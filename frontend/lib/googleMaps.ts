/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reusable Google Maps Platform helpers + types for Routz v1.
 *
 * The Maps JavaScript API is loaded lazily from Google's CDN and authorized
 * with a browser API key passed via `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.
 * Place autocomplete uses the Places API (New):
 * `AutocompleteSuggestion.fetchAutocompleteSuggestions`. Driving routes use
 * the Routes API (`Route.computeRoutes`).
 *
 * Docs: https://developers.google.com/maps/documentation/javascript
 */

export interface RoutzCoordinate {
  latitude: number;
  longitude: number;
}

export interface PlaceResult {
  id: string;
  name: string;
  formattedAddress: string;
  coordinate: RoutzCoordinate;
  /** Google Place ID — the unambiguous, address-backed identity of the place. */
  placeId?: string;
  /**
   * The `google.maps.places.Place` instance for this result. The JS Routes
   * library accepts Place instances directly as waypoints (more reliable
   * than re-typing a name or address string).
   */
  placeRef?: any;
}

export interface RouteInfo {
  distanceMeters: number;
  expectedTravelTimeSeconds: number;
  path: RoutzCoordinate[];
  name?: string;
}

export const GOOGLE_MAPS_JS_URL = "https://maps.googleapis.com/maps/api/js";
const LOAD_CALLBACK_NAME = "__routzGoogleMapsLoaded";

/** Default map center: Columbia, SC (neutral starting view). */
export const DEFAULT_CENTER: RoutzCoordinate = {
  latitude: 34.0007,
  longitude: -81.0348,
};

/**
 * Mock places shown ONLY when the user hasn't typed anything yet
 * (input focused + empty query). Never used as a hardcoded route.
 */
export const MOCK_SUGGESTIONS: PlaceResult[] = [
  {
    id: "mock-lady-st",
    name: "1321 Lady St",
    formattedAddress: "1321 Lady St, Columbia, SC 29201",
    coordinate: { latitude: 34.0004, longitude: -81.0344 },
  },
  {
    id: "mock-usc",
    name: "University of South Carolina",
    formattedAddress: "Columbia, SC 29208",
    coordinate: { latitude: 33.9961, longitude: -81.0274 },
  },
  {
    id: "mock-stadium",
    name: "Williams-Brice Stadium",
    formattedAddress: "1125 George Rogers Blvd, Columbia, SC 29201",
    coordinate: { latitude: 33.9731, longitude: -81.0191 },
  },
  {
    id: "mock-airport",
    name: "Columbia Metropolitan Airport",
    formattedAddress: "3250 Airport Blvd, West Columbia, SC 29170",
    coordinate: { latitude: 33.9387, longitude: -81.1195 },
  },
];

declare global {
  interface Window {
    google?: any;
  }
}

let loadPromise: Promise<any> | null = null;

export function getGoogleMapsApiKey(): string {
  return (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "").trim();
}

/** Load the Maps JavaScript API once and resolve `google.maps`. */
export function loadGoogleMaps(apiKey?: string): Promise<any> {
  if (typeof window === "undefined") {
    return Promise.reject(
      new Error("Google Maps can only load in the browser.")
    );
  }

  const key = (apiKey ?? getGoogleMapsApiKey()).trim();
  if (!key) {
    return Promise.reject(
      new Error(
        "Missing Google Maps API key. Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to your .env.local file. See README for setup."
      )
    );
  }

  if (window.google?.maps?.Map) {
    return Promise.resolve(window.google.maps);
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const fail = (message: string) => {
      loadPromise = null;
      reject(new Error(message));
    };

    (window as any)[LOAD_CALLBACK_NAME] = () => {
      if (window.google?.maps) {
        resolve(window.google.maps);
      } else {
        fail("Google Maps failed to initialize.");
      }
    };

    // Fired by Google when the key is invalid, APIs are disabled, or the
    // referrer is blocked. See README for key setup.
    (window as any).gm_authFailure = () => {
      fail(
        "Google Maps rejected this API key. Verify the key, enabled APIs (Maps JavaScript, Places (New), Geocoding, Routes), billing, and referrer restrictions in Google Cloud Console."
      );
    };

    // The key is constant per page load (env vars need a restart), so any
    // existing tag without a loaded API is a stale/failed attempt — replace it.
    document
      .querySelector('script[src*="maps.googleapis.com/maps/api/js"]')
      ?.remove();

    const script = document.createElement("script");
    script.src =
      `${GOOGLE_MAPS_JS_URL}?key=${encodeURIComponent(key)}` +
      `&libraries=places&loading=async&callback=${LOAD_CALLBACK_NAME}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      fail("Failed to load Google Maps. Check your connection and try again.");
    };
    document.head.appendChild(script);
  });

  return loadPromise;
}

