'use strict';
/**
 * Withdrawal approval must not double-count the debit (H3).
 *
 * ROOT CAUSE: `POST /api/withdraw/request` debits the wallet and writes the
 * financial ledger row ('Withdraw', -amount) at submission time. The admin
 * approve handler then wrote a SECOND negative row ('Withdraw Approved',
 * -amount). One payout therefore produced two debit entries: the customer's
 * history showed two withdrawals, and any audit total that sums `transactions`
 * overstated outflows by the full amount.
 *
 * Balance is authoritative and is NOT derived from `transactions`, so the defect
 * was in the audit trail and the UI, not the funds. The fix removes the approval
 * row only: no balance was touched, no historical row is rewritten or deleted,
 * and no new accounting model was introduced. The approval's audit record is the
 * status transition on the `withdrawals` row itself.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function block(startMarker, endMarker) {
  const at = SERVER.indexOf(startMarker);
  assert.ok(at > 0, 'missing: ' + startMarker);
  const end = SERVER.indexOf(endMarker, at + startMarker.length);
  assert.ok(end > at, 'unbounded: ' + startMarker);
  return SERVER.slice(at, end);
}

const REQUEST = block("app.post('/api/withdraw/request'", "app.get('/api/withdraw/history'");
const APPROVE = block("app.put('/api/admin/withdrawals/:id/approve'", "app.put('/api/admin/withdrawals/:id/reject'");
const REJECT = block("app.put('/api/admin/withdrawals/:id/reject'", "app.get('/api/admin/transactions'");

// ---------------------------------------------------------------------------
// H3 - the approval no longer writes a financial row
// ---------------------------------------------------------------------------
/** Strip // comments so assertions measure CODE, not the explanation around it. */
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('H3: approval writes no ledger transaction at all', () => {
  assert.ok(!/addTransaction\(/.test(code(APPROVE)),
    'approval must not add a ledger row - the request already recorded the debit');
  assert.ok(!/'Withdraw Approved'/.test(code(APPROVE)),
    'the duplicate negative row is gone from the executable handler');
});

test('H3: approval still performs the status transition and reports success', () => {
  assert.match(APPROVE, /update\(\{ status: 'approved' \}\)\.eq\('id', id\)/, 'status transition preserved');
  assert.match(APPROVE, /if \(withdrawal\.status !== 'pending'\)/, 'the pending guard is preserved');
  assert.match(APPROVE, /res\.json\(\{ success: true \}\)/, 'the response contract is unchanged');
  assert.match(APPROVE, /from\('withdrawals'\)\.select\('\*'\)\.eq\('id', id\)\.single\(\)/,
    'the withdrawal row (amount/address/timestamps) remains the audit record');
});

test('H3: approval never touches a wallet balance', () => {
  assert.ok(!/updateWallet\(/.test(APPROVE), 'no balance movement on approval');
  assert.ok(!/from\('wallets'\)/.test(APPROVE), 'no direct wallet write either');
});

// ---------------------------------------------------------------------------
// The request keeps its single debit
// ---------------------------------------------------------------------------
test('the request still records exactly one financial debit', () => {
  const withdrawRows = REQUEST.match(/addTransaction\(userId, 'Withdraw', -amount/g) || [];
  assert.strictEqual(withdrawRows.length, 1, 'one debit row per request');
  assert.match(REQUEST, /updateWallet\(userId, 'live_balance', -fromLive\)/, 'live debit preserved');
  assert.match(REQUEST, /updateWallet\(userId, 'bonus_balance', -fromBonus\)/, 'referral-bucket debit preserved');
  assert.match(REQUEST, /insert\(\{ user_id: userId, amount, address, status: 'pending' \}\)/,
    'the request row is still created as pending');
});

test('one withdrawal can produce at most one negative ledger entry', () => {
  // The only negative rows in the whole lifecycle are the request debit and the
  // rejection credit (positive). Nothing else may write a negative amount.
  const lifecycle = REQUEST + APPROVE + REJECT;
  const negatives = lifecycle.match(/addTransaction\([^)]*-\s*(amount|withdrawal\.amount)/g) || [];
  assert.deepStrictEqual(negatives, ["addTransaction(userId, 'Withdraw', -amount"],
    'exactly one negative ledger write across request/approve/reject');
});

// ---------------------------------------------------------------------------
// Rejection behaviour is untouched
// ---------------------------------------------------------------------------
test('rejection still refunds and still records the reversal', () => {
  assert.match(REJECT, /update\(\{ status: 'rejected' \}\)/, 'status transition preserved');
  assert.match(REJECT, /updateWallet\(withdrawal\.user_id, 'live_balance', withdrawal\.amount\)/, 'refund preserved');
  assert.match(REJECT, /addTransaction\(withdrawal\.user_id, 'Withdraw Rejected', withdrawal\.amount/,
    'the positive reversal row is preserved');
  assert.match(REJECT, /if \(withdrawal\.status !== 'pending'\)/, 'the pending guard is preserved');
});

// ---------------------------------------------------------------------------
// History is untouched
// ---------------------------------------------------------------------------
test('no historical ledger row is rewritten or deleted', () => {
  assert.ok(!/from\('transactions'\)[\s\S]{0,80}\.(update|delete|upsert)\(/.test(SERVER),
    'the server never mutates or deletes existing transactions');
  assert.ok(!/DELETE FROM transactions/i.test(SERVER), 'no SQL deletion of ledger rows');
  assert.ok(!/UPDATE transactions/i.test(SERVER), 'no SQL rewrite of ledger rows');
  // And no compensating balance adjustment for the historical duplicates.
  assert.ok(!/withdrawal.*duplicate.*refund/i.test(SERVER), 'no remedial refund logic was invented');
});

test('this fix requires no frontend change', () => {
  // PRE-EXISTING GAP, unchanged here: 'Withdraw Approved' has no TX_TYPE_LABELS
  // entry, so historical rows already render the raw English type. Adding a
  // localized label would mean new keys in six locales - a separate UI change,
  // not part of removing the duplicate debit. This test records the state so a
  // future change is a deliberate decision rather than an accident.
  assert.ok(!/'Withdraw Approved':/.test(INDEX),
    'no label key is added by this fix (frontend untouched)');
  assert.match(INDEX, /'Withdraw': 'tx\.type\.withdraw'/, 'the request debit row keeps its localized label');
});

test('the withdrawal status vocabulary is unchanged', () => {
  // No new state was introduced, so existing admin UI, history rendering and
  // status filters keep working.
  for (const status of ["'pending'", "'approved'", "'rejected'"]) {
    assert.ok(SERVER.includes('status: ' + status) || SERVER.includes('status: ' + status.replace(/'/g, '')), status);
  }
  assert.ok(!/status: 'completed'/.test(APPROVE + REJECT + REQUEST), 'no invented completion state');
});
