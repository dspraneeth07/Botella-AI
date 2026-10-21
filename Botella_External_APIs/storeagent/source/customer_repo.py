"""Per-customer aggregates for the Win-Back Radar.

From `sales` (joined to `customers` for names), VOID excluded. One row per
customer with visit cadence inputs. Favorite-category lookup is bounded to a
shortlist (the win-back list) to keep it cheap.
"""
from __future__ import annotations

from datetime import date

from ..canonical.category import canonicalize_category
from ..functions.customers import _NON_PERSON
from .connector import SourceDB
from .inventory_repo import _as_of, _void_sale_ids
from .sku_key import products_join


def store_as_of(db: SourceDB, client_id: int) -> date | None:
    return _as_of(db, client_id)


def fetch_customer_book_counts(db: SourceDB, client_id: int) -> dict:
    """Whole-book counts from `customers` (non-deleted), REAL PEOPLE only:
    payment-instrument placeholder rows ("Cash Customer", "Walk-In", card
    types...) are excluded with the same anchored name pattern the radar's
    is_real_person uses (it works verbatim in Postgres ~*), so the All
    Customers card reconciles with the segment cards to the digit. Unnamed
    rows stay counted — a missing name doesn't make someone a placeholder.
    `book` = all such rows; `contactable` = those with a phone or email on
    file — the audience the store can actually reach; `no_sales` = those never
    attached to a (non-VOID) sale, surfaced as the "Without Sales" segment."""
    row = db.fetch_one(
        """
        SELECT count(*) AS book,
               count(*) FILTER (WHERE COALESCE(c.contact_phone, '') <> ''
                                 OR COALESCE(c.contact_email, '') <> '') AS contactable,
               count(*) FILTER (WHERE b.customer_id IS NULL) AS no_sales
        FROM customers c
        LEFT JOIN (SELECT DISTINCT customer_id FROM sales
                   WHERE client_id = %(cid)s AND customer_id <> ''
                     AND sale_status <> 'VOID') b
               ON b.customer_id = c.customer_id
        WHERE c.client_id = %(cid)s AND COALESCE(c.is_deleted, false) = false
          AND (COALESCE(c.customer_name, '') = ''
               OR c.customer_name !~* %(nonp)s)
        """, {"cid": client_id, "nonp": _NON_PERSON.pattern})
    return {"book": int(row["book"] or 0) if row else 0,
            "contactable": int(row["contactable"] or 0) if row else 0,
            "no_sales": int(row["no_sales"] or 0) if row else 0}


def fetch_customer_rows(db: SourceDB, client_id: int) -> list[dict]:
    return db.fetch_all(
        """
        SELECT s.customer_id,
               max(c.customer_name)                       AS name,
               COALESCE(bool_or(COALESCE(c.contact_phone, '') <> ''
                                OR COALESCE(c.contact_email, '') <> ''),
                        false)                            AS has_contact,
               count(DISTINCT s.sale_date::date)          AS visits,
               count(*)                                   AS txns,
               min(s.sale_date)::date                     AS first_visit,
               max(s.sale_date)::date                     AS last_visit,
               -- Receipt-subtotal basis (pre-tax net), matching every other
               -- surface's revenue figures; total_amount is blank on about
               -- one receipt in twenty and tax-inclusive besides
               -- (backend/lib/metrics.js "Fix 0").
               --
               -- NO PER-CENT SIGN IN THIS COMMENT, and not a style rule:
               -- psycopg binds parameters by scanning the whole query string
               -- and does not understand SQL comments, so the one that used
               -- to sit in this sentence was an incomplete placeholder and
               -- this query raised every single time it ran. The Customers
               -- screen served a payload cached on 16 September for a month
               -- while it did. Double the sign if a literal is ever needed.
               sum(s.sub_total)                           AS spend
        FROM sales s
        LEFT JOIN customers c
               ON c.client_id = s.client_id AND c.customer_id = s.customer_id
              AND COALESCE(c.is_deleted, false) = false
        WHERE s.client_id = %s AND s.customer_id <> '' AND s.sale_status <> 'VOID'
        GROUP BY s.customer_id
        """, (client_id,))


def fetch_contactable_count(db: SourceDB, client_id: int) -> int:
    """Book-wide "Customer Base": every non-deleted, real-person customer with
    a phone or email on file, whether or not they have ever been attached to a
    sale. The non-person filter reuses _NON_PERSON verbatim (its anchored body
    is valid Postgres `~*` syntax), so the two layers cannot drift."""
    row = db.fetch_one(
        """
        SELECT count(*) AS n
        FROM customers
        WHERE client_id = %s
          AND COALESCE(is_deleted, false) = false
          AND (COALESCE(contact_phone, '') <> '' OR COALESCE(contact_email, '') <> '')
          AND (customer_name IS NULL OR customer_name !~* %s)
        """, (client_id, _NON_PERSON.pattern))
    return int(row["n"] or 0) if row else 0


