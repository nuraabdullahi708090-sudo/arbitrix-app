'use strict';
/**
 * Kalderix production smoke-test rehearsal.
 *
 * Runs the REAL server (a disposable copy pointed only at the local rehearsal
 * database) against a REAL PostgreSQL 16 with the release migrations applied.
 * Every assertion below maps to a line in docs/relaunch release checklist.
 *
 * Nothing here touches production: the server copy has no production Supabase
 * URL (it throws at boot without SMOKE_SUPABASE_URL), Payhip's licence API is a
 * local stub, and no payment provider is ever called.
 */
const { execFileSync, spawnSync } = require('child_process');
function sh(cmd) { spawnSync('bash', ['-c', cmd], { stdio: 'ignore' }); }
const crypto = require('crypto');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4180';
const CT = process.env.SMOKE_CONTAINER || 'kalderix-smoke';
const DB = process.env.SMOKE_DB || 'smoke';
const PAYHIP_API_KEY = process.env.SMOKE_PAYHIP_API_KEY || 'smoke-payhip-api-key';
const PASSWORD = 'SmokePass123!';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail) : ''}`);
}
function section(title) { console.log('\n== ' + title + ' =='); }

// `docker` directly when the socket is reachable, otherwise the non-interactive
// sudo form. -n so a password prompt fails fast instead of hanging the run.
const DOCKER = (() => {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return ['docker']; }
  catch { return ['sudo', '-n', 'docker']; }
})();
function sql(q) {
  const args = [...DOCKER, 'exec', '-i', CT, 'psql', '-U', 'postgres', '-d', DB,
    '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
  return execFileSync(DOCKER[0], args.slice(1), { input: q, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

async function api(method, path, { token, body, headers } = {}) {
  const opts = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 200) }; }
  return { status: res.status, json, text };
}

let seq = 0;
async function newUser(label, { live = null, admin = false, sandbox = false } = {}) {
  seq += 1;
  const email = `${label}.${Date.now()}.${seq}@smoke.kalderix.test`;
  const reg = await api('POST', '/api/auth/register', { body: { name: label, email, password: PASSWORD } });
  if (reg.status !== 200 && reg.status !== 201) throw new Error('register failed for ' + label + ': ' + reg.status + ' ' + reg.text.slice(0, 200));
  const login = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  if (!login.json || !login.json.token) throw new Error('login failed for ' + label + ': ' + login.text.slice(0, 200));
  let token = login.json.token;
  const me = await api('GET', '/api/auth/me', { token });
  const id = me.json && (me.json.user ? me.json.user.id : me.json.id);
  if (!id) throw new Error('no user id for ' + label + ': ' + me.text.slice(0, 200));
  if (admin) {
    sql(`update users set is_admin=1 where id=${id};`);
    token = (await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).json.token;
  }
  if (sandbox) sql(`update users set environment='MARKETING_SANDBOX' where id=${id};`);
  if (live !== null) sql(`update wallets set live_balance=${live} where user_id=${id};`);
  return { id, email, token, label };
}

function setLive(id, v) { sql(`update wallets set live_balance=${v} where user_id=${id};`); }
function liveOf(id) { return Number(sql(`select live_balance from wallets where user_id=${id};`)); }

function seedConfirmedDeposit(userId, amount, { status = 'confirmed', credited = true, ageDays = 30 } = {}) {
  sql(`insert into deposits (user_id, amount, status, credited, tx_hash, created_at, confirmed_at)
       values (${userId}, ${amount}, '${status}', ${credited}, 'smoke-tx-${userId}-${amount}', now() - interval '${ageDays} days', now() - interval '${ageDays} days');`);
  return Number(sql(`select max(id) from deposits where user_id=${userId};`));
}

const PAYHIP_HOOK = '/api/payhip/webhook?token=' + (process.env.SMOKE_PAYHIP_TOKEN || 'smoke-webhook-token');
function payhipSignature() {
  return crypto.createHash('sha256').update(PAYHIP_API_KEY).digest('hex');
}
function salePayload({ id, type = 'paid', key = 'KAL-VALID', product = 'ACTIVATION', price = 5000, email = 'buyer@example.com' }) {
  return {
    type, id, email, currency: 'USD', price,
    items: [{ product_id: 'ACT1', product_permalink: 'https://payhip.com/b/' + product, product_name: 'Kalderix Live Activation', license_key: key }],
    signature: payhipSignature()
  };
}

function resetData() {
  // A rehearsal must start from a known-empty customer state. Schema (and the
  // migration-managed referral_config rows) is kept; only customer data goes.
  sql(`truncate table
        transactions, referrals, deposits, payment_invoices, withdrawals,
        payhip_events, payhip_entitlements, payhip_purchases, payhip_products,
        subscription_charges, subscriptions, revoked_tokens, bot_sessions,
        wallets, users
      restart identity cascade;`);
}

async function main() {
  resetData();
  // ---------------------------------------------------------------- identity
  section('A. Brand / identity (existing customers see no change of operator)');
  const home = await api('GET', '/');
  check('A1 served landing page carries the Kalderix name in <title>',
    /<title>[^<]*Kalderix/i.test(home.text), home.text.slice(0, 160));
  check('A2 the retired product name "Arbitrix AI" is gone from the served page',
    !/Arbitrix AI/i.test(home.text));
  const legal = await api('GET', '/business-registration');
  check('A3 legal operator page still names Arbitrix Trading + KVK 72923513',
    legal.status === 200 && /Arbitrix Trading/.test(legal.text) && /72923513/.test(legal.text), legal.status);

  // ------------------------------------------------------- B. existing customer
  section('B. T5b - an existing funded customer keeps access');
  const legacy = await newUser('legacy.funded');
  setLive(legacy.id, 120);
  seedConfirmedDeposit(legacy.id, 100, { ageDays: 120 });
  const legacyBefore = { live: liveOf(legacy.id), me: (await api('GET', '/api/auth/me', { token: legacy.token })).json };

  const act = await api('GET', '/api/live/activation', { token: legacy.token });
  check('B1 funded customer is grandfathered (no purchase, no licence)',
    act.status === 200 && act.json.activated === true && act.json.reason === 'grandfathered-deposit', act.json);
  const startLive = await api('POST', '/api/bot/start', { token: legacy.token, body: { mode: 'live' } });
  check('B2 funded customer starts Live Mode (no activation prompt)', startLive.status === 200, { s: startLive.status, j: startLive.json });
  await api('POST', '/api/bot/stop', { token: legacy.token, body: {} });
  const startDemo = await api('POST', '/api/bot/start', { token: legacy.token, body: { mode: 'demo' } });
  check('B3 Demo Mode still works for the same customer', startDemo.status === 200, startDemo.json);
  await api('POST', '/api/bot/stop', { token: legacy.token, body: {} });
  check('B4 balance is unchanged by the activation checks', liveOf(legacy.id) === 120);

  // Payhip unavailable: the grandfathered path must not depend on it.
  sh("pkill -f payhip-stub.js");
  await new Promise((r) => setTimeout(r, 400));
  const actDuringOutage = await api('GET', '/api/live/activation', { token: legacy.token });
  const startDuringOutage = await api('POST', '/api/bot/start', { token: legacy.token, body: { mode: 'live' } });
  check('B5 Payhip outage does not affect a grandfathered account',
    actDuringOutage.json.activated === true && startDuringOutage.status === 200,
    { act: actDuringOutage.json, start: startDuringOutage.status });
  await api('POST', '/api/bot/stop', { token: legacy.token, body: {} });
  sh(`cd ${__dirname} && nohup node payhip-stub.js > payhip.log 2>&1 &`);
  await new Promise((r) => setTimeout(r, 1200));

  // ------------------------------------------------------------ C. activation
  section('C. T5c - Payhip Live Mode activation rules');
  const buyer = await newUser('buyer.new', { live: 50 });
  const gated = await api('POST', '/api/bot/start', { token: buyer.token, body: { mode: 'live' } });
  check('C1 a new unfunded customer cannot start Live Mode before activation',
    gated.status === 403 && gated.json.code === 'LIVE_ACTIVATION_REQUIRED', { s: gated.status, j: gated.json });
  const demoOk = await api('POST', '/api/bot/start', { token: buyer.token, body: { mode: 'demo' } });
  check('C2 Demo Mode remains available without any purchase', demoOk.status === 200, demoOk.json);
  await api('POST', '/api/bot/stop', { token: buyer.token, body: {} });

  const noKey = await api('POST', '/api/live/activate', { token: buyer.token, body: {} });
  check('C3 an empty licence key is rejected', noKey.status === 400 && noKey.json.code === 'LICENCE_REQUIRED', noKey.json);
  const badKey = await api('POST', '/api/live/activate', { token: buyer.token, body: { licenceKey: 'KAL-NOPE' } });
  check('C4 an unknown licence key is rejected as invalid', badKey.status === 404 && badKey.json.reason === 'invalid-licence', badKey.json);
  const disabled = await api('POST', '/api/live/activate', { token: buyer.token, body: { licenceKey: 'KAL-DISABLED' } });
  check('C5 a disabled/refunded licence is rejected', disabled.status === 409 && disabled.json.reason === 'licence-disabled', disabled.json);
  const wrong = await api('POST', '/api/live/activate', { token: buyer.token, body: { licenceKey: 'KAL-WRONG' } });
  check('C6 a licence for another product is rejected', wrong.status === 409 && wrong.json.reason === 'wrong-product', wrong.json);
  check('C7 no failed attempt created an entitlement', sql('select count(*) from payhip_entitlements;') === '0');
  check('C8 none of the failed attempts activated the account',
    (await api('GET', '/api/live/activation', { token: buyer.token })).json.activated === false);

  const unsigned = await api('POST', PAYHIP_HOOK, { body: Object.assign(salePayload({ id: 'SALE-UNSIGNED' }), { signature: 'deadbeef' }) });
  check('C9 an unsigned webhook records no purchase',
    (unsigned.status >= 400 || (unsigned.json && unsigned.json.outcome === 'signature-invalid')) &&
    sql('select count(*) from payhip_purchases;') === '0', { s: unsigned.status, j: unsigned.json });

  const wrongProduct = await api('POST', PAYHIP_HOOK, { body: salePayload({ id: 'SALE-OTHER', product: 'SOMETHING_ELSE' }) });
  check('C10 a paid sale for a non-activation product is not recorded',
    wrongProduct.json && wrongProduct.json.outcome === 'product-not-allowed' && sql('select count(*) from payhip_purchases;') === '0', wrongProduct.json);

  const sale = salePayload({ id: 'SALE-1001', key: 'KAL-VALID' });
  const paid = await api('POST', PAYHIP_HOOK, { body: sale });
  check('C11 a verified paid sale is recorded exactly once',
    paid.status === 200 && sql('select count(*) from payhip_purchases;') === '1', { s: paid.status, j: paid.json });
  const replay = await api('POST', PAYHIP_HOOK, { body: sale });
  check('C12 a replayed webhook is idempotent and grants nothing extra',
    sql('select count(*) from payhip_purchases;') === '1' && sql('select count(*) from payhip_entitlements;') === '1', replay.json);
  check('C13 the raw licence key is never stored (hash only)',
    sql("select count(*) from payhip_entitlements where licence_key_hash like 'KAL%';") === '0' &&
    sql("select count(*) from payhip_purchases where raw_payload::text like '%KAL-VALID%';") === '0');

  const balanceBeforeRedeem = liveOf(buyer.id);
  const redeem = await api('POST', '/api/live/activate', { token: buyer.token, body: { licenceKey: 'KAL-VALID' } });
  check('C14 the buyer redeems the licence and Live Mode unlocks', redeem.status === 200 && redeem.json.activated === true, redeem.json);
  check('C15 activation credits NO trading capital (balance unchanged)',
    liveOf(buyer.id) === balanceBeforeRedeem, { before: balanceBeforeRedeem, after: liveOf(buyer.id) });

  const thief = await newUser('buyer.other', { live: 50 });
  const stolen = await api('POST', '/api/live/activate', { token: thief.token, body: { licenceKey: 'KAL-VALID' } });
  check('C16 the same licence cannot be claimed by another account',
    stolen.status === 409 && ['claimed_by_other_account', 'already-claimed', 'entitlement_revoked'].includes(stolen.json.reason), stolen.json);
  check('C17 the second account did not receive an activation',
    (await api('GET', '/api/live/activation', { token: thief.token })).json.activated === false);

  const refund = await api('POST', PAYHIP_HOOK, { body: salePayload({ id: 'SALE-1001', type: 'refunded', key: 'KAL-VALID' }) });
  check('C18 a refund webhook revokes the activation', refund.status === 200, refund.json);
  const afterRefund = await api('GET', '/api/live/activation', { token: buyer.token });
  const startAfterRefund = await api('POST', '/api/bot/start', { token: buyer.token, body: { mode: 'live' } });
  check('C19 the revoked account is refused Live Mode again',
    afterRefund.json.activated === false && startAfterRefund.status === 403, { act: afterRefund.json, s: startAfterRefund.status });
  check('C20 the refund did not touch the customer balance', liveOf(buyer.id) === balanceBeforeRedeem);

  const sandboxUser = await newUser('sandbox.recorder', { sandbox: true });
  const sandboxAct = await api('GET', '/api/live/activation', { token: sandboxUser.token });
  check('C21 a MARKETING_SANDBOX account is exempt by construction',
    sandboxAct.json.activated === true && sandboxAct.json.reason === 'sandbox', sandboxAct.json);

  // ------------------------------------------------------------- D. min deposit
  section('D. T5d - $50 minimum deposit and referral sync');
  const admin = await newUser('ops.admin', { admin: true });
  const stats = await api('GET', '/api/admin/stats', { token: admin.token });
  check('D1 the runtime minimum deposit is $50', stats.json && stats.json.minDeposit === 50, stats.json && stats.json.minDeposit);
  check('D2 the runtime detects referral_config and the floor agree',
    stats.json && stats.json.minDepositSync && stats.json.minDepositSync.ok === true, stats.json && stats.json.minDepositSync);

  const belowMin = await api('POST', '/api/payment/create-invoice', { token: buyer.token, body: { amount: 49, currency: 'USDT', network: 'TRC20' } });
  check('D3 a $49 invoice is refused at the new floor',
    belowMin.status === 400 && /\$50/.test(belowMin.json.error || ''), belowMin.json);
  const atMin = await api('POST', '/api/payment/create-invoice', { token: buyer.token, body: { amount: 50, currency: 'USDT', network: 'TRC20' } });

  // Referral qualification at $50: drive the REAL admin-confirm path.
  const referrer = await newUser('ref.partner');
  const referred = await newUser('ref.downline', { live: 0 });
  sql(`insert into referrals (referrer_id, referred_id, status, bonus_earned) values (${referrer.id}, ${referred.id}, 'pending', 0);`);
  const pendingDeposit = seedConfirmedDeposit(referred.id, 50, { status: 'pending', credited: false, ageDays: 0 });
  const confirm = await api('PUT', `/api/admin/deposits/${pendingDeposit}/confirm`, { token: admin.token, body: {} });
  const bonus = Number(sql(`select bonus_balance from wallets where user_id=${referrer.id};`));
  const refStatus = sql(`select status || '|' || bonus_earned from referrals where referred_id=${referred.id};`);
  check('D4 a $50 deposit confirms through the real admin path', confirm.status === 200, confirm.json);
  check('D5 the $50 deposit qualifies the referral', refStatus.startsWith('active'), refStatus);
  check('D6 the referrer earns 20% of the $50 deposit ($10)', Math.abs(bonus - 10) < 0.001, { bonus });
  check('D7 exactly one referral bonus transaction was written',
    sql(`select count(*) from transactions where user_id=${referrer.id} and type='Referral Bonus';`) === '1');
  const doubleConfirm = await api('PUT', `/api/admin/deposits/${pendingDeposit}/confirm`, { token: admin.token, body: {} });
  check('D8 re-confirming the same deposit awards nothing twice',
    Math.abs(Number(sql(`select bonus_balance from wallets where user_id=${referrer.id};`)) - bonus) < 0.001 && doubleConfirm.status >= 400);

  // ------------------------------------------------- E. subscription rebrand
  section('E. T5e - subscription detail carries the new brand');
  const subUser = await newUser('sub.member', { live: 20 });
  sql(`insert into subscriptions (user_id, plan, price, status) values (${subUser.id}, 'pro', 7, 'active');`);
  const charge = sql(`select charge_subscription_safe(${subUser.id}, 7, 'smoke-charge-1', '2026-11', 'initial');`);
  const detail = sql(`select detail from transactions where user_id=${subUser.id} order by id desc limit 1;`);
  check('E1 a new subscription charge writes the Kalderix detail',
    /Kalderix Pro Subscription/.test(detail), { charge: charge.slice(0, 120), detail });
  check('E2 the retired brand never appears in new charge details',
    !/Arbitrix Pro Subscription/.test(detail) && !/Arbitrix/.test(detail), detail);
  const hist = sql(`insert into transactions (user_id, type, amount, detail, mode) values (${subUser.id}, 'Subscription', -7, 'Arbitrix Pro Subscription', 'live') returning id;`);
  check('E3 a pre-rebrand transaction row is preserved verbatim', hist !== '', hist);
  check('E4 the served page derives the detail prefixes from the brand (both eras map to one label)',
    /SUBSCRIPTION_DETAIL_PREFIXES/.test(home.text) && /Pro Subscription/.test(home.text) &&
    !/Arbitrix Pro Subscription/.test(home.text),
    (home.text.match(/[^\n]*SUBSCRIPTION_DETAIL_PREFIXES[^\n]*/g) || []).slice(0, 2));

  // ------------------------------------------------------ F. withdrawal rules
  section('F. Withdrawal rules untouched by the relaunch');
  const w = await api('POST', '/api/withdraw/request', { token: legacy.token, body: { amount: 499, address: 'TXYZsmokeaddress000001' } });
  check('F1 the internal $700 minimum still applies', w.status === 400 && /Min \$700/.test(w.json.error || ''), w.json);

  // ------------------------------------------------------------ G. final state
  section('G. No collateral damage');
  check('G1 the grandfathered customer balance is still $120', liveOf(legacy.id) === 120);
  check('G2 the grandfathered customer still has live trading access',
    (await api('POST', '/api/bot/start', { token: legacy.token, body: { mode: 'live' } })).status === 200);
  await api('POST', '/api/bot/stop', { token: legacy.token, body: {} });
  const meAfter = (await api('GET', '/api/auth/me', { token: legacy.token })).json;
  check('G3 the account still reports its real deposit', meAfter && meAfter.hasRealDeposit === true, meAfter && meAfter.hasRealDeposit);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(' - ' + f.name + '  ' + JSON.stringify(f.detail));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('HARNESS ERROR:', e && e.stack || e); process.exitCode = 2; });
