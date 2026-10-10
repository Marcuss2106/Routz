"""Server-composed spoken alerts.

The browser asks for audio by alert id. It never sends the sentence.
"""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field

ACTIVE_STATUSES = frozenset({"approaching", "blocking"})
VOICE_UNLOCK_ID = "voice-unlock"
VOICE_UNLOCK_TEXT = (
    "Simulation. Voice guidance is on. "
    "You can say a route, such as from Main Street to the hospital."
)
CLEAR_TEXT = "Simulation. The predicted crossing blockage has cleared."


class CrossingForecastIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    crossing_id: str = Field(min_length=1)
    eta_seconds: float | None = None
    estimated_blockage_seconds: float | None = None
    status: str


class PredictionIn(BaseModel):
    """Crossing estimate posted by the simulation backend. Audio is not accepted."""

    model_config = ConfigDict(extra="ignore")

    type: str = "crossing_prediction"
    simulation_id: str = Field(min_length=1)
    sequence: int = Field(ge=0)
    simulation_time_s: float = Field(ge=0)
    train_id: str = Field(min_length=1)
    status: str
    estimated_speed_mps: float | None = None
    direction: str = "unknown"
    crossings: list[CrossingForecastIn]
    source: str = "simulated_audio_inference"


class ResetIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str
    simulation_id: str = Field(min_length=1)


class StalePrediction(Exception):
    """Duplicate or out-of-order sequence for a simulation run."""


@dataclass(frozen=True)
class SpokenAlert:
    id: str
    text: str
    simulation_id: str
    sequence: int

    def message(self) -> dict:
        return {
            "type": "route_update",
            "simulation_id": self.simulation_id,
            "sequence": self.sequence,
            "label": "estimate",
            "alert": {"id": self.id, "text": self.text},
        }


def spoken_name(crossing_id: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in " -" else " " for ch in crossing_id)
    cleaned = " ".join(cleaned.replace("-", " ").split())
    return cleaned or "the crossing"


def _seconds(value: float | None) -> int | None:
    if value is None:
        return None
    return max(0, round(value))


def spoken_line(crossings: list[CrossingForecastIn]) -> str | None:
    """One short simulated sentence for the most urgent active crossing."""
    active = [crossing for crossing in crossings if crossing.status in ACTIVE_STATUSES]
    if not active:
        return None

    def urgency(crossing: CrossingForecastIn) -> tuple[int, float]:
        if crossing.status == "blocking":
            remaining = crossing.estimated_blockage_seconds
            return (0, remaining if remaining is not None else 0.0)
        eta = crossing.eta_seconds if crossing.eta_seconds is not None else 1e12
        return (1, eta)

    chosen = min(active, key=urgency)
    name = spoken_name(chosen.crossing_id)
    if chosen.status == "blocking":
        remaining = _seconds(chosen.estimated_blockage_seconds)
        if remaining is None:
            return f"Simulation. {name} is predicted blocked."
        return (
            f"Simulation. {name} is predicted blocked "
            f"for about {remaining} more seconds."
        )
    eta = _seconds(chosen.eta_seconds)
    if eta is None:
        return f"Simulation. {name} is predicted to close."
    return f"Simulation. {name} is predicted to close in about {eta} seconds."


def situation_key(crossings: list[CrossingForecastIn]) -> str | None:
    parts = [
        f"{crossing.crossing_id}:{crossing.status}"
        for crossing in crossings
        if crossing.status in ACTIVE_STATUSES
    ]
    if not parts:
        return None
    return ",".join(sorted(parts))


class AlertBook:
    def __init__(self) -> None:
        self.alerts: dict[str, SpokenAlert] = {}
        self.latest: SpokenAlert | None = None
        self._last_sequence: dict[str, int] = {}
        self._situation: dict[str, str | None] = {}

    def register(self, alert: SpokenAlert) -> None:
        self.alerts[alert.id] = alert

    def get(self, alert_id: str) -> SpokenAlert | None:
        return self.alerts.get(alert_id)

    def ingest(self, event: PredictionIn) -> SpokenAlert | None:
        if event.type != "crossing_prediction":
            raise ValueError("unsupported prediction type")
        last = self._last_sequence.get(event.simulation_id)
        if last is not None and event.sequence <= last:
            raise StalePrediction(
                f"sequence {event.sequence} is stale for {event.simulation_id}"
            )
        self._last_sequence[event.simulation_id] = event.sequence

        situation = situation_key(event.crossings)
        previous = self._situation.get(event.simulation_id)
        if situation is None:
            self._situation[event.simulation_id] = "clear"
            if previous is None or previous == "clear":
                return None
            alert = SpokenAlert(
                id=f"{event.simulation_id}:clear",
                text=CLEAR_TEXT,
                simulation_id=event.simulation_id,
                sequence=event.sequence,
            )
        elif previous == situation:
            return None
        else:
            text = spoken_line(event.crossings)
            if text is None:
                return None
            self._situation[event.simulation_id] = situation
            alert = SpokenAlert(
                id=f"{event.simulation_id}:{situation}",
                text=text,
                simulation_id=event.simulation_id,
                sequence=event.sequence,
            )
        self.alerts[alert.id] = alert
        self.latest = alert
        return alert

    def reset(self, simulation_id: str) -> None:
        self._last_sequence.pop(simulation_id, None)
        self._situation.pop(simulation_id, None)
        if self.latest is not None and self.latest.simulation_id == simulation_id:
            self.latest = None
