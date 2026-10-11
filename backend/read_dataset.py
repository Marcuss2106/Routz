#!/usr/bin/env python3
"""Read Routz dataset samples and replay metadata without training a model."""

import argparse
import bisect
import json
from pathlib import Path

import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.parquet as pq


def sample_geometry(geometry, distance_m):
    distances = [point["distance_along_route_m"] for point in geometry]
    target = min(max(distance_m, 0.0), distances[-1])
    index = min(max(bisect.bisect_right(distances, target) - 1, 0), len(geometry) - 2)
    first, second = geometry[index], geometry[index + 1]
    span = second["distance_along_route_m"] - first["distance_along_route_m"]
    ratio = 0.0 if span == 0 else (target - first["distance_along_route_m"]) / span
    return {
        "local_x_m": first["local_x_m"] + (second["local_x_m"] - first["local_x_m"]) * ratio,
        "local_z_m": first["local_z_m"] + (second["local_z_m"] - first["local_z_m"]) * ratio,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset_dir", type=Path)
    parser.add_argument("--run-id", help="complete run to load; defaults to the first")
    parser.add_argument("--batch-size", type=int, default=5)
    args = parser.parse_args()
    manifest = json.loads((args.dataset_dir / "manifest.json").read_text())
    observations = ds.dataset(args.dataset_dir / "observations", format="parquet")
    columns = ["run_id", "simulation_time_s", "local_x_m", "local_z_m", "speed_mps", "stopped"]
    first_batch = next(iter(observations.scanner(columns=columns, batch_size=args.batch_size).to_batches()))
    print("Selected observation columns:")
    print(json.dumps(first_batch.to_pylist(), indent=2))

    runs = pq.read_table(args.dataset_dir / manifest["files"]["replay_metadata"])
    run_id = args.run_id or runs.column("run_id")[0].as_py()
    selected_run = runs.filter(pc.equal(runs["run_id"], run_id))
    if selected_run.num_rows != 1:
        raise SystemExit(f"run not found: {run_id}")
    run = selected_run.to_pylist()[0]
    complete_run = observations.to_table(filter=pc.field("run_id") == run_id, columns=columns + ["distance_along_route_m"])
    routes = pq.read_table(args.dataset_dir / manifest["files"]["routes"])
    route = routes.filter(pc.equal(routes["route_id"], run["route_id"])).to_pylist()[0]
    last = complete_run.slice(complete_run.num_rows - 1, 1).to_pylist()[0]
    vehicles = [sample_geometry(route["geometry"], last["distance_along_route_m"] - offset) for offset in run["vehicle_offsets_m"]]
    print(f"\nComplete run {run_id}: {complete_run.num_rows} observations")
    print("Replay metadata:")
    print(json.dumps({key: run[key] for key in ("train_id", "route_id", "train_length_m", "wagon_count", "vehicle_offsets_m")}, indent=2))
    print("Reconstructed final locomotive/wagon positions:")
    print(json.dumps(vehicles, indent=2))


if __name__ == "__main__":
    main()
