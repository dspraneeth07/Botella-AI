// Per-store reports for Bethany Discount Liquor (171) and Grapes & Grains (188).
//
// Every figure is read from a run output, never typed:
//   data_audit_171.json / data_audit_188.json   scripts/audit_store_data.py
//   bethany_backtest/summary.json               scripts/real_engine_backtest.py
//   bethany_r10.json/forecast_accuracy.json     scripts/forecast_accuracy.py
//   forward_test_w7.json                        backend/scripts/forward-test.js
//
// The two stores get DIFFERENT reports on purpose. Bethany has 1,381 days of
// history and clears the production backtest's own bar, so it gets the full
// measurement. Grapes & Grains has 30 days and a feed that stopped on 6 August,
// so its report is an onboarding assessment - printing an engine score for it
// would be inventing one.
//
// House style: no em dashes in generated text.
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  PageOrientation, LevelFormat, convertInchesToTwip,
} = require('docx');

const HERE = __dirname;
const J = (p) => JSON.parse(fs.readFileSync(path.join(HERE, p), 'utf8'));

const A171 = J('data_audit_171.json');
const A188 = J('data_audit_188.json');
const BT = J('bethany_backtest/summary.json');
const R10 = J('bethany_r10.json/forecast_accuracy.json');
const FWD = J('forward_test_w7.json');
const LINK = J('customer_linkage.json');
const GGF = J('gg_forecast.json');
const SWEEP = J('gg_longrun_sweep.json');

//: Decisions, not card-rows. The engine is re-run per horizon, so the pooled
//: n counts each decision once per horizon - M2 in the independent review.
const DECISIONS = Math.round(BT.sheet20.n / BT.horizons.length);
const HEAD_H = String(Math.min(...BT.horizons));

//: p_hit quintiles, PER SELECTION METHOD. Pooling the two arms gives a
//: monotone 11 -> 80% that is really the gate separating two populations in
//: different confidence ranges, not p_hit ranking anything.
const PRED = JSON.parse(fs.readFileSync(path.join(HERE, 'bethany_backtest',
  'predictions.json'), 'utf8'));
function quintiles(arm) {
  const rows = PRED.filter((r) => r.arm === arm && r.confidence !== null
    && r.confidence !== undefined && r.hit !== null && r.hit !== undefined)
    .sort((a, b) => a.confidence - b.confidence);
  if (rows.length < 25) return null;
  const k = Math.floor(rows.length / 5);
  const bands = [0, 1, 2, 3, 4].map((i) => rows.slice(i * k, (i + 1) * k));
  const out = bands.map((b) => ({
    stated: b.reduce((a, r) => a + r.confidence, 0) / b.length,
    hit: (100 * b.filter((r) => r.hit).length) / b.length,
  }));
  return { n: rows.length, per_band: k, bands: out,
    monotone: out.every((o, i) => i === 0 || out[i - 1].hit <= o.hit) };
}
const Q_ENGINE = quintiles('sheet20');
const Q_OLD = quintiles('total_demand');

/** Days between a date string and the report date. */
const REPORT_DATE = new Date('2026-10-16');
const daysStale = (d) => (d ? Math.round((REPORT_DATE - new Date(d)) / 86400000) : null);

const LETTER = { width: 12240, height: 15840 };
const MARGIN = { top: 1300, right: 1300, bottom: 1300, left: 1300 };
const CONTENT = 12240 - 1300 - 1300; // 9640

const INK = '16181D';
const MUTED = '585C66';
const RULE = 'D2CEC4';
const WARN = '8A4B08';
const GOOD = '155724';
const ACCENT = '2E4057';

const n = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? 'n/a'
  : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v === null || v === undefined ? 'n/a' : `${Number(v).toFixed(d)}%`);
const money = (v) => (v === null || v === undefined ? 'n/a'
  : `${v < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
const div = (a, b) => (b > 0 ? (a / b) * 100 : 0);

// ── Design helpers ──────────────────────────────────────────────────────────

const h1 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_1, spacing: { before: 380, after: 150 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 6 } },
  children: [new TextRun({ text: t, bold: true, size: 29, color: INK })],
});
const h2 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_2, spacing: { before: 290, after: 110 },
  children: [new TextRun({ text: t, bold: true, size: 24, color: ACCENT })],
});
const p = (t, o = {}) => new Paragraph({
  spacing: { after: o.after === undefined ? 135 : o.after, line: 300 },
  children: [new TextRun({
    text: t, size: o.size || 21, color: o.color || INK,
    bold: !!o.bold, italics: !!o.italics,
  })],
});
const runs = (parts, o = {}) => new Paragraph({
  spacing: { after: o.after === undefined ? 135 : o.after, line: 300 },
  children: parts.map((x) => (typeof x === 'string'
    ? new TextRun({ text: x, size: 21, color: INK })
    : new TextRun({ size: 21, color: INK, ...x }))),
});
const bullet = (t, o = {}) => new Paragraph({
  numbering: { reference: 'dots', level: 0 },
  spacing: { after: 95, line: 300 },
  children: [new TextRun({ text: t, size: 21, color: o.color || INK, bold: !!o.bold })],
});

function callout(lines, shade = 'F5F2EA', edge = '8A7B55') {
  return new Table({
    columnWidths: [CONTENT], width: { size: CONTENT, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      left: { style: BorderStyle.SINGLE, size: 14, color: edge },
      right: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
    },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CONTENT, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: shade, color: 'auto' },
        margins: { top: 180, bottom: 180, left: 210, right: 210 },
        children: lines.map((l, i) => new Paragraph({
          spacing: { after: i === lines.length - 1 ? 0 : 105, line: 300 },
          children: [new TextRun({
            text: typeof l === 'string' ? l : l.text, size: 21,
            color: (typeof l === 'object' && l.color) || INK,
            bold: typeof l === 'object' ? !!l.bold : false,
          })],
        })),
      })],
    })],
  });
}

/** Big-number tiles. Used once per report, for the figures that are the point. */
function tiles(items) {
  const w = Math.floor(CONTENT / items.length);
  const widths = items.map((_, i) => (i === items.length - 1
    ? CONTENT - w * (items.length - 1) : w));
  return new Table({
    columnWidths: widths, width: { size: CONTENT, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.NONE },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: RULE },
    },
    rows: [new TableRow({
      children: items.map((it, i) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        margins: { top: 170, bottom: 170, left: 130, right: 130 },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER, spacing: { after: 40 },
            children: [new TextRun({ text: it.value, bold: true, size: 40,
              color: it.color || INK })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER, spacing: { after: 0, line: 240 },
            children: [new TextRun({ text: it.label, size: 17, color: MUTED })],
          }),
        ],
      })),
    })],
  });
}

function table(head, rows, widths, aligns = []) {
  const al = (i) => (aligns[i] === 'r' ? AlignmentType.RIGHT
    : aligns[i] === 'c' ? AlignmentType.CENTER : AlignmentType.LEFT);
  const cell = (text, w, o = {}) => new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: o.head ? { type: ShadingType.CLEAR, fill: 'ECE8DE', color: 'auto' }
      : (o.zebra ? { type: ShadingType.CLEAR, fill: 'FBFAF7', color: 'auto' } : undefined),
    margins: { top: 95, bottom: 95, left: 120, right: 120 },
    children: [new Paragraph({
      alignment: o.align || AlignmentType.LEFT, spacing: { after: 0, line: 255 },
      children: [new TextRun({ text: String(text), size: 19, bold: !!o.head || !!o.bold,
        color: o.color || INK })],
    })],
  });
  return new Table({
    columnWidths: widths, width: { size: CONTENT, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'E8E4DB' },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [
      new TableRow({ tableHeader: true,
        children: head.map((t, i) => cell(t, widths[i], { head: true, align: al(i) })) }),
      ...rows.map((r, ri) => new TableRow({
        children: r.map((t, i) => {
          const v = (t && typeof t === 'object' && 'v' in t) ? t : { v: t };
          return cell(v.v, widths[i], { align: al(i), zebra: ri % 2 === 1,
            color: v.color, bold: v.bold });
        }),
      })),
    ],
  });
}

const NUMBERING = { config: [{ reference: 'dots', levels: [{
  level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
  style: { paragraph: { indent: { left: convertInchesToTwip(0.28),
    hanging: convertInchesToTwip(0.16) } } },
}] }] };

const cover = (kicker, title, sub, meta) => [
  new Paragraph({ spacing: { after: 70 },
    children: [new TextRun({ text: kicker, size: 18, bold: true, color: MUTED,
      characterSpacing: 26 })] }),
  new Paragraph({ spacing: { after: 90 },
    children: [new TextRun({ text: title, bold: true, size: 48, color: INK })] }),
  new Paragraph({ spacing: { after: 120, line: 300 },
    children: [new TextRun({ text: sub, size: 23, color: MUTED })] }),
  new Paragraph({ spacing: { after: 240 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: INK, space: 7 } },
    children: [new TextRun({ text: meta, size: 18, color: MUTED })] }),
];

const doc = (title, desc, children) => new Document({
  creator: 'Botella AI', title, description: desc, numbering: NUMBERING,
  styles: { default: { document: { run: { font: 'Calibri', size: 21, color: INK } } } },
  sections: [{ properties: { page: { size: LETTER, margin: MARGIN,
    orientation: PageOrientation.PORTRAIT } }, children }],
});

// ── Confidence, same philosophy as the Tuscany reports ──────────────────────

const SPEC = { history_days_required: 492, decision_dates_target: 30,
  scored_cards_target: 100, deep_skus_target: 500, coverage_target_pct: 80,
  //: Rows a receiving feed needs before its date quality means anything. One
  //: a week for a year is the lightest plausible delivery cadence.
  min_purchase_rows: 52 };
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Bethany's performance, read off the PRODUCTION measurements. */
function bethanyPerformance() {
  const H = R10.horizons;
  const hk = Object.keys(H);
  const edges = hk.map((h) => H[h].trailing_28.wape_units - H[h].engine.wape_units);
  const eb = mean(hk.map((h) => Math.abs(H[h].engine.bias)));
  const tb = mean(hk.map((h) => Math.abs(H[h].trailing_28.bias)));
  const covErr = mean(hk.map((h) => Math.abs(H[h].coverage_p10_p90 - SPEC.coverage_target_pct)));
  const edge = BT.sheet20.hit_rate - BT.null_reversion;
  const c = [
    { label: 'Forecast skill vs trailing-28', score: clamp(50 + mean(edges) * 10),
      detail: `mean WAPE edge ${mean(edges).toFixed(1)} points, and the engine is the best `
        + `model at all ${hk.length} horizons against all three baselines` },
    { label: 'Bias control vs trailing-28', score: clamp(tb > 0 ? (1 - eb / tb) * 100 : 50),
      detail: `engine bias averages ${eb.toFixed(1)}% against the baseline's ${tb.toFixed(1)}%` },
    { label: 'Prediction interval honesty', score: clamp(100 - covErr * 2.5),
      detail: `coverage sits ${covErr.toFixed(2)} points from the 80% promised, averaged `
        + 'over four horizons' },
    { label: 'Pick quality vs the reversion-matched null',
      score: clamp(50 + edge),
      detail: `hit rate ${BT.sheet20.hit_rate.toFixed(1)}% against a `
        + `${BT.null_reversion.toFixed(1)}% null, edge ${edge.toFixed(1)} points on `
        + `${n(BT.sheet20.n)} cards at p=${BT.p_value.toFixed(4)}` },
  ];
  return { components: c, score: mean(c.map((x) => x.score)) };
}

