"""Accept synchronized chunks, localize on a 1 s buffer, and track the train."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

import numpy as np

from app.geometry import ANALYSIS_SAMPLES, MicrophonePosition
from app.localization import estimate_rail_position_m
from app.prediction import TrainTracker, prediction_from_track, unknown_prediction
from app.schemas import CrossingPredictionEvent, MicrophoneAudioChunk

logger = logging.getLogger("simulation_backend")


@dataclass
class IngestResult:
    accepted: bool
    frontend_message: dict
    backend_message: dict | None = None


@dataclass
class _Session:
    next_sequence: int | None = None
    last_time_s: float | None = None
    mic_ids: set[str] | None = None
    samples: dict[str, np.ndarray] = field(default_factory=dict)
    tracker: TrainTracker = field(default_factory=TrainTracker)


class SimulationPipeline:
    def __init__(self, predictions_url: str = "", internal_api_token: str = "") -> None:
        self.predictions_url = predictions_url
        self.internal_api_token = internal_api_token
        self._sessions: dict[str, _Session] = {}

    def reset(self, simulation_id: str) -> None:
        self._sessions.pop(simulation_id, None)

    def ingest(self, chunk: MicrophoneAudioChunk) -> IngestResult:
        started = time.perf_counter()
        session = self._sessions.setdefault(chunk.simulation_id, _Session())
        rejection = self._validate(session, chunk)
        if rejection is not None:
            self._log(chunk, started, rejection)
            return rejection

        session.next_sequence = chunk.sequence + 1
        session.last_time_s = chunk.simulation_time_s
        if session.mic_ids is None:
            session.mic_ids = {mic.id for mic in chunk.microphones}
            session.samples = {
                mic_id: np.zeros(0, dtype=np.float64) for mic_id in session.mic_ids
            }
        for mic in chunk.microphones:
            samples = np.asarray(mic.samples(), dtype=np.float64)
            previous = session.samples[mic.id]
            session.samples[mic.id] = np.concatenate((previous, samples))[-ANALYSIS_SAMPLES:]

        event = self._estimate(session, chunk)
        result = IngestResult(
            accepted=True,
            frontend_message=event.frontend_payload(),
            backend_message=event.user_backend_payload(),
        )
        self._log(chunk, started, result, event.status)
        return result

    def _validate(self, session: _Session, chunk: MicrophoneAudioChunk) -> IngestResult | None:
        if session.next_sequence is not None and chunk.sequence != session.next_sequence:
            return self._error(
                chunk,
                "out_of_order_or_gap",
                expected_sequence=session.next_sequence,
            )
        if session.last_time_s is not None and chunk.simulation_time_s <= session.last_time_s:
            return self._error(chunk, "non_monotonic_time")

        mic_ids = {mic.id for mic in chunk.microphones}
        if session.mic_ids is not None and mic_ids != session.mic_ids:
            return self._error(chunk, "microphone_set_changed")

        for mic in chunk.microphones:
            samples = np.asarray(mic.samples(), dtype=np.float64)
            if not np.isfinite(samples).all():
                return self._error(chunk, "invalid_audio")
        return None

    def _estimate(self, session: _Session, chunk: MicrophoneAudioChunk) -> CrossingPredictionEvent:
        if any(len(session.samples[mic.id]) < ANALYSIS_SAMPLES for mic in chunk.microphones):
            return unknown_prediction(
                simulation_id=chunk.simulation_id,
                sequence=chunk.sequence,
                simulation_time_s=chunk.simulation_time_s,
            )

        channels: list[np.ndarray] = []
        microphones: list[MicrophonePosition] = []
        for mic in chunk.microphones:
            channels.append(session.samples[mic.id][-ANALYSIS_SAMPLES:])
            microphones.append(
                MicrophonePosition(mic.id, mic.x_m, chunk.ground_lateral_m(mic))
            )
        fix = estimate_rail_position_m(channels, microphones, chunk.sample_rate_hz)
        if fix.position_m is None:
            return unknown_prediction(
                simulation_id=chunk.simulation_id,
                sequence=chunk.sequence,
                simulation_time_s=chunk.simulation_time_s,
            )
        snapshot = session.tracker.observe(chunk.simulation_time_s, fix.position_m)
        if snapshot is None:
            return unknown_prediction(
                simulation_id=chunk.simulation_id,
                sequence=chunk.sequence,
                simulation_time_s=chunk.simulation_time_s,
            )
        return prediction_from_track(
            simulation_id=chunk.simulation_id,
            sequence=chunk.sequence,
            simulation_time_s=chunk.simulation_time_s,
            position_m=snapshot.position_m,
            speed_mps=snapshot.speed_mps,
        )

    def _error(
        self,
        chunk: MicrophoneAudioChunk,
        reason: str,
        expected_sequence: int | None = None,
    ) -> IngestResult:
        message: dict = {
            "type": "ingest_error",
            "reason": reason,
            "simulation_id": chunk.simulation_id,
            "sequence": chunk.sequence,
            "simulation_time_s": chunk.simulation_time_s,
        }
        if expected_sequence is not None:
            message["expected_sequence"] = expected_sequence
        return IngestResult(accepted=False, frontend_message=message, backend_message=None)

    def _log(
        self,
        chunk: MicrophoneAudioChunk,
        started: float,
        result: IngestResult,
        status: str | None = None,
    ) -> None:
        latency_ms = (time.perf_counter() - started) * 1000.0
        if result.accepted:
            logger.info(
                "chunk simulation_id=%s sequence=%s simulation_time_s=%s latency_ms=%.1f status=%s",
                chunk.simulation_id,
                chunk.sequence,
                chunk.simulation_time_s,
                latency_ms,
                status,
            )
            return
        logger.info(
            "rejected chunk simulation_id=%s sequence=%s simulation_time_s=%s latency_ms=%.1f reason=%s",
            chunk.simulation_id,
            chunk.sequence,
            chunk.simulation_time_s,
            latency_ms,
            result.frontend_message.get("reason"),
        )
