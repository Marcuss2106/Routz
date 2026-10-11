# Routz

The current first-stage deliverable is a working 3D railroad simulation around downtown Columbia, South Carolina, with aligned SCDOT rail, OpenStreetMap road, and verified ground-level crossing layers.

The repository also contains the acoustic simulation vertical slice. Its shared
physical geometry lives in `shared/simulation_geometry.json`; the 3D frontend
and Python backend both consume that configuration.

## Packages

- `frontend/` — Next.js v1 app: Google map, place search, driving routes. See [frontend/README.md](frontend/README.md) for setup (requires a Google Maps Platform API key).
- `backend/` — authoritative SCDOT/OSM scene service on port 8000 and the user-facing API on port 8002.
- `simulation_frontend/` — Three.js train scene and three virtual microphone streams.
- `simulation_backend/` — FastAPI WebSocket ingest, GCC-PHAT localization, temporal tracking, and acoustic estimates.

## Acoustic simulation

```bash
cd simulation_backend
python -m pip install -r requirements.txt
PYTHONPATH=. uvicorn app.main:app --reload --port 8001
```

In another terminal:

```bash
cd simulation_frontend
npm install
npm run dev -- -p 3100
```

Open http://localhost:3100 and inspect the acoustic estimate
panel. The backend receives only microphone audio, timestamps, sequence numbers,
and microphone geometry. All displayed values are simulated. The complete live
path is:

```text
microphone audio + microphone geometry
  -> GCC-PHAT / track-constrained localization / Kalman state
  -> train_state_estimate
  -> user backend crossing forecasts + WebSocket fan-out
  -> Google map and acoustic-driven 3D train
```

The 3D panel's optional **Voice cues** button narrates acoustic connection and
train lifecycle changes with the browser's preferred English voice. The map's
route and crossing alerts use the user backend's calm ElevenLabs voice profile.

The simulator may use ground truth internally to synthesize extended-source
audio and to render a debug truth overlay. Ground truth is never placed in the
audio wire contract or used by the acoustic estimator. The visible 3D train
follows the acoustic estimate by default; use **Show truth** only to compare it.
The authoritative rail-motion service in [`backend`](backend/README.md) supplies
the live railroad scene, while [`simulation_backend`](simulation_backend/README.md)
supplies the acoustic estimate stream. The `frontend` directory remains the
separate user-facing routing application from GitHub.

The railroad backend also includes an offline, seeded Parquet journey generator
that uses the full connected rail graph without starting the live simulation.
See [`backend/DATASET_GUIDE.md`](backend/DATASET_GUIDE.md).

For deployment and verification scaffolding, see [`deploy/README.md`](deploy/README.md)
and run `./scripts/verify.sh` after installing the backend and Node dependencies.

## Full local demo

After installing the Python dependencies for both Python services and the Node
dependencies in both frontend folders, start the complete local workflow with:

```bash
./scripts/dev.sh
```

The launcher starts the railroad API on `8000`, acoustic API on `8001`, user
API on `8002`, the user map on `3000`, and the 3D simulation on `3100`. It
uses `deploy/.env` when present and otherwise supplies safe local defaults,
including the shared internal token. If the services use different Python or
Node installations, set `ROUTZ_BACKEND_PYTHON`, `ROUTZ_SIMULATION_PYTHON`, or
`ROUTZ_NODE_DIR` before starting it.

With the services running, verify the complete microphone-only path with:

```bash
./scripts/e2e_smoke.py
```

The smoke test generates a hidden synthetic acoustic capture, sends only
microphone channels and geometry to the live acoustic WebSocket, waits for the
canonical estimate on the user-backend WebSocket, checks that no simulator
truth or audio crossed that boundary, and verifies that reset accepts sequence
`0` again.

### Live demo check and trials

With the Python services running, `scripts/e2e_live_demo.py` streams a moving
synthetic source to the acoustic WebSocket and prints what the user WebSocket
returns: anchored map positions, per-crossing blockage windows, and the spoken
alert text. `scripts/e2e_trials.py` scores localization, speed, direction and
crossing-ETA error across speeds and noise levels (simulation only).

### iPhone Safari rehearsal

```bash
ROUTZ_PHONE_HOST=192.168.1.20 ./scripts/dev.sh   # your laptop's LAN IP
```

Open `http://192.168.1.20:3000` on the phone (same Wi-Fi). Tap Voice once to
unlock audio. The map, live train, blockage windows, rerouting and spoken
alerts work over LAN HTTP. Safari only allows geolocation and the microphone on
HTTPS, so without a tunnel the start falls back to the simulated Swearingen
Engineering Center and Say route reports that the microphone is unavailable.
Everything is a simulation: not for emergency use.

## Quick start (v1)

```bash
cd frontend
cp .env.example .env.local
# paste your Google Maps API key into .env.local
npm install
npm run dev
```

Open http://localhost:3000.
