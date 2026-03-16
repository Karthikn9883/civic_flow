import { useEffect, useRef, useState } from "react";
import { appConfig } from "../config";

interface VoiceInterfaceProps {
  sessionId: string | null;
  onCommandReceived?: (command: string) => void;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
type VoiceStatus = "idle" | "listening" | "processing" | "speaking";

export function VoiceInterface({ sessionId, onCommandReceived }: VoiceInterfaceProps) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [agentMessage, setAgentMessage] = useState("Press the microphone to start voice control");

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);

  // Initialize WebSocket connection
  useEffect(() => {
    if (!sessionId) return;

    const connectWebSocket = () => {
      const ws = new WebSocket(appConfig.agentWebSocketUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[VoiceInterface] WebSocket connected");
        setConnectionStatus("connected");
        setAgentMessage("Voice agent ready! Press the microphone to talk.");

        // Start voice session
        ws.send(
          JSON.stringify({
            type: "start_session",
            sessionId: sessionId,
          })
        );
      };

      ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log("[VoiceInterface] Received:", message.type);

          switch (message.type) {
            case "session_started":
              setAgentMessage("Voice session started. I'm listening!");
              break;

            case "audio":
              // Decode base64 audio and play
              if (message.data) {
                await playAudioChunk(message.data);
              }
              break;

            case "transcript":
              if (message.role === "user") {
                setTranscript(message.text);
              } else if (message.role === "agent") {
                setAgentMessage(message.text);
              }
              break;

            case "command_detected":
              console.log("[VoiceInterface] Command detected:", message.command);
              onCommandReceived?.(message.command);
              break;

            case "thinking":
              setVoiceStatus("processing");
              setAgentMessage("Thinking...");
              break;

            case "speaking":
              setVoiceStatus("speaking");
              break;

            case "error":
              console.error("[VoiceInterface] Error:", message.error);
              setAgentMessage(`Error: ${message.error}`);
              setConnectionStatus("error");
              break;
          }
        } catch (error) {
          console.error("[VoiceInterface] Failed to parse message:", error);
        }
      };

      ws.onerror = (error) => {
        console.error("[VoiceInterface] WebSocket error:", error);
        setConnectionStatus("error");
        setAgentMessage("Connection error. Please refresh the page.");
      };

      ws.onclose = () => {
        console.log("[VoiceInterface] WebSocket closed");
        setConnectionStatus("disconnected");
        setAgentMessage("Voice agent disconnected.");
        wsRef.current = null;
      };
    };

    setConnectionStatus("connecting");
    connectWebSocket();

    return () => {
      wsRef.current?.close();
      audioContextRef.current?.close();
    };
  }, [sessionId, onCommandReceived]);

  // Play audio chunk from base64
  const playAudioChunk = async (base64Audio: string) => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      }

      const audioData = Uint8Array.from(atob(base64Audio), (c) => c.charCodeAt(0));
      const audioBuffer = await audioContextRef.current.decodeAudioData(audioData.buffer);
      audioQueueRef.current.push(audioBuffer);

      if (!isPlayingRef.current) {
        playNextAudio();
      }
    } catch (error) {
      console.error("[VoiceInterface] Failed to play audio:", error);
    }
  };

  const playNextAudio = () => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      setVoiceStatus("idle");
      return;
    }

    isPlayingRef.current = true;
    const audioBuffer = audioQueueRef.current.shift()!;
    const source = audioContextRef.current!.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current!.destination);
    source.onended = () => {
      playNextAudio();
    };
    source.start();
  };

  // Start listening (capture microphone)
  const startListening = async () => {
    if (connectionStatus !== "connected") {
      alert("Voice agent is not connected. Please wait...");
      return;
    }

    try {
      setVoiceStatus("listening");
      setTranscript("");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);

      // Use ScriptProcessor for audio capture (simplified)
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (event) => {
        if (voiceStatus !== "listening") return;

        const inputData = event.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
        }

        // Send PCM16 audio to WebSocket
        const base64Audio = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: "audio",
              data: base64Audio,
            })
          );
        }
      };

      // Stop after 5 seconds (or implement push-to-talk)
      setTimeout(() => {
        stopListening(stream, processor, audioContext);
      }, 5000);
    } catch (error) {
      console.error("[VoiceInterface] Microphone access failed:", error);
      setAgentMessage("Microphone access denied. Please check permissions.");
      setVoiceStatus("idle");
    }
  };

  const stopListening = (
    stream: MediaStream,
    processor: ScriptProcessorNode,
    audioContext: AudioContext
  ) => {
    stream.getTracks().forEach((track) => track.stop());
    processor.disconnect();
    audioContext.close();
    setVoiceStatus("processing");
  };

  const getStatusText = () => {
    switch (voiceStatus) {
      case "listening":
        return "Listening...";
      case "processing":
        return "Processing...";
      case "speaking":
        return "Agent Speaking";
      default:
        return connectionStatus === "connected" ? "Ready" : "Connecting...";
    }
  };

  return (
    <div className="voice-agent-card card">
      <div className="voice-content">
        <div className="voice-status">
          {connectionStatus === "connected" && <span className="status-dot"></span>}
          <span>{getStatusText()}</span>
        </div>

        <button
          className={`mic-button ${voiceStatus === "listening" ? "listening" : ""}`}
          onClick={startListening}
          disabled={connectionStatus !== "connected" || voiceStatus !== "idle"}
        >
          {voiceStatus === "listening" ? "🎤" : "🎙️"}
        </button>

        <p className="mic-hint">{agentMessage}</p>

        {transcript && (
          <div className="voice-transcript">
            <strong>You said:</strong> {transcript}
          </div>
        )}
      </div>
    </div>
  );
}