def fetch_favorite_categories(db: SourceDB, client_id: int,
                              customer_ids: list[str]) -> dict[str, str]:
    if not customer_ids:
        return {}
    # Join by the store's detected product key (sku vs upc) — a plain p.sku join
    # returns zero rows on UPC-keyed stores and every favorite goes blank.
    rows = db.fetch_all(
        f"""
        SELECT s.customer_id, p.category, p.product_name, sum(si.quantity) AS units
        FROM sales s
        JOIN sale_items si ON si.client_id = s.client_id AND si.sale_id = s.sale_id
        {products_join("sku, upc, product_name, category", cid_param="c")}
        WHERE s.client_id = %(c)s AND s.customer_id = ANY(%(ids)s::text[])
          AND s.sale_status <> 'VOID'
        GROUP BY s.customer_id, p.category, p.product_name
        """, {"c": client_id, "ids": customer_ids})
    tally: dict[str, dict[str, float]] = {}
    for r in rows:
        cat = canonicalize_category(r["category"], r["product_name"])
        tally.setdefault(r["customer_id"], {})
        tally[r["customer_id"]][cat] = tally[r["customer_id"]].get(cat, 0.0) + float(r["units"] or 0)
    return {cid: max(cats, key=cats.get) for cid, cats in tally.items() if cats}


def fetch_engagement_context(db: SourceDB, client_id: int) -> dict:
    """What the Customers page can still say when per-person CRM is gated:
    how much identity capture is happening at the register, whether a contact
    book already exists in the POS (it often does — tens of thousands of named
    rows in `customers` while `sales.customer_id` stays empty or a bucket),
    and anonymous shopper patterns (sale timestamps carry real time-of-day
    across this warehouse). Only fetched when the win-back gate fails."""
    # linked_90d counts sales attached to an INDIVIDUAL customer. Bucket-POS
    # stores stamp every sale with one generic house account ("CASH"), which
    # would read as 100% linked while the store tracks nobody — so ids holding
    # an outsized share of the linked sales (same dominance idea as the
    # readiness gate, floored at 90 = a daily visitor's 90-day max) don't count.
    capture = db.fetch_one(
        """
        WITH w AS (
            SELECT customer_id, sub_total
            FROM sales
            WHERE client_id = %s AND sale_status <> 'VOID'
              AND sale_date >= now() - interval '90 days'
        ), linked AS (
            SELECT customer_id, count(*) AS n
            FROM w WHERE customer_id <> '' GROUP BY customer_id
        )
        SELECT (SELECT count(*) FROM w)          AS sales_90d,
               (SELECT avg(sub_total) FROM w)    AS avg_ticket,
               COALESCE((SELECT sum(n) FROM linked
                         WHERE n <= greatest(0.2 * (SELECT sum(n) FROM linked), 90)),
                        0)                       AS linked_90d
        """, (client_id,))

    contact_book = db.fetch_one(
        """
        SELECT count(*)                                                  AS contacts,
               count(*) FILTER (WHERE COALESCE(customer_name, '') <> '') AS named,
               count(*) FILTER (WHERE COALESCE(contact_phone, '') <> '') AS with_phone,
               count(*) FILTER (WHERE COALESCE(contact_email, '') <> '') AS with_email
        FROM customers
        WHERE client_id = %s AND COALESCE(is_deleted, false) = false
        """, (client_id,))

    by_day = db.fetch_all(
        """
        SELECT extract(isodow FROM sale_date)::int AS dow,
               count(*) AS tx, sum(sub_total) AS revenue
        FROM sales
        WHERE client_id = %s AND sale_status <> 'VOID'
          AND sale_date >= now() - interval '90 days'
        GROUP BY 1 ORDER BY 1
        """, (client_id,))

    by_hour = db.fetch_all(
        """
        SELECT extract(hour FROM sale_date)::int AS hour, count(*) AS tx
        FROM sales
        WHERE client_id = %s AND sale_status <> 'VOID'
          AND sale_date >= now() - interval '90 days'
        GROUP BY 1 ORDER BY 1
        """, (client_id,))

    lines = db.fetch_one(
        """
        SELECT count(*) AS baskets, count(*) FILTER (WHERE lines = 1) AS single_item
        FROM (
            SELECT si.sale_id, count(DISTINCT si.sku) AS lines
            FROM sale_items si
            WHERE si.client_id = %(cid)s AND si.quantity > 0
              AND si.sale_id IS NOT NULL
              AND si.sale_date >= now() - interval '90 days'
              AND NOT (si.sale_id = ANY(%(void)s::text[]))
            GROUP BY si.sale_id
        ) t
        """, {"cid": client_id, "void": _void_sale_ids(db, client_id)})

    return {"capture": capture, "contact_book": contact_book,
            "by_day": by_day, "by_hour": by_hour, "lines": lines}
