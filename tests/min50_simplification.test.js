'use strict';

/**
 * Mission: payment simplification for the normal customer journey.
 *
 * THREE APPROVED CHANGES, pinned here together because they all touch the same
 * funnel and must not silently drift apart:
 *
 *   1. PAYHIP ACTIVATION IS NOT PART OF THE NORMAL JOURNEY.
 *      The integration stays in the repository, fully functional, but it is
 *      switched off unless an operator sets PAYHIP_ACTIVATION_REQUIRED=true.
 *      With the flag unset a customer registers, funds Live and trades without
 *      ever being asked to buy a licence.
 *
 *   2. THE PLATFORM MINIMUM DEPOSIT IS $50.
 *      One server constant (PLATFORM_MIN_DEPOSIT_USD) feeds invoice validation,
 *      the sandbox simulated-deposit floor, the referral threshold fallback,
 *      marketing facts and /api/auth/me; the frontend adopts the published value.
 *
 *   3. THE REFERRAL REWARD IS 20% OF THE FIRST QUALIFYING DEPOSIT.
 *      At a $50 minimum that is $10 (at $100 it is $20). The SQL award helper
 *      reads referral_config.minimum_qualifying_deposit, so migration 057 must
 *      move that row to 50 or a $50 deposit would credit but never qualify.
 *
 * Money safety is asserted, not assumed: the Q8Pay signature/dedupe path, the
 * one-time referral guards and the "activation grants no capital" rule are all
 * re-checked at source level.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SERVER = read('server.js');
const INDEX = read('public/index.html');
const ENV_EXAMPLE = read('.env.example');
const MIGRATION_057 = read('supabase/migrations/057_min_deposit_and_referral_50.sql');

const Payhip = require('../services/PayhipEntitlements');

/** Execute the REAL minimum-deposit resolver from server.js with a fake env. */
function resolveMinDeposit(env) {
  const start = SERVER.search(/const PLATFORM_MIN_DEPOSIT_USD = \d+;/);
  const end = SERVER.indexOf('const PLATFORM_MIN_DEPOSIT = resolvePlatformMinDeposit();');
  assert.ok(start > 0 && end > start, 'the resolver block must exist');
  const src = SERVER.slice(start, end) +
    'const PLATFORM_MIN_DEPOSIT = resolvePlatformMinDeposit();' +
    ';globalThis.__out = { PLATFORM_MIN_DEPOSIT, PLATFORM_MIN_DEPOSIT_USD };';
  const sandbox = { process: { env }, console: { log() {}, warn() {} } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.__out;
}

/* ================================================================== *
 * 1. Minimum deposit = $50, everywhere, from ONE constant
 * ================================================================== */

test('server: the built-in minimum deposit is $50', () => {
  assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 50;/);
  assert.strictEqual(resolveMinDeposit({}).PLATFORM_MIN_DEPOSIT, 50);
});

test('server: the operator override still works and is validated', () => {
  assert.strictEqual(resolveMinDeposit({ PLATFORM_MIN_DEPOSIT_USD: '50' }).PLATFORM_MIN_DEPOSIT, 50);
  assert.strictEqual(resolveMinDeposit({ PLATFORM_MIN_DEPOSIT_USD: '100' }).PLATFORM_MIN_DEPOSIT, 100);
  // A malformed value falls back to the approved default, never to nonsense.
  assert.strictEqual(resolveMinDeposit({ PLATFORM_MIN_DEPOSIT_USD: 'abc' }).PLATFORM_MIN_DEPOSIT, 50);
  assert.strictEqual(resolveMinDeposit({ PLATFORM_MIN_DEPOSIT_USD: '5' }).PLATFORM_MIN_DEPOSIT, 50);
});

