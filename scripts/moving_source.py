"""Continuously moving synthetic train for end-to-end checks and trials.

SIMULATION ONLY. The source position here is hidden truth used to synthesize
three microphone channels (moving-source emission delay, 1/r attenuation, and
white noise at a chosen SNR). Only microphone samples and geometry are put in
the returned chunks; the truth callable is for scoring.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "simulation_backend"))
sys.path.insert(0, str(ROOT / "simulation_backend" / "tests"))

from app.geometry import (  # noqa: E402
    CHUNK_DURATION_S,
    MICROPHONES,
    SAMPLE_RATE_HZ,
    SAMPLES_PER_CHUNK,
    SPEED_OF_SOUND_MPS,
    TRACK_POINTS,
)
from app.schemas import MicrophoneAudioChunk, MicrophoneChunk  # noqa: E402
from synthetic_audio import train_source_mono  # noqa: E402

_VERTEX_S = [0.0]
for _a, _b in zip(TRACK_POINTS, TRACK_POINTS[1:]):
    _VERTEX_S.append(_VERTEX_S[-1] + float(np.hypot(_b.x_m - _a.x_m, _b.y_m - _a.y_m)))
_VERTEX_X = [point.x_m for point in TRACK_POINTS]
_VERTEX_Y = [point.y_m for point in TRACK_POINTS]


def _rail_xy(s: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Vectorised east/north position, extrapolating before and after the rail."""
    s = np.asarray(s, dtype=np.float64)
    x = np.interp(s, _VERTEX_S, _VERTEX_X)
    y = np.interp(s, _VERTEX_S, _VERTEX_Y)
    before = s < 0.0
    x = np.where(before, _VERTEX_X[0] + s, x)
    y = np.where(before, _VERTEX_Y[0], y)
    after = s > _VERTEX_S[-1]
    last = np.hypot(_VERTEX_X[-1] - _VERTEX_X[-2], _VERTEX_Y[-1] - _VERTEX_Y[-2])
    ux = (_VERTEX_X[-1] - _VERTEX_X[-2]) / last
    uy = (_VERTEX_Y[-1] - _VERTEX_Y[-2]) / last
    x = np.where(after, _VERTEX_X[-1] + (s - _VERTEX_S[-1]) * ux, x)
    y = np.where(after, _VERTEX_Y[-1] + (s - _VERTEX_S[-1]) * uy, y)
    return x, y


@dataclass
class MovingSource:
    chunks: list[MicrophoneAudioChunk]
    truth_s: Callable[[float], float]
    speed_mps: float
    s_start_m: float
    s_end_m: float


def moving_source(
    *,
    simulation_id: str,
    speed_mps: float,
    snr_db: float,
    s_start_m: float = -250.0,
    s_end_m: float = 350.0,
    tail_s: float = 6.0,
    seed: int = 1,
) -> MovingSource:
    """Train center moves at constant signed speed from ``s_start_m`` to ``s_end_m``."""
    rng = np.random.default_rng(seed)
    source = train_source_mono()
    count = len(source)
    moving_s = abs(s_end_m - s_start_m) / abs(speed_mps)
    chunk_count = int((moving_s + tail_s) / CHUNK_DURATION_S) + 1
    sample_count = chunk_count * SAMPLES_PER_CHUNK
    times = np.arange(sample_count) / SAMPLE_RATE_HZ
    sign = 1.0 if speed_mps >= 0 else -1.0

    def truth_s(time_s: float) -> float:
        return s_start_m + speed_mps * time_s

    lo, hi = min(s_start_m, s_end_m), max(s_start_m, s_end_m)
    channels: list[np.ndarray] = []
    for mic in MICROPHONES:
        emission = times.copy()
        for _ in range(3):
            x, y = _rail_xy(s_start_m + speed_mps * emission)
            emission = times - np.hypot(x - mic.x_m, y - mic.y_m) / SPEED_OF_SOUND_MPS
        x, y = _rail_xy(s_start_m + speed_mps * emission)
        distance = np.hypot(x - mic.x_m, y - mic.y_m)
        index = (emission * SAMPLE_RATE_HZ) % count
        clean = np.interp(index, np.arange(count), source) / np.maximum(distance, 1.0)
        position = s_start_m + speed_mps * times
        active = (position >= lo) & (position <= hi)
        clean = np.where(active, clean, 0.0)
        rms = float(np.sqrt(np.mean(clean[active] ** 2))) + 1e-12
        noise = rng.normal(0.0, rms / (10.0 ** (snr_db / 20.0)), sample_count)
        channels.append(clean + noise)
    del sign

    chunks: list[MicrophoneAudioChunk] = []
    for index in range(chunk_count):
        start, stop = index * SAMPLES_PER_CHUNK, (index + 1) * SAMPLES_PER_CHUNK
        chunks.append(
            MicrophoneAudioChunk(
                type="microphone_audio_chunk",
                simulation_id=simulation_id,
                sequence=index,
                simulation_time_s=index * CHUNK_DURATION_S,
                sample_rate_hz=SAMPLE_RATE_HZ,
                duration_ms=int(CHUNK_DURATION_S * 1000),
                microphones=[
                    MicrophoneChunk(
                        id=mic.id,
                        x_m=mic.x_m,
                        y_m=mic.y_m,
                        audio=channel[start:stop].tolist(),
                    )
                    for mic, channel in zip(MICROPHONES, channels)
                ],
            )
        )
    return MovingSource(chunks, truth_s, speed_mps, s_start_m, s_end_m)
