'use strict';
// Referral Partner payout experience: partner-chosen amount (NO MINIMUM), coin +
// network selection, explicit confirmation, UNDER REVIEW after submission, the
// full payout history, the manager review actions and the configurable partner
// support contact. Static/source pins + a pure-logic mirror of the new request
// RPC (which lets a $20 payout from one qualifying referral succeed).
// No network or database is required.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const MIG034 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '034_referral_payouts.sql'), 'utf8');
const MIG035 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '035_referral_payout_amount_assets.sql'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

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
// 1. Migration 035 - amount + coin/network (additive; 034 remains the base)
// ===========================================================================
test('035 adds coin + network columns and keeps the manual (no automated transfer) model', () => {
    assert.match(MIG035, /ALTER TABLE public\.referral_payouts\s+ADD COLUMN IF NOT EXISTS coin TEXT NOT NULL DEFAULT 'USDT'/);
    assert.match(MIG035, /ALTER TABLE public\.referral_payouts\s+ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'TRC20'/);
    assert.ok(!/sendTransaction|transferUsdt|axios|fetch\(|https?:\/\//i.test(MIG035), 'no automated crypto transfer');
});

test('035 replaces the request RPC with a single amount/coin/network-aware function', () => {
    assert.match(MIG035, /DROP FUNCTION IF EXISTS public\.request_referral_payout_safe\(BIGINT, TEXT, TEXT\)/);
    assert.match(MIG035, /FUNCTION public\.request_referral_payout_safe\(/);
    assert.match(MIG035, /p_amount DECIMAL DEFAULT NULL/);
    assert.match(MIG035, /p_coin TEXT DEFAULT 'USDT'/);
    assert.match(MIG035, /p_network TEXT DEFAULT 'TRC20'/);
    assert.match(MIG035, /\(user_id, amount, status, wallet_address, coin, network, idempotency_key\)/);
});

test('035 preserves the safety guarantees (idempotency, lock, one-open, active-referral cap, bonus only)', () => {
    const rpc = sliceBetween(MIG035, 'FUNCTION public.request_referral_payout_safe', '-- 3. EXECUTE LOCKDOWN');
    assert.match(rpc, /idempotency_key = p_idempotency_key/);
    assert.match(rpc, /SELECT \* INTO v_wallet FROM public\.wallets WHERE user_id = p_user_id FOR UPDATE/);
    const first = rpc.indexOf('idempotency_key = p_idempotency_key');
    const lock = rpc.indexOf('FOR UPDATE');
    const second = rpc.indexOf('idempotency_key = p_idempotency_key', first + 1);
    assert.ok(first > 0 && lock > first && second > lock, 'double idempotency check around the lock');
    assert.match(MIG035, /status IN \('PENDING', 'UNDER_REVIEW'\)/, 'one open payout guard');
    assert.match(MIG035, /status = 'active' AND referred_id > 0/, 'confirmed-deposit (qualified) referrals only');
    assert.match(MIG035, /SET bonus_balance = v_new_bonus/);
    assert.ok(!/live_balance\s*=|demo_balance\s*=/.test(MIG035), 'must not touch live/demo balances');
    assert.match(MIG035, /environment = 'MARKETING_SANDBOX'/);
    assert.match(MIG035, /REVOKE EXECUTE ON FUNCTION public\.request_referral_payout_safe/);
    assert.match(MIG035, /TO service_role/);
    assert.match(MIG035, /RAISE EXCEPTION/); // self-check
});

test('035 enforces NO MINIMUM and issues an UNDER_REVIEW payout', () => {
    const rpc = sliceBetween(MIG035, 'FUNCTION public.request_referral_payout_safe', '-- 3. EXECUTE LOCKDOWN');
    assert.ok(!/v_requested\s*<\s*[0-9]/.test(rpc), 'no minimum amount check');
    assert.ok(!/MIN_PAYOUT|min_payout|minimum payout/i.test(rpc), 'no minimum payout rule');
    assert.match(rpc, /v_requested := ROUND\(COALESCE\(p_amount, v_available\), 2\)/);
    assert.match(rpc, /IF v_requested <= 0 THEN[\s\S]*invalid_amount/);
    assert.match(rpc, /IF v_requested > v_available THEN[\s\S]*amount_exceeds_available/);
    assert.match(rpc, /VALUES \(p_user_id, v_requested, 'UNDER_REVIEW'/);
});

test('034 (the base migration) is untouched by this change', () => {
    assert.match(MIG034, /VALUES \(p_user_id, v_available, 'PENDING', v_address, p_idempotency_key\)/);
});

// ===========================================================================
// 2. Pure-logic mirror of the new request RPC
// ===========================================================================
function round2(n) { return Math.round(n * 100) / 100; }

function requestPayout(bonusBalance, activeRewards, amount) {
    const available = round2(Math.min(bonusBalance, activeRewards));
    if (available <= 0) return { success: false, reason: 'no_referral_earnings' };
    const requested = amount == null ? available : round2(amount);
    if (requested <= 0) return { success: false, reason: 'invalid_amount', available };
    if (requested > available) return { success: false, reason: 'amount_exceeds_available', available };
    return { success: true, amount: requested, status: 'UNDER_REVIEW', available, bonusBalance: round2(bonusBalance - requested) };
}

test('a $20 payout from a single qualifying referral succeeds (no minimum)', () => {
    // One referred user deposited $100 -> reward 20% -> $20 earned.
    const r = requestPayout(20, 20, 20);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.amount, 20);
    assert.strictEqual(r.status, 'UNDER_REVIEW');
    assert.strictEqual(r.bonusBalance, 0);
});

test('partial payouts are allowed with no minimum (e.g. $1 of $40)', () => {
    const r = requestPayout(40, 40, 1);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.amount, 1);
    assert.strictEqual(r.bonusBalance, 39);
});

test('the amount may be omitted to pay the full available balance', () => {
    const r = requestPayout(35, 35, null);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.amount, 35);
    assert.strictEqual(r.bonusBalance, 0);
});

test('invalid amounts are refused (zero, negative, above available)', () => {
    assert.strictEqual(requestPayout(20, 20, 0).reason, 'invalid_amount');
    assert.strictEqual(requestPayout(20, 20, -5).reason, 'invalid_amount');
    const over = requestPayout(20, 20, 25);
    assert.strictEqual(over.success, false);
    assert.strictEqual(over.reason, 'amount_exceeds_available');
    assert.strictEqual(over.available, 20);
});

test('no earnings -> nothing to pay out (no debt, no negative balance)', () => {
    const r = requestPayout(0, 0, 20);
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.reason, 'no_referral_earnings');
});

