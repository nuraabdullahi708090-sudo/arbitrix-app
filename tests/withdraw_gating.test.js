'use strict';

/**
 * Withdrawal prompt priority — production gating contract tests.
 *
 * server.js is a single Express app that binds a port on require (app.listen),
 * so these tests do NOT import it. Instead they pin the ORDERING contract that
 * /api/withdraw/request must enforce for PRODUCTION accounts:
 *
 *   Gate 1 (FIRST DEPOSIT) — if the user has no confirmed deposit and the
 *     request is not fully funded by genuinely earned referral earnings, the
 *     FIRST prompt is the clear first-deposit requirement — REGARDLESS of the
 *     verification status, requested amount (even below $700), balance, address,
 *     or completed-trade count. This covers a user who only holds the $50
 *     promotional credit and one who traded it for a profit.
 *
 *   Gate 2 (KYC) — otherwise, if verification status !== 'approved', the
 *     existing verificationRequired:true object is returned, REGARDLESS of the
 *     requested amount (below $700), balance, address, or completed-trade count.
 *
 *   Gate 3+ — after KYC approval the existing requirements keep their exact
 *     meaning and order: $700 minimum -> balance -> address -> at-least-1-trade.
 *
 * The referral-earnings exception is preserved: a request fully covered by
 * genuinely earned referral earnings skips the first-deposit gate (and the
 * trade gate) without weakening KYC.
 *
 * Raw status/enum values (not_started, pending_review, approved, rejected,
 * resubmission_required) are referenced verbatim and must never be localized or
 * mutated by the gate.
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
const DEPOSIT_MSG = 'A qualifying first deposit is required before you can withdraw your promotional credit or trading profits.';

// Faithful mirror of the /api/withdraw/request gate order (server.js).
// hasDeposit: true iff at least one confirmed real deposit exists.
// referralAvailable: genuinely earned referral earnings (server-derived).
function evaluateWithdrawGate({
    verificationStatus, amount, address, liveBalance, tradeCount,
    hasDeposit, referralAvailable = 0
}) {
    const requestedAmount = Number(amount) || 0;
    const referralFunded = requestedAmount > 0 && requestedAmount <= referralAvailable;

    // Gate 1 — FIRST-DEPOSIT PRIORITY (production, no confirmed deposit).
    if (!hasDeposit && !referralFunded) {
        return {
            status: 400,
            body: {
                error: DEPOSIT_MSG,
                depositRequired: true,
                requiresFirstDeposit: true,
                code: 'FIRST_DEPOSIT_REQUIRED'
            }
        };
    }
    // Gate 2 — KYC (unchanged).
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
    // Gate 3..6 — existing requirements, unchanged meaning, existing order.
    if (!amount || amount < 700) return { status: 400, body: { error: 'Min $700' } };
    const live = Number(liveBalance) || 0;
    const hasTrade = tradeCount >= 1;
    const requirementsMet = hasTrade && hasDeposit;
    let fromBonus = 0;
    if (requirementsMet) {
        if (amount > live + referralAvailable) return { status: 400, body: { error: 'Insufficient balance' } };
        fromBonus = Math.round((amount - Math.min(amount, live)) * 100) / 100;
    } else if (amount <= referralAvailable) {
        fromBonus = amount;
    } else if (amount > live) {
        return { status: 400, body: { error: 'Insufficient balance' } };
    }
    if (!address || address.length < 10) return { status: 400, body: { error: 'Valid address required' } };
    if (!requirementsMet && fromBonus === 0) {
        if (!hasTrade) return { status: 400, body: { error: 'Complete at least 1 trade first' } };
    }
    // Gate 7 — submission (success path).
    return { status: 200, body: { id: 1, amount, address, status: 'pending', message: 'Withdrawal submitted.' } };
}

// ---------------------------------------------------------------------------
// A. First-deposit priority (production, no confirmed deposit)
// ---------------------------------------------------------------------------

test('promo credit, no trades, unapproved KYC -> first-deposit prompt (NOT verification)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: 'not_started', amount: 800, address: 'TRX1234567890',
        liveBalance: 50, tradeCount: 0, hasDeposit: false
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, DEPOSIT_MSG);
    assert.strictEqual(r.body.depositRequired, true);
    assert.strictEqual(r.body.requiresFirstDeposit, true);
    assert.strictEqual(r.body.verificationRequired, undefined);
});

test('promo credit traded for a profit, still no deposit -> first-deposit prompt', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: 'not_started', amount: 800, address: 'TRX1234567890',
        liveBalance: 70, tradeCount: 12, hasDeposit: false
    });
    assert.strictEqual(r.body.error, DEPOSIT_MSG);
    assert.strictEqual(r.body.verificationRequired, undefined);
});

test('first-deposit prompt wins even for a below-$700 request (priority over Min $700)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: 'not_started', amount: 100, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 5, hasDeposit: false
    });
    assert.strictEqual(r.body.error, DEPOSIT_MSG);
    assert.notStrictEqual(r.body.error, 'Min $700');
});

test('first-deposit prompt wins for every non-approved KYC status (no deposit)', () => {
    for (const s of NON_APPROVED_STATUSES) {
        const r = evaluateWithdrawGate({
            verificationStatus: s, amount: 800, address: 'TRX1234567890',
            liveBalance: 5000, tradeCount: 5, hasDeposit: false
        });
        assert.strictEqual(r.body.depositRequired, true, `status ${s} should hit the deposit gate`);
        assert.strictEqual(r.body.verificationRequired, undefined);
    }
});

test('the first-deposit response shape is exact (machine-readable)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: 'approved', amount: 800, address: 'TRX1234567890',
        liveBalance: 50, tradeCount: 5, hasDeposit: false
    });
    assert.deepStrictEqual(Object.keys(r.body).sort(),
        ['code', 'depositRequired', 'error', 'requiresFirstDeposit'].sort());
});

// ---------------------------------------------------------------------------
// B. Referral-earnings exception is preserved
// ---------------------------------------------------------------------------

test('a request fully covered by genuine referral earnings skips the deposit gate (KYC still applies)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: 'not_started', amount: 800, address: 'TRX1234567890',
        liveBalance: 0, tradeCount: 0, hasDeposit: false, referralAvailable: 800
    });
    assert.strictEqual(r.body.depositRequired, undefined);
    assert.strictEqual(r.body.verificationRequired, true);
});

test('a partial referral-earnings request (above available) still hits the first-deposit gate', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: 'approved', amount: 800, address: 'TRX1234567890',
        liveBalance: 0, tradeCount: 5, hasDeposit: false, referralAvailable: 200
    });
    assert.strictEqual(r.body.depositRequired, true);
});

// ---------------------------------------------------------------------------
// C. Verification prompt for otherwise-eligible (deposited) users
// ---------------------------------------------------------------------------

test('deposited user with the trading condition met but unapproved KYC -> verification prompt', () => {
    for (const s of NON_APPROVED_STATUSES) {
        const r = evaluateWithdrawGate({
            verificationStatus: s, amount: 800, address: 'TRX1234567890',
            liveBalance: 5000, tradeCount: 5, hasDeposit: true
        });
        assert.strictEqual(r.body.verificationRequired, true, `status ${s} should be gated`);
        assert.strictEqual(r.body.status, s, 'raw status echoed back verbatim (not localized)');
        assert.strictEqual(r.body.error, 'Identity verification required');
        assert.strictEqual(r.body.redirectTo, '/#/verification');
    }
});

test('deposited + unapproved KYC wins for any amount/balance/address/trade combination', () => {
    const cases = [
        { amount: 100, address: 'TRX1234567890', liveBalance: 5000, tradeCount: 5 },
        { amount: 800, address: 'TRX1234567890', liveBalance: 100, tradeCount: 5 },
        { amount: 800, address: 'TRX1234567890', liveBalance: 5000, tradeCount: 0 },
        { amount: 800, address: 'x', liveBalance: 5000, tradeCount: 5 }
    ];
    for (const c of cases) {
        const r = evaluateWithdrawGate({ verificationStatus: 'pending_review', hasDeposit: true, ...c });
        assert.strictEqual(r.body.verificationRequired, true);
        assert.notStrictEqual(r.body.error, 'Min $700');
        assert.notStrictEqual(r.body.error, 'Insufficient balance');
        assert.notStrictEqual(r.body.error, 'Complete at least 1 trade first');
        assert.notStrictEqual(r.body.error, 'Valid address required');
    }
});

// ---------------------------------------------------------------------------
// D. Existing flow remains correct once the deposit exists
// ---------------------------------------------------------------------------

test('deposited + approved + below $700 -> minimum-withdrawal message', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 600, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 5, hasDeposit: true
    });
    assert.strictEqual(r.body.error, 'Min $700');
    assert.strictEqual(r.body.verificationRequired, undefined);
});

test('deposited + approved + $700+ but amount exceeds balance -> existing balance message', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 800, address: 'TRX1234567890',
        liveBalance: 750, tradeCount: 5, hasDeposit: true
    });
    assert.strictEqual(r.body.error, 'Insufficient balance');
});

test('deposited + approved + sufficient balance but invalid address -> existing address message', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 800, address: 'short',
        liveBalance: 5000, tradeCount: 5, hasDeposit: true
    });
    assert.strictEqual(r.body.error, 'Valid address required');
});

test('deposited + approved + all gates except trade count -> existing trade requirement', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 800, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 0, hasDeposit: true
    });
    assert.strictEqual(r.body.error, 'Complete at least 1 trade first');
});

test('deposited + all requirements satisfied -> success', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: APPROVED, amount: 800, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 3, hasDeposit: true
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'pending');
    assert.strictEqual(r.body.verificationRequired, undefined);
    assert.strictEqual(r.body.depositRequired, undefined);
});

test('the verification-required response shape is reused exactly (no new fields)', () => {
    const r = evaluateWithdrawGate({
        verificationStatus: 'not_started', amount: 100, address: 'TRX1234567890',
        liveBalance: 5000, tradeCount: 5, hasDeposit: true
    });
    assert.deepStrictEqual(Object.keys(r.body).sort(),
        ['error', 'redirectTo', 'status', 'verificationRequired'].sort());
});
