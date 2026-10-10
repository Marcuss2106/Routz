"""Process environment for the simulation backend."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from app.geometry import SAMPLE_RATE_HZ


@dataclass(frozen=True)
class Settings:
    allowed_origins: list[str]
    predictions_url: str
    internal_api_token: str
    sample_rate_hz: int

    @classmethod
    def from_env(cls) -> Settings:
        load_dotenv(Path(__file__).resolve().parents[1] / ".env")
        origins = os.getenv(
            "SIMULATION_ALLOWED_ORIGINS",
            "http://localhost:3000,http://localhost:3100",
        )
        sample_rate_hz = int(os.getenv("AUDIO_SAMPLE_RATE_HZ", str(SAMPLE_RATE_HZ)))
        if sample_rate_hz != SAMPLE_RATE_HZ:
            raise RuntimeError(
                f"AUDIO_SAMPLE_RATE_HZ must be {SAMPLE_RATE_HZ} for the locked demo contract"
            )
        return cls(
            allowed_origins=[origin.strip() for origin in origins.split(",") if origin.strip()],
            predictions_url=os.getenv("USER_BACKEND_PREDICTIONS_URL", ""),
            internal_api_token=os.getenv("INTERNAL_API_TOKEN", ""),
            sample_rate_hz=sample_rate_hz,
        )
