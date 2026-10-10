"""Timestamps, localization error, ETA math, and stale-chunk handling."""

from __future__ import annotations

import inspect
import json
import logging
import socket
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import pytest
from pydantic import ValidationError

from app.geometry import (
    MICROPHONES,
    ORIGIN_LATITUDE,
    ORIGIN_LONGITUDE,
    SAMPLE_RATE_HZ,
    SAMPLES_PER_CHUNK,
    MicrophonePosition,
    rail_to_latlon,
)
from app.localization import estimate_rail_position_m, gcc_phat_delay_s
from app.main import app
from app.pipeline import SimulationPipeline
from app.prediction import TrainTracker, forecast_crossing, prediction_from_track
from app.publisher import post_crossing_prediction
from app.schemas import MicrophoneAudioChunk, MicrophoneChunk, pcm16_base64_to_floats
from tests.synthetic_audio import chunks_from_window, synthesize_window


def _silent_chunk(
    sequence: int,
    time_s: float,
    simulation_id: str = "demo-001",
) -> MicrophoneAudioChunk:
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
    import base64

    clipped = np.clip(np.asarray(samples, dtype=np.float64), -1.0, 1.0)
    scaled = np.where(clipped < 0.0, clipped * 32768.0, clipped * 32767.0)
    ints = np.clip(np.round(scaled), -32768, 32767).astype("<i2")
    return base64.b64encode(ints.tobytes()).decode("ascii")


def test_schema_rejects_short_audio() -> None:
    payload = _silent_chunk(0, 1.0).model_dump()
    payload["microphones"][0]["audio"] = [0.0, 0.1]
    with pytest.raises(ValidationError):
        MicrophoneAudioChunk.model_validate(payload)


def test_pcm16_matches_the_simulation_frontend_layout() -> None:
    """The pushed scene uses elevation in y and the ground offset in z."""
    layout = (
        ("mic-1", -4.5, -2.2),
        ("mic-2", 0.0, 2.6),
        ("mic-3", 4.5, -2.2),
    )
    synth_mics = tuple(MicrophonePosition(mic_id, x_m, z_m) for mic_id, x_m, z_m in layout)
    source_x_m = 1.0
    channels = synthesize_window(
        source_x_m,
        t0_s=1.0,
        duration_s=1.0,
        snr_db=20.0,
        rng=np.random.default_rng(5),
        microphones=synth_mics,
    )
    message = {
        "type": "microphone_audio_chunk",
        "simulation_id": "routz-demo-001",
        "sequence": 0,
        "simulation_time_s": 1.0,
        "sample_rate_hz": SAMPLE_RATE_HZ,
        "duration_ms": 250,
        "source_file": "train.wav",
        "microphones": [
            {
                "id": mic_id,
                "x_m": x_m,
                "y_m": 0.0,
                "z_m": z_m,
                "audio_pcm16_base64": _pcm16_base64(channel[:SAMPLES_PER_CHUNK]),
            }
            for (mic_id, x_m, z_m), channel in zip(layout, channels)
        ],
    }
    chunk = MicrophoneAudioChunk.model_validate(message)
    assert chunk.uses_xz_ground_plane()
    assert chunk.ground_lateral_m(chunk.microphones[0]) == pytest.approx(-2.2)
    decoded = np.asarray(pcm16_base64_to_floats(message["microphones"][0]["audio_pcm16_base64"]))
    expected = np.clip(channels[0][:SAMPLES_PER_CHUNK], -1.0, 1.0)
    assert decoded == pytest.approx(expected, abs=1.0 / 32767.0)

    window = [np.asarray(mic.samples(), dtype=np.float64) for mic in chunk.microphones]
    # One chunk is 250 ms; localization below uses the full synthesized second.
    fix = estimate_rail_position_m(
        channels,
        list(synth_mics),
        SAMPLE_RATE_HZ,
    )
    assert fix.position_m == pytest.approx(source_x_m, abs=1.0)
    assert len(window[0]) == SAMPLES_PER_CHUNK


def test_localization_does_not_accept_ground_truth() -> None:
    banned = {"source_x_m", "ground_truth", "true_position_m", "true_speed_mps"}
    assert banned.isdisjoint(inspect.signature(estimate_rail_position_m).parameters)


