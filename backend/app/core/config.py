from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[3] / ".env",
        env_file_encoding="utf-8",
        env_prefix="CIVICFLOW_",
        extra="ignore",
    )

    app_name: str = "CivicFlow API Orchestrator"
    app_env: str = "dev"
    host: str = "0.0.0.0"
    port: int = 8000

    browser_worker_url: str = "http://localhost:8001"

    worker_timeout_seconds: int = 60
    max_navigation_steps: int = 25
    max_consecutive_failures: int = 3

    gemini_mode: str = "vertex"
    gemini_notice_model: str = "gemini-2.5-flash"
    gemini_planner_model: str = "gemini-2.5-flash"
    gcp_project: str = ""
    gcp_location: str = "us-east4"
    google_application_credentials: str = ""
    storage_bucket: str = ""

    default_user_profile_raw: str = Field(
        default='{"date_of_birth":"1949-01-12","street_address":"123 Maple Ave","zip_code":"94107"}'
    )

    @property
    def project_root(self) -> Path:
        return Path(__file__).resolve().parents[3]

    @property
    def storage_root(self) -> Path:
        return self.project_root / "runtime_storage"

    @property
    def notices_dir(self) -> Path:
        return self.storage_root / "notices"

    @property
    def sessions_dir(self) -> Path:
        return self.storage_root / "sessions"

    @property
    def default_user_profile(self) -> dict[str, Any]:
        try:
            parsed = json.loads(self.default_user_profile_raw)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
        return {
            "date_of_birth": "1949-01-12",
            "street_address": "123 Maple Ave",
            "zip_code": "94107",
        }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()

    # Resolve relative ADC paths from repo root so running inside subfolders still works
    adc_path = settings.google_application_credentials.strip()
    if adc_path and not Path(adc_path).is_absolute():
        resolved = settings.project_root / adc_path
        if resolved.exists():
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(resolved)
            settings.google_application_credentials = str(resolved)
        else:
            # If relative path doesn't exist, try from current working directory
            cwd_path = Path.cwd() / adc_path
            if cwd_path.exists():
                os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(cwd_path)
                settings.google_application_credentials = str(cwd_path)
    elif adc_path:
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = adc_path

    # Create local storage directories (used for notice images)
    settings.storage_root.mkdir(parents=True, exist_ok=True)
    settings.notices_dir.mkdir(parents=True, exist_ok=True)

    return settings
