"use client";

/**
 * Live train link between the Routz frontend and user backend.
 *
 * Live inference uses the canonical train_state_estimate WebSocket event.
 * The older observation POST remains available for the manual demo panel.
 */

import { useEffect, useRef, useState } from "react";
import type { Crossing } from "./crossings";
import { shouldStoreTrainUpdate, type TrainUpdateClock } from "./routeRefresh";
import {
  parseTrainObservation,
  type BlockagePrediction,
  type RailRoutePoint,
  type TrainObservation,
} from "./trains";

export type LiveStatus = "disabled" | "connecting" | "connected" | "offline";

export interface EstimateConfidence {
  position: number;
  speed: number;
  length: number;
  direction: number;
}

export interface EstimateUncertainty {
  position_m: number | null;
  speed_mps: number | null;
  length_m: number | null;
  direction_deg: number | null;
}

export type EstimateStatus = "detected" | "tracking" | "length_pending" | "cleared" | "unknown";

/** The acoustic estimate re-expressed on the demo map corridor (simulated). */
export interface MapState {
  anchor: string;
  label: "simulated_demo_anchor";
  position_reference: "front" | "center" | "rear";
  latitude: number;
  longitude: number;
  speed_mps: number | null;
  direction_deg_from_east: number | null;
  length_m: number | null;
  provisional_length_m: number | null;
}

export interface TrainStateEstimateEvent {
  type: "train_state_estimate";
  simulation_id: string;
  sequence: number;
  simulation_time_s: number;
  train_id: string;
  track_id: string;
  latitude: number | null;
  longitude: number | null;
  speed_mps: number | null;
  length_m: number | null;
  provisional_length_m: number | null;
  direction_deg_from_east: number | null;
  status: EstimateStatus;
  confidence: EstimateConfidence;
  uncertainty: EstimateUncertainty;
  source: "acoustic_array";
  label: "simulated_acoustic_estimate";
  track_position_m?: number | null;
  crossings: Array<{
    crossing_id: string;
    eta_seconds: number | null;
    estimated_blockage_seconds: number | null;
    status: "approaching" | "blocking" | "clear" | "unknown";
  }>;
  map_state: MapState | null;
  predictions: BlockagePrediction[];
}

export interface PredictionEnvelope {
  type: "predictions";
  observation: TrainObservation;
  predictions: BlockagePrediction[];
  stale: boolean;
}

export type SimulationTrainStatus = "running" | "paused" | "completed";

export interface SimulationVehiclePosition {
  id: string;
  distance_m: number;
  latitude: number;
  longitude: number;
  heading_deg: number;
}

/** Exact display state published by the railroad simulator on port 8000. */
export interface SimulationTrainState {
  type: "train_state";
  train_id: string;
  sequence: number;
  simulation_time_s: number;
  status: SimulationTrainStatus;
  route_id: string;
  distance_along_route_m: number;
  speed_mps: number;
  playback_speed: number;
  latitude: number;
  longitude: number;
  heading_deg: number;
  train_length_m: number;
  vehicles: SimulationVehiclePosition[];
}

/** Backend base URL. Empty = live mode disabled. */
export function getRoutzApiUrl(): string {
  return (
    process.env.NEXT_PUBLIC_ROUTZ_API_URL ?? process.env.NEXT_PUBLIC_USER_API_URL ?? ""
  ).trim().replace(/\/+$/, "");
}

export function getRoutzWsUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_ROUTZ_WS_URL ?? process.env.NEXT_PUBLIC_USER_WS_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (configured) return configured;
  const api = getRoutzApiUrl();
  if (!api) return "";
  return api.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:") + "/ws/updates";
}

/**
 * Railroad clock API. It is separate from the acoustic/user API on port 8002.
 * The localhost default applies only to development; a production build with
 * no configured URL returns "" so a deployed page never calls the viewer's own
 * localhost.
 */
export function getSimulationApiUrl(): string {
  const fallback = process.env.NODE_ENV === "production" ? "" : "http://localhost:8000";
  return (process.env.NEXT_PUBLIC_SIMULATION_API_URL ?? fallback)
    .trim()
    .replace(/\/+$/, "");
}

export function getSimulationWsUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_SIMULATION_WS_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (configured) return configured;
  const api = getSimulationApiUrl();
  if (!api) return "";
  return api.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:") + "/ws/simulation";
}

function finiteNumber(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`Simulation train has invalid ${field}.`);
  return result;
}

