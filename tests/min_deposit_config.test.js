'use strict';

/**
 * Platform minimum deposit: ONE runtime source.
 *
 * WHY
 *   The minimum deposit used to be a bare constant consumed in ~17 places. Before
 *   the business can consider moving it from $100 to $50 (a separate, approval-
 *   gated decision) the value had to become a single knob that every consumer
 *   reads, otherwise a change would half-apply (invoice creation at $50, the
 *   sandbox at $100, the referral qualifying deposit at the value stored in
 *   `referral_config`, and the frontend copy still saying $100).
 *
 * WHAT THESE TESTS PIN
 *   1. With no env var the effective value is EXACTLY the built-in default, so
 *      shipping this code changes no behaviour (the $100 platform rule stands).
 *   2. The env override is validated: a malformed or out-of-range value is
 *      rejected loudly and falls back to the default, never to a nonsense floor.
 *   3. Every runtime consumer reads the resolved value, not the raw default.
 *   4. /api/auth/me publishes the effective value in BOTH the production and
 *      MARKETING_SANDBOX branches, and the frontend adopts it.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/**
 * Evaluate the REAL resolver block from server.js in an isolated context with a
 * fake environment, so the matrix exercises the shipped code rather than a copy.
 */
function resolve(env) {
    const start = SERVER.indexOf('const PLATFORM_MIN_DEPOSIT_USD = 100;');
    const end = SERVER.indexOf('const PLATFORM_MIN_DEPOSIT = resolvePlatformMinDeposit();');
    assert.ok(start > 0 && end > start, 'the resolver block must exist in server.js');
    const src = SERVER.slice(start, end) +
        'const PLATFORM_MIN_DEPOSIT = resolvePlatformMinDeposit();' +
        ';globalThis.__out = { PLATFORM_MIN_DEPOSIT, PLATFORM_MIN_DEPOSIT_USD, MIN_DEPOSIT_ENV_VAR };';

    const logs = [];
    const sandbox = {
        process: { env },
        console: { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return { ...sandbox.__out, logs };
}

/* ------------------------------------------------------------------ *
 * 1. No env var -> unchanged behaviour
 * ------------------------------------------------------------------ */
test('with no env var the effective minimum is the built-in $100', () => {
    const r = resolve({});
    assert.strictEqual(r.PLATFORM_MIN_DEPOSIT_USD, 100, 'the pinned default must stay 100');
    assert.strictEqual(r.PLATFORM_MIN_DEPOSIT, 100, 'effective value equals the default');
    assert.deepStrictEqual(r.logs, [], 'no noise when nothing is overridden');
});

test('the env var NAME is PLATFORM_MIN_DEPOSIT_USD', () => {
    assert.strictEqual(resolve({}).MIN_DEPOSIT_ENV_VAR, 'PLATFORM_MIN_DEPOSIT_USD');
});

test('an empty or whitespace-only value is treated as unset', () => {
    for (const v of ['', '   ', '\t']) {
        assert.strictEqual(resolve({ PLATFORM_MIN_DEPOSIT_USD: v }).PLATFORM_MIN_DEPOSIT, 100, JSON.stringify(v));
    }
});

/* ------------------------------------------------------------------ *
 * 2. The override works and is validated
 * ------------------------------------------------------------------ */
test('a valid override is applied and logged once', () => {
    const r = resolve({ PLATFORM_MIN_DEPOSIT_USD: '50' });
    assert.strictEqual(r.PLATFORM_MIN_DEPOSIT, 50);
    assert.strictEqual(r.logs.length, 1);
    assert.match(r.logs[0], /overridden: \$50/);
});

test('surrounding whitespace in the override is tolerated', () => {
    assert.strictEqual(resolve({ PLATFORM_MIN_DEPOSIT_USD: '  50  ' }).PLATFORM_MIN_DEPOSIT, 50);
});

test('invalid overrides fall back to the default and warn', () => {
    const cases = ['abc', '50.5', 'NaN', '-50', '0', '5', '9', '10001', '1e6', '50usd'];
    for (const v of cases) {
        const r = resolve({ PLATFORM_MIN_DEPOSIT_USD: v });
        assert.strictEqual(r.PLATFORM_MIN_DEPOSIT, 100, 'value ' + JSON.stringify(v) + ' must fall back');
        assert.strictEqual(r.logs.length, 1, 'value ' + JSON.stringify(v) + ' must warn');
        assert.match(r.logs[0], /invalid/);
    }
});

test('the accepted band is 10..10000 inclusive', () => {
    assert.strictEqual(resolve({ PLATFORM_MIN_DEPOSIT_USD: '10' }).PLATFORM_MIN_DEPOSIT, 10);
    assert.strictEqual(resolve({ PLATFORM_MIN_DEPOSIT_USD: '10000' }).PLATFORM_MIN_DEPOSIT, 10000);
    assert.strictEqual(resolve({ PLATFORM_MIN_DEPOSIT_USD: '9' }).PLATFORM_MIN_DEPOSIT, 100);
    assert.strictEqual(resolve({ PLATFORM_MIN_DEPOSIT_USD: '10001' }).PLATFORM_MIN_DEPOSIT, 100);
});

/* ------------------------------------------------------------------ *
 * 3. Every consumer reads the resolved value
 * ------------------------------------------------------------------ */
test('no runtime consumer reads the raw default', () => {
    // Allowed: the declaration itself and the resolver's own fallbacks.
    const start = SERVER.indexOf('const PLATFORM_MIN_DEPOSIT_USD = 100;');
    const end = SERVER.indexOf('const PLATFORM_MIN_DEPOSIT = resolvePlatformMinDeposit();') + 10;
    const outside = SERVER.slice(0, start) + SERVER.slice(end);
    const offenders = outside.split('\n')
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.includes('PLATFORM_MIN_DEPOSIT_USD') && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    assert.deepStrictEqual(offenders.map((o) => o.l.trim()), [],
        'only the resolver may reference the raw default');
});

test('the invoice route enforces the resolved value', () => {
    const i = SERVER.indexOf("app.post('/api/payment/create-invoice'");
    assert.ok(i > 0);
    const body = SERVER.slice(i, i + 2600);
    assert.match(body, /const MIN_DEPOSIT_AMOUNT = PLATFORM_MIN_DEPOSIT;/);
    assert.match(body, /amount < MIN_DEPOSIT_AMOUNT/);
});

test('the sandbox simulated deposit uses the same resolved value', () => {
    assert.ok(SERVER.includes('if (!amt || amt < PLATFORM_MIN_DEPOSIT) {'),
        'both sandbox deposit doors must use the resolved value');
});

test('the referral qualifying-deposit fallback uses the resolved value', () => {
    assert.ok(SERVER.includes("getReferralConfig('minimum_qualifying_deposit', String(PLATFORM_MIN_DEPOSIT))"));
});

test('MARKETING_SANDBOX referral minimum derives from the resolved value', () => {
    assert.ok(SERVER.includes('const SANDBOX_REFERRAL_MIN_DEPOSIT = PLATFORM_MIN_DEPOSIT;'));
});

/* ------------------------------------------------------------------ *
 * 4. The customer-facing value follows the server
 * ------------------------------------------------------------------ */
test('/api/auth/me publishes minDeposit in BOTH branches', () => {
    const i = SERVER.indexOf("app.get('/api/auth/me'");
    assert.ok(i > 0);
    const body = SERVER.slice(i, SERVER.indexOf('// ---------- Marketing conversion claims', i));
    const hits = (body.match(/minDeposit: PLATFORM_MIN_DEPOSIT,/g) || []).length;
    assert.strictEqual(hits, 2, 'production and sandbox branches both report it');
    assert.ok(body.indexOf('minDeposit: PLATFORM_MIN_DEPOSIT,') < body.indexOf('environment: ENV_MARKETING_SANDBOX') + 400,
        'the sandbox branch carries it too');
});

test('the frontend adopts the server value into APP.MIN_DEPOSIT', () => {
    assert.match(INDEX, /typeof meData\.minDeposit === 'number'/, 'must type-check the field');
    assert.match(INDEX, /APP\.MIN_DEPOSIT = Number\(meData\.minDeposit\)/);
    // and the built-in default still exists for the offline path
    assert.match(INDEX, /MIN_DEPOSIT: 100,/);
});

test('APP.MIN_DEPOSIT remains the single frontend source', () => {
    // Deposit validation and the min-amount notice read it. The Live Mode guide
    // no longer quotes a funding amount (product decision), so there is one less
    // place for the figure to drift - not one more copy of it.
    assert.match(INDEX, /const MIN_DEPOSIT_AMOUNT = APP\.MIN_DEPOSIT;/);
    assert.match(INDEX, /t\('deposit\.minDeposit', \{ min: Number\(APP\.MIN_DEPOSIT\) \}\)/);
    assert.ok(!/startHere\.live\.step1/.test(INDEX), 'the guide no longer interpolates the minimum');
});
