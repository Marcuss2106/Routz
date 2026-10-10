## Railroad simulation frontend

The simulation frontend is the 3D side of Routz's prototype architecture. It
renders a train moving on the shared curved railroad polyline, three fixed
virtual microphones, and the signal strength each microphone receives on the
simulated ground plane.

The geometry source is `../shared/simulation_geometry.json`: `x` is east, `y`
is north, and `s` is distance along the rail. The backend uses the same file,
so the frontend and estimator cannot silently drift to different microphone
locations or track lengths.

The browser loads `train.wav` through `/api/train-audio` when the repository
asset is available. Each microphone then receives a separate PCM stream from a
moving extended-source model with per-segment propagation delay, distance
attenuation, rear cutoff, and configurable noise. If no
audio asset is available, the same pipeline uses a deterministic synthetic
train signal so the scene remains usable.

The optional **Stream** control sends synchronized JSON WebSocket chunks to
`NEXT_PUBLIC_SIMULATION_WS_URL` (default: `ws://localhost:8000/ws/simulation`).
Streaming is off by default. The simulation backend accepts those PCM16 chunks
on `/ws/simulation` and returns `train_state_estimate` events containing
track-constrained acoustic position, speed, numeric direction, confidence, and
an occupancy-derived length once the train clears the array.

## Getting Started

Run the two backends and frontend in three separate terminals. Keep all processes running.

Terminal 1:

```bash
cd ../backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
PYTHONPATH=src .venv/bin/uvicorn backend.main:app --reload --port 8000
```

Terminal 2:

```bash
cd ../simulation_backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8001
```

Terminal 3, from this directory:

```bash
cd simulation_frontend
npm install
npm run dev
```

Open http://localhost:3000. Copy `.env.example` to `.env.local` only if a service is hosted somewhere other than the defaults. The rail-motion service uses port 8000; audio inference uses port 8001.

If the page reports that it cannot load the network, verify http://localhost:8000/health in a browser. A healthy backend returns JSON containing `"status":"ok"`.

The renderer uses React Three Fiber, Three.js, and Drei. It displays the complete cached SCDOT rail network, an OpenStreetMap road layer, and verified ground-level rail crossings while the repeatable active corridor is 800 m. Every geographic layer uses the backend's shared UTM-to-scene conversion. Physical movement remains in backend meters. Rendering-only exaggeration is isolated in `src/lib/simulation.ts`. The locomotive and five wagons are independently sampled along the route; all six emit fading ground waves. Three route-local audio sensors generate synchronized PCM streams for the inference backend.

Rail rendering uses a distance-based LOD with a hysteresis band: nearby views show paired rails and instanced sleepers, while distant views fade to continuous `Line2` centerlines with screen-space widths. The renderer caps device pixel ratio at 2, uses MSAA when available, separates roads, sleepers, rails, and route overlays vertically, and uses a tighter camera depth range to reduce aliasing and z-fighting.

Checks:

```bash
npm run lint
npm run build
```
