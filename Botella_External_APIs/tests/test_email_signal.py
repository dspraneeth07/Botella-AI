"""Tests for the daily-industry-email signal: IMAP fetch normalization, the
LLM extraction analyst, and the gather_signals wiring. The canonical shape: a
Sazerac rep email announcing an allocation plus a price increase becomes two
citable NEWS items with categories/keywords that widen candidate eligibility,
while the pleasantries around them are dropped."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.utils import format_datetime
from types import SimpleNamespace

from app.config import Settings
from app.schemas.signals import NewsSignal
from app.schemas.store import StoreProfile
from app.signals import email_analyst, email_news, gather_signals
from app.signals.email_analyst import analyze, apply_analysis
from app.signals.email_news import fetch, signal_from_message, since_date


def _settings(**overrides: object) -> Settings:
    return Settings(node_api_base_url="http://x", anthropic_api_key="x", **overrides)


def _raw_email(
    subject: str = "Sazerac Daily Update",
    plain: str | None = None,
    html: str | None = None,
    sent: datetime | None = None,
) -> bytes:
    msg = EmailMessage()
    msg["From"] = "mbrown@sazerac.com"
    msg["To"] = "store@example.com"
    msg["Subject"] = subject
    if sent is not None:
        msg["Date"] = format_datetime(sent)
    if plain is not None:
        msg.set_content(plain)
        if html is not None:
            msg.add_alternative(html, subtype="html")
    elif html is not None:
        msg.set_content(html, subtype="html")
    return msg.as_bytes()


# ----- message normalization ------------------------------------------------


def test_signal_from_message_prefers_plain_text() -> None:
    raw = _raw_email(
        plain="Buffalo Trace allocation arriving next week.",
        html="<p>Buffalo Trace allocation arriving <b>next week</b>.</p>",
    )
    sig = signal_from_message(raw, "mbrown@sazerac.com", max_chars=6000)
    assert sig.headline == "Sazerac Daily Update"
    assert sig.category == email_news.EMAIL_CATEGORY
    assert sig.source == "mbrown@sazerac.com"
    assert sig.description == "Buffalo Trace allocation arriving next week."


def test_signal_from_message_strips_html_only_bodies() -> None:
    raw = _raw_email(
        html="<html><head><style>p{color:red}</style></head><body>"
        "<h1>Price notice</h1><p>Fireball up 8% August 1.</p>"
        "<script>track()</script></body></html>",
    )
    sig = signal_from_message(raw, "mbrown@sazerac.com", max_chars=6000)
    assert sig.description == "Price notice Fireball up 8% August 1."


def test_signal_from_message_truncates_and_defaults() -> None:
    raw = _raw_email(subject="", plain="x" * 500)
    sig = signal_from_message(raw, "mbrown@sazerac.com", max_chars=100)
    assert sig.headline == "(no subject)"
    assert sig.description is not None and len(sig.description) == 100


def test_since_date_uses_english_months() -> None:
    now = datetime(2026, 7, 16, 8, 0, tzinfo=UTC)
    assert since_date(3, now) == "13-Jul-2026"


def test_signal_from_message_skips_stale_issues() -> None:
    """No fresh issue -> no signal; yesterday's news must not ride today's run."""
    now = datetime(2026, 7, 16, 8, 0, tzinfo=UTC)
    window = {"now": now, "max_age_hours": 20.0}

    fresh = _raw_email(plain="fresh", sent=now - timedelta(hours=5))
    sig = signal_from_message(fresh, "mbrown@sazerac.com", 6000, **window)
    assert sig is not None and sig.description == "fresh"

    stale = _raw_email(plain="old", sent=now - timedelta(hours=25))
    assert signal_from_message(stale, "mbrown@sazerac.com", 6000, **window) is None

    undated = _raw_email(plain="no date header")  # unverifiable age -> stale
    assert signal_from_message(undated, "mbrown@sazerac.com", 6000, **window) is None

    # Without a window (pure parsing callers), nothing is filtered.
    assert signal_from_message(stale, "mbrown@sazerac.com", 6000) is not None


# ----- IMAP fetch plumbing ---------------------------------------------------


class _FakeIMAP:
    last: _FakeIMAP | None = None
    # Per-test fixtures: folder name -> raw messages; LIST response lines.
    mailboxes: dict[str, list[bytes]] = {}
    list_lines: list[bytes] = []

    def __init__(self, host: str, port: int, timeout: float | None = None) -> None:
        _FakeIMAP.last = self
        self.host, self.port = host, port
        self.readonly: bool | None = None
        self.mailbox: str | None = None
        self.selected: list[str] = []
        self.criteria: tuple = ()
        self.fetched: list[bytes] = []
        self.logged_out = False

    def login(self, user: str, password: str) -> tuple:
        self.user = user
        return "OK", [b""]

    def list(self) -> tuple:
        return "OK", list(self.list_lines)

    def select(self, mailbox: str, readonly: bool = False) -> tuple:
        name = mailbox.strip('"')
        self.selected.append(name)
        if name not in self.mailboxes:
            return "NO", [b"[NONEXISTENT] no such folder"]
        self.mailbox, self.readonly = name, readonly
        return "OK", [b"1"]

    def search(self, charset: object, *criteria: str) -> tuple:
        self.criteria = criteria
        n = len(self.mailboxes.get(self.mailbox or "", []))
        return "OK", [b" ".join(str(i).encode() for i in range(1, n + 1))]

    def fetch(self, msg_id: bytes, parts: str) -> tuple:
        assert "PEEK" in parts  # must never flip \Seen on a shared inbox
        self.fetched.append(msg_id)
        raw = self.mailboxes[self.mailbox or ""][int(msg_id) - 1]
        return "OK", [(b"1 (BODY[] {42}", raw), b")"]

    def logout(self) -> tuple:
        self.logged_out = True
        return "BYE", [b""]


def _fake_imap(monkeypatch, mailboxes: dict, list_lines: list[bytes] | None = None):
    monkeypatch.setattr(email_news.imaplib, "IMAP4_SSL", _FakeIMAP)
    monkeypatch.setattr(_FakeIMAP, "mailboxes", mailboxes)
    monkeypatch.setattr(_FakeIMAP, "list_lines", list_lines or [])


def _fresh(subject: str) -> bytes:
    return _raw_email(subject=subject, plain="body", sent=datetime.now(UTC))


async def test_fetch_pulls_newest_first_and_caps(monkeypatch) -> None:
    _fake_imap(
        monkeypatch, {"INBOX": [_fresh("Issue 1"), _fresh("Issue 2"), _fresh("Issue 3")]}
    )
    settings = _settings(
        email_imap_user="u@x.com", email_imap_password="pw", email_max_messages=2
    )
    signals = await fetch(settings)

    imap = _FakeIMAP.last
    assert imap is not None
    assert imap.mailbox == "INBOX" and imap.readonly is True
    assert imap.selected == ["INBOX"]  # fresh issue found -> spam never touched
    assert imap.logged_out is True
    assert "FROM" in imap.criteria and '"mbrown@sazerac.com"' in imap.criteria
    assert "SINCE" in imap.criteria
    # ids 1..3 with a cap of 2 -> the two newest, newest first.
    assert imap.fetched == [b"3", b"2"]
    assert [s.headline for s in signals] == ["Issue 3", "Issue 2"]


async def test_fetch_falls_back_to_spam_folder(monkeypatch) -> None:
    """Stale inbox -> the fresh issue is found in a spam folder by name guess."""
    stale = _raw_email(
        subject="Old Issue", plain="body", sent=datetime.now(UTC) - timedelta(hours=30)
    )
    _fake_imap(
        monkeypatch, {"INBOX": [stale], "Junk": [_fresh("Spam Issue")]}
    )
    settings = _settings(email_imap_user="u@x.com", email_imap_password="pw")
    signals = await fetch(settings)

    imap = _FakeIMAP.last
    assert imap is not None
    # Nonexistent guesses ("Bulk Mail", "Spam") select NO and are skipped.
    assert imap.selected == ["INBOX", "Bulk Mail", "Spam", "Junk"]
    assert [s.headline for s in signals] == ["Spam Issue"]


async def test_fetch_prefers_server_declared_junk_folder(monkeypatch) -> None:
    """A \\Junk folder from LIST is tried before (and beats) the name guesses."""
    _fake_imap(
        monkeypatch,
        {"INBOX": [], "Custom Junk": [_fresh("Spam Issue")]},
        list_lines=[
            rb'(\HasNoChildren) "/" "INBOX"',
            rb'(\HasNoChildren \Junk) "/" "Custom Junk"',
        ],
    )
    settings = _settings(email_imap_user="u@x.com", email_imap_password="pw")
    signals = await fetch(settings)

    imap = _FakeIMAP.last
    assert imap is not None
    assert imap.selected == ["INBOX", "Custom Junk"]
    assert [s.headline for s in signals] == ["Spam Issue"]


async def test_fetch_inert_without_credentials() -> None:
    # Credentials passed explicitly as None so a developer .env with real
    # values (or CI without one) exercises the same code path.
    assert await fetch(_settings(email_imap_user=None, email_imap_password=None)) == []
    assert (
        await fetch(_settings(email_imap_user="u@x.com", email_imap_password=None)) == []
    )
    assert (
        await fetch(
            _settings(
                email_imap_user="u", email_imap_password="p", email_signal_enabled=False
            )
        )
        == []
    )


async def test_fetch_fail_soft_on_mailbox_error(monkeypatch) -> None:
    class _Boom:
        def __init__(self, *a: object, **k: object) -> None:
            raise OSError("connection refused")

    monkeypatch.setattr(email_news.imaplib, "IMAP4_SSL", _Boom)
    settings = _settings(email_imap_user="u@x.com", email_imap_password="pw")
    assert await fetch(settings) == []


# ----- LLM extraction analyst ------------------------------------------------


def _emails() -> list[NewsSignal]:
    return [
        NewsSignal(
            headline="Sazerac Daily Update",
            category=email_news.EMAIL_CATEGORY,
            source="mbrown@sazerac.com",
            description="Buffalo Trace allocation lands next week. Fireball "
            "prices rise 8% on August 1. Happy Tuesday!",
        )
    ]


def test_apply_analysis_extracts_items() -> None:
    items = [
        {
            "email_index": 0,
            "headline": "Buffalo Trace allocation arriving next week",
            "impact": "demand_up",
            "categories": ["bourbon"],
            "product_keywords": ["Buffalo Trace ", ""],
            "key": "Buffalo Trace allocation!",
            "note": "Feature it — allocated bourbon sells itself.",
        },
        {
            "email_index": 0,
            "headline": "Fireball price increase August 1",
            "impact": "price_increase_risk",
            "categories": ["whiskey", "not_a_category"],
            "key": "email_fireball_price_increase",
        },
    ]
    kept, keys, categories, keywords = apply_analysis(_emails(), items)

    assert [n.headline for n in kept] == [
        "Buffalo Trace allocation arriving next week",
        "Fireball price increase August 1",
    ]
    assert all(n.category == email_news.EMAIL_CATEGORY for n in kept)
    assert all(n.source == "mbrown@sazerac.com" for n in kept)
    assert kept[0].key == "email_buffalo_trace_allocation"  # slugged + prefixed
    assert kept[0].note == "Feature it, allocated bourbon sells itself."  # dash cleaned
    assert kept[1].key == "email_fireball_price_increase"  # prefix not doubled
    assert keys == ["email_buffalo_trace_allocation", "email_fireball_price_increase"]
    assert categories == ["bourbon", "whiskey"]  # unknown vocab dropped
    assert keywords == ["buffalo trace"]  # cleaned + lowercased


def test_apply_analysis_filters_junk_and_caps() -> None:
    items = [
        {"email_index": 99, "headline": "out of range"},
        {"email_index": 0, "headline": "   "},  # empty headline
    ] + [
        {"email_index": 0, "headline": f"item {i}", "impact": "made_up"} for i in range(5)
    ]
    kept, keys, _, _ = apply_analysis(_emails(), items)
    assert len(kept) == 3  # hard cap keeps prompt news slots free
    assert kept[0].impact is None  # bad impact stays direction-less
    assert kept[0].key == "email_item_0"  # fallback slug


async def test_analyze_fail_soft_keeps_subject_lines() -> None:
    class _BoomMessages:
        async def create(self, **_: object) -> object:
            raise RuntimeError("api down")

    client = SimpleNamespace(messages=_BoomMessages())
    emails = _emails()
    kept, keys, categories, keywords = await analyze(emails, client, _settings())  # type: ignore[arg-type]
    assert kept == emails  # raw subjects survive as soft context
    assert keys == [] and categories == [] and keywords == []


async def test_analyze_parses_tool_block() -> None:
    tool_block = SimpleNamespace(
        type="tool_use",
        input={
            "items": [
                {
                    "email_index": 0,
                    "headline": "Fireball price increase August 1",
                    "impact": "price_increase_risk",
                    "categories": ["whiskey"],
                    "product_keywords": ["fireball"],
                    "key": "fireball_price_increase",
                    "note": "Buy ahead of the increase.",
                }
            ]
        },
    )

    class _Messages:
        async def create(self, **kwargs: object) -> object:
            assert kwargs["tool_choice"] == {"type": "tool", "name": "analyze_email"}
            return SimpleNamespace(content=[tool_block])

    client = SimpleNamespace(messages=_Messages())
    kept, keys, categories, keywords = await analyze(_emails(), client, _settings())  # type: ignore[arg-type]
    assert kept[0].key == "email_fireball_price_increase"
    assert kept[0].impact == "price_increase_risk"
    assert keys == ["email_fireball_price_increase"]
    assert categories == ["whiskey"] and keywords == ["fireball"]


# ----- gather_signals wiring -------------------------------------------------


async def test_gather_signals_merges_email_into_news_channel(monkeypatch) -> None:
    """Email items ride the news channel, placed first, keys in active_keys."""
    from app.signals import events, holidays, news, sports, weather

    email_sig = NewsSignal(
        headline="Buffalo Trace allocation arriving",
        category=email_news.EMAIL_CATEGORY,
        source="mbrown@sazerac.com",
        impact="demand_up",
        key="email_buffalo_trace_allocation",
    )
    state_news = NewsSignal(headline="Local festival this weekend", category="general")

    async def _fake_email(settings: Settings) -> list[NewsSignal]:
        return [email_sig]

    async def _fake_news(store, http, settings, *, broad=False):
        return [state_news], ["news_festival"]

    async def _fake_weather(store, http, settings):
        return None, []

    async def _fake_national(http, settings):
        return []

    async def _fake_events(store, http, settings, *, broad=False):
        return [], []

    async def _fake_holidays(store, settings):
        return [], []

    monkeypatch.setattr(email_news, "fetch", _fake_email)
    monkeypatch.setattr(news, "fetch", _fake_news)
    monkeypatch.setattr(weather, "fetch", _fake_weather)
    monkeypatch.setattr(sports, "fetch_national", _fake_national)
    monkeypatch.setattr(events, "fetch", _fake_events)
    monkeypatch.setattr(holidays, "fetch", _fake_holidays)

    async def _fake_analyze(emails, client, settings):
        return emails, ["email_buffalo_trace_allocation"], ["bourbon"], ["buffalo trace"]

    monkeypatch.setattr(email_analyst, "analyze", _fake_analyze)

    store = StoreProfile(id=1, state="KY")
    settings = _settings(email_imap_user="u@x.com", email_imap_password="pw")
    bundle = await gather_signals(
        store, http=None, settings=settings, anthropic_client=SimpleNamespace()  # type: ignore[arg-type]
    )

    # Email item first so the prompt's news display cap cannot drop it.
    assert [n.headline for n in bundle.news] == [
        "Buffalo Trace allocation arriving",
        "Local festival this weekend",
    ]
    assert "email_buffalo_trace_allocation" in bundle.active_keys
    assert "news_festival" in bundle.active_keys
    assert "bourbon" in bundle.news_categories
    assert "buffalo trace" in bundle.news_product_keywords
