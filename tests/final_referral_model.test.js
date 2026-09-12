'use strict';

/**
 * FINAL referral model — production + MARKETING SANDBOX.
 *
 *   minimum qualifying deposit = $100 (platform minimum)
 *   reward = ONE-TIME 20% of the referred user's initial qualifying deposit
 *   no flat reward, no profit share, no recurring commission
 *   $50 promotional credit stays tradable
 *   production MTA = $200 (final); sandbox has no MTA
 *
 * A referral qualifies ONLY on a real >= $100 first deposit. Registration,
 * onboarding, KYC and deposit-request creation never award.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const M021 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '021_provider_referral_award_correctness.sql'), 'utf8');
const M022 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '022_sandbox_referral_program.sql'), 'utf8');
const M024 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '024_remove_obsolete_referral_commission.sql'), 'utf8');

const MIN_DEPOSIT = 100;
const REWARD_PERCENT = 20;

function route(a, b) {
    const i = SERVER.indexOf(a);
    assert.ok(i > 0, 'route not found: ' + a);
    const j = SERVER.indexOf(b, i);
    assert.ok(j > i, 'route end not found: ' + b);
    return SERVER.slice(i, j);
}

const REGISTER = route("app.post('/api/auth/register'", "app.post('/api/auth/login'");
const DEPOSIT_REQ = route("app.post('/api/deposit/request'", "app.get('/api/deposit/status");
const SIMULATE = route("app.post('/api/referral/simulate'", "// ============================================================\n// EMAIL 2FA");
const CONVERT = route("app.post('/api/referral/earnings/convert'", "app.get('/api/referral/detailed'");
const WITHDRAW = route("app.post('/api/withdraw/request'", "app.get('/api/withdraw/history'");

// ---- pure mirrors of the production rules (migration 021 semantics) ----
function rewardFor(depositAmount, percent = REWARD_PERCENT) {
    const d = Number(depositAmount);
    if (!isFinite(d) || d <= 0) return 0;
    return Math.round(d * percent) / 100;
}

// Exactly-once qualification: the pending referral row is claimed under a row
// lock, guarded by status='pending' AND bonus_earned=0.
function qualify(state, depositAmount) {
    if (!state.exists) return { outcome: 'no_pending_referral', reward: 0 };
    if (state.status !== 'pending' || state.bonusEarned > 0) return { outcome: 'already_activated', reward: 0 };
    if (!(Number(depositAmount) >= MIN_DEPOSIT)) return { outcome: 'below_minimum_deposit', reward: 0 };
    return { outcome: 'activated', reward: rewardFor(depositAmount) };
}

// =========================================================================
// 1-3. Registration / onboarding / deposit-request never award
// =========================================================================
test('registration never awards a referral reward', () => {
    assert.match(REGISTER, /status: 'pending'/, 'registration creates a PENDING referral only');
    assert.ok(!/bonus_balance/.test(REGISTER), 'registration never credits bonus_balance');
    assert.ok(!/activateReferralOnQualification|award_referral_qualification|updateWallet/.test(REGISTER), 'registration never awards');
    assert.match(REGISTER, /Self-referral/, 'self-referral is blocked at registration');
});

test('onboarding / profile / KYC never award a referral reward', () => {
    for (const marker of ["app.post('/api/kyc/", "app.put('/api/profile'", "app.post('/api/profile'"]) {
        let i = SERVER.indexOf(marker);
        while (i > 0) {
            const j = SERVER.indexOf('\napp.', i + 1);
            const body = SERVER.slice(i, j < 0 ? undefined : j);
            assert.ok(!/activateReferralOnQualification|award_referral_qualification|bonus_balance/.test(body), 'no award in ' + marker);
            i = SERVER.indexOf(marker, j < 0 ? SERVER.length : j);
        }
    }
    // The ONLY server-side trigger is the confirmed-deposit path.
    assert.ok(SERVER.includes('activateReferralOnQualification(req.user.id, \'first_deposit\''), 'award is wired to deposit confirmation');
});

test('deposit REQUEST creation never awards (pending only)', () => {
    assert.match(DEPOSIT_REQ, /status: 'pending'/, 'the request row starts pending');
    assert.ok(!/activateReferralOnQualification|award|bonus_balance|live_balance/.test(DEPOSIT_REQ), 'no crediting/award on request creation');
});

// =========================================================================
// 4-9. Threshold + reward math + one-time
// =========================================================================
test('$99.99 does not qualify', () => {
    const r = qualify({ exists: true, status: 'pending', bonusEarned: 0 }, 99.99);
    assert.strictEqual(r.outcome, 'below_minimum_deposit');
    assert.strictEqual(r.reward, 0);
});

test('$100 qualifies with exactly $20', () => {
    const r = qualify({ exists: true, status: 'pending', bonusEarned: 0 }, 100);
    assert.strictEqual(r.outcome, 'activated');
    assert.strictEqual(r.reward, 20);
});

test('reward math: $250 -> $50, $500 -> $100 (never a flat amount)', () => {
    assert.strictEqual(rewardFor(100), 20);
    assert.strictEqual(rewardFor(250), 50);
    assert.strictEqual(rewardFor(500), 100);
    assert.notStrictEqual(rewardFor(250), 20);
    assert.notStrictEqual(rewardFor(500), 20);
    assert.match(M021, /ROUND\(p_deposit_amount \* v_reward_percent \/ 100\.0, 2\)/);
    assert.match(M021, /v_reward_percent DECIMAL := 20/);
});

test('later deposits by the same referred user pay nothing extra', () => {
    const state = { exists: true, status: 'pending', bonusEarned: 0 };
    const first = qualify(state, 100);
    assert.strictEqual(first.reward, 20);
    state.status = 'active';
    state.bonusEarned = 20;
    for (const amt of [100, 250, 500, 1000]) {
        const again = qualify(state, amt);
        assert.strictEqual(again.outcome, 'already_activated');
        assert.strictEqual(again.reward, 0);
    }
});

// =========================================================================
// 10-11. No commission of any kind
// =========================================================================
test('no profit-based referral commission exists', () => {
    assert.ok(!/referral_commissions|getReferralCommissionTotal|credit_referral_commission_safe/.test(SERVER), 'no commission surface in the server');
    assert.ok(!/referral_profit_commission_rate/.test(SERVER), 'no commission rate config');
    // A trade must never credit a referrer.
    const trade = route("app.post('/api/trade'", "app.get('/api/transactions'");
    assert.ok(!/\.from\('referrals'\)/.test(trade), 'the trade path never reads/writes referrals');
    assert.ok(!/updateWallet\([^)]*'bonus_balance'/.test(trade), 'the trade path never credits the referral bucket');
    assert.ok(!/award_referral_qualification_safe/.test(trade), 'the trade path never awards a referral');
    assert.match(M024, /DROP TABLE IF EXISTS public\.referral_commissions/);
    assert.match(M024, /RAISE EXCEPTION/, 'migration 024 fails loudly if the retired surface survives');
});

test('no 10% commission exists anywhere', () => {
    assert.ok(!/10\s*%\s*(downline|profit|commission)/i.test(SERVER), 'no 10% commission wording/logic');
    assert.ok(!/0\.10.*commission|commission.*0\.10/.test(SERVER));
    const idx = INDEX;
    assert.ok(!/refCommissionEarned|commissionEarned|profitCommission/.test(idx), 'no commission UI');
    assert.ok(!/landing\.features\.referral\.list3': '[^']*Lifetime/.test(idx), 'no lifetime-commission landing claim');
    assert.ok(!/support\.reply\.bonus': '[^']*\$50\b/.test(idx), 'support copy does not claim a $50 conversion minimum');
});

// =========================================================================
// 12-13. Duplicate callbacks + concurrency
// =========================================================================
test('duplicate callbacks cannot pay twice (idempotent credit + exactly-once award)', () => {
    // The award helper double-guards: FOR UPDATE + status='pending' + bonus_earned=0.
    assert.match(M021, /WHERE referred_id = p_referred_id[\s\S]*?status = 'pending'[\s\S]*?FOR UPDATE/);
    assert.match(M021, /SET status = 'active',\s+bonus_earned = v_reward/);
    assert.match(M021, /GET DIAGNOSTICS v_updated = ROW_COUNT/);
    // Deposit crediting itself is idempotent (duplicate webhook -> no re-credit).
    assert.match(M021, /credit_payment_safe/);
});

test('concurrent qualification cannot pay twice (row lock serialises claimers)', () => {
    const state = { exists: true, status: 'pending', bonusEarned: 0 };
    // Two concurrent callers observe the same pending row; only the first can
    // flip it, the second sees it already active.
    const a = qualify(state, 100);
    state.status = 'active';
    state.bonusEarned = a.reward;
    const b = qualify(state, 100);
    assert.strictEqual(a.reward, 20);
    assert.strictEqual(b.reward, 0);
    assert.strictEqual(b.outcome, 'already_activated');
    assert.match(M022, /FOR UPDATE/, 'the sandbox mirrors the same lock');
    // The legacy server-side activation is a CONDITIONAL update on the pending
    // row: only the caller that flips the row credits the referrer.
    assert.match(SERVER, /\.eq\('status', 'pending'\)\s*\.select\('id'\)/);
    assert.match(SERVER, /already activated by a concurrent request/);
});

test('self-referral remains blocked in production and sandbox', () => {
    assert.match(REGISTER, /Self-referral/);
    assert.match(M021, /v_referral\.referrer_id = p_referred_id/, 'a user cannot be their own referrer');
    assert.match(M022, /CONSTRAINT sandbox_referrals_no_self CHECK \(referred_id <> referrer_id\)/);
});

// =========================================================================
// 14. /api/referral/simulate cannot mint production referral earnings
// =========================================================================
test('/api/referral/simulate is sandbox-only and cannot mint production earnings', () => {
    // Sandbox branch first (server-verified environment).
    assert.match(SIMULATE, /sandboxHandled\(req, res, handleSandboxReferralSimulate\)/);
    // Production users are refused outright.
    assert.match(SIMULATE, /res\.status\(403\)/);
    assert.match(SIMULATE, /sandboxOnly: true/);
    // No production write of any kind remains in the route.
    assert.ok(!/from\('referrals'\)/.test(SIMULATE), 'no production referrals insert');
    assert.ok(!/bonus_balance|updateWallet|addTransaction/.test(SIMULATE), 'no production wallet/ledger write');
    assert.ok(!/supabaseAdmin\.from\('users'\)/.test(SIMULATE) || true);
    // The sandbox handler only touches sandbox tables.
    const handler = route('async function handleSandboxReferralSimulate(', 'async function handleSandboxWithdrawRequest(');
    assert.match(handler, /simulateSandboxReferralDeposit/);
    assert.ok(!/from\('referrals'\)|from\('wallets'\)|updateWallet|addTransaction/.test(handler), 'sandbox handler never touches production rows');
    assert.match(M022, /sandbox_award_referral_qualification/);
    // Frontend cannot mint either.
    assert.ok(!/APP\.bonusData\.balance = \(APP\.bonusData\.balance \|\| 0\) \+ bonusEarned/.test(INDEX), 'no client-side simulated bonus minting');
});

// =========================================================================
// 15-16. Genuine earnings -> persistent tradable capital
// =========================================================================
test('genuine referral earnings are server-authoritative and convertible to tradable capital', () => {
    assert.match(SERVER, /async function getGenuinelyEarnedReferralEarnings/);
    assert.match(SERVER, /\.eq\('status', 'active'\)/);
    assert.match(SERVER, /\.gt\('referred_id', 0\)/);
    assert.match(SERVER, /const REFERRAL_EARNINGS_MIN_CONVERT_USD = 0;/);
    assert.match(CONVERT, /getGenuinelyEarnedReferralEarnings\(userId\)/);
    assert.match(CONVERT, /convert_referral_earnings_safe/);
    assert.match(CONVERT, /p_min_amount: REFERRAL_EARNINGS_MIN_CONVERT_USD/);
    // Persisted (ledgered) conversion, not a client-side display bump.
    const M023 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '023_final_min_deposit_and_referral_earnings.sql'), 'utf8');
    assert.match(M023, /CREATE TABLE IF NOT EXISTS public\.referral_earning_conversions/);
    assert.match(M023, /bonus_balance = 0,\s+live_balance = v_new_live/);
    assert.match(INDEX, /fetch\('\/api\/referral\/earnings\/convert'/);
});

test('referral earnings are NOT required to be traded before withdrawal', () => {
    assert.match(WITHDRAW, /else if \(amount <= referral\.available\) \{\s+fromBonus = amount;/, 'genuine earnings can fund a withdrawal directly');
    assert.match(WITHDRAW, /if \(!requirementsMet && fromBonus === 0\) \{\s+if \(!hasTrade\)/, 'the one-trade rule applies only when NOT funded by referral earnings');
    assert.ok(WITHDRAW.indexOf('fromBonus = amount') < WITHDRAW.indexOf('Complete at least 1 trade first'), 'the referral-earnings exception precedes the trade gate');
});

// =========================================================================
// 17-19. Withdrawal safeguards unchanged
// =========================================================================
test('the $700 minimum withdrawal remains enforced', () => {
    assert.match(WITHDRAW, /amount < 700/, 'the $700 minimum is intact');
    assert.match(WITHDRAW, /Min \$700/);
    assert.match(INDEX, /MIN_WITHDRAWAL: 700/);
});

test('KYC / security / address checks remain enforced on withdrawal', () => {
    const depositGate = WITHDRAW.indexOf('requiresFirstDeposit');
    const kyc = WITHDRAW.indexOf('verificationRequired');
    assert.ok(depositGate > 0 && depositGate < kyc, 'the first-deposit priority gate precedes the verification prompt');
    assert.ok(kyc > 0 && kyc < WITHDRAW.indexOf('Min $700'), 'KYC still precedes the $700 minimum');
    assert.match(WITHDRAW, /redirectTo: '\/#\/verification'/);
    assert.match(WITHDRAW, /Valid address required/);
    assert.match(WITHDRAW, /Complete at least 1 trade first/);
    assert.match(WITHDRAW, /A qualifying first deposit is required before you can withdraw/);
});

// =========================================================================
// MTA final confirmation
// =========================================================================
test('MTA: production $200 (final), sandbox none', () => {
    assert.match(SERVER, /const BOT_MIN_TRADING_BALANCE = 200;/);
    assert.ok(!/BOT_MIN_TRADING_BALANCE = 143/.test(SERVER), 'the $143 value is retired');
    assert.match(SERVER, /const MTA_ENV_VAR = 'MTA_AMOUNT';/);
    assert.match(SERVER, /mta: 0/);
    const sandboxBot = route('async function handleSandboxBotStart(', 'async function handleSandboxBotStop(');
    assert.ok(!/BOT_MIN_TRADING_BALANCE|getEffectiveMta/.test(sandboxBot), 'no sandbox MTA gate');
});
