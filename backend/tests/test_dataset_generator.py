import json
import bisect
import math

import pyarrow.dataset as ds
import pyarrow.parquet as pq

from backend.config import settings
from backend.coordinates import CoordinateSystem
from backend.dataset_generator import GeneratorConfig, generate_dataset


def test_small_dataset_and_replay_reconstruction(tmp_path):
    output = tmp_path / "dataset"
    config = GeneratorConfig(
        run_count=2,
        duration_s=8.0,
        sampling_rate_hz=2.0,
        seed=12345,
        batch_size=5,
        output_dir=output,
        prediction_horizons_s=(1.0, 3.0),
        measurement_noise_m=2.0,
        min_route_length_m=1500.0,
        desktop_notification=False,
    )
    summary = generate_dataset(config)
    manifest = json.loads((output / "manifest.json").read_text())
    observations = ds.dataset(output / "observations", format="parquet").to_table()
    labels = ds.dataset(output / "labels", format="parquet").to_table()
    routes = pq.read_table(output / "routes.parquet").to_pylist()
    runs = pq.read_table(output / "replay_metadata.parquet").to_pylist()

    assert summary["run_count"] == 2
    assert observations.num_rows == labels.num_rows == 34
    assert manifest["master_seed"] == 12345
    assert len(manifest["run_seeds"]) == 2
    assert all(route["route_length_m"] > 800 for route in routes)
    assert all(len(route["directed_edge_ids"]) > 0 for route in routes)
    assert all(run["wagon_count"] == 5 for run in runs)
    assert observations.column("measured_local_x_m").null_count == 0
    assert "destination_node_id" not in observations.column_names
    assert "planned_directed_edge_ids" not in observations.column_names
    assert "actual_branch_edge_id" not in observations.column_names

    coordinate_system = CoordinateSystem(settings.center_lat, settings.center_lon)
    route_by_id = {route["route_id"]: route for route in routes}
    final_rows = {}
    for row in observations.select(["run_id", "route_id", "simulation_time_s", "distance_along_route_m", "local_x_m", "local_z_m"]).to_pylist():
        if row["run_id"] not in final_rows or row["simulation_time_s"] > final_rows[row["run_id"]]["simulation_time_s"]:
            final_rows[row["run_id"]] = row
    for run in runs:
        row = final_rows[run["run_id"]]
        geometry = route_by_id[row["route_id"]]["geometry"]
        distances = [point["distance_along_route_m"] for point in geometry]
        assert distances == sorted(distances)
        for vehicle_index, offset in enumerate(run["vehicle_offsets_m"]):
            target = max(0.0, row["distance_along_route_m"] - offset)
            assert 0 <= target <= distances[-1]
            index = min(max(bisect.bisect_right(distances, target) - 1, 0), len(geometry) - 2)
            first, second = geometry[index], geometry[index + 1]
            span = distances[index + 1] - distances[index]
            ratio = 0.0 if span == 0 else (target - distances[index]) / span
            x = first["local_x_m"] + (second["local_x_m"] - first["local_x_m"]) * ratio
            z = first["local_z_m"] + (second["local_z_m"] - first["local_z_m"]) * ratio
            longitude, latitude = coordinate_system.scene_to_wgs(x, z)
            assert math.isfinite(latitude) and math.isfinite(longitude)
            if vehicle_index == 0:
                assert math.isclose(x, row["local_x_m"], abs_tol=1e-6)
                assert math.isclose(z, row["local_z_m"], abs_tol=1e-6)


def test_generation_is_reproducible_except_manifest_clock(tmp_path):
    def make_config(output):
        return GeneratorConfig(1, 4.0, 2.0, 77, 100, output, (1.0,), 0.0, 1200.0, False)

    first = tmp_path / "first"
    second = tmp_path / "second"
    generate_dataset(make_config(first))
    generate_dataset(make_config(second))
    assert ds.dataset(first / "observations", format="parquet").to_table().equals(
        ds.dataset(second / "observations", format="parquet").to_table()
    )
    assert ds.dataset(first / "labels", format="parquet").to_table().equals(
        ds.dataset(second / "labels", format="parquet").to_table()
    )
