// storeIdentity.js
// -----------------------------------------------------------------------------
// One place that answers "whose store is this, and which market is it in".
//
// Every screen must read the same way for every login: no pilot store's name in
// the markup, no single state hard-coded into a sentence, and no screen quietly
// picking a different field than its neighbour. Before this existed the home
// greeted the LOCATION name ("Welcome back, Main.") while Market Comparison told
// every store in the country it was being compared against "Texas stores".
// -----------------------------------------------------------------------------

const read = (k) => {
  try { return (localStorage.getItem(k) || '').trim(); } catch { return ''; }
};

// Declared here, above its first use in `greetingName`, rather than beside
// `displayStoreName` where it reads most naturally: a `const` referenced from a
// function defined earlier in the file works only because the call happens after
// module init, and that is too subtle a thing to leave for the next edit to
// break. CRA substitutes this at BUILD time, so it is fixed for the bundle.
const DEMO_STORE_NAME = String(
  process.env.REACT_APP_DEMO_STORE_NAME || ''
).trim();

// US state and territory names, so "TX" can be said as "Texas". Static
// reference data, not store data - an unknown or missing code just falls back
// to wording that names no market at all.
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
  WY: 'Wyoming',
};

/** The store's business name, e.g. "High Peaks Wine & Spirits". */
export function storeName() {
  return read('botella_client_name');
}

/** The site within the business, e.g. "Main". Rarely worth showing on its own. */
export function locationName() {
  return read('botella_location_name');
}

/**
 * Who to greet.
 *
 * contact_name is an account contact, and across the current data it usually
 * just repeats client_name - so it only counts as a person when it differs from
 * the business name AND does not read like a business ("… Liquors", "… Wine &
 * Spirits"). When it is a person we greet their first name; otherwise we greet
 * the store. Never the location name: "Welcome back, Main." greets nobody.
 *
 * Returns '' when nothing usable is known, so the caller renders a bare
 * "Welcome back." rather than "Welcome back, undefined."
 */
export function greetingName() {
  // The demo override wins over BOTH the contact and the store: a prospect
  // watching a demo must not be greeted by the pilot store's owner by name.
  if (DEMO_STORE_NAME) return DEMO_STORE_NAME;
  const contact = read('botella_contact_name');
  const store = storeName();
  const BUSINESSY = /\b(liquor|liquors|wine|spirits|beverage|beer|store|shop|market|mart|inc|llc|co|company|&)\b/i;
  if (contact && contact.toLowerCase() !== store.toLowerCase() && !BUSINESSY.test(contact)) {
    return contact.split(/\s+/)[0]; // first name only
  }
  return store;
}

/**
 * THE NAME TO PUT ON SCREEN, with a demo override.
 *
 * Set REACT_APP_DEMO_STORE_NAME at build time and every surface that greets the
 * store shows that instead of the real one. This exists because the pilot stores
 * are named businesses: demonstrating to a prospect while "Bethany Discount
 * Liquor" sits in the header shows one customer's data to another, and asking
 * each screen to remember to hide it is how one of them forgets.
 *
 * Unset - which is every real login - this returns exactly what the call sites
 * read before it existed (`botella_location_name`, else the fallback), so the
 * override is the only behaviour it adds.
 *
 * NOT A SECURITY BOUNDARY. It renames what is displayed; it does not restrict
 * what the API returns. A demo that must not expose a real store's figures needs
 * its own instance and its own data, not this.
 */
export function displayStoreName(fallback = 'Your Store') {
  return DEMO_STORE_NAME || locationName() || fallback;
}

/** True when this build is renaming the store for a demo. */
export function isDemoNamed() {
  return Boolean(DEMO_STORE_NAME);
}

/** Two-letter state code for this store, or '' if unknown. */
export function stateCode() {
  return read('botella_state').toUpperCase();
}

/**
 * How to name this store's comparison market in a sentence.
 * "Texas stores" when the state is known, "stores in your area" when it is not,
 * so the wording is true for every login rather than for one pilot.
 */
export function comparisonMarket() {
  const code = stateCode();
  const name = STATE_NAMES[code];
  if (name) return `${name} stores`;
  if (code) return `${code} stores`;
  return 'stores in your area';
}

export default {
  storeName, locationName, displayStoreName, isDemoNamed,
  greetingName, stateCode, comparisonMarket,
};
