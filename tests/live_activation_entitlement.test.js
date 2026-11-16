'use strict';

/**
 * Payhip one-time Live Mode activation (Option A).
 *
 * The entitlement unlocks Live Mode; it credits NO capital and bypasses no
 * existing gate. These tests pin the security properties that make that true:
 * inert by default, allow-listed products, one-time claim, no raw licence key
 * stored, refunds revoke, and an unreadable store fails OPEN rather than
 * stranding a funded customer.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVICE = fs.readFileSync(path.join(ROOT, 'services', 'PayhipEntitlements.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '050_payhip_live_activation.sql'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const {
  resolvePayhipConfig,
  describePayhipConfig,
  createPayhipEntitlements,
  parseSale,
  netSettledCents,
  hashLicenceKey,
  tokenMatches,
  parseList
} = require('../services/PayhipEntitlements');

/** Minimal table-aware fake of the Supabase service-role client. */
function makeAdmin({ rpcResults = {}, rows = {} } = {}) {
  const calls = [];
  const inserted = [];
  const api = {
    from(table) {
      const builder = {
        insert(payload) {
          inserted.push({ table, payload });
          return Promise.resolve({ error: null });
        },
        upsert(payload, opts) {
          inserted.push({ table, payload, upsert: opts || {} });
          return Promise.resolve({ error: null });
        },
        select() { return builder; },
        order() { return builder; },
        limit() { return Promise.resolve({ data: rows[table] || [], error: null }); },
        eq() { return builder; },
        single() { return Promise.resolve({ data: null, error: null }); }
      };
      return builder;
    },
    rpc(name, args) {
      calls.push({ name, args });
      const value = rpcResults[name];
      if (value instanceof Error) return Promise.resolve({ data: null, error: value });
      return Promise.resolve({ data: value === undefined ? { success: true } : value, error: null });
    }
  };
  return { api, calls, inserted };
}

const CFG = (over = {}) => resolvePayhipConfig(Object.assign({
  PAYHIP_ENABLED: 'true',
  PAYHIP_WEBHOOK_TOKEN: 's'.repeat(40),
  PAYHIP_PRODUCTS: 'live-starter'
}, over));

const PAID = {
  type: 'paid',
  id: 'SALE-1',
  email: 'Buyer@Example.com',
  currency: 'USD',
  price: 5000,
  stripe_fee: 175,
  payhip_fee: 300,
  items: [{ product_id: 'live-starter', product_name: 'Live activation', license_key: 'AAAA-BBBB-CCCC-DDDD' }]
};

// ---------------------------------------------------------------- config

test('1. inert by default: no flag, no token, no product', () => {
  const c = resolvePayhipConfig({});
  assert.strictEqual(c.enabled, false);
  assert.strictEqual(c.usable, false);
  assert.strictEqual(c.reason, 'disabled');
  assert.strictEqual(c.activationRequired, false, 'Live Mode is NOT gated until an operator opts in');
  const d = describePayhipConfig(c);
  assert.strictEqual(d.webhookTokenConfigured, false);
  assert.ok(!JSON.stringify(d).includes('s'.repeat(40)), 'never echoes a secret');
});

test('2. usable only when enabled AND a token AND at least one product exist', () => {
  assert.strictEqual(CFG().usable, true);
  assert.strictEqual(CFG({ PAYHIP_WEBHOOK_TOKEN: '' }).reason, 'missing-webhook-token');
  assert.strictEqual(CFG({ PAYHIP_PRODUCTS: '' }).reason, 'no-products-configured');
  assert.strictEqual(CFG({ PAYHIP_ENABLED: 'no' }).reason, 'disabled');
  // An unknown/invalid flag value must not enable anything.
  assert.strictEqual(resolvePayhipConfig({ PAYHIP_ENABLED: 'yes please' }).enabled, false);
});

test('3. the product allow-list is normalised and case-insensitive', () => {
  const set = parseList(' Live-Starter , second ,, ');
  assert.deepStrictEqual([...set].sort(), ['live-starter', 'second']);
  const c = resolvePayhipConfig({ PAYHIP_ENABLED: 'true', PAYHIP_WEBHOOK_TOKEN: 'x'.repeat(32), PAYHIP_PRODUCTS: 'LIVE-STARTER' });
  assert.ok(c.products.has('live-starter'));
});

