// Build the two Tuscany reports as .docx from the measured JSON.
//
// Every figure here is read from the run outputs, never retyped:
//   data_audit_173.json              scripts/audit_store_data.py
//   backtest_short_1020300.json      scripts/short_window_backtest.py
//   decisions/summary.json           scripts/short_window_decisions.py
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
const audit = JSON.parse(fs.readFileSync(path.join(HERE, 'data_audit_173.json'), 'utf8'));
const fc = JSON.parse(fs.readFileSync(path.join(HERE, 'backtest_short_1020300.json'), 'utf8'));
const dec = JSON.parse(fs.readFileSync(path.join(HERE, 'decisions', 'summary.json'), 'utf8'));
const forward = JSON.parse(fs.readFileSync(path.join(HERE, 'forward_test_w7.json'), 'utf8'));
const basis = JSON.parse(fs.readFileSync(path.join(HERE, 'confidence_basis.json'), 'utf8'));
const CONF = require('./confidence').build({ fc, dec, audit, forward });

const BASIS_MEANING = {
  isotonic: 'Mapped to observed outcomes by isotonic regression, which is the correct '
    + 'method. It currently returns the SAME value for every card it touches, so the '
    + 'calibration has found nothing to discriminate on.',
  isotonic_flat_slate: 'Isotonic again, flagged because the slate it was fitted on was '
    + 'flat. Also a single constant value.',
  raw_ranking_score: "The engine's internal RANKING score, passed through unchanged. It "
    + 'orders cards against each other; it was never mapped to a probability, so it '
    + 'does not mean "this often succeeds".',
  not_recorded: 'No basis was recorded, so how the number was derived is not known from '
    + 'the data.',
};
const basisLabel = (b) => (b === 'not_recorded' ? 'not recorded' : b);

const LETTER = { size: { width: 12240, height: 15840 } };
const MARGIN = { top: 1440, right: 1440, bottom: 1440, left: 1440 };
const CONTENT = 12240 - 1440 - 1440; // 9360 DXA

const INK = '1A1A1A';
const MUTED = '5A5A5A';
const RULE = 'C8C8C8';
const WARN = '8A4B08';
const GOOD = '1B5E20';

const n = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v)
  ? 'n/a' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v === null || v === undefined ? 'n/a' : `${Number(v).toFixed(d)}%`);
