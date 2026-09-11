'use strict';

/**
 * MARKETING_SANDBOX referral program — FINAL model parity with production.
 *
 * FINAL model: reward = 20% of the referred user's INITIAL qualifying deposit
 * (platform minimum $100). Exactly once. No flat reward, no downline
 * commission. Sandbox rules mirror production 1:1; the money is simulated and
 * only ever touches sandbox_* tables.
 *
 * These tests pin:
 *   - the sandbox config reads the SAME referral_config keys production uses
 *   - the sandbox award RPC's guards (min deposit, percent reward, exactly
 *     once, row lock, env-asserted on both sides)
 *   - the retired commission surface is absent (table + RPC)
 *   - server.js sandbox handlers stay inside the sandbox_* namespace
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const M022 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '022_sandbox_referral_program.sql'), 'utf8');

function sqlFn(name) {
    const idx = M022.indexOf('FUNCTION public.' + name + '(');
    assert.ok(idx >= 0, 'function not found: ' + name);
    const end = M022.indexOf('\n$$;', idx);
    assert.ok(end > idx, 'terminator not found: ' + name);
    return M022.slice(idx, end + 4);
}

function serverFn(name) {
    const idx = SERVER.indexOf(`function ${name}(`);
    assert.ok(idx >= 0, 'server function not found: ' + name);
    const next = SERVER.indexOf('\nfunction ', idx + 1);
    const next2 = SERVER.indexOf('\nasync function ', idx + 1);
    let end = next < 0 ? next2 : next;
    if (next2 > 0 && (end < 0 || next2 < end)) end = next2;
    return SERVER.slice(idx, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------------------
// 1. Sandbox tables + config (single source of truth with production)
// ---------------------------------------------------------------------------
test('sandbox referral table is env-safe, simulated, and unique per real referred user', () => {
    assert.match(M022, /CREATE TABLE IF NOT EXISTS public\.sandbox_referrals/);
    assert.match(M022, /is_simulated BOOLEAN NOT NULL DEFAULT true CHECK \(is_simulated\)/);
    assert.match(M022, /CONSTRAINT sandbox_referrals_no_self CHECK \(referred_id <> referrer_id\)/);
    assert.match(M022, /CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_referrals_referred_unique[\s\S]*?WHERE referred_id > 0/, 'anti-abuse: one attribution per real referred user');
});

test('sandbox config reads the SAME production config keys (no invented numbers)', () => {
    const cfg = sqlFn('sandbox_referral_config');
    assert.match(cfg, /config_key = 'minimum_qualifying_deposit'/);
    assert.match(cfg, /config_key = 'referral_reward_percent'/);
    assert.ok(!/referral_reward_amount|referral_profit_commission_rate/.test(cfg), 'no retired keys');
    assert.match(cfg, /v_min DECIMAL := 100/);
    assert.match(cfg, /v_percent DECIMAL := 20/);
    assert.match(cfg, /'minimum_deposit', COALESCE\(v_min, 100\)/);
    assert.match(cfg, /'reward_percent', COALESCE\(v_percent, 20\)/);
    assert.match(cfg, /IF v_percent > 100 THEN v_percent := 100; END IF;/);
});

// ---------------------------------------------------------------------------
// 2. Sandbox award RPC (percent model, exactly once, env-asserted)
// ---------------------------------------------------------------------------
test('sandbox award enforces the platform minimum qualifying deposit', () => {
    const fn = sqlFn('sandbox_award_referral_qualification');
    assert.match(fn, /p_deposit_amount < v_min/);
    assert.match(fn, /'below_minimum_deposit'/);
    assert.match(fn, /'minimum_required', v_min/);
});

test('sandbox award is 20% of the deposit, never a flat amount', () => {
    const fn = sqlFn('sandbox_award_referral_qualification');
    assert.match(fn, /v_reward := ROUND\(p_deposit_amount \* v_percent \/ 100\.0, 2\)/);
    assert.match(fn, /'bonus_amount', v_reward/);
    assert.ok(!/v_reward\s*:=\s*20\b/.test(fn), 'the reward is not a flat 20');
});

test('sandbox award is exactly-once (row lock + guarded update + row_count)', () => {
    const fn = sqlFn('sandbox_award_referral_qualification');
    assert.match(fn, /WHERE referred_id = p_referred_id AND status = 'pending' AND bonus_earned = 0[\s\S]*?FOR UPDATE/);
    assert.match(fn, /SET status = 'active',\s+bonus_earned = v_reward,[\s\S]*?WHERE id = v_ref\.id AND status = 'pending' AND bonus_earned = 0/);
    assert.match(fn, /GET DIAGNOSTICS v_rows = ROW_COUNT/);
    assert.match(fn, /IF v_rows = 0 THEN[\s\S]*?'already_activated'/);
});

test('sandbox award asserts the sandbox environment on both sides and only credits sandbox balances', () => {
    const fn = sqlFn('sandbox_award_referral_qualification');
    assert.match(fn, /PERFORM public\.assert_sandbox_user\(v_ref\.referrer_id\)/);
    assert.match(fn, /IF p_referred_id > 0 THEN\s+PERFORM public\.assert_sandbox_user\(p_referred_id\)/);
    assert.match(fn, /UPDATE public\.sandbox_wallets/);
    assert.match(fn, /INSERT INTO public\.sandbox_transactions/);
    // Never touches production tables/RPCs.
    assert.ok(!/public\.(wallets|referrals|transactions|referral_commissions)\b/.test(fn), 'no production table writes');
    assert.ok(!/credit_payment_safe|record_trade_safe|award_referral_qualification_safe/.test(fn), 'no production RPC calls');
});

test('sandbox reset clears the new referral rows too', () => {
    const reset = sqlFn('sandbox_reset_account');
    assert.match(reset, /DELETE FROM public\.sandbox_referrals/);
    assert.match(reset, /referrer_id = p_user_id OR referred_id = p_user_id/);
});

// ---------------------------------------------------------------------------
// 3. Retired commission surface is absent from the sandbox
// ---------------------------------------------------------------------------
test('the retired sandbox commission ledger/RPC are dropped and refused', () => {
    assert.match(M022, /DROP TABLE IF EXISTS public\.sandbox_referral_commissions;/);
    assert.match(M022, /p\.proname = 'sandbox_credit_referral_commission'/, 'the retired RPC is dropped by signature');
    assert.match(M022, /RAISE EXCEPTION 'Migration 022 self-check failed: obsolete sandbox_referral_commissions still present'/);
    assert.match(M022, /RAISE EXCEPTION 'Migration 022 self-check failed: obsolete sandbox_credit_referral_commission still present'/);
    assert.ok(!/CREATE TABLE IF NOT EXISTS public\.sandbox_referral_commissions/.test(M022), 'the commission ledger is never created');
});

test('sandbox RPCs are service-role only', () => {
    assert.match(M022, /REVOKE ALL ON FUNCTION public\.sandbox_referral_config\(\) FROM PUBLIC/);
    assert.match(M022, /REVOKE ALL ON FUNCTION public\.sandbox_award_referral_qualification\(BIGINT, DECIMAL\) FROM PUBLIC/);
    assert.match(M022, /GRANT EXECUTE ON FUNCTION public\.sandbox_award_referral_qualification\(BIGINT, DECIMAL\) TO service_role/);
});

// ---------------------------------------------------------------------------
// 4. server.js sandbox wiring
// ---------------------------------------------------------------------------
test('server mirrors the percent model for the sandbox', () => {
    assert.match(SERVER, /const SANDBOX_REFERRAL_REWARD_PERCENT_DEFAULT = 20;/);
    assert.match(SERVER, /const SANDBOX_REFERRAL_MIN_DEPOSIT = PLATFORM_MIN_DEPOSIT_USD;/);
    assert.ok(!/SANDBOX_REFERRAL_REWARD_DEFAULT_USD|SANDBOX_REFERRAL_COMMISSION_RATE/.test(SERVER), 'no retired sandbox reward/commission constants');
    assert.ok(!/creditSandboxDownlineCommission|simulateSandboxDownlineProfit/.test(SERVER), 'no sandbox commission code');
});

test('sandbox referral stats/detailed report the percent model', () => {
    const summary = serverFn('getSandboxReferralSummary');
    assert.match(summary, /rewardPercent/);
    assert.ok(!/commissionEarned|commissionRate/.test(summary), 'no commission fields');
    assert.match(SERVER, /rewardPercent: Number\(parseConfigValue\(rewardPercent\)\) \|\| SANDBOX_REFERRAL_REWARD_PERCENT_DEFAULT/);
});

test('sandbox referral handlers are isolated to sandbox tables', () => {
    const stats = serverFn('handleSandboxReferralStats') + serverFn('handleSandboxReferralDetailed');
    assert.match(stats, /getSandboxReferralSummary/);
    assert.match(serverFn('getSandboxReferralRows'), /sandbox_referrals/);
    assert.ok(!/from\('referrals'\)|from\('wallets'\)|from\('transactions'\)|credit_payment_safe|record_trade_safe|award_referral_qualification_safe/.test(stats),
        'sandbox handlers never touch production financial tables/RPCs');
    // The only production table read is the display of the sandbox user identity.
    const nonUserProduction = stats.replace(/\.from\('users'\)/g, '');
    assert.ok(!/\.from\('[a-z_]+'\)/.test(nonUserProduction), 'no production financial table reads');
    assert.match(SERVER, /if \(await sandboxHandled\(req, res, handleSandboxReferralStats\)\) return;/, 'sandbox branch routed first');
});
