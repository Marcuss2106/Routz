"""Deterministic, headless railroad journey dataset generator.

This module intentionally does not import the FastAPI application or live
TrainSimulation. It loads the same cached rail graph, then runs independent
offline journeys as quickly as the CPU can produce them.
"""

import argparse
import bisect
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import random
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import pyarrow as pa
import pyarrow.parquet as pq

from .config import settings
from .coordinates import CoordinateSystem
from .rail_network import RailNetwork


SCHEMA_VERSION = "1.0.0"
GENERATOR_VERSION = "1.0.0"
DEFAULT_HORIZONS_S = (5.0, 15.0, 30.0)


@dataclass(frozen=True)
class GeneratorConfig:
    run_count: int
    duration_s: float
    sampling_rate_hz: float
    seed: int
    batch_size: int
    output_dir: Path
    prediction_horizons_s: Tuple[float, ...]
    measurement_noise_m: float
    min_route_length_m: float
    desktop_notification: bool


@dataclass(frozen=True)
class TrainSpec:
    train_length_m: float = 210.0
    wagon_count: int = 5
    locomotive_length_m: float = 12.0
    wagon_length_m: float = 10.0
    vehicle_width_m: float = 4.5
    vehicle_height_m: float = 5.1
    coupling_spacing_m: float = 2.0
    vehicle_offsets_m: Tuple[float, ...] = (0.0, 44.0, 80.0, 116.0, 152.0, 188.0)


@dataclass
class RouteGeometry:
    route_id: str
    start_node: int
    destination_node: int
    directed_edge_ids: List[str]
    directed_node_ids: List[int]
    points: List[Tuple[float, float]]
    point_edge_ids: List[str]
    cumulative_m: List[float]
    switch_events: List[Dict[str, Any]]

    @property
    def length_m(self) -> float:
        return self.cumulative_m[-1]


OBSERVATION_SCHEMA = pa.schema([
    pa.field("run_id", pa.string(), nullable=False),
    pa.field("train_id", pa.string(), nullable=False),
    pa.field("route_id", pa.string(), nullable=False),
    pa.field("simulation_time_s", pa.float64(), nullable=False),
    pa.field("timestamp_utc_ns", pa.int64(), nullable=False),
    pa.field("latitude_deg", pa.float64(), nullable=False),
    pa.field("longitude_deg", pa.float64(), nullable=False),
    pa.field("local_x_m", pa.float64(), nullable=False),
    pa.field("local_y_m", pa.float64(), nullable=False),
    pa.field("local_z_m", pa.float64(), nullable=False),
    pa.field("track_segment_id", pa.string(), nullable=False),
    pa.field("distance_along_route_m", pa.float64(), nullable=False),
    pa.field("speed_mps", pa.float64(), nullable=False),
    pa.field("acceleration_mps2", pa.float64(), nullable=False),
    pa.field("heading_deg", pa.float64(), nullable=False),
    pa.field("stopped", pa.bool_(), nullable=False),
    pa.field("measured_latitude_deg", pa.float64()),
    pa.field("measured_longitude_deg", pa.float64()),
    pa.field("measured_local_x_m", pa.float64()),
    pa.field("measured_local_z_m", pa.float64()),
    pa.field("measured_speed_mps", pa.float64()),
    pa.field("measured_heading_deg", pa.float64()),
])

FUTURE_POSITION_TYPE = pa.struct([
    pa.field("horizon_s", pa.float64(), nullable=False),
    pa.field("available", pa.bool_(), nullable=False),
    pa.field("simulation_time_s", pa.float64()),
    pa.field("distance_along_route_m", pa.float64()),
    pa.field("latitude_deg", pa.float64()),
    pa.field("longitude_deg", pa.float64()),
    pa.field("local_x_m", pa.float64()),
    pa.field("local_z_m", pa.float64()),
    pa.field("track_segment_id", pa.string()),
])