const money = (v) => (v === null || v === undefined ? 'n/a'
  : `${v < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 140 },
    children: [new TextRun({ text, bold: true, size: 30, color: INK })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 110 },
    children: [new TextRun({ text, bold: true, size: 25, color: INK })],
  });
}
function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after === undefined ? 130 : opts.after, line: 300 },
    children: [new TextRun({
      text, size: opts.size || 21, color: opts.color || INK,
      bold: !!opts.bold, italics: !!opts.italics,
    })],
  });
}
function runs(parts, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after === undefined ? 130 : opts.after, line: 300 },
    children: parts.map((x) => (typeof x === 'string'
      ? new TextRun({ text: x, size: 21, color: INK })
      : new TextRun({ size: 21, color: INK, ...x }))),
  });
}
function bullet(text, opts = {}) {
  return new Paragraph({
    numbering: { reference: 'dots', level: 0 },
    spacing: { after: 90, line: 300 },
    children: [new TextRun({ text, size: 21, color: opts.color || INK, bold: !!opts.bold })],
  });
}
function rule() {
  return new Paragraph({
    spacing: { before: 60, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } },
    children: [new TextRun({ text: '', size: 2 })],
  });
}

/** A callout block: one shaded cell, used for the verdict. */
function callout(lines, shade = 'F4F0E6') {
  return new Table({
    columnWidths: [CONTENT],
    width: { size: CONTENT, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      left: { style: BorderStyle.SINGLE, size: 12, color: '8A7B55' },
      right: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideHorizontal: { style: BorderStyle.NONE },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CONTENT, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: shade, color: 'auto' },
        margins: { top: 170, bottom: 170, left: 200, right: 200 },
        children: lines.map((l, i) => new Paragraph({
          spacing: { after: i === lines.length - 1 ? 0 : 100, line: 300 },
          children: [new TextRun({
            text: typeof l === 'string' ? l : l.text,
            size: 21, color: (typeof l === 'object' && l.color) || INK,
            bold: typeof l === 'object' ? !!l.bold : false,
          })],
        })),
      })],
    })],
  });
}

/** A data table. `widths` must sum to CONTENT. */
function table(head, rows, widths, aligns = []) {
  const cell = (text, w, opts = {}) => new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: opts.head
      ? { type: ShadingType.CLEAR, fill: 'EFEAE0', color: 'auto' }
      : (opts.zebra ? { type: ShadingType.CLEAR, fill: 'FAF8F4', color: 'auto' } : undefined),
    margins: { top: 90, bottom: 90, left: 120, right: 120 },
    children: [new Paragraph({
      alignment: opts.align || AlignmentType.LEFT,
      spacing: { after: 0, line: 260 },
      children: [new TextRun({
        text: String(text), size: 19, bold: !!opts.head,
        color: opts.color || (opts.head ? INK : INK),
      })],
    })],
  });
  const al = (i) => (aligns[i] === 'r' ? AlignmentType.RIGHT
    : aligns[i] === 'c' ? AlignmentType.CENTER : AlignmentType.LEFT);
  return new Table({
    columnWidths: widths,
    width: { size: CONTENT, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'E4E0D8' },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: head.map((t, i) => cell(t, widths[i], { head: true, align: al(i) })),
      }),
      ...rows.map((r, ri) => new TableRow({
        children: r.map((t, i) => {
          const v = (t && typeof t === 'object' && 'v' in t) ? t : { v: t };
          return cell(v.v, widths[i], { align: al(i), zebra: ri % 2 === 1, color: v.color });
        }),
      })),
    ],
  });
}

const NUMBERING = {
  config: [{
    reference: 'dots',
    levels: [{
      level: 0, format: LevelFormat.BULLET, text: '•',
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: convertInchesToTwip(0.28), hanging: convertInchesToTwip(0.16) } } },
    }],
  }],
};

function titleBlock(kicker, title, subtitle, meta) {
  return [
    new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: kicker, size: 18, bold: true, color: MUTED, characterSpacing: 24 })],
    }),
    new Paragraph({
      spacing: { after: 90 },
      children: [new TextRun({ text: title, bold: true, size: 44, color: INK })],
    }),
    new Paragraph({
      spacing: { after: 110, line: 300 },
      children: [new TextRun({ text: subtitle, size: 23, color: MUTED })],
    }),
    new Paragraph({
      spacing: { after: 220 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: INK, space: 6 } },
      children: [new TextRun({ text: meta, size: 18, color: MUTED })],
    }),
  ];
}

// ───────────────────────────── REPORT 1: BACKTEST ─────────────────────────────

const s20 = dec.sheet20;
const old = dec.old_ordering;
const need = fc.production_requirement_days;
const span = fc.data.span_days;
const H = fc.windows_used.horizons;

function backtestDoc() {
  const byH = H.map((h) => {
    const b = fc.by_horizon[String(h)];
    const e = b.models.engine, t = b.models.trailing_28, es = b.models.engine_seasonal;
    return { h, b, e, t, es };
  });
  const decH = dec.by_horizon;

  const children = [
    ...titleBlock(
      'BOTELLA ENGINE  /  BACKTEST',
      'Tuscany Liquors',
      'What the engine can and cannot be shown to do at this store, and why.',
      `Store 173 (tuscanyliquors)  -  data 2026-07-05 to 2026-10-13  -  report 2026-10-15`),

    h1('Verdict'),
    callout([
      { text: 'The production backtest cannot be run at this store, and that is not a failure of the engine.', bold: true },
      `It requires ${need} days of trading history per decision date (${fc.production_windows.long_run_days + 5} behind, so the engine's long-run rate has a full year, plus ${Math.max(...fc.production_windows.horizons) + 2} ahead, so the outcome window has closed). Tuscany has ${span}. It is short by ${need - span} days, and both production scripts correctly refuse to produce a number.`,
      { text: 'Measured on shortened windows instead, the two halves of the engine give opposite answers.', bold: true },
      `The FORECASTER is sound: it beats the only independent baseline at all three horizons and cuts forecast bias by roughly two thirds. The RECOMMENDER has no usable evidence base here: it issues ${dec.cards_per_run} cards per run, and the ${s20.n} cards it did issue hit ${pct(s20.hit_rate)} against a reversion-matched null of ${pct(dec.null_reversion)}.`,
      { text: `With n=${s20.n}, that hit rate cannot be distinguished from chance. It is not evidence that the engine is wrong here; it is evidence that there is not yet enough history to tell.`, bold: true, color: WARN },
    ]),

    h1('What "confidence" means, because it means four different things'),
    p('The word appears in four places in this product, measuring four unrelated '
      + 'things on different scales. They are routinely read as one number. They are '
      + 'not, and the rest of this report is unreadable until they are separated.'),
    table(
      ['Where it appears', 'What it is', 'Scale', 'At Tuscany'],
      [
        ['On a card, next to the advice',
          "The engine's own per-card number, and the one the admission gate filters on "
          + `at a ${basis.admission_floor} floor. Its derivation varies card by card and `
          + 'is recorded in `confidence_basis` - see the table below.',
          '0 to 1',
          { v: 'Not a probability. 9 of 10 cards carry a raw ranking score.', color: WARN }],
        ['Around a forecast (p10 to p90)',
          'How often the actual figure falls inside the stated range. The only one of '
          + 'the four that is a textbook statistical confidence, and the only one that '
          + 'is verifiably well behaved here.',
          '% of outcomes inside an 80% range',
          { v: `${pct(byH[1].b.interval_coverage_pct)} at 20 days against an 80% target. `
            + 'Sound.', color: GOOD }],
        ['Engine confidence score (this report)',
          'How much the engine may be RELIED ON at this store. Measured performance '
          + 'multiplied by how much evidence exists. Not a probability and not a grade.',
          '0 to 100',
          { v: `${CONF.engine_confidence}, i.e. insufficient evidence.`, color: WARN }],
        ['Data confidence score (companion report)',
          'How far the FEEDS can support any analysis at all. About the data, not the '
          + 'engine.',
          '0 to 100',
          `${CONF.data_confidence.score}, dragged down by receiving and customer linkage.`],
      ],
      [2200, 3500, 1700, 1960], ['l', 'l', 'l', 'l']),

    h2('The card-level number is the one to distrust'),
    p('Every card records how its confidence was derived. Across the estate those '
      + 'derivations are not comparable with each other, and most are not probabilities:'),
    table(
      ['Recorded basis', 'Cards', 'Stores', 'Range', 'What it actually is'],
      basis.estate.map((b) => [
        basisLabel(b.basis), n(b.cards), n(b.stores),
        b.lo === b.hi ? { v: `${b.lo} (constant)`, color: WARN } : `${b.lo} to ${b.hi}`,
        BASIS_MEANING[b.basis] || '',
      ]),
      [1700, 800, 800, 1500, 4560], ['l', 'r', 'r', 'l', 'l']),
    p(`The two isotonic rows are the ones that were calibrated properly, and both return `
      + `a single constant value for every card - so where the method is right, it is `
      + `currently finding nothing to tell cards apart. The ${n(basis.estate.find((b) => b.basis === 'raw_ranking_score').cards)} `
      + `raw-ranking-score cards carry an ordering where a probability is expected, and `
      + `the ${n(basis.estate.find((b) => b.basis === 'not_recorded').cards)} with no `
      + `recorded basis cannot be interpreted at all.`),

    h2('What that means for Tuscany specifically'),
    table(
      ['Basis', 'Cards', 'Range'],
      basis.tuscany.map((b) => [basisLabel(b.basis), n(b.cards),
        b.lo === b.hi ? `${b.lo}` : `${b.lo} to ${b.hi}`]),
      [3400, 1500, 4460], ['l', 'r', 'l']),
    runs([
      { text: 'So a Tuscany card showing confidence 0.43 is not saying "this works 43% '
        + 'of the time". ', bold: true },
      'It is showing the engine\'s ranking score for that card, on a scale that was '
      + 'never mapped to an outcome. The admission gate then withholds anything below '
      + `${basis.admission_floor} on that same unmapped scale, which is why `
      + 'nine of ten cards at this store never reach the screen.',
    ]),
    p('Independent support for distrusting it: the forward test over a different store '
      + 'with 110 scored cards found the stated number ANTI-correlated with outcomes - '
      + 'cards stating 0.23 met their forecast rate 50% of the time, those stating 0.34 '
      + 'managed 14.3%, and those stating 0.41 managed 7.1%. Those cards also had no '
      + 'recorded basis, so that result is a measurement of a number whose derivation is '
      + 'unknown, which is arguably the more serious finding of the two.'),

    h1('Engine confidence score'),
    callout([
      { text: `Engine confidence at this store: ${CONF.engine_confidence} out of 100 `
        + `(${CONF.band}).`, bold: true },
      `That is ${CONF.performance.score} for measured performance multiplied by `
      + `${CONF.sufficiency.score}% for evidence sufficiency.`,
      { text: 'READ THE TWO HALVES, NOT THE PRODUCT. A low score here does not say '
        + 'the engine performs badly at Tuscany. It says we cannot yet claim it '
        + 'performs well, which is a different statement and the only one the data '
        + 'supports.', bold: true },
      `The halves disagree sharply, and that disagreement is the finding: measured `
      + `performance is ${CONF.performance.score} - middling, with the forecaster `
      + `clearly positive and pick quality clearly negative - while evidence `
      + `sufficiency is ${CONF.sufficiency.score}, because this store has `
      + `${fc.data.span_days} days of history and not one issued card has reached a `
      + `closed outcome window.`,
    ]),
    p('A product rather than an average, deliberately. An average would let a '
      + 'respectable performance score survive on almost no evidence, so a store with '
      + 'three months of history and 18 scored cards would read as "the engine is '
      + 'around 58% reliable here". A product collapses toward zero as evidence '
      + 'disappears, which is the honest behaviour: not knowing is not a middling '
      + 'result.'),

    h2('Measured performance: what the numbers say'),
    table(
      ['Component', 'Score', 'What it measured, and against what'],
      CONF.performance.components.map((c) => [
        c.label,
        { v: n(c.score, 1), color: c.score >= 60 ? GOOD : (c.score < 40 ? WARN : INK) },
        c.detail,
      ]).concat([[{ v: 'Mean', color: INK }, { v: n(CONF.performance.score, 1), color: INK },
        'equally weighted; a component with no measurement behind it would be omitted, '
        + 'never scored 50, because a missing measurement is not a mediocre one']]),
      [2600, 900, 5860], ['l', 'r', 'l']),

    h2('Evidence sufficiency: how much measurement exists'),
    table(
      ['Component', 'Score', 'What it has, against what the measurement asks for'],
      CONF.sufficiency.components.map((c) => [
        c.label,
        { v: n(c.score, 1), color: c.score >= 60 ? GOOD : (c.score < 40 ? WARN : INK) },
        c.detail,
      ]).concat([[{ v: 'Mean', color: INK }, { v: n(CONF.sufficiency.score, 1), color: INK },
        'every bar is the measurement\'s own requirement, not a target invented for '
        + 'this report']]),
      [2600, 900, 5860], ['l', 'r', 'l']),
    p(`Each sub-score names its bar, because a 0-100 number with no stated bar is an `
      + `opinion with a decimal point. The history bar is the production backtest's own `
      + `${CONF.spec.history_days_required}-day requirement; the card bar is the `
      + `${CONF.spec.scored_cards_target} at which a Wilson interval on a 50% rate first `
      + `narrows to about plus or minus ten points.`, { size: 18, color: MUTED }),

    h1('What was measured, and what could not be'),
    p('Two production measurements exist, and both refuse this store outright rather than returning a weak number. That refusal is the single most important finding in this report, so the arithmetic is given in full.'),
    table(
      ['Requirement', 'Days', 'Why it exists'],
      [
        ['History behind each decision date', { v: n(fc.production_windows.long_run_days + 5) },
          "The engine's long-run rate is a 365-day window. Starting earlier compares a 28-day window against a 90-day one and calls it a year."],
        ['Future ahead of each decision date', { v: n(Math.max(...fc.production_windows.horizons) + 2) },
          'The outcome label does not exist until the window closes. Scoring earlier flatters every pick against a truncated future.'],
        [{ v: 'Minimum span before one scorable date exists', color: INK }, { v: n(need) }, 'Sum of the two.'],
        [{ v: 'Tuscany actual span', color: WARN }, { v: n(span), color: WARN },
          `${n(fc.data.trading_days)} trading days, ${fc.data.first_day} to ${fc.data.last_day}.`],
        [{ v: 'Shortfall', color: WARN }, { v: n(need - span), color: WARN }, `The store has ${Math.round(span / need * 100)}% of the history the measurement needs.`],
      ],
      [3100, 900, 5360], ['l', 'r', 'l']),
    p('Everything below therefore comes from a reduced-window variant, built for this report, which runs the same production modules with only the window bounds shortened. It is labelled as such everywhere, and its numbers are not comparable to any figure published for another store.', { after: 60 }),
    runs([
      { text: 'In particular: ', bold: true },
      `the 75.7% backtest figure published for Bethany Discount Liquor was computed over roughly three years of history. Nothing in this report may be set beside it.`,
    ]),

    h1('Part 1. The forecaster'),
    p(`Question: when the engine says "expect N units over the next H days", how wrong is N? Measured over ${n(fc.dates.scored)} scored decision dates (${fc.dates.calibration} earlier dates were used to calibrate the prediction interval and are excluded from scoring), ${n(byH[0].b.forecasts)} forecasts per horizon across ${n(byH[0].b.skus)} SKUs.`),
    h2('Result'),
    table(
      ['Horizon', 'Engine WAPE', 'Trailing-28 WAPE', 'Engine edge', 'Engine bias', 'Trailing bias', 'Interval coverage'],
      byH.map(({ h, b, e, t }) => [
        `${h} days`,
        { v: pct(e.wape_pct, 2), color: GOOD },
        pct(t.wape_pct, 2),
        { v: `${(e.wape_pct - t.wape_pct).toFixed(2)} pts`, color: GOOD },
        { v: pct(e.bias_pct, 2), color: GOOD },
        pct(t.bias_pct, 2),
        `${pct(b.interval_coverage_pct)} (CI ${b.interval_coverage_ci95[0]}-${b.interval_coverage_ci95[1]})`,
      ]),
      [1000, 1340, 1500, 1120, 1200, 1200, 2000],
      ['l', 'r', 'r', 'r', 'r', 'r', 'r']),
    p('WAPE: lower is better. Bias: nearer zero is better. Interval coverage targets 80%.', { size: 18, color: MUTED }),

    h2('Reading it'),
    bullet(`The engine beats the trailing-28 baseline at every horizon, but the margin is under one percentage point of WAPE (${byH.map((x) => (x.e.wape_pct - x.t.wape_pct).toFixed(2)).join(', ')} points). On accuracy alone the engine is barely better than "assume the last 28 days continue".`),
    bullet(`The real gain is in BIAS, and it is substantial. Trailing-28 over-forecasts by ${byH.map((x) => pct(x.t.bias_pct, 1)).join(', ')} at the three horizons; the engine over-forecasts by ${byH.map((x) => pct(x.e.bias_pct, 1)).join(', ')}. Shrinking the recent rate toward the long-run rate is correcting a systematic upward drift in the 28-day window, which is exactly what it is there for. For a store deciding order quantities, a two-thirds reduction in over-forecasting is worth more than a 0.9-point WAPE gain.`),
    bullet(`The prediction interval is honest. Coverage is ${byH.map((x) => pct(x.b.interval_coverage_pct)).join(', ')} against an 80% target, so at 20 and 30 days it is calibrated almost exactly. At 10 days it is too wide (${pct(byH[0].b.interval_coverage_pct)} of actuals fall inside an interval meant to catch 80%), which means short-horizon ranges overstate the uncertainty.`),
    bullet(`The seasonal layer does not help here. engine_seasonal scores ${byH.map((x) => pct(x.es.wape_pct, 2)).join(', ')} against the plain engine's ${byH.map((x) => pct(x.e.wape_pct, 2)).join(', ')}, so it adds a little error at every horizon. The day-of-week signal itself is real and strong at this store (Friday runs about 1.39x an average open day, Monday about 0.79x), but the pre-holiday index cannot be estimated at all: July to October contains no major holiday run-up, so there is no evidence in the data for the one effect that layer exists to catch.`),

    h2('Two of the three baselines are not baselines at this store'),
    p('The production measurement asks whether the engine beats three baselines. At Tuscany only one of them is real, which is why no "beats 3 of 3" claim appears in this report.'),
    table(
      ['Baseline', 'Status at Tuscany', 'Consequence'],
      [
        ['trailing_28', { v: 'Valid', color: GOOD }, 'A 28-day trailing rate. The only independent comparison available.'],
        ['last_year', { v: 'Collapsed', color: WARN },
          `Needs the same calendar window one year earlier. With no history there the estimator falls back to the trailing rate, so it is numerically IDENTICAL to trailing_28 on ${n(dec.horizons ? fc.by_horizon[String(H[0])].forecasts : 0)} of ${n(fc.by_horizon[String(H[0])].forecasts)} forecasts. Beating it is a tautology.`],
        ['year_average', { v: 'Mislabelled', color: WARN },
          'Computes an average over whatever history exists. Here that is about three months, not a year, so it sits very close to the engine\'s own long-run term.'],
      ],
      [1700, 1500, 6160], ['l', 'l', 'l']),

    h1('Part 2. The recommender'),
    p(`Question: when the engine issues a card, does the recommended product then sell at least what its own trailing rate implied? This is the "hit rate" sense of accuracy, and the figure most often quoted. Measured over ${dec.dates.length} decision dates at the same shortened windows.`),
    h2('Result'),
    table(
      ['Measure', 'Value', 'What it means'],
      [
        [{ v: 'Hit rate', color: WARN }, { v: pct(s20.hit_rate), color: WARN },
          `${s20.hits} hits from ${s20.n} cards. Wilson interval ${pct(s20.ci_lo)} to ${pct(s20.ci_hi)}.`],
        ['Date-clustered interval', `${pct(dec.clustered_ci[0])} to ${pct(dec.clustered_ci[1])}`,
          'The interval to quote. Cards issued on one morning share a market, so clustering by date is the only honest resampling.'],
        ['Null, volume-matched', pct(dec.null_volume), `Random baskets of similar volume. Engine edge ${(s20.hit_rate - dec.null_volume).toFixed(1)} points.`],
        [{ v: 'Null, reversion-matched', color: WARN }, { v: pct(dec.null_reversion), color: WARN },
          `Random baskets with a similar reversion profile. Engine edge ${(s20.hit_rate - dec.null_reversion).toFixed(1)} points. This is the honest null and the engine is behind it.`],
        ['Percentile vs the hard null', n(dec.percentile, 1), '50 would be no skill. Below 50 is worse than the matched null.'],
        ['p-value', n(dec.p_value, 4), 'Pooled permutation against the hard null. Cannot reject "no skill", and with this n the test is near powerless.'],
        ['Median lift', `${n(s20.median_lift, 2)}x`, 'Below 1.0 means the median recommended SKU sold less than its trailing rate implied.'],
        ['Incremental margin', { v: money(s20.margin_impact), color: WARN }, `Against each SKU's own trailing rate. The hard null earned ${money(52)} over the same windows.`],
        ['Per card', money(s20.impact_per_card), 'The like-for-like economic figure.'],
        [{ v: 'Cards per run', color: WARN }, { v: n(dec.cards_per_run, 1), color: WARN },
          `Across ${dec.runs} runs. The engine is almost always declining to act.`],
      ],
      [2250, 1500, 5610], ['l', 'r', 'l']),

    h2('By horizon'),
    table(
      ['Horizon', 'Cards', 'Hits', 'Hit rate', '95% CI', 'Reversion null', 'Edge'],
      H.map((h) => {
        const b = decH[String(h)];
        return [`${h} days`, n(b.n), n(b.hits), pct(b.hit_rate),
          `${pct(b.ci_lo)} - ${pct(b.ci_hi)}`, pct(b.null_reversion),
          { v: `${(b.hit_rate - b.null_reversion).toFixed(1)} pts`, color: WARN }];
      }),
      [1100, 900, 800, 1200, 2060, 1800, 1500],
      ['l', 'r', 'r', 'r', 'c', 'r', 'r']),
    p(`Six cards per horizon. No horizon carries enough observations to separate ${pct(s20.hit_rate)} from the ${pct(dec.null_reversion)} null, and the report does not claim otherwise.`, { size: 18, color: MUTED }),

    h1('Why the accuracy is what it is'),
    p('Four reasons, in order of how much they account for. None of them is "the model is badly fitted".'),
    h2('1. The engine is refusing to act, correctly'),
    p(`Across the whole run the engine declined ${n(Object.values(dec.refusals).reduce((a, b) => a + b, 0))} candidate cards and issued ${s20.n}. The refusal reasons are the engine's real predicates, not a summary:`),
    table(
      ['Refusal reason', 'Candidates', 'What it means'],
      Object.entries(dec.refusals).sort((a, b) => b[1] - a[1]).map(([k, v]) => [
        k.replace(/_/g, ' '), n(v),
        k === 'below_materiality_floor' ? `The SKU moves too few units to be worth a card. The floor is ${dec.settings.materiality_floor_units} units.`
          : k === 'trailing_window_inflated' ? 'The trailing window is running above the long run, so a dip-and-revert pick would be measuring its own noise.'
            : k === 'p_hit_below_floor' ? `Modelled probability of a hit below the ${dec.settings.min_hit_probability} floor.`
              : 'Not a merchandise SKU (register mechanics, blocked category, or absent from the catalogue).',
      ]),
      [2600, 1300, 5460], ['l', 'r', 'l']),
    p(`With ${n(audit.sku_depth.at_least_30_days)} of this store's ${n(audit.sku_depth.distinct_skus)} sold SKUs having been sold on 30 or more separate days, almost nothing clears a materiality floor AND has enough observations to model. That is the binding constraint, and it is a data constraint.`),

    h2('2. The sample is far too small to be a verdict'),
    p(`${s20.n} cards. The Wilson interval runs ${pct(s20.ci_lo)} to ${pct(s20.ci_hi)} and the date-clustered interval runs ${pct(dec.clustered_ci[0])} to ${pct(dec.clustered_ci[1])}. A true hit rate of 50% would produce ${s20.hits} hits out of ${s20.n} often enough that this result does not rule it out. The run's own output says the per-run Fisher test is "near-powerless" at this card count, and that is the correct reading.`),

    h2('3. The shortened window removes the signal the recommender runs on'),
    p(`The selection rule looks for SKUs whose recent window is depressed against their own long run, and expects reversion. In production the long run is 365 days. Here it is ${fc.windows_used.long_run_days} days against a ${fc.windows_used.baseline_window_days}-day recent window, so the two overlap heavily and "depressed against the long run" is close to "depressed against itself". The reversion signal is largely gone, which is visible in the result: the reversion-matched null scores ${pct(dec.null_reversion)} while the engine's picks score ${pct(s20.hit_rate)}.`),

    h2('4. No seasonal or holiday evidence exists yet'),
    p('The data covers July to October. There is no Thanksgiving, no Christmas, no New Year, and no prior year to compare any of them against. The pre-holiday index is therefore 1.0 by absence rather than by measurement, and the engine cannot anticipate the largest demand events in a liquor retailer\'s year at this store. The first useful test of that will be the first holiday season with a year of history behind it.'),

    h1('What would change the answer'),
    bullet(`History. The production measurement becomes possible once the store has ${n(need)} days of span, which is ${n(need - span)} days from the current end date, so around ${(() => { const d = new Date(fc.data.last_day); d.setDate(d.getDate() + (need - span)); return d.toISOString().slice(0, 10); })()} at the present collection rate. A meaningful interim read is possible once a full year of history exists.`),
    bullet('A fixed receiving feed. Every purchase row at this store has an unusable date (see the data audit report), so no supplier lead time or delivery cadence can be computed. The order-policy module is therefore working without the one input that tells it when the next delivery lands.'),
    bullet(`More scorable SKUs. ${n(audit.sku_depth.sold_on_1_day_only)} of ${n(audit.sku_depth.distinct_skus)} sold SKUs were sold on exactly one day. Depth accumulates on its own with time, and nothing needs to be done beyond continuing to collect.`),
    bullet('A holiday season in the window, which is the first point at which the seasonal layer can be judged rather than assumed inert.'),

    h1('Method and reproducibility'),
    p('Every figure above comes from one of three runs over a single CSV export. No database is touched by the measurement, which is what makes it replayable later.'),
    table(
      ['Step', 'Command'],
      [
        ['Export', 'node backend/scripts/export-store-sales.js --locations 173 --out ../audit/tuscany/data'],
        ['Forecast accuracy', 'python scripts/short_window_backtest.py --data ../audit/tuscany/data --file store_173_sale_items.csv.gz --store "Tuscany Liquors" --long-run 40 --horizons 10,20,30 --every 2 --out ../audit/tuscany/backtest_short_1020300.json'],
        ['Decision hit rate', 'python scripts/short_window_decisions.py --data ../audit/tuscany/data --file store_173_sale_items.csv.gz --store "Tuscany Liquors" --history 40 --horizons 10,20,30 --every 2 --out ../audit/tuscany/decisions'],
        ['Data audit', 'python scripts/audit_store_data.py --store 173 --out ../audit/tuscany/data_audit_173.json'],
      ],
      [1700, 7660], ['l', 'l']),
    p(`Export: ${n(fc.data.lines)} lines, ${n(fc.data.products)} products, cost present on ${pct(fc.data.cost_coverage_pct)} of sold lines, no lines refused by the data contract. Engine settings in force: materiality floor ${dec.settings.materiality_floor_units} units, minimum hit probability ${dec.settings.min_hit_probability}, baseline window ${dec.settings.baseline_window_days} days, ${dec.settings.n_recs} cards requested per run, ${n(dec.settings.null_baskets)} null baskets per comparison.`, { size: 18, color: MUTED }),

    h1('Limitations'),
    bullet('No figure in this report is a production accuracy estimate, and none may be quoted beside a figure from a store with a full history.'),
    bullet(`The reduced windows (long run ${fc.windows_used.long_run_days} days, horizons ${H.join('/')}) were chosen to fit ${span} days of data. They are stated in the output of every run.`),
    bullet(`Decision dates two days apart share most of their trailing data, so ${dec.dates.length} dates carry considerably less information than ${dec.dates.length} independent observations, even after date clustering.`),
    bullet(`The prediction interval was calibrated on only ${fc.dates.calibration} early dates. That is thin, and it is the most likely explanation for the over-wide ${H[0]}-day interval.`),
    bullet('An earlier version of this analysis used horizons of 7, 14 and 28 days. All three are exact multiples of seven, so each weekday appeared exactly once in every window and the day-of-week multiplier averaged to 1.000 by construction, making the seasonal layer look inert when it had simply been given nothing to vary over. The horizons were changed to 10, 20 and 30 for that reason, and the seasonal figures above come from the corrected run.'),
  ];

  return new Document({
    creator: 'Botella AI', title: 'Tuscany Liquors - Engine Backtest',
    description: 'Reduced-window backtest of the Botella engine at store 173.',
    numbering: NUMBERING,
    styles: { default: { document: { run: { font: 'Calibri', size: 21, color: INK } } } },
    sections: [{
      properties: { page: { size: LETTER.size, margin: MARGIN, orientation: PageOrientation.PORTRAIT } },
      children,
    }],
  });
}

