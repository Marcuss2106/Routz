"""Rail-constrained future-path prediction from one observable train fix.

The predictor deliberately knows nothing about a train's destination or planned
route. It snaps the fix to the cached rail graph, infers travel direction from
heading, and expands likely branches using local rail tangents.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import json
import math
from pathlib import Path
from typing import Iterable, Mapping, Protocol, Sequence

from .coordinates import CoordinateSystem
from .rail_network import Edge


Point = tuple[float, float]
BranchKey = tuple[int, str]
BranchPriors = Mapping[BranchKey, Mapping[str, float]]


class RailGraph(Protocol):
    nodes: list[Point]
    edges: dict[str, Edge]
    adjacency: dict[int, list[tuple[int, str, float]]]
    coordinates: CoordinateSystem


@dataclass
class SnapshotRailGraph:
    """Minimal graph loaded from a generated dataset's immutable snapshot."""

    nodes: list[Point]
    edges: dict[str, Edge]
    adjacency: dict[int, list[tuple[int, str, float]]]
    coordinates: CoordinateSystem

    @classmethod
    def load(cls, path: Path) -> "SnapshotRailGraph":
        payload = json.loads(path.read_text(encoding="utf-8"))
        origin = payload["coordinate_system"]["origin"]
        coordinates = CoordinateSystem(origin["latitude"], origin["longitude"])
        node_rows = sorted(payload["nodes"], key=lambda row: row["node_id"])
        nodes = [
            (float(row["utm_easting_m"]), float(row["utm_northing_m"]))
            for row in node_rows
        ]
        edges: dict[str, Edge] = {}
        adjacency: dict[int, list[tuple[int, str, float]]] = defaultdict(list)
        for row in payload["edges"]:
            edge = Edge(
                edge_id=row["edge_id"],
                start=int(row["start_node_id"]),
                end=int(row["end_node_id"]),
                points=[
                    (float(point[0]), float(point[1]))
                    for point in row["geometry_utm_m"]
                ],
                length_m=float(row["length_m"]),
                properties=row.get("properties", {}),
            )
            edges[edge.edge_id] = edge
            adjacency[edge.start].append((edge.end, edge.edge_id, edge.length_m))
            adjacency[edge.end].append((edge.start, edge.edge_id, edge.length_m))
        return cls(nodes, edges, dict(adjacency), coordinates)


@dataclass(frozen=True)
class TrainFix:
    latitude_deg: float
    longitude_deg: float
    heading_deg: float
    speed_mps: float


@dataclass(frozen=True)
class PredictedPosition:
    horizon_s: float
    latitude_deg: float
    longitude_deg: float
    local_x_m: float
    local_z_m: float
    track_segment_id: str
    stopped: bool


@dataclass(frozen=True)
class CandidatePath:
    probability: float
    first_switch_id: str | None
    first_branch_edge_id: str | None
    edge_ids: tuple[str, ...]
    geometry_utm_m: tuple[Point, ...]
    positions: tuple[PredictedPosition, ...]


@dataclass(frozen=True)
class PathPrediction:
    snap_distance_m: float
    snapped_edge_id: str
    candidates: tuple[CandidatePath, ...]
    uncertain: bool


@dataclass
class _Snap:
    edge_id: str
    point: Point
    segment_index: int
    ratio: float
    forward: bool
    distance_m: float


@dataclass
class _State:
    points: list[Point]
    cumulative_m: list[float]
    segment_edge_ids: list[str]
    edge_ids: list[str]
    node: int
    incoming_edge_id: str
    probability: float
    first_switch_id: str | None
    first_branch_edge_id: str | None
    visited_directions: frozenset[tuple[str, int]]
    heading_deg: float = 0.0
    complete: bool = False


def angular_difference_deg(first: float, second: float) -> float:
    """Smallest absolute difference between two compass headings."""
    return abs((first - second + 180.0) % 360.0 - 180.0)


def segment_heading_deg(first: Point, second: Point) -> float:
    """Compass heading: clockwise from true north."""
    return (
        math.degrees(math.atan2(second[0] - first[0], second[1] - first[1]))
        + 360.0
    ) % 360.0


