from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.models.schemas import IntakeResponse, SessionState
from app.services.dependencies import (
    get_app_settings,
    get_notice_parser,
    get_session_store,
)
from app.services.notice_parser import NoticeParser
from app.services.session_store import LocalSessionStore

router = APIRouter(tags=["intake"])


@router.post("/intake/notice", response_model=IntakeResponse)
async def intake_notice(
    image: UploadFile = File(...),
    parser: NoticeParser = Depends(get_notice_parser),
    session_store: LocalSessionStore = Depends(get_session_store),
) -> IntakeResponse:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Upload must be an image file.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image payload is empty.")

    summary = parser.parse_notice(
        image_bytes=image_bytes,
        mime_type=image.content_type,
        filename=image.filename or "capture.jpg",
    )
    settings = get_app_settings()
    session = session_store.create_session(summary, user_profile=settings.default_user_profile)

    return IntakeResponse(
        session_id=session.session_id,
        status=session.status,
        notice_summary=session.notice_summary,
        checklist=session.checklist,
    )


@router.get("/session/{session_id}", response_model=SessionState)
def get_session(
    session_id: str,
    session_store: LocalSessionStore = Depends(get_session_store),
) -> SessionState:
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session
