## Audio localization backend

This is the merged GCC-PHAT/Kalman audio inference service. The railroad-motion backend runs on port 8000; this service runs separately on port 8001.

```bash
cd simulation_backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8001
```
The simulation frontend sends three synchronized 250 ms PCM16 streams to `ws://localhost:8001/ws/simulation`. Sensor coordinates use the shared east/north frame in `shared/simulation_geometry.json`: `x_m` is east and `y_m` is north. The service receives no ground-truth train position. A trailing one-second analysis window is timestamped at its center; its `train_state_estimate` is then sent in order to the user backend.

The user-facing event contains `latitude`, `longitude`, `speed_mps`,
`length_m`, `provisional_length_m`, `direction_deg_from_east`,
`confidence`, `uncertainty`, `status`, and `source: "acoustic_array"`.
Length stays provisional while the train occupies the acoustic field and becomes
stable only after the rear clears. The maximum inferred occupancy is 2,000 m,
which is a safety bound rather than a configured train truth.

The POST to the user backend also carries `track_position_m`, the acoustic
estimate of distance along the shared rail polyline. The user backend maps it
onto a real Columbia corridor with `backend/src/backend/demo_anchor.py` (a
fixed demo transform), so the train reaches real crossings.

### Simulated trials

`scripts/e2e_trials.py` feeds a hidden, continuously moving synthetic point
source through `SimulationPipeline` and scores position, speed, direction, and
the ETA to the first real crossing. Representative results (simulation only, 2
seeds): at 20 dB SNR, 5-8 m median position error when tracking (fix rate
10-46%), direction always correct, median ETA error 3.5-8 s; at 10 dB almost
no fixes and none at 5 dB or lower. Speed is the weakest estimate (median
error about 25-35%), and the tracker loses the train inside the microphone
cluster. These do not measure real-world accuracy.

```bash
simulation_backend/.venv/bin/python scripts/e2e_trials.py --seeds 2
```

Run the inference tests with:

```bash
.venv/bin/python -m pytest -q
```

## Validation report

From the repository root, generate a reproducible stationary-window
microbenchmark for the five-value acoustic state contract:

    PYTHONPATH=simulation_backend python3 scripts/acoustic_validation.py

The report is written to artifacts/acoustic-validation/. It evaluates the
same localization, Kalman tracking, coordinate conversion, direction, and
train-lifecycle code used by the live path. Its captures are synthetic and it
must not be described as field accuracy evidence or as moving-train performance.
Use scripts/e2e_trials.py for the continuously moving-source trial and its
fix-rate, speed, and crossing-ETA metrics.
