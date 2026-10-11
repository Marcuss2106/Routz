#!/usr/bin/env python3
"""Simulated localization / speed / ETA trials for the acoustic pipeline.

SIMULATION ONLY. A synthetic train (one moving point source on the shared rail,
1/r attenuation, emission-time delay, white noise at a set SNR) is converted to
three microphone streams and fed to ``SimulationPipeline`` in-process. The
source position and speed are hidden truth used only for scoring. These numbers
describe this synthetic setup, not real-world accuracy.

ETA error is scored for the first real crossing after the array (Hampton St on
the demo corridor, see backend/src/backend/demo_anchor.py): the ETA implied by
each acoustic estimate versus the ETA implied by the hidden truth at the same
timestamp.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from moving_source import moving_source

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "src"))

from app.geometry import ACOUSTIC_FIELD_END_S, ACOUSTIC_FIELD_START_S  # noqa: E402
from app.pipeline import SimulationPipeline  # noqa: E402
from backend import demo_anchor  # noqa: E402
from backend.crossings import FRA_CROSSINGS  # noqa: E402
from backend.predict import delta_meters  # noqa: E402


LIVE_STATUSES = {"detected", "length_pending", "tracking"}


def _hampton_route_distance_m() -> float:
    start = next(c for c in FRA_CROSSINGS if c.id == "715869J")
    hampton = next(c for c in FRA_CROSSINGS if c.id == "715871K")
    east, north = delta_meters(start.latitude, start.longitude, hampton.latitude, hampton.longitude)
    along = east * np.cos(np.radians(demo_anchor.CORRIDOR_DEG_FROM_EAST)) + north * np.sin(
        np.radians(demo_anchor.CORRIDOR_DEG_FROM_EAST)
    )
    return float(along - demo_anchor.DEMO_WINDOW_START_M)


@dataclass
class RunResult:
    in_field_windows: int = 0
    fixes: int = 0
    position_errors_m: list[float] = field(default_factory=list)
    speed_errors_mps: list[float] = field(default_factory=list)
    speed_relative_errors: list[float] = field(default_factory=list)
    eastbound: int = 0
    directions: int = 0
    eta_errors_s: list[float] = field(default_factory=list)
    train_ids: set[str] = field(default_factory=set)
    cleared_lengths_m: list[float] = field(default_factory=list)


def run_once(speed_mps: float, snr_db: float, seed: int, hampton_m: float) -> RunResult:
    source = moving_source(
        simulation_id=f"trial-{speed_mps}-{snr_db}-{seed}",
        speed_mps=speed_mps,
        snr_db=snr_db,
        seed=seed,
    )
    pipeline = SimulationPipeline()
    result = RunResult()
    route_speed = speed_mps * demo_anchor.ROUTE_PER_ACOUSTIC_M
    for chunk in source.chunks:
        message = pipeline.ingest(chunk).frontend_message
        if message.get("type") != "train_state_estimate":
            continue
        center_s = source.truth_s(message["simulation_time_s"])
        in_field = ACOUSTIC_FIELD_START_S <= center_s <= ACOUSTIC_FIELD_END_S
        if in_field:
            result.in_field_windows += 1
        if message["status"] == "cleared" and message.get("length_m"):
            result.cleared_lengths_m.append(float(message["length_m"]))
        estimated_s = message.get("track_position_m")
        # "unknown" and "cleared" events repeat the last position; they are not fixes.
        if message["status"] not in LIVE_STATUSES or estimated_s is None or not in_field:
            continue
        result.fixes += 1
        result.train_ids.add(message["train_id"])
        result.position_errors_m.append(abs(estimated_s - center_s))
        estimated_speed = message.get("speed_mps")
        if estimated_speed is not None:
            result.speed_errors_mps.append(abs(estimated_speed - speed_mps))
            result.speed_relative_errors.append(abs(estimated_speed - speed_mps) / speed_mps)
            direction = message.get("direction_deg_from_east")
            if direction is not None:
                result.directions += 1
                result.eastbound += int(abs(direction) < 1.0 or abs(direction - 360.0) < 1.0)
            # ETA of the train front at Hampton St, estimate versus truth.
            estimated_eta = (
                hampton_m - demo_anchor.route_distance_m(estimated_s)
            ) / max(estimated_speed * demo_anchor.ROUTE_PER_ACOUSTIC_M, 1e-6)
            true_eta = (hampton_m - demo_anchor.route_distance_m(center_s)) / route_speed
            if true_eta > 0.0:
                result.eta_errors_s.append(abs(estimated_eta - true_eta))
    return result


def _percentile(values: list[float], q: float) -> float | None:
    return float(np.percentile(values, q)) if values else None


def summarize(runs: list[RunResult]) -> dict:
    position = [v for run in runs for v in run.position_errors_m]
    speed = [v for run in runs for v in run.speed_errors_mps]
    relative = [v for run in runs for v in run.speed_relative_errors]
    eta = [v for run in runs for v in run.eta_errors_s]
    windows = sum(run.in_field_windows for run in runs)
    fixes = sum(run.fixes for run in runs)
    directions = sum(run.directions for run in runs)
    eastbound = sum(run.eastbound for run in runs)
    lengths = [v for run in runs for v in run.cleared_lengths_m]
    return {
        "runs": len(runs),
        "fix_rate": fixes / windows if windows else None,
        "position_median_m": _percentile(position, 50),
        "position_p90_m": _percentile(position, 90),
        "speed_median_relative": _percentile(relative, 50),
        "speed_p90_mps": _percentile(speed, 90),
        "direction_correct": eastbound / directions if directions else None,
        "eta_median_s": _percentile(eta, 50),
        "eta_p90_s": _percentile(eta, 90),
        "train_ids_per_pass": statistics.mean(len(run.train_ids) for run in runs),
        "cleared_length_median_m": statistics.median(lengths) if lengths else None,
    }


def _fmt(value: float | None, digits: int = 1, scale: float = 1.0, suffix: str = "") -> str:
    return "n/a" if value is None else f"{value * scale:.{digits}f}{suffix}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--speeds", type=float, nargs="+", default=[10.0, 20.0, 30.0])
    parser.add_argument("--snrs", type=float, nargs="+", default=[20.0, 10.0, 5.0, 0.0])
    parser.add_argument("--seeds", type=int, default=2)
    parser.add_argument("--json", type=Path, help="write the summary rows here")
    args = parser.parse_args()

    hampton_m = _hampton_route_distance_m()
    rows = []
    print(
        "| speed (rail m/s) | SNR (dB) | fix rate | position median / p90 (m) | speed error median / p90 | "
        "eastbound | ETA error median / p90 (s) | train ids per pass |"
    )
    print("|---|---|---|---|---|---|---|---|")
    for speed in args.speeds:
        for snr in args.snrs:
            runs = [run_once(speed, snr, seed, hampton_m) for seed in range(1, args.seeds + 1)]
            summary = summarize(runs) | {"speed_mps": speed, "snr_db": snr}
            rows.append(summary)
            print(
                f"| {speed:g} | {snr:g} | {_fmt(summary['fix_rate'], 0, 100, '%')} "
                f"| {_fmt(summary['position_median_m'])} / {_fmt(summary['position_p90_m'])} "
                f"| {_fmt(summary['speed_median_relative'], 0, 100, '%')} / {_fmt(summary['speed_p90_mps'])} m/s "
                f"| {_fmt(summary['direction_correct'], 0, 100, '%')} "
                f"| {_fmt(summary['eta_median_s'])} / {_fmt(summary['eta_p90_s'])} "
                f"| {summary['train_ids_per_pass']:.1f} |",
                flush=True,
            )
    if args.json:
        args.json.write_text(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
