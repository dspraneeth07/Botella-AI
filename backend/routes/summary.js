const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');
const { toSafeError } = require('../utils/errors');
const { completedSaleDaySql } = require('../helpers/completedSaleDay');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// GET /api/summary  (?quick=1 → just the day's revenue/profit/top sellers)
router.get('/', async (req, res) => {
  const pool = req.pool;
  const clientId = req.user.client_id;
  const locationId = req.user.location_id;
  // Quick mode (the login digest): return only the day's numbers and skip the
  // heavy slow-inventory scan + the AI-suggestion LLM call, which together can
  // blow the statement timeout. The dashboard's DailySummary uses the full form.
  const quick = ['1', 'true'].includes(String(req.query.quick || ''));
  // `prev` is accepted for backward compatibility (the login digest sends
  // prev=1) but both modes now anchor identically - see below.

  try {
    // 1. Find the anchor sales date: the most recent COMPLETED day, in every
    //    mode. All surfaces (this report, the Dashboard, chat) must never show
    //    a still-filling current day - see helpers/completedSaleDay.js, which
    //    also handles the two cases the old 6-hour freshness heuristic got
    //    wrong (midnight boundary artifacts establishing an empty "today", and
    //    the lagging-feed store-171 case that heuristic was built for).
    //    The anchor is resolved INSIDE each query as a CTE (cheap MAX via
    //    index), so the whole quick path is TWO round trips, fully parallel -
    //    this endpoint feeds the login popup's headline numbers.
    const anchorSql = `SELECT (${completedSaleDaySql()}) AS d`;

    // 2. That day's summary. Profit uses products.cost - sale_items.cost is
    //    unreliable (0). De-dupe per line item so a line that matches more than one
    //    product row isn't double-counted. Date predicate is a half-open range
    //    (>= day AND < next day) so it stays sargable / index-able instead of
    //    casting sale_date::date on every row.
    const [salesResult, topProducts] = await Promise.all([
      pool.query(`
      WITH anchor AS (${anchorSql}),
      -- Normalize the product keys ONCE (sku + upc collapsed into one column) so the
      -- product link is a plain hash join on equality. The old form
      --   LEFT JOIN products p ON (TRIM(p.sku)=TRIM(si.sku) OR TRIM(p.upc)=TRIM(si.sku))
      -- could not use any index (TRIM wrappers + OR) and re-scanned the whole catalog
      -- once per sale line: 26M comparisons / ~15s on the 20k-SKU stores, which blew
      -- BOTH the login digest's fetch timeout and the pool's statement_timeout - so the
      -- popup rendered "-" and "No sales recorded." for the 8 biggest stores. Same shape
      -- dashboard.js buildPanelsSql already uses, so the Daily Report and the Dashboard
      -- agree by construction. src=0 (sku) beats src=1 (upc) - the precedence the old
      -- CASE tie-break encoded. Verified identical on all 101 stores across every
      -- aggregate below (revenue / units / profit / rev_costed / cogs_costed).
      prod_keys AS (
        SELECT TRIM(sku) AS pk, 0 AS src, cost FROM products
          WHERE client_id = $1 AND location_id = $2 AND NULLIF(TRIM(sku), '') IS NOT NULL
        UNION ALL
        SELECT TRIM(upc) AS pk, 1 AS src, cost FROM products
          WHERE client_id = $1 AND location_id = $2 AND NULLIF(TRIM(upc), '') IS NOT NULL
      ),
      matched AS (
        SELECT si.id, si.total_amount, si.quantity, k.cost,
               ROW_NUMBER() OVER (PARTITION BY si.id ORDER BY k.src) AS rn
        FROM sale_items si
        LEFT JOIN prod_keys k ON k.pk = TRIM(si.sku)
        WHERE si.sale_date >= (SELECT d FROM anchor)
          AND si.sale_date < ((SELECT d FROM anchor) + INTERVAL '1 day')
          AND si.client_id = $1 AND si.location_id = $2
      ),
      -- Headline revenue on the RECEIPT-SUBTOTAL basis (sales.sub_total,
      -- pre-tax net) - the SAME basis the Dashboard KPI (dashboard.js) and
      -- chat's get_sales_on_day/get_revenue report, so the popup, Dashboard,
      -- and chat can never disagree on the day's revenue. Line-item
      -- total_amount runs ~0.5% higher (tax/rounding) and had the popup
      -- showing 7,480 where every other surface said 7,440 (store 171).
      receipt AS (
        SELECT COUNT(*) AS tx, COALESCE(SUM(s.sub_total), 0) AS revenue
        FROM sales s, anchor a
        WHERE s.sale_date >= a.d AND s.sale_date < (a.d + INTERVAL '1 day')
          AND s.client_id = $1 AND s.location_id = $2
      )
      SELECT
        (SELECT d FROM anchor) AS last_date,
        (SELECT tx FROM receipt) as total_transactions,
        (SELECT revenue FROM receipt) as total_revenue,
        COALESCE(SUM(quantity), 0) as total_units,
        COALESCE(SUM(total_amount) - SUM(CASE WHEN cost > 0 AND cost*quantity <= 1.5*total_amount
                                              THEN cost*quantity ELSE 0 END), 0) as total_profit,
        -- Costed-subset aggregates for gross margin - the SAME definition the
        -- Dashboard / chat get_margin / StoreAgent overview use: lines with no
        -- recorded cost are EXCLUDED (COALESCE(cost,0) would book them as
        -- 100%-margin and inflate the figure the user cross-checks).
        -- COST SANITY (matches dashboard.js buildPanelsSql): a recorded cost
        -- above 1.5× the line's own realized value is pack-size corruption
        -- (store 177 keeps case costs in the unit field, driving margin to
        -- −666%) and is treated as unrecorded.
        COALESCE(SUM(total_amount) FILTER (WHERE cost > 0 AND cost*quantity <= 1.5*total_amount), 0) as rev_costed,
        COALESCE(SUM(cost * quantity) FILTER (WHERE cost > 0 AND cost*quantity <= 1.5*total_amount), 0) as cogs_costed
      FROM matched WHERE rn = 1
    `, [clientId, locationId]),
      pool.query(`
      WITH anchor AS (${anchorSql})
      SELECT si.product_name as name, si.sku, SUM(si.quantity) as units, SUM(si.total_amount) as revenue
      FROM sale_items si, anchor a
      WHERE si.sale_date >= a.d AND si.sale_date < (a.d + INTERVAL '1 day')
        AND si.client_id = $1 AND si.location_id = $2
      GROUP BY si.product_name, si.sku
      ORDER BY units DESC
      LIMIT 5
    `, [clientId, locationId]),
    ]);

    const lastDate = salesResult.rows[0]?.last_date;
    if (!lastDate) {
      return res.json({ sales: null, slow_inventory: [], suggestions: [] });
    }

    // Gross margin over the day's costed subset, gated exactly like the
    // Dashboard (routes/dashboard.js shapePanels): <5% of revenue costed →
    // margin can't be computed; 5-95% → close estimate; ≥95% → clean. Same
    // formula everywhere so the daily report and the Dashboard agree by
    // construction (they can still differ by PERIOD - this is one day, the
    // Dashboard panel is all-time/30d - but never by definition).
    const row = salesResult.rows[0];
    const revCosted = parseFloat(row.rev_costed) || 0;
    const cogsCosted = parseFloat(row.cogs_costed) || 0;
    const totalRevenue = parseFloat(row.total_revenue) || 0;
    const marginCostedPct = totalRevenue > 0 ? Math.round((100 * revCosted / totalRevenue) * 10) / 10 : 0;
    let grossMarginPct = null;
    let marginNote = null;
    if (marginCostedPct < 5) {
      marginNote = "Product cost isn't recorded for this store, so gross margin can't be computed.";
    } else {
      grossMarginPct = revCosted > 0
        ? Math.round((100 * (revCosted - cogsCosted) / revCosted) * 10) / 10 : null;
      if (marginCostedPct < 95) {
        marginNote = `Based on the ${marginCostedPct}% of the day's sales that have a cost recorded, treat as a close estimate.`;
      }
    }

    const sales = {
      date: lastDate,
      total_transactions: parseInt(salesResult.rows[0].total_transactions) || 0,
      total_revenue: parseFloat(salesResult.rows[0].total_revenue) || 0,
      total_units: parseInt(salesResult.rows[0].total_units) || 0,
      total_profit: parseFloat(salesResult.rows[0].total_profit) || 0,
      gross_margin_pct: grossMarginPct,
      margin_note: marginNote,
      margin_costed_pct: marginCostedPct,
      top_products: topProducts.rows.map(r => ({
        name: r.name,
        sku: r.sku,
        units: parseInt(r.units),
        revenue: parseFloat(r.revenue),
      })),
    };

    // Quick mode stops here - the popup only needs the day's headline numbers.
    if (quick) {
      return res.json({ sales, slow_inventory: [], suggestions: [] });
    }

    // 4. Slow-moving inventory (60+ days without a sale). This is the heavy scan;
    //    never let it sink the whole response - degrade to an empty list on
    //    timeout/error so revenue/profit still return.
    let slowItems = [];
    try {
      const slowInventory = await pool.query(`
        WITH last_sales AS (
          SELECT TRIM(si.sku) AS k, MAX(si.sale_date::date) AS last_sale_date
          FROM sale_items si
          WHERE si.client_id = $1 AND si.location_id = $2
          GROUP BY TRIM(si.sku)
        ),
        anchor AS (
          SELECT MAX(sale_date::date) AS today FROM sale_items WHERE client_id = $1 AND location_id = $2
        ),
        -- Same normalization as the day-summary query above: two equality joins
        -- instead of a LATERAL that re-scanned last_sales per product with an OR
        -- predicate. That form burned the FULL 15s statement_timeout on EVERY store
        -- (Zeke's included) and was swallowed by the catch below, so this panel had
        -- been silently empty fleet-wide while still costing ~15s per request.
        -- Verified: derives an identical last_sale_date for every product across 15
        -- stores, including those with blank sku/upc keys.
        prod_keys AS (
          SELECT id, TRIM(sku) AS pk FROM products
            WHERE client_id = $1 AND location_id = $2 AND NULLIF(TRIM(sku), '') IS NOT NULL
          UNION ALL
          SELECT id, TRIM(upc) AS pk FROM products
            WHERE client_id = $1 AND location_id = $2 AND NULLIF(TRIM(upc), '') IS NOT NULL
        ),
        prod_last AS (
          SELECT k.id, MAX(ls.last_sale_date) AS last_sale_date
          FROM prod_keys k
          JOIN last_sales ls ON ls.k = k.pk
          GROUP BY k.id
        )
        SELECT p.sku, p.product_name as name, p.cost, p.category,
          p.stock_qty as total_units,
          pl.last_sale_date,
          a.today - pl.last_sale_date AS days_since_sale
        FROM products p
        CROSS JOIN anchor a
        LEFT JOIN prod_last pl ON pl.id = p.id
        WHERE p.client_id = $1 AND p.location_id = $2
          AND p.stock_qty > 0
          AND (pl.last_sale_date IS NULL OR pl.last_sale_date < a.today - INTERVAL '60 days')
        ORDER BY COALESCE(a.today - pl.last_sale_date, 99999) DESC
        LIMIT 10
      `, [clientId, locationId]);

      slowItems = slowInventory.rows.map(r => ({
        sku: r.sku,
        name: r.name?.trim(),
        cost: parseFloat(r.cost || 0),
        category: r.category?.trim() || 'Unknown',
        total_units: parseInt(r.total_units),
        last_sale_date: r.last_sale_date || 'Never sold',
        days_since_sale: r.last_sale_date ? parseInt(r.days_since_sale) : null,
      }));
    } catch (slowErr) {
      logger.warn('Summary slow-inventory skipped', { error: slowErr.message, clientId, locationId });
    }

    // 5. Generate AI suggestions for slow inventory
    let suggestions = [];
    if (slowItems.length > 0) {
      try {
        const itemList = slowItems.map(i =>
          `${i.name} (${i.category}) - $${i.cost} cost, ${i.total_units} units, ${i.days_since_sale ? i.days_since_sale + ' days without sale' : 'never sold'}`
        ).join('\n');

        const aiResponse = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 512,
          messages: [{
            role: 'user',
            content: `You are a liquor store business advisor. These products have been sitting in inventory for 2+ months without a sale. Give exactly 4 short, practical suggestions to help sell them faster without losing 100% of the margin. Consider bundling, discounts, displays, and promotions. Be specific using the product names.\n\nSlow inventory:\n${itemList}\n\nRespond with just 4 bullet points, no intro or outro.`,
          }],
        });

        const aiText = aiResponse.content[0]?.text || '';
        suggestions = aiText
          .split('\n')
          .map(l => l.replace(/^[-•*]\s*/, '').trim())
          .filter(l => l.length > 10)
          .slice(0, 4);

        // One-number rule for the popup: advisory figures (percent discounts,
        // "buy 2 get 1") are the model's to suggest, but FACTUAL numbers -
        // costs, unit counts, day counts - must come from the rows we fed it.
        // A bullet quoting a number the data can't justify is dropped rather
        // than shown as fact.
        const factNums = new Set();
        for (const i of slowItems) {
          for (const v of [i.cost, i.total_units, i.days_since_sale]) {
            const n = Number(v);
            if (v != null && Number.isFinite(n)) { factNums.add(n); factNums.add(Math.round(n)); }
          }
          for (const m of String(i.name || '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
            factNums.add(Number(m[0].replace(/,/g, '')));
          }
        }
        const grounded = (line) => {
          // Percent expressions ("10-15% off", "50%") are advice, not facts.
          const stripped = line.replace(/\d[\d,]*(?:\.\d+)?\s*(?:-|-|to)\s*\d[\d,]*(?:\.\d+)?\s*%|\d[\d,]*(?:\.\d+)?\s*%/g, ' ');
          for (const m of stripped.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
            const n = Number(m[0].replace(/,/g, ''));
            if (!Number.isFinite(n)) continue;
            if (Number.isInteger(n) && n <= 12) continue; // "buy 2 get 1", "top 3"
            if (!factNums.has(n) && !factNums.has(Math.round(n))) return false;
          }
          return true;
        };
        const kept = suggestions.filter(grounded);
        if (kept.length < suggestions.length) {
          logger.warn('Summary suggestions dropped (ungrounded numbers)', {
            clientId, locationId, dropped: suggestions.length - kept.length,
          });
        }
        suggestions = kept;
      } catch (aiErr) {
        console.error('AI suggestion error:', aiErr.message);
        suggestions = [
          'Create a "Clearance Shelf" display near the register for slow-moving items',
          'Bundle slow items with popular products at a 10-15% combo discount',
          'Offer "Buy 2 Get 1 at 50% Off" on products sitting longest',
          'Run a weekend tasting event to introduce customers to these products',
        ];
      }
    }

    res.json({ sales, slow_inventory: slowItems, suggestions });
  } catch (err) {
    const safeErr = toSafeError(err);
    logger.error('Summary load failed', { error: err.message, clientId, locationId });
    res.status(safeErr.statusCode).json({ error: { code: safeErr.code, message: safeErr.userMessage } });
  }
});

module.exports = router;
