'use strict';

/**
 * Behavioural HTTP tests for the Payhip activation rail (H1 + H4).
 *
 * Every case below boots the REAL server and calls the REAL routes; only the
 * database and Payhip's licence API are substituted
 * (tests/helpers/fake-supabase-payhip.js). Nothing here is a source-string
 * assertion and no request leaves the machine.
 *
 * What the suite proves:
 *   - webhook authentication is enforced and CONFIGURED consistently: a missing
 *     token makes the integration report itself unusable instead of accepting
 *     deliveries into a 401 (H1);
 *   - a webhook alone can never grant an activation (it is a trigger; the
 *     licence is verified again at redemption);
 *   - redemption handles valid / invalid / wrong-product / disabled / claimed /
 *     reused licences correctly, fails closed on a Payhip or database outage,
 *     and binds the account from the JWT only;
 *   - a licence for another product is indistinguishable from an invalid one (M4);
 *   - payhip_products.is_active gates the purchase offer (M3);
 *   - no Payhip path touches a wallet or credits money.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-payhip.js');
const JWT_SECRET = 'payhip-http-test-secret';
const API_KEY = 'pk_test_payhip_http';
const TOKEN = 'webhook-token-0123456789abcdef';
const PRODUCT = 'mVT0';
const SCENARIO = path.join(os.tmpdir(), 'payhip-scenario-' + process.pid + '.json');
const RPC_LOG = path.join(os.tmpdir(), 'payhip-rpc-' + process.pid + '.jsonl');

/** Every RPC payload the server actually sent, as { rpc, payload }. */
function rpcCalls() {
  try {
    return fs.readFileSync(RPC_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { return []; }
}


const signature = crypto.createHash('sha256').update(API_KEY).digest('hex');

function setScenario(s) { fs.writeFileSync(SCENARIO, JSON.stringify(s || {})); }

function token(extra) {
  return jwt.sign(Object.assign({ id: 7, email: 'buyer@example.test' }, extra || {}), JWT_SECRET, { expiresIn: '1h' });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function boot(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      JWT_SECRET,
      BASE_URL: 'http://127.0.0.1:' + port,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_SUPPORT_CHAT_ID: '',
      TELEGRAM_ADMIN_IDS: '',
      PAYHIP_SCENARIO_FILE: SCENARIO,
      PAYHIP_RPC_LOG: RPC_LOG,
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
    }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server exited: ' + output.slice(-1200));
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* booting */ }
    if (Date.now() > deadline) throw new Error('server never became healthy: ' + output.slice(-1200));
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    output: () => output,
    stop: () => { if (child.exitCode === null) child.kill('SIGTERM'); }
  };
}

const FULL_ENV = {
  PAYHIP_ENABLED: 'true',
  PAYHIP_ACTIVATION_REQUIRED: 'true',
  PAYHIP_PRODUCTS: PRODUCT,
  PAYHIP_API_KEY: API_KEY,
  PAYHIP_WEBHOOK_TOKEN: TOKEN,
  PAYHIP_PRODUCT_SECRET: 'sk_test_payhip_http',
  PAYHIP_STORE_URL: 'https://payhip.com/b/mVT0',
  PAYHIP_RETURN_URL: 'https://example.test/'
};

let server = null;

test.before(async () => {
  setScenario({});
  server = await boot(FULL_ENV);
});

test.after(() => { if (server) server.stop(); });

async function call(method, route, body, opts) {
  const o = opts || {};
  const headers = {};
  if (o.auth !== false) headers.Authorization = 'Bearer ' + (o.token || token());
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(server.base + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json, text: JSON.stringify(json) };
}

// Each redemption case uses its OWN account: the redeem route rate-limits per
// user (10/minute), and sharing one id would make the suite test the throttle
// instead of the licence logic.
let uid = 100;
const nextUser = () => uid++;
const redeem = (key, opts) => {
  const o = Object.assign({}, opts || {});
  if (!o.token) o.token = token({ id: o.uid || nextUser() });
  return call('POST', '/api/live/activate', { licenceKey: key }, o);
};
const webhook = (payload, query) => call('POST', '/api/payhip/webhook' + (query === undefined ? '?token=' + TOKEN : query), payload, { auth: false });

