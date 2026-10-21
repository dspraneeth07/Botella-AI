-- StoreAgent app database schema (Phase 1: Inventory Intelligence).
-- The source `syncgo` DB is read-only; everything the system produces lands here.

CREATE TABLE IF NOT EXISTS inventory_runs (
    run_id                         bigserial PRIMARY KEY,
    client_id                      integer       NOT NULL,
    location_id                    integer       NOT NULL,
    as_of                          date          NOT NULL,
    generated_at                   timestamptz   NOT NULL,
    total_skus                     integer,
    total_inventory_value_at_cost  numeric(18,2),
    frozen_capital_dead            numeric(18,2),
    frozen_pct                     numeric(6,2),
    slow_capital                   numeric(18,2),
    dead_sku_count                 integer,
    actionable_sku_count           integer,
    actionable_frozen_capital      numeric(18,2),
    fast_count                     integer,
    normal_count                   integer,
    slow_count                     integer,
    dead_count                     integer,
    never_count                    integer,
    briefing                       text,
    payload                        jsonb         NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_runs_store
    ON inventory_runs (client_id, location_id, as_of DESC);

CREATE TABLE IF NOT EXISTS inventory_dead_items (
    run_id                bigint  NOT NULL REFERENCES inventory_runs(run_id) ON DELETE CASCADE,
    bucket                text    NOT NULL,           -- 'actionable' | 'premium_hold'
    rank                  integer NOT NULL,
    sku                   text,
    product_name          text,
    category              text,
    on_hand               integer,
    unit_cost             numeric(18,4),
    frozen_capital        numeric(18,2),
    days_since_last_sale  integer,
    velocity_class        text,
    is_premium            boolean,
    suggested_action      text
);

CREATE INDEX IF NOT EXISTS idx_dead_items_run
    ON inventory_dead_items (run_id, bucket, rank);
