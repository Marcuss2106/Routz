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

Run the inference tests with:

```bash
.venv/bin/python -m pytest -q
```

## Validation report

From the repository root, generate a reproducible report for the five-value
acoustic state contract:

    PYTHONPATH=simulation_backend python3 scripts/acoustic_validation.py

The report is written to artifacts/acoustic-validation/. It evaluates the
same localization, Kalman tracking, coordinate conversion, direction, and
train-lifecycle code used by the live path. Its captures are synthetic and it
must not be described as field accuracy evidence.
