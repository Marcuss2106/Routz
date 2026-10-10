from dataclasses import dataclass

from pyproj import Transformer


@dataclass(frozen=True)
class CoordinateSystem:
    center_lat: float
    center_lon: float

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "_to_utm", Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True)
        )
        object.__setattr__(
            self, "_to_wgs", Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)
        )
        east, north = self._to_utm.transform(self.center_lon, self.center_lat)
        object.__setattr__(self, "origin_easting", east)
        object.__setattr__(self, "origin_northing", north)

    def wgs_to_utm(self, lon: float, lat: float) -> tuple[float, float]:
        return self._to_utm.transform(lon, lat)

    def utm_to_wgs(self, east: float, north: float) -> tuple[float, float]:
        return self._to_wgs.transform(east, north)

    def utm_to_scene(self, east: float, north: float) -> tuple[float, float, float]:
        return east - self.origin_easting, 0.0, self.origin_northing - north

    def scene_to_utm(self, x: float, z: float) -> tuple[float, float]:
        return self.origin_easting + x, self.origin_northing - z

    def wgs_to_scene(self, lon: float, lat: float) -> tuple[float, float, float]:
        return self.utm_to_scene(*self.wgs_to_utm(lon, lat))

    def scene_to_wgs(self, x: float, z: float) -> tuple[float, float]:
        return self.utm_to_wgs(*self.scene_to_utm(x, z))

    def metadata(self) -> dict:
        return {
            "source_crs": "EPSG:4326",
            "movement_crs": "EPSG:32617",
            "origin": {
                "latitude": self.center_lat,
                "longitude": self.center_lon,
                "utm_easting_m": self.origin_easting,
                "utm_northing_m": self.origin_northing,
            },
            "scene_axes": {"x": "east", "y": "up", "z": "south"},
            "units": "meters",
            "geojson_order": "longitude, latitude",
            "heading": "degrees clockwise from true north",
        }
