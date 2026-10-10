"use client";

import { useState } from "react";
import {
  formatDistance,
  formatDuration,
  type PlaceResult,
  type RouteInfo,
} from "@/lib/googleMaps";

interface RouteSummaryProps {
  route: RouteInfo;
  origin: PlaceResult;
  destination: PlaceResult;
  onClose: () => void;
}

/** Bottom card summarizing the active driving route. */
export default function RouteSummary({
  route,
  origin,
  destination,
  onClose,
}: RouteSummaryProps) {
  const [started, setStarted] = useState(false);

  return (
    <div className="rounded-2xl bg-white p-4 shadow-[0_12px_40px_rgba(11,27,51,0.22)]">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#0B1B33]/50">
          Routz route
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Clear route"
          className="flex h-9 w-9 items-center justify-center rounded-full text-[#0B1B33]/45 hover:bg-black/5 active:bg-black/10"
        >
          ✕
        </button>
      </div>

      <div className="mt-1 flex items-baseline gap-2">
        <p className="text-[32px] font-bold leading-none text-[#0B1B33]">
          {formatDuration(route.expectedTravelTimeSeconds)}
        </p>
        <p className="text-[17px] font-medium text-[#0B1B33]/55">
          {formatDistance(route.distanceMeters)}
        </p>
        <span className="ml-auto hidden items-center gap-1 rounded-full bg-[#E6F4EA] px-2.5 py-1 text-[12px] font-semibold text-[#137333] sm:flex">
          ✓ Best route
        </span>
      </div>

      {route.name && (
        <p className="mt-1 truncate text-[13px] text-[#0B1B33]/50">
          via {route.name}
        </p>
      )}

      <div className="mt-3 space-y-2 border-t border-black/[0.06] pt-3">
        <div className="flex items-start gap-2.5">
          <span
            className="mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full bg-[#007AFF]"
            aria-hidden
          />
          <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#0B1B33]">
            {origin.name}
            {origin.formattedAddress &&
              origin.formattedAddress !== origin.name && (
                <span className="block truncate text-[13px] font-normal text-[#0B1B33]/55">
                  {origin.formattedAddress}
                </span>
              )}
          </p>
        </div>
        <div className="flex items-start gap-2.5">
          <span
            className="mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full bg-[#0B1B33]"
            aria-hidden
          />
          <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#0B1B33]">
            {destination.name}
            {destination.formattedAddress &&
              destination.formattedAddress !== destination.name && (
                <span className="block truncate text-[13px] font-normal text-[#0B1B33]/55">
                  {destination.formattedAddress}
                </span>
              )}
          </p>
        </div>
      </div>

      {!started ? (
        <button
          type="button"
          onClick={() => setStarted(true)}
          className="mt-4 flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-[#007AFF] text-[17px] font-semibold text-white shadow-[0_4px_14px_rgba(0,122,255,0.35)] hover:bg-[#0066D6] active:bg-[#0055B8]"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 3l3.6 3.6M19 3l-3.6 3.6M12 21v-8m0 0c0-4 3-6 7-6m-7 6c0-4-3-6-7-6"
            />
          </svg>
          Start route
        </button>
      ) : (
        <div className="mt-4 space-y-2">
          <div className="flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-[#0B1B33] text-[17px] font-semibold text-white">
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
            Route started
          </div>
          <button
            type="button"
            onClick={() => setStarted(false)}
            className="h-[44px] w-full rounded-xl bg-[#F2F4F8] text-[15px] font-semibold text-[#0B1B33] hover:bg-[#E6EAF1] active:bg-[#DCE2EC]"
          >
            End
          </button>
          <p className="text-center text-[13px] text-[#0B1B33]/55">
            Follow the blue line on the map. Turn-by-turn navigation arrives in
            a later version.
          </p>
        </div>
      )}
    </div>
  );
}
