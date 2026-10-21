import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RetrievalNotice from './RetrievalNotice';
import { RetrievalError, MISSING } from '../storeagent/retrieval';

/**
 * The owner-facing half of the same distinction.
 *
 * What was on screen before: "Unable to load customer insights. [Retry]" -
 * for an outage AND for a store whose analytics database has no customer
 * tables. In the second case the button is the only thing offered and it can
 * never work.
 *
 * Rendered to static markup rather than through a DOM testing library: this
 * repo has no @testing-library, and the claims below are all about what the
 * notice SAYS, which the markup carries in full.
 */

const missing = (over = {}) =>
  new RetrievalError('UndefinedTable: relation "customers" does not exist',
    { status: 502, kind: MISSING, reason: null, detail: null, ...over });

const html = (props) => renderToStaticMarkup(<RetrievalNotice {...props} />);

describe('what a screen tells an owner when it got nothing', () => {
  test('a store without the data is told so, and told what to do', () => {
    const out = html({ error: missing(), label: 'Customer insights', onRetry: () => {} });
    expect(out).toContain('Customer insights is not available for your store');
    expect(out).toContain('Botella AI Labs');
    // NO RETRY. Nothing is coming, so a button here is an invitation to wait
    // forever - and it is exactly what the old screen offered instead of the
    // one true thing.
    expect(out).not.toMatch(/<button/);
  });

  test("the engine's own sentence wins over the default", () => {
    const out = html({
      label: 'Customer insights',
      error: missing({ reason: 'This store lacks real per-person CRM data.' }),
    });
    expect(out).toContain('This store lacks real per-person CRM data.');
    expect(out).not.toContain('point-of-sale has not sent');
  });

  test('the technical cause is kept for whoever we ask to look', () => {
    const out = html({
      label: 'Loss prevention',
      error: missing({ detail: 'UndefinedTable: relation "shrinkage" does not exist' }),
    });
    expect(out).toContain('relation &quot;shrinkage&quot; does not exist');
  });

  test('OUR failure keeps Retry and says nothing about the store', () => {
    // The direction that must not drift: during an outage the data IS there,
    // and telling an owner it is not would be false and unrecoverable.
    const out = html({
      label: 'Customer insights',
      onRetry: () => {},
      error: new Error('StoreAgent service unreachable: ECONNREFUSED'),
    });
    expect(out).toMatch(/<button/);
    expect(out).toContain('Retry');
    expect(out).not.toContain('not available for your store');
    expect(out).not.toContain('Botella AI Labs');
    expect(out).toContain('service unreachable');
  });

  test('an error with nothing readable still gets a sentence', () => {
    const out = html({ label: 'Buying recommendations', error: {}, onRetry: () => {} });
    expect(out).toContain('Buying recommendations could not be loaded.');
  });

  test('an unlabelled notice still reads as a sentence', () => {
    expect(html({ error: missing() })).toContain('This data is not available for your store');
  });
});
