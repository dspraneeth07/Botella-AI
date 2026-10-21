#!/usr/bin/env python
"""Past home games are public record. Fetch them, so sports can be measured.

    python scripts/backfill_sports_history.py --stores 171,176,177,178,181 \
        --data ../audit/data [--dry-run]

WHY THIS EXISTS
    `signal_history` had no row for any home game, ever, because the only writer
    was a CALENDAR backfill and a fixture is not a function of a date. So
    `nfl_home_game` and its three siblings could never be measured, and every card
    the owner saw was computed from sales while the page beside it listed four
    live leagues.

    The run now captures what it sees, which fixes the future and does nothing for
    the past. This fixes the past.

THE SAME ARGUMENT THE WEATHER ARCHIVE WON
    `signal_backfill` says weather cannot be backfilled because a past advisory is
    not recoverable from a date. True of a CALENDAR and false of the world: daily
    highs are public record and an archive returns them, which is how 1,550 weather
    days reached the table and how Marshfield's heat effect was finally measured.

    A past fixture is the same kind of fact. ESPN serves a scoreboard for any date,
    including dates three years ago, and whether the Cowboys played at home on
    8 September 2024 is not a matter of opinion. So this is ARCHIVED, not computed:
    a third-party record of something that happened, which is a different kind of
    fact from a date arithmetic produced and from something the engine watched.

WHAT IT DOES NOT DO
    It does not decide that home games matter. It records that they happened. The
    uplift machinery then gets to say whether the store sold more on those days
    than on matched weekdays around them, and the honest answer may well be no -
    that is what an interval excluding zero is for.

ONE FETCH PER (LEAGUE, DATE), SHARED BY EVERY STORE
    A scoreboard is league-wide, so the same response answers all five stores. The
    expensive axis is dates, not stores, and the cache below is what keeps a
    five-store backfill at the cost of a one-store backfill.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from app.config import Settings  # noqa: E402
from app.schemas.store import StoreProfile  # noqa: E402
from app.signals.sports import (  # noqa: E402
    _LEAGUE_PATHS,
    is_local_game,
    local_date,
)

#: Marked ARCHIVED, like the weather. A third-party record of a past event is
#: neither calendar arithmetic nor something this engine observed at the time.
ARCHIVED = "archived"
SOURCE = "espn.scoreboard"
#: Politeness between calls. ESPN serves this endpoint without a key and the
#: backfill is a one-off, so there is no case for hammering it.
PAUSE_SECONDS = 0.15


def scoreboard_url(league: str, day: date) -> str:
    sport, lg = _LEAGUE_PATHS[league]
    return (f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{lg}"
            f"/scoreboard?dates={day.strftime('%Y%m%d')}&limit=200")


def fetch_day(league: str, day: date, cache: dict,
              cache_dir: Path | None = None) -> list[dict]:
    """Every game ESPN lists for one league on one date, cached across stores.

    CACHED TO DISK AS WELL AS IN MEMORY, because the fetch is the expensive half
    and this script has now proved twice that it can run for an hour and then hit
    a wall. 5,456 requests at about 1.4 seconds each is ninety minutes of network;
    losing that to a crash at date 1,300 is not a risk worth carrying for the sake
    of a few megabytes of JSON.

    The in-memory cache still does the real work - a scoreboard is league-wide, so
    one response answers all five stores - and the disk copy only earns its keep
    on a RE-RUN, which is exactly when it is needed.
    """
    key = (league, day)
    if key in cache:
        return cache[key]
    stamp = day.strftime("%Y%m%d")
    on_disk = (cache_dir / f"{league}-{stamp}.json") if cache_dir else None
    if on_disk is not None and on_disk.exists():
        try:
            events = json.loads(on_disk.read_text(encoding="utf-8"))
            cache[key] = events
            return events
        except ValueError:
            pass            # a truncated file is a cache miss, never a failure
    try:
        with urllib.request.urlopen(scoreboard_url(league, day), timeout=30) as r:
            payload = json.loads(r.read().decode("utf-8"))
        events = payload.get("events") or []
    except (urllib.error.URLError, OSError, ValueError):
        # A missing day is NOT "no games". It is an unknown, and recording it as
        # absent would put a fabricated zero in the history - the exact error the
        # calendar backfill refuses weather over. So nothing is written for it.
        events = None
    cache[key] = events
    # A FAILED fetch is not cached. An unknown must stay unknown, or a transient
    # 500 would be frozen into the record as "no games that day" for every future
    # run - a fabricated zero with a long memory.
    if on_disk is not None and events is not None:
        on_disk.parent.mkdir(parents=True, exist_ok=True)
        on_disk.write_text(json.dumps(events), encoding="utf-8")
    time.sleep(PAUSE_SECONDS)
    return events


def home_games_for(events, store: StoreProfile, radius_mi: float) -> set[str]:
    """Local calendar dates on which this store's metro had a home game."""
    out: set[str] = set()
    for event in events or ():
        for comp in event.get("competitions") or ():
            home = next((c for c in comp.get("competitors") or ()
                         if c.get("homeAway") == "home"), None)
            if not home:
                continue
            team = ((home.get("team") or {}).get("displayName")
                    or (home.get("team") or {}).get("name") or "")
            venue = (comp.get("venue") or {}).get("address") or {}
            state = venue.get("state") or ""
            if not team:
                continue
            if is_local_game(team, state, store, radius_mi):
                stamp = comp.get("date") or event.get("date")
                if stamp:
                    out.add(local_date(stamp, team))
    return out


