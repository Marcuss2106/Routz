"""GCC-PHAT delay estimation constrained to the shared rail polyline."""

from __future__ import annotations

from dataclasses import dataclass
import math

import numpy as np

from app.denoise import denoise_channels
from app.geometry import (
    ACOUSTIC_FIELD_END_S,
    ACOUSTIC_FIELD_START_S,
    SPEED_OF_SOUND_MPS,
    MicrophonePosition,
    rail_point_at_s,
)

GCC_BAND_HZ = (150.0, 2500.0)
MAX_DELAY_S = 0.70
MIN_PEAK_PROMINENCE = 8.0
MAX_DELAY_RESIDUAL_S = 0.012
SEARCH_MARGIN_M = 80.0


@dataclass(frozen=True)
class LocalizationResult:
    position_m: float | None
    position_error_m: float | None
    delay_residual_s: float | None
    confidence: float
    peak_prominence: float | None = None
    active: bool = False


def gcc_phat_delay_s(
    sig: np.ndarray,
    ref: np.ndarray,
    sample_rate_hz: int,
    max_delay_s: float = MAX_DELAY_S,
) -> tuple[float, float]:
    """Return how many seconds ``sig`` lags ``ref`` and the peak prominence."""
    sig = np.ascontiguousarray(sig, dtype=np.float64)
    ref = np.ascontiguousarray(ref, dtype=np.float64)
    sig = sig - np.mean(sig)
    ref = ref - np.mean(ref)
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
        denominator = left - 2.0 * center + right
        if denominator != 0.0:
            delta = 0.5 * (left - right) / denominator
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
    """Estimate ``s`` along the rail using audio and microphone geometry only."""
    if len(channels) != len(microphones) or len(channels) < 3:
        raise ValueError("channels and microphones must align and contain three microphones")
    lengths = {len(channel) for channel in channels}
    if len(lengths) != 1 or lengths.pop() == 0:
        raise ValueError("channels must be non-empty and the same length")
    if any(not np.isfinite(channel).all() for channel in channels):
        return _rejected()

    raw_rms = [float(np.sqrt(np.mean(np.square(channel)))) for channel in channels]
    if max(raw_rms) < 1e-5 or min(raw_rms) < 1e-5:
        return _rejected()

    denoised = denoise_channels(channels, sample_rate_hz)
    if any(not np.isfinite(channel).all() for channel in denoised):
        return _rejected()
    if any(float(np.sqrt(np.mean(np.square(channel)))) < 1e-6 for channel in denoised):
        return _rejected()

    pairs: list[tuple[int, int, float, float]] = []
    for sig_index in range(len(denoised)):
        for ref_index in range(sig_index):
            delay_s, prominence = gcc_phat_delay_s(
                denoised[sig_index], denoised[ref_index], sample_rate_hz
            )
            pairs.append((sig_index, ref_index, delay_s, prominence))
    if not pairs:
        return _rejected()

    prominence = min(pair[3] for pair in pairs)
    if not np.isfinite(prominence) or prominence < MIN_PEAK_PROMINENCE:
        return LocalizationResult(None, None, None, 0.0, float(prominence), False)

    search_start = ACOUSTIC_FIELD_START_S - SEARCH_MARGIN_M
    search_end = ACOUSTIC_FIELD_END_S + SEARCH_MARGIN_M
    coarse = np.linspace(search_start, search_end, int((search_end - search_start) / 1.0) + 1)
    best_s, best_cost, second_cost = _best_rail_s(coarse, microphones, pairs)
    fine = np.linspace(best_s - 2.0, best_s + 2.0, 81)
    best_s, best_cost, _ = _best_rail_s(fine, microphones, pairs)

    delay_residual_s = math.sqrt(best_cost / len(pairs)) if np.isfinite(best_cost) else float("inf")
    ambiguity = 1.0
    if second_cost > 0.0 and np.isfinite(second_cost):
        ambiguity = min(1.0, max(0.0, (second_cost - best_cost) / second_cost * 4.0))
    peak_confidence = min(1.0, max(0.0, (prominence - MIN_PEAK_PROMINENCE) / 18.0 + 0.35))
    residual_confidence = math.exp(-delay_residual_s / 0.0035)
    confidence = max(0.0, min(1.0, peak_confidence * residual_confidence * max(0.25, ambiguity)))
    position_error_m = max(0.75, delay_residual_s * SPEED_OF_SOUND_MPS * 2.0)

    if not np.isfinite(delay_residual_s) or delay_residual_s > MAX_DELAY_RESIDUAL_S or confidence < 0.18:
        return LocalizationResult(
            None,
            position_error_m,
            delay_residual_s,
            confidence,
            float(prominence),
            False,
        )
    return LocalizationResult(
        float(best_s),
        float(position_error_m),
        float(delay_residual_s),
        float(confidence),
        float(prominence),
        True,
    )


def _best_rail_s(
    candidates_m: np.ndarray,
    microphones: list[MicrophonePosition],
    pairs: list[tuple[int, int, float, float]],
) -> tuple[float, float, float]:
    scored: list[tuple[float, float]] = []
    for rail_s in candidates_m:
        rail_x, rail_y = rail_point_at_s(float(rail_s))
        distances = np.array(
            [math.hypot(rail_x - mic.x_m, rail_y - mic.y_m) for mic in microphones],
            dtype=np.float64,
        )
        cost = 0.0
        for sig_index, ref_index, delay_s, prominence in pairs:
            predicted_s = (distances[sig_index] - distances[ref_index]) / SPEED_OF_SOUND_MPS
            residual = predicted_s - delay_s
            weight = min(2.0, max(0.5, prominence / 12.0))
            cost += float(weight * residual * residual)
        scored.append((cost, float(rail_s)))
    scored.sort(key=lambda item: item[0])
    best_cost, best_s = scored[0]
    second_cost = scored[1][0] if len(scored) > 1 else float("inf")
    return best_s, best_cost, second_cost


def _rejected() -> LocalizationResult:
    return LocalizationResult(None, None, None, 0.0, None, False)
