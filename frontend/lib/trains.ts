/**
 * Train observation -> crossing blockage predictions for Routz.
 *
 * SIMULATION PROTOTYPE: all predictions are simulated estimates derived from
 * a single train observation (position of one reference point + speed +
 * heading + length). Not for real dispatch.
 *
 * Incoming observation shape (from acoustic-inference team):
 * {
 *   trainId: "train-001",
 *   observedAt: "2026-10-10T20:45:00Z",
 *   lat: 34.0007, lon: -81.0348,
 *   speedMps: 10, lengthM: 1200,
 *   degFromEast: 90,            // 0 = east, 90 = north, 180 = west, 270 = south
 *   positionReference: "front"  // which point of the train lat/lon refers to
 * }
 */

import type { Crossing } from "./crossings";

export type PositionReference = "front" | "center" | "rear";

export interface TrainObservation {
  trainId: string;
  /** ISO-8601 timestamp of the observation (UTC). */
  observedAt: string;
  lat: number;
  lon: number;
  /** Forward speed in m/s. Values <= ~0.5 are treated as stopped. */
  speedMps: number;
  /** Total train length in meters. */
  lengthM: number;
  /** Heading in degrees counter-clockwise from east: 0=E, 90=N, 180=W, 270=S. */
  degFromEast: number;
  positionReference: PositionReference;
}

export type BlockageStatus =
  | "blocked_now"
  | "blocked_soon"
  | "upcoming"
  | "cleared"
  | "stopped_on_crossing"
  | "unknown";

export interface BlockagePrediction {
  crossingId: string;
  roadName: string;
  latitude: number;
  longitude: number;
  /** ISO-8601: front of train reaches the crossing. */
  blockStartUtc: string;
  /** ISO-8601: rear of train clears the crossing (+ safety buffer). */
  blockEndUtc: string;
  /** Seconds from observedAt until the front reaches the crossing. <=0 means already there/past. */
  etaSeconds: number;
  /** Seconds from observedAt until the rear clears. */
  clearSeconds: number;
  /** Along-track distance (m) from the train FRONT to the crossing. Negative = front already passed. */
  distanceM: number;
  /** Perpendicular distance (m) from the train's path line to the crossing. Large = off-track. */
  lateralM: number;
  status: BlockageStatus;
  trainId: string;
  observedAt: string;
}

export interface PredictOptions {
  /** Crossings farther than this (perpendicular) from the train path are skipped. Default 120m. */
  corridorHalfWidthM?: number;
  /** Extra seconds added after the rear clears (gates, safety). Default 8s. */
  clearanceBufferS?: number;
  /** ETA under this is "blocked_soon". Default 75s. */
  soonThresholdS?: number;
  /** Predictions with ETA beyond this are still returned but marked upcoming. Default 15min. */
  horizonS?: number;
  /** Crossing half-width along track (m) for "on crossing" checks. Default 15m. */
  crossingHalfWidthM?: number;
}

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Degrees east -> unit vector in local (east, north) meters. */
export function headingToVector(degFromEast: number): { east: number; north: number } {
  const rad = toRad(degFromEast);
  return { east: Math.cos(rad), north: Math.sin(rad) };
}

/**
 * Delta from (lat1,lon1) to (lat2,lon2) in local meters.
 * Equirectangular approximation — plenty for <20km demo distances.
 */
