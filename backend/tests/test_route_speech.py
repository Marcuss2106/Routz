from fastapi.testclient import TestClient

from backend.main import create_app
from backend.route_speech import parse_route_request, route_summary_text
from backend.settings import Settings


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "allowed_origins": ["http://testserver"],
        "internal_api_token": "test-token",
        "elevenlabs_api_key": "",
        "elevenlabs_voice_id": "21m00Tcm4TlvDq8ikWAM",
        "host": "127.0.0.1",
        "port": 8001,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def test_parse_from_to_and_current_location() -> None:
    named = parse_route_request("from the University of South Carolina to the airport")
    assert named is not None
    assert named.origin_query == "the University of South Carolina"
    assert named.destination_query == "the airport"
    assert named.use_current_location is False

    here = parse_route_request("Take me to Williams-Brice Stadium.")
    assert here is not None
    assert here.use_current_location is True
    assert here.origin_query is None
    assert here.destination_query == "Williams-Brice Stadium"

    current = parse_route_request("from my location to the hospital")
    assert current is not None and current.use_current_location is True
    assert parse_route_request("hello there") is None


def test_route_summary_uses_a_fixed_sentence() -> None:
    text = route_summary_text("Lady St", "the airport", 840, 8000)
    assert text == (
        "Simulation. Driving route from Lady St to the airport. "
        "About 14 minutes and 5.0 miles."
    )
    assert route_summary_text("A", "B", 10, 100) is None
    assert route_summary_text("Lady St", "airport", -1, 100) is None


def test_transcription_becomes_a_route_lookup() -> None:
    async def transcribe(audio: bytes, content_type: str, filename: str) -> str:
        assert audio.startswith(b"abc")
        assert content_type == "audio/webm"
        assert filename == "route.webm"
        return "from Main Street to the hospital"

    client = TestClient(create_app(_settings(), transcriber=transcribe))
    response = client.post(
        "/api/voice/transcribe",
        files={"file": ("route.webm", b"abc" * 50, "audio/webm")},
    )
    body = response.json()
    assert response.status_code == 200
    assert body["origin_query"] == "Main Street"
    assert body["destination_query"] == "the hospital"
    assert body["alert"]["text"].startswith("Simulation. Looking up")


def test_unparsed_speech_asks_for_two_places() -> None:
    async def transcribe(audio: bytes, content_type: str, filename: str) -> str:
        return "hello"

    client = TestClient(create_app(_settings(), transcriber=transcribe))
    response = client.post(
        "/api/voice/transcribe",
        files={"file": ("route.webm", b"abc" * 50, "audio/webm")},
    )
    assert response.json()["destination_query"] is None
    assert "Say a start and a destination" in response.json()["alert"]["text"]


def test_route_summary_is_stored_for_playback() -> None:
    async def synthesize(text: str) -> bytes:
        return text.encode()

    client = TestClient(
        create_app(_settings(elevenlabs_api_key="live-key"), synthesizer=synthesize)
    )
    created = client.post(
        "/api/voice/route",
        json={
            "origin_name": "Lady St",
            "destination_name": "the airport",
            "duration_seconds": 600,
            "distance_meters": 8000,
        },
    )
    alert = created.json()["alert"]
    audio = client.get(f"/api/speech/{alert['id']}")
    assert audio.status_code == 200
    assert b"Driving route from Lady St" in audio.content


def test_transcription_without_a_key_is_unavailable() -> None:
    client = TestClient(create_app(_settings()))
    response = client.post(
        "/api/voice/transcribe",
        files={"file": ("route.webm", b"abc" * 50, "audio/webm")},
    )
    assert response.status_code == 503
