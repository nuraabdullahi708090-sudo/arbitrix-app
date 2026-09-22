'use strict';

/**
 * TEMPORARY (management test): platform-wide BOT PROFIT PAUSE.
 *
 * Rule: once a PRODUCTION account's cumulative NET realized Live profit reaches
 * BOT_PROFIT_PAUSE_USD (default 400; 0 disables), the bot is paused and further
 * trading is refused until a NEW confirmed deposit is made AFTER the trigger.
 *
 * These tests execute the REAL services/ProfitPause.js against a fake Supabase
 * client and the REAL evaluateRisk() from the trading worker, then pin the
 * wiring, the migration and the pop-up. The rule must NOT be documented anywhere
 * user-visible: the pop-up is the only surface and it discloses no threshold.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const WORKER_JS = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const TRADING_WORKER = fs.readFileSync(path.join(ROOT, 'services', 'TradingWorker.js'), 'utf8');
const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'services', 'ProfitPause.js'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '033_bot_profit_pause.sql'), 'utf8');
const KNOWLEDGE = fs.readFileSync(path.join(ROOT, 'services', 'support', 'arbitrix-knowledge.json'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

const MOD = require('../services/ProfitPause');
const { evaluateRisk } = require('../services/TradingWorker');

// ---------------------------------------------------------------------------
// Fake Supabase client (thenable query builder) - only what the module uses.
// ---------------------------------------------------------------------------
function makeStore(cfg) {
    cfg = cfg || {};
    return {
        users: cfg.users || [{ id: 7, environment: 'PRODUCTION' }],
        trades: cfg.trades || [],
        bot_profit_pauses: cfg.pauses || [],
        deposits: cfg.deposits || [],
        payment_invoices: cfg.invoices || [],
        errors: cfg.errors || {},
    };
}

function makeAdmin(store) {
    return {
        from(table) {
            const filters = { eq: [], gt: [] };
            let limit = null;
            let patch = null;
            const q = {
                select() { return q; },
                eq(col, val) { filters.eq.push([col, val]); return q; },
                gt(col, val) { filters.gt.push([col, val]); return q; },
                limit(n) { limit = n; return q; },
                maybeSingle() { return Promise.resolve(one()); },
                single() { return Promise.resolve(one()); },
                update(p) { patch = p; return q; },
                upsert(row) {
                    if (store.errors[table]) return Promise.resolve({ error: store.errors[table] });
                    const arr = store[table];
                    const i = arr.findIndex((r) => r.user_id === row.user_id);
                    if (i >= 0) arr[i] = Object.assign({}, arr[i], row);
                    else arr.push(Object.assign({}, row));
                    return Promise.resolve({ error: null });
                },
                then(res, rej) { return Promise.resolve(all()).then(res, rej); },
            };
            function all() {
                if (store.errors[table]) return { data: null, error: store.errors[table] };
                let rows = store[table].slice();
                for (const [c, v] of filters.eq) rows = rows.filter((r) => r[c] === v);
                for (const [c, v] of filters.gt) {
                    rows = rows.filter((r) => new Date(r[c]).getTime() > new Date(v).getTime());
                }
                if (patch) {
                    for (const r of rows) Object.assign(r, patch);
                    return { data: null, error: null };
                }
                if (limit != null) rows = rows.slice(0, limit);
                return { data: rows, error: null };
            }
            function one() {
                const r = all();
                if (r.error) return r;
                return { data: r.data && r.data.length ? r.data[0] : null, error: null };
            }
            return q;
        },
    };
}

function pauser(store, threshold) {
    return MOD.createProfitPauseCheck({
        admin: makeAdmin(store),
        threshold: threshold === undefined ? MOD.DEFAULT_PROFIT_PAUSE_USD : threshold,
        log: () => {},
    });
}

const LIVE = (amount) => ({ user_id: 7, mode: 'live', amount });
const DEMO = (amount) => ({ user_id: 7, mode: 'demo', amount });

// ---------------------------------------------------------------------------
// 1. Threshold configuration (single knob, easy to change/disable)
// ---------------------------------------------------------------------------
test('1a. default threshold is 400 and is the single source of truth', () => {
    assert.strictEqual(MOD.DEFAULT_PROFIT_PAUSE_USD, 400);
    assert.strictEqual(MOD.resolveProfitPauseUsd({}), 400);
    assert.strictEqual(MOD.resolveProfitPauseUsd({ BOT_PROFIT_PAUSE_USD: '' }), 400);
    assert.strictEqual(MOD.resolveProfitPauseUsd({ BOT_PROFIT_PAUSE_USD: '   ' }), 400);
});

test('1b. the env var retunes and (<=0 / invalid) disables the rule', () => {
    assert.strictEqual(MOD.resolveProfitPauseUsd({ BOT_PROFIT_PAUSE_USD: '250' }), 250);
    assert.strictEqual(MOD.resolveProfitPauseUsd({ BOT_PROFIT_PAUSE_USD: '400.5' }), 400.5);
    assert.strictEqual(MOD.resolveProfitPauseUsd({ BOT_PROFIT_PAUSE_USD: '0' }), 0);
    assert.strictEqual(MOD.resolveProfitPauseUsd({ BOT_PROFIT_PAUSE_USD: '-5' }), 0);
    assert.strictEqual(MOD.resolveProfitPauseUsd({ BOT_PROFIT_PAUSE_USD: 'abc' }), 0);
    assert.strictEqual(MOD.PROFIT_PAUSE_ENV, 'BOT_PROFIT_PAUSE_USD');
    assert.ok(MOD.PROFIT_PAUSE_CODE && MOD.PROFIT_PAUSE_MESSAGE);
});

test('1c. neither server.js nor worker.js hard-codes the threshold', () => {
    assert.ok(SERVER.includes('resolveProfitPauseUsd()'), 'server must resolve the threshold');
    assert.ok(WORKER_JS.includes('resolveProfitPauseUsd()'), 'worker must resolve the threshold');
    assert.ok(!/= 400\b/.test(SERVER), 'server.js must not contain a 400 literal');
    assert.ok(!/profitPauseUsd\s*=\s*400/.test(WORKER_JS), 'worker.js must not pin 400');
    assert.strictEqual((MODULE_SRC.match(/=\s*400\b/g) || []).length, 1, 'the 400 default lives in exactly one place');
});

// ---------------------------------------------------------------------------
// 2. Real pause logic (executed module + fake DB)
// ---------------------------------------------------------------------------
test('2a. below the threshold nothing happens and no state is written', async () => {
    const store = makeStore({ trades: [LIVE(300), LIVE(99.99)] });
    assert.strictEqual(await pauser(store).isPaused(7), false);
    assert.strictEqual(store.bot_profit_pauses.length, 0, 'no pause row below the threshold');
});

test('2b. reaching the threshold pauses and records the trigger', async () => {
    const store = makeStore({ trades: [LIVE(250), LIVE(150)] });
    assert.strictEqual(await pauser(store).isPaused(7), true);
    assert.strictEqual(store.bot_profit_pauses.length, 1);
    assert.ok(store.bot_profit_pauses[0].triggered_at, 'triggered_at recorded');
    assert.strictEqual(store.bot_profit_pauses[0].cleared_at, null);
});

test('2c. only LIVE trades count (demo profit cannot trigger the pause)', async () => {
    const store = makeStore({ trades: [DEMO(5000), LIVE(399)] });
    assert.strictEqual(await pauser(store).isPaused(7), false);
    const p = pauser(makeStore({ trades: [DEMO(5000), LIVE(400)] }));
    assert.strictEqual(await p.isPaused(7), true);
});

test('2d. a deposit made BEFORE the trigger does NOT clear the pause', async () => {
    const store = makeStore({
        pauses: [{ user_id: 7, triggered_at: '2026-09-22T10:00:00.000Z', cleared_at: null }],
        deposits: [{ id: 1, user_id: 7, status: 'confirmed', created_at: '2026-09-01T00:00:00.000Z' }],
    });
    assert.strictEqual(await pauser(store).isPaused(7), true);
    assert.strictEqual(store.bot_profit_pauses[0].cleared_at, null);
});

test('2e. a confirmed deposit AFTER the trigger clears the pause', async () => {
    const store = makeStore({
        pauses: [{ user_id: 7, triggered_at: '2026-09-22T10:00:00.000Z', cleared_at: null }],
        deposits: [{ id: 1, user_id: 7, status: 'confirmed', created_at: '2026-09-22T11:00:00.000Z' }],
    });
    assert.strictEqual(await pauser(store).isPaused(7), false);
    assert.ok(store.bot_profit_pauses[0].cleared_at, 'cleared_at stamped');
});

test('2f. a provider invoice (payment_invoices) also clears the pause', async () => {
    const store = makeStore({
        pauses: [{ user_id: 7, triggered_at: '2026-09-22T10:00:00.000Z', cleared_at: null }],
        invoices: [{ id: 9, user_id: 7, status: 'confirmed', created_at: '2026-09-22T12:00:00.000Z' }],
    });
    assert.strictEqual(await pauser(store).isPaused(7), false);
});

test('2g. a PENDING deposit does not clear the pause', async () => {
    const store = makeStore({
        pauses: [{ user_id: 7, triggered_at: '2026-09-22T10:00:00.000Z', cleared_at: null }],
        deposits: [{ id: 1, user_id: 7, status: 'pending', created_at: '2026-09-22T11:00:00.000Z' }],
    });
    assert.strictEqual(await pauser(store).isPaused(7), true);
});

test('2h. once cleared, a later profit level does NOT re-pause', async () => {
    const store = makeStore({
        pauses: [{ user_id: 7, triggered_at: '2026-09-22T10:00:00.000Z', cleared_at: '2026-09-22T11:00:00.000Z' }],
        trades: [LIVE(5000)],
    });
    assert.strictEqual(await pauser(store).isPaused(7), false);
    assert.strictEqual(store.bot_profit_pauses.length, 1, 'no second pause row');
});

test('2i. MARKETING_SANDBOX is never paused (and writes nothing)', async () => {
    const store = makeStore({
        users: [{ id: 7, environment: 'MARKETING_SANDBOX' }],
        trades: [LIVE(9999)],
    });
    assert.strictEqual(await pauser(store).isPaused(7), false);
    assert.strictEqual(store.bot_profit_pauses.length, 0);
});

test('2j. the rule applies to ALL production users (no deposit gate in code)', () => {
    assert.ok(!/isPromoCreditFunded|hasConfirmedDeposit\s*\(/.test(MODULE_SRC),
        'the module must not exclude deposited/promo users');
    assert.ok(!/environment\s*===\s*'PRODUCTION'\s*\)\s*return\s+false/.test(MODULE_SRC));
});

test('2k. unreadable state FAILS OPEN (never strands a trader)', async () => {
    const store = makeStore({
        trades: [LIVE(5000)],
        errors: { bot_profit_pauses: { code: '42P01', message: 'relation does not exist' } },
    });
    assert.strictEqual(await pauser(store).isPaused(7), false);
});

test('2l. an unreadable deposit source fails open too', async () => {
    const store = makeStore({
        pauses: [{ user_id: 7, triggered_at: '2026-09-22T10:00:00.000Z', cleared_at: null }],
        errors: { deposits: { message: 'boom' }, payment_invoices: { message: 'boom' } },
    });
    assert.strictEqual(await pauser(store).isPaused(7), false);
});

test('2m. threshold 0 DISABLES the rule entirely (no queries touched)', async () => {
    const store = makeStore({ trades: [LIVE(99999)] });
    const p = pauser(store, 0);
    assert.strictEqual(p.enabled, false);
    assert.strictEqual(p.threshold, 0);
    assert.strictEqual(await p.isPaused(7), false);
    assert.strictEqual(store.bot_profit_pauses.length, 0);
});

test('2n. cumulative profit is the SIGNED sum of live trades', async () => {
    const store = makeStore({ trades: [LIVE(500), LIVE(-120.5), DEMO(999)] });
    const p = pauser(store, 1);
    assert.strictEqual(await p.getCumulativeProfit(7), 379.5);
});

// ---------------------------------------------------------------------------
// 3. Trading worker enforcement (real evaluateRisk)
// ---------------------------------------------------------------------------
test('3a. evaluateRisk vetoes, stops the session, and uses the shared code', () => {
    const v = evaluateRisk({ balance: 500, realizedToday: 0, tradesToday: 1, profitPaused: true });
    assert.strictEqual(v.allow, false);
    assert.strictEqual(v.code, MOD.PROFIT_PAUSE_CODE);
    assert.strictEqual(v.reason, 'profit_pause');
    assert.strictEqual(v.stopSession, true);
});

test('3b. the promo cap takes precedence over the profit pause', () => {
    const v = evaluateRisk({
        balance: 500,
        realizedToday: 0,
        tradesToday: 1,
        promoCreditFunded: true,
        promoProfit: 20,
        profitPaused: true,
        isPromoProfitCapReached: (funded, profit) => funded === true && profit >= 20,
    });
    assert.strictEqual(v.code, 'PROMO_TRADING_LIMIT_REACHED');
});

test('3c. absent/false profitPaused changes nothing (backwards compatible)', () => {
    assert.strictEqual(evaluateRisk({ balance: 500, realizedToday: 0, tradesToday: 1 }).allow, true);
    assert.strictEqual(evaluateRisk({ balance: 500, realizedToday: 0, tradesToday: 1, profitPaused: false }).allow, true);
    assert.strictEqual(evaluateRisk({ balance: 0, realizedToday: 0, tradesToday: 1, profitPaused: true }).code, 'NO_BALANCE');
});

test('3d. the worker loads the pause from the collaborator and imports the shared code', () => {
    assert.ok(TRADING_WORKER.includes("require('./ProfitPause')"), 'shared code constant is imported');
    assert.ok(/profitPause = null/.test(TRADING_WORKER), 'collaborator is optional');
    assert.ok(/profitPause\.isPaused\(userId\)/.test(TRADING_WORKER), 'session inputs consult the rule');
    assert.ok(/try \{ profitPaused = \(await profitPause\.isPaused\(userId\)\) === true; \} catch/.test(TRADING_WORKER),
        'worker evaluation is fail-open');
    assert.ok(TRADING_WORKER.includes('profitPaused,'), 'the verdict input is returned');
    // ordering: promo cap check precedes the pause check
    assert.ok(TRADING_WORKER.indexOf('PROMO_TRADING_LIMIT_REACHED') < TRADING_WORKER.indexOf('if (profitPaused === true)'));
});

test('3e. worker.js constructs the rule with the env-resolved threshold', () => {
    assert.ok(WORKER_JS.includes('createProfitPauseCheck'));
    assert.ok(/threshold: resolveProfitPauseUsd\(\)/.test(WORKER_JS));
    assert.ok(/^\s*profitPause,\s*$/m.test(WORKER_JS), 'passed into createTradingWorker');
});

// ---------------------------------------------------------------------------
// 4. Server enforcement
// ---------------------------------------------------------------------------
function sliceBetween(text, startMarker, endMarker) {
    const a = text.indexOf(startMarker);
    assert.ok(a >= 0, 'missing ' + startMarker);
    const b = text.indexOf(endMarker, a + startMarker.length);
    assert.ok(b > a, 'missing ' + endMarker);
    return text.slice(a, b);
}

test('4a. server wires the rule to the service-role client', () => {
    assert.ok(SERVER.includes("require('./services/ProfitPause')"));
    assert.ok(/const profitPause = createProfitPauseCheck\(\{[\s\S]{0,120}admin: supabaseAdmin/.test(SERVER));
    assert.ok(SERVER.includes('threshold: PROFIT_PAUSE_USD'));
});

test('4b. /api/trade refuses a paused account BEFORE the money write', () => {
    const route = sliceBetween(SERVER, "app.post('/api/trade'", "app.get('/api/transactions'");
    const pauseIdx = route.indexOf('isProfitPausedForUser(userId)');
    const rpcIdx = route.indexOf("rpc('record_trade_safe'");
    assert.ok(pauseIdx > 0, 'pause check present');
    assert.ok(rpcIdx > 0, 'rpc call present');
    assert.ok(pauseIdx < rpcIdx, 'pause check must precede the RPC');
    assert.ok(route.indexOf('isPromoProfitCapReached') < pauseIdx, 'evaluated after the promo cap');
    assert.ok(route.includes('stopBotSessionForProfitPause(userId)'));
    assert.ok(route.includes('profitPauseBody()'));
});

test('4c. /api/bot/start refuses (live only) and stops the session', () => {
    const route = sliceBetween(SERVER, "app.post('/api/bot/start'", "app.post('/api/bot/stop'");
    assert.ok(/if \(mode === 'live' && await isProfitPausedForUser\(userId\)\)/.test(route),
        'live-gated so demo starts are not blocked');
    assert.ok(route.includes('stopBotSessionForProfitPause(userId)'));
    assert.ok(route.includes('profitPauseBody()'));
});

test('4d. /api/bot/status reports the pause to the app', () => {
    const route = sliceBetween(SERVER, "app.get('/api/bot/status'", "app.get('/api/admin/bot/worker-status'");
    assert.ok(route.includes('const profitPaused = await isProfitPausedForUser(req.user.id)'));
    assert.ok(/\n\s*profitPaused\n/.test(route), 'returned in the response body');
});

test('4e. the refusal body is machine-readable and promises no threshold', () => {
    assert.strictEqual(MOD.PROFIT_PAUSE_CODE, 'PROFIT_PAUSE_DEPOSIT_REQUIRED');
    const body = sliceBetween(SERVER, 'function profitPauseBody', '/** Machine-readable promotional-cap');
    assert.ok(body.includes('PROFIT_PAUSE_CODE'));
    assert.ok(body.includes('profitPauseReached: true'));
    assert.ok(body.includes('depositRequired: true'));
    assert.ok(!/\d/.test(MOD.PROFIT_PAUSE_MESSAGE), 'the message must not disclose a number');
    const deny = sliceBetween(SERVER, 'async function isProfitPausedForUser', '/** Machine-readable promotional-cap');
    assert.ok(/catch \(e\) \{\s*return false;/.test(deny), 'helpers fail open');
});

test('4f. the sandbox shortcut is preserved (rule never applies to sandbox)', () => {
    const trade = sliceBetween(SERVER, "app.post('/api/trade'", "app.get('/api/transactions'");
    assert.ok(trade.indexOf('sandboxHandled') < trade.indexOf('isProfitPausedForUser(userId)'));
});

// ---------------------------------------------------------------------------
// 5. Migration 033
// ---------------------------------------------------------------------------
test('5a. migration 033 is additive, idempotent and self-checking', () => {
    assert.ok(MIGRATION.includes('CREATE TABLE IF NOT EXISTS public.bot_profit_pauses'));
    assert.ok(MIGRATION.includes('triggered_at'));
    assert.ok(MIGRATION.includes('cleared_at'));
    assert.ok(MIGRATION.includes('ENABLE ROW LEVEL SECURITY'));
    assert.ok(/TO service_role USING \(true\)/.test(MIGRATION));
    assert.ok(MIGRATION.includes('DROP POLICY IF EXISTS'));
    assert.ok(MIGRATION.includes('RAISE EXCEPTION'));
    assert.ok(MIGRATION.includes('REVOKE ALL'), 'anon/authenticated are revoked');
});

test('5b. migration 033 touches no financial or sandbox table', () => {
    // Strip SQL comments so prose about what is NOT touched cannot false-positive.
    const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
    assert.ok(!/INSERT INTO/i.test(SQL), 'no data writes');
    assert.ok(!/ALTER TABLE public\.(wallets|trades|deposits|withdrawals|subscriptions|bot_sessions)/.test(SQL));
    assert.ok(!/sandbox/i.test(SQL), 'no sandbox object referenced');
    assert.ok(!/bot_sessions/.test(SQL), 'does not alter bot_sessions');
    assert.ok(!/\b(DELETE FROM|TRUNCATE|UPDATE\s+public\.)/i.test(SQL), 'no destructive statements');
});

test('5c. the application never runs the migration itself', () => {
    assert.ok(!SERVER.includes('033_bot_profit_pause'));
    assert.ok(!WORKER_JS.includes('033_bot_profit_pause'));
});

// ---------------------------------------------------------------------------
// 6. Front-end pop-up (the ONLY user-facing surface)
// ---------------------------------------------------------------------------
const MODAL = sliceBetween(INDEX, '<div class="deposit-modal" id="profitPauseModal">', '<!-- ==================== OFFICIAL SUPPORT MODAL');

test('6a. the pop-up exists and is fully localizable', () => {
    assert.strictEqual(INDEX.split('id="profitPauseModal"').length - 1, 1, 'exactly one pop-up');
    assert.ok(MODAL.includes('data-i18n="profitPause.title"'));
    assert.ok(MODAL.includes('data-i18n="profitPause.body"'));
    assert.ok(MODAL.includes('data-i18n="profitPause.addFunds"'));
    assert.ok(MODAL.includes('onclick="closeProfitPauseModal()"'));
    assert.ok(MODAL.includes('data-i18n="common.close"'));
});

test('6b. the pop-up reveals no amount, threshold or rule', () => {
    for (const lang of LANGS) {
        for (const key of ['profitPause.title', 'profitPause.body', 'profitPause.addFunds']) {
            const m = INDEX.match(new RegExp("'" + key.replace('.', '\\.') + "': '([^']*)'"));
            assert.ok(m, key + ' missing');
        }
    }
    const re = new RegExp("'(profitPause\\.(?:title|body|addFunds))': '([^']*)'", 'g');
    let m;
    let n = 0;
    while ((m = re.exec(INDEX))) {
        n++;
        assert.ok(!/\d/.test(m[2]), 'no digit may appear in the pop-up copy: ' + m[2]);
        assert.ok(!/\$\s*400/.test(m[2]));
    }
    assert.strictEqual(n, 18, '18 pop-up values (3 keys x 6 locales)');
    assert.ok(!/400/.test(MODAL), 'the pop-up must not disclose the threshold');
    assert.ok(!/profit.?pause/i.test(KNOWLEDGE), 'the support bot must not describe the rule');
    assert.ok(!INDEX.includes('BOT_PROFIT_PAUSE_USD'), 'the env var is server-side only');
});

test('6c. the pop-up opens only when the server says so, at most once', () => {
    const calls = [];
    const el = { classList: { add: (c) => calls.push('add:' + c), remove: (c) => calls.push('remove:' + c) } };
    const sandbox = {
        APP: { profitPauseNoticeShown: false },
        document: { getElementById: () => el },
        console: { warn() {}, log() {} },
    };
    vm.createContext(sandbox);
    const src = ['openProfitPauseModal', 'closeProfitPauseModal', 'maybeShowProfitPauseModal']
        .map(extractFn)
        .join('\n');
    vm.runInContext(src + ';globalThis.__f = maybeShowProfitPauseModal;', sandbox);

    sandbox.__f(undefined);
    assert.deepStrictEqual(calls, [], 'no status -> no pop-up');
    sandbox.__f({});
    sandbox.__f({ profitPaused: false });
    assert.deepStrictEqual(calls, [], 'false/absent profitPaused -> no pop-up');
    sandbox.__f({ profitPaused: true });
    assert.deepStrictEqual(calls, ['add:open'], 'true -> shown once');
    sandbox.__f({ profitPaused: true });
    sandbox.__f({ profitPaused: true });
    assert.deepStrictEqual(calls, ['add:open'], 'not shown again in the same page load');
    assert.strictEqual(sandbox.APP.profitPauseNoticeShown, true);
});

test('6d. closing and "Add Funds" reuse the existing flow', () => {
    const calls = [];
    const sandbox = {
        APP: {},
        document: { getElementById: () => ({ classList: { add: () => {}, remove: (c) => calls.push('remove:' + c) } }) },
        openDepositModal: () => calls.push('openDepositModal'),
        console: { warn() {}, log() {} },
    };
    vm.createContext(sandbox);
    const src = ['closeProfitPauseModal', 'profitPauseDeposit'].map(extractFn).join('\n');
    vm.runInContext(src + ';globalThis.__close = closeProfitPauseModal;globalThis.__dep = profitPauseDeposit;', sandbox);
    sandbox.__close();
    assert.deepStrictEqual(calls, ['remove:open']);
    sandbox.__dep();
    assert.deepStrictEqual(calls, ['remove:open', 'remove:open', 'openDepositModal'],
        'Add Funds opens the existing deposit modal (no invoice is created here)');
});

test('6e. the app reacts to the server signal at every trading entry point', () => {
    assert.ok(INDEX.includes("maybeShowProfitPauseModal(st);"),
        'wired into the worker-sync tick and on entry');
    assert.ok(INDEX.includes('maybeShowProfitPauseModal({ profitPaused: true });'),
        'wired into the refused-trade path');
    assert.ok(INDEX.includes("errBody.code === 'PROFIT_PAUSE_DEPOSIT_REQUIRED'"));
    assert.ok(INDEX.includes("st.profitPaused === true"),
        'a refused bot start undoes the optimistic loop');
    assert.ok(/profitPauseNoticeShown: false/.test(INDEX));
});

// ---------------------------------------------------------------------------
// 7. i18n parity
// ---------------------------------------------------------------------------
function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

function extractFn(name) {
    const start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist');
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return INDEX.slice(start, end + 1);
}

test('7a. the pop-up copy exists in all 6 locales with full parity', () => {
    const T = loadTranslations();
    assert.deepStrictEqual(Object.keys(T).sort(), LANGS.slice().sort());
    LANGS.forEach((l) => {
        assert.strictEqual(Object.keys(T[l]).length, 1404, l + ' key count');
    });
    const sets = LANGS.map((l) => Object.keys(T[l]).sort().join('|'));
    assert.strictEqual(new Set(sets).size, 1, 'identical key sets across locales');
    LANGS.forEach((l) => {
        ['profitPause.title', 'profitPause.body', 'profitPause.addFunds'].forEach((k) => {
            assert.ok(T[l][k] && T[l][k].trim(), l + '.' + k + ' must be non-empty');
        });
    });
    const en = Object.keys(T.en).filter((k) => /profitpause/i.test(k));
    assert.deepStrictEqual(en.sort(), ['profitPause.addFunds', 'profitPause.body', 'profitPause.title']);
});

test('7b. no pre-existing key or value was changed by this rule', () => {
    // The pop-up keys are additive: nothing else in the dictionary mentions the rule.
    const T = loadTranslations();
    LANGS.forEach((l) => {
        Object.keys(T[l]).forEach((k) => {
            if (/^profitPause\./.test(k)) return;
            assert.ok(!/profit paused/i.test(T[l][k]), l + '.' + k + ' must not describe the rule');
        });
    });
});
