"""Shared geometry, acoustic localization, lifecycle, and contract tests."""

from __future__ import annotations

import base64
import inspect
import json
import logging
import math

import numpy as np
import pytest
from pydantic import ValidationError

from app.geometry import (
    ACOUSTIC_FIELD_END_S,
    ACOUSTIC_FIELD_START_S,
    CROSSINGS,
    MICROPHONES,
    ORIGIN_LATITUDE,
    ORIGIN_LONGITUDE,
    SAMPLE_RATE_HZ,
    SAMPLES_PER_CHUNK,
    TRACK_ID,
    TRACK_LENGTH_M,
    MicrophonePosition,
    direction_deg_from_east,
    rail_point_at_s,
    rail_to_latlon,
)
from app.localization import estimate_rail_position_m, gcc_phat_delay_s
from app.pipeline import SimulationPipeline
from app.prediction import (
    AcousticTrackEstimator,
    TrainLifecycleTracker,
    TrainTracker,
    forecast_crossing,
    prediction_from_track,
)
from app.schemas import MicrophoneAudioChunk, MicrophoneChunk
from tests.synthetic_audio import chunks_from_window, synthesize_window


def _silent_chunk(sequence: int, time_s: float, simulation_id: str = "demo-001") -> MicrophoneAudioChunk:
    return MicrophoneAudioChunk(
        type="microphone_audio_chunk",
        simulation_id=simulation_id,
        sequence=sequence,
        simulation_time_s=time_s,
        sample_rate_hz=SAMPLE_RATE_HZ,
        duration_ms=250,
        microphones=[
            MicrophoneChunk(id=mic.id, x_m=mic.x_m, y_m=mic.y_m, audio=[0.0] * SAMPLES_PER_CHUNK)
            for mic in MICROPHONES
        ],
    )


def _pcm16_base64(samples: np.ndarray) -> str:
    clipped = np.clip(np.asarray(samples, dtype=np.float64), -1.0, 1.0)
    scaled = np.where(clipped < 0.0, clipped * 32768.0, clipped * 32767.0)
    integers = np.clip(np.round(scaled), -32768, 32767).astype("<i2")
    return base64.b64encode(integers.tobytes()).decode("ascii")


def test_shared_geometry_is_the_single_shape() -> None:
    assert len(MICROPHONES) == 3
    assert len({(mic.x_m, mic.y_m) for mic in MICROPHONES}) == 3
    assert TRACK_LENGTH_M == pytest.approx(500.0 + math.hypot(500.0, 300.0))
    assert ACOUSTIC_FIELD_START_S < 0.0 < ACOUSTIC_FIELD_END_S


def test_polyline_conversion_follows_east_then_northeast() -> None:
    origin = rail_point_at_s(0.0)
    bend = rail_point_at_s(500.0)
    end = rail_point_at_s(TRACK_LENGTH_M)
    assert origin == pytest.approx((0.0, 0.0))
    assert bend == pytest.approx((500.0, 0.0))
    assert end == pytest.approx((1000.0, 300.0))
    latitude, longitude = rail_to_latlon(TRACK_LENGTH_M)
    assert latitude > ORIGIN_LATITUDE
    assert longitude > ORIGIN_LONGITUDE


def test_schema_accepts_only_microphone_audio_and_geometry() -> None:
    message = _silent_chunk(0, 0.0).model_dump()
    assert "train_state" not in message
    with pytest.raises(ValidationError):
        payload = _silent_chunk(0, 0.0).model_dump()
        payload["train_position_m"] = 10.0
        MicrophoneAudioChunk.model_validate(payload)


