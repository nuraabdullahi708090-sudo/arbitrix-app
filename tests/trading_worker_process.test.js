/**
 * Process-level tests for the server-side trading worker.
 *
 * These spawn the REAL worker.js against a PostgREST-shaped stub, because the
 * most important failure mode this worker can have is "it looks fine but never
 * actually runs". A staging run on real Postgres caught exactly that: the tick
 * interval called timer.unref(), so the event loop drained and the process
 * exited right after logging worker_started - no ticks, no trades, ever. None of
 * the in-process unit tests could see it because they call runOnce() directly.
 *
 * No database is required: the stub only needs to answer like PostgREST.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const WORKER_PROCESS_SRC = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');

function startStub() {
  const state = { rpcs: 0, stops: 0, patches: 0, claims: 0, renews: 0, releases: 0, writes: 0, control: { id: 1, emergency_stop: false, reason: null, engaged_by: null, engaged_at: null } };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      // Anything that is not a read is a WRITE. Dry-run must produce ZERO of them.
      if (req.method !== 'GET' && req.method !== 'HEAD') state.writes++;
      const p = new URL(req.url, 'http://x').pathname;
      const single = (req.headers.accept || '').includes('object+json');
      const json = (code, data, extra = {}) => {
        res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, extra));
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      if (p === '/rest/v1/rpc/record_trade_safe') { state.rpcs++; return json(200, { success: true, applied_amount: 0.5, new_balance: 999.5 }); }
      // Executor lease (migration 029): the worker CLAIMS work and RENEWS its
      // lease before it may trade, so the stub must answer like the RPCs do.
      if (p === '/rest/v1/rpc/claim_bot_sessions') {
        state.claims++;
        const now = new Date();
        return json(200, {
          success: true,
          server_now: now.toISOString(),
          claimed: [{
            user_id: 1, is_running: 1, generation: 0, claimed_by: 'stub-worker',
            lease_expires_at: new Date(now.getTime() + 30000).toISOString(),
            consecutive_failures: 0, tick_count: 0,
          }],
        });
      }
      if (p === '/rest/v1/rpc/renew_bot_session_lease') {
        state.renews++;
        const now = new Date();
        return json(200, {
          success: true, renewed: true, code: null, server_now: now.toISOString(),
          generation: 0, is_running: 1, claimed_by: 'stub-worker',
          lease_expires_at: new Date(now.getTime() + 30000).toISOString(),
        });
      }
      if (p === '/rest/v1/rpc/release_bot_session_lease') { state.releases++; return json(200, { success: true, released: true, server_now: new Date().toISOString() }); }
      if (p === '/rest/v1/bot_worker_control') return json(200, single ? state.control : [state.control]);
      if (p === '/rest/v1/bot_sessions' && req.method === 'PATCH') { state.patches++; state.stops++; return json(204); }
      if (p === '/rest/v1/bot_sessions') return json(200, [{ user_id: 1, is_running: 1, mode: 'live', heartbeat_at: new Date().toISOString(), tick_count: 0, consecutive_failures: 0 }]);
      if (p === '/rest/v1/wallets') return json(200, single ? { live_balance: 1000 } : [{ live_balance: 1000 }]);
      if (p === '/rest/v1/trades') return json(200, []);
      if (p === '/rest/v1/deposits') return req.method === 'HEAD' ? json(200, undefined, { 'content-range': '0-0/1' }) : json(200, []);
      if (p === '/rest/v1/transactions') return req.method === 'HEAD' ? json(200, undefined, { 'content-range': '0-0/0' }) : json(200, []);
      if (p === '/rest/v1/referral_earning_conversions') return json(200, []);
      if (p === '/rest/v1/users') return json(200, single ? { environment: 'PRODUCTION' } : [{ environment: 'PRODUCTION' }]);
      return json(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

async function runWorkerFor(ms, env = {}) {
  const { server, state, port } = await startStub();
  const child = spawn('node', [path.join(ROOT, 'worker.js')], {
    env: Object.assign({}, process.env, {
      SUPABASE_URL: 'http://127.0.0.1:' + port,
      SUPABASE_SERVICE_KEY: 'stub-key-not-a-secret',
      TRADING_WORKER_ENABLED: 'true',
      TRADING_WORKER_TICK_MS: '120',
      TRADING_WORKER_DEBUG: 'true',
    }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, ms));
  const aliveAfterWindow = child.exitCode === null;
  child.kill('SIGTERM');
  const exitCode = await new Promise((r) => { child.on('exit', (code) => r(code)); setTimeout(() => r('timeout'), 3000); });
  server.close();
  return { out, state, aliveAfterWindow, exitCode };
}

test('worker process stays alive after start and keeps ticking (regression: timer.unref() made it exit immediately)', async () => {
  const { out, state, aliveAfterWindow } = await runWorkerFor(2200);
  assert.strictEqual(aliveAfterWindow, true, 'the worker exited on its own right after start; log:\n' + out.slice(0, 600));
  const ticks = (out.match(/"event":"tick_complete"/g) || []).length;
  assert.ok(ticks >= 2, 'expected at least 2 completed ticks, saw ' + ticks + '; log:\n' + out.slice(0, 600));
  assert.ok(state.rpcs >= 1, 'the tick must reach the trade RPC; log:\n' + out.slice(0, 600));
  // Lease mode (migration 029): a tick may only trade after claiming the session
  // and renewing (verifying) its lease, so those RPCs must have been reached too.
  assert.ok(state.claims >= 1, 'the worker must claim sessions through the lease RPC; log:\n' + out.slice(0, 600));
  assert.ok(state.renews >= 1, 'the worker must renew/fence the lease before trading; log:\n' + out.slice(0, 600));
});

test('trading needs NO browser: ticks and trades accumulate with no client attached', async () => {
  const { out, state } = await runWorkerFor(2200);
  // The spawned process IS the server-side worker. Nothing here simulates a
  // browser tab: if the loop depended on one, there would be no RPC calls.
  assert.ok(state.rpcs >= 2, 'expected repeated RPC calls with no client, saw ' + state.rpcs);
  assert.ok(/"event":"trade_recorded"/.test(out), 'no trade was recorded');
});

test('SIGTERM shuts the worker down cleanly (exit 0) and logs it', async () => {
  const { out, exitCode } = await runWorkerFor(900);
  assert.strictEqual(exitCode, 0, 'exit code was ' + exitCode + '; log:\n' + out.slice(0, 600));
  assert.match(out, /"event":"worker_shutdown"|"event":"worker_stopped"/);
});

test('the worker never keeps trading once the process is signalled to stop', async () => {
  const { out, state } = await runWorkerFor(900);
  const rpcsAtStop = state.rpcs;
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(state.rpcs, rpcsAtStop, 'RPCs continued after shutdown');
  assert.match(out, /worker_shutdown|worker_stopped/);
});

test('worker.js has no unref() on its tick timer and logs start + shutdown', () => {
  const svc = fs.readFileSync(path.join(ROOT, 'services/TradingWorker.js'), 'utf8');
  assert.ok(!/timer\.unref/.test(svc), 'unref() lets the event loop drain and the worker exit immediately');
  assert.match(WORKER_PROCESS_SRC, /event: 'worker_shutdown'/);
  assert.match(WORKER_PROCESS_SRC, /process\.on\('SIGTERM'/);
});

test('dry run (process level): the REAL worker writes nothing at all', async () => {
  const { out, state, aliveAfterWindow } = await runWorkerFor(1400, { TRADING_WORKER_DRY_RUN: 'true' });

  assert.strictEqual(aliveAfterWindow, true, 'the dry-run worker must stay alive');
  assert.ok((out.match(/"event":"tick_complete"/g) || []).length >= 2, 'dry run must still tick; log:\n' + out.slice(0, 600));
  assert.ok(/"event":"dry_run_trade"/.test(out), 'dry run must report what it WOULD write');
  assert.ok(/"wouldWrite":\{"rpc":"record_trade_safe"/.test(out), 'the intended write must be named');

  // ZERO writes of any kind: no trade RPC, no lease RPC, no session mutation.
  assert.strictEqual(state.writes, 0, 'dry run performed ' + state.writes + ' write request(s)');
  assert.strictEqual(state.rpcs, 0, 'dry run must never reach record_trade_safe');
  assert.strictEqual(state.claims, 0, 'dry run must not claim a lease');
  assert.strictEqual(state.renews, 0, 'dry run must not renew a lease');
  assert.strictEqual(state.releases, 0, 'dry run must not release a lease');
  assert.strictEqual(state.patches, 0, 'dry run must not mutate bot_sessions (no heartbeat/stop)');
  assert.ok(!/"event":"trade_recorded"/.test(out), 'no trade may be recorded');
});

test('migration 028 declares bot_sessions.updated_at (a column the stop path writes)', () => {
  const migration = fs.readFileSync(path.join(ROOT, 'supabase/migrations/028_trading_worker.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ/);
  const selfCheck = migration.slice(migration.indexOf('FOREACH v_col IN ARRAY'));
  assert.match(selfCheck, /'updated_at'/);
});

test('no migration creates bot_sessions, so the worker must tolerate its columns being added by 028', () => {
  const dir = path.join(ROOT, 'supabase/migrations');
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/CREATE TABLE (IF NOT EXISTS )?public\.bot_sessions/.test(s), f + ' creates bot_sessions');
  }
});

test('session stop/heartbeat results are inspected (supabase-js resolves with {error} instead of throwing)', () => {
  const svc = fs.readFileSync(path.join(ROOT, 'services/TradingWorker.js'), 'utf8');
  const stop = svc.slice(svc.indexOf('async function stopSession'), svc.indexOf('async function stopAllSessions'));
  assert.ok(/withRetry\(/.test(stop), 'stop must be retried/error-aware');
  assert.ok(/if \(!res\.ok\)/.test(stop), 'stop must branch on the resolved result');
  assert.match(stop, /session_stop_failed/);
  assert.match(stop, /return false/);
  const hb = svc.slice(svc.indexOf('async function heartbeat'), svc.indexOf('One evaluation of one session'));
  assert.ok(/withRetry\(/.test(hb), 'heartbeat must be error-aware');
});

test('emergency-stop route reports the truth when the session-stop write fails', () => {
  const body = SERVER.slice(SERVER.indexOf("app.post('/api/admin/bot/emergency-stop'"), SERVER.indexOf("app.post('/api/admin/bot/emergency-stop/clear'"));
  // Every running session is stopped through the FENCED stop (generation bump),
  // and the route only counts a session it actually stopped.
  assert.match(body, /for \(const id of ids\)/);
  assert.match(body, /await stopBotSessionFenced\(id, 'emergency_stop', engagedBy\)/);
  assert.match(body, /if \(outcome\.stopped\) sessionsStopped\+\+;/);
  assert.match(body, /if \(!outcome\.stopped && outcome\.error\) sessionsStopError = outcome\.error;/);
  assert.match(body, /sessionsStopError/);
  assert.match(body, /sessionsFenced/);
});
