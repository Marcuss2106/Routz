"""Process environment for the user backend."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

_PLACEHOLDERS = {
    "",
    "replace-with-private-key-if-generated-server-side",
    "replace-with-shared-private-token",
}
_DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"


def configured_secret(value: str) -> str:
    """Treat blank and template placeholders as unset."""
    cleaned = value.strip()
    if cleaned in _PLACEHOLDERS:
        return ""
    return cleaned


@dataclass(frozen=True)
class Settings:
    allowed_origins: list[str]
    internal_api_token: str
    elevenlabs_api_key: str
    elevenlabs_voice_id: str
    host: str
    port: int

    @classmethod
    def from_env(cls) -> Settings:
        load_dotenv(Path(__file__).resolve().parents[2] / ".env")
        origins = os.getenv(
            "USER_ALLOWED_ORIGINS",
            "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001",
        )
        return cls(
            allowed_origins=[
                origin.strip() for origin in origins.split(",") if origin.strip()
            ],
            internal_api_token=configured_secret(os.getenv("INTERNAL_API_TOKEN", "")),
            elevenlabs_api_key=configured_secret(os.getenv("ELEVENLABS_API_KEY", "")),
            elevenlabs_voice_id=os.getenv("ELEVENLABS_VOICE_ID", _DEFAULT_VOICE_ID).strip()
            or _DEFAULT_VOICE_ID,
            host=os.getenv("USER_BACKEND_HOST", "0.0.0.0"),
            port=int(os.getenv("USER_BACKEND_PORT", "8001")),
        )