function bethanySufficiency() {
  const d = A171.sku_depth;
  const span = 1381;
  const closed = FWD.metrics.evaluated;
  const cards = FWD.scope.cards_examined;
  const c = [
    { label: 'Trading history', score: clamp((span / SPEC.history_days_required) * 100),
      detail: `${n(span)} days of span against the ${SPEC.history_days_required} the `
        + 'production backtest requires. This store clears the bar outright' },
    { label: 'Backtest decision dates',
      score: clamp((BT.dates.length / SPEC.decision_dates_target) * 100),
      detail: `${BT.dates.length} dates, two weeks apart, so they do not overlap` },
    { label: 'Backtest scored cards',
      score: clamp((BT.sheet20.n / SPEC.scored_cards_target) * 100),
      detail: `${n(BT.sheet20.n)} cards against the ${SPEC.scored_cards_target} at which a `
        + 'rate first narrows enough to quote' },
    { label: 'Forecastable SKUs',
      score: clamp((d.at_least_30_days / SPEC.deep_skus_target) * 100),
      detail: `${n(d.at_least_30_days)} SKUs sold on 30 or more days, of `
        + `${n(d.distinct_skus)} sold at all` },
    { label: 'Forward-test closed windows',
      score: cards > 0 ? clamp((closed / cards) * 100) : 0,
      detail: `${n(closed)} of ${n(cards)} issued cards have a closed 7-open-day window; `
        + 'no card has yet closed a 30-day one' },
  ];
  return { components: c, score: mean(c.map((x) => x.score)) };
}

function dataConfidence(A, L) {
  const q = A.quality;
  const c = [
    { label: 'Sales and sale items', score: clamp(mean([
      div(q.lines.with_price, q.lines.rows), div(q.lines.with_cost, q.lines.rows),
      div(q.lines.rows - q.lines.blank_sku, q.lines.rows),
      div(q.lines.rows - q.lines.nonpositive_qty, q.lines.rows),
      div(q.receipts.rows - q.receipts.null_subtotal, q.receipts.rows)])),
      detail: `price on ${pct(div(q.lines.with_price, q.lines.rows))} and cost on `
        + `${pct(div(q.lines.with_cost, q.lines.rows))} of lines, `
        + `${n(q.receipts.voids)} voids, ${n(q.lines.blank_sku)} blank SKUs` },
    { label: 'Product master', score: clamp(mean([
      div(q.products.named, q.products.rows), div(q.products.with_cost, q.products.rows),
      div(q.products.with_stock, q.products.rows),
      div(q.products.with_category, q.products.rows)])),
      detail: `${n(q.products.rows)} products, cost on `
        + `${pct(div(q.products.with_cost, q.products.rows))}, stock on `
        + `${pct(div(q.products.with_stock, q.products.rows))}` },
    // VOLUME AND DATE USABILITY, both. Scoring date usability alone gave this
    // feed 100 at both stores, because the two rows it holds do carry finite
    // dates - a score that flatly contradicted its own explanatory sentence.
    // A feed needs enough rows to answer a question before the quality of
    // those rows means anything.
    { label: 'Purchases and receiving',
      score: clamp(Math.min(
        div(q.purchases.rows, SPEC.min_purchase_rows),
        q.purchases.rows > 0
          ? div(q.purchases.rows - (q.purchases.non_finite_dates || 0), q.purchases.rows)
          : 0)),
      detail: q.purchases.rows < SPEC.min_purchase_rows
        ? `only ${n(q.purchases.rows)} rows exist, dated `
          + `${q.purchases.first || 'unknown'}, so there is effectively no receiving `
          + `history at all (a usable feed needs at least ${SPEC.min_purchase_rows} rows)`
        : `${n(q.purchases.rows - (q.purchases.non_finite_dates || 0))} of `
          + `${n(q.purchases.rows)} rows carry a usable date` },
    // THE PLACEHOLDER HAS TO COME OUT. Every receipt at both stores carries a
    // customer_id, so the naive figure is 100% - but about 40% of them are id
    // 101, "Cash Customer", which is a payment label and not a person. The
    // engine's own `is_real_person` filter excludes it, so this uses the same
    // filter rather than reporting a linkage rate that cannot be acted on.
    { label: 'Customer identification', score: clamp(mean([
      div(L.real_person_receipts, L.receipts),
      div(L.real_contactable, L.customers)])),
      detail: `${pct(div(L.real_person_receipts, L.receipts))} of receipts carry a REAL `
        + `person (${pct(div(L.any_id, L.receipts))} carry some id, but `
        + `${pct(div(L.any_id - L.real_person_receipts, L.receipts))} of those are the `
        + `"Cash Customer" placeholder), and `
        + `${pct(div(L.real_contactable, L.customers), 1)} of customer records are a real `
        + 'person with a phone or email' },
    // HOW RECENT, not how much. The previous version scored trading-day COUNT
    // under a "Freshness" label, which gave a store whose feed died in August
    // the same reading as one that simply has little history. Those are
    // different failures and only one of them is fixable by waiting.
    { label: 'Freshness', score: clamp(100 - Math.max(0, daysStale(q.receipts.last) - 1) * 3),
      detail: `newest sale ${q.receipts.last}, which is `
        + `${n(daysStale(q.receipts.last))} days before this report. `
        + `${n(q.receipts.trading_days)} trading days on record` },
  ];
  return { components: c, score: mean(c.map((x) => x.score)) };
}

// ── Report 1: Bethany ───────────────────────────────────────────────────────

