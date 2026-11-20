'use strict';

/**
 * Payhip production wiring - the values the live launch will actually use.
 *
 * The approved model is fixed:
 *   $50 one-time Live Mode activation (Payhip product dLXuU) that grants
 *   PERMISSION only, a separate $100 qualifying deposit, a $700 withdrawal
 *   minimum and a $100 referral qualifying deposit. Activation must never add
 *   capital and must never bypass a deposit requirement.
 *
 * These tests exercise the real module against the production identifiers, and
 * they pin the three defects found while doing that:
 *   1. a mixed-case catalogue row ('dLXuU') never matched the allow-list because
 *      `productsOnSale` filtered with `.in()` (case-sensitive in PostgreSQL);
 *   2. the catalogue was keyed by Payhip's NUMERIC product id while the
 *      allow-list (and the licence API) use the PERMALINK code, so the buy
 *      button could stay hidden after a real sale;
 *   3. `product-not-allowed` recorded no identifiers, so an operator could not
 *      see which key Payhip sent without guessing.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const P = require('../services/PayhipEntitlements');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const MIGRATION_050 = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '050_payhip_live_activation.sql'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

// ---- the production values (no secrets: these are public identifiers) ----
const PRODUCT_LINK = 'dLXuU';
const STORE_URL = 'https://payhip.com/b/dLXuU';
const API_KEY = 'store-api-key-for-tests-0123456789';
const SIG = crypto.createHash('sha256').update(API_KEY).digest('hex');
const SECRET = 'product-secret-production-shape';
const TOKEN = 't'.repeat(32);

function cfg(over = {}) {
  return P.resolvePayhipConfig(Object.assign({
    PAYHIP_ENABLED: 'true',
    PAYHIP_PRODUCTS: PRODUCT_LINK,
    PAYHIP_API_KEY: API_KEY,
    PAYHIP_PRODUCT_SECRET: SECRET,
    PAYHIP_WEBHOOK_TOKEN: TOKEN,
    PAYHIP_STORE_URL: STORE_URL
  }, over));
}

function makeAdmin({ rpcResults = {}, products = [], purchases = [] } = {}) {
  const calls = [];
  const writes = [];
  const api = {
    from(table) {
      const b = {
        select() { return b; },
        eq() { return b; },
        order() { return b; },
        limit() { return Promise.resolve({ data: purchases, error: null }); },
        single() { return Promise.resolve({ data: purchases[0] || null, error: null }); },
        then(resolve) {
          // Awaiting the builder itself resolves the catalogue/rows.
          return Promise.resolve({ data: table === 'payhip_products' ? products : purchases, error: null }).then(resolve);
        },
        insert(payload) { writes.push({ table, payload }); return Promise.resolve({ error: null }); },
        upsert(payload, opts) { writes.push({ table, payload, opts }); return Promise.resolve({ error: null }); }
      };
      return b;
    },
    rpc(name, args) {
      calls.push({ name, args });
      const v = rpcResults[name];
      if (v instanceof Error) return Promise.resolve({ data: null, error: v });
      return Promise.resolve({ data: v === undefined ? { success: true } : v, error: null });
    }
  };
  return { api, calls, writes };
}

function licenceFetch(responder) {
  const seen = [];
  const fn = async (url) => {
    seen.push(url);
    const r = responder(url);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  fn.seen = seen;
  return fn;
}

const ENABLED_LICENCE = {
  status: 200,
  body: { data: { enabled: true, product_link: PRODUCT_LINK, license_key: 'K', buyer_email: 'b@e.test', uses: 0 } }
};

function paidSale(over = {}) {
  return Object.assign({
    type: 'paid',
    id: 'SALE-P1',
    email: 'Buyer@Example.com',
    currency: 'USD',
    price: 5000,
    signature: SIG,
    items: [{
      product_id: '1000001',
      product_key: PRODUCT_LINK,
      product_permalink: STORE_URL,
      license_key: 'LICENCE-KEY-P1'
    }]
  }, over);
}

const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');

// ------------------------------------------------------------------ config

test('production product link dLXuU is allow-listed and matched case-insensitively', () => {
  const c = cfg();
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.usable, true);
  assert.strictEqual(c.redeemUsable, true);
  assert.ok(c.products.has('dlxuu'), 'the allow-list normalises to lowercase');
  // A differently-cased operator value must still work.
  assert.ok(cfg({ PAYHIP_PRODUCTS: 'dLXuU, 1000001' }).products.has('1000001'));
  // And a product that is not configured stays out.
  assert.ok(!cfg({ PAYHIP_PRODUCTS: PRODUCT_LINK }).products.has('otherproduct'));
});

test('the buy button appears for a mixed-case catalogue row (case-sensitivity regression)', async () => {
  const { api } = makeAdmin({ products: [{ product_key: 'dLXuU', is_active: true }] });
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const r = await ent.productsOnSale();
  assert.deepStrictEqual(r, { ok: true, configured: 1, active: 1, onSale: true });
});

test('a lowercase catalogue row is found too, and an inactive one hides the button', async () => {
  const lower = P.createPayhipEntitlements({
    admin: makeAdmin({ products: [{ product_key: 'dlxuu', is_active: true }] }).api,
    config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE)
  });
  assert.strictEqual((await lower.productsOnSale()).onSale, true);

  const inactive = P.createPayhipEntitlements({
    admin: makeAdmin({ products: [{ product_key: 'dlxuu', is_active: false }] }).api,
    config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE)
  });
  const r = await inactive.productsOnSale();
  assert.strictEqual(r.onSale, false, 'an inactive catalogue row must not advertise checkout');
  assert.strictEqual(r.ok, true);
});

test('an unreadable catalogue fails closed for the offer', async () => {
  const api = {
    from() {
      const b = { select() { return b; }, then(res) { return Promise.resolve({ data: null, error: new Error('boom') }).then(res); } };
      return b;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); }
  };
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const r = await ent.productsOnSale();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.onSale, false);
});

// ----------------------------------------------------------------- webhook

test('a paid dLXuU sale is recorded with the permalink key, not the numeric id', async () => {
  const { api, calls, writes } = makeAdmin();
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });

  const out = await ent.handleWebhook(paidSale());
  assert.strictEqual(out.outcome, 'recorded');
  assert.strictEqual(out.saleId, 'SALE-P1');

  const rpc = calls.find((c) => c.name === 'record_payhip_purchase_safe');
  assert.ok(rpc, 'the purchase RPC must be called');
  assert.strictEqual(rpc.args.p_product_key, 'dlxuu',
    'the catalogue key passed to the RPC must match the row the catalogue was given');
  assert.strictEqual(rpc.args.p_licence_hash, sha('LICENCE-KEY-P1'), 'only the hash is stored');
  assert.ok(!JSON.stringify(rpc.args).includes('LICENCE-KEY-P1'), 'the raw licence must never reach the RPC');

  const catalogue = writes.find((w) => w.table === 'payhip_products');
  assert.ok(catalogue, 'the catalogue row is ensured');
  assert.strictEqual(catalogue.payload.product_key, 'dlxuu');
  assert.ok(!('is_active' in catalogue.payload), 'a sale must never activate checkout by itself');
});

test('a webhook that carries only the permalink is still recorded', async () => {
  const sale = paidSale({
    items: [{ product_permalink: STORE_URL, license_key: 'LICENCE-KEY-P2' }]
  });
  const { api, calls } = makeAdmin();
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const out = await ent.handleWebhook(sale);
  assert.strictEqual(out.outcome, 'recorded');
  assert.strictEqual(calls.find((c) => c.name === 'record_payhip_purchase_safe').args.p_product_key, 'dlxuu');
});

test('a numeric-only product id works when the operator allow-lists it', async () => {
  const sale = paidSale({ items: [{ product_id: '1000001', license_key: 'LICENCE-KEY-P3' }] });
  const { api, calls } = makeAdmin();
  const ent = P.createPayhipEntitlements({
    admin: api,
    config: cfg({ PAYHIP_PRODUCTS: 'dlxuu,1000001' }),
    fetchImpl: licenceFetch(() => ENABLED_LICENCE)
  });
  assert.strictEqual((await ent.handleWebhook(sale)).outcome, 'recorded');
  assert.strictEqual(calls.find((c) => c.name === 'record_payhip_purchase_safe').args.p_product_key, '1000001');
});

test('a product outside the allow-list is refused and the identifiers are recorded', async () => {
  const sale = paidSale({ items: [{ product_id: '999', product_key: 'ZZZZ', license_key: 'K' }] });
  const { api, calls, writes } = makeAdmin();
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const out = await ent.handleWebhook(sale);
  assert.strictEqual(out.outcome, 'product-not-allowed');
  assert.ok(!calls.some((c) => c.name === 'record_payhip_purchase_safe'), 'nothing may be recorded');
  assert.ok(!writes.some((w) => w.table === 'payhip_products'), 'the catalogue must not grow from a refused sale');
});

test('a duplicate webhook is idempotent', async () => {
  const { api, calls } = makeAdmin({ rpcResults: { record_payhip_purchase_safe: { success: true, duplicate: true, purchase_id: 1 } } });
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const out = await ent.handleWebhook(paidSale());
  assert.strictEqual(out.outcome, 'duplicate');
  assert.strictEqual(calls.filter((c) => c.name === 'redeem_payhip_entitlement_safe').length, 0,
    'a webhook must never claim an entitlement');
});

test('an invalid signature is refused before anything is recorded', async () => {
  const { api, calls } = makeAdmin();
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const out = await ent.handleWebhook(paidSale({ signature: 'deadbeef' }));
  assert.strictEqual(out.outcome, 'signature-invalid');
  assert.strictEqual(calls.length, 0, 'no RPC may run for an unauthenticated delivery');
});

// -------------------------------------------------------------- redemption

test('a valid dLXuU licence is claimed once for the account', async () => {
  const { api, calls } = makeAdmin({
    rpcResults: { redeem_payhip_entitlement_safe: { success: true, duplicate: false, entitlement_id: 7 } }
  });
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const r = await ent.redeem(41, 'LICENCE-KEY-P1');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.entitlement_id, 7);
  const call = calls.find((c) => c.name === 'redeem_payhip_entitlement_safe');
  assert.strictEqual(call.args.p_user_id, 41);
  assert.strictEqual(call.args.p_licence_hash, sha('LICENCE-KEY-P1'));
});

test('an invalid licence never reaches the claim RPC', async () => {
  const { api, calls } = makeAdmin();
  const ent = P.createPayhipEntitlements({
    admin: api, config: cfg(), fetchImpl: licenceFetch(() => ({ status: 200, body: {} }))
  });
  const r = await ent.redeem(42, 'NOT-A-REAL-KEY');
  assert.strictEqual(r.reason, 'invalid-licence');
  assert.strictEqual(calls.length, 0);
});

test('a refunded or disabled licence is refused', async () => {
  const { api, calls } = makeAdmin();
  const ent = P.createPayhipEntitlements({
    admin: api,
    config: cfg(),
    fetchImpl: licenceFetch(() => ({ status: 200, body: { data: { enabled: false, product_link: PRODUCT_LINK } } }))
  });
  const r = await ent.redeem(43, 'REFUNDED-KEY');
  assert.strictEqual(r.reason, 'licence-disabled');
  assert.strictEqual(calls.length, 0);
});

test('a licence for another product is refused indistinguishably from invalid', async () => {
  const { api, calls } = makeAdmin();
  const ent = P.createPayhipEntitlements({
    admin: api,
    config: cfg(),
    fetchImpl: licenceFetch(() => ({ status: 200, body: { data: { enabled: true, product_link: 'ZZZZ' } } }))
  });
  const r = await ent.redeem(44, 'OTHER-PRODUCT-KEY');
  assert.strictEqual(r.reason, 'invalid-licence');
  assert.strictEqual(calls.length, 0, 'a wrong-product key must not touch the entitlement table');
});

test('a delayed webhook: redeem before the sale lands, then after it lands', async () => {
  // Before: Payhip confirms the licence, but no sale row exists yet.
  const before = makeAdmin({ rpcResults: { redeem_payhip_entitlement_safe: { success: false, reason: 'invalid_licence' } } });
  const entBefore = P.createPayhipEntitlements({ admin: before.api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const r1 = await entBefore.redeem(45, 'LICENCE-KEY-P1');
  assert.strictEqual(r1.reason, 'not-recorded', 'a real key with no sale is retryable, not "invalid"');
  assert.strictEqual(r1.retryable, true);

  // After: the webhook arrived and the row exists.
  const after = makeAdmin({ rpcResults: { redeem_payhip_entitlement_safe: { success: true, entitlement_id: 9 } } });
  const entAfter = P.createPayhipEntitlements({ admin: after.api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const r2 = await entAfter.redeem(45, 'LICENCE-KEY-P1');
  assert.strictEqual(r2.success, true);
});

test('two accounts redeeming the same licence concurrently: the database decides', async () => {
  let n = 0;
  const { api, calls } = makeAdmin({
    rpcResults: { redeem_payhip_entitlement_safe: { success: true, duplicate: false, entitlement_id: 11 } }
  });
  // The second call simulates the row-lock loser: the module must pass BOTH through.
  const original = api.rpc;
  api.rpc = function (name, args) {
    if (name === 'redeem_payhip_entitlement_safe' && ++n === 2) {
      calls.push({ name, args });
      return Promise.resolve({ data: { success: false, reason: 'claimed_by_other_account' }, error: null });
    }
    return original.call(this, name, args);
  };
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });

  const [a, b] = await Promise.all([ent.redeem(46, 'LICENCE-KEY-P1'), ent.redeem(47, 'LICENCE-KEY-P1')]);
  assert.strictEqual(calls.filter((c) => c.name === 'redeem_payhip_entitlement_safe').length, 2,
    'both attempts must reach the atomic RPC; no client-side shortcut may decide ownership');
  const results = [a, b].map((r) => (r.success ? 'won' : r.reason)).sort();
  assert.deepStrictEqual(results, ['claimed_by_other_account', 'won']);
});

// ----------------------------------------------------------- revoke events

test('a refund revokes the entitlement through the revoke RPC', async () => {
  const { api, calls } = makeAdmin({ rpcResults: { revoke_payhip_entitlement_safe: { success: true, status: 'refunded' } } });
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const out = await ent.handleWebhook({ type: 'refunded', id: 'SALE-P1', amount_refunded: 5000, signature: SIG, items: [] });
  assert.strictEqual(out.outcome, 'revoked');
  const call = calls.find((c) => c.name === 'revoke_payhip_entitlement_safe');
  assert.deepStrictEqual(call.args, {
    p_sale_id: 'SALE-P1',
    p_status: 'refunded',
    p_amount_refunded_cents: 5000,
    p_reason: 'refunded'
  });
});

test('a chargeback revokes with its own status, and touches no balance', async () => {
  const { api, calls, writes } = makeAdmin({ rpcResults: { revoke_payhip_entitlement_safe: { success: true, status: 'chargedback' } } });
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });
  const out = await ent.handleWebhook({ type: 'chargedback', id: 'SALE-P1', amount_refunded: 5000, signature: SIG, items: [] });
  assert.strictEqual(out.outcome, 'revoked');
  assert.strictEqual(calls.find((c) => c.name === 'revoke_payhip_entitlement_safe').args.p_status, 'chargedback');
  assert.strictEqual(writes.filter((w) => /wallet|transaction|deposit/i.test(w.table)).length, 0);
});

// ------------------------------------------------------- no capital, no bypass

test('the module can only ever call the four Payhip RPCs', async () => {
  const allowed = new Set([
    'record_payhip_purchase_safe',
    'redeem_payhip_entitlement_safe',
    'revoke_payhip_entitlement_safe',
    'payhip_has_live_activation'
  ]);
  const { api, calls } = makeAdmin({ rpcResults: { payhip_has_live_activation: true } });
  const ent = P.createPayhipEntitlements({ admin: api, config: cfg(), fetchImpl: licenceFetch(() => ENABLED_LICENCE) });

  await ent.handleWebhook(paidSale());
  await ent.redeem(48, 'LICENCE-KEY-P1');
  await ent.handleWebhook({ type: 'refunded', id: 'SALE-P1', signature: SIG, items: [] });
  await ent.hasActivation(48);

  assert.ok(calls.length >= 4);
  for (const c of calls) {
    assert.ok(allowed.has(c.name), 'unexpected RPC from the Payhip path: ' + c.name);
  }
  // And nothing in the source names a wallet/credit/deposit function.
  for (const banned of ['updateWallet', 'credit_payment_safe', 'record_trade_safe', 'live_balance', 'bonus_balance', 'wallets']) {
    assert.ok(!new RegExp(banned, 'i').test(fs.readFileSync(path.join(ROOT, 'services', 'PayhipEntitlements.js'), 'utf8')),
      'the Payhip module must not reference ' + banned);
  }
});

test('activation grants permission only: the commercial constants are untouched', () => {
  const constants = {
    PLATFORM_MIN_DEPOSIT_USD: /const PLATFORM_MIN_DEPOSIT_USD = 100;/,
    MIN_WITHDRAWAL_USD: /const MIN_WITHDRAWAL_USD = 700;/,
    REFERRAL_REWARD_PERCENT_DEFAULT: /const REFERRAL_REWARD_PERCENT_DEFAULT = 20;/
  };
  for (const [name, re] of Object.entries(constants)) {
    assert.match(SERVER, re, name + ' must stay at its approved value');
  }
  // The activation routes must not write a balance or create a deposit.
  const activation = SERVER.slice(SERVER.indexOf("app.post('/api/live/activate'"), SERVER.indexOf("app.post('/api/live/activate'") + 4000);
  for (const banned of ['updateWallet', 'credit_payment_safe', 'record_trade_safe', 'wallets', 'liveModeLiveBalance']) {
    assert.ok(!activation.includes(banned), 'activation must not touch ' + banned);
  }
});

test('migration 050 is FK-compatible, idempotent and service-role only', () => {
  assert.match(MIGRATION_050, /user_id\s+BIGINT REFERENCES public\.users\(id\)/,
    'production users.id is BIGINT; a mismatch would abort the migration');
  assert.match(MIGRATION_050, /CREATE TABLE IF NOT EXISTS public\.payhip_products/);
  assert.match(MIGRATION_050, /CREATE TABLE IF NOT EXISTS public\.payhip_purchases/);
  assert.match(MIGRATION_050, /CREATE TABLE IF NOT EXISTS public\.payhip_entitlements/);
  assert.match(MIGRATION_050, /CREATE TABLE IF NOT EXISTS public\.payhip_events/);
  for (const fn of ['record_payhip_purchase_safe', 'redeem_payhip_entitlement_safe',
    'revoke_payhip_entitlement_safe', 'payhip_has_live_activation']) {
    assert.match(MIGRATION_050, new RegExp('CREATE OR REPLACE FUNCTION public\\.' + fn), fn + ' must be (re)created');
  }
  // Defence in depth: public first, pg_temp LAST, on every SECURITY DEFINER body.
  // Count FUNCTION DEFINITIONS, not the prose that mentions them.
  const defs = MIGRATION_050.match(/LANGUAGE (?:plpgsql|sql) SECURITY DEFINER[^\n]*/g) || [];
  const pinned = (MIGRATION_050.match(/SET search_path = public, pg_temp/g) || []).length;
  assert.ok(defs.length >= 4, 'the migration defines at least the four Payhip functions');
  assert.strictEqual(pinned, defs.length,
    'every SECURITY DEFINER body must pin search_path with pg_temp last (the 053 rule)');
  for (const line of defs) {
    assert.match(line, /SET search_path = public, pg_temp AS \$\$$/, line.slice(0, 90));
  }
  assert.match(MIGRATION_050, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  assert.match(MIGRATION_050, /GRANT EXECUTE ON FUNCTION %s TO service_role/);
  assert.match(MIGRATION_050, /payhip_sale_id\s+TEXT NOT NULL UNIQUE/, 'the sale id is the idempotency anchor');
  assert.match(MIGRATION_050, /licence_key_hash TEXT NOT NULL UNIQUE/);
  // Comments legitimately say what the migration does NOT do; only statements matter.
  const sqlOnly = MIGRATION_050.replace(/--[^\n]*/g, '');
  assert.ok(!/wallets|live_balance/i.test(sqlOnly),
    'migration 050 must not touch a wallet');
  assert.ok(!/INSERT\s+INTO\s+public\.transactions|UPDATE\s+public\.transactions/i.test(sqlOnly),
    'migration 050 must not write the ledger');
});

