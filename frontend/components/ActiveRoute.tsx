"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import { SpeakerIcon, VoiceAlert, useVoiceGuidance } from "@/components/VoiceGuidance";
import type { PlaceResult, RouteInfo, RouteStep } from "@/lib/googleMaps";
import { conflictRoadLabel, type RouteConflict } from "@/lib/routeCrossing";
import { registerStepSpeech } from "@/lib/voice";

interface ActiveRouteProps {
  route: RouteInfo;
  destination: PlaceResult;
  onEnd: () => void;
  barRef: Ref<HTMLDivElement>;
  /** Conflicts between the chosen route and predicted blockages (simulated). */
  conflicts?: RouteConflict[];
  /** True when we picked an alternate to avoid a blockage. */
  wasRerouted?: boolean;
  /** Number of candidates Google returned. */
  candidateCount?: number;
}

/** Navigation chrome shown once a driving route is selected. */
export default function ActiveRoute({
  route,
  destination,
  onEnd,
  barRef,
  conflicts = [],
  wasRerouted = false,
  candidateCount = 1,
}: ActiveRouteProps) {
  const step = route.steps[0];
  const upcoming = route.steps[1];
  const voice = useVoiceGuidance();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const instruction = step?.instruction ?? `Head toward ${destination.name}`;
  const detail =
    step?.detail ||
    continuationLine(upcoming) ||
    `Toward ${destination.name}`;
  const distanceLabel = formatBannerDistance(
    step?.distanceMeters || route.distanceMeters
  );
  const totalWait = conflicts.reduce((s, c) => s + c.waitSeconds, 0);
  const effectiveSeconds = route.expectedTravelTimeSeconds + totalWait;
  const durationLabel = formatTripDuration(effectiveSeconds);
  const distanceLabelTotal = formatTripDistance(route.distanceMeters);
  const arrival = now === null ? "—" : new Date(
    now + Math.max(0, effectiveSeconds) * 1000
  ).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const waitMinutes =
    totalWait > 0 ? Math.max(1, Math.round(totalWait / 60)) : 0;

  const { enabled: voiceEnabled, speak } = voice;
  const spokenInstructionRef = useRef(instruction);

  function speakStep() {
    spokenInstructionRef.current = instruction;
    void registerStepSpeech({
      instruction,
      distance_meters: step?.distanceMeters || route.distanceMeters,
      next_instruction: upcoming?.instruction ?? "",
    }).then(speak).catch(() => {
      // The banner still shows the instruction when speech is unavailable.
    });
  }

  // The route summary already names the first turn, so only a changed
  // instruction (a reroute) is called out automatically.
  useEffect(() => {
    if (!voiceEnabled || spokenInstructionRef.current === instruction) return;
    speakStep();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instruction, voiceEnabled]);

  function toggleVoice() {
    if (voice.enabled) {
      voice.toggle();
      return;
    }
    voice.prime();
    speakStep();
  }

  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-[22px] bg-[#16325C] px-4 py-3.5 text-white shadow-[0_10px_30px_rgba(11,27,51,0.28)]">
          <ManeuverIcon maneuver={step?.maneuver ?? ""} />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-white/70">
              IN {distanceLabel}
            </p>
            <p className="line-clamp-2 text-[18px] font-bold leading-snug">
              {instruction}
            </p>
            <p className="truncate text-[14px] text-white/75">{detail}</p>
          </div>
          <button
            type="button"
            onClick={toggleVoice}
            aria-label={voice.enabled ? "Mute voice guidance" : "Speak this turn"}
            aria-pressed={voice.enabled}
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${
              voice.enabled ? "bg-white text-[#16325C]" : "bg-white/15 text-white active:bg-white/25"
            }`}
          >
            <SpeakerIcon muted={!voice.enabled} className="h-6 w-6" />
          </button>
        </div>

        {conflicts.length > 0 ? (
          <div className="pointer-events-none mt-3 inline-flex max-w-full items-center gap-2 rounded-full bg-[#B00020] px-3 py-1.5 shadow-[0_6px_18px_rgba(176,0,32,0.35)]">
            <span className="text-[14px]" aria-hidden>
              🚧
            </span>
            <span className="truncate text-[13px] font-semibold text-white">
              Train blocking {conflictRoadLabel(conflicts)}
              {totalWait > 0 ? ` · +${Math.max(1, Math.round(totalWait / 60))} min wait` : ""} (sim)
            </span>
          </div>
        ) : wasRerouted ? (
          <div className="pointer-events-none mt-3 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 shadow-[0_6px_18px_rgba(11,27,51,0.12)]">
            <span className="h-2 w-2 rounded-full bg-[#1F9D55]" aria-hidden />
            <span className="text-[13px] font-semibold text-[#17803D]">
              Rerouted around blocked crossing (sim)
              {candidateCount > 1 ? ` · ${candidateCount} options` : ""}
            </span>
          </div>
        ) : (
          <div className="pointer-events-none mt-3 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 shadow-[0_6px_18px_rgba(11,27,51,0.12)]">
            <span className="h-2 w-2 rounded-full bg-[#1F9D55]" aria-hidden />
            <span className="text-[13px] font-semibold text-[#17803D]">Route ahead is clear</span>
          </div>
        )}
      </div>

      <div
        ref={barRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <div className="mb-2 w-full max-w-md">
          <VoiceAlert />
        </div>
        <div className="pointer-events-auto w-full max-w-md rounded-[28px] bg-white px-4 py-3.5 shadow-[0_16px_48px_rgba(11,27,51,0.22)]">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#16325C] text-white">
              <DestinationPinIcon />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold leading-none tracking-[0.14em] text-[#0B1B33]/40">
                HEADING TO
              </p>
              <p className="mt-1 truncate text-[17px] font-bold leading-tight">
                {destination.name}
              </p>
            </div>
            <button
              type="button"
              onClick={onEnd}
              className="flex h-11 shrink-0 items-center justify-center rounded-full bg-[#FDECEC] px-4 text-[15px] font-semibold text-[#E23B4A] active:bg-[#F8D4D4]"
            >
              End
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 overflow-hidden rounded-2xl bg-[#F4F7FB]">
            <TripStat label="Arrival" value={arrival} />
            <TripStat label="Time" value={durationLabel} />
            <TripStat label="Distance" value={distanceLabelTotal} />
          </div>

          {waitMinutes > 0 ? (
            <p className="mt-2 text-center text-[12px] font-semibold text-[#B00020]">
              Includes {waitMinutes} min simulated train wait
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}

function continuationLine(step: RouteStep | undefined): string {
  if (!step) return "";
  const target = step.instruction.match(/\b(?:onto|toward|at)\s+(.+)$/i)?.[1];
  if (target) return `Continue toward ${target}`;
  return "";
}

function formatBannerDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "0 MI";
  const miles = meters / 1609.344;
  if (miles < 0.1) {
    const feet = Math.max(1, Math.round(meters * 3.28084));
    return `${feet} FT`;
  }
  if (miles < 10) return `${miles.toFixed(1)} MI`;
  return `${Math.round(miles)} MI`;
}

function formatTripDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "—";
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hr`;
  return `${hours} hr ${remainder} min`;
}

function formatTripDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "—";
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

function TripStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l border-[#0B1B33]/8 px-2 py-2.5 text-center first:border-l-0">
      <p className="text-[10px] font-bold leading-none tracking-[0.12em] text-[#0B1B33]/40">
        {label.toUpperCase()}
      </p>
      <p className="mt-1.5 text-[18px] font-bold leading-none tracking-tight">
        {value}
      </p>
    </div>
  );
}

function DestinationPinIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <path
        d="M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11" r="2.2" fill="currentColor" />
    </svg>
  );
}

function maneuverKind(maneuver: string) {
  const value = maneuver.toUpperCase();
  if (value.includes("UTURN") || value.includes("U-TURN")) return "uturn";
  if (value.includes("SLIGHT_LEFT") || value.includes("FORK_LEFT")) return "left";
  if (value.includes("SLIGHT_RIGHT") || value.includes("FORK_RIGHT")) return "right";
  if (value.includes("LEFT")) return "left";
  if (value.includes("RIGHT")) return "right";
  if (value.includes("ARRIVE")) return "arrive";
  return "straight";
}

function ManeuverIcon({ maneuver }: { maneuver: string }) {
  const kind = maneuverKind(maneuver);
  if (kind === "straight" || kind === "arrive") {
    return (
      <svg viewBox="0 0 48 48" className="h-12 w-12 shrink-0" fill="none" aria-hidden>
        <path
          d="M24 42V14"
          stroke="white"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="M13 22 24 8l11 14"
          stroke="white"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  const flip = kind === "left" || kind === "uturn";
  return (
    <svg
      viewBox="0 0 48 48"
      className={`h-12 w-12 shrink-0 ${flip ? "-scale-x-100" : ""}`}
      fill="none"
      aria-hidden
    >
      <path
        d="M14 42V24a8 8 0 0 1 8-8h12"
        stroke="white"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M26 8 38 16 26 24"
        stroke="white"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
