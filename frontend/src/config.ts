function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveHttpBaseUrl(envValue: string | undefined, fallbackPort: number): string {
  if (envValue && envValue.trim()) {
    return trimTrailingSlash(envValue.trim());
  }

  if (typeof window === "undefined") {
    return `http://localhost:${fallbackPort}`;
  }

  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${fallbackPort}`;
}

function resolveWebSocketUrl(envValue: string | undefined, httpBaseUrl: string): string {
  if (envValue && envValue.trim()) {
    return trimTrailingSlash(envValue.trim());
  }

  const wsBaseUrl = httpBaseUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  return `${trimTrailingSlash(wsBaseUrl)}/voice/ws`;
}

const agentBaseUrl = resolveHttpBaseUrl(import.meta.env.VITE_AGENT_BASE_URL, 8000);
const browserWorkerBaseUrl = resolveHttpBaseUrl(import.meta.env.VITE_BROWSER_WORKER_BASE_URL, 8001);

export const appConfig = {
  agentBaseUrl,
  browserWorkerBaseUrl,
  agentWebSocketUrl: resolveWebSocketUrl(import.meta.env.VITE_AGENT_WS_URL, agentBaseUrl),
};
