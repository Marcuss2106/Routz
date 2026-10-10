"""Temporal acoustic tracking, lifecycle state, and train estimates."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Literal

import numpy as np

from app.geometry import (
    CLEAR_TIMEOUT_S,
    CROSSINGS,
    MAX_ESTIMATED_TRAIN_LENGTH_M,
    MIN_ESTIMATED_TRAIN_LENGTH_M,
    STOPPED_SPEED_MPS,
    TRACK_ID,
    TRAIN_ID_PREFIX,
    direction_deg_from_east,
    rail_to_latlon,
)
from app.localization import LocalizationResult
from app.schemas import (
    CrossingForecast,
    EstimateConfidence,
    EstimateUncertainty,
    TrainStateEstimateEvent,
)


@dataclass(frozen=True)
class TrackSnapshot:
    position_m: float
    velocity_along_track_mps: float | None
    speed_mps: float | None
    acceleration_mps2: float | None
    direction_deg_from_east: float | None
    position_error_m: float | None
    speed_error_mps: float | None
    direction_error_deg: float | None


class TrainTracker:
    """A small [s, velocity, acceleration] Kalman filter in simulation time."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._t: float | None = None
        self._state: np.ndarray | None = None
        self._covariance: np.ndarray | None = None
        self._last_snapshot: TrackSnapshot | None = None
        self._observations = 0

    @property
    def last_snapshot(self) -> TrackSnapshot | None:
        return self._last_snapshot

    def observe(
        self,
        time_s: float,
        position_m: float,
        position_error_m: float = 5.0,
        measurement_confidence: float = 1.0,
    ) -> TrackSnapshot | None:
        """Update from one acoustic rail fix; reject contradictory fixes."""
        if self._t is not None and time_s <= self._t:
            return None
        measurement_error = max(0.75, position_error_m / max(measurement_confidence, 0.2))

        if self._state is None or self._covariance is None or self._t is None:
            self._t = time_s
            self._state = np.array([position_m, 0.0, 0.0], dtype=np.float64)
            self._covariance = np.diag([measurement_error**2, 100.0, 100.0])
            self._observations = 1
            snapshot = self._snapshot()
            self._last_snapshot = snapshot
            return snapshot

        dt = time_s - self._t
        if dt <= 0.0:
            return None
        transition = np.array(
            [[1.0, dt, 0.5 * dt**2], [0.0, 1.0, dt], [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )
        acceleration_noise = 5.0
        process_noise = acceleration_noise**2 * np.array(
            [
                [dt**5 / 20.0, dt**4 / 8.0, dt**3 / 6.0],
                [dt**4 / 8.0, dt**3 / 3.0, dt**2 / 2.0],
                [dt**3 / 6.0, dt**2 / 2.0, dt],
            ],
            dtype=np.float64,
        )
        predicted = transition @ self._state
        covariance = transition @ self._covariance @ transition.T + process_noise
        innovation = position_m - predicted[0]
        innovation_variance = float(covariance[0, 0] + measurement_error**2)
        if abs(float(innovation)) > max(45.0, 6.0 * math.sqrt(innovation_variance)):
            return None

        observation = np.array([[1.0, 0.0, 0.0]])
        gain = covariance @ observation.T / innovation_variance
        self._state = predicted + gain[:, 0] * innovation
        self._covariance = (np.eye(3) - gain @ observation) @ covariance
        self._t = time_s
        self._observations += 1
        snapshot = self._snapshot()
        self._last_snapshot = snapshot
        return snapshot

    def _snapshot(self) -> TrackSnapshot:
        assert self._state is not None and self._covariance is not None
        position_m = float(self._state[0])
        velocity = float(self._state[1])
        acceleration = float(self._state[2])
        speed = abs(velocity)
        position_error = math.sqrt(max(0.0, float(self._covariance[0, 0])))
        speed_error = math.sqrt(max(0.0, float(self._covariance[1, 1])))
        direction = direction_deg_from_east(position_m, velocity)
        if direction is None:
            direction_error = None
        else:
            direction_error = min(90.0, math.degrees(math.atan2(speed_error, max(speed, 0.1))))
        has_velocity = self._observations >= 2
        return TrackSnapshot(
            position_m=position_m,
            velocity_along_track_mps=velocity if has_velocity else None,
            speed_mps=speed if has_velocity else None,
            acceleration_mps2=acceleration if has_velocity else None,
            direction_deg_from_east=direction if has_velocity else None,
            position_error_m=position_error,
            speed_error_mps=speed_error if has_velocity else None,
            direction_error_deg=direction_error if has_velocity else None,
        )


@dataclass(frozen=True)
class LifecycleSnapshot:
    train_id: str
    status: Literal["detected", "tracking", "length_pending", "cleared", "unknown"]
    length_m: float | None
    length_confidence: float
    length_error_m: float | None
    active: bool
    new_train: bool


class TrainLifecycleTracker:
    """Infer acoustic occupancy duration without a configured train length."""

    def __init__(self, simulation_id: str) -> None:
        self.simulation_id = simulation_id
        self._train_index = 0
        self._active = False
        self._first_active_time: float | None = None
        self._last_active_time: float | None = None
        self._last_speed_mps: float | None = None
        self._stable_length_m: float | None = None
        self._status: Literal["detected", "tracking", "length_pending", "cleared", "unknown"] = "unknown"

    @property
    def train_id(self) -> str:
        return f"{TRAIN_ID_PREFIX}-{self.simulation_id}-{self._train_index + 1:03d}"

    @property
    def status(self):
        return self._status

    def reset(self) -> None:
        self._active = False
        self._first_active_time = None
        self._last_active_time = None
        self._last_speed_mps = None
        self._stable_length_m = None
        self._status = "unknown"

    def observe(self, time_s: float, active: bool, speed_mps: float | None) -> LifecycleSnapshot:
        new_train = False
        if active and not self._active:
            if self._status == "cleared":
                self._train_index += 1
            self._active = True
            self._first_active_time = time_s
            self._last_active_time = time_s
            self._stable_length_m = None
            self._status = "detected"
            new_train = True
        elif active:
            self._last_active_time = time_s

        if speed_mps is not None and speed_mps >= STOPPED_SPEED_MPS:
            self._last_speed_mps = speed_mps

        if self._active and self._first_active_time is not None and self._last_active_time is not None:
            elapsed_s = max(0.0, self._last_active_time - self._first_active_time)
            provisional = self._provisional_length(elapsed_s)
            if self._last_speed_mps is not None and provisional is not None:
                self._status = "length_pending"

        if not active and self._active and self._last_active_time is not None:
            if time_s - self._last_active_time >= CLEAR_TIMEOUT_S:
                self._active = False
                first_active_time = (
                    self._first_active_time
                    if self._first_active_time is not None
                    else self._last_active_time
                )
                elapsed_s = max(0.0, self._last_active_time - first_active_time)
                self._stable_length_m = self._provisional_length(elapsed_s)
                self._status = "cleared"

        length_error = None if self._stable_length_m is None else max(5.0, self._stable_length_m * 0.18)
        return LifecycleSnapshot(
            train_id=self.train_id,
            status=self._status,
            length_m=self._stable_length_m,
            length_confidence=0.85 if self._stable_length_m is not None else 0.0,
            length_error_m=length_error,
            active=self._active,
            new_train=new_train,
        )

    def _provisional_length(self, elapsed_s: float) -> float | None:
        if self._last_speed_mps is None or elapsed_s <= 0.0:
            return None
        length_m = self._last_speed_mps * elapsed_s
        if not MIN_ESTIMATED_TRAIN_LENGTH_M <= length_m <= MAX_ESTIMATED_TRAIN_LENGTH_M:
            return None
        return float(length_m)


class AcousticTrackEstimator:
    """Combine localization, temporal tracking, and train lifecycle state."""

    def __init__(self, simulation_id: str) -> None:
        self.simulation_id = simulation_id
        self.tracker = TrainTracker()
        self.lifecycle = TrainLifecycleTracker(simulation_id)

    def observe(
        self,
        *,
        sequence: int,
        simulation_time_s: float,
        localization: LocalizationResult,
    ) -> TrainStateEstimateEvent:
        if localization.active and self.lifecycle.status == "cleared":
            self.tracker.reset()
        snapshot: TrackSnapshot | None = None
        if localization.position_m is not None and localization.active:
            snapshot = self.tracker.observe(
                simulation_time_s,
                localization.position_m,
                localization.position_error_m or 10.0,
                localization.confidence,
            )
        if snapshot is None:
            snapshot = self.tracker.last_snapshot
        lifecycle = self.lifecycle.observe(
            simulation_time_s,
            localization.active and localization.position_m is not None,
            snapshot.speed_mps if snapshot else None,
        )
        if lifecycle.new_train:
            # The lifecycle marks a new run; the first fix already belongs to it.
            pass
        return estimate_event(
            simulation_id=self.simulation_id,
            sequence=sequence,
            simulation_time_s=simulation_time_s,
            train_id=lifecycle.train_id,
            snapshot=snapshot,
            localization=localization,
            lifecycle=lifecycle,
        )


def forecast_crossing(
    position_m: float,
    speed_mps: float | None,
    crossing_rail_m: float,
    train_length_m: float | None,
    crossing_id: str = "",
) -> CrossingForecast:
    """Forecast only when both velocity and an acoustic length estimate exist."""
    if speed_mps is None or abs(speed_mps) < STOPPED_SPEED_MPS or train_length_m is None:
        return CrossingForecast(
            crossing_id=crossing_id,
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
            crossing_id=crossing_id,
            eta_seconds=float(time_front_s),
            estimated_blockage_seconds=float(train_length_m / abs(speed_mps)),
            status="approaching",
        )
    if time_rear_s > 0.0:
        return CrossingForecast(
            crossing_id=crossing_id,
            eta_seconds=0.0,
            estimated_blockage_seconds=float(time_rear_s),
            status="blocking",
        )
    return CrossingForecast(
        crossing_id=crossing_id,
        eta_seconds=None,
        estimated_blockage_seconds=None,
        status="clear",
    )


def estimate_event(
    *,
    simulation_id: str,
    sequence: int,
    simulation_time_s: float,
    train_id: str,
    snapshot: TrackSnapshot | None,
    localization: LocalizationResult,
    lifecycle: LifecycleSnapshot,
) -> TrainStateEstimateEvent:
    latitude = longitude = None
    track_position_m = None
    if snapshot is not None:
        latitude, longitude = rail_to_latlon(snapshot.position_m)
        track_position_m = snapshot.position_m

    if snapshot is None or not localization.active:
        position_confidence = 0.0
        speed_mps = None
        direction = None
        speed_confidence = 0.0
        direction_confidence = 0.0
    else:
        position_confidence = max(0.0, min(1.0, localization.confidence))
        speed_mps = snapshot.speed_mps
        direction = snapshot.direction_deg_from_east
        speed_confidence = _speed_confidence(snapshot)
        direction_confidence = _direction_confidence(snapshot)

    if lifecycle.status == "cleared":
        status = "cleared"
    elif snapshot is None or not localization.active:
        status = "unknown"
    elif snapshot.speed_mps is None:
        status = "detected"
    elif lifecycle.length_m is None:
        status = "length_pending"
    else:
        status = "tracking"

    crossings = []
    if snapshot is not None and localization.active:
        crossings = [
            forecast_crossing(
                snapshot.position_m,
                snapshot.velocity_along_track_mps,
                crossing.rail_position_m,
                lifecycle.length_m,
                crossing.crossing_id,
            )
            for crossing in CROSSINGS
        ]

    return TrainStateEstimateEvent(
        simulation_id=simulation_id,
        sequence=sequence,
        simulation_time_s=simulation_time_s,
        train_id=train_id,
        track_id=TRACK_ID,
        latitude=latitude,
        longitude=longitude,
        speed_mps=speed_mps,
        length_m=lifecycle.length_m,
        direction_deg_from_east=direction,
        status=status,
        confidence=EstimateConfidence(
            position=position_confidence,
            speed=speed_confidence,
            length=lifecycle.length_confidence,
            direction=direction_confidence,
        ),
        uncertainty=EstimateUncertainty(
            position_m=localization.position_error_m,
            speed_mps=snapshot.speed_error_mps if snapshot else None,
            length_m=lifecycle.length_error_m,
            direction_deg=snapshot.direction_error_deg if snapshot else None,
        ),
        track_position_m=track_position_m,
        crossings=crossings,
    )


def prediction_from_track(
    *,
    simulation_id: str,
    sequence: int,
    simulation_time_s: float,
    position_m: float | None,
    speed_mps: float | None,
    length_m: float | None = None,
) -> TrainStateEstimateEvent:
    """Compatibility helper for callers that already have a filtered track fix."""
    direction = direction_deg_from_east(position_m or 0.0, speed_mps or 0.0)
    snapshot = None
    if position_m is not None:
        snapshot = TrackSnapshot(
            position_m,
            speed_mps,
            abs(speed_mps) if speed_mps is not None else None,
            None,
            direction,
            5.0,
            1.0 if speed_mps is not None else None,
            5.0 if direction is not None else None,
        )
    lifecycle = LifecycleSnapshot(
        train_id=f"{TRAIN_ID_PREFIX}-{simulation_id}-001",
        status="tracking" if length_m is not None else "length_pending",
        length_m=length_m,
        length_confidence=0.85 if length_m is not None else 0.0,
        length_error_m=length_m * 0.18 if length_m is not None else None,
        active=position_m is not None,
        new_train=False,
    )
    localization = LocalizationResult(position_m, 5.0, 0.001, 0.8, 12.0, position_m is not None)
    return estimate_event(
        simulation_id=simulation_id,
        sequence=sequence,
        simulation_time_s=simulation_time_s,
        train_id=lifecycle.train_id,
        snapshot=snapshot,
        localization=localization,
        lifecycle=lifecycle,
    )


def unknown_prediction(*, simulation_id: str, sequence: int, simulation_time_s: float) -> TrainStateEstimateEvent:
    lifecycle = LifecycleSnapshot(
        train_id=f"{TRAIN_ID_PREFIX}-{simulation_id}-001",
        status="unknown",
        length_m=None,
        length_confidence=0.0,
        length_error_m=None,
        active=False,
        new_train=False,
    )
    return estimate_event(
        simulation_id=simulation_id,
        sequence=sequence,
        simulation_time_s=simulation_time_s,
        train_id=lifecycle.train_id,
        snapshot=None,
        localization=LocalizationResult(None, None, None, 0.0, None, False),
        lifecycle=lifecycle,
    )


def _speed_confidence(snapshot: TrackSnapshot) -> float:
    if snapshot.speed_mps is None:
        return 0.0
    return max(0.0, min(1.0, snapshot.speed_mps / (snapshot.speed_mps + (snapshot.speed_error_mps or 10.0))))


def _direction_confidence(snapshot: TrackSnapshot) -> float:
    if snapshot.direction_deg_from_east is None:
        return 0.0
    return max(0.0, min(1.0, 1.0 - (snapshot.direction_error_deg or 90.0) / 90.0))
