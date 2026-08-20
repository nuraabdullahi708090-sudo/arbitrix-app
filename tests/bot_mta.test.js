'use strict';

/**
 * BOT-START MTA ($143) — regression tests.
 *
 * server.js binds a port on require, so (per repo convention) these tests do
 * NOT import it. They pin, via source contracts + pure-JS mirrors:
 *
 *   PRODUCTION /api/bot/start:
 *   - balance is read from the server wallet (getWallet), never from req.body
 *   - client-supplied mode cannot bypass the gate: only an explicit 'demo'
 *     request is treated as demo; missing/unexpected mode => live (default deny)
 *   - live balance < $143 => HTTP 400 'MTA not reached', BEFORE any session write
 *   - live balance >= $143 => allowed (existing behavior preserved)
 *   - demo mode => NOT gated (existing Demo behavior preserved)
 *
 *   MARKETING_SANDBOX handleSandboxBotStart:
 *   - reads the simulated wallet server-side (getSandboxWallet)
 *   - simulated balance < $143 => HTTP 400 'MTA not reached', BEFORE any
 *     sandbox_bot_sessions write (no session, no trades, no background trading)
 *   - simulated balance >= $143 => allowed (still fully simulated)
 *
 *   FRONTEND startBot():
 *   - the MTA gate applies to MARKETING_SANDBOX too (no exemption)
 *   - uses the concise bot.mtaBlocked toast, present in all 6 locales
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// Helpers (same approach as tests/marketing_sandbox.test.js)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Pure-JS mirror of the server-side gate semantics.
// mode: the RAW client-supplied mode (server normalizes it).
// serverBalance: the balance read from the DB (the ONLY balance that matters).
// Returns 'blocked' or 'started' and whether a session row would be written.
// ---------------------------------------------------------------------------
function botStartMirror(rawMode, serverBalance) {
    const MTA = 143;
    const mode = rawMode === 'demo' ? 'demo' : 'live'; // default-deny
    if (mode === 'live' && Number(serverBalance) < MTA) {
        return { result: 'blocked', sessionWritten: false, mode };
    }
    return { result: 'started', sessionWritten: true, mode };
}

// ---------------------------------------------------------------------------
// 1. Production source contracts
// ---------------------------------------------------------------------------
test('production /api/bot/start reads the balance from the server wallet, never the client', () => {
    const body = routeBody('post', '/api/bot/start');
    assert.ok(body.includes('getWallet(userId)'), 'production route must read the server wallet');
    assert.ok(!/req\.body\.(balance|live_balance|wallet)/.test(body), 'client-supplied balance must never be used');
});

test('production /api/bot/start normalizes mode with default-deny (only explicit demo skips MTA)', () => {
    const body = routeBody('post', '/api/bot/start');
    assert.ok(body.includes("req.body.mode === 'demo' ? 'demo' : 'live'"),
        'missing/unexpected client mode must be treated as live (default deny)');
});

test('production /api/bot/start enforces the $143 MTA BEFORE creating a session', () => {
    const body = routeBody('post', '/api/bot/start');
    const mtaIdx = body.indexOf('BOT_MIN_TRADING_BALANCE');
    const upsertIdx = body.indexOf("from('bot_sessions')");
    assert.ok(mtaIdx > 0, 'MTA check missing');
    assert.ok(upsertIdx > 0, 'bot_sessions upsert missing');
    assert.ok(mtaIdx < upsertIdx, 'MTA check must happen BEFORE the session upsert');
    assert.ok(body.includes("res.status(400).json({ error: 'MTA not reached' })"), 'clear server-side MTA error missing');
});

test('production MTA constant is exactly 143 (value unchanged)', () => {
    assert.match(SERVER, /const BOT_MIN_TRADING_BALANCE = 143;/);
});

// ---------------------------------------------------------------------------
// 2. Sandbox source contracts
// ---------------------------------------------------------------------------
test('sandbox bot start reads the simulated wallet server-side and enforces the MTA', () => {
    const body = fnBody('handleSandboxBotStart');
    assert.ok(body.includes('getSandboxWallet(userId)'), 'sandbox handler must read the simulated wallet');
    assert.ok(!/req\.body\.(balance|live_balance|wallet)/.test(body), 'client-supplied balance must never be used');
    const mtaIdx = body.indexOf('BOT_MIN_TRADING_BALANCE');
    const upsertIdx = body.indexOf("from('sandbox_bot_sessions')");
    assert.ok(mtaIdx > 0, 'sandbox MTA check missing');
    assert.ok(upsertIdx > 0, 'sandbox session upsert missing');
    assert.ok(mtaIdx < upsertIdx, 'sandbox MTA check must happen BEFORE the session upsert');
    assert.ok(body.includes("res.status(400).json({ error: 'MTA not reached' })"), 'sandbox MTA error missing');
});

test('sandbox bot start touches no production tables/RPCs', () => {
    const body = fnBody('handleSandboxBotStart');
    for (const ref of ["from('wallets')", "from('bot_sessions')", 'record_trade_safe', 'credit_payment_safe', 'paymentService.']) {
        assert.ok(!body.includes(ref), `sandbox handler references production ${ref}`);
    }
});

// ---------------------------------------------------------------------------
// 3. Production behavior matrix (pure-JS mirror)
// ---------------------------------------------------------------------------
test('production live matrix: $0 / $50 / $142.99 blocked, $143 / >$143 allowed', () => {
    assert.strictEqual(botStartMirror('live', 0).result, 'blocked');
    assert.strictEqual(botStartMirror('live', 50).result, 'blocked'); // $50 promo credit alone does NOT satisfy the MTA
    assert.strictEqual(botStartMirror('live', 142.99).result, 'blocked');
    assert.strictEqual(botStartMirror('live', 143).result, 'started');
    assert.strictEqual(botStartMirror('live', 143.01).result, 'started');
    assert.strictEqual(botStartMirror('live', 1000).result, 'started');
});

test('security: fake client balance cannot bypass the gate (server balance is authoritative)', () => {
    // The mirror only accepts the server-read balance; a client claiming
    // balance >= $143 while the server wallet holds < $143 is still blocked.
    const claimed = 10000; // fake client-supplied balance (never read)
    const actual = 50;     // real server wallet balance
    const r = botStartMirror('live', actual, claimed); // claimed is ignored by the mirror signature
    assert.strictEqual(r.result, 'blocked');
    assert.strictEqual(r.sessionWritten, false);
});

test('security: client-supplied mode cannot bypass the gate', () => {
    for (const m of ['LIVE', 'Live', '', undefined, null, 'sandbox', 'admin', 0]) {
        const r = botStartMirror(m, 50);
        assert.strictEqual(r.mode, 'live', `mode ${String(m)} must normalize to live`);
        assert.strictEqual(r.result, 'blocked');
    }
});

test('security: a blocked request writes no session (and therefore starts no background trading)', () => {
    for (const b of [0, 50, 142.99]) {
        const r = botStartMirror('live', b);
        assert.strictEqual(r.sessionWritten, false, `balance ${b} must not create a session`);
    }
});

test('regression: demo mode is NOT gated (existing Demo behavior preserved)', () => {
    assert.strictEqual(botStartMirror('demo', 0).result, 'started');
    assert.strictEqual(botStartMirror('demo', 50).result, 'started');
    assert.strictEqual(botStartMirror('demo', 1000).result, 'started');
});

test('regression: restart below MTA is blocked (restart uses the same gated start path)', () => {
    // A restart is simply another start request: the same gate applies.
    assert.strictEqual(botStartMirror('live', 100).result, 'blocked');
    assert.strictEqual(botStartMirror('live', 143).result, 'started');
});

// ---------------------------------------------------------------------------
// 4. Sandbox behavior matrix (same mirror: sandbox start is always live-style)
// ---------------------------------------------------------------------------
test('sandbox matrix: $0 / $50 / $142.99 blocked, $143 / >$143 allowed', () => {
    // Sandbox bot sessions are always live-style (mode = 'live' server-side).
    assert.strictEqual(botStartMirror('live', 0).result, 'blocked');
    assert.strictEqual(botStartMirror('live', 50).result, 'blocked');
    assert.strictEqual(botStartMirror('live', 142.99).result, 'blocked');
    assert.strictEqual(botStartMirror('live', 143).result, 'started');
    assert.strictEqual(botStartMirror('live', 10000).result, 'started');
    // Sandbox sessions are always live-style: a client asking for 'demo' in a
    // sandbox still hits the sandbox handler, which forces mode 'live'.
    const body = fnBody('handleSandboxBotStart');
    assert.ok(body.includes("const mode = 'live';"), 'sandbox sessions stay live-style');
});

// ---------------------------------------------------------------------------
// 5. Frontend contracts
// ---------------------------------------------------------------------------
test('frontend startBot gates on MTA for live-style trading INCLUDING the sandbox', () => {
    const idx = INDEX.indexOf('function startBot()');
    assert.ok(idx > 0, 'startBot not found');
    const body = INDEX.slice(idx, idx + 1200);
    assert.ok(body.includes("APP.mode === 'live' && APP.liveData.balance < APP.MTA"), 'MTA gate missing');
    assert.ok(!body.includes("APP.environment !== 'MARKETING_SANDBOX'"), 'sandbox exemption must be removed');
    assert.ok(body.includes("showToast(t('bot.mtaBlocked'),'error')"), 'concise MTA toast missing');
    // The gate must return BEFORE the trading interval starts.
    const gateIdx = body.indexOf('APP.liveData.balance < APP.MTA');
    const intervalIdx = body.indexOf('setInterval(executeBotTrade');
    assert.ok(gateIdx > 0 && intervalIdx > gateIdx, 'MTA gate must precede the background trading interval');
});

test('bot.mtaBlocked exists in all 6 locales with the exact EN message', () => {
    const langs = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
    for (const lang of langs) {
        const re = new RegExp('\\b' + lang + ':\\s*\\{([\\s\\S]*?)\\n\\s{4}\\},');
        const m = INDEX.match(re);
        assert.ok(m, `${lang} block found`);
        const keyMatch = m[1].match(/'bot\.mtaBlocked':\s*'((?:[^'\\]|\\.)*)'/);
        assert.ok(keyMatch, `${lang} has bot.mtaBlocked`);
        assert.ok(keyMatch[1].trim().length > 0, `${lang} bot.mtaBlocked non-empty`);
        assert.ok(keyMatch[1].includes('$143'), `${lang} bot.mtaBlocked keeps the $143 token`);
    }
    const en = INDEX.match(/\ben:\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(en[1].includes("'bot.mtaBlocked': 'Minimum trading balance is $143 to start the bot.'"),
        'EN message must be exactly: Minimum trading balance is $143 to start the bot.');
});

// ---------------------------------------------------------------------------
// 6. Regression: unrelated surfaces untouched by this fix
// ---------------------------------------------------------------------------
test('regression: /api/trade has no MTA gate (running-session behavior unchanged)', () => {
    const body = routeBody('post', '/api/trade');
    assert.ok(!body.includes('BOT_MIN_TRADING_BALANCE'), 'trade execution must not gain an MTA gate');
    assert.ok(body.includes("record_trade_safe"), 'production trade RPC intact');
});

test('regression: /api/bot/stop is never MTA-gated (stopping must always work)', () => {
    const body = routeBody('post', '/api/bot/stop');
    assert.ok(!body.includes('BOT_MIN_TRADING_BALANCE'), 'stop must not be gated');
});

test('regression: subscription routes are untouched by the MTA change', () => {
    for (const [m, r] of [['get', '/api/subscription'], ['post', '/api/subscription/activate'], ['post', '/api/subscription/cancel']]) {
        const body = routeBody(m, r);
        assert.ok(!body.includes('BOT_MIN_TRADING_BALANCE'), `${r} must not reference the MTA`);
    }
});
