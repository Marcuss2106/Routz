import assert from "node:assert/strict";
import test from "node:test";
import type { PlaceResult, RouteInfo } from "./googleMaps";
import {
  COLUMBIA_BYPASS_WAYPOINTS,
  findDetourWaypoints,
  getCrossingAwareCandidates,
} from "./routeDetour";
import type { BlockagePrediction } from "./trains";

const NOW = Date.parse("2026-10-11T12:00:00Z");

const originPlace: PlaceResult = {
  id: "origin",
  name: "Swearingen Engineering Center",
  formattedAddress: "301 Main St, Columbia, SC",
  coordinate: { latitude: 33.98924, longitude: -81.02982 },
};

const destinationNorth: PlaceResult = {
  id: "dest-north",
  name: "Prisma Health Richland Hospital",
  formattedAddress: "5 Medical Park Dr, Columbia, SC",
  coordinate: { latitude: 34.0290, longitude: -81.0260 },
};

const destinationSouth: PlaceResult = {
  id: "dest-south",
  name: "Williams-Brice Stadium",
  formattedAddress: "1125 George Rogers Blvd, Columbia, SC",
  coordinate: { latitude: 33.9731, longitude: -81.0191 },
};

function blockedPrediction(crossingId: string, latitude: number, status: BlockagePrediction["status"] = "blocked_now"): BlockagePrediction {
  return {
    crossingId,
    roadName: crossingId,
    latitude,
    longitude: -81.0225,
    blockStartUtc: new Date(NOW - 60_000).toISOString(),
    blockEndUtc: new Date(NOW + 600_000).toISOString(),
    etaSeconds: status === "cleared" ? -500 : -60,
    clearSeconds: status === "cleared" ? -100 : 540,
    distanceM: status === "cleared" ? -200 : 20,
    lateralM: 0,
    status,
    trainId: "train-1",
    observedAt: new Date(NOW).toISOString(),
  };
}

function mockRoute(id: string, pathLats: number[], seconds = 300): RouteInfo {
  return {
    distanceMeters: 2000,
    expectedTravelTimeSeconds: seconds,
    path: pathLats.map((lat) => ({ latitude: lat, longitude: -81.0225 })),
    steps: [],
    name: id,
  };
}

test("findDetourWaypoints prioritizes cleared crossings when available", () => {
  const predictions: BlockagePrediction[] = [
    blockedPrediction("715871K", 34.0092, "blocked_now"),
    blockedPrediction("715869J", 33.9996, "cleared"),
  ];

  const waypoints = findDetourWaypoints(originPlace, destinationNorth, predictions);
  assert.ok(waypoints.length > 0);
  // The first waypoint should be the cleared crossing
  assert.equal(waypoints[0].latitude, 33.9996);
});

test("findDetourWaypoints includes grade-separated bypasses (Gervais, Elmwood, Blossom)", () => {
  const predictions: BlockagePrediction[] = [
    blockedPrediction("715871K", 34.0092, "blocked_now"),
  ];

  const waypoints = findDetourWaypoints(originPlace, destinationNorth, predictions);
  // Checks that Elmwood and Gervais are in the candidate waypoints
  const hasGervais = waypoints.some((wp) =>
    Math.abs(wp.latitude - COLUMBIA_BYPASS_WAYPOINTS[0].coordinate.latitude) < 0.001
  );
  const hasElmwood = waypoints.some((wp) =>
    Math.abs(wp.latitude - COLUMBIA_BYPASS_WAYPOINTS[1].coordinate.latitude) < 0.001
  );
  assert.ok(hasGervais);
  assert.ok(hasElmwood);
});

test("findDetourWaypoints ranks waypoints by travel heading", () => {
  const predictions: BlockagePrediction[] = [
    blockedPrediction("715871K", 34.0092, "blocked_now"),
  ];

  const northWaypoints = findDetourWaypoints(originPlace, destinationNorth, predictions);
  const southWaypoints = findDetourWaypoints(originPlace, destinationSouth, predictions);

  // For northbound travel, Elmwood Ave (North bypass ~34.0178) is ordered before Blossom St (~33.9935)
  const northElmwoodIdx = northWaypoints.findIndex((wp) => Math.abs(wp.latitude - 34.0178) < 0.001);
  const northBlossomIdx = northWaypoints.findIndex((wp) => Math.abs(wp.latitude - 33.9935) < 0.001);
  assert.ok(northElmwoodIdx < northBlossomIdx);

  // For southbound travel, Blossom St is ordered before Elmwood Ave
  const southBlossomIdx = southWaypoints.findIndex((wp) => Math.abs(wp.latitude - 33.9935) < 0.001);
  const southElmwoodIdx = southWaypoints.findIndex((wp) => Math.abs(wp.latitude - 34.0178) < 0.001);
  assert.ok(southBlossomIdx < southElmwoodIdx);
});

test("getCrossingAwareCandidates returns direct routes if no predictions exist", async () => {
  const directRoute = mockRoute("direct", [33.99, 34.01]);
  const mockFetcher = async () => [directRoute];

  const result = await getCrossingAwareCandidates(
    originPlace,
    destinationNorth,
    [],
    NOW,
    mockFetcher
  );
  assert.deepEqual(result, [directRoute]);
});

test("getCrossingAwareCandidates fetches detour routes when direct route is blocked", async () => {
  // Direct route passes right through blocked Hampton St (34.0092)
  const blockedDirect = mockRoute("blocked-direct", [34.00, 34.0092, 34.02], 300);
  // Detour route passes through Gervais St (34.0018) and avoids Hampton St
  const clearDetour = mockRoute("clear-detour", [34.00, 34.0018, 34.025], 400);

  const predictions: BlockagePrediction[] = [
    blockedPrediction("715871K", 34.0092, "blocked_now"),
  ];

  const mockFetcher = async (
    _orig: PlaceResult,
    _dest: PlaceResult,
    alternatives: boolean,
    intermediates?: Array<{ latitude: number; longitude: number }>
  ) => {
    if (alternatives) {
      return [blockedDirect];
    }
    if (intermediates && intermediates.length > 0) {
      return [clearDetour];
    }
    return [];
  };

  const candidates = await getCrossingAwareCandidates(
    originPlace,
    destinationNorth,
    predictions,
    NOW,
    mockFetcher
  );

  // Returned candidates should include both direct and detour routes
  assert.equal(candidates.length, 4); // 1 direct + 3 detour waypoints tried
  const detourCandidate = candidates.find((c) => c.name === "clear-detour");
  assert.ok(detourCandidate);
});
