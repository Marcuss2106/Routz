"use client";

import { useCallback, useState } from "react";
import GoogleMap from "@/components/GoogleMap";
import RouteForm from "@/components/RouteForm";
import RouteSummary from "@/components/RouteSummary";
import {
  getDrivingRoute,
  getGoogleMapsApiKey,
  reverseGeocode,
  type PlaceResult,
  type RouteInfo,
} from "@/lib/googleMaps";

export default function Home() {
  const [origin, setOrigin] = useState<PlaceResult | null>(null);
  const [destination, setDestination] = useState<PlaceResult | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);

  const handleGetRoute = useCallback(async () => {
    setRouteError(null);

    if (!origin || !destination) {
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
    try {
      const result = await getDrivingRoute(origin, destination);
      setRoute(result);
    } catch (err) {
      setRouteError(
        err instanceof Error ? err.message : "Could not calculate a route."
      );
    } finally {
      setRouteLoading(false);
    }
  }, [origin, destination]);

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
        <header className="pointer-events-auto flex items-center justify-between rounded-2xl bg-white/95 px-4 py-2.5 shadow-[0_8px_30px_rgba(11,27,51,0.12)] backdrop-blur">
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
          <span className="rounded-full bg-[#F2F4F8] px-2.5 py-1 text-[12px] font-semibold text-[#0B1B33]/60">
            v1
          </span>
        </header>

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
                Enter a start and destination to see your driving route.
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
