'use strict';
// Referral Partner program: server-side manual payout workflow + referral
// safety invariants. Static/source pins plus a pure-logic mirror of the payout
// lifecycle. No network or database is required.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const MIG = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '034_referral_payouts.sql'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function sliceBetween(text, a, b) {
    const i = text.indexOf(a);
    assert.ok(i > 0, 'start marker not found: ' + a);
    const j = text.indexOf(b, i);
    assert.ok(j > i, 'end marker not found: ' + b);
    return text.slice(i, j);
}

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx);
    let depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();
const PARTNER_API = sliceBetween(SERVER, '// REFERRAL PARTNER PROGRAM', '// EMAIL 2FA');

// ===========================================================================
// 1. Migration 034 - table + RPCs
// ===========================================================================
test('034 creates the referral_payouts table with every manager-recordable field', () => {
    assert.match(MIG, /CREATE TABLE IF NOT EXISTS public\.referral_payouts/);
    for (const col of ['user_id', 'amount', 'paid_amount', 'status', 'wallet_address',
        'tx_reference', 'manager_id', 'note', 'idempotency_key', 'created_at',
        'updated_at', 'reviewed_at', 'paid_at']) {
        assert.match(MIG, new RegExp('\\b' + col + '\\b'), 'missing column ' + col);
    }
    assert.match(MIG, /status IN \('PENDING', 'UNDER_REVIEW', 'PAID', 'REJECTED'\)/);
    assert.match(MIG, /idempotency_key TEXT NOT NULL UNIQUE/);
    assert.match(MIG, /user_id BIGINT NOT NULL REFERENCES public\.users/);
});

test('034 is additive, idempotent and self-checking', () => {
    assert.ok(!/\bDROP TABLE\b/i.test(MIG), 'must not drop tables');
    assert.ok(!/\bALTER TABLE public\.(wallets|referrals|users|deposits|withdrawals|transactions)\b/i.test(MIG),
        'must not alter existing financial tables');
    assert.match(MIG, /CREATE OR REPLACE FUNCTION/);
    assert.match(MIG, /DROP POLICY IF EXISTS/);
    assert.match(MIG, /RAISE EXCEPTION/); // verification block
});

test('034 locks the table down to service_role (no anon/authenticated policy)', () => {
    assert.match(MIG, /ALTER TABLE public\.referral_payouts ENABLE ROW LEVEL SECURITY/);
    assert.match(MIG, /FOR ALL TO service_role/);
    assert.match(MIG, /REVOKE ALL ON public\.referral_payouts FROM anon/);
    assert.match(MIG, /REVOKE ALL ON public\.referral_payouts FROM authenticated/);
    assert.match(MIG, /roles::text IN \('\{anon\}', '\{authenticated\}'\)/);
});

test('request RPC: idempotent, wallet-locked, one-open, caps at genuine earnings, debits bonus only', () => {
    const rpc = sliceBetween(MIG, 'FUNCTION public.request_referral_payout_safe', 'FUNCTION public.update_referral_payout_safe');
    assert.match(rpc, /idempotency_key = p_idempotency_key/);
    assert.match(rpc, /SELECT \* INTO v_wallet FROM public\.wallets WHERE user_id = p_user_id FOR UPDATE/);
    // idempotency checked BEFORE and AFTER the lock
    const first = rpc.indexOf('idempotency_key = p_idempotency_key');
    const lock = rpc.indexOf('FOR UPDATE');
    const second = rpc.indexOf('idempotency_key = p_idempotency_key', first + 1);
    assert.ok(first > 0 && lock > first && second > lock, 'double idempotency check around the lock');
    assert.match(rpc, /status IN \('PENDING', 'UNDER_REVIEW'\)/, 'one open payout guard');
    assert.match(rpc, /LEAST\(COALESCE\(v_wallet\.bonus_balance, 0\), COALESCE\(v_rewards, 0\)\)/);
    assert.match(rpc, /FROM public\.referrals[\s\S]*status = 'active' AND referred_id > 0/);
    // only the bonus bucket is touched
    assert.match(rpc, /SET bonus_balance = v_new_bonus/);
    assert.ok(!/live_balance\s*=|demo_balance\s*=/.test(rpc), 'must not touch live/demo balances');
    assert.match(rpc, /VALUES \(p_user_id, v_available, 'PENDING', v_address, p_idempotency_key\)/);
    // refuses sandbox
    assert.match(rpc, /environment = 'MARKETING_SANDBOX'/);
});

