"""Band-pass each microphone channel before delay estimation.

The same filter runs on every channel, so its phase does not change the
inter-microphone delay.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfiltfilt

BAND_HZ = (100.0, 2500.0)

_sos_cache: dict[int, np.ndarray] = {}


def _bandpass_sos(sample_rate_hz: int) -> np.ndarray:
    cached = _sos_cache.get(sample_rate_hz)
    if cached is None:
        low_hz, high_hz = BAND_HZ
        cached = butter(4, [low_hz, high_hz], btype="bandpass", fs=sample_rate_hz, output="sos")
        _sos_cache[sample_rate_hz] = cached
    return cached


def denoise_channels(channels: list[np.ndarray], sample_rate_hz: int) -> list[np.ndarray]:
    if not channels:
        return []
    sos = _bandpass_sos(sample_rate_hz)
    return [sosfiltfilt(sos, np.asarray(channel, dtype=np.float64)) for channel in channels]
