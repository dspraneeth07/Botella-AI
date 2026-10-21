// recommendationVoice.test.js
// -----------------------------------------------------------------------------
// Sheet 18. The pipeline's numbers, said in the owner's language.
// -----------------------------------------------------------------------------

import {
  cardConfidence, cardProvenance, confidenceNote, confidenceWords, constraintNote,
  evidenceLabel, evidenceSentence, provenanceIsMissing, provenanceLine,
  quantityWithReason,
} from './recommendationVoice';

describe('the provenance line', () => {
  const borrowed = {
    own_weight: 0.4, own_observations: 21, cohort_size: 14,
    cohort_level: 'state', cohort_region: 'Texas',
  };

  test('says where the numbers came from, in the owner language', () => {
    expect(provenanceLine(borrowed)).toBe(
      'Based on 14 similar stores in Texas - you have 3 weeks of your own history.'
    );
  });

  test('a card on its own data carries no hedge', () => {
    // A hedge on a card that does not need one teaches owners to ignore the
    // hedge on cards that do.
    expect(provenanceLine({ ...borrowed, own_weight: 1 })).toBeNull();
  });

  test('the RUNG is never printed as if it were a place', () => {
    // cohort_level is store|state|region|national, not a place name. Printing
    // it would produce "14 similar stores in state".
    const line = provenanceLine({ ...borrowed, cohort_region: null });
    expect(line).toContain('14 similar stores');
    expect(line).not.toContain('in state');
  });

  test('the national rung names no place even when one is attached', () => {
    const line = provenanceLine({ ...borrowed, cohort_level: 'national' });
    expect(line).not.toContain('Texas');
  });

  test('one store is singular', () => {
    expect(provenanceLine({ ...borrowed, cohort_size: 1 }))
      .toContain('1 similar store in Texas');
  });

  test('under a week is said in days, not rounded to zero weeks', () => {
    expect(provenanceLine({ ...borrowed, own_observations: 3 }))
      .toContain('3 days of your own history');
  });

  test('the cold start says it is the first data', () => {
    expect(provenanceLine({ ...borrowed, own_observations: 0 }))
      .toContain('this is your first data on it');
  });
});

describe('the pipeline line is preferred over a composed one', () => {
  const card = {
    provenance_sentence: '(based on 14 similar stores in Texas)',
    provenance: { own_weight: 0.4, own_observations: 21, cohort_size: 9 },
  };

  test("uses the pipeline's, because sheet 16 verified that string", () => {
    expect(cardProvenance(card)).toBe('(based on 14 similar stores in Texas)');
  });

  test('falls back to composing one so a missing sentence is never a missing disclosure', () => {
    const line = cardProvenance({ ...card, provenance_sentence: '' });
    expect(line).toContain('9 similar stores');
  });

  test('a cohort-weighted card with no sentence is flagged as a pipeline bug', () => {
    expect(provenanceIsMissing({ ...card, provenance_sentence: '' })).toBe(true);
  });

  test('a card on its own data owes nothing', () => {
    expect(provenanceIsMissing({
      provenance: { own_weight: 1 }, provenance_sentence: '',
    })).toBe(false);
  });
});

describe('the evidence state is spoken, not scored', () => {
  test('each state is a sentence an owner can argue with', () => {
    expect(evidenceSentence('EMERGING')).toBe(
      "You're an emerging store - I'm using your data where I can and "
      + "similar shops where I can't."
    );
    expect(evidenceSentence('NEW')).toContain('shops like yours');
    expect(evidenceSentence('MATURE')).toContain('your own sales history');
  });

  test('it is case-insensitive, because the wire format has varied', () => {
    expect(evidenceSentence('emerging')).toBe(evidenceSentence('EMERGING'));
  });

  test('an unknown state says nothing rather than guessing', () => {
    expect(evidenceSentence('SOMETHING_ELSE')).toBeNull();
    expect(evidenceSentence(null)).toBeNull();
    expect(evidenceLabel('nonsense')).toBeNull();
  });
});