def _project(point: Point, first: Point, second: Point) -> tuple[Point, float, float]:
    dx, dy = second[0] - first[0], second[1] - first[1]
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return first, 0.0, math.dist(point, first)
    ratio = min(
        1.0,
        max(0.0, ((point[0] - first[0]) * dx + (point[1] - first[1]) * dy) / length_sq),
    )
    projected = (first[0] + ratio * dx, first[1] + ratio * dy)
    return projected, ratio, math.dist(point, projected)


def snap_fix(network: RailGraph, fix: TrainFix) -> _Snap:
    """Find the closest rail segment, using heading to choose its direction."""
    query = network.coordinates.wgs_to_utm(fix.longitude_deg, fix.latitude_deg)
    best: tuple[float, float, _Snap] | None = None
    for edge_id, edge in network.edges.items():
        for index, (first, second) in enumerate(zip(edge.points, edge.points[1:])):
            projected, ratio, distance = _project(query, first, second)
            forward_heading = segment_heading_deg(first, second)
            forward_error = angular_difference_deg(fix.heading_deg, forward_heading)
            reverse_error = angular_difference_deg(fix.heading_deg, (forward_heading + 180) % 360)
            forward = forward_error <= reverse_error
            heading_error = min(forward_error, reverse_error)
            score = (distance, heading_error)
            snap = _Snap(edge_id, projected, index, ratio, forward, distance)
            if best is None or score < best[:2]:
                best = (distance, heading_error, snap)
    if best is None:
        raise ValueError("rail graph contains no usable segment")
    return best[2]


def _oriented_edge(edge: Edge, from_node: int) -> tuple[list[Point], int]:
    if edge.start == from_node:
        return list(edge.points), edge.end
    if edge.end == from_node:
        return list(reversed(edge.points)), edge.start
    raise ValueError(f"edge {edge.edge_id} is not incident to node {from_node}")


def _append_until(
    state: _State,
    points: Sequence[Point],
    edge_id: str,
    max_distance_m: float,
) -> bool:
    """Append points and return True if max distance was reached mid-edge."""
    for point in points:
        previous = state.points[-1]
        length = math.dist(previous, point)
        if length <= 1e-9:
            continue
        remaining = max_distance_m - state.cumulative_m[-1]
        if length >= remaining:
            ratio = max(0.0, min(1.0, remaining / length))
            final = (
                previous[0] + (point[0] - previous[0]) * ratio,
                previous[1] + (point[1] - previous[1]) * ratio,
            )
            if math.dist(previous, final) > 1e-9:
                state.heading_deg = segment_heading_deg(previous, final)
            state.points.append(final)
            state.cumulative_m.append(max_distance_m)
            state.segment_edge_ids.append(edge_id)
            state.complete = True
            return True
        state.heading_deg = segment_heading_deg(previous, point)
        state.points.append(point)
        state.cumulative_m.append(state.cumulative_m[-1] + length)
        state.segment_edge_ids.append(edge_id)
    return False


def _initial_state(network: RailGraph, snap: _Snap, max_distance_m: float) -> _State:
    edge = network.edges[snap.edge_id]
    if snap.forward:
        remainder = edge.points[snap.segment_index + 1 :]
        node = edge.end
    else:
        remainder = list(reversed(edge.points[: snap.segment_index + 1]))
        node = edge.start
    segment = edge.points[snap.segment_index : snap.segment_index + 2]
    segment_heading = segment_heading_deg(segment[0], segment[1]) if len(segment) == 2 else 0.0
    state = _State(
        heading_deg=segment_heading if snap.forward else (segment_heading + 180.0) % 360.0,
        points=[snap.point],
        cumulative_m=[0.0],
        segment_edge_ids=[],
        edge_ids=[snap.edge_id],
        node=node,
        incoming_edge_id=snap.edge_id,
        probability=1.0,
        first_switch_id=None,
        first_branch_edge_id=None,
        visited_directions=frozenset({(snap.edge_id, node)}),
    )
    if not remainder or not _append_until(state, remainder, snap.edge_id, max_distance_m):
        if state.cumulative_m[-1] >= max_distance_m - 1e-9:
            state.complete = True
    return state


