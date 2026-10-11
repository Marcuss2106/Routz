#!/usr/bin/env python3
"""Generate a reproducible report for the stationary-window acoustic contract.

This is a contract microbenchmark, not a field-accuracy claim or a moving-train
performance benchmark. It creates synthetic microphone captures from the
repository's train recording, then evaluates the same localization, tracking,
coordinate conversion, direction, and lifecycle code used by the live
simulation. Use scripts/e2e_trials.py for continuously moving-source trials.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SIMULATION_ROOT = PROJECT_ROOT / "simulation_backend"
sys.path.insert(0, str(SIMULATION_ROOT))
sys.path.insert(0, str(SIMULATION_ROOT / "tests"))

from app.geometry import (  # noqa: E402
    MICROPHONES,
    ORIGIN_LATITUDE,
    SAMPLE_RATE_HZ,
    direction_deg_from_east,
    rail_to_latlon,
)
from app.localization import estimate_rail_position_m  # noqa: E402
from app.prediction import (  # noqa: E402
    AcousticTrackEstimator,
    TrainLifecycleTracker,
    TrainTracker,
)
from synthetic_audio import synthesize_window  # noqa: E402


POSITION_CASES = (-30.0, 0.0, 25.0, 80.0, 160.0, 210.0)
SNR_CASES_DB = (10.0, 20.0)
MOVING_POSITIONS_M = tuple(float(value) for value in range(0, 141, 20))
MOVING_SPEED_MPS = 20.0
EXPECTED_LENGTH_M = 140.0


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * fraction
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return float(ordered[lower])
    weight = index - lower
    return float(ordered[lower] * (1.0 - weight) + ordered[upper] * weight)


def circular_error_degrees(actual: float, expected: float) -> float:
    return abs((actual - expected + 180.0) % 360.0 - 180.0)


def local_latlon_error_m(
    actual: tuple[float, float], expected: tuple[float, float]
) -> float:
    latitude, longitude = actual
    expected_latitude, expected_longitude = expected
    north_m = (latitude - expected_latitude) * 111_320.0
    east_m = (
        (longitude - expected_longitude)
        * 111_320.0
        * math.cos(math.radians(ORIGIN_LATITUDE))
    )
    return math.hypot(east_m, north_m)


def position_validation() -> dict[str, Any]:
    errors: list[float] = []
    latlon_errors: list[float] = []
    confidences: list[float] = []
    cases: list[dict[str, Any]] = []

    for position_m in POSITION_CASES:
        for snr_db in SNR_CASES_DB:
            seed = int((position_m + 100.0) * 100 + snr_db)
            channels = synthesize_window(
                position_m,
                t0_s=1.0,
                duration_s=1.0,
                snr_db=snr_db,
                rng=np.random.default_rng(seed),
            )
            result = estimate_rail_position_m(
                channels, list(MICROPHONES), SAMPLE_RATE_HZ
            )
            case: dict[str, Any] = {
                "true_position_m": position_m,
                "snr_db": snr_db,
                "active": result.active,
                "confidence": result.confidence,
                "estimated_position_m": result.position_m,
            }
            if result.position_m is not None:
                position_error = abs(result.position_m - position_m)
                expected_latlon = rail_to_latlon(position_m)
                actual_latlon = rail_to_latlon(result.position_m)
                errors.append(position_error)
                latlon_errors.append(
                    local_latlon_error_m(actual_latlon, expected_latlon)
                )
                confidences.append(result.confidence)
                case["position_error_m"] = position_error
                case["latlon_error_m"] = latlon_errors[-1]
            cases.append(case)

    active_cases = sum(1 for case in cases if case["active"])
    return {
        "cases": len(cases),
        "active_cases": active_cases,
        "detection_rate": active_cases / len(cases),
        "position_error_m": {
            "median": percentile(errors, 0.50),
            "p95": percentile(errors, 0.95),
            "max": max(errors) if errors else None,
        },
        "latlon_error_m": {
            "median": percentile(latlon_errors, 0.50),
            "p95": percentile(latlon_errors, 0.95),
        },
        "confidence": {"median": percentile(confidences, 0.50)},
        "cases_detail": cases,
    }


def tracking_validation() -> dict[str, Any]:
    tracker = TrainTracker()
    speed_errors: list[float] = []
    direction_errors: list[float] = []
    position_errors: list[float] = []
    complete_event: dict[str, Any] | None = None
    events: list[dict[str, Any]] = []
    estimator = AcousticTrackEstimator("validation")

    for sequence, position_m in enumerate(MOVING_POSITIONS_M):
        channels = synthesize_window(
            position_m,
            t0_s=float(sequence),
            duration_s=1.0,
            snr_db=15.0,
            rng=np.random.default_rng(10_000 + sequence),
        )
        localization = estimate_rail_position_m(
            channels, list(MICROPHONES), SAMPLE_RATE_HZ
        )
        if localization.position_m is not None:
            position_errors.append(abs(localization.position_m - position_m))
            snapshot = tracker.observe(
                float(sequence),
                localization.position_m,
                localization.position_error_m or 10.0,
                localization.confidence,
            )
        else:
            snapshot = None

        event = estimator.observe(
            sequence=sequence,
            simulation_time_s=float(sequence),
            localization=localization,
        )
        payload = event.frontend_payload()
        events.append(payload)
        length_value = payload.get("length_m") or payload.get("provisional_length_m")
        if (
            payload.get("latitude") is not None
            and payload.get("longitude") is not None
            and payload.get("speed_mps") is not None
            and length_value is not None
            and payload.get("direction_deg_from_east") is not None
        ):
            complete_event = {
                "latitude": payload["latitude"],
                "longitude": payload["longitude"],
                "speed_mps": payload["speed_mps"],
                "length_m": length_value,
                "length_kind": (
                    "stable" if payload.get("length_m") is not None else "provisional"
                ),
                "direction_deg_from_east": payload["direction_deg_from_east"],
                "confidence": payload["confidence"],
                "uncertainty": payload["uncertainty"],
                "source": payload["source"],
            }

        if snapshot is not None and snapshot.speed_mps is not None:
            speed_errors.append(abs(snapshot.speed_mps - MOVING_SPEED_MPS))
            expected_direction = direction_deg_from_east(
                position_m, MOVING_SPEED_MPS
            )
            if (
                expected_direction is not None
                and snapshot.direction_deg_from_east is not None
            ):
                direction_errors.append(
                    circular_error_degrees(
                        snapshot.direction_deg_from_east, expected_direction
                    )
                )

    lifecycle = TrainLifecycleTracker("length-validation")
    for time_s in range(8):
        lifecycle.observe(float(time_s), True, MOVING_SPEED_MPS)
    cleared = lifecycle.observe(8.5, False, MOVING_SPEED_MPS)

    return {
        "moving_cases": len(MOVING_POSITIONS_M),
        "position_error_m": {
            "median": percentile(position_errors, 0.50),
            "p95": percentile(position_errors, 0.95),
        },
        "speed_error_mps": {
            "median": percentile(speed_errors, 0.50),
            "p95": percentile(speed_errors, 0.95),
        },
        "direction_error_deg": {
            "median": percentile(direction_errors, 0.50),
            "p95": percentile(direction_errors, 0.95),
        },
        "length": {
            "expected_m": EXPECTED_LENGTH_M,
            "estimated_m": cleared.length_m,
            "absolute_error_m": (
                abs(cleared.length_m - EXPECTED_LENGTH_M)
                if cleared.length_m is not None
                else None
            ),
            "status_after_clear": cleared.status,
        },
        "complete_state_event": complete_event,
        "event_count": len(events),
    }


def rejected_audio_validation() -> dict[str, Any]:
    noise = np.random.default_rng(42).normal(0.0, 0.05, SAMPLE_RATE_HZ)
    result = estimate_rail_position_m(
        [noise, noise.copy(), noise.copy()], list(MICROPHONES), SAMPLE_RATE_HZ
    )
    return {
        "active": result.active,
        "confidence": result.confidence,
        "position_m": result.position_m,
    }


def make_report() -> dict[str, Any]:
    return {
        "report": "Routz acoustic contract microbenchmark",
        "generated_by": "scripts/acoustic_validation.py",
        "methodology": {
            "audio_source": "repository train.wav",
            "input_to_estimator": (
                "synthetic microphone channels plus microphone geometry"
            ),
            "ground_truth_available_to_estimator": False,
            "field_validation": False,
            "moving_source_benchmark": False,
            "note": (
                "This report validates stationary synthetic windows and the "
                "five-value event contract; it is not a field-accuracy or "
                "moving-source performance claim."
            ),
        },
        "required_state": [
            "latitude",
            "longitude",
            "speed_mps",
            "length_m or provisional_length_m",
            "direction_deg_from_east",
        ],
        "position": position_validation(),
        "tracking": tracking_validation(),
        "rejection": rejected_audio_validation(),
    }


def fmt(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value)


def markdown_report(report: dict[str, Any]) -> str:
    position = report["position"]
    tracking = report["tracking"]
    length = tracking["length"]
    complete = tracking["complete_state_event"]
    lines = [
        "# Routz Acoustic Contract Microbenchmark",
        "",
        "> Simulation validation only. This report is not field accuracy evidence.",
        "",
        "## Method",
        "",
        "The harness creates deterministic stationary-source microphone captures "
        "from train.wav, "
        "sends only microphone channels and microphone geometry into the "
        "localization/tracking code, and compares the returned estimates with "
        "hidden test values. Ground-truth train position is not passed to the "
        "estimator. Continuously moving-source performance is measured separately "
        "by scripts/e2e_trials.py.",
        "",
        "## Results",
        "",
        "| Measurement | Result |",
        "|---|---:|",
        f"| Position cases | {position['cases']} |",
        f"| Detection rate | {position['detection_rate'] * 100:.1f}% |",
        f"| Position error, median | {fmt(position['position_error_m']['median'])} m |",
        f"| Position error, p95 | {fmt(position['position_error_m']['p95'])} m |",
        f"| Lat/lon conversion error, p95 | {fmt(position['latlon_error_m']['p95'])} m |",
        f"| Speed error, median | {fmt(tracking['speed_error_mps']['median'])} m/s |",
        f"| Direction error, median | {fmt(tracking['direction_error_deg']['median'])}° |",
        f"| Length estimate | {fmt(length['estimated_m'])} m vs {fmt(length['expected_m'])} m |",
        f"| Rejected-noise confidence | {fmt(report['rejection']['confidence'])} |",
        "",
        "## Complete state example",
        "",
    ]
    if complete is None:
        lines.append("No event contained all five state values in this run.")
    else:
        lines.extend(
            [
                f"- Latitude: {complete['latitude']}",
                f"- Longitude: {complete['longitude']}",
                f"- Speed: {complete['speed_mps']:.2f} m/s",
                f"- Length: {complete['length_m']:.2f} m ({complete['length_kind']})",
                f"- Direction: {complete['direction_deg_from_east']:.2f}° from east",
                f"- Source: {complete['source']}",
                "",
                "The length is provisional while the train is still acoustically "
                "present; it becomes stable after the acoustic field clears.",
            ]
        )
    lines.extend(
        [
            "",
            "## What this does not prove",
            "",
            "- It does not prove accuracy with a physical microphone array.",
            "- It does not cover multiple overlapping trains or field noise such "
            "as wind, traffic, and rain.",
            "- It does not establish customer demand, pricing, or a paid pilot.",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PROJECT_ROOT / "artifacts" / "acoustic-validation",
        help="directory for JSON and Markdown reports",
    )
    args = parser.parse_args()
    report = make_report()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (args.output_dir / "report.md").write_text(markdown_report(report))
    print(markdown_report(report))
    print(f"Wrote {args.output_dir / 'report.json'}")
    print(f"Wrote {args.output_dir / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