LABEL_SCHEMA = pa.schema([
    pa.field("run_id", pa.string(), nullable=False),
    pa.field("train_id", pa.string(), nullable=False),
    pa.field("simulation_time_s", pa.float64(), nullable=False),
    pa.field("upcoming_switch_id", pa.string()),
    pa.field("distance_to_upcoming_switch_m", pa.float64()),
    pa.field("actual_branch_edge_id", pa.string()),
    pa.field("future_positions", pa.list_(FUTURE_POSITION_TYPE), nullable=False),
])

ROUTE_POINT_TYPE = pa.struct([
    pa.field("sequence", pa.int32(), nullable=False),
    pa.field("utm_easting_m", pa.float64(), nullable=False),
    pa.field("utm_northing_m", pa.float64(), nullable=False),
    pa.field("local_x_m", pa.float64(), nullable=False),
    pa.field("local_z_m", pa.float64(), nullable=False),
    pa.field("distance_along_route_m", pa.float64(), nullable=False),
])

ROUTE_SCHEMA = pa.schema([
    pa.field("route_id", pa.string(), nullable=False),
    pa.field("start_node_id", pa.int64(), nullable=False),
    pa.field("destination_node_id", pa.int64(), nullable=False),
    pa.field("route_length_m", pa.float64(), nullable=False),
    pa.field("directed_node_ids", pa.list_(pa.int64()), nullable=False),
    pa.field("directed_edge_ids", pa.list_(pa.string()), nullable=False),
    pa.field("geometry", pa.list_(ROUTE_POINT_TYPE), nullable=False),
])

RUN_SCHEMA = pa.schema([
    pa.field("run_id", pa.string(), nullable=False),
    pa.field("train_id", pa.string(), nullable=False),
    pa.field("route_id", pa.string(), nullable=False),
    pa.field("run_seed", pa.uint64(), nullable=False),
    pa.field("departure_time_utc_ns", pa.int64(), nullable=False),
    pa.field("duration_s", pa.float64(), nullable=False),
    pa.field("sampling_rate_hz", pa.float64(), nullable=False),
    pa.field("initial_distance_along_route_m", pa.float64(), nullable=False),
    pa.field("initial_speed_mps", pa.float64(), nullable=False),
    pa.field("destination_node_id", pa.int64(), nullable=False),
    pa.field("planned_directed_edge_ids", pa.list_(pa.string()), nullable=False),
    pa.field("train_length_m", pa.float64(), nullable=False),
    pa.field("wagon_count", pa.int32(), nullable=False),
    pa.field("locomotive_length_m", pa.float64(), nullable=False),
    pa.field("wagon_length_m", pa.float64(), nullable=False),
    pa.field("vehicle_width_m", pa.float64(), nullable=False),
    pa.field("vehicle_height_m", pa.float64(), nullable=False),
    pa.field("coupling_spacing_m", pa.float64(), nullable=False),
    pa.field("vehicle_offsets_m", pa.list_(pa.float64()), nullable=False),
    pa.field("max_acceleration_mps2", pa.float64(), nullable=False),
    pa.field("max_braking_mps2", pa.float64(), nullable=False),
])


def _largest_component(network: RailNetwork) -> List[int]:
    unseen = set(network.adjacency)
    components = []
    while unseen:
        component = network._component(next(iter(unseen)))
        components.append(component)
        unseen -= component
    return sorted(max(components, key=lambda value: sum(network.edges[e].length_m for node in value for _, e, _ in network.adjacency[node]) / 2))


def _path_between(network: RailNetwork, start: int, destination: int) -> Optional[Tuple[List[int], List[str], float]]:
    component = network._component(start)
    distances, previous = network._dijkstra(start, component)
    if destination not in distances:
        return None
    nodes = [destination]
    edges = []
    while nodes[-1] != start:
        parent, edge_id = previous[nodes[-1]]
        nodes.append(parent)
        edges.append(edge_id)
    return list(reversed(nodes)), list(reversed(edges)), distances[destination]


