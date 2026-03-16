import { useState } from "react";

interface BrowserControlProps {
  currentUrl: string | null;
  screenshot: string | null;
  mode: "agent" | "manual";
  isNavigating: boolean;
  onTakeControl: () => void;
  onReturnControl: () => void;
  onRunStep: () => void;
  onAutoRun: () => void;
  autoRunning: boolean;
}

export function BrowserControl({
  currentUrl,
  screenshot,
  mode,
  isNavigating,
  onTakeControl,
  onReturnControl,
  onRunStep,
  onAutoRun,
  autoRunning,
}: BrowserControlProps) {
  const [isFullScreen, setIsFullScreen] = useState(false);

  const toggleFullScreen = () => {
    setIsFullScreen(!isFullScreen);
  };

  return (
    <div className={`browser-card card ${isFullScreen ? "fullscreen" : ""}`}>
      <div className="browser-header">
        <div className="browser-url">
          <span className="material-symbols-rounded">language</span>
          <span>{currentUrl || "No page loaded"}</span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn btn-secondary" onClick={toggleFullScreen}>
            <span className="material-symbols-rounded">
              {isFullScreen ? "fullscreen_exit" : "fullscreen"}
            </span>
          </button>
          {mode === "agent" ? (
            <button className="btn btn-secondary" onClick={onTakeControl}>
              <span className="material-symbols-rounded">person</span>
              Take Control
            </button>
          ) : (
            <button className="btn btn-primary" onClick={onReturnControl}>
              <span className="material-symbols-rounded">smart_toy</span>
              Return to Agent
            </button>
          )}
        </div>
      </div>

      <div className="browser-viewport" style={{ position: "relative" }}>
        {screenshot ? (
          <img src={`data:image/png;base64,${screenshot}`} alt="Browser screenshot" className="browser-screenshot" />
        ) : (
          <div
            className="browser-screenshot"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#5f6368",
            }}
          >
            <div style={{ textAlign: "center" }}>
              <span className="material-symbols-rounded" style={{ fontSize: "64px", opacity: 0.3 }}>
                web
              </span>
              <p>No browser activity yet</p>
            </div>
          </div>
        )}

        {mode === "manual" && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0, 0, 0, 0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontSize: "1.25rem",
              fontWeight: 600,
            }}
          >
            <div style={{ textAlign: "center" }}>
              <span className="material-symbols-rounded" style={{ fontSize: "64px" }}>
                person
              </span>
              <p>Manual Control Active</p>
              <p style={{ fontSize: "0.875rem", opacity: 0.8, marginTop: "8px" }}>
                Use the visible browser window to interact
              </p>
            </div>
          </div>
        )}

        {isNavigating && mode === "agent" && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              background: "rgba(255, 255, 255, 0.95)",
              padding: "24px 32px",
              borderRadius: "12px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
              display: "flex",
              alignItems: "center",
              gap: "16px",
            }}
          >
            <div className="spinner"></div>
            <span style={{ fontWeight: 600, color: "#202124" }}>Agent is navigating...</span>
          </div>
        )}
      </div>

      {mode === "agent" && (
        <div className="browser-controls">
          <button className="btn btn-primary" onClick={onRunStep} disabled={isNavigating || autoRunning}>
            <span className="material-symbols-rounded">skip_next</span>
            Run Next Step
          </button>
          <button
            className={`btn ${autoRunning ? "btn-danger" : "btn-secondary"}`}
            onClick={onAutoRun}
            disabled={isNavigating}
          >
            <span className="material-symbols-rounded">{autoRunning ? "stop" : "play_arrow"}</span>
            {autoRunning ? "Stop Auto-Run" : "Auto-Run"}
          </button>
        </div>
      )}

      <style>{`
        .browser-card.fullscreen {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 9999;
          max-width: 100%;
          border-radius: 0;
          grid-column: 1;
        }

        .browser-card.fullscreen .browser-screenshot {
          min-height: calc(100vh - 200px);
        }

        .spinner {
          width: 24px;
          height: 24px;
          border: 3px solid #e8eaed;
          border-top-color: #1a73e8;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        .material-symbols-rounded {
          font-family: 'Material Symbols Rounded';
          font-weight: normal;
          font-style: normal;
          font-size: 20px;
          line-height: 1;
          letter-spacing: normal;
          text-transform: none;
          display: inline-block;
          white-space: nowrap;
          word-wrap: normal;
          direction: ltr;
          -webkit-font-feature-settings: 'liga';
          -webkit-font-smoothing: antialiased;
        }
      `}</style>
    </div>
  );
}
