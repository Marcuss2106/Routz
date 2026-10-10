# Routz

Mobile-friendly driving-route app built on Google Maps.

The repository also contains the acoustic simulation vertical slice. Its shared
physical geometry lives in `shared/simulation_geometry.json`; the 3D frontend
and Python backend both consume that configuration.

## Packages

- `frontend/` — Next.js v1 app: Google map, place search, driving routes. See [frontend/README.md](frontend/README.md) for setup (requires a Google Maps Platform API key).
- `backend/` — reserved for later versions (no backend in v1).
- `simulation_frontend/` — Three.js train scene and three virtual microphone streams.
- `simulation_backend/` — FastAPI WebSocket ingest, GCC-PHAT localization, temporal tracking, and acoustic estimates.

## Acoustic simulation

```bash
cd simulation_backend
python -m pip install -r requirements.txt
PYTHONPATH=. uvicorn app.main:app --reload --port 8000
```

In another terminal:

```bash
cd simulation_frontend
npm install
npm run dev -- -p 3100
```

Open http://localhost:3100, enable **Stream**, and inspect the acoustic estimate
panel. The backend receives only microphone audio, timestamps, sequence numbers,
and microphone geometry. All displayed values are simulated.

## Quick start (v1)

```bash
cd frontend
cp .env.example .env.local
# paste your Google Maps API key into .env.local
npm install
npm run dev
```

Open http://localhost:3000.
