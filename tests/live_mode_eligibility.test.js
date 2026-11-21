'use strict';

/**
 * The Live Mode eligibility rule, exercised over REAL HTTP.
 *
 * Approved commercial model:
 *   Live Mode = a valid $50 Payhip activation AND a confirmed deposit of at
 *   least the platform minimum ($100). Neither substitutes for the other.
 *
 * Every assertion below boots the real server and calls the real routes; only
 * the database and the Payhip licence API are substituted (see
 * helpers/fake-supabase-live-mode.js). No source-string matching is used to
 * decide pass or fail - the contract tested is the response the customer's
 * client actually receives.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-live-mode.js');
const JWT_SECRET = 'live-mode-eligibility-test-secret';
const SCENARIO_FILE = path.join(os.tmpdir(), 'lm-scenario-' + process.pid + '.json');
const PRODUCT = 'https://payhip.com/b/mVT0';

let child = null;
let base = '';
let output = '';

function setScenario(scenario) {
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify(scenario || {}));
}

function token(extra) {
  return jwt.sign(Object.assign({ id: 7, email: 'live@example.test' }, extra || {}), JWT_SECRET, { expiresIn: '1h' });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test.before(async () => {
  setScenario({});
  const port = await freePort();
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      JWT_SECRET,
      BASE_URL: 'http://127.0.0.1:' + port,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_SUPPORT_CHAT_ID: '',
      TELEGRAM_ADMIN_IDS: '',
      // The rail is configured but the requirement is ON: this is the state the
      // approved model describes.
      PAYHIP_ENABLED: 'true',
      PAYHIP_ACTIVATION_REQUIRED: 'true',
      PAYHIP_WEBHOOK_TOKEN: 'w'.repeat(32),
      PAYHIP_PRODUCTS: PRODUCT,
      PAYHIP_API_KEY: 'pk_test_live_mode',
      PAYHIP_PRODUCT_SECRET: 'sk_test_live_mode',
      PAYHIP_STORE_URL: 'https://payhip.com/arbitrix',
      PAYHIP_RETURN_URL: 'https://example.test/live',
      LM_SCENARIO_FILE: SCENARIO_FILE,
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server exited during boot: ' + output.slice(-1500));
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) break;
    } catch (e) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('server did not become healthy: ' + output.slice(-1500));
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.after(() => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  try { fs.unlinkSync(SCENARIO_FILE); } catch (e) { /* ignore */ }
});

async function call(method, route, body, opts) {
  const headers = { Authorization: 'Bearer ' + token() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json, text: JSON.stringify(json) };
}

const startLive = () => call('POST', '/api/bot/start', { mode: 'live' });
const tradeLive = () => call('POST', '/api/trade', { amount: 5, asset: 'XAU/USD', detail: 'Binance->Bybit' });

// ---------------------------------------------------------------------------
// 1-5. The complete truth table
// ---------------------------------------------------------------------------

test('1. registered, no activation, no deposit -> Live Mode denied', async () => {
  setScenario({ activation: false, balance: 50 });
  const res = await startLive();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'LIVE_ACTIVATION_REQUIRED');
  assert.strictEqual(res.body.activationRequired, true);
});

test('2. a $100 confirmed deposit with NO activation is still denied (deposits never activate)', async () => {
  setScenario({ activation: false, deposits: [{ amount: 100 }], balance: 100 });
  const res = await startLive();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'LIVE_ACTIVATION_REQUIRED',
    'a deposit must never satisfy the activation requirement');
});

test('3. activation purchased, no qualifying deposit -> denied for the deposit', async () => {
  setScenario({ activation: true, deposits: [], balance: 50 });
  const res = await startLive();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'LIVE_DEPOSIT_REQUIRED');
  assert.strictEqual(res.body.depositRequired, true);
  assert.strictEqual(res.body.minDeposit, 100);
});

test('4. activation + a $50 deposit -> denied (below the $100 minimum)', async () => {
  setScenario({ activation: true, deposits: [{ amount: 50 }], balance: 50 });
  const res = await startLive();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'LIVE_DEPOSIT_REQUIRED');
  assert.strictEqual(res.body.depositTotal, 50);
});

