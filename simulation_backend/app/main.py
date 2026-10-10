"""WebSocket ingest for simulated microphone audio."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from app.pipeline import SimulationPipeline
from app.publisher import post_crossing_prediction
from app.schemas import MicrophoneAudioChunk, SimulationReset
from app.settings import Settings

logger = logging.getLogger("simulation_backend")


def create_app() -> FastAPI:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = Settings.from_env()
    app = FastAPI(title="Routez simulation backend")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.settings = settings
    app.state.pipeline = SimulationPipeline(
        predictions_url=settings.predictions_url,
        internal_api_token=settings.internal_api_token,
    )

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "sample_rate_hz": settings.sample_rate_hz}

    @app.websocket("/ws/simulation")
    async def simulation_socket(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if origin is not None and origin not in settings.allowed_origins:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        pipeline: SimulationPipeline = websocket.app.state.pipeline
        try:
            while True:
                incoming = await websocket.receive()
                if incoming["type"] == "websocket.disconnect":
                    break
                if incoming.get("text") is None:
                    await websocket.send_json(
                        {"type": "ingest_error", "reason": "expected_json_text"}
                    )
                    continue
                await _handle_text(websocket, pipeline, incoming["text"])
        except WebSocketDisconnect:
            return

    return app


async def _handle_text(websocket: WebSocket, pipeline: SimulationPipeline, raw: str) -> None:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        await websocket.send_json({"type": "ingest_error", "reason": "invalid_json"})
        return
    if not isinstance(payload, dict):
        await websocket.send_json({"type": "ingest_error", "reason": "invalid_message"})
        return
    if payload.get("type") == "simulation_reset":
        try:
            message = SimulationReset.model_validate(payload)
        except ValidationError:
            await websocket.send_json({"type": "ingest_error", "reason": "invalid_message"})
            return
        pipeline.reset(message.simulation_id)
        await websocket.send_json(
            {"type": "simulation_reset_ack", "simulation_id": message.simulation_id}
        )
        return
    try:
        chunk = MicrophoneAudioChunk.model_validate(payload)
    except ValidationError as exc:
        detail = exc.errors()[0]["msg"] if exc.errors() else "invalid"
        await websocket.send_json(
            {"type": "ingest_error", "reason": "invalid_message", "detail": detail}
        )
        return

    result = pipeline.ingest(chunk)
    await websocket.send_json(result.frontend_message)
    if result.accepted and result.backend_message is not None:
        await asyncio.to_thread(
            post_crossing_prediction,
            result.backend_message,
            pipeline.predictions_url,
            pipeline.internal_api_token,
        )


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8001)
