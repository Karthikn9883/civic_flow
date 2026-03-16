interface AgentStatusProps {
  mode: "voice" | "vision" | "manual" | "idle";
  status: string;
  currentTask?: string;
  itemsList?: string[];
}

export function AgentStatus({ mode, status, currentTask, itemsList }: AgentStatusProps) {
  const getModeIcon = () => {
    switch (mode) {
      case "voice":
        return "mic";
      case "vision":
        return "visibility";
      case "manual":
        return "person";
      default:
        return "smart_toy";
    }
  };

  const getModeColor = () => {
    switch (mode) {
      case "voice":
        return "#7c3aed";
      case "vision":
        return "#1a73e8";
      case "manual":
        return "#ea4335";
      default:
        return "#5f6368";
    }
  };

  const getStatusIcon = () => {
    if (status.includes("error") || status.includes("stuck")) return "error";
    if (status.includes("completed")) return "check_circle";
    if (status.includes("waiting") || status.includes("awaiting")) return "hourglass_empty";
    if (status.includes("navigating") || status.includes("thinking")) return "sync";
    return "info";
  };

  return (
    <div className="card agent-status-card">
      <div className="card-header">
        <div className="card-icon" style={{ background: `${getModeColor()}20`, color: getModeColor() }}>
          <span className="material-symbols-rounded">{getModeIcon()}</span>
        </div>
        <h2 className="card-title">Agent Status</h2>
      </div>

      <div className="status-grid">
        <div className="status-item" style={{ borderLeftColor: getModeColor() }}>
          <div className="status-label">Current Mode</div>
          <div className="status-value" style={{ color: getModeColor() }}>
            {mode.charAt(0).toUpperCase() + mode.slice(1)} Agent
          </div>
        </div>

        <div className="status-item">
          <div className="status-label">Status</div>
          <div className="status-value" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span className="material-symbols-rounded" style={{ fontSize: "20px" }}>
              {getStatusIcon()}
            </span>
            {status}
          </div>
        </div>

        {currentTask && (
          <div className="status-item">
            <div className="status-label">Current Task</div>
            <div className="status-value" style={{ fontSize: "1rem" }}>
              {currentTask}
            </div>
          </div>
        )}

        {itemsList && itemsList.length > 0 && (
          <div className="status-item">
            <div className="status-label">Items List</div>
            <ul style={{ margin: "8px 0 0", paddingLeft: "20px", fontSize: "0.875rem" }}>
              {itemsList.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <style>{`
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
