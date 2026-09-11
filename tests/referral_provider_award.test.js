'use strict';

/**
 * Migration 021 contract tests — production referral award correctness in the
 * provider credit functions (companion to migration 020).
 *
 * WHY: migrations 002/006/007/008 hard-coded a $10 referral bonus inside the
 * provider credit functions, qualified on ANY first deposit, and never marked
 * the referral `active`. A referral_config row cannot change a literal
 * hard-coded inside a function, so migration 021 delegates that block to a
 * single config-driven, minimum-deposit, exactly-once SQL helper.
 *
 * FINAL model: one-time reward = 20% of the referred user's INITIAL qualifying
 * deposit (the platform minimum). No flat amount, no downline commission.
 *
 * These tests pin:
 *   - the helper's guards (min deposit, config-driven PERCENT reward,
 *     exactly-once, lock, sandbox refusal, no writes to the referred user's money)
 *   - that ONLY the referral block differs from the source migrations
 *     (byte-identical everywhere else — the safety property)
 *   - that the migrations are additive/idempotent and are NOT applied by code
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');

const M020 = read('020_referral_reward_model.sql');
const M021 = read('021_provider_referral_award_correctness.sql');

const OLD_BLOCK_RE = new RegExp(
    '(?:[ \\t]*-- (?:First-deposit referral bonus \\(best-effort: never breaks the credit\\)|' +
    'Process referral bonus for first deposit)\\n)?' +
    '[ \\t]*IF v_is_first_deposit THEN\\n' +
    '(?:.*\\n)*?' +
    '[ \\t]*RAISE WARNING \'Referral processing failed: %\', SQLERRM;\\n' +
    '[ \\t]*END;\\n' +
    '[ \\t]*END IF;'
);

const NEW_BLOCK_RE = new RegExp(
    '[ \\t]*-- Referral qualification \\(final management model\\)(?:.*\\n)*?' +
    '[ \\t]*RAISE WARNING \'Referral qualification failed: %\', SQLERRM;\\n' +
    '[ \\t]*v_referral_reward := 0;\\n' +
    '[ \\t]*END;'
);

function extractFunction(text, signature, occurrence = 0) {
    let start = -1;
    for (let i = 0; i <= occurrence; i++) start = text.indexOf(signature, start + 1);
    assert.ok(start >= 0, 'function not found: ' + signature);
    const end = text.indexOf('\n$$;', start);
    assert.ok(end > start, 'function terminator not found: ' + signature);
    return text.slice(start, end + 4);
}

const PROVIDERS = [
    ['002_payment_system.sql', 'CREATE OR REPLACE FUNCTION public.confirm_payment_with_credit(', 0],
    ['008_q8qpay_support.sql', 'CREATE OR REPLACE FUNCTION public.credit_payment_safe(', 0],
    ['006_paymento_support.sql', 'CREATE OR REPLACE FUNCTION public.paymento_credit_user_safe(', 0],
    ['007_paymento_settlement_audit.sql', 'CREATE OR REPLACE FUNCTION public.paymento_credit_user_safe(', 1],
];

function topLevelSql(sql) {
    return sql.replace(/\$\$[\s\S]*?\$\$/g, '$$body$$').replace(/^--.*$/gm, '');
}

// ---------------------------------------------------------------------------
// The safety property: only the referral block changed
// ---------------------------------------------------------------------------
test('migration 021 changes ONLY the referral block of every provider credit function', () => {
    for (const [file, signature, occurrence] of PROVIDERS) {
        const before = extractFunction(read(file), signature, 0);
        const after = extractFunction(M021, signature, occurrence);

        assert.ok(OLD_BLOCK_RE.test(before), `${file}: legacy referral block not found`);
        assert.ok(NEW_BLOCK_RE.test(after), `${file}: delegating referral block not found`);

        const normalise = (s) => s.replace(' \n', '\n');
        const a = normalise(before.replace(OLD_BLOCK_RE, '<<REFERRAL>>'));
        const b = normalise(after.replace(NEW_BLOCK_RE, '<<REFERRAL>>'));
        assert.strictEqual(b, a, `${file}: migration 021 changed something outside the referral block`);
    }
});

test('no provider credit function hard-codes the retired $10 reward any more', () => {
    const offenders = (M021.replace(/^--.*$/gm, '').match(/.*v_referral_reward := 10;.*/g) || [])
        .filter((line) => !/pg_get_functiondef|RAISE EXCEPTION/.test(line));
    assert.deepStrictEqual(offenders, [], 'stale $10 literal in migration 021: ' + offenders.join(' | '));
    for (const [file] of PROVIDERS) {
        assert.ok(read(file).includes('v_referral_reward := 10;'), `${file}: expected the legacy literal in the source`);
    }
});

