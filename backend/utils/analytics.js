// Analytics logger for chat interactions.
// One row per chat turn → bottleai_analytics.chat_interactions
//
// Designed so that analytics failures NEVER affect user-facing chat:
//   - All work is wrapped in try/catch
//   - Caller uses fire-and-forget; this function never throws
const { getAnalyticsPool } = require('../database/analytics-connection');

// ─── Pricing constants ─────────────────────────────────────────────────────
// Claude Sonnet 4.6 (model: claude-sonnet-4-6), USD per 1,000,000 tokens - same rates as Sonnet 4.
// If Anthropic changes pricing or you switch models, update these four numbers.
const PRICE_INPUT_PER_M        = 3.00;   // regular input tokens
const PRICE_CACHE_READ_PER_M   = 0.30;   // cached input (10% of regular)
const PRICE_CACHE_WRITE_PER_M  = 3.75;   // cache creation (1.25× regular)
const PRICE_OUTPUT_PER_M       = 15.00;  // output tokens

function calculateCosts(tokens = {}) {
  const inputCost      = (tokens.input      || 0) * PRICE_INPUT_PER_M       / 1_000_000;
  const cacheReadCost  = (tokens.cacheRead  || 0) * PRICE_CACHE_READ_PER_M  / 1_000_000;
  const cacheWriteCost = (tokens.cacheWrite || 0) * PRICE_CACHE_WRITE_PER_M / 1_000_000;
  const outputCost     = (tokens.output     || 0) * PRICE_OUTPUT_PER_M      / 1_000_000;

  // "Question cost" = everything paid to send the request (input + cache).
  // "Response cost" = output tokens (the answer Claude wrote).
  const questionCost = inputCost + cacheReadCost + cacheWriteCost;
  const responseCost = outputCost;

  // Round to 6 decimals (matches NUMERIC(12,6) column precision).
  return {
    questionCost:      Number(questionCost.toFixed(6)),
    responseCost:      Number(responseCost.toFixed(6)),
    totalCost:         Number((questionCost + responseCost).toFixed(6)),
    cacheReadCost:     Number(cacheReadCost.toFixed(6)),
    cacheCreationCost: Number(cacheWriteCost.toFixed(6)),
  };
}

/**
 * Log one chat interaction. Returns the inserted row id, or null on failure.
 * Never throws - analytics failures are silently logged to console.
 *
 * @param {object} d
 * @param {number} d.clientId
 * @param {number} d.locationId
 * @param {string} d.userId
 * @param {string} [d.username]
 * @param {string} [d.locationName]
 * @param {string} [d.conversationId]
 * @param {string} d.question                  - what the user typed
 * @param {string} [d.questionDisplay]         - what they actually saw (null = same as question)
 * @param {string} [d.response]                - assistant's final answer
 * @param {string[]} [d.followups]             - up to 3 suggestion strings
 * @param {object[]} [d.sqlQueries]            - array of {iteration,tool,query,success,row_count,execution_time_ms,error}
 * @param {number} [d.toolLoopsUsed]
 * @param {number} [d.responseTimeMs]
 * @param {object} [d.tokens]                  - {input,output,cacheRead,cacheWrite}
 * @param {string} [d.errorMessage]
 */
async function logChatInteraction(d) {
  try {
    const pool = getAnalyticsPool();
    const costs = calculateCosts(d.tokens || {});

    const sql = `
      INSERT INTO chat_interactions (
        client_id, location_id, user_id, username, location_name,
        conversation_id,
        question, question_display,
        response, followups,
        sql_queries, sql_query_count,
        tool_loops_used, response_time_ms,
        claude_input_tokens, claude_output_tokens,
        claude_cache_read_tokens, claude_cache_creation_tokens,
        error_message,
        question_cost_usd, response_cost_usd, total_cost_usd,
        cache_read_cost_usd, cache_creation_cost_usd
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6,
        $7, $8,
        $9, $10::jsonb,
        $11::jsonb, $12,
        $13, $14,
        $15, $16,
        $17, $18,
        $19,
        $20, $21, $22,
        $23, $24
      )
      RETURNING id
    `;

    const sqlQueriesArr = d.sqlQueries || [];
    const params = [
      d.clientId,
      d.locationId,
      d.userId || 'unknown',
      d.username     || null,
      d.locationName || null,
      d.conversationId || null,
      d.question,
      d.questionDisplay || null,
      d.response       || null,
      JSON.stringify(d.followups || []),
      JSON.stringify(sqlQueriesArr),
      sqlQueriesArr.length,
      d.toolLoopsUsed   ?? null,
      d.responseTimeMs  ?? null,
      d.tokens?.input      ?? null,
      d.tokens?.output     ?? null,
      d.tokens?.cacheRead  ?? null,
      d.tokens?.cacheWrite ?? null,
      d.errorMessage || null,
      costs.questionCost,
      costs.responseCost,
      costs.totalCost,
      costs.cacheReadCost,
      costs.cacheCreationCost,
    ];

    const result = await pool.query(sql, params);
    const rowId = result.rows[0]?.id;
    console.log(`[ANALYTICS] Logged interaction id=${rowId} user=${d.userId} cost=$${costs.totalCost.toFixed(6)}`);
    return rowId;
  } catch (err) {
    // SWALLOW the error - analytics MUST NOT break user-facing chat.
    console.error(`[ANALYTICS] logChatInteraction failed: ${err.message}`);
    return null;
  }
}

module.exports = { logChatInteraction, calculateCosts };