const VALID_LICENCE = { enabled: true, product_link: PRODUCT, uses: 0, buyer_email: 'buyer@example.test' };

// ---------------------------------------------------------------------------
// 1. Redemption
// ---------------------------------------------------------------------------

test('redemption: a valid licence activates the account', async () => {
  setScenario({ activation: true, verifyBody: VALID_LICENCE, rpcResult: { success: true, duplicate: false }, products: [{ product_key: PRODUCT, is_active: true }] });
  const res = await redeem('VALID-KEY-1');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.activated, true);
  assert.strictEqual(res.body.alreadyClaimed, false);
});

test('redemption: an invalid licence answers 404 without confirming anything', async () => {
  setScenario({ activation: false, verifyHttp: 404 });
  const res = await redeem('NOT-A-KEY');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.reason, 'invalid-licence');
  assert.strictEqual(res.body.success, false);
});

test('redemption: a refunded/disabled licence is refused', async () => {
  setScenario({ activation: false, verifyBody: Object.assign({}, VALID_LICENCE, { enabled: false }), products: [{ product_key: PRODUCT, is_active: true }] });
  const res = await redeem('REFUNDED-KEY');
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.reason, 'licence-disabled');
});

test('M4: a licence for ANOTHER product is indistinguishable from an invalid one', async () => {
  setScenario({ activation: false, verifyBody: Object.assign({}, VALID_LICENCE, { product_link: 'OTHER9' }), products: [{ product_key: PRODUCT, is_active: true }] });
  const wrongProduct = await redeem('OTHER-PRODUCT-KEY');
  setScenario({ activation: false, verifyHttp: 404 });
  const invalid = await redeem('NOT-A-KEY');
  assert.strictEqual(wrongProduct.status, invalid.status, 'same HTTP status');
  assert.deepStrictEqual(wrongProduct.body, invalid.body, 'the response must not reveal that the key exists');
  assert.strictEqual(wrongProduct.body.reason, 'invalid-licence');
});

test('redemption: a licence claimed by another account is refused', async () => {
  setScenario({ activation: false, verifyBody: VALID_LICENCE, rpcResult: { success: false, reason: 'claimed_by_other_account' }, products: [{ product_key: PRODUCT, is_active: true }] });
  const res = await redeem('SOMEONE-ELSES-KEY');
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.reason, 'claimed_by_other_account');
});

test('redemption: replaying the same licence is idempotent (alreadyClaimed)', async () => {
  setScenario({ activation: true, verifyBody: VALID_LICENCE, rpcResult: { success: true, duplicate: true }, products: [{ product_key: PRODUCT, is_active: true }] });
  const res = await redeem('VALID-KEY-1');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.alreadyClaimed, true);
});

test('redemption: a licence whose purchase is no longer active is refused', async () => {
  setScenario({ activation: false, verifyBody: VALID_LICENCE, rpcResult: { success: false, reason: 'purchase_not_active' }, products: [{ product_key: PRODUCT, is_active: true }] });
  const res = await redeem('REVOKED-PURCHASE-KEY');
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.reason, 'purchase_not_active');
});

test('redemption: a database outage fails closed (503, retryable)', async () => {
  setScenario({ activation: false, verifyBody: VALID_LICENCE, rpcError: true });
  const res = await redeem('VALID-KEY-2');
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.body.reason, 'unavailable');
});

test('redemption: a Payhip outage fails closed (503, retryable)', async () => {
  setScenario({ activation: false, verifyHttp: 500 });
  const res = await redeem('VALID-KEY-3');
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.body.reason, 'unavailable');
});

test('redemption: a missing licence key is a 400, not a grant', async () => {
  setScenario({ activation: false });
  const res = await call('POST', '/api/live/activate', {});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'LICENCE_REQUIRED');
});

