# Routz — Frontend (v2: crossing-aware routing)

Mobile-friendly Next.js app that provides a polished **Google Maps driving-route experience** with **simulated train-crossing predictions**: search a starting location and destination, calculate driving candidates, overlay predicted railroad blockages, and auto-pick the route that avoids them.

> **SIMULATION — NOT FOR EMERGENCY USE.** Train observations, crossing locations, blockage windows, and time savings are simulated unless independently validated.

## Tech stack

- Next.js 16 + TypeScript + App Router
- Google Maps Platform (Maps JavaScript API, Places API (New), Geocoding API, Routes API)
- Tailwind CSS v4

## Project structure

- `app/page.tsx` — page composition + route state + crossing-aware scoring
- `app/layout.tsx` — metadata, viewport, fonts
- `components/GoogleMap.tsx` — map, markers, route polyline, train/crossing overlays
- `components/RouteForm.tsx` — origin/destination search + submit behavior
- `components/ActiveRoute.tsx` — navigation banner + crossing alerts
- `components/TrainPanel.tsx` — demo ingestion: paste train observation JSON, see blockage predictions
- `lib/googleMaps.ts` — Google Maps helpers, types, formatters, mock suggestions
- `lib/trains.ts` — `TrainObservation` type + `predictCrossingBlockages()` (straight-line constant-velocity model)
- `lib/crossings.ts` — real FRA inventory crossings (Columbia, SC, with DOT IDs)
- `lib/routeCrossing.ts` — route-vs-blockage conflict detection + candidate scoring
- `lib/trainStream.ts` — live backend link: POST observations + SSE subscription

## Live backend (optional, recommended)

The `backend/` FastAPI service computes predictions server-side and pushes
them over SSE, so every client stays in sync:

The map falls back to the same local math when `NEXT_PUBLIC_ROUTZ_API_URL` is unset. The railroad process on port 8000 does not serve that prediction stream. The user voice API on port 8002 is a different service.

## Train observations (input contract)

The inference team sends JSON like this (one observation per update):

```json
{
  "trainId": "train-001",
  "observedAt": "2026-10-10T20:45:00Z",
  "lat": 33.9929,
  "lon": -81.0158,
  "speedMps": 12,
  "lengthM": 1200,
  "degFromEast": 109,
  "positionReference": "front"
}
```

(The sample sits ~800 m south of Greene St on the real NS downtown
corridor, heading 109° — the track's actual line. The inference team's
`lat`/`lon`/`degFromEast` values will differ per observation.)

- `degFromEast`: math convention, counter-clockwise from east — `0` = east, `90` = north, `180` = west, `270` = south.
- `positionReference`: which point of the train `lat`/`lon` refers to (`front` | `center` | `rear`).
- `observedAt`: ISO-8601 UTC. Stale observations (>~90s old) produce stale predictions — the demo warns about this.

Paste an observation into the **Train crossings** panel (below the route form) or tap **Sample** to load a live one. Routz predicts per-road `blockStartUtc`/`blockEndUtc` windows, draws them on the map, checks each Google route candidate against them, and picks the fastest non-blocked option. If all candidates are blocked, it shows the expected wait instead of pretending to reroute.

## Prerequisites

- Node.js 20+
- A Google Cloud account with billing enabled (Google Maps Platform requires it, even within free-tier usage)

## 1. Create a Google Maps API key

Routz loads Google maps in the browser, so it needs a browser API key from your own Google Cloud project.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create (or select) a project.
2. Enable billing for the project (**Billing** → link a billing account). This is required by Google Maps Platform.
3. Go to **APIs & Services → Library** and enable each of these:
   - **Maps JavaScript API** (interactive map)
   - **Places API (New)** (address/place autocomplete)
   - **Geocoding API** ("Use my location" reverse lookup)
   - **Routes API** (driving routes — the legacy Directions API no longer works for new projects)
4. Go to **APIs & Services → Credentials → Create Credentials → API key**.
5. **Restrict the key** (strongly recommended — it ships to the browser):
   - **Application restrictions → HTTP referrers**: add `http://localhost:3000/*` for local dev, plus your production domain(s) when deploying (e.g. `https://yourdomain.com/*`).
   - **API restrictions**: limit the key to the four APIs above.
6. Copy the key value (it looks like `AIza...`).

Docs: [Use API keys](https://developers.google.com/maps/documentation/javascript/get-api-key).

## 2. Configure environment

```bash
cd frontend
cp .env.example .env.local
```

Then edit `.env.local` and paste your key:

```bash
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIza...
```

> The app builds without a key, but the map/search/routing will show a friendly "missing key" error until you add one. Never commit `.env.local`. If you change the key, restart the dev server.

## 3. Run locally

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — best experienced in a narrow/mobile viewport or on your phone (your key's HTTP-referrer restrictions must allow the URL you open).

## 4. Build

```bash
cd frontend
npm run build
npm run start
```

## Usage

1. Type a **Starting location** (or tap **Use my location**) and pick a suggestion.
2. Type a **Destination** and pick a suggestion.
3. Tap **Get route** — Routz draws the Google Maps driving route and shows time, distance, and addresses in the bottom card.
4. Tap **Start route** to confirm; **End** or ✕ to clear.

When an input is focused but empty, the app shows a few mock Columbia, SC suggestions so the UI is explorable before typing. Real search results and routes always come from Google Maps Platform once you type and submit.

## Troubleshooting

- **"Google Maps rejected this API key"** — check that billing is enabled, all four APIs are enabled, and your HTTP-referrer restrictions include the exact URL you're visiting (scheme + host + port).
- **Search returns nothing** — confirm **Places API (New)** and **Geocoding API** are enabled on the project (search falls back to geocoding for bare street addresses like `2435 Forest Dr, Columbia, SC 29204`). You can also type the full address and press Enter — the form geocodes it directly.
- **No route found / legacy API error** — confirm **Routes API** (not the legacy Directions API) is enabled on the project, and try more specific addresses.
- **Geolocation fails** — location requires HTTPS (or `localhost`) plus browser permission. Say route and Use my location then use a simulated start at Swearingen Engineering Center.

## Simulated voice guidance

Optional. Route search still runs in the browser if the voice backend is down.

1. Copy `backend/.env.example` to `backend/.env` and set `ELEVENLABS_API_KEY` (and the same `INTERNAL_API_TOKEN` the simulation backend uses).
2. From `backend/`, run `uv run user-backend` (port 8002). `uv run backend` is the railroad clock on port 8000.
3. Tap **Voice** in the map header. That tap unlocks audio and speaks a short simulated line. Later crossing alerts are spoken only when a new alert arrives.
4. Tap **Say route**, then say a start and a destination, such as “from Main Street to the hospital.” Tap **Listening** to send it, or wait eight seconds. The map draws that driving route and speaks the time and distance. “Take me to …” starts from the browser’s location. If that fix is unavailable, the start is a simulated point at Swearingen Engineering Center, 301 Main St, Columbia, SC.

The route sheet pulls down from the handle so the map stays visible. Simulated estimates stay labeled on alerts and predictions.

## Notes

- Driving routes are still requested from Google in the browser.
- Spoken alerts come from `backend/` (`GET /api/speech/{alert_id}`). The ElevenLabs key stays there.
- Watch usage in **Google Cloud Console → Billing**; set budget alerts if you share the app publicly.
