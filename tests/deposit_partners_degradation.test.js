'use strict';

/**
 * MIGRATION-ABSENT DEGRADATION + ADMIN AUTHORIZATION (deposit partners).
 *
 * Migration 045 is NOT applied in production yet, so the application MUST keep
 * working on a database that has no `deposit_partners` table: the deposit page
 * falls back to the existing crypto route and the partner admin surface answers
 * 503 with `migrationRequired`. That is a deployment-order guarantee, so it is
 * tested against the REAL server process rather than by reading source.
 *
 * The child process runs with tests/helpers/fake-supabase-preload.js, which
 * replaces `globalThis.fetch` so the Supabase client is answered offline (see
 * that file for why an HTTP stub cannot work here). Every data-layer request is
 * logged, so the tests can assert exactly which tables the server touched.
 *
 * No database, no network and no production credential is used.
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-preload.js');
const JWT_SECRET = 'deposit-partner-degradation-test-secret';

const ADMIN_TOKEN = jwt.sign({ id: 1, email: 'admin@test.invalid', isAdmin: true, jti: 'jti-admin' }, JWT_SECRET);
const USER_TOKEN = jwt.sign({ id: 2, email: 'user@test.invalid', isAdmin: false, jti: 'jti-user' }, JWT_SECRET);

const VISIBLE_ROW = {
  id: 3, display_name: 'Visible Partner', telegram_username: 'arbitrix_csa1',
  services: ['direct_sale'], serves_worldwide: false, countries: ['Nigeria'],
  payment_methods: ['Bank transfer'], is_active: true, is_verified: true,
  display_order: 10, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
};
// Active + verified but NO coverage: the public listing must hide it.
const NO_COVERAGE_ROW = {
  id: 4, display_name: 'No Coverage Partner', telegram_username: 'arbitrix_csa2',
  services: ['guided_assistance'], serves_worldwide: false, countries: [],
  payment_methods: [], is_active: true, is_verified: true,
  display_order: 20, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
};

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startApp(mode, rows) {
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
      DP_FAKE_MODE: mode,
      DP_FAKE_ROWS: JSON.stringify(rows || []),
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server exited during boot: ' + output.slice(-1200));
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) break;
    } catch (e) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('server did not become healthy: ' + output.slice(-1200));
    await new Promise((r) => setTimeout(r, 150));
  }

  const lines = () => output.split('\n')
    .filter((l) => l.indexOf('[fake-supabase] ') !== -1)
    .map((l) => l.slice(l.indexOf('[fake-supabase] ') + '[fake-supabase] '.length).trim());

  return {
    base,
    // Data-layer calls the server made, e.g. "GET /rest/v1/deposit_partners?select=*".
    requests: () => lines().filter((l) => l && l.indexOf('BLOCKED') !== 0),
    blocked: () => lines().filter((l) => l.indexOf('BLOCKED') === 0),
    output: () => output,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 4000);
    })
  };
}

const get = async (base, p, token) => {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const res = await fetch(base + p, { headers });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body };
};

const send = async (base, method, p, token, payload) => {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {});
  const res = await fetch(base + p, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body };
};

/* ------------------------------------------------------------------------- *
 * The harness itself must be provably offline: a broken interception would
 * silently let a test talk to the real Supabase project.
 * ------------------------------------------------------------------------- */

test('the offline harness blocks any non-Supabase request', async () => {
  const script = [
    "(async () => {",
    "  try { await fetch('https://example.com/anything'); console.log('ESCAPED'); }",
    "  catch (e) { console.log('BLOCKED:' + e.message); }",
    "})();"
  ].join('\n');
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        DP_FAKE_MODE: 'missing',
        NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let text = '';
    child.stdout.on('data', (d) => { text += d.toString(); });
    child.stderr.on('data', (d) => { text += d.toString(); });
    child.once('exit', () => resolve(text));
    child.once('error', reject);
  });
  assert.match(out, /BLOCKED:offline test harness blocked/,
    'the preload must refuse to reach a real host, got: ' + out);
  assert.ok(out.indexOf('ESCAPED') === -1, 'no request may leave the process');
});

/* ------------------------------------------------------------------------- *
 * Scenario 1: migration 045 NOT applied (table does not exist)
 * ------------------------------------------------------------------------- */

