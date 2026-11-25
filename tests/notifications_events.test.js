'use strict';

/**
 * Event-based in-app notifications.
 *
 * The feed is written by BUSINESS EVENTS only (registration, trades, deposits,
 * referral rewards, journey reminders) and every row is keyed by a stable event
 * identifier with UNIQUE(user_id, event_key) in the database. These tests
 * execute the REAL services/Notifications.js against a behavioural fake of that
 * schema (same conflict semantics, same soft clear), and pin the wiring of the
 * migration and of the frontend store.
 *
 * The reported bug this suite protects against: a dashboard load used to add
 * "Welcome to Kalderix" again, every single login.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { readLf } = require('./helpers/text');

const ROOT = path.join(__dirname, '..');
const INDEX = readLf(path.join(ROOT, 'public', 'index.html'));
const SERVER = readLf(path.join(ROOT, 'server.js'));
const MIGRATION = readLf(path.join(ROOT, 'supabase', 'migrations', '058_notifications.sql'));
const SERVICE_PATH = path.join(ROOT, 'services', 'Notifications.js');

const {
    EVENTS,
    journeyReminders,
    dailyBucket,
    sanitizeVars,
    createNotificationsService,
} = require(SERVICE_PATH);

/* ------------------------------------------------------------------ fake DB */

/**
 * Behavioural fake of the 058 schema. It reproduces the two properties the
 * design depends on:
 *   * notification_emit() is INSERT ... ON CONFLICT (user_id, event_key) DO
 *     NOTHING and reports whether a row was created;
 *   * Clear is a SOFT clear, so a row keeps its event key and cannot be
 *     recreated.
 */
function createFakeDb() {
    const rows = [];
    let nextId = 1;
    const state = { rpcError: null, selectError: null, updates: [] };

    function matches(row, filters) {
        return filters.every(function (f) {
            if (f.op === 'eq') return row[f.col] === f.val;
            if (f.op === 'is') return f.val === null ? row[f.col] == null : row[f.col] === f.val;
            return true;
        });
    }

    function query(table) {
        if (table !== 'notifications') throw new Error('unexpected table ' + table);
        const filters = [];
        let mode = 'select';
        let payload = null;
        let withSelect = false;
        let orderCol = null;
        let orderAsc = false;
        let take = null;

        const builder = {
            select(_cols, _opts) { if (mode === 'update') withSelect = true; return builder; },
            eq(col, val) { filters.push({ op: 'eq', col: col, val: val }); return builder; },
            is(col, val) { filters.push({ op: 'is', col: col, val: val }); return builder; },
            order(col, opts) { orderCol = col; orderAsc = !!(opts && opts.ascending); return builder; },
            limit(n) { take = n; return builder; },
            update(obj) { mode = 'update'; payload = obj; return builder; },
            then(resolve, reject) {
                try { resolve(run()); } catch (e) { (reject || function (x) { throw x; })(e); }
            },
        };

        function run() {
            if (mode === 'update') {
                if (state.selectError) return { data: null, error: { message: state.selectError } };
                let touched = 0;
                rows.forEach(function (row) {
                    if (!matches(row, filters)) return;
                    Object.keys(payload).forEach(function (k) { row[k] = payload[k]; });
                    touched += 1;
                });
                state.updates.push({ filters: filters.slice(), payload: payload, touched: touched });
                return { data: withSelect ? rows.filter(function (r) { return matches(r, filters); }).map(function (r) { return { id: r.id }; }) : null, error: null };
            }
            if (state.selectError) return { data: null, error: { message: state.selectError } };
            let out = rows.filter(function (r) { return matches(r, filters); });
            if (orderCol) {
                out = out.slice().sort(function (a, b) {
                    const av = String(a[orderCol]), bv = String(b[orderCol]);
                    return orderAsc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
                });
            }
            if (take != null) out = out.slice(0, take);
            return {
                data: out.map(function (r) {
                    return {
                        id: r.id, event_key: r.event_key, type: r.type, title_key: r.title_key,
                        body_key: r.body_key, vars: r.vars, occurred_at: r.occurred_at, read_at: r.read_at,
                    };
                }),
                error: null,
            };
        }

        return builder;
    }

    const client = {
        from: query,
        async rpc(name, args) {
            if (name !== 'notification_emit') return { data: null, error: { message: 'unexpected rpc ' + name } };
            if (state.rpcError) return { data: null, error: { message: state.rpcError } };
            const existing = rows.find(function (r) {
                return r.user_id === args.p_user_id && r.event_key === args.p_event_key;
            });
            if (existing) return { data: false, error: null };
            rows.push({
                id: nextId++,
                user_id: args.p_user_id,
                event_key: args.p_event_key,
                type: args.p_type,
                title_key: args.p_title_key,
                body_key: args.p_body_key,
                vars: args.p_vars || {},
                occurred_at: args.p_occurred_at,
                read_at: null,
                cleared_at: null,
            });
            return { data: true, error: null };
        },
    };

    return { client: client, rows: rows, state: state };
}

function boot() {
    const db = createFakeDb();
    const service = createNotificationsService({ supabase: db.client });
    return { db: db, service: service };
}

const USER = 42;