/** Place autocomplete via the Places API (New), with coordinates resolved. */
export async function searchPlaces(query: string): Promise<PlaceResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const maps = await loadGoogleMaps();
  try {
    const fetchSuggestions =
      maps.places?.AutocompleteSuggestion?.fetchAutocompleteSuggestions;
    if (typeof fetchSuggestions !== "function") return [];

    const response = await fetchSuggestions.call(
      maps.places.AutocompleteSuggestion,
      { input: trimmed }
    );
    const suggestions: any[] = response?.suggestions ?? [];

    const settled = await Promise.allSettled(
      suggestions.slice(0, 5).map(async (suggestion, index): Promise<PlaceResult | null> => {
        const prediction = suggestion?.placePrediction;
        if (!prediction) return null;
        const place = prediction.toPlace();
        await place.fetchFields({
          fields: ["location", "displayName", "formattedAddress", "id"],
        });
        const location = place.location;
        const lat =
          typeof location?.lat === "function" ? location.lat() : location?.lat;
        const lng =
          typeof location?.lng === "function" ? location.lng() : location?.lng;
        if (typeof lat !== "number" || typeof lng !== "number") return null;

        // Grab the full address, not just the display name — routing depends
        // on the exact place, so keep every identifier Google gives us.
        const predictionText = asText(prediction.text);
        const structured = prediction.structuredFormat;
        const structuredText =
          asText(structured?.mainText) && asText(structured?.secondaryText)
            ? `${asText(structured.mainText)}, ${asText(structured.secondaryText)}`
            : null;
        const name =
          asText(place.displayName) ??
          asText(structured?.mainText) ??
          predictionText ??
          trimmed;
        const formattedAddress =
          asText(place.formattedAddress) ??
          structuredText ??
          predictionText ??
          name;
        const placeId =
          asText(place.id) ?? asText(prediction.placeId) ?? undefined;

        return {
          id:
            placeId ?? `place-${lat.toFixed(5)}-${lng.toFixed(5)}-${index}`,
          name,
          formattedAddress,
          coordinate: { latitude: lat, longitude: lng },
          ...(placeId ? { placeId } : {}),
          placeRef: place,
        } satisfies PlaceResult;
      })
    );

    return settled
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((p): p is PlaceResult => p !== null);
  } catch {
    return [];
  }
}

export interface ReverseGeocodeResult {
  address: string;
  placeId?: string;
}

/** Reverse-geocode a coordinate into a human-readable address + Place ID. */
export async function reverseGeocode(
  latitude: number,
  longitude: number
): Promise<ReverseGeocodeResult> {
  const maps = await loadGoogleMaps();
  return new Promise((resolve, reject) => {
    try {
      const geocoder = new maps.Geocoder();
      geocoder.geocode(
        { location: { lat: latitude, lng: longitude } },
        (results: any, status: any) => {
          const first = results?.[0];
          if (String(status) !== "OK" || !first?.formatted_address) {
            reject(new Error("Could not look up this location's address."));
            return;
          }
          resolve({
            address: first.formatted_address as string,
            placeId: asText(first.place_id) ?? undefined,
          });
        }
      );
    } catch {
      reject(new Error("Could not look up this location's address."));
    }
  });
}

