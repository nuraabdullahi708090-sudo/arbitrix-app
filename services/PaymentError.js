'use strict';

/**
 * Payment error classification.
 *
 * Why this exists: `POST /api/payment/create-invoice` used to answer HTTP 400
 * "Failed to create invoice" for EVERY failure - a provider rejecting the
 * amount, an exhausted prepaid balance, a suspended API key, a rate limit, a
 * 5xx, a network timeout, or a database error. The customer then saw
 * "That amount could not be processed. Check the amount and try again." and
 * support chased the amount instead of the real cause.
 *
 * The rule this module encodes:
 *
 *   HTTP 400  -> the CUSTOMER's input is wrong. Only genuine validation errors.
 *   HTTP 502  -> the provider examined the request and refused it.
 *   HTTP 503  -> the provider (or the network to it) could not serve us.
 *   HTTP 500  -> our own unexpected failure.
 *
 * `ambiguous` is the safety bit that decides whether the local invoice row may be
 * marked `failed`:
 *
 *   false -> the provider definitively did not create an invoice (a 4xx answer,
 *            or a request we never sent). Safe to mark the row failed.
 *   true  -> the provider may have created the invoice anyway (5xx, timeout,
 *            connection reset, a 2xx with an unusable body). The row is left
 *            `pending` so the outcome stays recoverable and a late webhook can
 *            still credit it.
 *
 * Nothing here reads the environment, performs I/O, or knows about Supabase.
 */

const PAYMENT_ERROR_CODES = Object.freeze({
    // customer input
    INVALID_AMOUNT: 'PAYMENT_INVALID_AMOUNT',
    INVALID_CURRENCY: 'PAYMENT_INVALID_CURRENCY',
    INVALID_NETWORK: 'PAYMENT_INVALID_NETWORK',
    // provider
    PROVIDER_REJECTED: 'PAYMENT_PROVIDER_REJECTED',
    PROVIDER_ACCOUNT: 'PAYMENT_PROVIDER_ACCOUNT',
    PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
    PROVIDER_TIMEOUT: 'PAYMENT_PROVIDER_TIMEOUT',
    PROVIDER_INVALID_RESPONSE: 'PAYMENT_PROVIDER_INVALID_RESPONSE',
    // us
    INTERNAL: 'PAYMENT_INTERNAL_ERROR'
});

/**
 * Customer-facing text per code. Deliberately generic and provider-agnostic:
 * the provider's own words never reach a browser (or an analytics event).
 */
const PUBLIC_MESSAGES = Object.freeze({
    [PAYMENT_ERROR_CODES.INVALID_AMOUNT]: 'Invalid amount',
    [PAYMENT_ERROR_CODES.INVALID_CURRENCY]: 'Unsupported currency',
    [PAYMENT_ERROR_CODES.INVALID_NETWORK]: 'Unsupported network',
    [PAYMENT_ERROR_CODES.PROVIDER_REJECTED]: 'The payment provider refused this invoice request',
    [PAYMENT_ERROR_CODES.PROVIDER_ACCOUNT]: 'The payment provider is not accepting invoices right now',
    [PAYMENT_ERROR_CODES.PROVIDER_UNAVAILABLE]: 'The payment provider is temporarily unavailable',
    [PAYMENT_ERROR_CODES.PROVIDER_TIMEOUT]: 'The payment provider did not answer in time',
    [PAYMENT_ERROR_CODES.PROVIDER_INVALID_RESPONSE]: 'The payment provider returned an unusable response',
    [PAYMENT_ERROR_CODES.INTERNAL]: 'Could not create a payment invoice'
});

