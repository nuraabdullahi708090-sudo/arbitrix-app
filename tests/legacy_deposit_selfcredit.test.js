'use strict';

/**
 * SECURITY FIX C1 — legacy deposit self-crediting.
 *
 * THE VULNERABILITY (reproduced end to end before the fix)
 *   1. POST /api/deposit/request (authenticated, any body) inserted a `pending`
 *      `deposits` row with a CLIENT-CHOSEN amount, a SHARED static receive
 *      address (identical for every user and every invoice) and
 *      `invoice_id = 'inv_<ms>_<userId>'`. No payment evidence of any kind.
 *   2. GET /api/deposit/status/:invoiceId then did, once the row was 15 seconds
 *      old:
 *          confirmLegacyDeposit(deposit)  -> wallet credit + ledger row
 *      i.e. ELAPSED TIME WAS THE ONLY "CONFIRMATION". A shared address cannot
 *      attribute an on-chain payment to a user, so no real evidence could ever
 *      exist for these rows.
 *   Exploit: register -> POST /api/deposit/request {amount: 100000} -> wait 15s
 *   -> GET /api/deposit/status/<id> -> $100,000 credited, nothing paid.
 *   Referral qualification also ran off that unaudited credit.
 *
 * THE FIX
 *   - /api/deposit/request is retired: authenticated, 410 Gone, machine-readable
 *     code, and it writes NO deposit row (no credit-able record can be minted).
 *   - /api/deposit/status/:invoiceId is read-only: it reports the stored state
 *     (plus evidence-based `credited` / `verified` flags) and never writes money.
 *   - The only remaining credit path is the administrator confirmation, behind
 *     authMiddleware + adminMiddleware, through the atomic idempotent
 *     confirm_legacy_deposit_safe() RPC (migration 041).
 *   - Legitimate deposits continue through the provider flow
 *     (create-invoice -> verified webhook -> credit_payment_safe).
 *
 * These tests EXECUTE the real handler bodies (extracted from server.js and run
 * in a sandboxed function with a fake Supabase client) and then pin the source
 * contracts that keep the fix in place.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const MIGRATION_041 = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '041_legacy_deposit_atomic_credit.sql'), 'utf8');

// ---------------------------------------------------------------------------
// Handler extraction: pull `async (req, res) => { ... }` out of a route.
// Comments are stripped first so braces inside prose cannot confuse the matcher
// and so comment-only assertions stay honest.
// ---------------------------------------------------------------------------
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

function routeArrow(method, routePath, source = SERVER) {
  const src = stripComments(source);
  const marker = `app.${method}('${routePath}'`;
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `route not found: ${method.toUpperCase()} ${routePath}`);
  const arrowAt = src.indexOf('async (req, res) => {', at);
  assert.ok(arrowAt > at, 'handler signature changed: ' + routePath);
  let depth = 0;
  for (let i = src.indexOf('{', arrowAt); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(arrowAt, i + 1);
    }
  }
  throw new Error('unbalanced handler: ' + routePath);
}

// Fake Supabase client that records every operation and returns a queued result.
function makeDb(row) {
  const ops = [];
  const result = { data: row, error: row ? null : { code: 'PGRST116', message: 'no rows' } };
  const chain = {
    select() { ops.push(['select']); return chain; },
    insert(payload) { ops.push(['insert', payload]); return Promise.resolve({ data: null, error: null }); },
    update(payload) { ops.push(['update', payload]); return { eq: () => Promise.resolve({ data: null, error: null }) }; },
    eq(column, value) { ops.push(['eq', column, value]); return chain; },
    single() { return Promise.resolve(result); }
  };
  return { client: { from(table) { ops.push(['from', table]); return chain; } }, ops };
}

// Run a route handler with explicit collaborators, failing loudly if the handler
// ever reaches a credit primitive.
async function runRoute(arrow, { row, body = {}, params = {}, sandbox = false, balance = 1000 }) {
  const db = makeDb(row);
  const creditCalls = [];
  const referralCalls = [];
  const logs = [];
  const handler = new Function(
    'sandboxHandled', 'supabaseAdmin', 'getWallet',
    'confirmLegacyDeposit', 'activateReferralOnQualification', 'console',
    'handleSandboxDepositRequest', 'handleSandboxDepositStatus',
    `return (${arrow});`
  )(
    async () => sandbox,
    db.client,
    async () => ({ live_balance: balance }),
    async (d) => { creditCalls.push(d); return { credited: true }; },
    async (...a) => { referralCalls.push(a); return null; },
    { error: (...a) => logs.push(a.join(' ')), warn: () => {}, log: () => {} },
    async () => {}, async () => {}
  );
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  await handler({ body, params, user: { id: 4242 } }, res);
  return { res, ops: db.ops, creditCalls, referralCalls, logs };
}

const REQUEST = () => routeArrow('post', '/api/deposit/request');
const STATUS = () => routeArrow('get', '/api/deposit/status/:invoiceId');

const HOUR = 3600000;
const pendingRow = (over = {}) => ({
  id: 900,
  user_id: 4242,
  amount: 100000,
  network: 'TRC20',
  status: 'pending',
  credited: false,
  created_at: new Date(Date.now() - 60 * 1000).toISOString(),
  ...over
});

// ===========================================================================
// A. The retired creation endpoint cannot mint a credit-able record
// ===========================================================================

test('deposit/request: an authenticated call is refused with 410 and writes nothing', async () => {
  const { res, ops, creditCalls, referralCalls } = await runRoute(REQUEST(), {
    body: { amount: 100000, network: 'TRC20' }
  });
  assert.strictEqual(res.statusCode, 410);
  assert.strictEqual(res.body.code, 'LEGACY_DEPOSIT_RETIRED');
  assert.strictEqual(res.body.success, false);
  assert.deepStrictEqual(ops, [], 'no database operation at all (in particular no insert)');
  assert.deepStrictEqual(creditCalls, []);
  assert.deepStrictEqual(referralCalls, []);
});

test('deposit/request: the refusal body points at the provider flow', async () => {
  const { res } = await runRoute(REQUEST(), { body: { amount: 50 } });
  assert.strictEqual(res.body.useEndpoint, '/api/payment/create-invoice');
  assert.match(res.body.error, /retired/i);
});

test('deposit/request: no amount, network or reference changes the outcome', async () => {
  for (const body of [{}, { amount: 1 }, { amount: '999999999' }, { amount: 100000, network: 'ERC20' },
                      { amount: 100000, currency: 'BTC' }, { amount: null, network: null }]) {
    const { res, ops } = await runRoute(REQUEST(), { body });
    assert.strictEqual(res.statusCode, 410, 'body ' + JSON.stringify(body));
    assert.deepStrictEqual(ops, [], 'body ' + JSON.stringify(body));
  }
});

test('deposit/request: the sandbox branch still runs first and is unchanged', () => {
  const arrow = routeArrow('post', '/api/deposit/request', SERVER);
  // routeArrow() strips comments, so the first statement of the body is the branch.
  assert.match(arrow, /^\s*async \(req, res\) => \{\s*if \(await sandboxHandled\(req, res, handleSandboxDepositRequest\)\) return;/,
    'a MARKETING_SANDBOX account must still reach the simulated handler before any production code');
  assert.match(arrow, /handleSandboxDepositRequest/);
});

// ===========================================================================
// B. The status endpoint cannot credit - the core of the fix
// ===========================================================================

test('deposit/status: a 60s-old PENDING row is NOT credited (the exploit)', async () => {
  const { res, creditCalls, referralCalls } = await runRoute(STATUS(), {
    row: pendingRow(), params: { invoiceId: 'inv_1_4242' }
  });
  assert.deepStrictEqual(creditCalls, [], 'elapsed time must never trigger a credit');
  assert.deepStrictEqual(referralCalls, [], 'no referral qualification off an unverified deposit');
  assert.strictEqual(res.body.status, 'pending');
  assert.strictEqual(res.body.credited, false);
  assert.strictEqual(res.body.verified, false);
  assert.strictEqual(res.body.creditedAmount, 0);
  assert.strictEqual(res.body.requiresVerification, true);
});

test('deposit/status: repeated polling never credits and never changes the balance', async () => {
  const row = pendingRow();
  for (let i = 0; i < 5; i += 1) {
    const { res, creditCalls } = await runRoute(STATUS(), { row: { ...row }, params: { invoiceId: 'inv_1_4242' } });
    assert.deepStrictEqual(creditCalls, []);
    assert.strictEqual(res.body.creditedAmount, 0);
    assert.strictEqual(res.body.newBalance, 1000, 'balance reported, never increased by polling');
  }
});

test('deposit/status: concurrent polls all report pending with zero credit', async () => {
  const row = pendingRow();
  const runs = await Promise.all(Array.from({ length: 8 }, () =>
    runRoute(STATUS(), { row: { ...row }, params: { invoiceId: 'inv_1_4242' } })));
  runs.forEach(({ res, creditCalls }) => {
    assert.deepStrictEqual(creditCalls, []);
    assert.strictEqual(res.body.credited, false);
    assert.strictEqual(res.body.creditedAmount, 0);
  });
});

test('deposit/status: an unpaid invoice older than an hour expires without crediting', async () => {
  const { res, ops, creditCalls } = await runRoute(STATUS(), {
    row: pendingRow({ created_at: new Date(Date.now() - 2 * HOUR).toISOString() }),
    params: { invoiceId: 'inv_1_4242' }
  });
  assert.deepStrictEqual(creditCalls, []);
  assert.deepStrictEqual(ops.filter((o) => o[0] === 'update'), [['update', { status: 'expired' }]],
    'the only remaining write is the non-financial expiry');
  assert.strictEqual(res.body.status, 'expired');
  assert.strictEqual(res.body.creditedAmount, 0);
});

test('deposit/status: credit is reported from the marker, not from the status string', async () => {
  // A genuinely credited row: status confirmed AND credited true.
  const confirmed = await runRoute(STATUS(), {
    row: pendingRow({ status: 'confirmed', credited: true }), params: { invoiceId: 'inv_1_4242' }
  });
  assert.strictEqual(confirmed.res.body.status, 'confirmed');
  assert.strictEqual(confirmed.res.body.credited, true);
  assert.strictEqual(confirmed.res.body.creditedAmount, 100000);
  assert.deepStrictEqual(confirmed.creditCalls, [], 'reporting a credit must not perform one');

  // The pre-041 shape: confirmed without the credit marker -> fail closed.
  for (const credited of [undefined, false, null]) {
    const bare = await runRoute(STATUS(), {
      row: pendingRow({ status: 'confirmed', credited }), params: { invoiceId: 'inv_1_4242' }
    });
    assert.strictEqual(bare.res.body.credited, false, 'credited=' + String(credited));
    assert.strictEqual(bare.res.body.creditedAmount, 0, 'credited=' + String(credited));
    assert.deepStrictEqual(bare.creditCalls, []);
  }
});

test('deposit/status: another user’s invoice is a 404 and credits nothing', async () => {
  // The fake returns no row: the ownership filter is part of the lookup, so a
  // foreign invoice is indistinguishable from a missing one.
  const { res, creditCalls, ops } = await runRoute(STATUS(), { row: null, params: { invoiceId: 'inv_other' } });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.error, 'Invoice not found');
  assert.deepStrictEqual(creditCalls, []);
  assert.ok(ops.some((o) => o[0] === 'update') === false, 'a 404 must not write anything');
});

test('deposit/status: the ownership filter is part of the query', () => {
  const arrow = routeArrow('get', '/api/deposit/status/:invoiceId', SERVER);
  assert.match(arrow, /\.eq\('invoice_id', invoiceId\)\.eq\('user_id', req\.user\.id\)/,
    'the lookup must be scoped to the authenticated user');
});

test('deposit/status: the sandbox branch still runs first', () => {
  const arrow = routeArrow('get', '/api/deposit/status/:invoiceId', SERVER);
  assert.match(arrow, /^\s*async \(req, res\) => \{\s*if \(await sandboxHandled\(req, res, handleSandboxDepositStatus\)\) return;/,
    'sandbox polling must still be simulated and never touch production money');
});

// ===========================================================================
// C. Source contracts that keep the vulnerability closed
// ===========================================================================

test('the status handler contains no credit primitive at all', () => {
  const arrow = routeArrow('get', '/api/deposit/status/:invoiceId', SERVER);
  for (const forbidden of ['confirmLegacyDeposit', 'confirm_legacy_deposit_safe', 'updateWallet',
                           'addTransaction', 'activateReferralOnQualification', 'credit_payment_safe']) {
    assert.ok(!arrow.includes(forbidden), 'status handler must not reference ' + forbidden);
  }
});

test('the retired request handler performs no insert', () => {
  const arrow = routeArrow('post', '/api/deposit/request', SERVER);
  assert.ok(!/\.insert\(/.test(arrow), 'the retired endpoint must not create deposit rows');
  assert.ok(!arrow.includes('updateWallet'));
});

test('every remaining legacy credit call site is admin-only', () => {
  const sites = [...SERVER.matchAll(/await confirmLegacyDeposit\(/g)].map((m) => m.index);
  assert.strictEqual(sites.length, 2, 'customer polling must no longer credit; only the two admin routes remain');
  for (const at of sites) {
    const routeStart = SERVER.lastIndexOf("\napp.", at);
    const header = SERVER.slice(routeStart, SERVER.indexOf('=>', routeStart));
    assert.match(header, /adminMiddleware/, 'credit call site without adminMiddleware: ' + header.trim().slice(0, 90));
    assert.match(header, /authMiddleware/);
  }
});

test('both legacy routes still authenticate before doing anything else', () => {
  assert.match(SERVER, /app\.post\('\/api\/deposit\/request', authMiddleware,/);
  assert.match(SERVER, /app\.get\('\/api\/deposit\/status\/:invoiceId', authMiddleware,/);
});

test('the atomic credit primitive is unchanged (idempotent, locked, marker-based)', () => {
  assert.match(MIGRATION_041, /CREATE OR REPLACE FUNCTION public\.confirm_legacy_deposit_safe/);
  assert.match(MIGRATION_041, /COALESCE\(v_deposit\.credited, FALSE\)/, 'idempotency check');
  assert.match(MIGRATION_041, /FOR UPDATE/, 'row lock');
  assert.match(MIGRATION_041, /user_mismatch/, 'ownership check');
  assert.match(MIGRATION_041, /IF lower\(COALESCE\(v_deposit\.status, ''\)\) <> 'pending' THEN/,
    'only a pending row may be credited');
});

test('the legitimate provider flow is intact', () => {
  // Creation + provider checkout, verified webhook, DB-side credit with a marker.
  assert.match(SERVER, /app\.post\('\/api\/payment\/create-invoice'/);
  assert.match(SERVER, /credit_payment_safe/);
  assert.match(SERVER, /app\.get\('\/api\/payment\/invoice\/:invoiceId'/);
  assert.match(SERVER, /app\.post\('\/api\/webhook\/:provider'/);
});

test('the frontend fallback still receives a JSON status (response shape preserved)', () => {
  // startPollingForPayment() falls back to the legacy status endpoint when the
  // provider invoice lookup fails, and only reads `status`/`creditedAmount`.
  assert.match(INDEX, /fetch\(`\/api\/deposit\/status\/\$\{invoiceId\}`/);
  const arrow = routeArrow('get', '/api/deposit/status/:invoiceId', SERVER);
  for (const key of ['status:', 'newBalance:', 'creditedAmount:', 'network:']) {
    assert.ok(arrow.includes(key), 'response must keep ' + key);
  }
  assert.match(arrow, /referralActivated: null/, 'shape kept, but never set by this endpoint');
});

test('the fix needs no schema change and introduced no migration', () => {
  // The credit primitive (atomic, idempotent, marker-based) and the
  // `deposits.credited` column already existed (migration 041) - the defect was
  // a ROUTE calling them, so no DDL is required and none was added.
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const files = fs.readdirSync(dir);
  assert.ok(files.includes('041_legacy_deposit_atomic_credit.sql'));
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!sql.includes('LEGACY_DEPOSIT_RETIRED'),
      'no migration may carry the route-level fix marker: ' + f);
  }
  assert.match(MIGRATION_041, /ADD COLUMN IF NOT EXISTS credited BOOLEAN/);
});

// ===========================================================================
// D. HTTP-level: the real server process, the real auth middleware
// ---------------------------------------------------------------------------
// Booting the real server proves the guarantees hold at the network boundary
// (not only inside the handler): authentication runs first, the retired route
// answers 410, and NO write to /rest/v1/deposits is attempted. The offline
// Supabase stub logs every attempt it sees, so "no write" is observed, not
// assumed.
// ===========================================================================

const JWT_SECRET = 'legacy-deposit-selfcredit-test-secret';
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-preload.js');
const app = { child: null, base: null, log: '' };

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

test.before(async () => {
  const port = await freePort();
  app.base = 'http://127.0.0.1:' + port;
  app.child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      JWT_SECRET,
      BASE_URL: app.base,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_SUPPORT_CHAT_ID: '',
      TELEGRAM_ADMIN_IDS: '',
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.child.stdout.on('data', (d) => { app.log += d.toString(); });
  app.child.stderr.on('data', (d) => { app.log += d.toString(); });
  const deadline = Date.now() + 25000;
  for (;;) {
    if (app.child.exitCode !== null) throw new Error('server exited during boot: ' + app.log.slice(-800));
    try {
      const r = await fetch(app.base + '/api/health');
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start: ' + app.log.slice(-800));
    await new Promise((r) => setTimeout(r, 150));
  }
});

test.after(() => { if (app.child) app.child.kill('SIGKILL'); });

const userToken = () => jwt.sign({ id: 4242, email: 'sec@example.test' }, JWT_SECRET, { expiresIn: '1h' });
const depositWrites = () => (app.log.match(/\[fake-supabase\] (POST|PATCH|PUT) \/rest\/v1\/deposits/g) || []);

test('HTTP: an unauthenticated deposit request is rejected before the route body', async () => {
  const before = depositWrites().length;
  const res = await fetch(app.base + '/api/deposit/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 100000 })
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(depositWrites().length, before, 'no deposit write for an unauthenticated caller');
});

test('HTTP: an unauthenticated status poll is rejected and credits nothing', async () => {
  const res = await fetch(app.base + '/api/deposit/status/inv_anything');
  assert.strictEqual(res.status, 401);
});

test('HTTP: an authenticated deposit request gets 410 and creates no deposit row', async () => {
  const before = depositWrites().length;
  const res = await fetch(app.base + '/api/deposit/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + userToken() },
    body: JSON.stringify({ amount: 100000, network: 'TRC20' })
  });
  assert.strictEqual(res.status, 410);
  const body = await res.json();
  assert.strictEqual(body.code, 'LEGACY_DEPOSIT_RETIRED');
  assert.ok(!body.address, 'no receive address is handed out any more');
  assert.ok(!body.id, 'no invoice id is minted');
  assert.strictEqual(depositWrites().length, before, 'the server never writes to the deposits table');
});

test('HTTP: an authenticated status poll of an unknown invoice never reports or performs a credit', async () => {
  const before = depositWrites().length;
  const res = await fetch(app.base + '/api/deposit/status/inv_does_not_exist', {
    headers: { authorization: 'Bearer ' + userToken() }
  });
  const body = await res.json().catch(() => ({}));
  // NOTE: the offline stub answers `200 []` for a single-object query where real
  // PostgREST answers 406/PGRST116, so the exact status differs from production.
  // What must hold in BOTH cases is the security property: no credit is reported
  // and nothing is written. (The 404 mapping itself is covered above with a
  // faithful fake.)
  assert.notStrictEqual(body.credited, true, 'a poll must never report a credit');
  assert.notStrictEqual(body.verified, true);
  assert.ok(!(body.creditedAmount > 0), 'creditedAmount must stay 0');
  assert.strictEqual(depositWrites().length, before, 'a poll cannot write anything');
});
