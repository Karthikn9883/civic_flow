from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException

from app.clients.browser_client import BrowserWorkerClient
from app.core.config import Settings
from app.models.schemas import (
    ActionLogItem,
    BrowserSnapshot,
    ControlModeRequest,
    NavigationAction,
    PendingUserInput,
    ProvideInputRequest,
    SessionState,
    StartSessionResponse,
    StepResult,
)
from app.services.dependencies import (
    get_app_settings,
    get_browser_client,
    get_navigation_planner,
    get_session_store,
)
from app.services.navigation_planner import NavigationPlanner
from app.services.session_store import LocalSessionStore

router = APIRouter(tags=["navigation"])


@router.post("/session/{session_id}/start", response_model=StartSessionResponse)
async def start_navigation(
    session_id: str,
    session_store: LocalSessionStore = Depends(get_session_store),
    browser_client: BrowserWorkerClient = Depends(get_browser_client),
    settings: Settings = Depends(get_app_settings),
) -> StartSessionResponse:
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    portal_url = session.notice_summary.portal_url or settings.demo_portal_url
    start_payload = await browser_client.command(
        session_id=session_id,
        command="start_session",
        payload={"start_url": portal_url},
    )

    snapshot = _parse_snapshot_from_worker(start_payload)
    session.last_snapshot = snapshot
    session.status = "navigation_active"
    session.control_mode = "assistant"
    session.pending_user_input = None
    session.current_portal_step = _infer_portal_step(snapshot.current_url)
    session_store.mark_checklist_item(session, "Open portal", done=True)
    session_store.save_session(session)

    return StartSessionResponse(
        session_id=session.session_id,
        status=session.status,
        message="Guided navigation started.",
        snapshot=snapshot,
    )


