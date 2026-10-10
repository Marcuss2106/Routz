"""Wire contracts for microphone chunks and crossing predictions."""

from __future__ import annotations

import base64
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.geometry import CHUNK_DURATION_MS, SAMPLE_RATE_HZ, SAMPLES_PER_CHUNK


def pcm16_base64_to_floats(payload: str) -> list[float]:
    """Decode the little-endian PCM16 encoding used by the simulation frontend."""
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
    """One microphone. `y_m` is elevation when `z_m` is the other ground axis."""

    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1)
    x_m: float
    y_m: float
    z_m: float = 0.0
    audio: list[float] | None = None
    audio_pcm16_base64: str | None = None

    @model_validator(mode="after")
    def decode_audio(self) -> MicrophoneChunk:
        if self.audio is not None and self.audio_pcm16_base64 is not None:
            raise ValueError("send audio or audio_pcm16_base64, not both")
        if self.audio_pcm16_base64 is not None:
            self.audio = pcm16_base64_to_floats(self.audio_pcm16_base64)
        if self.audio is None:
            raise ValueError("audio is required")
        return self

    def samples(self) -> list[float]:
        if self.audio is None:
            raise ValueError("audio was not decoded")
        return self.audio


class MicrophoneAudioChunk(BaseModel):
    """One synchronized capture from every microphone.

    `simulation_time_s` is the simulation clock at the first sample, not the
    wall-clock time this process received the message.
    """

    model_config = ConfigDict(extra="ignore")

    type: Literal["microphone_audio_chunk"]
    simulation_id: str = Field(min_length=1)
    sequence: int = Field(ge=0)
    simulation_time_s: float = Field(ge=0)
    sample_rate_hz: int
    duration_ms: int
    source_file: str | None = None
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

    def uses_xz_ground_plane(self) -> bool:
        """The simulation scene stores elevation in y and the ground offset in z."""
        return any(mic.z_m != 0.0 for mic in self.microphones)

    def ground_lateral_m(self, mic: MicrophoneChunk) -> float:
        if self.uses_xz_ground_plane():
            return mic.z_m
        return mic.y_m


class SimulationReset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["simulation_reset"]
    simulation_id: str = Field(min_length=1)


class LatLon(BaseModel):
    latitude: float
    longitude: float


class CrossingForecast(BaseModel):
    crossing_id: str
    eta_seconds: float | None
    estimated_blockage_seconds: float | None
    status: Literal["approaching", "blocking", "clear", "unknown"]


class CrossingPredictionEvent(BaseModel):
    """Estimate only. `label` marks the frontend copy so it is not read as truth."""

    type: Literal["crossing_prediction"] = "crossing_prediction"
    simulation_id: str
    sequence: int
    simulation_time_s: float
    train_id: str
    status: Literal["tracking", "unknown"]
    estimated_position: LatLon | None
    estimated_position_m: float | None = None
    estimated_speed_mps: float | None
    direction: Literal["eastbound", "westbound", "unknown"]
    crossings: list[CrossingForecast]
    source: Literal["simulated_audio_inference"] = "simulated_audio_inference"
    label: Literal["estimate"] = "estimate"

    def frontend_payload(self) -> dict:
        return self.model_dump(mode="json")

    def user_backend_payload(self) -> dict:
        return self.model_dump(mode="json", exclude={"estimated_position_m", "label"})
