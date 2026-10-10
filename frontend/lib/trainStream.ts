"use client";

/**
 * Live train-prediction link between the Routz frontend and user-backend.
 *
 * - POST observations to `<ROUTZ_API_URL>/api/train-observations`
 * - Stream prediction envelopes from `<ROUTZ_API_URL>/api/events` (SSE)
 *
 * When no backend URL is configured the app falls back to local-only
 * prediction (see lib/trains.ts) so the demo still works offline.
 */

import { useEffect, useRef, useState } from "react";
import { parseTrainObservation, type BlockagePrediction, type TrainObservation } from "./trains";

export type LiveStatus = "disabled" | "connecting" | "connected" | "offline";

export interface PredictionEnvelope {
  type: "predictions";
  observation: TrainObservation;
  predictions: BlockagePrediction[];
  stale: boolean;
}

/** Backend base URL, e.g. http://localhost:8001. Empty = live mode disabled. */
export function getRoutzApiUrl(): string {
  return (process.env.NEXT_PUBLIC_ROUTZ_API_URL ?? "").trim().replace(/\/+$/, "");
}

/** Validate an SSE/POST envelope payload (throws on invalid). */
export function parseEnvelope(raw: unknown): PredictionEnvelope {
  if (typeof raw !== "object" || raw === null) throw new Error("Envelope must be an object.");
  const e = raw as Record<string, unknown>;
  const observation = parseTrainObservation(e.observation);
  const preds = Array.isArray(e.predictions) ? e.predictions : [];
  const predictions: BlockagePrediction[] = preds.map((p) => {
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
      trainId: String(o.trainId ?? observation.trainId),
      observedAt: String(o.observedAt ?? observation.observedAt),
    };
  });
  return {
    type: "predictions",
    observation,
    predictions,
    stale: Boolean(e.stale),
  };
}

/** POST an observation; the backend computes + broadcasts predictions. */
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

/**
 * Subscribe to the backend SSE stream. Calls onEnvelope for every
 * `predictions` event (including the connect-time snapshot).
 * Returns the connection status for UI display.
 */
export function useTrainStream(onEnvelope: (env: PredictionEnvelope) => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(() =>
    getRoutzApiUrl() ? "connecting" : "disabled"
  );
  const handlerRef = useRef(onEnvelope);
  handlerRef.current = onEnvelope;

  useEffect(() => {
    const base = getRoutzApiUrl();
    if (!base || typeof EventSource === "undefined") {
      setStatus(getRoutzApiUrl() ? "offline" : "disabled");
      return;
    }
    setStatus("connecting");
    const es = new EventSource(`${base}/api/events`);

    const onPredictions = (ev: MessageEvent) => {
      try {
        const env = parseEnvelope(JSON.parse(String(ev.data)));
        setStatus("connected");
        handlerRef.current(env);
      } catch {
        // Ignore malformed events; the next one will resync.
      }
    };
    const onHello = () => setStatus("connected");
    const onError = () => {
      // EventSource auto-reconnects; surface the dip so the UI can note it.
      setStatus((s) => (s === "connected" ? "connecting" : "offline"));
    };

    es.addEventListener("predictions", onPredictions as EventListener);
    es.addEventListener("hello", onHello as EventListener);
    es.addEventListener("error", onError);
    return () => {
      es.removeEventListener("predictions", onPredictions as EventListener);
      es.removeEventListener("hello", onHello as EventListener);
      es.removeEventListener("error", onError);
      es.close();
    };
  }, []);

  return status;
}
