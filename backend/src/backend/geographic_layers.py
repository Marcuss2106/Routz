"""Road and ground-level rail crossing layers in the shared scene CRS."""

from __future__ import annotations

import json
import math

from shapely.geometry import LineString, MultiPoint, Point, shape
from shapely.ops import transform
from shapely.strtree import STRtree

from .coordinates import CoordinateSystem
from .rail_network import RailNetwork


MAJOR_ROADS = {"motorway", "trunk", "primary"}
MEDIUM_ROADS = {"secondary", "tertiary"}


def _parts(geometry):
    return list(geometry.geoms) if geometry.geom_type == "MultiLineString" else [geometry]


def _nearest_intersection(intersection, reference: Point) -> Point | None:
    if intersection.is_empty:
        return None
    if intersection.geom_type == "Point":
        return intersection
    if intersection.geom_type == "MultiPoint":
        return min(intersection.geoms, key=reference.distance)
    if intersection.geom_type in {"LineString", "MultiLineString"}:
        return intersection.interpolate(intersection.project(reference))
    points = [geometry for geometry in intersection.geoms if geometry.geom_type == "Point"]
    return min(points, key=reference.distance) if points else None


def _scene_heading(points: list[tuple[float, float]], reference: Point) -> float:
    best = (float("inf"), points[0], points[1])
    for first, second in zip(points, points[1:]):
        distance = LineString([first, second]).distance(reference)
        if distance < best[0]:
            best = (distance, first, second)
    _, first, second = best
    scene_first = (first[0], -first[1])
    scene_second = (second[0], -second[1])
    return math.atan2(scene_second[0] - scene_first[0], scene_second[1] - scene_first[1])


class GeographicLayers:
    """Load cached OSM roads and snap declared level crossings to SCDOT rails."""

    crossing_road_tolerance_m = 12.0
    crossing_rail_tolerance_m = 40.0

    def __init__(self, path, coordinates: CoordinateSystem, rail_network: RailNetwork):
        payload = json.loads(path.read_text())
        self.source_metadata = payload["metadata"]
        self.roads: list[dict] = []
        ground_geometries: list[LineString] = []
        ground_properties: list[dict] = []
        crossing_nodes: list[tuple[str, Point, dict]] = []

        def to_utm(x, y, z=None):
            return coordinates.wgs_to_utm(x, y)

        for feature in payload["features"]:
            properties = feature.get("properties", {})
            geometry = transform(to_utm, shape(feature["geometry"]))
            if properties.get("feature") == "level_crossing":
                crossing_nodes.append((str(feature["id"]), geometry, properties))
                continue
            if properties.get("feature") != "road":
                continue
            for part_index, part in enumerate(_parts(geometry)):
                if len(part.coords) < 2:
                    continue
                road_class = properties.get("highway", "residential")
                category = "major" if road_class in MAJOR_ROADS else "medium" if road_class in MEDIUM_ROADS else "local"
                layer = properties.get("layer")
                try:
                    layer_number = int(str(layer or "0").split(";")[0])
                except ValueError:
                    layer_number = 0
                bridge = properties.get("bridge") not in {None, "no", "false"}
                tunnel = properties.get("tunnel") not in {None, "no", "false"}
                elevation_m = 9.0 if bridge or layer_number > 0 else -2.0 if tunnel or layer_number < 0 else 0.0
                self.roads.append(
                    {
                        "id": f"{feature['id']}-{part_index}",
                        "name": properties.get("name"),
                        "ref": properties.get("ref"),
                        "class": road_class,
                        "category": category,
                        "ground_level": bool(properties.get("ground_level")),
                        "elevation_m": elevation_m,
                        "points": [coordinates.utm_to_scene(*point) for point in part.coords],
                    }
                )
                if properties.get("ground_level"):
                    ground_geometries.append(part)
                    ground_properties.append(properties)

        rail_geometries = [LineString(edge.points) for edge in rail_network.edges.values()]
        road_tree = STRtree(ground_geometries)
        rail_tree = STRtree(rail_geometries)
        self.crossings: list[dict] = []

        for crossing_id, declared, crossing_properties in crossing_nodes:
            road_index = int(road_tree.nearest(declared))
            rail_index = int(rail_tree.nearest(declared))
            road = ground_geometries[road_index]
            rail = rail_geometries[rail_index]
            if declared.distance(road) > self.crossing_road_tolerance_m:
                continue
            if declared.distance(rail) > self.crossing_rail_tolerance_m:
                continue
            crossing_point = _nearest_intersection(road.intersection(rail), declared)
            if crossing_point is None or crossing_point.distance(declared) > self.crossing_rail_tolerance_m:
                crossing_point = rail.interpolate(rail.project(declared))
            road_properties = ground_properties[road_index]
            longitude, latitude = coordinates.utm_to_wgs(crossing_point.x, crossing_point.y)
            self.crossings.append(
                {
                    "id": crossing_id,
                    "name": road_properties.get("name") or road_properties.get("ref") or "Rail crossing",
                    "road_class": road_properties.get("highway"),
                    "position": coordinates.utm_to_scene(crossing_point.x, crossing_point.y),
                    "longitude": longitude,
                    "latitude": latitude,
                    "rotation_y_rad": _scene_heading(list(road.coords), declared),
                    "signals": crossing_properties.get("signals"),
                    "barrier": crossing_properties.get("barrier"),
                    "source": "OpenStreetMap railway=level_crossing",
                }
            )

    def payload(self) -> dict:
        return {
            "road_source": self.source_metadata,
            "roads": self.roads,
            "crossings": self.crossings,
        }
