"""User backend: prediction ingest, alert broadcast, and speech playback."""

from __future__ import annotations

import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone

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
from backend.crossings import FRA_CROSSINGS
from backend.demo_anchor import ANCHOR_ID, anchor_estimate
from backend.estimate_store import EstimateStore
from backend.models import MapState, PredictionEnvelope, TrainObservation, TrainStateEstimate
from backend.predict import predict_crossing_blockages
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


def _enrich_estimate(event: TrainStateEstimate) -> TrainStateEstimate:
    """Anchor the acoustic estimate on the demo map and add crossing predictions.

    Only acoustic estimates are used; no simulator truth reaches this function.
    Raw acoustic fields are untouched. The map-framed values go in ``map_state``.
    """
    if (
        event.status == "unknown"
        or event.track_position_m is None
        or event.latitude is None
        or event.longitude is None
    ):
        return event.model_copy(update={"map_state": None, "predictions": []})

    anchored = anchor_estimate(
        track_position_m=event.track_position_m,
        speed_mps=event.speed_mps,
        direction_deg_from_east=event.direction_deg_from_east,
        length_m=event.length_m,
        provisional_length_m=event.provisional_length_m,
    )
    map_state = MapState(
        anchor=ANCHOR_ID,
        latitude=anchored.latitude,
        longitude=anchored.longitude,
        speed_mps=anchored.speed_mps,
        direction_deg_from_east=anchored.direction_deg_from_east,
        length_m=anchored.length_m,
        provisional_length_m=anchored.provisional_length_m,
    )
    length_m = anchored.length_m if anchored.length_m is not None else anchored.provisional_length_m
    if (
        event.status == "cleared"
        or anchored.speed_mps is None
        or anchored.direction_deg_from_east is None
        or length_m is None
        or length_m <= 0
    ):
        return event.model_copy(update={"map_state": map_state, "predictions": []})

    observation = TrainObservation(
        trainId=event.train_id,
        observedAt=datetime.now(timezone.utc),
        lat=anchored.latitude,
        lon=anchored.longitude,
        speedMps=anchored.speed_mps,
        lengthM=length_m,
        degFromEast=anchored.direction_deg_from_east,
        positionReference="front",
    )
    provisional = anchored.length_m is None
    predictions = [
        prediction.model_copy(update={"lengthProvisional": provisional})
        for prediction in predict_crossing_blockages(observation, FRA_CROSSINGS)
    ]
    return event.model_copy(update={"map_state": map_state, "predictions": predictions})


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
    estimate_store = EstimateStore(settings.database_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        client = httpx.AsyncClient()
        await estimate_store.start()
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
        await estimate_store.close()
        await client.aclose()

    app = FastAPI(title="Routez user backend", lifespan=lifespan)
    app.state.book = book
    app.state.hub = UpdateHub()
    app.state.transcriber = transcriber
    app.state.estimate_store = estimate_store
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

    @app.post("/api/train-observations")
    async def legacy_train_observation(body: dict) -> dict:
        """Keep the manual/demo REST contract while live audio uses the rich event."""
        try:
            observation = TrainObservation.model_validate(body)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=exc.errors()) from exc
        predictions = predict_crossing_blockages(observation, FRA_CROSSINGS)
        envelope = PredictionEnvelope(
            observation=observation,
            predictions=predictions,
            stale=False,
        )
        return envelope.model_dump(mode="json")

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
            await app.state.hub.broadcast(reset.model_dump(mode="json"))
            logger.info("simulation_reset simulation_id=%s", reset.simulation_id)
            return {"accepted": True, "alert": None}
        if event_type == "train_state_estimate":
            try:
                estimate = TrainStateEstimate.model_validate(body)
            except ValidationError as exc:
                raise HTTPException(status_code=422, detail=exc.errors()) from exc
            estimate = _enrich_estimate(estimate)
            try:
                alert = book.ingest_estimate(estimate)
            except StalePrediction:
                logger.info(
                    "stale estimate simulation_id=%s sequence=%s",
                    estimate.simulation_id,
                    estimate.sequence,
                )
                raise HTTPException(
                    status_code=409, detail="Stale or duplicate estimate"
                ) from None
            book.remember_estimate(estimate)
            await app.state.estimate_store.enqueue(estimate)
            await app.state.hub.broadcast(estimate.model_dump(mode="json"))
            if alert is not None:
                await app.state.hub.broadcast(alert.message())
            logger.info(
                "acoustic_estimate simulation_id=%s sequence=%s status=%s",
                estimate.simulation_id,
                estimate.sequence,
                estimate.status,
            )
            return {
                "accepted": True,
                "event": estimate.model_dump(mode="json"),
                "alert": None if alert is None else {"id": alert.id, "text": alert.text},
            }
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
            if book.latest_estimate is not None:
                await websocket.send_json(book.latest_estimate.model_dump(mode="json"))
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


def run() -> None:
    import uvicorn

    from backend.settings import Settings

    settings = Settings.from_env()
    uvicorn.run("backend.user_api:app", host=settings.host, port=settings.port)