test('every provider credit function delegates exactly once to the shared helper', () => {
    for (const [file, signature, occurrence] of PROVIDERS) {
        const body = extractFunction(M021, signature, occurrence);
        const calls = body.match(/award_referral_qualification_safe\(p_user_id, p_amount_usd\)/g) || [];
        assert.strictEqual(calls.length, 1, `${file}: expected exactly one delegation`);
        assert.ok(!/IF v_is_first_deposit THEN\s*\n\s*BEGIN\s*\n\s*SELECT referrer_id/.test(body),
            `${file}: legacy first-deposit-guarded award still present`);
    }
});

// ---------------------------------------------------------------------------
// The helper's guarantees (FINAL percent model)
// ---------------------------------------------------------------------------
test('helper gates on the EXISTING platform minimum qualifying deposit', () => {
    assert.match(M021, /p_deposit_amount < v_min\s+THEN\s+RETURN jsonb_build_object\('awarded', FALSE, 'reward', 0, 'reason', 'below_minimum_deposit'\)/,
        'below-minimum deposits must not qualify');
    assert.match(M021, /config_key = 'minimum_qualifying_deposit'/,
        'must read the existing minimum-deposit config (no new definition)');
    assert.match(M021, /v_min DECIMAL := 100/, 'default mirrors the platform minimum deposit ($100)');
});

test('helper reward is a config-driven PERCENT with a 20 default (single source of truth)', () => {
    assert.match(M021, /config_key = 'referral_reward_percent'/);
    assert.match(M021, /v_reward_percent DECIMAL := 20/);
    assert.match(M021, /v_reward := ROUND\(p_deposit_amount \* v_reward_percent \/ 100\.0, 2\)/,
        'reward is computed as a percentage of the qualifying deposit');
    assert.ok(!/config_key = 'referral_reward_amount'/.test(M021), 'must not read the retired flat reward key');
    assert.match(M021, /rewards_enabled/);
    assert.match(M021, /max_rewards_per_user/);
});

test('helper is exactly-once (pending row anchor + row lock + guarded update)', () => {
    assert.match(M021, /WHERE referred_id = p_referred_id[\s\S]*?status = 'pending'[\s\S]*?COALESCE\(bonus_earned, 0\) = 0[\s\S]*?FOR UPDATE/,
        'must lock the still-pending referral row');
    assert.match(M021, /GET DIAGNOSTICS v_updated = ROW_COUNT/,
        'must verify the guarded activation actually won');
    assert.match(M021, /IF v_updated = 0 THEN\s+RETURN jsonb_build_object\([\s\S]*?'already_qualified'\)/,
        'a losing racer must award nothing');
    assert.match(M021, /SET status = 'active',\s+bonus_earned = v_reward,\s+qualified_at = NOW\(\),\s+qualification_type = 'first_deposit'/,
        'must activate the referral the same way the server path does');
});

test('helper refuses MARKETING_SANDBOX accounts on both sides', () => {
    const sandboxChecks = M021.match(/environment = 'MARKETING_SANDBOX'/g) || [];
    assert.ok(sandboxChecks.length >= 2, 'must check both the referred user and the referrer');
    assert.match(M021, /EXCEPTION WHEN OTHERS THEN\s+v_is_sandbox := FALSE;/,
        'missing users.environment must fail closed to production, not error out');
});

