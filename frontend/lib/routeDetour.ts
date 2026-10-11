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
import { scoreRouteCandidates } from "./routeCrossing";
import type { BlockagePrediction } from "./trains";

export interface DetourBypass {
  name: string;
  coordinate: RoutzCoordinate;
}

/**
 * Grade-separated Columbia corridors that cross or bypass the downtown rail
 * corridor without using the nearby at-grade crossing.
 */
export const COLUMBIA_BYPASS_WAYPOINTS: DetourBypass[] = [
  {
    name: "Gervais Street central bypass",
    coordinate: { latitude: 34.0018, longitude: -81.0205 },
  },
  {
    name: "Elmwood Avenue north bypass",
    coordinate: { latitude: 34.0178, longitude: -81.0265 },
  },
  {
    name: "Blossom Street south bypass",
    coordinate: { latitude: 33.9935, longitude: -81.0230 },
  },
  {
    name: "Huger Street west bypass",
    coordinate: { latitude: 34.0050, longitude: -81.0440 },
  },
];

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
        COLUMBIA_BYPASS_WAYPOINTS[0],
        COLUMBIA_BYPASS_WAYPOINTS[2],
        COLUMBIA_BYPASS_WAYPOINTS[1],
        COLUMBIA_BYPASS_WAYPOINTS[3],
      ];
  bypasses.forEach((bypass) => add(bypass.coordinate));

  // Finally try real FRA crossings outside the active blockage set.
  const blockedIds = new Set(
    predictions
      .filter(
        (prediction) =>
          prediction.status !== "cleared" && prediction.status !== "unknown"
      )
      .map((prediction) => prediction.crossingId)
  );
  FRA_CROSSINGS
    .filter((crossing) => !blockedIds.has(crossing.id))
    .forEach((crossing) => add({
      latitude: crossing.latitude,
      longitude: crossing.longitude,
    }));

  return waypoints;
}

/**
 * Return ordinary alternatives plus forced bypass routes when every ordinary
 * route conflicts with the train.
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
    return direct;
  }

  const attempts = findDetourWaypoints(
    origin,
    destination,
    predictions
  ).slice(0, 3);
  const detours = await Promise.all(
    attempts.map(async (waypoint) => {
      try {
        return await routeFetcher(origin, destination, false, [waypoint]);
      } catch {
        return [];
      }
    })
  );
  return [...direct, ...detours.flat()];
}
