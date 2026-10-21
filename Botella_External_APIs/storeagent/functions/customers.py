"""Customer Win-Back Radar — deterministic functions over per-customer rows.

The key idea a POS doesn't do: detect each customer's PERSONAL visit cadence and
flag regulars whose gap since last visit has broken that cadence (churning),
ranked by the annual repeat-revenue at risk. Includes a data-readiness gate so
we never emit customer insights on stores whose customer_id is a system bucket.
"""
from __future__ import annotations

import re
from datetime import date

from ..config import CUSTOMERS, CustomerThresholds
from . import no_sales

# Payment-instrument / placeholder labels that are NOT contactable people.
# FULL-NAME match: a name is a non-person only when the WHOLE name is made of
# these labels (plus filler like "customer"/"sale"). The earlier word-boundary
# version excluded real people whose names contain a label word — "John Cash",
# "Christopher Guest", "Na Kim" — because \b(cash|guest|n/?a)\b matched inside
# the name. "CASH", "Cash Customer" or "Walk-In" still match; any name with a
# non-label word in it does not. The anchored pattern needs no word boundaries,
# so the same body works verbatim in Postgres `~*`.
# Mirrored in sql_checks/storeagent_checks.sql, sql_checks/verify_all.py and
# the generated frontend checkSql.js — keep all of them in sync.
_NON_PERSON = re.compile(
    r"^[\s\-\./,]*("
    r"(visa|master ?card|amex|american express|discover|credit|debit|"
    r"card ?holder|cash|gift ?card|walk[ -]?in|guest|default|unknown|n/?a|"
    r"manual(ly)?[ -]?(entered|entry)|no ?name|house ?account|"
    r"customer|account|acct|sale|payment)"
    r"[\s\-\./,]*)+$", re.I)


def _f(x) -> float:
    return float(x) if x is not None else 0.0


def is_real_person(name: str | None) -> bool:
    """A null name is fine (real, just unnamed); an explicit payment label is not."""
    return not (name and _NON_PERSON.search(name))


def data_readiness(rows: list[dict], t: CustomerThresholds = CUSTOMERS) -> dict:
    """Decide whether this store has real per-person customer data.

    Tiers instead of all-or-nothing: a store with a few hundred genuinely
    tracked customers still gets win-back over those customers ("partial"),
    clearly labeled, rather than a blank tab. A dominant system bucket
    (one id holding most visits) always disqualifies: those ids aren't people.
    """
    distinct = len(rows)
    total_visits = sum(int(_f(r["visits"])) for r in rows) or 1
    top_share = max((int(_f(r["visits"])) for r in rows), default=0) / total_visits
    reason = None
    if top_share > t.bucket_dominance_pct:
        tier = "none"
        reason = f"one id holds {top_share:.0%} of visits (looks like a system bucket)"
    elif distinct >= t.min_distinct_customers:
        tier = "full"
    elif distinct >= t.min_partial_customers:
        tier = "partial"
    else:
        tier = "none"
        reason = f"only {distinct} distinct customers (need >= {t.min_partial_customers})"
    return {"ok": tier != "none", "tier": tier,
            "distinct_customers": distinct, "reason": reason}


def engagement_profile(ctx: dict, distinct_customers: int,
                       t: CustomerThresholds = CUSTOMERS) -> dict:
    """Shape the no-CRM fallback (pure; input from fetch_engagement_context).

    Two jobs: make the unlock measurable (tracked customers vs the threshold,
    share of sales with a customer attached, whether a contact book already
    exists in the POS), and give the page real anonymous value (busiest days
    and hours, ticket profile) so it is never blank.
    """
    cap = ctx.get("capture") or {}
    sales_90d = int(_f(cap.get("sales_90d")))
    book = ctx.get("contact_book") or {}
    lines = ctx.get("lines") or {}
    baskets = int(_f(lines.get("baskets")))
    top_hours = sorted(ctx.get("by_hour") or [],
                       key=lambda r: int(_f(r.get("tx"))), reverse=True)
    return {
        "needed_customers": t.min_partial_customers,
        "tracked_customers": distinct_customers,
        "sales_90d": sales_90d,
        "linked_pct_90d": (round(100 * _f(cap.get("linked_90d")) / sales_90d, 1)
                           if sales_90d else None),
        "avg_ticket": (round(_f(cap.get("avg_ticket")), 2)
                       if cap.get("avg_ticket") is not None else None),
        "single_item_pct": (round(100 * _f(lines.get("single_item")) / baskets, 1)
                            if baskets else None),
        "contact_book": {
            "contacts": int(_f(book.get("contacts"))),
            "named": int(_f(book.get("named"))),
            "with_phone": int(_f(book.get("with_phone"))),
            "with_email": int(_f(book.get("with_email"))),
        },
        # isodow 1=Mon..7=Sun; revenue drives the day bars in the UI.
        "by_day": [{"dow": int(_f(r.get("dow"))), "tx": int(_f(r.get("tx"))),
                    "revenue": round(_f(r.get("revenue")), 2)}
                   for r in ctx.get("by_day") or []],
        "top_hours": [{"hour": int(_f(r.get("hour"))), "tx": int(_f(r.get("tx")))}
                      for r in top_hours[:4]],
    }


