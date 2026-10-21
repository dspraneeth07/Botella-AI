"""Application configuration, loaded from environment / ``.env``.

Every tunable lives here so the service has a single, typed source of truth.
Only ``node_api_base_url`` and ``anthropic_api_key`` are required; everything
else has a sensible default.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# The repo root (this file lives in app/), so .env is found by its real
# location rather than by whatever directory the process happens to start in.
# A bare relative ".env" made the service depend on being launched from the
# project folder: `uvicorn app.main:app` from one level up loaded NO settings
# at all and died on "node_api_base_url Field required", which reads like a
# missing .env rather than the wrong cwd.
_PROJECT_ROOT = Path(__file__).resolve().parents[1]

# The refusal, as one sentence that names the variable and says where the
# matching values live. Raised from the settings validator, so `Settings()` -
# and with it `get_settings()` in app.main - fails before a socket is bound.
SERVICE_API_KEY_REQUIRED_MESSAGE = (
    "SERVICE_API_KEY is not set and ENVIRONMENT=production - refusing to start "
    "with the work endpoints and /storeagent open. Every run costs real LLM "
    "money and /storeagent serves any store's figures to whoever reaches the "
    "port. Generate one with `openssl rand -hex 32`, set it as SERVICE_API_KEY "
    "in Botella_External_APIs/.env and the SAME value as REC_SERVICE_API_KEY "
    "and STOREAGENT_API_KEY in backend/.env (the Node side sends the header)."
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ----- Service ---------------------------------------------------------
    app_name: str = "contextual-intelligence-service"
    # "development" or "production" (ENVIRONMENT in .env). It is printed in the
    # startup log line and on /healthz, and exactly one thing BRANCHES on it:
    # the fail-closed check in `_service_api_key_required_in_production`
    # below. Matched after strip()/lower(), so "Production" is production -
    # the forgiving direction is the closed one.
    environment: str = "development"
    log_level: str = "INFO"
    log_json: bool = False
    # Browsers never call this machine-to-machine service, so CORS is off by
    # default. Set a JSON list (e.g. '["http://localhost:5173"]') to enable.
    cors_allow_origins: list[str] = Field(default_factory=list)
    # When set, every work endpoint requires this value in the X-API-Key
    # header - the recommendation runs, the batch endpoints and the whole
    # /storeagent surface. Unset = open: anyone who can reach the port can
    # trigger runs that cost real LLM money and read any store's figures.
    #
    # REQUIRED IN PRODUCTION. The sentence above used to end "set it in
    # production", and nothing enforced it: `require_api_key` returned early
    # on an empty key and the service started without a word. The 19 October
    # QA audit listed that as defect 4, next to the Node side it mirrors -
    # backend/middleware/auth.js refuses to start without NODE_API_TOKEN when
    # NODE_ENV=production, since checklist 6. The validator below is the same
    # rule for the same reason: fail closed, at startup, naming the variable.
    # Outside production an unset key keeps the open development behaviour and
    # the lifespan logs one warning (app/dependencies.py).
    service_api_key: str | None = None

    @property
    def is_production(self) -> bool:
        return self.environment.strip().lower() == "production"

    @model_validator(mode="after")
    def _service_api_key_required_in_production(self) -> Settings:
        if self.is_production and not self.service_api_key:
            raise ValueError(SERVICE_API_KEY_REQUIRED_MESSAGE)
        return self

    # ----- Node backend (the source of all DB-backed data) -----------------
    node_api_base_url: str = Field(
        ...,
        description="Base URL of the Node service that exposes the data endpoints "
        "(see API_CONTRACT.md). Example: https://api.internal.example.com",
    )
    node_api_token: str | None = Field(
        default=None,
        description="Optional bearer token sent as 'Authorization: Bearer <token>' "
        "to the Node API.",
    )
    node_api_timeout_seconds: float = 15.0
    node_api_max_retries: int = 3
    # 365, not 90. Sheet 20 compares a 28-day window against the SKU's own
    # LONG RUN, and with a quarter of history the "long run" is a quarter - a
    # materially weaker signal (the audit measured a 41.4 point decile spread
    # for rev_28_90 against 47.2 for rev_28_365). Node already serves it:
    # SALES_DAYS_MAX is 365 and /sales returns one row per (sku, date).
    node_sales_window_days: int = 365

    # Does the engine choose, or does the model?
    #
    # True: `app/pipeline` selects deterministically and the model only writes
    # prose. False: the superseded LLM-chooses path, kept for comparison on a
    # single store rather than as a fallback - it is the arm that scored 24.2%.
    use_deterministic_engine: bool = True
    # The trend-validation read fans out to ~25 peer stores on Node's remote
    # warehouse (measured seconds, not milliseconds) — it gets its own, more
    # patient per-request timeout instead of the default data-read one.
    trend_validation_timeout_seconds: float = 45.0

    # ----- Anthropic / LLM -------------------------------------------------
    anthropic_api_key: str = Field(..., description="Anthropic API key.")
    # The design's cost model is built around Sonnet at 1,200-store scale; keep
    # it as the default but allow overriding to any current Claude model.
    llm_model: str = "claude-sonnet-4-6"
    # Output budget. Must cover the whole tool-call JSON for up to
    # ``max_recommendations + trending_max_recommendations`` items *plus* any
    # effort/thinking tokens — those share this budget, so too low a value
    # truncates the tool call and yields "no recommendations array". 10K
    # leaves comfortable headroom at 10 daily + 4 trending recs.
    llm_max_tokens: int = 10240
    # Effort controls thinking depth / token spend (GA on Sonnet 4.6). Set to
    # None to omit (the API then defaults to "high", which costs more).
    llm_effort: str | None = "medium"
    # Per-attempt read timeout. The call is streamed, so this is the max idle
    # gap between tokens (plus connection setup), not the total generation time.
    llm_timeout_seconds: float = 120.0
    llm_max_retries: int = 2
    prompt_cache_enabled: bool = True
    # NOT SENT, AND THAT IS NOT AN OVERSIGHT.
    #
    # Sheet 15 asked for temperature 0 here because the chat path sends it. The
    # two are two SDK generations apart: Node is on @anthropic-ai/sdk 0.39.0,
    # where temperature is a normal Messages parameter; this service is on
    # anthropic 1.3.x, which REMOVED it from both stream() and create().
    # Passing it raises TypeError on every call.
    #
    # Kept as a declared setting so the decision is findable rather than
    # missing, and so a future SDK bump that restores temperature has an
    # obvious place to wire it back in - `tests/test_llm_client.py` fails the
    # day that happens.
    llm_temperature: float = 0.0
    # The resolved, dated model snapshot to pin to. None sends the alias in
    # ``llm_model`` and records whatever the API resolved it to - which is
    # honest but not reproducible, because an alias moves. Set this to the
    # dated id from a response's ``model`` field to freeze it.
    llm_model_pinned: str | None = None

    # ----- Bulk / batch runs ----------------------------------------------
    # The bulk endpoint (POST /run-recommendations) fans many stores out in one
    # call so the service owns concurrency instead of relying on xargs.
    bulk_max_concurrency: int = 8
    bulk_max_pairs: int = 500
    # "batch" mode routes the LLM calls through Anthropic's Message Batches API
    # for ~50% token cost on cron-driven runs that tolerate minutes of latency.
    # The request submits the batch, then polls until it ends or the cap is hit.
    batch_poll_interval_seconds: float = 10.0
    batch_max_wait_seconds: float = 1800.0

    # ----- Recommendation tuning ------------------------------------------
    candidate_pool_size: int = 150
    target_min_recommendations: int = 8
    max_recommendations: int = 10
    # One-number rule: pull per-SKU weekly rates and reorder quantities from
    # the storeagent demand engine (direct warehouse read, shared module) so
    # recommendations quote the exact figures the Buying tab prints. Degrades
    # softly to the legacy Node-feed math when the warehouse is unreachable.
    canonical_demand_enabled: bool = True
    # Store-intelligence grounding (the canonical-demand pattern extended to
    # the other engines): the Buying tab's don't-buy list suppresses
    # reorder/pre_stock picks, its lost-sales items get their own candidate
    # slice, the Inventory tab's velocity classes ground markdown/liquidate,
    # and the Market tab's assortment gaps feed stock_new evidence. Same
    # warehouse bridge and soft-fail behavior as canonical_demand_enabled.
    store_intel_enabled: bool = True
    # How many Market-tab gap opportunities render as MARKET GAP prompt lines
    # (top projected revenue first), and how many recommendations per run may
    # be anchored on one (like the register-trend ration: peer data informs,
    # never dominates).
    market_gap_max_lines: int = 6
    market_gap_recs_max: int = 1
    # The owner-facing strip and ACTIVE SIGNALS list must keep room for
    # weather, sports, events, holidays, news, and email — the merged social
    # channel (Reddit/YouTube analyst + Instagram + register-measured) is
    # capped to this many entries, strongest evidence first.
    social_signals_max: int = 4
    # Register-discovered trends (contract §1.9) are measured facts, but a
    # whole run of "X is hot at nearby stores" picks reads like surveillance,
    # not advice — at most this many recommendations per run may be anchored
    # purely on register discovery.
    register_trend_recs_max: int = 1
    # Trending (social_trending) recs ride a SEPARATE budget so they never
    # crowd out — or get crowded out of — the daily list: the LLM is asked
    # for 2-4 on top of the daily target, and the validator keeps the top
    # ``trending_max_recommendations`` by confidence. The frontend renders
    # them as their own persistent tab.
    trending_min_recommendations: int = 2
    trending_max_recommendations: int = 4
    # Trailing window of persisted recommendations fetched from Node (optional
    # endpoint) to measure realized lift; inert when Node doesn't serve it.
    feedback_window_days: int = 30
    # Cap on history rows used per run. Sent to Node as ?limit= and re-enforced
    # in Python (voted recs kept first, then most-recent) so the feedback digest
    # and prompt winner/loser lists stay bounded regardless of upstream volume.
    recommendation_history_limit: int = 20
    # Recommendation scoring: blend weights for computed lift vs explicit
    # thumbs votes (renormalized when a component is missing), and the score
    # thresholds that promote a rec's SKUs to "proven winners" (boosted into
    # candidate selection) or demote them to the didn't-convert avoid-list.
    feedback_lift_weight: float = 0.6
    feedback_user_weight: float = 0.4
    feedback_winner_threshold: float = 0.6
    feedback_loser_threshold: float = 0.4
    # When a product's category is empty/junk, infer it from the product name.
    category_name_fallback: bool = True
    # Hard floor enforced by the tool schema. Kept below the target so the model
    # can under-fill on quiet days rather than padding with weak suggestions.
    recommendation_floor: int = 5
    # ----- Action-tag policy (enforced deterministically in the validator) --
    # Cold-box doors are the most expensive real estate in the store, so
    # cold_box recommendations are hard-capped per run and only allowed for
    # chilled-consumption products with an imminent drink-now driver cited.
    # Excess or unqualified picks are re-tagged to endcap (kept, demoted).
    cold_box_max_per_run: int = 1
    # A cited event/game/holiday/heat driver must land within this many days
    # for cold_box to qualify — cold-door space is for what sells THIS window.
    cold_box_driver_days: int = 3

    # ----- Small-format (nip) exclusion -----------------------------------
    # Bottles at or under this volume are never recommended and never reach
    # the buy list: they are pocket-priced impulse buys whose big unit counts
    # made them look like the store's real movers. Applies to the daily
    # recommendation pool, the validator, and the StoreAgent buying tab.
    # Set to 0 to disable the exclusion entirely.
    small_format_max_ml: float = 50.0
    # End displays are physically scarce too (a store has a couple), and every
    # validator demotion path lands on endcap, so runs pile them up (store
    # 171, 2026-08-27: 7 of 14). Excess endcaps — lowest confidence first —
    # are re-tagged to promote (same visibility story, no shelving the store
    # doesn't have).
    endcap_max_per_run: int = 2

    # ----- Geocoding (address -> lat/long, for weather + events) ----------
    # The Node `clients` table stores a street address, not coordinates. We
    # geocode it with the free US Census geocoder (no key, US-only — matching
    # NWS). Results are cached in-process. Set False to skip (weather/events
    # then stay inert).
    geocoding_enabled: bool = True
    census_geocoder_url: str = (
        "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
    )

    # ----- Signal cache (shared across stores in a run) -------------------
    # Weather/sports/events/holidays/news are geography-shared, not per-store.
    # Caching them by geo collapses thousands of redundant upstream calls in a
    # network-wide run and avoids tripping free-tier caps. TTL outlives a single
    # run but expires within a day so the next run refreshes.
    signal_cache_enabled: bool = True
    signal_cache_ttl_seconds: float = 21600.0  # 6 hours

    # ----- External signal sources (free tiers) ---------------------------
    http_timeout_seconds: float = 10.0
    nws_user_agent: str = "ContextualIntelligenceService/1.0 (contact@example.com)"
    ticketmaster_api_key: str | None = None
    newsdata_api_key: str | None = None
    # LLM news analyst: replaces keyword matching with semantic relevance —
    # one small tool-use call per state per signal-cache TTL classifies the
    # fetched headlines into impact/categories/product keywords. Fail-soft;
    # keyword keys remain the floor when disabled or erroring.
    news_llm_enabled: bool = True
    news_llm_model: str = "claude-haiku-4-5"
    # Output budget for the classification tool call. A truncated response
    # loses the ENTIRE tool input (parses as zero items -> all headlines
    # silently dropped), so keep clear headroom for 10 analyzed headlines.
    news_llm_max_tokens: int = 2048
    # Cap on analyst-kept state news carried into the bundle (like
    # events_max_kept). Keeps prompt lines, ACTIVE KEYS, and the snapshot in
    # agreement: every kept item renders, so no citable key lacks its line.
    news_max_kept: int = 5
    # LLM event analyst: screens the raw Ticketmaster feed so only events that
    # plausibly move liquor demand (drinking-age crowd, real draw) survive into
    # the prompt, the snapshot, and candidate eligibility, each with a crowd-
    # size judgment, affected categories, a citable key, and a one-line note.
    # One call per store area per signal-cache TTL. Fail-soft; the segment-
    # keyword keys remain the floor when disabled or erroring.
    events_llm_enabled: bool = True
    events_llm_model: str = "claude-haiku-4-5"
    # Output budget for the classification tool call. An event-dense area
    # (downtown store, 14+ events) needs ~150 output tokens per analyzed
    # event; at 1024 the response truncated and ALL events were silently
    # dropped (parsed as zero items). Keep generous headroom.
    events_llm_max_tokens: int = 4096

    # ----- Social trend signals (Reddit + Google Trends) -------------------
    # Master switch for the social-trend channel. Reddit discovers what's
    # trending (official OAuth API, one global fetch per cache TTL serves the
    # whole network); Google Trends quantifies search momentum per state.
    social_trends_enabled: bool = True
    # Reddit script-app credentials (client-credentials grant). Dormant until
    # both are set. Register at https://www.reddit.com/prefs/apps (type
    # "script"); free tier allows 100 requests/minute — we make two per TTL.
    reddit_client_id: str | None = None
    reddit_client_secret: str | None = None
    # Reddit requires a descriptive UA and throttles library defaults.
    reddit_user_agent: str = "server:botella-contextual-intelligence:v1.0"
    # Subreddits pulled as ONE multireddit listing (r/a+b+c/top?t=week).
    reddit_subreddits: list[str] = Field(
        default_factory=lambda: [
            "cocktails", "bourbon", "whiskey", "wine", "beer",
            "Tequila", "rum", "Mixology", "alcohol",
        ]
    )
    # Posts pulled per fetch and the engagement floor below which a post
    # title is noise rather than a trend.
    reddit_top_limit: int = 40
    reddit_min_score: int = 25
    # YouTube discovery (official Data API v3 — a plain API key from Google
    # Cloud Console, no approval process). Feeds the same discovery channel as
    # Reddit: this week's most-viewed drink videos. Dormant until the key is
    # set. Quota note: search.list costs 100 units per query against the free
    # 10k/day quota, so the query list stays small and one fetch per cache
    # TTL serves the whole network.
    youtube_api_key: str | None = None
    youtube_queries: list[str] = Field(
        default_factory=lambda: ["cocktail trend", "trending drink", "cocktail recipe"]
    )
    # View floor below which a video is noise, and a cap bounding the
    # analyst payload. 250k, not 10k: YouTube-scale drink virality runs in
    # the hundreds of thousands — 72k/90k-view videos were anchoring
    # owner-facing trend chips (store-171 report), and that is niche
    # content, not a trend.
    youtube_min_views: int = 250_000
    youtube_max_videos: int = 40
    # Twitter/X discovery via an Apify pay-per-result actor (the official X
    # API has had no free read tier since Feb 2026). ONE synchronous actor
    # run per cache TTL covers every query, so a daily ~100-tweet fetch costs
    # about two cents at ~$0.20/1k, inside Apify's free $5/month credit
    # (which does NOT roll over and hard-stops runs when spent; the fetcher
    # fail-softs through that). Dormant until the token is set. The actor id
    # is configurable so a dead or repriced actor can be swapped without a
    # deploy of code.
    apify_token: str | None = None
    twitter_apify_actor: str = (
        "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest"
    )
    # X advanced-search BASE queries; the fetcher appends min_faves/since/lang
    # operators. X search ANDs space-separated words, so a multi-word phrase
    # ("cocktail trend") plus the like floor matched nothing all week and the
    # pay-per-result actor padded every empty scrape to its 15-item billing
    # minimum with mock_tweet notice rows (observed 2026-08-27: ten straight
    # zero-tweet fetches). OR groups keep single terms matching; the analyst
    # and the drink-term gate filter the off-topic remainder downstream.
    twitter_queries: list[str] = Field(
        default_factory=lambda: [
            '(cocktail OR margarita OR mocktail OR "espresso martini" OR negroni)',
            "(tequila OR whiskey OR bourbon OR seltzer OR sangria)",
        ]
    )
    # Like floor below which a tweet is noise. Likes ride at rough
    # Reddit-upvote parity in the analyst's ranking, so this floor is the
    # 25-upvote floor's stricter sibling: drink-Twitter virality runs in the
    # thousands, and a sub-500-like tweet is a post, not a trend.
    twitter_min_likes: int = 500
    twitter_max_posts: int = 40
    # Total tweets requested per actor run (its own minimum is 20). Split
    # across the queries by the actor; the per-result bill scales with this.
    twitter_max_items: int = 100
    # LLM trend analyst: one Haiku call per cache TTL reads the raw post and
    # video titles and extracts trending drink terms the keyword floor's
    # vocabulary never anticipated. Fail-soft; the keyword floor remains the
    # fallback.
    trend_llm_enabled: bool = True
    trend_llm_model: str = "claude-haiku-4-5"
    # Output budget for the extraction tool call. A truncated response loses
    # the whole tool input (logged as trend_analysis_truncated).
    trend_llm_max_tokens: int = 2048
    # Cap on trend terms carried into the prompt and snapshot.
    trend_max_kept: int = 5
    # Thin-evidence floor for KEPT terms: a term needs at least this many
    # supporting posts/videos, OR a single supporter so strong it clears the
    # solo bar (in normalized engagement units: Reddit upvotes, YouTube
    # views/200 — 2500 ~ a 2.5k-upvote megathread or a 500k-view video).
    # One modest video must never mint a trend chip on its own.
    trend_min_mentions: int = 2
    trend_solo_min_score: float = 2500.0
    # Google Trends rides an UNOFFICIAL endpoint (no public API) and can be
    # rate limited or break without notice, so it ships OFF. Enable after
    # probing it from the deploy host (probe_external_apis.py). All errors
    # degrade to Reddit-only.
    google_trends_enabled: bool = False
    # Seed terms whose search momentum is measured per state. Curated for
    # drinks retail; Reddit-discovered terms are a future enhancement (they
    # live in a different cache entry with a different key).
    google_trends_seed_terms: list[str] = Field(
        default_factory=lambda: [
            "espresso martini", "aperol spritz", "high noon", "buzzballz",
            "hard seltzer", "canned cocktail", "ranch water", "mezcal",
            "japanese whisky", "soju", "negroni", "non alcoholic beer",
            "orange wine", "amaro",
        ]
    )
    google_trends_timeframe: str = "today 3-m"
    # Pause between term batches. The endpoint throttles rapid-fire requests
    # (a 429 on the batch right after a success); one fetch per state per TTL
    # makes this pause negligible in wall-clock terms.
    google_trends_batch_pause_seconds: float = 5.0
    # Rising = trailing-week interest >= baseline * threshold AND >= the
    # absolute floor (interest drifting 1 -> 2 is noise, not a trend).
    google_trends_rising_threshold: float = 1.25
    google_trends_min_interest: int = 10
    # DISCOVERY via related rising queries ("Breakout" terms around broad
    # seeds): surfaces drink names nobody curated, measured by Google rather
    # than sampled by us. National geo on purpose — discovery shares ONE
    # global cache entry (see signals/__init__), unlike the state-scoped
    # momentum fetch above. Rides the same enabled flag and fail-soft rules.
    google_trends_discovery_seeds: list[str] = Field(
        default_factory=lambda: ["cocktail", "cocktail recipe", "trending drink"]
    )
    # Rising value floor (percent growth; "Breakout" arrives as ~5000+) and
    # the cap on queries carried into the discovery channel per fetch.
    google_trends_rising_min_growth: int = 200
    google_trends_rising_max: int = 10
    # Instagram hashtag velocity, served by OUR OWN Node backend (contract
    # §1.8): Node's cron polls a fixed drink-hashtag vocabulary on Meta's
    # Graph API daily; this service reads each term's acceleration (latest
    # posts/hour vs. its own multi-day baseline). First-party and fail-soft —
    # the endpoint returns [] until Node's poller has accrued baselines — so
    # unlike Google Trends it ships ON.
    instagram_trends_enabled: bool = True
    # Rising = latest velocity >= baseline * this threshold, with at least
    # min_baseline_points observations behind the baseline (a fresh
    # deployment serves acceleration = None for a day or two — skipped).
    instagram_min_acceleration: float = 1.5
    instagram_min_baseline_points: int = 2
    # Cap on Instagram entries carried into the merge (fastest-rising first).
    instagram_max_kept: int = 5
    # Register-measured trend discovery (contract §1.9): drink categories
    # accelerating across same-state peer registers, mined by Node from the
    # warehouse. Measured purchases, not social proxy — the prompt treats it
    # as the strongest trend evidence tier. First-party and fail-soft, ON.
    register_trends_enabled: bool = True
    register_trends_max: int = 6
    # How many PURE register entries the capped signal strip may carry. The
    # fetch cap above stays wider so register rows can still merge into and
    # corroborate social terms ("twitter+registers"), but standalone register
    # readings are one metric measured many times: without this ration their
    # top evidence tier filled all four social slots (4 of 4 chips
    # register-measured, observed 2026-08-26). Merged entries never count.
    register_signals_max: int = 1

    # ----- Email signal (daily industry email over IMAP) -------------------
    # A daily subscription email from an industry rep, pulled over IMAP and
    # fed into the news channel of the signal bundle. GoDaddy Professional
    # Email is powered by Titan Mail, whose IMAP endpoint is
    # imap.titan.email:993 (SSL) — the default host. Store-independent: one
    # mailbox read per signal-cache TTL serves the whole network. Dormant
    # until user + password are set.
    email_signal_enabled: bool = True
    email_imap_host: str = "imap.titan.email"
    email_imap_port: int = 993
    email_imap_user: str | None = None
    email_imap_password: str | None = None
    email_imap_mailbox: str = "INBOX"
    # When the primary mailbox has no fresh issue, these folders are checked
    # too (the subscription sometimes lands in spam). Any folder the server
    # itself marks \Junk (RFC 6154) is tried first; nonexistent names are
    # skipped harmlessly. "Bulk Mail" is GoDaddy Workspace's spam folder.
    email_spam_mailboxes: list[str] = Field(
        default_factory=lambda: ["Bulk Mail", "Spam", "Junk", "Junk E-mail"]
    )
    # Only messages FROM these senders are ingested.
    email_senders: list[str] = Field(default_factory=lambda: ["mbrown@sazerac.com"])
    # Coarse server-side IMAP SINCE prefilter (day granularity). Real
    # freshness is enforced client-side by ``email_max_age_hours``; this just
    # bounds how many candidates the mailbox returns.
    email_lookback_days: int = 2
    email_max_messages: int = 3
    # Only messages younger than this are ingested. An older issue is
    # yesterday's news: a run with no fresh issue SKIPS the email signal
    # entirely instead of re-shipping stale items. 20h keeps the ~2:30am ET
    # issue fresh for same-day runs at any hour while excluding the previous
    # day's issue whether or not a new one arrived.
    email_max_age_hours: float = 20.0
    # Cache TTL for the email entry, overriding the 6h signal-cache TTL. The
    # issue lands ~2:30am ET (12pm IST) and the post-close cron runs after,
    # so each RUN must re-read the mailbox (a 6h entry could predate the
    # day's issue) while the ~1,200 stores within a run still share one
    # fetch + one analyst call. 15 min ≈ per-run freshness for a daily cron.
    email_cache_ttl_seconds: float = 900.0
    # Plain-text body excerpt handed to the LLM analyst (chars). A real issue
    # measured ~85K chars of stripped text, and the analyst runs once per
    # signal-cache TTL for the whole network, so the ceiling is generous
    # (~25K tokens); it exists only to bound a pathological message.
    # Truncation is logged (email_body_truncated) when it actually bites.
    email_body_max_chars: int = 100000
    # LLM email analyst: one Haiku call per signal-cache TTL reads the email
    # bodies and extracts the demand-relevant items (impact, categories,
    # product keywords, citable key, note), tagged into the news channel.
    # Fail-soft; when disabled or erroring, the subject lines still reach the
    # prompt as soft context.
    email_llm_enabled: bool = True
    email_llm_model: str = "claude-haiku-4-5"
    # Output budget for the extraction tool call. 3 items with notes measured
    # ~500 tokens; a truncated response loses the whole tool input (logged as
    # email_analysis_truncated), so keep clear headroom.
    email_llm_max_tokens: int = 2048
    # Cap on events carried into the prompt and snapshot (biggest draws first
    # when the analyst is on).
    events_max_kept: int = 5
    # Total signal entries (weather + sports + events + holidays + news) kept
    # in the owner-facing signal snapshot, trimmed by priority. The LLM
    # prompt always sees the full bundle; this only bounds what the UI shows.
    signal_display_cap: int = 10
    event_radius_miles: int = 5
    signal_lookahead_days: int = 7
    holiday_lookahead_days: int = 21
    # Which ESPN leagues to query for upcoming games.
    sports_leagues: list[str] = Field(default_factory=lambda: ["nfl", "nba", "mlb", "nhl"])
    # A home game counts as "local" when the team's metro is within this many
    # miles of the store (falls back to a venue-state match without geo).
    # Deliberately WIDE: sports demand for a liquor store is watch-party
    # demand — a Cowboys home game lifts beer sales across the whole metro
    # because people watch at home, unlike a concert (event_radius_miles = 5)
    # where only venue foot traffic matters.
    sports_local_radius_miles: float = 40.0
    # Within this straight-line distance the STADIUM itself is close enough
    # for game-day foot traffic (fans stocking up on the way): only then may
    # the prose call the game "nearby" or pitch cold-box/single-serve
    # game-day advice. Beyond it, the pitch is watch-party staples.
    sports_stadium_radius_miles: float = 10.0


@lru_cache
def get_settings() -> Settings:
    """Return a cached ``Settings`` instance (read once per process)."""
    return Settings()
