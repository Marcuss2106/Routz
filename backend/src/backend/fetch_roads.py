"""Fetch and cache OpenStreetMap roads and declared rail level crossings."""

from __future__ import annotations

import json
import math
import time
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pyproj import Transformer
from shapely.geometry import LineString, Point, mapping
from shapely.ops import transform

from .config import settings


OVERPASS_URLS = (
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
OSM_MAP_URL = "https://api.openstreetmap.org/api/0.6/map"
ROAD_CLASSES = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|"
    "residential|living_street"
)
ROAD_CLASS_SET = set(ROAD_CLASSES.split("|"))
OVERPASS_TILES_PER_AXIS = 6


def _overpass(query: str) -> dict:
    last_error: Exception | None = None
    for url in OVERPASS_URLS:
        request = Request(
            url,
            data=urlencode({"data": query}).encode(),
            headers={"User-Agent": "Routz-hackathon-geography-cache/1.0"},
        )
        try:
            with urlopen(request, timeout=180) as response:
                return json.load(response)
        except (HTTPError, URLError, TimeoutError) as error:
            last_error = error
    raise RuntimeError("Every configured Overpass endpoint failed") from last_error


def _is_ground_level(tags: dict) -> bool:
    bridge = tags.get("bridge", "no")
    tunnel = tags.get("tunnel", "no")
    try:
        layer = int(tags.get("layer", "0").split(";")[0])
    except ValueError:
        layer = 0
    return bridge in {"no", "false"} and tunnel in {"no", "false"} and layer == 0


def _query_elements(bounds: tuple[float, float, float, float]) -> list[dict]:
    bbox = ",".join(str(value) for value in bounds)
    query = f"""
    [out:json][timeout:150];
    (
      way["highway"~"^({ROAD_CLASSES})$"]({bbox});
      node["railway"="level_crossing"]({bbox});
    );
    out tags geom;
    """
    return _overpass(query).get("elements", [])


def _osm_map_elements(bounds: tuple[float, float, float, float], depth: int = 0) -> list[dict]:
    south, west, north, east = bounds
    request = Request(
        f"{OSM_MAP_URL}?{urlencode({'bbox': f'{west},{south},{east},{north}'})}",
        headers={"User-Agent": "Routz-hackathon-geography-cache/1.0"},
    )
    for attempt in range(5):
        try:
            with urlopen(request, timeout=180) as response:
                root = ET.parse(response).getroot()
            break
        except HTTPError as error:
            if error.code == 400 and depth < 3:
                middle_latitude = (south + north) / 2
                middle_longitude = (west + east) / 2
                elements: list[dict] = []
                for child_bounds in (
                    (south, west, middle_latitude, middle_longitude),
                    (south, middle_longitude, middle_latitude, east),
                    (middle_latitude, west, north, middle_longitude),
                    (middle_latitude, middle_longitude, north, east),
                ):
                    elements.extend(_osm_map_elements(child_bounds, depth + 1))
                return elements
            if error.code not in {429, 500, 503, 509} or attempt == 4:
                raise
            retry_after = error.headers.get("Retry-After")
            delay = float(retry_after) if retry_after and retry_after.isdigit() else 2 ** (attempt + 1)
            print(f"OpenStreetMap API busy; retrying in {delay:g} seconds...")
            time.sleep(delay)

    nodes: dict[int, dict] = {}
    elements: list[dict] = []
    for node in root.findall("node"):
        node_id = int(node.attrib["id"])
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in node.findall("tag")}
        nodes[node_id] = {
            "lat": float(node.attrib["lat"]),
            "lon": float(node.attrib["lon"]),
            "tags": tags,
        }
        if tags.get("railway") == "level_crossing":
            elements.append({"type": "node", "id": node_id, **nodes[node_id]})

    for way in root.findall("way"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in way.findall("tag")}
        if tags.get("highway") not in ROAD_CLASS_SET:
            continue
        geometry = [
            {"lat": nodes[node_id]["lat"], "lon": nodes[node_id]["lon"]}
            for node_id in (int(item.attrib["ref"]) for item in way.findall("nd"))
            if node_id in nodes
        ]
        if len(geometry) >= 2:
            elements.append({
                "type": "way",
                "id": int(way.attrib["id"]),
                "tags": tags,
                "geometry": geometry,
            })
    return elements


