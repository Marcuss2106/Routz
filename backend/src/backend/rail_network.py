from collections import defaultdict
from dataclasses import dataclass
import heapq
import json
import math

from shapely.geometry import shape

from .coordinates import CoordinateSystem


@dataclass(frozen=True)
class Edge:
    edge_id: str
    start: int
    end: int
    points: list[tuple[float, float]]
    length_m: float
    properties: dict


def _length(points: list[tuple[float, float]]) -> float:
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


class RailNetwork:
    """Endpoint-only topology; crossings are never joined unless SCDOT split them."""

    join_tolerance_m = 2.5
    demo_route_length_m = 800.0

    def __init__(self, path, coordinates: CoordinateSystem):
        self.coordinates = coordinates
        payload = json.loads(path.read_text())
        self.source_metadata = payload["metadata"]
        raw_lines: list[tuple[str, list[tuple[float, float]], dict]] = []
        self.network_lines: list[dict] = []

        for feature_index, feature in enumerate(payload["features"]):
            geometry = shape(feature["geometry"])
            parts = list(geometry.geoms) if geometry.geom_type == "MultiLineString" else [geometry]
            for part_index, part in enumerate(parts):
                utm = [coordinates.wgs_to_utm(lon, lat) for lon, lat in part.coords]
                if len(utm) < 2 or _length(utm) < 0.5:
                    continue
                edge_id = f"rail-{feature.get('id', feature_index)}-{part_index}"
                props = feature.get("properties", {})
                raw_lines.append((edge_id, utm, props))
                self.network_lines.append(
                    {
                        "id": edge_id,
                        "type": props.get("TYPE"),
                        "name": props.get("NAME"),
                        "points": [coordinates.utm_to_scene(*point) for point in utm],
                    }
                )

        endpoints: list[tuple[float, float]] = []
        nodes: list[tuple[float, float]] = []

        def node_for(point: tuple[float, float]) -> int:
            for idx, existing in enumerate(nodes):
                if math.dist(point, existing) <= self.join_tolerance_m:
                    return idx
            nodes.append(point)
            return len(nodes) - 1

        self.edges: dict[str, Edge] = {}
        self.adjacency: dict[int, list[tuple[int, str, float]]] = defaultdict(list)
        for edge_id, points, props in raw_lines:
            start, end = node_for(points[0]), node_for(points[-1])
            length = _length(points)
            edge = Edge(edge_id, start, end, points, length, props)
            self.edges[edge_id] = edge
            self.adjacency[start].append((end, edge_id, length))
            self.adjacency[end].append((start, edge_id, length))
            endpoints.extend((points[0], points[-1]))
        self.nodes = nodes
        self.route_nodes, self.route_edges = self._select_route()
        full_route = self._assemble_route()
        self.route_points_utm = self._trim_for_demo(full_route)
        self.route_length_m = _length(self.route_points_utm)

    def _component(self, seed: int) -> set[int]:
        seen = {seed}
        stack = [seed]
        while stack:
            node = stack.pop()
            for neighbor, _, _ in self.adjacency[node]:
                if neighbor not in seen:
                    seen.add(neighbor)
                    stack.append(neighbor)
        return seen

    def _dijkstra(self, start: int, allowed: set[int]):
        distance = {start: 0.0}
        previous: dict[int, tuple[int, str]] = {}
        heap = [(0.0, start)]
        while heap:
            dist, node = heapq.heappop(heap)
            if dist != distance[node]:
                continue
            for neighbor, edge_id, weight in self.adjacency[node]:
                if neighbor not in allowed:
                    continue
                candidate = dist + weight
                if candidate < distance.get(neighbor, float("inf")):
                    distance[neighbor] = candidate
                    previous[neighbor] = (node, edge_id)
                    heapq.heappush(heap, (candidate, neighbor))
        return distance, previous

    def _select_route(self) -> tuple[list[int], list[str]]:
        unseen = set(self.adjacency)
        components = []
        while unseen:
            component = self._component(next(iter(unseen)))
            components.append(component)
            unseen -= component
        component = max(
            components,
            key=lambda nodes: sum(
                edge.length_m
                for edge in self.edges.values()
                if edge.start in nodes and edge.end in nodes
            ),
        )
        endpoints = [node for node in component if len(self.adjacency[node]) == 1]
        candidates = endpoints or list(component)
        best = (-1.0, candidates[0], candidates[0], {})
        for start in candidates:
            distances, previous = self._dijkstra(start, component)
            end = max(candidates, key=lambda node: distances.get(node, -1.0))
            if distances.get(end, -1.0) > best[0]:
                best = (distances[end], start, end, previous)
        _, start, end, previous = best
        nodes = [end]
        edge_ids = []
        while nodes[-1] != start:
            parent, edge_id = previous[nodes[-1]]
            edge_ids.append(edge_id)
            nodes.append(parent)
        return list(reversed(nodes)), list(reversed(edge_ids))

    def _assemble_route(self) -> list[tuple[float, float]]:
        points: list[tuple[float, float]] = []
        for index, edge_id in enumerate(self.route_edges):
            edge = self.edges[edge_id]
            segment = edge.points if edge.start == self.route_nodes[index] else list(reversed(edge.points))
            if points and math.dist(points[-1], segment[0]) <= self.join_tolerance_m:
                segment = segment[1:]
            points.extend(segment)
        return points

    def _trim_for_demo(
        self, points: list[tuple[float, float]]
    ) -> list[tuple[float, float]]:
        """Keep a short, central corridor while the renderer still shows every rail."""
        cumulative = [0.0]
        for first, second in zip(points, points[1:]):
            cumulative.append(cumulative[-1] + math.dist(first, second))
        if cumulative[-1] <= self.demo_route_length_m:
            return points
        origin = (self.coordinates.origin_easting, self.coordinates.origin_northing)
        nearest_index = min(range(len(points)), key=lambda index: math.dist(points[index], origin))
        center_m = cumulative[nearest_index]
        start_m = min(
            max(0.0, center_m - self.demo_route_length_m / 2),
            cumulative[-1] - self.demo_route_length_m,
        )
        end_m = start_m + self.demo_route_length_m

        def point_at(distance_m: float) -> tuple[float, float]:
            for index, segment_end in enumerate(cumulative[1:]):
                if segment_end >= distance_m:
                    segment_start = cumulative[index]
                    length = segment_end - segment_start
                    ratio = 0.0 if length == 0 else (distance_m - segment_start) / length
                    first, second = points[index], points[index + 1]
                    return (
                        first[0] + (second[0] - first[0]) * ratio,
                        first[1] + (second[1] - first[1]) * ratio,
                    )
            return points[-1]

        trimmed = [point_at(start_m)]
        trimmed.extend(
            point for point, distance in zip(points, cumulative) if start_m < distance < end_m
        )
        trimmed.append(point_at(end_m))
        return trimmed

    def point_at(self, distance_m: float) -> dict:
        target = min(max(distance_m, 0.0), self.route_length_m)
        travelled = 0.0
        for first, second in zip(self.route_points_utm, self.route_points_utm[1:]):
            segment = math.dist(first, second)
            if travelled + segment >= target or second == self.route_points_utm[-1]:
                ratio = 0.0 if segment == 0 else (target - travelled) / segment
                east = first[0] + (second[0] - first[0]) * ratio
                north = first[1] + (second[1] - first[1]) * ratio
                lon, lat = self.coordinates.utm_to_wgs(east, north)
                x, y, z = self.coordinates.utm_to_scene(east, north)
                heading = (math.degrees(math.atan2(second[0] - first[0], second[1] - first[1])) + 360) % 360
                return {
                    "distance_m": target,
                    "latitude": lat,
                    "longitude": lon,
                    "scene": {"x": x, "y": y, "z": z},
                    "heading_deg": heading,
                }
            travelled += segment
        raise RuntimeError("Route has no usable segment")

    def payload(self) -> dict:
        return {
            "source": self.source_metadata,
            "coordinate_system": self.coordinates.metadata(),
            "topology": {
                "join_tolerance_m": self.join_tolerance_m,
                "policy": "Only nearly coincident source-feature endpoints are joined; visual crossings are not.",
            },
            "network": self.network_lines,
            "route": {
                "id": "columbia-audio-demo-corridor",
                "length_m": self.route_length_m,
                "source_edge_ids": self.route_edges,
                "selection": "An 800 m corridor centered near downtown, cut from the substantial connected component.",
                "points": [self.coordinates.utm_to_scene(*point) for point in self.route_points_utm],
            },
        }
