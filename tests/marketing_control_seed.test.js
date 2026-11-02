'use strict';

/**
 * `marketing-control.js seed` - the operator-console path to the calendar.
 *
 * POST /api/admin/marketing/calendar/seed needs an admin browser session; the
 * Render shell only has the service credential. This command performs the SAME
 * inserts through the SAME builders so the two paths cannot diverge, and it is
 * the only way to prepare the queue during a group-only transition.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { cmdSeed, parseArgs, USAGE } = require('../scripts/marketing-control.js');
const { resolveMarketingConfig } = require('../services/TelegramBroadcast');

const ROOT = path.join(__dirname, '..');

const GROUP_ENV = {
    TELEGRAM_MARKETING_ENABLED: 'true',
    TELEGRAM_MARKETING_DRY_RUN: 'false',
    TELEGRAM_MARKETING_CHAT_ID: '-1001234567890'
};

const BOTH_ENV = Object.assign({}, GROUP_ENV, { TELEGRAM_ANNOUNCEMENT_CHAT_ID: '-1009876543210' });

function configFor(env, over) {
    return Object.assign(
        resolveMarketingConfig(env),
        { facts: { minDeposit: 100, referralPercent: 20 } },
        over || {}
    );
}

function fakeStore(options) {
    const o = options || {};
    const calls = { inserts: [] };
    return {
        calls,
        async insertPost(row) {
            calls.inserts.push(row);
            if (o.failOn && calls.inserts.length === o.failOn) return { ok: false, reason: 'insert-failed' };
            const seen = o.seen || [];
            return { ok: true, data: row, duplicate: seen.includes(row.idempotency_key) };
        }
    };
}

/** Quiet the command's console output while still capturing it. */
async function run(fn) {
    const out = [];
    const err = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => err.push(a.join(' '));
    try {
        const code = await fn();
        return { code, out: out.join('\n'), err: err.join('\n') };
    } finally {
        console.log = log;
        console.error = error;
    }
}

// ---------------------------------------------------------------------------
// Preview (no --confirm)
// ---------------------------------------------------------------------------
test('a preview writes nothing and refuses without --confirm', async () => {
    const store = fakeStore();
    const { code, out, err } = await run(() => cmdSeed(store, configFor(GROUP_ENV), { weeks: 2 }));
    assert.strictEqual(code, 2);
    assert.strictEqual(store.calls.inserts.length, 0, 'a preview must not insert');
    assert.match(out, /calendar plan \(2 week\(s\)\)/);
    assert.match(err, /Re-run with --confirm/);
});

test('the preview lists scheduled times in chronological order', async () => {
    const { out } = await run(() => cmdSeed(fakeStore(), configFor(GROUP_ENV), { weeks: 2 }));
    const times = [...out.matchAll(/next: (\S+)/g)].map((m) => m[1]);
    assert.ok(times.length >= 2);
    assert.deepStrictEqual(times, [...times].sort(), 'preview must read like the publishing order');
});

// ---------------------------------------------------------------------------
// Group-only mode
// ---------------------------------------------------------------------------
test('group-only mode seeds group posts only', async () => {
    const store = fakeStore();
    const config = configFor(Object.assign({}, BOTH_ENV, { TELEGRAM_MARKETING_GROUP_ONLY: 'true' }));
    const { code, out } = await run(() => cmdSeed(store, config, { weeks: 2, confirm: true }));

    assert.strictEqual(code, 0);
    assert.strictEqual(store.calls.inserts.length, 6, 'two weeks of group slots');
    assert.ok(store.calls.inserts.every((r) => r.audience === 'group'));
    assert.ok(store.calls.inserts.every((r) => r.status === 'scheduled'));
    assert.match(out, /inserted=6 \(group=6 channel=0\)/);
    assert.match(out, /no channel posts were queued/);
    assert.match(out, /group-only mode\s+: ON/);
});

test('a configured channel still seeds both audiences when the flag is off', async () => {
    const store = fakeStore();
    const { code } = await run(() => cmdSeed(store, configFor(BOTH_ENV), { weeks: 2, confirm: true }));
    const groups = store.calls.inserts.filter((r) => r.audience === 'group').length;
    const channels = store.calls.inserts.filter((r) => r.audience === 'channel').length;

    assert.strictEqual(code, 0);
    assert.deepStrictEqual({ groups, channels }, { groups: 6, channels: 8 }, 'reactivation path unchanged');
});

