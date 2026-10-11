"use client";

/**
 * Live train link between the Routz frontend and user backend.
 *
 * Live inference uses the canonical train_state_estimate WebSocket event.
 * The older observation POST remains available for the manual demo panel.
 */

import { useEffect, useRef, useState } from "react";
import { parseTrainObservation, type BlockagePrediction, type TrainObservation } from "./trains";

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
  predictions: BlockagePrediction[];
}

export interface PredictionEnvelope {
  type: "predictions";
  observation: TrainObservation;
  predictions: BlockagePrediction[];
  stale: boolean;
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
    predictions: parsePredictions(e.predictions, trainId, observedAt),
  };
}

/** Convert a rich estimate into the old map/panel observation shape. */
export function estimateToObservation(event: TrainStateEstimateEvent): TrainObservation | null {
  if (
    event.latitude === null ||
    event.longitude === null ||
    event.speed_mps === null ||
    event.direction_deg_from_east === null
  ) {
    return null;
  }
  const length = event.length_m ?? event.provisional_length_m ?? 1;
  return parseTrainObservation({
    trainId: event.train_id,
    observedAt: new Date().toISOString(),
    lat: event.latitude,
    lon: event.longitude,
    speedMps: event.speed_mps,
    lengthM: Math.max(1, length),
    degFromEast: event.direction_deg_from_east,
    positionReference: "center",
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

    const connect = () => {
      if (stopped) return;
      setStatus("connecting");
      socket = new WebSocket(url);
      socket.onopen = () => setStatus("connected");
      socket.onmessage = (message) => {
        try {
          const raw = JSON.parse(String(message.data)) as Record<string, unknown>;
          if (raw.type === "simulation_reset") {
            handlerRef.current(null);
            return;
          }
          if (raw.type !== "train_state_estimate") return;
          handlerRef.current(parseTrainStateEstimate(raw));
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