test('5. activation + a confirmed $100 deposit -> Live Mode allowed', async () => {
  setScenario({ activation: true, deposits: [{ amount: 100 }], invoices: [{ amount_usd: 100 }], balance: 150 });
  const res = await startLive();
  assert.strictEqual(res.status, 200, 'expected eligibility, got: ' + res.text);
  assert.strictEqual(res.body.status, 'started');
  assert.strictEqual(res.body.mode, 'live');
});

test('5b. the same two facts gate /api/trade, not just the bot', async () => {
  setScenario({ activation: true, deposits: [{ amount: 100 }], balance: 150, rpcResult: { success: true, new_balance: 155 } });
  const allowed = await tradeLive();
  assert.notStrictEqual(allowed.status, 403, 'an eligible account is not refused: ' + allowed.text);
  assert.notStrictEqual(allowed.body && allowed.body.code, 'LIVE_DEPOSIT_REQUIRED');
});

test('13. /api/trade cannot be used to skip the deposit requirement', async () => {
  setScenario({ activation: true, deposits: [], balance: 500 });
  const res = await tradeLive();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'LIVE_DEPOSIT_REQUIRED');
});

test('13b. /api/trade refuses an unactivated account before any balance read', async () => {
  setScenario({ activation: false, deposits: [{ amount: 100 }], balance: 500 });
  const res = await tradeLive();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'LIVE_ACTIVATION_REQUIRED');
});

// ---------------------------------------------------------------------------
// 6-10. Entitlement states and outages
// ---------------------------------------------------------------------------

test('6. a refunded/disabled activation is denied', async () => {
  setScenario({ activation: false, deposits: [{ amount: 100 }], balance: 100 });
  const res = await startLive();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'LIVE_ACTIVATION_REQUIRED');
});

test('6b. redeeming a licence Payhip reports as disabled is refused', async () => {
  setScenario({
    activation: false,
    verifyBody: { enabled: false, product_link: PRODUCT, uses: 0, buyer_email: 'x@example.test' }
  });
  const res = await call('POST', '/api/live/activate', { licenceKey: 'REFUNDED-KEY-0001' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.reason, 'licence-disabled');
});

test('7. another account\u2019s licence cannot be redeemed', async () => {
  setScenario({
    activation: false,
    verifyBody: { enabled: true, product_link: PRODUCT, uses: 1, buyer_email: 'other@example.test' },
    rpcResult: { success: false, reason: 'claimed_by_other_account' }
  });
  const res = await call('POST', '/api/live/activate', { licenceKey: 'SOMEONE-ELSES-KEY' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.reason, 'claimed_by_other_account');
});

test('8. a licence cannot be reused once its purchase is no longer active', async () => {
  setScenario({
    activation: false,
    verifyBody: { enabled: true, product_link: PRODUCT, uses: 2, buyer_email: 'x@example.test' },
    rpcResult: { success: false, reason: 'purchase_not_active' }
  });
  const res = await call('POST', '/api/live/activate', { licenceKey: 'USED-KEY-0002' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.reason, 'purchase_not_active');
});

test('9. a Payhip verification outage fails CLOSED', async () => {
  setScenario({ activation: false, verifyHttp: 503 });
  const res = await call('POST', '/api/live/activate', { licenceKey: 'ANY-KEY' });
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.body.code, 'ACTIVATION_FAILED');
  assert.strictEqual(res.body.reason, 'unavailable');
});

test('9b. an outage does not grant activation either', async () => {
  setScenario({ activation: 'error', deposits: [{ amount: 100 }], balance: 100 });
  const res = await startLive();
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.body.code, 'ACTIVATION_UNAVAILABLE');
  assert.strictEqual(res.body.retryable, true);
});

test('10. an entitlement-database outage fails CLOSED and is reported as unknown', async () => {
  setScenario({ activation: 'error', deposits: [{ amount: 100 }], balance: 100 });
  const res = await call('GET', '/api/live/activation');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.activated, false, 'unknown must never be reported as activated');
  assert.strictEqual(res.body.reason, 'activation-unavailable');
  assert.strictEqual(res.body.eligible, false);
});

