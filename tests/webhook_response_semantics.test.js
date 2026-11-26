'use strict';
/**
 * Webhook routing + HTTP response semantics (H1, H2).
 *
 * H1 ROOT CAUSE: `app.post('/api/webhook/:provider')` is registered BEFORE the
 * dedicated `/api/webhook/paymento` route and only called next() for q8qpay, so
 * every genuine Paymento IPN was consumed by the generic handler. That handler
 * reads x-signature / x-signature-256, while Paymento sends
 * X-HMAC-SHA256-SIGNATURE, so paymentoProvider.verifyWebhook() correctly failed
 * closed and the IPN was answered 200 - never credited, never retried.
 *
 * H2 ROOT CAUSE: every failure path answered 200 (success:false or
 * {error:'Processing error'}), so providers had no reason to retry a transient
 * database failure.
 *
 * These tests pin the routing contract and execute the real classifier.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function block(startMarker, endMarker) {
  const at = SERVER.indexOf(startMarker);
  assert.ok(at > 0, 'missing: ' + startMarker);
  const end = SERVER.indexOf(endMarker, at + startMarker.length);
  assert.ok(end > at, 'unbounded: ' + startMarker);
  return SERVER.slice(at, end);
}

function fnSource(name) {
  const at = SERVER.indexOf('function ' + name);
  assert.ok(at > 0, name + ' must exist');
  let depth = 0;
  let started = false;
  for (let i = at; i < SERVER.length; i++) {
    if (SERVER[i] === '{') { depth++; started = true; }
    else if (SERVER[i] === '}' && --depth === 0 && started) return SERVER.slice(at, i + 1);
  }
  throw new Error('unterminated ' + name);
}

const GENERIC = block("app.post('/api/webhook/:provider'", 'app.post(');
const NOWPAY = block("app.post('/api/webhook/nowpayments'", "app.post('/api/webhook/:provider'");
const PAYMENTO = block("app.post('/api/webhook/paymento'", "app.post('/api/webhook/q8qpay'");
const Q8QPAY = block("app.post('/api/webhook/q8qpay'", "app.get('/api/q8qpay/");

// ---------------------------------------------------------------------------
// H1 - routing precedence
// ---------------------------------------------------------------------------
test('H1: the generic handler delegates Paymento and q8qpay to their own routes', () => {
  assert.match(GENERIC, /if \(provider === 'q8qpay' \|\| provider === 'paymento'\) return next\(\);/,
    'both dedicated providers must fall through');
  // Ordering is the whole bug: the generic route must be declared first and the
  // dedicated routes after it, so next() reaches them.
  const genericAt = SERVER.indexOf("app.post('/api/webhook/:provider'");
  const paymentoAt = SERVER.indexOf("app.post('/api/webhook/paymento'");
  const q8At = SERVER.indexOf("app.post('/api/webhook/q8qpay'");
  assert.ok(genericAt < paymentoAt && genericAt < q8At, 'dedicated routes are registered after the generic one');
});

test('H1: each route reads the signature header its provider actually sends', () => {
  assert.match(PAYMENTO, /req\.headers\['x-hmac-sha256-signature'\]/, 'paymento IPN header');
  assert.match(Q8QPAY, /req\.headers\['x-webhook-signature'\]/, 'q8qpay header');
  assert.match(NOWPAY, /req\.headers\['x-signature'\]/, 'nowpayments header');
  const genericHeaderLine = GENERIC.split('\n').find((l) => l.includes('const signature ='));
  assert.match(genericHeaderLine, /x-signature'\] \|\| req\.headers\['x-signature-256'\]/,
    'the generic path accepts either documented header for other providers');
  // The mismatch that caused the defect must not come back: Paymento's header is
  // never the one the generic handler looks for.
  assert.ok(!/'x-hmac-sha256-signature'/.test(GENERIC), 'the generic handler must not guess Paymento headers');
});

test('H1: raw bytes are preserved for HMAC verification', () => {
  assert.match(PAYMENTO, /express\.raw\(\{ type: 'application\/json' \}\)/, 'raw body middleware on the route');
  // Paymento: express.raw() on the route means req.body IS the raw Buffer.
  assert.match(PAYMENTO, /const rawBody = req\.body;/, 'paymento verifies the raw Buffer body');
  // q8qpay: no route-level raw parser, so it uses the bytes the global verify hook captured.
  assert.match(Q8QPAY, /req\.rawBody/, 'q8qpay verifies the captured raw bytes');
  // No handler may re-serialise a parsed object before verification.
  assert.ok(!/verifyWebhook\(JSON\.stringify/.test(SERVER), 'never verify a re-serialised payload');
});

test('H1: genuine Paymento requests reach the existing processing path', () => {
  assert.match(PAYMENTO, /paymentoProvider\.verifyWebhook\(rawBody, signature\)/, 'existing verification reused');
  assert.match(PAYMENTO, /paymento_credit_user_safe|creditPaymento|paymentoCredit/, 'reaches the credit path');
  assert.match(PAYMENTO, /status\(401\)\.json\(\{ error: 'Missing signature' \}\)/, 'missing signature is a 401 before processing');
  assert.match(PAYMENTO, /Invalid HMAC signature/, 'invalid signature is rejected before processing');
  // No duplicated processing logic: only one place consumes Paymento IPNs.
  assert.strictEqual((SERVER.match(/paymentoProvider\.verifyWebhook/g) || []).length, 1,
    'a single Paymento verification site');
});

// ---------------------------------------------------------------------------
// H2 - response semantics
// ---------------------------------------------------------------------------
test('H2: no webhook handler acknowledges a failure with 200', () => {
  // Scope: the failure path of each handler. A 200 on a *handled* outcome
  // (duplicate, unknown invoice that a retry cannot fix) stays legitimate.
  const catchBlocks = {
    NOWPAY: NOWPAY.slice(NOWPAY.indexOf('} catch (error)')),
    PAYMENTO: PAYMENTO.slice(PAYMENTO.lastIndexOf('} catch (error)')),
    Q8QPAY: Q8QPAY.slice(Q8QPAY.lastIndexOf('} catch (error)')),
    GENERIC: GENERIC.slice(GENERIC.lastIndexOf('} catch (error)')),
  };
  for (const [name, src] of Object.entries(catchBlocks)) {
    assert.ok(!/status\(200\)/.test(src), name + ': the catch block never answers 200');
  }
  for (const [name, src] of Object.entries({ NOWPAY, GENERIC, PAYMENTO, Q8QPAY })) {
    assert.ok(!/Processing error/.test(src), name + ': the old 200-on-error body is gone');
  }
  // Every catch hands off to the classifier, which only returns 4xx/5xx.
  assert.match(NOWPAY, /catch \(error\) \{\s*\n\s*return webhookFailureResponse\(res, error, 'nowpayments'\)/);
  assert.match(GENERIC, /catch \(error\) \{\s*\n\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*return webhookFailureResponse\(res, error, provider\)/);
  assert.match(PAYMENTO, /return webhookFailureResponse\(res, error, 'paymento'\)/);
  assert.match(Q8QPAY, /return webhookFailureResponse\(res, error, 'q8qpay'\)/);
});

test('H2: a database credit failure is a 5xx everywhere', () => {
  const occurrences = SERVER.match(/res\.status\(200\)\.json\(\{ error: 'Credit failed' \}\)/g) || [];
  assert.strictEqual(occurrences.length, 0, 'the acknowledged credit failure is gone');
  const converted = SERVER.match(/res\.status\(500\)\.json\(\{ ok: false, error: 'processing_error' \}\)/g) || [];
  assert.ok(converted.length >= 3, 'each credit-failure branch now answers 500');
});

test('H2: duplicates and validation outcomes still answer 200', () => {
  // Replay safety: an already-credited invoice is a successful no-op, not a fault.
  // (A durable record is written between the check and the response now, so the
  // two statements are asserted separately rather than as one adjacent pair.)
  assert.match(Q8QPAY, /if \(invoice\.credited\) \{/);
  assert.match(Q8QPAY, /message: 'Already processed'/);
  // The wording moved into the shared outcome table with the rest of the policy.
  const SETTLEMENT_SRC = fs.readFileSync(path.join(ROOT, 'services/q8qpaySettlement.js'), 'utf8');
  assert.match(SETTLEMENT_SRC, /Duplicate payment \(not re-credited\)/);
  assert.match(Q8QPAY, /outcome\.code === 'already_credited' \|\| outcome\.code === 'duplicate'/);
  assert.match(PAYMENTO, /Duplicate payment/);

  // The response code is no longer decided inline: every outcome declares its own
  // policy, and the route answers `outcome.httpStatus`. Executing the real table is
  // a stronger pin than a regex on one branch.
  const { OUTCOMES } = require('../services/q8qpaySettlement');
  const byCode = (code) => Object.values(OUTCOMES).find((o) => o.code === code);
  for (const code of ['credited', 'already_credited', 'duplicate', 'unknown_invoice', 'reference_mismatch',
    'asset_mismatch', 'amount_mismatch', 'address_mismatch', 'missing_stored_amount']) {
    assert.strictEqual(byCode(code).httpStatus, 200, code + ' is a handled outcome: 200, no retry storm');
  }
  // Transient states must NOT be acknowledged, or the provider never retries.
  for (const code of ['provider_not_confirmed', 'verify_failed', 'missing_tx_hash', 'credit_failed']) {
    assert.strictEqual(byCode(code).httpStatus, 500, code + ' is retryable: 5xx');
    assert.strictEqual(byCode(code).transient, true, code + ' is declared retryable');
  }
  // Everything that is neither credited nor retryable must need a human.
  for (const code of ['unknown_invoice', 'reference_mismatch', 'asset_mismatch', 'amount_mismatch',
    'address_mismatch', 'missing_stored_amount', 'missing_tx_hash', 'credit_failed', 'verify_failed']) {
    assert.strictEqual(byCode(code).needsReview, true, code + ' leaves a durable review record');
  }
  assert.match(Q8QPAY, /res\.status\(outcome\.httpStatus\)/, 'the route answers the classified status');
});

test('H2: database idempotency remains the authoritative replay protection', () => {
  assert.match(Q8QPAY, /credit_payment_safe/, 'q8qpay still credits through the atomic RPC');
  assert.match(PAYMENTO, /paymento_credit_user_safe|creditPaymento/, 'paymento keeps its own atomic credit');
  // The in-memory set is a fast path, never the guarantee.
  const service = fs.readFileSync(path.join(ROOT, 'services/PaymentService.js'), 'utf8');
  assert.match(service, /processedWebhooks/, 'in-memory duplicate tracking still exists');
  assert.match(service, /generateWebhookIdempotencyKey/, 'and its key derivation');
});

// ---------------------------------------------------------------------------
// The classifyer, executed for real
// ---------------------------------------------------------------------------
function loadHelpers() {
  const sandbox = {
    console: { error() {} },
    Buffer,
    SyntaxError,
    res: null,
    JSON,
    String,
    RegExp,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fnSource('webhookFailureResponse') + '\n' + fnSource('parseWebhookBody'), ctx);
  return ctx;
}

function callClassifier(ctx, err) {
  let captured = null;
  ctx.res = {
    status(code) {
      captured = { code };
      return { json(body) { captured.body = body; return captured; } };
    },
  };
  ctx.webhookFailureResponse(ctx.res, err, 'test-provider');
  return captured;
}

test('H2: signature failures classify as 401', () => {
  const ctx = loadHelpers();
  for (const msg of ['Invalid webhook signature', 'Missing signature', 'invalid signature header']) {
    const out = callClassifier(ctx, new Error(msg));
    assert.strictEqual(out.code, 401, msg);
    assert.strictEqual(out.body.error, 'invalid_signature');
  }
});

test('H2: unknown provider classifies as 404', () => {
  const ctx = loadHelpers();
  const out = callClassifier(ctx, new Error('Unknown provider: bogus'));
  assert.strictEqual(out.code, 404);
  assert.strictEqual(out.body.error, 'unknown_provider');
});

test('H2: malformed payload classifies as 400', () => {
  const ctx = loadHelpers();
  let jsonErr;
  try { JSON.parse('{nope'); } catch (e) { jsonErr = e; }
  const out = callClassifier(ctx, jsonErr);
  assert.strictEqual(out.code, 400);
  assert.strictEqual(out.body.error, 'malformed_payload');
});

test('H2: any other failure classifies as 500 and leaks nothing', () => {
  const ctx = loadHelpers();
  const out = callClassifier(ctx, new Error('connection refused to db host internal-1'));
  assert.strictEqual(out.code, 500);
  assert.strictEqual(out.body.error, 'processing_error');
  assert.ok(!JSON.stringify(out.body).includes('internal-1'), 'the internal message is not echoed');
  assert.ok(!('stack' in out.body), 'no stack trace');
});

test('H2: raw bodies parse from Buffer, string and object; empty throws SyntaxError', () => {
  const ctx = loadHelpers();
  ctx.__b = Buffer.from('{"a":1}');
  assert.deepStrictEqual(vm.runInContext('parseWebhookBody(__b)', ctx), { a: 1 });
  ctx.__s = '{"b":2}';
  assert.deepStrictEqual(vm.runInContext('parseWebhookBody(__s)', ctx), { b: 2 });
  ctx.__o = { c: 3 };
  assert.deepStrictEqual(vm.runInContext('parseWebhookBody(__o)', ctx), { c: 3 });
  ctx.__none = undefined;
  assert.throws(() => vm.runInContext('parseWebhookBody(__none)', ctx), /Empty webhook body/);
});