def _copy_state(state: _State) -> _State:
    return _State(
        points=list(state.points),
        cumulative_m=list(state.cumulative_m),
        segment_edge_ids=list(state.segment_edge_ids),
        edge_ids=list(state.edge_ids),
        node=state.node,
        incoming_edge_id=state.incoming_edge_id,
        probability=state.probability,
        first_switch_id=state.first_switch_id,
        first_branch_edge_id=state.first_branch_edge_id,
        visited_directions=state.visited_directions,
        heading_deg=state.heading_deg,
        complete=state.complete,
    )


def _branch_weights(
    node: int,
    incoming_edge_id: str,
    context_edge_id: str,
    incoming_heading: float,
    options: Sequence[tuple[str, list[Point], int]],
    priors: BranchPriors | None,
    turn_temperature_deg: float,
) -> list[float]:
    learned = {}
    if priors:
        learned = (
            priors.get((node, context_edge_id))
            or priors.get((node, incoming_edge_id))
            or priors.get((node, "*"))
            or {}
        )
    weights = []
    for edge_id, points, _ in options:
        outgoing_heading = segment_heading_deg(points[0], points[1])
        turn = angular_difference_deg(incoming_heading, outgoing_heading)
        tangent_weight = math.exp(-turn / max(1.0, turn_temperature_deg))
        prior = max(0.0, learned.get(edge_id, 0.0))
        weights.append(tangent_weight if not learned else 0.2 * tangent_weight + 0.8 * prior)
    total = sum(weights)
    return [weight / total for weight in weights] if total else [1 / len(weights)] * len(weights)


def _sample_state(
    network: RailGraph,
    state: _State,
    horizon_s: float,
    speed_mps: float,
) -> PredictedPosition:
    target = min(max(0.0, speed_mps * horizon_s), state.cumulative_m[-1])
    index = 0
    while index + 1 < len(state.cumulative_m) and state.cumulative_m[index + 1] < target:
        index += 1
    first, second = state.points[index], state.points[min(index + 1, len(state.points) - 1)]
    start_m = state.cumulative_m[index]
    end_m = state.cumulative_m[min(index + 1, len(state.cumulative_m) - 1)]
    ratio = 0.0 if end_m == start_m else (target - start_m) / (end_m - start_m)
    east = first[0] + (second[0] - first[0]) * ratio
    north = first[1] + (second[1] - first[1]) * ratio
    longitude, latitude = network.coordinates.utm_to_wgs(east, north)
    local_x, _, local_z = network.coordinates.utm_to_scene(east, north)
    segment_edge_id = (
        state.segment_edge_ids[min(index, len(state.segment_edge_ids) - 1)]
        if state.segment_edge_ids
        else state.edge_ids[-1]
    )
    return PredictedPosition(
        horizon_s=horizon_s,
        latitude_deg=latitude,
        longitude_deg=longitude,
        local_x_m=local_x,
        local_z_m=local_z,
        track_segment_id=segment_edge_id,
        stopped=speed_mps < 0.05 or target >= state.cumulative_m[-1] - 1e-6,
    )


