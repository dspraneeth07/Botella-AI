const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');
const { toSafeError } = require('../utils/errors');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Shared SQL: enriched dead stock query with 30/60/90 day movement ──
const DEAD_STOCK_SQL = `
  WITH movement AS (
    SELECT si.sku,
      SUM(CASE WHEN si.sale_date::date >= CURRENT_DATE - INTERVAL '30 days' THEN si.quantity ELSE 0 END) as units_30d,
      SUM(CASE WHEN si.sale_date::date >= CURRENT_DATE - INTERVAL '60 days' THEN si.quantity ELSE 0 END) as units_60d,
      SUM(CASE WHEN si.sale_date::date >= CURRENT_DATE - INTERVAL '90 days' THEN si.quantity ELSE 0 END) as units_90d,
      MAX(si.sale_date::date) as last_sale_date
    FROM sale_items si
    WHERE si.client_id = $1 AND si.location_id = $2
    GROUP BY si.sku
  )
  SELECT p.sku, p.product_name as name,
    p.price, p.cost, p.category,
    p.stock_qty as total_units,
    m.last_sale_date,
    COALESCE(m.units_30d, 0) as units_30d,
    COALESCE(m.units_60d, 0) as units_60d,
    COALESCE(m.units_90d, 0) as units_90d,
    CURRENT_DATE - m.last_sale_date::date as days_since_sale
  FROM products p
  LEFT JOIN movement m ON TRIM(m.sku) = TRIM(p.upc)
  WHERE p.client_id = $1 AND p.location_id = $2
    AND p.stock_qty > 0
    AND (m.last_sale_date IS NULL OR m.last_sale_date < CURRENT_DATE - INTERVAL '90 days')
  ORDER BY COALESCE(CURRENT_DATE - m.last_sale_date::date, 9999) DESC,
           (p.cost * p.stock_qty) DESC
  LIMIT $3
`;

// Build enriched item objects with computed fields
function enrichItem(r) {
  const price = parseFloat(r.price || 0);
  const cost = parseFloat(r.cost || 0);
  const units = parseInt(r.total_units) || 0;
  const onHandValue = cost * units;
  const marginPct = price > 0 ? ((price - cost) / price) * 100 : 0;
  return {
    sku: r.sku,
    name: (r.name || '').trim(),
    price,
    cost,
    category: (r.category || 'Unknown').trim(),
    total_units: units,
    last_sale_date: r.last_sale_date || null,
    days_since_sale: r.last_sale_date ? parseInt(r.days_since_sale) : null,
    units_30d: parseInt(r.units_30d) || 0,
    units_60d: parseInt(r.units_60d) || 0,
    units_90d: parseInt(r.units_90d) || 0,
    on_hand_value: onHandValue,
    margin_pct: marginPct,
  };
}

// Build a grounded, data-driven template suggestion
function templateSuggestion(item, strategy) {
  const idleLabel = item.days_since_sale != null ? `${item.days_since_sale} days idle` : 'never sold';
  const move30 = item.units_30d;
  const valueStr = `$${item.on_hand_value.toFixed(2)}`;
  const priceStr = `$${item.price.toFixed(2)}`;
  const marginStr = `${item.margin_pct.toFixed(0)}% margin`;

  switch (strategy) {
    case 'bundle': {
      const discount = 15;
      const salePrice = (item.price * (1 - discount / 100)).toFixed(2);
      const expectedUnits = Math.min(item.total_units, Math.max(2, Math.floor(item.total_units * 0.3)));
      const recovery = (expectedUnits * parseFloat(salePrice)).toFixed(0);
      return `**Bundle Promotion, ${item.name}**, ${item.total_units} units on hand (${valueStr}), ${idleLabel}, ${move30} units sold in last 30 days. Bundle with a complementary item at ${discount}% off (sale price: $${salePrice}). Expected outcome: clear ~${expectedUnits} units, recover ~$${recovery} at ${marginStr}.`;
    }
    case 'clearance': {
      const discount = 25;
      const salePrice = (item.price * (1 - discount / 100)).toFixed(2);
      const expectedUnits = Math.min(item.total_units, Math.max(3, Math.floor(item.total_units * 0.4)));
      const recovery = (expectedUnits * parseFloat(salePrice)).toFixed(0);
      return `**Clearance Display, ${item.name}**, ${item.total_units} units sitting (${valueStr} tied up), ${idleLabel}. Move to "Last Chance" shelf near register at ${discount}% off (sale price: $${salePrice}). Expected outcome: clear ~${expectedUnits} units, recover ~$${recovery} before month-end.`;
    }
    case 'tasting': {
      return `**In-Store Tasting, ${item.name}**, ${item.total_units} units on hand (${valueStr}), ${idleLabel}. Host a weekend tasting event. Tasting drives an average 3-5x lift for unknown products. Expected outcome: convert 4-6 samples into 2-3 sales, accelerate category awareness at ${marginStr}.`;
    }
    case 'staff': {
      return `**Staff Push Incentive, ${item.name}**, ${item.total_units} units, ${priceStr} retail, ${idleLabel}. Pay staff $2 per unit sold this week. Current movement: ${move30} units in last 30 days. Expected outcome: 2-3x velocity increase for the week, clear ~${Math.max(3, Math.floor(item.total_units * 0.25))} units.`;
    }
    case 'social': {
      const discount = 20;
      const salePrice = (item.price * (1 - discount / 100)).toFixed(2);
      return `**48-Hour Flash Sale, ${item.name}**, ${item.total_units} units on hand (${valueStr}), ${idleLabel}. Post to Instagram/Facebook with ${discount}% off limited to 48 hours (sale price: $${salePrice}). Expected outcome: 3-5 units sold from social channel at ${marginStr}.`;
    }
    default:
      return `**Review, ${item.name}**, ${item.total_units} units on hand (${valueStr}), ${idleLabel}. Needs attention.`;
  }
}

