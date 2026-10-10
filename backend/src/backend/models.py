"""Pydantic contracts for train observations and blockage predictions.

Mirrors frontend/lib/trains.ts. SIMULATION PROTOTYPE — not for dispatch.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator

PositionReference = Literal["front", "center", "rear"]


class TrainObservation(BaseModel):
    trainId: str = Field(..., min_length=1, description="Stable train identifier")
    observedAt: datetime = Field(..., description="ISO-8601 UTC time of the observation")
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    speedMps: float = Field(..., ge=0, le=80, description="Forward speed in m/s")
    lengthM: float = Field(..., gt=0, le=5000, description="Total train length in meters")
    degFromEast: float = Field(
        ...,
        description="Heading, math convention CCW from east: 0=E, 90=N, 180=W, 270=S",
    )
    positionReference: PositionReference = Field(
        default="front",
        description="Which point of the train lat/lon refers to",
    )

    @field_validator("trainId", mode="before")
    @classmethod
    def _strip_train_id(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @field_validator("observedAt", mode="before")
    @classmethod
    def _parse_time(cls, v: object) -> object:
        if isinstance(v, datetime):
            dt = v
        elif isinstance(v, str):
            text = v.strip().replace("Z", "+00:00")
            dt = datetime.fromisoformat(text)
        else:
            raise ValueError("observedAt must be ISO-8601")
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)

    @field_validator("degFromEast")
    @classmethod
    def _normalize_heading(cls, v: float) -> float:
        return v % 360

    @field_validator("positionReference", mode="before")
    @classmethod
    def _lower_ref(cls, v: object) -> object:
        return v.lower() if isinstance(v, str) else v


class Crossing(BaseModel):
    id: str
    dotId: str
    roadName: str
    latitude: float
    longitude: float
    railroad: str
    label: str | None = None


class BlockagePrediction(BaseModel):
    crossingId: str
    roadName: str
    latitude: float
    longitude: float
    blockStartUtc: datetime
    blockEndUtc: datetime
    etaSeconds: int
    clearSeconds: int
    distanceM: int
    lateralM: int
    status: Literal[
        "blocked_now",
        "blocked_soon",
        "upcoming",
        "cleared",
        "stopped_on_crossing",
        "unknown",
    ]
    trainId: str
    observedAt: datetime


class PredictionEnvelope(BaseModel):
    """What POST returns and SSE broadcasts."""

    type: Literal["predictions"] = "predictions"
    observation: TrainObservation
    predictions: list[BlockagePrediction]
    stale: bool = Field(
        default=False,
        description="True when the observation is older than the last one seen for this train",
    )
