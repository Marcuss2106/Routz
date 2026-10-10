# Routez — AGENTS.md

## Living document: user instructions take precedence
**Routez is an evolving project. This file describes the current plan, not an immutable specification.** Be receptive to changes requested by the user, even when they contradict this document. When the user changes architecture, tools, requirements, naming, data flow, or scope, follow the latest explicit user instruction and **update this `AGENTS.md`** (and relevant `.env.example` files or contracts) to reflect the new decision. Do not resist changes merely because they differ from the original plan. Ask for clarification only when a change is genuinely ambiguous or creates an important conflict; otherwise implement it and keep documentation synchronized. Preserve working code and security safeguards while adapting.


## Project mission
Routez is a **hackathon prototype**, not an operational emergency-response system. It demonstrates how simulated acoustic observations of a freight train could be processed to estimate train movement and predict railroad-crossing blockages. A separate ambulance-facing web app uses those predictions to compare routes and provide optional ElevenLabs voice guidance.

**Core demo:** A 3D train moves along one shared curved rail polyline past three virtual microphones. The simulation emits synchronized audio chunks derived from one prerecorded train recording, with modeled moving extended-source delays, attenuation, and noise. A Python service denoises and localizes the sound on the rail, tracks movement, estimates occupancy-derived train length, and predicts crossing occupancy. Those predictions reach the user-facing backend, which evaluates ambulance routes and streams updates to a Next.js map on an iPhone.

**Acoustic-only inference rule:** The frontend may use ground truth to render the scene and synthesize microphone audio. The simulation backend may receive only microphone signals, timestamps/sequence metadata, and microphone geometry. It must never receive train position, speed, direction, or length as inference input.

**Always label all data, routes, predictions, and claimed time savings as simulated unless independently validated. Never market this prototype as safe for real dispatch.**

## Repository layout
Keep the four existing top-level application folders. Do not merge services or introduce microservices unnecessarily.

```text
routez/
├── shared/                # simulation_geometry.json, shared physical coordinate source
├── simulation_frontend/  # Next.js, TypeScript, React Three Fiber, Drei, Zustand
├── simulation_backend/   # Python, FastAPI, NumPy, SciPy, optional scikit-learn/FilterPy
├── frontend/             # Next.js, TypeScript, Google Maps, ElevenLabs
├── backend/              # railroad motion on :8000; user voice API on :8002
└── AGENTS.md
```

### Ownership and responsibilities

**simulation-frontend**
- Render railroad track, the cached road layer, verified ground-level crossings, moving train, three microphones, and optional sound-wave visualization.
- Provide play/pause/reset, speed, direction, noise level, and train-length controls.
- Use one prerecorded `train.wav` as the common source for three **distinct** virtual microphone streams; model per-microphone sound propagation delay, attenuation, and added noise.
- Read `shared/simulation_geometry.json` for the track polyline and microphone coordinates.
- Send timestamped, synchronized audio chunks and microphone coordinates to the simulation backend. Do not send ground-truth position/speed/length/direction or a source-file hint to inference endpoints.
- May show ground-truth position in a separate debug/evaluation channel, visibly labeled.
- A single simulation clock is essential. `backend/` owns the authoritative clock, route distance, and train state; `simulation-frontend` interpolates snapshots for rendering and derives synchronized sensor chunks from that clock for `simulation_backend`.

**backend (railroad simulation service)**
- FastAPI service for cached SCDOT railroad geometry, cached OpenStreetMap roads and declared level crossings, graph/route selection, shared coordinate conversion, and authoritative train motion.
- Publishes geometry over HTTP and state at about 10 Hz over WebSocket, accepting play/pause/restart/playback-speed commands from any client.
- This service runs on port 8000. `simulation_backend` runs on port 8001 and consumes its clock indirectly through timestamped frontend audio chunks.

**simulation-backend**
- Receive audio chunks from the simulation frontend over a persistent WebSocket (preferred for continuous audio).
- Read the same `shared/simulation_geometry.json` as the frontend; reject chunks whose microphone geometry does not match it.
- Denoise the three channels; estimate relative delays with cross-correlation/GCC-PHAT; infer train `s` constrained to the shared track polyline and reject weak/contradictory evidence.
- Track consecutive estimates with `[s, velocity_along_track, acceleration]`; derive nonnegative speed and numeric degrees-from-east direction from the local rail tangent.
- Infer train length from acoustic occupancy duration. Length remains null/provisional until the train clears the array; never substitute a hard-coded consist length.
- Publish `train_state_estimate` events with confidence and uncertainty for position, speed, length, and direction.
- Send compact, timestamped crossing predictions to `user-backend` using HTTP POST for MVP simplicity; do not send raw audio downstream.
- Keep signal processing in memory; avoid saving each sample to PostgreSQL.
- Train sound is an extended source; a single moving point source is an acknowledged simulation simplification. A prerecorded sound is not evidence of real-world localization accuracy.

