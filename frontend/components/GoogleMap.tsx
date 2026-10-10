"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_CENTER,
  getGoogleMapsApiKey,
  loadGoogleMaps,
  type PlaceResult,
  type RoutzCoordinate,
} from "@/lib/googleMaps";

interface GoogleMapProps {
  origin: PlaceResult | null;
  destination: PlaceResult | null;
  routePath: RoutzCoordinate[] | null;
  isCalculating?: boolean;
}

const ORIGIN_COLOR = "#007AFF";
const DESTINATION_COLOR = "#0B1B33";
const ROUTE_COLOR = "#007AFF";

/** Brand-colored map pin with a letter, as a data URL. */
function pinIcon(color: string, letter: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='36' height='36' viewBox='0 0 36 36'>` +
    `<path d='M18 2C10.8 2 5 7.8 5 15c0 9.2 13 19 13 19s13-9.8 13-19C31 7.8 25.2 2 18 2z' fill='${color}'/>` +
    `<text x='18' y='19.5' text-anchor='middle' font-family='Arial, sans-serif' font-size='13' font-weight='bold' fill='white'>${letter}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

/**
 * Initializes the Google map, renders origin/destination markers,
 * and draws the active driving-route polyline.
 */
export default function GoogleMap({
  origin,
  destination,
  routePath,
  isCalculating = false,
}: GoogleMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const mapsRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);

  // Initialize the map once.
  useEffect(() => {
    let cancelled = false;

    async function init() {
      const container = containerRef.current;
      if (!container) return;

      const apiKey = getGoogleMapsApiKey();
      if (!apiKey) {
        setIsLoading(false);
        setMapError(
          "Missing Google Maps API key. Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to frontend/.env.local — see README for setup."
        );
        return;
      }

      try {
        const maps = await loadGoogleMaps(apiKey);
        if (cancelled) return;
        mapsRef.current = maps;

        container.innerHTML = "";
        const map = new maps.Map(container, {
          center: {
            lat: DEFAULT_CENTER.latitude,
            lng: DEFAULT_CENTER.longitude,
          },
          zoom: 13,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          zoomControl: false,
          // The page itself doesn't scroll, so single-finger gestures are safe.
          gestureHandling: "greedy",
        });
        mapRef.current = map;
        setMapError(null);
      } catch (err) {
        if (!cancelled) {
          setMapError(
            err instanceof Error ? err.message : "Failed to load Google Maps."
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    init();

    return () => {
      cancelled = true;
      for (const overlay of overlaysRef.current) {
        try {
          overlay?.setMap?.(null);
        } catch {
          // teardown is best-effort
        }
      }
      overlaysRef.current = [];
      mapRef.current = null;
    };
  }, []);

  // Sync markers + route polyline whenever inputs change.
  useEffect(() => {
    const map = mapRef.current;
    const maps = mapsRef.current;
    if (!map || !maps) return;

    for (const overlay of overlaysRef.current) {
      try {
        overlay?.setMap?.(null);
      } catch {
        // ignore cleanup errors from Maps internals
      }
    }
    overlaysRef.current = [];

    try {
      const bounds = new maps.LatLngBounds();
      let hasPoints = false;

      const addMarker = (place: PlaceResult, color: string, letter: string) => {
        const position = {
          lat: place.coordinate.latitude,
          lng: place.coordinate.longitude,
        };
        const marker = new maps.Marker({
          position,
          map,
          title: place.name,
          icon: {
            url: pinIcon(color, letter),
            scaledSize: new maps.Size(36, 36),
          },
        });
        overlaysRef.current.push(marker);
        bounds.extend(position);
        hasPoints = true;
      };

      if (origin) addMarker(origin, ORIGIN_COLOR, "A");
      if (destination) addMarker(destination, DESTINATION_COLOR, "B");

      if (routePath && routePath.length > 1) {
        const path = routePath.map((p) => {
          const point = { lat: p.latitude, lng: p.longitude };
          bounds.extend(point);
          return point;
        });
        const polyline = new maps.Polyline({
          path,
          geodesic: true,
          strokeColor: ROUTE_COLOR,
          strokeOpacity: 1,
          strokeWeight: 5,
        });
        polyline.setMap(map);
        overlaysRef.current.push(polyline);
        hasPoints = true;
      }

      if (hasPoints) {
        map.fitBounds(bounds, {
          top: 190,
          right: 44,
          bottom: routePath && routePath.length > 1 ? 320 : 240,
          left: 44,
        });
      }
    } catch {
      // Rendering is best-effort; keep the base map usable.
    }
  }, [origin, destination, routePath]);

  return (
    <div className="relative h-full w-full bg-[#E8EEF4]">
      <div
        ref={containerRef}
        data-testid="google-map"
        className="absolute inset-0 h-full w-full"
        aria-label="Google map"
        role="application"
      />

      {/* Loading state */}
      {isLoading && !mapError && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#E8EEF4]/80 backdrop-blur-[1px]">
          <div className="flex items-center gap-3 rounded-2xl bg-white px-5 py-4 shadow-lg">
            <span
              className="h-5 w-5 animate-spin rounded-full border-2 border-[#007AFF] border-t-transparent"
              aria-hidden
            />
            <p className="text-sm font-medium text-[#0B1B33]">
              Loading Google Maps…
            </p>
          </div>
        </div>
      )}

      {/* Route-calculating indicator */}
      {!isLoading && !mapError && isCalculating && (
        <div className="pointer-events-none absolute inset-x-0 top-44 z-10 flex justify-center px-4">
          <div className="flex items-center gap-2.5 rounded-full bg-[#0B1B33]/90 px-4 py-2.5 shadow-xl backdrop-blur">
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
              aria-hidden
            />
            <p className="text-sm font-medium text-white">
              Finding best driving route…
            </p>
          </div>
        </div>
      )}

      {/* Error / missing-key state */}
      {mapError && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
          <div className="max-w-sm rounded-2xl bg-white p-5 text-center shadow-xl">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[#FFF3E0]">
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6 text-[#E65100]"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
                />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-[#0B1B33]">
              Google Maps unavailable
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[#0B1B33]/70">
              {mapError}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
