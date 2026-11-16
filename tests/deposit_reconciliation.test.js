'use strict';

/**
 * Q8Pay reconciliation surface.
 *
 * The deposit webhook credits nothing when the confirmed on-chain amount does not
 * match the exact amount the invoice asked for. That is correct, but the failure
 * used to be a log line. These tests pin the two properties that matter:
 * reconciliation makes those cases VISIBLE, and it credits nothing itself.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('1. the reconciliation queue exists and is admin-gated', () => {
  assert.ok(SERVER.includes("app.get('/api/admin/deposits/reconciliation'"),
    'the queue route exists');
  assert.match(SERVER, /app\.get\('\/api\/admin\/deposits\/reconciliation', authMiddleware, adminMiddleware/,
    'customer data is admin-only');
});

test('2. it surfaces both silent failure modes', () => {
  assert.ok(SERVER.includes("select('id, user_id, amount_usd, amount_crypto, currency, status, credited, created_at, expires_at')"),
    'stale pending invoices are listed with the exact crypto amount');
  assert.ok(SERVER.includes("select('id, user_id, amount, status, credited, created_at')"),
    'confirmed-but-uncredited deposits are listed');
  assert.ok(SERVER.includes("eq('status', 'confirmed')"), 'it looks for confirmed deposits');
  assert.match(SERVER, /credited\.is\.null,credited\.eq\.false/, 'and specifically the uncredited ones');
});

test('3. it is read-only: no write, no credit, no RPC', () => {
  const start = SERVER.indexOf("app.get('/api/admin/deposits/reconciliation'");
  const end = SERVER.indexOf('\n});', start) + 4;
  const body = SERVER.slice(start, end);
  // Match CALLS, not prose: the response legitimately says "credited" when it
  // explains that nothing was credited.
  for (const banned of ['.insert(', '.update(', '.delete(', '.rpc(', '.upsert(', 'updateWallet(']) {
    assert.ok(!body.includes(banned), 'reconciliation must never call ' + banned);
  }
  assert.ok(body.includes('Read-only'), 'the response says so explicitly');
});

test('4. the exact on-chain amount is exposed, because a mismatch is the likely cause', () => {
  assert.ok(SERVER.includes('amountCrypto:'), 'the asked-for exact amount is included');
  assert.ok(SERVER.includes('most likely cause of a'),
    'the reason is documented for the operator');
  assert.ok(SERVER.includes('I paid and got nothing'),
    'the support phrasing an operator will recognise is named');
});

test('5. the window is bounded so a wide query cannot stall the admin view', () => {
  assert.match(SERVER, /const hours = Math\.min\(Math\.max\(parseInt\(req\.query\.hours, 10\) \|\| 2, 1\), 168\)/,
    'hours is clamped to 1..168');
  assert.ok(SERVER.includes('.limit(200)'), 'both lists are capped');
});