// ---------------------------------------------------------------- tokens

test('4. webhook authentication is constant-time and length-safe', () => {
  const expected = 's'.repeat(40);
  assert.strictEqual(tokenMatches(expected, expected), true);
  assert.strictEqual(tokenMatches(expected, 's'.repeat(39)), false, 'shorter token rejected');
  assert.strictEqual(tokenMatches(expected, 's'.repeat(41)), false, 'longer token rejected');
  assert.strictEqual(tokenMatches(expected, ''), false);
  assert.strictEqual(tokenMatches(expected, undefined), false);
  assert.strictEqual(tokenMatches('', 'anything'), false, 'an unset secret never authorises');
});

test('5. licence keys are stored only as a hash', () => {
  const h = hashLicenceKey('AAAA-BBBB-CCCC-DDDD');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.strictEqual(h, hashLicenceKey('  AAAA-BBBB-CCCC-DDDD  '), 'trimmed before hashing');
  assert.ok(!h.includes('AAAA'), 'the raw key cannot leak through the hash');
  assert.notStrictEqual(h, hashLicenceKey('AAAA-BBBB-CCCC-DDDE'));
});

// ---------------------------------------------------------------- payload

test('6. a Payhip sale is normalised correctly (amounts are CENTS)', () => {
  const s = parseSale(PAID);
  assert.strictEqual(s.type, 'paid');
  assert.strictEqual(s.saleId, 'SALE-1');
  assert.strictEqual(s.email, 'buyer@example.com', 'email normalised to lower case');
  assert.strictEqual(s.priceCents, 5000);
  assert.strictEqual(s.stripeFeeCents, 175);
  assert.strictEqual(s.payhipFeeCents, 300);
  assert.strictEqual(s.productKey, 'live-starter');
  assert.strictEqual(s.licenceKey, 'AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(parseSale(null), null);
  assert.doesNotThrow(() => parseSale({}), 'junk never throws');
  assert.strictEqual(parseSale({}).saleId, null, 'junk normalises to null ids');
});

test('7. net settlement is derived from the payload fees, never assumed', () => {
  assert.strictEqual(netSettledCents(parseSale(PAID)), 4525);
  assert.strictEqual(netSettledCents({ priceCents: 5000 }), 5000, 'unknown fees report the gross');
  assert.strictEqual(netSettledCents({ priceCents: 100, stripeFeeCents: 80, payhipFeeCents: 80 }), 0, 'floored at zero');
  assert.strictEqual(netSettledCents(null), null);
});

// -------------------------------------------------------------- webhook

test('8. nothing is processed while the integration is inert', async () => {
  const { api, calls, inserted } = makeAdmin();
  const svc = createPayhipEntitlements({ admin: api, config: resolvePayhipConfig({}) });
  const out = await svc.handleWebhook(PAID);
  assert.strictEqual(out.handled, false);
  assert.strictEqual(out.outcome, 'disabled');
  assert.strictEqual(calls.length, 0, 'no RPC is attempted');
  assert.strictEqual(inserted.length, 0, 'no audit row is written');
});

test('9. a sale for a product that is not allow-listed creates nothing', async () => {
  const { api, calls } = makeAdmin();
  const svc = createPayhipEntitlements({ admin: api, config: CFG() });
  const out = await svc.handleWebhook(Object.assign({}, PAID, {
    items: [{ product_id: 'some-other-product', license_key: 'X' }]
  }));
  assert.strictEqual(out.outcome, 'product-not-allowed');
  assert.ok(!calls.some((c) => c.name === 'record_payhip_purchase_safe'), 'no entitlement is recorded');
});

test('10. a paid sale without a licence key records no entitlement', async () => {
  const { api, calls } = makeAdmin();
  const svc = createPayhipEntitlements({ admin: api, config: CFG() });
  const out = await svc.handleWebhook(Object.assign({}, PAID, {
    items: [{ product_id: 'live-starter' }]
  }));
  assert.strictEqual(out.outcome, 'no-licence-key');
  assert.ok(!calls.some((c) => c.name === 'record_payhip_purchase_safe'));
});

test('11. a verified paid sale records the purchase with a HASHED key only', async () => {
  const { api, calls } = makeAdmin({
    rpcResults: { record_payhip_purchase_safe: { success: true, duplicate: false, entitlement_id: 7 } }
  });
  const svc = createPayhipEntitlements({ admin: api, config: CFG() });
  const out = await svc.handleWebhook(PAID);
  assert.strictEqual(out.outcome, 'recorded');

  const call = calls.find((c) => c.name === 'record_payhip_purchase_safe');
  assert.ok(call, 'the purchase RPC ran');
  assert.strictEqual(call.args.p_sale_id, 'SALE-1', 'the sale id is the idempotency anchor');
  assert.strictEqual(call.args.p_product_key, 'live-starter');
  assert.strictEqual(call.args.p_price_cents, 5000);
  assert.match(call.args.p_licence_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(call.args).includes('AAAA-BBBB'),
    'the raw licence key is never sent to storage, including inside raw_payload');
  assert.ok(call.args.p_payload, 'the reconciliation payload is still recorded');
  assert.strictEqual(call.args.p_payload.items[0].product_id, 'live-starter', 'ids/amounts survive redaction');
});

test('12. a replayed webhook is idempotent and credits nothing twice', async () => {
  const { api, calls } = makeAdmin({
    rpcResults: { record_payhip_purchase_safe: { success: true, duplicate: true, entitlement_id: 7 } }
  });
  const svc = createPayhipEntitlements({ admin: api, config: CFG() });
  const out = await svc.handleWebhook(PAID);
  assert.strictEqual(out.outcome, 'duplicate');
  // The database owns dedupe (UNIQUE payhip_sale_id); the service just reports it.
  assert.strictEqual(calls.filter((c) => c.name === 'record_payhip_purchase_safe').length, 1);
  assert.strictEqual(calls.filter((c) => /wallet|balance|credit/i.test(c.name)).length, 0,
    'no balance RPC is ever called from this module');
});

test('13. a refund revokes the entitlement and touches no balance', async () => {
  const { api, calls } = makeAdmin({
    rpcResults: { revoke_payhip_entitlement_safe: { success: true, status: 'refunded' } }
  });
  const svc = createPayhipEntitlements({ admin: api, config: CFG() });
  const out = await svc.handleWebhook({
    type: 'refunded', id: 'SALE-1', amount_refunded: 5000, items: [{ product_id: 'live-starter' }]
  });
  assert.strictEqual(out.outcome, 'revoked');
  const call = calls.find((c) => c.name === 'revoke_payhip_entitlement_safe');
  assert.strictEqual(call.args.p_sale_id, 'SALE-1');
  assert.strictEqual(call.args.p_status, 'refunded');
  assert.strictEqual(call.args.p_amount_refunded_cents, 5000);
  assert.strictEqual(calls.filter((c) => /wallet|balance/i.test(c.name)).length, 0,
    'activation never held capital, so a refund reverses nothing');
});

test('14. unrelated Payhip events are ignored, not guessed at', async () => {
  const { api, calls } = makeAdmin();
  const svc = createPayhipEntitlements({ admin: api, config: CFG() });
  const out = await svc.handleWebhook({ type: 'subscription.created', id: 'SUB-1', items: [] });
  assert.strictEqual(out.outcome, 'ignored:subscription.created');
  assert.strictEqual(calls.length, 0);
});

test('15. an optional independent re-verification can reject a tampered amount', async () => {
  const { api, calls } = makeAdmin();
  const cfg = CFG({ PAYHIP_VERIFY_URL: 'https://payhip.example/sale/{sale_id}', PAYHIP_API_KEY: 'k' });
  const svc = createPayhipEntitlements({
    admin: api,
    config: cfg,
    fetchImpl: async () => ({ ok: true, json: async () => ({ price: 9999, status: 'paid' }) })
  });
  const out = await svc.handleWebhook(PAID);
  assert.strictEqual(out.outcome, 'verification-failed');
  assert.ok(!calls.some((c) => c.name === 'record_payhip_purchase_safe'),
    'a payload whose amount does not match the provider is never recorded');
});

// ------------------------------------------------------------- redemption

test('16. redemption sends a hash and honours the one-time claim result', async () => {
  const { api, calls } = makeAdmin({
    rpcResults: { redeem_payhip_entitlement_safe: { success: true, duplicate: false, entitlement_id: 3 } }
  });
  const svc = createPayhipEntitlements({ admin: api, config: CFG() });
  const out = await svc.redeem(42, 'AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(out.success, true);
  const call = calls.find((c) => c.name === 'redeem_payhip_entitlement_safe');
  assert.strictEqual(call.args.p_user_id, 42, 'identity is the caller-supplied authenticated id');
  assert.ok(!JSON.stringify(call.args).includes('AAAA-BBBB'));
});

test('17. an unknown or already-claimed key yields a generic refusal', async () => {
  const { api } = makeAdmin({
    rpcResults: { redeem_payhip_entitlement_safe: { success: false, reason: 'invalid_licence' } }
  });
  const svc = createPayhipEntitlements({ admin: api, config: CFG() });
  const out = await svc.redeem(42, 'NOPE');
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.reason, 'invalid_licence');
});

test('18. an unreadable entitlement store fails OPEN (never strands a customer)', async () => {
  const { api } = makeAdmin({ rpcResults: { payhip_has_live_activation: new Error('db down') } });
  const svc = createPayhipEntitlements({ admin: api, config: CFG() });
  const out = await svc.hasActivation(42);
  assert.strictEqual(out, null, 'null (unknown) lets the caller decide, rather than a false lock');
});

test('19. activation status is reported truthfully', async () => {
  const yes = makeAdmin({ rpcResults: { payhip_has_live_activation: true } });
  const no = makeAdmin({ rpcResults: { payhip_has_live_activation: false } });
  assert.strictEqual(await createPayhipEntitlements({ admin: yes.api, config: CFG() }).hasActivation(1), true);
  assert.strictEqual(await createPayhipEntitlements({ admin: no.api, config: CFG() }).hasActivation(1), false);
  assert.strictEqual(await createPayhipEntitlements({ admin: no.api, config: CFG() }).hasActivation(null), false);
});

// ---------------------------------------------------------------- server

test('20. the gates exist and run before any write', () => {
  const bot = SERVER.indexOf("app.post('/api/bot/start'");
  const botGate = SERVER.indexOf('const activation = await getLiveActivationState(userId)', bot);
  const botUpsert = SERVER.indexOf("from('bot_sessions')", bot);
  assert.ok(bot > 0 && botGate > bot, 'the bot gate is inside /api/bot/start');
  assert.ok(botUpsert > botGate, 'the gate precedes the session write');

  const trade = SERVER.indexOf("app.post('/api/trade'");
  const tradeGate = SERVER.indexOf('const activation = await getLiveActivationState(userId)', trade);
  const walletRead = SERVER.indexOf('const wallet = await getWallet(userId)', trade);
  assert.ok(tradeGate > trade && tradeGate < walletRead, 'the trade gate precedes the balance read');

  assert.ok(SERVER.includes('LIVE_ACTIVATION_CODE'), 'the refusal is machine-readable');
  assert.match(SERVER, /code: LIVE_ACTIVATION_CODE/, 'the body carries the code');
});

test('21. the requirement is off by default and funded accounts are grandfathered', () => {
  assert.match(SERVICE, /PAYHIP_ACTIVATION_REQUIRED[\s\S]{0,70}===\s*'true'/, 'opt-in env flag only');
  assert.ok(SERVER.includes('PAYHIP_CONFIG.activationRequired'), 'the server reads the resolved flag');
  assert.ok(SERVICE.includes("activationRequired: get('PAYHIP_ACTIVATION_REQUIRED', '').toLowerCase() === 'true'"),
    'the config reader defaults to false');
  assert.match(SERVER, /hasConfirmedDeposit\(userId\)[\s\S]{0,220}grandfathered-deposit/,
    'an account that already deposited keeps trading');
  assert.match(SERVER, /if \(!PAYHIP_CONFIG\.activationRequired\)[\s\S]{0,120}'not-required'/,
    'the default path returns activated');
  assert.match(SERVER, /held === null[\s\S]{0,160}unknown-fail-open/,
    'an unreadable store fails open');
});

test('22. the webhook path avoids the generic /api/webhook shadow', () => {
  assert.ok(SERVER.includes("app.post('/api/payhip/webhook'"), 'dedicated, unshadowed path');
  assert.ok(!SERVER.includes("app.post('/api/webhook/payhip'"), 'the shadowed path is not used');
  const generic = SERVER.indexOf("app.post('/api/webhook/:provider'");
  const dedicated = SERVER.indexOf("app.post('/api/payhip/webhook'");
  assert.ok(dedicated > generic, 'registered after the generic route and outside its path');
});

test('23. the module references no money path at all', () => {
  const code = SERVICE.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n');
  for (const banned of ['live_balance', 'bonus_balance', 'credit_payment_safe', 'record_trade_safe',
                        'updateWallet', 'transactions', 'wallets']) {
    assert.ok(!code.includes(banned), 'activation must not touch ' + banned);
  }
});

// ------------------------------------------------------------- migration

test('24. migration 050 is additive, service-role only, and self-checking', () => {
  for (const table of ['payhip_products', 'payhip_purchases', 'payhip_entitlements', 'payhip_events']) {
    assert.ok(MIGRATION.includes('CREATE TABLE IF NOT EXISTS public.' + table), table + ' is additive');
    assert.match(MIGRATION, new RegExp('ALTER TABLE public\\.' + table + '\\s+ENABLE ROW LEVEL SECURITY'),
      table + ' has RLS enabled');
  }
  assert.ok(!/TO anon|TO authenticated/.test(MIGRATION), 'no anon/authenticated policy');
  assert.ok(MIGRATION.includes('FOR ALL TO service_role'), 'service-role only');
  assert.match(MIGRATION, /payhip_purchases\s+ENABLE ROW LEVEL SECURITY/, 'RLS enabled on purchases');
  assert.ok(MIGRATION.includes('payhip_sale_id     TEXT NOT NULL UNIQUE'), 'the sale id is the idempotency anchor');
  assert.ok(MIGRATION.includes('licence_key_hash TEXT NOT NULL UNIQUE'), 'one entitlement per key');
  assert.ok(MIGRATION.includes('FOR UPDATE'), 'redemption is row-locked');
  assert.ok(MIGRATION.includes('claimed_by_other_account'), 'transfers are refused');
  assert.ok(MIGRATION.includes('RAISE EXCEPTION'), 'the self-check can fail the migration');
  assert.ok(!/UPDATE public\.wallets|UPDATE public\.transactions/.test(MIGRATION), 'no financial table written');
  assert.ok(!/ALTER TABLE public\.(wallets|users|deposits|withdrawals|trades)\s/.test(MIGRATION),
    'no existing table altered');
});

// ------------------------------------------------------------------ i18n

test('25. the activation copy exists in all six locales with no amount claim', () => {
  const tIdx = INDEX.indexOf('const TRANSLATIONS');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', tIdx); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(INDEX.slice(tIdx, end + 1).replace('const TRANSLATIONS', 'globalThis.T') + ';', sandbox);
  const T = sandbox.T;

  const keys = ['liveActivation.notice', 'liveActivation.cta', 'liveActivation.title',
                'liveActivation.body', 'liveActivation.buy', 'liveActivation.keyLabel',
                'liveActivation.submit', 'liveActivation.hint', 'liveActivation.keyRequired',
                'liveActivation.failed', 'liveActivation.success'];
  for (const l of ['en', 'es', 'pt', 'fr', 'ar', 'zh']) {
    for (const k of keys) {
      assert.ok(T[l][k] && String(T[l][k]).trim().length > 0, l + ' missing ' + k);
      assert.ok(!/\{\{/.test(T[l][k]), l + '/' + k + ' has an unfilled placeholder');
      assert.ok(!/\$\d/.test(T[l][k]), l + '/' + k + ' must not quote an amount');
    }
  }
  // Activation must never be described as adding capital.
  assert.match(T.en['liveActivation.body'], /does not add trading capital/i);
  assert.match(T.en['liveActivation.hint'], /never credits a balance/i);
});
