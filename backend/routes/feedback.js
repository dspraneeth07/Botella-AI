/**
 * /api/feedback - capture user product feedback (thumbs, star rating, and
 * free-text) into the analytics DB. Behind verifyToken; tenant + user come from
 * the JWT (req.user), never the body, so feedback is always attributed correctly.
 *
 * POST /api/feedback
 *   body: { source: 'chat'|'session', sentiment?: 'up'|'down',
 *           rating?: 1..5, message?: string, conversation_id?: string }
 *   At least one of sentiment / rating / message must be present.
 *
 * GET /api/feedback/status
 *   → { last_feedback_at: ISO | null } for the tenant - the frontend's ask
 *     gate syncs its "answered" cooldown from this so it holds across devices.
 */
const router = require('express').Router();
const { saveFeedback, lastFeedbackAt } = require('../services/feedbackService');

router.get('/status', async (req, res) => {
  try {
    const lastAt = await lastFeedbackAt(req.user.client_id, req.user.location_id);
    res.json({ last_feedback_at: lastAt ? new Date(lastAt).toISOString() : null });
  } catch (err) {
    console.error('[/api/feedback/status] error:', err.message);
    // Non-critical: the frontend falls back to its local state.
    res.json({ last_feedback_at: null });
  }
});

router.post('/', async (req, res) => {
  const { source, sentiment, rating, message, conversation_id: conversationId } = req.body || {};

  // ── Validate ────────────────────────────────────────────────────────────
  if (source !== 'chat' && source !== 'session') {
    return res.status(400).json({ error: { code: 'BAD_SOURCE', message: "source must be 'chat' or 'session'." } });
  }
  if (sentiment != null && sentiment !== 'up' && sentiment !== 'down') {
    return res.status(400).json({ error: { code: 'BAD_SENTIMENT', message: "sentiment must be 'up' or 'down'." } });
  }
  let ratingNum = null;
  if (rating != null && rating !== '') {
    ratingNum = Number(rating);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: { code: 'BAD_RATING', message: 'rating must be an integer 1-5.' } });
    }
  }
  const msg = typeof message === 'string' ? message.trim() : '';
  if (!sentiment && ratingNum == null && !msg) {
    return res.status(400).json({ error: { code: 'EMPTY_FEEDBACK', message: 'Provide a rating, a thumbs vote, or a message.' } });
  }
  if (conversationId != null && (typeof conversationId !== 'string' || conversationId.length > 100)) {
    return res.status(400).json({ error: { code: 'BAD_CONVERSATION_ID', message: 'Invalid conversation id.' } });
  }

  try {
    const id = await saveFeedback({
      clientId: req.user.client_id,
      locationId: req.user.location_id,
      userId: req.user.user_id,
      username: req.user.username,
      conversationId: conversationId || null,
      source,
      sentiment: sentiment || null,
      rating: ratingNum,
      message: msg || null,
    });
    res.status(201).json({ success: true, id });
  } catch (err) {
    console.error('[/api/feedback POST] error:', err.message);
    res.status(500).json({ error: { code: 'FEEDBACK_SAVE_FAILED', message: 'Could not save your feedback. Please try again.' } });
  }
});

module.exports = router;
