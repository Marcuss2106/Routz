# Routez — AGENTS.md

## Living document: user instructions take precedence
**Routez is an evolving project. This file describes the current plan, not an immutable specification.** Be receptive to changes requested by the user, even when they contradict this document. When the user changes architecture, tools, requirements, naming, data flow, or scope, follow the latest explicit user instruction and **update this `AGENTS.md`** (and relevant `.env.example` files or contracts) to reflect the new decision. Do not resist changes merely because they differ from the original plan. Ask for clarification only when a change is genuinely ambiguous or creates an important conflict; otherwise implement it and keep documentation synchronized. Preserve working code and security safeguards while adapting.


## Project mission
Routez is a **hackathon prototype**, not an operational emergency-response system. It demonstrates how simulated acoustic observations of a freight train could be processed to estimate train movement and predict railroad-crossing blockages. A separate ambulance-facing web app uses those predictions to compare routes and provide optional ElevenLabs voice guidance.

**Core demo:** A 3D train moves past three virtual microphones. The simulation emits synchronized audio chunks derived from one prerecorded train recording, with modeled delays, attenuation, and noise. A Python service denoises and localizes the sound, tracks movement, and predicts crossing occupancy. Those predictions reach the user-facing backend, which evaluates ambulance routes and streams updates to a Next.js map on an iPhone.

**Always label all data, routes, predictions, and claimed time savings as simulated unless independently validated. Never market this prototype as safe for real dispatch.**

## Repository layout
Keep the four existing top-level application folders. Do not merge services or introduce microservices unnecessarily.

```text
routez/
├── simulation-frontend/  # Next.js, TypeScript, React Three Fiber, Drei, Zustand
├── simulation-backend/   # Python, FastAPI, NumPy, SciPy, optional scikit-learn/FilterPy
├── user-frontend/        # Next.js, TypeScript, Google Maps, ElevenLabs
├── user-backend/         # FastAPI (preferred if Python already in use) or Node.js
└── AGENTS.md
```

### Ownership and responsibilities

**simulation-frontend**
- Render railroad track, moving train, three microphones, crossing, and optional sound-wave visualization.
- Provide play/pause/reset, speed, direction, noise level, and train-length controls.
- Use one prerecorded `train.wav` as the common source for three **distinct** virtual microphone streams; model per-microphone sound propagation delay, attenuation, and added noise.
- Send timestamped, synchronized audio chunks and microphone coordinates to the simulation backend. Do not send ground-truth position/speed to inference endpoints.
- May show ground-truth position in a separate debug/evaluation channel, visibly labeled.
- A single simulation clock is essential. `backend/` owns the authoritative clock, route distance, and train state; `simulation-frontend` interpolates snapshots for rendering and derives synchronized sensor chunks from that clock for `simulation_backend`.

**backend (railroad simulation service)**
- FastAPI service for cached SCDOT railroad geometry, graph/route selection, coordinate conversion, and shared authoritative train motion.
- Publishes geometry over HTTP and state at about 10 Hz over WebSocket, accepting play/pause/restart/playback-speed commands from any client.
- This service runs on port 8000. `simulation_backend` runs on port 8001 and consumes its clock indirectly through timestamped frontend audio chunks.

**simulation-backend**
- Receive audio chunks from the simulation frontend over a persistent WebSocket (preferred for continuous audio).
- Denoise the three channels; estimate relative delays with cross-correlation/GCC-PHAT; infer train location constrained to known track geometry.
- Track consecutive estimates to infer speed and direction; use a simple kinematic model/Kalman filter first. Predict crossing arrival and estimated clearance windows, including uncertainty.
- Send compact, timestamped crossing predictions to `user-backend` using HTTP POST for MVP simplicity; do not send raw audio downstream.
- Keep signal processing in memory; avoid saving each sample to PostgreSQL.
- Train sound is an extended source; a single moving point source is an acknowledged simulation simplification. A prerecorded sound is not evidence of real-world localization accuracy.

**user-backend**
- Accept and validate prediction events from simulation-backend; reject duplicates and stale/out-of-order updates.
- Own PostgreSQL access, persistent crossings, recent predictions, and optional run history. Use one Vultr-hosted PostgreSQL instance; neither browser frontend gets database credentials.
- Retrieve candidate road routes from Google Maps Routes API; overlay known rail crossings and predicted blockage intervals; evaluate each candidate at its expected crossing arrival time.
- Choose the best **available candidate** by estimated total travel time, accounting for wait time or detours. Google Routes API does not directly support arbitrary predicted crossing closures; alternatives may need explicit waypoints or a different routing engine.
- Broadcast current crossing predictions, route recommendations, and alerts to user-frontend via WebSocket.
- Never claim to optimize emergency response using standard traffic ETAs without explaining that ambulance behavior and traffic preemption are not modeled.

