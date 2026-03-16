from __future__ import annotations

from app.models.schemas import BrowserSnapshot, NavigationAction, SessionState
from app.services.gemini_service import GeminiService

ALLOWED_ACTIONS = {
    "click_by_text",
    "type_into_label",
    "select_dropdown",
    "scroll_down",
    "wait",
    "request_user_input",
    "finish",
}


class NavigationPlanner:
    def __init__(self, gemini_service: GeminiService) -> None:
        self.gemini_service = gemini_service

    def plan_next_action(self, snapshot: BrowserSnapshot, session: SessionState) -> NavigationAction:
        action = self.gemini_service.plan_ui_action(snapshot=snapshot, session=session)
        return self._validate_action(action)

    def _validate_action(self, action: NavigationAction) -> NavigationAction:
        if action.action not in ALLOWED_ACTIONS:
            return NavigationAction(
                action="wait",
                reason=f"Model returned unsupported action '{action.action}'.",
            )

        if action.action in {"click_by_text", "type_into_label", "select_dropdown", "request_user_input"} and not action.target_text:
            return NavigationAction(
                action="wait",
                reason=f"Action '{action.action}' is missing target_text.",
            )

        if action.action in {"type_into_label", "select_dropdown"} and not action.input_value:
            return NavigationAction(
                action="wait",
                reason=f"Action '{action.action}' is missing input_value.",
            )

        return action
