import {
  claimForDismissal, DISMISS_REASONS, deriveStatus, withStatus, reconcile, setStatus,
  applyServerState, counts, migrateLegacy, getStatus, _keys,
} from './recStatus';

/**
 * Owner decisions used to live only in localStorage, which made every one of
 * them invisible to the evaluator - the thing that needs them most, because
 * where no detector can tell whether a card was acted on, the owner's own
 * answer is the only evidence there is.
 *
 * Since migration 039 the SERVER decides the status: a card is Completed only
 * when fulfilment_state is 'confirmed', the owner's click is 'claimed' until
 * the data confirms it, and localStorage is an optimistic overlay the server
 * overrides on every fetch. These tests pin that derivation and the one
 * mapping that is a JUDGEMENT rather than plumbing: which server claim each
 * dismissal reason actually represents.
 */

beforeEach(() => { localStorage.clear(); });

describe('which claim a dismissal really is', () => {
  test('"Already done" is an action TAKEN, not a refusal', () => {
    // The trap. Its plain meaning is the opposite of every other reason under
    // the same button. Filed as 'dismissed' it would record a completed action
    // as a refusal, and the shelf movement that followed would have no
    // explanation - the evaluator would see units move on a card nobody acted
    // on and score the engine lucky.
    expect(claimForDismissal('Already done')).toBe('did');
  });

  test('every other listed reason is a genuine refusal', () => {
    for (const reason of DISMISS_REASONS.filter((r) => r !== 'Already done')) {
      expect(claimForDismissal(reason)).toBe('dismissed');
    }
  });

  test('an unrecognised reason is a refusal, never an action', () => {
    // Fail toward the claim that asserts LESS. 'did' triggers a re-evaluation
    // and tells the engine the shelf moved; a reason we do not recognise must
    // not be able to assert that.
    expect(claimForDismissal('something new in the menu')).toBe('dismissed');
    expect(claimForDismissal(undefined)).toBe('dismissed');
    expect(claimForDismissal('')).toBe('dismissed');
  });

  test('the mapping only ever yields a claim the server accepts', () => {
    // The route rejects anything outside this set with a 400, so a reason that
    // mapped to something else would fail silently from the owner's side.
    const accepted = ['did', 'did_not', 'dismissed'];
    for (const reason of [...DISMISS_REASONS, 'unknown', undefined]) {
      expect(accepted).toContain(claimForDismissal(reason));
    }
  });
});

describe('deriving status from the server (migration 039)', () => {
  test('completed ONLY when the data confirmed it', () => {
    expect(deriveStatus({ fulfilment_state: 'confirmed', action_claim: null, user_vote: null })).toBe('completed');
    expect(deriveStatus({ fulfilment_state: 'confirmed', action_claim: 'did', user_vote: 'up' })).toBe('completed');
    // The owner's click alone is never completed, whatever the vote says.
    expect(deriveStatus({ fulfilment_state: 'claimed', action_claim: 'did', user_vote: 'up' })).toBe('claimed');
    expect(deriveStatus({ fulfilment_state: 'pending', action_claim: 'did', user_vote: null })).not.toBe('completed');
  });

  test('a claim the data has refuted is not "claimed": the card goes back to open/accepted', () => {
    // not_followed with a 'did' claim: the screen shows the Not followed
    // treatment with the server's sentence saying both things.
    expect(deriveStatus({ fulfilment_state: 'not_followed', action_claim: 'did', user_vote: null })).toBe('open');
    expect(deriveStatus({ fulfilment_state: 'not_followed', action_claim: 'did', user_vote: 'up' })).toBe('accepted');
  });

  test('dismissed from action_claim, accepted from the thumb, else open', () => {
    expect(deriveStatus({ fulfilment_state: 'pending', action_claim: 'dismissed', user_vote: 'up' })).toBe('dismissed');
    expect(deriveStatus({ fulfilment_state: 'pending', action_claim: null, user_vote: 'up' })).toBe('accepted');
    expect(deriveStatus({ fulfilment_state: 'unobservable', action_claim: null, user_vote: 1 })).toBe('accepted');
    expect(deriveStatus({ fulfilment_state: 'pending', action_claim: null, user_vote: null })).toBe('open');
    expect(deriveStatus({ fulfilment_state: 'expired', action_claim: 'did_not', user_vote: null })).toBe('open');
  });

  test('a card with no server fields yields null, so an older backend keeps the local status', () => {
    expect(deriveStatus({ id: 1, user_vote: 'up' })).toBeNull();
    expect(deriveStatus(null)).toBeNull();
  });
});

