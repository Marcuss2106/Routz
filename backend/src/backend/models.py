"""Pydantic contracts for train observations and blockage predictions.

Mirrors frontend/lib/trains.ts. SIMULATION PROTOTYPE — not for dispatch.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
    # True while the train length is an occupancy-based provisional estimate,
    # so blockEndUtc is a lower bound rather than a settled clearance time.
    lengthProvisional: bool = False


class EstimateConfidence(BaseModel):
    position: float = Field(ge=0, le=1)
    speed: float = Field(ge=0, le=1)
    length: float = Field(ge=0, le=1)
    direction: float = Field(ge=0, le=1)


class EstimateUncertainty(BaseModel):
    position_m: float | None = Field(default=None, ge=0)
    speed_mps: float | None = Field(default=None, ge=0)
    length_m: float | None = Field(default=None, ge=0)
    direction_deg: float | None = Field(default=None, ge=0)


class MapState(BaseModel):
    """Acoustic estimate re-expressed on the demo map corridor (simulated).

    The acoustic rail is not on the real map, so the user backend applies the
    fixed transform in ``backend.demo_anchor``. Raw acoustic values stay in the
    canonical event fields.
    """

    anchor: str
    label: Literal["simulated_demo_anchor"] = "simulated_demo_anchor"
    position_reference: PositionReference = "front"
    latitude: float
    longitude: float
    speed_mps: float | None = Field(default=None, ge=0)
    direction_deg_from_east: float | None = Field(default=None, ge=0, le=360)
    length_m: float | None = Field(default=None, ge=0, le=5000)
    provisional_length_m: float | None = Field(default=None, ge=0, le=5000)


class CrossingEstimate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    crossing_id: str = Field(min_length=1)
    eta_seconds: float | None = None
    estimated_blockage_seconds: float | None = None
    status: Literal["approaching", "blocking", "clear", "unknown"]


class TrainStateEstimate(BaseModel):
    """Canonical acoustic estimate carried from inference to the user map."""

    model_config = ConfigDict(extra="ignore")

    type: Literal["train_state_estimate"] = "train_state_estimate"
    simulation_id: str = Field(min_length=1)
    sequence: int = Field(ge=0)
    simulation_time_s: float = Field(ge=0)
    train_id: str = Field(min_length=1)
    track_id: str = Field(min_length=1)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    speed_mps: float | None = Field(default=None, ge=0)
    length_m: float | None = Field(default=None, ge=0, le=5000)
    provisional_length_m: float | None = Field(default=None, ge=0, le=5000)
    direction_deg_from_east: float | None = Field(default=None, ge=0, le=360)
    status: Literal["detected", "tracking", "length_pending", "cleared", "unknown"]
    confidence: EstimateConfidence
    uncertainty: EstimateUncertainty
    source: Literal["acoustic_array"] = "acoustic_array"
    label: Literal["simulated_acoustic_estimate"] = "simulated_acoustic_estimate"
    track_position_m: float | None = None
    crossings: list[CrossingEstimate] = Field(default_factory=list)
    map_state: MapState | None = None
    predictions: list[BlockagePrediction] = Field(default_factory=list)


class PredictionEnvelope(BaseModel):
    """What POST returns and SSE broadcasts."""

    type: Literal["predictions"] = "predictions"
    observation: TrainObservation
    predictions: list[BlockagePrediction]
    stale: bool = Field(
        default=False,
        description="True when the observation is older than the last one seen for this train",
    )
