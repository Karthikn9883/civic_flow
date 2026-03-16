from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.core.config import Settings
from app.models.schemas import BrowserSnapshot, NavigationAction, NoticeSummary, SessionState

logger = logging.getLogger(__name__)

NOTICE_PROMPT = """
You are an expert assistant helping older adults understand government and official mailed notices.

Analyze this notice image carefully and extract the following information:

1. **document_type**: The type of notice (e.g., "Benefits Renewal Notice", "Housing Assistance Recertification", "Medicaid Renewal", etc.)
2. **deadline**: The exact deadline date if visible (format: YYYY-MM-DD). If not visible, return empty string.
3. **reference_number**: Any reference number, case number, or notice ID visible on the document. Look carefully for ANY ID numbers, codes, or tracking numbers. If truly not found, return empty string.
4. **summary_plain_english**: A clear, simple explanation (2-3 sentences) of what this notice is asking the person to do. Write at a 6th-grade reading level.
5. **required_items**: A list of information or documents the person will likely need. If reference_number is missing, INCLUDE "Locate the Notice ID or Reference Number" as the FIRST item.
6. **confidence_notes**: Any warnings or uncertainty about the extraction (e.g., "Deadline partially obscured", "No reference number found - user needs to locate it", "Document quality is low")
7. **portal_url**: The website URL if visible on the notice (e.g., "https://www.benefits.gov/renew"). If no URL is visible, return empty string.

IMPORTANT: If critical information like reference_number is missing, note it in both required_items and confidence_notes so the user knows to find it.

Return ONLY a JSON object with these exact keys. No markdown, no extra text.

Example output:
{{
  "document_type": "Benefits Renewal Notice",
  "deadline": "2026-04-15",
  "reference_number": "RN-20481",
  "summary_plain_english": "Your benefits need to be renewed before the deadline. You must verify your identity and address to keep receiving assistance.",
  "required_items": ["Notice ID", "Date of birth", "Street address", "ZIP code"],
  "confidence_notes": [],
  "portal_url": "https://www.benefits.gov/renew"
}}
""".strip()

PLANNER_PROMPT = """
You are an intelligent web navigation agent helping older adults complete government forms and paperwork online.

Your job is to analyze the current webpage and decide the NEXT SINGLE ACTION to take.

CONTEXT: You are helping someone complete a task related to: {current_goal}

Available actions:
- click_by_text: Click a button, link, or element by its visible text
- type_into_label: Type text into an input field identified by its label
- select_dropdown: Select an option from a dropdown by its label
- scroll_down: Scroll down the page to see more content
- wait: Pause (use when page is loading or you need to observe changes)
- request_user_input: Ask the user for a missing or sensitive value and pause automation
- finish: Mark the task as complete (ONLY when you see clear confirmation of successful completion)

CRITICAL RULES - Follow these exactly:
1. **NEVER SCROLL MORE THAN 2 TIMES** - If you scrolled twice without finding forms, STOP scrolling. Click "Back" or try a different link.
2. **BE INSTANT AND DECISIVE** - Make quick decisions. Don't overthink. Speed matters.
3. **FORMS ONLY** - If you don't see input fields (text boxes, dropdowns, checkboxes) within 2 scrolls, you're on the WRONG page.
4. **ACTION BIAS** - Prefer clicking buttons (Apply, Start, Continue, Submit, Next) over scrolling or waiting.
5. **FILL IMMEDIATELY** - When you see form fields, fill them NOW. Don't scroll past forms.
6. **AVOID INFORMATION PAGES** - Skip links like "Learn More", "FAQ", "About", "Information".
7. **USE AVAILABLE DATA** - You have all the user's information in the context. Use it to fill forms instantly.
8. **ASK FOR SENSITIVE OR MISSING VALUES** - For fields like email, password, SSN, bank details, phone, verification codes, or any unknown value, use `request_user_input`.

Current page information:
{context}

Return ONLY a JSON object with these keys:
- action: one of the allowed actions
- target_text: the visible text to click/type into (required for click_by_text, type_into_label, select_dropdown)
- input_value: the text to enter (required for type_into_label, select_dropdown)
- reason: brief explanation of why you chose this action

Example:
{{
  "action": "type_into_label",
  "target_text": "Notice ID",
  "input_value": "RN-20481",
  "reason": "Fill the notice reference number to verify identity"
}}
""".strip()


