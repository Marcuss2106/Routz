"""User backend: prediction ingest, alert broadcast, and speech playback."""

from __future__ import annotations

import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, File, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import ValidationError

from backend.alerts import (
    VOICE_UNLOCK_ID,
    VOICE_UNLOCK_TEXT,
    AlertBook,
    PredictionIn,
    ResetIn,
    SpokenAlert,
    StalePrediction,
)
from backend.route_speech import HELP_TEXT, parse_route_request, route_summary_text
from backend.settings import Settings
from backend.speech import SpeechService, Synthesizer, VoiceUnavailable, transcribe_elevenlabs

logger = logging.getLogger("user_backend")
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    logger.addHandler(_handler)
logger.setLevel(logging.INFO)


class UpdateHub:
    def __init__(self) -> None:
        self._sockets: set[WebSocket] = set()

    def add(self, websocket: WebSocket) -> None:
        self._sockets.add(websocket)

    def discard(self, websocket: WebSocket) -> None:
        self._sockets.discard(websocket)

    async def broadcast(self, message: dict) -> None:
        stale: list[WebSocket] = []
        for websocket in list(self._sockets):
            try:
                await websocket.send_json(message)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self._sockets.discard(websocket)


def _authorized(authorization: str | None, token: str) -> bool:
    if not token or authorization is None or not authorization.startswith("Bearer "):
        return False
    presented = authorization.removeprefix("Bearer ").strip()
    return secrets.compare_digest(presented, token)


def _origin_allowed(origin: str | None, allowed: list[str]) -> bool:
    if origin is None:
        return True
    return origin in allowed


Transcriber = Callable[[bytes, str, str], Awaitable[str]]
_AUDIO_TYPES = {
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/x-m4a",
    "video/webm",
}
_MAX_AUDIO_BYTES = 2_000_000


def _as_float(value: object) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return -1.0


def _audio_type(content_type: str | None) -> str | None:
    if not content_type:
        return None
    media = content_type.split(";", 1)[0].strip().lower()
    if media in _AUDIO_TYPES or media.startswith("audio/"):
        return media
    return None


def _remember(book: AlertBook, text: str) -> dict:
    alert = SpokenAlert(
        id=f"route-{secrets.token_hex(8)}",
        text=text,
        simulation_id="local",
        sequence=0,
    )
    book.register(alert)
    return {"id": alert.id, "text": alert.text}