def choose_route(network: RailNetwork, rng: random.Random, min_length_m: float, route_id: str) -> RouteGeometry:
    nodes = _largest_component(network)
    candidates = []
    for _ in range(240):
        start, destination = rng.sample(nodes, 2)
        result = _path_between(network, start, destination)
        if result is None:
            continue
        path_nodes, path_edges, length = result
        candidates.append((length, path_nodes, path_edges))
        if length >= min_length_m and rng.random() < 0.35:
            break
    valid = [item for item in candidates if item[0] >= min_length_m]
    length, path_nodes, path_edges = rng.choice(valid) if valid else max(candidates, key=lambda item: item[0])
    if length <= 800:
        raise RuntimeError("rail graph does not contain a route longer than the live demo corridor")
    return assemble_route(network, path_nodes, path_edges, route_id)


def assemble_route(network: RailNetwork, nodes: List[int], edge_ids: List[str], route_id: str) -> RouteGeometry:
    points: List[Tuple[float, float]] = []
    point_edge_ids: List[str] = []
    cumulative = [0.0]
    switch_events = []
    for index, edge_id in enumerate(edge_ids):
        edge = network.edges[edge_id]
        segment = edge.points if edge.start == nodes[index] else list(reversed(edge.points))
        if points and math.dist(points[-1], segment[0]) <= network.join_tolerance_m:
            segment = [points[-1]] + segment[1:]
        if not points:
            points.append(segment[0])
        for point in segment[1:]:
            cumulative.append(cumulative[-1] + math.dist(points[-1], point))
            points.append(point)
            point_edge_ids.append(edge_id)
        next_node = nodes[index + 1]
        if len(network.adjacency[next_node]) >= 3 and index + 1 < len(edge_ids):
            switch_events.append({
                "switch_id": f"node-{next_node}",
                "distance_m": cumulative[-1],
                "branch_edge_id": edge_ids[index + 1],
            })
    if len(point_edge_ids) != len(points) - 1:
        raise RuntimeError("route segment metadata is not aligned with geometry")
    return RouteGeometry(route_id, nodes[0], nodes[-1], edge_ids, nodes, points, point_edge_ids, cumulative, switch_events)


def sample_route(route: RouteGeometry, distance_m: float, coordinates: CoordinateSystem) -> Dict[str, Any]:
    target = min(max(distance_m, 0.0), route.length_m)
    index = min(max(bisect.bisect_right(route.cumulative_m, target) - 1, 0), len(route.points) - 2)
    first, second = route.points[index], route.points[index + 1]
    start_m, end_m = route.cumulative_m[index], route.cumulative_m[index + 1]
    ratio = 0.0 if end_m == start_m else (target - start_m) / (end_m - start_m)
    east = first[0] + (second[0] - first[0]) * ratio
    north = first[1] + (second[1] - first[1]) * ratio
    longitude, latitude = coordinates.utm_to_wgs(east, north)
    local_x, local_y, local_z = coordinates.utm_to_scene(east, north)
    heading = (math.degrees(math.atan2(second[0] - first[0], second[1] - first[1])) + 360) % 360
    return {
        "latitude_deg": latitude,
        "longitude_deg": longitude,
        "local_x_m": local_x,
        "local_y_m": local_y,
        "local_z_m": local_z,
        "track_segment_id": route.point_edge_ids[index],
        "distance_along_route_m": target,
        "heading_deg": heading,
    }


def reconstruct_vehicle_positions(route: RouteGeometry, locomotive_distance_m: float, vehicle_offsets_m: Sequence[float], coordinates: CoordinateSystem) -> List[Dict[str, Any]]:
    return [sample_route(route, locomotive_distance_m - offset, coordinates) for offset in vehicle_offsets_m]


