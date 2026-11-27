'use strict';

/**
 * THE CUSTOMER-FACING MESSAGE FOR EACH INVOICE-CREATION FAILURE.
 *
 * The production incident was not only a wrong HTTP status: the browser turned
 * every 400 into "That amount could not be processed. Check the amount and try
 * again.", so a provider/account problem read as a bad amount. These tests run the
 * REAL `depositInvoiceError()` from public/index.html and pin which message each
 * error class produces, plus the rule that no provider text ever reaches the UI.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/** The source of a top-level `function name(...) { ... }` in the page. */
function extractSource(name) {
    const start = INDEX.indexOf('function ' + name + '(');
    assert.notStrictEqual(start, -1, 'function not found: ' + name);
    let depth = 0;
    let i = INDEX.indexOf('{', start);
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    return INDEX.slice(start, i + 1);
}

/** Compile a page function and return it (no DOM needed for pure helpers). */
function loadFunction(name) {
    const sandbox = {};
    vm.createContext(sandbox);
    const fn = vm.runInContext('(' + extractSource(name) + ')', sandbox);
    assert.strictEqual(typeof fn, 'function');
    return fn;
}

const depositInvoiceError = loadFunction('depositInvoiceError');

function codeOf(err) {
    return {
        messageKey: err.depositMessageKey,
        retryable: err.retryable
    };
}

// ---------------------------------------------------------------------------
// Provider failures never read as "the amount is wrong"
// ---------------------------------------------------------------------------

test('a provider refusal shows the temporary-unavailability message, not "invalid amount"', () => {
    for (const code of ['PAYMENT_PROVIDER_REJECTED', 'PAYMENT_PROVIDER_UNAVAILABLE',
        'PAYMENT_PROVIDER_TIMEOUT', 'PAYMENT_PROVIDER_INVALID_RESPONSE']) {
        const mapped = codeOf(depositInvoiceError(502, { code }));
        assert.strictEqual(mapped.messageKey, 'deposit.errUnavailable', code);
        assert.strictEqual(mapped.retryable, true, code);
    }
});

test('an account/credential problem offers no pointless retry', () => {
    const mapped = codeOf(depositInvoiceError(503, { code: 'PAYMENT_PROVIDER_ACCOUNT' }));
    assert.strictEqual(mapped.messageKey, 'deposit.errUnavailable');
    assert.strictEqual(mapped.retryable, false, 'an operator has to fix a key/account state');
});

test('genuine input errors keep the amount message', () => {
    for (const code of ['PAYMENT_INVALID_AMOUNT', 'PAYMENT_INVALID_CURRENCY', 'PAYMENT_INVALID_NETWORK']) {
        const mapped = codeOf(depositInvoiceError(400, { code }));
        assert.strictEqual(mapped.messageKey, 'deposit.errInvalid', code);
    }
});

test('a 409 duplicate reference shows the honest message and offers no retry', () => {
    // The server sends retryable:false because the provider already holds an invoice
    // under our reference - retrying would create a second payable invoice.
    const mapped = codeOf(depositInvoiceError(502, {
        code: 'PAYMENT_PROVIDER_REJECTED',
        retryable: false,
        error: 'Duplicate reference'
    }));
    assert.strictEqual(mapped.messageKey, 'deposit.errUnavailable');
    assert.strictEqual(mapped.retryable, false);
});

test('an explicit retryable:false from the server always wins', () => {
    assert.strictEqual(codeOf(depositInvoiceError(503, { code: 'PAYMENT_PROVIDER_UNAVAILABLE', retryable: false })).retryable, false);
    assert.strictEqual(codeOf(depositInvoiceError(400, { code: 'PAYMENT_INVALID_NETWORK', retryable: false })).retryable, false);
    // ...and retryable:true can never resurrect a case that must not be retried
    assert.strictEqual(codeOf(depositInvoiceError(401, { retryable: true })).retryable, false);
});

test('the code wins over the status when both are present', () => {
    // A provider refusal answered 502 must not fall through to the generic 5xx path
    // only by luck: the code decides.
    assert.strictEqual(codeOf(depositInvoiceError(502, { code: 'PAYMENT_PROVIDER_REJECTED' })).messageKey, 'deposit.errUnavailable');
    // And a 502 with an unknown code still lands on the honest message via status.
    assert.strictEqual(codeOf(depositInvoiceError(502, { code: 'SOMETHING_NEW' })).messageKey, 'deposit.errUnavailable');
});

// ---------------------------------------------------------------------------
// Status fallback (an older server, or no body at all)
// ---------------------------------------------------------------------------

