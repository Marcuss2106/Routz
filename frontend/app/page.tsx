"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import ActiveRoute from "@/components/ActiveRoute";
import GoogleMap from "@/components/GoogleMap";
import RouteForm from "@/components/RouteForm";
import TrainPanel from "@/components/TrainPanel";
import {
  useVoiceGuidance,
  VoiceAlert,
  VoiceButton,
  VoiceProvider,
} from "@/components/VoiceGuidance";
import VoiceRouteButton from "@/components/VoiceRouteButton";
import {
  getDrivingRoutes,
  getGoogleMapsApiKey,
  reverseGeocode,
  type PlaceResult,
  type RouteInfo,
} from "@/lib/googleMaps";
import { readCurrentLocation } from "@/lib/here";
import { findRouteConflicts, scoreRouteCandidates, type RouteConflict } from "@/lib/routeCrossing";
import type { BlockagePrediction, TrainObservation } from "@/lib/trains";
import { useTrainStream } from "@/lib/trainStream";
import { registerRouteSpeech, type RouteTranscript } from "@/lib/voice";

/** Bias a spoken name to the demo city so Routes can resolve it as an address. */
function spokenPlace(query: string): PlaceResult | null {
  const trimmed = query.trim();
  if (trimmed.length < 2) return null;
  const withoutArticle = trimmed.replace(/^(the|a|an)\s+/i, "");
  const address = /columbia|,\s*sc\b|south carolina/i.test(withoutArticle)
    ? withoutArticle
    : `${withoutArticle}, Columbia, SC`;
  return {
    id: `spoken-${address.toLowerCase()}`,
    name: trimmed,
    formattedAddress: address,
    coordinate: { latitude: 33.98924, longitude: -81.02982 },
    addressQuery: address,
  };
}

/** Demo start when the browser cannot provide a GPS fix. */
function simulatedHere(): PlaceResult {
  return {
    id: `simulated-here-${Date.now()}`,
    name: "Swearingen Engineering Center",
    formattedAddress: "Simulated start, 301 Main St, Columbia, SC",
    coordinate: { latitude: 33.98924, longitude: -81.02982 },
  };
}

export default function Home() {
  return (
    <VoiceProvider>
      <MapScreen />
    </VoiceProvider>
  );
}

