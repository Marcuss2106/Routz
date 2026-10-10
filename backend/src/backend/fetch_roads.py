"""Fetch and cache OpenStreetMap roads and declared rail level crossings."""

from __future__ import annotations

import json
import math
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
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)
ROAD_CLASSES = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|"
    "residential|living_street"
)


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


def fetch(output_path: Path = settings.road_data_path) -> Path:
    latitude_delta = settings.road_radius_m / 111_320
    longitude_delta = settings.road_radius_m / (
        111_320 * math.cos(math.radians(settings.center_lat))
    )
    bbox = ",".join(
        str(value)
        for value in (
            settings.center_lat - latitude_delta,
            settings.center_lon - longitude_delta,
            settings.center_lat + latitude_delta,
            settings.center_lon + longitude_delta,
        )
    )
    query = f"""
    [out:json][timeout:150];
    (
      way["highway"~"^({ROAD_CLASSES})$"]({bbox});
      node["railway"="level_crossing"]({bbox});
    );
    out tags geom;
    """
    payload = _overpass(query)
    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True).transform
    to_wgs = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True).transform
    center = transform(to_utm, Point(settings.center_lon, settings.center_lat))
    clip_circle = center.buffer(settings.road_radius_m, resolution=96)
    features: list[dict] = []

    for element in payload.get("elements", []):
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
            "source": "OpenStreetMap via Overpass API",
            "source_url": OVERPASS_URLS[0],
            "attribution": "© OpenStreetMap contributors",
            "retrieved": date.today().isoformat(),
            "query_crs": "EPSG:4326",
            "clip_crs": "EPSG:32617",
            "center": [settings.center_lon, settings.center_lat],
            "radius_m": settings.road_radius_m,
            "road_filter": ROAD_CLASSES,
            "feature_count": len(features),
        },
        "features": features,
    }
    output_path.write_text(json.dumps(collection, separators=(",", ":")))
    return output_path


def main() -> None:
    path = fetch()
    print(f"Cached road geometry at {path}")


if __name__ == "__main__":
    main()
