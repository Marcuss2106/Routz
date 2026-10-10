"use client";

import { useCallback, useState } from "react";
import GoogleMap from "@/components/GoogleMap";
import RouteForm from "@/components/RouteForm";
import RouteSummary from "@/components/RouteSummary";
import {
  useVoiceGuidance,
  VoiceAlert,
  VoiceButton,
  VoiceProvider,
} from "@/components/VoiceGuidance";
import VoiceRouteButton from "@/components/VoiceRouteButton";
import {
  DEFAULT_CENTER,
  getDrivingRoute,
  getGoogleMapsApiKey,
  reverseGeocode,
  type PlaceResult,
  type RouteInfo,
} from "@/lib/googleMaps";
import { readCurrentLocation } from "@/lib/here";
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
    coordinate: { ...DEFAULT_CENTER },
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
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);

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

  const calculateRoute = useCallback(
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
      try {
        const result = await getDrivingRoute(from, to);
        const start = result.path[0];
        const end = result.path[result.path.length - 1];
        const snappedFrom =
          from.addressQuery && start ? { ...from, coordinate: start } : from;
        const snappedTo =
          to.addressQuery && end ? { ...to, coordinate: end } : to;
        if (snappedFrom !== from) setOrigin(snappedFrom);
        if (snappedTo !== to) setDestination(snappedTo);
        setRoute(result);
        if (speakResult || voice.enabled) {
          try {
            const alert = await registerRouteSpeech({
              origin_name: snappedFrom.name,
              destination_name: snappedTo.name,
              duration_seconds: result.expectedTravelTimeSeconds,
              distance_meters: result.distanceMeters,
            });
            voice.speak(alert);
          } catch {
            // The drawn route does not depend on speech.
          }
        }
      } catch (err) {
        setRouteError(
          err instanceof Error ? err.message : "Could not calculate a route."
        );
      } finally {
        setRouteLoading(false);
      }
    },
    [voice]
  );

  const handleGetRoute = useCallback(async () => {
    if (!origin || !destination) {
      setRouteError("Enter both a starting location and a destination.");
      return;
    }
    await calculateRoute(origin, destination, false);
  }, [origin, destination, calculateRoute]);

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
        setRouteError(`Could not find ${request.origin_query ?? "the start"}. Try a more specific name.`);
        return;
      }
      setOrigin(nextOrigin);
      setDestination(nextDestination);
      await calculateRoute(nextOrigin, nextDestination, true);
    },
    [locate, calculateRoute]
  );

  const handleUseMyLocation = useCallback(() => {
    void locate().then((place) => {
      setOrigin(place);
      setRoute(null);
    });
  }, [locate]);

  const handleClearRoute = useCallback(() => {
    setRoute(null);
    setRouteError(null);
  }, []);

  return (
    <div className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-[#E8EEF4] text-[#0B1B33]">
      {/* Full-bleed Google map */}
      <div className="absolute inset-0">
        <GoogleMap
          origin={origin}
          destination={destination}
          routePath={route?.path ?? null}
          isCalculating={routeLoading}
        />
      </div>

      {/* Top: brand + search */}
      <div className="pointer-events-none relative z-10 mx-auto flex w-full max-w-md flex-col gap-2.5 p-3 pb-0 sm:max-w-lg">
        <header className="pointer-events-auto flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white/95 px-4 py-2.5 shadow-[0_8px_30px_rgba(11,27,51,0.12)] backdrop-blur">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#007AFF] text-white shadow-[0_4px_12px_rgba(0,122,255,0.4)]">
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
                  d="M9 20l-5.5-2.5v-13L9 7l6-2.5L20.5 7v13L15 17.5 9 20Zm0 0v-13m6-2.5v13"
                />
              </svg>
            </span>
            <span>
              <span className="block text-[17px] font-bold leading-tight">
                Routz
              </span>
              <span className="block text-[12px] leading-tight text-[#0B1B33]/55">
                Driving routes
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <VoiceRouteButton
              disabled={routeLoading}
              onRequest={handleSpokenRoute}
            />
            <VoiceButton />
            <span className="rounded-full bg-[#F2F4F8] px-2.5 py-1 text-[12px] font-semibold text-[#0B1B33]/60">
              v1
            </span>
          </div>
        </header>

        <VoiceAlert />

        <div className="pointer-events-auto">
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
        </div>

        {/* Error state */}
        {routeError && (
          <div
            role="alert"
            className="pointer-events-auto flex items-start gap-2.5 rounded-2xl border border-[#B00020]/15 bg-[#FFF5F5] p-3.5 shadow-lg"
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
      </div>

      <div className="flex-1" />

      {/* Bottom: route summary or empty-state hint */}
      <div className="relative z-10 mx-auto w-full max-w-md p-3 pt-0 sm:max-w-lg pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {route && origin && destination ? (
          <RouteSummary
            route={route}
            origin={origin}
            destination={destination}
            onClose={handleClearRoute}
          />
        ) : (
          !routeLoading && (
            <div className="flex items-center gap-3 rounded-2xl bg-white/95 px-4 py-3 shadow-[0_8px_30px_rgba(11,27,51,0.12)] backdrop-blur">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#EAF2FF] text-[#007AFF]">
                <svg
                  viewBox="0 0 24 24"
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 20l-5.5-2.5v-13L9 7l6-2.5L20.5 7v13L15 17.5 9 20Zm0 0v-13m6-2.5v13"
                  />
                </svg>
              </span>
              <p className="text-[14px] leading-5 text-[#0B1B33]/70">
                <span className="font-semibold text-[#0B1B33]">
                  Plan your drive.
                </span>{" "}
                Enter a start and destination, or tap Say route and speak both places.
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
