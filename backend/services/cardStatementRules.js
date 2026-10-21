/**
 * Card Statement Analysis - the rules the engine reads (CARD-STATEMENTS.md §5.2).
 *
 * Constants only: the Rebelipay offer, the junk-fee catalogue, the action that
 * goes with each kind of notice, and the daily-anomaly thresholds. Versioned so
 * a change here is a deliberate, visible event and not a quiet edit inside the
 * engine.
 *
 * NEVER SERIALISED
 * ----------------
 * The offer's price lives here and nowhere else. The ticket forbids it from
 * appearing anywhere an owner or a payload could see it (D7), so nothing in
 * this file is ever returned by the API, written to the CSV export or logged.
 * The engine reads these values and emits totals only. The non-enumerable
 * toJSON below turns an accidental JSON.stringify (a logger, a debug dump)
 * into a placeholder instead of a leak.
 */

const SERIALISED_PLACEHOLDER = '[card statement rules]';

const rules = {
  version: 1,

  // Daily anomaly (a): a batch below this share of the median for its weekday,
  // followed by a day above spikeRatio x the median for that day's weekday.
  lowBatchRatio: 0.10,
  spikeRatio: 1.5,

  rebelipay: {
    name: 'Rebelipay',
    pctRate: 0.0255,          // used ONLY together with perTxnFee as one per-transaction price
    perTxnFee: 0.10,
    appliesTo: 'all_card_types',
    monthlyFees: 0,           // Rebelipay account/PCI/statement fees per month (none today; configurable)
    refundsReturnFee: true,   // D5
    roundPerTransaction: true,
  },

  // First match wins. Matched against the verbatim fee-line description.
  feeCatalogue: [
    { match: /NON RECEIPT OF PCI VALIDATION/i, tag: 'penalty',    period: 'monthly', fix: 'Fill in the free PCI security form (about 20 minutes)' },
    { match: /ANNUAL COMPLIANCE/i,             tag: 'negotiable', period: 'annual',  fix: 'Ask your processor to remove or lower it' },
    // The statement prints this one abbreviated ("MAESTRO REG", Bethany Jul 2026).
    { match: /MAESTRO REG(ISTRATION)?\b/i,    tag: 'watch',      period: 'monthly', fix: 'Keep an eye on it' },
    { match: /PAPER STATEMENT|STATEMENT FEE/i, tag: 'negotiable', period: 'monthly', fix: 'Switch to online statements' },
    { match: /MAILED (DISPUTE|CHARGEBACK) NOTIF/i, tag: 'negotiable', period: 'monthly', fix: 'Turn off mailed dispute letters in Commerce Control Center (CCC)' },
  ],

  noticeActions: {
    acquirer_change:       'Check the change with your bank, and update any rules you use to match deposits.',
    ach_descriptor_change: 'Tell your bank and bookkeeper the new name on your deposits, so no deposit is held or recorded wrongly.',
    delivery_change:       'Make sure someone can sign in to the new website for your statements.',
    fee_change:            'Check the new fee and the date it starts.',
    other:                 'Read it once. Usually there is nothing to do.',
  },
};

for (const target of [rules, rules.rebelipay]) {
  Object.defineProperty(target, 'toJSON', { value: () => SERIALISED_PLACEHOLDER, enumerable: false });
}

module.exports = rules;