class GeminiService:
    """Production Gemini service using Vertex AI only."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

        if not self.settings.gcp_project:
            raise RuntimeError(
                "GCP_PROJECT is required. Set CIVICFLOW_GCP_PROJECT in your environment."
            )

        # Import Vertex AI SDK
        try:
            from google import genai
            from google.genai import types

            self._genai = genai
            self._types = types
        except ImportError as exc:
            raise RuntimeError(
                "google-genai package is not installed. Run: pip install google-genai"
            ) from exc

        # Initialize Vertex AI client
        self._client = genai.Client(
            vertexai=True,
            project=self.settings.gcp_project,
            location=self.settings.gcp_location,
        )

        logger.info(
            f"Initialized Gemini service with project={self.settings.gcp_project}, "
            f"location={self.settings.gcp_location}"
        )

    def extract_notice(self, image_bytes: bytes, mime_type: str, filename: str) -> NoticeSummary:
        """Extract structured information from a notice image using Gemini Vision.

        Args:
            image_bytes: Raw image bytes
            mime_type: MIME type (e.g., 'image/jpeg')
            filename: Original filename (for logging)

        Returns:
            NoticeSummary with extracted fields

        Raises:
            RuntimeError: If Gemini API fails
            ValueError: If response is not valid JSON
        """
        logger.info(f"Extracting notice from image: {filename} ({mime_type})")

        try:
            # Define JSON schema to ensure correct structure
            response_schema = {
                "type": "object",
                "properties": {
                    "document_type": {"type": "string"},
                    "deadline": {"type": "string"},
                    "reference_number": {"type": "string"},
                    "summary_plain_english": {"type": "string"},
                    "required_items": {"type": "array", "items": {"type": "string"}},
                    "confidence_notes": {"type": "array", "items": {"type": "string"}},
                    "portal_url": {"type": "string"},
                },
                "required": ["document_type", "deadline", "reference_number", "summary_plain_english", "required_items", "confidence_notes", "portal_url"],
            }

            response = self._client.models.generate_content(
                model=self.settings.gemini_notice_model,
                contents=[
                    NOTICE_PROMPT,
                    self._types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                ],
                config=self._types.GenerateContentConfig(
                    temperature=0.1,  # Low temperature for consistent extraction
                    max_output_tokens=1024,
                    response_mime_type="application/json",  # Force JSON output
                    response_schema=response_schema,  # Enforce schema
                ),
            )

            # Get full response text from candidates
            response_text = ""
            if hasattr(response, 'candidates') and response.candidates:
                candidate = response.candidates[0]
                if hasattr(candidate, 'content') and hasattr(candidate.content, 'parts'):
                    parts = candidate.content.parts
                    response_text = "".join(part.text for part in parts if hasattr(part, 'text'))

            # Fallback to response.text
            if not response_text and hasattr(response, 'text'):
                response_text = response.text

            if not response_text:
                raise RuntimeError("Gemini returned empty response")

            # Extract JSON from response
            payload = self._extract_json_object(response_text)
            logger.info(f"Successfully extracted notice: {payload.get('document_type', 'Unknown')}")

            # Validate and return
            return NoticeSummary.model_validate(payload)

        except Exception as exc:
            logger.error(f"Failed to extract notice: {exc}", exc_info=True)
            raise RuntimeError(f"Notice extraction failed: {exc}") from exc

    def plan_ui_action(self, snapshot: BrowserSnapshot, session: SessionState) -> NavigationAction:
        """Plan the next UI action based on current page state.

        Args:
            snapshot: Current browser state (screenshot, URL, text)
            session: Current session state

        Returns:
            NavigationAction with the next step

        Raises:
            RuntimeError: If Gemini API fails
            ValueError: If response is not valid JSON
        """
        logger.info(f"Planning action for URL: {snapshot.current_url}")

        # Build dynamic goal from notice
        goal_description = session.notice_summary.summary_plain_english or "Complete the online form"

        # Build context for the planner
        context = {
            "current_url": snapshot.current_url,
            "page_title": snapshot.page_title,
            "visible_text": snapshot.visible_text[:3000],  # Increased for better context
            "session_status": session.status,
            "control_mode": session.control_mode,
            "document_type": session.notice_summary.document_type,
            "deadline": session.notice_summary.deadline,
            "required_items": session.notice_summary.required_items,
            "user_has_reference_number": bool(session.notice_summary.reference_number),
            "user_profile": session.user_profile,
            "pending_user_input": (
                session.pending_user_input.model_dump() if session.pending_user_input else None
            ),
            "completed_steps": [item.label for item in session.checklist if item.done],
            "pending_steps": [item.label for item in session.checklist if not item.done],
        }

        # Format prompt with goal
        prompt = PLANNER_PROMPT.format(
            current_goal=goal_description,
            context=json.dumps(context, indent=2)
        )

        try:
            response = self._client.models.generate_content(
                model=self.settings.gemini_planner_model,
                contents=[prompt],
                config=self._types.GenerateContentConfig(
                    temperature=0.2,  # Low temperature for deterministic planning
                    max_output_tokens=2048,  # Increased to prevent truncation
                    response_mime_type="application/json",  # Force JSON output
                ),
            )

            # Try to get full response text from candidates
            response_text = ""
            if hasattr(response, 'candidates') and response.candidates:
                candidate = response.candidates[0]
                if hasattr(candidate, 'content') and hasattr(candidate.content, 'parts'):
                    parts = candidate.content.parts
                    response_text = "".join(part.text for part in parts if hasattr(part, 'text'))

            # Fallback to response.text
            if not response_text and hasattr(response, 'text'):
                response_text = response.text

            if not response_text:
                raise RuntimeError("Gemini returned empty response")

            # Log raw response for debugging
            logger.info(f"Raw Gemini planner response: {response_text[:200]}")

            # Extract JSON from response
            payload = self._extract_json_object(response_text)
            logger.info(f"Planned action: {payload.get('action')} - {payload.get('reason')}")

            # Validate and return
            action = NavigationAction.model_validate(payload)
            return self._validate_action(action)

        except Exception as exc:
            logger.error(f"Failed to plan action: {exc}", exc_info=True)
            # Return safe fallback
            return NavigationAction(
                action="wait",
                reason=f"Error planning action: {str(exc)[:100]}",
            )

    def _validate_action(self, action: NavigationAction) -> NavigationAction:
        """Validate that the planned action is safe and has required fields."""
        ALLOWED_ACTIONS = {
            "click_by_text",
            "type_into_label",
            "select_dropdown",
            "scroll_down",
            "wait",
            "request_user_input",
            "finish",
        }

        if action.action not in ALLOWED_ACTIONS:
            logger.warning(f"Invalid action '{action.action}', fallback to wait")
            return NavigationAction(
                action="wait",
                reason=f"Model returned unsupported action '{action.action}'",
            )

        # Validate required fields
        if action.action in {"click_by_text", "type_into_label", "select_dropdown", "request_user_input"}:
            if not action.target_text:
                logger.warning(f"Action '{action.action}' missing target_text, fallback to wait")
                return NavigationAction(
                    action="wait",
                    reason=f"Action '{action.action}' requires target_text",
                )

        if action.action in {"type_into_label", "select_dropdown"}:
            if not action.input_value:
                logger.warning(f"Action '{action.action}' missing input_value, fallback to wait")
                return NavigationAction(
                    action="wait",
                    reason=f"Action '{action.action}' requires input_value",
                )

        return action

    def _extract_json_object(self, text: str) -> dict[str, Any]:
        """Extract JSON object from Gemini response text.

        Handles responses wrapped in markdown code blocks.
        """
        cleaned = text.strip()

        # Remove markdown code blocks
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            # Remove language identifier (e.g., "json")
            lines = cleaned.split("\n", 1)
            if len(lines) > 1 and lines[0].strip().lower() in {"json", ""}:
                cleaned = lines[1] if len(lines) > 1 else lines[0]

        cleaned = cleaned.strip()

        # Try direct parse first
        try:
            maybe = json.loads(cleaned)
            if isinstance(maybe, dict):
                return maybe
        except json.JSONDecodeError:
            pass

        # Try to find JSON object in text
        match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
        if not match:
            raise ValueError("No JSON object found in Gemini response")

        try:
            payload = json.loads(match.group(0))
            if not isinstance(payload, dict):
                raise ValueError("Gemini output JSON must be an object")
            return payload
        except json.JSONDecodeError as exc:
            raise ValueError(f"Failed to parse JSON from Gemini response: {exc}") from exc
