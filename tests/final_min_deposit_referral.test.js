'use strict';

/**
 * FINAL management business model (production + MARKETING SANDBOX).
 * Supersedes the earlier flat-$20 / 10% commission revisions.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const M020 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '020_referral_reward_model.sql'), 'utf8');
const M021 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '021_provider_referral_award_correctness.sql'), 'utf8');
const M022 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '022_sandbox_referral_program.sql'), 'utf8');
const M023 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '023_final_min_deposit_and_referral_earnings.sql'), 'utf8');
const M024 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '024_remove_obsolete_referral_commission.sql'), 'utf8');

const MIN_DEPOSIT = 100;
const REWARD_PERCENT = 20;
// FINAL management model: referral earnings have NO conversion minimum.
const CONVERT_MIN = 0;

function rewardFor(depositAmount, percent = REWARD_PERCENT) {
    const d = Number(depositAmount);
    if (!isFinite(d) || d <= 0) return 0;
    return Math.round(d * percent) / 100;
}

function qualifyReferral(state, depositAmount) {
    if (!state.exists) return { outcome: 'no_pending_referral', reward: 0 };
    if (state.status !== 'pending' || state.bonusEarned > 0) return { outcome: 'already_activated', reward: 0 };
    if (!(Number(depositAmount) >= MIN_DEPOSIT)) return { outcome: 'below_minimum_deposit', reward: 0 };
    return { outcome: 'activated', reward: rewardFor(depositAmount) };
}

function convert(ledger, wallet, key, minAmount = CONVERT_MIN) {
    if (!key) return { success: false, error: 'missing_idempotency_key' };
    const prior = ledger.find((r) => r.key === key);
    if (prior) return { success: true, duplicate: true, amount: prior.amount, live: prior.live };
    const earnings = Math.round((wallet.bonus_balance || 0) * 100) / 100;
    if (earnings <= 0) return { success: false, reason: 'no_referral_earnings' };
    if (earnings < minAmount) return { success: false, reason: 'below_minimum' };
    wallet.bonus_balance = 0;
    wallet.live_balance = Math.round((wallet.live_balance + earnings) * 100) / 100;
    ledger.push({ key, amount: earnings, live: wallet.live_balance });
    return { success: true, duplicate: false, amount: earnings, live: wallet.live_balance };
}

const WITHDRAW_SOURCE = SERVER.slice(
    SERVER.indexOf("app.post('/api/withdraw/request'"),
    SERVER.indexOf("app.get('/api/withdraw/history'")
);

function fnSource(name) {
    const idx = SERVER.indexOf(`function ${name}(`);
    assert.ok(idx >= 0, `function not found: ${name}`);
    const next = SERVER.indexOf('\nfunction ', idx + 1);
    const next2 = SERVER.indexOf('\nasync function ', idx + 1);
    let end = next < 0 ? next2 : next;
    if (next2 > 0 && (end < 0 || next2 < end)) end = next2;
    return SERVER.slice(idx, end < 0 ? undefined : end);
}

function translations() {
    const blocks = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const blk = blocks.find((b) => b.includes('const TRANSLATIONS'));
    const start = blk.indexOf('const TRANSLATIONS');
    const braceAt = blk.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = braceAt; i < blk.length; i++) {
        if (blk[i] === '{') depth++;
        else if (blk[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + blk.slice(braceAt, end + 1), sandbox);
    return sandbox.T;
}

test('min deposit: single server source of truth is $100', () => {
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/, 'platform minimum deposit constant must be $100');
    assert.match(SERVER, /const MIN_DEPOSIT_AMOUNT = PLATFORM_MIN_DEPOSIT_USD;/, 'production invoice route uses the constant');
    assert.ok(!/const MIN_DEPOSIT_AMOUNT = 50;/.test(SERVER), 'no stale $50 production minimum');
});

test('min deposit: production invoice validation rejects < $100 and accepts $100', () => {
    const body = SERVER.slice(SERVER.indexOf("app.post('/api/payment/create-invoice'"), SERVER.indexOf("app.post('/api/payment/create-invoice'") + 1200);
    assert.ok(body.includes('amount < MIN_DEPOSIT_AMOUNT'), 'amount gate present');
    assert.ok(body.includes('minimum deposit is $${MIN_DEPOSIT_AMOUNT}'), 'error message uses the constant');
});

test('min deposit: sandbox simulated deposits enforce the same $100 floor', () => {
    for (const name of ['handleSandboxDepositRequest', 'handleSandboxInvoiceCreate']) {
        const body = fnSource(name);
        assert.match(body, /amt < PLATFORM_MIN_DEPOSIT_USD/, `${name} must enforce the platform minimum`);
    }
    assert.match(SERVER, /const SANDBOX_REFERRAL_MIN_DEPOSIT = PLATFORM_MIN_DEPOSIT_USD;/,
        'sandbox referral qualifying deposit mirrors the platform minimum');
});

test('min deposit: referral config fallbacks are the platform minimum (no stale 50)', () => {
    assert.match(SERVER, /minimum_qualifying_deposit: \{ value: String\(PLATFORM_MIN_DEPOSIT_USD\)/);
    assert.ok(!/getReferralConfig\('minimum_qualifying_deposit', '50'\)/.test(SERVER), 'no $50 referral-min fallback left');
    assert.match(M021, /v_min DECIMAL := 100;/, 'production helper fallback is $100');
    assert.match(M022, /v_min DECIMAL := 100;/, 'sandbox config fallback is $100');
});

test('reward: server default percent is 20 and the flat amount model is gone', () => {
    assert.match(SERVER, /const REFERRAL_REWARD_PERCENT_DEFAULT = 20;/);
    assert.ok(!/REFERRAL_REWARD_DEFAULT_USD/.test(SERVER), 'no flat reward constant');
    const cfg = fnSource('getDefaultReferralConfig');
    assert.match(cfg, /referral_reward_percent: \{ value: String\(REFERRAL_REWARD_PERCENT_DEFAULT\)/);
    assert.ok(!/referral_reward_amount/.test(cfg), 'no flat reward config key');
    assert.ok(!/referral_profit_commission_rate/.test(cfg), 'no commission config key');
});

test('reward: qualification computes percent-of-deposit, never a fixed amount', () => {
    const fn = fnSource('activateReferralOnQualification');
    assert.match(fn, /getReferralConfig\('referral_reward_percent'/);
    assert.match(fn, /const rewardAmount = Math\.round\(Number\(depositInfo\.amount\) \* effectiveRewardPercent\) \/ 100;/,
        'reward = percent of the deposit the referral qualified with');
    assert.ok(!/config\.rewardAmount/.test(fn), 'no fixed reward amount reference');
    assert.match(fn, /below_minimum_deposit/, 'below-minimum deposits never qualify');
});

test('reward math: 20% of $100 / $250 / $300 (not a flat $20)', () => {
    assert.strictEqual(rewardFor(100), 20);
    assert.strictEqual(rewardFor(250), 50);
    assert.strictEqual(rewardFor(300), 60);
    assert.strictEqual(rewardFor(100.5), 20.1);
    assert.notStrictEqual(rewardFor(300), 20, 'the final model is NOT a flat $20');
});

test('qualification: deposit-only, exact minimum, exactly once', () => {
    assert.deepStrictEqual(qualifyReferral({ exists: true, status: 'pending', bonusEarned: 0 }, 0),
        { outcome: 'below_minimum_deposit', reward: 0 });
    assert.deepStrictEqual(qualifyReferral({ exists: true, status: 'pending', bonusEarned: 0 }, 99.99),
        { outcome: 'below_minimum_deposit', reward: 0 });
    assert.deepStrictEqual(qualifyReferral({ exists: true, status: 'pending', bonusEarned: 0 }, 100),
        { outcome: 'activated', reward: 20 });
    assert.deepStrictEqual(qualifyReferral({ exists: true, status: 'active', bonusEarned: 20 }, 500),
        { outcome: 'already_activated', reward: 0 });
    assert.deepStrictEqual(qualifyReferral({ exists: true, status: 'pending', bonusEarned: 20 }, 500),
        { outcome: 'already_activated', reward: 0 });
    assert.deepStrictEqual(qualifyReferral({ exists: false }, 1000),
        { outcome: 'no_pending_referral', reward: 0 });
});

test('attribution: the existing referral resolution is preserved', () => {
    const fn = fnSource('activateReferralOnQualification');
    assert.match(fn, /\.from\('referrals'\)/);
    assert.match(fn, /\.eq\('referred_id', userId\)/);
    assert.match(fn, /\.eq\('status', 'pending'\)/);
    assert.match(fn, /referral\.bonus_earned > 0/, 'duplicate-award guard');
});

test('reward: only confirmed-deposit paths invoke the award (registration does not)', () => {
    const defIdx = SERVER.indexOf('async function activateReferralOnQualification');
    assert.ok(defIdx >= 0);
    const registerIdx = SERVER.indexOf("app.post('/api/auth/register'");
    assert.ok(registerIdx > 0);
    const registerBody = SERVER.slice(registerIdx, registerIdx + 3000);
    assert.ok(!/activateReferralOnQualification/.test(registerBody), 'registration never awards a referral reward');
    const calls = (SERVER.match(/activateReferralOnQualification\(/g) || []).length;
    assert.ok(calls >= 4, 'the confirmed-deposit paths still invoke the award');
});

test('commission: the retired 10% architecture is absent from server.js', () => {
    assert.ok(!/creditReferralProfitCommission/.test(SERVER), 'no commission award helper');
    assert.ok(!/REFERRAL_PROFIT_COMMISSION_RATE/.test(SERVER), 'no commission rate constant');
    assert.ok(!/referral_profit_commission_rate/.test(SERVER), 'no commission config key');
    assert.ok(!/credit_referral_commission_safe/.test(SERVER), 'no commission RPC call');
    assert.ok(!/referral_commissions/.test(SERVER), 'no commission ledger reads');
    assert.ok(!/REFERRAL_COMMISSION_TX_TYPE/.test(SERVER), 'no commission transaction type');
});

test('commission: a trade never credits a referrer (the trade route is clean)', () => {
    const idx = SERVER.indexOf("app.post('/api/trade'");
    const body = SERVER.slice(idx, idx + 2500);
    assert.ok(!/creditReferralProfitCommission/.test(body), 'no referral credit on the trade path');
    assert.match(body, /record_trade_safe/, 'the existing trading engine is untouched');
});

test('commission: migration 020 removes the obsolete commission architecture', () => {
    assert.match(M020, /config_key = 'referral_reward_percent'/, 'final percent config seeded');
    assert.match(M020, /DELETE FROM public\.referral_config[\s\S]{0,140}referral_reward_amount/);
    assert.match(M020, /DROP TABLE IF EXISTS public\.referral_commissions/);
    assert.match(M020, /credit_referral_commission_safe/, 'drops the obsolete commission RPC');
});

test('commission: migration 024 fails loudly while retired bodies survive', () => {
    assert.match(M024, /RAISE EXCEPTION/, 'convergence guard raises');
    assert.match(M024, /referral_commissions/);
    assert.match(M024, /credit_referral_commission_safe/);
});

test('earnings: genuinely-earned referral income excludes commissions and simulated rows', () => {
    const fn = fnSource('getGenuinelyEarnedReferralEarnings');
    assert.match(fn, /\.eq\('status', 'active'\)/);
    assert.match(fn, /\.gt\('referred_id', 0\)/, 'test-only simulated rows are excluded');
    assert.ok(!/getReferralCommissionTotal|commission/.test(fn), 'no commission component');
    assert.match(fn, /bonusBalance/, 'capped by the earnings bucket');
});

test('earnings: referral earnings convert with NO minimum (final model)', () => {
    assert.match(SERVER, /const REFERRAL_EARNINGS_MIN_CONVERT_USD = 0;/, 'the old $50 bonus-wallet threshold is retired for referral earnings');
    assert.match(SERVER, /p_min_amount: REFERRAL_EARNINGS_MIN_CONVERT_USD/, 'the conversion passes the (now zero) minimum');
    assert.match(M023, /CREATE OR REPLACE FUNCTION public\.convert_referral_earnings_safe/);
    assert.match(M023, /ALTER TABLE public\.referral_earning_conversions ENABLE ROW LEVEL SECURITY/);
    assert.match(M023, /REVOKE EXECUTE ON FUNCTION public\.convert_referral_earnings_safe\(BIGINT, TEXT, DECIMAL\) FROM anon;/);
    assert.match(M023, /GRANT EXECUTE ON FUNCTION public\.convert_referral_earnings_safe\(BIGINT, TEXT, DECIMAL\) TO service_role;/);
});

test('earnings: conversion is exactly-once and never creates money', () => {
    const ledger = [];
    const wallet = { bonus_balance: 60, live_balance: 7 };
    const a = convert(ledger, wallet, 'k1');
    assert.deepStrictEqual(a, { success: true, duplicate: false, amount: 60, live: 67 });
    const b = convert(ledger, wallet, 'k1');
    assert.strictEqual(b.duplicate, true);
    assert.strictEqual(wallet.live_balance, 67, 'a duplicate key never re-credits');
    assert.strictEqual(wallet.bonus_balance, 0);
});

test('earnings: empty bucket is refused; small genuine earnings convert', () => {
    assert.strictEqual(convert([], { bonus_balance: 0, live_balance: 0 }, 'k').reason, 'no_referral_earnings');
    assert.strictEqual(convert([], { bonus_balance: 60, live_balance: 0 }, '').error, 'missing_idempotency_key');
    // A single qualifying referral at the $100 minimum earns $20, which must be
    // convertible to tradable capital (no $50 threshold).
    const w = { bonus_balance: 20, live_balance: 0 };
    assert.deepStrictEqual(convert([], w, 'k20'), { success: true, duplicate: false, amount: 20, live: 20 });
    const w2 = { bonus_balance: 5, live_balance: 3 };
    assert.strictEqual(convert([], w2, 'k5').success, true);
    assert.strictEqual(w2.live_balance, 8);
});

test('promo credit: stays $50 and is not derived from the minimum deposit', () => {
    assert.match(SERVER, /const SANDBOX_PROMO_CREDIT = 50;/);
    assert.ok(!/const PLATFORM_MIN_DEPOSIT_USD = 50/.test(SERVER));
});

test('promo credit: tradable through the EXISTING engine (no separate engine)', () => {
    assert.match(SERVER, /function isPromoFundedTrading\(/);
    const trade = SERVER.slice(SERVER.indexOf("app.post('/api/trade'"), SERVER.indexOf("app.post('/api/trade'") + 900);
    assert.match(trade, /record_trade_safe/, 'promo trading uses the same trading engine');
});

test('promo credit: withdrawal requires a qualifying first deposit, then one trade', () => {
    assert.ok(WITHDRAW_SOURCE.indexOf('verificationRequired') < WITHDRAW_SOURCE.indexOf('Min $700'), 'KYC is still the first gate');
    assert.ok(WITHDRAW_SOURCE.includes('Min $700'), 'existing $700 minimum preserved');
    assert.ok(WITHDRAW_SOURCE.includes('Complete at least 1 trade first'), 'the existing one-trade rule is preserved');
    assert.ok(WITHDRAW_SOURCE.includes('A qualifying first deposit is required before you can withdraw your promotional credit'), 'clear deposit requirement message');
    assert.ok(WITHDRAW_SOURCE.includes('depositRequired: true'));
    assert.ok(WITHDRAW_SOURCE.includes('requiresFirstDeposit: true'));
});

test('MTA: production $200 via a single source of truth, sandbox has none', () => {
    assert.match(SERVER, /const BOT_MIN_TRADING_BALANCE = 200;/, 'production MTA is $200');
    assert.match(SERVER, /const MTA_ENV_VAR = 'MTA_AMOUNT';/, 'env override is the single knob');
    assert.match(SERVER, /function getEffectiveMta\(/);
    assert.match(SERVER, /mta: 0/, 'sandbox reports MTA 0');
    const sandboxBot = fnSource('handleSandboxBotStart');
    assert.ok(!/BOT_MIN_TRADING_BALANCE|getEffectiveMta/.test(sandboxBot), 'sandbox bot start has no MTA gate');
});

test('sandbox: reward percent / minimum deposit mirror production', () => {
    assert.match(SERVER, /const SANDBOX_REFERRAL_REWARD_PERCENT_DEFAULT = 20;/);
    assert.match(SERVER, /const SANDBOX_REFERRAL_MIN_DEPOSIT = PLATFORM_MIN_DEPOSIT_USD;/);
    assert.ok(!/SANDBOX_REFERRAL_COMMISSION_RATE/.test(SERVER), 'no sandbox commission rate');
    assert.match(M022, /'minimum_deposit', COALESCE\(v_min, 100\)/);
    assert.match(M022, /'reward_percent', COALESCE\(v_percent, 20\)/);
    const fn = M022.slice(M022.indexOf('FUNCTION public.sandbox_award_referral_qualification'));
    assert.match(fn, /p_deposit_amount < v_min/, '$99.99 must not qualify in the sandbox');
    assert.match(fn, /v_reward := ROUND\(p_deposit_amount \* v_percent \/ 100\.0, 2\)/, '20% of the deposit');
    assert.match(fn, /bonus_earned = v_reward/, 'awards exactly the percent reward once');
    assert.match(fn, /FOR UPDATE/, 'concurrency guard');
});

test('sandbox: the retired commission surface is absent', () => {
    assert.ok(!/creditSandboxDownlineCommission/.test(SERVER), 'no sandbox commission helper');
    assert.ok(!/simulateSandboxDownlineProfit/.test(SERVER), 'no sandbox commission simulation');
    assert.match(M022, /DROP TABLE IF EXISTS public\.sandbox_referral_commissions;/);
    assert.match(M022, /sandbox_credit_referral_commission/, 'the retired RPC is dropped');
});

test('isolation: sandbox referral RPCs are env-asserted; production award refuses sandbox', () => {
    assert.match(M022, /assert_sandbox_user/);
    assert.match(SERVER, /isMarketingSandboxUser\(userId\)\) return \{ success: false, reason: 'sandbox' \}/, 'production award refuses sandbox');
});

test('migrations: 023 is additive/idempotent and sets the final config', () => {
    assert.match(M023, /UPDATE public\.referral_config[\s\S]{0,160}config_value = '100'/, 'bumps the qualifying deposit to $100');
    assert.match(M023, /ON CONFLICT \(config_key\) DO NOTHING/, 'idempotent inserts');
    assert.match(M023, /CREATE TABLE IF NOT EXISTS public\.referral_earning_conversions/);
    assert.ok(!/ALTER TABLE public\.(wallets|users|deposits|withdrawals|trades|transactions)\s/.test(M023), 'no financial table altered');
    assert.ok(!/ALTER TABLE public\.sandbox_/.test(M023), 'no sandbox table altered');
});

test('migrations: no migration re-introduces a $50 minimum deposit or a flat reward', () => {
    const dirs = ['supabase/migrations', 'migrations'];
    for (const dir of dirs) {
        const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.sql'));
        for (const f of files) {
            const sql = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
            assert.ok(!/v_min\s*(DECIMAL)?\s*:=\s*50/.test(sql), `${dir}/${f}: stale $50 minimum fallback`);
            // Only SEED statements matter: convergence migrations legitimately
            // DELETE / verify-against the retired keys.
            const seeds = sql.match(/INSERT INTO public\.referral_config[\s\S]*?;/g) || [];
            for (const seed of seeds) {
                assert.ok(!/'minimum_qualifying_deposit',\s*'50'/.test(seed), `${dir}/${f}: stale $50 qualifying-deposit seed`);
                assert.ok(!/'referral_reward_amount'/.test(seed), `${dir}/${f}: stale flat-reward seed`);
                assert.ok(!/'referral_profit_commission_rate'/.test(seed), `${dir}/${f}: stale commission seed`);
            }
        }
    }
});

test('migrations: the legacy bootstrap seeds the final percent model', () => {
    const bootstrap = fs.readFileSync(path.join(ROOT, 'migrations', '003_referral_config.sql'), 'utf8');
    assert.match(bootstrap, /\('minimum_qualifying_deposit', '100'/);
    assert.match(bootstrap, /\('referral_reward_percent', '20'/);
    assert.ok(!/referral_reward_amount/.test(bootstrap), 'no flat reward seed');
});

test('i18n: parity preserved and referral copy states the 20% model', () => {
    const T = translations();
    const locales = Object.keys(T);
    assert.deepStrictEqual(locales.sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
    const enKeys = new Set(Object.keys(T.en));
    for (const l of locales) {
        assert.deepStrictEqual(new Set(Object.keys(T[l])), enKeys, `${l}: key set drifted`);
        for (const k of ['referral.ofFirstDeposit', 'admin.referral.cfg.rewardPercent', 'admin.referral.cfg.rewardPercentDesc']) {
            assert.ok(String(T[l][k] || '').length > 0, `${l}.${k} missing`);
        }
        assert.ok(!('referral.commissionEarned' in T[l]), `${l}: retired commission label still present`);
        assert.ok(/20/.test(String(T[l]['referral.shareEarn'])), `${l}: referral copy must state 20%`);
    }
});