def test_gcc_phat_positive_delay_means_signal_arrives_later() -> None:
    rng = np.random.default_rng(0)
    reference = rng.normal(0.0, 1.0, SAMPLE_RATE_HZ)
    delay_samples = 123
    delayed = np.zeros_like(reference)
    delayed[delay_samples:] = reference[:-delay_samples]
    delay_s, prominence = gcc_phat_delay_s(delayed, reference, SAMPLE_RATE_HZ)
    assert delay_s == pytest.approx(delay_samples / SAMPLE_RATE_HZ, abs=1.0 / SAMPLE_RATE_HZ)
    assert prominence > 8.0


def test_noise_does_not_invent_a_position() -> None:
    rng = np.random.default_rng(1)
    channels = [rng.normal(0.0, 0.05, SAMPLE_RATE_HZ) for _ in MICROPHONES]
    result = estimate_rail_position_m(channels, list(MICROPHONES), SAMPLE_RATE_HZ)
    assert result.position_m is None


@pytest.mark.parametrize("source_x_m", [25.0, 80.0, 160.0])
@pytest.mark.parametrize("snr_db", [20.0, 10.0])
def test_localization_error_on_train_audio(source_x_m: float, snr_db: float) -> None:
    rng = np.random.default_rng(int(source_x_m * 10 + snr_db))
    channels = synthesize_window(source_x_m, t0_s=1.0, duration_s=1.0, snr_db=snr_db, rng=rng)
    result = estimate_rail_position_m(channels, list(MICROPHONES), SAMPLE_RATE_HZ)
    assert result.position_m is not None
    assert result.position_m == pytest.approx(source_x_m, abs=10.0)


def test_pipeline_uses_simulation_time_and_buffers_before_a_fix(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="simulation_backend")
    rng = np.random.default_rng(7)
    channels = synthesize_window(80.0, t0_s=1.0, duration_s=1.25, snr_db=20.0, rng=rng)
    chunks = chunks_from_window(channels, t0_s=1.0, simulation_id="buffer-demo", sequence_start=0)
    pipeline = SimulationPipeline()
    early = [pipeline.ingest(chunk) for chunk in chunks[:3]]
    assert all(result.accepted for result in early)
    assert all(result.frontend_message["estimated_position_m"] is None for result in early)
    assert all(result.frontend_message["status"] == "unknown" for result in early)

    first_fix = pipeline.ingest(chunks[3])
    assert first_fix.frontend_message["simulation_time_s"] == chunks[3].simulation_time_s
    assert first_fix.frontend_message["estimated_position_m"] == pytest.approx(80.0, abs=10.0)
    assert first_fix.frontend_message["estimated_speed_mps"] is None
    assert first_fix.frontend_message["label"] == "estimate"
    assert "estimated_position_m" not in first_fix.backend_message
    assert "label" not in first_fix.backend_message
    assert "audio" not in first_fix.backend_message
    assert first_fix.backend_message["source"] == "simulated_audio_inference"

    second_fix = pipeline.ingest(chunks[4])
    assert second_fix.frontend_message["status"] == "tracking"
    assert second_fix.frontend_message["estimated_speed_mps"] == pytest.approx(0.0, abs=1.0)
    assert second_fix.frontend_message["direction"] == "unknown"
    assert all(crossing["status"] == "unknown" for crossing in second_fix.frontend_message["crossings"])
    assert "simulation_id=buffer-demo" in caplog.text
    assert "sequence=3" in caplog.text
    assert "latency_ms=" in caplog.text


def test_successive_acoustic_fixes_report_eastbound() -> None:
    """Each window holds the source still. A moving source inside one window smears GCC-PHAT."""
    tracker = TrainTracker()
    snapshot = None
    for index, source_x_m in enumerate((40.0, 55.0, 70.0)):
        rng = np.random.default_rng(100 + index)
        channels = synthesize_window(source_x_m, t0_s=1.0, duration_s=1.0, snr_db=20.0, rng=rng)
        fix = estimate_rail_position_m(channels, list(MICROPHONES), SAMPLE_RATE_HZ)
        assert fix.position_m == pytest.approx(source_x_m, abs=10.0)
        snapshot = tracker.observe(float(index), fix.position_m)
        assert snapshot is not None
    assert snapshot is not None
    assert snapshot.direction == "eastbound"
    assert snapshot.speed_mps == pytest.approx(15.0, abs=3.0)