def _motion_series(config: GeneratorConfig, route: RouteGeometry, rng: random.Random, train: TrainSpec) -> List[Dict[str, float]]:
    dt = 1.0 / config.sampling_rate_hz
    sample_count = int(math.floor(config.duration_s * config.sampling_rate_hz)) + 1
    initial_distance = min(train.train_length_m, route.length_m * 0.1)
    distance = initial_distance
    max_accel = rng.uniform(0.25, 0.65)
    max_brake = rng.uniform(0.45, 1.0)
    cruise_target = rng.uniform(9.0, 24.0)
    next_change_s = rng.uniform(8.0, 24.0)
    departure_delay_s = rng.uniform(2.0, min(12.0, max(2.0, config.duration_s * 0.12))) if config.duration_s >= 20 and rng.random() < 0.45 else 0.0
    speed = 0.0 if departure_delay_s > 0 else rng.uniform(5.0, 17.0)
    stops = []
    if config.duration_s >= 30:
        for _ in range(rng.randint(0, min(3, max(1, int(config.duration_s // 90) + 1)))):
            start = rng.uniform(config.duration_s * 0.2, config.duration_s * 0.78)
            # The interval includes braking plus dwell time, making genuine
            # zero-speed samples likely instead of merely slowing the train.
            stops.append((start, min(config.duration_s, start + rng.uniform(20.0, 45.0))))
    series = []
    previous_speed = speed
    for index in range(sample_count):
        simulation_time = index * dt
        in_stop = simulation_time < departure_delay_s or any(start <= simulation_time <= end for start, end in stops)
        if simulation_time >= next_change_s:
            cruise_target = rng.uniform(7.0, 27.0)
            next_change_s += rng.uniform(8.0, 28.0)
        target_speed = 0.0 if in_stop else cruise_target
        requested_accel = (target_speed - speed) / dt
        acceleration = max(-max_brake, min(max_accel, requested_accel))
        speed = max(0.0, speed + acceleration * dt)
        if distance >= route.length_m:
            speed = 0.0
            acceleration = min(0.0, (speed - previous_speed) / dt)
        distance = min(route.length_m, distance + speed * dt)
        series.append({
            "simulation_time_s": simulation_time,
            "distance_m": distance,
            "speed_mps": speed,
            "acceleration_mps2": acceleration,
            "stopped": speed < 0.05,
            "max_acceleration_mps2": max_accel,
            "max_braking_mps2": max_brake,
            "initial_speed_mps": series[0]["speed_mps"] if series else speed,
            "initial_distance_m": initial_distance,
        })
        previous_speed = speed
    return series


def _next_switch(route: RouteGeometry, distance_m: float) -> Tuple[Optional[str], Optional[float], Optional[str]]:
    for event in route.switch_events:
        if event["distance_m"] + 1e-6 >= distance_m:
            return event["switch_id"], event["distance_m"] - distance_m, event["branch_edge_id"]
    return None, None, None


def _noisy_measurement(sample: Dict[str, Any], speed_mps: float, noise_m: float, rng: random.Random, coordinates: CoordinateSystem) -> Dict[str, Optional[float]]:
    if noise_m <= 0:
        return {key: None for key in (
            "measured_latitude_deg", "measured_longitude_deg", "measured_local_x_m",
            "measured_local_z_m", "measured_speed_mps", "measured_heading_deg",
        )}
    x = sample["local_x_m"] + rng.gauss(0, noise_m)
    z = sample["local_z_m"] + rng.gauss(0, noise_m)
    longitude, latitude = coordinates.scene_to_wgs(x, z)
    return {
        "measured_latitude_deg": latitude,
        "measured_longitude_deg": longitude,
        "measured_local_x_m": x,
        "measured_local_z_m": z,
        "measured_speed_mps": max(0.0, speed_mps + rng.gauss(0, noise_m * 0.06)),
        "measured_heading_deg": (sample["heading_deg"] + rng.gauss(0, min(12.0, noise_m * 0.35))) % 360,
    }


def generate_run(run_index: int, run_seed: int, config: GeneratorConfig, network: RailNetwork, coordinates: CoordinateSystem, train: TrainSpec) -> Tuple[RouteGeometry, Dict[str, Any], List[Dict[str, Any]], List[Dict[str, Any]]]:
    rng = random.Random(run_seed)
    run_id = f"run-{run_index:06d}-{run_seed:016x}"
    train_id = f"train-{run_index:06d}"
    route = choose_route(network, rng, config.min_route_length_m, f"route-{run_index:06d}-{run_seed:016x}")
    motion = _motion_series(config, route, rng, train)
    base_epoch_s = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()
    departure_s = base_epoch_s + rng.uniform(0, 365 * 24 * 3600)
    observations = []
    labels = []
    for index, state in enumerate(motion):
        sample = sample_route(route, state["distance_m"], coordinates)
        observations.append({
            "run_id": run_id,
            "train_id": train_id,
            "route_id": route.route_id,
            "simulation_time_s": state["simulation_time_s"],
            "timestamp_utc_ns": int((departure_s + state["simulation_time_s"]) * 1_000_000_000),
            **sample,
            "speed_mps": state["speed_mps"],
            "acceleration_mps2": state["acceleration_mps2"],
            "stopped": state["stopped"],
            **_noisy_measurement(sample, state["speed_mps"], config.measurement_noise_m, rng, coordinates),
        })
        switch_id, switch_distance, branch_id = _next_switch(route, state["distance_m"])
        futures = []
        for horizon in config.prediction_horizons_s:
            future_index = index + int(round(horizon * config.sampling_rate_hz))
            if future_index >= len(motion):
                futures.append({"horizon_s": horizon, "available": False})
            else:
                future_state = motion[future_index]
                future = sample_route(route, future_state["distance_m"], coordinates)
                futures.append({
                    "horizon_s": horizon,
                    "available": True,
                    "simulation_time_s": future_state["simulation_time_s"],
                    "distance_along_route_m": future["distance_along_route_m"],
                    "latitude_deg": future["latitude_deg"],
                    "longitude_deg": future["longitude_deg"],
                    "local_x_m": future["local_x_m"],
                    "local_z_m": future["local_z_m"],
                    "track_segment_id": future["track_segment_id"],
                })
        labels.append({
            "run_id": run_id,
            "train_id": train_id,
            "simulation_time_s": state["simulation_time_s"],
            "upcoming_switch_id": switch_id,
            "distance_to_upcoming_switch_m": switch_distance,
            "actual_branch_edge_id": branch_id,
            "future_positions": futures,
        })
    first = motion[0]
    run_metadata = {
        "run_id": run_id,
        "train_id": train_id,
        "route_id": route.route_id,
        "run_seed": run_seed,
        "departure_time_utc_ns": int(departure_s * 1_000_000_000),
        "duration_s": config.duration_s,
        "sampling_rate_hz": config.sampling_rate_hz,
        "initial_distance_along_route_m": first["initial_distance_m"],
        "initial_speed_mps": first["initial_speed_mps"],
        "destination_node_id": route.destination_node,
        "planned_directed_edge_ids": route.directed_edge_ids,
        **asdict(train),
        "vehicle_offsets_m": list(train.vehicle_offsets_m),
        "max_acceleration_mps2": first["max_acceleration_mps2"],
        "max_braking_mps2": first["max_braking_mps2"],
    }
    return route, run_metadata, observations, labels


def _route_row(route: RouteGeometry, coordinates: CoordinateSystem) -> Dict[str, Any]:
    geometry = []
    for index, ((east, north), distance) in enumerate(zip(route.points, route.cumulative_m)):
        x, _, z = coordinates.utm_to_scene(east, north)
        geometry.append({
            "sequence": index,
            "utm_easting_m": east,
            "utm_northing_m": north,
            "local_x_m": x,
            "local_z_m": z,
            "distance_along_route_m": distance,
        })
    return {
        "route_id": route.route_id,
        "start_node_id": route.start_node,
        "destination_node_id": route.destination_node,
        "route_length_m": route.length_m,
        "directed_node_ids": route.directed_node_ids,
        "directed_edge_ids": route.directed_edge_ids,
        "geometry": geometry,
    }


class PartWriter:
    """Bound memory by flushing rows to independent Parquet parts."""

    def __init__(self, schema: pa.Schema, directory: Path, batch_size: int):
        self.schema = schema
        self.directory = directory
        self.batch_size = batch_size
        self.buffer: List[Dict[str, Any]] = []
        self.paths: List[Path] = []
        self.row_count = 0
        directory.mkdir(parents=True, exist_ok=True)

    def append_many(self, rows: Iterable[Dict[str, Any]]) -> None:
        for row in rows:
            self.buffer.append(row)
            if len(self.buffer) >= self.batch_size:
                self.flush()

    def flush(self) -> None:
        if not self.buffer:
            return
        path = self.directory / f"part-{len(self.paths):05d}.parquet"
        pq.write_table(pa.Table.from_pylist(self.buffer, schema=self.schema), path, compression="zstd")
        self.paths.append(path)
        self.row_count += len(self.buffer)
        self.buffer = []


def _schema_manifest(schema: pa.Schema) -> List[Dict[str, Any]]:
    return [{"name": field.name, "type": str(field.type), "nullable": field.nullable} for field in schema]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _network_snapshot(network: RailNetwork, coordinates: CoordinateSystem) -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "rail_data": network.source_metadata,
        "coordinate_system": coordinates.metadata(),
        "topology": {
            "join_tolerance_m": network.join_tolerance_m,
            "node_count": len(network.nodes),
            "edge_count": len(network.edges),
            "policy": "Only source-feature endpoints within tolerance are connected; visual crossings are not.",
        },
        "nodes": [{"node_id": index, "utm_easting_m": point[0], "utm_northing_m": point[1]} for index, point in enumerate(network.nodes)],
        "edges": [{
            "edge_id": edge.edge_id,
            "start_node_id": edge.start,
            "end_node_id": edge.end,
            "length_m": edge.length_m,
            "properties": edge.properties,
            "geometry_utm_m": [[point[0], point[1]] for point in edge.points],
        } for edge in network.edges.values()],
    }


def _notify(title: str, message: str) -> None:
    try:
        if sys.platform == "darwin" and shutil.which("osascript"):
            safe_title = title.replace('"', "'")
            safe_message = message.replace('"', "'")
            subprocess.run(["osascript", "-e", f'display notification "{safe_message}" with title "{safe_title}"'], check=False)
        elif shutil.which("notify-send"):
            subprocess.run(["notify-send", title, message], check=False)
    except OSError:
        pass


def generate_dataset(config: GeneratorConfig) -> Dict[str, Any]:
    started = time.monotonic()
    output = config.output_dir.resolve()
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"output directory is not empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    coordinates = CoordinateSystem(settings.center_lat, settings.center_lon)
    network = RailNetwork(settings.data_path, coordinates)
    train = TrainSpec()
    master_rng = random.Random(config.seed)
    run_seeds = [master_rng.getrandbits(64) for _ in range(config.run_count)]
    route_rows = []
    run_rows = []
    observation_writer = PartWriter(OBSERVATION_SCHEMA, output / "observations", config.batch_size)
    label_writer = PartWriter(LABEL_SCHEMA, output / "labels", config.batch_size)
    for run_index, run_seed in enumerate(run_seeds):
        route, run_row, observations, labels = generate_run(run_index, run_seed, config, network, coordinates, train)
        route_rows.append(_route_row(route, coordinates))
        run_rows.append(run_row)
        observation_writer.append_many(observations)
        label_writer.append_many(labels)
        elapsed = time.monotonic() - started
        completed = run_index + 1
        eta = elapsed / completed * (config.run_count - completed)
        generated_rows = observation_writer.row_count + len(observation_writer.buffer)
        print(f"[{completed:>{len(str(config.run_count))}}/{config.run_count}] rows={generated_rows:,} elapsed={elapsed:.1f}s eta={eta:.1f}s", file=sys.stderr, flush=True)
    observation_writer.flush()
    label_writer.flush()
    observation_count = observation_writer.row_count
    label_count = label_writer.row_count
    routes_path = output / "routes.parquet"
    runs_path = output / "replay_metadata.parquet"
    pq.write_table(pa.Table.from_pylist(route_rows, schema=ROUTE_SCHEMA), routes_path, compression="zstd")
    pq.write_table(pa.Table.from_pylist(run_rows, schema=RUN_SCHEMA), runs_path, compression="zstd")
    snapshot_path = output / "rail_network_snapshot.json"
    snapshot_path.write_text(json.dumps(_network_snapshot(network, coordinates), indent=2), encoding="utf-8")
    elapsed = time.monotonic() - started
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "generator_version": GENERATOR_VERSION,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "generation_settings": {**asdict(config), "output_dir": str(output), "prediction_horizons_s": list(config.prediction_horizons_s)},
        "master_seed": config.seed,
        "run_seeds": run_seeds,
        "run_count": config.run_count,
        "observation_row_count": observation_count,
        "label_row_count": label_count,
        "schemas": {
            "observations": _schema_manifest(OBSERVATION_SCHEMA),
            "labels": _schema_manifest(LABEL_SCHEMA),
            "routes": _schema_manifest(ROUTE_SCHEMA),
            "replay_metadata": _schema_manifest(RUN_SCHEMA),
        },
        "files": {
            "observations": [str(path.relative_to(output)) for path in observation_writer.paths],
            "labels": [str(path.relative_to(output)) for path in label_writer.paths],
            "routes": routes_path.name,
            "replay_metadata": runs_path.name,
            "rail_network_snapshot": snapshot_path.name,
        },
        "rail_data_provenance": {
            "source_metadata": network.source_metadata,
            "cache_path": str(settings.data_path),
            "cache_sha256": _sha256(settings.data_path),
        },
        "coordinate_system": coordinates.metadata(),
        "timestamp_units": {"simulation_time_s": "seconds from run start", "timestamp_utc_ns": "Unix epoch nanoseconds UTC"},
        "elapsed_seconds": elapsed,
    }
    manifest_path = output / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    total_size = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    summary = {
        "output_dir": str(output),
        "manifest": str(manifest_path),
        "run_count": config.run_count,
        "row_count": observation_count,
        "file_size_bytes": total_size,
        "elapsed_seconds": elapsed,
    }
    print("\nDataset generation complete")
    print(json.dumps(summary, indent=2))
    if config.desktop_notification:
        _notify("Routz dataset complete", f"{config.run_count} runs, {observation_count:,} rows")
    return summary


def _positive(value: str) -> float:
    number = float(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return number


def parse_args(argv: Optional[Sequence[str]] = None) -> GeneratorConfig:
    parser = argparse.ArgumentParser(description="Generate offline synthetic train journeys as compressed Parquet.")
    parser.add_argument("--runs", type=int, default=100, help="number of complete journeys")
    parser.add_argument("--duration", type=_positive, default=300.0, help="seconds per journey")
    parser.add_argument("--sampling-rate", type=_positive, default=10.0, help="observations per simulated second")
    parser.add_argument("--seed", type=int, default=20261010, help="master reproducibility seed")
    parser.add_argument("--batch-size", type=int, default=50_000, help="rows per Parquet part")
    parser.add_argument("--output-dir", type=Path, required=True, help="new or empty output directory")
    parser.add_argument("--prediction-horizons", type=str, default=",".join(str(value) for value in DEFAULT_HORIZONS_S), help="comma-separated future horizons in seconds")
    parser.add_argument("--measurement-noise-m", type=float, default=0.0, help="standard deviation of optional local-position noise")
    parser.add_argument("--min-route-length", type=_positive, default=2000.0, help="minimum selected route length in meters")
    parser.add_argument("--desktop-notification", action="store_true", help="notify on completion where supported")
    args = parser.parse_args(argv)
    horizons = tuple(float(value) for value in args.prediction_horizons.split(",") if value.strip())
    if args.runs <= 0 or args.batch_size <= 0 or args.measurement_noise_m < 0 or not horizons or any(value <= 0 for value in horizons):
        parser.error("runs, batch size, and horizons must be positive; measurement noise cannot be negative")
    return GeneratorConfig(args.runs, args.duration, args.sampling_rate, args.seed, args.batch_size, args.output_dir, horizons, args.measurement_noise_m, args.min_route_length, args.desktop_notification)


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        generate_dataset(parse_args(argv))
        return 0
    except KeyboardInterrupt:
        print("Dataset generation cancelled.", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"Dataset generation failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
