"""Fetch and cache SCDOT rail geometry clipped to the configured metric radius."""

import json
from datetime import date
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

from pyproj import Transformer
from shapely.geometry import Point, mapping, shape
from shapely.ops import transform

from .config import settings


SERVICE_URL = "https://gis.scdot.org/hosting/rest/services/Railroads_RO/MapServer/12"
PAGE_SIZE = 1000


def _get_json(url: str, params: dict) -> dict:
    with urlopen(f"{url}?{urlencode(params)}", timeout=60) as response:
        return json.load(response)


def fetch(output_path: Path = settings.data_path) -> Path:
    metadata = _get_json(SERVICE_URL, {"f": "json"})
    if "Query" not in metadata.get("capabilities", ""):
        raise RuntimeError("SCDOT railroad layer does not advertise query support")

    query_url = f"{SERVICE_URL}/query"
    base = {
        "f": "geojson",
        "where": "TYPE IN ('ACTIVE','SPUR')",
        "geometry": f"{settings.center_lon},{settings.center_lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "distance": str(settings.radius_m),
        "units": "esriSRUnit_Meter",
        "outFields": "OBJECTID,NAME,ABBR_NAME,TYPE,RR_ID,SOURCE,LENGTH",
        "returnGeometry": "true",
        "outSR": "4326",
        "orderByFields": "OBJECTID",
        "resultRecordCount": str(PAGE_SIZE),
    }

    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True).transform
    to_wgs = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True).transform
    center = transform(to_utm, Point(settings.center_lon, settings.center_lat))
    clip_circle = center.buffer(settings.radius_m, resolution=128)

    features: list[dict] = []
    offset = 0
    while True:
        payload = _get_json(query_url, {**base, "resultOffset": str(offset)})
        page = payload.get("features", [])
        for feature in page:
            clipped = transform(to_utm, shape(feature["geometry"])).intersection(clip_circle)
            if clipped.is_empty:
                continue
            clipped_wgs = transform(to_wgs, clipped)
            features.append(
                {
                    "type": "Feature",
                    "id": feature.get("id"),
                    "properties": feature.get("properties", {}),
                    "geometry": mapping(clipped_wgs),
                }
            )
        if len(page) < PAGE_SIZE:
            break
        offset += len(page)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    collection = {
        "type": "FeatureCollection",
        "metadata": {
            "source": SERVICE_URL,
            "source_owner": metadata.get("copyrightText", "SCDOT GIS Office"),
            "source_updated": "April 2025",
            "retrieved": date.today().isoformat(),
            "query_crs": "EPSG:4326",
            "clip_crs": "EPSG:32617",
            "center": [settings.center_lon, settings.center_lat],
            "radius_m": settings.radius_m,
            "filter": "TYPE IN ('ACTIVE','SPUR')",
            "page_size": PAGE_SIZE,
            "feature_count": len(features),
        },
        "features": features,
    }
    output_path.write_text(json.dumps(collection, separators=(",", ":")))
    return output_path


def main() -> None:
    path = fetch()
    print(f"Cached railroad geometry at {path}")


if __name__ == "__main__":
    main()
