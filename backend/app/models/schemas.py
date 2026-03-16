from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

ActionType = Literal[
    "click_by_text",
    "type_into_label",
    "select_dropdown",
    "scroll_down",
    "wait",
    "request_user_input",
    "finish",
]

SessionStatus = Literal[
    "notice_scanned",
    "navigation_ready",
    "navigation_active",
    "awaiting_user_input",
    "completed",
    "blocked",
    "error",
]

ControlMode = Literal[
    "assistant",
    "user",
]


class NoticeSummary(BaseModel):
    document_type: str = "Unknown Notice"
    deadline: str = ""
    reference_number: str = ""
    summary_plain_english: str = ""
    required_items: list[str] = Field(default_factory=list)
    confidence_notes: list[str] = Field(default_factory=list)
    portal_url: str = ""  # URL of the government portal to navigate


class ChecklistItem(BaseModel):
    label: str
    done: bool = False


class NavigationAction(BaseModel):
    action: ActionType
    target_text: str = ""
    input_value: str = ""
    reason: str = ""


class BrowserSnapshot(BaseModel):
    current_url: str = ""
    page_title: str = ""
    visible_text: str = ""
    screenshot_base64: str = ""
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class ActionLogItem(BaseModel):
    step_number: int
    action: NavigationAction
    success: bool
    message: str = ""
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class PendingUserInput(BaseModel):
    field_key: str = ""
    field_label: str = ""
    prompt: str = ""
    sensitive: bool = False
    suggested_value: str = ""


class SessionState(BaseModel):
    session_id: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    status: SessionStatus = "notice_scanned"

    notice_summary: NoticeSummary
    checklist: list[ChecklistItem] = Field(default_factory=list)

    current_portal_step: str = "not_started"
    step_count: int = 0
    consecutive_failures: int = 0
    consecutive_scrolls: int = 0  # Track scroll actions to prevent doom scrolling
    last_url: str = ""  # Track URL changes to reset scroll counter
    blocked_reason: str = ""

    form_state: dict[str, bool] = Field(default_factory=dict)
    user_profile: dict[str, Any] = Field(default_factory=dict)
    pending_user_input: PendingUserInput | None = None
    control_mode: ControlMode = "assistant"

    last_snapshot: BrowserSnapshot | None = None
    action_log: list[ActionLogItem] = Field(default_factory=list)


class IntakeResponse(BaseModel):
    session_id: str
    status: SessionStatus
    notice_summary: NoticeSummary
    checklist: list[ChecklistItem]


class StartSessionResponse(BaseModel):
    session_id: str
    status: SessionStatus
    message: str
    snapshot: BrowserSnapshot | None = None


class StepResult(BaseModel):
    session_id: str
    status: SessionStatus
    step_number: int
    planned_action: NavigationAction
    execution_success: bool
    message: str
    snapshot: BrowserSnapshot | None = None


class WorkerCommandRequest(BaseModel):
    session_id: str
    command: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ProvideInputRequest(BaseModel):
    value: str
    field_key: str = ""
    field_label: str = ""


class ControlModeRequest(BaseModel):
    mode: ControlMode
