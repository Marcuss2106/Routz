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
import { offsetLatLon, trainEndpoints, type BlockagePrediction, type TrainObservation } from "@/lib/trains";
import type { TrainStateEstimateEvent } from "@/lib/trainStream";

interface GoogleMapProps {
  origin: PlaceResult | null;
  destination: PlaceResult | null;
  routePath: RoutzCoordinate[] | null;
  /** Alternate candidates (drawn faint) when crossing-aware routing found options. */
  altPaths?: RoutzCoordinate[][] | null;
  train?: TrainObservation | null;
  estimate?: TrainStateEstimateEvent | null;
  predictions?: BlockagePrediction[] | null;
  isCalculating?: boolean;
  /** Pixels to keep clear above the bottom sheet when fitting the route. */
  bottomInset?: number;
  /** Pixels to keep clear below the top banner when fitting the route. */
  topInset?: number;
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

/** Small crossing badge: colored dot with railroad glyph, as a data URL. */
function crossingIcon(color: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='30' height='30' viewBox='0 0 30 30'>` +
    `<circle cx='15' cy='15' r='13' fill='${color}' stroke='white' stroke-width='3'/>` +
    `<text x='15' y='20.5' text-anchor='middle' font-family='Arial, sans-serif' font-size='13' font-weight='bold' fill='white'>✕</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

/** Train front marker, as a data URL. */
function trainIcon(color = "#0B1B33"): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='34' height='34' viewBox='0 0 34 34'>` +
    `<rect x='2' y='2' width='30' height='30' rx='8' fill='${color}' stroke='white' stroke-width='3'/>` +
    `<text x='17' y='22.5' text-anchor='middle' font-family='Arial, sans-serif' font-size='15'>🚂</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function crossingColor(status: BlockagePrediction["status"]): string | null {
  switch (status) {
    case "blocked_now":
    case "stopped_on_crossing":
      return "#B00020";
    case "blocked_soon":
      return "#E65100";
    case "upcoming":
      return "#007AFF";
    default:
      return null;
  }
}

/**
 * Initializes the Google map, renders origin/destination markers,
 * the active driving-route polyline, and simulated train/crossing overlays.
 */
export default function GoogleMap({
  origin,
  destination,
  routePath,
  altPaths = null,
  train = null,
  estimate = null,
  predictions = null,
  isCalculating = false,
  bottomInset = 300,
  topInset = 88,
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
          cameraControl: false,
          rotateControl: false,
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
      // Route points drive the camera with sheet-aware insets. Train/crossing
      // overlays get their own modest framing and never fight the sheet:
      // fitting them with a ~700px bottom inset degenerates the zoom.
      const routeBounds = new maps.LatLngBounds();
      const trainBounds = new maps.LatLngBounds();
      let hasRoutePoints = false;
      let hasTrainPoints = false;

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
        routeBounds.extend(position);
        hasRoutePoints = true;
      };

      if (origin) addMarker(origin, ORIGIN_COLOR, "A");
      if (destination) addMarker(destination, DESTINATION_COLOR, "B");

      if (routePath && routePath.length > 1) {
        const path = routePath.map((p) => {
          const point = { lat: p.latitude, lng: p.longitude };
          routeBounds.extend(point);
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
        hasRoutePoints = true;
      }

      // Alternate candidates, drawn faint underneath the chosen route.
      if (altPaths) {
        for (const alt of altPaths) {
          if (!alt || alt.length < 2) continue;
          const path = alt.map((p) => ({ lat: p.latitude, lng: p.longitude }));
          const polyline = new maps.Polyline({
            path,
            geodesic: true,
            strokeColor: "#0B1B33",
            strokeOpacity: 0.25,
            strokeWeight: 4,
          });
          polyline.setMap(map);
          overlaysRef.current.push(polyline);
        }
      }

      // Acoustic estimate: this is the detected train shown to the user. It is
      // drawn from map_state, the estimate re-expressed on the demo corridor.
      const mapState = estimate?.map_state ?? null;
      if (estimate && mapState) {
        try {
          const length = mapState.length_m ?? mapState.provisional_length_m ?? 0;
          const heading = (mapState.direction_deg_from_east ?? 0) * (Math.PI / 180);
          const east = Math.cos(heading);
          const north = Math.sin(heading);
          // map_state reports the leading point; the body trails behind it.
          const rear = offsetLatLon(mapState.latitude, mapState.longitude, -east * length, -north * length);
          const frontPos = { lat: mapState.latitude, lng: mapState.longitude };
          const marker = new maps.Marker({
            position: frontPos,
            map,
            title: `Simulated acoustic estimate ${estimate.train_id} · ${estimate.status}${mapState.length_m === null && length > 0 ? " · length provisional" : ""}`,
            icon: { url: trainIcon("#7C3AED"), scaledSize: new maps.Size(34, 34) },
          });
          overlaysRef.current.push(marker);
          if (length > 0) {
            const body = new maps.Polyline({
              path: [frontPos, { lat: rear.lat, lng: rear.lon }],
              geodesic: true,
              strokeColor: "#7C3AED",
              strokeOpacity: 0.9,
              strokeWeight: 7,
            });
            body.setMap(map);
            overlaysRef.current.push(body);
            trainBounds.extend({ lat: rear.lat, lng: rear.lon });
          }
          trainBounds.extend(frontPos);
          hasTrainPoints = true;
        } catch {
          // Acoustic overlay is best-effort.
        }
      } else if (train) {
        // Manual compatibility observation: front marker + body line to rear.
        try {
          const { front, rear } = trainEndpoints(train);
          const frontPos = { lat: front.lat, lng: front.lon };
          const marker = new maps.Marker({
            position: frontPos,
            map,
            title: `Manual train ${train.trainId}`,
            icon: { url: trainIcon(), scaledSize: new maps.Size(34, 34) },
          });
          overlaysRef.current.push(marker);
          const body = new maps.Polyline({
            path: [frontPos, { lat: rear.lat, lng: rear.lon }],
            geodesic: true,
            strokeColor: "#0B1B33",
            strokeOpacity: 0.9,
            strokeWeight: 6,
          });
          body.setMap(map);
          overlaysRef.current.push(body);
          trainBounds.extend(frontPos);
          trainBounds.extend({ lat: rear.lat, lng: rear.lon });
          hasTrainPoints = true;
        } catch {
          // Train overlay is best-effort.
        }
      }

      // Simulated crossing predictions.
      if (predictions) {
        for (const p of predictions) {
          const color = crossingColor(p.status);
          if (!color) continue;
          const position = { lat: p.latitude, lng: p.longitude };
          const marker = new maps.Marker({
            position,
            map,
            title: `Simulated: ${p.roadName} — ${p.status.replaceAll("_", " ")}`,
            icon: { url: crossingIcon(color), scaledSize: new maps.Size(30, 30) },
          });
          overlaysRef.current.push(marker);
          trainBounds.extend(position);
          hasTrainPoints = true;
        }
      }

      if (hasRoutePoints) {
        map.fitBounds(routeBounds, {
          top: topInset,
          right: 44,
          bottom: bottomInset,
          left: 44,
        });
      } else if (hasTrainPoints) {
        // Train-only framing uses fixed modest padding — the bottom sheet
        // height is unpredictable (expanded prediction lists) and huge
        // insets collapse the viewport.
        map.fitBounds(trainBounds, { top: 110, right: 60, bottom: 320, left: 60 });
      }
    } catch {
      // Rendering is best-effort; keep the base map usable.
    }
  }, [origin, destination, routePath, altPaths, train, estimate, predictions, bottomInset, topInset]);

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
        <div className="pointer-events-none absolute inset-x-0 top-20 z-10 flex justify-center px-4">
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
