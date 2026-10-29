'use strict';

/**
 * Marketing publisher completeness:
 *   - worker liveness (heartbeat) and the migration that stores it
 *   - the channel/group destination guard
 *   - the single-shot controlled delivery test
 *   - admin action states that must never resurrect a published post
 *   - 429 retry_after propagation
 *
 * Everything here is offline: no database, no Telegram call and no send.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveMarketingConfig,
  describeMarketingConfig,
  workerHealth,
  WORKER_HEARTBEAT_STALE_MS,
  retryAfterMs
} = require('../services/TelegramBroadcast');
const { createMarketingWorker } = require('../services/MarketingWorker');
const { createTelegramTransport } = require('../services/TelegramSupportService');
const { render, renderTestMessage } = require('../services/MarketingContent');
const { checkContent } = require('../services/ContentGuard');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const MIGRATION_044 = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/044_marketing_worker_heartbeat.sql'), 'utf8');

const GROUP = '-1001234567890';
const CHANNEL = '-1009876543210';

const CONFIG = {
  enabled: true,
  dryRun: false,
  groupChatId: GROUP,
  channelChatId: CHANNEL,
  locale: 'en',
  timezone: 'UTC',
  tickMs: 60000,
  workerId: 'test-worker',
  leaseSeconds: 180,
  registerUrl: 'https://arbitrix.pro/?action=create-account',
  howItWorksUrl: 'https://arbitrix.pro/how-it-works',
  supportUrl: 'https://t.me/ArbitrixSupportBot',
  partnerSupportAlexUrl: 'https://t.me/AlexArbitrix',
  partnerSupportOliviaUrl: 'https://t.me/OliviaArbitrix',
  announcementUrl: 'https://t.me/ArbitrixChannel',
  facts: { minDeposit: 100, referralPercent: 20, promoCredit: 50 }
};

function post(over) {
  return Object.assign({
    id: 1,
    kind: 'weekly',
    theme: 'wed',
    locale: 'en',
    audience: 'channel',
    chat_id: null,
    content: render('weekly', 'en', CONFIG).text,
    buttons: [],
    status: 'sending',
    attempts: 1,
    max_attempts: 5
  }, over || {});
}

function fakeStore(options) {
  const o = options || {};
  const calls = { heartbeat: [], claim: 0, finish: [], block: [], sends: [] };
  return {
    calls,
    async heartbeat(args) {
      calls.heartbeat.push(args || {});
      if (o.heartbeatError) return { ok: false, reason: 'heartbeat-failed', error: 'boom' };
      if (o.heartbeatThrows) throw new Error('network down');
      return { ok: true, data: { worker_heartbeat_at: new Date().toISOString() } };
    },
    async getControl() {
      return o.control || { ok: true, data: { paused: false, dry_run: false } };
    },
    async countDue() { return { ok: true, count: 0 }; },
    async claimDue() {
      calls.claim += 1;
      return { ok: true, data: o.claims || [] };
    },
    async finish(args) { calls.finish.push(args); return { ok: true, data: {} }; },
    async block(id, reason, workerId) { calls.block.push({ id, reason, workerId }); return { ok: true, data: {} }; },
    async hasSentRecord() { return { ok: true, sent: false, messageId: null }; },
    async recordSend(row) { calls.sends.push(row); return { ok: true }; },
    async listSubscribers() { return { ok: true, data: [] }; }
  };
}

function fakeTransport(options) {
  const o = options || {};
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, opts) {
      if (o.error) throw o.error;
      sent.push({ chatId, text, opts: opts || {} });
      return { message_id: 555 };
    }
  };
}

function worker(store, transport, config) {
  return createMarketingWorker({
    store,
    transport,
    config: Object.assign({}, CONFIG, config || {}),
    workerId: 'test-worker',
    leaseSeconds: 180,
    logger: { log() {} },
    clock: () => 1700000000000
  });
}

// ---------------------------------------------------------------------------
// A. Channel is never the partner group
// ---------------------------------------------------------------------------

test('a channel id that equals the group id disables the CHANNEL, not the group', () => {
  const cfg = resolveMarketingConfig({
    TELEGRAM_MARKETING_CHAT_ID: GROUP,
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: GROUP
  });
  assert.strictEqual(cfg.groupChatId, GROUP, 'the group must keep working');
  assert.strictEqual(cfg.channelChatId, '', 'the channel must be disabled, not pointed at the group');
  assert.strictEqual(cfg.channelConflictsWithGroup, true);
});

test('distinct ids are untouched and report no conflict', () => {
  const cfg = resolveMarketingConfig({
    TELEGRAM_MARKETING_CHAT_ID: GROUP,
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: CHANNEL
  });
  assert.strictEqual(cfg.groupChatId, GROUP);
  assert.strictEqual(cfg.channelChatId, CHANNEL);
  assert.strictEqual(cfg.channelConflictsWithGroup, false);
  assert.strictEqual(describeMarketingConfig(cfg).channelConflictsWithGroup, false);
});

test('the status summary exposes the conflict so an operator can see it', () => {
  const cfg = resolveMarketingConfig({
    TELEGRAM_MARKETING_CHAT_ID: GROUP,
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: GROUP
  });
  const described = describeMarketingConfig(cfg);
  assert.strictEqual(described.channelConfigured, false);
  assert.strictEqual(described.channelConflictsWithGroup, true);
});

test('a channel post in a conflicting configuration is never delivered to the group', async () => {
  const conflicting = Object.assign({}, CONFIG, {
    channelChatId: '',
    channelConflictsWithGroup: true
  });
  const store = fakeStore({ claims: [post({ audience: 'channel' })] });
  const transport = fakeTransport();
  const result = await worker(store, transport, conflicting).tick();
  assert.strictEqual(transport.sent.length, 0);
  assert.strictEqual(result.results[0].result, 'destination-invalid');
  assert.match(result.results[0].reason, /announcement-channel-not-configured/);
  assert.strictEqual(store.calls.finish[0].ok, false);
});

// ---------------------------------------------------------------------------
// B. Channel copy links registration, How It Works and support
// ---------------------------------------------------------------------------

test('the channel intro carries registration, How It Works and support links', () => {
  for (const locale of ['en', 'pt', 'ar']) {
    const out = render('channelIntro', locale, CONFIG);
    assert.ok(out.text.includes(CONFIG.registerUrl), locale + ' must link registration');
    assert.ok(out.text.includes(CONFIG.howItWorksUrl), locale + ' must link How It Works');
    assert.ok(out.text.includes(CONFIG.supportUrl), locale + ' must link customer support');
    assert.strictEqual(checkContent(out.text, { locale, minDeposit: 100, referralPercent: 20 }).blocked, false);
  }
});

test('scheduled channel posts carry the How It Works link too', () => {
  for (const theme of ['tue', 'thu', 'sat', 'sun']) {
    const out = render('weekly', 'en', Object.assign({}, CONFIG, { theme }));
    assert.ok(out.text.includes(CONFIG.howItWorksUrl), theme + ' must link How It Works');
  }
});

test('a missing How It Works URL drops only that line', () => {
  const text = render('channelIntro', 'en', Object.assign({}, CONFIG, { howItWorksUrl: '' })).text;
  assert.ok(!text.includes('how-it-works'));
  assert.ok(text.includes(CONFIG.registerUrl));
});

// ---------------------------------------------------------------------------
// C. Worker heartbeat
// ---------------------------------------------------------------------------

test('migration 044 adds the three heartbeat columns additively and idempotently', () => {
  assert.match(MIGRATION_044, /ADD COLUMN IF NOT EXISTS worker_heartbeat_at TIMESTAMPTZ/);
  assert.match(MIGRATION_044, /ADD COLUMN IF NOT EXISTS worker_id\s+TEXT/);
  assert.match(MIGRATION_044, /ADD COLUMN IF NOT EXISTS worker_version\s+TEXT/);
  assert.match(MIGRATION_044, /BEGIN;/);
  assert.match(MIGRATION_044, /COMMIT;/);
  assert.match(MIGRATION_044, /RAISE EXCEPTION '044 self-check/);
});

test('migration 044 never changes the publishing gates or a money object', () => {
  assert.ok(!/SET\s+paused\s*=/i.test(MIGRATION_044), 'must not set paused');
  assert.ok(!/SET\s+dry_run\s*=/i.test(MIGRATION_044), 'must not set dry_run');
  for (const forbidden of ['wallets', 'transactions', 'deposits', 'withdrawals', 'trades', 'sandbox_']) {
    assert.ok(!MIGRATION_044.includes(forbidden), 'must not reference ' + forbidden);
  }
});

test('the worker writes a heartbeat on every tick, before any gate', async () => {
  const store = fakeStore();
  const w = worker(store, fakeTransport());
  await w.tick();
  assert.strictEqual(store.calls.heartbeat.length, 1);
  assert.strictEqual(store.calls.heartbeat[0].workerId, 'test-worker');
  assert.strictEqual(w.stats().lastHeartbeatAt, new Date(1700000000000).toISOString());
  assert.strictEqual(w.stats().lastHeartbeatError, null);
});

test('a paused worker still reports liveness', async () => {
  const store = fakeStore({ control: { ok: true, data: { paused: true, dry_run: false } } });
  const w = worker(store, fakeTransport());
  const out = await w.tick();
  assert.strictEqual(out.skipped, 'paused');
  assert.strictEqual(store.calls.heartbeat.length, 1, 'a paused worker is alive and must say so');
});

test('a dry-run worker still reports liveness', async () => {
  const store = fakeStore({ control: { ok: true, data: { paused: false, dry_run: true } } });
  const w = worker(store, fakeTransport());
  const out = await w.tick();
  assert.strictEqual(out.skipped, 'dry-run');
  assert.strictEqual(store.calls.heartbeat.length, 1);
});

test('a heartbeat failure is recorded but never blocks a publish', async () => {
  const store = fakeStore({ heartbeatError: true, claims: [post({ audience: 'channel' })] });
  const transport = fakeTransport();
  const w = worker(store, transport);
  await w.tick();
  assert.strictEqual(transport.sent.length, 1, 'the post must still be published');
  assert.strictEqual(w.stats().lastHeartbeatError, 'heartbeat-failed');
  assert.strictEqual(w.stats().lastHeartbeatAt, null);
});

test('a throwing heartbeat is swallowed and never breaks the tick', async () => {
  const store = fakeStore({ heartbeatThrows: true, claims: [post({ audience: 'channel' })] });
  const transport = fakeTransport();
  const w = worker(store, transport);
  const out = await w.tick();
  assert.strictEqual(transport.sent.length, 1);
  assert.match(w.stats().lastHeartbeatError, /network down/);
  assert.strictEqual(out.claimed, 1);
});

test('a store without a heartbeat method still publishes (backwards compatible)', async () => {
  const store = fakeStore({ claims: [post({ audience: 'channel' })] });
  delete store.heartbeat;
  const transport = fakeTransport();
  const out = await worker(store, transport).tick();
  assert.strictEqual(transport.sent.length, 1);
  assert.strictEqual(out.claimed, 1);
});

test('worker config reports the version so a stale deploy is visible', () => {
  const w = worker(fakeStore(), fakeTransport());
  assert.strictEqual(w.config().workerVersion, 'marketing-worker/1');
});

// ---------------------------------------------------------------------------
// D. workerHealth evaluation
// ---------------------------------------------------------------------------

test('workerHealth: a fresh heartbeat is healthy', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const health = workerHealth({ worker_heartbeat_at: '2026-01-01T11:58:30Z', worker_id: 'w1', worker_version: 'v1' }, { now });
  assert.strictEqual(health.healthy, true);
  assert.strictEqual(health.ageMs, 90000);
  assert.strictEqual(health.workerId, 'w1');
  assert.strictEqual(health.note, null);
});

test('workerHealth: a stale heartbeat is unhealthy', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const health = workerHealth({ worker_heartbeat_at: '2026-01-01T11:00:00Z' }, { now });
  assert.strictEqual(health.healthy, false);
  assert.match(health.note, /older than the stale window/);
});

test('workerHealth: no heartbeat is unhealthy and explains why', () => {
  for (const control of [null, {}, { worker_heartbeat_at: null }, { worker_heartbeat_at: 'not-a-date' }]) {
    const health = workerHealth(control);
    assert.strictEqual(health.healthy, false);
    assert.strictEqual(health.ageMs, null);
    assert.match(health.note, /no heartbeat recorded/);
  }
});

test('workerHealth: a future timestamp cannot produce a negative age', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const health = workerHealth({ worker_heartbeat_at: '2026-01-01T12:05:00Z' }, { now });
  assert.strictEqual(health.ageMs, 0);
  assert.strictEqual(health.healthy, true);
});

test('workerHealth: the stale window is three default ticks', () => {
  assert.strictEqual(WORKER_HEARTBEAT_STALE_MS, 180000);
  assert.strictEqual(workerHealth({}).staleAfterMs, WORKER_HEARTBEAT_STALE_MS);
  assert.strictEqual(workerHealth({}, { staleMs: 5000 }).staleAfterMs, 5000);
});

test('the admin status route reports heartbeat and queue counts', () => {
  const block = SERVER.slice(
    SERVER.indexOf("app.get('/api/admin/marketing/status'"),
    SERVER.indexOf("app.post('/api/admin/marketing/preview'")
  );
  assert.match(block, /workerHealth\(/);
  assert.match(block, /heartbeat: health/);
  assert.match(block, /countByStatus/);
  assert.match(block, /queue: counts\.ok \? counts\.data : null/);
  assert.match(block, /channelConflictsWithGroup/);
});

// ---------------------------------------------------------------------------
// E. Single-shot controlled delivery test
// ---------------------------------------------------------------------------

test('the approved test copy passes the guard in every locale and audience', () => {
  for (const locale of ['en', 'pt', 'ar']) {
    for (const audience of ['group', 'channel']) {
      const msg = renderTestMessage(audience, locale, CONFIG);
      assert.strictEqual(msg.audience, audience);
      assert.strictEqual(msg.locale, locale);
      const guard = checkContent(msg.text, { locale, minDeposit: 100, referralPercent: 20 });
      assert.strictEqual(guard.blocked, false, locale + '/' + audience + ' must be publishable');
      assert.ok(!/\$\d/.test(msg.text), 'a test message must carry no money figure');
      assert.ok(/no action is needed|nenhuma a\u00e7\u00e3o|\u0644\u0627 \u062d\u0627\u062c\u0629/i.test(msg.text),
        'the test must say no action is needed');
    }
  }
});

test('the group test copy links support, the channel copy links registration/how-it-works', () => {
  const group = renderTestMessage('group', 'en', CONFIG);
  assert.ok(group.text.includes(CONFIG.supportUrl));
  assert.ok(group.text.includes(CONFIG.partnerSupportAlexUrl), 'Alex listed');
  assert.ok(group.text.includes(CONFIG.partnerSupportOliviaUrl), 'Olivia listed');
  assert.ok(!group.text.includes(CONFIG.howItWorksUrl), 'the group test stays minimal');

  const channel = renderTestMessage('channel', 'en', CONFIG);
  assert.ok(channel.text.includes(CONFIG.registerUrl));
  assert.ok(channel.text.includes(CONFIG.howItWorksUrl));
  assert.ok(channel.text.includes(CONFIG.supportUrl));
});

test('an unconfigured URL is omitted instead of rendered empty', () => {
  const msg = renderTestMessage('channel', 'en', Object.assign({}, CONFIG, { howItWorksUrl: '' }));
  assert.ok(!msg.text.includes('how-it-works'));
  assert.ok(!/:\s*$/m.test(msg.text), 'no dangling label');
});

test('the test-message route renders only and never sends', () => {
  const start = SERVER.indexOf("app.get('/api/admin/marketing/test-message'");
  const end = SERVER.indexOf("app.post('/api/admin/marketing/test-send'");
  assert.ok(start > 0 && end > start, 'both routes must exist, in this order');
  const block = SERVER.slice(start, end);
  assert.match(block, /authMiddleware, adminMiddleware/);
  assert.ok(!block.includes('marketingTransport.sendMessage'), 'the preview must not send');
  assert.ok(!block.includes('insertPost'), 'the preview must not queue');
});

test('the test-send route is admin-gated, confirmed and cannot queue a post', () => {
  const start = SERVER.indexOf("app.post('/api/admin/marketing/test-send'");
  const end = SERVER.indexOf("app.get('/api/q8qpay/status", start);
  assert.ok(start > 0 && end > start, 'the route must exist before the q8qpay section');
  const block = SERVER.slice(start, end);
  assert.match(block, /authMiddleware, adminMiddleware/);
  assert.match(block, /MARKETING_TEST_CONFIRM/);
  assert.ok(!block.includes('insertPost'), 'a delivery test must never queue a post');
  assert.ok(!block.includes('setControl'), 'a delivery test must never change paused/dry_run');
  assert.match(block, /recordSend/);
});

test('the confirmation token is a phrase, not a boolean', () => {
  const match = /const MARKETING_TEST_CONFIRM = '([^']+)';/.exec(SERVER);
  assert.ok(match, 'the token must be a named constant');
  assert.strictEqual(match[1], 'SEND TEST');
  assert.match(SERVER, /\.trim\(\)\.toUpperCase\(\) !== MARKETING_TEST_CONFIRM/);
});

// ---------------------------------------------------------------------------
// F. Admin actions cannot resurrect a published post
// ---------------------------------------------------------------------------

test('approve cannot resurrect a published, in-flight or failed post', () => {
  const block = SERVER.slice(
    SERVER.indexOf("if (action === 'approve')"),
    SERVER.indexOf("return res.status(400).json({ success: false, error: 'Unknown action' })")
  );
  assert.match(block, /const approvable = \['draft', 'awaiting_approval', 'approved', 'scheduled'\]/);
  for (const blocked of ['published', 'sending', 'cancelled', 'failed']) {
    assert.ok(!block.includes("'" + blocked + "'"), blocked + ' must not be approvable');
  }
  assert.match(block, /use retry for a failed post/);
});

test('cancel and unschedule are state-guarded and clear a dead claim', () => {
  const block = SERVER.slice(
    SERVER.indexOf("if (action === 'cancel')"),
    SERVER.indexOf("if (action === 'retry')")
  );
  assert.match(block, /const cancellable = \['draft', 'awaiting_approval', 'approved', 'scheduled', 'failed', 'blocked'\]/);
  assert.match(block, /Only a scheduled or approved post can be unscheduled/);
  assert.strictEqual((block.match(/claimed_by: null/g) || []).length, 2);
  assert.strictEqual((block.match(/lease_expires_at: null/g) || []).length, 2);
});

test('a retry clears the lease so the row is claimable again', () => {
  const block = SERVER.slice(
    SERVER.indexOf("if (action === 'retry')"),
    SERVER.indexOf("if (action === 'approve')")
  );
  assert.match(block, /claimed_by: null/);
  assert.match(block, /lease_expires_at: null/);
  assert.match(block, /attempts: 0/);
});

// ---------------------------------------------------------------------------
// G. Telegram 429 handling
// ---------------------------------------------------------------------------

test('a 429 from Telegram propagates retry_after to the thrower and the backoff', async () => {
  const transport = createTelegramTransport({
    token: 'TOKENVALUE',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      json: async () => ({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 7',
        parameters: { retry_after: 7 }
      })
    })
  });
  await assert.rejects(
    () => transport.sendMessage(GROUP, 'text'),
    (error) => {
      assert.strictEqual(error.retryAfter, 7);
      assert.strictEqual(error.httpStatus, 429);
      assert.strictEqual(retryAfterMs(error), 7000);
      assert.ok(!error.message.includes('TOKENVALUE'), 'the token must be scrubbed');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// H. Store-level behaviour (heartbeat and admin transitions)
// ---------------------------------------------------------------------------

const { createMarketingStore } = require('../services/MarketingStore');


test('the store heartbeat writes only the liveness columns', async () => {
  const calls = [];
  const admin = {
    from() {
      const chain = {
        update(payload) { calls.push(payload); return this; },
        eq() { return this; },
        select() { return this; },
        async maybeSingle() {
          return { data: { worker_heartbeat_at: '2026-01-01T00:00:00Z', worker_id: 'w', worker_version: 'v' }, error: null };
        }
      };
      return chain;
    }
  };
  const store = createMarketingStore({ admin, logger: { warn() {} } });
  const result = await store.heartbeat({ workerId: 'w', version: 'v' });
  assert.strictEqual(result.ok, true);
  const payload = calls[0];
  assert.deepStrictEqual(Object.keys(payload).sort(), ['worker_heartbeat_at', 'worker_id', 'worker_version']);
  assert.ok(!('paused' in payload), 'a heartbeat must never touch the gates');
  assert.ok(!('dry_run' in payload), 'a heartbeat must never touch the gates');
});

test('the store heartbeat reports failure instead of throwing', async () => {
  const admin = {
    from() {
      const chain = {
        update() { return this; },
        eq() { return this; },
        select() { return this; },
        async maybeSingle() { return { data: null, error: { message: 'column does not exist', code: '42703' } }; }
      };
      return chain;
    }
  };
  const store = createMarketingStore({ admin, logger: { warn() {} } });
  const result = await store.heartbeat({ workerId: 'w', version: 'v' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'heartbeat-failed');
});

test('an admin transition retries without lease columns when 043 is absent', async () => {
  const seen = [];
  const admin = {
    from() {
      const chain = {
        update(payload) { seen.push(payload); return this; },
        eq() { return this; },
        select() { return this; },
        async maybeSingle() {
          const payload = seen[seen.length - 1];
          if ('claimed_by' in payload || 'lease_expires_at' in payload) {
            return { data: null, error: { code: '42703', message: 'column "claimed_by" does not exist' } };
          }
          return { data: { id: 7, status: 'scheduled' }, error: null };
        }
      };
      return chain;
    }
  };
  const store = createMarketingStore({ admin, logger: { warn() {} } });
  const result = await store.updatePost(7, { status: 'scheduled', claimed_by: null, lease_expires_at: null });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.id, 7);
  assert.strictEqual(seen.length, 2, 'one attempt with the lease columns, one without');
  assert.ok(!('claimed_by' in seen[1]));
});

test('an unrelated update error is not retried', async () => {
  let attempts = 0;
  const admin = {
    from() {
      const chain = {
        update() { attempts += 1; return this; },
        eq() { return this; },
        select() { return this; },
        async maybeSingle() { return { data: null, error: { code: '23514', message: 'check constraint' } }; }
      };
      return chain;
    }
  };
  const store = createMarketingStore({ admin, logger: { warn() {} } });
  const result = await store.updatePost(7, { status: 'bogus' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(attempts, 1);
});

test('countByStatus reports unreadable instead of a misleading zero', async () => {
  const admin = {
    from() {
      const chain = {
        select() { return this; },
        eq() { return this; },
        then(resolve) { resolve({ count: null, error: { message: '', code: 'PGRST301' } }); }
      };
      return chain;
    }
  };
  const store = createMarketingStore({ admin, logger: { warn() {} } });
  const result = await store.countByStatus();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'count-by-status-failed');
});

test('countByStatus returns a real zero when the queue is empty', async () => {
  const admin = {
    from() {
      const chain = {
        select() { return this; },
        eq() { return this; },
        then(resolve) { resolve({ count: 0, error: null }); }
      };
      return chain;
    }
  };
  const store = createMarketingStore({ admin, logger: { warn() {} } });
  const result = await store.countByStatus();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.scheduled, 0);
  assert.strictEqual(result.data.published, 0);
});
