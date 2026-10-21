import { inspect, isUnavailable, REQUIRED_SECTIONS } from './availability';

/**
 * A screen must not draw itself over data the store does not have.
 *
 * Before this, a capability payload came back 200 with whatever the engines
 * could compute, and the view rendered regardless: headings over nothing, stat
 * tiles reading 0, tables with no rows. An owner could not tell "your store has
 * no customer data" from "the number really is zero" - and zero is the more
 * alarming of the two readings.
 *
 * The distinction this file protects, in both directions:
 *   a measured zero is DATA and must still render;
 *   an absence must hide the view and say so.
 */

describe('whether a capability has anything to draw', () => {
  test('a normal payload is available', () => {
    const data = { customer_radar: { available: true, win_back: [{ id: 1 }] } };
    expect(isUnavailable('customers', data)).toBe(false);
  });

  test('an explicit available:false is decisive, and carries its reason', () => {
    const data = {
      customer_radar: {
        available: false,
        reason: 'This store lacks real per-person CRM data.',
      },
    };
    const got = inspect('customers', data);
    expect(got.unavailable).toBe(true);
    // The engine that refused wrote the best sentence we will ever have for
    // why, so it must survive to the notice rather than being replaced.
    expect(got.reason).toMatch(/per-person CRM/);
  });

  test('an absent section is missing', () => {
    expect(isUnavailable('customers', {})).toBe(true);
    expect(isUnavailable('customers', { customer_radar: null })).toBe(true);
  });

  test('an empty array or object is missing', () => {
    expect(isUnavailable('basket', { basket: [] })).toBe(true);
    expect(isUnavailable('basket', { basket: {} })).toBe(true);
  });

  test('no payload at all is missing', () => {
    expect(isUnavailable('inventory', null)).toBe(true);
    expect(isUnavailable('inventory', undefined)).toBe(true);
  });

  // -- The direction that matters most -------------------------------------

  test('A MEASURED ZERO IS DATA and still renders', () => {
    // The whole hazard. A store really holding no dead stock, really leaking
    // no money, is a GOOD result and an owner is entitled to read it. Turning
    // it into "data not available" would hide a true answer and send them to
    // support over nothing.
    const data = {
      velocity_classes: { fast: 0, slow: 0 },
      dead_stock: { units: 0, value: 0 },
      frozen_capital: { total: 0 },
      money_leaks: { count: 0 },
      brand_concentration: { top_share: 0 },
    };
    expect(isUnavailable('inventory', data)).toBe(false);
    expect(inspect('inventory', data).missing).toEqual([]);
  });

  test('a zero-valued scalar section is data too', () => {
    expect(isUnavailable('pricing', { pricing: 0 })).toBe(false);
  });

  // -- Partial payloads stay with the view ---------------------------------

  test('one missing section of several does not hide the screen', () => {
    // There is still something true to draw, and the view owns that case -
    // hiding four working sections because a fifth is absent would lose more
    // than it protects.
    const data = {
      velocity_classes: { fast: 3 },
      dead_stock: { units: 12 },
      frozen_capital: { total: 900 },
      money_leaks: { count: 2 },
      // brand_concentration absent
    };
    const got = inspect('inventory', data);
    expect(got.unavailable).toBe(false);
    expect(got.missing).toEqual(['brand_concentration']);
    expect(got.present).toHaveLength(4);
  });

  test('the screen hides only when EVERY required section is missing', () => {
    const data = {
      velocity_classes: null,
      dead_stock: {},
      frozen_capital: [],
      money_leaks: { available: false, reason: 'no cost data at this store' },
      brand_concentration: undefined,
    };
    const got = inspect('inventory', data);
    expect(got.unavailable).toBe(true);
    expect(got.missing).toHaveLength(5);
    expect(got.reason).toMatch(/no cost data/);
  });

  // -- Shape -----------------------------------------------------------------

  test('every capability the panel can render declares its sections', () => {
    for (const cap of ['customers', 'inventory', 'buying', 'market', 'overview',
      'basket', 'loss', 'pricing']) {
      expect(Array.isArray(REQUIRED_SECTIONS[cap])).toBe(true);
      expect(REQUIRED_SECTIONS[cap].length).toBeGreaterThan(0);
    }
  });

  test('an undeclared capability is not withheld on a hunch', () => {
    // This check exists to hide what cannot be drawn, not to withhold a view it
    // knows nothing about. A new capability must render until someone declares
    // what it needs.
    expect(isUnavailable('something_new', { anything: 1 })).toBe(false);
    // ...but with no payload there is still nothing to draw.
    expect(isUnavailable('something_new', null)).toBe(true);
  });
});
