// Shared date-only formatting.
//
// API date columns come back as bare calendar strings like "2026-07-01" - the
// backend returns date/timestamp OIDs as raw strings on purpose (see
// ARCHITECTURE.md "Date handling"). `new Date("2026-07-01")` parses that as UTC
// midnight, which renders as the PREVIOUS day in negative-offset timezones (e.g.
// US Central shows "June 30" for a July 1 value). Parsing a bare YYYY-MM-DD as
// LOCAL midnight makes every browser agree on the calendar day regardless of the
// viewer's timezone. Use these instead of `new Date(str).toLocaleDateString(...)`
// anywhere an API date string is shown.

export function parseLocalDate(d) {
  if (!d) return null;
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const dt = new Date(d);
  return isNaN(dt) ? null : dt;
}

export function formatLocalDate(d, opts = { month: 'long', day: 'numeric', year: 'numeric' }) {
  const dt = parseLocalDate(d);
  return dt ? dt.toLocaleDateString('en-US', opts) : String(d ?? '');
}
