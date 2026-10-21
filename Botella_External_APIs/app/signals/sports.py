"""ESPN sports schedule client (unofficial scoreboard API — free, no key).

Queries the configured leagues concurrently for games in the next N days.

A game is "locally relevant" when the home team's metro is within
``sports_local_radius_miles`` of the store (great-circle distance against a
static team -> metro-coordinates table). When the store has no coordinates or
the team isn't in the table, it falls back to the venue-state heuristic — so an
unknown expansion/relocated team degrades gracefully rather than disappearing.
Local home games emit a ``<league>_home_game`` active key.
"""

from __future__ import annotations

import asyncio
import math
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import GameSignal
from app.schemas.store import StoreProfile
from app.signals.us_states import to_code

log = get_logger(__name__)

# league -> (sport path, league path) on the ESPN scoreboard hosts
_LEAGUE_PATHS: dict[str, tuple[str, str]] = {
    "nfl": ("football", "nfl"),
    "nba": ("basketball", "nba"),
    "mlb": ("baseball", "mlb"),
    "nhl": ("hockey", "nhl"),
}

_EARTH_RADIUS_MI = 3958.8

# ESPN displayName -> approximate home-metro coordinates (lat, lng). City
# centers are plenty accurate for a ~75 mile radius test. Teams missing from
# this table (renames, expansion) fall back to the venue-state heuristic.
_TEAM_METROS: dict[str, tuple[float, float]] = {
    # --- NFL ---
    "Arizona Cardinals": (33.45, -112.07), "Atlanta Falcons": (33.75, -84.39),
    "Baltimore Ravens": (39.29, -76.61), "Buffalo Bills": (42.89, -78.88),
    "Carolina Panthers": (35.23, -80.84), "Chicago Bears": (41.88, -87.63),
    "Cincinnati Bengals": (39.10, -84.51), "Cleveland Browns": (41.50, -81.69),
    "Dallas Cowboys": (32.75, -97.08), "Denver Broncos": (39.74, -104.99),
    "Detroit Lions": (42.33, -83.05), "Green Bay Packers": (44.51, -88.02),
    "Houston Texans": (29.76, -95.37), "Indianapolis Colts": (39.77, -86.16),
    "Jacksonville Jaguars": (30.33, -81.66), "Kansas City Chiefs": (39.10, -94.58),
    "Las Vegas Raiders": (36.17, -115.14), "Los Angeles Chargers": (33.95, -118.34),
    "Los Angeles Rams": (33.95, -118.34), "Miami Dolphins": (25.96, -80.24),
    "Minnesota Vikings": (44.97, -93.27), "New England Patriots": (42.09, -71.26),
    "New Orleans Saints": (29.95, -90.07), "New York Giants": (40.81, -74.07),
    "New York Jets": (40.81, -74.07), "Philadelphia Eagles": (39.90, -75.17),
    "Pittsburgh Steelers": (40.44, -80.00), "San Francisco 49ers": (37.40, -121.97),
    "Seattle Seahawks": (47.60, -122.33), "Tampa Bay Buccaneers": (27.98, -82.50),
    "Tennessee Titans": (36.17, -86.78), "Washington Commanders": (38.91, -76.86),
    # --- NBA ---
    "Atlanta Hawks": (33.75, -84.39), "Boston Celtics": (42.37, -71.06),
    "Brooklyn Nets": (40.68, -73.97), "Charlotte Hornets": (35.23, -80.84),
    "Chicago Bulls": (41.88, -87.63), "Cleveland Cavaliers": (41.50, -81.69),
    "Dallas Mavericks": (32.79, -96.81), "Denver Nuggets": (39.74, -104.99),
    "Detroit Pistons": (42.33, -83.05), "Golden State Warriors": (37.77, -122.39),
    "Houston Rockets": (29.76, -95.37), "Indiana Pacers": (39.77, -86.16),
    "LA Clippers": (33.95, -118.34), "Los Angeles Clippers": (33.95, -118.34),
    "Los Angeles Lakers": (34.04, -118.27), "Memphis Grizzlies": (35.14, -90.05),
    "Miami Heat": (25.78, -80.19), "Milwaukee Bucks": (43.04, -87.91),
    "Minnesota Timberwolves": (44.97, -93.27), "New Orleans Pelicans": (29.95, -90.07),
    "New York Knicks": (40.75, -73.99), "Oklahoma City Thunder": (35.47, -97.52),
    "Orlando Magic": (28.54, -81.38), "Philadelphia 76ers": (39.90, -75.17),
    "Phoenix Suns": (33.45, -112.07), "Portland Trail Blazers": (45.52, -122.68),
    "Sacramento Kings": (38.58, -121.49), "San Antonio Spurs": (29.43, -98.49),
    "Toronto Raptors": (43.65, -79.38), "Utah Jazz": (40.76, -111.89),
    "Washington Wizards": (38.90, -77.02),
    # --- MLB ---
    "Arizona Diamondbacks": (33.45, -112.07), "Atlanta Braves": (33.75, -84.39),
    "Baltimore Orioles": (39.29, -76.61), "Boston Red Sox": (42.35, -71.10),
    "Chicago Cubs": (41.95, -87.66), "Chicago White Sox": (41.83, -87.63),
    "Cincinnati Reds": (39.10, -84.51), "Cleveland Guardians": (41.50, -81.69),
    "Colorado Rockies": (39.74, -104.99), "Detroit Tigers": (42.33, -83.05),
    "Houston Astros": (29.76, -95.37), "Kansas City Royals": (39.10, -94.58),
    "Los Angeles Angels": (33.84, -117.92), "Los Angeles Dodgers": (34.07, -118.24),
    "Miami Marlins": (25.78, -80.22), "Milwaukee Brewers": (43.04, -87.91),
    "Minnesota Twins": (44.98, -93.28), "New York Mets": (40.76, -73.85),
    "New York Yankees": (40.83, -73.93), "Athletics": (38.58, -121.49),
    "Oakland Athletics": (37.75, -122.20), "Philadelphia Phillies": (39.91, -75.17),
    "Pittsburgh Pirates": (40.45, -80.01), "San Diego Padres": (32.72, -117.16),
    "San Francisco Giants": (37.78, -122.39), "Seattle Mariners": (47.59, -122.33),
    "St. Louis Cardinals": (38.63, -90.20), "Tampa Bay Rays": (27.77, -82.65),
    "Texas Rangers": (32.75, -97.08), "Toronto Blue Jays": (43.64, -79.39),
    "Washington Nationals": (38.87, -77.01),
    # --- NHL ---
    "Anaheim Ducks": (33.81, -117.88), "Boston Bruins": (42.37, -71.06),
    "Buffalo Sabres": (42.89, -78.88), "Calgary Flames": (51.04, -114.07),
    "Carolina Hurricanes": (35.78, -78.64), "Chicago Blackhawks": (41.88, -87.63),
    "Colorado Avalanche": (39.74, -104.99), "Columbus Blue Jackets": (39.96, -83.00),
    "Dallas Stars": (32.79, -96.81), "Detroit Red Wings": (42.33, -83.05),
    "Edmonton Oilers": (53.55, -113.49), "Florida Panthers": (26.16, -80.33),
    "Los Angeles Kings": (34.04, -118.27), "Minnesota Wild": (44.94, -93.10),
    "Montreal Canadiens": (45.50, -73.57), "Nashville Predators": (36.16, -86.78),
    "New Jersey Devils": (40.73, -74.17), "New York Islanders": (40.71, -73.73),
    "New York Rangers": (40.75, -73.99), "Ottawa Senators": (45.42, -75.69),
    "Philadelphia Flyers": (39.90, -75.17), "Pittsburgh Penguins": (40.44, -80.00),
    "San Jose Sharks": (37.33, -121.90), "Seattle Kraken": (47.60, -122.33),
    "St. Louis Blues": (38.63, -90.20), "Tampa Bay Lightning": (27.94, -82.45),
    "Toronto Maple Leafs": (43.64, -79.38), "Utah Hockey Club": (40.76, -111.89),
    "Utah Mammoth": (40.76, -111.89), "Vancouver Canucks": (49.28, -123.12),
    "Vegas Golden Knights": (36.10, -115.18), "Washington Capitals": (38.90, -77.02),
    "Winnipeg Jets": (49.89, -97.14),
}


