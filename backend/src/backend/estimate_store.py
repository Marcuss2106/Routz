"""Optional Tiger Data/TimescaleDB sink for canonical acoustic estimates."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from backend.models import TrainStateEstimate

logger = logging.getLogger("user_backend.estimate_store")

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS train_state_estimates (
    simulation_id TEXT NOT NULL,
    sequence BIGINT NOT NULL,
    simulation_time_s DOUBLE PRECISION NOT NULL,
    train_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    speed_mps DOUBLE PRECISION,
    length_m DOUBLE PRECISION,
    provisional_length_m DOUBLE PRECISION,
    direction_deg_from_east DOUBLE PRECISION,
    status TEXT NOT NULL,
    confidence JSONB NOT NULL,
    uncertainty JSONB NOT NULL,
    source TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (simulation_id, sequence)
)
"""

_INSERT = """
INSERT INTO train_state_estimates (
    simulation_id, sequence, simulation_time_s, train_id, track_id,
    latitude, longitude, speed_mps, length_m, provisional_length_m,
    direction_deg_from_east, status, confidence, uncertainty, source, received_at
) VALUES (
    %(simulation_id)s, %(sequence)s, %(simulation_time_s)s, %(train_id)s, %(track_id)s,
    %(latitude)s, %(longitude)s, %(speed_mps)s, %(length_m)s, %(provisional_length_m)s,
    %(direction_deg_from_east)s, %(status)s, %(confidence)s, %(uncertainty)s,
    %(source)s, %(received_at)s
)
ON CONFLICT (simulation_id, sequence) DO UPDATE SET
    status = EXCLUDED.status,
    confidence = EXCLUDED.confidence,
    uncertainty = EXCLUDED.uncertainty,
    received_at = EXCLUDED.received_at
"""


@dataclass
class EstimateStore:
    """A bounded ordered writer; unset DATABASE_URL makes it a no-op."""

    database_url: str
    queue_size: int = 256

    def __post_init__(self) -> None:
        self._queue: asyncio.Queue[TrainStateEstimate | None] = asyncio.Queue(
            maxsize=self.queue_size
        )
        self._task: asyncio.Task[None] | None = None
        self._schema_ready = False

    @property
    def enabled(self) -> bool:
        return bool(self.database_url)

    async def start(self) -> None:
        if self.enabled and self._task is None:
            self._task = asyncio.create_task(self._run(), name="estimate-store")

    async def enqueue(self, event: TrainStateEstimate) -> None:
        if self.enabled:
            await self._queue.put(event)

    async def close(self) -> None:
        if self._task is None:
            return
        await self._queue.put(None)
        await self._queue.join()
        await self._task
        self._task = None

    async def _run(self) -> None:
        while True:
            event = await self._queue.get()
            try:
                if event is None:
                    return
                await asyncio.to_thread(self._write, event)
            finally:
                self._queue.task_done()

    def _write(self, event: TrainStateEstimate) -> None:
        try:
            import psycopg
            from psycopg.types.json import Jsonb
        except ImportError:
            logger.error(
                "Tiger Data persistence is configured but psycopg is not installed; "
                "install backend requirements to enable it"
            )
            return

        received_at = datetime.now(timezone.utc)
        values = {
            "simulation_id": event.simulation_id,
            "sequence": event.sequence,
            "simulation_time_s": event.simulation_time_s,
            "train_id": event.train_id,
            "track_id": event.track_id,
            "latitude": event.latitude,
            "longitude": event.longitude,
            "speed_mps": event.speed_mps,
            "length_m": event.length_m,
            "provisional_length_m": event.provisional_length_m,
            "direction_deg_from_east": event.direction_deg_from_east,
            "status": event.status,
            "confidence": Jsonb(event.confidence.model_dump(mode="json")),
            "uncertainty": Jsonb(event.uncertainty.model_dump(mode="json")),
            "source": event.source,
            "received_at": received_at,
        }
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                if not self._schema_ready:
                    cursor.execute(_CREATE_TABLE)
                    self._schema_ready = True
                cursor.execute(_INSERT, values)
