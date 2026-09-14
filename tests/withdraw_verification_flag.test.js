'use strict';

/**
 * TEMPORARY withdrawal verification gate (Stage 19C).
 *
 * Management decision: account verification is NOT required to withdraw right
 * now. The requirement is DISABLED behind a single server-side flag
 * (WITHDRAWAL_REQUIRES_VERIFICATION, default false) so it can be restored by
 * setting the env var to true - the gate code itself is untouched.
 *
 * These tests prove:
 *   1. an unverified user is not rejected solely because of missing verification;
 *   2. the request proceeds to the NEXT applicable validation;
 *   3. minimum withdrawal amount enforcement remains active;
 *   4. completed-trade enforcement remains active;
 *   5. balance and wallet validation remain active;
 *   6. pending/duplicate + authorization protections remain active;
 *   7. the verification-required modal is not shown for the removed condition;
 *   8. verified-user behavior is unchanged;
 *   9. flipping the flag restores the previous gate exactly;
 *  10. no unrelated withdrawal / financial logic changed.
 *
 * server.js binds a port on require, so it is inspected at the source level
 * (same approach as tests/withdraw_gating.test.js and tests/sandbox_no_kyc.test.js).
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');

const routeStart = SERVER.indexOf("app.post('/api/withdraw/request'");
const routeEnd = SERVER.indexOf("app.get('/api/withdraw/history'");
const WITHDRAW_ROUTE = SERVER.slice(routeStart, routeEnd);
const canStart = SERVER.indexOf("app.get('/api/kyc/can-withdraw'");
const CAN_WITHDRAW = SERVER.slice(canStart, SERVER.indexOf('// ---------- Admin KYC Management ----------'));

// ------------------------------------------------------------------ the flag
test('the verification requirement is controlled by ONE env-driven flag', () => {
    const m = SERVER.match(/const WITHDRAWAL_REQUIRES_VERIFICATION =\s*\n\s*String\(process\.env\.WITHDRAWAL_REQUIRES_VERIFICATION[^;]*;/);
    assert.ok(m, 'the flag constant must be defined once');
    assert.strictEqual(SERVER.split('const WITHDRAWAL_REQUIRES_VERIFICATION =').length - 1, 1,
        'exactly one definition (single source of truth)');
});

test('the flag defaults to FALSE (verification not required) for missing/invalid values', () => {
    const expr = "String(process.env.WITHDRAWAL_REQUIRES_VERIFICATION || '').trim().toLowerCase() === 'true'";
    const run = (env) => vm.runInNewContext(expr, { process: { env } });
    assert.strictEqual(run({}), false, 'unset -> not required');
    assert.strictEqual(run({ WITHDRAWAL_REQUIRES_VERIFICATION: '' }), false, 'empty -> not required');
    assert.strictEqual(run({ WITHDRAWAL_REQUIRES_VERIFICATION: 'false' }), false, 'false -> not required');
    assert.strictEqual(run({ WITHDRAWAL_REQUIRES_VERIFICATION: 'yes' }), false, 'anything but true -> not required');
    assert.strictEqual(run({ WITHDRAWAL_REQUIRES_VERIFICATION: 'true' }), true, 'true -> required (restore)');
    assert.strictEqual(run({ WITHDRAWAL_REQUIRES_VERIFICATION: ' TRUE ' }), true, 'normalised');
});

test('1/2. the withdraw KYC gate is skipped unless the flag is on (unverified -> next validation)', () => {
    assert.ok(WITHDRAW_ROUTE.includes('if (WITHDRAWAL_REQUIRES_VERIFICATION) {'),
        'the verification block must be wrapped in the flag');
    const flagIdx = WITHDRAW_ROUTE.indexOf('if (WITHDRAWAL_REQUIRES_VERIFICATION) {');
    const kycIdx = WITHDRAW_ROUTE.indexOf('kycService.getVerificationStatus(userId)', flagIdx);
    const minIdx = WITHDRAW_ROUTE.indexOf("amount < 700");
    assert.ok(kycIdx > flagIdx, 'the KYC lookup lives inside the flag branch');
    assert.ok(minIdx > kycIdx, 'the next applicable validation (minimum) follows the gate');
    const between = WITHDRAW_ROUTE.slice(flagIdx, WITHDRAW_ROUTE.indexOf('\n  }', flagIdx));
    assert.ok(!/\bthrow\b/.test(between), 'the disabled branch cannot throw');
});

test('9. the previous behavior is fully preserved behind the flag (restore path)', () => {
    const flagIdx = WITHDRAW_ROUTE.indexOf('if (WITHDRAWAL_REQUIRES_VERIFICATION) {');
    const block = WITHDRAW_ROUTE.slice(flagIdx, WITHDRAW_ROUTE.indexOf('\n  }', flagIdx));
    assert.ok(block.includes('kycService.getVerificationStatus'), 'verification status still read');
    assert.ok(block.includes('VERIFICATION_STATUS.APPROVED'), 'approval still required when enabled');
    assert.ok(block.includes("error: 'Identity verification required'"), 'existing error preserved');
    assert.ok(block.includes('verificationRequired: true'), 'existing machine-readable flag preserved');
    assert.ok(block.includes("redirectTo: '/#/verification'"), 'existing redirect preserved');
});

// --------------------------------------------------- the capability endpoint
test('capability check reports canWithdraw=true while verification is not required', () => {
    assert.ok(/const requiresVerification = WITHDRAWAL_REQUIRES_VERIFICATION;/.test(CAN_WITHDRAW),
        'reads the single flag');
    assert.ok(/canWithdraw: requiresVerification \? isVerified : true,/.test(CAN_WITHDRAW),
        'canWithdraw follows the flag');
    assert.ok(/verificationRequired: requiresVerification && !isVerified,/.test(CAN_WITHDRAW),
        'verificationRequired is only reported when the flag is on');
    assert.ok(CAN_WITHDRAW.includes("'Verification not required for withdrawals'"), 'honest message');
    assert.ok(CAN_WITHDRAW.includes("'Identity verified'"), 'verified message unchanged');
});

test('the sandbox capability short-circuit is untouched (before the production branch)', () => {
    const sbx = CAN_WITHDRAW.indexOf('isMarketingSandboxUser(userId)');
    const prod = CAN_WITHDRAW.indexOf('const status = await kycService.getVerificationStatus(userId)');
    assert.ok(sbx > 0 && prod > sbx, 'sandbox branch still precedes production');
    assert.ok(CAN_WITHDRAW.includes("verificationStatus: 'sandbox'"), 'sandbox response unchanged');
});

test('8. verified users are unaffected by the change', () => {
    assert.ok(/message: isVerified\s*\n\s*\? 'Identity verified'/.test(CAN_WITHDRAW),
        'verified accounts still report the verified message');
    assert.ok(/canWithdraw: requiresVerification \? isVerified : true,/.test(CAN_WITHDRAW),
        'verified accounts are true in both modes');
});

// ------------------------------------------------------- preserved protections
test('3. minimum withdrawal amount enforcement remains active', () => {
    assert.ok(WITHDRAW_ROUTE.includes('if (!amount || amount < 700) return res.status(400).json({ error: '), 'minimum guard present');
    assert.ok(WITHDRAW_ROUTE.includes("'Min $700'"), 'existing message unchanged');
});

test('4. completed-trade enforcement remains active', () => {
    assert.ok(WITHDRAW_ROUTE.includes("'Complete at least 1 trade first'"), 'trade gate present');
    assert.ok(WITHDRAW_ROUTE.includes('hasTrade'), 'trade check present');
});

test('5. balance and wallet validation remain active', () => {
    assert.ok(WITHDRAW_ROUTE.includes("'Insufficient balance'"), 'balance guard present');
    assert.ok(WITHDRAW_ROUTE.includes('liveBalance'), 'wallet balance is read');
    assert.ok(WITHDRAW_ROUTE.includes("updateWallet(userId, 'live_balance'"), 'wallet debit unchanged');
});

test('5b. wallet address validation remains active', () => {
    assert.ok(WITHDRAW_ROUTE.includes("if (!address || address.length < 10) return res.status(400).json({ error: 'Valid address required' })"),
        'address guard unchanged');
});

test('6/7. authorization and the pending-withdrawal record remain active', () => {
    assert.ok(/app\.post\('\/api\/withdraw\/request', authMiddleware,/.test(SERVER), 'route stays authenticated');
    assert.ok(WITHDRAW_ROUTE.includes("from('withdrawals').insert("), 'withdrawal is still recorded');
    assert.ok(WITHDRAW_ROUTE.includes("status: 'pending'"), 'recorded as pending exactly as before');
    assert.ok(!/WITHDRAWAL_REQUIRES_VERIFICATION/.test(WITHDRAW_ROUTE.split("from('withdrawals')")[1] || ''),
        'the flag never affects the persistence path');
});

test('the first-deposit and referral-earnings rules are untouched', () => {
    const depIdx = WITHDRAW_ROUTE.indexOf('depositRequired: true');
    const flagIdx = WITHDRAW_ROUTE.indexOf('if (WITHDRAWAL_REQUIRES_VERIFICATION) {');
    assert.ok(depIdx > 0, 'first-deposit gate present');
    assert.ok(depIdx < flagIdx, 'first-deposit priority still precedes the verification gate');
    assert.ok(WITHDRAW_ROUTE.includes('getGenuinelyEarnedReferralEarnings'), 'referral rules present');
});

// --------------------------------------------------------------- the frontend
test('7. the withdrawal modal only shows the verification state when the API says so', () => {
    const fnStart = HTML.indexOf('async function openWithdrawModal()');
    const fn = HTML.slice(fnStart, HTML.indexOf('function closeWithdrawModal()', fnStart));
    assert.ok(fn.includes("fetch('/api/kyc/can-withdraw'"), 'capability call present');
    assert.ok(/if \(!kycData\.canWithdraw\) \{/.test(fn), 'verification state is API-driven');
    const showIdx = fn.indexOf("getEl('withdrawKycRequired').style.display = 'block'");
    assert.ok(showIdx > fn.indexOf('!kycData.canWithdraw'), 'only shown inside the canWithdraw=false branch');
});

test('the API accepts the request, so the frontend can no longer block on verification alone', () => {
    // The frontend has no independent verification gate: every appearance of the
    // verification-required block is either sandbox-hidden or response-driven.
    const sites = HTML.split("getEl('withdrawKycRequired').style.display").length - 1;
    assert.ok(sites >= 3, 'expected the known show/hide sites, got ' + sites);
    assert.ok(!/APP\.kycVerified|kycData\.canWithdraw\s*=\s*false\s*;/.test(HTML),
        'no client-side verification override exists');
    assert.ok(HTML.includes('if (data.verificationRequired) {'),
        'the response path is kept so the flag can be restored without frontend work');
});

test('the verification system itself is not removed', () => {
    assert.ok(SERVER.includes('kycService.getVerificationStatus'), 'KYC service still used');
    assert.ok(SERVER.includes('VERIFICATION_STATUS.APPROVED'), 'verification statuses still referenced');
    assert.ok(/app\.get\('\/api\/kyc\/status'/.test(SERVER), 'KYC status endpoint still present');
    assert.ok(/app\.post\('\/api\/kyc\/submit'/.test(SERVER) || SERVER.includes('/api/kyc/'), 'KYC collection endpoints still present');
    assert.ok(SERVER.includes('blockSandboxKyc'), 'sandbox KYC guard untouched');
});

test('.env.example documents the temporary flag with its default', () => {
    assert.ok(ENV_EXAMPLE.includes('WITHDRAWAL_REQUIRES_VERIFICATION=false'),
        'the flag is documented as false (verification not required)');
    assert.ok(/restore/i.test(ENV_EXAMPLE), 'the restore instruction is documented');
});

test('the change is confined to the flag, the gate and the capability response', () => {
    // Only non-comment code reads the flag: the 2-line definition, the withdraw
    // gate, and the capability response. Nothing else in the server uses it.
    const code = SERVER.split('\n')
        .filter((l) => /WITHDRAWAL_REQUIRES_VERIFICATION/.test(l) && !l.trim().startsWith('//'));
    assert.strictEqual(code.length, 4, 'unexpected flag usage: ' + JSON.stringify(code.map((l) => l.trim())));
    assert.strictEqual(code.filter((l) => l.includes('const WITHDRAWAL_REQUIRES_VERIFICATION =')).length, 1, 'single definition');
    assert.strictEqual(code.filter((l) => l.includes('if (WITHDRAWAL_REQUIRES_VERIFICATION) {')).length, 1, 'single withdraw gate');
    assert.strictEqual(code.filter((l) => l.includes('requiresVerification = WITHDRAWAL_REQUIRES_VERIFICATION')).length, 1, 'single capability read');
});
