"""POST compact crossing predictions. Audio never leaves this process."""

from __future__ import annotations

import json
import logging
import asyncio
from dataclasses import dataclass
import urllib.request

logger = logging.getLogger("simulation_backend")


@dataclass
class PredictionPublisher:
    """Ordered, non-blocking bridge from inference to the user backend."""

    url: str
    token: str
    queue_size: int = 64

    def __post_init__(self) -> None:
        self._queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=self.queue_size)
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="prediction-publisher")

    async def publish(self, payload: dict) -> None:
        if self.url:
            await self._queue.put(payload)

    async def close(self) -> None:
        if self._task is None:
            return
        await self._queue.put(None)
        await self._queue.join()
        await self._task
        self._task = None

    async def _run(self) -> None:
        while True:
            payload = await self._queue.get()
            try:
                if payload is None:
                    return
                await asyncio.to_thread(
                    post_crossing_prediction,
                    payload,
                    self.url,
                    self.token,
                )
            finally:
                self._queue.task_done()


def post_crossing_prediction(
    payload: dict,
    url: str,
    token: str,
    timeout_s: float = 2.0,
) -> bool:
    """Return True when user-backend accepts the event. Network errors are logged."""
    if not url:
        return False
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            return 200 <= response.status < 300
    except Exception as exc:
        logger.warning(
            "prediction post failed simulation_id=%s sequence=%s error=%s",
            payload.get("simulation_id"),
            payload.get("sequence"),
            exc,
        )
        return False