test('available is capped by BOTH the earnings bucket and the qualified rewards', () => {
    // bonus_balance inflated above genuine rewards -> capped at the rewards.
    const r = requestPayout(1000, 20, 20);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.available, 20);
});

// ===========================================================================
// 3. Server endpoint pins
// ===========================================================================
test('PAYOUT_ASSETS is the single source of truth (launch scope: USDT on TRC20 only)', () => {
    assert.match(SERVER, /const PAYOUT_ASSETS = \[/);
    assert.match(SERVER, /\{ coin: 'USDT', networks: \['TRC20'\] \}/);
    assert.ok(!/networks: \[[^\]]*'ERC20'/.test(SERVER), 'ERC20 must not be a selectable payout network');
    assert.match(SERVER, /function resolvePayoutAsset\(/);
    const partnerGet = sliceBetween(PARTNER_API, "app.get('/api/referral/partner'", "app.post('/api/referral/payouts/request'");
    assert.match(partnerGet, /assets: PAYOUT_ASSETS/);
});

test('the payout request accepts amount + coin/network and forwards them to the RPC', () => {
    const ep = sliceBetween(PARTNER_API, "app.post('/api/referral/payouts/request'", "app.get('/api/admin/referral/payouts'");
    assert.match(ep, /resolvePayoutAsset\(req\.body && req\.body\.coin, req\.body && req\.body\.network\)/);
    assert.match(ep, /p_amount: amount/);
    assert.match(ep, /p_coin: asset\.coin/);
    assert.match(ep, /p_network: asset\.network/);
    assert.match(ep, /amount_exceeds_available/);
    assert.match(ep, /invalid_amount/);
    assert.ok(!/MIN_PAYOUT|minimum payout/i.test(ep), 'no minimum payout');
});

test('the partner dashboard returns coin/network/note for the history', () => {
    const partnerGet = sliceBetween(PARTNER_API, "app.get('/api/referral/partner'", "app.post('/api/referral/payouts/request'");
    assert.match(partnerGet, /coin, network/);
    assert.match(partnerGet, /note/);
    assert.match(partnerGet, /pendingPayouts/);
    assert.match(partnerGet, /paidPayouts/);
});

test('the admin list returns coin/network (and keeps the manager as the authenticated admin)', () => {
    const list = sliceBetween(PARTNER_API, "app.get('/api/admin/referral/payouts'", "app.put('/api/admin/referral/payouts/:id'");
    assert.match(list, /wallet_address, coin, network/);
    assert.match(list, /coin: p\.coin/);
    assert.match(list, /network: p\.network/);
    const upd = sliceBetween(PARTNER_API, "app.put('/api/admin/referral/payouts/:id'", '// ============================================================');
    assert.match(upd, /p_manager_id: req\.user\.id/);
    assert.match(upd, /body\.note/);
});

// ===========================================================================
// 4. Frontend: modal, history, support, admin actions
// ===========================================================================
test('the payout modal collects amount, coin, network, address and an explicit confirmation', () => {
    for (const id of ['payoutAmountInput', 'payoutCoin', 'payoutNetwork', 'payoutWalletAddress', 'payoutConfirmCheck', 'payoutSubmitBtn']) {
        assert.match(INDEX, new RegExp('id="' + id + '"'), 'missing ' + id);
    }
    assert.match(INDEX, /data-i18n="referral\.partner\.confirmLabel"/);
    assert.match(INDEX, /id="payoutCoin"[\s\S]{0,120}onchange="onPayoutAssetChange\(\)"/);
});

test('the submit handler requires the confirmation and validates the amount against the server value', () => {
    const fn = sliceBetween(INDEX, 'async function submitReferralPayoutRequest', 'function getCurrentData');
    assert.match(fn, /confirmRequired/);
    assert.match(fn, /amount > available \+ 0\.0000001/);
    assert.match(fn, /amount: Math\.round\(amount \* 100\) \/ 100/);
});

test('after submission the partner sees an UNDER REVIEW state', () => {
    const fn = sliceBetween(INDEX, 'async function submitReferralPayoutRequest', 'function getCurrentData');
    assert.match(fn, /referral\.partner\.submittedReview/);
    // The new request is created UNDER_REVIEW by the RPC (migration 035).
    assert.match(MIG035, /'UNDER_REVIEW'/);
});

test('the payout history shows amount, coin, network, a masked wallet, dates, tx ref and rejection reason', () => {
    const fn = sliceBetween(INDEX, 'function payoutItemHtml', 'function renderReferralPayouts');
    assert.match(fn, /maskWalletAddress\(/);
    assert.match(fn, /p\.coin/);
    assert.match(fn, /p\.network/);
    assert.match(fn, /referral\.partner\.requestedDate/);
    assert.match(fn, /referral\.partner\.paidDate/);
    assert.match(fn, /p\.tx_reference/);
    assert.match(fn, /p\.note/);
    assert.match(fn, /referral\.partner\.rejectionReason/);
});

test('the wallet address is masked (first 6 + last 4)', () => {
    const fn = sliceBetween(INDEX, 'function maskWalletAddress', 'function payoutAssetList');
    assert.match(fn, /slice\(0, 6\)/);
    assert.match(fn, /slice\(-4\)/);
});

test('the coin/network lists come from the server assets (extensible), not hard-coded', () => {
    const fn = sliceBetween(INDEX, 'function populatePayoutAssetSelects', 'function onPayoutAssetChange');
    assert.match(fn, /payoutAssetList\(\)/);
    assert.match(INDEX, /referralPartner\.assets/);
    assert.match(INDEX, /function onPayoutAssetChange\(/);
});

test('the manager can review, record the actual amount + tx hash, mark PAID or reject with a reason', () => {
    assert.match(INDEX, /function recordReferralPayoutPayment\(/);
    assert.match(INDEX, /admin\.referral\.paidAmountPrompt/);
    assert.match(INDEX, /admin\.referral\.txRefPrompt/);
    assert.match(INDEX, /function rejectReferralPayout\(/);
    assert.match(INDEX, /admin\.referral\.rejectReasonPrompt/);
    assert.match(INDEX, /admin\.referral\.rejectReasonRequired/);
    const upd = sliceBetween(INDEX, 'async function updateReferralPayout', 'function recordReferralPayoutPayment');
    assert.match(upd, /note: opts\.note \|\| null/);
    assert.match(INDEX, /function renderReferralPayoutsAdmin\(/);
    assert.match(INDEX, /admin\.referral\.payoutCol\.coin/);
    assert.match(INDEX, /admin\.referral\.payoutCol\.network/);
});

test('a Contact Partner Support action uses a CONFIGURABLE contact (never a hard-coded account)', () => {
    assert.match(INDEX, /id="partnerSupportBtn"/);
    assert.match(INDEX, /onclick="openPartnerSupport\(\)"/);
    assert.match(INDEX, /meta name="arbitrix-partner-support-telegram"/);
    assert.match(INDEX, /ARBITRIX_PARTNER_SUPPORT_TELEGRAM_URL/);
    const fn = sliceBetween(INDEX, 'function getPartnerSupportTelegramUrl', 'function openPartnerSupport');
    assert.match(fn, /partner-support-telegram/);
    const open = sliceBetween(INDEX, 'function openPartnerSupport', 'function closeReferralPayoutModal');
    assert.match(open, /window\.open\(url/);
    assert.match(open, /openSupportModal\(\)/); // fallback when unset
    // The button markup itself must not inline a personal telegram account.
    const btn = sliceBetween(INDEX, 'id="partnerSupportBtn"', '</button>');
    assert.ok(!/t\.me\//i.test(btn), 'partner support button must not hard-code a personal account');
});

test('the partner support contact is configured in ONE place and resolves to a t.me URL', () => {
    const m = INDEX.match(/<meta name="arbitrix-partner-support-telegram" content="([^"]*)">/);
    assert.ok(m, 'partner support meta present');
    const configured = m[1].trim();
    assert.ok(configured.length > 0, 'a partner support contact must be configured');
    // Single source of truth: the configured value appears exactly once in the page.
    assert.strictEqual(INDEX.split(configured).length - 1, 1, 'the contact must not be hard-coded more than once');
    // The helper turns a bare @username into a t.me URL (and passes a full URL through).
    const fn = sliceBetween(INDEX, 'function getPartnerSupportTelegramUrl', 'function openPartnerSupport');
    assert.match(fn, /test\(raw\)/);
    assert.match(fn, /return 'https:\/\/t\.me\/' \+ raw\.replace\(\/\^@\/, ''\)/);
});

test('the referral UI no longer says "platform minimum applies"', () => {
    assert.ok(!/platform minimum applies/i.test(INDEX), 'old wording removed');
    assert.match(INDEX, /data-i18n="referral\.partner\.noMinimumNote"/);
});

// ===========================================================================
// 5. i18n completeness
// ===========================================================================
test('all 6 locales keep an identical, complete, non-empty payout key set', () => {
    const counts = LANGS.map((l) => Object.keys(T[l]).length);
    assert.deepStrictEqual(counts, [1505, 1505, 1505, 1505, 1505, 1505]);
    const base = Object.keys(T.en).sort().join('|');
    for (const l of LANGS) assert.strictEqual(Object.keys(T[l]).sort().join('|'), base, l + ' key set drift');
    for (const l of LANGS) for (const k of Object.keys(T[l])) {
        assert.ok(typeof T[l][k] === 'string' && T[l][k].trim().length > 0, l + ' empty ' + k);
    }
});

test('the no-minimum / no-trading wording is present in every locale', () => {
    assert.match(T.en['referral.partner.noMinimumNote'], /minimum/i, 'EN must state no minimum');
    for (const l of LANGS) {
        const v = T[l]['referral.partner.noMinimumNote'];
        assert.ok(typeof v === 'string' && v.trim().length > 0, l + ' noMinimumNote must be non-empty');
        // No payout wording states a numeric threshold.
        assert.ok(!/\d/.test(v), l + ' noMinimumNote must not contain a figure');
    }
    // The withdraw note (sidebar) also states no minimum and no trading.
    for (const l of LANGS) {
        assert.ok(!/platform minimum applies/i.test(T[l]['referral.withdrawNote']), l + ' withdrawNote still says platform minimum applies');
        assert.ok(!/\d/.test(T[l]['referral.withdrawNote']), l + ' withdrawNote must not contain a figure');
    }
});

test('no locale advertises a $700 payout/withdrawal minimum in the payout keys', () => {
    for (const l of LANGS) {
        for (const k of Object.keys(T[l])) {
            if (k.indexOf('referral.partner.') === 0 || k.indexOf('admin.referral.') === 0) {
                assert.ok(!/\$700/.test(String(T[l][k])), l + ' ' + k + ' mentions $700');
            }
        }
    }
});

// ===========================================================================
// 6. Functional: run the REAL submit handler against a stubbed fetch
// ===========================================================================
function runSubmit(opts) {
    const fnSrc = sliceBetween(INDEX, 'async function submitReferralPayoutRequest', 'function getCurrentData');
    const mk = (v) => ({ value: v == null ? '' : String(v), checked: false, textContent: '', disabled: false, classList: { add() {}, remove() {} } });
    const els = {
        payoutAmountInput: mk(opts.amount),
        payoutWalletAddress: mk(opts.address),
        payoutCoin: mk(opts.coin || 'USDT'),
        payoutNetwork: mk(opts.network || 'TRC20'),
        payoutConfirmCheck: mk(''),
        payoutSubmitBtn: mk(''),
        payoutError: mk(''),
    };
    els.payoutConfirmCheck.checked = !!opts.confirmed;
    const calls = [];
    const sandbox = {
        APP: { referralPartner: { availableEarnings: opts.available } },
        localStorage: { getItem: () => 'jwt' },
        getEl: (id) => els[id] || null,
        t: (k) => k,
        translateBackendMessage: (e, f) => f,
        showToast: () => {},
        closeReferralPayoutModal: () => {},
        fetchReferralPartner: async () => {},
        syncWalletFromServer: async () => {},
        updateUI: () => {},
        Math, JSON, Number, isFinite, console,
        fetch: async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return { ok: true, json: async () => ({ success: true, status: 'UNDER_REVIEW' }) };
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + ';globalThis.__run = submitReferralPayoutRequest;', sandbox);
    return sandbox.__run().then(() => ({ calls, err: els.payoutError.textContent }));
}

test('functional: a $20 payout is submitted with coin + network + address', async () => {
    const r = await runSubmit({ available: 20, amount: 20, address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', coin: 'USDT', network: 'TRC20', confirmed: true });
    assert.strictEqual(r.calls.length, 1, 'exactly one request');
    assert.strictEqual(r.calls[0].url, '/api/referral/payouts/request');
    assert.strictEqual(r.calls[0].body.amount, 20);
    assert.strictEqual(r.calls[0].body.coin, 'USDT');
    assert.strictEqual(r.calls[0].body.network, 'TRC20');
    assert.ok(r.calls[0].body.walletAddress.length >= 10);
});

test('functional: the confirmation checkbox is required (no request without it)', async () => {
    const r = await runSubmit({ available: 20, amount: 20, address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', confirmed: false });
    assert.strictEqual(r.calls.length, 0, 'must not submit without confirmation');
    assert.strictEqual(r.err, 'referral.partner.confirmRequired');
});

test('functional: an amount above the available earnings is blocked client-side', async () => {
    const r = await runSubmit({ available: 20, amount: 25, address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', confirmed: true });
    assert.strictEqual(r.calls.length, 0);
    assert.strictEqual(r.err, 'referral.partner.amountExceeds');
});

test('functional: a sub-minimum amount ($1) is allowed (no minimum)', async () => {
    const r = await runSubmit({ available: 20, amount: 1, address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', confirmed: true });
    assert.strictEqual(r.calls.length, 1);
    assert.strictEqual(r.calls[0].body.amount, 1);
});