class PaymentError extends Error {
    /**
     * @param {string} code - one of PAYMENT_ERROR_CODES
     * @param {object} [options]
     * @param {number} [options.httpStatus] - status WE answer with
     * @param {boolean} [options.retryable] - is an immediate retry worth offering?
     * @param {boolean} [options.ambiguous] - may the provider have created the invoice?
     * @param {number|null} [options.providerStatus] - the provider's own HTTP status
     * @param {string} [options.providerMessage] - sanitised provider text (logs only)
     * @param {string} [options.provider] - provider name
     */
    constructor(code, options) {
        const opts = options || {};
        const publicMessage = PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES[PAYMENT_ERROR_CODES.INTERNAL];
        const detail = opts.providerMessage ? ` (provider ${opts.providerStatus || 'signal'}: ${opts.providerMessage})` : '';
        super(`${publicMessage}${detail}`);
        this.name = 'PaymentError';
        this.code = code;
        this.httpStatus = opts.httpStatus || 500;
        this.retryable = opts.retryable !== false;
        this.ambiguous = opts.ambiguous === true;
        this.providerStatus = Number.isFinite(opts.providerStatus) ? opts.providerStatus : null;
        this.providerMessage = opts.providerMessage || null;
        this.provider = opts.provider || null;
    }
}

/**
 * Remove anything credential-shaped from a provider response before it is
 * logged. Truncated, single line, no API key, no bearer token, no long hex
 * secret. The result is ONLY ever written to a server log - never returned.
 */
function sanitizeProviderText(text, maxLength) {
    const limit = Number.isFinite(maxLength) ? maxLength : 200;
    let value = String(text == null ? '' : text);
    if (!value) return '';
    value = value.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]');
    value = value.replace(/\b(?:live|test|sk|pk|rk)_[A-Za-z0-9_\-]{4,}/g, '[redacted]');
    value = value.replace(
        /("(?:api[_-]?key|apikey|secret|token|password|authorization|webhook[_-]?secret|private[_-]?key)"\s*:\s*")[^"]*(")/gi,
        '$1[redacted]$2'
    );
    value = value.replace(/\b[0-9a-f]{64}\b/gi, '[redacted]');
    value = value.replace(/\s+/g, ' ').trim();
    if (value.length > limit) value = value.slice(0, limit) + '...';
    return value;
}

function providerError(code, httpStatus, retryable, ambiguous, status, bodyText, provider) {
    return new PaymentError(code, {
        httpStatus,
        retryable,
        ambiguous,
        providerStatus: Number.isFinite(status) ? status : null,
        providerMessage: bodyText ? sanitizeProviderText(bodyText) : null,
        provider: provider || null
    });
}

/**
 * Classify a NON-2xx answer from a payment provider.
 *
 * | provider status        | code                  | we answer | retryable | ambiguous |
 * |------------------------|-----------------------|-----------|-----------|-----------|
 * | 400 / 422 / other 4xx  | PROVIDER_REJECTED     | 502       | no        | no        |
 * | 409                    | PROVIDER_REJECTED     | 502       | no        | YES       |
 * | 401 / 403              | PROVIDER_ACCOUNT      | 503       | no        | no        |
 * | 429                    | PROVIDER_UNAVAILABLE  | 503       | yes       | no        |
 * | 408                    | PROVIDER_TIMEOUT      | 503       | yes       | yes       |
 * | 5xx                    | PROVIDER_UNAVAILABLE  | 503       | yes       | yes       |
 *
 * `retryable: false` for 401/403 because pressing "Try again" cannot fix a key or
 * an account state - an operator has to. It is still `ambiguous: false`: a
 * refused request was not turned into an invoice.
 *
 * 409 IS SPECIAL - it is the one 4xx that is NOT ambiguous:false. Q8QPay documents
 * 409 as "Duplicate reference", i.e. an invoice with OUR reference ALREADY EXISTS.
 * That is the opposite of "no invoice was created": refunding the reference to the
 * retry/queue/replay path means the invoice can be paid while our row says failed.
 * See docs/payments/Q8QPAY-INVOICE-CREATE-ERRORS.md for the full reasoning and the
 * settlement paths that a `failed` row would lock out.
 */
