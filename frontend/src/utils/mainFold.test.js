import { mainFold } from './mainFold';

/**
 * The main fold reserves a seat per action type.
 *
 * "Do not show me only reorder." Under a pure value sort the markdown, bundle,
 * stock_new, pre_stock and cold_box cards - which the browser values at $0
 * because it will not invent a figure for them - all folded, and the owner saw
 * five reorders every morning. These pin the rule: top by value, but every
 * non-reorder type present gets its highest-ranked card a seat, taken from the
 * lowest-value reorder, within the limit.
 */

const LIMIT = 5;
const card = (id, action_type, rank, value) => ({ id, action_type, rank, value });
// The caller hands the fold its display order: value desc, then rank.
const byValue = (cards) => cards.slice().sort((a, b) => (b.value - a.value) || (a.rank - b.rank));

describe('mainFold', () => {
  test('reorders dominate by value but a markdown and a bundle still appear', () => {
    const slate = byValue([
      card('r1', 'reorder', 1, 2400), card('r2', 'reorder', 2, 1900), card('r3', 'reorder', 3, 1500),
      card('r4', 'reorder', 4, 1200), card('r5', 'reorder', 5, 900), card('r6', 'reorder', 6, 700),
      card('r7', 'reorder', 7, 400),
      card('m1', 'markdown', 8, 0), card('m2', 'markdown', 9, 0),
      card('b1', 'bundle', 10, 0),
    ]);
    const fold = mainFold(slate, LIMIT);
    const ids = fold.map((c) => c.id);
    expect(ids).toContain('m1');
    expect(ids).toContain('b1');
    // The highest-RANKED markdown, not both of them.
    expect(ids).not.toContain('m2');
    // The seats came from the cheapest reorders; the top three stay.
    expect(ids.slice(0, 3)).toEqual(['r1', 'r2', 'r3']);
    expect(ids).not.toContain('r4');
    expect(ids).not.toContain('r5');
  });

  test('MAIN_CARD_LIMIT is respected', () => {
    const slate = byValue([
      ...Array.from({ length: 8 }, (_, i) => card(`r${i}`, 'reorder', i + 1, 3000 - i * 100)),
      card('m', 'markdown', 9, 0), card('b', 'bundle', 10, 0), card('s', 'stock_new', 11, 0),
      card('p', 'pre_stock', 12, 0), card('c', 'cold_box', 13, 0),
    ]);
    const fold = mainFold(slate, LIMIT);
    expect(fold).toHaveLength(LIMIT);
    // Five non-reorder types and five seats: four reorders give way, the top
    // reorder keeps its seat because it is the only one left of its type.
    expect(fold.map((c) => c.action_type).filter((t) => t === 'reorder')).toHaveLength(1);
    expect(fold[0].id).toBe('r0');
  });

  test('no non-reorder cards -> pure value order', () => {
    const slate = byValue(Array.from({ length: 9 }, (_, i) => card(`r${i}`, 'reorder', 9 - i, 100 * (i + 1))));
    expect(mainFold(slate, LIMIT)).toEqual(slate.slice(0, LIMIT));
  });

  test('a non-reorder card already in the top by value displaces nothing', () => {
    const slate = byValue([
      card('p', 'pre_stock', 4, 2000), card('r1', 'reorder', 1, 1800), card('r2', 'reorder', 2, 1600),
      card('r3', 'reorder', 3, 1400), card('r4', 'reorder', 5, 1200), card('r5', 'reorder', 6, 1000),
    ]);
    expect(mainFold(slate, LIMIT)).toEqual(slate.slice(0, LIMIT));
  });

  test('fewer cards than the limit are all shown, in order', () => {
    const slate = byValue([card('r1', 'reorder', 1, 500), card('m', 'markdown', 2, 0)]);
    expect(mainFold(slate, LIMIT)).toEqual(slate);
    expect(mainFold([], LIMIT)).toEqual([]);
  });

  test('the output keeps the caller\'s order, so the list still reads by value', () => {
    const slate = byValue([
      card('r1', 'reorder', 1, 900), card('r2', 'reorder', 2, 800), card('r3', 'reorder', 3, 700),
      card('r4', 'reorder', 4, 600), card('r5', 'reorder', 5, 500), card('m', 'markdown', 6, 0),
    ]);
    const fold = mainFold(slate, LIMIT);
    expect(fold.map((c) => c.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'm']);
  });

  test('a type\'s only representative is never displaced, and the cap still wins', () => {
    // One reorder and six distinct types for five seats: the reorder is the
    // only card of its type so it stays; four types fit; two fold.
    const slate = byValue([
      card('r', 'reorder', 1, 1000),
      card('a', 'markdown', 2, 0), card('b', 'bundle', 3, 0), card('c', 'stock_new', 4, 0),
      card('d', 'pre_stock', 5, 0), card('e', 'cold_box', 6, 0), card('f', 'promote', 7, 0),
    ]);
    const fold = mainFold(slate, LIMIT);
    expect(fold).toHaveLength(LIMIT);
    expect(fold.map((c) => c.id)).toEqual(['r', 'a', 'b', 'c', 'd']);
  });

  test('a card with no action_type reserves nothing and is not mistaken for a reorder', () => {
    const slate = byValue([
      card('r1', 'reorder', 1, 900), card('r2', 'reorder', 2, 800), card('r3', 'reorder', 3, 700),
      card('r4', 'reorder', 4, 600), card('r5', 'reorder', 5, 500),
      { id: 'x', rank: 6, value: 0 }, card('m', 'markdown', 7, 0),
    ]);
    const ids = mainFold(slate, LIMIT).map((c) => c.id);
    expect(ids).toContain('m');
    expect(ids).not.toContain('x');
  });
});
