// Display formatters - ported verbatim from the StoreAgent web build (TS -> JS).
// Numbers from the API may arrive as JS numbers; coerce defensively so a stray
// numeric string still formats instead of showing "NaN".

const toNum = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isNaN(n) ? null : n;
};

// All monetary figures show exactly two decimal places. The legacy `cents`
// flag is kept for call-site compatibility but no longer changes precision -
// every dollar amount is rendered to the cent.
export const money = (x, cents = false) => {
  const n = toNum(x);
  if (n === null) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
};

export const num = (x) => {
  const n = toNum(x);
  return n === null ? '-' : new Intl.NumberFormat('en-US').format(n);
};

export const pct = (x) => {
  const n = toNum(x);
  return n === null ? '-' : `${n}%`;
};

export const days = (x) => {
  const n = toNum(x);
  return n === null ? 'never' : `${num(n)}d`;
};

export const titleFor = (name, sku) => name || sku;

// Project style rule: no em/en dashes in any displayed or AI-generated text.
export const noDash = (s) => (typeof s === 'string' ? s.replace(/[\u2014\u2013]/g, '-') : s);

export const shortDate = (s) =>
  s
    ? new Date(`${s}T00:00:00`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '-';