@router.post("/session/{session_id}/step", response_model=StepResult)
async def run_navigation_step(
    session_id: str,
    session_store: LocalSessionStore = Depends(get_session_store),
    browser_client: BrowserWorkerClient = Depends(get_browser_client),
    planner: NavigationPlanner = Depends(get_navigation_planner),
    settings: Settings = Depends(get_app_settings),
) -> StepResult:
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status in {"completed", "blocked"}:
        return StepResult(
            session_id=session_id,
            status=session.status,
            step_number=session.step_count,
            planned_action=NavigationAction(action="finish", reason="Session already finished."),
            execution_success=True,
            message="Session already finished.",
            snapshot=session.last_snapshot,
        )

    if session.control_mode == "user":
        if session.status == "navigation_active":
            session.status = "awaiting_user_input"
        if session.pending_user_input is None:
            session.pending_user_input = PendingUserInput(
                field_key="manual_control",
                field_label="Manual control",
                prompt=(
                    "Manual control is enabled. Fill the page directly, then switch back to assistant mode to continue."
                ),
                sensitive=True,
            )
        session_store.save_session(session)
        return StepResult(
            session_id=session_id,
            status=session.status,
            step_number=session.step_count,
            planned_action=NavigationAction(
                action="wait",
                reason="Automation paused while manual control is enabled.",
            ),
            execution_success=True,
            message="Manual control is active. Switch back to Assistant mode when ready.",
            snapshot=session.last_snapshot,
        )

    if session.status == "awaiting_user_input" and session.pending_user_input:
        return StepResult(
            session_id=session_id,
            status=session.status,
            step_number=session.step_count,
            planned_action=NavigationAction(
                action="request_user_input",
                target_text=session.pending_user_input.field_label,
                input_value=session.pending_user_input.suggested_value,
                reason=session.pending_user_input.prompt,
            ),
            execution_success=True,
            message=session.pending_user_input.prompt,
            snapshot=session.last_snapshot,
        )

    if session.step_count >= settings.max_navigation_steps:
        session.status = "blocked"
        session.blocked_reason = "Reached max navigation steps."
        session_store.save_session(session)
        return StepResult(
            session_id=session_id,
            status=session.status,
            step_number=session.step_count,
            planned_action=NavigationAction(action="wait", reason=session.blocked_reason),
            execution_success=False,
            message=session.blocked_reason,
            snapshot=session.last_snapshot,
        )

    pre_snapshot_payload = await browser_client.command(
        session_id=session_id,
        command="screenshot",
        payload={},
    )
    pre_snapshot = _parse_snapshot_from_worker(pre_snapshot_payload)
    session.last_snapshot = pre_snapshot
    session.current_portal_step = _infer_portal_step(pre_snapshot.current_url)

    if pre_snapshot.current_url != session.last_url:
        session.last_url = pre_snapshot.current_url
        session.consecutive_scrolls = 0

    if session.consecutive_scrolls >= 2:
        action = NavigationAction(
            action="wait",
            reason=(
                "Scrolled twice on this page without finding forms. Need to try a different approach or navigate elsewhere."
            ),
        )
        session.consecutive_scrolls = 0
    else:
        planned = planner.plan_next_action(snapshot=pre_snapshot, session=session)
        action = _adapt_action_for_user_context(session=session, action=planned)

    if action.action == "request_user_input":
        session.step_count += 1
        session.pending_user_input = PendingUserInput(
            field_key=_normalize_field_key(action.target_text),
            field_label=action.target_text,
            prompt=action.reason or f"I need your {action.target_text} to continue.",
            sensitive=_is_sensitive_field(action.target_text),
            suggested_value=action.input_value,
        )
        session.status = "awaiting_user_input"
        session.consecutive_failures = 0
        _append_action_log(session=session, action=action, success=True, message=session.pending_user_input.prompt)
        session_store.save_session(session)
        return StepResult(
            session_id=session.session_id,
            status=session.status,
            step_number=session.step_count,
            planned_action=action,
            execution_success=True,
            message=session.pending_user_input.prompt,
            snapshot=pre_snapshot,
        )

    if action.action == "finish":
        session.status = "completed"
        session.pending_user_input = None
        session_store.mark_checklist_item(session, "Complete renewal form", done=True)
        session.step_count += 1
        _append_action_log(session=session, action=action, success=True, message=action.reason)
        session_store.save_session(session)
        return StepResult(
            session_id=session.session_id,
            status=session.status,
            step_number=session.step_count,
            planned_action=action,
            execution_success=True,
            message="Workflow marked complete.",
            snapshot=pre_snapshot,
        )

    execution = await browser_client.command(
        session_id=session_id,
        command=action.action,
        payload={
            "target_text": action.target_text,
            "input_value": action.input_value,
        },
    )

    success = bool(execution.get("success", False))
    message = str(execution.get("message", ""))

    post_snapshot_payload = await browser_client.command(
        session_id=session_id,
        command="screenshot",
        payload={},
    )
    post_snapshot = _parse_snapshot_from_worker(post_snapshot_payload)
    session.last_snapshot = post_snapshot
    session.current_portal_step = _infer_portal_step(post_snapshot.current_url)

    if success:
        session.consecutive_failures = 0
        session.pending_user_input = None
        _apply_form_state_update(session=session, action=action)

        if action.action == "scroll_down":
            session.consecutive_scrolls += 1
        elif action.action != "wait":
            session.consecutive_scrolls = 0
    else:
        session.consecutive_failures += 1

    session.step_count += 1
    _append_action_log(session=session, action=action, success=success, message=message)

    if "confirmation" in urlparse(post_snapshot.current_url).path.lower():
        session.status = "completed"
        session_store.mark_checklist_item(session, "Complete renewal form", done=True)
    elif session.consecutive_failures >= settings.max_consecutive_failures:
        session.status = "blocked"
        session.blocked_reason = "Navigation blocked due to repeated action failures."
    else:
        session.status = "navigation_active"

    session_store.save_session(session)

    return StepResult(
        session_id=session.session_id,
        status=session.status,
        step_number=session.step_count,
        planned_action=action,
        execution_success=success,
        message=message or ("Action executed." if success else "Action failed."),
        snapshot=post_snapshot,
    )


