"use client";
import React, { useRef, useState, useEffect } from "react";
import { FaMicrophone, FaSync } from "react-icons/fa";
import vad from "voice-activity-detection";

export default function App() {
  const [messages, setMessages] = useState<string[]>([]);
  const [micReady, setMicReady] = useState(true);
  const [volume, setVolume] = useState(0);
  const [listening, setListening] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  // avatar & audio
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [showIdle, setShowIdle] = useState(true);
  const [videoSrc, setVideoSrc] = useState<string>("");
  const idleImage = "/blackish_Image.png";
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // mic resources
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vadStopRef = useRef<(() => void) | null>(null);

  // helper: wait for a single event once
  const once = (el: HTMLElement | HTMLMediaElement, ev: string) =>
    new Promise<void>((resolve) => {
      const fn = () => {
        el.removeEventListener(ev, fn as any);
        resolve();
      };
      el.addEventListener(ev, fn as any, { once: true });
    });

  // play audio and video in tight sync, matching durations
  const playInSync = async () => {
    const a = audioRef.current!;
    const v = videoRef.current!;

    // ensure metadata for both
    if (isNaN(a.duration) || a.duration === Infinity) {
      await once(a, "loadedmetadata");
    }
    if (!v.src) return;

    v.load(); // ensure new source is committed
    await once(v, "loadedmetadata");

    // compute playbackRate so video duration == audio duration
    const audioDur = Math.max(0.1, a.duration);
    const videoDur = Math.max(0.1, v.duration);
    v.playbackRate = videoDur / audioDur; // stretches/compresses video to match audio

    v.currentTime = 0;
    a.currentTime = 0;

    setShowIdle(false);

    // start audio first (guaranteed user gesture happened via mic button), then video
    await a.play().catch(() => {});
    await v.play().catch(() => {});

    // when audio ends, stop video and go idle
    a.onended = () => {
      try { v.pause(); } catch {}
      setShowIdle(true);
    };
  };

  useEffect(() => {
  if (!videoSrc || !audioRef.current || !videoRef.current) return;

  const syncAndPlay = async () => {
    try {
      await playInSync();
    } catch (err) {
      console.error("Failed to sync playback:", err);
    }
  };

  syncAndPlay();
}, [videoSrc]);


  useEffect(() => {
    wsRef.current = new WebSocket("wss://avatar.wellbands.com/ws/conversation");

    wsRef.current.onmessage = async (ev) => {
      const data = JSON.parse(ev.data);

      if (data.source === "user") {
        setMessages((p) => [...p, `User: ${data.Text}`]);
        return;
      }

      if (data.source === "assistant" && data.audio?.b64) {
        setMessages((p) => [...p, `AI: ${data.Text}`]);

        // decode base64 → blob → objectURL
        const bin = atob(data.audio.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: data.audio.mime || "audio/mpeg" });
        const audioUrl = URL.createObjectURL(blob);

        // assign audio
        if (!audioRef.current) return;
        audioRef.current.src = audioUrl;

        // when audio metadata is available, choose the video clip then start both
        audioRef.current.onloadedmetadata = async () => {
          const exact = audioRef.current!.duration || data.EstimatedDurationSec || 1;
          const rounded = Math.min(10, Math.max(1, Math.round(exact)));
          const src = `/Videos/${rounded}Sec.mp4`;
          setVideoSrc(src);

          if (videoRef.current) {
            videoRef.current.src = src;
            // ensure the browser commits the source before play
            await playInSync();
          } else {
            // audio only fallback
            setShowIdle(false);
            audioRef.current?.play().catch(() => {});
          }
        };

        // cleanup object URL when the audio completes
        audioRef.current.onended = () => {
          URL.revokeObjectURL(audioUrl);
        };
      }
    };

    return () => {
      wsRef.current?.close();
    };
  }, []);

  // mic / utterance with VAD
  const toggleMic = async () => {
    if (listening) {
      // Stop listening completely
      try {
        mediaRecorderRef.current?.state !== "inactive" && mediaRecorderRef.current?.stop();
      } catch {}
      streamRef.current?.getTracks().forEach((t) => t.stop());
      vadStopRef.current?.();
      vadStopRef.current = null;
      setListening(false);
      setMicReady(true);
      return;
    }

    // Start listening
    setMicReady(false);
    setListening(true);

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    let mr: MediaRecorder | null = null;
    let chunks: Blob[] = [];

    const startRecorder = () => {
      chunks = [];
      mr = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mr.onstop = () => {
        if (chunks.length > 0) {
          const blob = new Blob(chunks, { type: "audio/webm" });
          blob.arrayBuffer().then((buf) => wsRef.current?.send(buf));
        }
      };

      mr.start();
    };

    let speaking = false;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const ctx = new AudioContext();

    const vadControl = vad(ctx, stream, {
      onUpdate: (val: number) => {
        const level = val * 100;
        setVolume(level);

        if (level > 40) {
          // 🎤 Start talking
          if (!speaking) {
            speaking = true;
            startRecorder();
          }
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
        } else if (speaking && !silenceTimer) {
          // Silence detected → stop & send after 1.6s
          silenceTimer = setTimeout(() => {
            speaking = false;
            try {
              mr?.state !== "inactive" && mr?.stop();
            } catch {}
          }, 1600); // 
        }
      },
    });

    vadStopRef.current = () => {
      try {
        vadControl.destroy();
        ctx.close();
      } catch {}
    };

    setMicReady(true);
  };


  const resetAll = () => {
    setMessages([]);
    setShowIdle(true);
    try {
      mediaRecorderRef.current?.state !== "inactive" &&
        mediaRecorderRef.current?.stop();
    } catch {}
    streamRef.current?.getTracks().forEach((t) => t.stop());
    vadStopRef.current?.();
    vadStopRef.current = null;
    setMicReady(true);
    try {
      audioRef.current?.pause();
      videoRef.current?.pause();
    } catch {}
  };

  const handleVideoError = () => {
    if (!videoRef.current?.src) return;
    const url = videoRef.current.src;
    if (url.includes("Sec.mp4")) {
      const lower = url.replace("Sec.mp4", "sec.mp4");
      setVideoSrc(lower.replace(window.location.origin, ""));
    }
  };

  return (
    <div style={{ textAlign: "center", padding: "2rem", background: "#111", color: "#fff", minHeight: "100vh" }}>
      <h1>Realtime Conversational AI</h1>

      <div className="flex flex-col items-center mb-4 justify-center w-full mt-10">
        {showIdle ? (
          <img src={idleImage} alt="Idle Avatar" width={400} style={{ borderRadius: 12, marginBottom: 20 }} />
        ) : (
          <video
            ref={videoRef}
            width={400}
            muted
            playsInline
            preload="auto"
            poster={idleImage}
            src={videoSrc}  // ✅ always use state here
            onError={handleVideoError}
            style={{
              borderRadius: 12,
              marginBottom: 20,
              background: "#000",
              display: showIdle ? "none" : "block"
            }}
          />

        )}
      </div>

      <audio ref={audioRef} hidden />

      <div style={{ display: "flex", justifyContent: "center", gap: "1rem" }}>
        <button
          onClick={toggleMic}
          disabled={!micReady && !listening}
          title={listening ? "Stop" : "Start"}
          style={{
            background: listening ? "#e53935" : micReady ? "#24a148" : "#666",
            borderRadius: "50%",
            padding: 20,
            border: "none",
            cursor: micReady || listening ? "pointer" : "not-allowed",
            transition: "background 0.3s ease"
          }}
        >
          <FaMicrophone size={30} color="white" />
        </button>

        <button
          onClick={resetAll}
          title="Reset"
          style={{
            background: "#2196f3",
            borderRadius: "50%",
            padding: 20,
            border: "none",
            cursor: "pointer",
            transition: "background 0.3s ease"
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#1976d2")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "#2196f3")}
        >
          <FaSync size={25} color="white" />
        </button>
      </div>  
      
      
      {/* Waveform */}
      <div style={{
        marginTop: "20px",
        width: "300px",
        height: "10px",
        background: "#333",
        margin: "20px auto",
        borderRadius: "5px",
      }}>
        <div style={{
          width: `${Math.min(volume, 100)}%`,
          height: "100%",
          background: "#4caf50",
          borderRadius: "5px",
          transition: "width 0.1s"
        }} />
      </div>


      <div style={{ marginTop: 24, maxHeight: 300, overflowY: "auto", textAlign: "left", width: 900, marginInline: "auto" }}>
        {messages.map((m, i) => (<p key={i}>{m}</p>))}
      </div>
    </div>
  );
}
