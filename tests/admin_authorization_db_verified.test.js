'use strict';

/**
 * Administrative authorization must come from the database, not only from the JWT.
 *
 * The token carries an `isAdmin` claim valid for the whole 7-day session. Trusting
 * it alone meant that demoting an administrator (the very step the provisioning
 * runbook recommends when an account is compromised) did not take effect until
 * that person logged in again - and a stolen admin token could not be demoted at
 * all, only revoked.
 *
 * The contract pinned here:
 *   - the claim is still REQUIRED (a token without it never gains admin, and no
 *     database read happens);
 *   - the claim is no longer SUFFICIENT: `users.is_admin` decides;
 *   - a demotion applies within the 60 s cache window;
 *   - an unreadable answer is a 503 (retryable), never an allow and never a 403
 *     that would look like a permissions decision.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');

const ROOT = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-supabase-auth.js');

/** Load the REAL admin-authorization block out of server.js. */
function loadAdminBlock(db, clock) {
  const start = SERVER.indexOf('const ADMIN_STATUS_TTL_MS');
  assert.ok(start > -1, 'the admin status block exists');
  const endMarker = '\nasync function adminMiddleware(req, res, next) {';
  const endStart = SERVER.indexOf(endMarker);
  assert.ok(endStart > start, 'adminMiddleware follows the block');
  const tail = SERVER.indexOf('\n}\n', endStart);
  const source = SERVER.slice(start, tail + 3);

  const ctx = {
    supabaseAdmin: db,
    console: { warn() {}, log() {}, error() {} },
    Date: { now: clock ? clock.now : Date.now },
    Map,
    String,
    Number,
    Array,
  };
  vm.createContext(ctx);
  // `const` declarations stay script-scoped, so expose what the tests need.
  vm.runInContext(source + '\n;globalThis.__admin = { ADMIN_STATUS_TTL_MS: ADMIN_STATUS_TTL_MS, '
    + 'ADMIN_STATUS_CACHE_MAX: ADMIN_STATUS_CACHE_MAX, adminStatusCache: adminStatusCache, '
    + 'adminMiddleware: adminMiddleware };', ctx);
  assert.strictEqual(typeof ctx.__admin.adminMiddleware, 'function');
  return ctx.__admin;
}

function fakeDb(rows, options) {
  const opts = options || {};
  const calls = { count: 0 };
  return {
    calls,
    from(table) {
      assert.strictEqual(table, 'users');
      const builder = {
        select(columns) {
          assert.match(columns, /is_admin/, 'the query must read is_admin');
          return builder;
        },
        eq(column, value) {
          builder._id = value;
          return builder;
        },
        maybeSingle() { return run(); },
        then(resolve, reject) { return run().then(resolve, reject); },
      };
      function run() {
        calls.count += 1;
        if (opts.error) return Promise.resolve({ data: null, error: { message: 'store down' } });
        if (opts.throw) return Promise.reject(new Error('network down'));
        const row = rows.find((r) => String(r.id) === String(builder._id));
        return Promise.resolve({ data: row || null, error: null });
      }
      return builder;
    },
  };
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
    set(name, value) { res.headers[name] = value; return res; },
  };
  return res;
}

/* ------------------------------------------------------------ unit level */

test('a demoted administrator is refused even though the token still claims admin', async () => {
  const db = fakeDb([{ id: 7, is_admin: 0 }]);
  const ctx = loadAdminBlock(db);
  let nextCalled = false;
  const res = fakeRes();
  await ctx.adminMiddleware({ user: { id: 7, isAdmin: true } }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false, 'the request must not proceed');
  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.error, /Admin required/);
});

