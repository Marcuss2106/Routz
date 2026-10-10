## Railroad simulation backend

This FastAPI service owns the authoritative Columbia train clock and motion state. It is separate from `simulation_backend/`, which remains the audio-localization prototype.

### Start locally

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
PYTHONPATH=src .venv/bin/uvicorn backend.main:app --reload --port 8000
```

Normal startup reads the committed cache at `src/backend/data/railroads_columbia.geojson` and makes no external request. Optional settings are documented in `.env.example`.

Refresh the cache with:

```bash
PYTHONPATH=src .venv/bin/python -m backend.fetch_data
```

The fetcher inspects the public SCDOT layer, requests every page of `ACTIVE` and `SPUR` records intersecting a 16,093.44 m search radius, requests WGS84 output, then uses Shapely and pyproj to clip every line to the true circle in UTM 17N. It never substitutes fictional geometry.

### HTTP and WebSocket contract

- `GET /health` — load status and selected route length.
- `GET /api/railroad` — full network, route, source metadata, topology policy, and coordinate metadata.
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

The graph joins only source feature endpoints within 2.5 m and never creates a node merely where lines cross visually. It first finds the substantial connected 34.5 km corridor, then selects a continuous 800 m downtown demonstration section from it. The API and renderer still include the entire clipped railroad network.

### Data provenance

Source: SCDOT `Railroads_RO/MapServer/12`, owned by the South Carolina Department of Traffic Engineering and SCDOT GIS Office. The layer reports an April 2025 update. The cache was retrieved October 10, 2026; exact retrieval/filter/CRS details are embedded in its top-level `metadata` object.

### Tests

```bash
.venv/bin/pip install -r requirements-dev.txt
PYTHONPATH=src .venv/bin/python -m pytest -q
```

Tests cover coordinate round trips, connected route continuity, whole-train placement, and play/pause/restart behavior.
