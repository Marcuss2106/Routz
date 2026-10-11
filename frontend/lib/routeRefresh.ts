/**
 * Decide when a live train update should replace the driving route.
 *
 * WebSocket bursts are stored as one snapshot. A newer sequence wins. Google
 * is asked only when that snapshot is fresh and the train blocks every route
 * already on hand, so a late reply cannot draw a second line over the first.
 */

import type { RouteInfo } from "./googleMaps";
import {
  findRouteConflicts,
  scoreRouteCandidates,
  type RouteConflict,
} from "./routeCrossing";
import type { BlockagePrediction } from "./trains";

/** Observations older than this are not current. Matches the live-estimate window. */
export const TRAIN_SNAPSHOT_MAX_AGE_MS = 90_000;

export interface TrainUpdateClock {
  sourceId: string;
  sequence: number;
  simulationTimeS: number;
}

/** Last accepted train update used to judge the active driving route. */
export interface StoredTrainSnapshot extends TrainUpdateClock {
  /**
   * Wall-clock ms when this update was accepted.
   * The sockets carry a simulation clock, not a wall-clock send time, so this
   * is the arrival time of the newest packet we kept.
   */
  sentAtMs: number;
  predictions: BlockagePrediction[];
}

export type RerouteDecision =
  | { type: "keep" }
  | {
      type: "switch";
      route: RouteInfo;
      conflicts: RouteConflict[];
      wasRerouted: boolean;
    }
  | { type: "fetch" };

/**
 * Keep a packet only when it is newer than the stored one.
 * A restarted run (clock and sequence both jump backward) replaces the old run.
 */
export function shouldStoreTrainUpdate(
  previous: TrainUpdateClock | null,
  next: TrainUpdateClock
): boolean {
  if (!previous || next.sourceId !== previous.sourceId) return true;
  if (next.sequence > previous.sequence) return true;
  if (next.sequence === previous.sequence) {
    return next.simulationTimeS > previous.simulationTimeS;
  }
  return next.sequence < previous.sequence
    && next.simulationTimeS + 1 < previous.simulationTimeS;
}

export function snapshotIsFresh(snapshot: StoredTrainSnapshot, nowMs: number): boolean {
  return nowMs - snapshot.sentAtMs <= TRAIN_SNAPSHOT_MAX_AGE_MS;
}

/** Crossing ids the driver would actually meet, or "clear". */
export function routeBlockSignature(
  route: RouteInfo,
  predictions: BlockagePrediction[],
  nowMs: number
): string {
  const conflicts = findRouteConflicts(route, predictions, nowMs);
  if (conflicts.length === 0) return "clear";
  return conflicts.map((conflict) => conflict.crossingId).sort().join("|");
}

/** True when the stored snapshot is fresh and the route meets the train. */
export function trainIsInTheWay(
  route: RouteInfo,
  snapshot: StoredTrainSnapshot,
  nowMs: number
): boolean {
  if (!snapshotIsFresh(snapshot, nowMs)) return false;
  return findRouteConflicts(route, snapshot.predictions, nowMs).length > 0;
}

function fastestRoute(routes: RouteInfo[]): RouteInfo | null {
  if (routes.length === 0) return null;
  return [...routes].sort(
    (a, b) => a.expectedTravelTimeSeconds - b.expectedTravelTimeSeconds
  )[0];
}

/**
 * One decision per stored snapshot.
 * `fetch` means every route we already have is blocked, so Google may be asked once.
 */
export function decideReroute(input: {
  route: RouteInfo;
  candidates: RouteInfo[];
  snapshot: StoredTrainSnapshot | null;
  nowMs: number;
  requestInFlight: boolean;
  alreadyFetchedSignature: string;
}): RerouteDecision {
  const { route, candidates, snapshot, nowMs, requestInFlight, alreadyFetchedSignature } = input;
  if (!snapshot || !snapshotIsFresh(snapshot, nowMs)) return { type: "keep" };

  const pool = candidates.includes(route) ? candidates : [route, ...candidates];
  const fastest = fastestRoute(pool);
  const inTheWay = trainIsInTheWay(route, snapshot, nowMs);

  if (!inTheWay) {
    if (!fastest || fastest === route) return { type: "keep" };
    if (trainIsInTheWay(fastest, snapshot, nowMs)) return { type: "keep" };
    return {
      type: "switch",
      route: fastest,
      conflicts: [],
      wasRerouted: false,
    };
  }

  const open = scoreRouteCandidates(pool, snapshot.predictions, nowMs).find(
    (candidate) => !candidate.blocked && candidate.route !== route
  );
  if (open) {
    return {
      type: "switch",
      route: open.route,
      conflicts: open.conflicts,
      wasRerouted: Boolean(fastest && open.route !== fastest),
    };
  }

  if (requestInFlight) return { type: "keep" };
  const signature = routeBlockSignature(route, snapshot.predictions, nowMs);
  if (signature === "clear" || signature === alreadyFetchedSignature) return { type: "keep" };
  return { type: "fetch" };
}