// GET /api/dead-stock - returns 90+ day dead stock items with instant grounded suggestions
router.get('/', async (req, res) => {
  const pool = req.pool;
  const clientId = req.user.client_id;
  const locationId = req.user.location_id;

  try {
    const deadStock = await pool.query(DEAD_STOCK_SQL, [clientId, locationId, 20]);
    const items = deadStock.rows.map(enrichItem);

    if (items.length === 0) {
      return res.json({
        items: [],
        suggestions: [],
        message: 'No dead stock items found (90+ days without sale).',
      });
    }

    // Top 5 worst items
    const worstItems = items.slice(0, 5);

    // Build one grounded suggestion per worst item (each references that specific SKU)
    const strategies = ['clearance', 'bundle', 'tasting', 'social', 'staff'];
    const suggestions = worstItems.map((item, i) => templateSuggestion(item, strategies[i % strategies.length]));

    res.json({
      items: worstItems,
      suggestions,
      total_dead_stock_count: items.length,
    });
  } catch (err) {
    const safeErr = toSafeError(err);
    logger.error('Dead stock load failed', { error: err.message });
    res.status(safeErr.statusCode).json({ error: { code: safeErr.code, message: safeErr.userMessage } });
  }
});

// GET /api/dead-stock/ai-suggestions - AI-generated grounded suggestions (called async after page loads)
router.get('/ai-suggestions', async (req, res) => {
  const pool = req.pool;
  const clientId = req.user.client_id;
  const locationId = req.user.location_id;
  const locationName = req.user.location_name || 'your store';

  try {
    const deadStock = await pool.query(DEAD_STOCK_SQL, [clientId, locationId, 5]);
    const items = deadStock.rows.map(enrichItem);

    if (items.length === 0) {
      return res.json({ suggestions: [] });
    }

    // Build a detailed data dossier per item - this is what makes suggestions grounded
    const itemDossier = items.map((i, idx) => {
      const idleLabel = i.days_since_sale != null ? `${i.days_since_sale} days idle` : 'never sold';
      return `ITEM ${idx + 1}: ${i.name}
- SKU: ${i.sku}
- Category: ${i.category}
- Current on-hand: ${i.total_units} units
- On-hand value (at cost): $${i.on_hand_value.toFixed(2)}
- Retail price: $${i.price.toFixed(2)} | Cost: $${i.cost.toFixed(2)} | Margin: ${i.margin_pct.toFixed(0)}%
- Last sold: ${i.last_sale_date || 'Never'} (${idleLabel})
- Last 30 days sold: ${i.units_30d} units
- Last 60 days sold: ${i.units_60d} units
- Last 90 days sold: ${i.units_90d} units`;
    }).join('\n\n');

    const aiResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are a data-driven liquor store operations advisor for "${locationName}". Generate EXACTLY 5 grounded, operator-grade recommendations, one per dead stock item below. Each recommendation MUST cite specific numbers from the data (days idle, current qty, on-hand value, expected outcome in units and dollars).

DEAD STOCK DATA:
${itemDossier}

STRICT FORMAT, one suggestion per item, in this exact style:
**<Strategy Title>: <Product Name>**. <Specific observation: X units on hand ($Y tied up), Z days idle, N units sold last 30 days>. <Concrete action with exact price/discount>. Expected outcome: <units to clear> units cleared, ~$<dollars> recovered at <margin>% margin.

RULES:
- Use ONLY the data above. Do NOT invent numbers.
- Each suggestion MUST mention: current qty, days idle (or "never sold"), on-hand value, recent 30-day movement, and a specific expected outcome.
- Use different strategies per item: clearance display, bundle deal, in-store tasting, social flash sale, staff incentive.
- Every dollar amount must be computable from the data (price × units, cost × units, or price × discount).
- NO generic marketing brainstorms. This is an operator's tool.
- NEVER use a long dash anywhere in a suggestion: not the em dash (Unicode U+2014), not the en dash (Unicode U+2013). Use a colon, a comma or a full stop instead, or a plain ASCII hyphen "-" with spaces around it. The ASCII hyphen inside a compound word is always fine.

Return exactly 5 suggestions. No intro, no outro.`,
      }],
    });

    const aiText = aiResponse.content[0]?.text || '';
    const suggestions = aiText
      .split(/\n(?=\*\*)/) // split by lines starting with **
      .map(l => l.trim())
      .filter(l => l.startsWith('**') && l.length > 40)
      .slice(0, 5);

    res.json({ suggestions: suggestions.length > 0 ? suggestions : [] });
  } catch (err) {
    logger.error('AI suggestions failed', { error: err.message });
    res.json({ suggestions: [] });
  }
});

module.exports = router;
