// features.js
// -----------------------------------------------------------------------------
// Surfaces that are built, working, and deliberately not shown yet.
//
// This is NOT dead code and it is NOT a kill switch for something broken at the
// UI layer. Every screen behind a flag here renders correctly; what is missing
// is the evidence that the number it prints is worth showing a store owner.
// Flip a flag back to `true` and the screen returns exactly as it was.
//
// Why, today:
//
//   EFFECTIVENESS - ON since migration 039. It was withdrawn because the
//     screen scored a handful of hand-counted outcomes and, worse, because
//     "Completed" was a browser-side click: the ledger of recommendations
//     "being measured" came from localStorage, so the screen could not tell a
//     card the owner followed from one the owner tapped. Both are fixed: the
//     evaluation job runs nightly, and a card is Completed only when the
//     server's fulfilment_state is 'confirmed' - a purchases-feed row, a
//     matched invoice, a stock inflow, a price drop, a catalogue arrival. The
//     owner's click shows as "Marked done" until the data confirms it. The
//     screen, its nav item, the home-page tile and the /effectiveness and
//     /suggestions routes are all back.
//
//   BOTTLESENSE - held back for the demo, by request.
//
// Hiding a nav item is not enough on its own: the view is derived from the URL
// (ChatPage.viewFromPath), so /effectiveness typed, bookmarked, or left in a
// tester's history would still render the screen with the nav item gone. The
// route guard lives with the flag - see HIDDEN_VIEWS below - so the two can
// never drift apart.
//
// CARD STATEMENTS is the other kind of flag: not withdrawn, not yet rolled out.
// It follows the build (see below) instead of being a plain true/false.
// -----------------------------------------------------------------------------

import { IS_INTERNAL } from './env';

/** Show the Effectiveness screen, its nav item, and the home-page tile.
 *
 * OFF, 20 Oct 2026, by request, ahead of the QA deploy. The screen is not
 * wrong - it now refuses to put a number on a store with no purchase feed -
 * but it is being withheld until it has something to show at every pilot
 * store. The route guard (HIDDEN_VIEWS) follows this flag, as does the
 * Recommendations sub-tab (RecommendationsView.SHOW_EFFECTIVENESS_TAB), so
 * there is no side door. */
export const SHOW_EFFECTIVENESS = false;

/** Show the "N more recommendations - lower estimated value" folded group
 * under the open list.
 *
 * OFF, 20 Oct 2026, by request: the owner is not to be shown the cards that
 * did not clear the value floor at all. With the group hidden, the open-tab
 * headline counts only the cards on screen - a header reading "8 open" over
 * a list of five is the contradiction RecommendationsHome already documents
 * from Bethany on 29 Sep. The cards themselves are still generated, scored
 * and persisted; only the fold is withheld. */
export const SHOW_FOLDED_RECOMMENDATIONS = false;

/**
 * Show the per-card confidence figure or band to the owner.
 *
 * OFF, on a reviewer's measurement (2026-10-19). The number is not a
 * probability and does not mean the same thing from one card to the next:
 * 352 cards in the analytics store carried no `confidence_basis` at all; 33
 * (nine of ten at Tuscany) showed the engine's raw ranking score passed
 * through unchanged; every isotonic-calibrated card returned the same 0.444;
 * and on the forward test higher stated confidence went with LOWER hit rates
 * (0.23 -> 50% hit, 0.41 -> 7%). A number that sorts cards the wrong way
 * round is worse on the screen than no number.
 *
 * What this hides: the "Confidence · Fairly confident" line on the card
 * detail, the engine's store-level sentence that stood in for it on a flat
 * slate (it quotes the same percentage - "44% is how often..." - so it goes
 * with the figure it explained), the percentage and bar on the Suggestions
 * footer, the percentage chips on the Insights summary, and the Confidence
 * column of the CSV export. The field itself still travels on the API; the
 * ranking of cards never read it (expected margin does that); and the
 * admission gate now applies its floor only to a calibrated, discriminating
 * basis (backend/services/recommendationGateService.js).
 *
 * Flip back to `true` when audit/calibration/ shows a curve that differentiates
 * cards out of sample - AUC above 0.5 with its interval, ECE under the
 * registry's threshold - and not before.
 */
export const SHOW_CARD_CONFIDENCE = false;

/** Show the BottleSense screen and its nav item. */
export const SHOW_BOTTLESENSE = false;

/**
 * Show Card Statement Analysis: the screen, its nav item and its route.
 *
 * ON for QA and staging builds and for local development (`npm start`), OFF in
 * a production build until the rollout. It follows the build rather than a
 * literal so testers get it on every internal bundle without anyone editing
 * this file and remembering to put it back.
 *
 * Overridable at build time, both ways:
 *
 *     REACT_APP_SHOW_CARD_STATEMENTS=true   npm run build   -> shown in production
 *     REACT_APP_SHOW_CARD_STATEMENTS=false  npm start       -> hidden in local dev
 *
 * Anything else (unset, misspelled) means "follow the build", so a typo cannot
 * switch it on in production: the fail-safe direction is the same as env.js.
 *
 * This hides the screen, not the API. /api/card-statements answers any valid
 * session whatever this says.
 */
const CARD_STATEMENTS_OVERRIDE = String(process.env.REACT_APP_SHOW_CARD_STATEMENTS || '').trim().toLowerCase();
export const SHOW_CARD_STATEMENTS = (CARD_STATEMENTS_OVERRIDE === 'true' || CARD_STATEMENTS_OVERRIDE === '1')
  ? true
  : (CARD_STATEMENTS_OVERRIDE === 'false' || CARD_STATEMENTS_OVERRIDE === '0')
    ? false
    : (IS_INTERNAL || process.env.NODE_ENV === 'development');

