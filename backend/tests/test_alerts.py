from backend.alerts import (
    CLEAR_TEXT,
    AlertBook,
    CrossingForecastIn,
    PredictionIn,
    StalePrediction,
    spoken_line,
)


def _event(sequence: int, crossings: list[CrossingForecastIn], simulation_id: str = "demo-001") -> PredictionIn:
    return PredictionIn(
        simulation_id=simulation_id,
        sequence=sequence,
        simulation_time_s=float(sequence),
        train_id="train-001",
        status="tracking",
        crossings=crossings,
    )


def _approaching(eta: float = 45) -> CrossingForecastIn:
    return CrossingForecastIn(
        crossing_id="crossing-001",
        eta_seconds=eta,
        estimated_blockage_seconds=120,
        status="approaching",
    )


def test_spoken_line_names_the_soonest_closure() -> None:
    text = spoken_line(
        [
            CrossingForecastIn(
                crossing_id="crossing-002",
                eta_seconds=90,
                estimated_blockage_seconds=120,
                status="approaching",
            ),
            _approaching(45),
        ]
    )
    assert text == "Heads up. A train will block crossing 001 in about 45 seconds."


def test_blocking_is_spoken_ahead_of_a_later_approach() -> None:
    text = spoken_line(
        [
            _approaching(10),
            CrossingForecastIn(
                crossing_id="crossing-002",
                eta_seconds=None,
                estimated_blockage_seconds=30,
                status="blocking",
            ),
        ]
    )
    assert text == "A train is blocking crossing 002 for about 30 seconds."


def test_same_situation_is_not_spoken_again() -> None:
    book = AlertBook()
    first = book.ingest(_event(1, [_approaching(45)]))
    second = book.ingest(_event(2, [_approaching(40)]))
    assert first is not None
    assert first.text.startswith("Heads up.")
    assert second is None


def test_status_change_and_clearance_are_new_alerts() -> None:
    book = AlertBook()
    approaching = book.ingest(_event(1, [_approaching()]))
    blocking = book.ingest(
        _event(
            2,
            [
                CrossingForecastIn(
                    crossing_id="crossing-001",
                    eta_seconds=0,
                    estimated_blockage_seconds=80,
                    status="blocking",
                )
            ],
        )
    )
    cleared = book.ingest(
        _event(
            3,
            [
                CrossingForecastIn(
                    crossing_id="crossing-001",
                    eta_seconds=None,
                    estimated_blockage_seconds=None,
                    status="clear",
                )
            ],
        )
    )
    again = book.ingest(
        _event(
            4,
            [
                CrossingForecastIn(
                    crossing_id="crossing-001",
                    eta_seconds=None,
                    estimated_blockage_seconds=None,
                    status="clear",
                )
            ],
        )
    )
    assert approaching is not None and blocking is not None and cleared is not None
    assert approaching.id != blocking.id
    assert cleared.text == CLEAR_TEXT
    assert again is None


def test_duplicate_sequence_is_rejected() -> None:
    book = AlertBook()
    book.ingest(_event(1, [_approaching()]))
    try:
        book.ingest(_event(1, [_approaching()]))
    except StalePrediction:
        return
    raise AssertionError("expected StalePrediction")


def test_reset_allows_the_run_to_start_again() -> None:
    book = AlertBook()
    book.ingest(_event(4, [_approaching()]))
    book.reset("demo-001")
    again = book.ingest(_event(1, [_approaching(12)]))
    assert again is not None
    assert "12" in again.text