test('without a body the HTTP status still picks a safe message', () => {
    assert.strictEqual(codeOf(depositInvoiceError(400)).messageKey, 'deposit.errInvalid');
    assert.strictEqual(codeOf(depositInvoiceError(401)).messageKey, 'deposit.errSession');
    assert.strictEqual(codeOf(depositInvoiceError(403)).messageKey, 'deposit.errSession');
    assert.strictEqual(codeOf(depositInvoiceError(403)).retryable, false);
    assert.strictEqual(codeOf(depositInvoiceError(429)).messageKey, 'deposit.errRateLimited');
    assert.strictEqual(codeOf(depositInvoiceError(500)).messageKey, 'deposit.errUnavailable');
    assert.strictEqual(codeOf(depositInvoiceError(502)).messageKey, 'deposit.errUnavailable');
    assert.strictEqual(codeOf(depositInvoiceError(503)).messageKey, 'deposit.errUnavailable');
});

test('a malformed body cannot break the mapping', () => {
    for (const body of [null, undefined, 'text', 42, [], { code: 42 }, { code: null }]) {
        const mapped = codeOf(depositInvoiceError(400, body));
        assert.strictEqual(mapped.messageKey, 'deposit.errInvalid', JSON.stringify(body));
    }
});

// ---------------------------------------------------------------------------
// No provider text anywhere near the UI
// ---------------------------------------------------------------------------

test('the provider body is never used - only its code', () => {
    const err = depositInvoiceError(502, {
        code: 'PAYMENT_PROVIDER_REJECTED',
        error: 'insufficient balance for the reserved fee',
        message: 'q8qpay said: API key live_abcdef123456 is invalid'
    });
    const everything = JSON.stringify({
        message: err.message,
        key: err.depositMessageKey,
        retryable: err.retryable
    });
    assert.ok(!everything.includes('insufficient balance'), everything);
    assert.ok(!everything.includes('live_abcdef123456'), everything);
    assert.ok(!everything.includes('q8qpay said'), everything);
    assert.strictEqual(err.message, 'deposit.errUnavailable', 'the message is the translation KEY');
});

test('the call sites hand the parsed body to the mapper (and never render data.error)', () => {
    const fnStart = INDEX.indexOf('function depositInvoiceError(');
    const requestStart = INDEX.indexOf('async function requestDepositAddress(');
    const body = INDEX.slice(requestStart, fnStart);
    assert.ok(body.includes('depositInvoiceError(response.status, data)'),
        'the failure path passes the parsed body');
    assert.ok(!/depositInvoiceError\(\s*response\.status\s*\)\s*;/.test(body),
        'no call site still maps on the status alone');
    assert.ok(!body.includes('data.error'), 'the server message is never rendered');
    assert.ok(body.includes('await response.json().catch(() => null)'),
        'an unparsable error body must not throw');
});

// ---------------------------------------------------------------------------
// The copy itself
// ---------------------------------------------------------------------------

test('the messages exist in all six locales and are distinct from an amount error', () => {
    for (const key of ['deposit.errUnavailable', 'deposit.errInvalid']) {
        const occurrences = INDEX.split("'" + key + "':").length - 1;
        assert.strictEqual(occurrences, 6, key + ' must be defined in all six locales, found ' + occurrences);
    }
    const enUnavailable = INDEX.match(/'deposit\.errUnavailable':\s*'([^']+)'/)[1];
    assert.ok(/service is temporarily unavailable/i.test(enUnavailable), enUnavailable);
    assert.ok(!/amount/i.test(enUnavailable), 'the provider message must not mention the amount');
});

test('the retry button is hidden exactly when no retry can help', () => {
    const retry = { style: {} };
    const sandbox = {
        document: {
            getElementById(id) {
                if (id === 'depositInvoiceError') return { classList: { add() {} } };
                if (id === 'depositInvoiceErrorText') return { textContent: '' };
                if (id === 'depositRetryBtn') return retry;
                return null;
            }
        },
        t: (k) => k
    };
    vm.createContext(sandbox);
    const show = vm.runInContext('(' + extractSource('showDepositInvoiceError') + ')', sandbox);

    show(depositInvoiceError(503, { code: 'PAYMENT_PROVIDER_ACCOUNT' }));
    assert.strictEqual(retry.style.display, 'none', 'no pointless retry for an account problem');

    retry.style.display = 'unchanged';
    show(depositInvoiceError(502, { code: 'PAYMENT_PROVIDER_REJECTED' }));
    assert.notStrictEqual(retry.style.display, 'none', 'a provider blip is retryable');
});
