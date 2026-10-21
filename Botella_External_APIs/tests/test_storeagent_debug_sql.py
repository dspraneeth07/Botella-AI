"""A failing capability run must keep the SQL timings it collected.

Under STOREAGENT_DEBUG_SQL the runner records a duration per warehouse query,
but the log was only attached on the success path -- so the one run you most
want to inspect, a statement timeout, threw the evidence away. The queries that
completed before the timeout, with their durations, are what identify the slow
one.
"""
from __future__ import annotations

import pytest

from storeagent.api import service


def _cfg(runner):
    return {"runner": runner}


def test_partial_sql_log_rides_out_on_the_exception(monkeypatch) -> None:
    monkeypatch.setattr(service, "DEBUG_SQL", True)

    def runner(store, location, **kw):
        from storeagent.source.connector import _sql_capture
        _sql_capture.get().append({"sql": "SELECT 1", "duration_ms": 119_998.0})
        raise RuntimeError("canceling statement due to statement timeout")

    with pytest.raises(RuntimeError) as caught:
        service._compute(_cfg(runner), 171, 171, narrate=False)

    log = getattr(caught.value, "debug_sql", None)
    assert log, "the completed queries must survive the failure"
    assert log[0]["duration_ms"] == pytest.approx(119_998.0)


def test_success_path_still_attaches_the_log(monkeypatch) -> None:
    monkeypatch.setattr(service, "DEBUG_SQL", True)
    result = service._compute(_cfg(lambda s, loc, **kw: {"ok": True}), 171, 171, narrate=False)
    assert result["ok"] is True
    assert "debug_sql" in result


def test_capture_is_not_left_open_after_a_failure(monkeypatch) -> None:
    """end_sql_capture() still runs in the finally, so the next request on this
    thread does not inherit a live capture."""
    from storeagent.source.connector import _sql_capture

    monkeypatch.setattr(service, "DEBUG_SQL", True)

    def runner(store, location, **kw):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        service._compute(_cfg(runner), 171, 171, narrate=False)
    assert _sql_capture.get() is None


def test_debug_off_adds_nothing(monkeypatch) -> None:
    monkeypatch.setattr(service, "DEBUG_SQL", False)

    def runner(store, location, **kw):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError) as caught:
        service._compute(_cfg(runner), 171, 171, narrate=False)
    assert not hasattr(caught.value, "debug_sql")


def test_unsettable_exception_does_not_mask_the_real_error(monkeypatch) -> None:
    """Attaching diagnostics must never replace the failure being diagnosed.

    (`__slots__ = ()` alone would NOT reproduce this — Exception supplies a
    __dict__ regardless — so reject the assignment explicitly.)
    """
    class Unsettable(Exception):
        def __setattr__(self, name, value):
            raise AttributeError(name)

    monkeypatch.setattr(service, "DEBUG_SQL", True)

    def runner(store, location, **kw):
        raise Unsettable("canceling statement due to statement timeout")

    with pytest.raises(Unsettable, match="statement timeout"):
        service._compute(_cfg(runner), 171, 171, narrate=False)
