'use strict';

/**
 * MARKETING_SANDBOX referral-PARTNER PAYOUTS (migration 036 + wiring).
 *
 * The sandbox must be able to demonstrate the COMPLETE partner payout workflow:
 *   request -> UNDER_REVIEW -> manager records a SIMULATED reference -> PAID
 * while NEVER touching production tables, balances, deposits, withdrawals,
 * referral_payouts, or referral rows.
 *
 * This suite pins:
 *   - migration 036 shape/guards (request, review, paid, rejected+refund,
 *     idempotency, one-open, sandbox-user assertion, service-role lockdown)
 *   - reset/replay determinism (sandbox_reset_account clears payouts+earnings)
 *   - server.js routing (sandboxHandled FIRST; sandbox_* only; admin endpoints
 *     re-verify the sandbox target + payout ownership)
 *   - production isolation (no production table/RPC referenced by sandbox code)
 *   - a faithful JS mirror of the RPC state machine (happy path, reject/refund,
 *     idempotency, one-open, reset/replay, authorization)
 *   - frontend wiring + i18n parity
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
const M036 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '036_sandbox_referral_payouts.sql'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function sqlFn(name) {
    const idx = M036.indexOf('FUNCTION public.' + name + '(');
    assert.ok(idx >= 0, 'function not found in 036: ' + name);
    const end = M036.indexOf('\n$$;', idx);
    assert.ok(end > idx, 'terminator not found: ' + name);
    return M036.slice(idx, end + 4);
}

function serverRoute(startMarker, endMarker) {
    const s = SERVER.indexOf(startMarker);
    assert.ok(s > 0, 'route start not found: ' + startMarker);
    const e = SERVER.indexOf(endMarker, s + startMarker.length);
    assert.ok(e > s, 'route end not found: ' + endMarker);
    return SERVER.slice(s, e);
}

// ---------------------------------------------------------------------------
// 1. Migration 036 shape
// ---------------------------------------------------------------------------
test('036 is additive, idempotent and self-checking', () => {
    assert.match(M036, /ADD COLUMN IF NOT EXISTS referral_earnings DECIMAL\(18, 2\) NOT NULL DEFAULT 0/);
    assert.match(M036, /CREATE TABLE IF NOT EXISTS public\.sandbox_referral_payouts/);
    assert.match(M036, /CREATE OR REPLACE FUNCTION public\.sandbox_request_referral_payout_safe/);
    assert.match(M036, /CREATE OR REPLACE FUNCTION public\.sandbox_update_referral_payout_safe/);
    assert.match(M036, /CREATE OR REPLACE FUNCTION public\.sandbox_reset_account/);
    assert.match(M036, /RAISE EXCEPTION 'Migration 036 self-check failed: missing %'/);
    // Never ALTERs / DROPs a production table.
    assert.ok(!/ALTER TABLE public\.(referral_payouts|wallets|referrals|deposits|withdrawals)\b/.test(M036), 'must not alter production tables');
    assert.ok(!/DROP TABLE/.test(M036), 'no DROP TABLE');
});

test('036 payout table is sandbox-only, simulated and idempotent', () => {
    assert.match(M036, /idempotency_key TEXT NOT NULL UNIQUE/);
    assert.match(M036, /is_simulated BOOLEAN NOT NULL DEFAULT true CHECK \(is_simulated\)/);
    assert.match(M036, /environment TEXT NOT NULL DEFAULT 'MARKETING_SANDBOX' CHECK \(environment = 'MARKETING_SANDBOX'\)/);
    assert.match(M036, /status TEXT NOT NULL DEFAULT 'UNDER_REVIEW'/);
    assert.match(M036, /CHECK \(status IN \('PENDING', 'UNDER_REVIEW', 'PAID', 'REJECTED'\)\)/);
    // RLS on + service_role-only.
    assert.match(M036, /ALTER TABLE public\.sandbox_referral_payouts ENABLE ROW LEVEL SECURITY/);
    assert.match(M036, /REVOKE ALL ON public\.sandbox_referral_payouts FROM anon/);
    assert.match(M036, /REVOKE ALL ON public\.sandbox_referral_payouts FROM authenticated/);
    assert.match(M036, /GRANT ALL ON public\.sandbox_referral_payouts TO service_role/);
});

// ---------------------------------------------------------------------------
// 2. Award credits the SIMULATED EARNINGS bucket, never the trading balance
// ---------------------------------------------------------------------------
test('036 award credits referral_earnings and leaves the trading balance untouched', () => {
    const fn = sqlFn('sandbox_award_referral_qualification');
    assert.match(fn, /v_new_earnings := ROUND\(COALESCE\(v_wallet\.referral_earnings, 0\) \+ v_reward, 2\)/);
    assert.match(fn, /SET referral_earnings = v_new_earnings, updated_at = NOW\(\)/);
    assert.ok(!/SET balance =/.test(fn), 'must NOT credit the simulated trading balance');
    assert.match(fn, /PERFORM public\.assert_sandbox_user\(v_ref\.referrer_id\)/);
    assert.match(fn, /INSERT INTO public\.sandbox_transactions/);
});

// ---------------------------------------------------------------------------
// 3. Request RPC guards
// ---------------------------------------------------------------------------
test('request RPC: sandbox-asserted, idempotent (before AND after lock), one-open', () => {
    const fn = sqlFn('sandbox_request_referral_payout_safe');
    assert.match(fn, /PERFORM public\.assert_sandbox_user\(p_user_id\)/);
    assert.match(fn, /WHERE idempotency_key = p_idempotency_key/);
    // two idempotency checks around the wallet row lock
    const checks = fn.match(/WHERE idempotency_key = p_idempotency_key/g) || [];
    assert.ok(checks.length >= 2, 'idempotency checked before and after the lock');
    assert.match(fn, /FROM public\.sandbox_wallets WHERE user_id = p_user_id FOR UPDATE/);
    assert.match(fn, /status IN \('PENDING', 'UNDER_REVIEW'\)/);
    assert.match(fn, /'payout_already_open'/);
});

test('request RPC: NO minimum, reserves from EARNINGS only, returns UNDER_REVIEW', () => {
    const fn = sqlFn('sandbox_request_referral_payout_safe');
    assert.match(fn, /v_available := ROUND\(COALESCE\(v_wallet\.referral_earnings, 0\), 2\)/);
    assert.match(fn, /IF v_requested > v_available THEN/);
    assert.match(fn, /v_new_earnings := ROUND\(v_available - v_requested, 2\)/);
    assert.match(fn, /SET referral_earnings = v_new_earnings, updated_at = NOW\(\)/);
    assert.ok(!/SET balance =/.test(fn), 'must not touch the trading balance');
    assert.match(fn, /VALUES \(p_user_id, v_requested, 'UNDER_REVIEW', v_address, v_coin, v_network, p_idempotency_key\)/);
    assert.ok(!/minimum/i.test(fn) || !/MIN_PAYOUT|amount < [0-9]/.test(fn), 'no minimum payout enforced');
});

// ---------------------------------------------------------------------------
// 4. Update RPC (manager)
// ---------------------------------------------------------------------------
test('update RPC: locks the row, blocks terminal states, refunds rejection exactly once', () => {
    const fn = sqlFn('sandbox_update_referral_payout_safe');
    assert.match(fn, /FROM public\.sandbox_referral_payouts WHERE id = p_payout_id FOR UPDATE/);
    assert.match(fn, /PERFORM public\.assert_sandbox_user\(v_payout\.user_id\)/);
    assert.match(fn, /IF v_payout\.status = 'PAID' THEN[\s\S]*?'already_paid'/);
    assert.match(fn, /IF v_payout\.status = 'REJECTED' THEN[\s\S]*?'already_rejected'/);
    // rejection refunds (once, guarded by the terminal-status checks above)
    assert.match(fn, /v_new_earnings := ROUND\(COALESCE\(v_wallet\.referral_earnings, 0\) \+ v_payout\.amount, 2\)/);
    assert.match(fn, /SET status = 'REJECTED'/);
    // PAID records amount + simulated TX reference + paid_at
    assert.match(fn, /paid_amount = COALESCE\(p_paid_amount, amount\)/);
    assert.match(fn, /tx_reference = v_tx/);
    assert.match(fn, /paid_at = NOW\(\)/);
    assert.ok(!/SET balance =/.test(fn), 'must not touch the trading balance');
});

// ---------------------------------------------------------------------------
// 5. Reset / replay
// ---------------------------------------------------------------------------
test('reset clears the simulated payouts and zeroes referral_earnings', () => {
    const fn = sqlFn('sandbox_reset_account');
    assert.match(fn, /PERFORM public\.assert_sandbox_user\(p_user_id\)/);
    assert.match(fn, /DELETE FROM public\.sandbox_referral_payouts WHERE user_id = p_user_id/);
    assert.match(fn, /DELETE FROM public\.sandbox_referrals/);
    assert.match(fn, /INSERT INTO public\.sandbox_wallets \(user_id, balance, referral_earnings, intro_day, badge_hidden\)/);
    assert.match(fn, /SET balance = 0, referral_earnings = 0/);
    assert.match(fn, /'referral_earnings', 0/);
});

// ---------------------------------------------------------------------------
// 6. Production isolation (source-level)
// ---------------------------------------------------------------------------
test('every sandbox payout RPC writes only sandbox_* objects', () => {
    for (const name of ['sandbox_request_referral_payout_safe', 'sandbox_update_referral_payout_safe', 'sandbox_reset_account', 'sandbox_award_referral_qualification']) {
        const fn = sqlFn(name);
        assert.ok(!/\bpublic\.referral_payouts\b/.test(fn), name + ' must not reference public.referral_payouts');
        assert.ok(!/\bpublic\.wallets\b/.test(fn), name + ' must not reference public.wallets');
        assert.ok(!/\bpublic\.referrals\b/.test(fn), name + ' must not reference public.referrals');
        assert.ok(!/\bpublic\.transactions\b/.test(fn), name + ' must not reference public.transactions');
        assert.ok(!/request_referral_payout_safe|update_referral_payout_safe|update_wallet|credit_payment_safe|record_trade_safe/.test(fn.replace(/sandbox_[a-z_]*/g, '')), name + ' must not call a production RPC');
    }
});