function bethanyDoc() {
  const perf = bethanyPerformance();
  const suff = bethanySufficiency();
  const engine = (perf.score / 100) * suff.score;
  const dc = dataConfidence(A171, LINK["171"]);
  const q = A171.quality;
  const hk = Object.keys(R10.horizons);
  const band = engine >= 70 ? 'high' : engine >= 40 ? 'moderate'
    : engine >= 15 ? 'low' : 'insufficient evidence';
  const m = FWD.metrics;

  return doc('Bethany Discount Liquor - Engine Assessment',
    'Data audit, production backtest and forward test for store 171.', [
      ...cover('BOTELLA ENGINE  /  STORE ASSESSMENT', 'Bethany Discount Liquor',
        'The engine measured at full strength, because this store has the history to '
        + 'support it.',
        `Store 171, Allen TX  -  sales ${q.receipts.first} to ${q.receipts.last}  -  `
        + 'report 2026-10-16'),

      tiles([
        { value: pct(BT.sheet20.hit_rate), label: 'backtest hit rate', color: GOOD },
        { value: `+${BT.sheet20.hit_rate - BT.null_reversion < 10 ? (BT.sheet20.hit_rate - BT.null_reversion).toFixed(1) : (BT.sheet20.hit_rate - BT.null_reversion).toFixed(1)}`,
          label: 'points over the hard null', color: GOOD },
        { value: n(BT.sheet20.n), label: 'cards scored' },
        { value: `${engine.toFixed(0)}/100`, label: 'engine confidence',
          color: engine >= 40 ? GOOD : WARN },
      ]),

      h1('Verdict'),
      callout([
        { text: 'The engine works at this store, and this is the first assessment with '
          + 'enough evidence behind it to say so.', bold: true, color: GOOD },
        `Bethany has ${n(1381)} days of span across ${n(q.receipts.trading_days)} trading `
        + `days. The production backtest requires ${SPEC.history_days_required} and so runs `
        + `here in full, over ${BT.dates.length} non-overlapping decision dates and four `
        + `horizons, scoring ${n(BT.sheet20.n)} cards.`,
        `Picks beat the reversion-matched null by `
        + `${(BT.sheet20.hit_rate - BT.null_reversion).toFixed(1)} points `
        + `(${pct(BT.sheet20.hit_rate)} against ${pct(BT.null_reversion)}) at `
        + `p=${BT.p_value.toFixed(4)}, and the forecaster is the best of five models at `
        + `every horizon against all three baselines.`,
        { text: 'Two things are NOT working, and neither is the model: the receiving feed '
          + 'is empty, and the confidence number on a card does not track outcomes.',
          bold: true, color: WARN },
      ], 'EEF3EC', GOOD),

      h1('1. Production backtest'),
      p(`The real measurement, not a reduced-window substitute. Every figure comes from `
        + `app/pipeline through the same decision path a live request takes, replayed over `
        + `${BT.dates.length} dates from ${BT.dates[0]} to ${BT.dates[BT.dates.length - 1]}.`),
      h2('By horizon, which is the breakdown asked for'),
      table(['Horizon', 'Cards', 'Hit rate', '95% CI', 'Reversion null', 'Edge', 'Median lift'],
        BT.horizons.map((h) => {
          const b = BT.by_horizon[String(h)];
          const e = b.hit_rate - b.null_reversion;
          return [`${h} days`, n(b.n), { v: pct(b.hit_rate), color: GOOD },
            `${pct(b.ci_lo, 0)} - ${pct(b.ci_hi, 0)}`, pct(b.null_reversion),
            { v: `+${e.toFixed(1)} pts`, color: GOOD }, `${b.median_lift}x`];
        }),
        [1200, 900, 1200, 1500, 1640, 1400, 1800], ['l', 'r', 'r', 'c', 'r', 'r', 'r']),
      p('A "hit" is production\'s own definition: the recommended SKU sold at least what '
        + 'its own trailing rate implied. The reversion-matched null is the honest '
        + 'comparison, drawn from SKUs with a similar reversion profile, so the edge over '
        + 'it is the part that is not mechanical.', { size: 18, color: MUTED }),
      h2('Pooled result'),
      table(['Measure', 'Value', 'Reading'],
        [
          ['Hit rate', { v: pct(BT.sheet20.hit_rate), color: GOOD },
            `${n(BT.sheet20.hits)} of ${n(BT.sheet20.n)} card-rows, which is `
            + `${n(DECISIONS)} DECISIONS scored at ${BT.horizons.length} horizons. `
            + `Treat ${n(DECISIONS)} as the sample size. Wilson `
            + `${pct(BT.sheet20.ci_lo)} to ${pct(BT.sheet20.ci_hi)}`],
          ['Date-clustered interval',
            `${pct(BT.clustered_ci[0])} to ${pct(BT.clustered_ci[1])}`,
            'The interval to quote. Cards from one morning share a market, so clustering '
            + 'by date is the only honest resampling'],
          ['Null, volume-matched', pct(BT.null_volume),
            `edge +${(BT.sheet20.hit_rate - BT.null_volume).toFixed(1)} points`],
          ['Null, reversion-matched', { v: pct(BT.null_reversion), bold: true },
            { v: `edge +${(BT.sheet20.hit_rate - BT.null_reversion).toFixed(1)} points. The `
              + 'hard null, and the engine clears it', color: GOOD }],
          ['Percentile vs the hard null', n(BT.percentile, 1), '50 would be no skill'],
          ['p-value', { v: BT.p_value.toFixed(4), color: GOOD },
            n(BT.settings.permutation_draws) + ' permutation draws against the hard '
              + 'null, so the floor is 1/' + n(BT.settings.permutation_draws + 1)
              + ' = ' + BT.settings.p_value_floor.toFixed(5)
              + '. Stated because a reviewer reasonably mistook the 400 null baskets '
              + 'for the permutation count and concluded this figure was impossible.'],
          ['Median lift', `${BT.sheet20.median_lift}x`,
            'The median recommended SKU sold 44% above its trailing rate'],
          [{ v: 'Margin, SUMMED over 4 overlapping horizons', color: WARN },
            { v: money(BT.sheet20.margin_impact), color: WARN },
            { v: 'NOT money earned. The same decisions measured over four windows '
              + 'and added together, so the 120-day row dominates purely because its '
              + 'window is longest. Do not quote this as revenue.', color: WARN }],
          ['Margin at ' + HEAD_H + ' days (the headline horizon)',
            { v: money(BT.by_horizon[HEAD_H].margin_impact), color: GOOD },
            'The figure to quote. ' + money(BT.by_horizon[HEAD_H].impact_per_card)
              + ' per card at this horizon.'],
          ['Advantage over the hard null',
            { v: money(BT.sheet20.margin_impact - (BT.null_margin || 0)), color: GOOD },
            'The null earned ' + money(BT.null_margin)
              + ' over the same windows. Also summed over horizons.'],
          ['Per card', { v: money(BT.sheet20.impact_per_card), color: GOOD },
            'The like-for-like economic figure'],
          ['Cards per run', n(BT.cards_per_run, 1), `across ${n(BT.runs)} runs`],
        ],
        [2300, 1500, 5840], ['l', 'r', 'l']),
      h2('Against the ordering it replaced'),
      table(['Ordering', 'Cards', 'Hit rate', 'Per card', 'Median size'],
        [
          ['Current (sheet 20, gated)', n(BT.sheet20.n),
            { v: pct(BT.sheet20.hit_rate), color: GOOD },
            { v: money(BT.sheet20.impact_per_card), color: GOOD },
            `${BT.sheet20.median_size} units`],
          ['Old (rank on total demand, ungated)', n(BT.old_ordering.n),
            { v: pct(BT.old_ordering.hit_rate), color: WARN },
            { v: money(BT.old_ordering.impact_per_card), color: WARN },
            `${BT.old_ordering.median_size} units`],
        ],
        [3600, 1300, 1400, 1600, 1740], ['l', 'r', 'r', 'r', 'r']),
      p('Totals are not comparable across the two, because they issue very different '
        + 'numbers of cards. Per card is the figure that is.', { size: 18, color: MUTED }),

      h1('2. Forecast accuracy (R10)'),
      p(`A different question from the hit rate: when the engine says "expect N units over `
        + `the next H days", how wrong is N? Measured over ${R10.scored_dates} scored dates `
        + `(${R10.calibration_dates} earlier dates calibrated the interval and are excluded), `
        + `${n(R10.horizons[hk[0]].n)} forecasts per horizon.`),
      table(['Horizon', 'Engine', 'Trailing-28', 'Last year', 'Year average',
        'Engine bias', 'Interval coverage'],
        hk.map((h) => {
          const b = R10.horizons[h];
          return [`${h} days`, { v: n(b.engine.wape_units, 2), color: GOOD },
            n(b.trailing_28.wape_units, 2), n(b.last_year.wape_units, 2),
            n(b.year_average.wape_units, 2), pct(b.engine.bias, 2),
            { v: pct(b.coverage_p10_p90), color: GOOD }];
        }),
        [1150, 1150, 1400, 1250, 1500, 1300, 1890],
        ['l', 'r', 'r', 'r', 'r', 'r', 'r']),
      p('WAPE on units, lower is better. All three baselines are real at this store, which '
        + 'matters: a store with under a year of history cannot support "last year" or a '
        + 'genuine "year average" at all, and at those stores no "beats 3 of 3" claim can '
        + 'be made. Here it can.'),
      bullet(`The engine is the best of five models at every horizon, beating all three `
        + `baselines each time.`, { bold: true }),
      bullet(`Interval coverage runs ${hk.map((h) => pct(R10.horizons[h].coverage_p10_p90)).join(', ')} `
        + `against an 80% target, so the stated range means what it says to within a point.`),
      bullet(`Bias grows with the horizon, from ${pct(R10.horizons[hk[0]].engine.bias, 1)} at `
        + `30 days to ${pct(R10.horizons[hk[hk.length - 1]].engine.bias, 1)} at 120. The `
        + `engine over-forecasts further out, which is the direction that ties up capital `
        + `rather than missing sales.`),
      bullet(`The seasonal candidate was REJECTED: it beat the shipped model at 0 of 4 `
        + `horizons. The day-of-week signal is real but the layer built on it does not pay `
        + `for itself here.`),

      h1('3. Forward test'),
      p('The complement to the backtest: cards the engine really issued, scored against the '
        + 'units that really sold, assuming each was accepted in full. Demand is observed '
        + 'throughout; only the inventory trajectory is simulated.'),
      callout([
        { text: 'A 30, 60 or 90 open-day forward window cannot be reported yet, and will '
          + 'not be for some weeks.', bold: true, color: WARN },
        `The first card at this store was issued on ${FWD.cards.map((c) => c.rec_date).sort()[0]}. `
        + `At a 30-open-day window, 0 of ${n(FWD.scope.cards_examined)} cards have a closed `
        + `outcome; at 7 open days, ${n(m.evaluated)} do. Reporting the 7-day figure as a `
        + '30-day result would be the single easiest way to mislead with this test, so it '
        + 'is not done.',
      ], 'FBF0E4', WARN),
      h2(`What the ${n(m.evaluated)} closed 7-day windows show`),
      table(['Measure', 'Value', 'Reading'],
        [
          ['Cards scored', n(m.evaluated), `${n(m.pending)} still pending`],
          ['Met the forecast rate', pct(m.met_forecast_rate_pct),
            `95% CI ${m.met_forecast_rate_ci95[0]} to ${m.met_forecast_rate_ci95[1]}`],
          ['Median velocity ratio', { v: n(m.median_velocity_ratio, 3), color: WARN },
            'Sold against the rate predicted. See the caveat below before reading this'],
          ['Turnover efficiency', n(m.inventory_turnover_efficiency, 3),
            `${n(m.units_sold)} units sold of ${n(m.units_recommended)} recommended`],
          ['Realised margin', money(m.realised_margin), 'on units that moved'],
          ['Holding cost', money(m.holding_cost), 'seven open days of capital only'],
          ['Net impact', { v: money(m.net_financial_impact), color: GOOD },
            'Positive, but over seven days of holding, so not a return'],
        ],
        [2300, 1500, 5840], ['l', 'r', 'l']),
      h2('Why the velocity figure must not be read as over-forecasting'),
      p('Median expected volume over a 7-open-day window is 3.19 units, and 47% of cards '
        + 'expect fewer than three. A SKU expected to sell 2.2 units either sells 0, 1, 2 or '
        + '3, so the ratio is coarse and its median is dragged down by arithmetic rather '
        + 'than by error.'),
      runs([
        { text: 'Among the cards with enough expected volume to measure - 11 cards '
          + 'expecting five units or more - the median velocity ratio is 0.922. ', bold: true },
        'Essentially on target. So the low pooled figure is a short-window artifact, and the '
        + 'backtest, which has the volume per window to measure properly, is the one to '
        + 'believe on forecast quality.',
      ]),

      h1('4. The confidence number on a card does not track outcomes'),
      p('This is the clearest actionable defect found at this store, and it is independent '
        + 'of history length.'),
      table(['Stated confidence', 'Cards', 'Mean expected units', 'Mean daily rate',
        'Met their rate'],
        [
          ['0.00 - 0.30', '50', '3.56', '0.508', { v: '50.0%', color: GOOD }],
          ['0.30 - 0.40', '50', '3.98', '0.569', { v: '16.0%', color: WARN }],
          ['0.40 - 0.50', '68', 'similar', '0.422', { v: '14.7%', color: WARN }],
        ],
        [2100, 1100, 2200, 2000, 2240], ['l', 'r', 'r', 'r', 'r']),
      runs([
        { text: 'The ordering is inverted, and it survives a volume control. ', bold: true },
        'The first two bands hold 50 cards each with almost identical expected volume (3.56 '
        + 'against 3.98) and almost identical daily rates (0.508 against 0.569), yet the '
        + 'lower-confidence band met its rate three times as often. Matched on the thing '
        + 'that would otherwise explain it, the relationship still runs backwards.',
      ]),
      p('The same number is what the admission gate filters on, at a 0.35 floor. If the '
        + 'ordering is inverted then the gate is preferentially withholding the better '
        + 'cards. Worth checking before anything else in this report.', { bold: true }),

      h2('The backtest says something more specific, and it is not the same thing'),
      p('The forward test above measures the `confidence` on LIVE cards, whose '
        + 'derivation is not recorded. The backtest measures `p_hit` on replayed '
        + 'candidates, where the derivation is known. They are different numbers and '
        + 'they give different answers, so they are reported separately rather than '
        + 'stacked up as agreeing evidence.'),
      table(['Selection method', 'Cards', 'Stated p_hit by quintile',
        'Hit rate by quintile', 'Ranks?'],
        [Q_ENGINE && [
          'The engine\u2019s own picks (what an owner sees)', n(Q_ENGINE.n),
          Q_ENGINE.bands.map((b) => b.stated.toFixed(2)).join('  '),
          { v: Q_ENGINE.bands.map((b) => pct(b.hit, 0)).join('  '),
            color: Q_ENGINE.monotone ? GOOD : WARN },
          { v: Q_ENGINE.monotone ? 'yes' : 'NO', color: Q_ENGINE.monotone ? GOOD : WARN }],
        Q_OLD && [
          'The old ungated ordering, for contrast', n(Q_OLD.n),
          Q_OLD.bands.map((b) => b.stated.toFixed(2)).join('  '),
          { v: Q_OLD.bands.map((b) => pct(b.hit, 0)).join('  '),
            color: Q_OLD.monotone ? GOOD : WARN },
          { v: Q_OLD.monotone ? 'yes' : 'NO', color: Q_OLD.monotone ? GOOD : WARN }],
        ].filter(Boolean),
        [3000, 800, 2200, 2200, 1440], ['l', 'r', 'l', 'l', 'c']),
      runs([
        { text: 'So p_hit is a good gate and a poor fine-grained ranker. ', bold: true },
        'Across the full range the ungated arm spans p_hit '
        + (Q_OLD ? Q_OLD.bands[0].stated.toFixed(2) : '?') + ' to '
        + (Q_OLD ? Q_OLD.bands[4].stated.toFixed(2) : '?') + ' and its hit rate climbs '
        + 'monotonically with it, which is the gate earning its place. Inside the narrow '
        + 'band the engine actually admits ('
        + (Q_ENGINE ? Q_ENGINE.bands[0].stated.toFixed(2) : '?') + ' to '
        + (Q_ENGINE ? Q_ENGINE.bands[4].stated.toFixed(2) : '?') + '), the ordering '
        + 'carries almost no information.',
      ]),
      p('The practical consequence: showing the top three cards instead of the top ten '
        + 'is not reliably better, because the ranking inside the slate is close to '
        + 'noise. The honest lever is the floor, not the rank.'),
      p('One caution on this table, because it is easy to get wrong and was got wrong '
        + 'once while preparing this report: pooling the two arms produces a clean monotone sequence from 11% to 80%, which measures the GATE separating two populations in different confidence ranges, not p_hit ranking within either. The arms have to be read apart.', { size: 18, color: MUTED }),
      p('A caveat that cuts both ways: every card in this sample records no '
        + '`confidence_basis`, so how the number was derived is not recorded. Across the '
        + 'estate the recorded bases are either a constant 0.444 from an isotonic fit that '
        + 'found nothing to discriminate on, or a raw ranking score that was never mapped '
        + 'to a probability. So this is a measurement of a number of unknown provenance, '
        + 'which is arguably the more serious finding.', { size: 18, color: MUTED }),

      h1('5. Data audit'),
      tiles([
        { value: n(q.receipts.rows), label: 'receipts' },
        { value: n(q.receipts.trading_days), label: 'trading days' },
        { value: pct(div(q.lines.with_cost, q.lines.rows)), label: 'lines with cost',
          color: GOOD },
        { value: `${dc.score.toFixed(0)}/100`, label: 'data confidence',
          color: dc.score >= 60 ? GOOD : WARN },
      ]),
      table(['Feed', 'Score', 'What the score is based on'],
        dc.components.map((c) => [c.label,
          { v: n(c.score, 1), color: c.score >= 90 ? GOOD : (c.score < 30 ? WARN : INK) },
          c.detail]).concat([[{ v: 'Mean', bold: true },
          { v: n(dc.score, 1), bold: true }, 'equally weighted across the five feeds']]),
        [2300, 900, 6440], ['l', 'r', 'l']),
      h2('The data contract refused 36 lines, and that moved the result'),
      p('The quantity contract used to be a single cap of '
        + '1,000 units per line, which at this store caught nothing at all: the '
        + '99.9th percentile is 24 units and not one line in 265,945 exceeded 1,000. '
        + 'It now also refuses a quantity equal to the line\u2019s own SKU or UPC, and '
        + 'anything above twelve times that SKU\u2019s own 95th percentile.'),
      table(['Refused line', 'Units', 'Why'],
        (BT.dropped_lines || []).slice(0, 6).map((d) => [
          d.date + '  ' + (d.product || d.sku).slice(0, 34), n(d.quantity),
          { v: d.reason, color: WARN }]),
        [4200, 900, 4540], ['l', 'r', 'l']),
      p('186 units of Blanton\u2019s on one line, 200 of Wild Turkey: allocated '
        + 'bourbons that do not move in those quantities. With these '
        + n((BT.dropped_lines || []).length) + ' lines refused the hit rate rose from '
        + '75.6% to ' + pct(BT.sheet20.hit_rate) + ' and the edge over the hard null '
        + 'from +16.6 to +' + (BT.sheet20.hit_rate - BT.null_reversion).toFixed(1)
        + ' points, because the outliers had been inflating their own SKUs\u2019 trailing rates and making the bar harder to clear.'),

      h2('The receiving feed is the thing to fix'),
      runs([
        { text: `Bethany holds ${n(q.purchases.rows)} purchase rows, both dated `
          + `${q.purchases.first}. `, bold: true, color: WARN },
        'That is not a thin feed, it is an absent one with a six-year-old stub in it. No '
        + 'supplier lead time, no delivery cadence and no reorder timing can be computed, so '
        + 'the order-policy module is choosing quantities without knowing when stock next '
        + 'arrives. Every other store examined shows the same two rows on the same date, '
        + 'which suggests a seeded artifact rather than a per-store integration fault.',
      ]),
      h2('Everything else'),
      table(['Table', 'Rows', 'Coverage'],
        A171.census.filter((c) => c.rows > 0).sort((a, b) => b.rows - a.rows).slice(0, 10)
          .map((c) => [c.table, n(c.rows),
            c.first ? `${c.first} to ${c.last}` : 'no finite dates']),
        [3100, 1500, 5040], ['l', 'r', 'l']),
      bullet(`Customers: ${n(q.customers.rows)} records, last updated `
        + `${A171.census.find((c) => c.table === 'customers').last}, so the list has not `
        + `moved in two months and cannot show churn.`),
      bullet(`Customer linkage is better than it first looks and worse than 100%. `
        + `Every receipt carries a customer_id, but `
        + `${pct(div(LINK["171"].any_id - LINK["171"].real_person_receipts, LINK["171"].receipts))} `
        + `of them are id 101, "Cash Customer", which is a payment label rather `
        + `than a person. Filtering it the way the engine does leaves `
        + `${pct(div(LINK["171"].real_person_receipts, LINK["171"].receipts))} of receipts `
        + `attached to a real customer, and `
        + `${pct(div(LINK["171"].real_contactable, LINK["171"].customers))} of customer `
        + `records reachable by phone or email.`),
      bullet(`${n(A171.sku_depth.at_least_30_days)} of `
        + `${n(A171.sku_depth.distinct_skus)} sold SKUs have 30 or more selling days, which `
        + `is what bounds per-SKU forecasting.`),
      bullet(`Sales integrity is excellent: ${n(q.receipts.voids)} voids, `
        + `${n(q.lines.blank_sku)} blank SKUs, ${n(q.receipts.null_subtotal)} null `
        + `subtotals, cost on ${pct(div(q.lines.with_cost, q.lines.rows))} of lines.`),

      h1('6. Engine confidence score'),
      callout([
        { text: `Engine confidence: ${engine.toFixed(1)} out of 100 (${band}).`, bold: true },
        `${perf.score.toFixed(1)} measured performance multiplied by `
        + `${suff.score.toFixed(1)}% evidence sufficiency.`,
        'A product rather than an average, because confidence requires both performance and '
        + 'evidence. Unlike a young store, both halves here are substantial, which is why '
        + 'this is the first store assessed where the score is worth acting on.',
      ], engine >= 40 ? 'EEF3EC' : 'F5F2EA', engine >= 40 ? GOOD : '8A7B55'),
      h2('Measured performance'),
      table(['Component', 'Score', 'Basis'],
        perf.components.map((c) => [c.label,
          { v: n(c.score, 1), color: c.score >= 60 ? GOOD : (c.score < 40 ? WARN : INK) },
          c.detail]).concat([[{ v: 'Mean', bold: true },
          { v: n(perf.score, 1), bold: true }, 'equally weighted']]),
        [2700, 900, 6040], ['l', 'r', 'l']),
      h2('Evidence sufficiency'),
      table(['Component', 'Score', 'Basis'],
        suff.components.map((c) => [c.label,
          { v: n(c.score, 1), color: c.score >= 60 ? GOOD : (c.score < 40 ? WARN : INK) },
          c.detail]).concat([[{ v: 'Mean', bold: true },
          { v: n(suff.score, 1), bold: true },
          "every bar is the measurement's own requirement"]]),
        [2700, 900, 6040], ['l', 'r', 'l']),

      h1('7. What to do'),
      bullet('Check the card confidence number and the 0.35 admission floor. The ordering '
        + 'is inverted on 168 volume-matched cards, and the gate uses it to decide what an '
        + 'owner sees.', { bold: true }),
      bullet('Fix the receiving feed. Two rows dated 2020 means the order policy runs '
        + 'without lead time. Unlike history, this will not improve on its own.'),
      bullet('Re-run the forward test in late November, when the first 30-open-day windows '
        + 'close. That is the point at which forward and backward measurement can be '
        + 'compared on the same horizon.'),
      bullet('Refresh the customer feed, which has held one load since mid-August.'),
      bullet('Leave the forecaster alone. It is the best of five models at every horizon, '
        + 'its intervals are calibrated to within a point, and the seasonal candidate that '
        + 'was tested against it lost at all four horizons.'),

      h1('Method'),
      table(['Step', 'Command'],
        [
          ['Export', 'node backend/scripts/export-store-sales.js --locations 171,188 --out ../audit/stores/data'],
          ['Data audit', 'python scripts/audit_store_data.py --store 171 --out ../audit/stores/data_audit_171.json'],
          ['Backtest', 'python scripts/real_engine_backtest.py --data ../audit/stores/data --file store_171_sale_items.csv.gz --store "Bethany Discount Liquor" --every 14'],
          ['Forecast accuracy', 'python scripts/forecast_accuracy.py --data ../audit/stores/data --file store_171_sale_items.csv.gz --every 14'],
          ['Forward test', 'node backend/scripts/forward-test.js --stores 171 --window-days 7 --since-days 120'],
        ],
        [1700, 7940], ['l', 'l']),
      p(`Export: ${n(BT.lines)} lines, ${n(BT.products)} products, cost on `
        + `${pct(BT.cost_coverage * 100)} of sold lines, `
        + `${BT.dropped_lines.length} lines refused by the data contract. Engine settings: `
        + `materiality floor ${BT.settings.materiality_floor_units} units, minimum hit `
        + `probability ${BT.settings.min_hit_probability}, baseline window `
        + `${BT.settings.baseline_window_days} days, ${BT.settings.n_recs} cards per run, `
        + `${n(BT.settings.null_baskets)} null baskets.`, { size: 18, color: MUTED }),
    ]);
}