/** The shipped English dictionary (the catalogue stores KEYS, not text). */
function englishDictionary() {
    const start = INDEX.indexOf('const TRANSLATIONS = {');
    let i = INDEX.indexOf('{', start), depth = 0, end = -1;
    for (let j = i; j < INDEX.length; j++) {
        if (INDEX[j] === '{') depth++;
        else if (INDEX[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    return vm.runInNewContext('(' + INDEX.slice(i, end + 1) + ')').en;
}

/* ------------------------------------------- 1. the welcome, exactly once */

test('1. the welcome notification is created exactly once per account', async () => {
    const { db, service } = boot();

    const first = await service.emit(USER, 'welcome', 'welcome', {});
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.created, true, 'the first write creates the welcome');

    // Repeated logins / retries / concurrent requests for the same account.
    for (let i = 0; i < 5; i++) {
        const again = await service.emit(USER, 'welcome', 'welcome', {});
        assert.strictEqual(again.ok, true);
        assert.strictEqual(again.created, false, 'a later write is a no-op');
    }
    assert.strictEqual(db.rows.filter(function (r) { return r.event_key === 'welcome'; }).length, 1);
});

test('1b. the welcome is emitted at registration and NEVER on a dashboard load', () => {
    // Exactly one call site, inside the register handler, before the response.
    const calls = SERVER.split('\n').filter(function (l) { return l.includes("emitNotificationSafe(user.id, 'welcome'"); });
    assert.strictEqual(calls.length, 1, 'one welcome writer, in /api/auth/register');
    const registerIdx = SERVER.indexOf("app.post('/api/auth/register'");
    const welcomeIdx = SERVER.indexOf("emitNotificationSafe(user.id, 'welcome'");
    const registerEnd = SERVER.indexOf("app.post('/api/auth/login'", registerIdx);
    assert.ok(welcomeIdx > registerIdx && welcomeIdx < registerEnd, 'the welcome write lives inside register');

    // The login flow and the session endpoint must not write it.
    const loginSlice = SERVER.slice(registerEnd, SERVER.indexOf("app.post('/api/auth/logout'", registerEnd));
    assert.ok(!loginSlice.includes("'welcome'"), 'login never emits the welcome');
    const meStart = SERVER.indexOf("app.get('/api/auth/me'");
    const meEnd = SERVER.indexOf("app.get('/api/tracking/claim-live-activated'", meStart);
    assert.ok(!SERVER.slice(meStart, meEnd).includes('emitNotificationSafe('), '/api/auth/me never writes a welcome');

    // The frontend used to add it on every initApp().
    assert.ok(!/Notifications\.add\([^)]*notifications\.welcome/.test(INDEX),
        'the dashboard no longer creates the welcome notification');
    assert.ok(INDEX.includes('Notifications.syncFromServer();'),
        'the dashboard reads the durable feed instead');
});

/* ---------------------------------- 2. promo trading does not re-welcome */

test('2. trading the promotional credit never produces another welcome', async () => {
    const { db, service } = boot();
    const { journeyReminders: plan } = require(SERVICE_PATH);

    // Registration: one welcome.
    await service.emit(USER, 'welcome', 'welcome', {});

    // Ten trades + ten session evaluations for a promo-funded, unfunded account.
    for (let i = 0; i < 10; i++) {
        const reminders = plan({ hasConfirmedDeposit: false, hasTradingActivity: true, promoCreditFunded: true, hasPendingDeposit: false });
        for (const r of reminders) await service.emit(USER, r.eventKey, r.event, r.vars);
    }
    const welcomes = db.rows.filter(function (r) { return r.event_key === 'welcome'; });
    assert.strictEqual(welcomes.length, 1, 'still exactly one welcome');

    const promo = db.rows.filter(function (r) { return r.event_key === 'promo_first_trade'; });
    assert.strictEqual(promo.length, 1, 'the promo nudge is one-time');
    const daily = db.rows.filter(function (r) { return r.event_key.startsWith('promo_deposit_reminder:'); });
    assert.strictEqual(daily.length, 1, 'the reminder is one per UTC day, not one per call');
});

/* -------------------------------- 3/4. deposit reminder conditions */

test('3. the deposit reminder is only produced when no qualifying deposit exists', () => {
    const base = { hasTradingActivity: true, promoCreditFunded: true, hasPendingDeposit: false };
    assert.strictEqual(journeyReminders(Object.assign({ hasConfirmedDeposit: false }, base)).length, 2,
        'promo + traded + unfunded: the one-time nudge and the daily reminder');
    assert.deepStrictEqual(Array.from(journeyReminders(Object.assign({ hasConfirmedDeposit: true }, base))), [],
        'a confirmed qualifying deposit stops every reminder');
});

test('4. a pending deposit suppresses the reminder (never treated as confirmed)', () => {
    const plan = journeyReminders({
        hasConfirmedDeposit: false, hasTradingActivity: true, promoCreditFunded: true, hasPendingDeposit: true,
    });
    assert.deepStrictEqual(Array.from(plan), [], 'nothing is sent while a deposit is awaiting confirmation');

    // The reminder text never claims a pending deposit is confirmed.
    const EN = englishDictionary();
    assert.match(EN[EVENTS.promoFirstTrade.body], /confirmed deposit/i);
    assert.ok(!/is confirmed|has been credited/i.test(EN[EVENTS.promoFirstTrade.body]));
});

test('4b. the "start trading" nudge is one-time and waits 24h', () => {
    const young = journeyReminders({ hasConfirmedDeposit: false, hasTradingActivity: false, accountAgeHours: 3 });
    assert.deepStrictEqual(Array.from(young), [], 'no nudge for a brand new account');
    const mature = journeyReminders({ hasConfirmedDeposit: false, hasTradingActivity: false, accountAgeHours: 30 });
    assert.strictEqual(mature.length, 1);
    assert.strictEqual(mature[0].eventKey, 'ready_to_trade', 'a fixed key makes it one-time');
    const traded = journeyReminders({ hasConfirmedDeposit: false, hasTradingActivity: true, accountAgeHours: 30 });
    assert.ok(!traded.some(function (r) { return r.eventKey === 'ready_to_trade'; }), 'a trader does not get it');
});

/* -------------------------------- 5. deposit confirmation, once */

test('5. a confirmed deposit produces exactly one notification', async () => {
    const { db, service } = boot();
    const key = 'deposit_confirmed:invoice:9001';

    assert.strictEqual((await service.emit(USER, key, 'depositConfirmed', { amount: 100 })).created, true);
    // Webhook retry / admin re-confirm / second page load.
    assert.strictEqual((await service.emit(USER, key, 'depositConfirmed', { amount: 100 })).created, false);
    assert.strictEqual(db.rows.filter(function (r) { return r.event_key === key; }).length, 1);

    // Distinct deposits are distinct events.
    assert.strictEqual((await service.emit(USER, 'deposit_confirmed:invoice:9002', 'depositConfirmed', { amount: 50 })).created, true);

    // The migration only treats a status change as a confirmation when the
    // credit marker was committed too.
    assert.match(MIGRATION, /NEW\.status = 'confirmed' AND v_credited/);
    assert.match(MIGRATION, /v_credited := COALESCE\(NEW\.credited, FALSE\)/);
});

/* -------------------------------- 6. first trade, once */

test('6. the first completed trade produces exactly one notification', async () => {
    const { db, service } = boot();
    for (let i = 0; i < 25; i++) await service.emit(USER, 'first_trade', 'firstTrade', {});
    assert.strictEqual(db.rows.filter(function (r) { return r.event_key === 'first_trade'; }).length, 1);

    // Wired to a successful, non-duplicate write only.
    const tradeRoute = SERVER.slice(SERVER.indexOf("app.post('/api/trade'"), SERVER.indexOf("// ---------- Transactions ----------"));
    assert.match(tradeRoute, /if \(!result\.duplicate\) \{/);
    assert.match(tradeRoute, /emitNotificationSafe\(userId, 'first_trade', 'firstTrade'/);
});

/* -------------------------------- 7. referral, only after the credit */

test('7. the referral notification follows the reward credit, never the click', async () => {
    const { db, service } = boot();
    const key = 'referral:555';
    assert.strictEqual((await service.emit(USER, key, 'referral', { amount: 20 })).created, true);
    assert.strictEqual((await service.emit(USER, key, 'referral', { amount: 20 })).created, false);

    // The trigger fires on the reward marker only (active + bonus > 0), never on
    // a click, a registration or a pending referral.
    assert.match(MIGRATION, /IF NEW\.status <> 'active' OR v_bonus <= 0 THEN/);
    assert.match(MIGRATION, /COALESCE\(NEW\.bonus_earned, 0\)/);
    assert.match(MIGRATION, /NEW\.referred_id = NEW\.referrer_id THEN/, 'self-referral is skipped');
    assert.match(MIGRATION, /notifications_referral ON public\.referrals/);
});

/* -------------------------------- 8. duplicate processing */

test('8. repeated and concurrent processing cannot duplicate an event', async () => {
    const { db, service } = boot();
    const results = await Promise.all(
        Array.from({ length: 20 }, function () {
            return service.emit(USER, 'ready_to_trade', 'readyToTrade', {});
        })
    );
    assert.strictEqual(results.filter(function (r) { return r.created; }).length, 1, 'exactly one creation');
    assert.strictEqual(db.rows.length, 1);
});

test('8b. the same event for TWO accounts is two notifications', async () => {
    const { db, service } = boot();
    await service.emit(1, 'welcome', 'welcome', {});
    await service.emit(2, 'welcome', 'welcome', {});
    assert.strictEqual(db.rows.length, 2, 'the uniqueness is per user');
});

/* -------------------------------- 9/10. read, clear, history */

test('9. Mark All Read and Clear work, and report unread correctly', async () => {
    const { db, service } = boot();
    await service.emit(USER, 'welcome', 'welcome', {});
    await service.emit(USER, 'first_trade', 'firstTrade', {});
    await service.emit(USER, 'deposit_confirmed:invoice:1', 'depositConfirmed', { amount: 100 });

    const before = await service.list(USER);
    assert.strictEqual(before.ok, true);
    assert.strictEqual(before.notifications.length, 3);
    assert.strictEqual(before.unread, 3);

    const read = await service.markAllRead(USER);
    assert.strictEqual(read.ok, true);
    const afterRead = await service.list(USER);
    assert.strictEqual(afterRead.unread, 0, 'nothing unread after Mark All Read');
    assert.strictEqual(afterRead.notifications.length, 3, 'Mark All Read never removes a row');
    assert.ok(afterRead.notifications.every(function (n) { return !!n.read_at; }));

    const marked = await service.markRead(USER, before.notifications[0].id);
    assert.strictEqual(marked.ok, true);

    const cleared = await service.clearAll(USER);
    assert.strictEqual(cleared.ok, true);
    const afterClear = await service.list(USER);
    assert.deepStrictEqual(Array.from(afterClear.notifications), [], 'the feed is empty');
    assert.strictEqual(afterClear.unread, 0);
});

test('10. clearing never deletes history and cannot resurrect an event', async () => {
    const { db, service } = boot();
    await service.emit(USER, 'welcome', 'welcome', {});
    await service.emit(USER, 'first_trade', 'firstTrade', {});
    await service.clearAll(USER);

    assert.strictEqual(db.rows.length, 2, 'rows are kept (soft clear), not deleted');
    assert.ok(db.rows.every(function (r) { return r.cleared_at; }));

    // The same business event happening again (a replay, a retried webhook, a
    // second session read) must NOT put it back in the feed.
    const replay = await service.emit(USER, 'welcome', 'welcome', {});
    assert.strictEqual(replay.created, false);
    await service.emit(USER, 'first_trade', 'firstTrade', {});
    const feed = await service.list(USER);
    assert.deepStrictEqual(Array.from(feed.notifications), [], 'a cleared event stays cleared');

    // A genuinely NEW event still appears.
    await service.emit(USER, 'deposit_confirmed:invoice:77', 'depositConfirmed', { amount: 100 });
    const feed2 = await service.list(USER);
    assert.strictEqual(feed2.notifications.length, 1, 'new events still arrive after a clear');
});

test('10b. the feed is ordered by when the event happened and keeps its timestamp', async () => {
    const { db, service } = boot();
    await service.emit(USER, 'deposit_confirmed:invoice:1', 'depositConfirmed', { amount: 100 }, new Date('2026-01-01T10:00:00Z'));
    await service.emit(USER, 'first_trade', 'firstTrade', {}, new Date('2026-01-03T10:00:00Z'));
    await service.emit(USER, 'welcome', 'welcome', {}, new Date('2026-01-02T10:00:00Z'));

    const feed = await service.list(USER);
    assert.deepStrictEqual(feed.notifications.map(function (n) { return n.event_key; }),
        ['first_trade', 'welcome', 'deposit_confirmed:invoice:1']);
    assert.strictEqual(db.rows[0].occurred_at, '2026-01-01T10:00:00.000Z', 'the event time is what is stored');
});

test('10c. a database problem never throws and never breaks the caller', async () => {
    const { db, service } = boot();
    db.state.rpcError = 'relation "notifications" does not exist';
    const r = await service.emit(USER, 'welcome', 'welcome', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.created, false);

    db.state.selectError = 'relation "notifications" does not exist';
    const l = await service.list(USER);
    assert.strictEqual(l.ok, false);
    assert.deepStrictEqual(Array.from(l.notifications), []);

    const svc = createNotificationsService({});
    assert.strictEqual((await svc.emit(USER, 'welcome', 'welcome', {})).ok, false, 'no client -> no crash');
});

/* -------------------------------- schema / migration contract */

test('11. migration 058 provides the unique key, the soft clear and RLS', () => {
    assert.match(MIGRATION, /UNIQUE \(user_id, event_key\)/);
    assert.match(MIGRATION, /event_key\s+TEXT\s+NOT NULL/);
    assert.match(MIGRATION, /cleared_at\s+TIMESTAMPTZ/);
    assert.match(MIGRATION, /read_at\s+TIMESTAMPTZ/);
    assert.match(MIGRATION, /occurred_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    assert.match(MIGRATION, /ENABLE ROW LEVEL SECURITY/);
    assert.match(MIGRATION, /TO service_role USING \(true\) WITH CHECK \(true\)/);
    assert.match(MIGRATION, /REVOKE ALL ON public\.notifications FROM anon/);
    assert.match(MIGRATION, /INSERT INTO public\.notifications[\s\S]{0,900}ON CONFLICT \(user_id, event_key\) DO NOTHING/);
    // The triggers must never be able to block a money write.
    assert.match(MIGRATION, /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'notifications_capture_deposit/);
    assert.match(MIGRATION, /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'notifications_capture_referral/);
    // Sandbox accounts never produce real feed entries.
    assert.match(MIGRATION, /notification_user_is_sandbox/);
    // No money object is touched by this migration.
    assert.ok(!/UPDATE public\.(wallets|trades|referrals|deposits|payment_invoices)/.test(MIGRATION),
        'the migration only observes; it never mutates a financial row');
});

test('11b. the deposit triggers do not require a column that may be absent', () => {
    // deposits.credited arrives with migration 041. Requiring it in a STATIC column
    // list would make 058 fail on a database where 041 has not been applied, even
    // though everything else would work. The column list is therefore built from
    // what the table actually has.
    assert.ok(!/UPDATE OF status, credited ON public\.deposits/.test(MIGRATION),
        'the legacy trigger must not hard-require deposits.credited at creation time');
    assert.match(MIGRATION, /information_schema\.columns/);
    assert.match(MIGRATION, /v_cols := 'status, credited'/);
    assert.match(MIGRATION, /EXECUTE 'CREATE TRIGGER notifications_deposit_legacy/);
    // The function still reads the marker defensively, so a database without the
    // column can never block a deposit and simply produces no "confirmed" event.
    assert.match(MIGRATION, /v_credited := COALESCE\(NEW\.credited, FALSE\)/);
    assert.match(MIGRATION, /EXCEPTION WHEN OTHERS THEN\s+v_credited := FALSE/);
});

test('11c. the referral trigger reads only columns production is known to have', () => {
    // Referral notifications are written by a trigger on public.referrals. That
    // table is NOT created by any migration in this repo, so its exact column set
    // is only knowable from the live database. A record field that does not exist
    // raises 42703 at runtime, and the handler catches everything - so ONE
    // unverified column silently disables EVERY referral notification.
    //
    // The trigger therefore may only reference columns the deployed code proves:
    //   id, referrer_id, referred_id, status, bonus_earned (selected/written on
    //   the hot path) and created_at (the referral list ORDERS BY it).
    const fnStart = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.notifications_capture_referral()');
    // The rollback block at the top of the file also names the trigger, so the
    // end marker must be searched AFTER the function header.
    const fnEnd = MIGRATION.indexOf('DROP TRIGGER IF EXISTS notifications_referral', fnStart);
    const fn = MIGRATION.slice(fnStart, fnEnd);
    assert.ok(fn.length > 400, 'the referral function must be present');

    // Strip line comments so documentation can name a column without tripping this.
    const executable = fn.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
    const fields = Array.from(new Set((executable.match(/NEW\.([a-z_]+)/g) || []).map((m) => m.slice(4))));
    assert.deepStrictEqual(fields.sort(), ['bonus_earned', 'created_at', 'id', 'referred_id', 'referrer_id', 'status'],
        'unexpected record field: the referral table may not have it');
    assert.ok(!fields.includes('updated_at'), 'referrals.updated_at is not guaranteed by the schema');

    // The timestamp expression is the specific regression this pins.
    assert.match(executable, /COALESCE\(NEW\.created_at, now\(\)\)/);
    assert.ok(!/NEW\.updated_at/.test(executable));
});

test('11d. a referral row WITHOUT updated_at still produces its notification', () => {
    // Mirror of the trigger's timestamp rule, evaluated against rows of the shape
    // the live table is known to have. This documents the contract; 11c keeps the
    // SQL itself honest.
    const rule = (row) => {
        const created = row && row.created_at != null ? row.created_at : null;
        return created !== null ? created : 'now()';
    };
    const created = '2026-11-25T10:00:00.000Z';
    // No updated_at field at all - the production-shaped row.
    assert.strictEqual(rule({ id: 1, status: 'active', bonus_earned: 20, created_at: created }), created);
    // A row that happened to carry updated_at is unaffected: it is simply not read.
    assert.strictEqual(rule({ created_at: created, updated_at: '2026-11-30T00:00:00.000Z' }), created);
    // created_at unreadable/NULL falls back instead of raising.
    assert.strictEqual(rule({ created_at: null }), 'now()');

    // The PREVIOUS expression read updated_at first, which on the production-
    // shaped row above is a missing field: the handler would swallow the error and
    // the notification would never be written. Guard against a regression to it.
    const oldRule = (row) => {
        if (row && 'updated_at' in row) return row.updated_at;
        throw new Error('record "new" has no field "updated_at"');
    };
    assert.throws(() => oldRule({ created_at: created }), /has no field "updated_at"/,
        'the old expression is broken on a row without the column - which is why it was removed');
});

test('12. the six event copies exist in every locale', () => {
    const start = INDEX.indexOf('const TRANSLATIONS = {');
    assert.ok(start > 0);
    let i = INDEX.indexOf('{', start), depth = 0, end = -1;
    for (let j = i; j < INDEX.length; j++) {
        if (INDEX[j] === '{') depth++;
        else if (INDEX[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    const T = vm.runInNewContext('(' + INDEX.slice(i, end + 1) + ')');
    const locales = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
    const names = ['readyToTrade', 'promoDeposit', 'depositPending', 'depositConfirmed', 'firstTrade', 'referral'];
    names.forEach(function (n) {
        locales.forEach(function (l) {
            assert.ok(T[l]['notifications.events.' + n + '.title'], l + ' missing ' + n + '.title');
            assert.ok(T[l]['notifications.events.' + n + '.body'], l + ' missing ' + n + '.body');
        });
        assert.ok(T.en['notifications.events.' + n + '.title'].length > 0);
    });

    // The approved English copy, verbatim.
    assert.strictEqual(T.en['notifications.events.readyToTrade.title'], 'Ready to start trading?');
    assert.strictEqual(T.en['notifications.events.promoDeposit.title'], 'Make a deposit to start live trading');
    assert.strictEqual(T.en['notifications.events.depositPending.title'], 'Deposit processing');
    assert.strictEqual(T.en['notifications.events.depositConfirmed.title'], 'Deposit confirmed');
    assert.strictEqual(T.en['notifications.events.firstTrade.title'], 'Your first trade is complete');
    assert.strictEqual(T.en['notifications.events.referral.title'], 'Referral commission earned');
    assert.strictEqual(T.en['notifications.welcome'], 'Welcome to Kalderix');
    assert.strictEqual(T.en['notifications.welcomeDesc'], 'Welcome! Your $50 promotional credit is ready to trade.');

    // The catalogue and the dictionary cannot drift.
    Object.keys(EVENTS).forEach(function (k) {
        const def = EVENTS[k];
        assert.ok(T.en[def.title], 'catalogue title key missing from the dictionary: ' + def.title);
        if (def.body) assert.ok(T.en[def.body], 'catalogue body key missing from the dictionary: ' + def.body);
    });
});

/* -------------------------------- frontend store behaviour */

/** Boots the REAL Notifications store from the bundle with a fake DOM. */
function bootStore(opts) {
    const o = opts || {};
    const start = INDEX.indexOf('const Notifications = {');
    assert.ok(start > 0, 'Notifications store must exist');
    let i = INDEX.indexOf('{', start), depth = 0, end = -1;
    for (let j = i; j < INDEX.length; j++) {
        if (INDEX[j] === '{') depth++;
        else if (INDEX[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    const src = INDEX.slice(i, end + 1);
    const store = {};
    const elements = {};
    const requests = [];
    const storage = Object.assign({}, o.storage || {});
    const lang = { current: 'en' };

    const sandbox = {
        console: { log: function () {}, warn: function () {}, error: function () {} },
        localStorage: {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
            setItem: function (k, v) { storage[k] = String(v); },
            removeItem: function (k) { delete storage[k]; },
        },
        document: {
            getElementById: function (id) {
                if (!elements[id]) elements[id] = { id: id, innerHTML: '', classList: { add: function () {}, remove: function () {} } };
                return elements[id];
            },
        },
        fetch: function (url, init) {
            requests.push({ url: url, method: (init && init.method) || 'GET', headers: (init && init.headers) || {} });
            const body = o.responses && o.responses[url];
            return Promise.resolve({ ok: body !== undefined, json: function () { return Promise.resolve(body || {}); } });
        },
        escapeHtml: function (s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); },
        appLocale: function () { return 'en-US'; },
        // Minimal t(): the real dictionary is not needed to prove behaviour.
        t: function (key, vars) {
            let v = 'T:' + key;
            if (vars) Object.keys(vars).forEach(function (k) { v += '|' + k + '=' + vars[k]; });
            if (o.translations && o.translations[lang.current] && o.translations[lang.current][key]) v = o.translations[lang.current][key];
            return v;
        },
        Date: Date, JSON: JSON, Math: Math, Array: Array, Object: Object, Number: Number, String: String, Promise: Promise,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext('const Notifications = ' + src + '; globalThis.Notifications = Notifications;', sandbox);
    store.api = sandbox.Notifications;
    store.elements = elements;
    store.requests = requests;
    store.storage = storage;
    store.sandbox = sandbox;
    store.setLang = function (l) { lang.current = l; };
    return store;
}

test('13. the store collapses the duplicate welcomes the old bug left behind', () => {
    const welcome = { id: 1, type: 'info', title: 'Welcome to Kalderix', desc: 'Welcome! Your $50 promotional credit is ready to trade.', time: 1700000000000, read: true };
    const legacy = [
        Object.assign({}, welcome, { id: 3, time: 1700000003000 }),
        Object.assign({}, welcome, { id: 2, time: 1700000002000 }),
        welcome,
        { id: 4, type: 'success', title: 'Your first trade is complete', desc: 'Congratulations', time: 1700000004000, read: true },
    ];
    const s = bootStore({ storage: { arbi_notifications: JSON.stringify({ list: legacy }) } });
    s.api.load();
    assert.strictEqual(s.api.local.length, 2, 'three identical welcomes collapse to one');
    assert.strictEqual(s.api.local.filter(function (n) { return n.title === 'Welcome to Kalderix'; }).length, 1);
    assert.ok(s.api.local.some(function (n) { return n.title === 'Your first trade is complete'; }), 'other history is preserved');
});

test('14. the feed is server-backed, translated at render time and survives a reload', async () => {
    const rows = [
        { id: 11, event_key: 'welcome', type: 'success', title_key: 'notifications.welcome', body_key: 'notifications.welcomeDesc', vars: {}, occurred_at: '2026-11-20T10:00:00Z', read_at: null },
        { id: 12, event_key: 'deposit_confirmed:invoice:5', type: 'success', title_key: 'notifications.events.depositConfirmed.title', body_key: 'notifications.events.depositConfirmed.body', vars: { amount: 100 }, occurred_at: '2026-11-21T10:00:00Z', read_at: '2026-11-21T11:00:00Z' },
    ];
    const translations = {
        en: { 'notifications.welcome': 'Welcome to Kalderix', 'notifications.events.depositConfirmed.title': 'Deposit confirmed' },
        es: { 'notifications.welcome': 'Bienvenido a Kalderix', 'notifications.events.depositConfirmed.title': 'Deposito confirmado' },
    };
    const s = bootStore({
        storage: { jwt_token: 'tok' },
        responses: { '/api/notifications': { notifications: rows, unread: 1 } },
        translations: translations,
    });

    await s.api.syncFromServer();
    assert.strictEqual(s.api.list.length, 2, 'the server feed is adopted');
    assert.strictEqual(s.api.unread, 1, 'only the unread row counts');
    assert.ok(s.elements.notificationList.innerHTML.includes('Welcome to Kalderix'), 'rendered in the active language');
    assert.ok(s.elements.notificationList.innerHTML.includes('Deposit confirmed'));

    // Language switch re-renders the SAME rows through t(), no re-fetch needed.
    s.setLang('es');
    s.api.rebuild();
    assert.ok(s.elements.notificationList.innerHTML.includes('Bienvenido a Kalderix'));
    assert.ok(s.elements.notificationList.innerHTML.includes('Deposito confirmado'));

    // A fresh page load re-reads the server feed (nothing is lost on refresh).
    const s2 = bootStore({ storage: { jwt_token: 'tok' }, responses: { '/api/notifications': { notifications: rows, unread: 1 } } });
    await s2.api.syncFromServer();
    assert.strictEqual(s2.api.list.length, 2);
});

test('15. Mark All Read and Clear call the API on the caller\'s own rows', async () => {
    const rows = [
        { id: 21, event_key: 'welcome', type: 'success', title_key: 'notifications.welcome', body_key: null, vars: {}, occurred_at: '2026-11-20T10:00:00Z', read_at: null },
    ];
    const s = bootStore({ storage: { jwt_token: 'tok' }, responses: { '/api/notifications': { notifications: rows, unread: 1 } } });
    await s.api.syncFromServer();
    await s.api.markAllRead();
    const readAll = s.requests.filter(function (r) { return r.url === '/api/notifications/read-all'; });
    assert.strictEqual(readAll.length, 1);
    assert.strictEqual(readAll[0].method, 'POST');
    assert.strictEqual(readAll[0].headers.Authorization, 'Bearer tok', 'the JWT identifies the account');
    assert.strictEqual(s.api.unread, 0, 'the dot is cleared immediately');

    await s.api.clearAll();
    const clear = s.requests.filter(function (r) { return r.url === '/api/notifications' && r.method === 'DELETE'; });
    assert.strictEqual(clear.length, 1);
    assert.strictEqual(s.api.list.length, 0, 'the feed is empty');
    assert.ok(s.elements.notificationList.innerHTML.includes('T:notifications.empty'), 'the empty state is shown');
});

test('16. logout drops the cached feed; a pending event cannot be re-rendered locally', async () => {
    const rows = [{ id: 31, event_key: 'welcome', type: 'success', title_key: 'notifications.welcome', body_key: null, vars: {}, occurred_at: '2026-11-20T10:00:00Z', read_at: null }];
    const s = bootStore({ storage: { jwt_token: 'tok' }, responses: { '/api/notifications': { notifications: rows, unread: 1 } } });
    await s.api.syncFromServer();
    s.api.add('badge', 'Badge unlocked', 'Local celebration');
    assert.strictEqual(s.api.list.length, 2);

    s.api.reset();
    assert.strictEqual(s.api.list.length, 0, 'nothing is left in memory');
    assert.strictEqual(s.storage.arbi_notifications, undefined, 'the local cache is dropped');
    assert.strictEqual(s.api.unread, 0);
});

test('17. the store never creates account events client-side', () => {
    // Account events are never created from the bundle: the only things `add()`
    // receives are local celebrations (badges, milestones, toasts).
    const addCalls = INDEX.match(/Notifications\.add\([^;]{0,200}?\);/g) || [];
    addCalls.forEach(function (call) {
        assert.ok(!/notifications\.welcome|notifications\.events\./.test(call),
            'client-side creation of an account event: ' + call.slice(0, 120));
    });
    // Every account event is created through the idempotent RPC, in ONE module.
    const SERVICE = readLf(SERVICE_PATH);
    assert.match(SERVICE, /rpc\('notification_emit'/);
    assert.ok(!/from\('notifications'\)\.insert/.test(SERVICE), 'no ad-hoc insert path that could bypass the unique key');
    assert.ok(!/from\('notifications'\)\.insert/.test(SERVER),
        'server.js has no ad-hoc notification insert either');
});

test('17b. a server row renders a VALID click handler (regression)', () => {
    // The row id is embedded in an HTML attribute. A quoted string used to close
    // the attribute, so clicking a server notification threw
    // "Unexpected end of input" and never marked it read.
    const s = bootStore({ storage: {}, translations: {} });
    s.api.server = [
        { id: 'srv-501', serverId: 501, type: 'success', titleKey: 'a', bodyKey: null, vars: {}, icon: 'fa-check-circle', time: Date.now(), read: false },
    ];
    s.api.local = [];
    s.api.rebuild();
    const html = s.elements.notificationList.innerHTML;
    assert.ok(html.includes('onclick="Notifications.markAsRead(\'srv-501\')"'),
        'the attribute must carry a single-quoted literal: ' + (html.match(/onclick="[^"]*"/) || [])[0]);
    assert.ok(!/onclick="[^"]*""/.test(html), 'no attribute may be closed early');
    // The handler expression must actually be valid JavaScript.
    const expr = html.match(/onclick="([^"]*)"/)[1];
    assert.doesNotThrow(() => new Function(expr.replace(/^Notifications\.markAsRead/, 'return')));
});

test('17c. id literals, types and icons cannot escape the rendered markup', () => {
    const s = bootStore({ storage: {}, translations: {} });
    const api = s.api;
    assert.strictEqual(api.idLiteral(123), '123');
    assert.strictEqual(api.idLiteral('srv-9'), "'srv-9'");
    assert.strictEqual(api.idLiteral('srv-9" onclick="alert(1)'), "'srv-9onclickalert1'");
    assert.strictEqual(api.idLiteral(null), "''");
    assert.strictEqual(api.safeType('success'), 'success');
    assert.strictEqual(api.safeType('x" onmouseover="alert(1)'), 'info');
    assert.strictEqual(api.safeIcon('fa-check-circle'), 'fa-check-circle');
    assert.strictEqual(api.safeIcon('fa-x"/><img src=x>'), 'fa-bell');

    // And through the renderer: a hostile row cannot inject an attribute.
    s.api.server = [{ id: 'srv-1', serverId: 1, type: '"><img src=x onerror=alert(1)>', titleKey: 'a', bodyKey: null, vars: {}, icon: '"><script>bad()</script>', time: Date.now(), read: false }];
    s.api.local = [];
    s.api.rebuild();
    const html = s.elements.notificationList.innerHTML;
    assert.ok(!/onerror|<script>/i.test(html), 'no injected markup: ' + html.slice(0, 200));
});

test('17d. markAsRead of a server row posts to that row\'s own id', async () => {
    const rows = [{ id: 77, event_key: 'welcome', type: 'success', title_key: 'a', body_key: null, vars: {}, occurred_at: '2026-11-20T10:00:00Z', read_at: null }];
    const s = bootStore({ storage: { jwt_token: 'tok' }, responses: { '/api/notifications': { notifications: rows, unread: 1 } } });
    await s.api.syncFromServer();
    // Exactly what the rendered onclick does: pass the quoted literal's value.
    await s.api.markAsRead('srv-77');
    assert.strictEqual(s.api.list[0].read, true, 'the row is marked read');
    const call = s.requests.filter(function (r) { return r.url === '/api/notifications/77/read'; });
    assert.strictEqual(call.length, 1);
    assert.strictEqual(call[0].method, 'POST');
    assert.strictEqual(call[0].headers.Authorization, 'Bearer tok');
});

test('17e. a TRANSIENT write failure does not disable notifications for the process', () => {
    // Permanent disable is reserved for a structural failure (migration missing,
    // grants missing). One timeout must not silence the feed until the next deploy.
    const m = SERVER.match(/const NOTIFICATION_STRUCTURAL_ERROR = (\/.*?\/i);/);
    assert.ok(m, 'the structural-error matcher must exist');
    const re = new Function('return ' + m[1])();

    const structural = [
        'relation "public.notifications" does not exist',
        'permission denied for table notifications',
        'Could not find the table \'public.notifications\' in the schema cache',
        'PGRST205',
        '42P01',
        '42501',
    ];
    const transient = [
        'fetch failed',
        'ETIMEDOUT',
        'socket hang up',
        'upstream request timeout',
        '502 Bad Gateway',
        'ECONNRESET',
    ];
    structural.forEach(function (msg) { assert.ok(re.test(msg), 'structural: ' + msg); });
    transient.forEach(function (msg) { assert.ok(!re.test(msg), 'transient must NOT disable: ' + msg); });

    // The flag is only set inside the structural branch, and the transient branch
    // does not touch it.
    const fn = SERVER.slice(SERVER.indexOf('async function emitNotificationSafe'), SERVER.indexOf('async function evaluateJourneyNotifications'));
    const structuralBranch = fn.slice(fn.indexOf('if (NOTIFICATION_STRUCTURAL_ERROR'), fn.indexOf('} else {'));
    const transientBranch = fn.slice(fn.indexOf('} else {'));
    assert.ok(structuralBranch.includes('notificationCatalogueMissing = true'));
    assert.ok(!transientBranch.includes('notificationCatalogueMissing = true'),
        'a transient failure must leave the feed enabled');
});

test('17f. the session read runs no reminder queries when nothing can fire', () => {
    // Extract the REAL evaluateJourneyNotifications() and run it with stubs, so the
    // hot-path cost is a behavioural assertion rather than a source string.
    const start = SERVER.indexOf('async function evaluateJourneyNotifications');
    assert.ok(start > 0);
    let i = SERVER.indexOf('{', start), depth = 0, end = -1;
    for (let j = i; j < SERVER.length; j++) {
        if (SERVER[j] === '{') depth++;
        else if (SERVER[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    const src = SERVER.slice(start, end + 1);
    const calls = { pending: 0, emitted: [] };
    const sandbox = {
        console: { warn: function () {} },
        notifications: { emit: async function () { return { ok: true, created: true }; } },
        notificationCatalogueMissing: false,
        journeyReminders: journeyReminders,
        // Same definition as server.js: hours since users.created_at, 0 when unknown.
        accountAgeHours: function (user) {
            const t = user && user.created_at ? Date.parse(user.created_at) : NaN;
            return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 3600000) : 0;
        },
        hasPendingDeposit: async function () { calls.pending += 1; return false; },
        emitNotificationSafe: async function (uid, key) { calls.emitted.push(key); return { ok: true }; },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const run = sandbox.evaluateJourneyNotifications;

    return Promise.resolve()
        .then(function () { return run({ id: 1, created_at: '2026-01-01T00:00:00Z' }, { hasConfirmedDeposit: true }); })
        .then(function () {
            assert.strictEqual(calls.pending, 0, 'a funded account triggers no deposit query');
            assert.deepStrictEqual(calls.emitted, [], 'a funded account gets no reminder');
        })
        .then(function () { return run({ id: 2, created_at: new Date().toISOString() }, { promoCreditFunded: false, hasTradingActivity: false }); })
        .then(function () {
            assert.strictEqual(calls.pending, 0, 'a brand-new account triggers no deposit query either');
            assert.deepStrictEqual(calls.emitted, []);
        })
        .then(function () { return run({ id: 3, created_at: '2026-01-01T00:00:00Z' }, { promoCreditFunded: true, hasTradingActivity: true }); })
        .then(function () {
            assert.strictEqual(calls.pending, 1, 'the query runs only when a reminder is a candidate');
            assert.strictEqual(calls.emitted.length, 2, 'both promo reminders are emitted');
            assert.ok(calls.emitted[0].startsWith('promo_first_trade'));
            assert.ok(calls.emitted[1].startsWith('promo_deposit_reminder:'));
        });
});

test('17g. every notification route requires authentication', () => {
    const routes = [
        "app.get('/api/notifications', authMiddleware",
        "app.post('/api/notifications/read-all', authMiddleware",
        "app.post('/api/notifications/:id/read', authMiddleware",
        "app.delete('/api/notifications', authMiddleware",
    ];
    routes.forEach(function (r) {
        const at = SERVER.indexOf(r);
        assert.ok(at > 0, 'unprotected or missing route: ' + r);
        // Each handler resolves the account from the token only.
        const body = SERVER.slice(at, SERVER.indexOf('\n});', at) + 4);
        assert.ok(body.includes('req.user.id'), 'handler must use the authenticated identity: ' + r);
        assert.ok(!/req\.body\.userId|req\.query\.userId|req\.params\.userId/.test(body),
            'the caller must never supply the user id: ' + r);
    });
});

test('17h. one account cannot read, mark or clear another account\'s rows', async () => {
    const { db, service } = boot();
    await service.emit(111, 'welcome', 'welcome', {});
    const mine = await service.list(111);
    assert.strictEqual(mine.notifications.length, 1);

    // Another account sees nothing and cannot touch the row.
    const theirs = await service.list(222);
    assert.deepStrictEqual(Array.from(theirs.notifications), []);
    await service.markRead(222, mine.notifications[0].id);
    await service.markAllRead(222);
    await service.clearAll(222);

    const row = db.rows[0];
    assert.strictEqual(row.read_at, null, 'markRead from another account changed nothing');
    assert.strictEqual(row.cleared_at, null, 'clearAll from another account changed nothing');
    const stillMine = await service.list(111);
    assert.strictEqual(stillMine.notifications.length, 1, 'the owner still sees the row');
});

test('18. helper contracts (bucket, vars sanitisation)', () => {
    assert.strictEqual(dailyBucket(new Date('2026-11-23T23:59:59Z')), '2026-11-23');
    assert.strictEqual(dailyBucket('not-a-date'), '1970-01-01');
    const v = sanitizeVars({ amount: 100, nested: { a: 1 }, url: 'x'.repeat(200), ok: true, nothing: null });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(v)), { amount: 100, ok: true, url: 'x'.repeat(64) });
});