def test_pcm16_decode_uses_shared_east_north_layout() -> None:
    samples = np.linspace(-0.9, 0.9, SAMPLES_PER_CHUNK)
    chunk = MicrophoneAudioChunk(
        type="microphone_audio_chunk",
        simulation_id="pcm-demo",
        sequence=0,
        simulation_time_s=0.0,
        sample_rate_hz=SAMPLE_RATE_HZ,
        duration_ms=250,
        microphones=[
            MicrophoneChunk(
                id=mic.id,
                x_m=mic.x_m,
                y_m=mic.y_m,
                audio_pcm16_base64=_pcm16_base64(samples),
            )
            for mic in MICROPHONES
        ],
    )
    assert chunk.microphones[0].samples()[0] == pytest.approx(-0.9, abs=1 / 32767)
    assert chunk.microphones[1].x_m == 100.0
    assert chunk.microphones[2].y_m == -30.0


def test_gcc_phat_positive_delay_means_signal_arrives_later() -> None:
    rng = np.random.default_rng(0)
    reference = rng.normal(0.0, 1.0, SAMPLE_RATE_HZ)
    delay_samples = 123
    delayed = np.zeros_like(reference)
    delayed[delay_samples:] = reference[:-delay_samples]
    delay_s, prominence = gcc_phat_delay_s(delayed, reference, SAMPLE_RATE_HZ)
    assert delay_s == pytest.approx(delay_samples / SAMPLE_RATE_HZ, abs=1 / SAMPLE_RATE_HZ)
    assert prominence > 8.0


def test_localization_has_no_ground_truth_parameter() -> None:
    banned = {"source_s_m", "source_x_m", "ground_truth", "true_position_m", "true_speed_mps"}
    assert banned.isdisjoint(inspect.signature(estimate_rail_position_m).parameters)


def test_noise_does_not_invent_a_position() -> None:
    rng = np.random.default_rng(1)
    channels = [rng.normal(0.0, 0.05, SAMPLE_RATE_HZ) for _ in MICROPHONES]
    result = estimate_rail_position_m(channels, list(MICROPHONES), SAMPLE_RATE_HZ)
    assert result.position_m is None
    assert result.confidence == 0.0


@pytest.mark.parametrize("source_s_m", [25.0, 80.0, 160.0])
@pytest.mark.parametrize("snr_db", [20.0, 10.0])
def test_track_constrained_localization(source_s_m: float, snr_db: float) -> None:
    rng = np.random.default_rng(int(source_s_m * 10 + snr_db))
    channels = synthesize_window(source_s_m, t0_s=1.0, duration_s=1.0, snr_db=snr_db, rng=rng)
    result = estimate_rail_position_m(channels, list(MICROPHONES), SAMPLE_RATE_HZ)
    assert result.position_m == pytest.approx(source_s_m, abs=10.0)
    assert result.position_error_m is not None
    assert result.delay_residual_s is not None
    assert 0.0 < result.confidence <= 1.0


def test_pipeline_timestamps_full_window_at_center_and_strips_truth(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="simulation_backend")
    channels = synthesize_window(80.0, t0_s=1.0, duration_s=1.25, snr_db=20.0, rng=np.random.default_rng(7))
    chunks = chunks_from_window(channels, t0_s=1.0, simulation_id="buffer-demo", sequence_start=0)
    pipeline = SimulationPipeline()
    early = [pipeline.ingest(chunk) for chunk in chunks[:3]]
    assert all(result.accepted for result in early)
    assert all(result.frontend_message["type"] == "train_state_estimate" for result in early)
    assert all(result.frontend_message["status"] == "unknown" for result in early)

    first_fix = pipeline.ingest(chunks[3])
    assert first_fix.frontend_message["simulation_time_s"] == pytest.approx(1.5)
    assert first_fix.frontend_message["track_id"] == TRACK_ID
    assert first_fix.frontend_message["source"] == "acoustic_array"
    assert first_fix.frontend_message["label"] == "simulated_acoustic_estimate"
    assert "audio" not in first_fix.backend_message
    assert "train_position_m" not in first_fix.backend_message
    assert "label" not in first_fix.backend_message
    assert first_fix.backend_message["track_position_m"] == first_fix.frontend_message["track_position_m"]
    assert "simulation_id=buffer-demo" in caplog.text


