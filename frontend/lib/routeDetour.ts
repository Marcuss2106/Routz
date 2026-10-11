/**
 * Crossing-aware route candidate generation for Routz.
 *
 * When a freight train blocks direct routes across at-grade railroad
 * crossings in Columbia, SC, this module generates bypass candidate routes
 * using cleared crossings, unblocked crossings, and grade-separated
 * corridors (Elmwood Ave, Gervais St, Blossom St, Huger St).
 */

import {
  getDrivingRoutes,
  type PlaceResult,
  type RouteInfo,
  type RoutzCoordinate,
} from "./googleMaps";
import { scoreRouteCandidates } from "./routeCrossing";
import { FRA_CROSSINGS } from "./crossings";
import type { BlockagePrediction } from "./trains";

export interface DetourBypass {
  name: string;
  coordinate: RoutzCoordinate;
  description: string;
}

/**
 * Real grade-separated corridors in Columbia, SC.
 * Trains on Norfolk Southern pass over/under these arterials with bridges
 * or underpasses, so emergency vehicles and drivers are never blocked by
 * at-grade freight train movements.
 */
export const COLUMBIA_BYPASS_WAYPOINTS: DetourBypass[] = [
  {
    name: "Gervais St (Central Bypass)",
    coordinate: { latitude: 34.0018, longitude: -81.0205 },
    description: "Central grade-separated bridge between Greene St and Hampton St",
  },
  {
    name: "Elmwood Ave (North Bypass)",
    coordinate: { latitude: 34.0178, longitude: -81.0265 },
    description: "North grade-separated 6-lane arterial bypassing Laurel/Blanding/Taylor/Hampton",
  },
  {
    name: "Blossom St (South Bypass)",
    coordinate: { latitude: 33.9935, longitude: -81.0230 },
    description: "South grade-separated arterial south of Greene St / USC campus",
  },
  {
    name: "Huger St (West Bypass)",
    coordinate: { latitude: 34.0050, longitude: -81.0440 },
    description: "North-south arterial parallel to the downtown rail corridor",
  },
];

/**
 * Determine candidate detour waypoints when direct routes are blocked by a train.
 * Prioritizes cleared crossings and grade-separated bypasses aligned with trip direction.
 */
export function findDetourWaypoints(
  origin: PlaceResult,
  destination: PlaceResult,
  predictions: BlockagePrediction[]
): RoutzCoordinate[] {
  const waypoints: RoutzCoordinate[] = [];
  const seen = new Set<string>();

  const add = (coord: RoutzCoordinate) => {
    const key = `${coord.latitude.toFixed(4)},${coord.longitude.toFixed(4)}`;
    if (!seen.has(key)) {
      seen.add(key);
      waypoints.push(coord);
    }
  };

  // 1. Cleared crossings: any crossing that the rear of the train has already passed.
  const cleared = predictions
    .filter((p) => p.status === "cleared")
    .sort((a, b) => b.distanceM - a.distanceM);
  for (const c of cleared) {
    add({ latitude: c.latitude, longitude: c.longitude });
  }

  // 2. Grade-separated corridors ranked by trip direction:
  const headingNorth = destination.coordinate.latitude >= origin.coordinate.latitude;
  const bypassList = headingNorth
    ? [
        { name: "Gervais St", coordinate: { latitude: 34.0018, longitude: -81.0205 } },
        { name: "Elmwood Ave", coordinate: { latitude: 34.0178, longitude: -81.0265 } },
        { name: "Blossom St", coordinate: { latitude: 33.9935, longitude: -81.0230 } },
        { name: "Huger St", coordinate: { latitude: 34.0050, longitude: -81.0440 } },
      ]
    : [
        { name: "Gervais St", coordinate: { latitude: 34.0018, longitude: -81.0205 } },
        { name: "Blossom St", coordinate: { latitude: 33.9935, longitude: -81.0230 } },
        { name: "Elmwood Ave", coordinate: { latitude: 34.0178, longitude: -81.0265 } },
        { name: "Huger St", coordinate: { latitude: 34.0050, longitude: -81.0440 } },
      ];

  for (const bypass of bypassList) {
    add(bypass.coordinate);
  }

  // 3. Unblocked corridor crossings:
  const activeBlockedIds = new Set(
    predictions
      .filter((p) => p.status !== "cleared" && p.status !== "unknown")
      .map((p) => p.crossingId)
  );
  for (const c of FRA_CROSSINGS) {
    if (!activeBlockedIds.has(c.id)) {
      add({ latitude: c.latitude, longitude: c.longitude });
    }
  }

  return waypoints;
}

/**
 * Ask Google for ordinary direct alternatives first.
 * If every direct candidate meets an active train conflict, query alternative
 * routes forced through detour waypoints (cleared crossings, unblocked crossings,
 * and grade-separated corridors like Gervais St and Elmwood Ave) so the returned
 * candidates include routes that do not run into the train.
 */
export async function getCrossingAwareCandidates(
  origin: PlaceResult,
  destination: PlaceResult,
  predictions: BlockagePrediction[],
  nowMs: number = Date.now(),
  routeFetcher: (
    origin: PlaceResult,
    destination: PlaceResult,
    alternatives: boolean,
    intermediates?: RoutzCoordinate[]
  ) => Promise<RouteInfo[]> = getDrivingRoutes
): Promise<RouteInfo[]> {
  const direct = await routeFetcher(origin, destination, true);
  if (predictions.length === 0) {
    return direct;
  }

  const scoredDirect = scoreRouteCandidates(direct, predictions, nowMs);
  if (!scoredDirect[0]?.blocked) {
    // At least one direct route is already unblocked.
    return direct;
  }

  // Every direct route runs into the train!
  // Generate detour candidates using waypoints that bypass the blockage.
  const candidateWaypoints = findDetourWaypoints(origin, destination, predictions);
  // Try up to 3 distinct detour waypoints concurrently
  const toTry = candidateWaypoints.slice(0, 3);

  const detourPromises = toTry.map(async (wp) => {
    try {
      return await routeFetcher(origin, destination, false, [wp]);
    } catch {
      return [];
    }
  });

  const settled = await Promise.all(detourPromises);
  const detourRoutes = settled.flat();

  return [...direct, ...detourRoutes];
}
