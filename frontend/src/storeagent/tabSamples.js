// tabSamples.js
// -----------------------------------------------------------------------------
// WORKED EXAMPLES, one per tab, for the screens an owner cannot yet use.
//
// `RetrievalNotice` already tells a store the truth when its data is absent:
// "Customer insights is not available for your store ... contact Botella AI
// Labs". True, and still a dead end - the owner is told what is missing and
// nothing about what they are missing, so "connect my purchase feed" sounds
// like paperwork rather than something that buys them anything.
//
// So the MISSING notice now carries one of these: the same tab, filled in,
// from a demonstration store. It answers "what would I see here?" without
// waiting on an integration.
//
// TWO RULES, both non-negotiable.
//
//   NOTHING HERE MAY BE MISTAKEN FOR THE OWNER'S OWN FIGURES. Every sample is
//   rendered behind an EXAMPLE badge and a caption naming the demonstration
//   store, and the numbers are deliberately round in a way real register data
//   never is. A tutorial that reads as a dashboard is worse than a blank page,
//   because the owner acts on it.
//
//   NOTHING HERE IS COMPUTED. These are literals. They never pass through the
//   engine, are never written anywhere, and no figure on a real screen is ever
//   sourced from this file - which is what keeps a sample out of a forecast.
//
// `metrics` is the headline strip, `columns`/`rows` the table beneath it, and
// `reading` the two or three sentences that say what an owner DOES about it.
// Every tab uses the same shape so `TabTutorial` can render any of them.
// -----------------------------------------------------------------------------

//: The demonstration store every sample is attributed to. Named, and named
//: consistently, so the caption can say whose numbers these are. It is not one
//: of ours: a sample attributed to a real pilot store would be read as that
//: store's trading figures by anyone who recognised the name.
export const SAMPLE_STORE = 'Westbrook Fine Wine & Spirits (demonstration store)';

