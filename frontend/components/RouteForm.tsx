"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  MOCK_SUGGESTIONS,
  geocodeAddress,
  getGoogleMapsApiKey,
  searchPlaces,
  type PlaceResult,
} from "@/lib/googleMaps";

interface RouteFormProps {
  origin: PlaceResult | null;
  destination: PlaceResult | null;
  onOriginChange: (place: PlaceResult | null) => void;
  onDestinationChange: (place: PlaceResult | null) => void;
  onGetRoute: (overrides?: {
    origin?: PlaceResult | null;
    destination?: PlaceResult | null;
  }) => void;
  onUseMyLocation: () => void;
  isLoading: boolean;
  isLocating: boolean;
}

type Field = "origin" | "destination";

/** Origin/destination search with Google Places autocomplete + submit behavior. */
export default function RouteForm({
  origin,
  destination,
  onOriginChange,
  onDestinationChange,
  onGetRoute,
  onUseMyLocation,
  isLoading,
  isLocating,
}: RouteFormProps) {
  const [originQuery, setOriginQuery] = useState(origin?.name ?? "");
  const [destinationQuery, setDestinationQuery] = useState(
    destination?.name ?? ""
  );
  // Track externally-set places (geolocation, swap) so text inputs stay in
  // sync without syncing state inside an effect.
  const [prevOriginId, setPrevOriginId] = useState<string | null>(
    origin?.id ?? null
  );
  const [prevDestinationId, setPrevDestinationId] = useState<string | null>(
    destination?.id ?? null
  );
  if ((origin?.id ?? null) !== prevOriginId) {
    setPrevOriginId(origin?.id ?? null);
    setOriginQuery(origin ? origin.name : "");
  }
  if ((destination?.id ?? null) !== prevDestinationId) {
    setPrevDestinationId(destination?.id ?? null);
    setDestinationQuery(destination ? destination.name : "");
  }
  const [originResults, setOriginResults] = useState<PlaceResult[]>([]);
  const [destinationResults, setDestinationResults] = useState<PlaceResult[]>(
    []
  );
  const [activeField, setActiveField] = useState<Field | null>(null);
  const [searchingField, setSearchingField] = useState<Field | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function runSearch(field: Field, query: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Mock locations only when there is no user input yet.
    if (query.trim() === "") {
      setSearchError(null);
      if (field === "origin") setOriginResults(MOCK_SUGGESTIONS);
      else setDestinationResults(MOCK_SUGGESTIONS);
      return;
    }
    if (query.trim().length < 3) {
      if (field === "origin") setOriginResults([]);
      else setDestinationResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      if (!getGoogleMapsApiKey()) {
        setSearchError(
          "Add your Google Maps API key to .env.local to enable live search."
        );
        if (field === "origin") setOriginResults([]);
        else setDestinationResults([]);
        return;
      }
      setSearchingField(field);
      setSearchError(null);
      try {
        const results = await searchPlaces(query);
        if (field === "origin") setOriginResults(results);
        else setDestinationResults(results);
      } catch {
        setSearchError("Search failed. Check your connection and try again.");
      } finally {
        setSearchingField((current) => (current === field ? null : current));
      }
    }, 300);
  }

  function handleFocus(field: Field) {
    setActiveField(field);
    const query = field === "origin" ? originQuery : destinationQuery;
    runSearch(field, query);
  }

  function handleSelect(field: Field, place: PlaceResult) {
    if (field === "origin") {
      onOriginChange(place);
      setPrevOriginId(place.id);
      setOriginQuery(place.name);
      setOriginResults([]);
    } else {
      onDestinationChange(place);
      setPrevDestinationId(place.id);
      setDestinationQuery(place.name);
      setDestinationResults([]);
    }
    setActiveField(null);
    setSearchError(null);
  }

  function handleClear(field: Field) {
    if (field === "origin") {
      onOriginChange(null);
      setPrevOriginId(null);
      setOriginQuery("");
      setOriginResults(MOCK_SUGGESTIONS);
    } else {
      onDestinationChange(null);
      setPrevDestinationId(null);
      setDestinationQuery("");
      setDestinationResults(MOCK_SUGGESTIONS);
    }
  }

  function handleSwap() {
    const prevOrigin = origin;
    const prevDestination = destination;
    onOriginChange(prevDestination);
    onDestinationChange(prevOrigin);
    setPrevOriginId(prevDestination?.id ?? null);
    setPrevDestinationId(prevOrigin?.id ?? null);
    setOriginQuery(prevDestination ? prevDestination.name : "");
    setDestinationQuery(prevOrigin ? prevOrigin.name : "");
  }

  function handleQueryChange(field: Field, value: string) {
    if (field === "origin") {
      setOriginQuery(value);
      // User is editing, so drop the selected place (locally initiated).
      if (origin) {
        onOriginChange(null);
        setPrevOriginId(null);
      }
    } else {
      setDestinationQuery(value);
      if (destination) {
        onDestinationChange(null);
        setPrevDestinationId(null);
      }
    }
    setActiveField(field);
    runSearch(field, value);
  }

  /** Resolve typed-but-unselected text into a routable place. */
  async function resolveTypedQuery(
    field: Field,
    query: string,
    cached: PlaceResult[]
  ): Promise<PlaceResult | null> {
    const selected = field === "origin" ? origin : destination;
    if (selected) return selected;
    if (query.trim().length < 3) return null;
    // Prefer a visible suggestion (already resolved with Place ref).
    if (cached.length > 0) return cached[0];
    const geocoded = await geocodeAddress(query);
    return geocoded[0] ?? null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setActiveField(null);
    if (isLoading || isResolving) return;

    // Enter-to-submit with raw typed addresses: resolve each side that has
    // text but no selected suggestion (e.g. exact street addresses).
    let resolvedOrigin = origin;
    let resolvedDestination = destination;
    if (!resolvedOrigin || !resolvedDestination) {
      setIsResolving(true);
      setSearchError(null);
      try {
        if (!resolvedOrigin && originQuery.trim().length >= 3) {
          resolvedOrigin = await resolveTypedQuery(
            "origin",
            originQuery,
            originResults
          );
          if (resolvedOrigin) {
            onOriginChange(resolvedOrigin);
            setPrevOriginId(resolvedOrigin.id);
            setOriginQuery(resolvedOrigin.name);
            setOriginResults([]);
          }
        }
        if (!resolvedDestination && destinationQuery.trim().length >= 3) {
          resolvedDestination = await resolveTypedQuery(
            "destination",
            destinationQuery,
            destinationResults
          );
          if (resolvedDestination) {
            onDestinationChange(resolvedDestination);
            setPrevDestinationId(resolvedDestination.id);
            setDestinationQuery(resolvedDestination.name);
            setDestinationResults([]);
          }
        }
      } catch {
        setSearchError(
          "Could not find that address. Try a more specific address."
        );
      } finally {
        setIsResolving(false);
      }
    }
    onGetRoute({ origin: resolvedOrigin, destination: resolvedDestination });
  }

  const canSubmit =
    (origin !== null || originQuery.trim().length >= 3) &&
    (destination !== null || destinationQuery.trim().length >= 3) &&
    !isLoading &&
    !isResolving;
  const activeResults =
    activeField === "origin"
      ? originResults
      : activeField === "destination"
        ? destinationResults
        : [];
  const showingMocks =
    activeField !== null &&
    (activeField === "origin" ? originQuery : destinationQuery).trim() === "";

  return (
    <form onSubmit={handleSubmit}>
      <h1 className="text-[20px] font-bold leading-tight tracking-tight">
        Where are you going?
      </h1>
      <p className="mt-0.5 mb-3 text-[13px] text-[#0B1B33]/55">
        Type a start and destination, or tap the mic and say it.
      </p>
      <div className="relative flex flex-col gap-2">
        {/* Origin input */}
        <div className="relative">
          <label htmlFor="routz-origin" className="sr-only">
            Starting location
          </label>
          <span
            className="pointer-events-none absolute left-4 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[#A65353]"
            aria-hidden
          />
          <input
            id="routz-origin"
            type="text"
            autoComplete="off"
            enterKeyHint="search"
            placeholder="Starting location"
            value={originQuery}
            onChange={(e) => handleQueryChange("origin", e.target.value)}
            onFocus={() => handleFocus("origin")}
            className="h-[52px] w-full rounded-xl bg-[#F2F4F8] pl-10 pr-11 text-[16px] font-medium text-[#0B1B33] placeholder:font-normal placeholder:text-[#0B1B33]/45 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#A65353]"
          />
          {originQuery && (
            <button
              type="button"
              onClick={() => handleClear("origin")}
              aria-label="Clear starting location"
              className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-[#0B1B33]/40 hover:bg-black/5 active:bg-black/10"
            >
              ✕
            </button>
          )}
        </div>

        {/* Swap + use-my-location row */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSwap}
            aria-label="Swap origin and destination"
            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl bg-[#F2F4F8] text-lg text-[#0B1B33] hover:bg-[#E6EAF1] active:bg-[#DCE2EC]"
          >
            ⇅
          </button>
          <button
            type="button"
            onClick={onUseMyLocation}
            disabled={isLocating}
            className="flex h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#F6EAEA] px-4 text-[15px] font-semibold text-[#A65353] hover:bg-[#F0DEDE] active:bg-[#E8D1D1] disabled:opacity-60"
          >
            {isLocating ? (
              <>
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-[#A65353] border-t-transparent"
                  aria-hidden
                />
                Locating…
              </>
            ) : (
              <>
                <svg
                  viewBox="0 0 24 24"
                  className="h-[18px] w-[18px]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden
                >
                  <circle cx="12" cy="12" r="3" />
                  <path
                    strokeLinecap="round"
                    d="M12 2v3M12 19v3M2 12h3M19 12h3"
                  />
                  <circle cx="12" cy="12" r="8" />
                </svg>
                Use my location
              </>
            )}
          </button>
        </div>

        {/* Destination input */}
        <div className="relative">
          <label htmlFor="routz-destination" className="sr-only">
            Destination
          </label>
          <span
            className="pointer-events-none absolute left-4 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[#0B1B33]"
            aria-hidden
          />
          <input
            id="routz-destination"
            type="text"
            autoComplete="off"
            enterKeyHint="search"
            placeholder="Destination"
            value={destinationQuery}
            onChange={(e) => handleQueryChange("destination", e.target.value)}
            onFocus={() => handleFocus("destination")}
            className="h-[52px] w-full rounded-xl bg-[#F2F4F8] pl-10 pr-11 text-[16px] font-medium text-[#0B1B33] placeholder:font-normal placeholder:text-[#0B1B33]/45 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#A65353]"
          />
          {destinationQuery && (
            <button
              type="button"
              onClick={() => handleClear("destination")}
              aria-label="Clear destination"
              className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-[#0B1B33]/40 hover:bg-black/5 active:bg-black/10"
            >
              ✕
            </button>
          )}
        </div>

        {/* Suggestions */}
        {activeField !== null && (
          <div className="overflow-hidden rounded-xl border border-black/[0.06] bg-white">
            {searchingField === activeField ? (
              <div className="flex items-center gap-2.5 px-4 py-3.5">
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-[#A65353] border-t-transparent"
                  aria-hidden
                />
                <p className="text-sm text-[#0B1B33]/60">Searching places…</p>
              </div>
            ) : searchError ? (
              <p className="px-4 py-3.5 text-sm text-[#B00020]">{searchError}</p>
            ) : activeResults.length > 0 ? (
              <ul className="max-h-[min(220px,28dvh)] divide-y divide-black/[0.05] overflow-y-auto">
                {showingMocks && (
                  <li className="bg-[#F7F9FC] px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[#0B1B33]/45">
                    Suggested places
                  </li>
                )}
                {activeResults.map((place) => (
                  <li key={place.id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(activeField, place)}
                      className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[#F2F6FF] active:bg-[#E8F0FF]"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#F2F4F8] text-[#0B1B33]/60">
                        <svg
                          viewBox="0 0 24 24"
                          className="h-[18px] w-[18px]"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          aria-hidden
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M19.5 10.5c0 7-7.5 11-7.5 11s-7.5-4-7.5-11a7.5 7.5 0 0 1 15 0Z"
                          />
                        </svg>
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[15px] font-semibold text-[#0B1B33]">
                          {place.name}
                        </span>
                        <span className="block truncate text-[13px] text-[#0B1B33]/55">
                          {place.formattedAddress}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3.5 text-sm text-[#0B1B33]/55">
                {showingMocks
                  ? "No suggestions available."
                  : "No places found. Try a more specific address."}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={!canSubmit}
        className="mt-3 flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-[#A65353] text-[17px] font-semibold text-white shadow-[0_4px_14px_rgba(166,83,83,0.30)] hover:bg-[#934747] active:bg-[#7F3D3D] disabled:cursor-not-allowed disabled:bg-[#A65353]/35 disabled:shadow-none"
      >
        {isLoading ? (
          <>
            <span
              className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent"
              aria-hidden
            />
            Calculating route…
          </>
        ) : isResolving ? (
          <>
            <span
              className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent"
              aria-hidden
            />
            Finding address…
          </>
        ) : (
          <>
            Get route
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
                d="M13.5 4.5 21 12l-7.5 7.5M21 12H3"
              />
            </svg>
          </>
        )}
      </button>

      {!origin || !destination ? (
        <p className="mt-2 text-center text-[13px] text-[#0B1B33]/50">
          Select a starting location and destination to get a driving route.
        </p>
      ) : null}
    </form>
  );
}