def test_sequence_gap_time_regression_and_reset() -> None:
    pipeline = SimulationPipeline()
    assert pipeline.ingest(_silent_chunk(1, 5.0)).accepted
    gap = pipeline.ingest(_silent_chunk(3, 5.5))
    assert gap.accepted is False
    assert gap.frontend_message["reason"] == "out_of_order_or_gap"
    assert gap.frontend_message["expected_sequence"] == 2
    assert gap.backend_message is None

    backward = pipeline.ingest(_silent_chunk(2, 4.0))
    assert backward.frontend_message["reason"] == "non_monotonic_time"
    recovered = pipeline.ingest(_silent_chunk(2, 5.25))
    assert recovered.accepted
    assert recovered.frontend_message["simulation_time_s"] == 5.25

    duplicate = pipeline.ingest(_silent_chunk(2, 5.5))
    assert duplicate.frontend_message["reason"] == "out_of_order_or_gap"
    pipeline.reset("demo-001")
    assert pipeline.ingest(_silent_chunk(1, 0.0)).accepted


def test_tracker_speed_direction_and_eta() -> None:
    tracker = TrainTracker()
    snapshot = None
    for index in range(6):
        time_s = index * 0.25
        snapshot = tracker.observe(time_s, -192.5 + 10.0 * time_s)
    assert snapshot is not None
    assert snapshot.direction == "eastbound"
    assert snapshot.speed_mps == pytest.approx(10.0, abs=0.5)
    event = prediction_from_track(
        simulation_id="demo-001",
        sequence=6,
        simulation_time_s=1.25,
        position_m=snapshot.position_m,
        speed_mps=snapshot.speed_mps,
    )
    assert event.status == "tracking"
    assert event.estimated_position is not None
    crossing = next(item for item in event.crossings if item.crossing_id == "crossing-001")
    assert crossing.status == "approaching"
    assert crossing.eta_seconds == pytest.approx(14.0, abs=0.5)
    assert crossing.estimated_blockage_seconds == pytest.approx(18.0, abs=0.5)
    farther = next(item for item in event.crossings if item.crossing_id == "crossing-002")
    assert farther.eta_seconds == pytest.approx(24.0, abs=0.5)


def test_forecast_blocking_clear_and_westbound() -> None:
    blocking = forecast_crossing(0.0, 10.0, 50.0, train_length_m=180.0)
    assert blocking.status == "blocking"
    assert blocking.eta_seconds == 0.0
    assert blocking.estimated_blockage_seconds == pytest.approx(14.0)

    clear = forecast_crossing(200.0, 10.0, 50.0, train_length_m=180.0)
    assert clear.status == "clear"
    assert clear.eta_seconds is None

    westbound = forecast_crossing(200.0, -10.0, 50.0, train_length_m=180.0)
    assert westbound.status == "approaching"
    assert westbound.eta_seconds == pytest.approx(6.0)
    assert westbound.estimated_blockage_seconds == pytest.approx(18.0)

    stopped = forecast_crossing(50.0, 0.0, 50.0, train_length_m=180.0)
    assert stopped.status == "unknown"
    assert stopped.eta_seconds is None


def test_reversing_tracker_flips_direction() -> None:
    tracker = TrainTracker()
    snapshot = None
    for index in range(6):
        time_s = index * 0.25
        snapshot = tracker.observe(time_s, 10.0 * time_s)
    assert snapshot is not None and snapshot.direction == "eastbound"
    for index in range(6, 14):
        time_s = index * 0.25
        position_m = 12.5 - 10.0 * (time_s - 1.25)
        snapshot = tracker.observe(time_s, position_m)
    assert snapshot is not None
    assert snapshot.direction == "westbound"


def test_stopped_train_has_no_crossing_eta() -> None:
    tracker = TrainTracker()
    snapshot = None
    for index in range(5):
        snapshot = tracker.observe(index * 0.25, 50.0)
    assert snapshot is not None
    assert snapshot.speed_mps == pytest.approx(0.0, abs=0.5)
    assert snapshot.direction == "unknown"
    event = prediction_from_track(
        simulation_id="demo-001",
        sequence=5,
        simulation_time_s=1.0,
        position_m=snapshot.position_m,
        speed_mps=snapshot.speed_mps,
    )
    assert event.status == "tracking"
    assert all(crossing.status == "unknown" for crossing in event.crossings)


