import { useCallback, useEffect, useRef, useState } from "react";
import { appConfig } from "../config";

export type OrbState = "idle" | "listening" | "processing" | "speaking";

interface VoiceOrbProps {
  sessionId: string;
  onStateChange?: (state: OrbState) => void;
  onTranscript?: (text: string, role: "user" | "agent") => void;
  onLog?: (msg: string, type?: "voice" | "vision" | "success" | "warning" | "error") => void;
  onAgentNavigated?: (url: string, task: string) => void;
  onServerMessage?: (msg: Record<string, unknown>) => void;
}

// AudioWorklet processor code – same approach as the official Google sample
const WORKLET_CODE = `
class AudioRecorderWorklet extends AudioWorkletProcessor {
  buffer = new Int16Array(512);
  bufferWriteIndex = 0;

  process(inputs) {
    if (inputs[0] && inputs[0][0]) {
      this.processChunk(inputs[0][0]);
    }
    return true;
  }

  processChunk(float32Array) {
    for (let i = 0; i < float32Array.length; i++) {
      this.buffer[this.bufferWriteIndex++] = float32Array[i] * 32768;
      if (this.bufferWriteIndex >= this.buffer.length) {
        this.port.postMessage({ event: "chunk", data: { int16arrayBuffer: this.buffer.slice(0, this.bufferWriteIndex).buffer } });
        this.bufferWriteIndex = 0;
      }
    }
  }
}
registerProcessor("audio-recorder-worklet", AudioRecorderWorklet);
`;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToFloat32(b64: string): Float32Array {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const float32 = new Float32Array(bytes.length / 2);
  for (let i = 0; i < float32.length; i++) {
    let s = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    if (s >= 32768) s -= 65536;
    float32[i] = s / 32768;
  }
  return float32;
}