def post_rows(node: str, loc: int, rows: list[dict], token: str | None,
              chunk: int = 300) -> str:
    """POST in chunks, because 890 rows is larger than a default JSON body.

    The first run died on `PayloadTooLargeError: request entity too large` -
    Express defaults to a 100 KB body and three years of four leagues is well past
    it. Chunking here rather than raising the server limit: a one-off backfill has
    no business widening the front door for every other caller.

    Append-only with a unique index behind it, so a chunk that lands twice inserts
    once and a resumed run costs nothing.
    """
    url = f"{node.rstrip('/')}/api/clients/{loc}/locations/{loc}/signal-history"
    inserted = received = 0
    for start in range(0, len(rows), chunk):
        body = json.dumps({"rows": rows[start:start + chunk]}).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = (json.loads(resp.read().decode("utf-8")).get("data") or {})
        inserted += int(data.get("inserted") or 0)
        received += int(data.get("received") or 0)
    return f"written: inserted={inserted} received={received}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stores", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--node", default="http://localhost:3000")
    ap.add_argument("--token", default=None)
    ap.add_argument("--leagues", default="nfl,nba,mlb,nhl")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=None,
                    help="where to save the fetched rows before posting them")
    ap.add_argument("--from-file", default=None,
                    help="publish rows saved by an earlier run, with no refetch")
    ap.add_argument("--max-days", type=int, default=0,
                    help="cap the date span, for a quick smoke test")
    args = ap.parse_args()

    if args.from_file:
        # Re-publish without refetching. The whole point of saving first.
        for loc in [int(x.strip()) for x in args.stores.split(",") if x.strip()]:
            path = Path(args.from_file) / f"sports_history_{loc}.json"
            if not path.exists():
                print(f"  {loc}: {path.name} not saved, skipped")
                continue
            rows = json.loads(path.read_text(encoding="utf-8"))
            print(f"  {loc}: {len(rows)} rows from disk")
            print(f"        {post_rows(args.node, loc, rows, args.token)}")
        return 0

    from scripts.real_engine_backtest import load  # noqa: PLC0415

    settings = Settings(node_api_base_url=args.node)
    radius = float(getattr(settings, "sports_local_radius_miles", 40) or 40)
    leagues = [l.strip() for l in args.leagues.split(",") if l.strip()]
    locs = [int(s.strip()) for s in args.stores.split(",") if s.strip()]

    # Store profiles carry the geography `is_local_game` needs. Read from the
    # export's own store ids where Node is unavailable, so this can run offline
    # against the audit data.
    profiles: dict[int, StoreProfile] = {}
    spans: dict[int, list[date]] = {}
    for loc in locs:
        path = Path(args.data) / f"store_{loc}_sale_items.csv.gz"
        if not path.exists():
            print(f"  {loc}: export missing, skipped")
            continue
        store = load(str(Path(args.data)), path.name)
        spans[loc] = store.trading_days
        try:
            req = urllib.request.Request(
                f"{args.node.rstrip('/')}/api/clients/{loc}/locations/{loc}/profile")
            if args.token:
                req.add_header("Authorization", f"Bearer {args.token}")
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.loads(r.read().decode("utf-8"))
            profiles[loc] = StoreProfile.model_validate(body.get("data") or body)
        except Exception as exc:  # noqa: BLE001
            print(f"  {loc}: profile unavailable ({exc}); cannot place the store "
                  f"geographically, so its fixtures cannot be judged local")
    if not profiles:
        print("no store profiles - nothing can be judged local. Stopped.")
        return 1

    # The union of every store's trading span, fetched once per (league, date).
    all_days = sorted({d for loc in profiles for d in spans.get(loc, [])})
    if args.max_days:
        all_days = all_days[-args.max_days:]
    print(f"  {len(all_days)} dates x {len(leagues)} leagues "
          f"= {len(all_days) * len(leagues)} fetches, shared by "
          f"{len(profiles)} stores")

    cache: dict = {}
    cache_dir = (Path(args.out) / "espn-cache") if args.out else None
    rows_by_loc: dict[int, list[dict]] = defaultdict(list)
    unknown = 0
    for n, day in enumerate(all_days, start=1):
        for league in leagues:
            events = fetch_day(league, day, cache, cache_dir)
            if events is None:
                unknown += 1
                continue
            for loc, profile in profiles.items():
                if day not in set(spans.get(loc, ())):
                    continue
                for local in home_games_for(events, profile, radius):
                    rows_by_loc[loc].append({
                        "as_of": local,
                        "signal_key": f"{league}_home_game",
                        # No strength: this is a binary "there was a home game".
                        # A fabricated 1.0 would later be averaged with a real
                        # captured intensity and called measured.
                        "strength": None,
                        "source": SOURCE,
                        "origin": ARCHIVED,
                    })
        if n % 100 == 0:
            # FLUSHED. Python buffers stdout when it is not a terminal, so a
            # thirty-minute backfill redirected to a file shows nothing at all
            # until it finishes - which is indistinguishable from a hang, and
            # cost one wasted watch before this line was added.
            print(f"      {n}/{len(all_days)} dates, "
                  f"{sum(len(v) for v in rows_by_loc.values())} rows so far",
                  flush=True)

    print(f"\n  {unknown} (league, date) fetches failed and were left UNWRITTEN "
          f"rather than recorded as 'no game'")
    for loc in sorted(rows_by_loc):
        rows = rows_by_loc[loc]
        keys = defaultdict(int)
        for r in rows:
            keys[r["signal_key"]] += 1
        print(f"  {loc}: {len(rows)} rows  " +
              "  ".join(f"{k}={v}" for k, v in sorted(keys.items())))
        # ── SAVE BEFORE SENDING ───────────────────────────────────────
        #
        # The fetch is the expensive half - an hour of network for three years of
        # four leagues - and the write is the half that fails. The first version
        # posted straight from memory and lost the whole run to a 500 on the first
        # store, with the other four stores' rows computed and never written.
        # Nothing that took an hour to produce should exist only in RAM.
        out_dir = Path(args.out or ".")
        out_dir.mkdir(parents=True, exist_ok=True)
        saved = out_dir / f"sports_history_{loc}.json"
        saved.write_text(json.dumps(rows, indent=1), encoding="utf-8")
        print(f"        saved {saved}")
        if args.dry_run:
            continue
        print(f"        {post_rows(args.node, loc, rows, args.token)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
