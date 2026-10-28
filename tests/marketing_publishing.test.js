'use strict';

/**
 * Publishing engine: the durable queue worker, the join-triggered welcome, and
 * the migration that backs them.
 *
 * The most important property pinned here is that the system is INERT and FAILS
 * CLOSED: a disabled feature, an unreadable control row, a paused publisher, a
 * dry run, a guard failure or a bad destination all result in ZERO sends.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createMarketingWorker } = require('../services/MarketingWorker');
const { createRateLimiter, resolveMarketingConfig, backoffMs, retryAfterMs } = require('../services/TelegramBroadcast');
const { createOnboarding, buildCalendarRows, buildStartHereRow, buildChannelIntroRow, DEFAULT_SCHEDULE } = require('../services/MarketingOnboarding');
const { render } = require('../services/MarketingContent');

const ROOT = path.join(__dirname, '..');

const CONFIG = {
  enabled: true,
  dryRun: false,
  groupChatId: '-1001234567890',
  channelChatId: '-1009876543210',
  locale: 'en',
  timezone: 'UTC',
  tickMs: 60000,
  registerUrl: 'https://arbitrix.pro/?action=create-account',
  howItWorksUrl: 'https://arbitrix.pro/how-it-works',
  supportUrl: 'https://t.me/ArbitrixSupportBot',
  partnerSupportUrl: 'https://t.me/Arbitrix_CSA1',
  announcementUrl: 'https://t.me/ArbitrixChannel',
  facts: { minDeposit: 100, referralPercent: 20, promoCredit: 50 }
};

function goodContent() {
  return render('weekly', 'en', CONFIG).text;
}

function post(over) {
  return Object.assign({
    id: 1,
    kind: 'weekly',
    theme: 'wed',
    locale: 'en',
    audience: 'group',
    chat_id: null,
    content: goodContent(),
    buttons: [],
    status: 'sending',
    attempts: 1,
    max_attempts: 5
  }, over || {});
}

function fakeStore(options) {
  const o = options || {};
  const calls = { claim: 0, countDue: 0, finish: [], block: [], sends: [], control: 0, claimArgs: [], sentChecks: [] };
  const claims = o.claims ? o.claims.slice() : [o.claim || []];
  return {
    calls,
    async getControl() {
      calls.control += 1;
      return o.control || { ok: true, data: { paused: false, dry_run: false } };
    },
    async countDue() {
      calls.countDue += 1;
      return o.due ? { ok: true, count: o.due } : { ok: true, count: 0 };
    },
    async claimDue(args) {
      calls.claim += 1;
      calls.claimArgs.push(args || {});
      if (o.claimError) return { ok: false, reason: 'claim-failed', error: 'boom' };
      const next = claims.length ? claims.shift() : [];
      return { ok: true, data: next };
    },
    async finish(args) {
      calls.finish.push(args);
      // A fenced finish (lease reclaimed by another worker) returns no row.
      return { ok: true, data: o.finishRefused ? null : {} };
    },
    async block(id, reason, workerId) {
      calls.block.push({ id, reason, workerId });
      return { ok: true, data: o.blockRefused ? null : {} };
    },
    // Migration 043: the worker reconciles against the send audit before
    // re-publishing a reclaimed post.
    async hasSentRecord({ postId } = {}) {
      calls.sentChecks.push(postId);
      if (o.sentError) return { ok: false, reason: 'send-audit-unreadable', error: 'boom' };
      const hit = (o.sentRecords || {})[postId];
      return hit ? { ok: true, sent: true, messageId: hit } : { ok: true, sent: false, messageId: null };
    },
    async recordSend(row) {
      calls.sends.push(row);
      return { ok: true };
    },
    async listSubscribers() {
      return o.subscribers || { ok: true, data: [] };
    }
  };
}

function fakeTransport(options) {
  const o = options || {};
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, opts) {
      if (o.throwOn) throw new Error(o.throwOn);
      sent.push({ chatId, text, opts });
      return { message_id: 100 + sent.length };
    },
    async pinChatMessage(chatId, messageId) {
      sent.push({ pinned: true, chatId, messageId });
      return true;
    }
  };
}

function workerFor(store, transport, overrides) {
  return createMarketingWorker({
    store,
    transport,
    config: Object.assign({}, CONFIG, overrides || {}),
    logger: { log() {}, warn() {}, error() {} }
  });
}

test('a claimed post is sent once and recorded', async () => {
  const store = fakeStore({ claim: [post()] });
  const transport = fakeTransport();
  const result = await workerFor(store, transport).tick();
  assert.strictEqual(result.claimed, 1);
  assert.deepStrictEqual(result.results, [{ id: 1, result: 'sent' }]);
  assert.strictEqual(transport.sent.length, 1);
  assert.strictEqual(transport.sent[0].chatId, CONFIG.groupChatId);
  assert.strictEqual(store.calls.finish.length, 1);
  assert.strictEqual(store.calls.finish[0].ok, true);
  assert.strictEqual(store.calls.sends.length, 1);
  assert.strictEqual(store.calls.sends[0].status, 'sent');
});

// ---------------------------------------------------------------------------
// Inert / fail-closed gates
// ---------------------------------------------------------------------------

test('the worker sends nothing when the feature flag is off', async () => {
  const store = fakeStore({ claim: [post()] });
  const transport = fakeTransport();
  const result = await workerFor(store, transport, { enabled: false }).tick();
  assert.deepStrictEqual(result, { skipped: 'disabled' });
  assert.strictEqual(store.calls.claim, 0, 'the queue must not even be claimed');
  assert.strictEqual(store.calls.control, 0);
  assert.strictEqual(transport.sent.length, 0);
});

test('an unreadable control row fails CLOSED', async () => {
  const store = fakeStore({ control: { ok: false, reason: 'schema-not-migrated' }, claim: [post()] });
  const transport = fakeTransport();
  const result = await workerFor(store, transport).tick();
  assert.strictEqual(result.skipped, 'control-unavailable');
  assert.strictEqual(store.calls.claim, 0);
  assert.strictEqual(transport.sent.length, 0);
});

test('a paused publisher sends nothing', async () => {
  const store = fakeStore({ control: { ok: true, data: { paused: true, dry_run: false } }, claim: [post()] });
  const transport = fakeTransport();
  const result = await workerFor(store, transport).tick();
  assert.strictEqual(result.skipped, 'paused');
  assert.strictEqual(store.calls.claim, 0);
  assert.strictEqual(transport.sent.length, 0);
});

test('a dry run counts due posts but never claims or sends', async () => {
  for (const overrides of [{ dryRun: true }, { dryRun: false }]) {
    const store = fakeStore({
      control: { ok: true, data: { paused: false, dry_run: true } },
      claim: [post()],
      due: 3
    });
    const transport = fakeTransport();
    const result = await workerFor(store, transport, overrides).tick();
    assert.strictEqual(result.skipped, 'dry-run');
    assert.strictEqual(result.due, 3);
    assert.strictEqual(store.calls.claim, 0);
    assert.strictEqual(transport.sent.length, 0);
  }
});

test('an empty queue is a no-op', async () => {
  const store = fakeStore({ claim: [] });
  const transport = fakeTransport();
  const result = await workerFor(store, transport).tick();
  assert.deepStrictEqual(result, { claimed: 0, sent: 0 });
  assert.strictEqual(transport.sent.length, 0);
});

test('the channel audience uses the announcement channel, never the stored chat_id', async () => {
  const store = fakeStore({ claim: [post({ audience: 'channel', chat_id: '-1009999999999' })] });
  const transport = fakeTransport();
  await workerFor(store, transport).tick();
  assert.strictEqual(transport.sent.length, 1);
  assert.strictEqual(transport.sent[0].chatId, CONFIG.channelChatId,
    'a tampered chat_id in the queue must be ignored');
});

test('inline buttons are sent as a reply_markup only when present', async () => {
  const buttons = [{ text: 'Create your account', url: 'https://arbitrix.pro/?action=create-account' }];
  const store = fakeStore({ claim: [post({ buttons })] });
  const transport = fakeTransport();
  await workerFor(store, transport).tick();
  assert.ok(transport.sent[0].opts.reply_markup.inline_keyboard[0][0].url);
});

test('a second tick does not re-send a post the store no longer claims', async () => {
  const store = fakeStore({ claims: [[post()], []] });
  const transport = fakeTransport();
  const worker = workerFor(store, transport);
  await worker.tick();
  await worker.tick();
  assert.strictEqual(transport.sent.length, 1, 'exactly one send');
  assert.strictEqual(store.calls.claim, 2);
});

// ---------------------------------------------------------------------------
// Rejections that must not reach Telegram
// ---------------------------------------------------------------------------

test('the guard is re-checked at send time and blocks unsafe copy', async () => {
  const store = fakeStore({ claim: [post({ content: 'Guaranteed profit, risk-free, lifetime commission.' })] });
  const transport = fakeTransport();
  const result = await workerFor(store, transport).tick();
  assert.strictEqual(result.results[0].result, 'blocked');
  assert.strictEqual(transport.sent.length, 0, 'blocked content must never be sent');
  assert.strictEqual(store.calls.block.length, 1);
  assert.strictEqual(store.calls.sends[0].status, 'blocked');
});

test('a missing marketing group is a retryable configuration error, not a crash', async () => {
  const store = fakeStore({ claim: [post()] });
  const transport = fakeTransport();
  const result = await workerFor(store, transport, { groupChatId: '' }).tick();
  assert.strictEqual(result.results[0].result, 'destination-invalid');
  assert.strictEqual(transport.sent.length, 0);
  assert.strictEqual(store.calls.finish[0].ok, false);
  assert.match(store.calls.finish[0].error, /marketing-group-not-configured/);
  assert.strictEqual(store.calls.sends[0].status, 'skipped');
});

test('a destination that is not configured is refused', async () => {
  const store = fakeStore({ claim: [post({ audience: 'channel' })] });
  const transport = fakeTransport();
  const result = await workerFor(store, transport, { channelChatId: '' }).tick();
  assert.strictEqual(result.results[0].result, 'destination-invalid');
  assert.match(store.calls.finish[0].error, /announcement-channel-not-configured/);
});

test('a Telegram failure is retried with backoff and audited', async () => {
  const store = fakeStore({ claim: [post()] });
  const transport = fakeTransport({ throwOn: 'Telegram sendMessage failed: Too Many Requests' });
  const now = Date.now();
  const result = await workerFor(store, transport).tick();
  assert.strictEqual(result.results[0].result, 'failed');
  assert.strictEqual(store.calls.finish[0].ok, false);
  assert.ok(new Date(store.calls.finish[0].retryAt).getTime() > now, 'a retry must be scheduled');
  assert.strictEqual(store.calls.sends[0].status, 'failed');
});

test('Telegram 429 retry_after is honoured and backoff is capped', () => {
  assert.strictEqual(retryAfterMs(new Error('Telegram sendMessage failed: retry after 30')), 30000);
  assert.strictEqual(retryAfterMs({ retryAfter: 5 }), 5000);
  assert.strictEqual(retryAfterMs(new Error('nope')), 0);
  assert.strictEqual(backoffMs(1), 60000);
  assert.strictEqual(backoffMs(2), 120000);
  assert.ok(backoffMs(20) <= 3600000);
});

test('a rate-limited send is deferred without losing the post', async () => {
  const store = fakeStore({ claim: [post()] });
  const transport = fakeTransport();
  const worker = createMarketingWorker({
    store,
    transport,
    config: CONFIG,
    rateLimiter: { take: () => ({ ok: false, waitMs: 5000 }) },
    logger: { log() {}, warn() {}, error() {} }
  });
  const result = await worker.tick();
  assert.strictEqual(result.results[0].result, 'rate-limited');
  assert.strictEqual(transport.sent.length, 0);
  assert.strictEqual(store.calls.finish[0].ok, false);
  assert.ok(new Date(store.calls.finish[0].retryAt).getTime() > Date.now());
});

test('the per-chat limiter allows a burst then refuses, and is per chat', () => {
  let now = 0;
  const limiter = createRateLimiter({ maxPerMinute: 3, now: () => now });
  assert.strictEqual(limiter.take('a').ok, true);
  assert.strictEqual(limiter.take('a').ok, true);
  assert.strictEqual(limiter.take('a').ok, true);
  assert.strictEqual(limiter.take('a').ok, false);
  assert.strictEqual(limiter.take('b').ok, true);
  now += 61000;
  assert.strictEqual(limiter.take('a').ok, true);
});

// ---------------------------------------------------------------------------
// Subscriber audience
// ---------------------------------------------------------------------------

test('a subscriber post with no subscribers is closed out without a send', async () => {
  const store = fakeStore({ claim: [post({ audience: 'subscribers' })] });
  const transport = fakeTransport();
  const result = await workerFor(store, transport).tick();
  assert.strictEqual(result.results[0].result, 'skipped');
  assert.strictEqual(transport.sent.length, 0);
  assert.strictEqual(store.calls.sends[0].status, 'skipped');
});

test('only returned (subscribed) recipients are messaged, and bad ids are skipped', async () => {
  const store = fakeStore({
    claim: [post({ audience: 'subscribers' })],
    subscribers: {
      ok: true,
      data: [
        { telegram_chat_id: '424242', locale: 'en', subscribed: true },
        { telegram_chat_id: 'not-an-id', locale: 'en', subscribed: true }
      ]
    }
  });
  const transport = fakeTransport();
  await workerFor(store, transport).tick();
  assert.strictEqual(transport.sent.length, 1);
  assert.strictEqual(transport.sent[0].chatId, '424242');
});

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function onboardingFor(transport, config) {
  return createOnboarding({
    config: config || CONFIG,
    transport,
    store: { async recordSend() { return { ok: true }; } },
    logger: { log() {}, warn() {}, error() {} }
  });
}

test('a new member in the marketing group receives the welcome', async () => {
  const transport = fakeTransport();
  const result = await onboardingFor(transport).handleNewMembers({
    chatId: CONFIG.groupChatId,
    members: [{ id: '777', name: 'Ana', isBot: false }],
    messageId: '9'
  });
  assert.strictEqual(result.sent, true);
  assert.strictEqual(transport.sent.length, 1);
  assert.match(transport.sent[0].text, /20%/);
  assert.match(transport.sent[0].text, /\$100/);
  assert.ok(transport.sent[0].opts.reply_markup.inline_keyboard.length >= 2);
});

test('a join in any other chat is ignored', async () => {
  const transport = fakeTransport();
  const result = await onboardingFor(transport).handleNewMembers({
    chatId: '-1000000000001',
    members: [{ id: '777', name: 'Ana', isBot: false }],
    messageId: '9'
  });
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.skipped, 'chat-not-configured');
  assert.strictEqual(transport.sent.length, 0);
});

test('the welcome is not sent when the marketing group is unconfigured', async () => {
  const transport = fakeTransport();
  const result = await onboardingFor(transport, Object.assign({}, CONFIG, { groupChatId: '' }))
    .handleNewMembers({ chatId: '-1001234567890', members: [{ id: '1', name: 'A', isBot: false }] });
  assert.strictEqual(result.skipped, 'marketing-group-not-configured');
  assert.strictEqual(transport.sent.length, 0);
});

test('bots are never welcomed', async () => {
  const transport = fakeTransport();
  const result = await onboardingFor(transport).handleNewMembers({
    chatId: CONFIG.groupChatId,
    members: [{ id: '888', name: 'SomeBot', isBot: true }]
  });
  assert.strictEqual(result.skipped, 'no-human-members');
  assert.strictEqual(transport.sent.length, 0);
});

test('a redelivered join event does not double-post', async () => {
  const transport = fakeTransport();
  const onboarding = onboardingFor(transport);
  const event = { chatId: CONFIG.groupChatId, members: [{ id: '777', name: 'Ana', isBot: false }], messageId: '9' };
  await onboarding.handleNewMembers(event);
  const second = await onboarding.handleNewMembers(event);
  assert.strictEqual(second.skipped, 'duplicate');
  assert.strictEqual(transport.sent.length, 1);
});

test('a welcome send failure is swallowed (the webhook must not fail)', async () => {
  const transport = fakeTransport({ throwOn: 'Telegram sendMessage failed: Forbidden' });
  const result = await onboardingFor(transport).handleNewMembers({
    chatId: CONFIG.groupChatId,
    members: [{ id: '777', name: 'Ana', isBot: false }],
    messageId: '9'
  });
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.skipped, 'send-failed');
});

test('the welcome uses the configured locale', async () => {
  const transport = fakeTransport();
  await onboardingFor(transport, Object.assign({}, CONFIG, { locale: 'pt' })).handleNewMembers({
    chatId: CONFIG.groupChatId,
    members: [{ id: '1', name: 'Ana', isBot: false }],
    messageId: '1'
  });
  assert.match(transport.sent[0].text, /Comunidade de Parceiros Arbitrix/);
});

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

test('the calendar seeds a manageable week without flooding either chat', () => {
  const rows = buildCalendarRows({ config: CONFIG, weeks: 2, now: new Date('2026-10-27T14:05:00Z') });
  assert.strictEqual(rows.length, DEFAULT_SCHEDULE.length * 2);
  const perWeek = { group: 0, channel: 0 };
  for (const slot of DEFAULT_SCHEDULE) perWeek[slot.audience] += 1;
  assert.strictEqual(perWeek.group, 3);
  assert.strictEqual(perWeek.channel, 4);
  assert.ok(perWeek.group + perWeek.channel <= 7, 'at most one post per day');
});

test('calendar rows are unique, publishable and mapped to the right audience', () => {
  const rows = buildCalendarRows({ config: CONFIG, weeks: 3, now: new Date('2026-10-27T14:05:00Z') });
  const keys = new Set(rows.map((r) => r.row.idempotency_key));
  assert.strictEqual(keys.size, rows.length, 'idempotency keys must be unique');
  for (const { row, guard } of rows) {
    assert.strictEqual(guard.ok, true);
    assert.strictEqual(row.status, 'scheduled');
    assert.ok(['group', 'channel'].includes(row.audience));
    assert.strictEqual(row.chat_id, null, 'a destination is never stored');
    assert.ok(row.scheduled_for);
  }
});

test('re-seeding the same window produces the same keys (no duplicate posts)', () => {
  const now = new Date('2026-10-27T14:05:00Z');
  const a = buildCalendarRows({ config: CONFIG, weeks: 2, now });
  const b = buildCalendarRows({ config: CONFIG, weeks: 2, now });
  assert.deepStrictEqual(a.map((r) => r.row.idempotency_key), b.map((r) => r.row.idempotency_key));
});

test('the Start Here and channel-intro builders are distinct and publishable', () => {
  const start = buildStartHereRow({ config: CONFIG, scheduledFor: '2026-10-28T09:00:00Z' });
  const intro = buildChannelIntroRow({ config: CONFIG, scheduledFor: '2026-10-28T09:00:00Z' });
  assert.strictEqual(start.row.audience, 'group');
  assert.strictEqual(intro.row.audience, 'channel');
  assert.strictEqual(start.row.status, 'scheduled');
  assert.match(start.content.text, /START HERE/);
  assert.notStrictEqual(start.row.idempotency_key, intro.row.idempotency_key);
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test('migration 038 exists and creates the documented objects', () => {
  const file = path.join(ROOT, 'supabase', 'migrations', '038_marketing_broadcast.sql');
  assert.ok(fs.existsSync(file));
  const sql = fs.readFileSync(file, 'utf8');
  for (const table of [
    'telegram_marketing_posts',
    'telegram_marketing_subscriptions',
    'telegram_marketing_control',
    'telegram_marketing_sends'
  ]) {
    assert.match(sql, new RegExp('CREATE TABLE IF NOT EXISTS public\\.' + table));
    assert.match(sql, new RegExp('ALTER TABLE public\\.' + table + '\\s+ENABLE ROW LEVEL SECURITY'));
  }
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /idempotency_key\s+TEXT\s+NOT NULL UNIQUE/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.claim_marketing_posts/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.finish_marketing_post/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.block_marketing_post/);
});

test('the publisher starts paused and in dry-run', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '038_marketing_broadcast.sql'), 'utf8');
  assert.match(sql, /paused\s+BOOLEAN\s+NOT NULL DEFAULT TRUE/);
  assert.match(sql, /dry_run\s+BOOLEAN\s+NOT NULL DEFAULT TRUE/);
  assert.match(sql, /VALUES \(1, TRUE, TRUE\)/);
});

test('the queue is service_role only (no anon or authenticated policy)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '038_marketing_broadcast.sql'), 'utf8');
  assert.ok(!/TO\s+(anon|authenticated)\b/i.test(sql), 'no anon/authenticated policy may be granted');
  assert.match(sql, /REVOKE ALL ON public\.telegram_marketing_posts\s+FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /TO service_role/);
});

test('the migration retains status, audience and locale invariants', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '038_marketing_broadcast.sql'), 'utf8');
  assert.match(sql, /status IN \('draft', 'awaiting_approval', 'approved', 'scheduled'/);
  assert.match(sql, /audience IN \('group', 'channel', 'subscribers'\)/);
  assert.match(sql, /locale IN \('en', 'pt', 'ar'\)/);
});

test('the worker is inert by default in configuration and in the entrypoint', () => {
  const cfg = resolveMarketingConfig({});
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.dryRun, true);
  const entry = fs.readFileSync(path.join(ROOT, 'marketing-worker.js'), 'utf8');
  assert.match(entry, /TELEGRAM_MARKETING_ENABLED/);
  assert.match(entry, /worker_disabled/);
  assert.match(entry, /worker_misconfigured/);
});

test('no marketing file references a money path or a sandbox table', () => {
  const files = fs.readdirSync(path.join(ROOT, 'services'))
    .filter((f) => /^(Marketing|TelegramBroadcast|ContentGuard)/.test(f));
  assert.ok(files.length >= 4);
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, 'services', file), 'utf8');
    assert.ok(!/record_trade_safe|credit_payment_safe|charge_subscription_safe/.test(src), file);
    assert.ok(!/from\(['"](wallets|trades|deposits|withdrawals|subscriptions)['"]\)/.test(src), file);
    assert.ok(!/sandbox_/.test(src), file);
  }
});
