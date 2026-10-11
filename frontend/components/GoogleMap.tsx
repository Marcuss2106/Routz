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
import {
  haversineM,
  offsetLatLon,
  trainEndpoints,
  type BlockagePrediction,
  type RailRoutePoint,
  type TrainObservation,
} from "@/lib/trains";
import type { SimulationTrainState, TrainStateEstimateEvent } from "@/lib/trainStream";

interface GoogleMapProps {
  origin: PlaceResult | null;
  destination: PlaceResult | null;
  routePath: RoutzCoordinate[] | null;
  train?: TrainObservation | null;
  estimate?: TrainStateEstimateEvent | null;
  simulationTrain?: SimulationTrainState | null;
  simulationRailRoute?: RailRoutePoint[];
  predictions?: BlockagePrediction[] | null;
  isCalculating?: boolean;
  /** Pixels to keep clear above the bottom sheet when fitting the route. */
  bottomInset?: number;
  /** Pixels to keep clear below the top banner when fitting the route. */
  topInset?: number;
}

const ORIGIN_COLOR = "#A65353";
const DESTINATION_COLOR = "#0B1B33";
const ROUTE_COLOR = "#A65353";

/** Trace the visible consist over every saved rail vertex instead of cutting curved track corners. */
function trainPathOnRoute(
  route: RailRoutePoint[],
  frontDistanceM: number,
  trainLengthM: number
): Array<{ lat: number; lng: number }> {
  if (route.length < 2) return [];
  const cumulative = [0];
  for (let index = 1; index < route.length; index++) {
    cumulative.push(cumulative[index - 1] + haversineM(
      route[index - 1].latitude,
      route[index - 1].longitude,
      route[index].latitude,
      route[index].longitude
    ));
  }
  const routeLengthM = cumulative[cumulative.length - 1];
  const frontM = Math.max(0, Math.min(frontDistanceM, routeLengthM));
  const rearM = Math.max(0, frontM - trainLengthM);

  const pointAt = (distanceM: number) => {
    let index = 1;
    while (index < cumulative.length - 1 && cumulative[index] < distanceM) index++;
    const startM = cumulative[index - 1];
    const segmentM = cumulative[index] - startM;
    const fraction = segmentM <= 0 ? 0 : (distanceM - startM) / segmentM;
    return {
      lat: route[index - 1].latitude + (route[index].latitude - route[index - 1].latitude) * fraction,
      lng: route[index - 1].longitude + (route[index].longitude - route[index - 1].longitude) * fraction,
    };
  };

  const path = [pointAt(frontM)];
  for (let index = route.length - 2; index > 0; index--) {
    if (cumulative[index] < frontM && cumulative[index] > rearM) {
      path.push({ lat: route[index].latitude, lng: route[index].longitude });
    }
  }
  path.push(pointAt(rearM));
  return path;
}

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