def fetch(output_path: Path = settings.road_data_path) -> Path:
    latitude_delta = settings.road_radius_m / 111_320
    longitude_delta = settings.road_radius_m / (
        111_320 * math.cos(math.radians(settings.center_lat))
    )
    south = settings.center_lat - latitude_delta
    west = settings.center_lon - longitude_delta
    north = settings.center_lat + latitude_delta
    east = settings.center_lon + longitude_delta
    elements_by_id: dict[tuple[str, int], dict] = {}
    checkpoint_path = output_path.with_suffix(".partial.jsonl")
    completed_tiles: set[int] = set()
    if checkpoint_path.exists():
        for line in checkpoint_path.read_text().splitlines():
            checkpoint = json.loads(line)
            completed_tiles.add(checkpoint["tile"])
            for element in checkpoint["elements"]:
                elements_by_id[(element["type"], element["id"])] = element
        print(f"Resuming with {len(completed_tiles)} cached road tiles.")
    source_url = OVERPASS_URLS[0]
    source_name = "OpenStreetMap via Overpass API"
    use_overpass = True
    tile_count = OVERPASS_TILES_PER_AXIS ** 2
    for row in range(OVERPASS_TILES_PER_AXIS):
        tile_south = south + (north - south) * row / OVERPASS_TILES_PER_AXIS
        tile_north = south + (north - south) * (row + 1) / OVERPASS_TILES_PER_AXIS
        for column in range(OVERPASS_TILES_PER_AXIS):
            tile_west = west + (east - west) * column / OVERPASS_TILES_PER_AXIS
            tile_east = west + (east - west) * (column + 1) / OVERPASS_TILES_PER_AXIS
            tile_number = row * OVERPASS_TILES_PER_AXIS + column + 1
            if tile_number in completed_tiles:
                continue
            print(f"Fetching OpenStreetMap road tile {tile_number}/{tile_count}...")
            bounds = (tile_south, tile_west, tile_north, tile_east)
            try:
                elements = _query_elements(bounds) if use_overpass else _osm_map_elements(bounds)
            except RuntimeError:
                print("Overpass unavailable; continuing with the tiled OpenStreetMap map API.")
                use_overpass = False
                source_url = OSM_MAP_URL
                source_name = "OpenStreetMap map API"
                elements = _osm_map_elements(bounds)
            for element in elements:
                elements_by_id[(element["type"], element["id"])] = element
            with checkpoint_path.open("a") as checkpoint_file:
                checkpoint_file.write(json.dumps({"tile": tile_number, "elements": elements}, separators=(",", ":")) + "\n")
    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True).transform
    to_wgs = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True).transform
    center = transform(to_utm, Point(settings.center_lon, settings.center_lat))
    clip_circle = center.buffer(settings.road_radius_m, resolution=96)
    features: list[dict] = []

    for element in elements_by_id.values():
        tags = element.get("tags", {})
        if element.get("type") == "way" and element.get("geometry"):
            coordinates = [(point["lon"], point["lat"]) for point in element["geometry"]]
            if len(coordinates) < 2:
                continue
            clipped = transform(to_utm, LineString(coordinates)).intersection(clip_circle)
            if clipped.is_empty:
                continue
            features.append(
                {
                    "type": "Feature",
                    "id": f"osm-road-{element['id']}",
                    "properties": {
                        "feature": "road",
                        "osm_id": element["id"],
                        "name": tags.get("name"),
                        "ref": tags.get("ref"),
                        "highway": tags.get("highway"),
                        "surface": tags.get("surface"),
                        "lanes": tags.get("lanes"),
                        "bridge": tags.get("bridge"),
                        "tunnel": tags.get("tunnel"),
                        "layer": tags.get("layer"),
                        "ground_level": _is_ground_level(tags),
                    },
                    "geometry": mapping(transform(to_wgs, clipped)),
                }
            )
        elif element.get("type") == "node" and tags.get("railway") == "level_crossing":
            features.append(
                {
                    "type": "Feature",
                    "id": f"osm-crossing-{element['id']}",
                    "properties": {
                        "feature": "level_crossing",
                        "osm_id": element["id"],
                        "name": tags.get("name"),
                        "crossing": tags.get("crossing"),
                        "signals": tags.get("crossing:signals"),
                        "barrier": tags.get("crossing:barrier"),
                    },
                    "geometry": {"type": "Point", "coordinates": [element["lon"], element["lat"]]},
                }
            )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    collection = {
        "type": "FeatureCollection",
        "metadata": {
            "source": source_name,
            "source_url": source_url,
            "attribution": "© OpenStreetMap contributors",
            "retrieved": date.today().isoformat(),
            "query_crs": "EPSG:4326",
            "clip_crs": "EPSG:32617",
            "center": [settings.center_lon, settings.center_lat],
            "radius_m": settings.road_radius_m,
            "road_filter": ROAD_CLASSES,
            "overpass_tiles": tile_count,
            "feature_count": len(features),
        },
        "features": features,
    }
    output_path.write_text(json.dumps(collection, separators=(",", ":")))
    checkpoint_path.unlink(missing_ok=True)
    return output_path


def main() -> None:
    path = fetch()
    print(f"Cached road geometry at {path}")


if __name__ == "__main__":
    main()
