"use client";

import { useEffect, useMemo, useState } from "react";
import type { BlockagePrediction, TrainObservation } from "@/lib/trains";
import {
  type LiveStatus,
  type SimulationTrainState,
  type TrainStateEstimateEvent,
} from "@/lib/trainStream";

interface TrainPanelProps {
  observation: TrainObservation | null;
  estimate?: TrainStateEstimateEvent | null;
  simulationTrain?: SimulationTrainState | null;
  predictions: BlockagePrediction[];
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
      return "bg-[#A65353]/10 text-[#A65353]";
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

/** Live train and crossing-blockage summary. Simulated — not for dispatch. */
export default function TrainPanel({
  observation,
  estimate = null,
  simulationTrain = null,
  predictions,
  liveStatus,
}: TrainPanelProps) {
  const [open, setOpen] = useState(false);

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
    if (ageS < 3600) return `Observation is ${Math.round(ageS / 60)} min old — predictions are stale. Waiting for a fresh estimate.`;
    return `Observation is ${(ageS / 3600).toFixed(1)} hr old — predictions are stale. Waiting for a fresh estimate.`;
  }, [now, observation]);

  return (
    <div className="overflow-hidden rounded-xl border border-black/[0.06] bg-[#F7F9FC]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!observation}
        aria-expanded={open && Boolean(observation)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left active:bg-black/[0.03]"
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base ${
            observation ? "bg-[#A65353]/10" : "bg-black/[0.06]"
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
              ? `${observation.trainId} · ${(observation.speedMps * 2.23694).toFixed(0)} mph · ${simulationTrain ? simulationTrain.status : estimate ? "acoustic estimate" : "simulated"}`
              : "No train detected right now"}
          </span>
          <span className="block truncate text-[12px] text-[#0B1B33]/40">
            {liveLabel(liveStatus)}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          {observation && (
            <span className="rounded-full bg-[#7A5C00]/10 px-2 py-0.5 text-[11px] font-bold text-[#7A5C00]">
              {simulationTrain ? "LIVE SIM" : estimate ? "ACOUSTIC" : "SIM"}
            </span>
          )}
          {observation && (
            <span className={`text-[#0B1B33]/40 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
              ▾
            </span>
          )}
        </span>
      </button>

      {open && observation && (
        <div className="border-t border-black/[0.06] px-4 py-3">
          {observation && (
            <div>
              {estimate && (
                <div className="mb-2 grid grid-cols-2 gap-1.5 rounded-lg bg-[#7C3AED]/[0.07] px-3 py-2 text-[12px] text-[#4C1D95]">
                  <span>Status: <strong>{estimate.status.replaceAll("_", " ")}</strong></span>
                  <span>Position confidence: <strong>{Math.round(estimate.confidence.position * 100)}%</strong></span>
                  <span>Position uncertainty: <strong>±{Math.round(estimate.uncertainty.position_m ?? 0)} m</strong></span>
                  <span>Direction: <strong>{estimate.map_state?.direction_deg_from_east == null ? "—" : `${estimate.map_state.direction_deg_from_east.toFixed(0)}° from east`}</strong></span>
                  <span className="col-span-2">
                    Length: <strong>{estimate.map_state?.length_m != null ? `${Math.round(estimate.map_state.length_m)} m stable` : estimate.map_state?.provisional_length_m != null ? `${Math.round(estimate.map_state.provisional_length_m)} m provisional (clearing times are lower bounds)` : "pending"}</strong>
                  </span>
                  <span className="col-span-2 text-[#4C1D95]/70">Source: acoustic array · {estimate.label.replaceAll("_", " ")} · placed on a demo corridor, not a real train</span>
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
                                : "bg-[#A65353]"
                        }`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-semibold text-[#0B1B33]">
                          {p.roadName}
                          <span className="ml-1.5 font-normal text-[#0B1B33]/50">
                            {p.status === "blocked_now" || p.status === "stopped_on_crossing"
                              ? `blocked · clears ${p.lengthProvisional ? "no earlier than " : ""}${formatClock(p.blockEndUtc)}`
                              : p.status === "cleared"
                                ? "cleared"
                                : `blocked ${formatEta(p.etaSeconds)} · ${formatClock(p.blockStartUtc)}–${p.lengthProvisional ? "≥" : ""}${formatClock(p.blockEndUtc)}`}
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