**user-frontend**
- Mobile-friendly Next.js map view, demonstrated in iPhone Safari.
- With permission, use browser geolocation to display the ambulance's current location; permit simulated ambulance movement for demos.
- Display route candidates, rail crossings, predicted closure/clearance windows, selected route, and simulated ETA impact.
- Receive real-time events from user-backend. Use ElevenLabs to speak concise alerts/directions (e.g. predicted closure and suggested reroute); voice is optional and must not block routing.
- Mark the entire experience **SIMULATION / NOT FOR EMERGENCY USE**.

## End-to-end data flow

```text
simulation-frontend (3D train + 3 virtual microphone audio streams)
  -- timestamped audio chunks + microphone positions -->
simulation-backend (denoise -> TDOA -> rail-constrained localization
                    -> speed/direction -> crossing ETA + clearance)
  -- authenticated HTTP POST prediction event -->
user-backend <--> Vultr PostgreSQL
  | Google Maps Routes API + crossing-aware candidate scoring
  -- WebSocket route/prediction events -->
user-frontend (Google Map + ambulance position + ElevenLabs voice)
```

The simulation backend may also return estimated train state to the simulation frontend for visual comparison. Keep truth and inference clearly separated.

## Minimal Python simulation backend

```text
simulation-backend/
├── app/
│   ├── __init__.py
│   ├── main.py          # FastAPI, ingestion WebSocket, orchestration
│   ├── schemas.py       # typed input/output contracts
│   ├── geometry.py      # locked mics, track, crossings, sample rate
│   ├── denoise.py       # filter noisy chunks
│   ├── localization.py  # delay estimation + rail-constrained position
│   ├── prediction.py    # tracking, crossing ETA, clearance window
│   ├── pipeline.py      # sequence checks, audio buffer, orchestration
│   ├── publisher.py     # HTTP POST to user-backend
│   └── settings.py
├── tests/
│   ├── synthetic_audio.py
│   └── test_pipeline.py
├── .env.example
├── .gitignore
└── requirements.txt
```

Start with `fastapi`, `uvicorn[standard]`, `numpy`, `scipy`, and `pydantic`; add `soundfile` where prerecorded WAV decoding happens and `scikit-learn`/`filterpy` only if actually needed. Don't introduce PyTorch, a model-training service, or a database in the simulation backend without a concrete reason.

## Event contracts

Locked for the demo. The code source of truth is `simulation_backend/app/geometry.py`. Use a stable `simulation_id`, `sequence` increasing by exactly 1, and simulation-relative `simulation_time_s` in every message. Audio must be synchronized and sampled at the same sample rate. Coordinate frames and units must be explicit.

**Locked demo scene**

- Sample rate `16000` Hz, chunk duration `250` ms, **4000 float samples** per microphone.
- The simulation frontend sends `audio_pcm16_base64` (little-endian PCM16) plus `z_m`. In that scene `y` is elevation and `z` is the other ground axis. A JSON `audio` float array with the offset in `y_m` is also accepted. Do not send both encodings in one microphone.
- Microphones, 20 m north of the rail: `mic-1` (0 m, 20 m), `mic-2` (100 m, 20 m), `mic-3` (200 m, 20 m).
- Rail is the line `y = 0`. Positive x is east. Speed of sound used by the localizer is 343 m/s.
- Crossings: `crossing-001` at rail x = 50 m, `crossing-002` at rail x = 150 m.
- Assumed consist length for blockage math is 180 m, centered on the acoustic fix. This is an assumption, not a measurement.
- Rail x = 0 maps to latitude 34.0007, longitude -81.0348. Positive x moves east in longitude.
- The backend localizes on a trailing 1 s buffer, so the first three 250 ms chunks of a run return `status: "unknown"`. The train is treated as fixed during that window. Motion that changes the delays inside the window smears the peak, and the fix is dropped instead of guessed.
- `sequence` must be exactly the previous accepted sequence plus 1. Gaps and duplicates are rejected and do not advance state. `{"type":"simulation_reset","simulation_id":"..."}` clears that run.

**Simulation -> simulation backend (WebSocket)**

```json
{
  "type": "microphone_audio_chunk",
  "simulation_id": "demo-001",
  "sequence": 42,
  "simulation_time_s": 10.5,
  "sample_rate_hz": 16000,
  "duration_ms": 250,
  "microphones": [
    {"id": "mic-1", "x_m": 0, "y_m": 20, "audio": [0.0, 0.01]},
    {"id": "mic-2", "x_m": 100, "y_m": 20, "audio": [0.0, -0.02]},
    {"id": "mic-3", "x_m": 200, "y_m": 20, "audio": [0.0, 0.03]}
  ]
}
```

