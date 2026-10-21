"""The build guards for sheet 00.

Two things are being protected here, and both are the kind that rot silently:

* no new magic numbers in the pipeline (rule 3);
* no ambient reads inside a stage - one ``date.today()`` destroys replay for
  every run that touches it, and the output still looks perfectly reasonable.

Running the real checker as a test is what "wire it into the test run" means:
there is no separate CI step to forget, and a violation fails the same command
everyone already runs.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from textwrap import dedent

import pytest

from app.pipeline import ConfigRegistry, Setting

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "check_no_literals.py"


def _load_checker():
    """Load the script by path - scripts/ is a CLI directory, not a package."""
    spec = importlib.util.spec_from_file_location("check_no_literals", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["check_no_literals"] = module
    spec.loader.exec_module(module)
    return module


checker = _load_checker()


def _plant(root: Path, relpath: str, body: str) -> Path:
    path = root / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


# ── The real repository must be clean ───────────────────────────────────────


def test_the_repository_has_no_new_magic_numbers() -> None:
    """This is the guard itself, not a test of the guard."""
    assert checker.main(["--root", str(REPO_ROOT)]) == 0


def test_the_pipeline_package_is_completely_clean() -> None:
    """storeagent/ carries a grandfathered baseline; app/pipeline/ carries
    none and never should."""
    offenders = [
        v for v in checker.collect(REPO_ROOT) if v.path.startswith("app/pipeline")
    ]
    assert offenders == [], f"app/pipeline must stay clean, found: {offenders}"


# ── The guard catches a planted violation ───────────────────────────────────


def test_a_planted_float_is_caught_and_passes_once_removed(tmp_path: Path) -> None:
    planted = _plant(
        tmp_path,
        "app/pipeline/planted.py",
        "def score(x):\n    return x * 0.85\n",
    )

    violations = checker.collect(tmp_path)
    assert [v.detail for v in violations] == ["0.85"]
    assert violations[0].kind == "float"
    assert violations[0].line == 2
    # Exit code, not just the scan: the build has to actually fail.
    assert checker.main(["--root", str(tmp_path), "--no-baseline"]) == 1

    planted.unlink()
    assert checker.collect(tmp_path) == []
    assert checker.main(["--root", str(tmp_path), "--no-baseline"]) == 0


def test_zero_and_one_are_not_violations(tmp_path: Path) -> None:
    """Identity elements and probability bounds are not judgements; flagging
    them would train everyone to suppress the check reflexively."""
    _plant(
        tmp_path,
        "app/pipeline/bounds.py",
        "def clamp(x):\n    return min(1.0, max(0.0, x))\n",
    )
    assert checker.collect(tmp_path) == []


def test_the_registry_is_exempt(tmp_path: Path) -> None:
    """registry.py is where the numbers are supposed to live."""
    _plant(tmp_path, "app/pipeline/registry.py", "DEFAULT_K = 12.0\n")
    assert checker.collect(tmp_path) == []


def test_tests_are_exempt(tmp_path: Path) -> None:
    _plant(tmp_path, "app/pipeline/tests/test_thing.py", "EXPECTED = 0.85\n")
    assert checker.collect(tmp_path) == []


# ── The ambient-read rule ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("from datetime import date\nx = date.today()\n", "date.today"),
        ("import datetime\nx = datetime.datetime.now()\n", "datetime.now"),
        ("import os\nx = os.environ\n", "os.environ"),
        ("import random\nx = random.random()\n", "random.random"),
        ("import uuid\nx = uuid.uuid4()\n", "uuid.uuid4"),
    ],
)
def test_ambient_reads_inside_the_pipeline_are_caught(
    tmp_path: Path, body: str, expected: str
) -> None:
    _plant(tmp_path, "app/pipeline/leaky.py", body)
    violations = [v for v in checker.collect(tmp_path) if v.kind == "ambient"]
    assert len(violations) == 1
    assert expected in violations[0].detail


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        # "Do not reintroduce ... or connection object inside a stage function."
        ("import psycopg\nc = psycopg.connect()\n", "psycopg.connect"),
        ("from sqlalchemy import create_engine\ne = create_engine('x')\n", "create_engine"),
        ("from storeagent.app_db import app_conn\nc = app_conn()\n", "app_conn"),
        # done-when #1: "no database, no network and no clock"
        ("import httpx\nr = httpx.get('u')\n", "httpx.get"),
        ("import requests\nr = requests.post('u')\n", "requests.post"),
        ("from urllib.request import urlopen\nr = urlopen('u')\n", "urlopen"),
    ],
)
def test_database_and_network_reads_are_caught(
    tmp_path: Path, body: str, expected: str
) -> None:
    """A stage that opens a connection or makes a call is reading data that is
    not in its input - so its output can never be reproduced from the audit
    row, which is the whole promise of the envelope."""
    _plant(tmp_path, "app/pipeline/leaky.py", body)
    violations = [v for v in checker.collect(tmp_path) if v.kind == "ambient"]
    assert len(violations) == 1, violations
    assert expected in violations[0].detail


def test_ambient_rule_does_not_apply_to_legacy_storeagent(tmp_path: Path) -> None:
    """storeagent/ is in scope for the float rule only until it is ported;
    applying the clock rule there today would just block every commit."""
    _plant(tmp_path, "storeagent/legacy.py", "from datetime import date\nx = date.today()\n")
    assert [v for v in checker.collect(tmp_path) if v.kind == "ambient"] == []


# ── Baseline behaviour ──────────────────────────────────────────────────────


def test_baseline_grandfathers_existing_but_not_new(tmp_path: Path) -> None:
    _plant(tmp_path, "storeagent/old.py", "K = 0.003\n")
    baseline = tmp_path / "baseline.json"

    # Record what exists today...
    assert checker.main(
        ["--root", str(tmp_path), "--baseline", str(baseline), "--update-baseline"]
    ) == 0
    assert checker.main(["--root", str(tmp_path), "--baseline", str(baseline)]) == 0

    # ...a NEW one still fails.
    _plant(tmp_path, "storeagent/new.py", "K = 0.777\n")
    assert checker.main(["--root", str(tmp_path), "--baseline", str(baseline)]) == 1


def test_baseline_refuses_to_grow(tmp_path: Path) -> None:
    """The debt list may shrink, never grow - otherwise --update-baseline
    becomes the standard way to silence the check."""
    _plant(tmp_path, "storeagent/old.py", "K = 0.003\n")
    baseline = tmp_path / "baseline.json"
    checker.main(["--root", str(tmp_path), "--baseline", str(baseline), "--update-baseline"])

    _plant(tmp_path, "storeagent/new.py", "K = 0.777\n")
    assert checker.main(
        ["--root", str(tmp_path), "--baseline", str(baseline), "--update-baseline"]
    ) == 1


def test_baseline_key_survives_a_line_shift(tmp_path: Path) -> None:
    """Adding an import above a grandfathered constant must not read as a new
    violation, or the baseline is unusable noise."""
    _plant(tmp_path, "storeagent/old.py", "K = 0.003\n")
    baseline = tmp_path / "baseline.json"
    checker.main(["--root", str(tmp_path), "--baseline", str(baseline), "--update-baseline"])

    _plant(tmp_path, "storeagent/old.py", "import os\nimport sys\n\nK = 0.003\n")
    assert checker.main(["--root", str(tmp_path), "--baseline", str(baseline)]) == 0


def test_a_file_with_a_bom_is_parsed_not_reported(tmp_path: Path) -> None:
    """A BOM is invisible to the Python importer; reading as plain utf-8 made
    ast.parse reject a perfectly valid module (storeagent/source/loss_repo.py
    really does have one)."""
    path = tmp_path / "storeagent" / "bom.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("K = 2.0\n", encoding="utf-8-sig")
    violations = checker.collect(tmp_path)
    assert [v.kind for v in violations] == ["float"]


# ── The PROVISIONAL count, printed on every run ─────────────────────────────


def test_config_report_states_how_much_is_still_guesswork(capsys) -> None:
    """A number the current engine cannot produce at all, which is why its 63
    constants went unexamined for so long."""
    # Declared here rather than relying on another test module having been
    # imported first: the catalogue is process-wide, so a report test that
    # borrows someone else's settings passes or fails on collection order.
    Setting(
        name="test.guards.sentinel", default=3, unit="count",
        owner="pipeline", why="proves the report is populated",
        status="PROVISIONAL",
    )
    report = ConfigRegistry().report()
    print(f"\n[config] {report.provisional_count} of {report.total} settings "
          f"are still PROVISIONAL")
    assert report.total >= 1
    assert report.provisional_count >= 0
    assert "still PROVISIONAL" in str(report)
    assert "PROVISIONAL" in capsys.readouterr().out


def test_cfg_print_report_prints_grouped_by_status(capsys) -> None:
    """The sheet's wording: "cfg.report() prints every setting grouped by
    status". report() returns so it can be asserted on; print_report() is the
    verb, and it is what CI calls."""
    Setting(
        name="test.guards.printed", default=5, unit="count",
        owner="pipeline", why="proves print_report emits the grouping",
        status="FITTED",
    )
    returned = ConfigRegistry().print_report()
    out = capsys.readouterr().out
    for status in ("PROVISIONAL", "FITTED", "MEASURED"):
        assert status in out
    assert "test.guards.printed" in out
    assert "why: proves print_report emits the grouping" in out
    assert returned.total >= 1  # returns the report as well as printing it


# ── Sheet 07 widened the guard by exactly one shape. Prove it is still tight. ─


def test_a_float_default_of_a_registered_setting_is_allowed(tmp_path: Path) -> None:
    """Sheet 07 needed the published Syntetos-Boylan cuts (1.32, 0.49) as
    Settings declared outside registry.py, and the guard flagged them - while
    its own message said to declare thresholds exactly that way.

    A Setting carries a name, unit, owner, reason and status. That is the
    opposite of a magic number; it is the documented form the guard asks for.
    """
    _plant(tmp_path, "storeagent/ok.py", dedent('''
        from app.pipeline.registry import Setting

        ADI_CUT = Setting(
            name="x.adi_cut",
            default=1.32,
            unit="open days",
            owner="forecasting",
            why="published Syntetos-Boylan cut",
            status="MEASURED",
        )
    '''))
    assert checker.collect(tmp_path) == []


def test_the_guard_still_catches_a_bare_float_beside_a_setting(tmp_path: Path) -> None:
    """The widening must not become a general amnesty.

    A file containing a legitimate Setting default AND a bare threshold must
    still fail on the bare one - otherwise declaring one Setting would launder
    every other number in the module.
    """
    _plant(tmp_path, "storeagent/mixed.py", dedent('''
        from app.pipeline.registry import Setting

        CUT = Setting(
            name="x.cut", default=1.32, unit="u", owner="o", why="w",
            status="MEASURED",
        )

        def score(value):
            return value * 0.87
    '''))
    violations = checker.collect(tmp_path)
    assert len(violations) == 1
    assert violations[0].kind == "float"
    assert "0.87" in str(violations[0])


def test_the_same_value_elsewhere_in_the_file_is_not_laundered(tmp_path: Path) -> None:
    """Identity, not value: a Setting default of 0.49 must not excuse a bare
    0.49 three lines later."""
    _plant(tmp_path, "storeagent/same.py", dedent('''
        from app.pipeline.registry import Setting

        CUT = Setting(
            name="x.cv2", default=0.49, unit="u", owner="o", why="w",
            status="MEASURED",
        )

        def classify(cv2):
            return cv2 >= 0.49
    '''))
    violations = checker.collect(tmp_path)
    assert len(violations) == 1, (
        "the bare 0.49 must still be caught even though a Setting declares "
        "the same value"
    )


def test_a_float_default_on_something_that_is_not_a_setting_is_still_caught(
    tmp_path: Path,
) -> None:
    """Only `Setting(...)` gets the exemption - not any call with a
    `default=`."""
    _plant(tmp_path, "storeagent/notasetting.py", dedent('''
        def field(default=None, **kw):
            return default

        THRESHOLD = field(default=1.32)
    '''))
    violations = checker.collect(tmp_path)
    assert len(violations) == 1
