import { sentence } from './sentence';

/**
 * The engines' refusal reasons now reach owners, not just log files.
 *
 * Each string below is a real one, copied from the capability that writes it.
 * They were authored as fragments for briefings and logs; as the explanatory
 * paragraph of "not available for your store" a lowercase fragment with no
 * full stop reads like a truncated error rather than an answer.
 */

describe('an engine reason read as a sentence', () => {
  test.each([
    ['no sales data for this store', 'No sales data for this store.'],
    ['no location/geography on file for this store',
     'No location/geography on file for this store.'],
    ["this store's POS records no cashier on transactions",
     "This store's POS records no cashier on transactions."],
    ['no recurring co-purchase pairs', 'No recurring co-purchase pairs.'],
    ['one id holds 48% of visits (looks like a system bucket)',
     'One id holds 48% of visits (looks like a system bucket).'],
  ])('%s', (given, want) => {
    expect(sentence(given)).toBe(want);
  });

  test('a reason that opens with a figure is not mangled', () => {
    // "3 of 5 peers" must not become "3 of 5 peers" with a capitalised digit,
    // and must not lose the figure to an over-eager slice.
    expect(sentence('not enough nearby peer stores (3)'))
      .toBe('Not enough nearby peer stores (3).');
    expect(sentence('3 of 5 peer stores reported')).toBe('3 of 5 peer stores reported.');
  });

  test('a sentence that is already one is left alone', () => {
    const already = 'This store lacks real per-person CRM data.';
    expect(sentence(already)).toBe(already);
    expect(sentence('Is the feed connected?')).toBe('Is the feed connected?');
    expect(sentence('No data yet…')).toBe('No data yet…');
  });

  test('nothing in, nothing out - never the string "null"', () => {
    // The callers render this directly, so a placeholder leaking through would
    // be visible on the page.
    expect(sentence(null)).toBeNull();
    expect(sentence(undefined)).toBeNull();
    expect(sentence('')).toBeNull();
    expect(sentence('   ')).toBeNull();
    expect(sentence(42)).toBeNull();
    expect(sentence({ reason: 'x' })).toBeNull();
  });

  test('it does not reword what the engine measured', () => {
    // The engine knows what it refused on better than this function can, so
    // only capitalisation and a full stop may change.
    const given = 'only 12 of 4,398 customers are linked to a ticket';
    expect(sentence(given).toLowerCase().replace(/\.$/, '')).toBe(given.toLowerCase());
  });
});