def test_rail_origin_maps_east() -> None:
    latitude, longitude = rail_to_latlon(0.0)
    assert latitude == pytest.approx(ORIGIN_LATITUDE)
    assert longitude == pytest.approx(ORIGIN_LONGITUDE)
    _east_lat, east_lon = rail_to_latlon(1000.0)
    assert east_lon > longitude


def test_post_skipped_when_url_missing() -> None:
    assert post_crossing_prediction({"simulation_id": "x", "sequence": 1}, "", "token") is False


def test_post_failure_is_swallowed() -> None:
    assert (
        post_crossing_prediction(
            {"simulation_id": "x", "sequence": 1},
            "http://127.0.0.1:1/api/predictions",
            "token",
            timeout_s=0.3,
        )
        is False
    )


def test_post_sends_bearer_token_without_audio() -> None:
    captured: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            captured["path"] = self.path
            captured["auth"] = self.headers.get("Authorization")
            captured["body"] = json.loads(self.rfile.read(length))
            self.send_response(204)
            self.end_headers()

        def log_message(self, fmt: str, *args: object) -> None:
            return

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        ok = post_crossing_prediction(
            {
                "type": "crossing_prediction",
                "simulation_id": "demo-001",
                "sequence": 4,
                "source": "simulated_audio_inference",
            },
            f"http://127.0.0.1:{port}/api/predictions",
            "test-token",
        )
    finally:
        server.shutdown()
    assert ok
    assert captured["path"] == "/api/predictions"
    assert captured["auth"] == "Bearer test-token"
    assert "audio" not in captured["body"]
    assert captured["body"]["source"] == "simulated_audio_inference"


def test_websocket_posts_prediction_and_rejects_a_gap() -> None:
    captured: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            captured.append(json.loads(self.rfile.read(length)))
            self.send_response(204)
            self.end_headers()

        def log_message(self, fmt: str, *args: object) -> None:
            return

    http_server = HTTPServer(("127.0.0.1", 0), Handler)
    http_port = http_server.server_address[1]
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()

    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    ws_port = probe.getsockname()[1]
    probe.close()

    import uvicorn
    from websockets.sync.client import connect

    original_pipeline = app.state.pipeline
    app.state.pipeline = SimulationPipeline(
        predictions_url=f"http://127.0.0.1:{http_port}/api/predictions",
        internal_api_token="socket-token",
    )
    config = uvicorn.Config(app, host="127.0.0.1", port=ws_port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("simulation backend did not start")

        with urllib.request.urlopen(f"http://127.0.0.1:{ws_port}/health", timeout=2) as response:
            health = json.loads(response.read().decode())
        assert health["status"] == "ok"
        assert health["sample_rate_hz"] == SAMPLE_RATE_HZ

        with connect(f"ws://127.0.0.1:{ws_port}/ws/simulation", open_timeout=5) as socket_client:
            socket_client.send(json.dumps(_silent_chunk(0, 1.0, "ws-demo").model_dump()))
            reply = json.loads(socket_client.recv(timeout=5))
            socket_client.send(json.dumps(_silent_chunk(2, 1.25, "ws-demo").model_dump()))
            rejected = json.loads(socket_client.recv(timeout=5))
        assert reply["type"] == "crossing_prediction"
        assert reply["status"] == "unknown"
        assert reply["label"] == "estimate"
        assert reply["simulation_time_s"] == 1.0
        assert rejected["reason"] == "out_of_order_or_gap"
        deadline = time.time() + 2.0
        while not captured and time.time() < deadline:
            time.sleep(0.05)
    finally:
        app.state.pipeline = original_pipeline
        server.should_exit = True
        http_server.shutdown()
        thread.join(timeout=5)

    assert len(captured) == 1
    assert captured[0]["simulation_id"] == "ws-demo"
    assert captured[0]["sequence"] == 0
    assert "audio" not in captured[0]
    assert "label" not in captured[0]
    assert "estimated_position_m" not in captured[0]