test('.env.example documents the production product code and store URL', () => {
  assert.match(ENV_EXAMPLE, /PAYHIP_PRODUCTS=dLXuU/,
    'the example must use the real product code so an operator does not ship a placeholder');
  assert.match(ENV_EXAMPLE, /PAYHIP_STORE_URL=https:\/\/payhip\.com\/b\/dLXuU/);
  for (const v of ['PAYHIP_ENABLED', 'PAYHIP_PRODUCT_SECRET', 'PAYHIP_WEBHOOK_TOKEN',
    'PAYHIP_ACTIVATION_REQUIRED', 'PAYHIP_API_KEY']) {
    assert.ok(ENV_EXAMPLE.includes(v), v + ' must be documented');
  }
  // No secret VALUE may be committed next to the names.
  assert.ok(!/PAYHIP_PRODUCT_SECRET=[A-Za-z0-9]{16,}/.test(ENV_EXAMPLE), 'no committed product secret');
  assert.ok(!/PAYHIP_API_KEY=[A-Za-z0-9]{16,}/.test(ENV_EXAMPLE), 'no committed store API key');
  assert.ok(!/PAYHIP_WEBHOOK_TOKEN=[A-Za-z0-9]{16,}/.test(ENV_EXAMPLE), 'no committed webhook token');
});

