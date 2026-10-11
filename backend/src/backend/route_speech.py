"""Turn a spoken request into a driving-route lookup, then a fixed spoken summary."""

from __future__ import annotations

import re
from dataclasses import dataclass

HELP_TEXT = (
    "Tell me where you're going. "
    "For example, from Main Street to the hospital."
)

NOTICE_TEXTS = {
    "voice-help": HELP_TEXT,
    "voice-no-mic": (
        "This browser can't use the microphone. You can type your route instead."
    ),
    "voice-mic-blocked": "I need microphone access to hear your route.",
    "voice-not-heard": "Sorry, I didn't catch that. Please try again.",
    "voice-route-failed": "Sorry, I couldn't find a driving route.",
}

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


def _phrase(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in " ,.'-/&" else " " for ch in value)
    return " ".join(cleaned.split())[:140].strip(" ,.-/&")


_ROAD_WORDS = {
    "St": "Street",
    "Ave": "Avenue",
    "Rd": "Road",
    "Blvd": "Boulevard",
    "Hwy": "Highway",
    "Ln": "Lane",
    "Pkwy": "Parkway",
    "Ct": "Court",
    "Pl": "Place",
}
_ROAD_ABBREVIATION = re.compile(r"(?<=\w )(" + "|".join(_ROAD_WORDS) + r")\b\.?")


def speakable(value: str) -> str:
    """Spell out road suffixes so the voice says 'Main Street', not 'Main S T'."""
    return _ROAD_ABBREVIATION.sub(lambda match: _ROAD_WORDS[match.group(1)], value)


def _spoken_distance(distance_meters: float) -> str:
    miles = distance_meters / 1609.344
    if miles < 0.1:
        return f"{max(1, round(distance_meters * 3.28084))} feet"
    rounded = round(miles, 1) if miles < 10 else round(miles)
    if rounded == 1:
        return "1 mile"
    if rounded == int(rounded):
        return f"{int(rounded)} miles"
    return f"{rounded} miles"


def _sentence_start(value: str) -> str:
    return value[:1].lower() + value[1:] if value else value


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
    first_instruction: str = "",
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
    distance = _spoken_distance(distance_meters)
    minute_word = "minute" if minutes == 1 else "minutes"
    summary = (
        f"Here's your route from {speakable(origin)} to {speakable(destination)}. "
        f"It's about {minutes} {minute_word} and {distance}."
    )
    first = _phrase(first_instruction)
    if len(first) >= 3:
        summary += f" First, {_sentence_start(speakable(first))}."
    return summary


def route_step_text(
    instruction: str,
    distance_meters: float,
    next_instruction: str = "",
) -> str | None:
    """Current maneuver, then the next one after this step's distance."""
    current = _phrase(instruction)
    if len(current) < 3:
        return None
    text = f"{speakable(current)}."
    upcoming = _phrase(next_instruction)
    if len(upcoming) >= 3 and 1 <= distance_meters <= 2_000_000:
        text += (
            f" In {_spoken_distance(distance_meters)}, "
            f"{_sentence_start(speakable(upcoming))}."
        )
    return text


def place_not_found_text(query: str) -> str:
    place = _place(query)
    if len(place) < 2:
        return "Sorry, I couldn't find that place. Try a more specific name."
    return f"Sorry, I couldn't find {speakable(place)}. Try a more specific name."
