"""Turn a spoken request into a driving-route lookup, then a fixed spoken summary."""

from __future__ import annotations

import re
from dataclasses import dataclass

HELP_TEXT = (
    "Simulation. Say a start and a destination. "
    "For example, from Main Street to the hospital."
)

_HERE = {
    "here",
    "my location",
    "current location",
    "where i am",
    "my position",
}
_FROM_TO = re.compile(r"\bfrom\s+(.+?)\s+to\s+(.+)$", re.IGNORECASE)
_TO_ONLY = re.compile(
    r"^(?:please\s+)?(?:take me|directions|navigate|route|go)\s+to\s+(.+)$",
    re.IGNORECASE,
)
_BARE_TO = re.compile(r"^(.+?)\s+to\s+(.+)$", re.IGNORECASE)
_LEAD_IN = re.compile(
    r"^(?:please\s+)?(?:hey\s+)?(?:routz[, ]+)?(?:simulation[, ]+)?",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class SpokenRouteRequest:
    origin_query: str | None
    destination_query: str
    use_current_location: bool


def _place(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in " ,.'-" else " " for ch in value)
    return " ".join(cleaned.split())[:80].strip(" ,.-")


def parse_route_request(transcript: str) -> SpokenRouteRequest | None:
    """Read 'from A to B' or 'take me to B'. Anything else is not a route."""
    text = " ".join(transcript.replace(".", " ").split())
    text = _LEAD_IN.sub("", text).strip()
    if not text:
        return None

    from_to = _FROM_TO.search(text)
    to_only = None if from_to else _TO_ONLY.search(text)
    bare = None if from_to or to_only else _BARE_TO.search(text)
    match = from_to or to_only or bare
    if match is None:
        return None

    use_current = to_only is not None
    if to_only is not None:
        origin = ""
        destination = _place(to_only.group(1))
    else:
        origin = _place(match.group(1))
        destination = _place(match.group(2))
        if origin.casefold() in _HERE:
            use_current = True
            origin = ""

    if len(destination) < 2 or destination.casefold() in _HERE:
        return None
    if not use_current and len(origin) < 2:
        return None
    return SpokenRouteRequest(
        origin_query=None if use_current else origin,
        destination_query=destination,
        use_current_location=use_current,
    )


def route_summary_text(
    origin_name: str,
    destination_name: str,
    duration_seconds: float,
    distance_meters: float,
) -> str | None:
    origin = _place(origin_name)
    destination = _place(destination_name)
    if len(origin) < 2 or len(destination) < 2:
        return None
    if not (1 <= duration_seconds <= 24 * 60 * 60):
        return None
    if not (1 <= distance_meters <= 2_000_000):
        return None
    minutes = max(1, round(duration_seconds / 60))
    miles = distance_meters / 1609.344
    if miles < 0.1:
        distance = f"{max(1, round(distance_meters * 3.28084))} feet"
    elif miles < 10:
        distance = f"{miles:.1f} miles"
    else:
        distance = f"{round(miles)} miles"
    minute_word = "minute" if minutes == 1 else "minutes"
    return (
        f"Simulation. Driving route from {origin} to {destination}. "
        f"About {minutes} {minute_word} and {distance}."
    )