def create_app(
    settings: Settings | None = None,
    synthesizer: Synthesizer | None = None,
    transcriber: Transcriber | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    book = AlertBook()
    book.register(
        SpokenAlert(
            id=VOICE_UNLOCK_ID,
            text=VOICE_UNLOCK_TEXT,
            simulation_id="local",
            sequence=0,
        )
    )
    speech = SpeechService(settings, book, synthesizer)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        client = httpx.AsyncClient()
        speech.bind_client(client)
        if transcriber is None and settings.elevenlabs_api_key:

            async def live_transcriber(audio: bytes, content_type: str, filename: str) -> str:
                return await transcribe_elevenlabs(
                    audio, content_type, filename, settings, client
                )

            app.state.transcriber = live_transcriber
        else:
            app.state.transcriber = transcriber
        logger.info(
            "user backend listening voice_configured=%s",
            bool(settings.elevenlabs_api_key),
        )
        if not settings.elevenlabs_api_key:
            logger.warning("ELEVENLABS_API_KEY is unset; speech requests will return 503")
        if not settings.internal_api_token:
            logger.warning("INTERNAL_API_TOKEN is unset; prediction ingest will return 503")
        yield
        await client.aclose()

    app = FastAPI(title="Routez user backend", lifespan=lifespan)
    app.state.book = book
    app.state.hub = UpdateHub()
    app.state.transcriber = transcriber
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "voice_configured": bool(settings.elevenlabs_api_key)}

    @app.get("/api/speech/{alert_id}")
    async def speak(alert_id: str) -> Response:
        if len(alert_id) > 200 or "/" in alert_id:
            raise HTTPException(status_code=404, detail="Unknown alert")
        started = time.perf_counter()
        try:
            audio, cache_hit = await speech.audio_for(alert_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Unknown alert") from None
        except VoiceUnavailable:
            raise HTTPException(
                status_code=503,
                detail="Voice is unavailable. Set ELEVENLABS_API_KEY on the user backend.",
            ) from None
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.info(
            "speech alert_id=%s cache_hit=%s latency_ms=%.0f",
            alert_id,
            cache_hit,
            elapsed_ms,
        )
        return Response(content=audio, media_type="audio/mpeg")

    @app.post("/api/voice/transcribe")
    async def transcribe_route(file: UploadFile = File()) -> dict:
        media = _audio_type(file.content_type)
        if media is None:
            raise HTTPException(status_code=415, detail="Send an audio recording.")
        audio = await file.read(_MAX_AUDIO_BYTES + 1)
        if len(audio) > _MAX_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="Recording is too long.")
        if len(audio) < 100:
            raise HTTPException(status_code=400, detail="Recording was empty.")
        transcribe = app.state.transcriber
        if transcribe is None:
            raise HTTPException(
                status_code=503,
                detail="Voice is unavailable. Set ELEVENLABS_API_KEY on the user backend.",
            )
        try:
            transcript = await transcribe(audio, media, file.filename or "route.webm")
        except VoiceUnavailable:
            raise HTTPException(
                status_code=502,
                detail="Could not transcribe that recording.",
            ) from None
        request = parse_route_request(transcript)
        if request is None:
            logger.info("transcript heard=%r parsed=no", transcript)
            return {
                "transcript": transcript,
                "origin_query": None,
                "destination_query": None,
                "use_current_location": False,
                "alert": _remember(book, HELP_TEXT),
            }
        logger.info(
            "transcript heard=%r origin=%r destination=%r use_current_location=%s",
            transcript,
            request.origin_query,
            request.destination_query,
            request.use_current_location,
        )
        if request.use_current_location:
            heard = f"your location to {request.destination_query}"
        else:
            heard = f"{request.origin_query} to {request.destination_query}"
        return {
            "transcript": transcript,
            "origin_query": request.origin_query,
            "destination_query": request.destination_query,
            "use_current_location": request.use_current_location,
            "alert": _remember(book, f"Simulation. Looking up a driving route from {heard}."),
        }

    @app.post("/api/voice/route")
    async def speak_route(body: dict) -> dict:
        summary = route_summary_text(
            str(body.get("origin_name", "")),
            str(body.get("destination_name", "")),
            _as_float(body.get("duration_seconds")),
            _as_float(body.get("distance_meters")),
        )
        if summary is None:
            raise HTTPException(status_code=422, detail="Route summary is incomplete.")
        return {"alert": _remember(book, summary)}

    @app.post("/api/predictions")
    async def ingest(
        body: dict,
        authorization: str | None = Header(default=None),
    ) -> dict:
        if not settings.internal_api_token:
            raise HTTPException(
                status_code=503,
                detail="INTERNAL_API_TOKEN is not configured",
            )
        if not _authorized(authorization, settings.internal_api_token):
            raise HTTPException(status_code=401, detail="Invalid bearer token")
        event_type = body.get("type")
        if event_type == "simulation_reset":
            try:
                reset = ResetIn.model_validate(body)
            except ValidationError as exc:
                raise HTTPException(status_code=422, detail=exc.errors()) from exc
            book.reset(reset.simulation_id)
            logger.info("simulation_reset simulation_id=%s", reset.simulation_id)
            return {"accepted": True, "alert": None}
        try:
            event = PredictionIn.model_validate(body)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=exc.errors()) from exc
        try:
            alert = book.ingest(event)
        except StalePrediction:
            logger.info(
                "stale prediction simulation_id=%s sequence=%s",
                event.simulation_id,
                event.sequence,
            )
            raise HTTPException(
                status_code=409, detail="Stale or duplicate prediction"
            ) from None
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        logger.info(
            "prediction simulation_id=%s sequence=%s alert_id=%s",
            event.simulation_id,
            event.sequence,
            alert.id if alert else None,
        )
        if alert is not None:
            await app.state.hub.broadcast(alert.message())
        return {
            "accepted": True,
            "alert": None if alert is None else {"id": alert.id, "text": alert.text},
        }

    @app.websocket("/ws/updates")
    async def updates(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if not _origin_allowed(origin, settings.allowed_origins):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        app.state.hub.add(websocket)
        try:
            if book.latest is not None:
                await websocket.send_json(book.latest.message())
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            app.state.hub.discard(websocket)

    return app


app = create_app()
