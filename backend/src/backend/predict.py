"""Train observation -> per-crossing blockage windows.

Python port of frontend/lib/trains.ts predictCrossingBlockages.
Model: straight-line constant-velocity motion along degFromEast.
Train occupies [front - lengthM, front] along the heading.
"""

from __future__ import annotations

import math
from datetime import timedelta

from .models import BlockagePrediction, Crossing, TrainObservation

EARTH_RADIUS_M = 6371000.0


def heading_to_vector(deg_from_east: float) -> tuple[float, float]:
    rad = math.radians(deg_from_east)
    return math.cos(rad), math.sin(rad)  # (east, north)


def delta_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> tuple[float, float]:
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    mean_lat = math.radians((lat1 + lat2) / 2)
    north = d_lat * EARTH_RADIUS_M
    east = d_lon * EARTH_RADIUS_M * math.cos(mean_lat)
    return east, north


def predict_crossing_blockages(
    obs: TrainObservation,
    crossings: list[Crossing],
    corridor_half_width_m: float = 120.0,
    clearance_buffer_s: float = 8.0,
    soon_threshold_s: float = 75.0,
    horizon_s: float = 15 * 60,
    crossing_half_width_m: float = 15.0,
) -> list[BlockagePrediction]:
    dir_east, dir_north = heading_to_vector(obs.degFromEast)
    stopped = obs.speedMps < 0.5

    if obs.positionReference == "front":
        ref_to_front_m = 0.0
    elif obs.positionReference == "center":
        ref_to_front_m = obs.lengthM / 2
    else:
        ref_to_front_m = obs.lengthM

    out: list[BlockagePrediction] = []
    for c in crossings:
        d_east, d_north = delta_meters(obs.lat, obs.lon, c.latitude, c.longitude)
        along_ref = d_east * dir_east + d_north * dir_north
        lateral = abs(d_east * dir_north - d_north * dir_east)
        if lateral > corridor_half_width_m:
            continue

        front_dist = along_ref - ref_to_front_m
        rear_clear_dist = front_dist + obs.lengthM

        if stopped:
            overlaps = front_dist <= crossing_half_width_m and rear_clear_dist >= -crossing_half_width_m
            if not overlaps:
                continue
            out.append(BlockagePrediction(
                crossingId=c.id, roadName=c.roadName,
                latitude=c.latitude, longitude=c.longitude,
                blockStartUtc=obs.observedAt,
                blockEndUtc=obs.observedAt + timedelta(seconds=horizon_s),
                etaSeconds=0, clearSeconds=int(horizon_s),
                distanceM=round(front_dist), lateralM=round(lateral),
                status="stopped_on_crossing",
                trainId=obs.trainId, observedAt=obs.observedAt,
            ))
            continue

        eta_s = front_dist / obs.speedMps
        clear_s = rear_clear_dist / obs.speedMps + clearance_buffer_s

        if rear_clear_dist < -crossing_half_width_m:
            if rear_clear_dist < -2000:
                continue
            out.append(BlockagePrediction(
                crossingId=c.id, roadName=c.roadName,
                latitude=c.latitude, longitude=c.longitude,
                blockStartUtc=obs.observedAt + timedelta(seconds=eta_s),
                blockEndUtc=obs.observedAt + timedelta(seconds=clear_s),
                etaSeconds=round(eta_s), clearSeconds=round(clear_s),
                distanceM=round(front_dist), lateralM=round(lateral),
                status="cleared",
                trainId=obs.trainId, observedAt=obs.observedAt,
            ))
            continue

        if eta_s > horizon_s:
            continue

        if front_dist <= crossing_half_width_m and rear_clear_dist >= -crossing_half_width_m:
            status = "blocked_now"
        elif 0 < eta_s <= soon_threshold_s:
            status = "blocked_soon"
        else:
            status = "upcoming"

        out.append(BlockagePrediction(
            crossingId=c.id, roadName=c.roadName,
            latitude=c.latitude, longitude=c.longitude,
            blockStartUtc=obs.observedAt + timedelta(seconds=max(0.0, eta_s)),
            blockEndUtc=obs.observedAt + timedelta(seconds=max(0.0, clear_s)),
            etaSeconds=round(eta_s), clearSeconds=round(clear_s),
            distanceM=round(front_dist), lateralM=round(lateral),
            status=status,  # type: ignore[arg-type]
            trainId=obs.trainId, observedAt=obs.observedAt,
        ))

    out.sort(key=lambda p: p.etaSeconds)
    return out
