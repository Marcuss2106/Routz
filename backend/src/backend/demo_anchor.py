"""Documented demo transform from the acoustic rail to a real map corridor.

SIMULATION ONLY. The acoustic estimator localizes on a small local rail
(``shared/simulation_geometry.json``). The 3D scene draws that estimate on an
800 m SCDOT demonstration route that passes no mapped level crossing. To let a
simulated train visibly affect real crossings on the ambulance map, the user
backend places the acoustic rail on the Norfolk Southern Greene St -> Laurel St
corridor, whose crossings are real FRA inventory entries.

The transform is fixed and shared with the 3D scene's own mapping:

1. ``s`` (acoustic rail metres) -> demo route distance, the same linear map as
   ``mapRouteDistanceToAcousticS`` in ``simulation_frontend/src/lib/simulation.ts``.
2. Route distance (metres) -> corridor distance, offset by
   ``DEMO_WINDOW_START_M`` from the Greene St crossing, 1:1 in metres.
3. Speed and length scale with step 1 so the map sees route-frame values.

Nothing here reads ground truth; it only re-expresses acoustic estimates.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .crossings import FRA_CROSSINGS
from .predict import EARTH_RADIUS_M, delta_meters

ANCHOR_ID = "demo-corridor-greene-laurel"

# Mirrors simulation_geometry.json: east 500 m then toward (1000, 300).
ACOUSTIC_TRACK_LENGTH_M = 500.0 + math.hypot(500.0, 300.0)
# Mirrors SIMULATION_START_MARGIN_M in simulation_frontend/src/lib/geometry.ts.
ACOUSTIC_MARGIN_M = 180.0
# Mirrors the 800 m route owned by backend.rail_network (RailNetwork).
DEMO_ROUTE_LENGTH_M = 800.0
# Where the 800 m demo route starts on the corridor, measured from Greene St.
# At 820 m, Hampton, Taylor, Blanding, and Laurel St sit about 302, 461, 618,
# and 776 m into the route. The array only tracks the train over roughly the
# first 220 m of the route, so every crossing is still ahead while it is heard.
DEMO_WINDOW_START_M = 820.0

_START = next(c for c in FRA_CROSSINGS if c.id == "715869J")  # Greene St
_END = next(c for c in FRA_CROSSINGS if c.id == "715875M")  # Laurel St
_EAST_M, _NORTH_M = delta_meters(_START.latitude, _START.longitude, _END.latitude, _END.longitude)
CORRIDOR_LENGTH_M = math.hypot(_EAST_M, _NORTH_M)
CORRIDOR_DEG_FROM_EAST = math.degrees(math.atan2(_NORTH_M, _EAST_M)) % 360.0
_UNIT_EAST = _EAST_M / CORRIDOR_LENGTH_M
_UNIT_NORTH = _NORTH_M / CORRIDOR_LENGTH_M

ROUTE_PER_ACOUSTIC_M = DEMO_ROUTE_LENGTH_M / (ACOUSTIC_TRACK_LENGTH_M + 2.0 * ACOUSTIC_MARGIN_M)


@dataclass(frozen=True)
class AnchoredEstimate:
    latitude: float
    longitude: float
    speed_mps: float | None
    direction_deg_from_east: float | None
    length_m: float | None
    provisional_length_m: float | None
    route_distance_m: float
    corridor_distance_m: float


def route_distance_m(track_position_m: float) -> float:
    """Acoustic rail position -> distance along the 800 m demo route."""
    normalized = (track_position_m + ACOUSTIC_MARGIN_M) / (
        ACOUSTIC_TRACK_LENGTH_M + 2.0 * ACOUSTIC_MARGIN_M
    )
    return min(max(normalized * DEMO_ROUTE_LENGTH_M, 0.0), DEMO_ROUTE_LENGTH_M)


def corridor_point(distance_m: float) -> tuple[float, float]:
    """Latitude/longitude at a distance along Greene St -> Laurel St."""
    east_m = _UNIT_EAST * distance_m
    north_m = _UNIT_NORTH * distance_m
    latitude = _START.latitude + math.degrees(north_m / EARTH_RADIUS_M)
    longitude = _START.longitude + math.degrees(
        east_m / (EARTH_RADIUS_M * math.cos(math.radians(_START.latitude)))
    )
    return latitude, longitude


def _scaled(value: float | None) -> float | None:
    return None if value is None else value * ROUTE_PER_ACOUSTIC_M


def anchor_estimate(
    *,
    track_position_m: float,
    speed_mps: float | None,
    direction_deg_from_east: float | None,
    length_m: float | None,
    provisional_length_m: float | None,
) -> AnchoredEstimate:
    """Express one acoustic estimate on the demo corridor.

    The acoustic direction is east (0) for increasing rail distance near the
    array, so travel toward Laurel St is ``cos(direction) >= 0``; the reverse
    direction maps to the opposite corridor heading.
    """
    route_m = route_distance_m(track_position_m)
    corridor_m = DEMO_WINDOW_START_M + route_m
    latitude, longitude = corridor_point(corridor_m)

    mapped_direction: float | None = None
    if direction_deg_from_east is not None:
        forward = math.cos(math.radians(direction_deg_from_east)) >= 0.0
        mapped_direction = (
            CORRIDOR_DEG_FROM_EAST if forward else (CORRIDOR_DEG_FROM_EAST + 180.0) % 360.0
        )
    return AnchoredEstimate(
        latitude=latitude,
        longitude=longitude,
        speed_mps=_scaled(speed_mps),
        direction_deg_from_east=mapped_direction,
        length_m=_scaled(length_m),
        provisional_length_m=_scaled(provisional_length_m),
        route_distance_m=route_m,
        corridor_distance_m=corridor_m,
    )