test('10b. an unreadable DEPOSIT store also fails closed', async () => {
  setScenario({ activation: true, depositsError: true, balance: 100 });
  const res = await startLive();
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.body.code, 'LIVE_DEPOSIT_CHECK_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// 11-12. Demo and sandbox stay free
// ---------------------------------------------------------------------------

test('11. a forged demo mode is treated as a normal Live start', async () => {
  // Demo Mode was retired. The client can no longer ask for it, and if an old
  // client sends mode:'demo' the server must NOT grant a free session.
  setScenario({ activation: false, deposits: [], balance: 0 });
  const res = await call('POST', '/api/bot/start', { mode: 'demo' });
  assert.notStrictEqual(res.status, 200, 'a demo-flagged request must not be accepted: ' + res.text);
  assert.ok(/activation/i.test(res.text), 'it is refused by the Live eligibility gate: ' + res.text);
});

test('12. MARKETING_SANDBOX is unaffected', async () => {
  setScenario({ activation: false, deposits: [], balance: 0, environment: 'MARKETING_SANDBOX' });
  const res = await startLive();
  assert.notStrictEqual(res.body && res.body.code, 'LIVE_ACTIVATION_REQUIRED');
  assert.notStrictEqual(res.body && res.body.code, 'LIVE_DEPOSIT_REQUIRED');
});

// ---------------------------------------------------------------------------
// 14-15. What the two requirements must NOT touch
// ---------------------------------------------------------------------------

test('14. a deposit never creates a Payhip entitlement', async () => {
  setScenario({ activation: false, deposits: [{ amount: 250 }], invoices: [{ amount_usd: 250 }], balance: 250 });
  const before = output.length;
  const state = await call('GET', '/api/live/activation');
  assert.strictEqual(state.body.activated, false);
  assert.strictEqual(state.body.depositSatisfied, true, 'the deposit IS counted for its own half');
  assert.strictEqual(state.body.eligible, false, 'but it cannot make the account eligible');
  const seen = output.slice(before);
  assert.ok(!/POST \/rest\/v1\/payhip_entitlements/.test(seen), 'no entitlement row may be written by a deposit');
  assert.ok(!/POST \/rest\/v1\/payhip_purchases/.test(seen), 'no purchase row may be written by a deposit');
});

test('15. redeeming an activation never changes the balance or the ledger', async () => {
  setScenario({
    activation: true,
    deposits: [{ amount: 100 }],
    balance: 100,
    verifyBody: { enabled: true, product_link: PRODUCT, uses: 0, buyer_email: 'live@example.test' },
    rpcResult: { success: true, duplicate: false }
  });
  const before = output.length;
  const res = await call('POST', '/api/live/activate', { licenceKey: 'VALID-KEY-0003' });
  assert.strictEqual(res.status, 200, 'a valid licence activates: ' + res.text);
  assert.strictEqual(res.body.success, true);
  const seen = output.slice(before);
  assert.ok(!/PATCH \/rest\/v1\/wallets/.test(seen), 'activation must not write a wallet');
  assert.ok(!/POST \/rest\/v1\/wallets/.test(seen), 'activation must not write a wallet');
  assert.ok(!/credit_payment_safe|record_trade_safe|charge_subscription_safe|update_referral_payout_safe/.test(seen),
    'activation must not call any money-moving RPC');
});

// ---------------------------------------------------------------------------
// Payload contract the dashboard relies on
// ---------------------------------------------------------------------------

test('the status payload reports BOTH halves so the UI can name the missing step', async () => {
  setScenario({ activation: true, deposits: [{ amount: 40 }], balance: 40 });
  const res = await call('GET', '/api/live/activation');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(
    {
      activationRequired: res.body.activationRequired,
      activated: res.body.activated,
      eligible: res.body.eligible,
      depositRequired: res.body.depositRequired,
      depositSatisfied: res.body.depositSatisfied,
      depositTotal: res.body.depositTotal,
      minDeposit: res.body.minDeposit
    },
    {
      activationRequired: true,
      activated: true,
      eligible: false,
      depositRequired: true,
      depositSatisfied: false,
      depositTotal: 40,
      minDeposit: 100
    }
  );
  assert.strictEqual(res.body.liveMode.status, 'deposit_required');
});

test('/api/auth/me carries the same two facts', async () => {
  setScenario({ activation: true, deposits: [{ amount: 100 }], balance: 120 });
  const res = await call('GET', '/api/auth/me');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.liveEligible, true);
  assert.strictEqual(res.body.liveDepositSatisfied, true);
  assert.strictEqual(res.body.liveMinDeposit, 100);
  assert.strictEqual(res.body.liveMode.status, 'available');
});
