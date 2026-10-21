#!/usr/bin/env python
"""How much of this engine is still guesswork?

Prints every declared Setting grouped by status, and ends with the number
that matters: how many judgements are still PROVISIONAL. The current engine
cannot produce this number at all, which is exactly why its 63 constants went
unexamined for so long.

Settings register themselves when their module is imported, so this walks
``app/pipeline/`` and imports it before reporting. A settings module that is
never imported is invisible here — which is itself worth knowing.

Usage:
    python scripts/config_report.py                 # full report
    python scripts/config_report.py --count         # just the number
    python scripts/config_report.py --max-provisional 20
        exit 1 if more than 20 remain — the ratchet, once wave 6 starts
        promoting settings to FITTED.
"""

from __future__ import annotations

import argparse
import importlib
import pkgutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from app.pipeline import ConfigRegistry  # noqa: E402  (needs the path above)

#: Packages walked for Setting declarations. Add new ones as waves land.
# Sheet 07 put the first Settings outside `app.pipeline` - the forecasting
# thresholds live with the forecasters in `storeagent`. They were invisible
# here until this list grew, and the report cheerfully said "MEASURED (0)"
# while four MEASURED settings existed. A catalogue that silently omits a
# whole package is worse than no catalogue: the entire value of this registry
# is being able to enumerate EVERY judgement in the system, and an incomplete
# enumeration reads exactly like a complete one.
SETTING_PACKAGES = ("app.pipeline", "storeagent.forecasting")


def import_settings() -> list[str]:
    """Import every module that might declare a Setting. Returns what failed."""
    failures: list[str] = []
    for package_name in SETTING_PACKAGES:
        package = importlib.import_module(package_name)
        for info in pkgutil.walk_packages(package.__path__, prefix=f"{package_name}."):
            try:
                importlib.import_module(info.name)
            except Exception as exc:  # noqa: BLE001 — report, do not abort
                failures.append(f"{info.name}: {exc}")
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", action="store_true", help="print only the count")
    parser.add_argument(
        "--max-provisional", type=int, default=None,
        help="exit 1 if more than N settings are still PROVISIONAL",
    )
    args = parser.parse_args(argv)

    failures = import_settings()
    registry = ConfigRegistry()

    if args.count:
        report = registry.report()
        print(report.provisional_count)
    else:
        report = registry.print_report()
        for failure in failures:
            print(f"  ! could not import {failure}", file=sys.stderr)

    print(
        f"[config] {report.provisional_count} of {report.total} settings are still "
        "PROVISIONAL (unfitted judgements)"
    )

    if args.max_provisional is not None and report.provisional_count > args.max_provisional:
        print(
            f"[config] FAIL: {report.provisional_count} PROVISIONAL settings exceeds "
            f"the allowed {args.max_provisional}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
