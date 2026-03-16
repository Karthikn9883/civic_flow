from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from threading import Lock
from uuid import uuid4

from app.models.schemas import ChecklistItem, NoticeSummary, SessionState


class InMemorySessionStore:
    """In-memory session store for simplicity."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}
        self._lock = Lock()

    def create_session(self, notice_summary: NoticeSummary, user_profile: dict) -> SessionState:
        session_id = uuid4().hex[:12]
        checklist = [
            ChecklistItem(label="Scan notice", done=True),
            ChecklistItem(label="Extract deadline", done=bool(notice_summary.deadline)),
            ChecklistItem(label="Open portal", done=False),
            ChecklistItem(label="Complete renewal form", done=False),
        ]
        session = SessionState(
            session_id=session_id,
            notice_summary=notice_summary,
            checklist=checklist,
            status="notice_scanned",
            form_state={
                "notice_id_filled": False,
                "dob_filled": False,
                "address_filled": False,
                "zip_filled": False,
                "email_filled": False,
                "password_filled": False,
            },
            user_profile=user_profile,
        )
        with self._lock:
            self._sessions[session_id] = session
        return session

    def get_session(self, session_id: str) -> SessionState | None:
        return self._sessions.get(session_id)

    def save_session(self, session: SessionState) -> None:
        session.updated_at = datetime.utcnow()
        with self._lock:
            self._sessions[session.session_id] = session

    def mark_checklist_item(self, session: SessionState, label: str, done: bool = True) -> None:
        for item in session.checklist:
            if item.label == label:
                item.done = done
                return


class LocalSessionStore:
    """Local JSON file session store (fallback/development mode)."""

    def __init__(self, sessions_dir: Path) -> None:
        self.sessions_dir = sessions_dir
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def create_session(self, notice_summary: NoticeSummary, user_profile: dict) -> SessionState:
        session_id = uuid4().hex[:12]
        checklist = [
            ChecklistItem(label="Scan notice", done=True),
            ChecklistItem(label="Extract deadline", done=bool(notice_summary.deadline)),
            ChecklistItem(label="Open portal", done=False),
            ChecklistItem(label="Complete renewal form", done=False),
        ]
        session = SessionState(
            session_id=session_id,
            notice_summary=notice_summary,
            checklist=checklist,
            status="notice_scanned",
            form_state={
                "notice_id_filled": False,
                "dob_filled": False,
                "address_filled": False,
                "zip_filled": False,
                "email_filled": False,
                "password_filled": False,
            },
            user_profile=user_profile,
        )
        self.save_session(session)
        return session

    def get_session(self, session_id: str) -> SessionState | None:
        path = self._session_path(session_id)
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return SessionState.model_validate(data)

    def save_session(self, session: SessionState) -> None:
        session.updated_at = datetime.utcnow()
        payload = session.model_dump(mode="json")
        with self._lock:
            self._session_path(session.session_id).write_text(
                json.dumps(payload, indent=2),
                encoding="utf-8",
            )

    def mark_checklist_item(self, session: SessionState, label: str, done: bool = True) -> None:
        for item in session.checklist:
            if item.label == label:
                item.done = done
                return

    def _session_path(self, session_id: str) -> Path:
        return self.sessions_dir / f"{session_id}.json"


class CloudSessionStore:
    """Cloud-native session store using Firestore."""

    def __init__(self, firestore_service) -> None:
        from app.services.firestore_service import FirestoreService

        self.firestore: FirestoreService = firestore_service

    def create_session(self, notice_summary: NoticeSummary, user_profile: dict) -> SessionState:
        session_id = uuid4().hex[:12]
        checklist = [
            ChecklistItem(label="Scan notice", done=True),
            ChecklistItem(label="Extract deadline", done=bool(notice_summary.deadline)),
            ChecklistItem(label="Open portal", done=False),
            ChecklistItem(label="Complete renewal form", done=False),
        ]
        session = SessionState(
            session_id=session_id,
            notice_summary=notice_summary,
            checklist=checklist,
            status="notice_scanned",
            form_state={
                "notice_id_filled": False,
                "dob_filled": False,
                "address_filled": False,
                "zip_filled": False,
                "email_filled": False,
                "password_filled": False,
            },
            user_profile=user_profile,
        )
        self.save_session(session)
        return session

    def get_session(self, session_id: str) -> SessionState | None:
        return self.firestore.get_session(session_id)

    def save_session(self, session: SessionState) -> None:
        session.updated_at = datetime.utcnow()
        self.firestore.save_session(session)

    def mark_checklist_item(self, session: SessionState, label: str, done: bool = True) -> None:
        for item in session.checklist:
            if item.label == label:
                item.done = done
                return
