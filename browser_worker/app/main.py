from __future__ import annotations

import asyncio
import base64
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright


class CommandRequest(BaseModel):
    command: str
    params: dict[str, Any] = Field(default_factory=dict)


class CommandResponse(BaseModel):
    success: bool
    message: str = ""
    screenshot: str | None = None
    url: str | None = None
    error: str | None = None


class WorkerCommandRequest(BaseModel):
    session_id: str
    command: str
    payload: dict[str, Any] = Field(default_factory=dict)


class WorkerCommandResponse(BaseModel):
    success: bool
    message: str
    snapshot: dict[str, Any] | None = None


@dataclass
class BrowserSession:
    context: BrowserContext
    page: Page


app = FastAPI(title="CivicFlow Browser Worker", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_playwright: Playwright | None = None
_browser: Browser | None = None
_sessions: dict[str, BrowserSession] = {}


@app.on_event("startup")
async def startup_event() -> None:
    global _playwright, _browser  # noqa: PLW0603
    _playwright = await async_playwright().start()
    # Default to HEADED mode for manual control capability
    headless = os.getenv("CIVICFLOW_BROWSER_HEADLESS", "false").strip().lower() not in {
        "0",
        "false",
        "no",
    }
    _browser = await _playwright.chromium.launch(
        headless=headless,
        args=["--no-sandbox", "--disable-dev-shm-usage"]
    )
    print(f"Browser launched in {'headless' if headless else 'headed'} mode")


@app.on_event("shutdown")
async def shutdown_event() -> None:
    for browser_session in list(_sessions.values()):
        await browser_session.context.close()
    _sessions.clear()

    global _browser, _playwright  # noqa: PLW0603
    if _browser:
        await _browser.close()
    _browser = None
    if _playwright:
        await _playwright.stop()
    _playwright = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# Global page for simplified agent API
_global_page: Page | None = None


async def _ensure_global_page() -> Page:
    """Ensure we have a global page ready"""
    global _global_page
    if _global_page is None or _global_page.is_closed():
        if not _browser:
            raise HTTPException(status_code=503, detail="Browser not initialized")
        context = await _browser.new_context(viewport={"width": 1366, "height": 860})
        _global_page = await context.new_page()
    return _global_page


@app.post("/command", response_model=CommandResponse)
async def simple_command(request: CommandRequest) -> CommandResponse:
    """
    Simplified command API for agent orchestrator.
    No session management - just a single global browser page.
    """
    try:
        page = await _ensure_global_page()
        command = request.command
        params = request.params

        if command == "navigate":
            url = params.get("url", "")
            if not url:
                return CommandResponse(success=False, error="Missing url parameter")
            await page.goto(url, wait_until="domcontentloaded")
            screenshot_bytes = await page.screenshot(type="png")
            screenshot_base64 = base64.b64encode(screenshot_bytes).decode("utf-8")
            return CommandResponse(
                success=True,
                message=f"Navigated to {url}",
                screenshot=screenshot_base64,
                url=page.url
            )

        if command == "screenshot":
            screenshot_bytes = await page.screenshot(type="png")
            screenshot_base64 = base64.b64encode(screenshot_bytes).decode("utf-8")
            return CommandResponse(
                success=True,
                screenshot=screenshot_base64,
                url=page.url
            )

        if command == "click_by_text":
            target_text = params.get("text", "")
            if not target_text:
                return CommandResponse(success=False, error="Missing text parameter")

            # Try different locator strategies
            locator = page.get_by_role("button", name=target_text)
            if await locator.count() > 0:
                await locator.first.click(timeout=5000)
            else:
                locator = page.get_by_role("link", name=target_text)
                if await locator.count() > 0:
                    await locator.first.click(timeout=5000)
                else:
                    locator = page.get_by_text(target_text, exact=False)
                    if await locator.count() > 0:
                        await locator.first.click(timeout=5000)
                    else:
                        return CommandResponse(
                            success=False,
                            error=f"Could not find element with text '{target_text}'"
                        )

            await page.wait_for_load_state("domcontentloaded", timeout=3000)
            screenshot_bytes = await page.screenshot(type="png")
            screenshot_base64 = base64.b64encode(screenshot_bytes).decode("utf-8")
            return CommandResponse(
                success=True,
                message=f"Clicked '{target_text}'",
                screenshot=screenshot_base64,
                url=page.url
            )

        if command == "type_into_label":
            target_text = params.get("text", "")
            value = params.get("value", "")
            if not target_text:
                return CommandResponse(success=False, error="Missing text parameter")

            locator = page.get_by_label(target_text, exact=False)
            if await locator.count() > 0:
                await locator.first.fill(value)
            else:
                # Try placeholder fallback
                fallback = page.locator(f"input[placeholder*='{target_text}' i]")
                if await fallback.count() > 0:
                    await fallback.first.fill(value)
                else:
                    return CommandResponse(
                        success=False,
                        error=f"Could not find input for label '{target_text}'"
                    )

            screenshot_bytes = await page.screenshot(type="png")
            screenshot_base64 = base64.b64encode(screenshot_bytes).decode("utf-8")
            return CommandResponse(
                success=True,
                message=f"Filled '{target_text}'",
                screenshot=screenshot_base64,
                url=page.url
            )

        if command == "scroll_down":
            await page.mouse.wheel(0, 900)
            await page.wait_for_timeout(500)
            screenshot_bytes = await page.screenshot(type="png")
            screenshot_base64 = base64.b64encode(screenshot_bytes).decode("utf-8")
            return CommandResponse(
                success=True,
                message="Scrolled down",
                screenshot=screenshot_base64,
                url=page.url
            )

        return CommandResponse(success=False, error=f"Unknown command: {command}")

    except Exception as exc:
        return CommandResponse(
            success=False,
            error=f"{command} failed: {str(exc)}"
        )


@app.post("/session/command", response_model=WorkerCommandResponse)
async def session_command(request: WorkerCommandRequest) -> WorkerCommandResponse:
    if not _browser:
        raise HTTPException(status_code=503, detail="Browser not initialized")

    command_name = request.command
    payload = request.payload

    if command_name == "start_session":
        start_url = str(payload.get("start_url", "http://localhost:8002"))
        snapshot = await _start_session(request.session_id, start_url=start_url)
        return WorkerCommandResponse(success=True, message="Session started", snapshot=snapshot)

    if command_name == "close_session":
        await _close_session(request.session_id)
        return WorkerCommandResponse(success=True, message="Session closed")

    browser_session = _sessions.get(request.session_id)
    if not browser_session:
        raise HTTPException(status_code=404, detail="Session not found in worker")

    if command_name == "goto":
        url = str(payload.get("url", ""))
        if not url:
            return WorkerCommandResponse(success=False, message="Missing url in payload")
        await browser_session.page.goto(url, wait_until="domcontentloaded")
        snapshot = await _snapshot(browser_session.page)
        return WorkerCommandResponse(success=True, message=f"Navigated to {url}", snapshot=snapshot)

    if command_name == "screenshot":
        snapshot = await _snapshot(browser_session.page)
        return WorkerCommandResponse(success=True, message="Captured screenshot", snapshot=snapshot)

    if command_name == "click_by_text":
        target_text = str(payload.get("target_text", "")).strip()
        if not target_text:
            return WorkerCommandResponse(success=False, message="Missing target_text")
        success, message = await _click_by_text(browser_session.page, target_text)
        snapshot = await _snapshot(browser_session.page)
        return WorkerCommandResponse(success=success, message=message, snapshot=snapshot)

    if command_name == "type_into_label":
        target_text = str(payload.get("target_text", "")).strip()
        input_value = str(payload.get("input_value", ""))
        if not target_text:
            return WorkerCommandResponse(success=False, message="Missing target_text")
        success, message = await _type_into_label(browser_session.page, target_text, input_value)
        snapshot = await _snapshot(browser_session.page)
        return WorkerCommandResponse(success=success, message=message, snapshot=snapshot)

    if command_name == "select_dropdown":
        target_text = str(payload.get("target_text", "")).strip()
        input_value = str(payload.get("input_value", "")).strip()
        if not target_text or not input_value:
            return WorkerCommandResponse(success=False, message="Missing target_text or input_value")
        success, message = await _select_dropdown(browser_session.page, target_text, input_value)
        snapshot = await _snapshot(browser_session.page)
        return WorkerCommandResponse(success=success, message=message, snapshot=snapshot)

    if command_name == "scroll_down":
        await browser_session.page.mouse.wheel(0, 900)
        snapshot = await _snapshot(browser_session.page)
        return WorkerCommandResponse(success=True, message="Scrolled down", snapshot=snapshot)

    if command_name == "wait":
        seconds = float(payload.get("seconds", 1.0))
        seconds = max(0.2, min(seconds, 10.0))
        await asyncio.sleep(seconds)
        snapshot = await _snapshot(browser_session.page)
        return WorkerCommandResponse(success=True, message=f"Waited {seconds:.1f}s", snapshot=snapshot)

    return WorkerCommandResponse(success=False, message=f"Unsupported command '{command_name}'")


async def _start_session(session_id: str, start_url: str) -> dict[str, Any]:
    if session_id in _sessions:
        await _sessions[session_id].context.close()
        del _sessions[session_id]

    if not _browser:
        raise RuntimeError("Browser not initialized")

    context = await _browser.new_context(viewport={"width": 1366, "height": 860})
    page = await context.new_page()
    await page.goto(start_url, wait_until="domcontentloaded")
    _sessions[session_id] = BrowserSession(context=context, page=page)
    return await _snapshot(page)


async def _close_session(session_id: str) -> None:
    session = _sessions.get(session_id)
    if not session:
        return
    await session.context.close()
    del _sessions[session_id]


async def _click_by_text(page: Page, target_text: str) -> tuple[bool, str]:
    try:
        locator = page.get_by_role("button", name=target_text)
        if await locator.count() > 0:
            await locator.first.click(timeout=5000)
            await _settle_after_action(page)
            return True, f"Clicked button '{target_text}'"

        locator = page.get_by_role("link", name=target_text)
        if await locator.count() > 0:
            await locator.first.click(timeout=5000)
            await _settle_after_action(page)
            return True, f"Clicked link '{target_text}'"

        locator = page.get_by_text(target_text, exact=False)
        if await locator.count() > 0:
            await locator.first.click(timeout=5000)
            await _settle_after_action(page)
            return True, f"Clicked text '{target_text}'"

        return False, f"Could not find clickable element with text '{target_text}'"
    except Exception as exc:  # noqa: BLE001
        return False, f"click_by_text failed: {exc}"


async def _type_into_label(page: Page, target_text: str, value: str) -> tuple[bool, str]:
    try:
        locator = page.get_by_label(target_text, exact=False)
        if await locator.count() > 0:
            await locator.first.fill(value)
            return True, f"Filled '{target_text}'"

        fallback = page.locator(f"input[placeholder*='{target_text}' i], textarea[placeholder*='{target_text}' i]")
        if await fallback.count() > 0:
            await fallback.first.fill(value)
            return True, f"Filled placeholder match for '{target_text}'"

        return False, f"Could not find input for label '{target_text}'"
    except Exception as exc:  # noqa: BLE001
        return False, f"type_into_label failed: {exc}"


async def _select_dropdown(page: Page, target_text: str, value: str) -> tuple[bool, str]:
    try:
        locator = page.get_by_label(target_text, exact=False)
        if await locator.count() > 0:
            await locator.first.select_option(label=value)
            return True, f"Selected '{value}' for '{target_text}'"

        return False, f"Could not find dropdown for label '{target_text}'"
    except Exception as exc:  # noqa: BLE001
        return False, f"select_dropdown failed: {exc}"


async def _snapshot(page: Page) -> dict[str, Any]:
    screenshot_bytes = await page.screenshot(type="png", full_page=True)
    screenshot_base64 = base64.b64encode(screenshot_bytes).decode("utf-8")
    visible_text = (await page.locator("body").inner_text())[:4000]
    return {
        "current_url": page.url,
        "page_title": await page.title(),
        "visible_text": visible_text,
        "screenshot_base64": screenshot_base64,
        "timestamp": datetime.utcnow().isoformat(),
    }


async def _settle_after_action(page: Page) -> None:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=3000)
    except Exception:
        # Not every click triggers navigation; short wait keeps snapshots stable.
        await page.wait_for_timeout(350)
