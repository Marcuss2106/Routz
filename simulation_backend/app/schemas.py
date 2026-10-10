"""Wire contracts for acoustic observations and train-state estimates."""

from __future__ import annotations

import base64
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.geometry import CHUNK_DURATION_MS, SAMPLE_RATE_HZ, SAMPLES_PER_CHUNK


def pcm16_base64_to_floats(payload: str) -> list[float]:
    """Decode the little-endian PCM16 encoding used by the simulator."""
    try:
        raw = base64.b64decode(payload, validate=True)
    except Exception as exc:
        raise ValueError("audio_pcm16_base64 is not valid base64") from exc
    if len(raw) % 2 != 0:
        raise ValueError("pcm16 payload has an odd number of bytes")
    ints = np.frombuffer(raw, dtype="<i2").astype(np.float64)
    samples = np.empty_like(ints)
    negative = ints < 0
    samples[negative] = ints[negative] / 32768.0
    samples[~negative] = ints[~negative] / 32767.0
    return samples.tolist()


class MicrophoneChunk(BaseModel):
    """One synchronized microphone signal and its east/north geometry."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    x_m: float
    y_m: float
    audio: list[float] | None = None
    audio_pcm16_base64: str | None = None

    @model_validator(mode="after")
    def decode_audio(self) -> MicrophoneChunk:
        if self.audio is not None and self.audio_pcm16_base64 is not None:
            raise ValueError("send audio or audio_pcm16_base64, not both")
        if self.audio_pcm16_base64 is not None:
            self.audio = pcm16_base64_to_floats(self.audio_pcm16_base64)
            self.audio_pcm16_base64 = None
        if self.audio is None:
            raise ValueError("audio is required")
        return self

    def samples(self) -> list[float]:
        if self.audio is None:
            raise ValueError("audio was not decoded")
        return self.audio


class MicrophoneAudioChunk(BaseModel):
    """A timestamped array capture; it contains no train ground truth."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["microphone_audio_chunk"]
    simulation_id: str = Field(min_length=1)
    sequence: int = Field(ge=0)
    # This is the simulation timestamp of the first sample in each channel.
    simulation_time_s: float = Field(ge=0)
    sample_rate_hz: int
    duration_ms: int
    microphones: list[MicrophoneChunk]

    @model_validator(mode="after")
    def check_locked_audio_shape(self) -> MicrophoneAudioChunk:
        if self.sample_rate_hz != SAMPLE_RATE_HZ:
            raise ValueError(f"sample_rate_hz must be {SAMPLE_RATE_HZ}")
        if self.duration_ms != CHUNK_DURATION_MS:
            raise ValueError(f"duration_ms must be {CHUNK_DURATION_MS}")
        if len(self.microphones) != 3:
            raise ValueError("expected 3 microphones")
        ids = [mic.id for mic in self.microphones]
        if len(set(ids)) != 3:
            raise ValueError("microphone ids must be unique")
        for mic in self.microphones:
            if len(mic.samples()) != SAMPLES_PER_CHUNK:
                raise ValueError(
                    f"microphone {mic.id} must contain {SAMPLES_PER_CHUNK} samples"
                )
        return self


class SimulationReset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["simulation_reset"]
    simulation_id: str = Field(min_length=1)


class CrossingForecast(BaseModel):
    crossing_id: str
    eta_seconds: float | None
    estimated_blockage_seconds: float | None
    status: Literal["approaching", "blocking", "clear", "unknown"]


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


class TrainStateEstimateEvent(BaseModel):
    """An estimate derived from microphone audio, never from simulator truth."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["train_state_estimate"] = "train_state_estimate"
    simulation_id: str
    sequence: int
    simulation_time_s: float
    train_id: str
    track_id: str
    latitude: float | None
    longitude: float | None
    speed_mps: float | None = Field(default=None, ge=0)
    length_m: float | None = Field(default=None, ge=0)
    direction_deg_from_east: float | None = Field(default=None, ge=0, le=360)
    status: Literal["detected", "tracking", "length_pending", "cleared", "unknown"]
    confidence: EstimateConfidence
    uncertainty: EstimateUncertainty
    source: Literal["acoustic_array"] = "acoustic_array"
    label: Literal["simulated_acoustic_estimate"] = "simulated_acoustic_estimate"
    track_position_m: float | None = None
    crossings: list[CrossingForecast] = Field(default_factory=list)

    def frontend_payload(self) -> dict:
        return self.model_dump(mode="json")

    def user_backend_payload(self) -> dict:
        return self.model_dump(mode="json", exclude={"track_position_m", "label"})


# Compatibility name for publisher integrations that still import the old type.
CrossingPredictionEvent = TrainStateEstimateEvent