/**
 * Mask customer identity on the Customers screen: real names become initials
 * and the customer id is truncated.
 *
 * ON while the product is being shown to prospects. The Customers screen lists
 * named individuals with their annual spend and how overdue a visit is, which
 * is a real person's shopping habits on a projector in a room of strangers -
 * and those people are the PROSPECT'S customers, not ours to display.
 *
 * TURN THIS OFF BEFORE REAL STORES USE WIN-BACK. The whole point of that table
 * is to phone the customer, and an owner cannot ring "J.D." Masked is the safe
 * default for a demo and the wrong default for the job.
 *
 * ── SHEET 18: THIS NOW HAS A DEADLINE, AND IT IS NOT "WHEN SOMEBODY NOTICES"
 *
 * The gate (sheet 17) moves a family from shadow to live automatically, once
 * it has beaten a volume-matched null at a store. `win_back` is one of those
 * families. So the day this flag becomes a live product problem is a day
 * chosen by a p-value, not by a release plan - and nobody will be watching for
 * it.
 *
 * The failure is quiet and complete: the gate proves win-back works, the cards
 * go live, and every one of them names a customer the owner cannot identify.
 * The recommendation is correct, measured, validated by sheets 14 and 16 - and
 * unusable. None of those gates can catch it, because none of them asks
 * whether the owner can ACT on a correct card.
 *
 * This is a product and privacy decision that needs an owner:
 *
 *   - does the store see its own customers' names? (they are the store's
 *     customers and the store's data, which is an argument for yes)
 *   - if yes, under what consent, and does the demo path stay masked?
 *   - if no, then win-back should be removed from the family list rather than
 *     shipped in a form that cannot be acted on.
 *
 * NOT CHANGED HERE. Deciding it in a frontend constant would be making a
 * privacy call in a rendering utility. It is raised in SHEET-18-STORE-INTERFACE
 * and in ENGINE-REBUILD's open-questions list so it is settled deliberately,
 * BEFORE the gate opens win-back, rather than discovered at that point.
 */
export const MASK_CUSTOMER_IDENTITY = true;

/**
 * "Sarah Jennings" -> "S.J." · "Miguel" -> "M." · falls back to the id when
 * there is no name to reduce. Initials, not a hash: the owner watching a demo
 * still sees that these are distinct people with distinct habits, which is the
 * point the table is making.
 */
export function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.slice(0, 3).map((w) => `${w[0].toUpperCase()}.`).join('');
}

/**
 * Tenants the product is currently being DEMONSTRATED on.
 *
 * These are logged into from a QA or staging build - that is how the demo gets
 * the newest work - and an internal build shows internal tooling. The
 * "Generate Insights" bar is the visible one: an env badge and a button
 * captioned "Testers only; not shown to stores", sitting on the first screen a
 * prospect sees. It is correct for a tester and wrong for an audience.
 *
 * Gating on the TENANT rather than the build is deliberate. Hiding the bar
 * everywhere would take the tool off the testers who need it, and shipping a
 * separate production build for the demo would mean demoing something other
 * than the code under test.
 */
/*
 * SET AT BUILD TIME, not hardcoded.
 *
 *     REACT_APP_DEMO_CLIENT_IDS=171,46  npm run build
 *
 * It used to be a literal `['171']`, which meant the testers who most needed
 * the Generate Insights button - the ones working on store 171 - were the only
 * people who could not see it, and the only way to get it back was to edit this
 * file and remember to put it back afterwards.
 *
 * UNSET MEANS NO DEMO TENANTS, so the bar is visible. That is the opposite of
 * the fail-safe direction used in env.js, and it is deliberate: the bar is only
 * compiled into an INTERNAL build at all (CAN_GENERATE_INSIGHTS = IS_INTERNAL),
 * so the worst case here is a tester seeing a tester's button. A production
 * build cannot show it whatever this variable says.
 *
 * BEFORE A DEMO, set the variable for that build. The bar carries an env badge
 * and the caption "Testers only; not shown to stores", which is correct for a
 * tester and wrong in front of a prospect.
 */
const DEMO_CLIENT_IDS = new Set(
  String(process.env.REACT_APP_DEMO_CLIENT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/**
 * Is the signed-in store one we are demoing on? Reads the id the login stored;
 * an unreadable or absent id answers NO, so a storage failure degrades toward
 * the tester's behaviour rather than silently stripping their tools.
 */
export function isDemoAccount() {
  try {
    const id = (localStorage.getItem('botella_client_id') || '').trim();
    return id ? DEMO_CLIENT_IDS.has(id) : false;
  } catch {
    return false;
  }
}

/**
 * Views that must not resolve from a URL while their flag is off. ChatPage
 * treats these as unknown, which lands on `recommendations` - the same place
 * any other unrecognised path goes, so a stale bookmark degrades quietly
 * instead of opening a screen we chose to withdraw.
 *
 * 'suggestions' rides along with Effectiveness: it is a deep link that maps to
 * the same nav item (VIEW_TO_NAV), so leaving it reachable would be a side door
 * into a hidden screen.
 */
export const HIDDEN_VIEWS = [
  ...(SHOW_EFFECTIVENESS ? [] : ['effectiveness', 'suggestions']),
  ...(SHOW_BOTTLESENSE ? [] : ['bottlesense']),
  ...(SHOW_CARD_STATEMENTS ? [] : ['card-statements']),
];

/** True when `view` is withdrawn by a flag above. */
export function isHiddenView(view) {
  return HIDDEN_VIEWS.includes(String(view || ''));
}
