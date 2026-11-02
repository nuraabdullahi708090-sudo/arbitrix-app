'use strict';

/**
 * Migration 046 reliability work:
 *   A. the join-welcome ledger must survive a process restart (the in-memory map
 *      never could), fail OPEN when the table is absent, and RELEASE a claim when
 *      the send fails so a redelivery can still greet;
 *   B. the worker must persist the destinations IT resolved, so the admin status
 *      route can tell "the worker has no channel id" from "only the web service
 *      lacks it".
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createOnboarding } = require('../services/MarketingOnboarding');
const { createMarketingWorker } = require('../services/MarketingWorker');
const { createMarketingStore } = require('../services/MarketingStore');

const ROOT = path.join(__dirname, '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase/migrations/046_telegram_delivery_durability.sql'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'services/MarketingStore.js'), 'utf8');
const ONBOARDING_SRC = fs.readFileSync(path.join(ROOT, 'services/MarketingOnboarding.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'services/MarketingWorker.js'), 'utf8');

const GROUP = '-1001111111111';
const CONFIG = {
  locale: 'en',
  timezone: 'UTC',
  groupChatId: GROUP,
  channelChatId: '-1002222222222',
  registerUrl: 'https://arbitrix.pro/?action=create-account',
  howItWorksUrl: 'https://arbitrix.pro/how-it-works',
  supportUrl: 'https://t.me/ArbitrixSupportBot',
  partnerSupportAlexUrl: 'https://t.me/AlexArbitrix',
  partnerSupportOliviaUrl: 'https://t.me/OliviaArbitrix',
  announcementUrl: 'https://t.me/ArbitrixAnnouncements',
  facts: { minDeposit: 100, referralPercent: 20 }
};

const JOIN = {
  chatId: GROUP,
  chatType: 'supergroup',
  messageId: '900',
  members: [{ id: '555', firstName: 'Ana', name: 'Ana', isBot: false }]
};

function ledgerStore() {
  const claimed = new Set();
  const calls = { claim: [], release: [] };
  return {
    claimed,
    calls,
    async claimWelcomes(rows) {
      calls.claim.push(rows);
      const fresh = [];
      for (const row of rows) {
        const key = row.chatId + '|' + row.memberId + '|' + row.messageId;
        if (!claimed.has(key)) {
          claimed.add(key);
          fresh.push({ member_id: row.memberId });
        }
      }
      return { ok: true, data: fresh };
    },
    async releaseWelcomes(rows) {
      calls.release.push(rows);
      for (const row of rows) claimed.delete(row.chatId + '|' + row.memberId + '|' + row.messageId);
      return { ok: true };
    },
    async recordSend() { return { ok: true }; }
  };
}

function transport(opts) {
  const options = opts || {};
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, extra) {
      if (options.failOnce && options.failOnce.failed === false) {
        options.failOnce.failed = true;
        throw new Error('telegram 502');
      }
      sent.push({ chatId, text, extra });
      return { ok: true, messageId: 1000 + sent.length };
    }
  };
}

// ------------------------------------------------------- A. welcome durability

test('welcome: a redelivery after a restart is skipped by the durable ledger', async () => {
  const store = ledgerStore();
  const t1 = transport();
  const first = createOnboarding({ store, transport: t1, config: CONFIG, logger: { log() {} } });
  const one = await first.handleNewMembers(JOIN);
  assert.strictEqual(one.sent, true);
  assert.strictEqual(t1.sent.length, 1);

  // A NEW process: the in-memory map is empty, exactly like a Render restart.
  const t2 = transport();
  const second = createOnboarding({ store, transport: t2, config: CONFIG, logger: { log() {} } });
  const two = await second.handleNewMembers(JOIN);
  assert.strictEqual(two.sent, false);
  assert.strictEqual(two.skipped, 'duplicate');
  assert.strictEqual(t2.sent.length, 0, 'no second welcome after a restart');
  assert.strictEqual(store.claimed.size, 1);
});

test('welcome: a NEW join message from the same member is welcomed again', async () => {
  const store = ledgerStore();
  const t = transport();
  const onboarding = createOnboarding({ store, transport: t, config: CONFIG, logger: { log() {} } });
  await onboarding.handleNewMembers(JOIN);
  const again = await onboarding.handleNewMembers(Object.assign({}, JOIN, { messageId: '901' }));
  assert.strictEqual(again.sent, true, 'a genuine rejoin is not suppressed');
  assert.strictEqual(t.sent.length, 2);
});

test('welcome: a missing ledger table fails OPEN (pre-046 schema keeps working)', async () => {
  const store = ledgerStore();
  store.claimWelcomes = async () => ({ ok: false, reason: 'welcome-claim-failed', error: 'relation does not exist' });
  const t = transport();
  const onboarding = createOnboarding({ store, transport: t, config: CONFIG, logger: { log() {} } });
  const result = await onboarding.handleNewMembers(JOIN);
  assert.strictEqual(result.sent, true);
  assert.strictEqual(t.sent.length, 1);
});

test('welcome: a failed send releases the claim so a redelivery can still greet', async () => {
  const store = ledgerStore();
  const failOnce = { failed: false };
  const t = transport({ failOnce });
  const onboarding = createOnboarding({ store, transport: t, config: CONFIG, logger: { log() {} } });
  const failed = await onboarding.handleNewMembers(JOIN);
  assert.strictEqual(failed.sent, false);
  assert.strictEqual(store.calls.release.length, 1, 'the claim was handed back');
  assert.strictEqual(store.claimed.size, 0);

  const retried = await onboarding.handleNewMembers(JOIN);
  assert.strictEqual(retried.sent, true);
  assert.strictEqual(t.sent.length, 1);
});

test('welcome: the ledger key is chat + member + message id (no message text)', () => {
  assert.match(ONBOARDING_SRC, /memberId: String\(member\.id\)/);
  assert.match(ONBOARDING_SRC, /messageId: String\(e\.messageId \|\| ''\)/);
  assert.ok(!/claimWelcomes\([^)]*text/.test(ONBOARDING_SRC), 'no message body is persisted');
});

// -------------------------------------------------- B. store contract (046)

function fakeControlAdmin(options) {
  const opts = options || {};
  const patches = [];
  let first = true;
  const api = {};
  api.from = () => api;
  api.update = (patch) => { patches.push(patch); return api; };
  api.eq = () => api;
  api.select = () => api;
  api.maybeSingle = async () => {
    if (first && opts.failFirstWith) {
      first = false;
      return { data: null, error: { code: opts.failFirstWith, message: 'column "worker_channel_configured" does not exist' } };
    }
    first = false;
    return { data: { worker_heartbeat_at: '2026-10-31T00:00:00Z', worker_id: 'w1', worker_version: 'v1' }, error: null };
  };
  return { admin: api, patches };
}

test('store.heartbeat records the worker-resolved destinations', async () => {
  const { admin, patches } = fakeControlAdmin();
  const store = createMarketingStore({ admin });
  const result = await store.heartbeat({
    workerId: 'w1',
    version: 'v1',
    groupConfigured: true,
    channelConfigured: false,
    configWarning: 'TELEGRAM_ANNOUNCEMENT_CHAT_ID:username-not-supported'
  });
  assert.strictEqual(result.ok, true);
  const patch = patches[0];
  assert.strictEqual(patch.worker_group_configured, true);
  assert.strictEqual(patch.worker_channel_configured, false);
  assert.match(patch.worker_config_warning, /username-not-supported/);
  assert.ok(patch.worker_heartbeat_at, 'the plain heartbeat is still written');
});

test('store.heartbeat falls back to the pre-046 columns instead of reporting a dead worker', async () => {
  const { admin, patches } = fakeControlAdmin({ failFirstWith: '42703' });
  const store = createMarketingStore({ admin });
  const result = await store.heartbeat({ workerId: 'w1', version: 'v1', groupConfigured: true, channelConfigured: true });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(patches.length, 2, 'retried once without the new columns');
  assert.strictEqual(patches[1].worker_channel_configured, undefined);
});

test('store.heartbeat never touches paused or dry_run', async () => {
  const { admin, patches } = fakeControlAdmin();
  const store = createMarketingStore({ admin });
  await store.heartbeat({ workerId: 'w1', version: 'v1', groupConfigured: true, channelConfigured: false });
  assert.strictEqual(patches[0].paused, undefined);
  assert.strictEqual(patches[0].dry_run, undefined);
});

test('store.claimWelcomes upserts with the durable unique key and ignoreDuplicates', async () => {
  const captured = {};
  const api = {};
  api.from = () => api;
  api.upsert = (rows, opts) => { captured.rows = rows; captured.opts = opts; return api; };
  api.select = () => api;
  api.then = (resolve) => resolve({ data: [{ member_id: '555' }], error: null });
  const store = createMarketingStore({ admin: api });
  const result = await store.claimWelcomes([{ chatId: GROUP, memberId: '555', messageId: '900' }]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(captured.opts, { onConflict: 'chat_id,member_id,message_id', ignoreDuplicates: true });
  assert.deepStrictEqual(captured.rows, [{ chat_id: GROUP, member_id: '555', message_id: '900' }]);
});

test('store.pruneWelcomes deletes only rows older than the retention window', async () => {
  const captured = {};
  const api = {};
  api.from = () => api;
  api.delete = () => api;
  api.lt = (column, value) => { captured.column = column; captured.value = value; return api; };
  api.then = (resolve) => resolve({ error: null });
  const store = createMarketingStore({ admin: api });
  const result = await store.pruneWelcomes({ days: 30 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(captured.column, 'created_at');
  const ageDays = (Date.now() - Date.parse(captured.value)) / 86400000;
  assert.ok(ageDays > 29.9 && ageDays < 30.1, 'cut-off is ~30 days back');
});

// ------------------------------------------- C. worker reports its own view

function workerWith(capturedHeartbeats, config) {
  const store = {
    async getControl() { return { ok: true, data: { paused: true, dry_run: true } }; },
    async countDue() { return { ok: true, count: 0 }; },
    async heartbeat(args) { capturedHeartbeats.push(args); return { ok: true, data: {} }; },
    async pruneWelcomes() { return { ok: true }; }
  };
  return createMarketingWorker({ store, transport: transport(), config, logger: { log() {} } });
}

test('worker: the heartbeat carries the destinations this process resolved', async () => {
  const heartbeats = [];
  const runner = workerWith(heartbeats, CONFIG).run();
  await new Promise((resolve) => setTimeout(resolve, 30));
  runner.stop();
  assert.ok(heartbeats.length >= 1, 'a heartbeat was written');
  assert.strictEqual(heartbeats[0].groupConfigured, true);
  assert.strictEqual(heartbeats[0].channelConfigured, true);
  assert.strictEqual(heartbeats[0].configWarning, null);
});

test('worker: an unusable channel id is reported as a warning, not silently dropped', async () => {
  const heartbeats = [];
  const config = Object.assign({}, CONFIG, { channelChatId: '', channelChatIdInvalid: 'username-not-supported' });
  const runner = workerWith(heartbeats, config).run();
  await new Promise((resolve) => setTimeout(resolve, 30));
  runner.stop();
  assert.strictEqual(heartbeats[0].channelConfigured, false);
  assert.match(heartbeats[0].configWarning, /TELEGRAM_ANNOUNCEMENT_CHAT_ID:username-not-supported/);
});

test('worker: a conflicting channel id is reported as same-as-group', async () => {
  const heartbeats = [];
  const config = Object.assign({}, CONFIG, { channelChatId: '', channelConflictsWithGroup: true });
  const runner = workerWith(heartbeats, config).run();
  await new Promise((resolve) => setTimeout(resolve, 30));
  runner.stop();
  assert.match(heartbeats[0].configWarning, /same-as-group/);
});

// ------------------------------------------------------------ D. surfaces + SQL

test('status route exposes the worker-reported destinations and a stalled flag', () => {
  assert.match(SERVER, /destinations: control\.ok \? \{/);
  assert.match(SERVER, /channel: control\.data\.worker_channel_configured/);
  assert.match(SERVER, /warning: control\.data\.worker_config_warning \|\| null/);
  assert.match(SERVER, /stalled: !health\.healthy/);
});

test('migration 046 is additive, idempotent and service_role-only', () => {
  assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS worker_channel_configured/);
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.telegram_welcome_deliveries/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS telegram_welcome_deliveries_key/);
  assert.match(MIGRATION, /ENABLE ROW LEVEL SECURITY/);
  assert.match(MIGRATION, /FOR ALL TO service_role/);
  assert.match(MIGRATION, /REVOKE ALL ON public\.telegram_welcome_deliveries FROM anon/);
  assert.match(MIGRATION, /\$verify\$/);
  assert.ok(!/DROP TABLE|TRUNCATE|DELETE FROM public\.(wallets|users|deposits|trades)/i.test(MIGRATION), 'no destructive statement');
  assert.ok(!/^\s*(paused|dry_run)\s*=\s*(TRUE|FALSE)/im.test(MIGRATION), 'never changes the publishing flags');
});

test('the ledger table holds ids only - never a secret or message text', () => {
  const ddl = MIGRATION.match(/CREATE TABLE IF NOT EXISTS public\.telegram_welcome_deliveries[\s\S]*?\);/)[0];
  const columns = Array.from(ddl.matchAll(/^\s{2}(\w+)\s+(BIGINT|TEXT|TIMESTAMPTZ)/gm)).map((m) => m[1]);
  assert.deepStrictEqual(columns, ['id', 'chat_id', 'member_id', 'message_id', 'created_at']);
  for (const name of columns) {
    assert.ok(!/token|secret|jwt|password/i.test(name), 'no credential column: ' + name);
  }
  assert.match(STORE_SRC, /claimWelcomes/);
  assert.match(WORKER_SRC, /destinationWarning\(config\)/);
});
