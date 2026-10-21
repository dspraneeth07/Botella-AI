/**
 * Card Statement Analysis - upload, read, re-run, export, delete.
 *
 * Mounted at `/api/card-statements` behind verifyToken only (server.js). No
 * attachPool: nothing here reads the POS warehouse. Every row lives in the
 * analytics pool - see services/cardStatementService.js.
 *
 *   POST   /upload                    multipart `file` (PDF or CSV) -> 202 { id, status: 'analysing' },
 *                                     or 200 { duplicate: true, id, reason: 'same_file', message }
 *   GET    /                          ?limit&offset&q&status&store&sort -> { data, total, stores }
 *   GET    /:id                       the statement, its analysis (re-run at read time) and savings to date
 *   GET    /:id/log                   { data: [{ id, event, actor, payload, createdAt }] }, oldest first
 *   POST   /:id/reanalyse             { reextract? } -> fresh detail, or 202 when the file is read again
 *   GET    /:id/file                  the original upload
 *   GET    /:id/csv                   the analysis as a spreadsheet
 *   DELETE /:id                       -> { ok: true }
 *   POST   /:id/rebelipay-interest    -> { ok: true, ctaUrl }
 *
 * House rule: statements are scoped to the CLIENT (CARD-STATEMENTS.md D1). The
 * tenant is req.user.client_id from the JWT, never the body or the query, and
 * an id that is not this client's is a 404 exactly like one that does not
 * exist. location_id is recorded for audit and is never a filter.
 *
 * Error shape matches the rest of the app: { "error": { "code", "message" } },
 * with owner-safe messages. Never 401 for a document problem: every screen
 * reads 401 as an expired session.
 *
 * Nothing here does I/O at require time; check-routes requires every router.
 */

const router = require('express').Router();
const fs = require('fs');
const multer = require('multer');
const logger = require('../utils/logger');
const { getAnalyticsPool } = require('../database/analytics-connection');
const svc = require('../services/cardStatementService');

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB; a statement is 4-6 pages and well under 1MB

// No fileFilter on the declared mimetype. Browsers send a CSV as text/csv,
// application/vnd.ms-excel, text/plain or nothing at all, and a mimetype is
// only the client's claim anyway. The bytes are checked after the upload
// (svc.detectKind: %PDF- magic, or a .csv name with text content).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  // Browsers send the file name as raw UTF-8 with no charset; the latin1
  // default turns "Déclaration.pdf" into "DÃ©claration.pdf" on the list.
  defParamCharset: 'utf8',
});

const tenant = (req) => ({ clientId: req.user.client_id, locationId: req.user.location_id });
// Who is acting, for the activity trail. Null rather than a placeholder, so
// the log can tell a person from the system by the absence of an actor.
const actorOf = (req) => (req.user && (req.user.username || req.user.email)) || null;
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const notFound = (res) => fail(res, 404, 'NOT_FOUND', 'That statement was not found.');

/**
 * Answer a failed request with something the reader can act on.
 *
 * Errors the service raised for the owner carry their own status and text.
 * Postgres 42P01 (undefined_table) means one thing here: the analytics
 * migrations have not been run on this machine, and saying so beats a 500 that
 * sends people looking for a bug in their statement. Anything else is logged
 * in full and answered with the fallback.
 */
function failWith(res, err, context, fallbackCode, fallbackMessage) {
  if (err && err.httpStatus) return fail(res, err.httpStatus, err.code, err.publicMessage);
  if (err && err.code === '42P01') {
    return fail(res, 503, 'MIGRATION_MISSING',
      'The card statement tables are missing from the analytics database on this machine. '
      + 'Run: npm run migrate --prefix backend');
  }
  logger.error(`[CS] ${context} failed`, { error: err && err.message, code: err && err.code });
  return fail(res, 500, fallbackCode, fallbackMessage);
}

/**
 * Content-Disposition with an RFC 5987 filename* for the real name, and a
 * plain ASCII filename for clients that predate it. Statement file names are
 * the owner's, so they can carry anything; quotes and non-ASCII never reach
 * the quoted form.
 */
