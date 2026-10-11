from collections import defaultdict
from dataclasses import dataclass
import heapq
import json
import math
from typing import Optional

from shapely.geometry import LineString, Point, shape
from shapely.ops import substring

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
    route_start_wgs = (-81.03289988338747, 33.98918866218069)
    route_end_wgs = (-81.02246011939191, 33.99336818146877)

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
        self.route_nodes, self.route_edges, self.route_points_utm = self._select_requested_route()
        self.route_length_m = _length(self.route_points_utm)
        self.route_start_distance_m = 0.0

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

    def _path_between_nodes(self, start: int, end: int) -> Optional[tuple[list[int], list[str], float]]:
        if start == end:
            return [start], [], 0.0
        component = self._component(start)
        if end not in component:
            return None
        distances, previous = self._dijkstra(start, component)
        nodes = [end]
        edge_ids = []
        while nodes[-1] != start:
            parent, edge_id = previous[nodes[-1]]
            nodes.append(parent)
            edge_ids.append(edge_id)
        return list(reversed(nodes)), list(reversed(edge_ids)), distances[end]

    @staticmethod
    def _edge_section(edge: Edge, start_m: float, end_m: float) -> list[tuple[float, float]]:
        section = substring(LineString(edge.points), start_m, end_m)
        if section.geom_type == "Point":
            return [tuple(section.coords[0])]
        return [tuple(point) for point in section.coords]

    def _select_requested_route(self) -> tuple[list[int], list[str], list[tuple[float, float]]]:
        """Snap the requested endpoints to the nearest mutually connected rails."""
        start = Point(self.coordinates.wgs_to_utm(*self.route_start_wgs))
        end = Point(self.coordinates.wgs_to_utm(*self.route_end_wgs))

        def candidates(point: Point):
            values = []
            for edge in self.edges.values():
                line = LineString(edge.points)
                values.append((line.distance(point), line.project(point), edge))
            return sorted(values, key=lambda value: value[0])[:12]

        choices = []
        for start_snap, start_projection, start_edge in candidates(start):
            for end_snap, end_projection, end_edge in candidates(end):
                for start_node, start_endpoint_m in ((start_edge.start, 0.0), (start_edge.end, start_edge.length_m)):
                    for end_node, end_endpoint_m in ((end_edge.start, 0.0), (end_edge.end, end_edge.length_m)):
                        middle = self._path_between_nodes(start_node, end_node)
                        if middle is None:
                            continue
                        middle_nodes, middle_edges, middle_length = middle
                        route_length = abs(start_projection - start_endpoint_m) + middle_length + abs(end_projection - end_endpoint_m)
                        if route_length < 50:
                            continue
                        choices.append((
                            start_snap + end_snap,
                            route_length,
                            start_projection,
                            start_endpoint_m,
                            start_edge,
                            end_projection,
                            end_endpoint_m,
                            end_edge,
                            middle_nodes,
                            middle_edges,
                        ))
        if not choices:
            raise RuntimeError("requested train endpoints do not share a connected railroad route")
        (
            _, _, start_projection, start_endpoint_m, start_edge,
            end_projection, end_endpoint_m, end_edge, middle_nodes, middle_edges,
        ) = min(choices, key=lambda value: (value[0], value[1]))

        pieces = [self._edge_section(start_edge, start_projection, start_endpoint_m)]
        for index, edge_id in enumerate(middle_edges):
            edge = self.edges[edge_id]
            pieces.append(edge.points if edge.start == middle_nodes[index] else list(reversed(edge.points)))
        pieces.append(self._edge_section(end_edge, end_endpoint_m, end_projection))

        points: list[tuple[float, float]] = []
        for piece in pieces:
            if not piece:
                continue
            if points and math.dist(points[-1], piece[0]) <= self.join_tolerance_m:
                piece = piece[1:]
            points.extend(piece)
        edge_ids = [start_edge.edge_id, *middle_edges, end_edge.edge_id]
        edge_ids = [edge_id for index, edge_id in enumerate(edge_ids) if index == 0 or edge_id != edge_ids[index - 1]]
        return middle_nodes, edge_ids, points

    def _assemble_route(self) -> list[tuple[float, float]]:
        points: list[tuple[float, float]] = []
        for index, edge_id in enumerate(self.route_edges):
            edge = self.edges[edge_id]
            segment = edge.points if edge.start == self.route_nodes[index] else list(reversed(edge.points))
            if points and math.dist(points[-1], segment[0]) <= self.join_tolerance_m:
                segment = segment[1:]
            points.extend(segment)
        return points

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

    def scene_rotation_at(self, longitude: float, latitude: float) -> float:
        """Return the scene yaw of the rail segment nearest a WGS84 point."""
        reference = Point(self.coordinates.wgs_to_utm(longitude, latitude))
        _, first, second = min(
            (
                LineString([first, second]).distance(reference),
                first,
                second,
            )
            for edge in self.edges.values()
            for first, second in zip(edge.points, edge.points[1:])
        )
        return math.atan2(second[0] - first[0], -(second[1] - first[1]))

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
                "id": "usc-engineering-demo-corridor",
                "length_m": self.route_length_m,
                "source_edge_ids": self.route_edges,
                "selection": "Requested USC-area endpoints snapped to the nearest mutually connected SCDOT rails.",
                "requested_start": {"longitude": self.route_start_wgs[0], "latitude": self.route_start_wgs[1]},
                "requested_end": {"longitude": self.route_end_wgs[0], "latitude": self.route_end_wgs[1]},
                "points": [self.coordinates.utm_to_scene(*point) for point in self.route_points_utm],
            },
            "landmarks": [
                {
                    "id": "usc-college-engineering-computing",
                    "name": "USC College of Engineering and Computing",
                    "latitude": 33.98955201735446,
                    "longitude": -81.02929284552975,
                    "position": self.coordinates.wgs_to_scene(-81.02929284552975, 33.98955201735446),
                    "dimensions_m": [92.0, 22.0, 68.0],
                    "rotation_y_rad": self.scene_rotation_at(-81.02929284552975, 33.98955201735446),
                }
            ],
            "audio_trackers": [
                {
                    "id": tracker_id,
                    "latitude": latitude,
                    "longitude": longitude,
                    "position": self.coordinates.wgs_to_scene(longitude, latitude),
                }
                for tracker_id, latitude, longitude in (
                    ("mic-1", 33.99163558377776, -81.02947126852062),
                    ("mic-2", 33.99001253170513, -81.02976900004801),
                    ("mic-3", 33.99000959154903, -81.02757827270213),
                )
            ],
            "microphone_markers": [
                {
                    "id": f"microphone-{index}",
                    "label": f"Microphone {index}",
                    "latitude": latitude,
                    "longitude": longitude,
                    "position": self.coordinates.wgs_to_scene(longitude, latitude),
                }
                for index, (latitude, longitude) in enumerate((
                    (33.98721528133955, -81.0386527620951),
                    (33.986272305778336, -81.03730092883272),
                    (33.986450226496366, -81.0394788824221),
                    (33.991503019432336, -81.03947888242146),
                    (33.99248151854065, -81.03797684546328),
                    (33.99247262314496, -81.03992949350892),
                    (33.998397193068165, -81.04078881842322),
                    (33.998708509652744, -81.04297750084804),
                    (33.99996265921107, -81.04115359882671),
                    (33.98807776176246, -81.02681873198692),
                    (33.98816310231779, -81.02486315863109),
                    (33.98684031407964, -81.02598246706503),
                    (33.996483395044216, -81.021312248925),
                    (33.9946487338758, -81.01952392855354),
                    (34.01676271453926, -81.04940364195004),
                    (34.01930500738639, -81.0487656621734),
                    (34.01861351127043, -81.04488870814612),
                    (34.01939336456181, -81.02249280219216),
                    (34.02200811223002, -81.02356220030889),
                    (34.02280581582158, -81.0201935962412),
                    (33.979338528946826, -81.04406592679342),
                    (33.976789651057736, -81.04400604935654),
                    (34.00911125991207, -81.06332459809751),
                    (34.01216137717251, -81.06414050204815),
                    (34.00945606126901, -81.06826801615142),
                    (33.98231315246829, -81.0259966808033),
                    (33.982948698414056, -81.02422687758958),
                    (33.98113449104526, -81.02390636204693),
                    (33.98014070492083, -81.01475076531452),
                    (33.97862689220661, -81.01557295735867),
                    (33.97929713322231, -81.01293915572568),
                    (33.97441039561798, -81.00688351480497),
                    (33.97502054423369, -81.00483889524875),
                    (33.97366536610791, -81.0047769370804),
                ), start=4)
            ],
        }