test('redemption: requires authentication', async () => {
  setScenario({ activation: false });
  const res = await redeem('VALID-KEY-1', { auth: false });
  assert.strictEqual(res.status, 401);
});

test('redemption: the account comes from the JWT, never from the body (IDOR)', async () => {
  setScenario({ activation: true, verifyBody: VALID_LICENCE, rpcResult: { success: true }, products: [{ product_key: PRODUCT, is_active: true }] });
  const idorUser = nextUser();
  const res = await call('POST', '/api/live/activate', { licenceKey: 'VALID-KEY-4', userId: 999, user_id: 999 },
    { token: token({ id: idorUser }) });
  assert.strictEqual(res.status, 200, res.text);

  // The harness records every RPC payload the server sent. The redeem RPC must
  // carry the JWT's user id (7) and must never carry the body's 999.
  let redeemCall = null;
  for (let i = 0; i < 40 && !redeemCall; i++) {
    redeemCall = rpcCalls().filter((c) => c.rpc === 'redeem_payhip_entitlement_safe').pop() || null;
    if (!redeemCall) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(redeemCall, 'the redeem RPC must have been called');
  assert.strictEqual(redeemCall.payload.p_user_id, idorUser, 'the account comes from the JWT');
  assert.ok(!JSON.stringify(redeemCall.payload).includes('999'), 'a client-supplied userId must never reach the RPC');
  assert.ok(!('userId' in redeemCall.payload) && !('user_id' in redeemCall.payload), 'no client identity field is forwarded');
});

test('redemption: repeated attempts from one account are throttled (429)', async () => {
  setScenario({ activation: false, verifyHttp: 404 });
  const sameUser = nextUser();
  const statuses = [];
  for (let i = 0; i < 13; i++) {
    const res = await redeem('GUESS-' + i, { token: token({ id: sameUser }) });
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), 'brute-forcing licence keys must be rate limited: ' + statuses.join(','));
  assert.ok(statuses.indexOf(429) >= 10, 'the first ten attempts are allowed');
});

// ---------------------------------------------------------------------------
// 2. Webhook authentication (H1)
// ---------------------------------------------------------------------------

function salePayload(extra) {
  return Object.assign({
    id: 'SALE-1001',
    type: 'paid',
    email: 'buyer@example.test',
    currency: 'USD',
    price: 5000,
    items: [{
      product_id: '2804256',
      product_permalink: 'https://payhip.com/b/' + PRODUCT,
      product_name: 'Kalderix Live Activation',
      license_key: 'VALID-KEY-5'
    }],
    signature
  }, extra || {});
}

test('webhook: a correctly authenticated delivery is recorded', async () => {
  setScenario({ activation: false, verifyBody: VALID_LICENCE, rpcResult: { success: true }, products: [{ product_key: PRODUCT, is_active: true }] });
  const res = await webhook(salePayload());
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.outcome, 'recorded');
});

test('webhook: a missing token is rejected', async () => {
  setScenario({ activation: false, verifyBody: VALID_LICENCE });
  const res = await webhook(salePayload(), '');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'invalid_token');
});

test('webhook: a wrong token is rejected', async () => {
  setScenario({ activation: false, verifyBody: VALID_LICENCE });
  const res = await webhook(salePayload(), '?token=not-the-configured-token');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'invalid_token');
});

test('webhook: a valid token but a bad signature is rejected', async () => {
  setScenario({ activation: false, verifyBody: VALID_LICENCE });
  const res = await webhook(salePayload({ signature: 'deadbeef' }));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'invalid_signature');
});

test('webhook: a refunded sale is acknowledged through the revoke path', async () => {
  setScenario({ activation: false, verifyBody: VALID_LICENCE, rpcResult: { success: true } });
  const res = await webhook(salePayload({ id: 'SALE-1002', type: 'refunded' }));
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.ok, true);
});

