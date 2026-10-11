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
