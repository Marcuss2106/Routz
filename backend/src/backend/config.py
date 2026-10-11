from dataclasses import dataclass
from pathlib import Path
import os


PACKAGE_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class Settings:
    center_lat: float = float(os.getenv("RAIL_CENTER_LAT", "34.0007"))
    center_lon: float = float(os.getenv("RAIL_CENTER_LON", "-81.0348"))
    radius_m: float = float(os.getenv("RAIL_RADIUS_M", "16093.44"))
    base_speed_mps: float = float(os.getenv("TRAIN_SPEED_MPS", "16.0"))
    allowed_origins: tuple[str, ...] = tuple(
        value.strip().rstrip("/")
        for value in os.getenv(
            "SIMULATION_ALLOWED_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3100,http://127.0.0.1:3100",
        ).split(",")
        if value.strip()
    )
    data_path: Path = Path(
        os.getenv("RAIL_DATA_PATH", str(PACKAGE_DIR / "data" / "railroads_columbia.geojson"))
    )
    road_radius_m: float = float(os.getenv("ROAD_RADIUS_M", "16093.44"))
    road_data_path: Path = Path(
        os.getenv("ROAD_DATA_PATH", str(PACKAGE_DIR / "data" / "roads_columbia.geojson"))
    )


settings = Settings()
