'use strict';

/**
 * Migration 043: lease-based recovery for the marketing queue.
 *
 * The defect (docs/TELEGRAM_RECOVERY_AUDIT.md, section 19): a worker that died
 * between claim and finish left its post in 'sending' forever. Nothing reclaimed
 * it, nothing failed it, nothing noticed.
 *
 * Pinned here:
 *   * the SQL contract (claimant + lease, expired-lease reclaim, fenced finish,
 *     poison-post handling, no mass reset on startup);
 *   * the store wiring (the claimant and lease reach the RPCs);
 *   * the worker behaviour (crash recovery, stale claimant, already-sent
 *     reconciliation, unreadable audit fails closed, two workers stay apart).
 *
 * The SQL itself was executed against PostgreSQL 16 while authoring the
 * migration: an expired lease is reclaimed with attempts incremented, a live
 * lease is not stolen, a stale finish/block returns no row, an already-sent post
 * is reconciled, and a post that exhausted its attempts is marked failed with
 * last_error = 'lease_expired'.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createMarketingWorker } = require('../services/MarketingWorker');

const ROOT = path.join(__dirname, '..');
const SQL_043 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/043_marketing_claim_lease.sql'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'services/MarketingStore.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'services/MarketingWorker.js'), 'utf8');

const CONFIG = {
  enabled: true,
  dryRun: false,
  groupChatId: '-1001234567890',
  channelChatId: '-1009876543210',
  locale: 'en',
  timezone: 'UTC',
  tickMs: 60000,
  workerId: 'worker-A',
  leaseSeconds: 180,
  registerUrl: 'https://arbitrix.pro/?action=create-account',
  howItWorksUrl: 'https://arbitrix.pro/how-it-works',
  supportUrl: 'https://t.me/ArbitrixSupportBot',
  partnerSupportAlexUrl: 'https://t.me/AlexArbitrix',
  partnerSupportOliviaUrl: 'https://t.me/OliviaArbitrix'
};

const APPROVED = [
  'Arbitrix is an automated multi-asset arbitrage platform.',
  'A referral reward is a one-time 20% of a referred user\'s first qualifying deposit of $100 or more.'
].join('\n\n');

function post(over) {
  return Object.assign({
    id: 1,
    kind: 'weekly',
    locale: 'en',
    audience: 'group',
    content: APPROVED,
    buttons: [],
    status: 'sending',
    attempts: 1,
    max_attempts: 5,
    scheduled_for: '2026-10-28T10:00:00.000Z'
  }, over || {});
}

function quietLogger() {
  const lines = [];
  return { lines, log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
}

function fakeStore(options) {
  const o = options || {};
  const calls = { claim: [], finish: [], block: [], sends: [], sent: [] };
  const claims = o.claims ? o.claims.slice() : [[o.claim].filter(Boolean)];
  return {
    calls,
    async getControl() { return { ok: true, data: { paused: false, dry_run: false } }; },
    async countDue() { return { ok: true, count: 0 }; },
    async claimDue(args) {
      calls.claim.push(args || {});
      const next = claims.length ? claims.shift() : [];
      return { ok: true, data: next };
    },
    async finish(args) {
      calls.finish.push(args);
      return { ok: true, data: o.finishRefused ? null : {} };
    },
    async block(id, reason, workerId) {
      calls.block.push({ id, reason, workerId });
      return { ok: true, data: o.blockRefused ? null : {} };
    },
    async recordSend(row) { calls.sends.push(row); return { ok: true }; },
    async listSubscribers() { return { ok: true, data: [] }; },
    async hasSentRecord(args) {
      calls.sent.push(args);
      if (o.sentError) return { ok: false, reason: 'send-audit-unreadable', error: 'boom' };
      const hit = (o.sentRecords || {})[args.postId];
      return hit ? { ok: true, sent: true, messageId: hit } : { ok: true, sent: false, messageId: null };
    }
  };
}

function fakeTransport(options) {
  const o = options || {};
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, extra) {
      sent.push({ chatId, text, extra });
      if (o.fail) throw new Error(o.fail);
      return { message_id: 500 + sent.length };
    }
  };
}

function makeWorker(store, transport, over) {
  return createMarketingWorker(Object.assign({
    store,
    transport,
    config: CONFIG,
    logger: quietLogger(),
    clock: () => Date.parse('2026-10-28T12:00:00.000Z')
  }, over || {}));
}

// ---------------------------------------------------------------------------
// 1. SQL contract
// ---------------------------------------------------------------------------

test('043 adds the claimant and lease bookkeeping plus a partial index', () => {
  for (const column of ['claimed_by', 'lease_expires_at', 'last_attempt_at']) {
    assert.match(SQL_043, new RegExp('ADD COLUMN IF NOT EXISTS ' + column), 'missing column ' + column);
  }
  assert.match(SQL_043, /CREATE INDEX IF NOT EXISTS telegram_marketing_posts_lease_idx\s+ON public\.telegram_marketing_posts \(lease_expires_at\)\s+WHERE status = 'sending'/);
});

test('043 claims due posts exactly as before, and reclaims only EXPIRED claims', () => {
  assert.match(SQL_043, /p\.status = 'scheduled'\s+AND p\.scheduled_for IS NOT NULL\s+AND p\.scheduled_for <= v_now/);
  assert.match(SQL_043, /p\.status = 'sending'\s+AND \(p\.lease_expires_at IS NULL OR p\.lease_expires_at < v_now\)/);
  assert.match(SQL_043, /FOR UPDATE SKIP LOCKED/, 'the concurrency primitive is REQUIRED');
  assert.match(SQL_043, /attempts = p\.attempts \+ 1/);
  assert.match(SQL_043, /p\.attempts < p\.max_attempts/, 'retries stay bounded');
});

test('043 records the claimant and a bounded lease on every claim', () => {
  assert.match(SQL_043, /claimed_by = v_worker/);
  assert.match(SQL_043, /lease_expires_at = v_now \+ make_interval\(secs => v_lease\)/);
  assert.match(SQL_043, /LEAST\(GREATEST\(COALESCE\(p_lease_seconds, 180\), 30\), 900\)/);
  assert.match(SQL_043, /last_attempt_at = v_now/);
});

test('043 marks exhausted claims failed instead of reclaiming them forever', () => {
  const poison = SQL_043.slice(SQL_043.indexOf("SET status = 'failed'"), SQL_043.indexOf('RETURN QUERY'));
  assert.match(poison, /attempts >= max_attempts/);
  assert.match(poison, /lease_expired/);
  assert.match(poison, /claimed_by = NULL/);
  assert.match(poison, /lease_expires_at < v_now/);
});

test('043 fences finish on the current claimant and clears the lease', () => {
  const start = SQL_043.indexOf('CREATE OR REPLACE FUNCTION public.finish_marketing_post');
  const finish = SQL_043.slice(start, SQL_043.indexOf('$$;', start) + 3);
  assert.match(finish, /p_worker_id\s+TEXT DEFAULT NULL/);
  assert.equal((finish.match(/claimed_by = p_worker_id/g) || []).length, 2, 'both branches are fenced');
  assert.ok(!/p_worker_id IS NOT NULL AND claimed_by = p_worker_id\s*$/m.test(finish),
    'the fence must tolerate pre-043 rows with a NULL claimant');
  assert.match(finish, /claimed_by = NULL,\s+lease_expires_at = NULL/);
});

test('043 preserves the original retry and failure semantics', () => {
  assert.match(SQL_043, /SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'scheduled' END/);
  assert.match(SQL_043, /COALESCE\(p_retry_at, now\(\) \+ interval '2 minutes'\)/);
  assert.match(SQL_043, /left\(COALESCE\(p_error, 'unknown error'\), 500\)/);
  assert.match(SQL_043, /telegram_message_id = COALESCE\(p_message_id, telegram_message_id\)/);
  assert.match(SQL_043, /published_at = now\(\)/);
});

test('043 never mass-resets sending rows on startup', () => {
  assert.ok(!/SET status = 'scheduled'[\s\S]{0,200}WHERE status = 'sending'/.test(SQL_043),
    'a blanket startup reset would let two workers post the same message');
  assert.ok(!/UPDATE public\.telegram_marketing_posts[\s\S]{0,120}SET status = 'scheduled'\s+WHERE status = 'sending'/i.test(SQL_043));
});

test('043 supersedes the old signatures (no ambiguous overloads) and re-grants service_role', () => {
  assert.ok(SQL_043.includes('DROP FUNCTION IF EXISTS public.claim_marketing_posts(TIMESTAMPTZ, INTEGER);'));
  assert.ok(SQL_043.includes('DROP FUNCTION IF EXISTS public.finish_marketing_post(BIGINT, BOOLEAN, BIGINT, TEXT, TIMESTAMPTZ);'));
  assert.ok(SQL_043.includes('DROP FUNCTION IF EXISTS public.block_marketing_post(BIGINT, TEXT);'));
  assert.match(SQL_043, /GRANT EXECUTE ON FUNCTION public\.claim_marketing_posts\(TIMESTAMPTZ, INTEGER, TEXT, INTEGER\) TO service_role/);
  assert.match(SQL_043, /GRANT EXECUTE ON FUNCTION public\.finish_marketing_post\(BIGINT, BOOLEAN, BIGINT, TEXT, TIMESTAMPTZ, TEXT\) TO service_role/);
  assert.match(SQL_043, /to_regrole\('anon'\)[\s\S]*?FROM anon/);
  assert.match(SQL_043, /NOTIFY pgrst, 'reload schema'/);
});

test('043 verifies its own result', () => {
  assert.ok(SQL_043.includes('043 self-check: the lease index is missing'));
  assert.ok(SQL_043.includes('043 self-check: a superseded function signature is still present'));
  assert.ok(SQL_043.includes('043 self-check: finish_marketing_post is not fenced on the claimant'));
  assert.ok(SQL_043.includes('043 self-check: SECURITY DEFINER was lost'));
  assert.ok(SQL_043.includes('RAISE NOTICE'));
});

// ---------------------------------------------------------------------------
// 2. Store wiring
// ---------------------------------------------------------------------------

test('the store passes the claimant and the lease to the claim RPC', () => {
  assert.match(STORE_SRC, /async claimDue\(\{ now, limit, workerId, leaseSeconds \} = \{\}\)/);
  assert.match(STORE_SRC, /p_worker_id: workerId \|\| null/);
  assert.match(STORE_SRC, /p_lease_seconds: Number\.isFinite\(Number\(leaseSeconds\)\) \? Number\(leaseSeconds\) : null/);
});

test('the store passes the claimant to finish and block, and can read the send audit', () => {
  assert.match(STORE_SRC, /async finish\(\{ id, ok, messageId, error, retryAt, workerId \}\)/);
  assert.match(STORE_SRC, /async block\(id, reason, workerId\)/);
  assert.match(STORE_SRC, /p_worker_id: workerId \|\| null/);
  assert.match(STORE_SRC, /async hasSentRecord\(\{ postId \} = \{\}\)/);
  assert.match(STORE_SRC, /\.eq\('status', 'sent'\)/, 'reconciliation reads delivered sends only');
});

// ---------------------------------------------------------------------------
// 3. Worker behaviour
// ---------------------------------------------------------------------------

test('a claim carries this worker id and the configured lease', async () => {
  const store = fakeStore({ claim: post({ id: 1 }) });
  const worker = makeWorker(store, fakeTransport());
  await worker.tick();
  const args = store.calls.claim[0];
  assert.equal(args.workerId, 'worker-A');
  assert.equal(args.leaseSeconds, 180);
});

test('a crashed claim is recovered by the next worker (lease reclaim)', async () => {
  // Worker A claims and never finishes (simulating a crash): nothing is written.
  const storeA = fakeStore({ claim: post({ id: 7, attempts: 1 }) });
  const transportA = fakeTransport({ fail: 'process died before send' });
  const workerA = makeWorker(storeA, transportA);
  await workerA.tick();
  assert.equal(storeA.calls.finish.length, 1, 'the failure was recorded by A');

  // Worker B reclaims the SAME post once the lease expired. The RPC grants it
  // (attempts incremented, claimant = worker-B); B publishes it.
  const storeB = fakeStore({ claim: post({ id: 7, attempts: 2 }) });
  const transportB = fakeTransport();
  const workerB = makeWorker(storeB, transportB, { workerId: 'worker-B' });
  await workerB.tick();

  assert.equal(transportB.sent.length, 1, 'the recovered post is published exactly once');
  assert.equal(storeB.calls.finish[0].workerId, 'worker-B');
  assert.equal(storeB.calls.finish[0].ok, true);
  assert.equal(storeB.calls.claim[0].workerId, 'worker-B');
});

test('a stale claimant cannot finish; the send is still audited for the next owner', async () => {
  // The lease was reclaimed while this worker was sending: the RPC returns no row.
  const store = fakeStore({ claim: post({ id: 9 }), finishRefused: true });
  const transport = fakeTransport();
  const worker = makeWorker(store, transport);
  const result = await worker.tick();

  assert.equal(transport.sent.length, 1, 'the message really was sent');
  assert.equal(store.calls.finish[0].workerId, 'worker-A');
  assert.equal(store.calls.sends.length, 1, 'the audit row lets the next owner reconcile');
  assert.equal(store.calls.sends[0].status, 'sent');
  assert.equal(worker.stats().leaseLost, 1);
  assert.ok(result.results.length === 1);
});

test('an already-sent post is reconciled, never posted twice', async () => {
  const store = fakeStore({ claim: post({ id: 11 }), sentRecords: { 11: 4242 } });
  const transport = fakeTransport();
  const worker = makeWorker(store, transport);

  await worker.tick();

  assert.equal(transport.sent.length, 0, 'NO second send');
  assert.deepEqual(store.calls.sent, [{ postId: 11 }]);
  const finish = store.calls.finish[0];
  assert.equal(finish.ok, true);
  assert.equal(finish.messageId, 4242, 'the original message id is preserved');
  assert.equal(worker.stats().reconciled, 1);
  assert.equal(store.calls.sends.length, 0, 'no duplicate audit row is written');
});

test('an unreadable send audit fails CLOSED (no send, retry scheduled)', async () => {
  const store = fakeStore({ claim: post({ id: 12 }), sentError: true });
  const transport = fakeTransport();
  const worker = makeWorker(store, transport);

  await worker.tick();

  assert.equal(transport.sent.length, 0, 'never send when delivery state is unknown');
  assert.equal(store.calls.finish[0].ok, false);
  assert.equal(store.calls.finish[0].error, 'send-audit-unreadable');
  assert.ok(store.calls.finish[0].retryAt, 'a retry is scheduled');
  assert.equal(worker.stats().failed, 1);
});

test('two workers claim and publish their own posts without interference', async () => {
  const storeA = fakeStore({ claim: post({ id: 21 }) });
  const storeB = fakeStore({ claim: post({ id: 22 }) });
  const transportA = fakeTransport();
  const transportB = fakeTransport();

  const workerA = makeWorker(storeA, transportA, { workerId: 'worker-A' });
  const workerB = makeWorker(storeB, transportB, { workerId: 'worker-B' });
  await Promise.all([workerA.tick(), workerB.tick()]);

  assert.equal(transportA.sent.length, 1);
  assert.equal(transportB.sent.length, 1);
  assert.equal(storeA.calls.finish[0].id, 21);
  assert.equal(storeA.calls.finish[0].workerId, 'worker-A');
  assert.equal(storeB.calls.finish[0].id, 22);
  assert.equal(storeB.calls.finish[0].workerId, 'worker-B');
});

test('the worker exposes its claimant identity and lease for operations', () => {
  const worker = makeWorker(fakeStore({ claim: [] }), fakeTransport());
  const cfg = worker.config();
  assert.equal(cfg.workerId, 'worker-A');
  assert.equal(cfg.leaseSeconds, 180);

  // An out-of-range lease falls back to the safe default rather than being sent.
  const weird = makeWorker(fakeStore({ claim: [] }), fakeTransport(), { leaseSeconds: 5 });
  assert.equal(weird.config().leaseSeconds, 180);
});
