"""Daily industry email as a news signal (IMAP; Titan Mail / GoDaddy).

The network subscribes to a daily industry email (a Sazerac rep newsletter).
This module pulls recent messages from the configured sender(s) over IMAP and
normalizes each into a :class:`NewsSignal`: subject as the headline, extracted
plain-text body as ``description`` (analyst input — never shown in the
prompt), category ``industry_email`` so the item is tagged as news downstream.

Everything here is store-independent, so ``gather_signals`` routes it through
one GLOBAL cache entry with a short TTL override (``email_cache_ttl_seconds``):
each cron-triggered run re-reads the mailbox (the issue lands ~2:30am ET,
shortly before the post-close cron), while all stores within a run share one
IMAP round-trip plus one analyst call. The mailbox is selected read-only
and messages are fetched with BODY.PEEK, so ingestion never flips ``\\Seen``
flags out from under the humans reading the same inbox.

Requires ``email_imap_user`` / ``email_imap_password``; returns empty without
them. GoDaddy Professional Email is powered by Titan Mail, whose IMAP endpoint
is imap.titan.email:993 (SSL) — the default host in settings.
"""

from __future__ import annotations

import asyncio
import imaplib
import re
from datetime import UTC, datetime, timedelta
from email import message_from_bytes, policy
from email.message import EmailMessage
from html.parser import HTMLParser

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import NewsSignal

log = get_logger(__name__)

# Category tag carried on email-derived news items in the prompt/snapshot.
EMAIL_CATEGORY = "industry_email"

# IMAP SINCE dates require English month abbreviations regardless of locale,
# so the date string is built by hand instead of strftime("%b").
_MONTHS = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)

_WS = re.compile(r"\s+")

# A LIST line whose attributes carry \Junk (RFC 6154 SPECIAL-USE) names the
# server's own spam folder — preferred over guessing by name.
_JUNK_ATTR = re.compile(rb"\(([^)]*\\Junk[^)]*)\)", re.IGNORECASE)
_LAST_QUOTED = re.compile(rb'"((?:[^"\\]|\\.)*)"\s*$')


class _TextExtractor(HTMLParser):
    """Visible-text extraction for HTML-only bodies (most newsletters)."""

    _SKIP = {"script", "style", "head", "title", "template"}

    def __init__(self) -> None:
        super().__init__()
        self._chunks: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip_depth and data.strip():
            self._chunks.append(data.strip())

    def text(self) -> str:
        return " ".join(self._chunks)


