from fastapi.testclient import TestClient

from backend.alerts import VOICE_UNLOCK_TEXT
from backend.user_api import create_app
from backend.settings import Settings


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "allowed_origins": ["http://localhost:3000", "http://testserver"],
        "internal_api_token": "test-token",
        "elevenlabs_api_key": "",
        "elevenlabs_voice_id": "21m00Tcm4TlvDq8ikWAM",
        "host": "127.0.0.1",
        "port": 8001,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def _prediction(sequence: int = 1, status: str = "approaching") -> dict:
    return {
        "type": "crossing_prediction",
        "simulation_id": "demo-001",
        "sequence": sequence,
        "simulation_time_s": 10.5,
        "train_id": "train-001",
        "status": "tracking",
        "estimated_speed_mps": 13.4,
        "direction": "eastbound",
        "crossings": [
            {
                "crossing_id": "crossing-001",
                "eta_seconds": 45,
                "estimated_blockage_seconds": 120,
                "status": status,
            }
        ],
        "source": "simulated_audio_inference",
    }


def test_speech_uses_stored_text_and_caches_it() -> None:
    calls: list[str] = []

    async def synthesize(text: str) -> bytes:
        calls.append(text)
        return b"ID3-fake"

    client = TestClient(
        create_app(
            _settings(elevenlabs_api_key="live-key"),
            synthesizer=synthesize,
        )
    )
    first = client.get("/api/speech/voice-unlock", params={"text": "ignore me"})
    second = client.get("/api/speech/voice-unlock")
    assert first.status_code == 200
    assert first.headers["content-type"] == "audio/mpeg"
    assert first.content == b"ID3-fake"
    assert second.content == b"ID3-fake"
    assert calls == [VOICE_UNLOCK_TEXT]


def test_speech_without_a_key_is_unavailable() -> None:
    client = TestClient(create_app(_settings()))
    response = client.get("/api/speech/voice-unlock")
    assert response.status_code == 503
    assert "ELEVENLABS_API_KEY" in response.json()["detail"]


def test_unknown_alert_is_not_synthesized() -> None:
    calls: list[str] = []

    async def synthesize(text: str) -> bytes:
        calls.append(text)
        return b"ID3-fake"

    client = TestClient(
        create_app(_settings(elevenlabs_api_key="live-key"), synthesizer=synthesize)
    )
    response = client.get("/api/speech/not-a-real-alert")
    assert response.status_code == 404
    assert calls == []


def test_prediction_requires_the_shared_token() -> None:
    client = TestClient(create_app(_settings()))
    rejected = client.post("/api/predictions", json=_prediction())
    assert rejected.status_code == 401
    accepted = client.post(
        "/api/predictions",
        json=_prediction(),
        headers={"Authorization": "Bearer test-token"},
    )
    assert accepted.status_code == 200
    alert = accepted.json()["alert"]
    assert alert["text"].startswith("Simulation.")
    # The map encodes the id. A found alert with no API key is 503, not 404.
    spoken = client.get(f"/api/speech/{alert['id']}")
    assert spoken.status_code == 503


def test_missing_token_configuration_rejects_ingest() -> None:
    client = TestClient(create_app(_settings(internal_api_token="")))
    response = client.post(
        "/api/predictions",
        json=_prediction(),
        headers={"Authorization": "Bearer test-token"},
    )
    assert response.status_code == 503


def test_duplicate_prediction_conflicts_and_repeat_situation_is_silent() -> None:
    client = TestClient(create_app(_settings()))
    headers = {"Authorization": "Bearer test-token"}
    first = client.post("/api/predictions", json=_prediction(1), headers=headers)
    repeat = client.post("/api/predictions", json=_prediction(1), headers=headers)
    same_situation = client.post("/api/predictions", json=_prediction(2), headers=headers)
    assert first.status_code == 200
    assert repeat.status_code == 409
    assert same_situation.json()["alert"] is None


def test_websocket_receives_the_latest_alert() -> None:
    client = TestClient(create_app(_settings()))
    client.post(
        "/api/predictions",
        json=_prediction(),
        headers={"Authorization": "Bearer test-token"},
    )
    with client.websocket_connect("/ws/updates") as websocket:
        message = websocket.receive_json()
    assert message["type"] == "route_update"
    assert message["label"] == "estimate"
    assert message["alert"]["text"].startswith("Simulation. crossing 001")