test('update RPC: locks the row, blocks terminal re-use, refunds exactly once on rejection, records the manager', () => {
    const rpc = sliceBetween(MIG, 'FUNCTION public.update_referral_payout_safe', '-- 4. EXECUTE LOCKDOWN');
    assert.match(rpc, /FROM public\.referral_payouts WHERE id = p_payout_id FOR UPDATE/);
    assert.match(rpc, /already_paid/);
    assert.match(rpc, /already_rejected/);
    assert.match(rpc, /IF v_status = 'REJECTED' THEN[\s\S]*bonus_balance = ROUND\(COALESCE\(bonus_balance, 0\) \+ v_refund/);
    assert.match(rpc, /paid_amount = v_paid/);
    assert.match(rpc, /tx_reference = /);
    assert.match(rpc, /manager_id = COALESCE\(p_manager_id, manager_id\)/);
    assert.match(rpc, /paid_at = CASE WHEN v_status = 'PAID' THEN NOW\(\)/);
    assert.match(rpc, /reviewed_at = CASE WHEN v_status IN \('UNDER_REVIEW', 'REJECTED'\)/);
});

test('034 revokes EXECUTE from PUBLIC/anon/authenticated and grants only service_role', () => {
    for (const fn of ['request_referral_payout_safe\\(BIGINT, TEXT, TEXT\\)',
        'update_referral_payout_safe\\(BIGINT, TEXT, DECIMAL, TEXT, BIGINT, TEXT\\)']) {
        assert.match(MIG, new RegExp('REVOKE EXECUTE ON FUNCTION public\\.' + fn + ' FROM PUBLIC'));
        assert.match(MIG, new RegExp('REVOKE EXECUTE ON FUNCTION public\\.' + fn + ' FROM anon'));
        assert.match(MIG, new RegExp('REVOKE EXECUTE ON FUNCTION public\\.' + fn + ' FROM authenticated'));
        assert.match(MIG, new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + fn + ' TO service_role'));
    }
});

