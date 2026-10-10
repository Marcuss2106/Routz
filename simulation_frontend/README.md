## Railroad simulation frontend

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
