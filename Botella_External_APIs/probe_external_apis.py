"""Ad-hoc probe: call each external signal source's real fetch() and report.

Run:  .venv/bin/python probe_external_apis.py [lat lng STATE]
Exercises the actual app code paths (app/signals/*) against the live APIs,
using a sample US store so the geo-gated sources fire, then runs the combined
``gather_signals`` exactly as a real request would. Safe/read-only.
"""

from __future__ import annotations

import asyncio
import os
import sys

# The status marks below are non-ASCII. A legacy Windows console runs cp1252 and
# raises UnicodeEncodeError on the first one, killing the probe before it prints
# a single result - and again inside the except handler, so the real error is
# lost too. Ask for UTF-8 and degrade unprintable glyphs instead of dying.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Settings has two required fields; give them harmless placeholders so the
# config object constructs without a .env. They are not used by signal fetches.
os.environ.setdefault("NODE_API_BASE_URL", "http://localhost:3000")
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-placeholder")

import httpx

from app.config import get_settings
from app.schemas.store import StoreProfile
from app.signals import (
    events,
    gather_signals,
    google_trends,
    holidays,
    news,
    reddit,
    social,
    sports,
    weather,
    youtube,
)

# Chicago, IL by default — has geo + state so every geo/state-gated source can
# fire. Override with:  probe_external_apis.py 40.71 -74.0 NY
if len(sys.argv) == 4:
    _LAT, _LNG, _STATE = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3].upper()
else:
    _LAT, _LNG, _STATE = 41.8781, -87.6298, "IL"

STORE = StoreProfile(
    id=1, name="Probe Store", city="(probe)", state=_STATE,
    latitude=_LAT, longitude=_LNG,
)


def line(label: str, ok: bool, detail: str) -> None:
    mark = "✅" if ok else "—"
    print(f"{mark} {label:<14} {detail}")


async def main() -> None:
    settings = get_settings()
    print(f"Probing external APIs as store: {STORE.name} "
          f"({STORE.latitude}, {STORE.longitude}, {STORE.state})\n")

    async with httpx.AsyncClient(
        timeout=settings.http_timeout_seconds,
        headers={"User-Agent": settings.nws_user_agent},
        follow_redirects=True,
    ) as http:
        # 1. NWS weather (no key)
        try:
            sig, keys = await weather.fetch(STORE, http, settings)
            if sig:
                line("weather", True,
                     f"{sig.summary} | high {sig.high_f}F low {sig.low_f}F "
                     f"| alerts={sig.alerts} | keys={keys}")
            else:
                line("weather", False, "no data returned (None)")
        except Exception as exc:  # noqa: BLE001
            line("weather", False, f"ERROR: {exc!r}")

        # 2. ESPN sports (no key) — national fetch, then per-store locality.
        try:
            national = await sports.fetch_national(http, settings)
            games, keys = sports.localize(national, STORE, settings)
            locals_ = [g for g in games if g.is_local_home]
            line("sports", bool(games),
                 f"{len(national)} national games, {len(locals_)} local | keys={keys}"
                 + (f" | local e.g. {locals_[0].away} @ {locals_[0].home} "
                    f"({locals_[0].date})" if locals_ else ""))
        except Exception as exc:  # noqa: BLE001
            line("sports", False, f"ERROR: {exc!r}")

        # 3. Ticketmaster events (needs key)
        if not settings.ticketmaster_api_key:
            line("events", False, "skipped: TICKETMASTER_API_KEY not set")
        else:
            try:
                evs, keys = await events.fetch(STORE, http, settings)
                line("events", bool(evs),
                     f"{len(evs)} events within {settings.event_radius_miles}mi | keys={keys}"
                     + (f" | e.g. {evs[0].name} @ {evs[0].venue} ({evs[0].date})"
                        if evs else ""))
            except Exception as exc:  # noqa: BLE001
                line("events", False, f"ERROR: {exc!r}")

        # 4. NewsData news (needs key)
        if not settings.newsdata_api_key:
            line("news", False, "skipped: NEWSDATA_API_KEY not set")
        else:
            try:
                ns, keys = await news.fetch(STORE, http, settings)
                line("news", bool(ns),
                     f"{len(ns)} headlines | keys={keys} "
                     f"| query={news.build_query(STORE.state)!r}"
                     + (f" | e.g. {ns[0].headline!r}" if ns else ""))
            except Exception as exc:  # noqa: BLE001
                line("news", False, f"ERROR: {exc!r}")

        # 5. Reddit discovery (needs script-app credentials)
        if not (settings.reddit_client_id and settings.reddit_client_secret):
            line("reddit", False, "skipped: REDDIT_CLIENT_ID/SECRET not set")
        else:
            try:
                posts = await reddit.fetch_posts(http, settings)
                sigs, keys, cats, kws = social.keyword_signals(
                    posts, max_kept=settings.trend_max_kept
                )
                line("reddit", bool(posts),
                     f"{len(posts)} posts, {len(sigs)} keyword terms | keys={keys} "
                     f"| cats={cats}"
                     + (f" | e.g. {sigs[0].term!r} ({sigs[0].mentions} posts, "
                        f"{sigs[0].score} upvotes)" if sigs else ""))
            except Exception as exc:  # noqa: BLE001
                line("reddit", False, f"ERROR: {exc!r}")

        # 6. YouTube discovery (needs a Data API v3 key)
        if not settings.youtube_api_key:
            line("youtube", False, "skipped: YOUTUBE_API_KEY not set")
        else:
            try:
                videos = await youtube.fetch_videos(http, settings)
                sigs, keys, cats, kws = social.keyword_signals(
                    videos, max_kept=settings.trend_max_kept
                )
                line("youtube", bool(videos),
                     f"{len(videos)} videos, {len(sigs)} keyword terms | keys={keys}"
                     + (f" | e.g. {videos[0].title!r} ({videos[0].score} views)"
                        if videos else ""))
            except Exception as exc:  # noqa: BLE001
                line("youtube", False, f"ERROR: {exc!r}")

        # 7. Google Trends (unofficial endpoint, off by default)
        if not settings.google_trends_enabled:
            line("google_trends", False, "skipped: GOOGLE_TRENDS_ENABLED=false")
        else:
            try:
                sigs, cats, kws = await google_trends.fetch(STORE, http, settings)
                line("google_trends", bool(sigs),
                     f"{len(sigs)} rising of {len(settings.google_trends_seed_terms)} "
                     f"seeds | cats={cats}"
                     + (f" | e.g. {sigs[0].term!r} ({sigs[0].interest}/100)"
                        if sigs else ""))
            except Exception as exc:  # noqa: BLE001
                line("google_trends", False, f"ERROR: {exc!r}")

        # 8. Holidays (local, no network)
        sigs, keys = await holidays.fetch(STORE, settings)
        line("holidays", bool(sigs),
             f"{len(sigs)} upcoming in {settings.holiday_lookahead_days}d | keys={keys}"
             + (f" | next: {sigs[0].name} in {sigs[0].days_away}d" if sigs else ""))

        # 9. The combined bundle, exactly as a real run builds it.
        bundle = await gather_signals(STORE, http, settings)
        print(f"\nACTIVE KEYS (combined): {bundle.active_keys}")
        if bundle.social:
            print(f"TRENDS: {[(t.term, t.source) for t in bundle.social]}")


if __name__ == "__main__":
    asyncio.run(main())