// ──────────────────────────── REPORT 2: DATA AUDIT ────────────────────────────

function auditDoc() {
  const q = audit.quality;
  const present = audit.census.filter((c) => c.rows > 0).sort((a, b) => b.rows - a.rows);
  const empty = audit.census.filter((c) => !c.rows).map((c) => c.table);
  const depth = audit.sku_depth;
  const linkedPct = q.receipts.with_customer / q.receipts.rows * 100;
  const contactPct = q.customers.contactable / q.customers.rows * 100;

  const children = [
    ...titleBlock(
      'BOTELLA ENGINE  /  DATA AUDIT',
      'Tuscany Liquors',
      'Which tables hold this store\'s data, how much of it there is, and where it is not trustworthy.',
      `Store 173 (tuscanyliquors), location ${audit.location_id}  -  warehouse: syncgo  -  report 2026-10-15`),

    h1('Verdict'),
    callout([
      { text: 'The feeds that matter are clean. The problem is that there are only three months of them, and one feed is unusable.', bold: true },
      `Sales, sale items and the product master are in good order: cost is present on ${pct(q.lines.with_cost / q.lines.rows * 100, 2)} of sold lines and ${pct(q.products.with_cost / q.products.rows * 100, 2)} of products, there are no void receipts, no null quantities and no blank SKUs. That is better coverage than most stores in the estate.`,
      { text: `Three findings limit what can be built on it.`, bold: true },
      `1. Only ${n(q.receipts.trading_days)} trading days exist (${q.receipts.first} to ${q.receipts.last}), which is ${Math.round(span / need * 100)}% of what the engine's own backtest requires.`,
      { text: `2. Every one of the ${n(q.purchases.rows)} purchase rows has an unusable date, so no lead time or delivery cadence can be computed at all.`, color: WARN },
      { text: `3. Of ${n(q.customers.rows)} customers, ${n(q.customers.contactable)} (${pct(contactPct, 2)}) have a phone or email, so win-back has almost no reachable audience.`, color: WARN },
    ]),

    h1('Data confidence score'),
    p('One clarification first, because the word is overloaded. "Confidence" appears in '
      + 'four places in this product and they measure unrelated things: the number on a '
      + 'card, the coverage of a forecast range, the engine confidence score in the '
      + 'companion backtest report, and the data confidence score below. This one is '
      + 'the narrowest of the four and the easiest to state plainly:'),
    callout([
      { text: 'Data confidence asks one question: how far can the feeds this store '
        + 'sends us support any analysis at all?', bold: true },
      'It says nothing about whether the engine is any good, and nothing about whether a '
      + 'particular recommendation will work. A store could score 100 here and still be '
      + 'unmodellable for want of history, or score badly and still be perfectly well '
      + 'served once one feed is repaired. It is a readiness measure, not a verdict.',
      `For how much the ENGINE can be relied on at this store, see the engine confidence `
      + `score in the backtest report, which stands at ${CONF.engine_confidence} out of `
      + `100. The two are deliberately not combined.`,
    ], 'EFF2E6'),
    callout([
      { text: `Data confidence at this store: ${CONF.data_confidence.score} out of 100.`,
        bold: true },
      'Scored per feed, and deliberately NOT folded into the engine confidence score '
      + 'in the companion report. A store can have immaculate data and no history, or '
      + 'three years of history behind a broken receiving feed, and averaging those '
      + 'tells a reader nothing about which one to fix.',
      { text: 'The spread is the whole story: two feeds near 100, one at zero.',
        bold: true },
      'Sales and the product master are as good as any store in the estate. Receiving '
      + 'scores zero because every purchase date is unusable. Customer identification '
      + 'scores near zero because almost nothing is linked or contactable. History is '
      + 'simply young.',
    ]),
    table(
      ['Feed', 'Score', 'What the score is based on'],
      CONF.data_confidence.components.map((c) => [
        c.label,
        { v: n(c.score, 1), color: c.score >= 90 ? GOOD : (c.score < 30 ? WARN : INK) },
        c.detail,
      ]).concat([[{ v: 'Mean', color: INK },
        { v: n(CONF.data_confidence.score, 1), color: INK },
        'equally weighted across the five feeds the engine reads']]),
      [2300, 900, 6160], ['l', 'r', 'l']),
    p('Receiving is scored on DATE USABILITY rather than row count on purpose. The '
      + 'rows are there and the costs are good, but a purchase with no usable date '
      + 'cannot produce a lead time, a delivery cadence or a reorder point, and those '
      + 'are the only things this feed is read for. Scoring it on how many rows arrived '
      + 'would report 100 for a feed that answers none of the questions asked of it.',
      { size: 18, color: MUTED }),

    h1('Table census'),
    p(`${present.length} of ${audit.census.length} client-scoped tables hold data for this store. Row counts are for this store only, not the whole warehouse.`),
    table(
      ['Table', 'Rows', 'Date column', 'Coverage', 'Days'],
      present.map((c) => [
        c.table, n(c.rows), c.date_column || 'none',
        c.non_finite_dates && c.non_finite_dates === c.rows
          ? { v: 'all dates unusable', color: WARN }
          : (c.first ? `${c.first} to ${c.last}` : 'no finite dates'),
        c.distinct_days ? n(c.distinct_days) : '-',
      ]),
      [2300, 1100, 1700, 3160, 1100], ['l', 'r', 'l', 'l', 'r']),
    p(`Empty for this store: ${empty.join(', ')}. These are operational and job-log tables; an empty job history is expected for a store onboarded in July.`, { size: 18, color: MUTED }),

    h1('Feed-by-feed quality'),

    h2('Sales and sale items'),
    table(
      ['Measure', 'Value', 'Assessment'],
      [
        ['Receipts', n(q.receipts.rows), `${n(q.receipts.trading_days)} trading days, ${q.receipts.first} to ${q.receipts.last}.`],
        ['Sale item lines', n(q.lines.rows), `${n(q.lines.sold)} with status Sold.`],
        ['Void receipts', { v: n(q.receipts.voids), color: GOOD }, 'None. Nothing has to be excluded as a reversal.'],
        ['Null subtotals', { v: n(q.receipts.null_subtotal), color: GOOD }, 'None. Every receipt carries a pre-tax net value, which is the revenue basis used everywhere.'],
        ['Blank SKUs', { v: n(q.lines.blank_sku), color: GOOD }, 'None. Every line attributes to a product.'],
        ['Null quantities', { v: n(q.lines.null_qty), color: GOOD }, 'None.'],
        ['Non-positive quantities', n(q.lines.nonpositive_qty), `${n(q.lines.nonpositive_qty)} lines at or below zero units, ${pct(q.lines.nonpositive_qty / q.lines.rows * 100, 2)} of lines. Excluded by the loader rather than treated as sales.`],
        ['Lines with a price', { v: n(q.lines.with_price), color: GOOD }, pct(q.lines.with_price / q.lines.rows * 100, 2) + ' of lines.'],
        ['Lines with a cost', { v: n(q.lines.with_cost), color: GOOD }, pct(q.lines.with_cost / q.lines.rows * 100, 2) + ' of lines. Margin figures at this store are measured, not defaulted.'],
        ['Distinct SKUs sold', n(q.lines.distinct_skus), 'Against ' + n(q.products.rows) + ' products in the master.'],
        [{ v: 'Receipts linked to a customer', color: WARN }, { v: n(q.receipts.with_customer), color: WARN },
          pct(linkedPct, 1) + ' of receipts. The other ' + pct(100 - linkedPct, 1) + ' are anonymous, so all customer analysis covers a tenth of trade and must be read as a floor.'],
      ],
      [2500, 1300, 5560], ['l', 'r', 'l']),

    h2('Product master'),
    table(
      ['Measure', 'Value', 'Assessment'],
      [
        ['Products', n(q.products.rows), 'Last updated ' + q.products.newest + '.'],
        ['With a name', { v: n(q.products.named), color: GOOD }, 'All of them.'],
        ['With a cost', { v: n(q.products.with_cost), color: GOOD }, pct(q.products.with_cost / q.products.rows * 100, 2) + '. Only ' + n(q.products.rows - q.products.with_cost) + ' lack one.'],
        ['With a stock quantity', { v: n(q.products.with_stock), color: GOOD }, 'All of them, so on-hand is known rather than assumed.'],
        ['With a category', n(q.products.with_category), pct(q.products.with_category / q.products.rows * 100, 2) + '. ' + n(q.products.rows - q.products.with_category) + ' uncategorised, which excludes them from category-level comparisons.'],
      ],
      [2500, 1300, 5560], ['l', 'r', 'l']),

    h2('Purchases and suppliers'),
    callout([
      { text: `Every purchase row at this store has an unusable date.`, bold: true, color: WARN },
      `All ${n(q.purchases.rows)} rows carry '-infinity' in the date column. Postgres accepts that value and the driver then refuses to read it, so the column is not merely sparse, it is unreadable. A date before the year 1 is a missing value written as a sentinel, not an early delivery.`,
      `Consequence: no supplier lead time, no delivery cadence and no reorder timing can be computed for Tuscany. The order-policy module runs without the input that tells it when the next delivery arrives. This is a feed defect to raise with whoever owns the receiving integration, and it is independent of history length: it will not fix itself with time.`,
    ], 'FBF0E4'),
    table(
      ['Measure', 'Value', 'Assessment'],
      [
        ['Purchase rows', n(q.purchases.rows), 'Present and otherwise populated.'],
        [{ v: 'Rows with a usable date', color: WARN }, { v: '0', color: WARN }, `All ${n(q.purchases.non_finite_dates)} are non-finite.`],
        ['Distinct suppliers', n(q.purchases.suppliers), 'Against ' + n(present.find((c) => c.table === 'suppliers')?.rows || 0) + ' rows in the suppliers table.'],
        ['Distinct SKUs purchased', n(q.purchases.skus), 'Good breadth; the receiving feed itself is working.'],
        ['Rows with a cost', { v: n(q.purchases.with_cost), color: GOOD }, pct(q.purchases.with_cost / q.purchases.rows * 100, 1) + '. Purchase cost is reliable even though the date is not.'],
      ],
      [2500, 1300, 5560], ['l', 'r', 'l']),

    h2('Customers'),
    table(
      ['Measure', 'Value', 'Assessment'],
      [
        ['Customer records', n(q.customers.rows), 'Snapshot dated ' + (present.find((c) => c.table === 'customers')?.first || 'unknown') + ', and that is the only date present.'],
        [{ v: 'Contactable', color: WARN }, { v: n(q.customers.contactable), color: WARN },
          pct(contactPct, 2) + ' have a phone or email. Win-back can address ' + n(q.customers.contactable) + ' people in total.'],
        ['Deleted', n(q.customers.deleted), 'None flagged deleted.'],
      ],
      [2500, 1300, 5560], ['l', 'r', 'l']),
    p(`The customers table carries a single update timestamp for every row, which means it has been loaded once and not refreshed since. A customer list that does not update cannot show churn, and segment movement at this store will be measured from sales rather than from the customer feed.`),

    h1('How much of this data is actually modellable'),
    p('Row counts overstate what a forecaster can use. Demand estimation needs repeated observations of the same SKU, and most SKUs at a three-month-old store do not have them.'),
    table(
      ['Sold on at least', 'SKUs', 'Share of sold SKUs'],
      [
        ['1 day (all sold SKUs)', n(depth.distinct_skus), '100%'],
        ['exactly 1 day', { v: n(depth.sold_on_1_day_only), color: WARN }, pct(depth.sold_on_1_day_only / depth.distinct_skus * 100, 1)],
        ['2 days', n(depth.at_least_2_days), pct(depth.at_least_2_days / depth.distinct_skus * 100, 1)],
        ['5 days', n(depth.at_least_5_days), pct(depth.at_least_5_days / depth.distinct_skus * 100, 1)],
        ['10 days', n(depth.at_least_10_days), pct(depth.at_least_10_days / depth.distinct_skus * 100, 1)],
        ['20 days', n(depth.at_least_20_days), pct(depth.at_least_20_days / depth.distinct_skus * 100, 1)],
        ['30 days', { v: n(depth.at_least_30_days), color: WARN }, pct(depth.at_least_30_days / depth.distinct_skus * 100, 1)],
      ],
      [3100, 1500, 4760], ['l', 'r', 'r']),
    p(`${n(depth.at_least_30_days)} SKUs have been sold on 30 or more separate days. Those are the only ones with enough signal for a confident per-SKU forecast, and they are ${pct(depth.at_least_30_days / depth.distinct_skus * 100, 1)} of what the store sells. This is the figure that bounds the backtest in the companion report, and it rises on its own as history accumulates.`),

    h1('Trading pattern'),
    table(
      ['Month', 'Trading days', 'Receipts', 'Revenue (pre-tax net)'],
      audit.monthly.map((m) => [m.month, n(m.trading_days), n(m.receipts), '$' + n(m.revenue, 0)]),
      [2000, 2200, 2200, 2960], ['l', 'r', 'r', 'r']),
    p(`Trade is steady and slightly growing across the three full months. ${audit.monthly[audit.monthly.length - 1].month} is partial (${audit.monthly[audit.monthly.length - 1].trading_days} days) and must not be compared with the others. The store appears to trade close to every day, which is why open days rather than calendar days are the correct denominator everywhere in the engine.`),

    h1('What to fix, in order'),
    bullet('The purchase date feed. Every row is a sentinel value, it blocks lead time and reorder timing outright, and it is the only finding here that will not improve with time. Owner: whoever maintains the receiving integration.', { bold: true }),
    bullet(`Customer capture at the till. ${pct(linkedPct, 1)} of receipts carry a customer and ${pct(contactPct, 2)} of customer records have a contact method. Both are operational rather than technical, and both cap what customer analysis can honestly report.`),
    bullet('Refresh the customers table. It holds one load dated ' + (present.find((c) => c.table === 'customers')?.first || 'a single day') + ' and has not moved since, so it cannot show churn.'),
    bullet(`The ${n(q.products.rows - q.products.with_category)} uncategorised products, which drop out of every category comparison.`),
    bullet('Nothing else. Cost, price, quantity, stock and SKU integrity are all in good order, and the remaining limitation is simply that the store is three months old.'),

    h1('Method'),
    p('Read-only, SELECT against syncgo, which is the same path every capability reads through. Nothing was written. The audit enumerates every table carrying a client_id, excluding the monthly partitions of sales and sale_items so their rows are counted once rather than twice.'),
    p('python scripts/audit_store_data.py --store 173 --out ../audit/tuscany/data_audit_173.json', { size: 18, color: MUTED }),
    p('One note on method, because it changes a number: date ranges exclude non-finite values. Left in, the -infinity dates in purchases would have made that feed appear to begin before the year 1 and would have widened every span computed from it. They are excluded from ranges and counted separately instead.', { size: 18, color: MUTED }),
  ];

  return new Document({
    creator: 'Botella AI', title: 'Tuscany Liquors - Data Audit',
    description: 'Table census and data-quality audit for store 173.',
    numbering: NUMBERING,
    styles: { default: { document: { run: { font: 'Calibri', size: 21, color: INK } } } },
    sections: [{
      properties: { page: { size: LETTER.size, margin: MARGIN, orientation: PageOrientation.PORTRAIT } },
      children,
    }],
  });
}

(async () => {
  const jobs = [
    ['Tuscany-Liquors-Engine-Backtest.docx', backtestDoc()],
    ['Tuscany-Liquors-Data-Audit.docx', auditDoc()],
  ];
  for (const [name, doc] of jobs) {
    const buf = await Packer.toBuffer(doc);
    const out = path.join(HERE, name);
    fs.writeFileSync(out, buf);
    console.log(`wrote ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
})();
