"""REST command fallback for the railroad simulation (no WebSocket needed)."""

from fastapi.testclient import TestClient

from backend.main import app


def test_command_post_drives_play_pause_restart() -> None:
    client = TestClient(app)

    restarted = client.post("/api/command", json={"command": "restart"})
    assert restarted.status_code == 200
    assert restarted.json()["status"] == "paused"

    played = client.post("/api/command", json={"command": "play"})
    assert played.status_code == 200
    body = played.json()
    assert body["type"] == "train_state"
    assert body["status"] == "running"

    paused = client.post("/api/command", json={"command": "pause"})
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"


def test_command_post_rejects_unknown_commands() -> None:
    client = TestClient(app)
    response = client.post("/api/command", json={"command": "derail"})
    assert response.status_code == 400


def test_command_post_sets_train_length() -> None:
    client = TestClient(app)
    response = client.post("/api/command", json={"command": "set_train_length", "value": 800})
    assert response.status_code == 200
    assert response.json()["train_length_m"] == 800.0

    rejected = client.post("/api/command", json={"command": "set_train_length", "value": 10})
    assert rejected.status_code == 400


def test_public_rail_api_does_not_emit_credentialed_cors() -> None:
    client = TestClient(app)
    response = client.get(
        "/api/train",
        headers={"Origin": "http://localhost:3100"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3100"
    assert "access-control-allow-credentials" not in response.headers
