# Routz — Frontend (v1)

Mobile-friendly Next.js app that provides a polished **Google Maps driving-route experience**: search a starting location and destination, calculate a normal driving route with the Directions service, and view it on an interactive Google map.

> **Scope for v1:** driving routes only. No train detection, railroad crossings, alerts, sensors, user accounts, databases, custom rerouting, or backend.

## Tech stack

- Next.js 16 + TypeScript + App Router
- Google Maps Platform (Maps JavaScript API, Places API (New), Geocoding API, Routes API)
- Tailwind CSS v4

## Project structure

- `app/page.tsx` — page composition + route state
- `app/layout.tsx` — metadata, viewport, fonts
- `components/GoogleMap.tsx` — initializes the Google map, markers, route polyline
- `components/RouteForm.tsx` — origin/destination search + submit behavior
- `components/RouteSummary.tsx` — bottom route summary card
- `lib/googleMaps.ts` — Google Maps helpers, types, formatters, mock suggestions

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
- **Search returns nothing** — confirm **Places API (New)** is enabled on the project.
- **No route found / legacy API error** — confirm **Routes API** (not the legacy Directions API) is enabled on the project, and try more specific addresses.
- **Geolocation fails** — location requires HTTPS (or `localhost`) plus browser permission. Say route and Use my location then use a simulated start at Swearingen Engineering Center.

## Simulated voice guidance

Optional. Route search still runs in the browser if the voice backend is down.

1. Copy `backend/.env.example` to `backend/.env` and set `ELEVENLABS_API_KEY` (and the same `INTERNAL_API_TOKEN` the simulation backend uses).
2. From `backend/`, run `uv run backend`.
3. Tap **Voice** in the map header. That tap unlocks audio and speaks a short simulated line. Later crossing alerts are spoken only when a new alert arrives.
4. Tap **Say route**, then say a start and a destination, such as “from Main Street to the hospital.” Tap **Listening** to send it, or wait eight seconds. The map draws that driving route and speaks the time and distance. “Take me to …” starts from the browser’s location. If that fix is unavailable, the start is a simulated point at Swearingen Engineering Center, 301 Main St, Columbia, SC.

The page is labeled **SIMULATION / NOT FOR EMERGENCY USE**.

## Notes

- Driving routes are still requested from Google in the browser.
- Spoken alerts come from `backend/` (`GET /api/speech/{alert_id}`). The ElevenLabs key stays there.
- Watch usage in **Google Cloud Console → Billing**; set budget alerts if you share the app publicly.
