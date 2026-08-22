'use strict';

/**
 * MARKETING SANDBOX DEFAULT DEMO BALANCE — regression tests (Phase 15).
 *
 * Pins the fix for the sandbox Demo Mode starting at $0 instead of the
 * production new-user seed of $1,000.
 *
 * Root cause (documented): getSandboxWallet() hardcoded `demo_balance: 0` in
 * the /api/auth/me wallet response shape, while production getWallet() seeds
 * new users with demo_balance: 1000. sandbox_wallets has NO demo column by
 * design (demo trading has no server ledger — demo trades are client-side
 * only), so the demo balance is a pure read-time response value. The fix sets
 * that value to SANDBOX_DEMO_BALANCE (1000).
 *
 * Safety invariants pinned here:
 *  - The $1,000 is ONLY the simulated demo seed. It is never stored, never a
 *    deposit, never a ledger entry, and never feeds live_balance.
 *  - live_balance still derives ONLY from sandbox_wallets.balance (DEFAULT 0).
 *  - No production wallet / deposit / trade / withdrawal / subscription table
 *    or RPC is touched by the change.
 *  - Production wallet initialization, subscription eligibility, the $143 MTA
 *    rule, and the $50 promotional Live credit are byte-unchanged.
 *  - Frontend demo display path (syncWalletFromServer adoption of
 *    wallet.demo_balance) is unchanged — it just now receives 1000.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const MIGRATION_013 = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '013_marketing_sandbox.sql'), 'utf8');

function fnBody(name) {
    const m = SERVER.match(new RegExp('function ' + name + '\\b[\\s\\S]*?\\n\\}'));
    assert.ok(m, name + ' should exist');
    return m[0];
}

// Pure-JS mirror of getSandboxWallet's response-shape logic.
function sandboxWalletShape(row) {
    return {
        user_id: row.user_id,
        demo_balance: 1000, // SANDBOX_DEMO_BALANCE
        live_balance: Number(row.balance) || 0,
        bonus_balance: 0,
        intro_day: row.intro_day,
        badge_hidden: !!row.badge_hidden,
        is_simulated: true,
    };
}

// ---------------------------------------------------------------------------
// 1/2. New sandbox account: Demo = $1,000, Live = $0
// ---------------------------------------------------------------------------
test('getSandboxWallet returns the $1,000 simulated demo seed (matches production)', () => {
    const fn = fnBody('getSandboxWallet');
    assert.match(fn, /demo_balance: SANDBOX_DEMO_BALANCE/, 'demo_balance must be the SANDBOX_DEMO_BALANCE constant');
    assert.ok(!/demo_balance: 0/.test(fn), 'demo_balance must no longer be hardcoded to 0');
    assert.match(SERVER, /const SANDBOX_DEMO_BALANCE = 1000;/, 'SANDBOX_DEMO_BALANCE must be 1000');
    // matches the production new-user seed
    assert.match(fnBody('getWallet'), /demo_balance: 1000/, 'production seed must stay 1000');
});

test('sandbox live balance stays $0 for a fresh account and demo never feeds live', () => {
    const fn = fnBody('getSandboxWallet');
    assert.match(fn, /live_balance: Number\(data\.balance\) \|\| 0/, 'live_balance derives ONLY from sandbox_wallets.balance');
    // demo_balance and live_balance are independent fields
    assert.ok(fn.indexOf('demo_balance: SANDBOX_DEMO_BALANCE') !== fn.indexOf('live_balance:'), 'demo/live are separate fields');
    // the stored sandbox balance column defaults to 0 (migration 013)
    assert.match(MIGRATION_013, /balance DECIMAL\(18, 2\) NOT NULL DEFAULT 0/, 'sandbox_wallets.balance defaults to 0');
    // mirror: fresh row -> demo 1000, live 0
    const w = sandboxWalletShape({ user_id: 7, balance: 0, intro_day: 1, badge_hidden: false });
    assert.strictEqual(w.demo_balance, 1000);
    assert.strictEqual(w.live_balance, 0);
    assert.strictEqual(w.bonus_balance, 0);
    assert.strictEqual(w.is_simulated, true);
    // mirror: a funded sandbox keeps its simulated live balance, demo stays 1000
    const w2 = sandboxWalletShape({ user_id: 7, balance: 250.5, intro_day: 3, badge_hidden: false });
    assert.strictEqual(w2.demo_balance, 1000);
    assert.strictEqual(w2.live_balance, 250.5);
});

// ---------------------------------------------------------------------------
// 3/4. No production wallet, deposit, or ledger entry
// ---------------------------------------------------------------------------
test('getSandboxWallet only reads sandbox_wallets (no production tables, no ledger writes)', () => {
    const fn = fnBody('getSandboxWallet');
    assert.ok(fn.includes("from('sandbox_wallets')"), 'must read sandbox_wallets');
    for (const bad of ["from('wallets')", "from('deposits')", "from('transactions')", "from('withdrawals')", 'credit_payment_safe', 'record_trade_safe', 'PaymentService']) {
        assert.ok(!fn.includes(bad), `getSandboxWallet must not touch ${bad}`);
    }
});

test('sandbox account creation still inserts ONLY into users + sandbox_wallets', () => {
    const m = SERVER.match(/app\.post\('\/api\/admin\/sandbox\/accounts'[\s\S]*?\n\}\);/);
    assert.ok(m, 'sandbox account creation route missing');
    assert.ok(m[0].includes("from('users').insert"), 'must create the user');
    assert.ok(m[0].includes("from('sandbox_wallets').insert({ user_id: user.id })"), 'must create only the sandbox wallet row');
    assert.ok(!m[0].includes("from('wallets')"), 'must NOT create a production wallet');
    assert.ok(!m[0].includes("from('deposits')"), 'must NOT create a deposit');
    assert.ok(!m[0].includes("from('transactions')"), 'must NOT create a ledger entry');
});

// ---------------------------------------------------------------------------
// 5. Isolation intact: migration 013 unchanged w.r.t. wallet schema/backstops
// ---------------------------------------------------------------------------
test('migration 013 sandbox wallet schema + backstops are untouched by the fix', () => {
    // no demo column was added — demo remains a read-time constant
    const walletTable = MIGRATION_013.match(/CREATE TABLE IF NOT EXISTS public\.sandbox_wallets \([\s\S]*?\n\);/);
    assert.ok(walletTable, 'sandbox_wallets table missing');
    assert.ok(!/demo_balance/.test(walletTable[0]), 'sandbox_wallets must NOT gain a demo_balance column');
    assert.match(walletTable[0], /is_simulated BOOLEAN NOT NULL DEFAULT true CHECK \(is_simulated\)/, 'is_simulated lock intact');
    // production backstop triggers still guard against sandbox users
    assert.match(MIGRATION_013, /assert_user_not_marketing_sandbox/, 'production-table backstop guard intact');
    assert.match(MIGRATION_013, /assert_wallet_not_marketing_sandbox/, 'wallets backstop guard intact');
});

// ---------------------------------------------------------------------------
// 6/7. /api/auth/me returns it; the frontend adopts it for Demo Mode
// ---------------------------------------------------------------------------
test('/api/auth/me sandbox branch returns the getSandboxWallet shape', () => {
    const m = SERVER.match(/app\.get\('\/api\/auth\/me'[\s\S]*?\n\}\);/);
    assert.ok(m);
    const sandboxBranch = m[0].slice(0, m[0].indexOf('// getUser and getWallet are independent'));
    assert.ok(sandboxBranch.includes('getSandboxWallet(req.user.id)'), 'sandbox branch must use getSandboxWallet');
    assert.match(sandboxBranch, /res\.json\(\{[\s\S]*?wallet,[\s\S]*?\}\)/, 'wallet is returned to the client');
});

test('frontend adopts wallet.demo_balance into Demo Mode state (unchanged path)', () => {
    const m = INDEX.match(/if \(typeof wallet\.demo_balance === 'number'\) \{\s*APP\.demoData\.balance = Number\(wallet\.demo_balance\) \|\| 0;/);
    assert.ok(m, 'syncWalletFromServer must still adopt server demo_balance');
});

// ---------------------------------------------------------------------------
// 8. Switching to Live does not convert the demo $1,000 into live funds
// ---------------------------------------------------------------------------
test('no code path derives sandbox live balance from the demo seed', () => {
    // the demo constant may appear only in its declaration + getSandboxWallet
    // (comments stripped so a mention in a comment does not count)
    const codeOnly = SERVER.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const uses = [...codeOnly.matchAll(/SANDBOX_DEMO_BALANCE/g)].length;
    assert.strictEqual(uses, 2, 'SANDBOX_DEMO_BALANCE: 1 declaration + 1 use only');
    // live_balance in the sandbox shape comes only from the stored balance
    const fn = fnBody('getSandboxWallet');
    assert.ok(!/live_balance:[^\n]*demo/.test(fn), 'live_balance must never reference the demo seed');
    // the sandbox live funding path is unchanged: simulated deposit RPC credits
    assert.match(MIGRATION_013, /sandbox_credit_deposit/, 'simulated deposit RPC intact');
});

// ---------------------------------------------------------------------------
// 9. Existing sandbox deposit simulation unchanged
// ---------------------------------------------------------------------------
test('sandbox deposit request/credit flow is untouched', () => {
    assert.ok(SERVER.includes('handleSandboxDepositRequest'), 'sandbox deposit handler present');
    const m = SERVER.match(/async function handleSandboxDepositRequest\b[\s\S]*?\n\}/);
    assert.ok(m);
    assert.ok(!/demo_balance|SANDBOX_DEMO_BALANCE/.test(m[0]), 'deposit flow must not reference the demo seed');
    assert.ok(SERVER.includes("sandboxHandled(req, res, handleSandboxDepositRequest)"), 'deposit route branch intact');
});

// ---------------------------------------------------------------------------
// 10/11/12. Production init, subscription eligibility, MTA unchanged
// ---------------------------------------------------------------------------
test('production wallet initialization is unchanged (demo 1000, live 50 promo, bonus 0)', () => {
    assert.match(fnBody('getWallet'), /demo_balance: 1000, live_balance: 50, bonus_balance: 0/, 'production new-user wallet seed unchanged');
});

test('$143 MTA rule is unchanged and still gated on live balance only', () => {
    assert.match(SERVER, /const BOT_MIN_TRADING_BALANCE = 143;/, 'MTA constant unchanged');
    const sandboxBot = SERVER.match(/async function handleSandboxBotStart\b[\s\S]*?\n\}/);
    assert.ok(sandboxBot, 'sandbox bot start handler present');
    assert.match(sandboxBot[0], /Number\(wallet\.live_balance\) < BOT_MIN_TRADING_BALANCE/, 'sandbox MTA gate intact (live balance only)');
});

test('subscription charge logic does not reference the demo seed', () => {
    const m = SERVER.match(/app\.post\('\/api\/subscription\/activate'[\s\S]*?\n\}\);/);
    assert.ok(m);
    assert.ok(!/demo_balance|SANDBOX_DEMO_BALANCE/.test(m[0]), 'subscription activation must not touch the demo seed');
});
