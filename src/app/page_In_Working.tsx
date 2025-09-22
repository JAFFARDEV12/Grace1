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

  // Streaming audio elements
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioQueue: Uint8Array[] = [];
  let appending = false;

  const setupMediaSource = () => {
    mediaSourceRef.current = new MediaSource();
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.src = URL.createObjectURL(mediaSourceRef.current);
    audioElementRef.current = audioEl;

    mediaSourceRef.current.addEventListener("sourceopen", () => {
      if (!sourceBufferRef.current && mediaSourceRef.current) {
        try {
          sourceBufferRef.current = mediaSourceRef.current.addSourceBuffer("audio/mpeg");
          sourceBufferRef.current.mode = "sequence";
          sourceBufferRef.current.addEventListener("updateend", () => {
            processQueue(); // Process queued chunks after finishing
          });
        } catch (e) {
          console.error("Error creating SourceBuffer", e);
        }
      }
    });

    document.body.appendChild(audioEl);
  };

  const playAudioChunk = (chunk: ArrayBuffer) => {
    audioQueue.push(new Uint8Array(chunk));
    processQueue();
  };

  const processQueue = () => {
    if (!sourceBufferRef.current || appending || sourceBufferRef.current.updating || audioQueue.length === 0) return;

    try {
      appending = true;
      const nextChunk = audioQueue.shift()!;
      sourceBufferRef.current.appendBuffer(nextChunk as unknown as BufferSource);
      appending = false;

    } catch (e) {
      console.error("appendBuffer failed, re-queuing", e);
      audioQueue.unshift(nextChunk);
      appending = false;
    }
  };

  const connectWebSocket = () => {
    setupMediaSource();
    wsRef.current = new WebSocket("ws://127.0.0.1:8000/ws/conversation");
    wsRef.current.binaryType = "arraybuffer";

    wsRef.current.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        playAudioChunk(event.data);
      } else {
        try {
          const data = JSON.parse(event.data);
          if (data.audio_end) {
            console.log("[WS] Audio ended, reactivating mic...");
            setMicActive(true);
            return;
          }

          // --- NVIDIA A2F (Morph Targets) ---
          if (data.source === "a2f") {
            if (data.type === "header") {
              console.log("[A2F] Blendshape names:", data.blendshapeNames);
              // Optionally store names in state for later use
              // setBlendshapeNames(data.blendshapeNames);
            } else if (data.type === "frame") {
              console.log("[A2F] Morph frame:", data.blendshapes);
              // Send blendshapes to your avatar engine here:
              // updateAvatarBlendshapes(data.blendshapes);
            } else if (data.type === "status") {
              console.log("[A2F] Status:", data.code, data.message);
            }
            return; // stop further message handling
          }

          // if (data.partial_assistant) {
          //   setMessages((prev) => [...prev.slice(0, -1), "AI: " + data.partial_assistant]);
          // }
          // if (data.final_text || data.partial_text) {
          //   setMessages((prev) => [...prev, "User: " + (data.final_text || data.partial_text)]);
          // }
          // if (data.partial_assistant) {
          //   setMessages((prev) => [...prev.slice(0, -1), "User: " + data.partial_assistant]);
          // }
          if (data.Text && !data.partial_assistant) { // Full assistant message
            const emotionInfo = data.Sentiment ? ` [${data.Sentiment} | ${data.Facial} | ${data.Body}]` : "";
            setMessages((prev) => [...prev, data.source == 'user' ? "User: " + data.Text + emotionInfo : "AI: " + data.Text + emotionInfo]);
          }
        } catch {}
      }
    };
  };

  const startListening = async () => {
    if (!micActive) return;
    setMicActive(false);

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = mediaRecorder;

    audioContextRef.current = audioContextRef.current || new AudioContext();
    const source = audioContextRef.current.createMediaStreamSource(stream);
    analyserRef.current = audioContextRef.current.createAnalyser();
    source.connect(analyserRef.current);

    let isSpeaking = false;
    let silenceTimeout: ReturnType<typeof setTimeout>;

    vad(audioContextRef.current, stream, {
      onUpdate: (val: number) => {
        const energy = val * 100;
        setVolume(energy);

        if (!analyserRef.current || !audioContextRef.current) return;
        const freqData = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(freqData);
        const dominantFreqIndex = freqData.indexOf(Math.max(...freqData));
        const nyquist = audioContextRef.current.sampleRate / 2;
        const dominantFreq = (dominantFreqIndex / freqData.length) * nyquist;

        const isHumanVoice = dominantFreq > 300 && dominantFreq < 3000;

        if (energy > 40 && isHumanVoice) {
          if (!isSpeaking) {
            isSpeaking = true;
            audioChunks.length = 0;
            mediaRecorder.start();
          }
          clearTimeout(silenceTimeout);
        } else if (isSpeaking) {
          silenceTimeout = setTimeout(() => {
            isSpeaking = false;
            mediaRecorder.stop();
          }, 2100);
        }
      },
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      blob.arrayBuffer().then((buf) => {
        wsRef.current?.send(buf);
      });
    };
  };

  const resetConversation = () => {
    setMessages([]);
    wsRef.current?.close();
    wsRef.current = null;
    setMicActive(true);
    alert("Conversation reset.");
  };

  React.useEffect(() => {
    connectWebSocket();
    setMicActive(true);
  }, []);

  return (
    <div style={{ textAlign: "center", padding: "2rem", background: "#111", color: "#fff", height: "100vh" }}>
      <h1>Realtime Conversational AI</h1>
      <div style={{ display: "flex", justifyContent: "center", gap: "1rem" }}>
        <button
          onClick={startListening}
          disabled={!micActive}
          style={{
            background: micActive ? "#4caf50" : "#666",
            borderRadius: "50%",
            padding: "20px",
            border: "none",
            cursor: micActive ? "pointer" : "not-allowed",
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

      <div style={{ marginTop: "20px", maxHeight: "400px", overflowY: "auto", textAlign: "left" }}>
        {/* {messages.map((m, i) => <p key={i} style={{ color: m.startsWith("User") ? "#4caf50" : "#ff9800" }}>{m}</p>)} */}
        {messages.map((m, i) => {
          const [text, emotions] = m.split(" [");
          return (
            <p key={i} style={{ color: m.startsWith("User") ? "#4caf50" : "#ff9800" }}>
              {text}
              {emotions && (
                <span style={{ fontSize: "0.8rem", color: "#bbb" }}> [{emotions}</span>
              )}
            </p>
          );
        })}

      </div>
    </div>
  );
}

// This code is a React component that implements a real-time conversational AI interface with voice activity detection and audio streaming.
