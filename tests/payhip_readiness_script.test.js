'use strict';

/**
 * The Payhip readiness probe must be honest and safe:
 *   - it must never print a secret;
 *   - its verdict mapping must match what the server actually answers;
 *   - its webhook probe must be a refused delivery (empty body, no token), so
 *     running it can never record a purchase.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-payhip-readiness.js');
const {
  interpretWebhookProbe, envReport, verdict, buildReport, render
} = require(SCRIPT);

const SECRETS = {
  // Synthetic values built from repeated letters - never a real credential, and
  // shaped so no secret scanner mistakes the fixture for one.
  PAYHIP_API_KEY: 'test-api-key-' + 'A'.repeat(24),
  PAYHIP_PRODUCT_SECRET: 'test-product-secret-' + 'B'.repeat(24),
  PAYHIP_WEBHOOK_TOKEN: 'test-webhook-token-' + 'C'.repeat(24)
};

test('a 404 means the route is not in the running build', () => {
  const v = interpretWebhookProbe(404, { success: false, error: 'Not found' });
  assert.strictEqual(v.state, 'not-deployed');
  assert.match(v.detail, /does not exist/);
  assert.match(v.action, /deploy/);
});

test('a 503 names the missing configuration and the variable to set', () => {
  const cases = {
    disabled: /PAYHIP_ENABLED/,
    'no-products-configured': /PAYHIP_PRODUCTS=dLXuU/,
    'missing-api-key': /PAYHIP_API_KEY/,
    'missing-webhook-token': /PAYHIP_WEBHOOK_TOKEN/,
    'weak-webhook-token': /16 chars/
  };
  for (const [reason, expected] of Object.entries(cases)) {
    const v = interpretWebhookProbe(503, { ok: false, error: 'payhip-not-configured', reason });
    assert.strictEqual(v.state, 'deployed-not-configured', reason);
    assert.match(v.action, expected, reason);
  }
});

test('a 401 means the route is live and the registered URL must carry the token', () => {
  const v = interpretWebhookProbe(401, { ok: false, error: 'invalid_token' });
  assert.strictEqual(v.state, 'deployed-token-mismatch');
  assert.match(v.action, /\?token=/);
});

test('an accepted unauthenticated delivery is treated as unsafe', () => {
  assert.strictEqual(interpretWebhookProbe(200, { ok: true }).state, 'unexpected-accept');
  assert.strictEqual(interpretWebhookProbe(500, {}).state, 'unexpected');
});

test('the environment report never contains a secret value', () => {
  const report = envReport({ ...SECRETS, PAYHIP_ENABLED: 'true', PAYHIP_PRODUCTS: 'dLXuU' });
  const serialised = JSON.stringify(report) + render({ env: report, probe: null, verdict: { code: 0, text: 'x' } });
  for (const value of Object.values(SECRETS)) {
    assert.ok(!serialised.includes(value), 'a secret value leaked into the report');
  }
  assert.deepStrictEqual(report.present, {
    PAYHIP_ENABLED: true,
    PAYHIP_API_KEY: true,
    PAYHIP_PRODUCTS: true,
    PAYHIP_PRODUCT_SECRET: true,
    PAYHIP_PRODUCT_SECRETS: false,
    PAYHIP_STORE_URL: false,
    PAYHIP_WEBHOOK_TOKEN: true,
    PAYHIP_ACTIVATION_REQUIRED: false
  });
  // Product codes are public (they are in the buy URL) and are reported.
  assert.deepStrictEqual(report.productCodes, ['dlxuu']);
});

test('verdict: not deployed, not enabled, half configured, ready', () => {
  const deployed = { webhookVerdict: { state: 'deployed-token-mismatch' } };
  assert.strictEqual(verdict({}, { webhookVerdict: { state: 'not-deployed' } }).code, 2);
  assert.strictEqual(verdict({}, deployed).code, 3);
  assert.strictEqual(verdict({}, { webhookVerdict: { state: 'unexpected-accept' } }).code, 3);

  const enabledNoProducts = { PAYHIP_ENABLED: 'true' };
  assert.match(verdict(enabledNoProducts, deployed).text, /no-products-configured/);

  const noSecret = {
    PAYHIP_ENABLED: 'true',
    PAYHIP_PRODUCTS: 'dLXuU',
    PAYHIP_API_KEY: SECRETS.PAYHIP_API_KEY,
    PAYHIP_WEBHOOK_TOKEN: SECRETS.PAYHIP_WEBHOOK_TOKEN
  };
  assert.match(verdict(noSecret, deployed).text, /REDEMPTION NOT USABLE/);

  const ready = { ...noSecret, PAYHIP_PRODUCT_SECRET: SECRETS.PAYHIP_PRODUCT_SECRET, PAYHIP_ACTIVATION_REQUIRED: 'true' };
  assert.strictEqual(verdict(ready, deployed).code, 0);
});

test('the webhook probe is an empty POST with no credentials', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, method: (options && options.method) || 'GET', headers: (options && options.headers) || {}, body: options && options.body });
    if (url.endsWith('/api/health')) return { status: 200, json: async () => ({ status: 'ok' }) };
    if (url.endsWith('/api/live/activation')) return { status: 401, json: async () => ({ error: 'Unauthorized' }) };
    return { status: 503, json: async () => ({ ok: false, error: 'payhip-not-configured', reason: 'disabled' }) };
  };
  const report = await buildReport({ env: SECRETS, probe: { base: 'https://example.test' }, fetchImpl: fakeFetch });

  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'the probe must exercise the webhook');
  assert.strictEqual(post.url, 'https://example.test/api/payhip/webhook');
  assert.strictEqual(post.body, '{}', 'the probe body must be empty - it can never record a purchase');
  const headerNames = Object.keys(post.headers).map((h) => h.toLowerCase());
  assert.ok(!headerNames.includes('authorization'), 'the probe must not send credentials');
  assert.ok(!headerNames.includes('x-payhip-token'), 'the probe must not send a token');
  assert.strictEqual(report.probe.webhookVerdict.state, 'deployed-not-configured');
  assert.strictEqual(report.verdict.code, 3);
});

test('the script reads configuration from the real resolver and writes nothing', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /require\('\.\.\/services\/PayhipEntitlements'\)/, 'must reuse the real config resolver');
  assert.match(src, /if \(require\.main === module\)/, 'must be importable for tests');
  assert.ok(!/writeFile|appendFile|mkdir|unlink/.test(src), 'a readiness probe must not write to disk');
  assert.ok(!/console\.log\(process\.env/.test(src), 'must never dump the environment');
  assert.match(src, /Exit codes: 0 ready, 2 not deployed/);
});