def _strip_html(html: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # noqa: BLE001 — malformed markup degrades to whatever was parsed
        pass
    return parser.text()


def _body_text(msg: EmailMessage) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    try:
        content = part.get_content()
    except Exception:  # noqa: BLE001 — undecodable payload; the subject still signals
        return ""
    if not isinstance(content, str):
        return ""
    if part.get_content_type() == "text/html":
        content = _strip_html(content)
    return _WS.sub(" ", content).strip()


def since_date(lookback_days: int, now: datetime) -> str:
    """IMAP SINCE literal, e.g. ``13-Jul-2026``."""
    d = (now - timedelta(days=lookback_days)).date()
    return f"{d.day:02d}-{_MONTHS[d.month - 1]}-{d.year}"


def _sent_at(msg: EmailMessage) -> datetime | None:
    """Aware send time from the Date header; None when missing/unparseable.

    Everything is wrapped: with ``policy.default`` an unparseable Date header
    can raise from the ``.datetime`` property itself, and letting that bubble
    would drop the whole mailbox result instead of just this message.
    """
    try:
        sent = getattr(msg.get("Date"), "datetime", None)
    except Exception:  # noqa: BLE001 — one bad header must not sink the channel
        return None
    if sent is None:
        return None
    return sent if sent.tzinfo else sent.replace(tzinfo=UTC)


def signal_from_message(
    raw: bytes,
    sender: str,
    max_chars: int,
    *,
    now: datetime | None = None,
    max_age_hours: float | None = None,
) -> NewsSignal | None:
    """Normalize one raw RFC822 message into a news-channel signal.

    With ``now`` and ``max_age_hours`` set, a message older than the window
    (or without a parseable Date header) returns None: yesterday's issue is
    yesterday's news, and a run with no fresh issue skips the signal rather
    than re-shipping stale items.
    """
    msg = message_from_bytes(raw, policy=policy.default)
    subject = _WS.sub(" ", (msg.get("Subject") or "").strip()) or "(no subject)"
    if now is not None and max_age_hours is not None:
        sent = _sent_at(msg)
        # A Date header more than a few hours in the future is clock skew at
        # best and a forged header at worst — either way not provably fresh.
        if (
            sent is None
            or now - sent > timedelta(hours=max_age_hours)
            or sent - now > timedelta(hours=6)
        ):
            log.info(
                "email_skipped_stale",
                subject=subject,
                sent=sent.isoformat() if sent else None,
                max_age_hours=max_age_hours,
            )
            return None
    body = _body_text(msg)
    if len(body) > max_chars:
        log.warning(
            "email_body_truncated", subject=subject, chars=len(body), kept=max_chars
        )
    return NewsSignal(
        headline=subject,
        category=EMAIL_CATEGORY,
        source=sender,
        description=body[:max_chars] or None,
    )


def _quote_mailbox(name: str) -> str:
    """IMAP-quote a mailbox name (names with spaces, e.g. "Bulk Mail")."""
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _junk_mailboxes(imap: imaplib.IMAP4) -> list[str]:
    """Folders the server itself marks \\Junk via LIST (RFC 6154)."""
    try:
        status, lines = imap.list()
    except imaplib.IMAP4.error:
        return []
    if status != "OK":
        return []
    names: list[str] = []
    for line in lines or []:
        if not isinstance(line, bytes) or not _JUNK_ATTR.search(line):
            continue
        match = _LAST_QUOTED.search(line)
        if match:
            names.append(match.group(1).decode("ascii", "replace").replace('\\"', '"'))
    return names


def _search_mailbox(
    imap: imaplib.IMAP4, mailbox: str, settings: Settings, now: datetime, since: str
) -> list[NewsSignal]:
    """Fresh messages from the allow-listed senders in one mailbox.

    A mailbox that does not exist (spam folder name guesses) selects NO and
    yields nothing; freshness filtering applies the same everywhere.
    """
    status, _ = imap.select(_quote_mailbox(mailbox), readonly=True)
    if status != "OK":
        return []
    signals: list[NewsSignal] = []
    for sender in settings.email_senders:
        status, data = imap.search(None, "FROM", f'"{sender}"', "SINCE", since)
        if status != "OK" or not data or not data[0]:
            continue
        ids = data[0].split()
        # Sequence numbers ascend with arrival; keep the newest first so
        # the overall cap below favors today's issue over older ones.
        for msg_id in reversed(ids[-settings.email_max_messages:]):
            status, fetched = imap.fetch(msg_id, "(BODY.PEEK[])")
            if status != "OK":
                continue
            raw = next((p[1] for p in fetched if isinstance(p, tuple) and p[1]), None)
            if raw is None:
                continue
            signal = signal_from_message(
                raw,
                sender,
                settings.email_body_max_chars,
                now=now,
                max_age_hours=settings.email_max_age_hours,
            )
            if signal is not None:
                signals.append(signal)
    return signals


def _fetch_sync(settings: Settings, now: datetime) -> list[NewsSignal]:
    since = since_date(settings.email_lookback_days, now)
    imap = imaplib.IMAP4_SSL(
        settings.email_imap_host,
        settings.email_imap_port,
        timeout=settings.http_timeout_seconds,
    )
    try:
        imap.login(settings.email_imap_user or "", settings.email_imap_password or "")
        signals = _search_mailbox(imap, settings.email_imap_mailbox, settings, now, since)
        if not signals:
            # The issue sometimes lands in spam. Try the server's declared
            # \Junk folder first, then the configured name guesses.
            candidates = _junk_mailboxes(imap) + list(settings.email_spam_mailboxes)
            seen = {settings.email_imap_mailbox}
            for mailbox in candidates:
                if mailbox in seen:
                    continue
                seen.add(mailbox)
                signals = _search_mailbox(imap, mailbox, settings, now, since)
                if signals:
                    log.info("email_found_in_spam", mailbox=mailbox)
                    break
    finally:
        try:
            imap.logout()
        except Exception:  # noqa: BLE001 — a failed goodbye must not mask the result
            pass
    return signals[: settings.email_max_messages]


async def fetch(settings: Settings) -> list[NewsSignal]:
    """Pull the latest subscription email(s); fail-soft to no signals.

    ``imaplib`` is blocking, so the round-trip runs in a worker thread. Any
    mailbox problem (auth, network, a provider hiccup) degrades to an empty
    list — a flaky inbox must never sink a recommendation run.
    """
    if not settings.email_signal_enabled or not settings.email_senders:
        return []
    if not (settings.email_imap_user and settings.email_imap_password):
        return []
    try:
        signals = await asyncio.to_thread(_fetch_sync, settings, datetime.now(UTC))
    except Exception as exc:  # noqa: BLE001 — fail-soft, see docstring
        log.warning("email_fetch_failed", error=str(exc))
        return []
    log.info("email_fetched", messages=len(signals))
    return signals
