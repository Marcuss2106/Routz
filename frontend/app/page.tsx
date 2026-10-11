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
  getGoogleMapsApiKey,
  resolveSpokenPlace,
  reverseGeocode,
  type PlaceResult,
  type RouteInfo,
} from "@/lib/googleMaps";
import { readCurrentLocation } from "@/lib/here";
import { SIMULATED_CROSSINGS, type Crossing } from "@/lib/crossings";
import { findRouteConflicts, scoreRouteCandidates, type RouteConflict } from "@/lib/routeCrossing";
import {
  blockedCrossingSignature,
  getCrossingAwareCandidates,
  routeAvoidsActiveBlockages,
} from "@/lib/routeDetour";
import {
  predictCrossingBlockages,
  predictRouteBlockages,
  type RailRoutePoint,
} from "@/lib/trains";
import {
  estimateToObservation,
  simulationStateToObservation,
  useSimulationTrainStream,
  useTrainStream,
  type SimulationTrainState,
  type TrainStateEstimateEvent,
} from "@/lib/trainStream";
import {
  VOICE_NOTICES,
  registerNotFoundSpeech,
  registerRouteSpeech,
  type RouteTranscript,
} from "@/lib/voice";

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
  const [simulationTrain, setSimulationTrain] = useState<SimulationTrainState | null>(null);
  const [simulationCrossings, setSimulationCrossings] = useState<Crossing[]>(SIMULATED_CROSSINGS);
  const [simulationRailRoute, setSimulationRailRoute] = useState<RailRoutePoint[]>([]);
  const [estimate, setEstimate] = useState<TrainStateEstimateEvent | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(320);
  const [sheetOpen, setSheetOpen] = useState(true);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetDrag = useRef({ y: 0, dragged: false, active: false });
  const activeRouteRequestRef = useRef(0);
  const routeRefreshRef = useRef({
    key: "",
    pendingKey: "",
    riskKey: "clear",
    wasBlocked: false,
    refreshedAt: 0,
    requestId: 0,
  });

  const estimatedTrain = useMemo(
    () => (estimate ? estimateToObservation(estimate) : null),
    [estimate]
  );
  const train = useMemo(
    () => (simulationTrain ? simulationStateToObservation(simulationTrain) : estimatedTrain),
    [estimatedTrain, simulationTrain]
  );
  const predictions = useMemo(() => {
    if (simulationTrain && train) {
      return simulationRailRoute.length > 1
        ? predictRouteBlockages(simulationTrain, simulationRailRoute, simulationCrossings)
        : predictCrossingBlockages(train, simulationCrossings);
    }
    return estimate?.predictions ?? [];
  }, [estimate, simulationCrossings, simulationRailRoute, simulationTrain, train]);
  const crossingStateKey = useMemo(() => {
    const active = predictions
      .filter((prediction) => prediction.status !== "cleared" && prediction.status !== "unknown")
      .map((prediction) =>
        `${prediction.crossingId}:${prediction.status}:${Math.floor(prediction.distanceM / 50)}`
      );
    return active.length > 0 ? active.join("|") : "clear";
  }, [predictions]);
  const crossingRiskKey = useMemo(() => {
    const active = predictions
      .filter((prediction) => prediction.status !== "cleared" && prediction.status !== "unknown")
      .map((prediction) => `${prediction.crossingId}:${prediction.status}`);
    return active.length > 0 ? active.join("|") : "clear";
  }, [predictions]);
  const simulationTrainStatus = simulationTrain?.status;
  const routeActive = Boolean(route);
  const latestPredictionsRef = useRef(predictions);
  const latestRouteRef = useRef(route);
  useEffect(() => {
    latestPredictionsRef.current = predictions;
  }, [predictions]);
  useEffect(() => {
    latestRouteRef.current = route;
  }, [route]);

  const displayedConflicts = useMemo(
    () => (route ? findRouteConflicts(route, predictions) : conflicts),
    [conflicts, predictions, route]
  );

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
      const requestId = activeRouteRequestRef.current + 1;
      activeRouteRequestRef.current = requestId;
      setRouteLoading(true);
      setRoute(null);
      setCandidates([]);
      setConflicts([]);
      setWasRerouted(false);
      try {
        const results = await getCrossingAwareCandidates(from, to, predictions);
        if (activeRouteRequestRef.current !== requestId) return;
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
        routeRefreshRef.current.key = crossingStateKey;
        routeRefreshRef.current.pendingKey = "";
        routeRefreshRef.current.riskKey = crossingRiskKey;
        routeRefreshRef.current.wasBlocked = Boolean(best?.blocked);
        routeRefreshRef.current.refreshedAt = Date.now();
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
              first_instruction: chosen.steps[0]?.instruction ?? "",
            });
            voice.speak(alert);
          } catch {
            // The drawn route does not depend on speech.
          }
        }
      } catch (err) {
        if (activeRouteRequestRef.current !== requestId) return;
        setRouteError(err instanceof Error ? err.message : "Could not calculate a route.");
        if (speakResult) voice.speak(VOICE_NOTICES.routeFailed);
      } finally {
        if (activeRouteRequestRef.current === requestId) setRouteLoading(false);
      }
    },
    [crossingRiskKey, crossingStateKey, predictions, voice]
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
      setRouteError(null);
      const notFound = (query: string) => {
        setRouteError(`Could not find ${query}. Try a more specific name.`);
        void registerNotFoundSpeech(query).then(voice.speak).catch(() => {
          // The written error is enough when speech is unavailable.
        });
      };
      const nextOrigin = request.use_current_location
        ? await locate()
        : await resolveSpokenPlace(request.origin_query ?? "");
      if (!nextOrigin) {
        notFound(request.origin_query ?? "the start");
        return;
      }
      const nextDestination = await resolveSpokenPlace(
        destinationQuery,
        nextOrigin.coordinate
      );
      if (!nextDestination) {
        notFound(destinationQuery);
        return;
      }
      setOrigin(nextOrigin);
      setDestination(nextDestination);
      await chooseRoute(nextOrigin, nextDestination, true);
    },
    [locate, chooseRoute, voice]
  );

  useEffect(() => {
    if (!route || candidates.length === 0) return;
    const nowMs = Date.now();
    const scored = scoreRouteCandidates(candidates, predictions, nowMs);
    const best = scored[0];
    if (!best) return;
    if (best.route === route) return;

    const current = scored.find((candidate) => candidate.route === route);
    const trainStillActive = predictions.some(
      (prediction) =>
        prediction.status !== "cleared" && prediction.status !== "unknown"
    );
    if (wasRerouted && trainStillActive && current && !current.blocked) {
      // Hold a verified clear detour until the train risk clears or the
      // detour itself becomes blocked.
      return;
    }

    // Same blocked crossings + longer ETA = "just slower", not a reroute.
    const currentSignature = blockedCrossingSignature(route, predictions, nowMs);
    const bestSignature = blockedCrossingSignature(best.route, predictions, nowMs);
    if (
      currentSignature !== "clear" &&
      bestSignature === currentSignature &&
      best.route.expectedTravelTimeSeconds >= route.expectedTravelTimeSeconds
    ) {
      return;
    }

    const trainIsStationary = Boolean(
      simulationTrainStatus && simulationTrainStatus !== "running"
    );
    if (
      trainIsStationary &&
      current &&
      best.conflicts.length >= current.conflicts.length
    ) {
      return;
    }

    const improvesAvoidance =
      Boolean(current?.blocked) && !best.blocked;
    const fewerConflicts =
      current != null && best.conflicts.length < current.conflicts.length;
    const fasterWhileClear =
      !best.blocked &&
      !current?.blocked &&
      best.effectiveSeconds + 15 < (current?.effectiveSeconds ?? Infinity);

    if (improvesAvoidance || fewerConflicts || fasterWhileClear || !current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRoute(best.route);
      setConflicts(best.conflicts);
      const fastest = [...candidates].sort(
        (a, b) => a.expectedTravelTimeSeconds - b.expectedTravelTimeSeconds
      )[0];
      setWasRerouted(!best.blocked && best.route !== fastest);
    }
  }, [predictions, route, candidates, simulationTrainStatus, wasRerouted]);

  // Ask Google for a fresh set of alternatives as the train advances into a
  // new 50 m crossing window. Calls are capped to one every five seconds;
  // existing candidates continue to be rescored on every train update.
  useEffect(() => {
    const activeRoute = latestRouteRef.current;
    if (!routeActive || !activeRoute || !origin || !destination || routeLoading) return;
    if (
      routeRefreshRef.current.key === crossingStateKey ||
      routeRefreshRef.current.pendingKey === crossingStateKey
    ) return;
    const currentPredictions = latestPredictionsRef.current;
    const routeIsBlocked = findRouteConflicts(activeRoute, currentPredictions).length > 0;
    if (simulationTrainStatus && simulationTrainStatus !== "running" && !routeIsBlocked) {
      // Invalidate any in-flight refresh that was started while the train was
      // moving. Its stale response must not restore the old fastest route.
      routeRefreshRef.current = {
        ...routeRefreshRef.current,
        key: crossingStateKey,
        pendingKey: "",
        riskKey: crossingRiskKey,
        wasBlocked: false,
        requestId: routeRefreshRef.current.requestId + 1,
      };
      activeRouteRequestRef.current += 1;
      return;
    }
    const newlyRisky = routeIsBlocked && (
      !routeRefreshRef.current.wasBlocked ||
      routeRefreshRef.current.riskKey !== crossingRiskKey
    );
    const delayMs = newlyRisky
      ? 0
      : Math.max(0, 5000 - (Date.now() - routeRefreshRef.current.refreshedAt));
    const requestId = routeRefreshRef.current.requestId + 1;
    const activeRequestId = activeRouteRequestRef.current + 1;
    activeRouteRequestRef.current = activeRequestId;
    routeRefreshRef.current = {
      ...routeRefreshRef.current,
      pendingKey: crossingStateKey,
      requestId,
    };
    const timer = window.setTimeout(() => {
      routeRefreshRef.current = {
        ...routeRefreshRef.current,
        key: crossingStateKey,
        pendingKey: "",
        riskKey: crossingRiskKey,
        wasBlocked: routeIsBlocked,
        refreshedAt: Date.now(),
      };
      void getCrossingAwareCandidates(origin, destination, latestPredictionsRef.current)
        .then((results) => {
          if (
            routeRefreshRef.current.requestId !== requestId ||
            activeRouteRequestRef.current !== activeRequestId
          ) return;
          const nowMs = Date.now();
          const latest = latestPredictionsRef.current;
          const scored = scoreRouteCandidates(results, latest, nowMs);
          const best = scored.find((candidate) =>
            routeAvoidsActiveBlockages(candidate.route, latest, nowMs)
          );
          if (!best) {
            // Every candidate still meets the train (often the same crossings
            // with a longer ETA). Keep the drawn route stable — no flicker.
            setCandidates(results);
            return;
          }
          const active = latestRouteRef.current;
          if (
            active &&
            routeAvoidsActiveBlockages(active, latest, nowMs) &&
            blockedCrossingSignature(active, latest, nowMs) === "clear" &&
            best.route.expectedTravelTimeSeconds + 15 >=
              active.expectedTravelTimeSeconds
          ) {
            // Already on a clear route; do not redraw for a slower clear option.
            setCandidates(results);
            return;
          }
          const fastest = [...results].sort(
            (a, b) => a.expectedTravelTimeSeconds - b.expectedTravelTimeSeconds
          )[0];
          setCandidates(results);
          setRoute(best.route);
          setConflicts(best.conflicts);
          setWasRerouted(routeIsBlocked || best.route !== fastest);
        })
        .catch(() => {
          // Keep the current valid route; the next crossing-state change retries.
        });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [crossingRiskKey, crossingStateKey, destination, origin, routeActive, routeLoading, simulationTrainStatus]);

  const liveStatus = useTrainStream(
    useCallback(
      (event) => {
        if (!event) {
          setEstimate(null);
          setWasRerouted(false);
          setConflicts([]);
          return;
        }
        setEstimate(event);
      },
      []
    )
  );

  const simulationStatus = useSimulationTrainStream(
    useCallback((state) => setSimulationTrain(state), []),
    useCallback((crossings: Crossing[]) => setSimulationCrossings(crossings), []),
    useCallback((railRoute: RailRoutePoint[]) => setSimulationRailRoute(railRoute), [])
  );
  const displayedLiveStatus = simulationTrain ? simulationStatus : liveStatus;

  const handleUseMyLocation = useCallback(() => {
    activeRouteRequestRef.current += 1;
    setRouteLoading(false);
    void locate().then((place) => {
      setOrigin(place);
      setRoute(null);
      setCandidates([]);
      setConflicts([]);
      setWasRerouted(false);
    });
  }, [locate]);

  const handleClearRoute = useCallback(() => {
    activeRouteRequestRef.current += 1;
    setRouteLoading(false);
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
          train={train}
          estimate={simulationTrain ? null : estimate}
          simulationTrain={simulationTrain}
          simulationRailRoute={simulationRailRoute}
          predictions={predictions}
          isCalculating={routeLoading}
          bottomInset={sheetHeight + (routeSelected ? 16 : 96)}
          topInset={routeSelected ? 200 : 80}
        />
      </div>

      {route && origin && destination ? (
        <ActiveRoute
          route={route}
          destination={destination}
          onEnd={handleClearRoute}
          barRef={sheetRef}
          conflicts={displayedConflicts}
          wasRerouted={wasRerouted}
          candidateCount={candidates.length}
        />
      ) : null}

      {!routeSelected && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="pointer-events-auto flex h-11 items-center gap-2 rounded-full bg-white/95 pl-1.5 pr-3.5 shadow-[0_8px_30px_rgba(11,27,51,0.12)] backdrop-blur">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#A65353] text-white">
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
              <span className="text-[16px] font-bold leading-none">Routz</span>
              <span className="rounded-full bg-[#7A5C00]/10 px-2 py-0.5 text-[11px] font-bold text-[#7A5C00]">
                Sim
              </span>
            </div>
            <div className="pointer-events-auto">
              <VoiceButton />
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center">
            <div className="pointer-events-none mb-2 w-[min(100%-1.5rem,28rem)]">
              <VoiceAlert />
            </div>
            <div className="pointer-events-none mb-3 flex w-[min(100%-1.5rem,28rem)] justify-end">
              <VoiceRouteButton disabled={routeLoading} onRequest={handleSpokenRoute} />
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
              className="pointer-events-auto max-h-[68dvh] w-full max-w-md overflow-hidden rounded-t-[28px] bg-white px-4 pt-2 shadow-[0_-12px_40px_rgba(11,27,51,0.2)] pb-[max(0.85rem,env(safe-area-inset-bottom))]"
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
                <span
                  className={`flex items-center gap-1.5 overflow-hidden text-[15px] font-semibold text-[#0B1B33] transition-[max-height,margin,opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
                    sheetOpen
                      ? "mt-0 max-h-0 -translate-y-2 opacity-0"
                      : "mt-2 max-h-6 translate-y-0 opacity-100"
                  }`}
                >
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
              </button>
              <div
                id="routz-route-sheet"
                aria-hidden={!sheetOpen}
                inert={!sheetOpen}
                className={`grid transition-[grid-template-rows,opacity,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
                  sheetOpen
                    ? "grid-rows-[1fr] translate-y-0 opacity-100"
                    : "pointer-events-none grid-rows-[0fr] translate-y-5 opacity-0"
                }`}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="mt-3 max-h-[calc(68dvh-4.5rem)] overflow-y-auto">
                    <RouteForm
                      origin={origin}
                      destination={destination}
                      onOriginChange={(place) => {
                        activeRouteRequestRef.current += 1;
                        setRouteLoading(false);
                        setOrigin(place);
                        setRoute(null);
                      }}
                      onDestinationChange={(place) => {
                        activeRouteRequestRef.current += 1;
                        setRouteLoading(false);
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
                        estimate={simulationTrain ? null : estimate}
                        simulationTrain={simulationTrain}
                        predictions={predictions}
                        liveStatus={displayedLiveStatus}
                      />
                      <p className="mt-2 text-center text-[12px] text-[#0B1B33]/45">
                        SIMULATION — train + crossing predictions are simulated, not for emergency use.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
