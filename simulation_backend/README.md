## Audio localization backend

This is the merged GCC-PHAT/Kalman audio inference service. The railroad-motion backend runs on port 8000; this service runs separately on port 8001.

```bash
cd simulation_backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8001
```
The simulation frontend sends three synchronized 250 ms PCM16 streams to `ws://localhost:8001/ws/simulation`. Sensor coordinates use a route-local frame: `x_m` is distance along the selected demonstration corridor and `y_m` is lateral distance from it. The service receives no ground-truth train position.

Run the inference tests with:

```bash
.venv/bin/python -m pytest -q
```