function classifyProviderResponse(status, bodyText, provider) {
    const s = Number(status);
    const safeBody = bodyText ? sanitizeProviderText(bodyText) : '';

    if (s === 409) {
        // "Duplicate reference": the provider already holds an invoice for this
        // reference. The call created nothing, but an invoice exists - so the local
        // row must stay recoverable (never marked failed) and no automatic retry is
        // offered (a retry would create a SECOND payable invoice with a new
        // reference while the first stays invisible to us).
        return providerError(PAYMENT_ERROR_CODES.PROVIDER_REJECTED, 502, false, true, s, safeBody, provider);
    }
    if (s === 401 || s === 403) {
        return providerError(PAYMENT_ERROR_CODES.PROVIDER_ACCOUNT, 503, false, false, s, safeBody, provider);
    }
    if (s === 429) {
        return providerError(PAYMENT_ERROR_CODES.PROVIDER_UNAVAILABLE, 503, true, false, s, safeBody, provider);
    }
    if (s === 408) {
        return providerError(PAYMENT_ERROR_CODES.PROVIDER_TIMEOUT, 503, true, true, s, safeBody, provider);
    }
    if (Number.isFinite(s) && s >= 500) {
        return providerError(PAYMENT_ERROR_CODES.PROVIDER_UNAVAILABLE, 503, true, true, s, safeBody, provider);
    }
    if (Number.isFinite(s) && s >= 300) {
        // Any other 3xx/4xx: the provider declined this request. A redirect
        // cannot happen (fetch follows them), so this is a refusal.
        return providerError(PAYMENT_ERROR_CODES.PROVIDER_REJECTED, 502, false, false, s, safeBody, provider);
    }
    // Unreachable in practice (2xx is handled by the caller), kept total.
    return providerError(PAYMENT_ERROR_CODES.PROVIDER_INVALID_RESPONSE, 502, true, true, s || null, safeBody, provider);
}

/** A 2xx whose body we cannot use: the invoice may well exist. */
function classifyUnusableResponse(provider, detail) {
    return providerError(
        PAYMENT_ERROR_CODES.PROVIDER_INVALID_RESPONSE,
        502,
        true,
        true,
        200,
        detail || 'missing required invoice fields',
        provider
    );
}

/**
 * Classify a THROWN provider call (network failure, DNS, reset, abort/timeout).
 * Both are ambiguous: the request may have reached the provider before it failed.
 */
function classifyProviderThrow(error, provider) {
    if (error instanceof PaymentError) return error;
    const name = error && error.name ? String(error.name) : '';
    const code = error && error.code ? String(error.code) : '';
    const message = error && error.message ? String(error.message) : '';
    const timeoutish = name === 'AbortError'
        || name === 'TimeoutError'
        || code === 'ETIMEDOUT'
        || code === 'ABORT_ERR'
        || /timed? ?out|aborted/i.test(message);

    if (timeoutish) {
        return providerError(PAYMENT_ERROR_CODES.PROVIDER_TIMEOUT, 503, true, true, null,
            `timeout: ${message}`, provider);
    }
    return providerError(PAYMENT_ERROR_CODES.PROVIDER_UNAVAILABLE, 503, true, true, null,
        `network error: ${message}`, provider);
}

/**
 * The HTTP answer for a failed invoice creation.
 * A non-PaymentError is an unexpected internal failure: 500, retryable, and never
 * treated as a definitive provider refusal (so nothing is marked failed).
 */
function paymentErrorHttpResponse(error) {
    if (error instanceof PaymentError) {
        return {
            status: error.httpStatus,
            body: {
                success: false,
                error: PUBLIC_MESSAGES[error.code] || PUBLIC_MESSAGES[PAYMENT_ERROR_CODES.INTERNAL],
                code: error.code,
                retryable: error.retryable === true
            }
        };
    }
    return {
        status: 500,
        body: {
            success: false,
            error: PUBLIC_MESSAGES[PAYMENT_ERROR_CODES.INTERNAL],
            code: PAYMENT_ERROR_CODES.INTERNAL,
            retryable: true
        }
    };
}

/** True only when the local invoice row may safely be marked failed. */
function isDefinitiveProviderFailure(error) {
    return error instanceof PaymentError && error.ambiguous !== true
        && error.code !== PAYMENT_ERROR_CODES.INTERNAL;
}

module.exports = {
    PAYMENT_ERROR_CODES,
    PUBLIC_MESSAGES,
    PaymentError,
    sanitizeProviderText,
    classifyProviderResponse,
    classifyProviderThrow,
    classifyUnusableResponse,
    paymentErrorHttpResponse,
    isDefinitiveProviderFailure
};
