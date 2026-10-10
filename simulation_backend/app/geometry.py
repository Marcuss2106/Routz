"""Shared east/north rail geometry for the simulator and acoustic estimator.

The JSON file at ``shared/simulation_geometry.json`` is the single source of
truth. The frontend reads that same file at build time; the backend loads it at
import time. ``s`` is distance along the polyline in metres.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CONFIG_PATH = Path(__file__).resolve().parents[2] / "shared" / "simulation_geometry.json"
CONFIG: dict[str, Any] = json.loads(CONFIG_PATH.read_text())

SAMPLE_RATE_HZ = 16_000
CHUNK_DURATION_MS = 250
CHUNK_DURATION_S = CHUNK_DURATION_MS / 1000.0
SAMPLES_PER_CHUNK = SAMPLE_RATE_HZ * CHUNK_DURATION_MS // 1000
ANALYSIS_WINDOW_S = 1.0
ANALYSIS_SAMPLES = int(ANALYSIS_WINDOW_S * SAMPLE_RATE_HZ)

SPEED_OF_SOUND_MPS = 343.0
STOPPED_SPEED_MPS = 0.5
TRACK_ID = str(CONFIG["track_id"])
TRAIN_ID_PREFIX = "acoustic-train"
ORIGIN_LATITUDE = float(CONFIG["origin"]["latitude"])
ORIGIN_LONGITUDE = float(CONFIG["origin"]["longitude"])
METERS_PER_DEGREE_LATITUDE = 111_320.0
ACOUSTIC_FIELD_MARGIN_M = 120.0
CLEAR_TIMEOUT_S = 1.5
MIN_ESTIMATED_TRAIN_LENGTH_M = 20.0
MAX_ESTIMATED_TRAIN_LENGTH_M = 500.0


@dataclass(frozen=True)
class TrackPoint:
    x_m: float
    y_m: float


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


TRACK_POINTS: tuple[TrackPoint, ...] = tuple(
    TrackPoint(float(point["x_m"]), float(point["y_m"]))
    for point in CONFIG["track"]
)
MICROPHONES: tuple[MicrophonePosition, ...] = tuple(
    MicrophonePosition(
        str(microphone["id"]),
        float(microphone["x_m"]),
        float(microphone["y_m"]),
    )
    for microphone in CONFIG["microphones"]
)
CROSSINGS: tuple[CrossingGeometry, ...] = tuple(
    CrossingGeometry(
        str(crossing["id"]),
        float(crossing["s_m"]),
        str(crossing["name"]),
    )
    for crossing in CONFIG.get("crossings", [])
)

_SEGMENT_LENGTHS = tuple(
    math.hypot(
        TRACK_POINTS[index + 1].x_m - point.x_m,
        TRACK_POINTS[index + 1].y_m - point.y_m,
    )
    for index, point in enumerate(TRACK_POINTS[:-1])
)
_CUMULATIVE_S = [0.0]
for _length in _SEGMENT_LENGTHS:
    _CUMULATIVE_S.append(_CUMULATIVE_S[-1] + _length)
TRACK_LENGTH_M = _CUMULATIVE_S[-1]


def rail_point_at_s(s_m: float) -> tuple[float, float]:
    """Return east/north coordinates; extrapolate just beyond endpoints."""
    if s_m <= 0.0:
        start, end = TRACK_POINTS[0], TRACK_POINTS[1]
        ratio = s_m / _SEGMENT_LENGTHS[0]
        return (
            start.x_m + (end.x_m - start.x_m) * ratio,
            start.y_m + (end.y_m - start.y_m) * ratio,
        )
    if s_m >= TRACK_LENGTH_M:
        start, end = TRACK_POINTS[-2], TRACK_POINTS[-1]
        ratio = (s_m - TRACK_LENGTH_M) / _SEGMENT_LENGTHS[-1]
        return (
            end.x_m + (end.x_m - start.x_m) * ratio,
            end.y_m + (end.y_m - start.y_m) * ratio,
        )
    segment_index = next(
        index for index in range(len(_SEGMENT_LENGTHS)) if s_m <= _CUMULATIVE_S[index + 1]
    )
    start, end = TRACK_POINTS[segment_index], TRACK_POINTS[segment_index + 1]
    ratio = (s_m - _CUMULATIVE_S[segment_index]) / _SEGMENT_LENGTHS[segment_index]
    return (
        start.x_m + (end.x_m - start.x_m) * ratio,
        start.y_m + (end.y_m - start.y_m) * ratio,
    )


def rail_tangent_at_s(s_m: float) -> tuple[float, float]:
    """Return the east/north unit tangent for increasing rail distance."""
    clamped_s = min(max(s_m, 0.0), TRACK_LENGTH_M - 1e-9)
    segment_index = next(
        index
        for index in range(len(_SEGMENT_LENGTHS))
        if clamped_s <= _CUMULATIVE_S[index + 1]
    )
    start, end = TRACK_POINTS[segment_index], TRACK_POINTS[segment_index + 1]
    length = _SEGMENT_LENGTHS[segment_index]
    return (
        (end.x_m - start.x_m) / length,
        (end.y_m - start.y_m) / length,
    )


def nearest_rail_position_s(x_m: float, y_m: float) -> float:
    """Project a local east/north point onto the closest polyline segment."""
    best_s = 0.0
    best_distance = float("inf")
    for index, length in enumerate(_SEGMENT_LENGTHS):
        start, end = TRACK_POINTS[index], TRACK_POINTS[index + 1]
        dx = end.x_m - start.x_m
        dy = end.y_m - start.y_m
        ratio = ((x_m - start.x_m) * dx + (y_m - start.y_m) * dy) / (length * length)
        ratio = min(max(ratio, 0.0), 1.0)
        projected_x = start.x_m + ratio * dx
        projected_y = start.y_m + ratio * dy
        distance = math.hypot(x_m - projected_x, y_m - projected_y)
        if distance < best_distance:
            best_distance = distance
            best_s = _CUMULATIVE_S[index] + ratio * length
    return best_s


def rail_to_latlon(rail_position_m: float) -> tuple[float, float]:
    """Convert rail distance to WGS84 using the local east/north frame."""
    east_m, north_m = rail_point_at_s(rail_position_m)
    latitude = ORIGIN_LATITUDE + north_m / METERS_PER_DEGREE_LATITUDE
    meters_per_degree_lon = METERS_PER_DEGREE_LATITUDE * math.cos(math.radians(ORIGIN_LATITUDE))
    longitude = ORIGIN_LONGITUDE + east_m / meters_per_degree_lon
    return latitude, longitude


def direction_deg_from_east(rail_position_m: float, signed_velocity_mps: float) -> float | None:
    if abs(signed_velocity_mps) < STOPPED_SPEED_MPS:
        return None
    tangent_east, tangent_north = rail_tangent_at_s(rail_position_m)
    east_velocity = tangent_east * signed_velocity_mps
    north_velocity = tangent_north * signed_velocity_mps
    return (math.degrees(math.atan2(north_velocity, east_velocity)) + 360.0) % 360.0


def microphone_rail_positions() -> tuple[float, ...]:
    return tuple(nearest_rail_position_s(mic.x_m, mic.y_m) for mic in MICROPHONES)


_MICROPHONE_S = microphone_rail_positions()
ACOUSTIC_FIELD_START_S = min(_MICROPHONE_S) - ACOUSTIC_FIELD_MARGIN_M
ACOUSTIC_FIELD_END_S = max(_MICROPHONE_S) + ACOUSTIC_FIELD_MARGIN_M
