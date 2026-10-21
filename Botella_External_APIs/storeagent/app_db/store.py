"""App-database access: schema init + run persistence."""
from __future__ import annotations

from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from ..config import APP_DB
from ..functions.models import InventoryDataset

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def app_conn(dbname: str | None = None) -> psycopg.Connection:
    return psycopg.connect(**APP_DB.kwargs(dbname))


def init_schema() -> None:
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    with app_conn() as conn, conn.cursor() as cur:
        cur.execute(sql)
        conn.commit()


def persist_run(result: dict, dataset: InventoryDataset) -> int:
    """Persist one inventory run + its dead-item findings; returns run_id."""
    init_schema()  # idempotent; keeps Phase 1 zero-step

    vc = result["velocity_classes"]
    cls = vc["classes"]
    fc = result["frozen_capital"]
    ds = result["dead_stock"]

    with app_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO inventory_runs (
                client_id, location_id, as_of, generated_at,
                total_skus, total_inventory_value_at_cost, frozen_capital_dead,
                frozen_pct, slow_capital, dead_sku_count, actionable_sku_count,
                actionable_frozen_capital, fast_count, normal_count, slow_count,
                dead_count, never_count, briefing, payload)
            VALUES (%s,%s,%s,%s, %s,%s,%s, %s,%s,%s,%s, %s,%s,%s,%s, %s,%s,%s,%s)
            RETURNING run_id
            """,
            (
                result["client_id"], result["location_id"], result["as_of"],
                result["generated_at"],
                vc["total_skus"], fc["total_inventory_value_at_cost"],
                fc["frozen_capital_dead"], fc["frozen_pct_of_inventory"],
                fc["slow_capital"], ds["dead_sku_count"], ds["actionable_sku_count"],
                ds["actionable_frozen_capital"],
                cls["fast"]["sku_count"], cls["normal"]["sku_count"],
                cls["slow"]["sku_count"], cls["dead"]["sku_count"],
                cls["never_sold"]["sku_count"],
                result["briefing"],
                Jsonb({k: v for k, v in result.items() if k != "briefing"}),
            ),
        )
        run_id = cur.fetchone()[0]

        rows = []
        for bucket, items in (("actionable", ds["items"]),
                              ("premium_hold", ds["premium_hold_items"])):
            for rank, it in enumerate(items, 1):
                rows.append((run_id, bucket, rank, it["sku"], it["product_name"],
                             it["category"], it["on_hand"], it["unit_cost"],
                             it["frozen_capital"], it["days_since_last_sale"],
                             it["class"], it["is_premium"], it["suggested_action"]))
        if rows:
            cur.executemany(
                """
                INSERT INTO inventory_dead_items (
                    run_id, bucket, rank, sku, product_name, category, on_hand,
                    unit_cost, frozen_capital, days_since_last_sale, velocity_class,
                    is_premium, suggested_action)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """, rows)
        conn.commit()
    return run_id