test('a webhook ALONE never grants an activation', async () => {
  setScenario({ activation: false, verifyBody: VALID_LICENCE, rpcResult: { success: true }, products: [{ product_key: PRODUCT, is_active: true }] });
  const hook = await webhook(salePayload({ id: 'SALE-1003' }));
  assert.strictEqual(hook.status, 200);
  const state = await call('GET', '/api/live/activation');
  assert.strictEqual(state.status, 200);
  assert.strictEqual(state.body.activated, false, 'the webhook must not activate the account');
});

// ---------------------------------------------------------------------------
// 3. Purchase offer gating (M3) and admin visibility
// ---------------------------------------------------------------------------

test('M3: the purchase offer follows payhip_products.is_active', async () => {
  setScenario({ activation: false, products: [{ product_key: PRODUCT, is_active: false }] });
  const off = await call('GET', '/api/live/activation');
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.purchase.available, false, 'an inactive product must not be offered');
  assert.strictEqual(off.body.purchase.onSale, false);

  setScenario({ activation: false, products: [{ product_key: PRODUCT, is_active: true }] });
  const on = await call('GET', '/api/live/activation');
  assert.strictEqual(on.body.purchase.available, true, 'an active product is offered');
  assert.strictEqual(on.body.purchase.onSale, true);
});

test('M3: an unreadable catalogue fails closed for the offer', async () => {
  setScenario({ activation: false, productsError: true });
  const res = await call('GET', '/api/live/activation');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.purchase.available, false);
  assert.strictEqual(res.body.purchase.onSaleReason, 'catalogue-unreadable');
});

test('admin status: requires an admin and reports the wiring', async () => {
  setScenario({ activation: false, isAdmin: false, products: [{ product_key: PRODUCT, is_active: true }] });
  const denied = await call('GET', '/api/admin/payhip/status');
  assert.strictEqual(denied.status, 403);

  setScenario({ activation: false, isAdmin: true, products: [{ product_key: PRODUCT, is_active: true }] });
  const ok = await call('GET', '/api/admin/payhip/status', undefined, { token: token({ isAdmin: true }) });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ok.body.payhip.usable, true);
  assert.strictEqual(ok.body.payhip.webhookUsable, true);
  assert.strictEqual(ok.body.payhip.webhookTokenValid, true);
  assert.strictEqual(ok.body.products.onSale, true);
  assert.ok(!JSON.stringify(ok.body).includes(TOKEN), 'the status surface must never echo the token');
});

test('M3: /api/auth/me hides the purchase button for an inactive product', async () => {
  // The dashboard button reads activationPurchasable from /api/auth/me, so the
  // catalogue flag has to reach BOTH surfaces - otherwise flipping is_active
  // would hide the modal's button but leave the dashboard one clickable.
  setScenario({ activation: false, products: [{ product_key: PRODUCT, is_active: false }] });
  const meOff = await call('GET', '/api/auth/me');
  assert.strictEqual(meOff.status, 200, meOff.text);
  assert.strictEqual(meOff.body.activationPurchasable, false);

  setScenario({ activation: false, products: [{ product_key: PRODUCT, is_active: true }] });
  const meOn = await call('GET', '/api/auth/me');
  assert.strictEqual(meOn.body.activationPurchasable, true);

  setScenario({ activation: false, productsError: true });
  const meErr = await call('GET', '/api/auth/me');
  assert.strictEqual(meErr.body.activationPurchasable, false, 'an unreadable catalogue fails closed');
});

// ---------------------------------------------------------------------------
// 4. No money moves anywhere on the Payhip rail
// ---------------------------------------------------------------------------

test('no Payhip route writes a wallet or calls a money RPC', async () => {
  setScenario({ activation: true, verifyBody: VALID_LICENCE, rpcResult: { success: true }, products: [{ product_key: PRODUCT, is_active: true }] });
  const before = server.output().length;
  await redeem('VALID-KEY-6');
  await webhook(salePayload({ id: 'SALE-1004' }));
  const seen = server.output().slice(before);
  assert.ok(!/PATCH \/rest\/v1\/wallets|POST \/rest\/v1\/wallets/.test(seen), 'no wallet write');
  assert.ok(!/credit_payment_safe|record_trade_safe|charge_subscription_safe|confirm_legacy_deposit_safe/.test(seen), 'no money RPC');
});

