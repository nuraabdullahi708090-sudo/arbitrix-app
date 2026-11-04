'use strict';

/**
 * Signed Zernio webhook endpoint logic.
 *
 * VERIFIED CONTRACT (docs.zernio.com/webhooks):
 *   - header X-Zernio-Signature: hex HMAC-SHA256 of the RAW request body, keyed
 *     by the endpoint secret. Compare BEFORE parsing.
 *   - header X-Zernio-Event: event name.
 *   - header X-Zernio-Event-Id (also body.id): stable per event, identical on
 *     every retry and redelivery. It is the dedupe key.
 *   - the endpoint must answer 2xx within 5 seconds; anything else schedules a
 *     retry with exponential backoff (up to 7 attempts).
 *
 * STATUS CODES THIS HANDLER RETURNS
 *   401 invalid/missing signature  -> fail closed, never process.
 *   503 secret not configured      -> fail closed (do not pretend success).
 *   200 processed / duplicate / disabled.
 *   500 processing failed          -> Zernio retries; the dedupe key is released
 *                                     so the retry is actually processed.
 *
 * A message is never sent twice for one event: the dedupe key is taken before
 * processing and released only when processing failed.
 */

const crypto = require('crypto');

const DEFAULT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEDUPE_MAX = 5000;

function scrubSecret(text, secret) {
  if (!text || !secret) return text;
  return String(text).split(secret).join('[redacted]');
}

/**
 * Constant-time HMAC verification of the raw request bytes.
 */
function verifySignature({ rawBody, signature, secret }) {
  if (!secret) return { ok: false, reason: 'not-configured' };
  if (!signature) return { ok: false, reason: 'missing-signature' };

  const provided = String(signature).trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(provided)) {
    return { ok: false, reason: 'malformed-signature' };
  }

  const body = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(typeof rawBody === 'string' ? rawBody : '', 'utf8');

  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const providedBuffer = Buffer.from(provided, 'hex');

  if (expectedBuffer.length !== providedBuffer.length) {
    return { ok: false, reason: 'signature-mismatch' };
  }
  const equal = crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  return equal ? { ok: true, reason: 'verified' } : { ok: false, reason: 'signature-mismatch' };
}

function createEventDeduper(options) {
  const opts = options || {};
  const ttlMs = Number(opts.ttlMs || DEFAULT_DEDUPE_TTL_MS);
  const maxEntries = Number(opts.maxEntries || DEFAULT_DEDUPE_MAX);
  const clock = opts.clock || (() => Date.now());
  const seen = new Map();

  function prune(now) {
    for (const [key, at] of seen) {
      if (now - at > ttlMs) seen.delete(key);
      else break;
    }
  }

  return {
    /**
     * Reserve an event id. Returns false when it is already known (duplicate).
     */
    reserve(eventId) {
      if (!eventId) return true;
      const now = clock();
      prune(now);
      if (seen.has(eventId)) return false;
      if (seen.size >= maxEntries) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.set(eventId, now);
      return true;
    },
    /** Release a reservation whose processing failed, so a retry is processed. */
    release(eventId) {
      if (eventId) seen.delete(eventId);
    },
    size() {
      return seen.size;
    },
    has(eventId) {
      return seen.has(eventId);
    }
  };
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;
  const lower = headers[String(name).toLowerCase()];
  if (lower !== undefined) return Array.isArray(lower) ? lower[0] : lower;
  return undefined;
}

/**
 * Build the Express handler body. `automation` is the object returned by
 * createWhatsAppAutomation(); it is only called after the signature passes.
 */
function createZernioWebhookHandler(options) {
  const opts = options || {};
  const automation = opts.automation;
  const logger = opts.logger || console;
  const clock = opts.clock || (() => Date.now());
  const deduper = opts.deduper || createEventDeduper({ clock });
  const secret = opts.secret !== undefined ? opts.secret : process.env.ZERNIO_WEBHOOK_SECRET || '';
  const enabled = opts.enabled === undefined
    ? String(process.env.WHATSAPP_AUTOMATION_ENABLED || '').toLowerCase() === 'true'
    : Boolean(opts.enabled);

  async function handle({ headers, rawBody, body }) {
    const signature = headerValue(headers, 'x-zernio-signature');
    const verification = verifySignature({ rawBody, signature, secret });

    if (!verification.ok) {
      if (verification.reason === 'not-configured') {
        logger.error('[WhatsApp] Webhook secret is not configured; refusing the delivery', {
          event: 'whatsapp_webhook_not_configured'
        });
        return { status: 503, body: { ok: false, error: 'not_configured' } };
      }
      logger.warn('[WhatsApp] Webhook signature rejected', {
        event: 'whatsapp_webhook_rejected',
        reason: verification.reason
      });
      return { status: 401, body: { ok: false, error: 'invalid_signature', reason: verification.reason } };
    }

    const eventId = headerValue(headers, 'x-zernio-event-id') || (body && body.id) || null;
    const eventName = headerValue(headers, 'x-zernio-event') || (body && body.event) || null;

    if (!eventName) {
      return { status: 400, body: { ok: false, error: 'missing_event' } };
    }

    if (!enabled) {
      return { status: 200, body: { ok: true, skipped: 'disabled' } };
    }

    if (!deduper.reserve(eventId)) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    try {
      const result = await automation.handleEvent(eventName, body);
      if (result && result.delivered === false) {
        // The customer did not receive the reply: answer 500 so Zernio retries,
        // and release the dedupe key so the retry is actually processed.
        deduper.release(eventId);
        logger.error('[WhatsApp] Reply was not delivered; asking Zernio to retry', {
          event: 'whatsapp_reply_undelivered',
          eventName,
          eventId,
          action: result.action
        });
        return { status: 500, body: { ok: false, error: 'delivery_failed' } };
      }
      logger.log(JSON.stringify({
        event: 'whatsapp_webhook_processed',
        eventName,
        eventId,
        action: result && result.action,
        language: result && result.language,
        reason: result && result.reason
      }));
      return { status: 200, body: { ok: true, ...result } };
    } catch (error) {
      deduper.release(eventId);
      logger.error('[WhatsApp] Webhook processing failed', {
        event: 'whatsapp_webhook_failed',
        eventName,
        eventId,
        code: error && error.code,
        status: error && error.status,
        message: scrubSecret(error && error.message, secret)
      });
      return { status: 500, body: { ok: false, error: 'processing_failed' } };
    }
  }

  return { handle, verifySignature, deduper, getSecretConfigured: () => Boolean(secret) };
}

module.exports = {
  DEFAULT_DEDUPE_TTL_MS,
  DEFAULT_DEDUPE_MAX,
  verifySignature,
  createEventDeduper,
  createZernioWebhookHandler
};
