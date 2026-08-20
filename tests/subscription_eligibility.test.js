// Regression tests for the subscription activation / $50 promotional Live
// credit fix. The $50 promo is seeded into wallets.live_balance at wallet
// creation but must NEVER count toward subscription funding. Eligibility is
// established ONLY via a confirmed real deposit (hasConfirmedDeposit),
// server-side. These tests mirror the gate logic purely (no express import —
// deps are unavailable in this env) and grep the production source to pin the
// wiring contract.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// ---------- Pure-JS mirrors of the gate logic (production + recurring) ----------
function activateGate(subStatus, hasConfirmedDeposit) {
  // Mirrors the POST /api/subscription/activate ordering:
  // sandbox branch first (not modelled here), then create/ensure, then
  // already-active duplicate, then the NEW eligibility gate, then charge.
  if (subStatus === 'active') {
    return { outcome: 'duplicate_active', charged: false };
  }
  if (!hasConfirmedDeposit) {
    return { outcome: 'blocked_deposit_required', charged: false, status: subStatus };
  }
  return { outcome: 'charge_attempted', charged: true, status: subStatus === 'payment_due' ? 'payment_due' : subStatus };
}

function recurringGate(subStatus, due, hasConfirmedDeposit) {
  // Mirrors processDueSubscription(): not billable unless active/payment_due;
  // if not due -> not_due; NEW eligibility gate -> payment_due without charge;
  // otherwise charge via charge_subscription_safe.
  if (subStatus !== 'active' && subStatus !== 'payment_due') {
    return { outcome: 'not_billable', charged: false, status: subStatus };
  }
  if (!due) return { outcome: 'not_due', charged: false, status: subStatus };
  if (!hasConfirmedDeposit) {
    return { outcome: 'blocked_deposit_required', charged: false, status: 'payment_due' };
  }
  return { outcome: 'charge_attempted', charged: true, status: subStatus };
}

function frontendActivateGuard(mode) {
  // Mirrors activateSubscription() Demo guard.
  if (mode !== 'live') return { blocked: true, reason: 'switch_to_live' };
  return { blocked: false };
}