def _enrich_customer(r: dict, as_of: date, t: CustomerThresholds) -> dict:
    visits = int(_f(r["visits"]))
    spend = _f(r["spend"])
    first, last = r["first_visit"], r["last_visit"]
    span = max((last - first).days, 0)
    cadence = (span / (visits - 1)) if visits >= 2 else None      # avg days between visits
    recency = (as_of - last).days
    annual_value = round(spend / max(span, t.min_active_span_days) * 365, 2)

    is_regular = visits >= t.min_regular_visits
    churn_gap = max(t.churn_min_days, (cadence or 0) * t.churn_cadence_multiple)
    # "At risk" = an established regular who broke their cadence RECENTLY (still winnable).
    is_at_risk = (is_regular and cadence is not None
                  and recency > churn_gap and recency <= t.recent_lapse_days)

    if visits == 1:
        seg = "one_timer"
    elif is_at_risk:
        seg = "at_risk"
    elif is_regular and recency > t.recent_lapse_days and recency <= t.winback_lookback_days:
        seg = "lost"                       # regular, but gone too long to be "walking out"
    elif recency > t.winback_lookback_days:
        seg = "lapsed"
    elif visits >= 20:
        seg = "champion"
    elif is_regular:
        seg = "loyal"
    else:
        seg = "occasional"

    return {
        "customer_id": r["customer_id"], "name": r["name"],
        "has_contact": bool(r.get("has_contact")),
        "visits": visits, "spend": round(spend, 2),
        "first_visit": first.isoformat(), "last_visit": last.isoformat(),
        "cadence_days": round(cadence, 1) if cadence is not None else None,
        "days_since_last": recency, "annual_value": annual_value,
        "segment": seg, "at_risk": is_at_risk,
    }


def customer_radar(rows: list[dict], as_of: date | None,
                   t: CustomerThresholds = CUSTOMERS,
                   favorites: dict[str, str] | None = None, top_n: int = 500,
                   book_counts: dict | None = None) -> dict:
    # NO SALES AT ALL: `store_as_of` is None, and both returns below call
    # `as_of.isoformat()`. This raised AttributeError on every one of the 111
    # stores (of 212) with no `sales` rows, and the owner read the traceback
    # text on the page where the figures should have been. Every recency in
    # here is measured FROM as_of, so without one there is nothing to compute
    # and nothing to say except that the feed has sent nothing yet.
    if as_of is None:
        return no_sales.unavailable(as_of=None, status="no_sales",
                                    distinct_customers=0)
    readiness = data_readiness(rows, t)
    if not readiness["ok"]:
        return {"as_of": as_of.isoformat(), "available": False,
                "status": "insufficient_data",
                "reason": readiness["reason"], "distinct_customers": readiness["distinct_customers"]}

    persons = [r for r in rows if is_real_person(r["name"])]
    non_person_excluded = len(rows) - len(persons)
    enriched = [_enrich_customer(r, as_of, t) for r in persons]
    # The headline counts span the WHOLE contact book when the caller passes
    # book_counts (fetch_customer_book_counts): "contactable" = everyone with a
    # phone or email on file, purchased or not — they are reachable all the
    # same; "book" = every saved customer. Everything else (segments, win-back,
    # top customers) still spans all real people WITH sales history — a lapsed
    # regular without a phone number is still worth knowing about; the store
    # may recognise them at the counter. Old callers/tests that pass no
    # book_counts fall back to the buyers-only contactable count.
    contactable = [c for c in enriched if c["has_contact"]]
    bc = book_counts or {}
    seg_counts: dict[str, int] = {}
    for c in enriched:
        seg_counts[c["segment"]] = seg_counts.get(c["segment"], 0) + 1
    # Saved-but-never-purchased customers get their own segment so the segment
    # cards account for (almost) the whole book: buyers split by behavior plus
    # this bucket equals All Customers, minus only the payment-label ids.
    if bc.get("no_sales"):
        seg_counts["no_sales"] = bc["no_sales"]

    top_customers = sorted(enriched, key=lambda c: c["spend"], reverse=True)[:top_n]
    at_risk = [c for c in enriched if c["at_risk"]]
    at_risk.sort(key=lambda c: c["annual_value"], reverse=True)
    win_back = at_risk[:top_n]
    if favorites:
        for c in win_back:
            c["favorite_category"] = favorites.get(c["customer_id"])

    return {
        "as_of": as_of.isoformat(),
        "available": True,
        # healthy = real customer data and no lapsed regulars (a good result,
        # not a broken tab); partial coverage means insights span only the
        # store's tracked customers and the UI should say so.
        "status": "healthy" if not at_risk else "opportunities",
        "coverage": readiness["tier"],
        # Contactable Customers card: book-wide when available (see above).
        "total_customers": bc.get("contactable", len(contactable)),
        # All Customers card: every customer saved in the POS book, purchased
        # or not. None for old callers without book_counts (UI falls back).
        "book_customers": bc.get("book"),
        # tracked = every real person with sales history (the population behind
        # segments/lists); no_contact = tracked without a phone or email.
        "tracked_customers": len(enriched),
        "no_contact_customers": len(enriched) - len(contactable),
        "non_person_excluded": non_person_excluded,
        "segments": seg_counts,
        "at_risk_count": len(at_risk),
        # The actionable subset: at-risk regulars with a phone or email on
        # file — the ones the store can reach today (Reachable At Risk card).
        "reachable_at_risk": sum(1 for c in at_risk if c["has_contact"]),
        "annual_revenue_at_risk": round(sum(c["annual_value"] for c in at_risk), 2),
        "top_customers": top_customers,
        "win_back": win_back,
    }