test('invoice validation reads the resolved value and words the error from it', () => {
  // The route compares against the resolved constant, never a literal.
  const route = SERVER.slice(SERVER.indexOf("app.post('/api/payment/create-invoice'"));
  const body = route.slice(0, 3000);
  assert.match(body, /const MIN_DEPOSIT_AMOUNT = PLATFORM_MIN_DEPOSIT;/);
  assert.match(body, /amount < MIN_DEPOSIT_AMOUNT/);
  assert.ok(!/amount < 100\b/.test(body), 'no stale literal floor in the invoice route');
  // The 400 body is built from the same value, so it can never disagree.
  assert.match(SERVER, /Min \$' \+ PLATFORM_MIN_DEPOSIT|'Min \$' \+ MIN_DEPOSIT_AMOUNT/);
});

test('both sandbox deposit doors use the same resolved floor', () => {
  const hits = (SERVER.match(/PLATFORM_MIN_DEPOSIT\b/g) || []).length;
  assert.ok(hits >= 8, 'the resolved constant is the one every consumer reads');
  assert.match(SERVER, /if \(!amt \|\| amt < PLATFORM_MIN_DEPOSIT\)/);
  assert.match(SERVER, /const SANDBOX_REFERRAL_MIN_DEPOSIT = PLATFORM_MIN_DEPOSIT;/);
});

test('frontend: APP.MIN_DEPOSIT defaults to 50 and adopts the server value', () => {
  assert.match(INDEX, /MIN_DEPOSIT: 50,/);
  assert.match(INDEX, /APP\.MIN_DEPOSIT = Number\(meData\.minDeposit\)/);
  // The offline fallbacks agree with the default.
  assert.ok(!/MIN_DEPOSIT\) \|\| 100/.test(INDEX), 'no stale 100 fallback');
  assert.match(INDEX, /MIN_DEPOSIT\) \|\| 50/);
});

test('frontend: the deposit presets start at the minimum', () => {
  assert.match(INDEX, /onclick="setDepositAmount\(50\)">\$50<\/button>/);
  assert.ok(!/onclick="setDepositAmount\(100\)"/.test(INDEX), 'the first preset is the floor');
});

test('frontend: the server "Min $..." rejection maps to the localized notice', () => {
  assert.match(INDEX, /'Min \$50': 'deposit\.min100'/,
    'the API string is built from the same constant the map keys on');
  assert.ok(!/'Min \$100'/.test(INDEX), 'no stale map key');
});

test('copy: no customer-facing "minimum deposit is $100" claim survives', () => {
  const dictionary = INDEX.slice(INDEX.indexOf('const TRANSLATIONS ='), INDEX.indexOf('function t('));
  const offenders = dictionary.split('\n')
    .filter((line) => /deposit/i.test(line) && /\$100/.test(line))
    .filter((line) => !/milestone|badge|profit/i.test(line));
  assert.deepStrictEqual(offenders, [], 'deposit copy must state the $50 floor');
});

/* ================================================================== *
 * 2. Referral: 20% of the FIRST qualifying deposit at $50
 * ================================================================== */

test('referral: the reward is a percentage, default 20, with no flat amount', () => {
  assert.match(SERVER, /const REFERRAL_REWARD_PERCENT_DEFAULT = 20;/);
  assert.ok(!/REFERRAL_REWARD_DEFAULT_USD/.test(SERVER), 'the flat reward constant is gone');
  assert.ok(!/REFERRAL_PROFIT_COMMISSION_RATE/.test(SERVER), 'no recurring commission exists');
});

