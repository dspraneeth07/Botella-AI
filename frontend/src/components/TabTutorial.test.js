import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TabTutorial from './TabTutorial';
import RetrievalNotice from './RetrievalNotice';
import { RetrievalError, MISSING, FAILED } from '../storeagent/retrieval';
import SAMPLES, { sampleFor, SAMPLE_STORE } from '../storeagent/tabSamples';

/**
 * The worked example an owner sees on a tab their store cannot fill yet.
 *
 * The whole risk is that it looks real. An owner who reads "$4,200 of cash
 * committed" as their own figure will act on it, and a screen built to explain
 * the product becomes the product lying to them. So most of what follows is
 * about the FRAMING rather than the content - the badge, the caption, and the
 * accessible name are load-bearing, and a future tidy-up that removes them for
 * being noisy has broken this component even though it still renders.
 *
 * Static markup rather than a DOM library, matching RetrievalNotice.test.js:
 * every claim here is about what the tutorial SAYS.
 */

const html = (props) => renderToStaticMarkup(<TabTutorial {...props} />);
const notice = (props) => renderToStaticMarkup(<RetrievalNotice {...props} />);

const missing = (over = {}) =>
  new RetrievalError('UndefinedTable: relation "purchases" does not exist',
    { status: 502, kind: MISSING, reason: null, detail: null, ...over });

describe('a sample can never be mistaken for the owner’s own figures', () => {
  test('the example is badged before any number is on screen', () => {
    const out = html({ sample: 'purchasing' });
    expect(out).toContain('tt-badge');
    expect(out).toMatch(/Example/);
    // The badge markup precedes the first figure in document order, so it is
    // read first whether the eye or a screen reader gets there.
    expect(out.indexOf('tt-badge')).toBeLessThan(out.indexOf('$4,200'));
  });

  test('the demonstration store is named, and it is not a real one', () => {
    const out = html({ sample: 'purchasing' });
    // Matched piecewise, not against SAMPLE_STORE itself: the "&" in the name
    // is escaped to "&amp;" in the rendered markup, so the literal never
    // appears and asserting on it tests the escaping, not the attribution.
    expect(out).toContain('Westbrook');
    expect(out).toContain('demonstration store');
    expect(out).toContain('Not your store');
    // Never attributed to a pilot store: anyone who recognised the name would
    // read these as that store's trading figures.
    expect(SAMPLE_STORE).toMatch(/demonstration store/i);
    for (const real of ['Tuscany', 'Bethany', 'Grapes', 'Cork Runner']) {
      expect(SAMPLE_STORE).not.toContain(real);
    }
  });

  test('the warning reaches a screen reader too', () => {
    const out = html({ sample: 'effectiveness' });
    // Both the region's accessible name and the table's own caption, because a
    // table navigated directly otherwise announces its numbers with nothing
    // in front of them.
    expect(out).toMatch(/aria-label="Example figures from [^"]*Not your store/);
    expect(out).toContain('<caption');
  });
});

describe('what it renders', () => {
  test('a tab with no sample renders nothing at all', () => {
    // Not a generic example: that would teach the owner about a screen they
    // are not looking at.
    expect(html({ sample: 'no-such-tab' })).toBe('');
    expect(html({ sample: undefined })).toBe('');
    expect(html({ sample: null })).toBe('');
  });

  test('every tab a screen asks for resolves to a sample', () => {
    // The keys wired into the RetrievalNotice call sites. If a screen is added
    // with a new key and no sample, this is where it is caught.
    const wired = ['purchasing', 'effectiveness', 'recommendations', 'customers',
      'market', 'dashboard', 'ledger', 'pending', 'poEffectiveness', 'insights',
      'commandCenter'];
    for (const key of wired) {
      expect(sampleFor(key)).toBeTruthy();
      expect(html({ sample: key })).toContain('tt-badge');
    }
  });

  test('every sample carries the three things that make it a tutorial', () => {
    for (const [name, s] of Object.entries(SAMPLES)) {
      expect(typeof s.heading).toBe('string');
      expect(s.metrics.length).toBeGreaterThan(0);
      expect(s.rows.length).toBeGreaterThan(0);
      // "How to read it" is the half that makes it teaching rather than a
      // screenshot, so it is required, not optional.
      expect(s.reading.length).toBeGreaterThan(0);
      // Every row matches the header, or the table renders ragged.
      for (const row of s.rows) expect(row.length).toBe(s.columns.length);
      expect(name).toBeTruthy();
    }
  });
});

describe('when the notice shows a tutorial, and when it must not', () => {
  test('a store without the data gets the example under the explanation', () => {
    const out = notice({ error: missing(), label: 'Buying recommendations', sample: 'purchasing' });
    expect(out).toContain('Buying recommendations is not available for your store');
    expect(out).toContain('Botella AI Labs');
    expect(out).toContain('tt-badge');
    // Still no Retry: nothing is coming.
    expect(out).not.toMatch(/<button/);
  });

  test('OUR outage shows no tutorial', () => {
    // FAILED is about us. The store's data may be perfectly fine, so teaching
    // them what the tab "would" look like implies an absence we have not
    // established - and the retry might simply work.
    const out = notice({
      error: new RetrievalError('socket hang up', { status: 502, kind: FAILED }),
      label: 'Buying recommendations',
      sample: 'purchasing',
      onRetry: () => {},
    });
    expect(out).not.toContain('tt-badge');
    expect(out).toMatch(/<button/);
  });

  test('an absence that arrived as a 200 still gets the notice', () => {
    // The purchase-feed case: the report comes back fine and every card is
    // ungradeable. There is no error object to classify, so the screen says so
    // itself with `missing`, and the backend's sentence is what is shown.
    const reason = 'no purchases rows for this store since 2026-09-08: the POS '
      + 'does not sync orders here, so no order is not evidence of inaction';
    const out = notice({
      missing: true, label: 'Measured effectiveness', reason, sample: 'effectiveness',
    });
    expect(out).toContain('Measured effectiveness is not available for your store');
    expect(out).toContain('the POS does not sync orders here');
    expect(out).toContain('Botella AI Labs');
    expect(out).toContain('tt-badge');
    expect(out).not.toMatch(/<button/);
    // And none of the arithmetic-on-an-absence this replaces.
    expect(out).not.toContain('-71,125');
  });
});