export function deltaMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): { east: number; north: number } {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const meanLat = toRad((lat1 + lat2) / 2);
  const north = dLat * EARTH_RADIUS_M;
  const east = dLon * EARTH_RADIUS_M * Math.cos(meanLat);
  return { east, north };
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Move from lat/lon by (eastM, northM) meters. */
export function offsetLatLon(
  lat: number,
  lon: number,
  eastM: number,
  northM: number
): { lat: number; lon: number } {
  const dLat = (northM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon =
    ((eastM / (EARTH_RADIUS_M * Math.cos(toRad(lat)))) * (180 / Math.PI));
  return { lat: lat + dLat, lon: lon + dLon };
}

/** Validate + normalize an untrusted observation payload. Throws on invalid. */
export function parseTrainObservation(raw: unknown): TrainObservation {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Train observation must be an object.");
  }
  const o = raw as Record<string, unknown>;
  const trainId = String(o.trainId ?? "").trim();
  const observedAt = String(o.observedAt ?? "").trim();
  const lat = Number(o.lat);
  const lon = Number(o.lon);
  const speedMps = Number(o.speedMps);
  const lengthM = Number(o.lengthM);
  const degFromEast = Number(o.degFromEast);
  const positionReference = String(o.positionReference ?? "front").toLowerCase() as PositionReference;

  if (!trainId) throw new Error("Train observation missing trainId.");
  if (!observedAt || Number.isNaN(Date.parse(observedAt))) {
    throw new Error("Train observation has invalid observedAt (need ISO-8601 UTC).");
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error("Invalid train lat.");
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error("Invalid train lon.");
  if (!Number.isFinite(speedMps) || speedMps < 0 || speedMps > 80) {
    throw new Error("Invalid speedMps (expected 0..80).");
  }
  if (!Number.isFinite(lengthM) || lengthM <= 0 || lengthM > 5000) {
    throw new Error("Invalid lengthM (expected 1..5000).");
  }
  if (!Number.isFinite(degFromEast)) throw new Error("Invalid degFromEast.");
  if (positionReference !== "front" && positionReference !== "center" && positionReference !== "rear") {
    throw new Error('positionReference must be "front", "center", or "rear".');
  }

  // Normalize heading to [0,360)
  const normalized = ((degFromEast % 360) + 360) % 360;
  return { trainId, observedAt, lat, lon, speedMps, lengthM, degFromEast: normalized, positionReference };
}

/**
 * Predict per-crossing blockage windows from one train observation.
 *
 * Model: straight-line constant-velocity motion along degFromEast.
 * Train occupies [front - length, front] along the heading.
 * A crossing at along-track distance `frontDist` from the front is blocked
 * while the train overlaps it: traveled ∈ [frontDist, frontDist + length].
 */
export function predictCrossingBlockages(
  obs: TrainObservation,
  crossings: Crossing[],
  opts: PredictOptions = {}
): BlockagePrediction[] {
  const {
    corridorHalfWidthM = 120,
    clearanceBufferS = 8,
    soonThresholdS = 75,
    horizonS = 15 * 60,
    crossingHalfWidthM = 15,
  } = opts;

  const dir = headingToVector(obs.degFromEast);
  const observedMs = Date.parse(obs.observedAt);
  const stopped = obs.speedMps < 0.5;

  // Offset from the reported reference point to the FRONT along heading.
  const refToFrontM =
    obs.positionReference === "front" ? 0 : obs.positionReference === "center" ? obs.lengthM / 2 : obs.lengthM;

  const out: BlockagePrediction[] = [];

  for (const c of crossings) {
    const d = deltaMeters(obs.lat, obs.lon, c.latitude, c.longitude);
    // Along-track distance from the REFERENCE point to the crossing.
    const alongRef = d.east * dir.east + d.north * dir.north;
    // Perpendicular distance (absolute).
    const lateral = Math.abs(d.east * dir.north - d.north * dir.east);

    if (lateral > corridorHalfWidthM) continue;

    // Along-track distance from the FRONT to the crossing.
    const frontDist = alongRef - refToFrontM;
    // Distance the rear still has to travel to clear (front dist + full length).
    const rearClearDist = frontDist + obs.lengthM;

    if (stopped) {
      // Stopped: only report if the train body currently overlaps the crossing.
      const overlaps = frontDist <= crossingHalfWidthM && rearClearDist >= -crossingHalfWidthM;
      if (!overlaps) continue;
      out.push({
        crossingId: c.id,
        roadName: c.roadName,
        latitude: c.latitude,
        longitude: c.longitude,
        blockStartUtc: obs.observedAt,
        blockEndUtc: new Date(observedMs + horizonS * 1000).toISOString(),
        etaSeconds: 0,
        clearSeconds: horizonS,
        distanceM: Math.round(frontDist),
        lateralM: Math.round(lateral),
        status: "stopped_on_crossing",
        trainId: obs.trainId,
        observedAt: obs.observedAt,
      });
      continue;
    }

    const etaSeconds = frontDist / obs.speedMps;
    const clearSeconds = rearClearDist / obs.speedMps + clearanceBufferS;

    // Already cleared: rear passed the crossing (with margin).
    if (rearClearDist < -crossingHalfWidthM) {
      // Still include as cleared for UI completeness? Skip far-behind ones.
      if (rearClearDist < -2000) continue;
      out.push({
        crossingId: c.id,
        roadName: c.roadName,
        latitude: c.latitude,
        longitude: c.longitude,
        blockStartUtc: new Date(observedMs + etaSeconds * 1000).toISOString(),
        blockEndUtc: new Date(observedMs + clearSeconds * 1000).toISOString(),
        etaSeconds: Math.round(etaSeconds),
        clearSeconds: Math.round(clearSeconds),
        distanceM: Math.round(frontDist),
        lateralM: Math.round(lateral),
        status: "cleared",
        trainId: obs.trainId,
        observedAt: obs.observedAt,
      });
      continue;
    }

    // Beyond horizon: skip to keep the list focused.
    if (etaSeconds > horizonS) continue;

    let status: BlockageStatus = "upcoming";
    const frontAtCrossing = frontDist <= crossingHalfWidthM && rearClearDist >= -crossingHalfWidthM;
    if (frontAtCrossing) status = "blocked_now";
    else if (etaSeconds <= soonThresholdS && etaSeconds > 0) status = "blocked_soon";

    out.push({
      crossingId: c.id,
      roadName: c.roadName,
      latitude: c.latitude,
      longitude: c.longitude,
      blockStartUtc: new Date(observedMs + Math.max(0, etaSeconds) * 1000).toISOString(),
      blockEndUtc: new Date(observedMs + Math.max(0, clearSeconds) * 1000).toISOString(),
      etaSeconds: Math.round(etaSeconds),
      clearSeconds: Math.round(clearSeconds),
      distanceM: Math.round(frontDist),
      lateralM: Math.round(lateral),
      status,
      trainId: obs.trainId,
      observedAt: obs.observedAt,
    });
  }

  // Soonest first.
  out.sort((a, b) => a.etaSeconds - b.etaSeconds);
  return out;
}

/** Front + rear lat/lon of the train at observation time (for map display). */
export function trainEndpoints(obs: TrainObservation): {
  front: { lat: number; lon: number };
  rear: { lat: number; lon: number };
} {
  const dir = headingToVector(obs.degFromEast);
  const refToFrontM =
    obs.positionReference === "front" ? 0 : obs.positionReference === "center" ? obs.lengthM / 2 : obs.lengthM;
  const refToRearM = refToFrontM - obs.lengthM;
  const front = offsetLatLon(obs.lat, obs.lon, dir.east * refToFrontM, dir.north * refToFrontM);
  const rear = offsetLatLon(obs.lat, obs.lon, dir.east * refToRearM, dir.north * refToRearM);
  return { front, rear };
}

/** Project the train's front position forward by dt seconds (constant velocity). */
export function projectTrainFront(obs: TrainObservation, dtSeconds: number): { lat: number; lon: number } {
  const { front } = trainEndpoints(obs);
  const dir = headingToVector(obs.degFromEast);
  const dist = obs.speedMps * dtSeconds;
  return offsetLatLon(front.lat, front.lon, dir.east * dist, dir.north * dist);
}

/**
 * Sample observation for local testing: a northbound NS freight ~800 m south
 * of Greene St on the real FRA downtown corridor (heading ≈ 109° from east,
 * matching the Greene -> Laurel track line). Yields 1 "closing soon" +
 * 4 upcoming predictions.
 */
export const SAMPLE_OBSERVATION: TrainObservation = {
  trainId: "train-001",
  observedAt: new Date().toISOString(),
  lat: 33.9929,
  lon: -81.0158,
  speedMps: 12,
  lengthM: 1200,
  degFromEast: 109,
  positionReference: "front",
};
