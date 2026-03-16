from __future__ import annotations

from datetime import datetime
from pathlib import Path

from app.core.config import Settings
from app.models.schemas import NoticeSummary
from app.services.gemini_service import GeminiService


class NoticeParser:
    def __init__(
        self,
        settings: Settings,
        gemini_service: GeminiService,
        storage_service=None,
    ) -> None:
        self.settings = settings
        self.gemini_service = gemini_service
        self.storage_service = storage_service

        # Only create local directory if not using cloud storage
        if not storage_service:
            self.notices_dir = settings.notices_dir
            self.notices_dir.mkdir(parents=True, exist_ok=True)

    def parse_notice(self, image_bytes: bytes, mime_type: str, filename: str) -> NoticeSummary:
        saved_name = self._save_notice_image(image_bytes=image_bytes, filename=filename)
        summary = self.gemini_service.extract_notice(
            image_bytes=image_bytes,
            mime_type=mime_type,
            filename=saved_name,
        )
        return summary

    def _save_notice_image(self, image_bytes: bytes, filename: str) -> str:
        """Save notice image to Cloud Storage or local filesystem."""
        # Use cloud storage if available
        if self.storage_service:
            blob_path = self.storage_service.save_notice_image(
                image_bytes=image_bytes,
                filename=filename,
            )
            return blob_path

        # Fallback to local storage
        suffix = Path(filename).suffix or ".jpg"
        timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S-%f")
        safe_filename = f"notice-{timestamp}{suffix}"
        target = self.notices_dir / safe_filename
        target.write_bytes(image_bytes)
        return safe_filename