`audio` arrays in the example are abbreviated. Each live chunk contains 4,000 samples per microphone. The simulation frontend sends those samples as `audio_pcm16_base64` and connects to the audio inference service at `ws://localhost:8001/ws/simulation`. Sensor `x_m` is route-local distance along the 800 m demo corridor and the ground lateral offset is sent in `y_m`.

**Simulation backend -> user backend (HTTP POST `/api/predictions`)**

```json
{
  "type": "crossing_prediction",
  "simulation_id": "demo-001",
  "sequence": 42,
  "simulation_time_s": 10.5,
  "train_id": "train-001",
  "status": "tracking",
  "estimated_position": {"latitude": 34.0007, "longitude": -81.0348},
  "estimated_speed_mps": 13.4,
  "direction": "eastbound",
  "crossings": [
    {"crossing_id": "crossing-001", "eta_seconds": 45,
     "estimated_blockage_seconds": 120, "status": "approaching"}
  ],
  "source": "simulated_audio_inference"
}
```

These numbers are illustrative, not actual detections. `eta_seconds` is relative to `simulation_time_s`, not wall time. `status` is `tracking` or `unknown`. Per-crossing `status` is `approaching`, `blocking`, `clear`, or `unknown`. While approaching, `estimated_blockage_seconds` is the full closure (assumed length / speed). While blocking, it is the remaining time until the rear clears. A stopped train publishes a near-zero speed and unknown crossing ETAs.

If speed or location cannot be inferred, publish `unknown` and null speeds rather than a guessed value. A position may still be present when speed is null. The WebSocket reply to the simulation frontend adds `estimated_position_m` (rail axis) and `"label": "estimate"`. Those two fields are not included on the user-backend POST. Only add confidence scores if calibrated or clearly defined.

**User backend -> user frontend (WebSocket)**
- Forward current predictions and selected route/alerts, with `simulation_id`, `sequence`, and timestamp.
- Reconnect and load latest state via HTTP GET if the socket drops.

## PostgreSQL on Vultr

**Only `user-backend` accesses the database.** PostgreSQL is for persistence and queries, **not** a real-time message bus or raw audio store.

Start with three tables:
- `crossings`: `id`, `name`, `latitude`, `longitude`, optional `rail_position_m` and geometry metadata.
- `train_observations`: `id`, `simulation_id`, `train_id`, `simulation_time_s`, estimated position, estimated speed, and ingestion timestamp.
- `crossing_predictions`: `id`, `simulation_id`, `train_id`, `crossing_id`, `simulation_time_s`, predicted arrival/clearance **in simulation seconds**, ingestion timestamp.

Keep optional ground truth in a separate evaluation-only dataset. Never expose PostgreSQL credentials in `NEXT_PUBLIC_*`. Store secrets in backend environment variables, use Vultr-required TLS, and authenticate inter-service ingestion. Database writes must not block live WebSocket broadcasts.

## Environment variables and `.env` conventions

**Each of the four folders owns its own environment configuration.** Do not use one shared `.env` containing every service's secrets. Commit `.env.example` files with placeholder values; never commit `.env`, `.env.local`, API keys, database passwords, or private certificates. Add these patterns to each applicable `.gitignore` (`!.env.example` allows templates):

```gitignore
.env
.env.*
!.env.example
```

Create local files by copying the relevant template, then fill in actual values:

```bash
cp simulation-frontend/.env.example simulation-frontend/.env.local
cp simulation-backend/.env.example simulation-backend/.env
cp user-frontend/.env.example user-frontend/.env.local
cp user-backend/.env.example user-backend/.env
```

**Suggested templates (adapt as implementation evolves):**

`simulation-frontend/.env.example` (Next.js browser-safe configuration):

```dotenv
NEXT_PUBLIC_SIMULATION_WS_URL=ws://localhost:8000/ws/simulation
NEXT_PUBLIC_AUDIO_WS_URL=ws://localhost:8001/ws/simulation
```

`simulation-backend/.env.example` (Python/FastAPI, server-side):

```dotenv
SIMULATION_ALLOWED_ORIGINS=http://localhost:3000
USER_BACKEND_PREDICTIONS_URL=http://localhost:8002/api/predictions
INTERNAL_API_TOKEN=replace-with-shared-private-token
AUDIO_SAMPLE_RATE_HZ=16000
```

`user-frontend/.env.example` (Next.js):

```dotenv
NEXT_PUBLIC_USER_API_URL=http://localhost:8001
NEXT_PUBLIC_USER_WS_URL=ws://localhost:8001/ws/updates
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=replace-with-browser-restricted-key
```

`user-backend/.env.example` (server-side; Python/FastAPI or equivalent):

```dotenv
DATABASE_URL=postgresql+psycopg://username:password@localhost:5432/routez
INTERNAL_API_TOKEN=replace-with-shared-private-token
GOOGLE_MAPS_SERVER_API_KEY=replace-with-server-side-key
ELEVENLABS_API_KEY=replace-with-private-key-if-generated-server-side
USER_ALLOWED_ORIGINS=http://localhost:3001
```