/** Places API (New) text comes back as a string or a `{ text }` object. */
function asText(value: any): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (
    value &&
    typeof value.text === "string" &&
    value.text.trim() !== ""
  ) {
    return value.text;
  }
  return null;
}

/**
 * Calculate a standard driving route via the Routes API.
 * Waypoints use the exact `Place` instance (address-backed) when we have
 * one, so routing never depends on a vague display name. Note the JS Routes
 * library only accepts Place instances, LatLngs, or address strings —
 * not REST-style `{ placeId }` / `{ location: { latLng } }` objects.
 */
export async function getDrivingRoute(
  origin: PlaceResult,
  destination: PlaceResult
): Promise<RouteInfo> {
  const maps = await loadGoogleMaps();

  // The Routes library loads on demand. (The legacy DirectionsService is not
  // available to new Google Cloud projects, hence this migration.)
  if (typeof maps.importLibrary === "function") {
    try {
      await maps.importLibrary("routes");
    } catch {
      // Fall through to the availability check below.
    }
  }
  const computeRoutes = maps.routes?.Route?.computeRoutes;
  if (typeof computeRoutes !== "function") {
    throw new Error(
      "Google's Routes API isn't available. Enable the Routes API for your key in Google Cloud Console, then try again."
    );
  }

  // The JS wrapper rejects REST-style "DRIVE" — it wants the classic
  // Maps enum value ("DRIVING"). Try every known location for it.
  const travelMode =
    maps.TravelMode?.DRIVING ??
    maps.routes?.TravelMode?.DRIVING ??
    maps.routes?.TravelMode?.DRIVE ??
    "DRIVING";
  // The Routes API requires an explicit field mask: no `fields`, no route.
  // The JS wrapper takes Route-relative names (it prefixes `routes.` itself).
  // NOTE: its validator only accepts a subset — duration/polyline must be
  // derived from `legs` — so request the accepted fields and stitch the
  // path + totals from the legs below.
  const fields = ["distanceMeters", "legs", "description"];
  const requestFor = (from: any, to: any) => ({
    origin: from,
    destination: to,
    travelMode,
    fields,
  });
  const usedPlace = Boolean(origin.placeRef || destination.placeRef);

  const routesOf = (res: any): any[] =>
    Array.isArray(res) ? res : (res?.routes ?? []);

  let response: any;
  try {
    response = await computeRoutes.call(
      maps.routes.Route,
      requestFor(toWaypoint(origin, maps), toWaypoint(destination, maps))
    );
    // An empty result with Place waypoints earns one coordinate retry.
    if (usedPlace && routesOf(response).length === 0) {
      try {
        const retry = await computeRoutes.call(
          maps.routes.Route,
          requestFor(
            toCoordinateWaypoint(origin, maps),
            toCoordinateWaypoint(destination, maps)
          )
        );
        if (routesOf(retry).length > 0) response = retry;
      } catch {
        // Keep the original response so diagnostics below describe it.
      }
    }
  } catch (err) {
    if (usedPlace) {
      // Retry with pure coordinates in case a Place reference was stale.
      try {
        response = await computeRoutes.call(
          maps.routes.Route,
          requestFor(
            toCoordinateWaypoint(origin, maps),
            toCoordinateWaypoint(destination, maps)
          )
        );
      } catch {
        throw new Error(describeRouteError(err));
      }
    } else {
      throw new Error(describeRouteError(err));
    }
  }

  const routes = routesOf(response);
  const route = routes[0];
  const legs: any[] = Array.isArray(route?.legs) ? route.legs : [];
  // Path shapes vary by library version — try route, leg, then step level.
  const path = extractPath(maps, route);

  if (!route || path.length < 2) {
    throw new Error(
      "Google couldn't build a route for these locations. Try adjusting them." +
        describeEmptyRoute(route, routes, legs)
    );
  }

  const distanceMeters =
    toFiniteNumber(route.distanceMeters) ??
    sumNumbers(legs.map((leg) => toFiniteNumber(leg.distanceMeters))) ??
    0;
  const expectedTravelTimeSeconds =
    durationToSeconds(route.duration) ??
    durationToSeconds(route.staticDuration) ??
    sumNumbers(legs.map((leg) => durationToSeconds(leg.duration))) ??
    0;

  return {
    distanceMeters,
    expectedTravelTimeSeconds,
    path,
    name:
      typeof route.description === "string" && route.description
        ? route.description
        : undefined,
  };
}

