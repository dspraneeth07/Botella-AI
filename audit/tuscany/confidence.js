// The confidence score for both Tuscany reports, computed from the run outputs.
//
// WHY IT IS A PRODUCT OF TWO HALVES, AND WHY THAT MATTERS MORE THAN THE NUMBER
//   Confidence is not a performance grade. A grade answers "how good is the
//   engine"; confidence answers "how much may we rely on it HERE". Those come
//   apart completely at a three-month-old store, and a single blended figure
//   hides exactly the distinction a reader needs:
//
//       MEASURED PERFORMANCE   what the measurements say, where they exist
//       EVIDENCE SUFFICIENCY   how much measurement there actually is
//
//   score = performance x sufficiency
//
//   A product, not an average. An average lets a good score on almost no
//   evidence stay respectable, which is the single most misleading thing this
//   document could do - it would let a store with 100 days of history and 18
//   scored cards read as "the engine is 58% reliable here". A product collapses
//   toward zero when the evidence is absent, which is the honest behaviour: we
//   do not know, and not knowing is not a middling result.
//
//   So a low score here does NOT say the engine performs badly at Tuscany. It
//   says we cannot yet claim it performs well. Both halves are always printed
//   so that cannot be misread.
//
// EVERY SUB-SCORE NAMES ITS BAR. A 0-100 number with no stated bar is an
// opinion with a decimal point. Each component below says what it measured,
// what it was measured against, and why that bar.

const SPEC = {
  // The production backtest's own requirement, so "how much history" is scored
  // against the engine's own standard rather than one invented here.
  history_days_required: 492,
  // Decision dates the measurement would want before a hit rate means much.
  // Thirty two-weekly dates is roughly a year of non-overlapping windows.
  decision_dates_target: 30,
  // Scored cards. A hundred is where a Wilson interval on a ~50% rate narrows
  // to about +/-10 points, which is the first point a rate is worth quoting.
  scored_cards_target: 100,
  // SKUs with enough observations to forecast. Five hundred is roughly what the
  // pilot stores carry at >= 30 selling days.
  deep_skus_target: 500,
  // Interval coverage the engine promises.
  coverage_target_pct: 80,
};

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * MEASURED PERFORMANCE: four components, averaged over those that exist.
 * A component with no measurement behind it is OMITTED, never scored 50 -
 * a missing measurement is not a mediocre one.
 */
function performance(fc, dec) {
  const H = fc.windows_used.horizons.map(String);
  const out = [];

  // 1. Forecast skill against the only independent baseline at this store.
  //    Parity with trailing-28 is 50. Each percentage point of WAPE better is
  //    +10, because a point of WAPE is a large move on a SKU-level forecast.
  const edges = H.map((h) => {
    const b = fc.by_horizon[h];
    return b.models.trailing_28.wape_pct - b.models.engine.wape_pct;
  });
  out.push({
    key: 'forecast_skill',
    label: 'Forecast skill vs trailing-28',
    score: clamp(50 + (mean(edges) * 10)),
    detail: `mean WAPE edge ${r1(mean(edges))} points over the only independent `
      + 'baseline this store supports (50 = parity, +10 per point)',
  });

  // 2. Bias control. The ratio of the engine's absolute bias to the
  //    baseline's: halving the bias scores 50, eliminating it scores 100.
  const eb = mean(H.map((h) => Math.abs(fc.by_horizon[h].models.engine.bias_pct)));
  const tb = mean(H.map((h) => Math.abs(fc.by_horizon[h].models.trailing_28.bias_pct)));
  out.push({
    key: 'bias_control',
    label: 'Bias control vs trailing-28',
    score: clamp(tb > 0 ? (1 - eb / tb) * 100 : 50),
    detail: `engine over-forecasts by ${r1(eb)}% on average against the baseline's `
      + `${r1(tb)}% (100 = no bias, 50 = half the baseline's)`,
  });

  // 3. Interval honesty. How far stated coverage sits from the 80% promised,
  //    in either direction - an over-wide interval overstates uncertainty and
  //    is a defect too, not a safety margin.
  const covErr = mean(H.map((h) => Math.abs(
    fc.by_horizon[h].interval_coverage_pct - SPEC.coverage_target_pct)));
  out.push({
    key: 'interval_honesty',
    label: 'Prediction interval honesty',
    score: clamp(100 - covErr * 2.5),
    detail: `coverage sits ${r1(covErr)} points from the ${SPEC.coverage_target_pct}% `
      + 'it promises, averaged over the horizons (both directions penalised)',
  });

  // 4. Decision skill against the reversion-matched null - the hard one, and
  //    the honest one. Matching the null is 50; each point of edge is a point.
  const edge = dec.sheet20.hit_rate - dec.null_reversion;
  out.push({
    key: 'decision_skill',
    label: 'Pick quality vs the reversion-matched null',
    score: clamp(50 + edge),
    detail: `hit rate ${r1(dec.sheet20.hit_rate)}% against a ${r1(dec.null_reversion)}% `
      + `null, an edge of ${r1(edge)} points on ${dec.sheet20.n} cards`,
  });

  return { components: out, score: mean(out.map((c) => c.score)) };
}

/**
 * EVIDENCE SUFFICIENCY: how much measurement exists, as a fraction of what the
 * measurement itself asks for. Averaged, so no single component can rescue or
 * sink it alone - but note that the history component is the one the others
 * mostly follow from.
 */
