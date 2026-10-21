import { classify, kindOf, isMissing, retrievalError, RetrievalError, MISSING, FAILED } from './retrieval';

/**
 * A screen that got nothing must say the right thing about WHY.
 *
 * Before this, every failed fetch produced one sentence and a Retry button:
 * "Unable to load customer insights. [Retry]". For a store whose analytics
 * database has no customer tables that button can never work, and the owner is
 * never told the only true thing - that the data has to be connected upstream,
 * by us.
 *
 * The two mistakes are not symmetric, which is what these tests protect:
 *   calling our outage "your store has no data" is a lie the owner cannot
 *     recover from, and it burns the notice for the case where it is real;
 *   calling a real absence "something went wrong" costs a few pointless
 *     retries.
 * So an unrecognised failure is OURS.
 */

describe('why a screen got nothing', () => {
  // -- The store really does not have it -----------------------------------

  test('a missing relation is the store, not us', () => {
    const got = classify(502, {
      error: 'UndefinedTable: relation "customer_metrics" does not exist',
    });
    expect(got.kind).toBe(MISSING);
    // Not the Postgres sentence - but keep it, because it is what support acts on.
    expect(got.reason).toMatch(/analytics database/);
    expect(got.detail).toMatch(/customer_metrics/);
  });

  test('a missing column counts too', () => {
    expect(classify(502, { error: 'UndefinedColumn: column "cost" does not exist' }).kind)
      .toBe(MISSING);
  });

  test('an unknown capability for this store is missing', () => {
    expect(classify(404, { error: 'unknown capability: customers' }).kind).toBe(MISSING);
    expect(classify(501, null).kind).toBe(MISSING);
  });

  test('an engine that refused keeps its own sentence', () => {
    const got = classify(200, {
      available: false,
      reason: 'This store lacks real per-person CRM data.',
    });
    expect(got.kind).toBe(MISSING);
    expect(got.reason).toBe('This store lacks real per-person CRM data.');
  });

  // -- The hazard: ours, dressed as theirs ---------------------------------

  test('PERMISSION DENIED IS OURS, however much it looks like absence', () => {
    // A role without a GRANT is a migration we have not finished. Showing this
    // as "your store does not have customer data" would send an owner to
    // support over our own unfinished work, and the data is right there.
    const got = classify(502, { error: 'InsufficientPrivilege: permission denied for table customers' });
    expect(got.kind).toBe(FAILED);
  });

  test('the service being down is ours', () => {
    expect(classify(502, { error: 'StoreAgent service unreachable: ECONNREFUSED' }).kind)
      .toBe(FAILED);
  });

  test('a dropped network is ours', () => {
    expect(classify(0, { error: 'Failed to fetch' }).kind).toBe(FAILED);
    expect(classify(0, new TypeError('NetworkError when attempting to fetch resource')).kind)
      .toBe(FAILED);
  });

  test('a timeout is ours', () => {
    expect(classify(504, { error: 'query timed out after 30s' }).kind).toBe(FAILED);
  });

  // -- The default direction ------------------------------------------------

  test('AN UNRECOGNISED FAILURE IS OURS', () => {
    // The whole asymmetry. We do not get to tell a store its data is absent on
    // a guess, so anything we cannot read lands on the retryable side.
    expect(classify(500, { error: 'TypeError: cannot read property of undefined' }).kind)
      .toBe(FAILED);
    expect(classify(503, null).kind).toBe(FAILED);
    expect(classify(0, null).kind).toBe(FAILED);
  });

  test('the {code, message} envelope is read, not rendered blind', () => {
    // routes' catch-all handlers return an OBJECT in `error`; the classifier
    // has to reach the message inside it or every such failure is unreadable.
    const got = classify(502, {
      error: { code: 'DB_ERROR', message: 'relation "shrinkage" does not exist' },
    });
    expect(got.kind).toBe(MISSING);
  });

  // -- What anything else thrown reads as -----------------------------------

  test('a plain Error from anywhere else is ours', () => {
    expect(kindOf(new Error('boom'))).toBe(FAILED);
    expect(kindOf(null)).toBe(FAILED);
    expect(kindOf(undefined)).toBe(FAILED);
  });

  test('a classified error keeps its reading through a catch', () => {
    const e = new RetrievalError('nope', { status: 404, kind: MISSING });
    expect(isMissing(e)).toBe(true);
    expect(e.status).toBe(404);
    expect(e instanceof Error).toBe(true);
  });
});

/**
 * The step the screens actually run: a not-ok Response in, a classified error
 * out. Worth its own tests because the classifier being right is no use if the
 * body never reaches it - reading the body is the part that can throw, and a
 * throw here would have turned every failure back into an unlabelled one.
 */
describe('turning a failed response into the error a screen throws', () => {
  const res = (status, body, { unreadable = false } = {}) => ({
    status,
    text: () => (unreadable
      ? Promise.reject(new Error('stream already consumed'))
      : Promise.resolve(body == null ? '' : JSON.stringify(body))),
  });

  test('the Python 502 envelope for a missing table reads as the store', async () => {
    // Verified against the live service: app/storeagent_api.py returns this
    // exact shape for anything the capability throws.
    const e = await retrievalError(
      res(502, { error: 'UndefinedTable: relation "customer_metrics" does not exist' }),
      'Unable to load customer insights.');
    expect(e.kind).toBe(MISSING);
    expect(e.status).toBe(502);
    expect(e.message).toMatch(/customer_metrics/);
  });

  test('an unknown capability reads as the store', async () => {
    // Also verified live: HTTP 404 {"error":"unknown capability: ..."}.
    const e = await retrievalError(res(404, { error: 'unknown capability: customers' }));
    expect(e.kind).toBe(MISSING);
  });

  test('a query-building bug of ours stays ours', async () => {
    // Seen live from the same endpoint. It is a 502 naming no table, so it
    // must not be dressed up as the store having no data.
    const e = await retrievalError(res(502, {
      error: "ProgrammingError: incomplete placeholder: '%'",
    }));
    expect(e.kind).toBe(FAILED);
  });

  test('an empty body still classifies on the status alone', async () => {
    expect((await retrievalError(res(404, null))).kind).toBe(MISSING);
    expect((await retrievalError(res(500, null))).kind).toBe(FAILED);
  });

  test('a body that will not read does not throw over it', async () => {
    const e = await retrievalError(res(503, null, { unreadable: true }), 'fallback text');
    expect(e.kind).toBe(FAILED);
    expect(e.message).toBe('fallback text');
  });

  test('non-JSON (an HTML error page from a proxy) is kept as text', async () => {
    const e = await retrievalError({
      status: 502,
      text: () => Promise.resolve('<html>502 Bad Gateway</html>'),
    });
    expect(e.kind).toBe(FAILED);
    expect(e.message).toMatch(/Bad Gateway/);
  });
  test('the real psycopg message is cut to its first line', async () => {
    // Captured from this service verbatim. Everything after the first line
    // echoes OUR SQL back, and a store owner has no use for it - while
    // anyone reading over their shoulder does.
    const e = await retrievalError({
      status: 502,
      text: () => Promise.resolve(JSON.stringify({ error: 'UndefinedTable: relation "customer_metrics" does not exist\nLINE 1: SELECT 1 FROM customer_metrics WHERE client_id = 171 LIMIT 1\n                      ^' })),
    });
    expect(e.kind).toBe(MISSING);
    expect(e.detail).toBe(
      'UndefinedTable: relation "customer_metrics" does not exist');
    expect(e.detail).not.toMatch(/SELECT|client_id/);
  });
});