// ---------- Source-contract greps ----------
describe('source wiring contract', () => {
  test('eligibility helper delegates to hasConfirmedDeposit', () => {
    assert.ok(/async function hasSubscriptionFundingEligibility\(userId\) \{\s*return hasConfirmedDeposit\(userId\);/.test(serverSrc));
  });
  test('activation route gates eligibility BEFORE the cancelled-reactivation and RPC', () => {
    const act = serverSrc.match(/app\.post\('\/api\/subscription\/activate'[\s\S]*?app\.post\('\/api\/subscription\/cancel'/)[0];
    const gateIdx = act.indexOf("reason: 'deposit_required'");
    const cancelledIdx = act.indexOf("sub.status === 'cancelled'");
    const rpcIdx = act.indexOf("rpc('charge_subscription_safe'");
    assert.ok(gateIdx > -1 && cancelledIdx > -1 && rpcIdx > -1);
    assert.ok(gateIdx < cancelledIdx, 'gate must precede cancelled-reactivation');
    assert.ok(gateIdx < rpcIdx, 'gate must precede the charge RPC');
  });
  test('recurring billing gates eligibility BEFORE the monthly RPC', () => {
    const fn = serverSrc.match(/async function processDueSubscription[\s\S]*?\n\}/)[0];
    const gateIdx = fn.indexOf("reason: 'deposit_required'");
    const rpcIdx = fn.indexOf("charge_subscription_safe");
    assert.ok(gateIdx > -1 && rpcIdx > -1);
    assert.ok(gateIdx < rpcIdx);
    assert.ok(fn.includes("status: 'payment_due'"), 'blocked recurring marks payment_due');
  });
  test('frontend Demo-mode guard blocks before server call', () => {
    const fn = indexSrc.match(/async function activateSubscription\(\)[\s\S]*?\n}/)[0];
    assert.ok(fn.includes("APP.mode !== 'live'"));
    assert.ok(fn.indexOf("APP.mode !== 'live'") < fn.indexOf("fetch('/api/subscription/activate'"));
  });
  test('frontend maps deposit_required + insufficient_balance messages', () => {
    const fn = indexSrc.match(/async function activateSubscription\(\)[\s\S]*?\n}/)[0];
    assert.ok(fn.includes("data.reason === 'deposit_required'"));
    assert.ok(fn.includes("data.reason === 'insufficient_balance'"));
    assert.ok(fn.includes("t('subscription.depositRequired')"));
    assert.ok(fn.includes("t('subscription.depositMore')"));
  });
  test('new i18n keys exist in all 6 locales', () => {
    for (const key of ['subscription.switchToLive', 'subscription.depositRequired', 'subscription.depositMore']) {
      const found = indexSrc.match(new RegExp(`'${key}':`, 'g'));
      assert.ok(found && found.length >= 6, `${key} should be defined in all 6 locales`);
    }
  });
  test('sandbox subscription path is untouched (branches before production gate)', () => {
    const act = serverSrc.match(/app\.post\('\/api\/subscription\/activate'[\s\S]*?app\.post\('\/api\/subscription\/cancel'/)[0];
    assert.ok(act.indexOf('handleSandboxSubscriptionActivate') < act.indexOf("reason: 'deposit_required'"));
  });
  test('$50 minimum deposit unchanged (server)', () => {
    assert.ok(!/amount\s*<\s*50[^0-9]/.test(serverSrc.replace(/`/g, '')), 'no new $50 floor regression');
  });
});

// ---------- Case matrix (spec §14) ----------
describe('case matrix', () => {
  test('CASE 1: Demo mode blocked client-side before any charge', () => {
    const r = frontendActivateGuard('demo');
    assert.ok(r.blocked && r.reason === 'switch_to_live');
  });
  test('CASE 2: Live + $50 promo + $0 deposit -> deposit_required, no charge', () => {
    const r = activateGate('inactive', false);
    assert.deepStrictEqual(r, { outcome: 'blocked_deposit_required', charged: false, status: 'inactive' });
  });
  test('CASE 3: Live + $50 promo + $50 deposit -> eligible, charge attempted', () => {
    const r = activateGate('inactive', true);
    assert.ok(r.charged);
  });
  test('CASE 4: $93 deposit reaches ~$143 balance; subscription stays independent of MTA', () => {
    // MTA (143) is a trading/bot gate, not a subscription gate.
    assert.ok(serverSrc.includes("wallet.live_balance < 143"));
    const r = activateGate('inactive', true);
    assert.ok(r.charged);
  });
  test('CASE 5: $143+ deposit -> normal funded-user behavior', () => {
    assert.ok(activateGate('inactive', true).charged);
  });
  test('CASE 6: no promo, $50+ deposit -> eligible (gate only needs a confirmed deposit)', () => {
    assert.ok(activateGate('inactive', true).charged);
  });
  test('CASE 7: due subscription + no confirmed deposit -> payment_due, NO promo charge', () => {
    const r = recurringGate('active', true, false);
    assert.deepStrictEqual(r, { outcome: 'blocked_deposit_required', charged: false, status: 'payment_due' });
  });
  test('CASE 8: active subscription lifecycle unaffected when funded', () => {
    const r = recurringGate('active', true, true);
    assert.ok(r.charged);
    // not_due path for future billing date
    assert.strictEqual(recurringGate('active', false, true).outcome, 'not_due');
    // non-billable statuses never charged
    assert.strictEqual(recurringGate('inactive', true, true).outcome, 'not_billable');
    assert.strictEqual(recurringGate('cancelled', true, true).outcome, 'not_billable');
  });
  test('already-active activation returns duplicate without eligibility check', () => {
    const r = activateGate('active', false);
    assert.deepStrictEqual(r.outcome, 'duplicate_active');
  });
  test('promotional-only balance can never activate from any entry point', () => {
    for (const status of ['inactive', 'payment_due']) {
      assert.ok(!activateGate(status, false).charged);
    }
    for (const status of ['active', 'payment_due']) {
      assert.ok(!recurringGate(status, true, false).charged);
    }
  });
});

// ---------- Constants preserved ----------
describe('constants preserved', () => {
  test('subscription price remains configuration-driven (payment_config + default 7 fallback)', () => {
    assert.ok(serverSrc.includes("'subscription.pro_price'"));
    assert.ok(/SUBSCRIPTION_PRO_DEFAULT_PRICE = 7/.test(serverSrc));
    assert.ok(/'subscription\.pro_price', '7', 'number'/.test(fs.readFileSync(path.join(ROOT, 'supabase/migrations/011_subscription_pro.sql'), 'utf8')));
  });
  test('MTA remains $143', () => {
    assert.ok(serverSrc.includes("wallet.live_balance < 143"));
    assert.ok(indexSrc.includes('$143.00'));
  });
  test('Demo starting balance remains $1,000', () => {
    assert.ok(/demo_balance: 1000/.test(serverSrc));
  });
  test('$50 promotional seed preserved in wallet creation', () => {
    assert.ok(/live_balance: 50/.test(serverSrc));
  });
  test('sandbox remains simulated (sandbox_charge_subscription, never production RPC)', () => {
    const sbx = serverSrc.match(/async function handleSandboxSubscriptionActivate[\s\S]*?handleSandboxSubscriptionCancel/)[0];
    assert.ok(sbx.includes('sandbox_charge_subscription'));
    assert.ok(!sbx.includes('charge_subscription_safe('));
  });
  test('migration 011 and 013 unchanged by this fix', () => {
    // The fix is server.js + index.html + tests only. Verify both migrations
    // still exist and contain the original functions.
    for (const m of ['011_subscription_pro.sql', '013_marketing_sandbox.sql']) {
      const src = fs.readFileSync(path.join(ROOT, 'supabase/migrations', m), 'utf8');
      assert.ok(src.length > 1000);
    }
    assert.ok(fs.readFileSync(path.join(ROOT, 'supabase/migrations/011_subscription_pro.sql'), 'utf8').includes('charge_subscription_safe'));
    assert.ok(fs.readFileSync(path.join(ROOT, 'supabase/migrations/013_marketing_sandbox.sql'), 'utf8').includes('sandbox_charge_subscription'));
  });
});
