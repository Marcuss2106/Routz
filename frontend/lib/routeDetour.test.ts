import assert from "node:assert/strict";
import test from "node:test";
import type { PlaceResult, RouteInfo } from "./googleMaps";
import {
  COLUMBIA_BYPASS_WAYPOINTS,
  getCrossingAwareCandidates,
} from "./routeDetour";
import type { BlockagePrediction } from "./trains";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const origin: PlaceResult = {
  id: "origin",
  name: "Swearingen Engineering Center",
  formattedAddress: "301 Main Street, Columbia, SC",
  coordinate: { latitude: 33.98924, longitude: -81.02982 },
};
const destination: PlaceResult = {
  id: "destination",
  name: "Hospital",
  formattedAddress: "5 Medical Park Drive, Columbia, SC",
  coordinate: { latitude: 34.029, longitude: -81.026 },
};

function route(name: string, latitude: number, seconds: number): RouteInfo {
  return {
    name,
    distanceMeters: 2000,
    expectedTravelTimeSeconds: seconds,
    path: [
      { latitude: latitude - 0.002, longitude: -81.0225 },
      { latitude, longitude: -81.0225 },
      { latitude: latitude + 0.002, longitude: -81.0225 },
    ],
    steps: [],
  };
}

const blocked: BlockagePrediction = {
  crossingId: "hampton",
  roadName: "Hampton Street",
  latitude: 34.0092,
  longitude: -81.0225,
  blockStartUtc: new Date(NOW - 60_000).toISOString(),
  blockEndUtc: new Date(NOW + 600_000).toISOString(),
  etaSeconds: -60,
  clearSeconds: 600,
  distanceM: 0,
  lateralM: 0,
  status: "blocked_now",
  trainId: "train-1",
  observedAt: new Date(NOW).toISOString(),
};

test("requests grade-separated detours when all direct routes meet the train", async () => {
  const direct = route("blocked direct", blocked.latitude, 300);
  const detour = route("clear detour", 34.02, 420);
  const requestedWaypoints: Array<{ latitude: number; longitude: number }> = [];

  const result = await getCrossingAwareCandidates(
    origin,
    destination,
    [blocked],
    NOW,
    async (_origin, _destination, alternatives, intermediates = []) => {
      if (alternatives) return [direct];
      requestedWaypoints.push(...intermediates);
      return [detour];
    }
  );

  assert.equal(result[0], direct);
  assert.ok(result.includes(detour));
  assert.equal(requestedWaypoints.length, 3);
  assert.deepEqual(
    requestedWaypoints[0],
    COLUMBIA_BYPASS_WAYPOINTS[0].coordinate
  );
});

test("does not spend extra route requests when an ordinary route is clear", async () => {
  const clear = route("clear direct", 34.02, 300);
  let calls = 0;
  const result = await getCrossingAwareCandidates(
    origin,
    destination,
    [blocked],
    NOW,
    async () => {
      calls += 1;
      return [clear];
    }
  );

  assert.deepEqual(result, [clear]);
  assert.equal(calls, 1);
});