test('migration 036 never touches production referral_payouts / wallets / referrals', () => {
    // Ignore SQL comments (the header legitimately NAMES the production tables
    // it promises not to touch); scan only executable statements.
    const code = M036.replace(/--[^\n]*/g, '');
    const prodRefs = code.match(/\bpublic\.(referral_payouts|wallets|referrals|deposits|withdrawals|transactions|subscriptions)\b/g) || [];
    assert.deepStrictEqual(prodRefs, [], 'unexpected production table reference: ' + prodRefs.join(','));
});

// ---------------------------------------------------------------------------
// 7. Server routing / wiring
// ---------------------------------------------------------------------------
test('sandbox account GET + payout request branch to sandbox BEFORE any production code', () => {
    const partner = serverRoute("app.get('/api/referral/partner', authMiddleware", 'try {');
    assert.match(partner, /if \(await sandboxHandled\(req, res, handleSandboxPartnerGet\)\) return;/);
    const idxBranch = partner.indexOf('sandboxHandled');
    const idxProd = partner.indexOf(".from('referrals')");
    assert.ok(idxBranch >= 0 && (idxProd < 0 || idxBranch < idxProd), 'sandbox branch must precede the production query');

    const req = serverRoute("app.post('/api/referral/payouts/request', authMiddleware", 'try {');
    assert.match(req, /if \(await sandboxHandled\(req, res, handleSandboxPayoutRequest\)\) return;/);
    const idxB2 = req.indexOf('sandboxHandled');
    const idxP2 = req.indexOf("rpc('request_referral_payout_safe'");
    assert.ok(idxB2 >= 0 && (idxP2 < 0 || idxB2 < idxP2), 'sandbox branch must precede the production RPC');
});

