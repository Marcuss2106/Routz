# Routz — Simulation Frontend

The simulation frontend is the 3D side of Routz's prototype architecture. It
renders a train moving on a railroad track, three fixed virtual microphones,
and the signal strength each microphone receives on the simulated ground
plane.

The browser loads `train.wav` through `/api/train-audio` when the repository
asset is available. Each microphone then receives a separate PCM stream with
modeled propagation delay, distance attenuation, and configurable noise. If no
audio asset is available, the same pipeline uses a deterministic synthetic
train signal so the scene remains usable.

The optional **Stream** control sends synchronized JSON WebSocket chunks to
`NEXT_PUBLIC_SIMULATION_WS_URL` (default: `ws://localhost:8000/ws/simulation`).
The current GitHub simulation backend is still a scaffold, so streaming is
off by default.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The scene supports orbit
controls, pause/run, speed, train direction, noise, source, waveform, and
backend-stream toggles.

The main scene is composed from React Three Fiber, Drei, Zustand, and Tailwind
CSS components under `src/components/simulation`.
