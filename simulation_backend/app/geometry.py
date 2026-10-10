"""Locked demo geometry shared with the simulation frontend.

The frontend owns the clock and the microphone signals. It must send chunks
that match these constants. Nothing here is the train's ground-truth state.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


SAMPLE_RATE_HZ = 16_000
CHUNK_DURATION_MS = 250
CHUNK_DURATION_S = CHUNK_DURATION_MS / 1000.0
SAMPLES_PER_CHUNK = SAMPLE_RATE_HZ * CHUNK_DURATION_MS // 1000

# One chunk cannot cover the delay across a 100 m baseline, so localization
# runs on the trailing window while ingest stays at 250 ms.
ANALYSIS_WINDOW_S = 1.0
ANALYSIS_SAMPLES = int(ANALYSIS_WINDOW_S * SAMPLE_RATE_HZ)

SPEED_OF_SOUND_MPS = 343.0
TRACK_Y_M = 0.0
# Acoustic fix is treated as the consist center. Length is an assumption.
TRAIN_LENGTH_M = 180.0
TRAIN_ID = "train-001"
STOPPED_SPEED_MPS = 0.5

# Rail x = 0. Positive x is east.
ORIGIN_LATITUDE = 34.0007
ORIGIN_LONGITUDE = -81.0348
METERS_PER_DEGREE_LATITUDE = 111_320.0


@dataclass(frozen=True)
class MicrophonePosition:
    id: str
    x_m: float
    y_m: float


@dataclass(frozen=True)
class CrossingGeometry:
    crossing_id: str
    rail_position_m: float
    name: str


MICROPHONES: tuple[MicrophonePosition, ...] = (
    MicrophonePosition("mic-1", 0.0, 20.0),
    MicrophonePosition("mic-2", 100.0, 20.0),
    MicrophonePosition("mic-3", 200.0, 20.0),
)

CROSSINGS: tuple[CrossingGeometry, ...] = (
    CrossingGeometry("crossing-001", 50.0, "Demo crossing 50 m"),
    CrossingGeometry("crossing-002", 150.0, "Demo crossing 150 m"),
)


def rail_to_latlon(rail_position_m: float) -> tuple[float, float]:
    """Map a rail-axis meter coordinate to the demo WGS84 point."""
    latitude = ORIGIN_LATITUDE
    meters_per_degree_lon = METERS_PER_DEGREE_LATITUDE * math.cos(math.radians(latitude))
    longitude = ORIGIN_LONGITUDE + rail_position_m / meters_per_degree_lon
    return latitude, longitude