// ---------------------------------------------------------------------------
// 5. Incomplete configuration (H1) - a separate boot, because env is per process
// ---------------------------------------------------------------------------

test('H1: enabled WITHOUT a webhook token reports unusable and refuses deliveries', async () => {
  const env = Object.assign({}, FULL_ENV);
  delete env.PAYHIP_WEBHOOK_TOKEN;
  const s = await boot(env);
  try {
    setScenario({ activation: false, isAdmin: true, verifyBody: VALID_LICENCE, products: [{ product_key: PRODUCT, is_active: true }] });

    const hook = await fetch(s.base + '/api/payhip/webhook?token=' + TOKEN, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(salePayload())
    });
    const hookBody = await hook.json();
    assert.strictEqual(hook.status, 503, 'an unconfigured rail must refuse, not accept');
    assert.strictEqual(hookBody.error, 'payhip-not-configured');
    assert.strictEqual(hookBody.reason, 'missing-webhook-token');

    const status = await fetch(s.base + '/api/admin/payhip/status', {
      headers: { Authorization: 'Bearer ' + token({ isAdmin: true }) }
    }).then((r) => r.json());
    assert.strictEqual(status.payhip.usable, false);
    assert.strictEqual(status.payhip.webhookUsable, false);
    assert.strictEqual(status.payhip.reason, 'missing-webhook-token');

    const activation = await fetch(s.base + '/api/live/activation', {
      headers: { Authorization: 'Bearer ' + token() }
    }).then((r) => r.json());
    assert.strictEqual(activation.purchase.available, false, 'never offer a purchase we cannot record');
  } finally {
    s.stop();
  }
});

// ---------------------------------------------------------------------------
// 6. Configuration matrix (pure, exhaustive)
// ---------------------------------------------------------------------------

test('config: every incomplete combination reports unusable with a precise reason', () => {
  const { resolvePayhipConfig, describePayhipConfig } = require(path.join(ROOT, 'services', 'PayhipEntitlements.js'));
  const base = {
    PAYHIP_ENABLED: 'true',
    PAYHIP_PRODUCTS: PRODUCT,
    PAYHIP_API_KEY: API_KEY,
    PAYHIP_WEBHOOK_TOKEN: TOKEN,
    PAYHIP_PRODUCT_SECRET: 'sk'
  };
  const strip = (k) => { const c = Object.assign({}, base); delete c[k]; return c; };

  const cases = [
    ['disabled', {}, 'disabled', false],
    ['no products', Object.assign({}, base, { PAYHIP_PRODUCTS: '' }), 'no-products-configured', false],
    ['no api key', strip('PAYHIP_API_KEY'), 'missing-api-key', false],
    ['no token', strip('PAYHIP_WEBHOOK_TOKEN'), 'missing-webhook-token', false],
    ['weak token', Object.assign({}, base, { PAYHIP_WEBHOOK_TOKEN: 'short' }), 'weak-webhook-token', false],
    ['valid', base, null, true]
  ];
  for (const [label, env, reason, usable] of cases) {
    const cfg = resolvePayhipConfig(env);
    assert.strictEqual(cfg.reason, reason, label + ': reason');
    assert.strictEqual(cfg.usable, usable, label + ': usable');
    assert.strictEqual(cfg.webhookUsable, usable, label + ': webhookUsable');
    const described = describePayhipConfig(cfg);
    assert.strictEqual(described.usable, usable, label + ': description matches');
    assert.ok(!JSON.stringify(described).includes(TOKEN), label + ': the description must not leak the token');
  }
  // The webhook and redemption have independent requirements: a missing product
  // secret leaves deliveries working but makes redemption refuse (fail closed).
  const noSecret = resolvePayhipConfig(strip('PAYHIP_PRODUCT_SECRET'));
  assert.strictEqual(noSecret.usable, true, 'the webhook is usable without the redemption secret');
  assert.strictEqual(noSecret.redeemUsable, false, 'redemption requires the product secret');
});
