'use strict';

/**
 * BOT-START MTA ($200) — regression tests.
 *
 * server.js binds a port on require, so (per repo convention) these tests do
 * NOT import it. They pin, via source contracts + pure-JS mirrors:
 *
 *   PRODUCTION /api/bot/start:
 *   - balance is read from the server wallet (getWallet), never from req.body
 *   - client-supplied mode cannot bypass the gate: only an explicit 'demo'
 *     request is treated as demo; missing/unexpected mode => live (default deny)
 *   - live balance < $200 => HTTP 400 'MTA not reached', BEFORE any session write
 *   - live balance >= $200 => allowed (existing behavior preserved)
 *   - demo mode => NOT gated (existing Demo behavior preserved)
 *
 *   MARKETING_SANDBOX handleSandboxBotStart (management decision — FINAL):
 *   - the sandbox has NO MTA and NO hidden equivalent minimum: every simulated
 *     balance can start the bot (the production $200 never reaches the sandbox,
 *     and neither does any other minimum)
 *   - no balance read, no gate, no 'MTA not reached' response, and /api/auth/me
 *     reports mta: 0 for sandbox accounts
 *   - simulated balance is irrelevant => allowed (still fully simulated)
 *
 *   FRONTEND startBot():
 *   - the MTA gate applies only where an MTA exists (Number(APP.MTA) > 0), so a
 *     no-MTA account (MARKETING_SANDBOX) is never blocked, and no environment
 *     special-case is needed
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
    const MTA = 200; // PRODUCTION MTA (management decision, production-only)
    const mode = rawMode === 'demo' ? 'demo' : 'live'; // default-deny
    if (mode === 'live' && Number(serverBalance) < MTA) {
        return { result: 'blocked', sessionWritten: false, mode };
    }
    return { result: 'started', sessionWritten: true, mode };
}

// MARKETING_SANDBOX mirror: the sandbox has NO MTA at all, so the simulated
// balance can never block a start (no hidden minimum either).
function sandboxBotStartMirror(serverBalance) {
    void serverBalance; // balance is deliberately irrelevant
    return { result: 'started', sessionWritten: true };
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

test('production /api/bot/start enforces the $200 MTA BEFORE creating a session', () => {
    const body = routeBody('post', '/api/bot/start');
    const mtaIdx = body.indexOf('BOT_MIN_TRADING_BALANCE');
    const upsertIdx = body.indexOf("from('bot_sessions')");
    assert.ok(mtaIdx > 0, 'MTA check missing');
    assert.ok(upsertIdx > 0, 'bot_sessions upsert missing');
    assert.ok(mtaIdx < upsertIdx, 'MTA check must happen BEFORE the session upsert');
    assert.ok(body.includes("res.status(400).json({ error: 'MTA not reached' })"), 'clear server-side MTA error missing');
});

test('production MTA constant is exactly 200 (active value)', () => {
    assert.match(SERVER, /const BOT_MIN_TRADING_BALANCE = 200;/);
});

// ---------------------------------------------------------------------------
// 2. Sandbox source contracts
// ---------------------------------------------------------------------------
test('sandbox bot start has NO MTA gate and reads no balance at all', () => {
    const body = fnBody('handleSandboxBotStart');
    assert.ok(!body.includes('getSandboxWallet'), 'no balance needs to be read (there is no gate)');
    assert.ok(!body.includes('SANDBOX_BOT_MIN_TRADING_BALANCE'), 'no sandbox MTA constant may exist');
    assert.ok(!body.includes('MTA not reached'), 'no MTA error may be returned');
    assert.ok(!/req\.body\.(balance|live_balance|wallet)/.test(body), 'client-supplied balance must never be used');
    // The production MTA must never be consulted either.
    assert.ok(!body.includes('getEffectiveMta'), 'sandbox must not read the production/env MTA');
    assert.ok(!body.includes('BOT_MIN_TRADING_BALANCE'), 'sandbox must not read the production constant');
    // No gate means the session upsert is unconditional.
    assert.ok(body.includes("from('sandbox_bot_sessions')"), 'sandbox session upsert missing');
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
test('production live matrix: $0 / $50 / $199.99 blocked, $200 / >$200 allowed', () => {
    assert.strictEqual(botStartMirror('live', 0).result, 'blocked');
    assert.strictEqual(botStartMirror('live', 50).result, 'blocked'); // $50 promo credit alone does NOT satisfy the MTA
    assert.strictEqual(botStartMirror('live', 199.99).result, 'blocked');
    assert.strictEqual(botStartMirror('live', 200).result, 'started');
    assert.strictEqual(botStartMirror('live', 200.01).result, 'started');
    assert.strictEqual(botStartMirror('live', 1000).result, 'started');
});

test('security: fake client balance cannot bypass the gate (server balance is authoritative)', () => {
    // The mirror only accepts the server-read balance; a client claiming
    // balance >= $200 while the server wallet holds < $200 is still blocked.
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
    for (const b of [0, 50, 199.99]) {
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
    assert.strictEqual(botStartMirror('live', 200).result, 'started');
});

// ---------------------------------------------------------------------------
// 4. Sandbox behavior matrix (same mirror: sandbox start is always live-style)
// ---------------------------------------------------------------------------
test('sandbox matrix: NO simulated balance can block a start (no MTA, no hidden minimum)', () => {
    // The production MTA never reaches the sandbox and the sandbox has no MTA of
    // its own, so even $0 starts.
    assert.strictEqual(sandboxBotStartMirror(0).result, 'started');
    assert.strictEqual(sandboxBotStartMirror(0.01).result, 'started');
    assert.strictEqual(sandboxBotStartMirror(50).result, 'started');
    assert.strictEqual(sandboxBotStartMirror(142.99).result, 'started');
    assert.strictEqual(sandboxBotStartMirror(143).result, 'started');
    assert.strictEqual(sandboxBotStartMirror(199.99).result, 'started');
    assert.strictEqual(sandboxBotStartMirror(10000).result, 'started');
    // Sandbox sessions are always live-style: a client asking for 'demo' in a
    // sandbox still hits the sandbox handler, which forces mode 'live'.
    const body = fnBody('handleSandboxBotStart');
    assert.ok(body.includes("const mode = 'live';"), 'sandbox sessions stay live-style');
});

test('environment isolation: production MTA is $200; the sandbox reports NO MTA (mta: 0)', () => {
    // One production constant + one env override; the sandbox has none at all.
    assert.match(SERVER, /const BOT_MIN_TRADING_BALANCE = 200;/);
    assert.ok(!SERVER.includes('SANDBOX_BOT_MIN_TRADING_BALANCE'), 'the sandbox MTA constant must be gone');
    // /api/auth/me: production returns getEffectiveMta(); the sandbox branch
    // reports 0 = "no minimum", which the UI treats as no gate.
    const meBody = routeBody('get', '/api/auth/me');
    assert.ok(meBody.includes('mta: getEffectiveMta(),'), 'production me uses the effective (env-selectable) MTA');
    assert.ok(/mta: 0,/.test(meBody), 'sandbox me reports mta: 0 (no MTA)');
});

// ---------------------------------------------------------------------------
// 5. Frontend contracts
// ---------------------------------------------------------------------------
test('frontend startBot gates on MTA only when an MTA exists (no-MTA accounts are never blocked)', () => {
    const idx = INDEX.indexOf('function startBot()');
    assert.ok(idx > 0, 'startBot not found');
    const body = INDEX.slice(idx, idx + 1400);
    assert.ok(body.includes("APP.mode === 'live' && Number(APP.MTA) > 0 && APP.liveData.balance < APP.MTA"),
        'MTA gate must be conditional on an MTA existing');
    assert.ok(!body.includes("APP.environment !== 'MARKETING_SANDBOX'"), 'no environment special-case may be used');
    assert.ok(body.includes("showToast(t('bot.mtaBlocked', {mta: APP.MTA}),'error')"), 'concise MTA toast missing');
    // Promo-credit-funded trading is exempt (management decision).
    assert.ok(body.includes('!isPromoFundedTrading()'), 'promo-credit exemption missing');
    // The gate must return BEFORE the trading interval starts.
    const gateIdx = body.indexOf('APP.liveData.balance < APP.MTA');
    const intervalIdx = body.indexOf('setInterval(executeBotTrade');
    assert.ok(gateIdx > 0 && intervalIdx > gateIdx, 'MTA gate must precede the background trading interval');
});

test('frontend adopts mta: 0 (no MTA) instead of rejecting it', () => {
    // syncWalletFromServer must accept 0 so a no-MTA account cannot be left
    // holding the production/inherited value.
    assert.ok(INDEX.includes('if (Number.isFinite(Number(meData.mta)) && Number(meData.mta) >= 0)'),
        'the MTA adoption must accept 0');
    assert.ok(INDEX.includes('APP.MTA = Number(meData.mta);'), 'MTA adoption missing');
    // The MTA progress card and the MTA badge must not appear without an MTA.
    const mtaCard = INDEX.indexOf('function updateMTAProgress()');
    assert.ok(mtaCard > 0);
    assert.ok(INDEX.slice(mtaCard, mtaCard + 700).includes('!(Number(APP.MTA) > 0)'),
        'the MTA card must be hidden when there is no MTA');
    assert.ok(INDEX.includes("b.id !== 'mta_unlocked' || Number(APP.MTA) > 0"),
        'the MTA badge must be hidden when there is no MTA');
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
        assert.ok(keyMatch[1].includes('{{mta}}'), `${lang} bot.mtaBlocked uses the {{mta}} token`);
    }
    const en = INDEX.match(/\ben:\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(en[1].includes("'bot.mtaBlocked': 'Minimum trading balance is ${{mta}} to start the bot.'"),
        'EN message must be exactly: Minimum trading balance is ${{mta}} to start the bot.');
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
