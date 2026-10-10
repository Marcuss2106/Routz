# Routz

Mobile-friendly driving-route app built on Google Maps.

## Packages

- `frontend/` — Next.js v1 app: Google map, place search, driving routes. See [frontend/README.md](frontend/README.md) for setup (requires a Google Maps Platform API key).
- `backend/` — reserved for later versions (no backend in v1).

## Quick start (v1)

```bash
cd frontend
cp .env.example .env.local
# paste your Google Maps API key into .env.local
npm install
npm run dev
```

Open http://localhost:3000.
