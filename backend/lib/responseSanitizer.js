// responseSanitizer.js
// -----------------------------------------------------------------------------
// Strips sensitive patterns from chat responses BEFORE they reach the user,
// regardless of what the LLM emits. This is a defence-in-depth layer:
// the system prompt already tells Claude never to reveal customer UUIDs or
// SQL queries, but the bot has been observed caving under repeated user
// pressure (BOTELLA-22, BOTELLA-23). A server-side regex pass guarantees the
// guardrails hold even if the prompt rules fail.
//
// Two patterns are stripped:
//   1. UUIDs (customer_id values) - 8-4-4-4-12 hex format
//   2. SQL code blocks (```sql ... ``` fenced or bare SELECT/FROM/WHERE lines)
//
// The module exports two surfaces:
//   - sanitizeText(text) - one-shot, for fully assembled responses
//   - createStreamingSanitizer() - for SSE delta streams, with a hold-back
//     buffer so patterns spanning chunk boundaries are still caught
// -----------------------------------------------------------------------------

// Standard UUID v4 / v1 / nil - 8-4-4-4-12 lowercase or uppercase hex.
// Replaced with a generic placeholder so the rest of the answer still reads.
const UUID_REGEX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Fenced SQL code block - ```sql ... ``` (also bare ``` ... ``` that contains
// obvious SQL keywords on its first line). Spans multiple lines, so we use
// the s-flag for `.` to match newlines, and a non-greedy `.*?` to stop at
// the first closing fence.
const FENCED_SQL_REGEX = /```\s*sql\b[\s\S]*?```/gi;

// Heuristic for an unfenced SQL line - starts a logical statement with a
// SQL verb followed by another SQL keyword. We deliberately require BOTH
// because "SELECT a product" or "Update your shipping address" are valid
// English and would false-positive on the verb alone.
const SQL_VERB_LINE_REGEX = /^(\s*)(SELECT\s+.+\bFROM\b|WITH\s+\w+\s+AS\s*\(|INSERT\s+INTO\s+\w+|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\s+\w+|CREATE\s+(TABLE|VIEW|INDEX|DATABASE|FUNCTION|PROCEDURE|TRIGGER)\b|ALTER\s+(TABLE|DATABASE|VIEW)\b|DROP\s+(TABLE|DATABASE|VIEW|INDEX)\b)[^\n]*$/gim;

// Replacement strings - kept consistent so log analysis can grep for them.
const UUID_PLACEHOLDER = '[customer ID hidden]';
const SQL_PLACEHOLDER = '_[query hidden]_';

// BOTELLA-11 fix: markdown tables break when cells are empty because some
// renderers shift remaining cells leftward (the "column misalignment" the QA
// team reported on customer-list queries with optional email/phone). Cleanest
// fix is to replace EMPTY cells with an em-dash placeholder so every cell
// has visible content. Detection: a line is a markdown table row when it
// starts and ends with a `|`. Separator rows (---|---) are left alone.
const TABLE_ROW_REGEX = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_REGEX = /^\s*\|[\s\-:|]+\|\s*$/;
const EMPTY_CELL_PLACEHOLDER = '-';

function normaliseMarkdownTables(text) {
  if (!text || typeof text !== 'string' || !text.includes('|')) return text;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TABLE_ROW_REGEX.test(line) || TABLE_SEPARATOR_REGEX.test(line)) continue;
    // Split on `|`, but preserve the leading/trailing empty cells (which
    // are the syntax markers, not actual cells). Trim each real cell and
    // replace empties with the placeholder.
    const parts = line.split('|');
    // parts[0] is text before the first `|` (usually whitespace/empty)
    // parts[parts.length - 1] is text after the last `|` (same)
    // Real cells are parts[1] .. parts[length - 2]
    for (let j = 1; j < parts.length - 1; j++) {
      if (parts[j].trim() === '') {
        parts[j] = ` ${EMPTY_CELL_PLACEHOLDER} `;
      }
    }
    lines[i] = parts.join('|');
  }
  return lines.join('\n');
}

/**
 * One-shot sanitiser for fully assembled response text.
 * Use this on the final logged response and for non-streaming paths.
 *
 * Order matters: strip fenced SQL FIRST (so its UUIDs inside don't accidentally
 * survive when the fence is stripped), then bare SQL lines, then UUIDs.
 */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return text;
  const securityStripped = text
    .replace(FENCED_SQL_REGEX, SQL_PLACEHOLDER)
    .replace(SQL_VERB_LINE_REGEX, (_match, indent) => `${indent}${SQL_PLACEHOLDER}`)
    .replace(UUID_REGEX, UUID_PLACEHOLDER);
  // Table normalisation runs LAST so it doesn't interfere with the SQL/UUID
  // regexes, which are anchored to specific patterns the table-cell em-dash
  // wouldn't accidentally match.
  return normaliseMarkdownTables(securityStripped);
}

