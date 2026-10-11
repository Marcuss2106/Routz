"""Server-composed spoken alerts.

The browser asks for audio by alert id. It never sends the sentence.
"""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field

from backend.models import TrainStateEstimate
from backend.route_speech import speakable

ACTIVE_STATUSES = frozenset({"approaching", "blocking"})
VOICE_UNLOCK_ID = "voice-unlock"
VOICE_UNLOCK_TEXT = (
    "Voice guidance is on. "
    "Tap the microphone and tell me where you're going."
)
CLEAR_TEXT = "Good news. The train has cleared the crossing."


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
    name = speakable(spoken_name(chosen.crossing_id))
    place = name if "crossing" in name.casefold() else f"the {name} crossing"
    if chosen.status == "blocking":
        remaining = _seconds(chosen.estimated_blockage_seconds)
        if remaining is None:
            return f"A train is blocking {place}."
        return f"A train is blocking {place} for about {_duration(remaining)}."
    eta = _seconds(chosen.eta_seconds)
    if eta is None:
        return f"Heads up. A train is about to block {place}."
    return f"Heads up. A train will block {place} in about {_duration(eta)}."


def _duration(seconds: int) -> str:
    if seconds < 90:
        return "1 second" if seconds == 1 else f"{seconds} seconds"
    minutes = round(seconds / 60)
    return f"{minutes} minutes"


def situation_key(crossings: list[CrossingForecastIn]) -> str | None:
    parts = [
        f"{crossing.crossing_id}:{crossing.status}"
        for crossing in crossings
        if crossing.status in ACTIVE_STATUSES
    ]
    if not parts:
        return None
    return ",".join(sorted(parts))


SPEAK_WITHIN_S = 120


def spoken_crossings(event: TrainStateEstimate) -> list[CrossingForecastIn]:
    """Map user-facing blockage predictions to the existing speech policy.

    The road name stands in for the crossing id so the sentence names the real
    road. Far-off crossings are not spoken; only closures within about two
    minutes or already blocked.
    """
    crossings: list[CrossingForecastIn] = []
    for prediction in event.predictions:
        if prediction.status in {"blocked_now", "stopped_on_crossing"}:
            crossings.append(
                CrossingForecastIn(
                    crossing_id=prediction.roadName,
                    eta_seconds=0.0,
                    estimated_blockage_seconds=max(0.0, float(prediction.clearSeconds)),
                    status="blocking",
                )
            )
        elif prediction.status in {"blocked_soon", "upcoming"} and (
            0 < prediction.etaSeconds <= SPEAK_WITHIN_S
        ):
            crossings.append(
                CrossingForecastIn(
                    crossing_id=prediction.roadName,
                    eta_seconds=float(prediction.etaSeconds),
                    estimated_blockage_seconds=max(
                        0.0, float(prediction.clearSeconds - prediction.etaSeconds)
                    ),
                    status="approaching",
                )
            )
    return crossings


class AlertBook:
    def __init__(self) -> None:
        self.alerts: dict[str, SpokenAlert] = {}
        self.latest: SpokenAlert | None = None
        self.latest_estimates: dict[str, TrainStateEstimate] = {}
        self._last_sequence: dict[str, int] = {}
        self._situation: dict[str, str | None] = {}

    def register(self, alert: SpokenAlert) -> None:
        self.alerts[alert.id] = alert

    def get(self, alert_id: str) -> SpokenAlert | None:
        return self.alerts.get(alert_id)

    @property
    def latest_estimate(self) -> TrainStateEstimate | None:
        if not self.latest_estimates:
            return None
        return max(self.latest_estimates.values(), key=lambda event: event.sequence)

    def remember_estimate(self, event: TrainStateEstimate) -> None:
        """Keep the latest rich acoustic event for websocket reconnects."""
        self.latest_estimates[event.simulation_id] = event

    def ingest_estimate(self, event: TrainStateEstimate) -> SpokenAlert | None:
        """Speak real map crossings, not the acoustic rail's internal crossing ids.

        A tracking dropout (no usable estimate) says nothing about the train, so
        it must not announce a clearance. Only a cleared train does.
        """
        crossings = spoken_crossings(event)
        if not crossings and event.status != "cleared":
            last = self._last_sequence.get(event.simulation_id)
            if last is not None and event.sequence <= last:
                raise StalePrediction(
                    f"sequence {event.sequence} is stale for {event.simulation_id}"
                )
            self._last_sequence[event.simulation_id] = event.sequence
            return None
        legacy = PredictionIn(
            simulation_id=event.simulation_id,
            sequence=event.sequence,
            simulation_time_s=event.simulation_time_s,
            train_id=event.train_id,
            status=event.status,
            estimated_speed_mps=event.speed_mps,
            direction=(
                str(event.direction_deg_from_east)
                if event.direction_deg_from_east is not None
                else "unknown"
            ),
            crossings=crossings,
            source=event.source,
        )
        return self.ingest(legacy)

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
        self.latest_estimates.pop(simulation_id, None)
        if self.latest is not None and self.latest.simulation_id == simulation_id:
            self.latest = None
