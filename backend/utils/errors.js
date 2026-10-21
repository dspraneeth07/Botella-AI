/**
 * Custom Error Classes - Botella
 *
 * Use these instead of generic Error to:
 * 1. Never leak internal details to users
 * 2. Set correct HTTP status codes automatically
 * 3. Provide structured error codes for frontend
 */

class AppError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    // User-friendly message (safe to send to client)
    this.userMessage = message;
  }
}

class BusinessError extends AppError {
  constructor(message, code = 'BUSINESS_ERROR') {
    super(message, code, 400);
  }
}

class ValidationError extends AppError {
  constructor(message, code = 'VALIDATION_ERROR') {
    super(message, code, 400);
  }
}

class AuthError extends AppError {
  constructor(message = 'Authentication required. Please log in again.', code = 'AUTH_ERROR') {
    super(message, code, 401);
  }
}

class DatabaseError extends AppError {
  constructor(internalMessage) {
    super('We\'re having trouble accessing your data. Please try again in a moment.', 'DATABASE_ERROR', 500);
    // Keep internal message for logging, never sent to client
    this.internalMessage = internalMessage;
  }
}

/**
 * IS THIS THE ACCOUNT'S PROBLEM OR THE NETWORK'S?
 *
 * An exhausted credit balance, a revoked key and a permission error all arrive
 * as 4xx `invalid_request_error` / `authentication_error` from the provider, and
 * none of them clears by waiting. Telling the owner to "try again in a few
 * seconds" is then false twice over: the retry cannot work, and the real fault -
 * billing or a key - is hidden behind the word "unavailable".
 *
 * Measured cost of getting this wrong, 20 October: the chat returned "The AI
 * service is temporarily unavailable. Please try again in a few seconds." while
 * the underlying response was `400 invalid_request_error: Your credit balance is
 * too low to access the Anthropic API`. The banner sent the operator looking for
 * a bug in the stack - every service was healthy - instead of at Plans & Billing.
 *
 * `isTransient` in routes/chat.js already refuses to RETRY these, so the two
 * agree; this adds the half that reaches a human.
 */
const PERSISTENT_PROVIDER_FAULT = [
  /credit balance is too low/i,
  /insufficient[_ ]quota/i,
  /authentication[_ ]error/i,
  // Anthropic's own wording for a bad key is "invalid x-api-key"; OpenAI's is
  // "Incorrect API key provided". Matched loosely because the exact phrasing is
  // the provider's to change and a missed match costs a misleading banner.
  /invalid[ _-]*x?-?api[ _-]?key/i,
  /incorrect api key/i,
  /permission[_ ]error/i,
  /billing/i,
];

function isPersistentProviderFault(detail) {
  const text = String(detail || '');
  return PERSISTENT_PROVIDER_FAULT.some((re) => re.test(text));
}

class ExternalServiceError extends AppError {
  constructor(service, internalMessage) {
    const messages = {
      anthropic: 'The AI service is temporarily unavailable. Please try again in a few seconds.',
      openai: 'The image generation service is temporarily unavailable. Please try again.',
      gmail: 'Unable to connect to Gmail. Please check your connection and try again.',
      meta: 'Unable to connect to social media. Please check your connection and try again.',
    };
    // A store owner cannot top up Botella's API credits, so the owner-facing
    // wording stays calm and non-technical - but it must not promise that
    // waiting fixes it, and it must not invite a retry that is certain to fail.
    const persistent = isPersistentProviderFault(internalMessage);
    const message = persistent
      ? 'AI features are offline right now. This needs attention from the Botella '
        + 'team - retrying will not help. Everything else on this page still works.'
      : (messages[service] || 'An external service is temporarily unavailable. Please try again.');
    // 503 and not 502: the dependency answered clearly and refused. 502 reads as
    // a bad gateway and groups this with the outages it is not one of.
    super(message, persistent ? 'EXTERNAL_SERVICE_UNCONFIGURED' : 'EXTERNAL_SERVICE_ERROR',
      persistent ? 503 : 502);
    this.service = service;
    this.internalMessage = internalMessage;
    this.persistent = persistent;
    this.retryable = !persistent;
    if (persistent) {
      // Loud, and on its own line. The operator should not have to read a 400
      // JSON blob to find out that this is a billing problem.
      // eslint-disable-next-line no-console
      console.error(
        `[ACTION REQUIRED] ${service}: persistent account fault, not an outage. `
        + 'Retrying will not help. Check the provider account (credits / API key / '
        + `permissions). Provider said: ${String(internalMessage || '').slice(0, 300)}`
      );
    }
  }
}

class RateLimitError extends AppError {
  constructor(message = 'You\'ve reached the usage limit. Please try again later.') {
    super(message, 'RATE_LIMIT', 429);
  }
}

/**
 * Map a raw error to a user-friendly AppError
 * Use this in catch blocks to safely convert unknown errors
 */
function toSafeError(err) {
  // Already an AppError - pass through
  if (err instanceof AppError) return err;

  const msg = (err.message || '').toLowerCase();

  // Database errors
  if (msg.includes('econnrefused') || msg.includes('connection') || msg.includes('pool') || msg.includes('timeout')) {
    return new DatabaseError(err.message);
  }

  // Anthropic API errors
  if (msg.includes('anthropic') || msg.includes('api key') || msg.includes('overloaded') || msg.includes('rate_limit')) {
    return new ExternalServiceError('anthropic', err.message);
  }

  // OpenAI errors
  if (msg.includes('openai') || msg.includes('image generation') || msg.includes('dall-e') || msg.includes('gpt-image')) {
    return new ExternalServiceError('openai', err.message);
  }

  // Gmail errors
  if (msg.includes('gmail') || msg.includes('google') || msg.includes('oauth')) {
    return new ExternalServiceError('gmail', err.message);
  }

  // Default - generic safe message
  const safe = new AppError(
    'Something went wrong. Please try again.',
    'INTERNAL_ERROR',
    500
  );
  safe.internalMessage = err.message;
  return safe;
}

module.exports = {
  AppError,
  BusinessError,
  ValidationError,
  AuthError,
  DatabaseError,
  ExternalServiceError,
  RateLimitError,
  toSafeError,
  // Exported so the chat route's own retry predicate can agree with this one
  // rather than keeping a second, drifting copy of the same judgement.
  isPersistentProviderFault,
};
