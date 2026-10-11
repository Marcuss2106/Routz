import json
import math
from pathlib import Path

import pytest

from backend import demo_anchor as anchor
from backend.crossings import FRA_CROSSINGS
from backend.predict import delta_meters

ROOT = Path(__file__).resolve().parents[2]


def _corridor_along(crossing_id: str) -> tuple[float, float]:
    start = next(c for c in FRA_CROSSINGS if c.id == "715869J")
    crossing = next(c for c in FRA_CROSSINGS if c.id == crossing_id)
    east, north = delta_meters(start.latitude, start.longitude, crossing.latitude, crossing.longitude)
    along = east * math.cos(math.radians(anchor.CORRIDOR_DEG_FROM_EAST)) + north * math.sin(
        math.radians(anchor.CORRIDOR_DEG_FROM_EAST)
    )
    lateral = abs(
        east * math.sin(math.radians(anchor.CORRIDOR_DEG_FROM_EAST))
        - north * math.cos(math.radians(anchor.CORRIDOR_DEG_FROM_EAST))
    )
    return along, lateral


def test_acoustic_constants_match_shared_geometry() -> None:
    geometry = json.loads((ROOT / "shared" / "simulation_geometry.json").read_text())
    track = geometry["track"]
    length = sum(
        math.hypot(b["x_m"] - a["x_m"], b["y_m"] - a["y_m"]) for a, b in zip(track, track[1:])
    )
    assert anchor.ACOUSTIC_TRACK_LENGTH_M == pytest.approx(length)


def test_route_distance_matches_the_3d_scene_mapping() -> None:
    assert anchor.route_distance_m(-anchor.ACOUSTIC_MARGIN_M) == pytest.approx(0.0)
    assert anchor.route_distance_m(
        anchor.ACOUSTIC_TRACK_LENGTH_M + anchor.ACOUSTIC_MARGIN_M
    ) == pytest.approx(anchor.DEMO_ROUTE_LENGTH_M)
    assert anchor.route_distance_m(-1000.0) == 0.0
    assert anchor.route_distance_m(5000.0) == anchor.DEMO_ROUTE_LENGTH_M


def test_demo_window_passes_real_corridor_crossings() -> None:
    window = (
        anchor.DEMO_WINDOW_START_M,
        anchor.DEMO_WINDOW_START_M + anchor.DEMO_ROUTE_LENGTH_M,
    )
    inside = []
    for crossing_id in ("715871K", "715872S", "715874F", "715875M"):
        along, lateral = _corridor_along(crossing_id)
        assert lateral < 15.0
        assert window[0] < along < window[1]
        inside.append(along - window[0])
    assert inside == sorted(inside)
    # All crossings must lie beyond where the array tracks the train (~220 m).
    assert min(inside) > anchor.route_distance_m(220.0)


def test_speed_and_length_scale_with_the_route_mapping() -> None:
    result = anchor.anchor_estimate(
        track_position_m=100.0,
        speed_mps=28.9,
        direction_deg_from_east=0.0,
        length_m=None,
        provisional_length_m=200.0,
    )
    assert result.speed_mps == pytest.approx(28.9 * anchor.ROUTE_PER_ACOUSTIC_M)
    assert result.speed_mps == pytest.approx(16.0, abs=0.1)
    assert result.length_m is None
    assert result.provisional_length_m == pytest.approx(200.0 * anchor.ROUTE_PER_ACOUSTIC_M)
    assert result.direction_deg_from_east == pytest.approx(anchor.CORRIDOR_DEG_FROM_EAST)


def test_reverse_travel_flips_the_corridor_heading() -> None:
    result = anchor.anchor_estimate(
        track_position_m=100.0,
        speed_mps=10.0,
        direction_deg_from_east=180.0,
        length_m=100.0,
        provisional_length_m=None,
    )
    assert result.direction_deg_from_east == pytest.approx(
        (anchor.CORRIDOR_DEG_FROM_EAST + 180.0) % 360.0
    )


def test_unknown_direction_stays_unknown() -> None:
    result = anchor.anchor_estimate(
        track_position_m=100.0,
        speed_mps=None,
        direction_deg_from_east=None,
        length_m=None,
        provisional_length_m=None,
    )
    assert result.direction_deg_from_east is None
    assert result.speed_mps is None


def test_corridor_point_round_trips_along_distance() -> None:
    latitude, longitude = anchor.corridor_point(700.0)
    start = next(c for c in FRA_CROSSINGS if c.id == "715869J")
    east, north = delta_meters(start.latitude, start.longitude, latitude, longitude)
    assert math.hypot(east, north) == pytest.approx(700.0, abs=1.0)