describe('the overlay and the server', () => {
  const cards = [
    { id: 1, fulfilment_state: 'confirmed', action_claim: 'did', user_vote: null, fulfilment_summary: 'Confirmed: 12 units ordered on Oct 13 (purchase order).' },
    { id: 2, fulfilment_state: 'claimed', action_claim: 'did', user_vote: null, fulfilment_summary: 'Marked done by you on Oct 12; no order has appeared in your data yet.' },
    { id: 3, fulfilment_state: 'pending', action_claim: null, user_vote: 'up' },
    { id: 4, fulfilment_state: 'pending', action_claim: 'dismissed', user_vote: null, dismiss_reason: 'Wrong product' },
    { id: 5, fulfilment_state: 'unobservable', action_claim: null, user_vote: null },
  ];

  test('server state wins over a stale local status on every fetch', () => {
    // The browser thought 2 and 5 were completed - the old click.
    localStorage.setItem(_keys.KEY, JSON.stringify({
      2: { status: 'completed', completed_at: '2026-10-12T00:00:00Z', server_seen_at: '2026-10-11T00:00:00Z' },
      5: { status: 'completed', server_seen_at: '2026-10-11T00:00:00Z' },
    }));
    reconcile(cards);
    const got = Object.fromEntries(withStatus(cards).map((r) => [r.id, r._status]));
    expect(got).toEqual({ 1: 'completed', 2: 'claimed', 3: 'accepted', 4: 'dismissed', 5: 'open' });
    expect(counts(cards)).toEqual({ open: 1, accepted: 1, claimed: 1, completed: 1 });
    // The server's sentence and reason ride on the entry for the card to print.
    expect(getStatus(2).summary).toMatch(/Marked done by you/);
    expect(getStatus(4).reason).toBe('Wrong product');
  });

  test('an optimistic click wins until the server answers', () => {
    reconcile(cards);
    // The owner marks card 3 done; the list in memory still says accepted.
    setStatus(3, 'claimed');
    expect(withStatus(cards).find((r) => r.id === 3)._status).toBe('claimed');
    // The POST comes back: the feed already held the order, so the data
    // confirmed it on the same click.
    applyServerState(3, { fulfilment_state: 'confirmed', action_claim: 'did', fulfilment_summary: 'Confirmed: 6 units ordered on Oct 14 (purchase order).' });
    expect(withStatus(cards).find((r) => r.id === 3)._status).toBe('completed');
    // ...and a later fetch that says claimed (say, the feed row was a
    // duplicate and got removed) overrides it again. The server decides. The
    // component reconciles the list it then renders, so read that list.
    const refetched = cards.map((c) => (c.id === 3 ? { ...c, fulfilment_state: 'claimed', action_claim: 'did' } : c));
    reconcile(refetched);
    expect(withStatus(refetched).find((r) => r.id === 3)._status).toBe('claimed');
  });

  test('a card without server fields keeps its local status', () => {
    setStatus(9, 'accepted');
    expect(withStatus([{ id: 9 }])[0]._status).toBe('accepted');
    expect(withStatus([{ id: 10 }])[0]._status).toBe('open');
  });
});

describe('migrating the old key', () => {
  test('a v1 "completed" was a click, so it becomes "claimed" with its timestamp kept', () => {
    const v1 = {
      7: { status: 'completed', accepted_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-02T00:00:00Z' },
      8: { status: 'accepted', accepted_at: '2026-10-03T00:00:00Z' },
      9: { status: 'dismissed', reason: 'Wrong timing', dismissed_at: '2026-10-04T00:00:00Z' },
      10: { status: 'something-else' },
    };
    const out = migrateLegacy(v1);
    expect(out[7].status).toBe('claimed');
    expect(out[7].claimed_at).toBe('2026-10-02T00:00:00Z');
    expect(out[7].completed_at).toBeUndefined();
    expect(out[8].status).toBe('accepted');
    expect(out[9]).toMatchObject({ status: 'dismissed', reason: 'Wrong timing' });
    expect(out[10].status).toBe('open');
  });

  test('the migration runs once, on first read, and removes the old key', () => {
    localStorage.setItem(_keys.LEGACY_KEY, JSON.stringify({ 7: { status: 'completed', completed_at: '2026-10-02T00:00:00Z' } }));
    expect(getStatus(7).status).toBe('claimed');
    expect(localStorage.getItem(_keys.LEGACY_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(_keys.KEY))[7].migrated_from).toBe('v1');
    // Putting the old key back does nothing now that v2 exists.
    localStorage.setItem(_keys.LEGACY_KEY, JSON.stringify({ 7: { status: 'completed' } }));
    expect(getStatus(7).status).toBe('claimed');
  });

  test('once the server has spoken, a migrated click is overridden like any other local status', () => {
    localStorage.setItem(_keys.LEGACY_KEY, JSON.stringify({ 7: { status: 'completed' } }));
    reconcile([{ id: 7, fulfilment_state: 'not_followed', action_claim: 'did', user_vote: null, fulfilment_summary: 'No order seen by Oct 30; the shelf did not move. You marked it done on Oct 2, but the data shows no order.' }]);
    const row = withStatus([{ id: 7, fulfilment_state: 'not_followed', action_claim: 'did', user_vote: null }])[0];
    expect(row._status).toBe('open');
    expect(row._fulfilment).toBe('not_followed');
  });
});
