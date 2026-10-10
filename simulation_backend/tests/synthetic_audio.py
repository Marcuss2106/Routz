"""Build delayed, attenuated microphone audio for tests.

`source_x_m` is used only to render the signals. Localization must not receive it.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample

from app.geometry import (
    CHUNK_DURATION_S,
    MICROPHONES,
    SAMPLE_RATE_HZ,
    SAMPLES_PER_CHUNK,
    SPEED_OF_SOUND_MPS,
    MicrophonePosition,
)
from app.schemas import MicrophoneAudioChunk, MicrophoneChunk

_SOURCE: np.ndarray | None = None


def train_source_mono(sample_rate_hz: int = SAMPLE_RATE_HZ) -> np.ndarray:
    global _SOURCE
    if _SOURCE is not None and sample_rate_hz == SAMPLE_RATE_HZ:
        return _SOURCE
    path = Path(__file__).resolve().parents[2] / "train.wav"
    if not path.is_file():
        raise FileNotFoundError(path)
    start = int(8 * 44100)
    frames = int(8 * 44100)
    data, file_rate = sf.read(path, start=start, frames=frames, always_2d=True)
    mono = np.asarray(data.mean(axis=1), dtype=np.float64)
    if file_rate != sample_rate_hz:
        target = int(round(len(mono) * sample_rate_hz / file_rate))
        mono = np.asarray(resample(mono, target), dtype=np.float64)
    peak = float(np.max(np.abs(mono)))
    mono = mono / peak if peak > 0 else mono
    if sample_rate_hz == SAMPLE_RATE_HZ:
        _SOURCE = mono
    return mono


def synthesize_window(
    source_x_m: float,
    t0_s: float,
    duration_s: float,
    snr_db: float,
    rng: np.random.Generator,
    microphones: tuple[MicrophonePosition, ...] = MICROPHONES,
    sample_rate_hz: int = SAMPLE_RATE_HZ,
) -> list[np.ndarray]:
    """Simultaneous capture of one source fixed at `source_x_m` during the window."""
    source = train_source_mono(sample_rate_hz)
    sample_count = int(round(duration_s * sample_rate_hz))
    channels: list[np.ndarray] = []
    for mic in microphones:
        distance_m = float(np.hypot(source_x_m - mic.x_m, mic.y_m))
        delay_s = distance_m / SPEED_OF_SOUND_MPS
        attenuation = 1.0 / max(distance_m, 1.0)
        times_s = t0_s + np.arange(sample_count) / sample_rate_hz
        indices = (times_s - delay_s) * sample_rate_hz
        clean = np.interp(indices, np.arange(len(source)), source, left=0.0, right=0.0)
        clean *= attenuation
        rms = float(np.sqrt(np.mean(clean**2))) + 1e-12
        noise_std = rms / (10 ** (snr_db / 20.0))
        channels.append(clean + rng.normal(0.0, noise_std, sample_count))
    return channels


def chunks_from_window(
    channels: list[np.ndarray],
    t0_s: float,
    simulation_id: str,
    sequence_start: int,
    microphones: tuple[MicrophonePosition, ...] = MICROPHONES,
) -> list[MicrophoneAudioChunk]:
    messages: list[MicrophoneAudioChunk] = []
    offset = 0
    sequence = sequence_start
    time_s = t0_s
    while offset + SAMPLES_PER_CHUNK <= len(channels[0]):
        messages.append(
            MicrophoneAudioChunk(
                type="microphone_audio_chunk",
                simulation_id=simulation_id,
                sequence=sequence,
                simulation_time_s=time_s,
                sample_rate_hz=SAMPLE_RATE_HZ,
                duration_ms=int(CHUNK_DURATION_S * 1000),
                microphones=[
                    MicrophoneChunk(
                        id=mic.id,
                        x_m=mic.x_m,
                        y_m=mic.y_m,
                        audio=channel[offset : offset + SAMPLES_PER_CHUNK].tolist(),
                    )
                    for mic, channel in zip(microphones, channels, strict=True)
                ],
            )
        )
        offset += SAMPLES_PER_CHUNK
        sequence += 1
        time_s += CHUNK_DURATION_S
    return messages
