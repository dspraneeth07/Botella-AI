#!/usr/bin/env node
/*
  grade-eval.js - offline, deterministic grader.

  Loads an eval artifact (answers + captured tool-result rows) and an INDEPENDENT
  ground-truth snapshot, then grades every turn with answer-verifier.js. Reports
  the two honest numbers the brief asks for, kept separate:
      - % correct-or-honest
      - # confident_wrong  (must be 0)

  Determinism: grades against the captured rows in the artifact + the saved
  ground-truth.json snapshot. It does NOT call the bot/model and does NOT re-query
  the live DB unless the snapshot is missing or --refresh-gt is passed.

  Usage:
    node tests/grade-eval.js [artifact.json] [graded-out.json] [--refresh-gt]
*/
const fs = require('fs');
const path = require('path');
const V = require('./answer-verifier');

const RESULTS_DIR = path.join(__dirname, '..', 'eval-results');
const GT_PATH = path.join(RESULTS_DIR, 'ground-truth.json');

async function loadGroundTruth(refresh) {
  if (!refresh && fs.existsSync(GT_PATH)) return JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
  const { build } = require('./ground-truth');
  const gt = build({});
  const resolved = await gt;
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(GT_PATH, JSON.stringify(resolved, null, 2));
  return resolved;
}

// Worst-of ordering for rolling a conversation's turns into one case verdict.
const RANK = { confident_wrong: 3, needs_review: 2, honest: 1, correct: 0 };
function worse(a, b) { return RANK[a] >= RANK[b] ? a : b; }

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh-gt');
  const positional = args.filter(a => !a.startsWith('--'));
  const inFile = positional[0] || path.join(RESULTS_DIR, 'v2.json');
  const outFile = positional[1] || inFile.replace(/\.json$/, '') + '.graded.json';

  const payload = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const gt = await loadGroundTruth(refresh);

  const turnsOut = [];
  const cases = [];
  for (const result of payload.results || []) {
    const turns = result.turns || [];
    let caseVerdict = 'correct';
    const caseTurns = [];
    const cumEvidence = [];  // accumulate evidence across a conversation's turns (a follow-up may cite facts established earlier from real queries)
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      cumEvidence.push(...(turn.evidence || []));
      // per-turn spec: turnsVerify[i] for conversations, else result.verify
      const rawSpec = (Array.isArray(result.turnsVerify) ? result.turnsVerify[i] : null) || result.verify || {};
      // Drop ground-truth pairing for live "today" category values: they drift as the
      // current day accumulates in the DB, so they are verified against the bot's OWN
      // captured evidence (numbers_supported), not a re-timed snapshot. Stable facts
      // (best day, counts, search recall) still use ground truth.
      const spec = (rawSpec && Array.isArray(rawSpec.checks))
        ? { ...rawSpec, checks: rawSpec.checks.filter(c => !(c.type === 'pairing_from' && /^cat_today/.test(String(c.from || '')))) }
        : rawSpec;
      const graded = V.gradeTurn(
        { answer: turn.answer, evidence: cumEvidence.slice() },
        { expect: spec, groundTruth: gt }
      );
      caseVerdict = worse(caseVerdict, graded.verdict);
      const rec = {
        caseId: result.id, category: result.category, turnIndex: i + 1,
        question: turn.question, verdict: graded.verdict,
        findings: graded.findings, hadEvidence: graded.hadEvidence,
        evidenceTools: (turn.evidence || []).map(e => e.tool),
        answerPreview: String(turn.answer || '').replace(/\s+/g, ' ').slice(0, 240),
      };
      caseTurns.push(rec);
      turnsOut.push(rec);
    }
    cases.push({ id: result.id, category: result.category, verdict: caseVerdict, turns: caseTurns });
  }

  // summaries (per turn - the strict unit)
  const cats = {};
  const tally = (bucket, v) => {
    bucket.total++;
    bucket[v] = (bucket[v] || 0) + 1;
  };
  const overall = { total: 0 };
  for (const t of turnsOut) {
    if (!cats[t.category]) cats[t.category] = { total: 0 };
    tally(cats[t.category], t.verdict);
    tally(overall, t.verdict);
  }
  const pct = (b) => b.total ? Number((((b.correct || 0) + (b.honest || 0)) / b.total * 100).toFixed(1)) : 0;
  overall.correctOrHonestPct = pct(overall);
  overall.confidentWrong = overall.confident_wrong || 0;
  for (const c of Object.values(cats)) { c.correctOrHonestPct = pct(c); c.confidentWrong = c.confident_wrong || 0; }

  const confidentWrong = turnsOut.filter(t => t.verdict === 'confident_wrong')
    .map(t => ({ caseId: t.caseId, turnIndex: t.turnIndex, question: t.question, reasons: t.findings.filter(f => f.severity === 'fail').map(f => f.reason), answerPreview: t.answerPreview }));
  const needsReview = turnsOut.filter(t => t.verdict === 'needs_review')
    .map(t => ({ caseId: t.caseId, turnIndex: t.turnIndex, question: t.question, answerPreview: t.answerPreview }));

  const summary = {
    inputFile: path.basename(inFile),
    gradedAt: new Date().toISOString(),
    groundTruthDate: gt.latestDate,
    turns: overall.total,
    correct: overall.correct || 0,
    honest: overall.honest || 0,
    confidentWrong: overall.confidentWrong,
    needsReview: overall.needs_review || 0,
    correctOrHonestPct: overall.correctOrHonestPct,
    byCategory: cats,
  };

  const out = { summary, confidentWrong, needsReview, cases, groundTruthUsed: gt };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nConfident-wrong turns: ${confidentWrong.length}`);
  for (const cw of confidentWrong) console.log(`  ✗ [${cw.caseId} t${cw.turnIndex}] ${cw.question}\n      ${cw.reasons.join(' | ')}`);
  console.log(`\nGraded artifact: ${outFile}`);
  if (confidentWrong.length > 0) process.exitCode = 2;
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