@router.post("/session/{session_id}/provide-input", response_model=StepResult)
async def provide_user_input(
    session_id: str,
    payload: ProvideInputRequest,
    session_store: LocalSessionStore = Depends(get_session_store),
    browser_client: BrowserWorkerClient = Depends(get_browser_client),
) -> StepResult:
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    value = payload.value.strip()
    if not value:
        raise HTTPException(status_code=400, detail="Input value is required")

    pending = session.pending_user_input
    field_label = payload.field_label.strip() or (pending.field_label if pending else "")
    if not field_label:
        raise HTTPException(status_code=400, detail="No pending input field is available")

    field_key = payload.field_key.strip() or (pending.field_key if pending else "") or _normalize_field_key(field_label)
    session.user_profile[field_key] = value

    action = NavigationAction(
        action="type_into_label",
        target_text=field_label,
        input_value=value,
        reason="User provided input value.",
    )

    execution = await browser_client.command(
        session_id=session_id,
        command="type_into_label",
        payload={
            "target_text": field_label,
            "input_value": value,
        },
    )
    success = bool(execution.get("success", False))
    message = str(execution.get("message", ""))

    snapshot = session.last_snapshot
    try:
        post_snapshot_payload = await browser_client.command(
            session_id=session_id,
            command="screenshot",
            payload={},
        )
        snapshot = _parse_snapshot_from_worker(post_snapshot_payload)
        session.last_snapshot = snapshot
        session.current_portal_step = _infer_portal_step(snapshot.current_url)
    except Exception:
        pass

    session.step_count += 1
    _append_action_log(session=session, action=action, success=success, message=message or "User input submitted.")

    if success:
        session.pending_user_input = None
        session.status = "navigation_active"
        _apply_form_state_update(session=session, action=action)
    else:
        session.status = "awaiting_user_input"
        session.pending_user_input = PendingUserInput(
            field_key=field_key,
            field_label=field_label,
            prompt=f"Could not fill '{field_label}' automatically. Please provide or adjust it and try again.",
            sensitive=_is_sensitive_field(field_label),
            suggested_value=value,
        )

    session_store.save_session(session)

    return StepResult(
        session_id=session.session_id,
        status=session.status,
        step_number=session.step_count,
        planned_action=action,
        execution_success=success,
        message=message or ("Input applied." if success else "Input failed."),
        snapshot=snapshot,
    )


@router.post("/session/{session_id}/control-mode", response_model=SessionState)
def set_control_mode(
    session_id: str,
    payload: ControlModeRequest,
    session_store: LocalSessionStore = Depends(get_session_store),
) -> SessionState:
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    session.control_mode = payload.mode

    if payload.mode == "user":
        if session.status == "navigation_active":
            session.status = "awaiting_user_input"
        if session.pending_user_input is None:
            session.pending_user_input = PendingUserInput(
                field_key="manual_control",
                field_label="Manual control",
                prompt=(
                    "Manual control enabled. Fill sensitive fields yourself, then switch back to assistant mode."
                ),
                sensitive=True,
            )
    else:
        if session.pending_user_input and session.pending_user_input.field_key == "manual_control":
            session.pending_user_input = None
        if session.status == "awaiting_user_input" and session.pending_user_input is None:
            session.status = "navigation_active"

    session_store.save_session(session)
    return session


@router.get("/session/{session_id}/status", response_model=SessionState)
def get_navigation_status(
    session_id: str,
    session_store: LocalSessionStore = Depends(get_session_store),
) -> SessionState:
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


def _parse_snapshot_from_worker(payload: dict[str, Any]) -> BrowserSnapshot:
    snapshot = payload.get("snapshot", payload)
    if not isinstance(snapshot, dict):
        raise HTTPException(status_code=502, detail="Browser worker returned invalid snapshot payload")
    return BrowserSnapshot.model_validate(snapshot)


