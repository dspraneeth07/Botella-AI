"""Normalized external-signal shapes and the aggregated signal bundle."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

# The one enforced definition of a news item's demand/price direction. The
# analysts (news_analyst / email_analyst) import this instead of keeping their
# own copies, and pydantic rejects anything else at the model boundary.
NewsImpact = Literal["demand_up", "demand_down", "price_increase_risk", "supply_risk"]

# Impacts that mean "buy the affected products ahead" — a supply pause or a
# coming price rise. The validator uses this to keep such stories from being
# tagged with demand-side actions (promote/endcap/cold_box) on the affected
# products.
BUY_AHEAD_IMPACTS = ("price_increase_risk", "supply_risk")

# The weather signal is ONE snapshot entry but up to three citable keys (see
# app.signals.weather); which of them fired is not recorded on the signal
# itself, so any cited weather key must retain the weather entry.
_WEATHER_KEYS = frozenset({"heat_advisory", "cold_snap", "severe_weather"})


class WeatherSignal(BaseModel):
    summary: str
    # IANA timezone of the store's NWS gridpoint ("America/Chicago"), straight
    # from the /points lookup the fetch already performs. It costs nothing
    # extra and it is the only authoritative answer we get to "what day is it
    # where this store is" - the daily capture tables key every row on the
    # store's own calendar date, not the server's (see analytics migration
    # 014). None outside the US, or when the lookup failed.
    timezone: str | None = None
    # Local calendar date (YYYY-MM-DD) of the period ``summary`` describes —
    # the first forecast period, i.e. today/tonight.
    summary_date: str | None = None
    # Live observed conditions from the nearest reporting NWS station — what
    # weather.gov shows as "current" for the location. This is the pair the
    # owner-facing chip renders; anything forecast-derived below is about a
    # later part of the day and must not be presented as "right now".
    # ``current_f`` is already Fahrenheit: the observation API reports Celsius
    # (``wmoUnit:degC``), unlike the forecast API which reports F directly.
    current_f: float | None = None
    current_summary: str | None = None
    # ISO-8601 UTC timestamp of the observation, so a stale reading is visible
    # rather than silently presented as current.
    observed_at: str | None = None
    # TODAY's forecast high/low — the rest of the store's own day, not a
    # week-wide peak. The *_date fields still say which local date each lands
    # on so nothing renders undated.
    high_f: float | None = None
    high_date: str | None = None
    low_f: float | None = None
    low_date: str | None = None
    # First/last local dates the forecast periods cover.
    window_start: str | None = None
    window_end: str | None = None
    alerts: list[str] = []


class GameSignal(BaseModel):
    league: str
    home: str
    away: str
    # Venue-LOCAL calendar date (YYYY-MM-DD), not ESPN's UTC timestamp: a
    # 7pm Atlanta game is 23:15Z, which renders as the next day for anyone
    # viewing from a timezone ahead of the venue (and made a 4-game series
    # look like it had two games on the same date).
    date: str
    # Every game of the same matchup in the window collapsed into one signal
    # (a 4-game home series is one signal with games=4, not four entries).
    # ``date`` is the opener and ``end_date`` the finale, so it shows as one
    # "Jul 20-23" range instead of several near-identical rows.
    games: int = 1
    end_date: str | None = None
    is_local_home: bool = False
    # Straight-line miles from the store to the team's metro (None without
    # coordinates on either side). Disclosed so neither the model nor the
    # owner reads a metro-wide watch-party signal as "the stadium is nearby".
    distance_mi: float | None = None
    # True only within sports_stadium_radius_miles: the stadium itself is
    # close enough for game-day foot traffic (cold box, single serves).
    stadium_nearby: bool = False
    venue: str | None = None
    # Venue state from ESPN — kept so per-store locality can fall back to the
    # state heuristic when the team has no metro-coordinates entry.
    venue_state: str | None = None


class EventSignal(BaseModel):
    name: str
    venue: str | None = None
    date: str | None = None
    distance_mi: float | None = None
    category: str | None = None
    # Consecutive performance dates collapsed into one signal (a 3-night arena
    # run is one event with nights=3, not three list entries).
    nights: int = 1
    # Filled by the LLM event analyst for events it keeps as relevant:
    # crowd-size judgment, a citable snake_case key, and a one-line note.
    draw: str | None = None  # major | moderate | minor
    key: str | None = None
    note: str | None = None


class HolidaySignal(BaseModel):
    name: str
    date: str
    days_away: int
    key: str


class TrendSignal(BaseModel):
    """One drink/brand/cocktail term trending on social media or in search.

    Term-level, not post-level: the Reddit fetcher and trend analyst collapse
    supporting posts into one entry per term, the same way a 4-game series is
    one GameSignal. ``source`` records which channel(s) observed it —
    "reddit", "google_trends", or "reddit+google_trends" after a merge.
    """

    term: str
    source: str
    # Reddit evidence: supporting posts this week and their summed upvotes.
    mentions: int = 1
    score: int | None = None
    # Google Trends evidence: momentum verdict and the latest 0-100 interest.
    momentum: str | None = None  # rising | stable | declining
    interest: int | None = None
    # Strongest supporting post title, or a search-interest one-liner.
    evidence: str | None = None
    # Citable snake_case key (trend_<term>) and the analyst's one-line so-what.
    key: str | None = None
    note: str | None = None


class NewsSignal(BaseModel):
    headline: str
    category: str
    source: str | None = None
    url: str | None = None
    # Article description from the source — analyst input, not shown in the prompt.
    description: str | None = None
    # Filled by the LLM news analyst when the article affects demand:
    # impact direction, a citable snake_case key, and a one-line note.
    # ``impact`` stays None when the analyst omitted or garbled it — an
    # unknown direction is soft context, never silently coerced to demand_up.
    impact: NewsImpact | None = None
    key: str | None = None
    note: str | None = None
    # Per-item affected categories (canonical tokens) and product-name
    # keywords from the analyst. The bundle still pools them for eligibility;
    # keeping them per item preserves the direction -> product link so the
    # validator can enforce "supply_risk means buy ahead, not promote" on the
    # specific products the story is about.
    categories: list[str] = []
    product_keywords: list[str] = []


class SignalBundle(BaseModel):
    """Everything the context builder learned about the world for one store.

    ``active_keys`` is the bridge between raw signals and candidate selection
    (see ``app.signals.mapping``). Each signal client contributes the keys it
    can confidently assert.
    """

    weather: WeatherSignal | None = None
    sports: list[GameSignal] = []
    events: list[EventSignal] = []
    holidays: list[HolidaySignal] = []
    news: list[NewsSignal] = []
    social: list[TrendSignal] = []
    active_keys: list[str] = []
    # From the LLM news analyst: canonical category tokens whose demand the
    # news affects (widen candidate eligibility like mapped signal keys do),
    # and product-name keywords that identify specifically affected SKUs.
    news_categories: list[str] = []
    news_product_keywords: list[str] = []
    # From the LLM event analyst: canonical category tokens the kept events'
    # crowds actually buy (widen eligibility the same way).
    event_categories: list[str] = []
    # From the social-trend channel (Reddit keyword floor / trend analyst /
    # Google Trends): categories the trending drinks belong to, and product-
    # name keywords that identify the trending items on this store's shelf.
    trend_categories: list[str] = []
    trend_product_keywords: list[str] = []

    def is_empty(self) -> bool:
        return not any(
            [self.weather, self.sports, self.events, self.holidays, self.news, self.social]
        )

    def snapshot(
        self, *, display_cap: int | None = None, cited_keys: set[str] | None = None
    ) -> dict:
        """JSON-serializable snapshot stored alongside the run by the Node side.

        ``display_cap`` bounds the TOTAL number of signal entries (weather +
        sports + events + holidays + news) kept in the snapshot, because this
        dict is what the owner-facing UI renders as chips and thirty chips is
        noise, not signal. Trimming is by priority (see ``_display_order``),
        preserving each type's original order. The LLM prompt is unaffected:
        it renders from the full bundle, and ``active_keys`` / categories /
        keywords stay complete here so the run record still shows everything
        that shaped eligibility.

        ``cited_keys`` (the union of every returned recommendation's
        ``signals_cited``) marks entries that must SURVIVE the trim: a cited
        signal whose snapshot entry was trimmed can only render as a bare,
        orphaned key downstream. Cited entries are always retained, even when
        that exceeds the cap; the cap then trims uncited entries only.
        """
        data = self.model_dump(mode="json")
        if display_cap is None:
            return data
        order = self._display_order()
        cited = cited_keys or set()
        keep: list[tuple[str, int]] = [
            (f, i) for f, i in order if self._entry_keys(f, i) & cited
        ]
        kept = set(keep)
        for entry in order:
            if len(keep) >= max(0, display_cap):
                break
            if entry not in kept:
                keep.append(entry)
        for field in ("sports", "events", "holidays", "news", "social"):
            wanted = sorted(i for f, i in keep if f == field)
            data[field] = [data[field][i] for i in wanted]
        if not any(f == "weather" for f, _ in keep):
            data["weather"] = None
        return data

    def _entry_keys(self, field: str, i: int) -> set[str]:
        """The citable signal keys that resolve to one snapshot entry.

        Mirrors how each signal client names its keys: weather asserts
        heat_advisory / cold_snap / severe_weather, a local home game cites
        ``<league>_home_game``, an event is citable via its analyst ``key``
        AND its segment-derived keys (event_nearby / event_festival /
        event_concert / ...), and holidays / news carry their own ``key``
        (None for unanalyzed items, which are never citable).
        """
        if field == "weather":
            return set(_WEATHER_KEYS)
        if field == "sports":
            return {f"{self.sports[i].league}_home_game"}
        if field == "events":
            # Deferred import: app.signals.events imports EventSignal from
            # this module, so a top-level import would be circular.
            from app.signals.events import keys_for_event

            e = self.events[i]
            return keys_for_event(e) | ({e.key} if e.key else set())
        key: str | None
        if field == "holidays":
            key = self.holidays[i].key
        elif field == "social":
            key = self.social[i].key
        else:  # news
            key = self.news[i].key
        return {key} if key else set()

    def citable_keys_by_domain(self) -> dict[str, str]:
        """Every citable key in this bundle -> the field it belongs to.

        ``{"heat_advisory": "weather", "nhl_home_game": "sports",
        "event_concert": "events", "halloween": "holidays",
        "news_tariff_bourbon": "news", "trend_espresso_martini": "social"}``.

        The hybrid slate (app/recommender/hybrid.py) holds a model card to its
        own evidence with this: a weather card must cite a weather key, a
        game-day card a sports, events or holidays key, and a key from another
        domain is removed from the card rather than shown as a chip the owner
        would read as the reason. Built from the same `_entry_keys` the
        snapshot trim uses, so the two cannot disagree about what a key is.
        """
        out: dict[str, str] = {}
        if self.weather is not None:
            for k in self._entry_keys("weather", 0):
                out[k] = "weather"
        for field in ("sports", "events", "holidays", "news", "social"):
            for i in range(len(getattr(self, field) or [])):
                for k in self._entry_keys(field, i):
                    out.setdefault(k, field)
        return out

    def _display_order(self) -> list[tuple[str, int]]:
        """(field, index) pairs, most owner-relevant first.

        Priority: weather, upcoming holidays, major events, local games,
        impact-bearing news (email digest items lead, then buy-ahead
        supply/price stories), social trends, demand-direction state news,
        moderate then minor events, unanalyzed soft-context news last.
        Supply/price news outranks trends because it is a time-critical
        purchasing decision: the buying window closes when supply pauses or
        wholesale prices move, while a trend fades gradually.
        """
        draw_rank = {"major": 0, "moderate": 1, "minor": 2}
        ranked: list[tuple[tuple, str, int]] = []
        if self.weather is not None:
            ranked.append(((0,), "weather", 0))
        for i, h in enumerate(self.holidays):
            ranked.append(((1, h.days_away), "holidays", i))
        for i, e in enumerate(self.events):
            tier = draw_rank.get(e.draw or "", 1)
            prio = 2 if tier == 0 else (6 if tier == 1 else 7)
            ranked.append(((prio, e.date or "9999", i), "events", i))
        for i, g in enumerate(self.sports):
            ranked.append(((3, g.date, i), "sports", i))
        for i in range(len(self.social)):
            ranked.append(((5, 0, i), "social", i))
        for i, n in enumerate(self.news):
            if n.impact is None:
                ranked.append(((8, 0, i), "news", i))
            elif n.category == "industry_email":
                ranked.append(((4, 0, i), "news", i))
            elif n.impact in BUY_AHEAD_IMPACTS:
                ranked.append(((4, 1, i), "news", i))
            else:
                ranked.append(((5, 1, i), "news", i))
        ranked.sort(key=lambda r: r[0])
        return [(field, i) for _, field, i in ranked]
