import assert from "node:assert/strict";
import test from "node:test";
import type { RouteInfo } from "./googleMaps";
import {
  decideReroute,
  routeBlockSignature,
  shouldStoreTrainUpdate,
  trainIsInTheWay,
  TRAIN_SNAPSHOT_MAX_AGE_MS,
  type StoredTrainSnapshot,
} from "./routeRefresh";
import type { BlockagePrediction } from "./trains";

const NOW = Date.parse("2026-10-11T12:00:00Z");

function route(id: string, latitude: number, seconds: number): RouteInfo {
  return {
    distanceMeters: 1000,
    expectedTravelTimeSeconds: seconds,
    path: [
      { latitude, longitude: -81.03 },
      { latitude: latitude + 0.002, longitude: -81.03 },
    ],
    steps: [],
    name: id,
  };
}

function blockage(crossingId: string, latitude: number, inTheWay: boolean): BlockagePrediction {
  const start = inTheWay ? NOW - 60_000 : NOW + 60 * 60_000;
  return {
    crossingId,
    roadName: crossingId,
    latitude,
    longitude: -81.03,
    blockStartUtc: new Date(start).toISOString(),
    blockEndUtc: new Date(start + 10 * 60_000).toISOString(),
    etaSeconds: inTheWay ? -60 : 3600,
    clearSeconds: inTheWay ? 540 : 4200,
    distanceM: inTheWay ? 20 : 5000,
    lateralM: 0,
    status: inTheWay ? "blocked_now" : "upcoming",
    trainId: "train-1",
    observedAt: new Date(NOW).toISOString(),
  };
}

function snapshot(predictions: BlockagePrediction[], sentAtMs = NOW): StoredTrainSnapshot {
  return {
    sourceId: "train-1",
    sequence: 4,
    simulationTimeS: 12,
    sentAtMs,
    predictions,
  };
}

test("stores a newer train packet and drops an older one", () => {
  const first = { sourceId: "train-1", sequence: 5, simulationTimeS: 10 };
  assert.equal(shouldStoreTrainUpdate(null, first), true);
  assert.equal(
    shouldStoreTrainUpdate(first, { sourceId: "train-1", sequence: 4, simulationTimeS: 9 }),
    false
  );
  assert.equal(
    shouldStoreTrainUpdate(first, { sourceId: "train-1", sequence: 5, simulationTimeS: 10 }),
    false
  );
  assert.equal(
    shouldStoreTrainUpdate(first, { sourceId: "train-1", sequence: 6, simulationTimeS: 11 }),
    true
  );
  assert.equal(
    shouldStoreTrainUpdate(first, { sourceId: "train-1", sequence: 0, simulationTimeS: 0 }),
    true
  );
});

test("a stale snapshot is not treated as the train being in the way", () => {
  const blocked = route("main", 34.0, 100);
  const stored = snapshot([blockage("hampton", 34.001, true)], NOW - TRAIN_SNAPSHOT_MAX_AGE_MS - 1);
  assert.equal(trainIsInTheWay(blocked, stored, NOW), false);
  assert.equal(
    decideReroute({
      route: blocked,
      candidates: [blocked],
      snapshot: stored,
      nowMs: NOW,
      requestInFlight: false,
      alreadyFetchedSignature: "",
    }).type,
    "keep"
  );
});

test("asks Google once when the stored train blocks every current route", () => {
  const blocked = route("main", 34.0, 100);
  const stored = snapshot([blockage("hampton", 34.001, true)]);
  assert.equal(trainIsInTheWay(blocked, stored, NOW), true);
  assert.equal(routeBlockSignature(blocked, stored.predictions, NOW), "hampton");
  assert.equal(
    decideReroute({
      route: blocked,
      candidates: [blocked],
      snapshot: stored,
      nowMs: NOW,
      requestInFlight: false,
      alreadyFetchedSignature: "",
    }).type,
    "fetch"
  );
  assert.equal(
    decideReroute({
      route: blocked,
      candidates: [blocked],
      snapshot: stored,
      nowMs: NOW,
      requestInFlight: true,
      alreadyFetchedSignature: "",
    }).type,
    "keep"
  );
  assert.equal(
    decideReroute({
      route: blocked,
      candidates: [blocked],
      snapshot: stored,
      nowMs: NOW,
      requestInFlight: false,
      alreadyFetchedSignature: "hampton",
    }).type,
    "keep"
  );
});

test("switches to a stored clear route instead of requesting another", () => {
  const blocked = route("main", 34.0, 100);
  const open = route("detour", 34.05, 180);
  const decision = decideReroute({
    route: blocked,
    candidates: [blocked, open],
    snapshot: snapshot([blockage("hampton", 34.001, true)]),
    nowMs: NOW,
    requestInFlight: false,
    alreadyFetchedSignature: "",
  });
  assert.equal(decision.type, "switch");
  if (decision.type === "switch") {
    assert.equal(decision.route, open);
    assert.equal(decision.wasRerouted, true);
  }
});