def _normalize_field_key(label: str) -> str:
    lowered = label.strip().lower()
    if "notice" in lowered or "reference" in lowered or "case" in lowered:
        return "reference_number"
    if "birth" in lowered or "dob" in lowered:
        return "date_of_birth"
    if "street" in lowered or "address" in lowered:
        return "street_address"
    if "zip" in lowered or "postal" in lowered:
        return "zip_code"
    if "email" in lowered:
        return "email"
    if "password" in lowered or "passcode" in lowered:
        return "password"
    if "phone" in lowered:
        return "phone"
    normalized = re.sub(r"[^a-z0-9]+", "_", lowered).strip("_")
    return normalized or "value"


def _is_sensitive_field(label: str) -> bool:
    lowered = label.strip().lower()
    sensitive_patterns = (
        "password",
        "passcode",
        "pin",
        "social security",
        "ssn",
        "tax id",
        "ein",
        "routing",
        "account number",
        "card number",
        "cvv",
        "verification code",
        "one-time code",
        "security answer",
        "email",
        "phone",
    )
    return any(pattern in lowered for pattern in sensitive_patterns)


def _looks_placeholder_value(value: str) -> bool:
    lowered = value.strip().lower()
    if not lowered:
        return True
    placeholder_patterns = (
        "example",
        "user@",
        "@example.com",
        "your ",
        "test",
        "sample",
        "placeholder",
        "12345",
        "000",
        "xxxxx",
    )
    return any(pattern in lowered for pattern in placeholder_patterns)


def _resolve_input_value_from_profile(session: SessionState, target_text: str, model_value: str) -> str:
    key = _normalize_field_key(target_text)
    profile_value = str(session.user_profile.get(key, "")).strip()
    if profile_value:
        return profile_value

    if key == "reference_number":
        reference_number = session.notice_summary.reference_number.strip()
        if reference_number:
            return reference_number

    candidate = model_value.strip()
    if _looks_placeholder_value(candidate):
        return ""
    return candidate


def _adapt_action_for_user_context(session: SessionState, action: NavigationAction) -> NavigationAction:
    if action.action not in {"type_into_label", "select_dropdown"}:
        return action

    resolved_value = _resolve_input_value_from_profile(
        session=session,
        target_text=action.target_text,
        model_value=action.input_value,
    )

    if _is_sensitive_field(action.target_text):
        return NavigationAction(
            action="request_user_input",
            target_text=action.target_text,
            input_value=resolved_value,
            reason=(
                action.reason
                or f"Please provide or confirm your {action.target_text} so I can continue safely."
            ),
        )

    if not resolved_value:
        return NavigationAction(
            action="request_user_input",
            target_text=action.target_text,
            reason=f"I need your {action.target_text} to continue this form.",
        )

    return NavigationAction(
        action=action.action,
        target_text=action.target_text,
        input_value=resolved_value,
        reason=action.reason,
    )


def _apply_form_state_update(session: SessionState, action: NavigationAction) -> None:
    if action.action != "type_into_label":
        return

    label = action.target_text.strip().lower()
    if "notice" in label or "reference" in label:
        session.form_state["notice_id_filled"] = True
    elif "birth" in label:
        session.form_state["dob_filled"] = True
    elif "street" in label or "address" in label:
        session.form_state["address_filled"] = True
    elif "zip" in label:
        session.form_state["zip_filled"] = True
    elif "email" in label:
        session.form_state["email_filled"] = True
    elif "password" in label:
        session.form_state["password_filled"] = True


def _append_action_log(session: SessionState, action: NavigationAction, success: bool, message: str) -> None:
    session.action_log.append(
        ActionLogItem(
            step_number=session.step_count,
            action=action,
            success=success,
            message=message,
        )
    )


def _infer_portal_step(url: str) -> str:
    path = urlparse(url).path.lower()
    if "identity" in path:
        return "identity_verification"
    if "address" in path:
        return "address_confirmation"
    if "review" in path:
        return "review"
    if "confirmation" in path:
        return "submitted"
    return "start"
