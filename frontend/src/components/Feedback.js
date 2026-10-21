// Feedback widgets - capture thumbs / star ratings / free-text and POST to
// /api/feedback (persisted in the analytics DB). Three exports:
//   - FeedbackModal          the "write to us" descriptive-feedback dialog
//   - ChatFeedbackBanner     inline "How is Botella doing?" after N chat turns
//   - SessionFeedbackToast   gentle bottom-right "rate us" after N minutes
// Whether either prompt may show is decided by the shared feedbackGate: at
// most one ask per session across BOTH flows, 20 days of quiet after an
// answer, growing backoff (3d/7d/14d/20d) after dismissals - persisted per
// store across logins, so neither prompt nags on every login.
import React, { useEffect, useRef, useState } from 'react';
import { ThumbsUp, ThumbsDown, Star, X, Send, Loader, MessageSquare, Check } from 'lucide-react';
import { canAsk, claimAsk, claimSession, recordAnswer, recordDismiss, syncFromServer } from './feedbackGate';
import './Feedback.css';

async function postFeedback(apiBase, authToken, payload) {
  const res = await fetch(`${apiBase}/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'ngrok-skip-browser-warning': 'true',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

/* ── Chat feedback popup ───────────────────────────────────────────────
 *
 * Asked ONCE per conversation, in the bottom-right corner, out of the way of
 * the transcript.
 *
 * The previous attempt put a rating row under every answer. That is more data
 * in principle and worse in practice: it sat in the reading column, pushed the
 * next answer down, and turned a conversation into a sequence of forms. A
 * conversation is the unit a person can actually judge - "was that useful" is
 * a question about the exchange, not about message four.
 *
 * Fires after the second answer, so there is something to judge, and never
 * again for that conversation whatever the person does with it - answered,
 * dismissed, or ignored. The claim is written before the prompt is shown, so a
 * re-render or a reload cannot produce a second ask.
 */
const CHAT_ASKED_KEY = 'botella_chat_fb_asked';

function alreadyAsked(convId) {
  if (!convId) return false;
  try {
    const raw = localStorage.getItem(CHAT_ASKED_KEY);
    return raw ? JSON.parse(raw).includes(String(convId)) : false;
  } catch { return false; }
}

function markAsked(convId) {
  if (!convId) return;
  try {
    const raw = localStorage.getItem(CHAT_ASKED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!list.includes(String(convId))) {
      // Bounded: the last 200 conversations is far more than anyone revisits,
      // and an unbounded list in localStorage grows until it throws.
      list.push(String(convId));
      localStorage.setItem(CHAT_ASKED_KEY, JSON.stringify(list.slice(-200)));
    }
  } catch { /* storage unavailable - worst case the prompt shows again */ }
}

export function ChatFeedbackPopup({ apiBase, authToken, conversationId, answerCount, minAnswers = 2 }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const claimed = useRef(null);

  useEffect(() => { syncFromServer(apiBase, authToken); }, [apiBase, authToken]);

  // Reset when the conversation changes, so the next thread gets its own ask.
  useEffect(() => {
    setOpen(false); setRating(0); setText(''); setDone(false);
    claimed.current = null;
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId || answerCount < minAnswers) return;
    if (claimed.current === conversationId) return;
    if (alreadyAsked(conversationId)) return;
    claimed.current = conversationId;
    markAsked(conversationId);          // claim BEFORE showing, never after
    const t = setTimeout(() => setOpen(true), 1200);   // let the answer land first
    return () => clearTimeout(t);
  }, [conversationId, answerCount, minAnswers]);

  if (!open) return null;

  const rate = async (stars) => {
    setRating(stars);
    try {
      await postFeedback(apiBase, authToken, {
        source: 'chat', rating: stars, conversation_id: conversationId || null,
      });
      recordAnswer();
    } catch { /* non-blocking */ }
  };

  const send = async () => {
    const body = text.trim();
    if (sending) return;
    setSending(true);
    try {
      if (body) {
        await postFeedback(apiBase, authToken, {
          source: 'chat',
          rating: rating || null,
          message: body,
          conversation_id: conversationId || null,
        });
      }
      setDone(true);
      setTimeout(() => setOpen(false), 2200);
    } catch {
      setDone(true);
      setTimeout(() => setOpen(false), 2200);
    } finally {
      setSending(false);
    }
  };

  const close = () => {
    if (!rating) recordDismiss();
    setOpen(false);
  };

  return (
    <div className="fb-pop" role="dialog" aria-label="Rate this conversation">
      <button type="button" className="fb-pop-x" onClick={close} aria-label="Close">
        <X size={15} />
      </button>

      {done ? (
        <p className="fb-pop-done"><Check size={16} /> Thank you — we read every one.</p>
      ) : (
        <>
          <p className="fb-pop-title">How was this conversation?</p>

          <div className="fb-pop-stars" role="radiogroup" aria-label="Rate out of five"
               onMouseLeave={() => setHover(0)}>
            {[1, 2, 3, 4, 5].map((n) => {
              const on = (hover || rating) >= n;
              return (
                <button
                  key={n} type="button" role="radio" aria-checked={rating === n}
                  aria-label={`${n} star${n === 1 ? '' : 's'}`}
                  className={`fb-pop-star ${on ? 'is-on' : ''}`}
                  onMouseEnter={() => setHover(n)}
                  onFocus={() => setHover(n)}
                  onClick={() => rate(n)}
                >
                  <Star size={20} fill={on ? 'currentColor' : 'none'} />
                </button>
              );
            })}
          </div>

          {/* The box only appears once a rating exists, so the popup opens as
              one short question rather than a form in the corner. */}
          {rating > 0 && (
            <>
              <textarea
                className="fb-pop-text"
                rows={3}
                value={text}
                maxLength={2000}
                autoFocus
                onChange={(e) => setText(e.target.value)}
                placeholder={rating >= 4 ? 'What worked well? (optional)' : 'What would have helped? (optional)'}
                aria-label="Tell us more"
              />
              <div className="fb-pop-actions">
                <button type="button" className="fb-pop-skip" onClick={() => { setDone(true); setTimeout(() => setOpen(false), 1400); }}>
                  Skip
                </button>
                <button type="button" className="fb-pop-send" onClick={send} disabled={sending}>
                  {sending ? <Loader size={14} className="fb-spin" /> : <Send size={14} />}
                  {sending ? 'Sending' : 'Send'}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Descriptive feedback modal ──────────────────────────────────────────────
export function FeedbackModal({ apiBase, authToken, source, conversationId, sentiment, rating, onClose, onSubmitted }) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    const message = text.trim();
    if (!message || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await postFeedback(apiBase, authToken, {
        source,
        message,
        conversation_id: conversationId || null,
        sentiment: sentiment || null,
        rating: rating || null,
      });
      if (onSubmitted) onSubmitted();
      onClose();
    } catch (e) {
      setError('Could not send your feedback. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="fb-scrim" onClick={onClose}>
      <div className="fb-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Send feedback">
        <button className="fb-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <div className="fb-modal-title">Share your feedback</div>
        <p className="fb-modal-sub">Tell us what's working or what's getting in your way. It goes straight to our team.</p>
        <textarea
          className="fb-textarea"
          placeholder="Describe the problem you're facing or what we could do better…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          maxLength={5000}
          autoFocus
        />
        {error && <div className="fb-error">{error}</div>}
        <div className="fb-modal-actions">
          <button className="fb-btn-secondary" onClick={onClose}>Cancel</button>
          <button className="fb-btn-primary" onClick={submit} disabled={!text.trim() || submitting}>
            {submitting ? <Loader size={15} className="fb-spin" /> : <Send size={15} />}
            {submitting ? 'Sending…' : 'Send feedback'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── In-chat feedback chip ───────────────────────────────────────────────────
// Asks after the FIRST message of every new chat, in every session.
//
// This one is deliberately OUTSIDE the shared ask-budget that governs the
// session toast. It is not an interruption: the user has just spoken to the
// assistant and the chip asks how that went, in place, about the thing they are
// already doing. Under the old rules (5 turns, plus once per session, plus a
// 24-hour settle-in, plus 20 days of quiet after any answer) it almost never
// appeared at all.

// A conversation has no id until its first message is sent. Tracking that
// pre-id state under its own key lets the real id be adopted as the SAME
// thread, instead of reading as a switch and asking twice in one conversation.
const NEW_THREAD = '__new__';

export function ChatFeedbackBanner({ apiBase, authToken, conversationId, turnCount, threshold = 1 }) {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState('ask'); // 'ask' | 'thanks'
  const [chosen, setChosen] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const shownFor = useRef(null);   // thread already asked about
  const prevTurns = useRef(null);  // to see the transition, not just the level

  // Still synced, because an answer here writes the store's durable timestamp
  // and that is what keeps the session toast quiet afterwards.
  useEffect(() => { syncFromServer(apiBase, authToken); }, [apiBase, authToken]);

  // Adopt the id a brand-new conversation is given, or forget the previous
  // thread when the user genuinely switches to another one.
  useEffect(() => {
    if (shownFor.current === NEW_THREAD && conversationId) {
      shownFor.current = conversationId;
      return;
    }
    const key = conversationId || NEW_THREAD;
    if (shownFor.current !== null && shownFor.current !== key) {
      shownFor.current = null;
      prevTurns.current = null;
      setVisible(false);
      setStatus('ask');
      setChosen(null);
    }
  }, [conversationId]);

  useEffect(() => {
    const prev = prevTurns.current;
    prevTurns.current = turnCount;
    // First run only records where this conversation already is. Opening a long
    // thread out of history is not a new chat and must not prompt.
    if (prev === null) return;
    const key = conversationId || NEW_THREAD;
    if (turnCount > prev && turnCount === threshold && shownFor.current !== key) {
      shownFor.current = key;
      claimSession();
      setChosen(null);
      setStatus('ask');
      setVisible(true);
    }
  }, [turnCount, threshold, conversationId]);

  const close = () => { recordDismiss(); setVisible(false); };

  const vote = async (sentiment) => {
    setChosen(sentiment);
    setStatus('thanks');
    recordAnswer();
    try { await postFeedback(apiBase, authToken, { source: 'chat', sentiment, conversation_id: conversationId || null }); } catch { /* non-blocking */ }
  };

  return (
    <>
      {visible && (
        <div className="fb-chip" role="status">
          {status === 'ask' ? (
            <>
              <span className="fb-chip-text">How is Botella doing?</span>
              <div className="fb-chip-actions">
                <button className={`fb-thumb ${chosen === 'up' ? 'is-on' : ''}`} onClick={() => vote('up')} aria-label="Thumbs up" title="Good">
                  <ThumbsUp size={15} />
                </button>
                <button className={`fb-thumb ${chosen === 'down' ? 'is-on' : ''}`} onClick={() => vote('down')} aria-label="Thumbs down" title="Not great">
                  <ThumbsDown size={15} />
                </button>
                <button className="fb-link" onClick={() => setModalOpen(true)}>
                  <MessageSquare size={13} /> Give detailed feedback
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="fb-chip-text">Thanks for the feedback!</span>
              <div className="fb-chip-actions">
                <button className="fb-link" onClick={() => setModalOpen(true)}>
                  <MessageSquare size={13} /> Add details
                </button>
              </div>
            </>
          )}
          <button className="fb-chip-close" onClick={close} aria-label="Dismiss"><X size={15} /></button>
        </div>
      )}
      {modalOpen && (
        <FeedbackModal
          apiBase={apiBase}
          authToken={authToken}
          source="chat"
          conversationId={conversationId}
          sentiment={chosen}
          onClose={() => setModalOpen(false)}
          onSubmitted={() => { recordAnswer(); setStatus('thanks'); setVisible(true); }}
        />
      )}
    </>
  );
}

// ── Global session feedback toast (shows after `delayMs` of the session) ─────

export function SessionFeedbackToast({ apiBase, authToken, delayMs = 5 * 60 * 1000, suppressed = false }) {
  const [armed, setArmed] = useState(false);   // delay elapsed + gate claimed
  const [closed, setClosed] = useState(false); // dismissed / answered
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [status, setStatus] = useState('ask'); // 'ask' | 'thanks'
  const [modalOpen, setModalOpen] = useState(false);

  // Server sync first (once per session, non-blocking): by the time the timer
  // fires minutes later, the durable cooldown has been merged into local state.
  useEffect(() => { syncFromServer(apiBase, authToken); }, [apiBase, authToken]);

  useEffect(() => {
    // Engagement trigger: the timer runs only while the tab is visible-ish -
    // when it fires in a hidden tab we wait for the user to come back before
    // asking. Frequency itself is owned by the shared gate (once per session
    // across both flows + cross-login cooldowns), checked at fire time so the
    // chat banner claiming the ask first suppresses this toast for the session.
    const ask = () => {
      if (canAsk()) {
        claimAsk();
        setArmed(true);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', onVisible);
        ask();
      }
    };
    const t = setTimeout(() => {
      if (document.visibilityState === 'visible') ask();
      else document.addEventListener('visibilitychange', onVisible);
    }, delayMs);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [delayMs]);

  const close = () => { recordDismiss(); setClosed(true); };

  const pick = async (stars) => {
    setRating(stars);
    setStatus('thanks');
    recordAnswer();
    try { await postFeedback(apiBase, authToken, { source: 'session', rating: stars }); } catch { /* non-blocking */ }
    // Gently auto-dismiss the toast; the modal (if opened) renders separately and stays.
    setTimeout(() => setClosed(true), 4000);
  };

  const shown = hover || rating;
  // Only surface on non-chat screens - the chat screen has its own in-chat
  // feedback banner. If the timer fired while in chat, this shows on the next
  // non-chat screen instead of interrupting the conversation.
  const visible = armed && !closed && !suppressed;

  return (
    <>
      {visible && (
        <div className="fb-toast" role="dialog" aria-label="Rate your experience">
          <button className="fb-toast-close" onClick={close} aria-label="Dismiss"><X size={16} /></button>
          {status === 'ask' ? (
            <>
              <div className="fb-toast-title">Enjoying Botella?</div>
              <div className="fb-toast-sub">Tap a star to rate your experience.</div>
              <div className="fb-stars" onMouseLeave={() => setHover(0)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    className={`fb-star ${n <= shown ? 'is-on' : ''}`}
                    onMouseEnter={() => setHover(n)}
                    onClick={() => pick(n)}
                    aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  >
                    <Star size={22} />
                  </button>
                ))}
              </div>
              <button className="fb-link" onClick={() => setModalOpen(true)}>
                <MessageSquare size={13} /> Write to us
              </button>
            </>
          ) : (
            <>
              <div className="fb-toast-title">Thanks - {rating}★ noted!</div>
              <div className="fb-toast-sub">Anything we could do better?</div>
              <button className="fb-link" onClick={() => setModalOpen(true)}>
                <MessageSquare size={13} /> Write to us
              </button>
            </>
          )}
        </div>
      )}
      {modalOpen && (
        <FeedbackModal
          apiBase={apiBase}
          authToken={authToken}
          source="session"
          rating={rating || null}
          onClose={() => setModalOpen(false)}
          onSubmitted={() => { recordAnswer(); setStatus('thanks'); setClosed(true); }}
        />
      )}
    </>
  );
}
