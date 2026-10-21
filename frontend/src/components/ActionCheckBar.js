import React, { useState, useEffect, useCallback } from 'react';
import { HelpCircle, Check, X } from 'lucide-react';
import './ActionCheckBar.css';

// ── One-question micro-survey ────────────────────────────────────────────────
// For physically unobservable actions (endcap / cold box / promote / bundle)
// the system can't detect whether the owner acted - so it asks. Deliberately
// minimal: ONE question at a time, at most THREE DISTINCT questions per
// browser session (tracked in sessionStorage - closing the tab resets it),
// three one-tap responses, and it disappears the moment it's answered or
// dismissed (dismissal is permanent for that recommendation). Reloading while
// a question is up re-shows the same one without spending the session budget.
// Answers feed the Effectiveness stats as "owner-reported" evidence - hard
// sensor evidence always outranks them.
const SESSION_KEY = 'botella_action_questions_shown';
const MAX_PER_SESSION = 3;

function shownThisSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids : [];
  } catch {
    return []; // storage unavailable → fail open, worst case one extra ask
  }
}

function markShown(recId) {
  try {
    const ids = shownThisSession();
    if (!ids.includes(recId)) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify([...ids, recId]));
    }
  } catch { /* storage unavailable */ }
}

export default function ActionCheckBar({ authToken, apiUrl }) {
  const [question, setQuestion] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | asked | saving | thanks | failed
  // What the server made of the answer (migration 039): a 'did' comes back
  // 'claimed' - the owner's word, awaiting confirmation - or, when the data
  // already held the evidence, 'confirmed'. The thanks line says which.
  const [outcome, setOutcome] = useState(null);

  const base = apiUrl.replace(/\/api\/?$/, '');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
    'ngrok-skip-browser-warning': 'true',
  };

  useEffect(() => {
    if (!authToken) return;
    // Session budget: after 3 distinct questions, stay quiet until a new
    // browser session - the owner should never feel interrogated.
    const shown = shownThisSession();
    if (shown.length >= MAX_PER_SESSION) return;
    let alive = true;
    fetch(`${base}/api/recommendations/action-question`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!alive || !data?.question) return;
        const id = String(data.question.rec_id);
        // A reload mid-question re-shows the same one for free; a NEW question
        // only appears while the session budget lasts.
        if (!shown.includes(id) && shown.length >= MAX_PER_SESSION) return;
        markShown(id);
        setQuestion(data.question);
        setPhase('asked');
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [authToken, apiUrl]); // headers derive from these two

  const answer = useCallback(async (claim) => {
    if (!question) return;
    // THE RESPONSE IS CHECKED. This used to flip to "Noted" before the POST
    // was sent and swallow any failure, so an owner could answer into a dead
    // connection and be thanked for it - the answer never reached the
    // evaluator and nothing said so. Now the bar waits, and a failure puts
    // the question back with a plain line saying it did not save.
    setPhase('saving');
    try {
      const res = await fetch(`${base}/api/recommendations/${question.rec_id}/action-claim`, {
        method: 'POST', headers, body: JSON.stringify({ claim }),
      });
      if (!res.ok) throw new Error(`action-claim ${res.status}`);
      const body = await res.json().catch(() => ({}));
      if (claim === 'dismissed') { setPhase('idle'); return; }
      setOutcome(body && body.fulfilment_state ? body.fulfilment_state : null);
      setPhase('thanks');
      setTimeout(() => setPhase('idle'), 4500);
    } catch {
      setPhase('failed');
    }
  }, [question, authToken, apiUrl]); // eslint-disable-line

  if (phase === 'thanks') {
    return (
      <div className="acb acb-thanks" role="status">
        <Check size={14} />
        <span>
          {outcome === 'confirmed'
            ? 'Noted - and your data already confirms it. Counted as done.'
            : outcome === 'claimed'
              ? 'Noted as your word. It counts as done once your data shows it.'
              : 'Noted. This sharpens your Effectiveness stats.'}
        </span>
      </div>
    );
  }
  if ((phase !== 'asked' && phase !== 'saving' && phase !== 'failed') || !question) return null;

  return (
    <div className="acb" role="group" aria-label="Quick question">
      <HelpCircle size={15} className="acb-icon" />
      <span className="acb-text">
        {question.text}
        {phase === 'failed' && (
          <em className="acb-failed"> That did not save. Check your connection and try again.</em>
        )}
      </span>
      <div className="acb-actions">
        <button type="button" className="acb-btn acb-yes" disabled={phase === 'saving'} onClick={() => answer('did')}>
          {phase === 'saving' ? 'Saving…' : 'Yes, I did'}
        </button>
        <button type="button" className="acb-btn" disabled={phase === 'saving'} onClick={() => answer('did_not')}>
          No
        </button>
        <button
          type="button"
          className="acb-close"
          aria-label="Don't ask about this again"
          title="Don't ask about this again"
          onClick={() => answer('dismissed')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
