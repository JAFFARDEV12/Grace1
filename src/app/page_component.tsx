'use client';
import React, { useRef, useState } from "react";
import { FaMicrophone, FaSync } from "react-icons/fa";
import vad from "voice-activity-detection";

export default function App() {
  const [messages, setMessages] = useState<string[]>([]);
  const [micActive, setMicActive] = useState(false);
  const [volume, setVolume] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunks: Blob[] = [];
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // For AI audio playback
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioQueue: Uint8Array[] = [];

  const setupMediaSource = () => {
    // Reuse existing MediaSource if it's already initialized
    if (mediaSourceRef.current && audioElementRef.current) return;

    mediaSourceRef.current = new MediaSource();
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.src = URL.createObjectURL(mediaSourceRef.current);
    audioElementRef.current = audioEl;

    mediaSourceRef.current.addEventListener("sourceopen", () => {
      if (!sourceBufferRef.current) { // Prevent multiple SourceBuffer creation
        try {
          sourceBufferRef.current = mediaSourceRef.current!.addSourceBuffer("audio/mpeg");
          sourceBufferRef.current.mode = "sequence";
          sourceBufferRef.current.addEventListener("updateend", () => {
            if (audioQueue.length > 0 && !sourceBufferRef.current!.updating) {
              sourceBufferRef.current!.appendBuffer(audioQueue.shift()!);
            }
          });
        } catch (err) {
          console.error("Error adding SourceBuffer:", err);
        }
      }
    });

    document.body.appendChild(audioEl);
  };

  const initMediaSource = () => {
  mediaSourceRef.current = new MediaSource();
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  audioEl.src = URL.createObjectURL(mediaSourceRef.current);
  audioElementRef.current = audioEl;

  mediaSourceRef.current.addEventListener("sourceopen", () => {
      if (!sourceBufferRef.current) {
        sourceBufferRef.current = mediaSourceRef.current!.addSourceBuffer("audio/mpeg");
        sourceBufferRef.current.mode = "sequence";
        sourceBufferRef.current.addEventListener("updateend", () => {
          if (audioQueue.length > 0 && !sourceBufferRef.current!.updating) {
            sourceBufferRef.current!.appendBuffer(audioQueue.shift()!);
          }
        });
      }
    });

    document.body.appendChild(audioEl);
  };

  const resetMediaSource = () => {
    try {
      if (sourceBufferRef.current && mediaSourceRef.current?.readyState === "open") {
        mediaSourceRef.current.removeSourceBuffer(sourceBufferRef.current);
      }
    } catch {}
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.src = "";
      audioElementRef.current.remove();
    }
    mediaSourceRef.current = null;
    sourceBufferRef.current = null;
    audioElementRef.current = null;
    audioQueue.length = 0;
  };



  const playAudioChunk = (chunk: ArrayBuffer) => {
    const buffer = new Uint8Array(chunk);
    if (sourceBufferRef.current) {
      if (sourceBufferRef.current.updating) {
        audioQueue.push(buffer);
      } else {
        sourceBufferRef.current.appendBuffer(buffer);
      }
    } else {
      audioQueue.push(buffer);
    }
  };

  const connectWebSocket = () => {
    setupMediaSource();
    wsRef.current = new WebSocket("ws://localhost:8000/ws/conversation");
    wsRef.current.binaryType = "arraybuffer";
    wsRef.current.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        playAudioChunk(event.data);
      } else {
        try {
          const data = JSON.parse(event.data);

          if (data.audio_end) {
            resetMediaSource();
            initMediaSource();
            return;
          }

          if (data.partial_assistant) {
            setMessages((prev) => [...prev.slice(0, -1), "AI: " + data.partial_assistant]);
          }
          if (data.final_text) {
            setMessages((prev) => [...prev, "User: " + data.final_text]);
          }
        } catch {}
      }
    };


  };

  const startListening = async () => {
    if (micActive) return;
    setMicActive(true);
    connectWebSocket();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = mediaRecorder;

    // AudioContext for VAD & waveform
    audioContextRef.current = new AudioContext();
    const source = audioContextRef.current.createMediaStreamSource(stream);
    analyserRef.current = audioContextRef.current.createAnalyser();
    source.connect(analyserRef.current);

    // Setup VAD
    let isSpeaking = false;
    let speakingThreshold = 30; // More strict
    let silenceTimeout: NodeJS.Timeout;

    vad(audioContextRef.current, stream, {
      onUpdate: (val: number) => {
        const energy = val * 100;
        setVolume(energy);

        if (energy > speakingThreshold) {
          if (!isSpeaking) {
            isSpeaking = true;
            audioChunks.length = 0;
            mediaRecorder.start();
          }
          clearTimeout(silenceTimeout);
        } else if (isSpeaking) {
          // Wait 1s after last speech before stopping
          silenceTimeout = setTimeout(() => {
            isSpeaking = false;
            mediaRecorder.stop();
          }, 1000);
        }
      },
    });

    // Collect chunks
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      blob.arrayBuffer().then((buf) => {
        wsRef.current?.send(buf); // Send full phrase after pause
      });
    };
  };

  const resetConversation = () => {
    setMessages([]);
    resetMediaSource();
    wsRef.current?.close();
    wsRef.current = null;
    setMicActive(false);
    alert("Conversation reset.");
  };

  return (
    <div style={{ textAlign: "center", padding: "2rem", background: "#111", color: "#fff", height: "100vh" }}>
      <h1>Realtime Conversational AI</h1>
      <div style={{ display: "flex", justifyContent: "center", gap: "1rem" }}>
        <button
          onClick={startListening}
          style={{
            background: micActive ? "#f44333" : "#4caf50",
            borderRadius: "50%",
            padding: "20px",
            border: "none",
            cursor: "pointer",
          }}
        >
          <FaMicrophone size={30} color="white" />
        </button>
        <button
          onClick={resetConversation}
          style={{
            background: "#2196f3",
            borderRadius: "50%",
            padding: "20px",
            border: "none",
            cursor: "pointer",
          }}
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

      {/* Messages */}
      <div style={{ marginTop: "20px", maxHeight: "400px", overflowY: "auto", textAlign: "left" }}>
        {messages.map((m, i) => <p key={i} style={{ color: m.startsWith("User") ? "#4caf50" : "#ff9800" }}>{m}</p>)}
      </div>
    </div>
  );
}


//working with issue of audio mismatch