/**
 * Streaming-friendly sanitiser. Patterns can span delta boundaries (a UUID
 * is 36 chars, fenced SQL blocks span many tokens), so we maintain a small
 * tail buffer of recently-received text. Each `addChunk` call appends to
 * the tail, then emits the "safe-to-flush" prefix - anything more than
 * HOLDBACK_CHARS away from the end, since shorter patterns can't still
 * be growing in the unflushed tail.
 *
 * One gotcha: fenced SQL blocks can be arbitrarily long. We can't realistically
 * hold back an entire potential block. Instead, when we see ```sql open, we
 * flip into "drop mode" and discard all subsequent input until we see ```
 * close. This means the user momentarily sees nothing while a block streams,
 * then a placeholder appears once it ends - a perfectly acceptable UX for
 * the rare case the LLM tries to dump SQL.
 *
 * Usage:
 *   const s = createStreamingSanitizer();
 *   for each delta:        const safe = s.addChunk(delta);
 *                          if (safe) sendSSE(...safe);
 *   when stream ends:      const tail = s.flush();
 *                          if (tail) sendSSE(...tail);
 */
// Hold-back size for the streaming sanitiser. Must be ≥ UUID length (36 chars)
// so any UUID sitting entirely inside the tail can be detected before
// being emitted. Bumping this higher than 40 only adds initial-stream lag -
// it doesn't improve detection. Reduced from 80 → 40 to restore the
// letter-by-letter streaming animation; the original 80 was overly cautious
// and caused tokens to accumulate into big batches before reaching the user.
const HOLDBACK_CHARS = 40;

function createStreamingSanitizer() {
  let tail = '';            // unsent buffer
  let inSqlFence = false;   // true while inside ```sql ... ```
  let droppedDuringFence = false; // flag for placeholder emission on fence close

  function processNonFenceText(input) {
    // Apply the line-level + UUID regexes to text outside SQL fences.
    // Table normalisation also runs here so empty table cells get the
    // em-dash placeholder while the response is still streaming. Rows
    // split across delta boundaries naturally fall through to the next
    // chunk's pass, where the full row eventually appears.
    return normaliseMarkdownTables(
      input
        .replace(SQL_VERB_LINE_REGEX, (_match, indent) => `${indent}${SQL_PLACEHOLDER}`)
        .replace(UUID_REGEX, UUID_PLACEHOLDER)
    );
  }

  function addChunk(delta) {
    if (!delta) return '';
    tail += delta;

    let output = '';

    while (tail.length > 0) {
      if (inSqlFence) {
        // Look for closing fence
        const closeIdx = tail.indexOf('```');
        if (closeIdx === -1) {
          // Whole tail is inside the fence - drop it
          droppedDuringFence = true;
          tail = '';
          break;
        }
        // Found close - drop everything up to and including the fence,
        // emit a placeholder ONCE for the dropped block.
        tail = tail.slice(closeIdx + 3);
        inSqlFence = false;
        if (droppedDuringFence) {
          output += SQL_PLACEHOLDER;
          droppedDuringFence = false;
        }
        continue;
      }

      // Look for opening SQL fence in the tail.
      // We match ```sql with optional whitespace after the backticks.
      const fenceMatch = tail.match(/```\s*sql\b/i);
      if (fenceMatch && fenceMatch.index !== undefined) {
        // Emit everything before the fence (sanitised), enter fence mode.
        const before = tail.slice(0, fenceMatch.index);
        output += processNonFenceText(before);
        tail = tail.slice(fenceMatch.index + fenceMatch[0].length);
        inSqlFence = true;
        droppedDuringFence = true;
        continue;
      }

      // No fence in sight. Emit everything except the last HOLDBACK_CHARS
      // (which may still grow into a pattern with the next chunk).
      if (tail.length <= HOLDBACK_CHARS) {
        // Not enough buffered to safely emit anything yet
        break;
      }
      const splitAt = tail.length - HOLDBACK_CHARS;
      const ready = tail.slice(0, splitAt);
      tail = tail.slice(splitAt);
      output += processNonFenceText(ready);
      break;
    }

    return output;
  }

  function flush() {
    // End-of-stream: emit whatever's left in the tail, sanitised. If we're
    // still inside an unclosed SQL fence (LLM cut off mid-block), emit the
    // placeholder so the user sees SOMETHING acknowledging the omission.
    let out = '';
    if (inSqlFence) {
      if (droppedDuringFence) out += SQL_PLACEHOLDER;
      inSqlFence = false;
      droppedDuringFence = false;
      tail = '';
      return out;
    }
    if (tail.length > 0) {
      out += processNonFenceText(tail);
      tail = '';
    }
    return out;
  }

  return { addChunk, flush };
}

module.exports = {
  sanitizeText,
  createStreamingSanitizer,
  // Exported for testing / observability
  UUID_PLACEHOLDER,
  SQL_PLACEHOLDER,
};
