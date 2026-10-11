from __future__ import annotations

import asyncio

import pytest

import app.publisher as publisher_module
from app.publisher import PredictionPublisher


def test_prediction_publisher_preserves_order(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[int] = []

    def fake_post(payload: dict, url: str, token: str, timeout_s: float = 2.0) -> bool:
        sent.append(int(payload["sequence"]))
        return True

    monkeypatch.setattr(publisher_module, "post_crossing_prediction", fake_post)
    async def exercise() -> None:
        bridge = PredictionPublisher("http://user-backend/api/predictions", "token")
        await bridge.start()
        await bridge.publish({"sequence": 1})
        await bridge.publish({"sequence": 2})
        await bridge.close()

    asyncio.run(exercise())
    assert sent == [1, 2]