function toFiniteNumber(value: any): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The JS Routes library accepts Place instances, LatLngs, or address
 * strings as waypoints. Prefer the exact Place; fall back to coordinates
 * (current location, mock places).
 */
function toWaypoint(place: PlaceResult, maps: any): any {
  if (place.placeRef) return place.placeRef;
  return toCoordinateWaypoint(place, maps);
}

function toCoordinateWaypoint(place: PlaceResult, maps: any): any {
  const { latitude, longitude } = place.coordinate;
  if (typeof maps.LatLng === "function") {
    try {
      return new maps.LatLng(latitude, longitude);
    } catch {
      // Fall through to the literal form.
    }
  }
  return { lat: latitude, lng: longitude };
}

/** Pull coordinates out of whatever path shape the Routes library returns. */
function extractPath(maps: any, route: any): RoutzCoordinate[] {
  if (!route) return [];
  const direct = pathFromPolylineValue(maps, route.polyline);
  if (direct.length >= 2) return direct;
  const routePoints = pathFromPointArray(route.path);
  if (routePoints.length >= 2) return routePoints;

  const legs: any[] = Array.isArray(route.legs) ? route.legs : [];
  const stitched: RoutzCoordinate[] = [];
  for (const leg of legs) {
    const legPath = pathFromPolylineValue(maps, leg?.polyline);
    if (legPath.length > 0) {
      stitched.push(...legPath);
      continue;
    }
    const legPoints = pathFromPointArray(leg?.path);
    if (legPoints.length > 0) {
      stitched.push(...legPoints);
      continue;
    }
    const steps: any[] = Array.isArray(leg?.steps) ? leg.steps : [];
    for (const step of steps) {
      stitched.push(
        ...pathFromPolylineValue(maps, step?.polyline),
        ...pathFromPointArray(step?.path)
      );
    }
  }
  // Drop duplicate points where segments meet.
  return stitched.filter(
    (p, i) =>
      i === 0 ||
      p.latitude !== stitched[i - 1].latitude ||
      p.longitude !== stitched[i - 1].longitude
  );
}

/** Decode a polyline given as `{ encodedPolyline }`, a raw string, or junk. */
function pathFromPolylineValue(maps: any, value: any): RoutzCoordinate[] {
  if (!value) return [];
  if (typeof value === "string") {
    return value ? decodeRoutePolyline(maps, value) : [];
  }
  const encoded: unknown =
    value.encodedPolyline ?? value.points ?? value.polyline;
  if (typeof encoded === "string" && encoded) {
    return decodeRoutePolyline(maps, encoded);
  }
  return [];
}

/** Normalize a pre-decoded point array (LatLngs, literals, tuples). */
function pathFromPointArray(value: any): RoutzCoordinate[] {
  if (!Array.isArray(value)) return [];
  const out: RoutzCoordinate[] = [];
  for (const p of value) {
    if (!p) continue;
    if (typeof p.lat === "function" && typeof p.lng === "function") {
      out.push({ latitude: p.lat(), longitude: p.lng() });
    } else if (
      typeof p.latitude === "number" &&
      typeof p.longitude === "number"
    ) {
      out.push({ latitude: p.latitude, longitude: p.longitude });
    } else if (typeof p.lat === "number" && typeof p.lng === "number") {
      out.push({ latitude: p.lat, longitude: p.lng });
    } else if (
      Array.isArray(p) &&
      typeof p[0] === "number" &&
      typeof p[1] === "number"
    ) {
      out.push({ latitude: p[0], longitude: p[1] });
    }
  }
  return out;
}

