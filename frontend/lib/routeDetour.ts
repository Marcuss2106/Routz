/**
 * Generate real driving alternatives when Google's ordinary candidates all
 * cross an active simulated train blockage.
 */

import {
  getDrivingRoutes,
  type PlaceResult,
  type RouteInfo,
  type RoutzCoordinate,
} from "./googleMaps";
import { FRA_CROSSINGS } from "./crossings";
import { findRouteConflicts, scoreRouteCandidates } from "./routeCrossing";
import type { BlockagePrediction } from "./trains";

export interface DetourBypass {
  name: string;
  coordinate: RoutzCoordinate;
}

/**
 * Waypoints west of the downtown Norfolk Southern at-grade corridor.
 *
 * Earlier hard-coded points sat on Gervais/Elmwood *at* the rail (~-81.02),
 * so Google's forced routes still crossed Hampton/Taylor and scored as
 * blocked — the map flickered between slower blocked alternatives. These
 * points are drawn from OSM elevated/west arterials that keep the path off
 * the FRA downtown inventory crossings.
 */
export const COLUMBIA_BYPASS_WAYPOINTS: DetourBypass[] = [
  {
    name: "Gervais Street rail overpass (west)",
    coordinate: { latitude: 33.99869, longitude: -81.04167 },
  },
  {
    name: "Huger Street west arterial",
    coordinate: { latitude: 34.0050, longitude: -81.0435 },
  },
  {
    name: "Elmwood Avenue west of corridor",
    coordinate: { latitude: 34.0120, longitude: -81.0436 },
  },
  {
    name: "Blossom Street rail overpass (west)",
    coordinate: { latitude: 33.99021, longitude: -81.0393 },
  },
];

/** Active (not cleared/unknown) blockage predictions. */
export function activeBlockages(
  predictions: BlockagePrediction[]
): BlockagePrediction[] {
  return predictions.filter(
    (prediction) =>
      prediction.status !== "cleared" && prediction.status !== "unknown"
  );
}

/** True when the route does not meet any active train blockage. */
export function routeAvoidsActiveBlockages(
  route: RouteInfo,
  predictions: BlockagePrediction[],
  nowMs: number = Date.now()
): boolean {
  return findRouteConflicts(route, activeBlockages(predictions), nowMs).length === 0;
}

/**
 * Crossing ids the route would meet while the train is active.
 * Used to tell "same blocked corridor, just slower" from a real bypass.
 */
export function blockedCrossingSignature(
  route: RouteInfo,
  predictions: BlockagePrediction[],
  nowMs: number = Date.now()
): string {
  const ids = findRouteConflicts(route, activeBlockages(predictions), nowMs)
    .map((conflict) => conflict.crossingId)
    .sort();
  return ids.length > 0 ? ids.join("|") : "clear";
}

/** Candidate waypoints, ordered for the trip's general north/south direction. */
export function findDetourWaypoints(
  origin: PlaceResult,
  destination: PlaceResult,
  predictions: BlockagePrediction[]
): RoutzCoordinate[] {
  const waypoints: RoutzCoordinate[] = [];
  const seen = new Set<string>();
  const add = (coordinate: RoutzCoordinate) => {
    const key = `${coordinate.latitude.toFixed(4)},${coordinate.longitude.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    waypoints.push(coordinate);
  };

  // A crossing behind the rear is the shortest reliable bypass when one is
  // already available.
  predictions
    .filter((prediction) => prediction.status === "cleared")
    .sort((a, b) => b.distanceM - a.distanceM)
    .forEach((prediction) => add({
      latitude: prediction.latitude,
      longitude: prediction.longitude,
    }));

  const northbound =
    destination.coordinate.latitude >= origin.coordinate.latitude;
  const bypasses = northbound
    ? COLUMBIA_BYPASS_WAYPOINTS
    : [
        COLUMBIA_BYPASS_WAYPOINTS[3],
        COLUMBIA_BYPASS_WAYPOINTS[0],
        COLUMBIA_BYPASS_WAYPOINTS[1],
        COLUMBIA_BYPASS_WAYPOINTS[2],
      ];
  bypasses.forEach((bypass) => add(bypass.coordinate));

  // Finally try real FRA crossings outside the active blockage set, but only
  // ones that sit west of the blocked corridor so Google cannot snap back onto
  // Hampton/Taylor.
  const blockedIds = new Set(
    activeBlockages(predictions).map((prediction) => prediction.crossingId)
  );
  const blockedLons = activeBlockages(predictions).map((p) => p.longitude);
  const eastEdge = blockedLons.length > 0 ? Math.max(...blockedLons) : -81.02;
  FRA_CROSSINGS
    .filter((crossing) => !blockedIds.has(crossing.id))
    .filter((crossing) => crossing.longitude < eastEdge - 0.005)
    .forEach((crossing) => add({
      latitude: crossing.latitude,
      longitude: crossing.longitude,
    }));

  return waypoints;
}

/**
 * Keep unique geometric candidates: drop routes that hit the same active
 * crossings as an earlier (usually faster) option. That is the "just slower"
 * case the map was flickering through.
 */
export function dedupeByBlockageSignature(
  routes: RouteInfo[],
  predictions: BlockagePrediction[],
  nowMs: number = Date.now()
): RouteInfo[] {
  const seen = new Set<string>();
  const unique: RouteInfo[] = [];
  for (const route of routes) {
    const signature = blockedCrossingSignature(route, predictions, nowMs);
    // Always keep one clear route; keep only the first blocked signature.
    const key = signature === "clear"
      ? `clear:${Math.round(route.expectedTravelTimeSeconds)}:${Math.round(route.distanceMeters)}`
      : signature;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(route);
  }
  return unique;
}

/**
 * Return ordinary alternatives plus forced bypass routes when every ordinary
 * route conflicts with the train. Only keep detours that actually clear the
 * active blockage set.
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
  if (
    predictions.length === 0 ||
    !scoreRouteCandidates(direct, predictions, nowMs)[0]?.blocked
  ) {
    return dedupeByBlockageSignature(direct, predictions, nowMs);
  }

  const attempts = findDetourWaypoints(
    origin,
    destination,
    predictions
  ).slice(0, 4);
  const detours = await Promise.all(
    attempts.map(async (waypoint) => {
      try {
        return await routeFetcher(origin, destination, false, [waypoint]);
      } catch {
        return [];
      }
    })
  );

  // Prefer detours that truly avoid the active blockages; fall back to the
  // full pool only so the caller can still show "all options blocked".
  const pooled = [...direct, ...detours.flat()];
  const clear = pooled.filter((route) =>
    routeAvoidsActiveBlockages(route, predictions, nowMs)
  );
  return dedupeByBlockageSignature(
    clear.length > 0 ? clear : pooled,
    predictions,
    nowMs
  );
}