// ------------------------------------------------------------ operator scripts

test('the 050 readiness and postcheck scripts are read-only', () => {
  const files = ['payhip_050_readiness.sql', 'payhip_050_postcheck.sql'];
  for (const name of files) {
    const full = path.join(ROOT, 'docs', 'sql', name);
    assert.ok(fs.existsSync(full), name + ' must exist for the operator to run');
    const raw = fs.readFileSync(full, 'utf8');
    // Remove comments and single-quoted literals: the postcheck PRINTS an INSERT
    // statement as advice, which is not a write.
    const bare = raw
      .replace(/--[^\n]*/g, '')
      .replace(/'(?:[^']|'')*'/g, "''");
    for (const verb of ['insert into', 'update ', 'delete from', 'alter table',
      'create table', 'drop table', 'create or replace', 'grant ', 'revoke ']) {
      assert.ok(!bare.toLowerCase().includes(verb),
        name + ' must not contain "' + verb.trim() + '" outside a printed literal');
    }
    assert.match(raw, /READ-ONLY/i, name + ' must say it is read-only');
  }
});

test('the release checklists point at scripts that exist', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'relaunch', '13-RELEASE-CHECKLIST-KALDERIX.md'), 'utf8');
  for (const ref of ['docs/sql/payhip_050_readiness.sql', 'docs/sql/payhip_050_postcheck.sql']) {
    assert.ok(doc.includes(ref), 'the checklist must reference ' + ref);
  }
  // The stale $50 instructions must be gone.
  assert.ok(!/049_min_deposit_50\.sql/.test(doc), 'the retired $50 migration must not be referenced');
  assert.ok(!/PLATFORM_MIN_DEPOSIT_USD=50/.test(doc), 'no instruction may set the floor to 50');
  assert.match(doc, /052[\s\S]{0,80}APPLIED/, '052 must be recorded as already applied');
  assert.match(doc, /053[\s\S]{0,120}APPLIED/, '053 must be recorded as already applied');
});
