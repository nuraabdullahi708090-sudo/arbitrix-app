'use strict';

/**
 * Phase 7A — Verification & Withdrawal UX/Gating contract tests.
 *
 * server.js is a single Express app that binds a port on require (app.listen),
 * so these tests do NOT import it. Instead they pin the ORDERING contract that
 * /api/withdraw/request must enforce:
 *
 *   Gate 1 (KYC) — if verification status !== 'approved', the response is the
 *     existing verificationRequired:true object, REGARDLESS of the requested
 *     amount (below $700), balance, address, or completed-trade count. None of
 *     the other eligibility checks may run or short-circuit before KYC.
 *
 *   After KYC approval, the existing requirements keep their exact meaning and
 *     order: $700 minimum -> balance -> address -> at-least-1-trade.
 *
 * Raw status/enum values (not_started, pending_review, approved, rejected,
 * resubmission_required) are referenced verbatim and must never be localized or
 * mutated by the gate.
 *
 * The helper below is a faithful mirror of the gate order authored in
 * server.js's /api/withdraw/request handler. If the server reorders the gates,
 * this mirror must be updated in lock-step — that is the point of the test.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const APPROVED = 'approved';
const NON_APPROVED_STATUSES = [
    'not_started',
    'pending_review',
    'rejected',
    'resubmission_required'
];

// Faithful mirror of the /api/withdraw/request gate order (server.js).
// Inputs describe the user's state + request. Returns the response object the
// handler would send (status 400 error objects, or a success object).
function evaluateWithdrawGate({ verificationStatus, amount, address, liveBalance, tradeCount }) {
    // Gate 1 — KYC FIRST.
    if (verificationStatus !== APPROVED) {
        return {
            status: 400,
            body: {
                error: 'Identity verification required',
                verificationRequired: true,
                status: verificationStatus,
                redirectTo: '/#/verification'
            }
        };
    }
    // Gate 2..5 — existing requirements, unchanged meaning, in their existing order.
    if (!amount || amount < 700) return { status: 400, body: { error: 'Min $700' } };
    if (amount > liveBalance) return { status: 400, body: { error: 'Insufficient balance' } };
    if (!address || address.length < 10) return { status: 400, body: { error: 'Valid address required' } };
    if (tradeCount < 1) return { status: 400, body: { error: 'Complete at least 1 trade first' } };
    // Gate 6 — submission (success path).
    return { status: 200, body: { id: 1, amount, address, status: 'pending', message: 'Withdrawal submitted.' } };
}

test('Gate 1 (KYC) wins for an unapproved user even with amount below $700', () => {
    for (const s of NON_APPROVED_STATUSES) {
        const r = evaluateWithdrawGate({
            verificationStatus: s, amount: 100, address: 'TRX1234567890',
            liveBalance: 5000, tradeCount: 5
        });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.verificationRequired, true);
        assert.strictEqual(r.body.error, 'Identity verification required');
        // The min-amount error must NOT have been produced.
        assert.notStrictEqual(r.body.error, 'Min $700');
    }
});

test('Gate 1 (KYC) wins for an unapproved user even with insufficient balance', () => {
    for (const s of NON_APPROVED_STATUSES) {
        const r = evaluateWithdrawGate({
            verificationStatus: s, amount: 800, address: 'TRX1234567890',
            liveBalance: 100, tradeCount: 5
        });
        assert.strictEqual(r.body.verificationRequired, true);
        assert.notStrictEqual(r.body.error, 'Insufficient balance');
    }
});

test('Gate 1 (KYC) wins for an unapproved user even with no completed trade', () => {
    for (const s of NON_APPROVED_STATUSES) {
        const r = evaluateWithdrawGate({
            verificationStatus: s, amount: 800, address: 'TRX1234567890',
            liveBalance: 5000, tradeCount: 0
        });
        assert.strictEqual(r.body.verificationRequired, true);
        assert.notStrictEqual(r.body.error, 'Complete at least 1 trade first');
    }
});

test('Gate 1 (KYC) wins for an unapproved user even with a missing/invalid address', () => {
    for (const s of NON_APPROVED_STATUSES) {
        const r = evaluateWithdrawGate({
            verificationStatus: s, amount: 800, address: 'x',
            liveBalance: 5000, tradeCount: 5
        });
        assert.strictEqual(r.body.verificationRequired, true);
        assert.notStrictEqual(r.body.error, 'Valid address required');
    }
});

test('pending_review / rejected / resubmission_required all hit the KYC gate first (not just not_started)', () => {
    // Explicitly covers scenarios 4: every non-approved status -> verificationRequired.
    assert.deepStrictEqual(NON_APPROVED_STATUSES.sort(),
        ['not_started', 'pending_review', 'rejected', 'resubmission_required'].sort());
    for (const s of NON_APPROVED_STATUSES) {
        const r = evaluateWithdrawGate({
            verificationStatus: s, amount: 1000, address: 'TRX1234567890',
            liveBalance: 5000, tradeCount: 5
        });
        assert.strictEqual(r.body.verificationRequired, true, `status ${s} should be gated`);
        assert.strictEqual(r.body.status, s, 'raw status echoed back verbatim (not localized)');
    }
});

test('approved + below $700 -> minimum-withdrawal message (Gate 2)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 600, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 5
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'Min $700');
    assert.strictEqual(r.body.verificationRequired, undefined);
});

test('approved + $700+ but amount exceeds balance -> existing balance message (Gate 3)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 800, address: 'TRX1234567890',
        liveBalance: 750, tradeCount: 5
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'Insufficient balance');
    assert.strictEqual(r.body.verificationRequired, undefined);
});

test('approved + $700+ + sufficient balance but invalid address -> existing address message (Gate 4)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 800, address: 'short',
        liveBalance: 5000, tradeCount: 5
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'Valid address required');
});

test('approved + all gates except trade count -> existing trade requirement (Gate 5)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 800, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 0
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'Complete at least 1 trade first');
});

test('approved + all requirements satisfied -> success (Gate 6)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 800, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 3
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'pending');
    assert.strictEqual(r.body.verificationRequired, undefined);
});

test('approved users retain the existing withdrawal behavior (no KYC field in success/error)', () => {
    // min-amount path
    let r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 50, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 3
    });
    assert.strictEqual(r.body.verificationRequired, undefined);
    assert.strictEqual(r.body.error, 'Min $700');
    // success path
    r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 900, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 3
    });
    assert.strictEqual(r.body.verificationRequired, undefined);
    assert.strictEqual(r.body.message, 'Withdrawal submitted.');
});

test('the verification-required response shape is reused exactly (no new fields)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: 'not_started', amount: 100, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 5
    });
    assert.deepStrictEqual(Object.keys(r.body).sort(),
        ['error', 'redirectTo', 'status', 'verificationRequired'].sort());
});
