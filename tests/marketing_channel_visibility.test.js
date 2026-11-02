'use strict';

/**
 * Regression tests for the "configured channel, empty queue" blind spot.
 *
 * The announcement channel published nothing for weeks while every signal the
 * admin API reported said OK: enabled, paused=false, dry-run=false, heartbeat
 * healthy, both destinations configured. The missing fact was simply "zero
 * channel posts are scheduled". These tests pin the three places that now say it
 * out loud: the queue-health helper, the per-audience upcoming count, and the
 * seed endpoint reporting what it created (and skipped).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { describeQueueHealth } = require('../services/TelegramBroadcast');
const { createMarketingStore } = require('../services/MarketingStore');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// 1. describeQueueHealth - stable codes, no prose
// ---------------------------------------------------------------------------
test('a configured channel with no upcoming post is a warning', () => {
    const health = describeQueueHealth({
        groupConfigured: true,
        channelConfigured: true,
        upcoming: { group: 6, channel: 0 }
    });
    assert.strictEqual(health.level, 'warn');
    assert.deepStrictEqual(health.warnings, ['channel-configured-no-upcoming-posts']);
});

test('a seeded queue for both audiences is healthy', () => {
    const health = describeQueueHealth({
        groupConfigured: true,
        channelConfigured: true,
        upcoming: { group: 6, channel: 8 }
    });
    assert.strictEqual(health.level, 'ok');
    assert.deepStrictEqual(health.warnings, []);
});

test('an intentionally unconfigured channel is reported, not treated as broken', () => {
    const health = describeQueueHealth({
        groupConfigured: true,
        channelConfigured: false,
        upcoming: { group: 3, channel: 0 }
    });
    assert.deepStrictEqual(health.warnings, ['channel-not-configured']);
});

test('an empty group queue on a configured group is also flagged', () => {
    const health = describeQueueHealth({
        groupConfigured: true,
        channelConfigured: true,
        upcoming: { group: 0, channel: 4 }
    });
    assert.deepStrictEqual(health.warnings, ['group-configured-no-upcoming-posts']);
});

test('missing input never throws and never invents a clean result', () => {
    const health = describeQueueHealth({ groupConfigured: true, channelConfigured: true });
    assert.strictEqual(health.level, 'warn');
    assert.ok(health.warnings.includes('channel-configured-no-upcoming-posts'));
});

test('codes are stable identifiers, not sentences', () => {
    const health = describeQueueHealth({
        groupConfigured: true, channelConfigured: true, upcoming: { group: 0, channel: 0 }
    });
    for (const code of health.warnings) {
        assert.match(code, /^[a-z]+(-[a-z]+)+$/, 'unexpected code shape: ' + code);
    }
});

// ---------------------------------------------------------------------------
// 2. countUpcomingByAudience - counts only FUTURE scheduled rows
// ---------------------------------------------------------------------------
function fakeAdmin(rows, capture) {
    return {
        from(table) {
            capture.table = table;
            return {
                select(columns) {
                    capture.columns = columns;
                    const q = {
                        eq(column, value) { capture.eq = [column, value]; return q; },
                        gt(column, value) {
                            capture.gt = [column, value];
                            return Promise.resolve({ data: rows, error: null });
                        },
                        lte() { return Promise.resolve({ data: rows, error: null }); }
                    };
                    return q;
                }
            };
        }
    };
}

test('countUpcomingByAudience counts group and channel separately', async () => {
    const capture = {};
    const rows = [
        { audience: 'channel' }, { audience: 'channel' }, { audience: 'channel' },
        { audience: 'group' }, { audience: 'group' },
        { audience: 'subscribers' }
    ];
    const store = createMarketingStore({ admin: fakeAdmin(rows, capture) });
    const result = await store.countUpcomingByAudience({ now: '2026-11-02T12:00:00.000Z' });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.data, { group: 2, channel: 3 });
    assert.strictEqual(capture.table, 'telegram_marketing_posts');
    assert.deepStrictEqual(capture.eq, ['status', 'scheduled']);
    assert.deepStrictEqual(capture.gt, ['scheduled_for', '2026-11-02T12:00:00.000Z']);
});

test('an unreadable queue reports a reason instead of a zero count', async () => {
    const admin = {
        from() {
            return {
                select() {
                    const q = { eq() { return q; }, gt() { return Promise.resolve({ data: null, error: { message: 'boom' } }); } };
                    return q;
                }
            };
        }
    };
    const store = createMarketingStore({ admin });
    const result = await store.countUpcomingByAudience();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'count-upcoming-failed');
});

// ---------------------------------------------------------------------------
// 3. The seed endpoint reports what it created and what it skipped
// ---------------------------------------------------------------------------
test('calendar seed reports per-audience counts and channel skips', () => {
    const src = read('server.js');
    const start = src.indexOf("app.post('/api/admin/marketing/calendar/seed'");
    assert.ok(start > 0, 'seed route must exist');
    const route = src.slice(start, start + 2600);

    assert.match(route, /created\[audience\] \+= 1/, 'must count inserts per audience');
    assert.match(route, /channelSkipped \+= 1/, 'must count channel rows it refuses to queue');
    assert.match(route, /!marketingConfig\.channelChatId/, 'must skip channel rows when no channel is configured');
    assert.match(route, /created,\s*\n\s*channelSkipped,/, 'response must carry created + channelSkipped');
    assert.match(route, /channelConfigured: Boolean\(marketingConfig\.channelChatId\)/);
    // It must remain idempotent: duplicates are still counted, never re-inserted.
    assert.match(route, /result\.duplicate/);
});

// ---------------------------------------------------------------------------
// 4. The status endpoint exposes the diagnosis
// ---------------------------------------------------------------------------
test('admin status reports upcoming counts and queue health', () => {
    const src = read('server.js');
    const start = src.indexOf("app.get('/api/admin/marketing/status'");
    const route = src.slice(start, start + 4000);

    assert.match(route, /countUpcomingByAudience/);
    assert.match(route, /upcoming: upcoming\.ok \? upcoming\.data : null/);
    assert.match(route, /queueHealth: describeQueueHealth\(/);
    assert.match(route, /channelConfigured: Boolean\(marketingConfig\.channelChatId\)/);
});

test('the operator console prints the same diagnosis', () => {
    const src = read('scripts/marketing-control.js');
    assert.match(src, /require\('\.\.\/services\/TelegramBroadcast'\)/);
    assert.match(src, /describeQueueHealth/);
    assert.match(src, /upcoming \(future, scheduled\)/);
    assert.match(src, /queue health/);
    assert.match(src, /state\.upcoming\.channel/);
});

// ---------------------------------------------------------------------------
// 5. Scope guards - this is a diagnostics change, not a publishing change
// ---------------------------------------------------------------------------
test('no new migration and no publishing-path change', () => {
    const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
    assert.ok(migrations.every((f) => !/047_/.test(f)), 'no new migration is required for a read-only count');

    const worker = read('services/MarketingWorker.js');
    assert.ok(!/countUpcomingByAudience/.test(worker), 'the worker must not depend on the diagnostic');
    assert.ok(/chatIdForAudience/.test(worker), 'destination resolution is unchanged');

    const store = read('services/MarketingStore.js');
    assert.ok(!/\.update\(|\.delete\(|\.upsert\(/.test(store.slice(store.indexOf('async countUpcomingByAudience'), store.indexOf('async countUpcomingByAudience') + 900)),
        'the upcoming count must stay read-only');
});

test('the queue-health helper sends nothing and logs no destination', () => {
    const src = read('services/TelegramBroadcast.js');
    const start = src.indexOf('function describeQueueHealth');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.ok(!/fetch|sendMessage|chat_id|chatId/.test(body), 'helper must be pure metadata');
});
