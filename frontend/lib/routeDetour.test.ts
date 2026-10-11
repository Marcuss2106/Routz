import assert from "node:assert/strict";
import test from "node:test";
import type { PlaceResult, RouteInfo } from "./googleMaps";
import {
  COLUMBIA_BYPASS_WAYPOINTS,
  blockedCrossingSignature,
  dedupeByBlockageSignature,
  getCrossingAwareCandidates,
  routeAvoidsActiveBlockages,
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

function route(name: string, latitude: number, seconds: number, lon = -81.0225): RouteInfo {
  return {
    name,
    distanceMeters: 2000,
    expectedTravelTimeSeconds: seconds,
    path: [
      { latitude: latitude - 0.002, longitude: lon },
      { latitude, longitude: lon },
      { latitude: latitude + 0.002, longitude: lon },
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

test("bypass waypoints sit west of the downtown FRA corridor", () => {
  for (const bypass of COLUMBIA_BYPASS_WAYPOINTS) {
    assert.ok(
      bypass.coordinate.longitude < -81.03,
      `${bypass.name} must sit west of the at-grade corridor`
    );
  }
});

test("same blocked crossings with a longer ETA are treated as just slower", () => {
  const fastBlocked = route("fast blocked", blocked.latitude, 300);
  const slowBlocked = route("slow blocked", blocked.latitude, 480);
  assert.equal(
    blockedCrossingSignature(fastBlocked, [blocked], NOW),
    blockedCrossingSignature(slowBlocked, [blocked], NOW)
  );
  assert.equal(routeAvoidsActiveBlockages(fastBlocked, [blocked], NOW), false);
  const unique = dedupeByBlockageSignature(
    [fastBlocked, slowBlocked],
    [blocked],
    NOW
  );
  assert.deepEqual(unique, [fastBlocked]);
});

test("requests west-side detours when all direct routes meet the train", async () => {
  const direct = route("blocked direct", blocked.latitude, 300);
  const detour = route("clear detour", 34.02, 420, -81.043);
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

  assert.ok(result.every((candidate) => routeAvoidsActiveBlockages(candidate, [blocked], NOW)));
  assert.ok(result.includes(detour));
  assert.ok(requestedWaypoints.length >= 3);
  assert.ok(requestedWaypoints.every((point) => point.longitude < -81.03));
});

test("does not spend extra route requests when an ordinary route is clear", async () => {
  const clear = route("clear direct", 34.02, 300, -81.043);
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
