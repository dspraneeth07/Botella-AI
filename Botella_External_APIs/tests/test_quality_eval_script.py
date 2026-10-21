"""Checklist 13 - the quality gates finally have a caller.

`scripts/quality_eval.py` is what Node runs per store at 03:50. These tests
run it the way Node does - a payload file in, one JSON object out - and pin
the three facts the serving path depends on: a never-synced store is
REJECTED, a stale store carries BOTH staleness and the store's own median
interval (so Node's `data_too_stale` refusal has numbers to fire on), and a
fresh store passes.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from app.pipeline.contracts.gates import (
    FRESHNESS_TOLERANCE_PCT,
)

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "quality_eval.py"
AS_OF = "2026-10-08"
MIDNIGHT = datetime(2026, 10, 8)


def daily_syncs(ending_days_ago: int, count: int = 30) -> list[str]:
    """`count` successful syncs one day apart, the newest `ending_days_ago`
    days before AS_OF - a store on a DAILY cadence."""
    last = MIDNIGHT - timedelta(days=ending_days_ago)
    return [(last - timedelta(days=i)).isoformat() + "Z" for i in range(count)]


def run_script(tmp_path: Path, payload: dict) -> dict:
    path = tmp_path / "quality.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    done = subprocess.run(
        [sys.executable, str(SCRIPT), str(path)],
        cwd=REPO, capture_output=True, text=True,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def payload(**over) -> dict:
    base = {"client_id": 9999, "location_id": 999901, "connector": "clover",
            "as_of": AS_OF}
    return {**base, **over}


# ── Never synced: reject ────────────────────────────────────────────────────


def test_a_store_that_never_synced_is_rejected(tmp_path) -> None:
    out = run_script(tmp_path, payload(freshness=[
        {"entity": "sales", "last_successful_sync": None, "recent_syncs": []},
    ]))
    assert out["verdict"] == "reject"
    assert out["may_recommend"] is False
    assert out["never_synced"] is True
    assert out["staleness_days"] is None, "never synced is NOT zero days stale"
    assert "never_synced" in out["reasons"]
    fresh = [g for g in out["gates"] if g["gate"] == "freshness"]
    assert len(fresh) == 1 and fresh[0]["verdict"] == "fail"
    assert fresh[0]["entity"] == "sales"


# ── Stale on a daily cadence: degraded, with both numbers filled ────────────


def test_twenty_days_stale_on_a_daily_cadence_is_degraded_with_both_numbers(
    tmp_path,
) -> None:
    """The row this writes is what lets Node refuse. `data_too_stale` needs
    staleness_days AND median_interval_days, and nothing wrote either."""
    out = run_script(tmp_path, payload(freshness=[
        {"entity": "sales", "last_successful_sync": daily_syncs(20)[0],
         "recent_syncs": daily_syncs(20)},
    ]))
    assert out["verdict"] == "degraded"
    assert out["may_recommend"] is True, (
        "Python degrades; the refusal at 6x cadence is Node's admission rule")
    assert out["never_synced"] is False
    assert out["staleness_days"] == pytest.approx(20.0, abs=0.01)
    assert out["median_interval_days"] == pytest.approx(1.0)
    assert any(r.startswith("stale:") for r in out["reasons"])

    fresh = next(g for g in out["gates"] if g["gate"] == "freshness")
    assert fresh["verdict"] == "degraded"
    detail = fresh["detail"]["value"]
    assert detail["cadence_source"] == "own_history"
    tolerance = FRESHNESS_TOLERANCE_PCT.default
    assert detail["allowed_days"] == pytest.approx(1.0 * tolerance / 100)


# ── Fresh: pass ─────────────────────────────────────────────────────────────


def test_a_fresh_store_passes(tmp_path) -> None:
    out = run_script(tmp_path, payload(freshness=[
        {"entity": "sales", "last_successful_sync": daily_syncs(1)[0],
         "recent_syncs": daily_syncs(1)},
        {"entity": "products", "last_successful_sync": daily_syncs(1)[0],
         "recent_syncs": daily_syncs(1)},
    ]))
    assert out["verdict"] == "pass"
    assert out["may_recommend"] is True
    assert out["staleness_days"] == pytest.approx(1.0, abs=0.01)
    assert out["median_interval_days"] == pytest.approx(1.0)
    assert out["reasons"] == []
    assert sorted(g["entity"] for g in out["gates"] if g["gate"] == "freshness") \
        == ["products", "sales"]


# ── Worst entity wins ───────────────────────────────────────────────────────


def test_the_store_is_only_as_fresh_as_its_least_fresh_feed(tmp_path) -> None:
    """Fresh sales and a never-synced products feed is a store with no prices
    or stock. The verdict is built from the worst entity and the other one's
    reading is still on the row."""
    out = run_script(tmp_path, payload(freshness=[
        {"entity": "sales", "last_successful_sync": daily_syncs(1)[0],
         "recent_syncs": daily_syncs(1)},
        {"entity": "products", "last_successful_sync": None, "recent_syncs": []},
    ]))
    assert out["verdict"] == "reject"
    assert out["freshness_entity"] == "products"
    assert out["never_synced"] is True


def test_a_stale_secondary_feed_is_named_on_the_row(tmp_path) -> None:
    out = run_script(tmp_path, payload(freshness=[
        {"entity": "sales", "last_successful_sync": daily_syncs(20)[0],
         "recent_syncs": daily_syncs(20)},
        {"entity": "products", "last_successful_sync": daily_syncs(9)[0],
         "recent_syncs": daily_syncs(9)},
    ]))
    assert out["verdict"] == "degraded"
    assert out["freshness_entity"] == "sales"
    assert any(r.startswith("products:stale:") for r in out["reasons"])


# ── No history at all: default cadence, said so ─────────────────────────────


def test_too_little_history_falls_back_to_the_default_cadence_and_says_so(
    tmp_path,
) -> None:
    """Two syncs are not a cadence. The gate assumes the connector default and
    the row says `default_assumed` rather than inventing a median from two
    points - and Node's refusal still has a median to work with."""
    out = run_script(tmp_path, payload(
        freshness=[{"entity": "sales", "last_successful_sync": daily_syncs(2)[0],
                    "recent_syncs": daily_syncs(2, count=2)}],
        notes=["sync_history_unavailable:ECONNREFUSED"],
    ))
    fresh = next(g for g in out["gates"] if g["gate"] == "freshness")
    assert fresh["detail"]["value"]["cadence_source"] == "default_assumed"
    assert out["median_interval_days"] is not None
    assert "sync_history_unavailable:ECONNREFUSED" in out["reasons"]


