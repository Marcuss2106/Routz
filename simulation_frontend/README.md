# Routz — Simulation Frontend

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

```bash
npm install
npm run dev
```

Open [http://localhost:3100](http://localhost:3100). The scene supports orbit
controls, pause/run, speed, train direction, noise, source, waveform, and
backend-stream toggles.

The main scene is composed from React Three Fiber, Drei, Zustand, and Tailwind
CSS components under `src/components/simulation`.
