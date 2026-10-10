export type HereFix = {
  latitude: number;
  longitude: number;
};

const FRESH_MS = 120_000;

let cached: { fix: HereFix; at: number } | null = null;
let inflight: Promise<HereFix | null> | null = null;

/** Start a location request during a tap, so Safari can show the permission prompt. */
export function armCurrentLocation(): void {
  void readCurrentLocation();
}

/** Latest browser fix, or null when permission or a position is unavailable. */
export function readCurrentLocation(): Promise<HereFix | null> {
  if (cached && Date.now() - cached.at < FRESH_MS) {
    return Promise.resolve(cached.fix);
  }
  if (inflight) return inflight;
  inflight = new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fix = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        cached = { fix, at: Date.now() };
        resolve(fix);
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: FRESH_MS }
    );
  }).finally(() => {
    inflight = null;
  });
  return inflight;
}