/** Validate the railroad simulator's canonical train_state event. */
export function parseSimulationTrainState(raw: unknown): SimulationTrainState {
  if (typeof raw !== "object" || raw === null) throw new Error("Simulation train must be an object.");
  const event = raw as Record<string, unknown>;
  if (event.type !== "train_state") throw new Error("Unsupported simulation event.");
  const status = String(event.status ?? "");
  if (status !== "running" && status !== "paused" && status !== "completed") {
    throw new Error("Simulation train has invalid status.");
  }
  const trainId = String(event.train_id ?? "").trim();
  if (!trainId) throw new Error("Simulation train is missing train_id.");
  const vehicles = Array.isArray(event.vehicles)
    ? event.vehicles.map((item) => {
        const vehicle = item as Record<string, unknown>;
        return {
          id: String(vehicle.id ?? "vehicle"),
          distance_m: finiteNumber(vehicle.distance_m, "vehicle distance"),
          latitude: finiteNumber(vehicle.latitude, "vehicle latitude"),
          longitude: finiteNumber(vehicle.longitude, "vehicle longitude"),
          heading_deg: finiteNumber(vehicle.heading_deg, "vehicle heading"),
        };
      })
    : [];
  return {
    type: "train_state",
    train_id: trainId,
    sequence: finiteNumber(event.sequence, "sequence"),
    simulation_time_s: finiteNumber(event.simulation_time_s, "simulation_time_s"),
    status,
    route_id: String(event.route_id ?? ""),
    distance_along_route_m: finiteNumber(event.distance_along_route_m, "distance_along_route_m"),
    speed_mps: Math.max(0, finiteNumber(event.speed_mps, "speed_mps")),
    playback_speed: Math.max(0, finiteNumber(event.playback_speed ?? 1, "playback_speed")),
    latitude: finiteNumber(event.latitude, "latitude"),
    longitude: finiteNumber(event.longitude, "longitude"),
    heading_deg: finiteNumber(event.heading_deg, "heading_deg"),
    train_length_m: Math.max(1, finiteNumber(event.train_length_m, "train_length_m")),
    vehicles,
  };
}

/** Convert compass heading (clockwise from north) to the map model's CCW-from-east heading. */
export function simulationStateToObservation(
  state: SimulationTrainState,
  observedAt: string = new Date().toISOString()
): TrainObservation {
  return parseTrainObservation({
    trainId: state.train_id,
    observedAt,
    lat: state.latitude,
    lon: state.longitude,
    speedMps: state.status === "running" ? state.speed_mps * state.playback_speed : 0,
    lengthM: state.train_length_m,
    degFromEast: 90 - state.heading_deg,
    positionReference: "front",
  });
}

function parsePredictions(raw: unknown, fallbackTrainId: string, fallbackObservedAt: string): BlockagePrediction[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const o = p as Record<string, unknown>;
    const blockStartUtc = String(o.blockStartUtc ?? "");
    const blockEndUtc = String(o.blockEndUtc ?? "");
    if (!blockStartUtc || Number.isNaN(Date.parse(blockStartUtc))) {
      throw new Error("Prediction has invalid blockStartUtc.");
    }
    if (!blockEndUtc || Number.isNaN(Date.parse(blockEndUtc))) {
      throw new Error("Prediction has invalid blockEndUtc.");
    }
    return {
      crossingId: String(o.crossingId ?? ""),
      roadName: String(o.roadName ?? "Unknown crossing"),
      latitude: Number(o.latitude),
      longitude: Number(o.longitude),
      blockStartUtc,
      blockEndUtc,
      etaSeconds: Number(o.etaSeconds ?? 0),
      clearSeconds: Number(o.clearSeconds ?? 0),
      distanceM: Number(o.distanceM ?? 0),
      lateralM: Number(o.lateralM ?? 0),
      status: String(o.status ?? "unknown") as BlockagePrediction["status"],
      trainId: String(o.trainId ?? fallbackTrainId),
      observedAt: String(o.observedAt ?? fallbackObservedAt),
      lengthProvisional: Boolean(o.lengthProvisional),
    };
  });
}

