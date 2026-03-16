from __future__ import annotations

from functools import lru_cache

from app.clients.browser_client import BrowserWorkerClient
from app.core.config import Settings, get_settings
from app.services.gemini_service import GeminiService
from app.services.navigation_planner import NavigationPlanner
from app.services.notice_parser import NoticeParser
from app.services.session_store import InMemorySessionStore


@lru_cache(maxsize=1)
def get_session_store() -> InMemorySessionStore:
    """Get session store (in-memory for simplicity)."""
    return InMemorySessionStore()


@lru_cache(maxsize=1)
def get_gemini_service() -> GeminiService:
    settings = get_settings()
    return GeminiService(settings=settings)


@lru_cache(maxsize=1)
def get_notice_parser() -> NoticeParser:
    settings = get_settings()
    return NoticeParser(
        settings=settings,
        gemini_service=get_gemini_service(),
    )


@lru_cache(maxsize=1)
def get_navigation_planner() -> NavigationPlanner:
    return NavigationPlanner(gemini_service=get_gemini_service())


@lru_cache(maxsize=1)
def get_browser_client() -> BrowserWorkerClient:
    settings = get_settings()
    return BrowserWorkerClient(
        base_url=settings.browser_worker_url,
        timeout_seconds=settings.worker_timeout_seconds,
    )


def get_app_settings() -> Settings:
    return get_settings()