test('034 is a manual workflow: no automated crypto transfer anywhere', () => {
    assert.ok(!/sendTransaction|transferUsdt|axios|fetch\(|https?:\/\//i.test(MIG),
        'migration must not perform any transfer');
    assert.match(MIG, /manual/i);
});

// ===========================================================================
// 2. Server endpoints
// ===========================================================================
test('GET /api/referral/partner is auth-gated, self-scoped and server-derived', () => {
    const ep = sliceBetween(PARTNER_API, "app.get('/api/referral/partner'", "app.post('/api/referral/payouts/request'");
    assert.match(ep, /authMiddleware/);
    assert.match(ep, /const userId = req\.user\.id/);
    assert.match(ep, /\.eq\('referrer_id', userId\)/);
    assert.match(ep, /\.eq\('user_id', userId\)/);
    assert.match(ep, /availableEarnings/);
    assert.match(ep, /totalQualifyingDepositVolume/);
    assert.match(ep, /pendingPayouts/);
    assert.match(ep, /paidPayouts/);
    assert.ok(!/req\.body/.test(ep), 'GET must not read a client body');
});

test('payout request is auth-gated, sandbox-refused, and validates address + amount + asset', () => {
    const ep = sliceBetween(PARTNER_API, "app.post('/api/referral/payouts/request'", "app.get('/api/admin/referral/payouts'");
    assert.match(ep, /authMiddleware/);
    assert.match(ep, /const userId = req\.user\.id/);
    assert.match(ep, /isMarketingSandboxUser\(userId\)/);
    // The partner chooses the amount (NO MINIMUM) and the coin/network; the RPC
    // re-validates the amount against the server-derived available earnings.
    assert.match(ep, /req\.body\.walletAddress/);
    assert.match(ep, /walletAddress\.length < 10/);
    assert.match(ep, /resolvePayoutAsset\(/);
    assert.match(ep, /p_amount: amount/);
    assert.match(ep, /p_coin: asset\.coin/);
    assert.match(ep, /p_network: asset\.network/);
    assert.ok(!/amount < MIN_WITHDRAWAL|MIN_PAYOUT|minimum payout amount/i.test(ep), 'no minimum payout is enforced');
    assert.match(ep, /rpc\('request_referral_payout_safe'/);
    assert.match(ep, /p_user_id: userId/);
    // idempotency key is server-derived from the authenticated user id
    assert.match(ep, /'payout_' \+ userId \+ '_'/);
});

test('admin payout list/update are admin-gated and the manager is the authenticated admin', () => {
    const list = sliceBetween(PARTNER_API, "app.get('/api/admin/referral/payouts'", "app.put('/api/admin/referral/payouts/:id'");
    assert.match(list, /authMiddleware, adminMiddleware/);
    assert.match(list, /partner:users!user_id/);
    assert.match(list, /manager:users!manager_id/);

    const upd = sliceBetween(PARTNER_API, "app.put('/api/admin/referral/payouts/:id'", '// ============================================================');
    assert.match(upd, /authMiddleware, adminMiddleware/);
    assert.match(upd, /PAYOUT_STATUSES\.includes\(status\)/);
    assert.match(upd, /p_manager_id: req\.user\.id/);
    assert.ok(!/p_manager_id:\s*req\.body/.test(upd), 'manager must not come from the client');
    assert.match(upd, /rpc\('update_referral_payout_safe'/);
});

test('the payout endpoints contain no automated transfer / provider call', () => {
    assert.ok(!/PaymentService|nowpayments|axios|blockchain|sendTransaction/i.test(PARTNER_API),
        'no automated crypto payout machinery');
});

// ===========================================================================
// 3. Existing referral business rules are unchanged
// ===========================================================================
test('reward is one-time 20% of the INITIAL qualifying deposit (no flat amount, no commission)', () => {
    assert.match(SERVER, /const REFERRAL_REWARD_PERCENT_DEFAULT = 20;/);
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/);
    const activation = sliceBetween(SERVER, 'async function activateReferralOnQualification', 'async function getGenuinelyEarnedReferralEarnings');
    assert.match(activation, /rewardAmount = Math\.round\(Number\(depositInfo\.amount\) \* effectiveRewardPercent\) \/ 100/);
    assert.ok(!/REFERRAL_REWARD_AMOUNT_DEFAULT|referral_reward_amount/.test(SERVER), 'no flat reward exists');
    assert.ok(!/REFERRAL_PROFIT_COMMISSION_RATE|credit_referral_commission_safe/.test(SERVER), 'no commission exists');
});

test('the platform minimum qualifying deposit is enforced server-side ($100)', () => {
    const activation = sliceBetween(SERVER, 'async function activateReferralOnQualification', 'async function getGenuinelyEarnedReferralEarnings');
    assert.match(activation, /!\(Number\(depositInfo\.amount\) >= config\.minDeposit\)/);
    assert.match(activation, /below_minimum_deposit/);
});

test('registration stores attribution server-side and never awards a reward', () => {
    const reg = sliceBetween(SERVER, "app.post('/api/auth/register'", "app.post('/api/auth/login'");
    assert.match(reg, /from\('referrals'\)/);
    assert.match(reg, /status:\s*'pending'/);
    assert.match(reg, /bonus_earned:\s*0/);
    assert.ok(!/activateReferralOnQualification/.test(reg), 'registration must not qualify/award a referral');
    assert.ok(!/updateWallet|addTransaction/.test(reg), 'registration must not credit any reward');
});

test('self-referral is blocked at registration', () => {
    const reg = sliceBetween(SERVER, "app.post('/api/auth/register'", "app.post('/api/auth/login'");
    assert.match(reg, /normalizedRefCode === userReferralCode/);
    assert.match(reg, /Self-referral attempt blocked/);
});

test('a referral reward is credited at most once (conditional pending->active update)', () => {
    const activation = sliceBetween(SERVER, 'async function activateReferralOnQualification', 'async function getGenuinelyEarnedReferralEarnings');
    assert.match(activation, /\.eq\('status', 'pending'\)[\s\S]*\.select\('id'\)/);
    assert.match(activation, /already_activated/);
    assert.match(activation, /referral\.bonus_earned > 0/);
    // migration 021's SQL authority remains the exactly-once contract
    const m021 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '021_provider_referral_award_correctness.sql'), 'utf8');
    assert.match(m021, /award_referral_qualification_safe/);
    assert.match(m021, /FOR UPDATE/);
});

test('the frontend payout request sends amount + coin/network + address but never an identity', () => {
    const fn = sliceBetween(INDEX, 'async function submitReferralPayoutRequest', 'function getCurrentData');
    assert.match(fn, /amount: Math\.round\(amount \* 100\) \/ 100/);
    assert.match(fn, /coin: coin/);
    assert.match(fn, /network: network/);
    assert.match(fn, /walletAddress: address/);
    assert.match(fn, /idempotencyKey: APP\.payoutRequestKey/);
    // the amount is bounded client-side by the server-derived available earnings
    assert.match(fn, /amount > available \+ 0\.0000001/);
    assert.ok(!/userId|referrer_id|partner_id/.test(fn), 'the client must not send an identity');
});

// ===========================================================================
// 4. Pure-logic mirror of the payout lifecycle
// ===========================================================================
function canAdvance(current, next) {
    if (current === 'PAID' || current === 'REJECTED') return false; // terminal
    return ['PENDING', 'UNDER_REVIEW', 'PAID', 'REJECTED'].includes(next);
}
function refundOnReject(current, next, amount) {
    if (next === 'REJECTED' && current !== 'PAID' && current !== 'REJECTED') return amount;
    return 0;
}

test('lifecycle mirror: PENDING -> UNDER REVIEW -> PAID and REJECTED refunds once', () => {
    assert.ok(canAdvance('PENDING', 'UNDER_REVIEW'));
    assert.ok(canAdvance('UNDER_REVIEW', 'PAID'));
    assert.ok(canAdvance('PENDING', 'REJECTED'));
    assert.ok(!canAdvance('PAID', 'REJECTED'));
    assert.ok(!canAdvance('REJECTED', 'PAID'));
    assert.strictEqual(refundOnReject('UNDER_REVIEW', 'REJECTED', 20), 20);
    assert.strictEqual(refundOnReject('PAID', 'REJECTED', 20), 0);
    assert.strictEqual(refundOnReject('PENDING', 'PAID', 20), 0);
});

// ===========================================================================
// 5. i18n + UI wiring
// ===========================================================================
test('every locale has the full, identical referral-partner key set (no empties)', () => {
    const sets = LANGS.map((l) => Object.keys(T[l]).sort().join('|'));
    assert.strictEqual(new Set(sets).size, 1, 'identical key sets');
    const required = [
        'landing.partner.tag', 'landing.partner.title', 'landing.partner.subtitle',
        'landing.partner.step1', 'landing.partner.step2', 'landing.partner.step3',
        'landing.partner.step4', 'landing.partner.step5', 'landing.partner.cta',
        'landing.partner.disclosure',
        'referral.partner.title', 'referral.partner.totalReferrals', 'referral.partner.qualified',
        'referral.partner.volume', 'referral.partner.available', 'referral.partner.requestPayout',
        'referral.partner.alreadyOpen', 'referral.partner.pendingPayouts', 'referral.partner.history',
        'referral.partner.modalTitle', 'referral.partner.modalDesc', 'referral.partner.amountLabel',
        'referral.partner.walletLabel', 'referral.partner.walletPlaceholder', 'referral.partner.walletInvalid',
        'referral.partner.submit', 'referral.partner.manualNote', 'referral.partner.requested',
        'referral.partner.requestFailed', 'referral.partner.noPayouts', 'referral.partner.statusPending',
        'referral.partner.statusReview', 'referral.partner.statusPaid', 'referral.partner.statusRejected',
        'referral.partner.txRef', 'referral.partner.createdAt',
        'admin.referral.payoutsTab', 'admin.referral.payoutsHelp', 'admin.referral.payoutCol.partner',
        'admin.referral.payoutCol.amount', 'admin.referral.payoutCol.status', 'admin.referral.payoutCol.wallet',
        'admin.referral.payoutCol.txRef', 'admin.referral.payoutCol.manager', 'admin.referral.payoutCol.date',
        'admin.referral.payoutCol.action', 'admin.referral.recordPayment', 'admin.referral.rejectPayout',
        'admin.referral.txRefPrompt', 'admin.referral.rejectConfirm', 'admin.referral.noPayouts',
        'admin.referral.payoutUpdated', 'admin.referral.payoutUpdateFailed',
        // amount/coin/network + confirmation + history + support (migration 035 UI)
        'referral.partner.noMinimumNote', 'referral.partner.coinLabel', 'referral.partner.networkLabel',
        'referral.partner.confirmLabel', 'referral.partner.confirmRequired', 'referral.partner.amountInvalid',
        'referral.partner.amountExceeds', 'referral.partner.submittedReview', 'referral.partner.contactSupport',
        'referral.partner.requestedDate', 'referral.partner.paidDate', 'referral.partner.rejectionReason',
        'admin.referral.payoutCol.coin', 'admin.referral.payoutCol.network', 'admin.referral.paidAmountPrompt',
        'admin.referral.paidAmountInvalid', 'admin.referral.rejectReasonPrompt', 'admin.referral.rejectReasonRequired',
    ];
    for (const l of LANGS) {
        for (const k of required) {
            assert.ok(typeof T[l][k] === 'string' && T[l][k].trim(), l + ' missing/empty ' + k);
        }
    }
});

test('the landing partner section and the payout UI are wired', () => {
    assert.match(INDEX, /id="referral-partner"/);
    assert.match(INDEX, /data-i18n="landing\.partner\.title"/);
    assert.match(INDEX, /data-i18n="landing\.partner\.cta"/);
    assert.match(INDEX, /data-i18n="landing\.partner\.disclosure"/);
    assert.match(INDEX, /id="referralPayoutModal"/);
    assert.match(INDEX, /id="requestPayoutBtn"/);
    assert.match(INDEX, /id="adminReferralPayoutsTable"/);
    assert.match(INDEX, /id="refSubTabPayouts"/);
});

test('the payout modal collects an amount (no minimum), a coin/network and a confirmation', () => {
    assert.match(INDEX, /id="payoutAmountDisplay"/);
    assert.match(INDEX, /id="payoutAmountInput"/);
    assert.match(INDEX, /id="payoutWalletAddress"/);
    assert.match(INDEX, /id="payoutCoin"/);
    assert.match(INDEX, /id="payoutNetwork"/);
    assert.match(INDEX, /id="payoutConfirmCheck"/);
    assert.match(INDEX, /data-i18n="referral\.partner\.confirmLabel"/);
    // No minimum is advertised; the explicit no-minimum note is present.
    assert.match(INDEX, /data-i18n="referral\.partner\.noMinimumNote"/);
    // The "platform minimum applies" wording is gone from the referral UI.
    assert.ok(!/platform minimum applies/i.test(INDEX), 'the old platform-minimum wording must be removed');
});

test('no $700 withdrawal-minimum value remains anywhere in user-facing copy', () => {
    // Landing copy states there is no minimum.
    assert.match(T.en['landing.faq.5.a'], /no minimum withdrawal/i);
    assert.ok(!/\$700/.test(T.en['landing.faq.5.a']));
    // Across ALL locales, NO translation mentions $700 - not even the withdraw
    // pop-up (the internal minimum is server-enforced only, never displayed).
    for (const l of LANGS) {
        const offenders = Object.keys(T[l]).filter((k) => /\$700/.test(String(T[l][k])));
        assert.deepStrictEqual(offenders, [], l + ' advertises $700: ' + offenders.join(','));
    }
    // The bot knowledge base does NOT claim a $700 minimum.
    const kb = fs.readFileSync(path.join(ROOT, 'services', 'support', 'arbitrix-knowledge.json'), 'utf8');
    assert.ok(!/\$700/.test(kb), 'support bot must not state a $700 minimum');
    assert.match(kb, /no minimum withdrawal/i);
});