test("helper never touches the referred user's balance and only credits the referrer bucket", () => {
    const body = extractFunction(M021, 'CREATE OR REPLACE FUNCTION public.award_referral_qualification_safe(');
    assert.ok(!/live_balance\s*=\s*COALESCE\(live_balance/.test(body), 'must not credit live_balance');
    assert.ok(!/demo_balance\s*=\s*COALESCE\(demo_balance/.test(body), 'must not credit demo_balance');
    assert.match(body, /SET bonus_balance = COALESCE\(bonus_balance, 0\) \+ v_reward/,
        'credits the existing referral-earnings bucket only');
    assert.match(body, /WHERE user_id = v_referral\.referrer_id/);
});

test('helper does not bypass self-referral protection', () => {
    assert.match(M021, /v_referral\.referrer_id = p_referred_id THEN\s+RETURN jsonb_build_object\([\s\S]*?'invalid_referrer'\)/);
});

test('helper returns the JSONB contract the server/provider functions rely on', () => {
    assert.match(M021, /RETURNS JSONB/);
    assert.match(M021, /'awarded', TRUE,[\s\S]*?'reward', v_reward,[\s\S]*?'reward_percent', v_reward_percent/);
    assert.match(M021, /'reason', 'sandbox_account'/);
    assert.match(M021, /'reason', 'rewards_disabled'/);
});

// ---------------------------------------------------------------------------
// Additive / idempotent / not applied
// ---------------------------------------------------------------------------
test('migration 021 is additive: no schema or data changes at top level', () => {
    const code = topLevelSql(M021);
    assert.ok(!/CREATE TABLE/i.test(code), 'must not create tables');
    assert.ok(!/ALTER TABLE/i.test(code), 'must not alter tables');
    assert.ok(!/DROP TABLE/i.test(code), 'must not drop tables');
    assert.ok(!/INSERT INTO/i.test(code), 'must not migrate data');
    assert.ok(!/UPDATE public\./i.test(code), 'must not mutate existing rows');
});

test('migration 021 is idempotent and locks the new helper down to service_role', () => {
    const code = M021.replace(/^--.*$/gm, '');
    const creates = code.match(/CREATE OR REPLACE FUNCTION/g) || [];
    assert.ok(creates.length >= 5, 'must use CREATE OR REPLACE for every function');
    assert.match(M021, /REVOKE EXECUTE ON FUNCTION public\.award_referral_qualification_safe\(BIGINT, DECIMAL\) FROM anon/);
    assert.match(M021, /REVOKE EXECUTE ON FUNCTION public\.award_referral_qualification_safe\(BIGINT, DECIMAL\) FROM authenticated/);
    assert.match(M021, /GRANT EXECUTE ON FUNCTION public\.award_referral_qualification_safe\(BIGINT, DECIMAL\) TO service_role/);
    assert.match(M021, /RAISE EXCEPTION 'a provider credit function still hard-codes a fixed referral reward!'/,
        'must self-verify after applying');
});

test('neither migration is applied (or referenced) by application code', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    for (const name of ['020_referral_reward_model', '021_provider_referral_award_correctness']) {
        assert.ok(!server.includes(name), `server.js must not apply ${name}`);
        assert.ok(!server.includes(name + '.sql'), `server.js must not reference ${name}`);
    }
});

// ---------------------------------------------------------------------------
// Migration 020 — the retired commission architecture is gone
// ---------------------------------------------------------------------------
test('migration 020 drops the obsolete commission RPC/ledger and seeds the percent config', () => {
    assert.match(M020, /referral_reward_percent/, 'the percent config is seeded');
    assert.match(M020, /DROP TABLE IF EXISTS public\.referral_commissions/, 'the commission ledger is dropped');
    assert.ok(!/CREATE TABLE IF NOT EXISTS public\.referral_commissions/.test(M020), 'the commission ledger is never created');
    assert.ok(!/CREATE OR REPLACE FUNCTION public\.credit_referral_commission_safe/.test(M020),
        'the commission RPC is never created');
    assert.match(M020, /RAISE EXCEPTION/, 'the self-check fails loudly on drift');
});

// ---------------------------------------------------------------------------
// End-to-end wiring of the referral feature inside server.js
// ---------------------------------------------------------------------------
test('server wiring: percent reward, minimum deposit and attribution', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(server, /const REFERRAL_REWARD_PERCENT_DEFAULT = 20;/);
    assert.match(server, /const SANDBOX_REFERRAL_REWARD_PERCENT_DEFAULT = 20;/,
        'the sandbox mirrors the production percent model');
    assert.match(server, /config\.minDeposit|minimum_qualifying_deposit/, 'qualification uses the existing minimum deposit');
    assert.match(server, /\.eq\('status', 'pending'\)/, 'attribution anchors on the pending referral row');
    assert.match(server, /Math\.round\(Number\(depositInfo\.amount\) \* effectiveRewardPercent\) \/ 100/,
        'server computes the reward as a percent of the qualifying deposit');
    assert.ok(!/REFERRAL_REWARD_DEFAULT_USD|REFERRAL_PROFIT_COMMISSION_RATE/.test(server),
        'no retired flat reward / commission constants');
    assert.ok(!/credit_referral_commission_safe/.test(server), 'server never calls the retired commission RPC');
});