def _haversine_mi(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * _EARTH_RADIUS_MI * math.asin(math.sqrt(a))


def metro_distance_mi(home_team: str, store: StoreProfile) -> float | None:
    """Straight-line miles from the store to the team's metro, or None when
    either side lacks coordinates. Straight-line, so a 45-mile DRIVE can read
    ~35 here — which is why the distance is DISCLOSED on the signal instead
    of silently gating prose that then claims the game is 'nearby'."""
    metro = _TEAM_METROS.get(home_team)
    if metro and store.has_geo:
        assert store.latitude is not None and store.longitude is not None
        return _haversine_mi(store.latitude, store.longitude, *metro)
    return None


def is_local_game(
    home_team: str, venue_state: str, store: StoreProfile, radius_mi: float
) -> bool:
    """Whether a home game is locally relevant to the store.

    Geo-proximity against the team's metro when both sides have coordinates
    (a Buffalo store no longer flags Knicks games just because both are "NY");
    otherwise the original venue-state heuristic. The radius is deliberately
    WIDE (sports_local_radius_miles = 40): the sales driver is metro-wide
    watch parties, not stadium foot traffic — stadium proximity is a separate,
    tight flag (``stadium_nearby``, ~10 mi).
    """
    dist = metro_distance_mi(home_team, store)
    if dist is not None:
        return dist <= radius_mi
    # Both sides normalized to the two-letter code: ESPN venue addresses carry
    # the full name ("Georgia") while store profiles carry "GA", so comparing
    # them raw made this fallback dead code.
    store_state = to_code(store.state)
    return bool(store_state) and to_code(venue_state) == store_state


# Longitude -> IANA zone for continental US/Canada venues. Coarse on purpose:
# we only need the venue's CALENDAR DATE, and games start mid-afternoon to
# late evening local, far from the midnight boundary where an hour of error
# (e.g. Arizona not observing DST) could flip the date.
_TZ_BANDS: tuple[tuple[float, str], ...] = (
    (-87.5, "America/New_York"),
    (-102.0, "America/Chicago"),
    (-115.0, "America/Denver"),
)
# Most US pro venues are Eastern/Central, and evening games converted from a
# western venue into Eastern still land on the right date, so this is a safe
# default for a team missing from the metro table.
_DEFAULT_TZ = ZoneInfo("America/New_York")


def _venue_tz(home_team: str) -> ZoneInfo:
    metro = _TEAM_METROS.get(home_team)
    if metro is None:
        return _DEFAULT_TZ
    _, lng = metro
    for western_edge, zone in _TZ_BANDS:
        if lng >= western_edge:
            return ZoneInfo(zone)
    return ZoneInfo("America/Los_Angeles")


def local_date(espn_timestamp: str, home_team: str) -> str:
    """ESPN's UTC timestamp -> the venue's local calendar date (YYYY-MM-DD).

    The frontend parses a bare ``YYYY-MM-DD`` as a local date (no timezone
    shift), so the owner sees the day the game is actually played wherever
    they happen to be viewing from.
    """
    try:
        moment = datetime.fromisoformat(espn_timestamp.replace("Z", "+00:00"))
    except ValueError:
        return espn_timestamp
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(_venue_tz(home_team)).date().isoformat()


def _collapse_series(games: list[GameSignal]) -> list[GameSignal]:
    """Collapse every game of the same matchup into ONE signal.

    Teams play multi-game home series, doubleheaders, and sometimes a second
    set against the same opponent later in the window. Each of those would
    otherwise repeat a near-identical line in the strip, the prompt, and the
    snapshot, so the owner reads the same fixture several times instead of
    several distinct signals. The earliest game keeps its date, ``end_date``
    is the last one, and ``games`` counts them all: one "Padres @ Braves,
    Jul 20-25, 4 games" signal rather than four bubbles. Different opponents
    stay separate, since those are genuinely different signals.
    """
    runs: dict[tuple[str, str, str], GameSignal] = {}
    ordered: list[GameSignal] = []
    for game in sorted(games, key=lambda g: g.date):
        key = (game.league, game.home, game.away)
        current = runs.get(key)
        if current is None:
            runs[key] = game
            ordered.append(game)
            continue
        merged = current.model_copy(
            update={"games": current.games + 1, "end_date": game.date}
        )
        runs[key] = merged
        ordered[ordered.index(current)] = merged
    return ordered


# ESPN serves the identical scoreboard route (same JSON shape) from more than
# one hostname, and the primary's edge 403-blocks some networks while the
# mirror answers fine (observed: site.api.espn.com 403 for every UA from a
# dev host while site.web.api.espn.com returned the schedule). Try in order.
_SCOREBOARD_HOSTS = ("https://site.api.espn.com", "https://site.web.api.espn.com")


def _scoreboard_urls(league: str) -> list[str]:
    paths = _LEAGUE_PATHS.get(league)
    if not paths:
        return []
    sport, lg = paths
    return [
        f"{host}/apis/site/v2/sports/{sport}/{lg}/scoreboard"
        for host in _SCOREBOARD_HOSTS
    ]


async def _fetch_day(
    league: str,
    urls: list[str],
    day: str,
    http: httpx.AsyncClient,
) -> tuple[list | None, str]:
    """One league-day off whichever scoreboard host answers first."""
    last_error = ""
    for index, url in enumerate(urls):
        try:
            resp = await http.get(url, params={"dates": day, "limit": 100})
            resp.raise_for_status()
            if index:
                log.info("sports_fallback_host_used", league=league, url=url)
            return resp.json().get("events", []), ""
        except (httpx.HTTPError, ValueError) as exc:
            last_error = str(exc)
    return None, last_error


async def _fetch_league(
    league: str,
    http: httpx.AsyncClient,
    now: datetime,
    settings: Settings,
) -> list[GameSignal]:
    urls = _scoreboard_urls(league)
    if not urls:
        return []
    # ESPN used to accept dates=START-END on this route and now 400s the range
    # on BOTH hosts, which silently zeroed every league. Single dates still
    # work, so the window is walked a day at a time, concurrently. Days are
    # independent: a bad day costs that day, not the whole league.
    days = [
        (now + timedelta(days=offset)).strftime("%Y%m%d")
        for offset in range(settings.signal_lookahead_days + 1)
    ]
    results = await asyncio.gather(
        *(_fetch_day(league, urls, day, http) for day in days)
    )

    events: list = []
    seen_ids: set[str] = set()
    failures = [err for day_events, err in results if day_events is None]
    for day_events, _ in results:
        if not day_events:
            continue
        for event in day_events:
            # A single-date query can still return neighbouring fixtures (ESPN
            # answers an NFL date with its whole week), so the same game shows
            # up under several days.
            event_id = str(event.get("id") or "")
            if event_id and event_id in seen_ids:
                continue
            if event_id:
                seen_ids.add(event_id)
            events.append(event)

    if len(failures) == len(days):
        log.warning("sports_fetch_failed", league=league, error=failures[0])
        return []
    if failures:
        log.info("sports_partial_window", league=league,
                 failed_days=len(failures), total_days=len(days))

    games: list[GameSignal] = []
    for event in events:
        competitions = event.get("competitions") or []
        if not competitions:
            continue
        comp = competitions[0]
        competitors = comp.get("competitors") or []
        home = next((c for c in competitors if c.get("homeAway") == "home"), None)
        away = next((c for c in competitors if c.get("homeAway") == "away"), None)
        if not home or not away:
            continue
        venue = comp.get("venue") or {}
        home_name = (home.get("team") or {}).get("displayName", "Home")
        games.append(
            GameSignal(
                league=league,
                home=home_name,
                away=(away.get("team") or {}).get("displayName", "Away"),
                date=local_date(event.get("date", ""), home_name),
                venue=venue.get("fullName"),
                venue_state=((venue.get("address") or {}).get("state") or "").upper() or None,
            )
        )
    return games


async def fetch_national(
    http: httpx.AsyncClient, settings: Settings
) -> list[GameSignal]:
    """Fetch the national schedule for every configured league, concurrently.

    The result is store-independent (locality is not set), so the signal cache
    can hold ONE entry for the whole network instead of one per state.
    """
    now = datetime.now(UTC)
    per_league = await asyncio.gather(
        *(_fetch_league(league, http, now, settings) for league in settings.sports_leagues)
    )
    return [g for games in per_league for g in games]


def localize(
    games: list[GameSignal], store: StoreProfile, settings: Settings
) -> tuple[list[GameSignal], list[str]]:
    """Pure per-store step: keep only locally relevant home games and derive keys.

    Both the snapshot the owner sees and the prompt the model reads stay scoped to
    games near THIS store, so an Austin store never surfaces New York or Detroit
    games. Locality is geo-proximity to the team's metro when the store has
    coordinates, otherwise the venue-state heuristic (see ``is_local_game``).
    """
    localized = []
    for g in games:
        dist = metro_distance_mi(g.home, store)
        localized.append(
            g.model_copy(
                update={
                    "is_local_home": is_local_game(
                        g.home, g.venue_state or "", store,
                        settings.sports_local_radius_miles,
                    ),
                    "distance_mi": round(dist, 1) if dist is not None else None,
                    # Tight, separate flag: only THIS close is the stadium
                    # itself a foot-traffic driver (cold box, single serves).
                    "stadium_nearby": (
                        dist is not None
                        and dist <= settings.sports_stadium_radius_miles
                    ),
                }
            )
        )
    active_keys = sorted(
        {f"{g.league}_home_game" for g in localized if g.is_local_home}
    )
    # Surface ONLY local home games (soonest first). Non-local games are dropped
    # entirely rather than padded in, so nothing irrelevant reaches the store.
    # A multi-game series collapses to one signal so a homestand can't fill the
    # strip with the same matchup repeated.
    local_games = _collapse_series([g for g in localized if g.is_local_home])
    return local_games[:8], active_keys