/** Summarize an unusable response so the next error message is actionable. */
function describeEmptyRoute(route: any, routes: any[], legs: any[]): string {
  try {
    if (typeof console !== "undefined") {
      const seen = new WeakSet();
      const shape = JSON.stringify({ routes }, (_key, value) => {
        if (typeof value === "function") return "[function]";
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[circular]";
          seen.add(value);
        }
        return value;
      });
      console.error("Routz empty-route response:", shape?.slice(0, 3000));
    }
  } catch {
    // Logging is best-effort.
  }
  try {
    const keysOf = (o: any) =>
      o && typeof o === "object" ? Object.keys(o).join(",") : typeof o;
    return (
      ` (debug: routes=${routes.length}, legs=${legs.length}, ` +
      `routeKeys=[${keysOf(route)}], leg0Keys=[${keysOf(legs[0])}])`
    );
  } catch {
    return "";
  }
}

/**
 * Turn a Routes API failure into an actionable message. Config problems
 * (disabled API, key restrictions, billing) surface Google's detail instead
 * of the generic "no route" hint.
 */
function describeRouteError(err: unknown): string {
  if (typeof console !== "undefined") {
    console.error("Routz route error:", err);
  }
  const detail =
    err instanceof Error && err.message ? err.message : String(err ?? "");
  if (
    /api.*key|not enabled|enable|permission|denied|quota|billing|REQUEST_DENIED|LegacyApi/i.test(
      detail
    )
  ) {
    return (
      "Google Routes error: " +
      (detail || "request denied.") +
      " Check that the Routes API is enabled and your key restrictions allow this site — see README."
    );
  }
  return (
    "No driving route found between these locations. Try more specific addresses." +
    (detail ? ` (Google: ${detail})` : "")
  );
}

function sumNumbers(values: (number | null)[]): number | null {
  let total = 0;
  let found = false;
  for (const value of values) {
    if (typeof value === "number") {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

/** Routes API durations look like "831s" (string); be liberal in parsing. */
function durationToSeconds(value: any): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.match(/[\d.]+/);
    if (match) {
      const seconds = parseFloat(match[0]);
      if (Number.isFinite(seconds)) return seconds;
    }
  }
  if (value && typeof value.seconds === "number") return value.seconds;
  return null;
}

/** Decode an encoded polyline, preferring Google's decoder when present. */
function decodeRoutePolyline(maps: any, encoded: string): RoutzCoordinate[] {
  const decode = maps.geometry?.encoding?.decodePath;
  if (typeof decode === "function") {
    try {
      return decode
        .call(maps.geometry.encoding, encoded)
        .map((p: any) => ({ latitude: p.lat(), longitude: p.lng() }))
        .filter(
          (p: any): p is RoutzCoordinate =>
            typeof p.latitude === "number" && typeof p.longitude === "number"
        );
    } catch {
      // Fall through to the local decoder.
    }
  }
  return decodePolyline(encoded);
}

/** Local encoded-polyline decoder (fallback if geometry library is absent). */
function decodePolyline(encoded: string): RoutzCoordinate[] {
  const path: RoutzCoordinate[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    path.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return path;
}

/** e.g. 840 -> "14 min", 3900 -> "1 hr 5 min" */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "—";
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hr`;
  return `${hours} hr ${remainder} min`;
}

/** e.g. 5150 -> "3.2 mi", 120 -> "394 ft" */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "—";
  const miles = meters / 1609.344;
  if (miles < 0.1) {
    const feet = Math.round(meters * 3.28084);
    return `${feet} ft`;
  }
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}