def test_successive_acoustic_fixes_estimate_signed_velocity() -> None:
    tracker = TrainTracker()
    snapshot = None
    for index, source_s_m in enumerate((40.0, 55.0, 70.0)):
        snapshot = tracker.observe(float(index), source_s_m, 2.0, 0.9)
        assert snapshot is not None
    assert snapshot is not None
    assert snapshot.velocity_along_track_mps == pytest.approx(15.0, abs=3.0)
    assert snapshot.speed_mps == pytest.approx(15.0, abs=3.0)
    assert snapshot.direction_deg_from_east == pytest.approx(0.0, abs=2.0)


def test_curved_track_direction_is_degrees_from_east() -> None:
    assert direction_deg_from_east(250.0, 10.0) == pytest.approx(0.0)
    assert direction_deg_from_east(700.0, 10.0) == pytest.approx(math.degrees(math.atan2(300, 500)), abs=0.1)
    assert direction_deg_from_east(700.0, -10.0) == pytest.approx(210.963756, abs=0.1)


def test_length_is_pending_until_acoustic_occupancy_clears() -> None:
    lifecycle = TrainLifecycleTracker("lifecycle-demo")
    assert lifecycle.observe(0.0, True, 10.0).status == "detected"
    assert lifecycle.observe(1.0, True, 10.0).length_m is None
    pending = lifecycle.observe(14.0, True, 10.0)
    assert pending.status == "length_pending"
    assert pending.provisional_length_m == pytest.approx(140.0)
    assert pending.provisional_length_error_m is not None
    cleared = lifecycle.observe(15.6, False, 10.0)
    assert cleared.status == "cleared"
    assert cleared.length_m == pytest.approx(140.0)


def test_length_is_not_used_for_crossing_forecast_before_clear() -> None:
    unknown = forecast_crossing(100.0, 10.0, CROSSINGS[0].rail_position_m, None, CROSSINGS[0].crossing_id)
    assert unknown.status == "unknown"
    stable = forecast_crossing(100.0, 10.0, CROSSINGS[0].rail_position_m, 140.0, CROSSINGS[0].crossing_id)
    assert stable.status in {"approaching", "blocking", "clear"}
    event = prediction_from_track(
        simulation_id="estimate-demo",
        sequence=2,
        simulation_time_s=2.0,
        position_m=100.0,
        speed_mps=10.0,
        length_m=140.0,
    )
    assert event.type == "train_state_estimate"
    assert event.length_m == 140.0
    assert event.source == "acoustic_array"


def test_sequence_and_geometry_errors_do_not_advance_state() -> None:
    pipeline = SimulationPipeline()
    assert pipeline.ingest(_silent_chunk(0, 0.0)).accepted
    gap = pipeline.ingest(_silent_chunk(2, 0.5))
    assert gap.accepted is False
    assert gap.frontend_message["reason"] == "out_of_order_or_gap"
    changed = _silent_chunk(1, 0.25)
    changed.microphones[0].x_m = 1.0
    mismatch = pipeline.ingest(changed)
    assert mismatch.frontend_message["reason"] == "microphone_geometry_mismatch"
    recovered = pipeline.ingest(_silent_chunk(1, 0.25))
    assert recovered.accepted


def test_multiple_cleared_runs_get_new_backend_train_ids() -> None:
    estimator = AcousticTrackEstimator("multi-demo")
    active = type("Fix", (), {"position_m": 10.0, "position_error_m": 2.0, "confidence": 0.9, "delay_residual_s": 0.001, "peak_prominence": 10.0, "active": True})()
    first = estimator.observe(sequence=0, simulation_time_s=0.0, localization=active)
    for index in range(1, 5):
        estimator.observe(sequence=index, simulation_time_s=float(index), localization=active)
    inactive = type("Fix", (), {"position_m": None, "position_error_m": None, "confidence": 0.0, "delay_residual_s": None, "peak_prominence": None, "active": False})()
    cleared = estimator.observe(sequence=5, simulation_time_s=6.5, localization=inactive)
    assert cleared.status == "cleared"
    second = estimator.observe(sequence=6, simulation_time_s=7.0, localization=active)
    assert first.train_id != second.train_id
