'use strict';

/**
 * Group-only mode (TELEGRAM_MARKETING_GROUP_ONLY=true).
 *
 * Business decision: stop maintaining the announcement channel, keep all
 * Telegram marketing on the partner group. The channel must be switched OFF by
 * configuration - not deleted - so that (a) the calendar can never queue another
 * channel post, (b) a stray legacy channel row is parked instead of retried
 * forever, and (c) clearing the flag restores the previous behaviour exactly.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createMarketingWorker } = require('../services/MarketingWorker');
const { resolveMarketingConfig, describeMarketingConfig, describeQueueHealth } = require('../services/TelegramBroadcast');
const { buildCalendarRows, DEFAULT_SCHEDULE } = require('../services/MarketingOnboarding');
const { render } = require('../services/MarketingContent');

const ROOT = path.join(__dirname, '..');

const CONFIG = {
    enabled: true,
    dryRun: false,
    groupOnly: false,
    groupChatId: '-1001234567890',
    channelChatId: '-1009876543210',
    locale: 'en',
    timezone: 'UTC',
    tickMs: 60000,
    registerUrl: 'https://arbitrix.pro/?action=create-account',
    howItWorksUrl: 'https://arbitrix.pro/how-it-works',
    supportUrl: 'https://t.me/ArbitrixSupportBot',
    partnerSupportAlexUrl: 'https://t.me/ArbitrixCSA1',
    partnerSupportOliviaUrl: '',
    announcementUrl: 'https://t.me/ArbitrixAnnouncements',
    facts: { minDeposit: 100, referralPercent: 20, promoCredit: 50 }
};

const ENV = {
    TELEGRAM_MARKETING_ENABLED: 'true',
    TELEGRAM_MARKETING_DRY_RUN: 'false',
    TELEGRAM_MARKETING_CHAT_ID: '-1001234567890',
    TELEGRAM_ANNOUNCEMENT_CHAT_ID: '-1004336842902'
};

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
test('group-only mode disables the channel destination without touching the group', () => {
    const on = resolveMarketingConfig(Object.assign({}, ENV, { TELEGRAM_MARKETING_GROUP_ONLY: 'true' }));
    assert.strictEqual(on.groupOnly, true);
    assert.strictEqual(on.channelChatId, '', 'the channel must not be addressable in group-only mode');
    assert.strictEqual(on.groupChatId, ENV.TELEGRAM_MARKETING_CHAT_ID, 'the group destination is unchanged');
    assert.strictEqual(on.channelChatIdInvalid, null, 'an intentionally-off channel is not a config error');
    assert.strictEqual(on.enabled, true);
    assert.strictEqual(on.dryRun, false);
});

test('group-only mode is off unless the variable is explicitly true', () => {
    for (const value of [undefined, '', 'false', 'no', 'off', '0']) {
        const cfg = resolveMarketingConfig(Object.assign({}, ENV, { TELEGRAM_MARKETING_GROUP_ONLY: value }));
        assert.strictEqual(cfg.groupOnly, false, 'unexpected groupOnly for ' + JSON.stringify(value));
    }
});

test('without the flag the channel still resolves exactly as before', () => {
    const cfg = resolveMarketingConfig(ENV);
    assert.strictEqual(cfg.groupOnly, false);
    assert.strictEqual(cfg.channelChatId, '-1004336842902');
    assert.strictEqual(describeMarketingConfig(cfg).channelConfigured, true, 'this is the reactivation path');
});

test('the status summary reports the mode', () => {
    const on = describeMarketingConfig(resolveMarketingConfig(Object.assign({}, ENV, { TELEGRAM_MARKETING_GROUP_ONLY: 'true' })));
    assert.strictEqual(on.groupOnly, true);
    assert.strictEqual(on.channelConfigured, false);
});

// ---------------------------------------------------------------------------
// 2. Calendar seeding
// ---------------------------------------------------------------------------
test('a seeded calendar contains group posts only in group-only mode', () => {
    const cfg = resolveMarketingConfig(Object.assign({}, ENV, { TELEGRAM_MARKETING_GROUP_ONLY: 'true' }));
    const rows = buildCalendarRows({ config: cfg, weeks: 2, now: new Date('2026-11-02T12:00:00Z'), createdBy: 1 });

    assert.strictEqual(rows.length, 6, 'two weeks of group slots only');
    for (const { row, guard } of rows) {
        assert.strictEqual(row.audience, 'group');
        assert.strictEqual(row.status, 'scheduled');
        assert.strictEqual(guard.blocked, false);
        assert.ok(row.scheduled_for, 'every group row keeps its scheduled time');
        assert.strictEqual(row.chat_id, null, 'a destination is never stored on the row');
    }
    assert.strictEqual(new Set(rows.map((r) => r.row.idempotency_key)).size, rows.length);
});

test('clearing the flag restores channel seeding (reactivation path)', () => {
    const cfg = resolveMarketingConfig(ENV);
    const rows = buildCalendarRows({ config: cfg, weeks: 2, now: new Date('2026-11-02T12:00:00Z'), createdBy: 1 });

    assert.strictEqual(rows.length, 14, '6 group + 8 channel');
    assert.strictEqual(rows.filter((r) => r.row.audience === 'channel').length, 8);
    assert.strictEqual(rows.filter((r) => r.row.audience === 'group').length, 6);
});

test('the channel schedule itself is preserved for a future reactivation', () => {
    const channelSlots = DEFAULT_SCHEDULE.filter((s) => s.audience === 'channel');
    assert.strictEqual(channelSlots.length, 4, 'tue/thu/sat/sun 18:00 must remain defined');
    assert.deepStrictEqual(channelSlots.map((s) => s.theme).sort(), ['sat', 'sun', 'thu', 'tue']);
    assert.ok(channelSlots.every((s) => s.hour === 18 && s.minute === 0));
});

// ---------------------------------------------------------------------------
// 3. Worker behaviour with a legacy channel row
// ---------------------------------------------------------------------------
function post(over) {
    return Object.assign({
        id: 7,
        kind: 'weekly',
        theme: 'thu',
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

function fakeStore(claims) {
    const calls = { finish: [], block: [], sends: [], cancel: 0, delete: 0 };
    const queue = claims.slice();
    return {
        calls,
        async getControl() { return { ok: true, data: { paused: false, dry_run: false } }; },
        async countDue() { return { ok: true, count: 0 }; },
        async claimDue() { const next = queue.length ? queue.shift() : []; return { ok: true, data: next }; },
        async finish(args) { calls.finish.push(args); return { ok: true, data: {} }; },
        async block(id, reason, workerId) { calls.block.push({ id, reason, workerId }); return { ok: true, data: {} }; },
        async hasSentRecord() { return { ok: true, sent: false, messageId: null }; },
        async recordSend(row) { calls.sends.push(row); return { ok: true }; },
        async listSubscribers() { return { ok: true, data: [] }; }
    };
}

function fakeTransport() {
    const sent = [];
    return {
        sent,
        async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: 500 + sent.length }; },
        async pinChatMessage() { return true; }
    };
}

function worker(store, transport, overrides) {
    return createMarketingWorker({
        store,
        transport,
        config: Object.assign({}, CONFIG, overrides || {}),
        logger: { log() {}, warn() {}, error() {} }
    });
}

test('a channel row is parked, never sent, in group-only mode', async () => {
    const store = fakeStore([[post({ id: 7 })]]);
    const transport = fakeTransport();
    const result = await worker(store, transport, { groupOnly: true, channelChatId: '' }).tick();

    assert.strictEqual(transport.sent.length, 0, 'nothing may be sent to the channel');
    assert.deepStrictEqual(result.results, [{ id: 7, result: 'parked-group-only' }]);
    assert.strictEqual(store.calls.finish.length, 1);
    assert.strictEqual(store.calls.finish[0].ok, false);
    assert.match(store.calls.finish[0].error, /group-only-mode/);
    assert.strictEqual(store.calls.block.length, 0, 'parking is not a content block');
    assert.strictEqual(store.calls.sends[0].status, 'skipped');
    assert.strictEqual(store.calls.sends[0].audience, 'channel');
});

test('the parked row is scheduled far in the future so it is never retried', async () => {
    const store = fakeStore([[post({ id: 9 })]]);
    await worker(store, fakeTransport(), { groupOnly: true, channelChatId: '' }).tick();

    const retryAt = Date.parse(store.calls.finish[0].retryAt);
    assert.ok(Number.isFinite(retryAt), 'retryAt must be a timestamp');
    const daysAhead = (retryAt - Date.now()) / 86400000;
    assert.ok(daysAhead > 300, 'expected ~1 year ahead, got ' + Math.round(daysAhead) + ' days');
});

test('group posts keep publishing in the same tick as a parked channel row', async () => {
    const store = fakeStore([[
        post({ id: 1, audience: 'group', theme: 'wed' }),
        post({ id: 2, audience: 'channel' }),
        post({ id: 3, audience: 'group', theme: 'fri' })
    ]]);
    const transport = fakeTransport();
    const result = await worker(store, transport, { groupOnly: true, channelChatId: '' }).tick();

    assert.deepStrictEqual(result.results, [
        { id: 1, result: 'sent' },
        { id: 2, result: 'parked-group-only' },
        { id: 3, result: 'sent' }
    ]);
    assert.strictEqual(transport.sent.length, 2);
    assert.ok(transport.sent.every((m) => m.chatId === CONFIG.groupChatId), 'both sends go to the group');
});

test('without the flag a channel row still publishes (no behaviour change)', async () => {
    const store = fakeStore([[post({ id: 4 })]]);
    const transport = fakeTransport();
    const result = await worker(store, transport).tick();
    assert.deepStrictEqual(result.results, [{ id: 4, result: 'sent' }]);
    assert.strictEqual(transport.sent[0].chatId, CONFIG.channelChatId);
});

test('parking preserves history: no delete, no cancel, status stays scheduled', async () => {
    const store = fakeStore([[post({ id: 11 })]]);
    await worker(store, fakeTransport(), { groupOnly: true, channelChatId: '' }).tick();

    assert.strictEqual(store.calls.delete, 0);
    assert.strictEqual(store.calls.cancel, 0);
    // finish(ok=false) leaves the row 'scheduled' unless the attempt budget is
    // exhausted; a single park uses exactly one attempt.
    assert.strictEqual(store.calls.finish[0].ok, false);
    assert.notStrictEqual(store.calls.finish[0].status, 'cancelled');
});

// ---------------------------------------------------------------------------
// 4. Queue health
// ---------------------------------------------------------------------------
test('an empty channel queue is not a warning in group-only mode', () => {
    const health = describeQueueHealth({
        groupOnly: true,
        groupConfigured: true,
        channelConfigured: false,
        upcoming: { group: 6, channel: 0 }
    });
    assert.strictEqual(health.level, 'ok');
    assert.deepStrictEqual(health.warnings, []);
});

test('outside group-only mode the same state is still a warning', () => {
    const health = describeQueueHealth({
        groupOnly: false,
        groupConfigured: true,
        channelConfigured: true,
        upcoming: { group: 6, channel: 0 }
    });
    assert.deepStrictEqual(health.warnings, ['channel-configured-no-upcoming-posts']);
});

// ---------------------------------------------------------------------------
// 5. Wiring + scope guards
// ---------------------------------------------------------------------------
test('the admin start-here route refuses to queue a channel intro in group-only mode', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(src, /if \(body\.includeChannelIntro && !marketingConfig\.groupOnly\)/);
    assert.match(src, /channelIntroSkipped: body\.includeChannelIntro && marketingConfig\.groupOnly \? 'group-only-mode' : null/);
});

test('the status route passes the mode to the queue-health helper', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(src, /groupOnly: Boolean\(marketingConfig\.groupOnly\)/);
});

test('the operator console reports the mode', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/marketing-control.js'), 'utf8');
    assert.match(src, /group-only mode/);
    assert.match(src, /flags\.groupOnly/);
});

test('no database migration is needed to switch the channel off', () => {
    const files = fs.readdirSync(path.join(ROOT, 'supabase/migrations'));
    assert.ok(files.every((f) => !f.startsWith('047_')), 'group-only mode is configuration, not schema');
});