# ── Anomaly: abstains below the floor, quarantines a double-load ────────────


def test_anomaly_with_thin_history_abstains(tmp_path) -> None:
    out = run_script(tmp_path, payload(
        freshness=[{"entity": "sales", "last_successful_sync": daily_syncs(1)[0],
                    "recent_syncs": daily_syncs(1)}],
        anomaly={"entity": "sales", "batch_volume": 400,
                 "trailing": {"median_daily_volume": 200, "observations": 2}},
    ))
    assert out["verdict"] == "pass"
    anomaly = next(g for g in out["gates"] if g["gate"] == "anomaly")
    assert anomaly["verdict"] == "abstained"


def test_a_double_load_is_quarantined(tmp_path) -> None:
    out = run_script(tmp_path, payload(
        freshness=[{"entity": "sales", "last_successful_sync": daily_syncs(1)[0],
                    "recent_syncs": daily_syncs(1)}],
        anomaly={"entity": "sales", "batch_volume": 600,
                 "trailing": {"median_daily_volume": 200, "observations": 60}},
    ))
    assert out["verdict"] == "quarantine"
    assert out["may_recommend"] is False
    assert any(r.startswith("volume_spike:") for r in out["reasons"])
    anomaly = next(g for g in out["gates"] if g["gate"] == "anomaly")
    assert anomaly["verdict"] == "fail"


# ── Schema: a batch with a missing required column is rejected ──────────────


def test_a_batch_missing_a_required_column_is_rejected_and_names_it(tmp_path) -> None:
    out = run_script(tmp_path, payload(
        freshness=[{"entity": "sales", "last_successful_sync": daily_syncs(1)[0],
                    "recent_syncs": daily_syncs(1)}],
        batch={"entity": "sales", "batch_id": "test-1",
               "rows": [{"sku": "A", "qty": 1}, {"sku": "B", "qty": 2}]},
    ))
    assert out["verdict"] == "reject"
    assert any(r.startswith("missing_required_field:") for r in out["reasons"])
    schema = next(g for g in out["gates"] if g["gate"] == "schema")
    assert schema["verdict"] == "fail"
    assert schema["entity"] == "sales"
