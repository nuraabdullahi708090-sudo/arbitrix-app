'use strict';

/**
 * Production withdrawal prompt priority — source contracts (Rule A).
 *
 * Pins that /api/withdraw/request returns the clear FIRST-DEPOSIT requirement
 * before the verification prompt for a production account that has never made a
 * real qualifying deposit, while preserving every existing requirement and the
 * MARKETING_SANDBOX branch. The detailed gate-order matrix lives in
 * tests/withdraw_gating.test.js; this file pins the wiring in the real source
 * (server.js + public/index.html) and the i18n copy.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const DEPOSIT_MSG = 'A qualifying first deposit is required before you can withdraw your promotional credit or trading profits.';
const DEPOSIT_CODE = 'FIRST_DEPOSIT_REQUIRED';

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

// Brace-match a top-level function in either source file.
function extractFunction(src, name) {
    const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    const m = src.match(re);
    assert.ok(m, `function ${name} not found`);
    const start = m.index;
    const braceStart = src.indexOf('{', src.indexOf('(', start));
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error(`unterminated function ${name}`);
}

// ---------------------------------------------------------------------------
// 1. Server: first-deposit gate is the FIRST production gate
// ---------------------------------------------------------------------------

test('server: the sandbox branch precedes the production first-deposit gate', () => {
    const body = routeBody('post', '/api/withdraw/request');
    const sandboxIdx = body.indexOf('sandboxHandled(req, res, handleSandboxWithdrawRequest)');
    const depositIdx = body.indexOf('requiresFirstDeposit');
    assert.ok(sandboxIdx > 0, 'sandbox branch missing');
    assert.ok(depositIdx > sandboxIdx, 'the production gate must run only after the sandbox short-circuit');
});

test('server: first-deposit gate precedes the verification prompt and the $500 minimum', () => {
    const body = routeBody('post', '/api/withdraw/request');
    const depositIdx = body.indexOf('requiresFirstDeposit');
    const kycIdx = body.indexOf('kycService.getVerificationStatus');
    const minIdx = body.indexOf('amount < MIN_WITHDRAWAL_USD');
    assert.ok(depositIdx > 0 && kycIdx > depositIdx, 'first-deposit gate must precede verification');
    assert.ok(kycIdx > 0 && minIdx > kycIdx, 'verification must still precede the $500 minimum');
});

test('server: the first-deposit gate requires no confirmed deposit AND no referral funding', () => {
    const body = routeBody('post', '/api/withdraw/request');
    assert.match(body, /hasConfirmedDeposit\(userId\)/);
    assert.match(body, /getGenuinelyEarnedReferralEarnings\(userId\)/);
    assert.match(body, /if \(!hasDeposit && !referralFunded\)/);
});

test('server: the first-deposit response is clear and machine-readable', () => {
    const body = routeBody('post', '/api/withdraw/request');
    assert.ok(body.includes(DEPOSIT_MSG), 'clear first-deposit message missing');
    assert.match(body, /depositRequired: true/);
    assert.match(body, /requiresFirstDeposit: true/);
    assert.match(body, new RegExp(`code: '${DEPOSIT_CODE}'`));
});

test('server: every existing production requirement is preserved', () => {
    const body = routeBody('post', '/api/withdraw/request');
    for (const s of [
        'Identity verification required',
        "Min $' + MIN_WITHDRAWAL_USD",
        'Insufficient balance',
        'Valid address required',
        'Complete at least 1 trade first',
        "verificationRequired: true",
        "redirectTo: '/#/verification'"
    ]) {
        assert.ok(body.includes(s), `missing preserved requirement: ${s}`);
    }
});

test('server: the deposit gate precedes the trade gate (no-deposit user never sees the trade prompt first)', () => {
    const body = routeBody('post', '/api/withdraw/request');
    assert.ok(body.indexOf('requiresFirstDeposit') < body.indexOf('Complete at least 1 trade first'));
});

// ---------------------------------------------------------------------------
// 2. Frontend: prompt priority mirrors the server
// ---------------------------------------------------------------------------

test('frontend: openWithdrawModal checks first deposit BEFORE the KYC capability call', () => {
    const fn = extractFunction(INDEX, 'openWithdrawModal');
    const depositIdx = fn.indexOf("t('withdraw.firstDeposit')");
    const kycIdx = fn.indexOf("fetch('/api/kyc/can-withdraw'");
    assert.ok(depositIdx > 0, 'first-deposit prompt missing from openWithdrawModal');
    assert.ok(kycIdx > 0, 'KYC capability call missing');
    assert.ok(depositIdx < kycIdx, 'first-deposit prompt must be evaluated before the KYC call');
});

test('frontend: the sandbox short-circuit still precedes every production gate', () => {
    const fn = extractFunction(INDEX, 'openWithdrawModal');
    const sandboxIdx = fn.indexOf("const isSandbox = APP.environment === 'MARKETING_SANDBOX'");
    const depositIdx = fn.indexOf("t('withdraw.firstDeposit')");
    assert.ok(sandboxIdx > 0 && sandboxIdx < depositIdx, 'sandbox short-circuit must come first');
});

test('frontend: the server deposit-required response shows the clear prompt', () => {
    const fn = extractFunction(INDEX, 'submitWithdrawAPI');
    assert.ok(fn.includes('data.depositRequired'), 'depositRequired handling missing');
    assert.ok(fn.includes("t('withdraw.firstDeposit')"), 'clear prompt not used');
});

// ---------------------------------------------------------------------------
// 3. i18n (all 6 locales)
// ---------------------------------------------------------------------------

test('i18n: withdraw.firstDeposit exists and is non-empty in all 6 locales', () => {
    const blocks = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const blk = blocks.find((b) => b.includes('const TRANSLATIONS'));
    const start = blk.indexOf('const TRANSLATIONS');
    let i = blk.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < blk.length; i++) {
        if (blk[i] === '{') depth++;
        else if (blk[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + blk.slice(blk.indexOf('{', start), end + 1), sandbox);
    const T = sandbox.T;
    assert.deepStrictEqual(Object.keys(T).sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
    for (const lang of Object.keys(T)) {
        assert.ok(T[lang]['withdraw.firstDeposit'], `${lang}.withdraw.firstDeposit missing`);
        assert.ok(String(T[lang]['withdraw.firstDeposit']).length > 0, `${lang}.withdraw.firstDeposit empty`);
    }
    assert.strictEqual(T.en['withdraw.firstDeposit'], 'Make your first deposit to unlock withdrawals.');
});