function sufficiency(fc, dec, audit, forward) {
  const depth = audit.sku_depth;
  const closed = forward
    ? (forward.metrics.evaluated || 0) : 0;
  const cards = forward ? (forward.scope.cards_examined || 0) : 0;
  const out = [
    {
      key: 'history',
      label: 'Trading history',
      score: clamp((fc.data.span_days / SPEC.history_days_required) * 100),
      detail: `${fc.data.span_days} days of span against the ${SPEC.history_days_required} `
        + "the production backtest requires (the engine's own standard)",
    },
    {
      key: 'decision_dates',
      label: 'Scored decision dates',
      score: clamp((dec.dates.length / SPEC.decision_dates_target) * 100),
      detail: `${dec.dates.length} dates against a ${SPEC.decision_dates_target}-date bar, `
        + 'and these are days apart so they share most of their data',
    },
    {
      key: 'scored_cards',
      label: 'Cards with a measured outcome',
      score: clamp((dec.sheet20.n / SPEC.scored_cards_target) * 100),
      detail: `${dec.sheet20.n} cards against the ${SPEC.scored_cards_target} at which a `
        + 'rate first narrows enough to quote',
    },
    {
      key: 'sku_depth',
      label: 'Forecastable SKUs',
      score: clamp((depth.at_least_30_days / SPEC.deep_skus_target) * 100),
      detail: `${depth.at_least_30_days} SKUs sold on 30+ days, of `
        + `${depth.distinct_skus} sold at all`,
    },
    {
      key: 'forward_evidence',
      label: 'Forward-test closed windows',
      score: cards > 0 ? clamp((closed / cards) * 100) : 0,
      detail: cards > 0
        ? `${closed} of ${cards} issued cards have a closed outcome window`
        : 'no issued card has reached a closed outcome window',
    },
  ];
  return { components: out, score: mean(out.map((c) => c.score)) };
}

/**
 * DATA CONFIDENCE: a separate score for the audit report, about the FEEDS
 * rather than the engine. Deliberately not folded into the engine score - a
 * store can have immaculate data and no history, or three years of history
 * with a broken receiving feed, and averaging those tells the reader nothing
 * about which to fix.
 */
function dataConfidence(audit) {
  const q = audit.quality;
  const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
  const out = [
    {
      key: 'sales_integrity',
      label: 'Sales and sale items',
      score: clamp(mean([
        pct(q.lines.with_price, q.lines.rows),
        pct(q.lines.with_cost, q.lines.rows),
        pct(q.lines.rows - q.lines.blank_sku, q.lines.rows),
        pct(q.lines.rows - q.lines.nonpositive_qty, q.lines.rows),
        pct(q.receipts.rows - q.receipts.null_subtotal, q.receipts.rows),
      ])),
      detail: `price on ${r1(pct(q.lines.with_price, q.lines.rows))}% and cost on `
        + `${r1(pct(q.lines.with_cost, q.lines.rows))}% of lines, no blank SKUs, `
        + `no null subtotals, ${q.lines.nonpositive_qty} non-positive quantities`,
    },
    {
      key: 'product_master',
      label: 'Product master',
      score: clamp(mean([
        pct(q.products.named, q.products.rows),
        pct(q.products.with_cost, q.products.rows),
        pct(q.products.with_stock, q.products.rows),
        pct(q.products.with_category, q.products.rows),
      ])),
      detail: `${q.products.rows} products, cost on `
        + `${r1(pct(q.products.with_cost, q.products.rows))}%, stock on `
        + `${r1(pct(q.products.with_stock, q.products.rows))}%, category on `
        + `${r1(pct(q.products.with_category, q.products.rows))}%`,
    },
    {
      key: 'receiving',
      label: 'Purchases and receiving',
      // Scored on DATE USABILITY, because a purchase with no usable date
      // cannot produce a lead time, a cadence or a reorder point - which is
      // the only thing this feed is read for.
      score: clamp(pct(q.purchases.rows - q.purchases.non_finite_dates, q.purchases.rows)),
      detail: `0 of ${q.purchases.rows} rows carry a usable date, so no lead time or `
        + 'delivery cadence can be computed at all',
    },
    {
      key: 'customer_link',
      label: 'Customer identification',
      score: clamp(mean([
        pct(q.receipts.with_customer, q.receipts.rows),
        pct(q.customers.contactable, q.customers.rows),
      ])),
      detail: `${r1(pct(q.receipts.with_customer, q.receipts.rows))}% of receipts carry a `
        + `customer and ${r1(pct(q.customers.contactable, q.customers.rows))}% of `
        + 'customer records have a phone or email',
    },
    {
      key: 'history_depth',
      label: 'History and SKU depth',
      score: clamp(mean([
        (q.receipts.trading_days / SPEC.history_days_required) * 100,
        (audit.sku_depth.at_least_30_days / SPEC.deep_skus_target) * 100,
      ])),
      detail: `${q.receipts.trading_days} trading days and `
        + `${audit.sku_depth.at_least_30_days} SKUs with 30+ selling days`,
    },
  ];
  return { components: out, score: mean(out.map((c) => c.score)) };
}

function build({ fc, dec, audit, forward }) {
  const perf = performance(fc, dec);
  const suff = sufficiency(fc, dec, audit, forward);
  const engine = (perf.score / 100) * suff.score;
  const data = dataConfidence(audit);
  return {
    spec: SPEC,
    performance: { ...perf, score: r1(perf.score) },
    sufficiency: { ...suff, score: r1(suff.score) },
    engine_confidence: r1(engine),
    data_confidence: { ...data, score: r1(data.score) },
    band: engine >= 70 ? 'high' : engine >= 40 ? 'moderate'
      : engine >= 15 ? 'low' : 'insufficient evidence',
  };
}

module.exports = { build, SPEC };