/** Validate the retained manual REST envelope. */
export function parseEnvelope(raw: unknown): PredictionEnvelope {
  if (typeof raw !== "object" || raw === null) throw new Error("Envelope must be an object.");
  const e = raw as Record<string, unknown>;
  const observation = parseTrainObservation(e.observation);
  return {
    type: "predictions",
    observation,
    predictions: parsePredictions(e.predictions, observation.trainId, observation.observedAt),
    stale: Boolean(e.stale),
  };
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseMapState(raw: unknown): MapState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const latitude = Number(m.latitude);
  const longitude = Number(m.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const reference = String(m.position_reference ?? "front");
  return {
    anchor: String(m.anchor ?? ""),
    label: "simulated_demo_anchor",
    position_reference:
      reference === "center" || reference === "rear" ? reference : "front",
    latitude,
    longitude,
    speed_mps: numberOrNull(m.speed_mps),
    direction_deg_from_east: numberOrNull(m.direction_deg_from_east),
    length_m: numberOrNull(m.length_m),
    provisional_length_m: numberOrNull(m.provisional_length_m),
  };
}

/** Validate the one canonical event used by the acoustic map. */
export function parseTrainStateEstimate(raw: unknown): TrainStateEstimateEvent {
  if (typeof raw !== "object" || raw === null) throw new Error("Estimate must be an object.");
  const e = raw as Record<string, unknown>;
  if (e.type !== "train_state_estimate") throw new Error("Unsupported live event.");
  const confidence = e.confidence as Record<string, unknown>;
  const uncertainty = e.uncertainty as Record<string, unknown>;
  if (!confidence || !uncertainty) throw new Error("Estimate confidence is missing.");
  const simulationId = String(e.simulation_id ?? "");
  const trainId = String(e.train_id ?? "");
  if (!simulationId || !trainId) throw new Error("Estimate identity is missing.");
  const observedAt = new Date().toISOString();
  return {
    type: "train_state_estimate",
    simulation_id: simulationId,
    sequence: Number(e.sequence ?? 0),
    simulation_time_s: Number(e.simulation_time_s ?? 0),
    train_id: trainId,
    track_id: String(e.track_id ?? ""),
    latitude: numberOrNull(e.latitude),
    longitude: numberOrNull(e.longitude),
    speed_mps: numberOrNull(e.speed_mps),
    length_m: numberOrNull(e.length_m),
    provisional_length_m: numberOrNull(e.provisional_length_m),
    direction_deg_from_east: numberOrNull(e.direction_deg_from_east),
    status: String(e.status ?? "unknown") as EstimateStatus,
    confidence: {
      position: Number(confidence.position ?? 0),
      speed: Number(confidence.speed ?? 0),
      length: Number(confidence.length ?? 0),
      direction: Number(confidence.direction ?? 0),
    },
    uncertainty: {
      position_m: numberOrNull(uncertainty.position_m),
      speed_mps: numberOrNull(uncertainty.speed_mps),
      length_m: numberOrNull(uncertainty.length_m),
      direction_deg: numberOrNull(uncertainty.direction_deg),
    },
    source: "acoustic_array",
    label: "simulated_acoustic_estimate",
    track_position_m: numberOrNull(e.track_position_m),
    crossings: Array.isArray(e.crossings) ? (e.crossings as TrainStateEstimateEvent["crossings"]) : [],
    map_state: parseMapState(e.map_state),
    predictions: parsePredictions(e.predictions, trainId, observedAt),
  };
}

/**
 * Convert a rich estimate into the map/panel observation shape.
 *
 * The raw acoustic latitude/longitude live on the acoustic demo rail, which is
 * not on the real map. The user backend publishes `map_state` after applying
 * its documented demo anchor, so that is what the map draws. While the length
 * is unknown the marker uses a 1 m placeholder; no prediction depends on it,
 * because predictions come from the user backend.
 */
export function estimateToObservation(event: TrainStateEstimateEvent): TrainObservation | null {
  const map = event.map_state;
  if (
    !map ||
    map.speed_mps === null ||
    map.direction_deg_from_east === null
  ) {
    return null;
  }
  const length = map.length_m ?? map.provisional_length_m ?? 1;
  return parseTrainObservation({
    trainId: event.train_id,
    observedAt: new Date().toISOString(),
    lat: map.latitude,
    lon: map.longitude,
    speedMps: map.speed_mps,
    lengthM: Math.max(1, length),
    degFromEast: map.direction_deg_from_east,
    positionReference: map.position_reference,
  });
}

/** POST an observation for the manual compatibility panel. */
export async function postTrainObservation(obs: TrainObservation): Promise<PredictionEnvelope> {
  const base = getRoutzApiUrl();
  if (!base) throw new Error("Live backend not configured.");
  const res = await fetch(`${base}/api/train-observations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Backend rejected observation (HTTP ${res.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
  return parseEnvelope(await res.json());
}

/** Subscribe to canonical acoustic estimates over WebSocket. */
export function useTrainStream(onEstimate: (event: TrainStateEstimateEvent | null) => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(() =>
    getRoutzApiUrl() ? "connecting" : "disabled"
  );
  const handlerRef = useRef(onEstimate);
  useEffect(() => {
    handlerRef.current = onEstimate;
  }, [onEstimate]);

  useEffect(() => {
    const url = getRoutzWsUrl();
    if (!url || typeof WebSocket === "undefined") {
      return;
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let lastClock: TrainUpdateClock | null = null;

    const connect = () => {
      if (stopped) return;
      setStatus("connecting");
      socket = new WebSocket(url);
      socket.onopen = () => setStatus("connected");
      socket.onmessage = (message) => {
        try {
          const raw = JSON.parse(String(message.data)) as Record<string, unknown>;
          if (raw.type === "simulation_reset") {
            lastClock = null;
            handlerRef.current(null);
            return;
          }
          if (raw.type !== "train_state_estimate") return;
          const estimate = parseTrainStateEstimate(raw);
          const clock = {
            sourceId: `${estimate.simulation_id}:${estimate.train_id}`,
            sequence: estimate.sequence,
            simulationTimeS: estimate.simulation_time_s,
          };
          if (!shouldStoreTrainUpdate(lastClock, clock)) return;
          lastClock = clock;
          handlerRef.current(estimate);
        } catch {
          // Ignore malformed events; the reconnect snapshot resynchronizes state.
        }
      };
      socket.onerror = () => setStatus("offline");
      socket.onclose = () => {
        if (stopped) return;
        setStatus("offline");
        reconnectTimer = setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return status;
}

/**
 * Subscribe directly to the real railroad simulation clock.
 *
 * A REST snapshot is loaded first so a paused/completed train is visible even
 * before the WebSocket connects. Disconnects deliberately retain the last
 * valid state instead of making a stationary train disappear.
 */
export function useSimulationTrainStream(
  onState: (state: SimulationTrainState) => void,
  onCrossings?: (crossings: Crossing[]) => void,
  onRoute?: (route: RailRoutePoint[]) => void
): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const handlerRef = useRef(onState);
  const crossingsHandlerRef = useRef(onCrossings);
  const routeHandlerRef = useRef(onRoute);
  useEffect(() => {
    handlerRef.current = onState;
  }, [onState]);
  useEffect(() => {
    crossingsHandlerRef.current = onCrossings;
  }, [onCrossings]);
  useEffect(() => {
    routeHandlerRef.current = onRoute;
  }, [onRoute]);

  useEffect(() => {
    const apiUrl = getSimulationApiUrl();
    const wsUrl = getSimulationWsUrl();
    if (!apiUrl || !wsUrl) {
      // Railroad clock is not configured for this build; stay offline.
      setStatus("offline");
      return;
    }
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let lastClock: TrainUpdateClock | null = null;

    const accept = (raw: unknown) => {
      try {
        const state = parseSimulationTrainState(raw);
        const clock = {
          sourceId: state.train_id,
          sequence: state.sequence,
          simulationTimeS: state.simulation_time_s,
        };
        if (!shouldStoreTrainUpdate(lastClock, clock)) return;
        lastClock = clock;
        handlerRef.current(state);
      } catch {
        // A later valid snapshot will resynchronize the display.
      }
    };

    void fetch(`${apiUrl}/api/train`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((raw) => {
        if (!stopped) accept(raw);
      })
      .catch(() => {
        if (!stopped) setStatus("offline");
      });

    void fetch(`${apiUrl}/api/railroad`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((raw) => {
        if (stopped || typeof raw !== "object" || raw === null) return;
        const railroad = raw as Record<string, unknown>;
        const route = railroad.route;
        if (typeof route === "object" && route !== null) {
          const routePoints = (route as Record<string, unknown>).points_wgs84;
          if (Array.isArray(routePoints)) {
            const parsedRoute = routePoints.flatMap((item): RailRoutePoint[] => {
              if (typeof item !== "object" || item === null) return [];
              const point = item as Record<string, unknown>;
              const latitude = Number(point.latitude);
              const longitude = Number(point.longitude);
              return Number.isFinite(latitude) && Number.isFinite(longitude)
                ? [{ latitude, longitude }]
                : [];
            });
            if (parsedRoute.length > 1) routeHandlerRef.current?.(parsedRoute);
          }
        }
        const values = railroad.crossings;
        if (!Array.isArray(values)) return;
        const crossings = values.flatMap((item): Crossing[] => {
          if (typeof item !== "object" || item === null) return [];
          const crossing = item as Record<string, unknown>;
          const latitude = Number(crossing.latitude);
          const longitude = Number(crossing.longitude);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
          const id = String(crossing.id ?? `${latitude},${longitude}`);
          return [{
            id,
            dotId: id,
            roadName: String(crossing.name ?? "Rail crossing"),
            latitude,
            longitude,
            railroad: "Simulation railroad network",
          }];
        });
        if (crossings.length > 0) crossingsHandlerRef.current?.(crossings);
      })
      .catch(() => {
        // The curated crossing list remains available when network metadata fails.
      });

    const connect = () => {
      if (stopped || typeof WebSocket === "undefined") return;
      setStatus("connecting");
      socket = new WebSocket(wsUrl);
      socket.onopen = () => setStatus("connected");
      socket.onmessage = (message) => {
        try {
          accept(JSON.parse(String(message.data)));
        } catch {
          // Ignore malformed JSON and retain the last good train position.
        }
      };
      socket.onerror = () => setStatus("offline");
      socket.onclose = () => {
        if (stopped) return;
        setStatus("offline");
        reconnectTimer = setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return status;
}
