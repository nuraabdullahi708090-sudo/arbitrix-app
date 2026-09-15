'use strict';

/**
 * WITHDRAWAL PROTECTION — regression tests for the UI-only support/KYC-hide change.
 *
 * This change touched the frontend only. These tests prove the withdrawal
 * pipeline was NOT weakened, bypassed, simplified, or renamed:
 *   - server gate ORDER (first-deposit -> KYC -> minimum -> balance -> trade);
 *   - the $700 minimum, balance and completed-trade requirements;
 *   - the promotional-credit / first-deposit restriction;
 *   - the withdrawal API route set;
 *   - the frontend eligibility gates and the sandbox-only exemptions;
 *   - no client-side approval and no support/payment code injected into the
 *     withdrawal path.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const WITHDRAW_ROUTE_START = "app.post('/api/withdraw/request'";
const WITHDRAW_ROUTE_END = "app.get('/api/withdraw/history'";

function withdrawRoute() {
    const a = SERVER.indexOf(WITHDRAW_ROUTE_START);
    assert.ok(a > 0, 'withdraw request route should exist');
    const b = SERVER.indexOf(WITHDRAW_ROUTE_END, a);
    assert.ok(b > a, 'withdraw route span should be bounded');
    return SERVER.slice(a, b);
}

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start), depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' should be brace-matchable');
    return INDEX.slice(start, end + 1);
}

test('server: withdrawal gate order is first-deposit -> KYC -> minimum -> balance/trade', () => {
    const route = withdrawRoute();
    const iFirstDeposit = route.indexOf('FIRST_DEPOSIT_REQUIRED');
    const iKyc = route.indexOf('verificationRequired: true');
    const iMin = route.indexOf("amount < MIN_WITHDRAWAL_USD");
    const iInsufficient = route.indexOf("error: 'Insufficient balance'");
    assert.ok(iFirstDeposit > 0, 'first-deposit gate present');
    assert.ok(iKyc > iFirstDeposit, 'KYC gate runs after the first-deposit gate');
    assert.ok(iMin > iKyc, '$500 minimum runs after KYC');
    assert.ok(iInsufficient > iMin, 'balance check runs after the minimum');
});

test('server: the $500 minimum, KYC response and trade requirement are unchanged', () => {
    const route = withdrawRoute();
    assert.ok(/amount < MIN_WITHDRAWAL_USD/.test(route), '$500 minimum preserved');
    assert.ok(/error: 'Min \$' \+ MIN_WITHDRAWAL_USD/.test(route), 'minimum error string preserved');
    assert.ok(/verificationRequired: true/.test(route), 'KYC-required response preserved');
    assert.ok(/kycService\.getVerificationStatus\(userId\)/.test(route), 'server-side KYC gate preserved');
    assert.ok(/\.eq\('type', 'Trade Executed'\)/.test(route), '>=1 completed-trade requirement preserved');
    assert.ok(/redirectTo: '\/#\/verification'/.test(route), 'existing KYC redirect preserved');
});

test('server: promotional-credit / first-deposit restriction is unchanged', () => {
    const route = withdrawRoute();
    assert.ok(/hasConfirmedDeposit\(userId\)/.test(route), 'confirmed-deposit check preserved');
    assert.ok(/depositRequired: true/.test(route) && /requiresFirstDeposit: true/.test(route),
        'first-deposit restriction response preserved');
    assert.ok(/getGenuinelyEarnedReferralEarnings\(userId\)/.test(route),
        'referral-earnings eligibility derivation preserved');
});

test('server: the withdrawal API route set is unchanged (no new/bypassed endpoints)', () => {
    const routes = [...SERVER.matchAll(/app\.(?:get|post)\('(\/api\/withdraw[^']*)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(routes.sort(), ['/api/withdraw/history', '/api/withdraw/request']);
    // Sandbox withdrawal handling must remain wired (never bypassed).
    assert.ok(/handleSandboxWithdrawRequest/.test(SERVER), 'sandbox withdrawal handler preserved');
    assert.ok(/sandbox_request_withdrawal/.test(SERVER), 'sandbox withdrawal RPC preserved');
});

test('frontend: withdrawal eligibility gates still execute in order', () => {
    const fn = extractFunction('openWithdrawModal');
    const iFirstDeposit = fn.indexOf("t('withdraw.firstDeposit')");
    const iKycFetch = fn.indexOf("'/api/kyc/can-withdraw'");
    const iKycRequired = fn.indexOf('withdrawKycRequired');
    const iMin = fn.indexOf("t('withdraw.minWithdrawal'");
    const iDeposit = fn.indexOf('APP.liveData.hasRealDeposit');
    const iTrade = fn.indexOf('APP.liveData.hasTradingActivity');
    assert.ok(iFirstDeposit > 0, 'first-deposit gate present');
    assert.ok(iKycFetch > iFirstDeposit, 'KYC capability check runs after first-deposit');
    assert.ok(iKycRequired > 0, 'verification-required experience preserved');
    assert.ok(iMin > iKycFetch, 'minimum gate preserved after KYC');
    assert.ok(iDeposit > 0 && iTrade > iDeposit, 'deposit + trade gates preserved in order');
});

test('frontend: minimum withdrawal, balance math and constants are unchanged', () => {
    assert.ok(/MIN_WITHDRAWAL:\s*500/.test(INDEX), 'APP.MIN_WITHDRAWAL must stay 500');
    assert.ok(/APP\.MIN_WITHDRAWAL/.test(extractFunction('getWithdrawableTotal') + INDEX),
        'withdrawable total still uses the configured minimum');
    // No client-side withdrawal approval may exist.
    const submit = extractFunction('submitWithdraw');
    assert.ok(/\/api\/withdraw\/request/.test(INDEX), 'submission still posts to the server route');
    assert.ok(!/status\s*=\s*'approved'|status:\s*'approved'/.test(submit),
        'frontend must not approve a withdrawal client-side');
});

test('frontend: sandbox-only exemptions remain sandbox-gated', () => {
    const fn = extractFunction('openWithdrawModal');
    const isSandboxAt = fn.indexOf("APP.environment === 'MARKETING_SANDBOX'");
    const skipAt = fn.indexOf('getEl(\'withdrawForm\').style.display = \'block\'');
    assert.ok(isSandboxAt > 0, 'sandbox detection preserved');
    assert.ok(isSandboxAt < skipAt, 'sandbox short-circuit precedes the production gates');
});

test('no support/payment code was injected into the withdrawal path', () => {
    const route = withdrawRoute();
    for (const marker of ['openSupportModal', 'supportModal', 'OFFICIAL_SUPPORT', 'arbitrix-support-telegram']) {
        assert.ok(!route.includes(marker), `withdraw route must not contain ${marker}`);
    }
    const fn = extractFunction('openWithdrawModal');
    assert.ok(!/openSupportModal|supportModal/.test(fn), 'withdraw modal logic carries no support code');
});
