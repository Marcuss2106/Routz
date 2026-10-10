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

The renderer uses React Three Fiber, Three.js, and Drei. It displays the complete cached SCDOT network while the repeatable active corridor is 800 m. Physical movement remains in backend meters. Rendering-only exaggeration is isolated in `src/lib/simulation.ts`. The locomotive and five wagons are independently sampled along the route; all six emit fading ground waves. Three route-local audio sensors generate synchronized PCM streams for the inference backend.

Checks:

```bash
npm run lint
npm run build
```