def predict_paths(
    network: RailGraph,
    fix: TrainFix,
    horizons_s: Sequence[float] = (5.0, 15.0, 30.0),
    *,
    top_k: int = 3,
    branch_priors: BranchPriors | None = None,
    turn_temperature_deg: float = 35.0,
    max_snap_distance_m: float = 120.0,
) -> PathPrediction:
    """Return likely rail paths without consulting destination or future labels."""
    if not horizons_s or any(horizon < 0 for horizon in horizons_s):
        raise ValueError("horizons must contain nonnegative seconds")
    if fix.speed_mps < 0:
        raise ValueError("speed_mps must be nonnegative")
    if top_k < 1:
        raise ValueError("top_k must be at least 1")

    snap = snap_fix(network, fix)
    if snap.distance_m > max_snap_distance_m:
        raise ValueError(
            f"train fix is {snap.distance_m:.1f} m from rail; maximum is {max_snap_distance_m:.1f} m"
        )
    max_distance_m = max(horizons_s) * fix.speed_mps
    # Retain a tiny path so stopped trains still get a segment and coordinates.
    rollout_distance_m = max(max_distance_m, 0.01)
    active = [_initial_state(network, snap, rollout_distance_m)]
    finished: list[_State] = []

    while active:
        next_active: list[_State] = []
        for state in active:
            if state.complete:
                finished.append(state)
                continue
            options: list[tuple[str, list[Point], int]] = []
            for neighbor, edge_id, _ in network.adjacency[state.node]:
                if edge_id == state.incoming_edge_id:
                    continue
                direction = (edge_id, neighbor)
                if direction in state.visited_directions:
                    continue
                points, destination = _oriented_edge(network.edges[edge_id], state.node)
                if len(points) >= 2:
                    options.append((edge_id, points, destination))
            if not options:
                state.complete = True
                finished.append(state)
                continue

            incoming_heading = state.heading_deg
            weights = _branch_weights(
                state.node,
                state.incoming_edge_id,
                snap.edge_id,
                incoming_heading,
                options,
                branch_priors,
                turn_temperature_deg,
            )
            is_switch = len(network.adjacency[state.node]) >= 3
            for (edge_id, points, destination), weight in zip(options, weights):
                child = _copy_state(state)
                child.probability *= weight
                child.edge_ids.append(edge_id)
                if is_switch and child.first_branch_edge_id is None:
                    child.first_switch_id = f"node-{state.node}"
                    child.first_branch_edge_id = edge_id
                child.incoming_edge_id = edge_id
                child.node = destination
                child.visited_directions = child.visited_directions | {(edge_id, destination)}
                reached = _append_until(child, points[1:], edge_id, rollout_distance_m)
                if reached:
                    finished.append(child)
                else:
                    next_active.append(child)
        active = sorted(next_active, key=lambda item: item.probability, reverse=True)[: top_k * 4]

    ranked = sorted(finished, key=lambda item: item.probability, reverse=True)[:top_k]
    total_probability = sum(state.probability for state in ranked) or 1.0
    candidates = tuple(
        CandidatePath(
            probability=state.probability / total_probability,
            first_switch_id=state.first_switch_id,
            first_branch_edge_id=state.first_branch_edge_id,
            edge_ids=tuple(state.edge_ids),
            geometry_utm_m=tuple(state.points),
            positions=tuple(
                _sample_state(network, state, horizon, fix.speed_mps)
                for horizon in horizons_s
            ),
        )
        for state in ranked
    )
    return PathPrediction(
        snap_distance_m=snap.distance_m,
        snapped_edge_id=snap.edge_id,
        candidates=candidates,
        uncertain=fix.speed_mps < 0.05 or len(candidates) > 1,
    )


def fit_branch_priors(
    rows: Iterable[Mapping[str, object]],
    *,
    smoothing: float = 1.0,
) -> dict[BranchKey, dict[str, float]]:
    """Fit simple per-switch branch frequencies from training runs only."""
    counts: dict[BranchKey, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for row in rows:
        switch_id = row.get("upcoming_switch_id")
        incoming_edge = row.get("track_segment_id")
        branch = row.get("actual_branch_edge_id")
        if not isinstance(switch_id, str) or not switch_id.startswith("node-"):
            continue
        if not isinstance(incoming_edge, str) or not isinstance(branch, str):
            continue
        try:
            node = int(switch_id.removeprefix("node-"))
        except ValueError:
            continue
        counts[(node, incoming_edge)][branch] += 1.0
        counts[(node, "*")][branch] += 1.0

    result: dict[BranchKey, dict[str, float]] = {}
    for key, branches in counts.items():
        total = sum(value + smoothing for value in branches.values())
        result[key] = {
            branch: (value + smoothing) / total for branch, value in branches.items()
        }
    return result
