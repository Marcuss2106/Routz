import asyncio
import json

import httpx

from backend.settings import Settings
from backend.speech import PLEASANT_VOICE_SETTINGS, synthesize_elevenlabs


def test_elevenlabs_synthesis_uses_the_calm_voice_profile() -> None:
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, content=b"ID3-fake")

    settings = Settings(
        allowed_origins=["http://testserver"],
        internal_api_token="test-token",
        elevenlabs_api_key="live-key",
        elevenlabs_voice_id="pleasant-voice",
        host="127.0.0.1",
        port=8002,
    )

    async def run() -> bytes:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            return await synthesize_elevenlabs("The route is clear.", settings, client)

    assert asyncio.run(run()) == b"ID3-fake"
    payload = json.loads(requests[0].content)
    assert payload["model_id"] == "eleven_flash_v2_5"
    assert payload["voice_settings"] == PLEASANT_VOICE_SETTINGS
