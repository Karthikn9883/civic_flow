from __future__ import annotations

from typing import Any

import httpx


class BrowserWorkerClient:
    def __init__(self, base_url: str, timeout_seconds: int) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    async def command(self, session_id: str, command: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = {
            "session_id": session_id,
            "command": command,
            "payload": payload or {},
        }
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(f"{self.base_url}/command", json=body)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise RuntimeError("Browser worker returned invalid payload")
            return data