test('a current administrator still gets through', async () => {
  const db = fakeDb([{ id: 7, is_admin: 1 }]);
  const ctx = loadAdminBlock(db);
  let nextCalled = false;
  await ctx.adminMiddleware({ user: { id: 7, isAdmin: true } }, fakeRes(), () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

test('a token without the claim never reaches the database', async () => {
  const db = fakeDb([{ id: 7, is_admin: 1 }]);
  const ctx = loadAdminBlock(db);
  const res = fakeRes();
  let nextCalled = false;
  await ctx.adminMiddleware({ user: { id: 7 } }, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(db.calls.count, 0, 'no lookup for a non-admin claim');
});

test('an account that no longer exists is refused', async () => {
  const db = fakeDb([]);
  const ctx = loadAdminBlock(db);
  const res = fakeRes();
  await ctx.adminMiddleware({ user: { id: 99, isAdmin: true } }, res, () => {});
  assert.strictEqual(res.statusCode, 403);
});

test('an unreadable answer is a retryable 503, never an allow and never a 403', async () => {
  for (const mode of ['error', 'throw']) {
    const db = fakeDb([], mode === 'error' ? { error: true } : { throw: true });
    const ctx = loadAdminBlock(db);
    const res = fakeRes();
    let nextCalled = false;
    await ctx.adminMiddleware({ user: { id: 7, isAdmin: true } }, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, mode + ': must not proceed');
    assert.strictEqual(res.statusCode, 503, mode + ': retryable, not a permissions answer');
    assert.strictEqual(res.headers['Retry-After'], '5');
    assert.strictEqual(res.body.retryable, true);
  }
});

test('the status is cached for the TTL and a demotion applies once it expires', async () => {
  let now = 1_000_000;
  const rows = [{ id: 7, is_admin: 1 }];
  const db = fakeDb(rows);
  const ctx = loadAdminBlock(db, { now: () => now });

  let allowed = 0;
  const run = async () => {
    let nextCalled = false;
    const res = fakeRes();
    await ctx.adminMiddleware({ user: { id: 7, isAdmin: true } }, res, () => { nextCalled = true; });
    if (nextCalled) allowed += 1;
    return res;
  };

  await run();
  await run();
  assert.strictEqual(db.calls.count, 1, 'the second request used the cache');

  // Demotion mid-session: still cached...
  rows[0].is_admin = 0;
  await run();
  assert.strictEqual(allowed, 3, 'within the TTL the cached grant is used');

  // ...but not for longer than one TTL.
  now += ctx.ADMIN_STATUS_TTL_MS + 1;
  const res = await run();
  assert.strictEqual(res.statusCode, 403, 'the demotion takes effect after the TTL');
  assert.strictEqual(db.calls.count, 2);
  assert.strictEqual(ctx.ADMIN_STATUS_TTL_MS, 60000, 'a demotion applies within a minute');
});

test('the status cache is bounded', async () => {
  const rows = [];
  for (let i = 0; i < 800; i++) rows.push({ id: i, is_admin: 1 });
  const db = fakeDb(rows);
  const ctx = loadAdminBlock(db);
  for (let i = 0; i < 800; i++) {
    await ctx.adminMiddleware({ user: { id: i, isAdmin: true } }, fakeRes(), () => {});
  }
  assert.ok(ctx.adminStatusCache.size <= ctx.ADMIN_STATUS_CACHE_MAX,
    'cache bounded to ' + ctx.ADMIN_STATUS_CACHE_MAX + ', got ' + ctx.adminStatusCache.size);
});

test('the routes still put authMiddleware before adminMiddleware', () => {
  const registrations = SERVER.match(/app\.(?:get|post|put|patch|delete)\([^\n]*authMiddleware, adminMiddleware/g) || [];
  assert.ok(registrations.length > 20, 'admin routes are registered with both middleware');
  const backwards = SERVER.match(/adminMiddleware, authMiddleware/g) || [];
  assert.strictEqual(backwards.length, 0, 'never adminMiddleware before authMiddleware');
});

/* ----------------------------------------------------------- over HTTP */

const SCENARIO_FILE = path.join(os.tmpdir(), 'admin-db-' + process.pid + '.json');
const SECRET = 'admin-db-verified-secret';

function freePort() {
  return new Promise(function (resolve) {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      server.close(function () { resolve(port); });
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function bootServer() {
  // The database says this account is NOT an administrator.
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify({
    twofaType: 'none',
    user: {
      id: 777, name: 'Former Admin', email: 'former@example.test',
      password_hash: '$2b$04$abcdefghijklmnopqrstuv', referral_code: 'ARBI-FMR001',
      is_admin: 0, environment: 'PRODUCTION',
    },
  }));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test', PORT: String(port), JWT_SECRET: SECRET, BASE_URL: base,
      SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'ad-anon', SUPABASE_SERVICE_KEY: 'ad-service',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_SUPPORT_CHAT_ID: '', TELEGRAM_ADMIN_IDS: '',
      PAYHIP_ENABLED: 'false', AUTH_SCENARIO_FILE: SCENARIO_FILE,
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited early: ' + output);
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) return { base, child };
    } catch (e) { /* not up */ }
    await sleep(120);
  }
  throw new Error('server not healthy\n' + output);
}

test('HTTP: a token minted while admin is refused after the account is demoted', async () => {
  const server = await bootServer();
  try {
    // A valid, correctly signed session token whose claim still says admin - the
    // exact state left behind by a demotion without re-login.
    const staleAdminToken = jwt.sign(
      { id: 777, email: 'former@example.test', isAdmin: true, jti: 'jti-admin-db-test' },
      SECRET, { expiresIn: '7d' }
    );
    const res = await fetch(server.base + '/api/admin/users', {
      headers: { Authorization: 'Bearer ' + staleAdminToken },
    });
    const body = await res.json().catch(() => ({}));
    assert.strictEqual(res.status, 403, 'the database decides, not the claim: ' + JSON.stringify(body));

    // The same token on a NON-admin route still works: the session itself is
    // valid, only the administrative authority was withdrawn.
    const me = await fetch(server.base + '/api/auth/me', {
      headers: { Authorization: 'Bearer ' + staleAdminToken },
    });
    assert.strictEqual(me.status, 200, 'the customer session is unaffected by losing admin rights');
  } finally {
    if (server.child.exitCode === null) {
      try { server.child.kill('SIGTERM'); } catch (e) { /* gone */ }
      await Promise.race([once(server.child, 'exit'), sleep(4000)]);
    }
  }
});
