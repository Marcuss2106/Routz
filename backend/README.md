# Routz user backend

Accepts simulated crossing predictions, broadcasts a spoken alert when the situation changes, and serves that audio from ElevenLabs.

The API key stays in this process. The map requests `GET /api/speech/{alert_id}` and only receives audio for a sentence this service already composed.

## Run

```bash
cd backend
cp .env.example .env
# Set ELEVENLABS_API_KEY and INTERNAL_API_TOKEN in .env
uv run backend
```

`POST /api/voice/transcribe` accepts a short recording and returns a start and destination. `POST /api/voice/route` stores the spoken summary of a route the map already calculated.

The server listens on port `8001`. `GET /health` reports whether a real ElevenLabs key is configured. Placeholder values from `.env.example` count as unset.

`POST /api/predictions` expects `Authorization: Bearer <INTERNAL_API_TOKEN>` and the crossing-prediction JSON from the simulation backend. A repeated situation is accepted and not spoken again. A duplicate or older `sequence` returns 409. `{"type":"simulation_reset","simulation_id":"..."}` clears that run.
