"""ElevenLabs synthesis. Callers pass an alert id; this module looks up the text."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

import httpx

from backend.alerts import AlertBook
from backend.settings import Settings

logger = logging.getLogger("user_backend")

Synthesizer = Callable[[str], Awaitable[bytes]]

_CACHE_LIMIT = 256

# A calm, warm delivery keeps short route and crossing alerts pleasant without
# making them sound theatrical. All server-composed speech uses this profile.
PLEASANT_VOICE_SETTINGS = {
    "stability": 0.56,
    "similarity_boost": 0.78,
    "style": 0.18,
    "use_speaker_boost": True,
}


class VoiceUnavailable(Exception):
    """Synthesis is not configured or the provider rejected the request."""


async def transcribe_elevenlabs(
    audio: bytes,
    content_type: str,
    filename: str,
    settings: Settings,
    client: httpx.AsyncClient,
) -> str:
    response = await client.post(
        "https://api.elevenlabs.io/v1/speech-to-text",
        headers={"xi-api-key": settings.elevenlabs_api_key},
        data={"model_id": "scribe_v2", "language_code": "eng", "tag_audio_events": "false"},
        files={"file": (filename, audio, content_type)},
        timeout=30.0,
    )
    if response.status_code >= 400:
        logger.warning("elevenlabs transcription failed status=%s", response.status_code)
        raise VoiceUnavailable
    payload = response.json()
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str):
        raise VoiceUnavailable
    return text.strip()


async def synthesize_elevenlabs(
    text: str,
    settings: Settings,
    client: httpx.AsyncClient,
) -> bytes:
    response = await client.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{settings.elevenlabs_voice_id}/stream",
        params={"output_format": "mp3_44100_128"},
        headers={
            "xi-api-key": settings.elevenlabs_api_key,
            "Accept": "audio/mpeg",
        },
        json={
            "text": text,
            "model_id": "eleven_flash_v2_5",
            "voice_settings": PLEASANT_VOICE_SETTINGS,
        },
        timeout=20.0,
    )
    if response.status_code >= 400:
        logger.warning("elevenlabs synthesis failed status=%s", response.status_code)
        raise VoiceUnavailable
    return response.content


class SpeechService:
    def __init__(
        self,
        settings: Settings,
        book: AlertBook,
        synthesize: Synthesizer | None = None,
    ) -> None:
        self.settings = settings
        self.book = book
        self._synthesize = synthesize
        self._cache: dict[str, bytes] = {}

    def bind_client(self, client: httpx.AsyncClient) -> None:
        if self._synthesize is None:
            settings = self.settings

            async def synthesize(text: str) -> bytes:
                return await synthesize_elevenlabs(text, settings, client)

            self._synthesize = synthesize

    async def audio_for(self, alert_id: str) -> tuple[bytes, bool]:
        alert = self.book.get(alert_id)
        if alert is None:
            raise KeyError(alert_id)
        if not self.settings.elevenlabs_api_key or self._synthesize is None:
            raise VoiceUnavailable
        cached = self._cache.get(alert.text)
        if cached is not None:
            return cached, True
        audio = await self._synthesize(alert.text)
        if not audio:
            raise VoiceUnavailable
        if len(self._cache) >= _CACHE_LIMIT:
            self._cache.pop(next(iter(self._cache)))
        self._cache[alert.text] = audio
        return audio, False