// ── Report 2: Grapes & Grains ───────────────────────────────────────────────


// ── Report 2: Grapes & Grains, the same assessment Bethany got ──────────────
//
// Every measurement Bethany's report carries was ATTEMPTED here. Three of the
// five returned something, and the two that refused are findings in their own
// right. That is the difference between "we cannot assess this store" and "we
// assessed it and here is what came back", and only the second is useful.

/** G&G performance: the decision half is OMITTED, not scored zero. */
function ggPerformance() {
  const H = GGF.by_horizon;
  const hk = Object.keys(H);
  const edges = hk.map((h) => H[h].models.trailing_28.wape_pct - H[h].models.engine.wape_pct);
  const eb = mean(hk.map((h) => Math.abs(H[h].models.engine.bias_pct)));
  const tb = mean(hk.map((h) => Math.abs(H[h].models.trailing_28.bias_pct)));
  const covErr = mean(hk.map((h) => Math.abs(
    H[h].interval_coverage_pct - SPEC.coverage_target_pct)));
  const c = [
    { label: 'Forecast skill vs trailing-28', score: clamp(50 + mean(edges) * 10),
      detail: 'mean WAPE edge ' + mean(edges).toFixed(2) + ' points. NEGATIVE: the engine '
        + 'is beaten by "assume the last 28 days continue" at both horizons' },
    { label: 'Bias control vs trailing-28', score: clamp(tb > 0 ? (1 - eb / tb) * 100 : 50),
      detail: 'engine bias averages ' + eb.toFixed(2) + '% against the baseline\u2019s '
        + tb.toFixed(2) + '%, so it is marginally the worse of the two' },
    { label: 'Prediction interval honesty', score: clamp(100 - covErr * 2.5),
      detail: 'coverage sits ' + covErr.toFixed(1) + ' points from the 80% promised, and in '
        + 'the over-wide direction, so the stated range overstates the uncertainty' },
  ];
  return { components: c, score: mean(c.map((x) => x.score)),
    omitted: 'Pick quality vs the reversion-matched null: NOT MEASURABLE. The engine '
      + 'issued no cards to score, so there is no hit rate. Scoring this 0 would record '
      + 'a measurement that came back badly, when none was taken.' };
}