describe('the quantity carries its reason', () => {
  test('"24 units (2 cases of 12)" rather than a bare 24', () => {
    expect(quantityWithReason(24, { case_pack: 12 })).toBe('24 units (2 cases of 12)');
  });

  test('a quantity that is not a whole number of cases says only the units', () => {
    // Claiming "2.08 cases" would be arithmetic nobody asked for.
    expect(quantityWithReason(25, { case_pack: 12 })).toBe('25 units');
  });

  test('one case is singular, one unit is singular', () => {
    expect(quantityWithReason(12, { case_pack: 12 })).toBe('12 units (1 case of 12)');
    expect(quantityWithReason(1, {})).toBe('1 unit');
  });

  test('no pack size means no invented pack', () => {
    expect(quantityWithReason(24, {})).toBe('24 units');
    expect(quantityWithReason(24, { case_pack: 1 })).toBe('24 units');
  });

  test('a missing or zero quantity claims nothing', () => {
    expect(quantityWithReason(null, { case_pack: 12 })).toBeNull();
    expect(quantityWithReason(0, { case_pack: 12 })).toBeNull();
  });
});

describe('the constraint note only appears when a constraint bound', () => {
  test('shows why the number changed', () => {
    expect(constraintNote({
      ideal_qty: 37.4, suggested_order_qty: 24,
      constraint_reasons: ['rounded down to 2 cases of 12'],
    })).toBe('rounded down to 2 cases of 12');
  });

  test('says nothing when the quantity was not changed', () => {
    // A note about a constraint that did not bind is noise, and noise teaches
    // people to stop reading the notes that matter.
    expect(constraintNote({
      ideal_qty: 24, suggested_order_qty: 24,
      constraint_reasons: ['case pack considered'],
    })).toBeNull();
  });

  test('says nothing when there are no reasons', () => {
    expect(constraintNote({ ideal_qty: 37, suggested_order_qty: 24 })).toBeNull();
  });
});

describe('confidence is calibrated, and said in words', () => {
  test('words, never a bare percentage', () => {
    expect(confidenceWords(0.9)).toBe('Very confident');
    expect(confidenceWords(0.5)).toBe('Fairly confident');
    expect(confidenceWords(0.1)).toBe('A long shot');
  });

  test('the CALIBRATED field is the only one read', () => {
    expect(cardConfidence({ calibrated_confidence: 0.9 })).toBe('Very confident');
  });

  test('a raw confidence is never shown under a confidence label', () => {
    // Stated confidence measured 0.48 against a 0.23 hit rate - a coin flip
    // with a decimal point. A card with no calibrated value claims none.
    expect(cardConfidence({ confidence: 0.95 })).toBeNull();
  });

  test('a figure that does not separate the cards claims nothing per card', () => {
    // Bethany run 294: the curve mapped every raw score from 0.161 to 0.515
    // onto 0.444, so nine cards all read "Fairly confident" - a word that
    // distinguished none of them while reading as a judgement about each.
    const flat = { calibrated_confidence: 0.444, confidence_discriminates: false };
    expect(cardConfidence(flat)).toBeNull();
    // ...and the stored card, which carries only the basis string.
    expect(cardConfidence({
      calibrated_confidence: 0.444, confidence_basis: 'isotonic_flat_slate',
    })).toBeNull();
    expect(cardConfidence({
      calibrated_confidence: 0.444, confidence_basis: 'isotonic_constant',
    })).toBeNull();
  });

  test('a figure that DOES separate them is still shown', () => {
    expect(cardConfidence({
      calibrated_confidence: 0.9, confidence_discriminates: true,
    })).toBe('Very confident');
    expect(cardConfidence({
      calibrated_confidence: 0.9, confidence_basis: 'isotonic',
    })).toBe('Very confident');
  });

  test('the withheld band is replaced by the store-level sentence, not a gap', () => {
    const flat = {
      calibrated_confidence: 0.444,
      confidence_discriminates: false,
      confidence_explain: '44% is how often this kind of recommendation has '
        + 'worked at this store overall.',
    };
    expect(confidenceNote(flat)).toMatch(/at this store overall/);
    // A card whose figure does discriminate needs no explanation, and a card
    // with no figure at all is already silent.
    expect(confidenceNote({ calibrated_confidence: 0.9 })).toBeNull();
    expect(confidenceNote({})).toBeNull();
  });

  test('an absent confidence is not given a default band', () => {
    // The bug this replaces: absent -> { word: 'Good' } and 60%, inventing a
    // confidence claim for a card that made none.
    expect(cardConfidence({})).toBeNull();
    expect(cardConfidence({ calibrated_confidence: null })).toBeNull();
    expect(cardConfidence(null)).toBeNull();
  });

  test('zero is a value, not an absence', () => {
    expect(cardConfidence({ calibrated_confidence: 0 })).toBe('A long shot');
  });
});