**user-backend (`backend/user_api.py`, port 8002)**
- Accept and validate prediction events from simulation-backend; reject duplicates and stale/out-of-order updates.
- Own PostgreSQL access, persistent crossings, recent predictions, and optional run history. Use one Vultr-hosted PostgreSQL instance; neither browser frontend gets database credentials.
- Retrieve candidate road routes from Google Maps Routes API; overlay known rail crossings and predicted blockage intervals; evaluate each candidate at its expected crossing arrival time.
- Choose the best **available candidate** by estimated total travel time, accounting for wait time or detours. Google Routes API does not directly support arbitrary predicted crossing closures; alternatives may need explicit waypoints or a different routing engine.
- Broadcast current crossing predictions, route recommendations, and alerts to user-frontend via WebSocket.
- Compose the spoken sentence on the server. `GET /api/speech/{alert_id}` looks up that sentence, asks ElevenLabs for audio, and caches the bytes by alert id. The browser never sends text to speak. If `ELEVENLABS_API_KEY` is unset, skip synthesis and still broadcast the alert text.
- Never claim to optimize emergency response using standard traffic ETAs without explaining that ambulance behavior and traffic preemption are not modeled.

**user-frontend (`frontend/`)**
- Mobile-friendly Next.js map view, demonstrated in iPhone Safari.
- With permission, use browser geolocation to display the ambulance's current location. Ask for that fix on the Say route tap. If the browser has no fix, start from a simulated point at Swearingen Engineering Center (301 Main St, Columbia) and label it simulated.
- Display route candidates, rail crossings, predicted closure/clearance windows, selected route, and simulated ETA impact.
- Receive real-time events from user-backend. A Voice toggle plays concise simulated alerts (predicted closure or clearance) by requesting `GET /api/speech/{alert_id}`. Say route records a short request, the user backend transcribes it, and the map draws that driving route and speaks the result. The tap unlocks audio for iPhone Safari. Voice is optional and must not block routing. Speak a crossing line only when its alert id changes.
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

The physical source of truth is `shared/simulation_geometry.json`; the wire source of truth is `simulation_backend/app/schemas.py`. Use a stable `simulation_id`, `sequence` increasing by exactly 1, and simulation-relative timestamps. The backend timestamps a full trailing analysis window at its center, not at the arrival time of the latest chunk.

**Shared geometry**

- Sample rate `16000` Hz, chunk duration `250` ms, **4000 PCM16 samples** per microphone.
- Local coordinates are `x_m = east`, `y_m = north`, and `s_m = distance along the rail polyline`. Microphone chunks use `audio_pcm16_base64` plus these `x_m`/`y_m` coordinates.
- Microphones are `mic-1 (0, 20)`, `mic-2 (100, 20)`, and `mic-3 (50, -30)` metres. They are non-collinear.
- Track vertices are `(0, 0)`, `(500, 0)`, and `(1000, 300)` metres. The polyline conversion does not assume constant latitude. Speed of sound is 343 m/s.
- Crossings are stored by rail distance in the shared JSON (`crossing-001` at `s=300 m`, `crossing-002` at `s=850 m`).
- Train length is never a configured backend truth; it remains null/provisional until acoustic occupancy clears the array.
- The origin is latitude 34.0007, longitude -81.0348. Positive east/north rail coordinates are converted to latitude/longitude locally.
- The backend localizes on a trailing 1 s buffer, timestamps full-window estimates at the window center, and rejects weak or contradictory delay evidence.
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
    {"id": "mic-1", "x_m": 0, "y_m": 20, "audio_pcm16_base64": "..."},
    {"id": "mic-2", "x_m": 100, "y_m": 20, "audio_pcm16_base64": "..."},
    {"id": "mic-3", "x_m": 50, "y_m": -30, "audio_pcm16_base64": "..."}
  ]
}
```

Each live chunk contains 4,000 PCM16 samples per microphone. The frontend sends
only microphone signals and geometry, plus synchronization metadata; it sends no
train state or source-file hint. The audio inference socket is
`ws://localhost:8001/ws/simulation`.

**Simulation backend -> user backend and simulation frontend**

```json
{
  "type": "train_state_estimate",
  "simulation_id": "demo-001",
  "sequence": 42,
  "simulation_time_s": 10.5,
  "train_id": "acoustic-train-demo-001-001",
  "track_id": "acoustic-track-001",
  "latitude": 34.0007,
  "longitude": -81.0339,
  "speed_mps": 8.4,
  "length_m": null,
  "direction_deg_from_east": 0.0,
  "status": "length_pending",
  "confidence": {"position": 0.91, "speed": 0.84, "length": 0.0, "direction": 0.97},
  "uncertainty": {"position_m": 6.5, "speed_mps": 0.8, "length_m": null, "direction_deg": 4.0},
  "source": "acoustic_array",
  "label": "simulated_acoustic_estimate"
}
```

These numbers are illustrative, not actual detections. `speed_mps` is nonnegative. Direction is numeric degrees from east: east `0`, north `90`, west `180`, south `270`; a curved rail uses its local tangent. `length_m` remains null until acoustic occupancy clears the array, then becomes a backend-derived estimate. Main statuses are `detected`, `length_pending`, `tracking`, `cleared`, and `unknown`. Crossing forecasts are unknown while length is unavailable. The backend generates a new `train_id` for each cleared run and supports one acoustically dominant train at a time.

