"use client";

import { useEffect, useMemo, useState } from "react";
import { SIMULATED_CROSSINGS } from "@/lib/crossings";
import {
  SAMPLE_OBSERVATION,
  parseTrainObservation,
  predictCrossingBlockages,
  type BlockagePrediction,
  type TrainObservation,
} from "@/lib/trains";
import { getRoutzApiUrl, postTrainObservation, type LiveStatus, type TrainStateEstimateEvent } from "@/lib/trainStream";

interface TrainPanelProps {
  observation: TrainObservation | null;
  estimate?: TrainStateEstimateEvent | null;
  predictions: BlockagePrediction[];
  onObservation: (obs: TrainObservation | null, predictions: BlockagePrediction[]) => void;
  liveStatus: LiveStatus;
}

function liveLabel(status: LiveStatus): string {
  switch (status) {
    case "connected":
      return "Live backend · connected";
    case "connecting":
      return "Live backend · connecting…";
    case "offline":
      return "Live backend · unreachable (local mode)";
    default:
      return "Local mode (no backend URL)";
  }
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatEta(etaSeconds: number): string {
  if (etaSeconds <= 0) return "now";
  if (etaSeconds < 60) return `${etaSeconds}s`;
  const m = Math.floor(etaSeconds / 60);
  const s = etaSeconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function statusStyle(status: BlockagePrediction["status"]): string {
  switch (status) {
    case "blocked_now":
    case "stopped_on_crossing":
      return "bg-[#B00020]/10 text-[#B00020]";
    case "blocked_soon":
      return "bg-[#E65100]/10 text-[#E65100]";
    case "upcoming":
      return "bg-[#007AFF]/10 text-[#007AFF]";
    default:
      return "bg-black/5 text-[#0B1B33]/50";
  }
}

function statusLabel(status: BlockagePrediction["status"]): string {
  switch (status) {
    case "blocked_now":
      return "BLOCKED NOW";
    case "stopped_on_crossing":
      return "STOPPED ON CROSSING";
    case "blocked_soon":
      return "CLOSING SOON";
    case "upcoming":
      return "UPCOMING";
    case "cleared":
      return "CLEARED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Demo ingestion panel for train observations.
 * Paste the JSON your inference team sends (or load the sample), and Routz
 * predicts per-road blockage windows. Simulated — not for dispatch.
 */
function sampleJson(observedAt: string): string {
  return JSON.stringify({ ...SAMPLE_OBSERVATION, observedAt }, null, 2);
}

export default function TrainPanel({ observation, estimate = null, predictions, onObservation, liveStatus }: TrainPanelProps) {
  const [open, setOpen] = useState(false);
  // Static initial text (prerender-safe); refreshed to "now" on the client.
  const [draft, setDraft] = useState(() => sampleJson("2026-10-10T00:00:00Z"));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const activeCount = useMemo(
    () => predictions.filter((p) => p.status !== "cleared" && p.status !== "unknown").length,
    [predictions]
  );

  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const staleLabel = useMemo(() => {
    if (!observation || now === null) return null;
    const ageS = (now - Date.parse(observation.observedAt)) / 1000;
    if (ageS < 90) return null;
    if (ageS < 3600) return `Observation is ${Math.round(ageS / 60)} min old — predictions are stale. Tap Sample for live data.`;
    return `Observation is ${(ageS / 3600).toFixed(1)} hr old — predictions are stale. Tap Sample for live data.`;
  }, [now, observation]);

  async function applyObservation(raw: string) {
    setError(null);
    setNotice(null);
    let obs: TrainObservation;
    try {
      obs = parseTrainObservation(JSON.parse(raw));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid observation JSON.");
      return;
    }
    // Prefer the backend (single source of truth + SSE fan-out); fall back
    // to identical local math when the backend is down or unconfigured.
    if (getRoutzApiUrl()) {
      setPosting(true);
      try {
        const env = await postTrainObservation(obs);
        onObservation(env.observation, env.predictions);
        if (env.stale) setNotice("Backend flagged this as older than the last observation.");
        return;
      } catch (err) {
        setNotice(
          `${err instanceof Error ? err.message : "Backend POST failed."} Computed locally instead.`
        );
      } finally {
        setPosting(false);
      }
    }
    onObservation(obs, predictCrossingBlockages(obs, SIMULATED_CROSSINGS));
  }

  function loadSample() {
    const sample = sampleJson(new Date().toISOString());
    setDraft(sample);
    applyObservation(sample);
  }

  function clear() {
    setError(null);
    onObservation(null, []);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-black/[0.06] bg-[#F7F9FC]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left active:bg-black/[0.03]"
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base ${
            observation ? "bg-[#007AFF]/10" : "bg-black/[0.06]"
          }`}
          aria-hidden
        >
          🚂
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold leading-tight text-[#0B1B33]">
            Train crossings {activeCount > 0 ? `· ${activeCount} affected` : "· none"}
          </span>
          <span className="block truncate text-[13px] text-[#0B1B33]/55">
            {observation
              ? `${observation.trainId} · ${(observation.speedMps * 2.23694).toFixed(0)} mph · acoustic estimate`
              : "Tap to simulate a train observation"}
          </span>
          <span className="block truncate text-[12px] text-[#0B1B33]/40">
            {liveLabel(liveStatus)}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          {observation && (
            <span className="rounded-full bg-[#7A5C00]/10 px-2 py-0.5 text-[11px] font-bold text-[#7A5C00]">
              {estimate ? "ACOUSTIC" : "SIM"}
            </span>
          )}
          <span className={`text-[#0B1B33]/40 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
            ▾
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-black/[0.06] px-4 py-3">
          <label htmlFor="train-json" className="text-[13px] font-semibold text-[#0B1B33]/70">
            Train observation JSON
          </label>
          <textarea
            id="train-json"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            spellCheck={false}
            className="mt-1.5 w-full rounded-lg border border-black/10 bg-white p-2.5 font-mono text-[12px] leading-5 text-[#0B1B33] focus:outline-none focus:ring-2 focus:ring-[#007AFF]"
          />
          {error && <p role="alert" className="mt-1.5 text-[13px] font-medium text-[#B00020]">{error}</p>}
          {notice && <p className="mt-1.5 text-[13px] text-[#0B1B33]/60">{notice}</p>}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => applyObservation(draft)}
              disabled={posting}
              className="flex h-10 flex-1 items-center justify-center rounded-lg bg-[#0B1B33] text-[14px] font-semibold text-white active:bg-[#13294F] disabled:opacity-60"
            >
              {posting ? "Sending…" : "Predict blockages"}
            </button>
            <button
              type="button"
              onClick={loadSample}
              className="flex h-10 items-center justify-center rounded-lg bg-[#007AFF]/10 px-3.5 text-[14px] font-semibold text-[#007AFF] active:bg-[#007AFF]/15"
            >
              Sample
            </button>
            {observation && (
              <button
                type="button"
                onClick={clear}
                className="flex h-10 items-center justify-center rounded-lg bg-black/[0.06] px-3.5 text-[14px] font-semibold text-[#0B1B33]/70 active:bg-black/10"
              >
                Clear
              </button>
            )}
          </div>

          {observation && (
            <div className="mt-3">
              {estimate && (
                <div className="mb-2 grid grid-cols-2 gap-1.5 rounded-lg bg-[#7C3AED]/[0.07] px-3 py-2 text-[12px] text-[#4C1D95]">
                  <span>Status: <strong>{estimate.status.replaceAll("_", " ")}</strong></span>
                  <span>Position confidence: <strong>{Math.round(estimate.confidence.position * 100)}%</strong></span>
                  <span>Position uncertainty: <strong>±{Math.round(estimate.uncertainty.position_m ?? 0)} m</strong></span>
                  <span>Direction: <strong>{estimate.direction_deg_from_east === null ? "—" : `${estimate.direction_deg_from_east.toFixed(0)}°`}</strong></span>
                  <span className="col-span-2">
                    Length: <strong>{estimate.length_m === null ? `${Math.round(estimate.provisional_length_m ?? 0)} m provisional` : `${Math.round(estimate.length_m)} m stable`}</strong>
                    {estimate.uncertainty.length_m !== null ? ` ±${Math.round(estimate.uncertainty.length_m)} m` : ""}
                  </span>
                  <span className="col-span-2 text-[#4C1D95]/70">Source: acoustic array · {estimate.label.replaceAll("_", " ")}</span>
                </div>
              )}
              {staleLabel && (
                <p role="alert" className="mb-2 rounded-lg bg-[#E65100]/10 px-3 py-2 text-[13px] font-medium text-[#9C3D00]">
                  ⚠️ {staleLabel}
                </p>
              )}
              <p className="text-[12px] font-bold uppercase tracking-wider text-[#0B1B33]/45">
                Predicted road blockages · simulated
              </p>
              {predictions.length === 0 ? (
                <p className="mt-1.5 text-[14px] text-[#0B1B33]/60">
                  No crossings ahead of this train within the prediction horizon.
                </p>
              ) : (
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {predictions.map((p) => (
                    <li
                      key={p.crossingId}
                      className="flex items-center gap-2.5 rounded-lg bg-white px-3 py-2 shadow-[0_1px_4px_rgba(11,27,51,0.06)]"
                    >
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                          p.status === "blocked_now" || p.status === "stopped_on_crossing"
                            ? "bg-[#B00020]"
                            : p.status === "blocked_soon"
                              ? "bg-[#E65100]"
                              : p.status === "cleared"
                                ? "bg-black/20"
                                : "bg-[#007AFF]"
                        }`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-semibold text-[#0B1B33]">
                          {p.roadName}
                          <span className="ml-1.5 font-normal text-[#0B1B33]/50">
                            {p.status === "blocked_now" || p.status === "stopped_on_crossing"
                              ? `blocked · clears ${formatClock(p.blockEndUtc)}`
                              : p.status === "cleared"
                                ? "cleared"
                                : `blocked ${formatEta(p.etaSeconds)} · ${formatClock(p.blockStartUtc)}–${formatClock(p.blockEndUtc)}`}
                          </span>
                        </span>
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${statusStyle(p.status)}`}>
                        {statusLabel(p.status)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
