import { useEffect, useRef, useState } from "react";
import { VoiceOrb, type OrbState } from "./components/VoiceOrb";

type TabId = "browser" | "status";
type ControlMode = "agent" | "manual";

interface LogEntry {
  id: number;
  text: string;
  type: "voice" | "vision" | "success" | "warning" | "error";
  time: string;
}

const AGENT_URL        = (import.meta.env.VITE_AGENT_URL        as string | undefined) ?? 'http://localhost:8000';
const BROWSER_WORKER_URL = (import.meta.env.VITE_BROWSER_WORKER_URL as string | undefined) ?? 'http://localhost:8001';

const SESSION_ID = Math.random().toString(36).slice(2, 14);

let logCounter = 0;
function makeLog(text: string, type: LogEntry["type"] = "voice"): LogEntry {
  return {
    id: logCounter++,
    text,
    type,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("browser");
  const [transcript, setTranscript] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([makeLog("CivicFlow initialised", "success")]);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [controlMode, setControlMode] = useState<ControlMode>("agent");
  const [isNavigating, setIsNavigating] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [agentMode, setAgentMode] = useState("idle");
  const [wsOnline, setWsOnline] = useState(false);
  const autoRef = useRef(false);

  const addLog = (text: string, type: LogEntry["type"] = "voice") => {
    setLogs(prev => [makeLog(text, type), ...prev].slice(0, 60));
  };

  const handleStateChange = (s: OrbState) => {
    if (s === "listening") setAgentMode("voice");
    else if (s === "processing") setAgentMode("vision");
    else if (s === "speaking") setAgentMode("voice");
    else if (s === "idle") setAgentMode("idle");
  };

  const handleTranscript = (text: string, role: "user" | "agent") => {
    setTranscript(text);
    addLog(`${role === "user" ? "You" : "Agent"}: ${text}`, role === "user" ? "voice" : "success");
    if (role === "agent") setActiveTab("status");
  };

  const handleAgentNavigated = (url: string, task: string) => {
    setCurrentUrl(url);
    setAgentMode("vision");
    setActiveTab("browser");
    addLog(`Opening ${url} — ${task}`, "vision");
    // Fetch a screenshot after navigation settles
    setTimeout(async () => {
      try {
        const r = await fetch(`${BROWSER_WORKER_URL}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "screenshot" }),
        });
        const d = await r.json();
        if (d.screenshot) setScreenshot(d.screenshot);
      } catch { /* browser worker may not be running */ }
    }, 2000);
  };

  // Check WS status by polling the hidden input written by VoiceOrb
  useEffect(() => {
    const interval = setInterval(() => {
      const el = document.querySelector("[data-ws-status]") as HTMLInputElement | null;
      setWsOnline(el?.dataset.wsStatus === "online");
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const runStep = async () => {
    setIsNavigating(true);
    addLog("Executing navigation step…", "vision");
    try {
      const r = await fetch(`${AGENT_URL}/session/${SESSION_ID}/step`, { method: "POST" });
      const d = await r.json();
      if (d.screenshot) setScreenshot(d.screenshot);
      if (d.url) setCurrentUrl(d.url);
      addLog(d.reason || "Step complete", d.action === "finish" ? "success" : "vision");
      if (d.action === "finish") setAgentMode("idle");
      if (d.action === "request_user_input") addLog("Agent needs your input", "warning");
      setActiveTab("browser");
    } catch {
      addLog("Step failed — is the agent running?", "error");
    } finally {
      setIsNavigating(false);
    }
  };

  const toggleAutoRun = async () => {
    if (autoRef.current) {
      autoRef.current = false;
      setAutoRunning(false);
      addLog("Auto-run stopped", "warning");
      return;
    }
    autoRef.current = true;
    setAutoRunning(true);
    addLog("Auto-run started", "vision");

    const loop = async () => {
      if (!autoRef.current) return;
      await runStep();
      if (autoRef.current) setTimeout(loop, 1800);
    };
    loop();
  };

  const handleServerMessage = (msg: Record<string, unknown>) => {
    if (msg.type === "screenshot") {
      if (msg.screenshot) setScreenshot(msg.screenshot as string);
      if (msg.url) setCurrentUrl(msg.url as string);
      setActiveTab("browser");
    } else if (msg.type === "visionStep") {
      addLog(`Step ${msg.step}: ${msg.reason}`, "vision");
    } else if (msg.type === "visionStatus") {
      const status = msg.status as string;
      if (status === "running") addLog(`Vision agent started: ${msg.task}`, "vision");
      else if (status === "complete") { addLog(`Task complete: ${msg.reason}`, "success"); setAgentMode("idle"); }
      else if (status === "needs_input") addLog(`Agent needs help: ${msg.reason}`, "warning");
      else if (status === "stopped") addLog(`Vision stopped: ${msg.reason}`, "warning");
      else if (status === "rate_limited") addLog(`Rate limit hit — pausing ${msg.waitSeconds}s`, "warning");
    }
  };

  const handleTakeControl = () => {
    setControlMode("manual");
    setAgentMode("manual");
    addLog("Manual control activated", "warning");
  };

  const handleReturnControl = () => {
    setControlMode("agent");
    setAgentMode("vision");
    addLog("Returned control to agent", "success");
  };

  const triggerDemo = async (label: string, url: string) => {
    addLog(`Demo: ${label}`, "voice");
    setCurrentUrl(url);
    setActiveTab("browser");
    try {
      const r = await fetch(`${BROWSER_WORKER_URL}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "navigate", params: { url } }),
      });
      const d = await r.json();
      if (d.screenshot) setScreenshot(d.screenshot);
      if (d.url) setCurrentUrl(d.url);
      addLog(`Opened ${d.url || url}`, "success");
    } catch {
      addLog("Browser worker offline — start it first", "error");
    }
  };

  const modeColorMap: Record<string, string> = {
    voice: "var(--purple)",
    vision: "var(--blue)",
    manual: "var(--red)",
    idle: "var(--text-3)",
  };

  return (
    <div className="shell">
      {/* ── TOPBAR ── */}
      <header className="topbar">
        <div className="topbar-brand">
          <div className="topbar-logo">⚡</div>
          <span className="topbar-name">CivicFlow</span>
          <span className="topbar-tag">Multimodal Agent</span>
        </div>
        <div className="topbar-right">
          <div className={`connection-badge ${wsOnline ? "online" : "offline"}`}>
            <span className="dot" />
            {wsOnline ? "Agent online" : "Agent offline"}
          </div>
          <div className={`connection-badge`} style={{ borderColor: modeColorMap[agentMode], color: modeColorMap[agentMode] }}>
            <span className="dot" style={{ background: modeColorMap[agentMode] }} />
            {agentMode === "idle" ? "Idle" : `${agentMode.charAt(0).toUpperCase() + agentMode.slice(1)} mode`}
          </div>
        </div>
      </header>

      {/* ── ORB STAGE ── */}
      <main className="orb-stage">
        <VoiceOrb
          sessionId={SESSION_ID}
          onStateChange={handleStateChange}
          onTranscript={handleTranscript}
          onLog={addLog}
          onAgentNavigated={handleAgentNavigated}
          onServerMessage={handleServerMessage}
        />

        {transcript && (
          <div className={`transcript-bubble ${transcript ? "has-text" : ""}`}>
            {transcript}
          </div>
        )}
      </main>

      {/* ── SIDE PANEL ── */}
      <aside className="side-panel">
        <div className="panel-tabs">
          <button
            className={`panel-tab ${activeTab === "browser" ? "active" : ""}`}
            onClick={() => setActiveTab("browser")}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>web</span>
            Browser
          </button>
          <button
            className={`panel-tab ${activeTab === "status" ? "active" : ""}`}
            onClick={() => setActiveTab("status")}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>history</span>
            Activity
            {logs.length > 1 && (
              <span style={{
                background: "var(--blue)",
                color: "white",
                borderRadius: "10px",
                padding: "1px 6px",
                fontSize: "0.65rem",
                fontWeight: 700,
              }}>
                {Math.min(logs.length, 99)}
              </span>
            )}
          </button>
        </div>

        <div className="panel-body">
          {activeTab === "browser" && (
            <div>
              <div className="browser-url-bar">
                <span className="material-symbols-rounded">lock</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {currentUrl || "No page loaded"}
                </span>
              </div>

              <div className="screenshot-frame">
                {screenshot ? (
                  <>
                    <img src={`data:image/png;base64,${screenshot}`} alt="Browser view" />
                    {controlMode === "manual" && (
                      <div style={{
                        position: "absolute",
                        inset: 0,
                        background: "rgba(0,0,0,0.7)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexDirection: "column",
                        gap: 10,
                        color: "white",
                        fontSize: "0.875rem",
                        fontWeight: 600,
                      }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 36 }}>person</span>
                        Manual control active
                      </div>
                    )}
                    {isNavigating && (
                      <div style={{
                        position: "absolute",
                        bottom: 12,
                        left: "50%",
                        transform: "translateX(-50%)",
                        background: "rgba(0,0,0,0.8)",
                        color: "white",
                        padding: "6px 16px",
                        borderRadius: 20,
                        fontSize: "0.75rem",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}>
                        <div style={{
                          width: 12, height: 12,
                          border: "2px solid rgba(255,255,255,0.3)",
                          borderTopColor: "white",
                          borderRadius: "50%",
                          animation: "spin 0.7s linear infinite",
                        }} />
                        Navigating…
                      </div>
                    )}
                  </>
                ) : (
                  <div className="screenshot-empty">
                    <span className="material-symbols-rounded">web</span>
                    <span>No browser activity yet</span>
                    <span style={{ fontSize: "0.72rem" }}>Use a quick command below or speak to the agent</span>
                  </div>
                )}
              </div>

              <div className="browser-actions">
                {controlMode === "agent" ? (
                  <>
                    <button className="btn btn-ghost" onClick={runStep} disabled={isNavigating || autoRunning}>
                      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>skip_next</span>
                      Step
                    </button>
                    <button
                      className={`btn ${autoRunning ? "btn-danger" : "btn-ghost"}`}
                      onClick={toggleAutoRun}
                      disabled={isNavigating && !autoRunning}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{autoRunning ? "stop" : "play_arrow"}</span>
                      {autoRunning ? "Stop" : "Auto"}
                    </button>
                    <button className="btn btn-ghost" onClick={handleTakeControl}>
                      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>person</span>
                      Take control
                    </button>
                  </>
                ) : (
                  <button className="btn btn-success" onClick={handleReturnControl} style={{ flex: 1 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }}>smart_toy</span>
                    Return to agent
                  </button>
                )}
              </div>
            </div>
          )}

          {activeTab === "status" && (
            <div>
              <div className={`mode-badge ${agentMode}`}>
                <span className="material-symbols-rounded" style={{ fontSize: 12 }}>
                  {agentMode === "voice" ? "mic" : agentMode === "vision" ? "visibility" : agentMode === "manual" ? "person" : "radio_button_unchecked"}
                </span>
                {agentMode} mode
              </div>

              <div className="status-log">
                {logs.map(l => (
                  <div key={l.id} className={`log-entry ${l.type}`}>
                    <div className="log-dot" />
                    <div>
                      <div className="log-text">{l.text}</div>
                      <div className="log-time">{l.time}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* ── BOTTOM BAR ── */}
      <footer className="bottombar">
        <div className="quick-commands">
          <button className="cmd-chip" onClick={() => triggerDemo("Groceries", "https://www.instacart.com")}>
            <span className="material-symbols-rounded">shopping_cart</span>
            Book Groceries
          </button>
          <button className="cmd-chip" onClick={() => triggerDemo("IRS Portal", "https://www.irs.gov")}>
            <span className="material-symbols-rounded">account_balance</span>
            File Taxes
          </button>
          <button className="cmd-chip" onClick={() => triggerDemo("Benefits", "https://www.ssa.gov")}>
            <span className="material-symbols-rounded">health_and_safety</span>
            Benefits
          </button>
          <button className="cmd-chip" onClick={() => triggerDemo("Medicare", "https://www.medicare.gov")}>
            <span className="material-symbols-rounded">medical_services</span>
            Medicare
          </button>
        </div>

        <div className="bottombar-right">
          <button
            className="btn btn-ghost"
            style={{ fontSize: "0.75rem" }}
            onClick={() => {
              setTranscript("");
              setScreenshot(null);
              setCurrentUrl(null);
              setLogs([makeLog("Session reset", "success")]);
              setAgentMode("idle");
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>refresh</span>
            Reset
          </button>
        </div>
      </footer>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
