'use strict';

/**
 * BOT START GATE — MTA REMOVED (management decision).
 *
 * The Minimum Trading Amount (MTA) has been REMOVED from production. There is
 * no longer any minimum live balance required to start the bot. server.js binds
 * a port on require, so (per repo convention) these tests do NOT import it.
 * They pin, via source contracts + pure-JS mirrors:
 *
 *   PRODUCTION /api/bot/start:
 *   - NO MTA gate, NO MTA constant, NO MTA_AMOUNT env override, NO 'MTA not
 *     reached' response, and no server-side balance read for gating
 *   - client-supplied mode is still normalized default-deny (only an explicit
 *     'demo' request is demo), but demo/live no longer differ by any threshold
 *   - the promotional-credit $20 realized-profit cap (a SEPARATE rule) is still
 *     enforced BEFORE the bot_session upsert
 *
 *   MARKETING_SANDBOX handleSandboxBotStart:
 *   - unchanged: no balance gate, no production tables/RPCs
 *
 *   FRONTEND startBot():
 *   - NO MTA gate and no APP.MTA reference anywhere; the promo cap is the only
 *     live-trading restriction mirrored in the UI
 *   - the MTA i18n keys are removed from all 6 locales; bot.readyToTrade exists
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function stripFullLineComments(s) {
    return s.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
}

function routeBody(method, routePath) {
    const marker = `app.${method}('${routePath}'`;
    const start = SERVER.indexOf(marker);
    assert.ok(start >= 0, `route not found: ${method.toUpperCase()} ${routePath}`);
    const after = SERVER.indexOf('\napp.', start + marker.length);
    return stripFullLineComments(SERVER.slice(start, after < 0 ? undefined : after));
}

function fnBody(name) {
    const idx = SERVER.indexOf(`function ${name}(`);
    assert.ok(idx >= 0, `function not found: ${name}`);
    const start = SERVER.lastIndexOf('async function', idx) >= 0 ? SERVER.lastIndexOf('async function', idx) : idx;
    const next = SERVER.indexOf('\nasync function ', idx + 1);
    const next2 = SERVER.indexOf('\nfunction ', idx + 1);
    let end = next < 0 ? next2 : next;
    if (next2 > 0 && next2 < end) end = next2;
    return stripFullLineComments(SERVER.slice(start < 0 ? idx : start, end < 0 ? undefined : end));
}

function localeBlock(lang) {
    const re = new RegExp('\\b' + lang + ':\\s*\\{([\\s\\S]*?)\\n\\s{4}\\},');
    const m = INDEX.match(re);
    assert.ok(m, `${lang} dictionary block found`);
    return m[1];
}

// ---------------------------------------------------------------------------
// Pure-JS mirror: with the MTA removed, any mode may start the bot.
// ---------------------------------------------------------------------------
function botStartMirror(rawMode) {
    const mode = rawMode === 'demo' ? 'demo' : 'live'; // still default-deny
    return { result: 'started', sessionWritten: true, mode };
}

// ---------------------------------------------------------------------------
// 1. Server: MTA fully removed
// ---------------------------------------------------------------------------
test('server: no MTA constant, env override or helper remains', () => {
    // Comments may still explain the removal; executable code must not.
    const code = stripFullLineComments(SERVER);
    assert.ok(!code.includes('BOT_MIN_TRADING_BALANCE'), 'BOT_MIN_TRADING_BALANCE must be gone');
    assert.ok(!code.includes('MTA_AMOUNT'), 'MTA_AMOUNT env var must no longer be read');
    assert.ok(!code.includes('getEffectiveMta'), 'getEffectiveMta() must be gone');
    assert.ok(!code.includes('SANDBOX_BOT_MIN_TRADING_BALANCE'), 'the sandbox MTA constant must stay gone');
});

test('server: /api/bot/start has NO MTA gate and no balance-based threshold', () => {
    const body = routeBody('post', '/api/bot/start');
    assert.ok(!body.includes('MTA'), 'the route must not mention the MTA');
    assert.ok(!body.includes('MTA not reached'), 'the MTA error must be gone');
    assert.ok(!/live_balance\s*</.test(body), 'no balance threshold may remain');
});

test('server: /api/bot/start still normalizes mode with default-deny', () => {
    const body = routeBody('post', '/api/bot/start');
    assert.ok(body.includes("req.body.mode === 'demo' ? 'demo' : 'live'"),
        'missing/unexpected client mode must be treated as live (default deny)');
});

test('server: the promotional-credit cap is still enforced BEFORE the session upsert', () => {
    const body = routeBody('post', '/api/bot/start');
    const capIdx = body.indexOf('isPromoProfitCapReached');
    const upsertIdx = body.indexOf("from('bot_sessions')");
    assert.ok(capIdx > 0, 'promo-cap check missing');
    assert.ok(upsertIdx > 0, 'bot_sessions upsert missing');
    assert.ok(capIdx < upsertIdx, 'promo-cap check must happen BEFORE the session upsert');
});

// ---------------------------------------------------------------------------
// 2. Sandbox: unchanged (no gate, isolated)
// ---------------------------------------------------------------------------
test('sandbox bot start has NO MTA gate and reads no balance at all', () => {
    const body = fnBody('handleSandboxBotStart');
    assert.ok(!body.includes('MTA'), 'no MTA reference in the sandbox handler');
    assert.ok(!/req\.body\.(balance|live_balance|wallet)/.test(body), 'client-supplied balance must never be used');
    assert.ok(body.includes("from('sandbox_bot_sessions')"), 'sandbox session upsert missing');
});

test('sandbox bot start touches no production tables/RPCs', () => {
    const body = fnBody('handleSandboxBotStart');
    for (const ref of ["from('wallets')", "from('bot_sessions')", 'record_trade_safe', 'credit_payment_safe', 'paymentService.']) {
        assert.ok(!body.includes(ref), `sandbox handler references production ${ref}`);
    }
});

// ---------------------------------------------------------------------------
// 3. Behavior matrix (pure-JS mirror of the new no-gate semantics)
// ---------------------------------------------------------------------------
test('production: every balance can start the bot (no minimum trading amount)', () => {
    for (const m of ['live', 'demo']) {
        for (const b of [0, 0.01, 50, 199.99, 200, 10000]) {
            void b; // balance is irrelevant by design — captured for readability
            assert.strictEqual(botStartMirror(m).result, 'started', `${m} @ ${b} must start`);
        }
    }
});

test('production: mode normalization is unchanged (client mode cannot change the outcome, but stays default-deny)', () => {
    for (const m of ['LIVE', 'Live', '', undefined, null, 'sandbox', 'admin', 0]) {
        assert.strictEqual(botStartMirror(m).mode, 'live', `mode ${String(m)} must normalize to live`);
        assert.strictEqual(botStartMirror(m).result, 'started');
    }
    assert.strictEqual(botStartMirror('demo').mode, 'demo');
});

test('still-stopped safety: the promo-credit cap remains the only live-trading stop', () => {
    const body = routeBody('post', '/api/bot/start');
    assert.ok(body.includes('promoLimitBody('), 'the promo-limit body must be returned when capped');
    assert.ok(body.includes('stopBotSessionForPromoLimit'), 'the running session must be stopped when capped');
});

// ---------------------------------------------------------------------------
// 4. Frontend contracts
// ---------------------------------------------------------------------------
test('frontend: startBot has no MTA gate; the promo cap is the only stop', () => {
    const idx = INDEX.indexOf('function startBot()');
    assert.ok(idx > 0, 'startBot not found');
    const body = INDEX.slice(idx, idx + 2200);
    assert.ok(!body.includes('APP.MTA'), 'startBot must not reference an MTA');
    assert.ok(body.includes('APP.liveData.promoLimitReached'), 'promo-cap gate missing');
    assert.ok(body.includes("showToast(t('bot.promoLimitReached'),'error', 6000)"), 'promo-cap toast missing');
    const capIdx = body.indexOf('promoLimitReached');
    const intervalIdx = body.indexOf('setInterval(executeBotTrade');
    assert.ok(capIdx > 0 && intervalIdx > capIdx, 'the stop must precede the background trading interval');
});

test('frontend: no APP.MTA reference or MTA UI remains anywhere', () => {
    assert.ok(!INDEX.includes('APP.MTA'), 'no APP.MTA reference may remain');
    assert.ok(!INDEX.includes('isNonDepositedTrading'), 'the retired MTA-exemption helper must be gone');
    assert.ok(!INDEX.includes('function updateMTAProgress'), 'the MTA progress card function must be gone');
    assert.ok(!INDEX.includes('id="mtaProgressCard"'), 'the MTA progress card markup must be gone');
    assert.ok(!INDEX.includes('mta_unlocked'), 'the MTA badge must be gone');
    assert.ok(!INDEX.includes('meData.mta'), 'the frontend must no longer adopt a server MTA');
    assert.ok(!INDEX.includes('.mta-'), 'the MTA CSS must be gone');
});

test('i18n: every MTA key is removed from all 6 locales; bot.readyToTrade exists', () => {
    const removed = ['bot.reachMTA', 'bot.mtaBlocked', 'bot.mtaMet', 'mta.title', 'mta.subtitle',
        'mta.inProgress', 'mta.targetLabel', 'mta.of', 'mta.nearlyThere', 'mta.greatProgress',
        'mta.depositMore', 'mta.moreToUnlock', 'mta.depositNow', 'mta.reached',
        'badges.mtaUnlocked', 'badges.mtaUnlockedDesc', 'startHere.live.step2',
        'support.reply.botNoMta', 'live.withdrawStatus.belowTradingBalance', 'trade.mtaNotReached'];
    for (const lang of LANGS) {
        const block = localeBlock(lang);
        for (const key of removed) {
            assert.ok(!block.includes(`'${key}':`), `${lang} must not define ${key}`);
        }
        assert.ok(block.includes("'bot.readyToTrade':"), `${lang} must define bot.readyToTrade`);
    }
    const en = localeBlock('en');
    assert.ok(en.includes("'bot.readyToTrade': '✅ Bot ready to trade'"), 'EN bot.readyToTrade exact');
});

// ---------------------------------------------------------------------------
// 5. Regression: unrelated surfaces untouched
// ---------------------------------------------------------------------------
test('regression: /api/trade has no MTA gate', () => {
    const body = routeBody('post', '/api/trade');
    assert.ok(!body.includes('BOT_MIN_TRADING_BALANCE'), 'trade execution must not gain an MTA gate');
    assert.ok(body.includes('record_trade_safe'), 'production trade RPC intact');
});

test('regression: /api/bot/stop is never gated', () => {
    const body = routeBody('post', '/api/bot/stop');
    assert.ok(!body.includes('BOT_MIN_TRADING_BALANCE'), 'stop must not be gated');
});

test('regression: subscription routes are untouched', () => {
    for (const [m, r] of [['get', '/api/subscription'], ['post', '/api/subscription/activate'], ['post', '/api/subscription/cancel']]) {
        const body = routeBody(m, r);
        assert.ok(!body.includes('BOT_MIN_TRADING_BALANCE'), `${r} must not reference the MTA`);
    }
});