function disposition(type, name) {
  const fallback = String(name || 'statement').replace(/[^\x20-\x7E]+/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(String(name || 'statement'))
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/* ── POST /upload ─────────────────────────────────────────────────────────────
   Store, answer 202, read in the background. A statement read takes long
   enough that holding the request open would meet proxy timeouts; the row
   exists as 'analysing' before the reply goes, the list polls, and a restart
   mid-read is swept to 'failed' (service recoverStuck). multer runs inside the
   handler so its errors become our 400/413 instead of the global handler's 500. */
router.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      if (uploadErr.code === 'LIMIT_FILE_SIZE') {
        return fail(res, 413, 'FILE_TOO_LARGE',
          'That file is larger than 20MB. A card statement is usually well under 1MB; check it is the right file.');
      }
      if (uploadErr.name === 'MulterError') {
        return fail(res, 400, 'NO_FILE', 'Upload one statement at a time.');
      }
      logger.warn('[CS] upload could not be parsed', { error: uploadErr.message });
      return fail(res, 400, 'NO_FILE', 'The upload did not arrive complete. Please try again.');
    }
    if (!req.file) return fail(res, 400, 'NO_FILE', 'No file was attached.');
    if (!req.file.size || !req.file.buffer || !req.file.buffer.length) {
      return fail(res, 400, 'EMPTY_FILE', 'That file is empty.');
    }

    const { clientId, locationId } = tenant(req);
    const fileName = req.file.originalname || 'statement';
    let kind = null;
    try {
      kind = svc.detectKind({ buffer: req.file.buffer, originalName: fileName, mimetype: req.file.mimetype });
    } catch (err) {
      return failWith(res, err, 'type check', 'UPLOAD_FAILED', 'The file could not be checked. Please try again.');
    }
    if (!kind) {
      return fail(res, 400, 'UNSUPPORTED_TYPE',
        'Upload the statement as a PDF, or a transaction export as a CSV file.');
    }

    const pool = getAnalyticsPool();
    const sha = svc.contentHash(req.file.buffer);

    // Already have this exact file? Point at it rather than reading and
    // listing a second copy (contract D8: a hash duplicate creates no row).
    // The owner may genuinely want it read again; "Analyse again" on the
    // existing row is the supported way, and the message says so.
    try {
      const existing = await svc.findByContent(pool, clientId, sha);
      if (existing) {
        svc.logEvent(pool, {
          statementId: existing.id, clientId, locationId, event: 'duplicate', actor: actorOf(req),
          payload: { reason: 'same_file', fileName },
        });
        logger.info('[CS] same file uploaded again', { id: String(existing.id), clientId });
        return res.status(200).json({
          duplicate: true, id: String(existing.id), reason: 'same_file', message: svc.sameFileMessage(existing),
        });
      }
    } catch (err) {
      // A failed duplicate check must never stop an upload. A missing table
      // fails the insert below, which reports it properly.
      logger.warn('[CS] duplicate check failed, continuing', { clientId, error: err.message });
    }

    let stored = null;
    let id = null;
    try {
      stored = svc.storeFile(clientId, kind, req.file.buffer);
      id = await svc.createAnalysing(pool, {
        clientId,
        locationId,
        sha,
        uploadedBy: actorOf(req),
        file: { name: fileName, mime: svc.MIME_BY_KIND[kind], size: req.file.size, path: stored },
      });
      svc.logEvent(pool, {
        statementId: id, clientId, locationId, event: 'uploaded', actor: actorOf(req),
        payload: { fileName, size: req.file.size, kind },
      });

      // CLOSE THE RACE the check above cannot. Two uploads of one file arriving
      // together both pass findByContent and both insert. Now that this row has
      // an id, the later of the two sees the earlier one and retires itself,
      // row and file, so no second row survives. If the check itself fails the
      // upload goes ahead: the row exists, and a rare second copy is a smaller
      // problem than a 500 on a statement that was saved.
      const earlier = await svc.findEarlierByContent(pool, clientId, sha, id).catch((err) => {
        logger.warn('[CS] concurrent duplicate check failed, continuing', { id: String(id), error: err.message });
        return null;
      });
      if (earlier) {
        await svc.discardUpload(pool, clientId, id, stored);
        svc.logEvent(pool, {
          statementId: earlier.id, clientId, locationId, event: 'duplicate', actor: actorOf(req),
          payload: { reason: 'same_file', fileName },
        });
        logger.info('[CS] concurrent duplicate upload retired', {
          id: String(id), originalId: String(earlier.id), clientId });
        return res.status(200).json({
          duplicate: true, id: String(earlier.id), reason: 'same_file', message: svc.sameFileMessage(earlier),
        });
      }
    } catch (err) {
      // No row means nothing points at the file; do not leave it behind.
      if (stored && id == null) svc.removeFile(stored);
      return failWith(res, err, 'upload', 'UPLOAD_FAILED', 'The file could not be saved. Please try again.');
    }

    logger.info('[CS] uploaded', { id: String(id), clientId, locationId, kind, size: req.file.size });
    res.status(202).json({ id: String(id), status: 'analysing' });

    // req.file.buffer is multer's in-memory copy, so it outlives the response.
    // Never throws; the outcome lands on the row and in its log.
    svc.analyseInBackground(id, {
      clientId, locationId, pool, buffer: req.file.buffer, kind, fileName,
    });
  });
});

/* ── GET / ─────────────────────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  const { clientId } = tenant(req);
  try {
    // Whitelisted, not passed through: req.query reaches a WHERE clause, and
    // handing the whole object over would let any future parameter in by accident.
    res.json(await svc.list({
      clientId,
      pool: getAnalyticsPool(),
      limit: req.query.limit,
      offset: req.query.offset,
      q: req.query.q,
      status: req.query.status,
      store: req.query.store,
      sort: req.query.sort,
    }));
  } catch (err) {
    failWith(res, err, 'list', 'LIST_FAILED', 'Could not load your statements.');
  }
});

/* ── GET /:id ──────────────────────────────────────────────────────────────── */
router.get('/:id(\\d+)', async (req, res) => {
  const { clientId } = tenant(req);
  try {
    const detail = await svc.getDetail(req.params.id, { clientId, pool: getAnalyticsPool() });
    if (!detail) return notFound(res);
    res.json(detail);
  } catch (err) {
    failWith(res, err, 'detail', 'DETAIL_FAILED', 'Could not load that statement.');
  }
});

