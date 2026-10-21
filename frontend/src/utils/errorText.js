// errorText.js
// -----------------------------------------------------------------------------
// Coerce anything an API might put in `error` into a STRING that is safe to
// render.
//
// The API does not have one error shape, it has two, and the difference is not
// visible from the call site:
//
//   expected failures   { error: "Invalid username or password." }
//   unexpected failures { error: { code: "...", message: "..." } }
//
// The second comes from the routes' catch-all handlers (routes/auth.js,
// dashboard.js, dead-stock.js, insights.js all end with
// `json({ error: { code, message } })`). So a screen that does
// `setError(data.error)` gets a string on the path everyone tests by hand, and
// an OBJECT on the path that only appears when something is actually broken -
// a database that cannot be reached, a timeout, an unhandled throw.
//
// Rendering that object is a hard crash: React throws
//   "Objects are not valid as a React child (found: object with keys
//    {code, message})"
// which replaces the real problem ("we cannot reach the database") with a stack
// trace that says nothing about it. The failure mode is worst exactly when the
// user most needs the message.
//
// This is the one place that knows about both shapes. Every screen that renders
// an API error should route through it.
// -----------------------------------------------------------------------------

/**
 * @param {unknown} err       whatever the API returned in `error` (or a caught Error)
 * @param {string}  fallback  shown when nothing usable can be extracted
 * @returns {string}          always a string, never an object
 */
export function errorText(err, fallback = 'Something went wrong. Please try again.') {
  if (err == null) return fallback;

  // Already a string: the common, expected shape.
  if (typeof err === 'string') return err.trim() || fallback;

  // A thrown Error, or the { code, message } envelope: both answer to .message.
  if (typeof err === 'object') {
    // `{ error: ... }` nested one deeper than the caller expected.
    if (err.error != null && err.error !== err) return errorText(err.error, fallback);

    const msg = err.message ?? err.userMessage ?? err.detail;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();

    // A code with no message is still better than nothing - it is the one
    // thing support can search for.
    if (typeof err.code === 'string' && err.code.trim()) return `${fallback} (${err.code})`;
  }

  return fallback;
}

export default errorText;
