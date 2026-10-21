// /api/conversations - read & delete chat history backed by the
// bottleai_analytics.chat_interactions table.
//
// All endpoints REQUIRE authentication and strictly filter by
// `user_id = req.user.user_id` so users can only see their own chats.
const router = require('express').Router();
const { getAnalyticsPool } = require('../database/analytics-connection');

// ─── Helpers ───────────────────────────────────────────────────────────────

// Take the first ~60 chars of the first user question as the conversation title.
// Mirrors the deriveTitle() logic the frontend used in localStorage so the
// sidebar looks identical after the migration.
function deriveTitle(firstQuestion) {
  if (!firstQuestion) return 'New Chat';
  const trimmed = firstQuestion.trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57) + '…';
}

// Convert a flat list of chat_interactions rows into the {role,text,followups}
// shape the frontend's <Message /> components expect.
function rowsToMessages(rows) {
  const messages = [];
  for (const r of rows) {
    // Each row is one (user question + assistant response) turn.
    if (r.question) {
      messages.push({
        role: 'user',
        // question_display = what the user actually saw (e.g. for the
        // Suggestions → Analyse flow). Fall back to question text when null.
        text: r.question_display || r.question,
      });
    }
    if (r.response !== null && r.response !== undefined) {
      messages.push({
        role: 'assistant',
        text: r.response || '',
        followups: r.followups || [],
        // Pass through the per-turn response time so the hover tooltip in the
        // chat UI works after a refresh / conversation switch (matches the
        // shape produced by the live SSE 'done' event).
        responseTimeMs: r.response_time_ms ?? null,
      });
    }
  }
  return messages;
}

// ─── GET /api/conversations ─────────────────────────────────────────────────
// Lists the calling user's conversations, newest first.
// Returns: [{ id, title, message_count, createdAt, updatedAt }, ...]
router.get('/', async (req, res) => {
  const userId = req.user.user_id;
  const clientId = req.user.client_id;
  const locationId = req.user.location_id;

  try {
    const pool = getAnalyticsPool();

    // Group by conversation_id and grab the earliest question of each group as the title.
    // Tenant filter (client_id + location_id) is included as defense-in-depth
    // even though user_id is already unique.
    // deleted_at IS NULL hides conversations the user has soft-deleted (data
    // is retained in the DB for analytics; just hidden from this API).
    const sql = `
      SELECT
        conversation_id AS id,
        COUNT(*) AS message_count,
        MIN(created_at) AS created_at,
        MAX(created_at) AS updated_at,
        -- Prefer the human-readable question_display (what the user actually saw)
        -- over the raw question text. Only differs when a hidden prompt was sent
        -- (e.g. Suggestions → Analyse) but it's the right title in every case.
        (ARRAY_AGG(COALESCE(question_display, question) ORDER BY created_at ASC))[1] AS first_question
      FROM chat_interactions
      WHERE user_id = $1
        AND client_id = $2
        AND location_id = $3
        AND conversation_id IS NOT NULL
        AND deleted_at IS NULL
      GROUP BY conversation_id
      ORDER BY MAX(created_at) DESC
      LIMIT 200
    `;

    const result = await pool.query(sql, [userId, clientId, locationId]);

    const conversations = result.rows.map((row) => ({
      id: row.id,
      title: deriveTitle(row.first_question),
      messageCount: parseInt(row.message_count, 10) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    res.json({ conversations });
  } catch (err) {
    console.error('[/api/conversations LIST] error:', err.message);
    res.status(500).json({ error: { code: 'CONVERSATIONS_LIST_FAILED', message: 'Failed to load conversations.' } });
  }
});

// ─── GET /api/conversations/:id ─────────────────────────────────────────────
// Returns one conversation with its messages, oldest-first.
router.get('/:id', async (req, res) => {
  const userId = req.user.user_id;
  const clientId = req.user.client_id;
  const locationId = req.user.location_id;
  const conversationId = req.params.id;

  if (!conversationId || conversationId.length > 100) {
    return res.status(400).json({ error: { code: 'BAD_CONVERSATION_ID', message: 'Invalid conversation id.' } });
  }

  try {
    const pool = getAnalyticsPool();

    const sql = `
      SELECT id, question, question_display, response, followups,
             response_time_ms, created_at
      FROM chat_interactions
      WHERE user_id = $1
        AND client_id = $2
        AND location_id = $3
        AND conversation_id = $4
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;

    const result = await pool.query(sql, [userId, clientId, locationId, conversationId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found or you do not have access.' } });
    }

    const messages = rowsToMessages(result.rows);
    const firstQuestion = result.rows.find((r) => r.question)?.question || '';

    res.json({
      id: conversationId,
      title: deriveTitle(firstQuestion),
      messages,
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[result.rows.length - 1].created_at,
    });
  } catch (err) {
    console.error(`[/api/conversations GET] id=${conversationId} error:`, err.message);
    res.status(500).json({ error: { code: 'CONVERSATION_LOAD_FAILED', message: 'Failed to load conversation.' } });
  }
});

// ─── DELETE /api/conversations/:id ──────────────────────────────────────────
// SOFT-deletes every chat_interactions row tied to this conversation_id by
// setting deleted_at = NOW(). The data is retained in the database (useful
// for analytics, audit, and possible future "undo" features) but hidden from
// the user - both the LIST and GET endpoints filter on deleted_at IS NULL.
//
// Strictly scoped to the calling user. Idempotent: deleting an
// already-deleted conversation is a no-op (returns 404).
router.delete('/:id', async (req, res) => {
  const userId = req.user.user_id;
  const clientId = req.user.client_id;
  const locationId = req.user.location_id;
  const conversationId = req.params.id;

  if (!conversationId || conversationId.length > 100) {
    return res.status(400).json({ error: { code: 'BAD_CONVERSATION_ID', message: 'Invalid conversation id.' } });
  }

  try {
    const pool = getAnalyticsPool();

    const sql = `
      UPDATE chat_interactions
         SET deleted_at = NOW()
       WHERE user_id = $1
         AND client_id = $2
         AND location_id = $3
         AND conversation_id = $4
         AND deleted_at IS NULL
    `;

    const result = await pool.query(sql, [userId, clientId, locationId, conversationId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found or already deleted.' } });
    }

    console.log(`[CONVERSATIONS] Soft-deleted id=${conversationId} user=${userId} rows=${result.rowCount}`);
    res.json({ success: true, deletedRows: result.rowCount });
  } catch (err) {
    console.error(`[/api/conversations DELETE] id=${conversationId} error:`, err.message);
    res.status(500).json({ error: { code: 'CONVERSATION_DELETE_FAILED', message: 'Failed to delete conversation.' } });
  }
});

module.exports = router;
