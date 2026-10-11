"""Evaluate rail path prediction against withheld generated-dataset labels."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import hashlib
from itertools import zip_longest
import json
import math
from pathlib import Path
from typing import Iterable, Iterator

import pyarrow.dataset as ds

from .rail_pathfinder import (
    BranchPriors,
    PathPrediction,
    SnapshotRailGraph,
    TrainFix,
    fit_branch_priors,
    predict_paths,
)


OBSERVATION_COLUMNS = [
    "run_id",
    "train_id",
    "simulation_time_s",
    "latitude_deg",
    "longitude_deg",
    "local_x_m",
    "local_z_m",
    "track_segment_id",
    "distance_along_route_m",
    "speed_mps",
    "heading_deg",
    "stopped",
    "measured_latitude_deg",
    "measured_longitude_deg",
    "measured_speed_mps",
    "measured_heading_deg",
]
LABEL_COLUMNS = [
    "run_id",
    "train_id",
    "simulation_time_s",
    "upcoming_switch_id",
    "distance_to_upcoming_switch_m",
    "actual_branch_edge_id",
    "future_positions",
]


def split_for_run(run_id: str) -> str:
    """Stable 70/15/15 split by complete run, never by adjacent rows."""
    bucket = int.from_bytes(hashlib.sha256(run_id.encode()).digest()[:8], "big") % 100
    if bucket < 70:
        return "train"
    if bucket < 85:
        return "validation"
    return "test"


def dataset_rows(dataset_dir: Path) -> Iterator[dict]:
    observations = ds.dataset(dataset_dir / "observations", format="parquet")
    labels = ds.dataset(dataset_dir / "labels", format="parquet")
    observation_rows = (
        row
        for batch in observations.scanner(
            columns=OBSERVATION_COLUMNS, batch_size=8192
        ).to_batches()
        for row in batch.to_pylist()
    )
    label_rows = (
        row
        for batch in labels.scanner(columns=LABEL_COLUMNS, batch_size=8192).to_batches()
        for row in batch.to_pylist()
    )
    for observation, label in zip_longest(observation_rows, label_rows):
        if observation is None or label is None:
            raise ValueError("observation and label row counts differ")
        key = ("run_id", "train_id", "simulation_time_s")
        if any(observation[name] != label[name] for name in key):
            raise ValueError("observation and label rows are not aligned")
        yield {**observation, **label}


@dataclass
class ErrorSummary:
    count: int = 0
    absolute_error_sum_m: float = 0.0
    squared_error_sum_m2: float = 0.0

    def add(self, error_m: float) -> None:
        self.count += 1
        self.absolute_error_sum_m += error_m
        self.squared_error_sum_m2 += error_m * error_m

    def report(self) -> dict:
        if self.count == 0:
            return {"count": 0, "mae_m": None, "rmse_m": None}
        return {
            "count": self.count,
            "mae_m": self.absolute_error_sum_m / self.count,
            "rmse_m": math.sqrt(self.squared_error_sum_m2 / self.count),
        }


@dataclass
class Metrics:
    row_count: int = 0
    rejected_count: int = 0
    branch_count: int = 0
    branch_top1_hits: int = 0
    branch_top2_hits: int = 0
    branch_brier_sum: float = 0.0
    future_errors: dict[float, ErrorSummary] = field(default_factory=dict)
    stopped_errors: dict[float, ErrorSummary] = field(default_factory=dict)

    def report(self) -> dict:
        branch = {
            "count": self.branch_count,
            "top1_accuracy": (
                self.branch_top1_hits / self.branch_count if self.branch_count else None
            ),
            "top2_coverage": (
                self.branch_top2_hits / self.branch_count if self.branch_count else None
            ),
            "brier_score": (
                self.branch_brier_sum / self.branch_count if self.branch_count else None
            ),
        }
        return {
            "rows": self.row_count,
            "rejected_fixes": self.rejected_count,
            "branch": branch,
            "future_position": {
                f"{horizon:g}s": summary.report()
                for horizon, summary in sorted(self.future_errors.items())
            },
            "stopped_future_position": {
                f"{horizon:g}s": summary.report()
                for horizon, summary in sorted(self.stopped_errors.items())
            },
        }


def _fix_for(row: dict, measured: bool) -> TrainFix | None:
    prefix = "measured_" if measured else ""
    latitude = row.get(f"{prefix}latitude_deg")
    longitude = row.get(f"{prefix}longitude_deg")
    speed = row.get(f"{prefix}speed_mps")
    heading = row.get(f"{prefix}heading_deg")
    if not all(isinstance(value, (int, float)) for value in (latitude, longitude, speed, heading)):
        return None
    return TrainFix(float(latitude), float(longitude), float(heading), float(speed))


def _future_map(row: dict) -> dict[float, dict]:
    return {
        float(future["horizon_s"]): future
        for future in row["future_positions"]
        if future.get("available")
    }


def _branch_is_reached(row: dict, futures: dict[float, dict]) -> bool:
    distance = row.get("distance_to_upcoming_switch_m")
    if not isinstance(distance, (int, float)) or not futures:
        return False
    furthest = max(
        float(future["distance_along_route_m"]) for future in futures.values()
    )
    return furthest - float(row["distance_along_route_m"]) > float(distance) + 1e-6


def _branch_probabilities(prediction: PathPrediction) -> dict[str, float]:
    probabilities: dict[str, float] = {}
    for candidate in prediction.candidates:
        if candidate.first_branch_edge_id:
            probabilities[candidate.first_branch_edge_id] = (
                probabilities.get(candidate.first_branch_edge_id, 0.0)
                + candidate.probability
            )
    return probabilities


def _multiclass_brier(probabilities: dict[str, float], actual: str) -> float:
    labels = set(probabilities) | {actual}
    return sum(
        (probabilities.get(label, 0.0) - (1.0 if label == actual else 0.0)) ** 2
        for label in labels
    )


def score_rows(
    graph: SnapshotRailGraph,
    rows: Iterable[dict],
    *,
    split: str,
    measured: bool,
    branch_priors: BranchPriors | None,
    horizons_s: tuple[float, ...],
    max_rows: int,
) -> Metrics:
    metrics = Metrics()
    for row in rows:
        if split_for_run(row["run_id"]) != split:
            continue
        if max_rows and metrics.row_count >= max_rows:
            break
        fix = _fix_for(row, measured)
        if fix is None:
            continue
        metrics.row_count += 1
        try:
            prediction = predict_paths(
                graph,
                fix,
                horizons_s,
                top_k=3,
                branch_priors=branch_priors,
            )
        except ValueError:
            metrics.rejected_count += 1
            continue
        if not prediction.candidates:
            metrics.rejected_count += 1
            continue

        futures = _future_map(row)
        top = prediction.candidates[0]
        predicted_by_horizon = {position.horizon_s: position for position in top.positions}
        for horizon, future in futures.items():
            predicted = predicted_by_horizon.get(horizon)
            if predicted is None:
                continue
            error = math.hypot(
                predicted.local_x_m - float(future["local_x_m"]),
                predicted.local_z_m - float(future["local_z_m"]),
            )
            metrics.future_errors.setdefault(horizon, ErrorSummary()).add(error)
            if row["stopped"]:
                metrics.stopped_errors.setdefault(horizon, ErrorSummary()).add(error)

        actual_branch = row.get("actual_branch_edge_id")
        if isinstance(actual_branch, str) and _branch_is_reached(row, futures):
            metrics.branch_count += 1
            probabilities = _branch_probabilities(prediction)
            ranked = sorted(probabilities, key=probabilities.get, reverse=True)
            metrics.branch_top1_hits += int(bool(ranked) and ranked[0] == actual_branch)
            metrics.branch_top2_hits += int(actual_branch in ranked[:2])
            metrics.branch_brier_sum += _multiclass_brier(probabilities, actual_branch)
    return metrics


def training_branch_rows(dataset_dir: Path) -> Iterator[dict]:
    for row in dataset_rows(dataset_dir):
        if split_for_run(row["run_id"]) == "train":
            yield row


def select_frequency_model(baseline: Metrics, frequency: Metrics) -> bool:
    """Use validation data only; accept better accuracy or safer probabilities."""
    baseline_branch = baseline.report()["branch"]
    frequency_branch = frequency.report()["branch"]
    baseline_accuracy = baseline_branch["top1_accuracy"]
    frequency_accuracy = frequency_branch["top1_accuracy"]
    baseline_brier = baseline_branch["brier_score"]
    frequency_brier = frequency_branch["brier_score"]
    improves_accuracy = (
        baseline_accuracy is not None
        and frequency_accuracy is not None
        and frequency_accuracy > baseline_accuracy + 0.01
    )
    improves_calibration = (
        baseline_brier is not None
        and frequency_brier is not None
        and baseline_brier > 0
        and frequency_brier < baseline_brier * 0.95
        and frequency_accuracy is not None
        and baseline_accuracy is not None
        and frequency_accuracy >= baseline_accuracy
    )
    return improves_accuracy or improves_calibration


def evaluate_dataset(
    dataset_dir: Path,
    *,
    max_rows: int = 50_000,
) -> dict:
    manifest = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))
    horizons_s = tuple(
        float(value)
        for value in manifest["generation_settings"]["prediction_horizons_s"]
    )
    graph = SnapshotRailGraph.load(dataset_dir / "rail_network_snapshot.json")
    priors = fit_branch_priors(training_branch_rows(dataset_dir))

    validation_baseline = score_rows(
        graph,
        dataset_rows(dataset_dir),
        split="validation",
        measured=False,
        branch_priors=None,
        horizons_s=horizons_s,
        max_rows=max_rows,
    )
    validation_frequency = score_rows(
        graph,
        dataset_rows(dataset_dir),
        split="validation",
        measured=False,
        branch_priors=priors,
        horizons_s=horizons_s,
        max_rows=max_rows,
    )
    use_frequency = select_frequency_model(validation_baseline, validation_frequency)

    result = {
        "dataset": str(dataset_dir.resolve()),
        "split_policy": "sha256(run_id), 70% train / 15% validation / 15% test",
        "evaluated_rows_per_split_limit": max_rows or None,
        "learned_branch_prior_keys": len(priors),
        "selection": {
            "selected_model": "frequency_priors" if use_frequency else "heading_baseline",
            "rule": (
                "select frequency priors when validation top-1 improves by >0.01, "
                "or Brier score improves by >=5% without reducing top-1"
            ),
        },
        "validation": {
            "heading_baseline": validation_baseline.report(),
            "frequency_priors": validation_frequency.report(),
        },
        "test": {},
    }
    for name, selected_priors in (
        ("heading_baseline", None),
        ("frequency_priors", priors),
    ):
        result["test"][name] = {
            "truth_inputs": score_rows(
                graph,
                dataset_rows(dataset_dir),
                split="test",
                measured=False,
                branch_priors=selected_priors,
                horizons_s=horizons_s,
                max_rows=max_rows,
            ).report(),
            "measured_inputs": score_rows(
                graph,
                dataset_rows(dataset_dir),
                split="test",
                measured=True,
                branch_priors=selected_priors,
                horizons_s=horizons_s,
                max_rows=max_rows,
            ).report(),
        }
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset_dir", type=Path)
    parser.add_argument(
        "--max-rows",
        type=int,
        default=50_000,
        help="maximum rows per validation/test pass; 0 evaluates all rows",
    )
    parser.add_argument("--output", type=Path, help="optional JSON report path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = evaluate_dataset(args.dataset_dir, max_rows=args.max_rows)
    rendered = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
