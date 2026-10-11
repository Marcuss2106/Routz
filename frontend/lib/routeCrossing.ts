/**
 * Route <-> crossing-blockage conflict detection + candidate scoring.
 *
 * SIMULATION: arrival times at crossings are estimated from the route's total
 * duration prorated by along-path distance. Real traffic + ambulance
 * preemption are NOT modeled.
 */

import type { RouteInfo, RoutzCoordinate } from "./googleMaps";
import { haversineM } from "./trains";
import type { BlockagePrediction } from "./trains";

export interface RouteConflict {
  crossingId: string;
  roadName: string;
  latitude: number;
  longitude: number;
  /** Estimated driver arrival at the crossing (ms since epoch). */
  driverArrivalMs: number;
  blockStartMs: number;
  blockEndMs: number;
  /** Seconds the driver would wait if they take this route. 0 = no wait. */
  waitSeconds: number;
  /** Min distance (m) between route path and crossing. */
  missDistanceM: number;
}

export interface ScoredRoute {
  route: RouteInfo;
  index: number;
  conflicts: RouteConflict[];
  /** Total wait across conflicts (s). */
  totalWaitSeconds: number;
  /** Travel + wait (s) — the number we rank by. */
  effectiveSeconds: number;
  blocked: boolean;
}

/** Cumulative path distances in meters. */
function cumulativeDistances(path: RoutzCoordinate[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    cum.push(cum[i - 1] + haversineM(a.latitude, a.longitude, b.latitude, b.longitude));
  }
  return cum;
}

function closestApproach(
  path: RoutzCoordinate[],
  lat: number,
  lon: number
): { distanceM: number; fraction: number } {
  if (path.length === 0) return { distanceM: Infinity, fraction: 0 };
  const cum = cumulativeDistances(path);
  const total = cum[cum.length - 1] || 1;
  let best = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < path.length; i++) {
    const d = haversineM(path[i].latitude, path[i].longitude, lat, lon);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return { distanceM: best, fraction: cum[bestIdx] / total };
}

/**
 * Find where a route crosses predicted blockages.
 *
 * @param route Route candidate from Google.
 * @param predictions Active blockage predictions (sorted soonest-first).
 * @param departMs Driver departure time (ms epoch). Default now.
 * @param hitRadiusM Route passes within this of a crossing => it uses that crossing. Default 45m.
 * @param graceS Block window is expanded by this on both sides. Default 10s.
 */
export function findRouteConflicts(
  route: RouteInfo,
  predictions: BlockagePrediction[],
  departMs: number = Date.now(),
  hitRadiusM = 45,
  graceS = 10
): RouteConflict[] {
  const conflicts: RouteConflict[] = [];
  const durationMs = Math.max(0, route.expectedTravelTimeSeconds) * 1000;

  for (const p of predictions) {
    if (p.status === "cleared" || p.status === "unknown") continue;
    const { distanceM, fraction } = closestApproach(route.path, p.latitude, p.longitude);
    if (distanceM > hitRadiusM) continue;

    const driverArrivalMs = departMs + durationMs * fraction;
    const blockStartMs = Date.parse(p.blockStartUtc) - graceS * 1000;
    const blockEndMs = Date.parse(p.blockEndUtc) + graceS * 1000;

    // Driver arrives before the block starts (with margin) => no conflict.
    // Driver arrives after it clears => no conflict. While the acoustic length
    // is only provisional, blockEnd is a lower bound, so a later arrival is not
    // known to be clear and stays a conflict.
    if (driverArrivalMs < blockStartMs) continue;
    if (!p.lengthProvisional && driverArrivalMs > blockEndMs) continue;

    conflicts.push({
      crossingId: p.crossingId,
      roadName: p.roadName,
      latitude: p.latitude,
      longitude: p.longitude,
      driverArrivalMs: Math.round(driverArrivalMs),
      blockStartMs,
      blockEndMs,
      waitSeconds: Math.max(0, Math.round((blockEndMs - driverArrivalMs) / 1000)),
      missDistanceM: Math.round(distanceM),
    });
  }

  conflicts.sort((a, b) => a.driverArrivalMs - b.driverArrivalMs);
  return conflicts;
}

/** Score candidates; lowest effectiveSeconds wins. Unblocked routes sort first. */
export function scoreRouteCandidates(
  routes: RouteInfo[],
  predictions: BlockagePrediction[],
  departMs: number = Date.now()
): ScoredRoute[] {
  const scored = routes.map((route, index) => {
    const conflicts = findRouteConflicts(route, predictions, departMs);
    const totalWaitSeconds = conflicts.reduce((s, c) => s + c.waitSeconds, 0);
    const effectiveSeconds = route.expectedTravelTimeSeconds + totalWaitSeconds;
    return {
      route,
      index,
      conflicts,
      totalWaitSeconds,
      effectiveSeconds,
      blocked: conflicts.length > 0,
    } satisfies ScoredRoute;
  });
  scored.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    return a.effectiveSeconds - b.effectiveSeconds;
  });
  return scored;
}

/** Human-friendly "in 2 min" / "now" for a block start. */
export function formatBlockCountdown(blockStartMs: number, nowMs: number = Date.now()): string {
  const s = Math.round((blockStartMs - nowMs) / 1000);
  if (s <= 5) return "now";
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  return `in ${(m / 60).toFixed(1)} hr`;
}

/** "Lady St", "Lady St +1", "3 crossings". */
export function conflictRoadLabel(conflicts: RouteConflict[]): string {
  if (conflicts.length === 0) return "";
  if (conflicts.length === 1) return conflicts[0].roadName;
  if (conflicts.length === 2) return `${conflicts[0].roadName}, ${conflicts[1].roadName}`;
  return `${conflicts[0].roadName} +${conflicts.length - 1} more`;
}