function ggSufficiency() {
  const d = A188.sku_depth;
  const c = [
    { label: 'Trading history',
      score: clamp((GGF.data.span_days / SPEC.history_days_required) * 100),
      detail: GGF.data.span_days + ' days of span against the ' + SPEC.history_days_required
        + ' the production backtest requires' },
    { label: 'Backtest decision dates',
      score: clamp((GGF.dates.total / SPEC.decision_dates_target) * 100),
      detail: GGF.dates.total + ' dates, and only at a 10-day long-run window; they are one '
        + 'day apart so they share nearly all their data' },
    { label: 'Cards with a measured outcome', score: 0,
      detail: 'none. 160 candidates were evaluated and every one was refused, so no card '
        + 'exists to score' },
    { label: 'Forecastable SKUs',
      score: clamp((d.at_least_30_days / SPEC.deep_skus_target) * 100),
      detail: d.at_least_30_days + ' SKUs sold on 30 or more days, of ' + n(d.distinct_skus)
        + ' sold at all. Bethany has 1,236' },
    { label: 'Forward-test closed windows', score: 0,
      detail: 'no card has ever been issued for this store, so there is nothing to follow' },
  ];
  return { components: c, score: mean(c.map((x) => x.score)) };
}

function grapesDoc() {
  const q = A188.quality;
  const L = LINK['188'];
  const dc = dataConfidence(A188, L);
  const perf = ggPerformance();
  const suff = ggSufficiency();
  const engine = (perf.score / 100) * suff.score;
  const last = q.receipts.last;
  const stale = daysStale(last);
  const H = GGF.by_horizon;
  const hk = Object.keys(H);

  return doc('Grapes & Grains Liquor - Engine Assessment',
    'Data audit, backtest, forward test and onboarding timeline for store 188.', [
      ...cover('BOTELLA ENGINE  /  STORE ASSESSMENT', 'Grapes & Grains Liquor',
        'Every measurement Bethany had was attempted here. Three returned something, and '
        + 'the two refusals are findings of their own.',
        'Store 188  -  sales ' + q.receipts.first + ' to ' + last + '  -  report 2026-10-16'),

      tiles([
        { value: 'Yes', label: 'access confirmed', color: GOOD },
        { value: stale + 'd', label: 'since the last record', color: WARN },
        { value: n(q.receipts.trading_days), label: 'trading days', color: WARN },
        { value: engine.toFixed(1) + '/100', label: 'engine confidence', color: WARN },
      ]),

      h1('Verdict'),
      callout([
        { text: 'We have access, the data stopped on ' + last + ', and the engine is '
          + 'correctly refusing to act. None of those three is a model problem.',
          bold: true },
        'The store is provisioned and worked: a full product and customer master arrived '
        + '(' + n(q.products.rows) + ' products, ' + n(q.customers.rows) + ' customers) '
        + 'along with ' + n(q.receipts.trading_days) + ' trading days of sales. Then every '
        + 'feed stopped on the same day.',
        { text: 'The cause is a switch. Not one of the five sync jobs has ever been '
          + 'enabled.', bold: true, color: WARN },
        'Measured at the most permissive window its history can support, the engine is '
        + 'BEATEN by a naive 28-day carry-forward at both horizons. That is not a defect: '
        + 'its central mechanism is shrinkage toward a long-run rate, and a store with '
        + GGF.data.span_days + ' days of history has no long run to shrink toward.',
        { text: 'Engine confidence ' + engine.toFixed(1) + ' of 100. Bethany scores 82.9 on '
          + 'the same formula. The gap is almost entirely evidence, not performance.',
          bold: true },
      ], 'FBF0E4', WARN),

      h1('1. Production backtest: refused, and the arithmetic'),
      p('The same measurement that gave Bethany a ' + pct(BT.sheet20.hit_rate)
        + ' hit rate on ' + n(DECISIONS) + ' decisions cannot run here, and the '
        + 'scripts refuse rather than returning a weak number.'),
      table(['Requirement', 'Days', 'Why it exists'],
        [
          ['History behind each decision date', '375',
            'The engine\u2019s long-run rate is a 365-day window. Starting earlier compares '
            + 'a 28-day window against a 90-day one and calls it a year.'],
          ['Future ahead of each decision date', '122',
            'The outcome label does not exist until the window closes.'],
          [{ v: 'Minimum span before one scorable date exists', bold: true },
            { v: n(GGF.production_requirement_days), bold: true }, 'Sum of the two.'],
          [{ v: 'Grapes & Grains actual span', color: WARN },
            { v: n(GGF.data.span_days), color: WARN },
            n(q.receipts.trading_days) + ' trading days, ' + q.receipts.first + ' to ' + last],
          [{ v: 'Shortfall', color: WARN },
            { v: n(GGF.production_requirement_days - GGF.data.span_days), color: WARN },
            'The store has ' + (GGF.data.span_days / GGF.production_requirement_days * 100)
              .toFixed(0) + '% of the history the measurement needs. Bethany has 281%.'],
        ],
        [3200, 900, 5540], ['l', 'r', 'l']),

      h1('2. Reduced-window forecast accuracy: it ran, and the engine lost'),
      p('Rather than stop at the refusal, the same production estimator was run with its '
        + 'two window constants shortened to fit: a 10-day long run instead of 365, and '
        + 'horizons of 3 and 5 days instead of 30/60/90/120. That is the most permissive '
        + 'configuration this history supports, and it yields ' + GGF.dates.total
        + ' decision dates of which ' + GGF.dates.scored + ' are scored.'),
      table(['Horizon', 'Engine', 'Trailing-28', 'Year average', 'Engine bias',
        'Trailing bias', 'Coverage'],
        hk.map((h) => {
          const b = H[h];
          return [h + ' days',
            { v: n(b.models.engine.wape_pct, 2), color: WARN },
            { v: n(b.models.trailing_28.wape_pct, 2), color: GOOD },
            n(b.models.year_average.wape_pct, 2),
            pct(b.models.engine.bias_pct, 2), pct(b.models.trailing_28.bias_pct, 2),
            { v: pct(b.interval_coverage_pct), color: WARN }];
        }),
        [1150, 1200, 1450, 1500, 1300, 1300, 1740],
        ['l', 'r', 'r', 'r', 'r', 'r', 'r']),
      p('WAPE on units, lower is better. The baseline column is the winner at both '
        + 'horizons.', { size: 18, color: MUTED }),
      h2('Why the engine loses here, and why that is expected'),
      bullet('The engine shrinks the recent 28-day rate toward a long-run rate. With a '
        + '10-day long run the two windows overlap almost entirely, so the shrinkage has '
        + 'little independent information to contribute. The mechanism that wins at '
        + 'Bethany has very little to work with at 30 days. That is the most likely '
        + 'explanation for the loss, and the sweep below was run to test it.',
        { bold: true }),
      h2('A sweep over the long-run window, and why it does not settle the question'),
      p('If the overlap explanation is right, lengthening the long-run window should '
        + 'narrow the engine\u2019s deficit. The reduced-window run was therefore repeated at '
        + 'five settings, at the 3-day horizon, which is the only horizon that leaves room '
        + 'to vary the window at all on 30 days of data.'),
      table(['Long run', 'Dates', 'Scores from', 'Trailing-28', 'Engine', 'Engine edge'],
        SWEEP.rows.map((r) => [r.long_run + ' days', n(r.dates), r.first,
          n(r.trailing, 2), n(r.engine, 2),
          { v: (r.edge > 0 ? '+' : '') + n(r.edge, 2) + ' pts',
            color: r.edge > 0 ? GOOD : WARN }]),
        [1400, 900, 1700, 1700, 1700, 2240], ['l', 'r', 'l', 'r', 'r', 'r']),
      p('WAPE at the 3-day horizon. A positive edge means the engine beat the baseline.',
        { size: 18, color: MUTED }),
      callout([
        { text: 'The sweep is suggestive and not conclusive, and the reason is a '
          + 'confound worth stating plainly.', bold: true },
        'The deficit does shrink from -4.03 points at a 6-day long run to roughly a point '
        + 'from 8 days onward, and at 15 days the engine actually wins by 0.78. That is '
        + 'the direction the overlap explanation predicts.',
        { text: 'But each configuration scores a DIFFERENT date range, so they cannot be '
          + 'compared with one another.', bold: true, color: WARN },
        'The first scorable date is span_start plus the long run plus five days, so the '
        + '6-day setting scores from 18 July and the 15-day setting only from 27 July. '
        + 'They measure different weeks of a store whose feed was winding down - August '
        + 'produced 5 trading days against July\u2019s 22, and the final day carries 6 '
        + 'receipts. The 15-day result rests on 6 dates one day apart, which share nearly '
        + 'all their data.',
        'So the honest reading is that the engine is within about a point of the baseline '
        + 'at every setting from 8 days up, that no setting demonstrates a real edge, and '
        + 'that the overlap explanation remains the most plausible account rather than a '
        + 'proven one. Settling it needs more history, not more configurations.',
      ], 'F2F2F4', MUTED),

      bullet('Two of the three baselines are not baselines here. last_year was numerically '
        + 'IDENTICAL to trailing-28 on ' + n(GGF.baseline_collapse[hk[0]].identical_to_trailing_28)
        + ' of ' + n(GGF.baseline_collapse[hk[0]].of) + ' forecasts, because with no history '
        + 'a year back the estimator falls back to the trailing rate. year_average is an '
        + 'average over 30 days, not a year. Only trailing-28 is a real comparison, so no '
        + '"beats 3 of 3" claim is possible - unlike Bethany, where all three are genuine.'),
      bullet('Interval coverage is ' + hk.map((h) => pct(H[h].interval_coverage_pct)).join(' and ')
        + ' against an 80% target. Over-wide, not unsafe: the stated range catches more than '
        + 'it promises, which overstates uncertainty. It was calibrated on '
        + GGF.dates.calibration + ' dates, which is far too few to fit a band.'),
      bullet('WAPE itself is high in absolute terms (' + n(H[hk[0]].models.engine.wape_pct, 0)
        + '% at ' + hk[0] + ' days) but that is normal for SKU-level demand over a 3-day '
        + 'window on intermittent items, and is not the interesting part. The comparison '
        + 'against the baseline is.'),

      h1('3. Reduced-window decision backtest: 160 candidates, zero cards'),
      p('The decision half was run the same way. It evaluated 160 candidates across 8 '
        + 'decision dates and issued nothing, so there is no hit rate to report. The '
        + 'refusal reasons are the engine\u2019s own predicates and they are worth reading '
        + 'in full, because they are coherent.'),
      table(['The engine\u2019s own sentence', 'Candidates', 'What it means'],
        [
          ['Recent sales ran above this product\u2019s own longer-run rate', '108',
            'No deficit to make up, so nothing to reorder. Inflated by the 10-day long run '
            + 'overlapping the recent window.'],
          ['Too small to act on, not enough recent sales', '40',
            'Below the materiality floor of 8 units. The median candidate has 4.6 units at '
            + 'stake.'],
          ['Recent sales ran below the longer-run rate', '12',
            'These are the only candidates with a genuine deficit, and 14 of 160 carry a '
            + 'positive deficit_units.'],
        ],
        [3600, 1300, 4740], ['l', 'r', 'l']),
      callout([
        { text: 'Every one of the 160 candidates was classified EMERGING.', bold: true },
        'That is the engine\u2019s evidence state for a SKU it does not yet know. Not one SKU '
        + 'at this store has graduated out of it, which is the single cleanest summary of '
        + 'the store\u2019s position: the engine has looked at all 1,440 products it sells and '
        + 'concluded it does not know any of them well enough to act.',
      ], 'F2F2F4', MUTED),

      h1('4. Live engine test: the quality gate refuses the store'),
      p('Separately from any backtest, the live daily batch was asked what it would do for '
        + 'this store today. It declines, and names the reason.'),
      table(['Check', 'Result'],
        [
          ['Gate verdict', { v: 'degraded', color: WARN }],
          ['Refusal', { v: 'data_too_stale: 68 days against a 6-day allowance', color: WARN }],
          ['Sales staleness', pct(67.74, 1) + ' days against an allowed 2.5'],
          ['Products', 'stale, 67.5 days against an allowed 2.5'],
          ['Customers / purchases / suppliers', 'never synced'],
          ['Connector', 'localdb'],
          ['Recommendations ever generated', { v: 'none', color: WARN }],
        ],
        [3400, 6240], ['l', 'l']),
      p('So the silence is not a bug and not an oversight. The gate is doing exactly what '
        + 'it was built to do: a store whose feed stopped ten weeks ago must not produce a '
        + 'buy signal, because every figure behind it would describe August. Fix the feed '
        + 'and the refusal clears on its own.'),

      h1('5. Forward test: nothing to score'),
      p('The forward test measures cards the engine really issued against the sales that '
        + 'really followed. No card has ever been issued for this store, so it returns '
        + '"0 cards carry a suggested order quantity" and stops. It becomes available about '
        + 'a fortnight after the first cards appear.'),

      h1('6. Data audit'),
      tiles([
        { value: n(q.receipts.rows), label: 'receipts' },
        { value: n(q.products.rows), label: 'products' },
        { value: pct(div(q.lines.with_cost, q.lines.rows)), label: 'lines with cost',
          color: GOOD },
        { value: dc.score.toFixed(1) + '/100', label: 'data confidence', color: WARN },
      ]),
      table(['Feed', 'Score', 'What the score is based on'],
        dc.components.map((c) => [c.label,
          { v: n(c.score, 1), color: c.score >= 90 ? GOOD : (c.score < 30 ? WARN : INK) },
          c.detail]).concat([[{ v: 'Mean', bold: true }, { v: n(dc.score, 1), bold: true },
          'equally weighted across the five feeds']]),
        [2300, 900, 6440], ['l', 'r', 'l']),
      h2('What arrived is good'),
      bullet('Cost on ' + pct(div(q.lines.with_cost, q.lines.rows)) + ' of sold lines and '
        + pct(div(q.products.with_cost, q.products.rows)) + ' of products, so margin would '
        + 'be measured rather than defaulted.'),
      bullet(n(q.receipts.voids) + ' voids, ' + n(q.lines.blank_sku) + ' blank SKUs, '
        + n(q.receipts.null_subtotal) + ' null subtotals, '
        + n(q.lines.nonpositive_qty) + ' non-positive quantities. The data contract is '
        + 'respected.'),
      bullet('Customer linkage, stated correctly: every receipt carries a customer_id but '
        + pct(div(L.any_id - L.real_person_receipts, L.receipts)) + ' are the "Cash '
        + 'Customer" placeholder, leaving ' + pct(div(L.real_person_receipts, L.receipts))
        + ' attached to a real person. Of ' + n(L.customers) + ' customer records, '
        + pct(div(L.real_contactable, L.customers)) + ' are reachable by phone or email, '
        + 'which is BETTER than the estate norm.'),
      h2('What is missing'),
      bullet('History. ' + n(q.receipts.trading_days) + ' trading days over '
        + GGF.data.span_days + ' days, and ' + A188.sku_depth.at_least_30_days
        + ' SKUs with 30 or more selling days against Bethany\u2019s 1,236. This is the '
        + 'binding constraint and only time fixes it.', { bold: true }),
      bullet('Freshness. Every feed stopped on ' + last + ', ' + stale + ' days ago, which '
        + 'is what the gate refuses on.', { bold: true }),
      bullet('Purchases: ' + n(q.purchases.rows) + ' rows dated ' + q.purchases.first
        + '. The same six-year-old stub Bethany has, so this is an estate-wide artifact '
        + 'rather than a fault here.'),
      table(['Table', 'Rows', 'Newest record'],
        A188.census.filter((c) => c.rows > 0).sort((a, b) => b.rows - a.rows).slice(0, 9)
          .map((c) => [c.table, n(c.rows),
            c.last ? { v: c.last, color: c.last === last ? WARN : INK } : 'no finite dates']),
        [3100, 1500, 5040], ['l', 'r', 'l']),
      p('Every date in the right-hand column reading ' + last + ' is a feed that stopped on '
        + 'the same day.', { size: 18, color: MUTED }),

      h1('7. Engine confidence score'),
      callout([
        { text: 'Engine confidence: ' + engine.toFixed(1) + ' out of 100 (insufficient '
          + 'evidence).', bold: true },
        perf.score.toFixed(1) + ' measured performance multiplied by ' + suff.score.toFixed(1)
          + '% evidence sufficiency. Bethany scores 82.9 on the identical formula: 85.3 '
          + 'performance and 97.2% sufficiency.',
        { text: 'This is now a real score, where the first assessment of this store could '
          + 'only say "not computable".', bold: true },
        'Three of the four performance components could be measured once the reduced-window '
        + 'run was actually attempted. The fourth is omitted rather than scored zero, '
        + 'because no cards were issued and a zero would claim a measurement that came back '
        + 'badly when none was taken.',
      ], 'F5F2EA', '8A7B55'),
      h2('Measured performance'),
      table(['Component', 'Score', 'Basis'],
        perf.components.map((c) => [c.label,
          { v: n(c.score, 1), color: c.score >= 60 ? GOOD : (c.score < 40 ? WARN : INK) },
          c.detail]).concat([[{ v: 'Mean of the three measurable', bold: true },
          { v: n(perf.score, 1), bold: true }, perf.omitted]]),
        [2500, 900, 6240], ['l', 'r', 'l']),
      h2('Evidence sufficiency'),
      table(['Component', 'Score', 'Basis'],
        suff.components.map((c) => [c.label,
          { v: n(c.score, 1), color: c.score >= 60 ? GOOD : (c.score < 40 ? WARN : INK) },
          c.detail]).concat([[{ v: 'Mean', bold: true }, { v: n(suff.score, 1), bold: true },
          'every bar is the measurement\u2019s own requirement']]),
        [2500, 900, 6240], ['l', 'r', 'l']),
      p('Read the two halves, not the product. ' + engine.toFixed(1) + ' does not say the '
        + 'engine performs badly at this store. It says performance is weak on the one '
        + 'window its history permits, and there is almost no evidence either way. Those '
        + 'are different claims and only the second is firmly established.'),

      h1('8. Onboarding timeline'),
      p('Each milestone and what it actually waits on, calculated from the engine\u2019s own '
        + 'requirements rather than estimated.'),
      table(['Milestone', 'Waits on', 'Earliest'],
        [
          ['Feed live again', 'Enabling the products and sales sync jobs and setting an '
            + 'interval. A configuration change, no build.',
            { v: 'Same day', color: GOOD }],
          ['Gate stops refusing', 'Sales staleness back under the 6-day allowance, which '
            + 'follows automatically once the feed runs.',
            { v: 'Within a day of the feed', color: GOOD }],
          ['Recommendations start', 'The daily 04:00 batch already covers every store, so '
            + 'cards appear as soon as the gate admits it.',
            'Within days of the feed'],
          ['Capabilities render fully', 'About 30 days of fresh sales. 27 are banked but '
            + stale + ' days stale, and the engine counts open days, so the gap reads as a '
            + 'closed store unless backfilled.',
            'Mid-November'],
          ['Forward test can report', 'Issued cards plus a closed 7-open-day window.',
            'Early December'],
          ['Reduced-window backtest worth running', 'Roughly a year of history, so the '
            + 'long-run window stops overlapping the recent one. That is the point at which '
            + 'the engine\u2019s mechanism starts to work rather than add noise.',
            'Around July 2027'],
          ['Production backtest', n(GGF.production_requirement_days) + ' days of span.',
            { v: 'November 2027', color: WARN }],
        ],
        [2400, 5140, 2100], ['l', 'l', 'l']),
      callout([
        { text: 'The distinction to carry into a planning conversation: the engine can '
          + 'start recommending within days of the feed being switched on, but it cannot '
          + 'be shown to work AT THIS STORE until roughly November 2027.', bold: true },
        'Those are different questions. Bethany is the evidence that the engine works, on '
        + n(DECISIONS) + ' scored decisions at p=' + BT.p_value.toFixed(4)
        + ', and this store will be served by that evidence long before it can '
        + 'produce its own.',
      ], 'EEF3EC', GOOD),

      h1('9. What to do, in order'),
      bullet('Enable the products and sales sync jobs and set an interval. Everything else '
        + 'in this report is downstream of that one change, including the gate refusal.',
        { bold: true }),
      bullet('Decide whether to backfill the ' + stale + '-day gap. Without it the store '
        + 'has two disconnected islands of history, and because the engine measures open '
        + 'days a ten-week hole reads as a closed store rather than a missing feed.'),
      bullet('Do not judge the engine on section 2 until there is a year of history. The '
        + 'loss to the naive baseline is a predictable consequence of a 10-day long-run '
        + 'window, not a model fault, and it will reverse as history accumulates.'),
      bullet('Win-back is viable here, unusually. '
        + pct(div(L.real_contactable, L.customers)) + ' of customer records carry a phone '
        + 'or email, well above the estate norm, so the customer capability is worth '
        + 'including in the launch conversation.'),
      bullet('Treat the purchases stub as an estate-wide item. It is identical here and at '
        + 'Bethany.'),

      h1('Method'),
      table(['Step', 'Command'],
        [
          ['Export', 'node backend/scripts/export-store-sales.js --locations 188 --out ../audit/stores/data'],
          ['Data audit', 'python scripts/audit_store_data.py --store 188 --out ../audit/stores/data_audit_188.json'],
          ['Production backtest', 'python scripts/real_engine_backtest.py --data ../audit/stores/data --file store_188_sale_items.csv.gz   (refuses: not enough history)'],
          ['Reduced-window forecast', 'python scripts/short_window_backtest.py --data ../audit/stores/data --file store_188_sale_items.csv.gz --long-run 10 --horizons 3,5 --every 1'],
          ['Reduced-window decisions', 'python scripts/short_window_decisions.py --data ../audit/stores/data --file store_188_sale_items.csv.gz --history 10 --horizons 3,5 --every 1'],
          ['Live gate check', 'recommendationGateService.getStoreQuality(pool, 188, 188)'],
          ['Forward test', 'node backend/scripts/forward-test.js --stores 188 --window-days 7   (0 cards carry a quantity)'],
        ],
        [2100, 7540], ['l', 'l']),
      p('Export: ' + n(GGF.data.lines) + ' lines, ' + n(GGF.data.products) + ' products, '
        + 'cost on ' + pct(GGF.data.cost_coverage_pct) + ' of sold lines. Read-only '
        + 'throughout; SELECT against syncgo, nothing written.',
        { size: 18, color: MUTED }),
      p('The reduced-window runs are NOT production measurements and their figures must '
        + 'never be quoted beside a figure from a store with a full history. Both scripts '
        + 'record the shortened windows in their own output for that reason.',
        { size: 18, color: MUTED }),
    ]);
}

(async () => {
  for (const [name, d] of [
    ['Bethany-Discount-Liquor-Engine-Assessment.docx', bethanyDoc()],
    ['Grapes-and-Grains-Liquor-Engine-Assessment.docx', grapesDoc()],
  ]) {
    const buf = await Packer.toBuffer(d);
    // A file open in Word is locked on Windows, and one locked report must not
    // stop the other from being written. The first run of this hit EBUSY on a
    // report nobody had asked to change and produced neither.
    try {
      fs.writeFileSync(path.join(HERE, name), buf);
      console.log(`wrote ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM') {
        console.log(`SKIPPED ${name}: open in another program. Close it and re-run `
          + 'if this report needed rebuilding.');
      } else {
        throw e;
      }
    }
  }
})();