test('sandbox payout handlers use sandbox_* tables only and the sbx_ idempotency namespace', () => {
    const s = SERVER.indexOf('async function getSandboxReferralEarnings');
    const e = SERVER.indexOf('async function handleSandboxWithdrawRequest', s);
    const section = SERVER.slice(s, e);
    assert.match(section, /from\('sandbox_referral_payouts'\)/);
    assert.match(section, /from\('sandbox_wallets'\)/);
    assert.match(section, /rpc\('sandbox_request_referral_payout_safe'/);
    assert.match(section, /'sbx_payout_' \+ userId \+ '_'/);
    assert.ok(!/from\('referral_payouts'\)/.test(section), 'no production payout table');
    assert.ok(!/from\('wallets'\)/.test(section), 'no production wallet table');
    assert.ok(!/rpc\('request_referral_payout_safe'/.test(section), 'no production payout RPC');
    assert.match(section, /assets: PAYOUT_ASSETS/);
});

test('admin sandbox payout endpoints re-verify the sandbox target and payout ownership', () => {
    const list = serverRoute("app.get('/api/admin/sandbox/:userId/payouts'", "// Marketing control (SANDBOX ONLY): record");
    assert.match(list, /requireSandboxTargetUser\(req, res\)/);
    assert.match(list, /getSandboxPayoutRows\(targetId\)/);

    const upd = serverRoute("app.put('/api/admin/sandbox/:userId/payouts/:payoutId'", "app.post('/api/admin/sandbox/:userId/bot'");
    assert.match(upd, /requireSandboxTargetUser\(req, res\)/);
    assert.match(upd, /from\('sandbox_referral_payouts'\)[\s\S]*?\.eq\('id', payoutId\)/);
    assert.match(upd, /Number\(row\.user_id\) !== targetId/);
    assert.match(upd, /rpc\('sandbox_update_referral_payout_safe'/);
    assert.ok(!/rpc\('update_referral_payout_safe'/.test(upd), 'must not call the production RPC');
});

test('production payout endpoints + PAYOUT_ASSETS are unchanged by this feature', () => {
    const prodReq = serverRoute("app.post('/api/referral/payouts/request', authMiddleware", 'app.get(\'/api/admin/referral/payouts\'');
    assert.match(prodReq, /rpc\('request_referral_payout_safe'/);
    assert.match(prodReq, /'payout_' \+ userId \+ '_'/);
    const prodAdmin = serverRoute("app.put('/api/admin/referral/payouts/:id'", 'app.get(\'/api/admin/referrals\'');
    assert.match(prodAdmin, /rpc\('update_referral_payout_safe'/);
    // USDT/TRC20-only launch asset restriction preserved
    assert.match(SERVER, /PAYOUT_ASSETS\s*=\s*\[[\s\S]*?coin:\s*'USDT'[\s\S]*?networks:\s*\['TRC20'\]/);
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/);
    assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
});

// ---------------------------------------------------------------------------
// 8. Frontend wiring
// ---------------------------------------------------------------------------
test('sandbox admin UI exposes a separate simulated payout surface', () => {
    assert.match(INDEX, /id="sandboxPayoutsTable"/);
    assert.match(INDEX, /id="sandboxPayoutsEmpty"/);
    assert.match(INDEX, /function loadSandboxPayouts\(\)/);
    assert.match(INDEX, /function sandboxRecordPayoutPayment\(/);
    assert.match(INDEX, /function sandboxRejectPayout\(/);
    // Uses the sandbox admin fetch helper (never the production payouts tab).
    const s = INDEX.indexOf('async function loadSandboxPayouts');
    const e = INDEX.indexOf('async function sandboxBotAction', s);
    const section = INDEX.slice(s, e);
    assert.ok(!/fetch\('\/api\/admin\/referral\//.test(section), 'must not call the production admin payouts endpoint');
    assert.match(section, /sandboxAdminFetch\('\/api\/admin\/sandbox\//);
});

test('partner panel shows a simulated-data marker for sandbox partners', () => {
    assert.match(INDEX, /id="partnerSimulatedNote"/);
    assert.match(INDEX, /simNote\.classList\.toggle\('hidden', partner\.sandbox !== true\)/);
    assert.match(INDEX, /'referral\.partner\.simulatedNote'/);
});

// ---------------------------------------------------------------------------
// 9. i18n parity for the new keys
// ---------------------------------------------------------------------------
test('new sandbox payout i18n keys exist in all 6 locales with placeholder parity', () => {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx), d = 0, e = -1;
    for (; i < INDEX.length; i++) { if (INDEX[i] === '{') d++; else if (INDEX[i] === '}') { d--; if (d === 0) { e = i; break; } } }
    const sb = {}; vm.createContext(sb);
    vm.runInContext(INDEX.slice(tIdx, e + 1) + ';globalThis.__T=TRANSLATIONS;', sb);
    const T = sb.__T;
    const enKeys = Object.keys(T.en);
    for (const l of LANGS) assert.strictEqual(Object.keys(T[l]).length, enKeys.length, l + ' key-set size');
    const NEW = ['referral.partner.simulatedNote', 'sandbox.admin.payoutsTitle', 'sandbox.admin.payoutsSimulatedNote', 'sandbox.admin.payoutsEarnings', 'sandbox.admin.payoutRecord', 'sandbox.admin.payoutReject', 'sandbox.admin.payoutUpdated', 'sandbox.admin.referredByCode'];
    const ph = (s) => (String(s).match(/\{\{\w+\}\}/g) || []).sort().join(',');
    for (const k of NEW) {
        assert.ok(k in T.en, 'missing key ' + k);
        for (const l of LANGS) {
            assert.ok(T[l][k] && String(T[l][k]).trim() !== '', l + ' empty ' + k);
            assert.strictEqual(ph(T[l][k]), ph(T.en[k]), l + ' placeholder mismatch ' + k);
        }
    }
});

// ---------------------------------------------------------------------------
// 10. Functional mirror of the RPC state machine
// ---------------------------------------------------------------------------
function makeSandbox(seedEarnings, opts) {
    opts = opts || {};
    const isSandbox = opts.isSandbox !== false;
    const state = { earnings: seedEarnings, balance: 0, payouts: [], seq: 0, keys: new Set() };
    const r2 = (n) => Math.round(n * 100) / 100;
    function request({ userId, address, key, amount, coin, network }) {
        if (!isSandbox) return { success: false, error: 'not a MARKETING_SANDBOX account' };
        if (!key) return { success: false, error: 'missing_idempotency_key' };
        if (!address || address.length < 10) return { success: false, error: 'invalid_address' };
        coin = (coin || 'USDT').toUpperCase(); network = (network || 'TRC20').toUpperCase();
        if (state.keys.has(key)) {
            const p = state.payouts.find((x) => x.idempotency_key === key);
            return { success: true, duplicate: true, payout_id: p.id, amount: p.amount, status: p.status };
        }
        if (state.payouts.some((p) => p.status === 'PENDING' || p.status === 'UNDER_REVIEW')) {
            return { success: false, reason: 'payout_already_open' };
        }
        const avail = r2(state.earnings);
        if (avail <= 0) return { success: false, reason: 'no_referral_earnings' };
        const req = r2(amount == null ? avail : amount);
        if (req <= 0) return { success: false, reason: 'invalid_amount' };
        if (req > avail) return { success: false, reason: 'amount_exceeds_available' };
        state.earnings = r2(avail - req);
        state.seq++;
        const p = { id: state.seq, user_id: userId, amount: req, paid_amount: null, status: 'UNDER_REVIEW', coin: coin, network: network, tx_reference: null, idempotency_key: key };
        state.payouts.push(p); state.keys.add(key);
        return { success: true, duplicate: false, payout_id: p.id, amount: req, status: 'UNDER_REVIEW', referral_earnings: state.earnings };
    }
    function update({ payoutId, status, paidAmount, txReference }) {
        if (!isSandbox) return { success: false, error: 'not a MARKETING_SANDBOX account' };
        const p = state.payouts.find((x) => x.id === payoutId);
        if (!p) return { success: false, error: 'payout_not_found' };
        const s = String(status || '').toUpperCase();
        if (!['PENDING', 'UNDER_REVIEW', 'PAID', 'REJECTED'].includes(s)) return { success: false, error: 'invalid_status' };
        if (p.status === 'PAID') return { success: false, error: 'already_paid' };
        if (p.status === 'REJECTED') return { success: false, error: 'already_rejected' };
        if (s === 'REJECTED') {
            state.earnings = r2(state.earnings + p.amount);
            p.status = 'REJECTED';
            return { success: true, payout_id: p.id, status: 'REJECTED', refunded: p.amount, referral_earnings: state.earnings };
        }
        if (s === 'PAID') {
            p.status = 'PAID';
            p.paid_amount = paidAmount == null ? p.amount : paidAmount;
            p.tx_reference = txReference || null;
            return { success: true, payout_id: p.id, status: 'PAID', paid_amount: p.paid_amount, tx_reference: p.tx_reference };
        }
        p.status = s;
        return { success: true, payout_id: p.id, status: s };
    }
    function reset() { state.payouts.length = 0; state.keys.clear(); state.earnings = 0; state.balance = 0; }
    return { state, request, update, reset };
}

test('happy path: $20 earnings -> request -> UNDER_REVIEW -> PAID with simulated TX', () => {
    const sb = makeSandbox(20);
    const req = sb.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'k1', amount: 20, coin: 'USDT', network: 'TRC20' });
    assert.strictEqual(req.status, 'UNDER_REVIEW');
    assert.strictEqual(sb.state.earnings, 0);
    const paid = sb.update({ payoutId: req.payout_id, status: 'PAID', paidAmount: 20, txReference: 'SIMULATED-TRC20-ABC' });
    assert.strictEqual(paid.status, 'PAID');
    assert.strictEqual(paid.paid_amount, 20);
    assert.strictEqual(paid.tx_reference, 'SIMULATED-TRC20-ABC');
});

test('idempotency: replayed request never double-reserves', () => {
    const sb = makeSandbox(20);
    const a = sb.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'same', amount: 20 });
    const b = sb.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'same', amount: 20 });
    assert.strictEqual(b.duplicate, true);
    assert.strictEqual(b.payout_id, a.payout_id);
    assert.strictEqual(sb.state.payouts.length, 1);
    assert.strictEqual(sb.state.earnings, 0);
});

test('one open payout at a time', () => {
    const sb = makeSandbox(40);
    sb.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'k1', amount: 20 });
    const second = sb.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'k2', amount: 20 });
    assert.strictEqual(second.reason, 'payout_already_open');
});

test('rejection refunds the reserved earnings exactly once', () => {
    const sb = makeSandbox(20);
    const r = sb.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'k1', amount: 20 });
    const rej = sb.update({ payoutId: r.payout_id, status: 'REJECTED', note: 'no' });
    assert.strictEqual(rej.refunded, 20);
    assert.strictEqual(sb.state.earnings, 20);
    const again = sb.update({ payoutId: r.payout_id, status: 'REJECTED' });
    assert.strictEqual(again.error, 'already_rejected');
    assert.strictEqual(sb.state.earnings, 20, 'no double refund');
});

