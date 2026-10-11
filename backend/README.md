## Railroad simulation backend

This FastAPI service owns the authoritative Columbia train clock and motion state. It is separate from `simulation_backend/`, which remains the audio-localization prototype, and from the user voice API in `backend.user_api`.

### Start locally

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
PYTHONPATH=src .venv/bin/uvicorn backend.main:app --reload --port 8000
```

`uv run backend` starts the same railroad app on port 8000.

Normal startup reads the committed rail and road caches in `src/backend/data/` and makes no external request. Optional settings are documented in `.env.example`.

The expanded road cache is already downloaded and committed at `src/backend/data/roads_columbia.geojson`; running the application does **not** require Overpass or OpenStreetMap API access. Restart the backend after replacing or updating the cache because geographic layers are loaded once when the process starts. `GET /health` reports `road_radius_m`, `road_count`, and `road_source` so the loaded cache can be verified directly.

Refresh the cache with:

```bash
PYTHONPATH=src .venv/bin/python -m backend.fetch_data
PYTHONPATH=src .venv/bin/python -m backend.fetch_roads
```

The fetcher inspects the public SCDOT layer, requests every page of `ACTIVE` and `SPUR` records intersecting a 16,093.44 m search radius, requests WGS84 output, then uses Shapely and pyproj to clip every line to the true circle in UTM 17N. It never substitutes fictional geometry.

The road fetcher caches major, secondary, and local OpenStreetMap roads within the same 10-mile (16,093.44 m) radius as the railroad network. It queries the bounding area in resumable tiles, deduplicates ways at tile boundaries, falls back from public Overpass instances to the standard OpenStreetMap map API when necessary, and clips the merged geometry to the exact metric circle. It also caches declared `railway=level_crossing` nodes. At startup, bridge, tunnel, and nonzero-layer roads are excluded from crossing candidates; declared ground crossings are snapped to the nearest SCDOT rail in UTM meters before all layers are converted by the same `CoordinateSystem`.

### HTTP and WebSocket contract

- `GET /health` — load status, selected route length, road count, and crossing count.
- `GET /api/railroad` — full rail network, road layer, verified ground crossings, route, source metadata, topology policy, and coordinate metadata.
- `GET /api/train` — current authoritative snapshot for reconnect/fallback clients.
- `WS /ws/simulation` — about 10 snapshots/second; all clients share one service-level simulation.

WebSocket commands are JSON:

```json
{"command":"play"}
{"command":"pause"}
{"command":"restart"}
{"command":"set_playback_speed","value":2}
```

State includes `train_id`, monotonic `sequence`, `simulation_time_s`, `status`, `route_id`, route distance, effective speed, WGS84 position, local scene position, heading, train length, and independently sampled vehicle positions. Heading is degrees clockwise from true north. Restart places the locomotive 210 m into the route so the locomotive and five wagons all begin on-track with visible coupling gaps. Completion occurs when the locomotive reaches the endpoint; trailing wagons remain on the route.

### Coordinates and route

Cached GeoJSON is WGS84 (`EPSG:4326`, `[longitude, latitude]`). Movement and clipping use UTM zone 17N (`EPSG:32617`) in meters. The shared origin is downtown Columbia at 34.0007, -81.0348. Three.js X is east, Y is up, and Z is south; `coordinates.py` makes this reversible.

The graph joins only source feature endpoints within 2.5 m and never creates a node merely where lines cross visually. The live demo route snaps the requested USC-area start (33.98918866218069, -81.03289988338747) and end (33.99336818146877, -81.02246011939191) to the nearest mutually connected SCDOT rails. The API and renderer still include the entire clipped railroad network, while the offline generator continues to use the complete graph. Roads, the USC College of Engineering and Computing landmark, audio trackers, crossings, and rails use the same WGS84 → UTM 17N → Three.js conversion.

### Data provenance

Rail source: SCDOT `Railroads_RO/MapServer/12`, owned by the South Carolina Department of Traffic Engineering and SCDOT GIS Office. Road and declared level-crossing source: OpenStreetMap contributors via the public APIs recorded in the road cache metadata. Both caches were retrieved October 10, 2026; exact retrieval/filter/CRS details are embedded in their top-level `metadata` objects.

## User voice API

Accepts simulated crossing predictions, broadcasts a spoken alert when the situation changes, and serves that audio from ElevenLabs. This process is separate from the railroad app so the two do not share a port.

```bash
cd backend
uv run user-backend
```

The server listens on port `8002` (`USER_BACKEND_PORT`). `GET /health` reports whether a real ElevenLabs key is configured. Placeholder values from `.env.example` count as unset.

`POST /api/voice/transcribe` accepts a short recording and returns a start and destination. `POST /api/voice/route` stores the spoken summary of a route the map already calculated. The map requests `GET /api/speech/{alert_id}` and only receives audio for a sentence this service already composed.

`POST /api/predictions` expects `Authorization: Bearer <INTERNAL_API_TOKEN>` and the crossing-prediction JSON from the simulation backend. A repeated situation is accepted and not spoken again. A duplicate or older `sequence` returns 409. `{"type":"simulation_reset","simulation_id":"..."}` clears that run.

### Tests

```bash
.venv/bin/pip install -r requirements-dev.txt
PYTHONPATH=src .venv/bin/python -m pytest -q
```

Tests cover coordinate round trips, connected route continuity, shared road/crossing alignment, whole-train placement, play/pause/restart behavior, the voice API, and offline dataset generation/replay reconstruction.

### Offline dataset generation

The dataset generator is a separate headless command. It uses the complete railroad graph, runs faster than real time, and does not start FastAPI, render Three.js, or publish WebSocket messages.

```bash
PYTHONPATH=src .venv/bin/python -m backend.dataset_generator \
  --runs 25 \
  --duration 300 \
  --sampling-rate 10 \
  --seed 20261010 \
  --batch-size 50000 \
  --prediction-horizons 5,15,30 \
  --measurement-noise-m 3 \
  --output-dir datasets/columbia-v1
```

Read selected columns and reconstruct one complete run without loading a model:

```bash
PYTHONPATH=src .venv/bin/python read_dataset.py datasets/columbia-v1 --batch-size 8
```

See [`DATASET_GUIDE.md`](DATASET_GUIDE.md) for schemas, leakage boundaries, replay reconstruction, assumptions, and the complete file layout.
