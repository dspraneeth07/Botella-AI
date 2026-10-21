"""load_fixture — run any stage with no database, no network and no clock.

The done-when for this sheet is that a stage runs from a JSON file. That is
not a testing convenience, it is the proof that the envelope holds: if a stage
can be fully exercised from a flat file, then it genuinely has no hidden
inputs, and the only things that can change its answer are the ones stamped on
its audit row.

Fixture shape (``tests/fixtures/<name>.json``)::

    {
      "context": {
        "run_id": "...", "tenant_id": 46, "store_id": 46,
        "as_of": "2026-09-21", "snapshot_id": "...",
        "config_version": "default", "seed": 0,
        "versions": {"engine": "2.0.0"}
      },
      "input": { ... whatever the stage takes ... }
    }
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.pipeline.context import RunContext

#: Repo-root-relative default. app/pipeline/fixtures.py -> app -> <root>.
DEFAULT_FIXTURE_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures"


def fixture_path(name: str, *, root: Path | None = None) -> Path:
    stem = name[:-5] if name.endswith(".json") else name
    return (root or DEFAULT_FIXTURE_DIR) / f"{stem}.json"


def load_fixture(name: str, *, root: Path | None = None) -> tuple[Any, RunContext]:
    """Return ``(input, ctx)`` for the named fixture.

    Raises with the paths it looked at rather than a bare KeyError — a missing
    fixture is usually a typo, and the useful information is where it looked.
    """
    path = fixture_path(name, root=root)
    if not path.exists():
        available = (
            sorted(p.stem for p in path.parent.glob("*.json"))
            if path.parent.exists()
            else []
        )
        raise FileNotFoundError(
            f"No fixture {name!r} at {path}. Available: {available or '(none)'}"
        )

    data = json.loads(path.read_text(encoding="utf-8"))
    if "context" not in data:
        raise ValueError(f"fixture {name!r} has no 'context' key")
    return data.get("input"), RunContext.from_dict(data["context"])


def save_fixture(
    name: str, stage_input: Any, ctx: RunContext, *, root: Path | None = None
) -> Path:
    """Write a fixture. Handy for capturing a real run as a regression case."""
    path = fixture_path(name, root=root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"context": ctx.to_dict(), "input": stage_input}, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


__all__ = ["DEFAULT_FIXTURE_DIR", "fixture_path", "load_fixture", "save_fixture"]
