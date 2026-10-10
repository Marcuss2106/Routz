"""POST compact crossing predictions. Audio never leaves this process."""

from __future__ import annotations

import json
import logging
import urllib.request

logger = logging.getLogger("simulation_backend")


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
