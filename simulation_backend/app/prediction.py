"""Track speed and direction, then forecast crossing blockage."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from app.geometry import (
    CROSSINGS,
    STOPPED_SPEED_MPS,
    TRAIN_ID,
    TRAIN_LENGTH_M,
    rail_to_latlon,
)
from app.schemas import CrossingForecast, CrossingPredictionEvent, LatLon


@dataclass(frozen=True)
class TrackSnapshot:
    position_m: float
    speed_mps: float | None
    direction: str


class TrainTracker:
    """Constant-velocity Kalman filter along the rail, in simulation time."""

    def __init__(self) -> None:
        self._t: float | None = None
        self._z: float | None = None
        self._x: np.ndarray | None = None
        self._p: np.ndarray | None = None

    def reset(self) -> None:
        self._t = None
        self._z = None
        self._x = None
        self._p = None

    def observe(self, time_s: float, position_m: float) -> TrackSnapshot | None:
        """Ingest one rail fix. Return None when the fix is too unstable to use."""
        if self._t is not None and time_s <= self._t:
            return None
        if self._x is None and self._z is None:
            self._t = time_s
            self._z = position_m
            return TrackSnapshot(position_m, None, "unknown")
        if self._x is None:
            assert self._t is not None and self._z is not None
            dt = time_s - self._t
            speed = (position_m - self._z) / dt
            self._x = np.array([position_m, speed], dtype=np.float64)
            self._p = np.diag([25.0, 4.0])
            self._t = time_s
            return _snapshot(self._x)

        assert self._p is not None and self._t is not None
        dt = time_s - self._t
        transition = np.array([[1.0, dt], [0.0, 1.0]])
        process_noise = np.array(
            [[dt**3 / 3.0, dt**2 / 2.0], [dt**2 / 2.0, dt]],
            dtype=np.float64,
        )
        predicted = transition @ self._x
        covariance = transition @ self._p @ transition.T + process_noise
        if abs(float(position_m - predicted[0])) > 30.0:
            return None
        observation = np.array([[1.0, 0.0]])
        measurement_var = np.array([[25.0]])
        innovation = np.array([position_m - predicted[0]])
        innovation_cov = observation @ covariance @ observation.T + measurement_var
        gain = covariance @ observation.T @ np.linalg.inv(innovation_cov)
        self._x = predicted + (gain @ innovation).ravel()
        self._p = (np.eye(2) - gain @ observation) @ covariance
        self._t = time_s
        return _snapshot(self._x)


def direction_from_speed(
    speed_mps: float | None,
) -> Literal["eastbound", "westbound", "unknown"]:
    if speed_mps is None or abs(speed_mps) < STOPPED_SPEED_MPS:
        return "unknown"
    if speed_mps > 0:
        return "eastbound"
    return "westbound"


def forecast_crossing(
    position_m: float,
    speed_mps: float | None,
    crossing_rail_m: float,
    train_length_m: float = TRAIN_LENGTH_M,
) -> CrossingForecast:
    """Forecast one crossing from a center position and signed speed.

    `eta_seconds` is the wait until the front reaches the crossing. While the
    train is approaching, `estimated_blockage_seconds` is the full closure.
    While the crossing is already occupied, it is the time until the rear
    clears. A near-zero speed does not get an ETA.
    """
    if speed_mps is None or abs(speed_mps) < STOPPED_SPEED_MPS:
        return CrossingForecast(
            crossing_id="",
            eta_seconds=None,
            estimated_blockage_seconds=None,
            status="unknown",
        )
    half_m = train_length_m / 2.0
    if speed_mps > 0:
        front_m = position_m + half_m
        rear_m = position_m - half_m
    else:
        front_m = position_m - half_m
        rear_m = position_m + half_m
    time_front_s = (crossing_rail_m - front_m) / speed_mps
    time_rear_s = (crossing_rail_m - rear_m) / speed_mps
    if time_front_s > 1e-6:
        return CrossingForecast(
            crossing_id="",
            eta_seconds=float(time_front_s),
            estimated_blockage_seconds=float(train_length_m / abs(speed_mps)),
            status="approaching",
        )
    if time_rear_s > 0.0:
        return CrossingForecast(
            crossing_id="",
            eta_seconds=0.0,
            estimated_blockage_seconds=float(time_rear_s),
            status="blocking",
        )
    return CrossingForecast(
        crossing_id="",
        eta_seconds=None,
        estimated_blockage_seconds=None,
        status="clear",
    )


def prediction_from_track(
    *,
    simulation_id: str,
    sequence: int,
    simulation_time_s: float,
    position_m: float | None,
    speed_mps: float | None,
) -> CrossingPredictionEvent:
    if speed_mps is not None and abs(speed_mps) > 45.0:
        speed_mps = None
    direction = direction_from_speed(speed_mps)
    estimated_position = None
    reported_position = None
    if position_m is not None:
        latitude, longitude = rail_to_latlon(position_m)
        estimated_position = LatLon(latitude=latitude, longitude=longitude)
        reported_position = float(position_m)
    if position_m is not None and speed_mps is not None and direction != "unknown":
        crossings = [
            forecast_crossing(position_m, speed_mps, crossing.rail_position_m).model_copy(
                update={"crossing_id": crossing.crossing_id}
            )
            for crossing in CROSSINGS
        ]
    else:
        crossings = _unknown_crossings()
    status: Literal["tracking", "unknown"] = (
        "tracking" if position_m is not None and speed_mps is not None else "unknown"
    )
    return CrossingPredictionEvent(
        simulation_id=simulation_id,
        sequence=sequence,
        simulation_time_s=simulation_time_s,
        train_id=TRAIN_ID,
        status=status,
        estimated_position=estimated_position,
        estimated_position_m=reported_position,
        estimated_speed_mps=None if speed_mps is None else float(speed_mps),
        direction=direction,
        crossings=crossings,
    )


def unknown_prediction(
    *,
    simulation_id: str,
    sequence: int,
    simulation_time_s: float,
) -> CrossingPredictionEvent:
    return prediction_from_track(
        simulation_id=simulation_id,
        sequence=sequence,
        simulation_time_s=simulation_time_s,
        position_m=None,
        speed_mps=None,
    )


def _unknown_crossings() -> list[CrossingForecast]:
    return [
        CrossingForecast(
            crossing_id=crossing.crossing_id,
            eta_seconds=None,
            estimated_blockage_seconds=None,
            status="unknown",
        )
        for crossing in CROSSINGS
    ]


def _snapshot(state: np.ndarray) -> TrackSnapshot:
    position_m = float(state[0])
    speed_mps = float(state[1])
    return TrackSnapshot(position_m, speed_mps, direction_from_speed(speed_mps))