const SAMPLES = {
  // ── Buying / purchase orders ───────────────────────────────────────────────
  purchasing: {
    heading: 'What your buying list looks like once orders are connected',
    blurb:
      'One line per bottle worth reordering, with the quantity and the deadline '
      + 'the engine worked out from how fast it actually sells in your store.',
    metrics: [
      { label: 'Bottles to reorder', value: '18', hint: 'across 6 suppliers' },
      { label: 'Cash it commits', value: '$4,200', hint: 'at your cost' },
      { label: 'Soonest deadline', value: '3 days', hint: 'before you run dry' },
    ],
    columns: ['Product', 'On hand', 'Order', 'Order by', 'Why'],
    rows: [
      ['Tito’s Handmade Vodka 1.75L', '4', '24', 'in 3 days',
        'sells 2.1/day, 2 days of cover left'],
      ['Jameson Irish Whiskey 750ml', '6', '12', 'in 6 days',
        'sells 0.9/day, St Patrick’s run-up'],
      ['Josh Cellars Cabernet 750ml', '2', '18', 'in 2 days',
        'out of stock 4 days last month'],
      ['Modelo Especial 12pk', '9', '20', 'in 8 days', 'steady 1.4/day'],
    ],
    reading: [
      'Order by is a deadline, not a suggestion: it is the last day an order '
      + 'can be placed and still arrive before the shelf is empty.',
      'The quantity is what covers demand until your next delivery, so a bigger '
      + 'number means a longer gap between orders, not a bigger bet.',
    ],
  },

  // ── Effectiveness / did it work ────────────────────────────────────────────
  effectiveness: {
    heading: 'What the effectiveness report looks like once orders are connected',
    blurb:
      'Every recommendation you acted on, graded against what the bottle '
      + 'actually did afterwards - and the ones that cannot be graded yet, '
      + 'said so plainly.',
    metrics: [
      { label: 'Confirmed acted on', value: '46', hint: 'from your own order data' },
      { label: 'Outperformed', value: '21', hint: 'beat the expectation' },
      { label: 'Still pending', value: '12', hint: 'window not closed' },
    ],
    columns: ['Product', 'Ordered', 'Sold', 'Verdict', 'On what evidence'],
    rows: [
      ['Tito’s Handmade Vodka 1.75L', '24', '26', 'outperformed',
        'purchase order 14 Mar, sold through in 19 days'],
      ['Jameson Irish Whiskey 750ml', '12', '11', 'as expected',
        'purchase order 11 Mar'],
      ['Josh Cellars Cabernet 750ml', '18', '7', 'underperformed',
        'purchase order 9 Mar, 11 still on hand'],
      ['Casamigos Blanco 750ml', '6', '—', 'cannot be said yet',
        '30-day window closes in 8 days'],
    ],
    reading: [
      'A verdict needs evidence that the order happened. Without a purchase '
      + 'feed the engine will not guess - it says "cannot be said yet" rather '
      + 'than grading a card you may never have acted on.',
      '"As expected" is a pass, not a shrug: it means the bottle sold at the '
      + 'rate the engine predicted when it wrote the card.',
    ],
  },

  // ── Recommendations home ──────────────────────────────────────────────────
  recommendations: {
    heading: 'What your daily recommendations look like with your data connected',
    blurb:
      'Eight to ten cards a morning, each one naming the bottle, the quantity, '
      + 'and the reason in the store’s own numbers.',
    metrics: [
      { label: 'Cards this morning', value: '9', hint: 'refreshed overnight' },
      { label: 'Reorder before stockout', value: '6', hint: 'the urgent half' },
      { label: 'Signal-led', value: '3', hint: 'weather, a home game, a holiday' },
    ],
    columns: ['Card', 'Bottle', 'Act by', 'Reason'],
    rows: [
      ['Reorder', 'Tito’s Handmade Vodka 1.75L', 'in 3 days',
        '2 days of cover at 2.1 sold/day'],
      ['Reorder', 'Josh Cellars Cabernet 750ml', 'in 2 days',
        'was out of stock 4 days last month'],
      ['Weather', 'White Claw Variety 12pk', 'this week',
        'heat advisory Thu-Sat; seltzer lifts in heat here'],
      ['Markdown', 'Beaujolais Nouveau 750ml', 'this week',
        '41 on hand, 0.2 sold/day, ties up $380'],
    ],
    reading: [
      'Cards are ordered by deadline, so the top of the list is the thing that '
      + 'runs out first - not the most expensive thing.',
      'A signal card only appears when that signal has a measured effect in '
      + 'your own store. Until it is measured, it is not shown.',
    ],
  },

  // ── Customers ─────────────────────────────────────────────────────────────
  customers: {
    heading: 'What customer insights look like once your loyalty data is connected',
    blurb:
      'Who buys, how often, and which groups are worth a message - built from '
      + 'register receipts linked to a named customer.',
    metrics: [
      { label: 'Linked customers', value: '1,240', hint: '62% of receipts' },
      { label: 'Repeat buyers', value: '430', hint: '3+ visits in 90 days' },
      { label: 'Lapsed, worth winning back', value: '85', hint: 'no visit in 60 days' },
    ],
    columns: ['Group', 'People', 'Average basket', 'What it suggests'],
    rows: [
      ['Weekly regulars', '186', '$38', 'your base; protect the range they buy'],
      ['Wine-only buyers', '274', '$52', 'have never bought spirits from you'],
      ['Lapsed 60+ days', '85', '$44', 'a win-back message is worth sending'],
      ['One-visit only', '512', '$21', 'mostly passing trade'],
    ],
    reading: [
      'Contactability is the limit on any of this: a group is only actionable '
      + 'if those receipts carry a name, so the linked percentage above matters '
      + 'more than the group sizes.',
      'Cash and card receipts with no customer attached are counted but cannot '
      + 'be messaged, and are never padded into these groups.',
    ],
  },

  // ── Market / peer comparison ──────────────────────────────────────────────
  market: {
    heading: 'What the market comparison looks like with peer data connected',
    blurb:
      'Your range against comparable stores - where you are missing something '
      + 'that sells for them, and where you carry something they dropped.',
    metrics: [
      { label: 'Comparable stores', value: '24', hint: 'similar size and area' },
      { label: 'Gaps in your range', value: '11', hint: 'they sell it, you do not' },
      { label: 'Worth trialling', value: '4', hint: 'after margin and space' },
    ],
    columns: ['Product', 'Peers carrying it', 'Their rate', 'Read'],
    rows: [
      ['Espolon Blanco 750ml', '19 of 24', '1.2/day', 'the clearest gap'],
      ['High Noon Variety 8pk', '17 of 24', '2.0/day', 'strong in summer'],
      ['Aperol 750ml', '14 of 24', '0.4/day', 'slow but high margin'],
      ['Fireball 1.75L', '21 of 24', '0.8/day', 'you already stock this'],
    ],
    reading: [
      'A gap is a question, not an instruction: peers selling something says '
      + 'nothing about your own shelf space or your customers.',
      'Rates are per peer store per day, so they are comparable to your own '
      + 'sold-per-day figures elsewhere in the app.',
    ],
  },

  // ── Dashboard / summary ───────────────────────────────────────────────────
  dashboard: {
    heading: 'What your dashboard looks like once sales are flowing',
    blurb:
      'The morning read: what moved, what stalled, and what needs a decision '
      + 'today.',
    metrics: [
      { label: 'Sales, last 7 days', value: '$18,400', hint: 'up 6% on prior 7' },
      { label: 'Bottles at risk of stockout', value: '6', hint: 'within 5 days' },
      { label: 'Cash tied up in slow stock', value: '$2,900', hint: '34 products' },
    ],
    columns: ['Area', 'Now', 'Prior period', 'Read'],
    rows: [
      ['Spirits', '$9,100', '$8,300', 'up; vodka and tequila leading'],
      ['Wine', '$5,600', '$5,800', 'flat'],
      ['Beer & seltzer', '$3,100', '$2,600', 'up; warm week'],
      ['Open days in period', '7', '7', 'like-for-like'],
    ],
    reading: [
      'Everything is measured over open days, never calendar days, so a public '
      + 'holiday does not read as a bad week.',
      'A period with no trading is reported as unmeasurable rather than as zero.',
    ],
  },
};

//: Tabs whose data all comes from the same place get the same worked example
//: rather than a near-duplicate of it: the ledger, the pending list and the PO
//: report are three views of one question ("did the cards work?").
const ALIASES = {
  ledger: 'effectiveness',
  pending: 'effectiveness',
  poEffectiveness: 'effectiveness',
  insights: 'dashboard',
  commandCenter: 'dashboard',
  suggestions: 'recommendations',
};

/** The worked example for a tab, or null when that tab has none.
 *
 * Returns null rather than throwing or substituting a default: a tab with no
 * sample should show the plain notice, and inventing a generic example for it
 * would teach the owner about a screen they are not looking at.
 */
export function sampleFor(key) {
  if (!key) return null;
  const resolved = ALIASES[key] || key;
  return SAMPLES[resolved] || null;
}

export default SAMPLES;