If speed or location cannot be inferred, publish `unknown` and null values rather than a guessed value. Every estimate includes confidence and uncertainty for position, speed, length, and direction. The `source` is explicitly `acoustic_array` and the `label` is `simulated_acoustic_estimate`.

**Train observation -> user app (current integration format, Oct 2026)**

The inference team delivers compact train-state observations (wall-clock UTC) instead of the earlier `simulation_time_s` envelope for the user-app vertical slice. The user app derives per-road blockage windows client-side (see `frontend/lib/trains.ts`) until the user-backend prediction service lands.

```json
{
  "trainId": "train-001",
  "observedAt": "2026-10-10T20:45:00Z",
  "lat": 34.0007,
  "lon": -81.0348,
  "speedMps": 10,
  "lengthM": 1200,
  "degFromEast": 90,
  "positionReference": "front"
}
```

- `degFromEast`: math convention, counter-clockwise from east: `0` = east, `90` = north, `180` = west, `270` = south.
- `positionReference`: `front` | `center` | `rear` — which point of the train `lat`/`lon` refers to.
- `observedAt`: ISO-8601 UTC wall clock. Stale observations (>~90 s) must be flagged; do not silently treat old positions as current.
- Prediction model (MVP): straight-line constant-velocity motion along `degFromEast`; train occupies `[front - lengthM, front]`; per-crossing `blockStartUtc`/`blockEndUtc` = front-ETA / rear-clear + buffer. Crossings outside a ~120 m corridor or beyond a 15-min horizon are skipped. See `frontend/lib/routeCrossing.ts` for route-conflict scoring (route within ~45 m of a crossing + driver ETA overlapping the block window = conflict; pick the candidate with lowest travel + wait).
- Crossings are **real FRA inventory data** (Form 71, SOUTH CAROLINA / COLUMBIA, public at-grade open, Norfolk Southern, with DOT IDs) curated to two corridors in `frontend/lib/crossings.ts` and mirrored in `backend/src/backend/crossings.py`. Predictions derived from them are still simulated.
- `degFromEast` convention confirmed (Oct 2026): math CCW from east, 0=E/90=N/180=W/270=S.

**Train-observation stream (documented, not served by the current processes)**
- Planned FastAPI + SSE contract: `POST /api/train-observations`, `GET /api/predictions`, `GET /api/crossings`, `GET /api/events`. `backend/main.py` is the railroad clock and does not implement these routes. `backend/user_api.py` is the voice API.
- Frontend links via `NEXT_PUBLIC_ROUTZ_API_URL` (`frontend/lib/trainStream.ts`) and falls back to identical local math when that URL is unset or unreachable.

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
cp simulation_frontend/.env.example simulation_frontend/.env.local
cp simulation_backend/.env.example simulation_backend/.env
cp frontend/.env.example frontend/.env.local
cp backend/.env.example backend/.env
```

**Suggested templates (adapt as implementation evolves):**

`simulation-frontend/.env.example` (Next.js browser-safe configuration):

```dotenv
NEXT_PUBLIC_SIMULATION_WS_URL=ws://localhost:8000/ws/simulation
NEXT_PUBLIC_AUDIO_WS_URL=ws://localhost:8001/ws/simulation
```

`simulation-backend/.env.example` (Python/FastAPI, server-side):

```dotenv
SIMULATION_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3100
USER_BACKEND_PREDICTIONS_URL=http://localhost:8002/api/predictions
INTERNAL_API_TOKEN=replace-with-shared-private-token
AUDIO_SAMPLE_RATE_HZ=16000
```

`frontend/.env.example` (the user-facing Next.js map):

```dotenv
NEXT_PUBLIC_USER_API_URL=http://localhost:8002
NEXT_PUBLIC_USER_WS_URL=ws://localhost:8002/ws/updates
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=replace-with-browser-restricted-key
```

`backend/.env.example` (railroad motion and the user voice API):

```dotenv
SIMULATION_ALLOWED_ORIGINS=http://localhost:3000
USER_BACKEND_PORT=8002
USER_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001
INTERNAL_API_TOKEN=replace-with-shared-private-token
ELEVENLABS_API_KEY=replace-with-private-key-if-generated-server-side
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

- Current local ports are simulation frontend `3000`, rail-motion `backend.main` `8000`, audio inference `8001`, and the user voice API `backend.user_api` `8002`. The map plays audio from port `8002`. `USER_ALLOWED_ORIGINS` includes localhost and 127.0.0.1 on ports 3000 and 3001 so either Next dev URL can call the voice API.
- Next.js exposes **all `NEXT_PUBLIC_*` variables to the browser**. Only use that prefix for intentionally public configuration. Google Maps browser keys are not secrets: restrict them by HTTP referrer and API; keep Google Routes server keys private and restrict them separately.
- ElevenLabs is called from `backend/user_api.py` on port 8002. The key stays in `ELEVENLABS_API_KEY`. The map only requests `GET /api/speech/{alert_id}` and plays the audio. `ELEVENLABS_VOICE_ID` defaults to the public Rachel voice when unset. PostgreSQL and the Google server key are not read by this speech service yet.
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