function MapScreen() {
  const voice = useVoiceGuidance();
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
  const [sheetOpen, setSheetOpen] = useState(true);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetDrag = useRef({ y: 0, dragged: false, active: false });

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

  const locate = useCallback(async (): Promise<PlaceResult> => {
    setIsLocating(true);
    setRouteError(null);
    const fix = await readCurrentLocation();
    if (!fix) {
      setIsLocating(false);
      return simulatedHere();
    }
    let address = `${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}`;
    let placeId: string | undefined;
    try {
      const resolved = await reverseGeocode(fix.latitude, fix.longitude);
      address = resolved.address;
      placeId = resolved.placeId;
    } catch {
      // Coordinates are enough to route when reverse geocoding is off.
    }
    setIsLocating(false);
    return {
      id: `current-${Date.now()}`,
      name: "Current location",
      formattedAddress: address,
      coordinate: fix,
      ...(placeId ? { placeId } : {}),
    };
  }, []);

  const chooseRoute = useCallback(
    async (from: PlaceResult, to: PlaceResult, speakResult: boolean) => {
      setRouteError(null);
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
        const results = await getDrivingRoutes(from, to, true);
        const scored =
          predictions.length > 0 ? scoreRouteCandidates(results, predictions) : null;
        const best = scored?.[0];
        const chosen = best?.route ?? results[0];
        const start = chosen.path[0];
        const end = chosen.path[chosen.path.length - 1];
        const snappedFrom =
          from.addressQuery && start ? { ...from, coordinate: start } : from;
        const snappedTo = to.addressQuery && end ? { ...to, coordinate: end } : to;
        setOrigin(snappedFrom);
        setDestination(snappedTo);
        setCandidates(results);
        setRoute(chosen);
        if (best) {
          setConflicts(best.conflicts);
          const fastest = [...results].sort(
            (a, b) => a.expectedTravelTimeSeconds - b.expectedTravelTimeSeconds
          )[0];
          const fastestConflicts = findRouteConflicts(fastest, predictions);
          setWasRerouted(
            fastestConflicts.length > 0 && best.conflicts.length < fastestConflicts.length
          );
        }
        if (speakResult || voice.enabled) {
          try {
            const alert = await registerRouteSpeech({
              origin_name: snappedFrom.name,
              destination_name: snappedTo.name,
              duration_seconds: chosen.expectedTravelTimeSeconds,
              distance_meters: chosen.distanceMeters,
            });
            voice.speak(alert);
          } catch {
            // The drawn route does not depend on speech.
          }
        }
      } catch (err) {
        setRouteError(err instanceof Error ? err.message : "Could not calculate a route.");
      } finally {
        setRouteLoading(false);
      }
    },
    [predictions, voice]
  );

  const handleGetRoute = useCallback(
    async (overrides?: { origin?: PlaceResult | null; destination?: PlaceResult | null }) => {
      const effectiveOrigin = overrides?.origin ?? origin;
      const effectiveDestination = overrides?.destination ?? destination;
      if (!effectiveOrigin || !effectiveDestination) {
        setRouteError("Enter both a starting location and a destination.");
        return;
      }
      await chooseRoute(effectiveOrigin, effectiveDestination, false);
    },
    [origin, destination, chooseRoute]
  );

  const handleSpokenRoute = useCallback(
    async (request: RouteTranscript) => {
      const destinationQuery = request.destination_query;
      if (!destinationQuery) return;
      const nextOrigin = request.use_current_location
        ? await locate()
        : spokenPlace(request.origin_query ?? "");
      const nextDestination = spokenPlace(destinationQuery);
      if (!nextDestination) {
        setRouteError(`Could not find ${destinationQuery}. Try a more specific name.`);
        return;
      }
      if (!nextOrigin) {
        setRouteError(
          `Could not find ${request.origin_query ?? "the start"}. Try a more specific name.`
        );
        return;
      }
      setOrigin(nextOrigin);
      setDestination(nextDestination);
      await chooseRoute(nextOrigin, nextDestination, true);
    },
    [locate, chooseRoute]
  );

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

  const liveStatus = useTrainStream(
    useCallback(
      (env) => handleTrainObservation(env.observation, env.predictions),
      [handleTrainObservation]
    )
  );

  const handleUseMyLocation = useCallback(() => {
    void locate().then((place) => {
      setOrigin(place);
      setRoute(null);
      setCandidates([]);
      setConflicts([]);
      setWasRerouted(false);
    });
  }, [locate]);

  const handleClearRoute = useCallback(() => {
    setRoute(null);
    setCandidates([]);
    setConflicts([]);
    setWasRerouted(false);
    setRouteError(null);
  }, []);

  const routeSelected = Boolean(route && origin && destination);

  function beginSheetDrag(event: PointerEvent<HTMLButtonElement>) {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is unavailable until the browser has a real pointer.
    }
    sheetDrag.current = { y: event.clientY, dragged: false, active: true };
  }

  function moveSheetDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!sheetDrag.current.active) return;
    if (Math.abs(event.clientY - sheetDrag.current.y) > 12) {
      sheetDrag.current.dragged = true;
    }
  }

  function endSheetDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!sheetDrag.current.active) return;
    const dy = event.clientY - sheetDrag.current.y;
    sheetDrag.current.active = false;
    if (!sheetDrag.current.dragged) return;
    if (dy > 28) setSheetOpen(false);
    else if (dy < -28) setSheetOpen(true);
  }

  function toggleSheet() {
    if (sheetDrag.current.dragged) {
      sheetDrag.current.dragged = false;
      return;
    }
    setSheetOpen((open) => !open);
  }

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
            <div className="pointer-events-auto flex min-h-11 flex-wrap items-center justify-center gap-2 rounded-2xl bg-white/95 px-3 py-1.5 shadow-[0_8px_30px_rgba(11,27,51,0.12)] backdrop-blur">
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
              <VoiceRouteButton disabled={routeLoading} onRequest={handleSpokenRoute} />
              <VoiceButton />
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center">
            <div className="pointer-events-none mb-2 w-[min(100%-1.5rem,28rem)]">
              <VoiceAlert />
            </div>
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
              <button
                type="button"
                aria-expanded={sheetOpen}
                aria-controls="routz-route-sheet"
                aria-label={sheetOpen ? "Pull down to hide route search" : "Pull up route search"}
                onPointerDown={beginSheetDrag}
                onPointerMove={moveSheetDrag}
                onPointerUp={endSheetDrag}
                onPointerCancel={endSheetDrag}
                onClick={toggleSheet}
                className="flex w-full touch-none flex-col items-center py-2"
              >
                <span className="h-1.5 w-10 rounded-full bg-[#0B1B33]/20" />
                {!sheetOpen ? (
                  <span className="mt-2 flex items-center gap-1.5 text-[15px] font-semibold text-[#0B1B33]">
                    Where are you going?
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4 rotate-180 text-[#0B1B33]/45"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.4}
                      aria-hidden
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
                    </svg>
                  </span>
                ) : null}
              </button>
              {sheetOpen ? (
              <div id="routz-route-sheet" className="mt-3">
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
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