test('an unconfigured channel is skipped and reported, never queued', async () => {
    const store = fakeStore();
    const config = configFor(GROUP_ENV);
    const { code, out } = await run(() => cmdSeed(store, config, { weeks: 2, confirm: true }));

    assert.strictEqual(code, 0);
    assert.ok(store.calls.inserts.every((r) => r.audience === 'group'));
    assert.strictEqual(store.calls.inserts.length, 6);
    assert.match(out, /no channel posts were queued/);
});

// ---------------------------------------------------------------------------
// Idempotency, clamping, failure handling
// ---------------------------------------------------------------------------
test('re-seeding the same dates inserts nothing new', async () => {
    const first = fakeStore();
    await run(() => cmdSeed(first, configFor(GROUP_ENV), { weeks: 2, confirm: true }));
    const keys = first.calls.inserts.map((r) => r.idempotency_key);

    const second = fakeStore({ seen: keys });
    const { code, out } = await run(() => cmdSeed(second, configFor(GROUP_ENV), { weeks: 2, confirm: true }));

    assert.strictEqual(code, 0);
    assert.match(out, /inserted=0 \(group=0 channel=0\) duplicates=6/);
    assert.strictEqual(second.calls.inserts.length, 6, 'the rows are re-attempted but reported as duplicates');
});

test('weeks are clamped to a sane range', async () => {
    const zero = fakeStore();
    await run(() => cmdSeed(zero, configFor(GROUP_ENV), { weeks: 0, confirm: true }));
    assert.strictEqual(zero.calls.inserts.length, 3, '0 weeks falls back to 1 week (3 group slots)');

    const huge = fakeStore();
    await run(() => cmdSeed(huge, configFor(GROUP_ENV), { weeks: 99, confirm: true }));
    assert.strictEqual(huge.calls.inserts.length, 24, '99 weeks clamps to 8 weeks (3 group slots each)');
});

test('an insert failure stops with a database error code', async () => {
    const store = fakeStore({ failOn: 2 });
    const { code, err } = await run(() => cmdSeed(store, configFor(GROUP_ENV), { weeks: 2, confirm: true }));
    assert.strictEqual(code, 3);
    assert.match(err, /insert failed/);
    assert.strictEqual(store.calls.inserts.length, 2, 'no further rows are attempted');
});

test('every seeded row carries a unique key, a schedule and no destination', async () => {
    const store = fakeStore();
    await run(() => cmdSeed(store, configFor(GROUP_ENV), { weeks: 2, confirm: true }));
    const rows = store.calls.inserts;
    assert.strictEqual(new Set(rows.map((r) => r.idempotency_key)).size, rows.length);
    assert.ok(rows.every((r) => r.scheduled_for && r.chat_id === null));
    assert.ok(rows.every((r) => typeof r.content === 'string' && r.content.length > 50), 'real rendered copy');
});

// ---------------------------------------------------------------------------
// Wiring + parity with the admin route
// ---------------------------------------------------------------------------
test('seed is a first-class console command', () => {
    assert.match(USAGE, /<status\|seed\|enable\|pause\|start-here>/);
    assert.match(USAGE, /seed \[--weeks 2\] \[--confirm\]/);
    assert.deepStrictEqual(parseArgs(['seed', '--weeks', '3', '--confirm']), { _: ['seed'], weeks: '3', confirm: true });
});

test('the console and the admin route apply the same channel-skip rule', () => {
    const console = fs.readFileSync(path.join(ROOT, 'scripts/marketing-control.js'), 'utf8');
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(console, /audience === 'channel' && !config\.channelChatId/);
    assert.match(server, /audience === 'channel' && !marketingConfig\.channelChatId/);
});

test('seed never sends or publishes anything itself', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/marketing-control.js'), 'utf8');
    const start = src.indexOf('async function cmdSeed');
    const body = src.slice(start, src.indexOf('async function cmdStartHere', start));
    assert.ok(!/sendMessage|fetch\(|claimPosts|finishPost|setControl/.test(body), 'cmdSeed only inserts rows');
    assert.match(body, /store\.insertPost/);
});