/* ── GET /:id/log ─────────────────────────────────────────────────────────── */
router.get('/:id(\\d+)/log', async (req, res) => {
  const { clientId } = tenant(req);
  try {
    const log = await svc.getLog(req.params.id, { clientId, pool: getAnalyticsPool() });
    if (!log) return notFound(res);
    res.json(log);
  } catch (err) {
    failWith(res, err, 'log', 'LOG_FAILED', 'Could not load the log for that statement.');
  }
});

/* ── POST /:id/reanalyse ──────────────────────────────────────────────────────
   Default: re-run the checks and the engine on the stored extraction, which
   is quick, and answer with the fresh detail. { reextract: true }, or a row
   with nothing stored, reads the original again in the background: 202, like
   an upload. 409 BUSY while a read is already running. */
router.post('/:id(\\d+)/reanalyse', async (req, res) => {
  const { clientId } = tenant(req);
  try {
    const result = await svc.reanalyse(req.params.id, {
      clientId,
      pool: getAnalyticsPool(),
      reextract: !!(req.body && req.body.reextract === true),
      actor: actorOf(req),
    });
    if (!result) return notFound(res);
    if (result.accepted) return res.status(202).json({ id: result.id, status: result.status });
    if (!result.detail) return notFound(res);
    res.json(result.detail);
  } catch (err) {
    failWith(res, err, 'reanalyse', 'REANALYSE_FAILED', 'The statement could not be analysed again. Please try again.');
  }
});

/* ── GET /:id/file - view or download the original ────────────────────────── */
router.get('/:id(\\d+)/file', async (req, res) => {
  const { clientId } = tenant(req);
  try {
    const file = await svc.getFile(req.params.id, { clientId, pool: getAnalyticsPool() });
    if (!file) return notFound(res);
    if (!file.fullPath) return fail(res, 404, 'FILE_MISSING', 'The original file is no longer on the server.');

    // inline by default so the browser can preview a PDF; ?download=1 to save.
    // The type is the one we validated on upload, never the client's claim,
    // and nosniff stops the browser second-guessing it.
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', disposition(req.query.download ? 'attachment' : 'inline', file.name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = fs.createReadStream(file.fullPath);
    stream.on('error', (err) => {
      logger.warn('[CS] file stream failed', { id: req.params.id, clientId, error: err.message });
      if (!res.headersSent) fail(res, 404, 'FILE_MISSING', 'The original file is no longer on the server.');
      else res.destroy(err);
    });
    stream.pipe(res);
  } catch (err) {
    failWith(res, err, 'file', 'FILE_FAILED', 'Could not open that file.');
  }
});

/* ── GET /:id/csv - the analysis as a spreadsheet ─────────────────────────── */
router.get('/:id(\\d+)/csv', async (req, res) => {
  const { clientId } = tenant(req);
  try {
    const detail = await svc.getDetail(req.params.id, { clientId, pool: getAnalyticsPool() });
    if (!detail) return notFound(res);
    if (detail.status !== 'analysed' || !detail.analysis) {
      return fail(res, 409, 'NOT_ANALYSED', 'This statement has not been analysed, so there is nothing to export yet.');
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', disposition('attachment', svc.csvFileName(detail)));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(svc.toCsv(detail));
  } catch (err) {
    failWith(res, err, 'csv', 'CSV_FAILED', 'Could not build the CSV.');
  }
});

/* ── DELETE /:id ──────────────────────────────────────────────────────────── */
router.delete('/:id(\\d+)', async (req, res) => {
  const { clientId } = tenant(req);
  try {
    const done = await svc.deleteStatement(req.params.id, { clientId, pool: getAnalyticsPool() });
    if (!done) return notFound(res);
    res.json({ ok: true });
  } catch (err) {
    failWith(res, err, 'delete', 'DELETE_FAILED', 'Could not delete that statement.');
  }
});

/* ── POST /:id/rebelipay-interest ─────────────────────────────────────────────
   The browser has already opened the Rebelipay page (synchronously, so no
   popup blocker intervenes); this records the interest and forwards the lead.
   A webhook failure never fails this request. */
router.post('/:id(\\d+)/rebelipay-interest', async (req, res) => {
  const { clientId } = tenant(req);
  try {
    const result = await svc.recordInterest(req.params.id, {
      clientId, pool: getAnalyticsPool(), actor: actorOf(req),
    });
    if (!result) return notFound(res);
    res.json(result);
  } catch (err) {
    failWith(res, err, 'rebelipay interest', 'INTEREST_FAILED', 'Could not record that. Please try again.');
  }
});

module.exports = router;