test('guards: no earnings, amount exceeds available, non-sandbox refused', () => {
    const empty = makeSandbox(0);
    assert.strictEqual(empty.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'k', amount: 20 }).reason, 'no_referral_earnings');
    const sb = makeSandbox(20);
    assert.strictEqual(sb.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'k', amount: 25 }).reason, 'amount_exceeds_available');
    const prod = makeSandbox(20, { isSandbox: false });
    assert.match(prod.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'k', amount: 20 }).error, /MARKETING_SANDBOX/);
});

test('reset/replay yields a clean, deterministic state', () => {
    const sb = makeSandbox(20);
    const r = sb.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'k1', amount: 20 });
    sb.update({ payoutId: r.payout_id, status: 'PAID', txReference: 'X' });
    sb.reset();
    assert.strictEqual(sb.state.payouts.length, 0);
    assert.strictEqual(sb.state.earnings, 0);
    // Replay: the operator re-runs the simulated referral deposit, then the SAME
    // idempotency key works again (no stale dedupe after a reset).
    sb.state.earnings = 20;
    const r2 = sb.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'k1', amount: 20 });
    assert.strictEqual(r2.duplicate, false);
    assert.strictEqual(r2.status, 'UNDER_REVIEW');
});

test('trading balance is never touched by any payout operation', () => {
    const sb = makeSandbox(20);
    const r = sb.request({ userId: 1, address: 'T' + 'a'.repeat(33), key: 'k1', amount: 20 });
    sb.update({ payoutId: r.payout_id, status: 'PAID', txReference: 'X' });
    assert.strictEqual(sb.state.balance, 0);
});
