"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActiveRoute from "@/components/ActiveRoute";
import GoogleMap from "@/components/GoogleMap";
import RouteForm from "@/components/RouteForm";
import TrainPanel from "@/components/TrainPanel";
import {
  getDrivingRoutes,
  getGoogleMapsApiKey,
  reverseGeocode,
  type PlaceResult,
  type RouteInfo,
} from "@/lib/googleMaps";
import { findRouteConflicts, scoreRouteCandidates, type RouteConflict } from "@/lib/routeCrossing";
import type { BlockagePrediction, TrainObservation } from "@/lib/trains";
import { useTrainStream } from "@/lib/trainStream";

export default function Home() {
  const [origin, setOrigin] = useState<PlaceResult | null>(null);
  const [destination, setDestination] = useState<PlaceResult | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [candidates, setCandidates] = useState<RouteInfo[]>([]);
  const [conflicts, setConflicts] = useState<RouteConflict[]>([]);
  const [wasRerouted, setWasRerouted] = useState(false);
  const [train, setTrain] = useState<TrainObservation | null>(null);
  const [predictions, setPredictions] = useState<BlockagePrediction[]>([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(320);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  const altPaths = useMemo(() => {
    if (!route || candidates.length < 2) return null;
    return candidates.filter((c) => c !== route).map((c) => c.path);
  }, [route, candidates]);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;

    const measure = () => {
      const next = Math.ceil(sheet.getBoundingClientRect().height / 8) * 8;
      setSheetHeight((current) => (current === next ? current : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [route, routeError]);

  const handleGetRoute = useCallback(async (overrides?: {
    origin?: PlaceResult | null;
    destination?: PlaceResult | null;
  }) => {
    setRouteError(null);

    // RouteForm may pass freshly resolved places (Enter-to-submit with a
    // typed address) that haven't propagated through state yet.
    const effectiveOrigin = overrides?.origin ?? origin;
    const effectiveDestination = overrides?.destination ?? destination;
    if (!effectiveOrigin || !effectiveDestination) {
      setRouteError("Enter both a starting location and a destination.");
      return;
    }
    if (!getGoogleMapsApiKey()) {
      setRouteError(
        "Missing Google Maps API key. Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to frontend/.env.local — see README for setup."
      );
      return;
    }

    setRouteLoading(true);
    setRoute(null);
    setCandidates([]);
    setConflicts([]);
    setWasRerouted(false);
    try {
      const results = await getDrivingRoutes(
        effectiveOrigin,
        effectiveDestination,
        true
      );
      setCandidates(results);
      if (predictions.length > 0) {
        const scored = scoreRouteCandidates(results, predictions);
        const best = scored[0];
        setRoute(best.route);
        setConflicts(best.conflicts);
        // Rerouted = the fastest Google route was blocked but an alternate avoids it.
        const fastest = [...results].sort(
          (a, b) => a.expectedTravelTimeSeconds - b.expectedTravelTimeSeconds
        )[0];
        const fastestConflicts = findRouteConflicts(fastest, predictions);
        setWasRerouted(
          fastestConflicts.length > 0 &&
            best.conflicts.length < fastestConflicts.length
        );
      } else {
        setRoute(results[0]);
      }
    } catch (err) {
      setRouteError(
        err instanceof Error ? err.message : "Could not calculate a route."
      );
    } finally {
      setRouteLoading(false);
    }
  }, [origin, destination, predictions]);

  // Re-score the active route when fresh train predictions arrive.
  // If the current route becomes blocked but a cached alternate avoids it,
  // auto-switch (demo-friendly) and flag the reroute.
  useEffect(() => {
    if (!route || candidates.length === 0) return;
    const scored = scoreRouteCandidates(candidates, predictions);
    const best = scored[0];
    if (!best) return;
    setConflicts(findRouteConflicts(route, predictions));
    if (best.route !== route && best.conflicts.length === 0) {
      const currentConflicts = findRouteConflicts(route, predictions);
      if (currentConflicts.length > 0) {
        setRoute(best.route);
        setConflicts(best.conflicts);
        setWasRerouted(true);
      }
    }
  }, [predictions, route, candidates]);

  const handleTrainObservation = useCallback(
    (obs: TrainObservation | null, preds: BlockagePrediction[]) => {
      setTrain(obs);
      setPredictions(preds);
      if (!obs) {
        setWasRerouted(false);
        setConflicts([]);
      }
    },
    []
  );

  // Live backend stream (SSE). No-op when NEXT_PUBLIC_ROUTZ_API_URL is unset.
  const liveStatus = useTrainStream(
    useCallback(
      (env) => handleTrainObservation(env.observation, env.predictions),
      [handleTrainObservation]
    )
  );

  const handleUseMyLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setRouteError("Geolocation is not supported on this device.");
      return;
    }
    setIsLocating(true);
    setRouteError(null);

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        let label = "Current location";
        let address = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        let placeId: string | undefined;
        try {
          const resolved = await reverseGeocode(latitude, longitude);
          address = resolved.address;
          placeId = resolved.placeId;
          label = "Current location";
        } catch {
          // Keep coordinate fallback — still routable.
        }
        setOrigin({
          id: `current-${Date.now()}`,
          name: label,
          formattedAddress: address,
          coordinate: { latitude, longitude },
          ...(placeId ? { placeId } : {}),
        });
        setIsLocating(false);
      },
      () => {
        setIsLocating(false);
        setRouteError(
          "Could not get your location. Check browser permissions and try again."
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }, []);

  const handleClearRoute = useCallback(() => {
    setRoute(null);
    setCandidates([]);
    setConflicts([]);
    setWasRerouted(false);
    setRouteError(null);
  }, []);

  const routeSelected = Boolean(route && origin && destination);

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-[#E8EEF4] text-[#0B1B33]">
      <div className="absolute inset-0">
        <GoogleMap
          origin={origin}
          destination={destination}
          routePath={route?.path ?? null}
          altPaths={altPaths}
          train={train}
          predictions={predictions}
          isCalculating={routeLoading}
          bottomInset={sheetHeight + 16}
          topInset={routeSelected ? 200 : 80}
        />
      </div>

      {route && origin && destination ? (
        <ActiveRoute
          route={route}
          destination={destination}
          onEnd={handleClearRoute}
          barRef={sheetRef}
          conflicts={conflicts}
          wasRerouted={wasRerouted}
          candidateCount={candidates.length}
        />
      ) : null}

      {!routeSelected && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="pointer-events-auto flex h-11 items-center gap-2 rounded-2xl bg-white/95 px-3 shadow-[0_8px_30px_rgba(11,27,51,0.12)] backdrop-blur">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#007AFF] text-white">
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  aria-hidden
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 20l-5.5-2.5v-13L9 7l6-2.5L20.5 7v13L15 17.5 9 20Zm0 0v-13m6-2.5v13"
                  />
                </svg>
              </span>
              <span className="text-[15px] font-bold leading-none">Routz</span>
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center">
            {routeError && (
              <div
                role="alert"
                className="pointer-events-auto mb-2 flex w-[min(100%-1.5rem,28rem)] items-start gap-2.5 rounded-2xl border border-[#B00020]/15 bg-[#FFF5F5] p-3.5 shadow-lg"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#B00020]/10 text-[#B00020]">
                  !
                </span>
                <p className="flex-1 pt-1 text-[14px] font-medium leading-5 text-[#5F0B16]">
                  {routeError}
                </p>
                <button
                  type="button"
                  onClick={() => setRouteError(null)}
                  aria-label="Dismiss error"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#5F0B16]/60 hover:bg-black/5"
                >
                  ✕
                </button>
              </div>
            )}

            <div
              ref={sheetRef}
              className="pointer-events-auto max-h-[78dvh] w-full max-w-md overflow-y-auto rounded-t-[28px] bg-white px-4 pt-2 shadow-[0_-12px_40px_rgba(11,27,51,0.2)] pb-[max(0.85rem,env(safe-area-inset-bottom))]"
            >
              <div
                className="mx-auto mb-3 mt-1 h-1.5 w-10 rounded-full bg-[#0B1B33]/15"
                aria-hidden
              />
              <RouteForm
                origin={origin}
                destination={destination}
                onOriginChange={(place) => {
                  setOrigin(place);
                  setRoute(null);
                }}
                onDestinationChange={(place) => {
                  setDestination(place);
                  setRoute(null);
                }}
                onGetRoute={handleGetRoute}
                onUseMyLocation={handleUseMyLocation}
                isLoading={routeLoading}
                isLocating={isLocating}
              />
              <div className="mt-3">
                <TrainPanel
                  observation={train}
                  predictions={predictions}
                  onObservation={handleTrainObservation}
                  liveStatus={liveStatus}
                />
                <p className="mt-2 text-center text-[12px] text-[#0B1B33]/45">
                  SIMULATION — train + crossing predictions are simulated, not for emergency use.
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