/** Top-down locomotive marker. SVG points north, then rotates to its compass heading. */
function trainIcon(color = "#D32F2F", headingDeg = 0): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='34' height='34' viewBox='0 0 34 34'>` +
    `<g transform='rotate(${headingDeg.toFixed(1)} 17 17)'>` +
    `<path d='M17 2 25 8v20c0 2.2-1.8 4-4 4h-8c-2.2 0-4-1.8-4-4V8l8-6Z' fill='${color}' stroke='white' stroke-width='2.5'/>` +
    `<rect x='12' y='9' width='10' height='7' rx='2' fill='#F7D9D9'/>` +
    `<path d='M12 22h10M13 27h8' stroke='#7F1D1D' stroke-width='2' stroke-linecap='round'/>` +
    `</g>` +
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
      return "#A65353";
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
  train = null,
  estimate = null,
  simulationTrain = null,
  simulationRailRoute = [],
  predictions = null,
  isCalculating = false,
  bottomInset = 300,
  topInset = 88,
}: GoogleMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const mapsRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const activeRoutePolylineRef = useRef<any>(null);
  const predictionOverlaysRef = useRef<Map<string, any>>(new Map());
  const trainMarkerRef = useRef<any>(null);
  const trainBodyRef = useRef<any>(null);
  const framedTrainRef = useRef(false);
  const framedRouteKeyRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);

  // Initialize the map once.
  useEffect(() => {
    let cancelled = false;
    const predictionOverlays = predictionOverlaysRef.current;

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
      activeRoutePolylineRef.current?.setMap?.(null);
      activeRoutePolylineRef.current = null;
      for (const overlay of predictionOverlays.values()) overlay?.setMap?.(null);
      predictionOverlays.clear();
      trainMarkerRef.current?.setMap?.(null);
      trainBodyRef.current?.setMap?.(null);
      trainMarkerRef.current = null;
      trainBodyRef.current = null;
      mapRef.current = null;
    };
  }, []);

  // Route overlays change infrequently. Keeping these separate from the live
  // train prevents a 10 Hz train feed from rebuilding/flickering the route.
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
      const routeBounds = new maps.LatLngBounds();
      let hasRoutePoints = false;

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
        if (!activeRoutePolylineRef.current) {
          activeRoutePolylineRef.current = new maps.Polyline({ map });
        }
        activeRoutePolylineRef.current.setOptions({
          path,
          geodesic: true,
          strokeColor: ROUTE_COLOR,
          strokeOpacity: 1,
          strokeWeight: 5,
          zIndex: 20,
          map,
        });
        hasRoutePoints = true;
      } else {
        activeRoutePolylineRef.current?.setMap?.(null);
        activeRoutePolylineRef.current = null;
      }

      const routeFrameKey = routePath && origin && destination
        ? `${origin.id}:${destination.id}`
        : null;
      if (hasRoutePoints && routeFrameKey && framedRouteKeyRef.current !== routeFrameKey) {
        map.fitBounds(routeBounds, {
          top: topInset,
          right: 44,
          bottom: bottomInset,
          left: 44,
        });
        framedRouteKeyRef.current = routeFrameKey;
      } else if (!routePath) {
        framedRouteKeyRef.current = null;
      }
    } catch {
      // Rendering is best-effort; keep the base map usable.
    }
  }, [origin, destination, routePath, bottomInset, topInset, isLoading]);

  // Crossing markers can update with predictions without moving the camera or
  // touching the driving-route polylines.
  useEffect(() => {
    const map = mapRef.current;
    const maps = mapsRef.current;
    if (!map || !maps) return;
    const visible = new Set<string>();
    for (const prediction of predictions ?? []) {
      const color = crossingColor(prediction.status);
      if (!color) continue;
      visible.add(prediction.crossingId);
      let marker = predictionOverlaysRef.current.get(prediction.crossingId);
      if (!marker) {
        marker = new maps.Marker({ map });
        predictionOverlaysRef.current.set(prediction.crossingId, marker);
      }
      const nextTitle = `Simulated: ${prediction.roadName} — ${prediction.status.replaceAll("_", " ")}`;
      marker.setPosition({ lat: prediction.latitude, lng: prediction.longitude });
      marker.setTitle(nextTitle);
      if (marker.__routzStatus !== prediction.status) {
        marker.setIcon({ url: crossingIcon(color), scaledSize: new maps.Size(30, 30) });
        marker.__routzStatus = prediction.status;
      }
    }
    for (const [crossingId, marker] of predictionOverlaysRef.current) {
      if (visible.has(crossingId)) continue;
      marker.setMap(null);
      predictionOverlaysRef.current.delete(crossingId);
    }
  }, [predictions, isLoading]);

  // Update the same marker/polyline objects in place for smooth train motion.
  // The exact simulator vehicle points keep the body on curved track.
  useEffect(() => {
    const map = mapRef.current;
    const maps = mapsRef.current;
    if (!map || !maps) return;

    let path: Array<{ lat: number; lng: number }> = [];
    let title = "";
    let color = "#0B1B33";
    let markerHeadingDeg = 0;
    if (simulationTrain && train) {
      color = "#D32F2F";
      markerHeadingDeg = simulationTrain.heading_deg;
      const distinctVehicles = simulationTrain.vehicles.filter((vehicle, index, vehicles) => {
        if (index === 0) return true;
        const previous = vehicles[index - 1];
        return Math.abs(vehicle.latitude - previous.latitude) > 1e-9 ||
          Math.abs(vehicle.longitude - previous.longitude) > 1e-9;
      });
      const railPath = trainPathOnRoute(
        simulationRailRoute,
        simulationTrain.distance_along_route_m,
        simulationTrain.train_length_m
      );
      path = railPath.length > 1
        ? railPath
        : distinctVehicles.length > 0
          ? distinctVehicles.map((vehicle) => ({ lat: vehicle.latitude, lng: vehicle.longitude }))
          : [{ lat: train.lat, lng: train.lon }];

      // At the beginning of the route the backend clamps wagons with negative
      // route distance to the first rail point. Extend the missing tail behind
      // the final distinct vehicle so the train is full-length from frame one.
      const rearVehicle = distinctVehicles.at(-1);
      if (rearVehicle) {
        const representedLength = Math.max(
          0,
          simulationTrain.distance_along_route_m - rearVehicle.distance_m
        );
        const missingLength = Math.max(0, simulationTrain.train_length_m - representedLength);
        if (missingLength > 0.5) {
          const heading = rearVehicle.heading_deg * (Math.PI / 180);
          const tail = offsetLatLon(
            rearVehicle.latitude,
            rearVehicle.longitude,
            -Math.sin(heading) * missingLength,
            -Math.cos(heading) * missingLength
          );
          path.push({ lat: tail.lat, lng: tail.lon });
        }
      }
      title = `Simulation train ${simulationTrain.train_id} · ${simulationTrain.status}`;
    } else if (estimate?.map_state) {
      const state = estimate.map_state;
      const length = state.length_m ?? state.provisional_length_m ?? 0;
      const heading = (state.direction_deg_from_east ?? 0) * (Math.PI / 180);
      const rear = offsetLatLon(
        state.latitude,
        state.longitude,
        -Math.cos(heading) * length,
        -Math.sin(heading) * length
      );
      path = [{ lat: state.latitude, lng: state.longitude }, { lat: rear.lat, lng: rear.lon }];
      title = `Simulated acoustic estimate ${estimate.train_id} · ${estimate.status}`;
      color = "#7C3AED";
      markerHeadingDeg = 90 - (state.direction_deg_from_east ?? 0);
    } else if (train) {
      const { front, rear } = trainEndpoints(train);
      path = [{ lat: front.lat, lng: front.lon }, { lat: rear.lat, lng: rear.lon }];
      title = `Simulated train ${train.trainId}`;
      markerHeadingDeg = 90 - train.degFromEast;
    }

    if (path.length === 0) {
      trainMarkerRef.current?.setMap?.(null);
      trainBodyRef.current?.setMap?.(null);
      trainMarkerRef.current = null;
      trainBodyRef.current = null;
      framedTrainRef.current = false;
      return;
    }

    const front = path[0];
    if (!trainMarkerRef.current) {
      trainMarkerRef.current = new maps.Marker({ map });
    }
    trainMarkerRef.current.setOptions({
      position: front,
      title,
      icon: {
        url: trainIcon(color, markerHeadingDeg),
        scaledSize: new maps.Size(34, 34),
        anchor: new maps.Point(17, 17),
      },
      zIndex: 1000,
    });

    if (!trainBodyRef.current) {
      trainBodyRef.current = new maps.Polyline({ map, geodesic: true });
    }
    trainBodyRef.current.setOptions({
      path,
      strokeColor: color,
      strokeOpacity: 0.9,
      strokeWeight: simulationTrain ? 12 : 6,
      zIndex: 999,
    });

    if (!routePath && !framedTrainRef.current) {
      map.setCenter(front);
      map.setZoom(15);
      framedTrainRef.current = true;
    }
  }, [train, estimate, simulationTrain, simulationRailRoute, routePath, isLoading]);

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
              className="h-5 w-5 animate-spin rounded-full border-2 border-[#A65353] border-t-transparent"
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