export function VoiceOrb({ sessionId, onStateChange, onTranscript, onLog, onAgentNavigated, onServerMessage }: VoiceOrbProps) {
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [wsStatus, setWsStatus] = useState<"offline" | "connecting" | "online" | "error">("offline");
  const [displayText, setDisplayText] = useState("Tap to start");
  const [subText, setSubText] = useState("Voice agent ready");
  // Whether the user has started the session (mic + audio context initialized)
  const [sessionStarted, setSessionStarted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Audio playback — created once on first user gesture, never closed between turns
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const messageQueueRef = useRef<Float32Array[]>([]);
  const queueProcessingRef = useRef(false);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const setState = useCallback((s: OrbState) => {
    setOrbState(s);
    onStateChange?.(s);
  }, [onStateChange]);

  // ── Playback ────────────────────────────────────────────────────────────────
  const playAudioQueue = useCallback(() => {
    const ctx = playbackCtxRef.current;
    if (!ctx) return;

    queueProcessingRef.current = true;

    if (nextStartTimeRef.current < ctx.currentTime) {
      nextStartTimeRef.current = ctx.currentTime;
    }

    while (messageQueueRef.current.length > 0) {
      const chunk = messageQueueRef.current.shift()!;
      const buf = ctx.createBuffer(1, chunk.length, 24000);
      buf.copyToChannel(new Float32Array(chunk), 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      activeSourcesRef.current.push(src);
      src.onended = () => {
        const idx = activeSourcesRef.current.indexOf(src);
        if (idx > -1) activeSourcesRef.current.splice(idx, 1);
        // When all playback finishes, return to listening (not idle)
        if (activeSourcesRef.current.length === 0 && messageQueueRef.current.length === 0) {
          setState("listening");
          setDisplayText("Listening…");
          setSubText("Speak naturally");
        }
      };
      src.start(nextStartTimeRef.current);
      nextStartTimeRef.current += buf.duration;
    }
    queueProcessingRef.current = false;
  }, [setState]);

  const stopCurrentPlayback = () => {
    messageQueueRef.current = [];
    activeSourcesRef.current.forEach(s => { try { s.stop(); s.disconnect(); } catch { /* already stopped */ } });
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;
    queueProcessingRef.current = false;
  };

  // ── WebSocket ───────────────────────────────────────────────────────────────
  useEffect(() => {
    setWsStatus("connecting");
    const ws = new WebSocket(appConfig.agentWebSocketUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus("online");
      onLog?.("Voice agent connected", "success");
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(ev.data as string); } catch { return; }

      if (msg.type === "session_started") {
        setDisplayText(sessionStarted ? "Listening…" : "Tap to start");
        setSubText(sessionStarted ? "Speak naturally" : "I'm ready");
        onLog?.("Session ready", "success");

      } else if (msg.type === "audioStream") {
        setState("speaking");
        setDisplayText("Speaking…");
        setSubText("Agent is responding");
        messageQueueRef.current.push(base64ToFloat32(msg.data as string));
        if (!queueProcessingRef.current) playAudioQueue();

      } else if (msg.type === "agentNavigated") {
        const { url, task } = msg as { type: string; url: string; task: string };
        onAgentNavigated?.(url, task);

      } else if (msg.type === "userTranscript") {
        const text = msg.data as string;
        onTranscript?.(text, "user");
        // Stop agent playback when user speaks (barge-in)
        stopCurrentPlayback();

      } else if (msg.type === "textStream") {
        const text = msg.data as string;
        setDisplayText(text.length > 60 ? text.slice(0, 57) + "…" : text);
        onTranscript?.(text, "agent");

      } else if (msg.type === "error") {
        setWsStatus("error");
        setDisplayText("Agent error");
        setSubText(msg.data as string);
        onLog?.(`Error: ${msg.data}`, "error");
      } else {
        // Forward unknown messages (screenshot, visionStatus, visionStep) to parent
        onServerMessage?.(msg);
      }
    };

    ws.onerror = () => {
      setWsStatus("error");
      setDisplayText("Agent offline");
      setSubText("Start the agent server first");
      onLog?.("WebSocket connection failed — is the agent running?", "error");
    };

    ws.onclose = () => {
      setWsStatus("offline");
      setState("idle");
    };

    return () => { ws.close(); };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Start always-on session (called once on first orb tap) ─────────────────
  const startSession = async () => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setDisplayText("Not connected");
      setSubText("Agent server is offline");
      return;
    }

    try {
      // Create playback AudioContext inside user gesture so it starts in "running" state
      if (!playbackCtxRef.current) {
        playbackCtxRef.current = new AudioContext();
        nextStartTimeRef.current = playbackCtxRef.current.currentTime;
      }
      await playbackCtxRef.current.resume();

      // Set up mic for continuous streaming (16 kHz PCM16 → Gemini Live)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const recordCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = recordCtx;
      const source = recordCtx.createMediaStreamSource(stream);

      const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await recordCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const worklet = new AudioWorkletNode(recordCtx, "audio-recorder-worklet");
      worklet.port.onmessage = (e) => {
        const buf: ArrayBuffer = e.data.data.int16arrayBuffer;
        if (buf && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "realtimeInput",
            audioData: arrayBufferToBase64(buf),
          }));
        }
      };

      source.connect(worklet);
      setSessionStarted(true);
      setState("listening");
      setDisplayText("Listening…");
      setSubText("Speak naturally");
      onLog?.("Always-on microphone active", "voice");

    } catch {
      setDisplayText("Microphone denied");
      setSubText("Check browser permissions");
      onLog?.("Microphone access denied", "error");
    }
  };

  const handleOrbClick = async () => {
    if (!sessionStarted) {
      await startSession();
    }
    // After session is started, tapping does nothing — always-on streaming
  };

  const iconFor: Record<OrbState, string> = {
    idle: "mic",
    listening: "graphic_eq",
    processing: "auto_awesome",
    speaking: "volume_up",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "24px" }}>
      <div className="orb-wrap">
        <div className="orb-ring orb-ring-3" />
        <div className="orb-ring orb-ring-2" />
        <div className="orb-ring orb-ring-1" />
        <button className={`orb ${orbState}`} onClick={handleOrbClick}>
          <div className="orb-inner">
            <span className="material-symbols-rounded orb-icon">{iconFor[orbState]}</span>
          </div>
        </button>
      </div>

      <div className="waveform" style={{ opacity: orbState === "listening" ? 1 : 0 }}>
        {[...Array(7)].map((_, i) => <div key={i} className="wave-bar" />)}
      </div>

      <div style={{ textAlign: "center" }}>
        <div className="orb-label">{displayText}</div>
        <div className="orb-sublabel" style={{ marginTop: 4 }}>{subText}</div>
      </div>

      {/* ws status for parent polling */}
      <input type="hidden" id="ws-status-probe" data-ws-status={wsStatus} />
    </div>
  );
}
