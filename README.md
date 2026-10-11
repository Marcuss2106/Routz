# Routz

The current first-stage deliverable is a working 3D railroad simulation around downtown Columbia, South Carolina, with aligned SCDOT rail, OpenStreetMap road, and verified ground-level crossing layers.

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
The authoritative rail-motion service in [`backend`](backend/README.md) supplies
the live railroad scene, while [`simulation_backend`](simulation_backend/README.md)
supplies the acoustic estimate stream. The `frontend` directory remains the
separate user-facing routing application from GitHub.

The railroad backend also includes an offline, seeded Parquet journey generator
that uses the full connected rail graph without starting the live simulation.
See [`backend/DATASET_GUIDE.md`](backend/DATASET_GUIDE.md).

## Quick start (v1)

```bash
cd frontend
cp .env.example .env.local
# paste your Google Maps API key into .env.local
npm install
npm run dev
```

Open http://localhost:3000.