test('without migration 045 the deposit options still return the crypto route', async () => {
  const app = await startApp('missing');
  try {
    const { status, body } = await get(app.base, '/api/deposit/options', USER_TOKEN);
    assert.strictEqual(status, 200, 'the deposit page must not break');
    assert.strictEqual(body.success, true);
    assert.deepStrictEqual(body.partners, [], 'no partners are invented');
    assert.strictEqual(body.partnersAvailable, false, 'the partner state is reported as unavailable');
    // The existing crypto route is intact and unchanged.
    assert.strictEqual(body.crypto.enabled, true);
    assert.strictEqual(body.crypto.asset, 'USDT');
    assert.strictEqual(body.crypto.network, 'TRC20');
    assert.strictEqual(body.crypto.minDeposit, 100, 'minimum deposit stays $100');
    // Card purchasing stays postponed whatever the environment says.
    assert.strictEqual(body.card.enabled, false);

    // The degradation came from the directory query itself...
    const pointsAtDirectory = app.requests().filter((r) => r.indexOf('/rest/v1/deposit_partners') !== -1);
    assert.ok(pointsAtDirectory.length >= 1, 'the directory was queried: ' + app.requests().join(' | '));
    // ...and the read-only options route touched nothing money-related.
    assert.deepStrictEqual(
      app.requests().filter((r) => /wallets|credit|transactions|invoices|deposit_status|rpc\//i.test(r)), [],
      'the options route must never reach a wallet, ledger, invoice or RPC path');
    // No request escaped to a non-Supabase host.
    assert.deepStrictEqual(app.blocked(), []);
  } finally {
    await app.stop();
  }
});

test('without migration 045 the partner admin surface answers 503 + migrationRequired', async () => {
  const app = await startApp('missing');
  try {
    const list = await get(app.base, '/api/admin/deposit-partners', ADMIN_TOKEN);
    assert.strictEqual(list.status, 503);
    assert.strictEqual(list.body.success, false);
    assert.strictEqual(list.body.migrationRequired, '045_deposit_partners.sql',
      'the operator is told which migration to apply');

    const created = await send(app.base, 'POST', '/api/admin/deposit-partners', ADMIN_TOKEN, {
      displayName: 'Partner', telegramUsername: 'arbitrix_csa1',
      services: ['direct_sale'], servesWorldwide: true
    });
    assert.strictEqual(created.status, 503, 'a write fails cleanly, never half-applied');
    assert.strictEqual(created.body.success, false);

    const updated = await send(app.base, 'PUT', '/api/admin/deposit-partners/1', ADMIN_TOKEN, { isActive: true });
    assert.strictEqual(updated.status, 503);

    const removed = await send(app.base, 'DELETE', '/api/admin/deposit-partners/1', ADMIN_TOKEN);
    assert.strictEqual(removed.status, 503);
  } finally {
    await app.stop();
  }
});

test('authentication and administrator authorization still gate every partner route', async () => {
  const app = await startApp('missing');
  try {
    // No token -> 401 on the public and the admin route.
    assert.strictEqual((await get(app.base, '/api/deposit/options')).status, 401);
    assert.strictEqual((await get(app.base, '/api/admin/deposit-partners')).status, 401);

    // A normal user's token -> 200 on the customer route, 403 on every admin
    // route. The 403 comes BEFORE the directory is touched, so it holds on a
    // missing table too.
    assert.strictEqual((await get(app.base, '/api/deposit/options', USER_TOKEN)).status, 200);
    const forbidden = [
      ['GET', '/api/admin/deposit-partners', undefined],
      ['POST', '/api/admin/deposit-partners', { displayName: 'X', telegramUsername: 'arbitrix_csa1', services: ['direct_sale'] }],
      ['PUT', '/api/admin/deposit-partners/1', { isActive: true }],
      ['DELETE', '/api/admin/deposit-partners/1', undefined]
    ];
    for (const [method, url, payload] of forbidden) {
      const res = method === 'GET'
        ? await get(app.base, url, USER_TOKEN)
        : await send(app.base, method, url, USER_TOKEN, payload);
      assert.strictEqual(res.status, 403, method + ' ' + url + ' must be admin-only');
      assert.match(JSON.stringify(res.body), /Admin required/);
    }

    // A forged/invalid signature is rejected outright.
    const bad = await get(app.base, '/api/admin/deposit-partners', 'not.a.jwt');
    assert.strictEqual(bad.status, 401);
  } finally {
    await app.stop();
  }
});

/* ------------------------------------------------------------------------- *
 * Scenario 2: migration 045 applied (table exists with rows)
 * ------------------------------------------------------------------------- */

test('with the directory present only visible partners reach the customer', async () => {
  const app = await startApp('present', [VISIBLE_ROW, NO_COVERAGE_ROW]);
  try {
    const { status, body } = await get(app.base, '/api/deposit/options', USER_TOKEN);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.partnersAvailable, true);
    assert.strictEqual(body.partners.length, 1, 'only the fully-disclosed partner is listed');
    const partner = body.partners[0];
    assert.strictEqual(partner.displayName, 'Visible Partner');
    assert.strictEqual(partner.telegramUrl, 'https://t.me/arbitrix_csa1');
    assert.strictEqual(partner.directSale, true);
    assert.deepStrictEqual(partner.countries, ['Nigeria']);
    // No administrative field reaches the browser.
    for (const forbidden of ['id', 'is_active', 'is_verified', 'display_order', 'created_at', 'updated_at']) {
      assert.ok(!(forbidden in partner), 'public partner must not expose ' + forbidden);
    }
  } finally {
    await app.stop();
  }
});

test('the admin listing reports the authoritative visibleToCustomers flag', async () => {
  const app = await startApp('present', [VISIBLE_ROW, NO_COVERAGE_ROW]);
  try {
    const { status, body } = await get(app.base, '/api/admin/deposit-partners', ADMIN_TOKEN);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.partners.length, 2, 'the admin sees every row, visible or not');

    const byName = {};
    for (const row of body.partners) byName[row.display_name] = row;
    assert.strictEqual(byName['Visible Partner'].visibleToCustomers, true);
    assert.strictEqual(byName['No Coverage Partner'].visibleToCustomers, false,
      'active + verified without coverage is NOT visible to customers');

    // The flag must agree with what the customer endpoint actually returns.
    const publicList = await get(app.base, '/api/deposit/options', USER_TOKEN);
    const publicNames = publicList.body.partners.map((p) => p.displayName);
    for (const row of body.partners) {
      assert.strictEqual(row.visibleToCustomers, publicNames.indexOf(row.display_name) !== -1,
        'the admin indicator must match the public listing for ' + row.display_name);
    }
  } finally {
    await app.stop();
  }
});