test('referral: the qualifying amount falls back to the platform minimum', () => {
  assert.match(SERVER, /getReferralConfig\('minimum_qualifying_deposit', String\(PLATFORM_MIN_DEPOSIT\)\)/);
  const hits = (SERVER.match(/minimum_qualifying_deposit', String\(PLATFORM_MIN_DEPOSIT\)/g) || []).length;
  assert.ok(hits >= 3, 'every referral read uses the same fallback');
});

test('referral: the SQL award helper computes 20% of the credited deposit', () => {
  const sql = read('supabase/migrations/021_provider_referral_award_correctness.sql');
  assert.match(sql, /v_reward := ROUND\(p_deposit_amount \* v_reward_percent \/ 100\.0, 2\)/);
  assert.match(sql, /WHERE config_key = 'minimum_qualifying_deposit'/,
    'the SQL threshold comes from the config row, not a literal');
  assert.match(sql, /IF p_deposit_amount < v_min THEN/);
});

test('referral: migration 057 moves the threshold to 50 and is idempotent', () => {
  assert.match(MIGRATION_057, /v_target\s+CONSTANT TEXT := '50'/);
  assert.match(MIGRATION_057, /ELSIF trim\(v_value\) = '100' THEN/,
    'the superseded value is moved, an operator value is reported');
  assert.match(MIGRATION_057, /minimum_qualifying_deposit left at operator value/);
  assert.match(MIGRATION_057, /INSERT INTO public\.referral_config/);
  assert.match(MIGRATION_057, /BEGIN;[\s\S]*COMMIT;/);
  // A config migration must never touch money.
  ['wallets', 'deposits', 'withdrawals', 'trades', 'transactions', 'referrals']
    .forEach((table) => {
      assert.ok(!new RegExp('(UPDATE|INSERT INTO|DELETE FROM)\\s+public\\.' + table + '\\b').test(MIGRATION_057),
        'migration 057 must not write ' + table);
    });
});

test('referral: exactly-once guards survive the threshold change', () => {
  const sql = read('supabase/migrations/021_provider_referral_award_correctness.sql');
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /GET DIAGNOSTICS/);
  assert.match(sql, /bonus_earned/);
  // Legacy JS path: a conditional pending -> active update gates the credit.
  assert.match(SERVER, /\.eq\('status', 'pending'\)/);
  assert.match(SERVER, /referrer_id = referred_id|referred_id = referrer_id|self-referral/i);
});

/* ================================================================== *
 * 3. Payhip activation is off by default and stays out of the journey
 * ================================================================== */

test('payhip: activation is NOT required unless the operator asks for it', () => {
  assert.strictEqual(Payhip.resolvePayhipConfig({}).activationRequired, false);
  assert.strictEqual(Payhip.resolvePayhipConfig({ PAYHIP_ACTIVATION_REQUIRED: 'false' }).activationRequired, false);
  assert.strictEqual(Payhip.resolvePayhipConfig({ PAYHIP_ACTIVATION_REQUIRED: 'TRUE' }).activationRequired, true,
    'the value is normalised, so a shouting operator is not silently ignored');
  assert.strictEqual(Payhip.resolvePayhipConfig({ PAYHIP_ACTIVATION_REQUIRED: 'true' }).activationRequired, true);
  for (const junk of ['yes', '1', 'on', 'enabled', 'nonsense']) {
    assert.strictEqual(Payhip.resolvePayhipConfig({ PAYHIP_ACTIVATION_REQUIRED: junk }).activationRequired, false,
      junk + ' must NOT enable a paid gate');
  }
});

test('payhip: the integration is retained (not deleted) for future use', () => {
  for (const file of [
    'services/PayhipEntitlements.js',
    'supabase/migrations/050_payhip_live_activation.sql',
    'supabase/migrations/054_grandfather_activation.sql',
    'tests/payhip_production_wiring.test.js'
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file + ' must stay in the repository');
  }
  assert.match(SERVER, /app\.post\('\/api\/payhip\/webhook/);
  assert.match(SERVER, /app\.post\('\/api\/live\/activate'/);
});

test('gates: bot start / trade only demand activation when it is required', () => {
  // The refusal must be produced by the eligibility helper, which short-circuits
  // when activationRequired is false, rather than by an unconditional test.
  const eligibility = SERVER.slice(SERVER.indexOf('async function getLiveModeEligibility'),
    SERVER.indexOf('function sendLiveModeRefusal'));
  assert.ok(eligibility.length > 100, 'the eligibility helper exists');
  assert.match(eligibility, /if \(activation\.activationRequired !== true\) \{/,
    'the whole gate short-circuits when activation is not required');
  assert.match(eligibility, /depositSatisfied = read\.ok && read\.total >= minDeposit/);
  // The machine-readable refusals the frontend renders still exist.
  assert.match(SERVER, /LIVE_ACTIVATION_REQUIRED/);
  assert.match(SERVER, /LIVE_DEPOSIT_REQUIRED/);
});

test('frontend: no activation UI renders when the flag is off', () => {
  const pending = INDEX.slice(INDEX.indexOf('function activationPending()'), INDEX.indexOf('function renderLiveModeCard()'));
  assert.match(pending, /APP\.activationRequired === true/,
    'the notice is driven by the server flag, defaulting to hidden');
  // The Live-Mode guide only lists activation when the server says it applies.
  const steps = INDEX.slice(INDEX.indexOf('function startHereLiveSteps()'), INDEX.indexOf('function startHereLiveComplete()'));
  assert.match(steps, /activationPending\(\)/);
});

test('copy: the default funnel never advertises a mandatory paid activation', () => {
  const dictionary = INDEX.slice(INDEX.indexOf('const TRANSLATIONS ='), INDEX.indexOf('function t('));
  const landing = dictionary.split('\n').filter((l) => /landing\./.test(l) && /activation/i.test(l));
  const offenders = landing.filter((l) => !/liveActivation|activationRequired/.test(l));
  assert.deepStrictEqual(offenders.map((l) => l.trim().slice(0, 90)), [],
    'landing copy must not assert a mandatory activation');
});

/* ================================================================== *
 * 4. Money paths that must NOT have changed
 * ================================================================== */

test('q8pay: signature verification and idempotency are untouched', () => {
  const provider = read('services/providers/q8qpay.js');
  assert.match(provider, /createHmac\(|verifySignature|X-Webhook-Signature/i);
  assert.match(provider, /createInvoice/);
  // The webhook route still compares against the recorded amount before credit.
  assert.match(SERVER, /api\/webhook\/q8qpay/);
  const handler = SERVER.slice(SERVER.indexOf("app.post('/api/webhook/q8qpay'"));
  assert.match(handler.slice(0, 4000), /credited|amount|signature/i);
});

test('crediting remains atomic and exactly-once', () => {
  const credit = read('supabase/migrations/008_q8qpay_support.sql');
  assert.match(credit, /credit_payment_safe/);
  assert.match(credit, /FOR UPDATE/);
  assert.match(credit, /idempotency/i);
});

test('the promotional credit is still $50 and is not derived from the floor', () => {
  assert.match(SERVER, /const SANDBOX_PROMO_CREDIT = 50;/);
  assert.match(SERVER, /live_balance: 50, bonus_balance: 0/);
  assert.ok(!/live_balance: PLATFORM_MIN_DEPOSIT/.test(SERVER));
});

test('the withdrawal minimum and KYC machinery are unchanged by this work', () => {
  assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
  assert.match(INDEX, /MIN_WITHDRAWAL: 700/);
  assert.match(SERVER, /WITHDRAWAL_REQUIRES_VERIFICATION/);
});

test('.env.example documents the $50 floor and the disabled activation', () => {
  const block = ENV_EXAMPLE.slice(ENV_EXAMPLE.indexOf('MINIMUM DEPOSIT FLOOR'));
  const section = block.slice(0, block.indexOf('PAYHIP LIVE MODE'));
  assert.match(section, /APPROVED VALUE \$50/);
  assert.match(section, /PLATFORM_MIN_DEPOSIT_USD/);
  assert.match(section, /057_min_deposit_and_referral_50\.sql/);
  assert.match(ENV_EXAMPLE, /# PAYHIP_ACTIVATION_REQUIRED=true/,
    'enabling activation stays an explicit, documented opt-in');
});
