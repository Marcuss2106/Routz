"""GCC-PHAT delays and a position constrained to the rail line."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.denoise import denoise_channels
from app.geometry import SPEED_OF_SOUND_MPS, TRACK_Y_M, MicrophonePosition

GCC_BAND_HZ = (150.0, 2500.0)
MAX_DELAY_S = 0.70
MIN_PEAK_PROMINENCE = 8.0
MAX_DELAY_COST_S2 = 0.005
SEARCH_MARGIN_M = 40.0


@dataclass(frozen=True)
class LocalizationResult:
    position_m: float | None
    delay_cost_s2: float | None
    peak_prominence: float | None


def gcc_phat_delay_s(
    sig: np.ndarray,
    ref: np.ndarray,
    sample_rate_hz: int,
    max_delay_s: float = MAX_DELAY_S,
) -> tuple[float, float]:
    """Return how many seconds `sig` lags `ref`, and the peak prominence.

    A positive delay means `sig` arrives later than `ref`.
    """
    sig = np.ascontiguousarray(sig, dtype=np.float64)
    ref = np.ascontiguousarray(ref, dtype=np.float64)
    nfft = 1 << int(np.ceil(np.log2(len(sig) + len(ref))))
    sig_spectrum = np.fft.rfft(sig, n=nfft)
    ref_spectrum = np.fft.rfft(ref, n=nfft)
    cross = sig_spectrum * np.conj(ref_spectrum)
    frequencies = np.fft.rfftfreq(nfft, d=1.0 / sample_rate_hz)
    low_hz, high_hz = GCC_BAND_HZ
    in_band = (frequencies >= low_hz) & (frequencies <= high_hz)
    cross = np.where(in_band, cross / (np.abs(cross) + 1e-12), 0.0)
    correlation = np.fft.irfft(cross, n=nfft)

    max_shift = int(round(max_delay_s * sample_rate_hz))
    if max_shift < 1 or max_shift >= nfft // 2:
        raise ValueError("max_delay_s is outside the correlation window")
    window = np.concatenate((correlation[-max_shift:], correlation[: max_shift + 1]))
    peak_index = int(np.argmax(window))
    delta = 0.0
    if 0 < peak_index < len(window) - 1:
        left, center, right = window[peak_index - 1], window[peak_index], window[peak_index + 1]
        denom = left - 2.0 * center + right
        if denom != 0.0:
            delta = 0.5 * (left - right) / denom
            if not np.isfinite(delta) or abs(delta) > 1.0:
                delta = 0.0
    delay_s = (peak_index - max_shift + delta) / sample_rate_hz
    prominence = float(window[peak_index] / (np.median(np.abs(window)) + 1e-12))
    return delay_s, prominence


def estimate_rail_position_m(
    channels: list[np.ndarray],
    microphones: list[MicrophonePosition],
    sample_rate_hz: int,
) -> LocalizationResult:
    """Estimate along-track position from synchronized channels.

    The source coordinate used to synthesize a test signal is not an input.
    """
    if len(channels) != len(microphones) or len(channels) < 2:
        raise ValueError("channels and microphones must align and contain at least two")
    lengths = {len(channel) for channel in channels}
    if len(lengths) != 1 or lengths.pop() == 0:
        raise ValueError("channels must be non-empty and the same length")
    if any(not np.isfinite(channel).all() for channel in channels):
        return LocalizationResult(None, None, None)

    denoised = denoise_channels(channels, sample_rate_hz)
    if any(float(np.max(np.abs(channel))) < 1e-8 for channel in denoised):
        return LocalizationResult(None, None, None)

    pairs: list[tuple[int, int, float, float]] = []
    for sig_index in range(len(denoised)):
        for ref_index in range(sig_index):
            delay_s, prominence = gcc_phat_delay_s(
                denoised[sig_index], denoised[ref_index], sample_rate_hz
            )
            pairs.append((sig_index, ref_index, delay_s, prominence))

    mic_x = np.array([mic.x_m for mic in microphones], dtype=np.float64)
    mic_y = np.array([mic.y_m - TRACK_Y_M for mic in microphones], dtype=np.float64)
    x_min = float(np.min(mic_x) - SEARCH_MARGIN_M)
    x_max = float(np.max(mic_x) + SEARCH_MARGIN_M)
    coarse = np.linspace(x_min, x_max, int((x_max - x_min) / 0.5) + 1)
    best_x, best_cost = _best_rail_x(coarse, mic_x, mic_y, pairs)
    fine = np.linspace(best_x - 1.0, best_x + 1.0, 41)
    best_x, best_cost = _best_rail_x(fine, mic_x, mic_y, pairs)
    prominence = min(pair[3] for pair in pairs)
    if (
        not np.isfinite(best_cost)
        or best_cost > MAX_DELAY_COST_S2
        or not np.isfinite(prominence)
        or prominence < MIN_PEAK_PROMINENCE
    ):
        return LocalizationResult(None, float(best_cost), float(prominence))
    return LocalizationResult(float(best_x), float(best_cost), float(prominence))


def _best_rail_x(
    candidates_m: np.ndarray,
    mic_x: np.ndarray,
    mic_y: np.ndarray,
    pairs: list[tuple[int, int, float, float]],
) -> tuple[float, float]:
    best_cost = float("inf")
    best_x = float(candidates_m[0])
    for rail_x in candidates_m:
        distances = np.hypot(rail_x - mic_x, mic_y)
        cost = 0.0
        for sig_index, ref_index, delay_s, _prominence in pairs:
            predicted_s = (distances[sig_index] - distances[ref_index]) / SPEED_OF_SOUND_MPS
            residual = predicted_s - delay_s
            cost += float(residual * residual)
        if cost < best_cost:
            best_cost = cost
            best_x = float(rail_x)
    return best_x, best_cost
