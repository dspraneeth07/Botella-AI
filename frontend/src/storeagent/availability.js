// Is a capability's data actually there?
//
// WHAT WENT WRONG WITHOUT THIS. A capability payload arrives as 200 with the
// sections it could compute, and a store that has no CRM, no cost data or no
// supplier history simply gets fewer sections. The panel then rendered the view
// anyway: `if (!d || !View) return null` hid the whole thing silently when the
// payload was missing, and when a SECTION was missing the view rendered its
// headings over nothing - stat tiles reading 0, tables with no rows, a bar
// chart with no bars. Both readings are wrong in the same direction. An owner
// cannot tell "your store has no customer data" from "the number really is
// zero", and zero is the more alarming of the two.
//
// Only three capabilities carry an explicit flag - customers.customer_radar,
// market.market, overview.overview - and only some of the views honoured it.
// Inventory had no availability handling at all. So this is one rule, applied
// to every capability in one place.
//
// THE RULE, in order:
//   1. An explicit `available: false` on the section is decisive. It carries a
//      `reason`, written by the engine that tried, and that is the best
//      sentence we will ever have for why.
//   2. A section that is absent, null, an empty array or an empty object is
//      missing. There is nothing to draw.
//   3. Anything else is present, including a section whose numbers are all
//      zero - a measured zero is data, and this module must never turn one
//      into an absence. That is the same distinction `on_hand` makes between
//      an empty shelf and an unknown one.
//
// A capability is UNAVAILABLE only when every section it needs is missing. One
// section out of four means the view still has something true to draw, and the
// view is responsible for that part of it.

/**
 * The sections each capability's view reads, taken from the views themselves.
 *
 * Deliberately a declaration rather than something inferred: a view that starts
 * reading a new section should have to say so here, because the alternative is
 * this check silently passing a payload the view cannot draw.
 */
export const REQUIRED_SECTIONS = {
  customers: ['customer_radar'],
  inventory: ['velocity_classes', 'dead_stock', 'frozen_capital', 'money_leaks',
    'brand_concentration'],
  buying: ['buying', 'lost_sales'],
  market: ['market'],
  overview: ['overview'],
  basket: ['basket'],
  loss: ['loss', 'shrinkage_report'],
  pricing: ['pricing'],
};

/** A human label per capability, for the notice. */
export const CAPABILITY_LABEL = {
  customers: 'Customer insights',
  inventory: 'Inventory analysis',
  buying: 'Buying recommendations',
  market: 'Market comparison',
  overview: 'Store overview',
  basket: 'Basket analysis',
  loss: 'Loss prevention',
  pricing: 'Pricing analysis',
};

/** True when there is genuinely nothing to draw for this section. */
function sectionMissing(value) {
  if (value === undefined || value === null) return true;
  // The engine said so, and said why.
  if (typeof value === 'object' && value.available === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** The reason the engine gave, if it gave one. */
function sectionReason(value) {
  if (value && typeof value === 'object' && typeof value.reason === 'string') {
    return value.reason.trim() || null;
  }
  return null;
}

/**
 * What is missing from this capability's payload.
 *
 * @returns {{missing: string[], present: string[], reason: string|null,
 *            unavailable: boolean}}
 *   `unavailable` is true only when NOTHING the view needs is present.
 */
export function inspect(capability, data) {
  const required = REQUIRED_SECTIONS[capability];
  // A capability nobody declared is assumed fine: this check exists to hide
  // what cannot be drawn, not to withhold a view it knows nothing about.
  if (!required || !required.length) {
    return { missing: [], present: [], reason: null, unavailable: !data };
  }
  if (!data || typeof data !== 'object') {
    return { missing: [...required], present: [], reason: null, unavailable: true };
  }
  const missing = [];
  const present = [];
  let reason = null;
  for (const name of required) {
    const value = data[name];
    if (sectionMissing(value)) {
      missing.push(name);
      reason = reason || sectionReason(value);
    } else {
      present.push(name);
    }
  }
  return { missing, present, reason, unavailable: present.length === 0 };
}

/** Convenience: may this capability's view be rendered at all? */
export function isUnavailable(capability, data) {
  return inspect(capability, data).unavailable;
}

const availability = { CAPABILITY_LABEL, REQUIRED_SECTIONS, inspect, isUnavailable };
export default availability;