- Current local ports are simulation frontend `3000`, rail-motion backend `8000`, audio inference backend `8001`, and reserved user backend `8002`.
- Next.js exposes **all `NEXT_PUBLIC_*` variables to the browser**. Only use that prefix for intentionally public configuration. Google Maps browser keys are not secrets: restrict them by HTTP referrer and API; keep Google Routes server keys private and restrict them separately.
- If ElevenLabs is called from the user backend, keep its key there. Never place a secret ElevenLabs key in a browser-exposed variable; use a backend endpoint or approved short-lived token mechanism for browser voice interactions.
- The same `INTERNAL_API_TOKEN` value must be configured in both Python simulation backend and user backend. Authenticate prediction ingestion (e.g., `Authorization: Bearer <token>`) and use TLS/HTTPS in deployment. Do not put this token in either frontend.
- For Vultr PostgreSQL, use the actual connection string and required TLS settings from the provider. Restrict database network access to the user backend. Avoid logging connection URLs or credentials.
- Use `python-dotenv` or `pydantic-settings` in Python as needed; Next.js automatically reads `.env.local`. Validate required server variables on startup and fail clearly when missing.
- For deployments, set variables in the host's secret/environment manager, not committed files. Replace local `http://` / `ws://` with production `https://` / `wss://` URLs. CORS origins must match deployed frontend domains.
- When adding a new integration, **update the owning folder's `.env.example` and this section**. Never invent or hard-code credentials in source files.

## Key technical constraints

- Three microphones need known coordinates and synchronized sample clocks. Localization requires meaningful time offsets of a common acoustic signal, not just three independently playing audio files.
- Audio generation must account for the moving source and sound emission time. Simply changing the volume or shifting the same whole WAV by a fixed amount is only a preliminary demo approximation.
- The frontend's ground-truth train position/speed may drive acoustic synthesis and visual evaluation, but **must not** enter the localization/prediction algorithm as input.
- Start with one train, one track corridor, and a few known crossings. At switches or ambiguous paths, mark route prediction uncertain rather than assuming a destination.
- Estimating blockage duration needs train length and movement assumptions; stopping/reversing can invalidate the estimate.
- Distinguish train position (rail-local meters) from map coordinates (WGS84 lat/lon); define a single conversion at a known boundary.
- A browser-based audio simulator can be CPU-intensive. Generate/process modest chunks (e.g., 250 ms) and avoid pushing 16 kHz raw samples to both apps or into PostgreSQL.
- Route guidance is advisory in the demo. Never integrate with real emergency dispatch or claim safety certification.

## Implementation sequence

1. Agree on event schemas, simulation clock, microphone positions, track geometry, and crossing IDs.
2. Render one moving train and three microphones in `simulation-frontend`; implement controls and one prerecorded WAV source.
3. Generate synchronized three-channel audio chunks with controlled delay, attenuation, and noise.
4. Implement a working WebSocket ingest endpoint in `simulation-backend`; initially return mocked predictions to unblock downstream development.
5. Implement denoising, TDOA localization, tracking, and crossing ETA; compare against withheld simulation ground truth.
6. Implement `user-backend` prediction ingestion, latest-state broadcast, and simple route candidate scoring.
7. Connect the `user-frontend` Google Map, simulated/live ambulance marker, rerouting alerts, and optional ElevenLabs voice.
8. Add PostgreSQL storage of crossings and prediction history; deploy backend services and database on Vultr.
9. Run an end-to-end demo and show localization/ETA error and route impact **from simulated trials**, with assumptions disclosed.

## Team boundaries

- Simulation UI developer: 3D rendering, controls, prerecorded audio playback and virtual microphone chunk synthesis.
- Audio developer: denoising and TDOA/localization, with tests at different noise levels.
- Prediction developer: train tracking, speed/direction, rail-constrained crossing ETA and blockage windows.
- User app developers: Google Maps routing, backend ingestion/storage, live map, and ElevenLabs alerts.

People can work in parallel by mocking the agreed event contracts. Avoid cross-folder imports that couple independently deployed apps.

## Agent coding rules

- Work in the assigned folder; preserve the four-folder architecture.
- Favor a working end-to-end vertical slice over new abstractions or extra dependencies.
- Keep units explicit (`_m`, `_mps`, `_s`, `_hz`) and use typed contracts.
- Add basic tests for timestamps, localization error, ETA math, and stale-event handling.
- Log `simulation_id`, `sequence`, and processing latency for debugging.
- Keep secrets server-side; document environment variables in `.env.example`.
- If changing an event contract, update both producer and consumer and document the change.
- Clearly distinguish **simulated ground truth**, **simulated microphone signals**, **model estimates**, and **real observations** everywhere.
