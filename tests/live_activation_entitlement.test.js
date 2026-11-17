'use strict';

/**
 * Payhip one-time Live Mode activation (Option A).
 *
 * Approved model: a Payhip purchase buys a ONE-TIME software activation
 * entitlement. It never deposits, credits or adds funds. Live Mode requires BOTH
 * a valid activation AND a funded balance, and funding stays a Q8Pay deposit.
 *
 * The contract these tests hold:
 *   - webhook authenticity = hex(sha256(store API key)) (Payhip's documented value)
 *   - evidence            = the licence API's own record, read server-side with
 *                           the product secret; enabled must be true and the
 *                           product must be allow-listed
 *   - one account, one time, enforced by the database
 *   - NO fail-open authorization for a new account, under any failure mode
 *   - existing funded customers are never locked out by a Payhip outage
 *
 * The access-control scenarios execute the REAL resolver extracted from
 * server.js, so they verify behaviour rather than assert about it.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SERVICE = fs.readFileSync(path.join(ROOT, 'services', 'PayhipEntitlements.js'), 'utf8');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '050_payhip_live_activation.sql'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const P = require('../services/PayhipEntitlements');

const API_KEY = 'store-api-key-for-tests-0123456789';
const SIG = crypto.createHash('sha256').update(API_KEY).digest('hex');
const SECRET = 'product-secret-AAA';
const LINK = 'mVT0';

const CFG = (over = {}) => P.resolvePayhipConfig(Object.assign({
  PAYHIP_ENABLED: 'true',
  PAYHIP_PRODUCTS: LINK,
  PAYHIP_API_KEY: API_KEY,
  PAYHIP_PRODUCT_SECRET: SECRET,
  PAYHIP_WEBHOOK_TOKEN: 'w'.repeat(32)
}, over));

// ------------------------------------------------------------------- fakes

function makeAdmin({ rpcResults = {}, rows = {} } = {}) {
  const calls = [];
  const inserted = [];
  const api = {
    from(table) {
      const b = {
        insert(payload) { inserted.push({ table, payload }); return Promise.resolve({ error: null }); },
        upsert(payload) { inserted.push({ table, payload, op: 'upsert' }); return Promise.resolve({ error: null }); },
        select() { return b; },
        order() { return b; },
        limit() { return Promise.resolve({ data: rows[table] || [], error: null }); },
        eq() { return b; },
        single() { return Promise.resolve({ data: (rows[table] || [null])[0] || null, error: null }); }
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
  return { api, calls, inserted };
}

/** A fetch that answers a licence call with a fixed shape. */
function licenceFetch({ status = 200, body = null, throwErr = false } = {}) {
  const seen = [];
  const fn = async (url, opts) => {
    seen.push({ url, headers: (opts && opts.headers) || {} });
    if (throwErr) throw new Error('ECONNRESET');
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.seen = seen;
  return fn;
}

const validLicence = (over = {}) => ({
  data: Object.assign({
    enabled: true,
    product_link: LINK,
    license_key: 'AAAA-BBBB-CCCC-DDDD',
    buyer_email: 'buyer@example.com',
    uses: 0,
    date: '2024-02-22T11:23:05+00:00'
  }, over)
});

const PAID = {
  type: 'paid',
  id: 'SALE-1',
  email: 'Buyer@Example.com',
  currency: 'USD',
  price: 5000,
  stripe_fee: 175,
  payhip_fee: 300,
  signature: SIG,
  items: [{
    product_id: '2804256',
    product_key: LINK,
    product_permalink: 'https://payhip.com/b/' + LINK,
    license_key: 'AAAA-BBBB-CCCC-DDDD'
  }]
};

// ------------------------------------------------ real function extraction

/** Extract a top-level `[async] function name(...) { ... }` block by brace count. */
function extractFn(source, name) {
  let start = source.indexOf('async function ' + name + '(');
  if (start < 0) start = source.indexOf('function ' + name + '(');
  assert.ok(start > 0, 'could not find function ' + name);
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces extracting ' + name);
}

/**
 * Run the REAL getLiveActivationState with injected dependencies.
 * hasActivation: true | false | null (null = entitlement store unreadable)
 */
function runActivation({ activationRequired = true, environment = 'PRODUCTION',
                         hasDeposit = false, hasActivation = false } = {}) {
  const fn = extractFn(SERVER, 'getLiveActivationState');
  const sandbox = {
    PAYHIP_CONFIG: { activationRequired },
    ENV_MARKETING_SANDBOX: 'MARKETING_SANDBOX',
    supabaseAdmin: {
      from() {
        const b = {
          select() { return b; },
          eq() { return b; },
          single() { return Promise.resolve({ data: { environment }, error: null }); }
        };
        return b;
      }
    },
    hasConfirmedDeposit: async () => hasDeposit,
    payhipEntitlements: { hasActivation: async () => hasActivation }
  };
  vm.createContext(sandbox);
  vm.runInContext(fn + '\nglobalThis.fn = getLiveActivationState;', sandbox);
  return sandbox.fn(7);
}

/** Run the REAL sendActivationRefusal against a fake response object. */
function runRefusal(state) {
  const fn = extractFn(SERVER, 'sendActivationRefusal');
  const bodyFn = extractFn(SERVER, 'liveActivationBody');
  const res = { headers: {}, statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  const sandbox = { LIVE_ACTIVATION_CODE: 'LIVE_ACTIVATION_REQUIRED' };
  vm.createContext(sandbox);
  vm.runInContext(bodyFn + '\n' + fn + '\nglobalThis.f = sendActivationRefusal;', sandbox);
  sandbox.f(res, state);
  return res;
}

// ============================================================ configuration

test('1. inert by default: no flag means no gate and no processing', () => {
  const c = P.resolvePayhipConfig({});
  assert.strictEqual(c.enabled, false);
  assert.strictEqual(c.usable, false);
  assert.strictEqual(c.reason, 'disabled');
  assert.strictEqual(c.activationRequired, false, 'Live Mode is NOT gated until opted in');
  assert.strictEqual(c.redeemUsable, false);
  const d = P.describePayhipConfig(c);
  assert.strictEqual(d.signatureVerification, 'not-configured');
  assert.strictEqual(d.productSecretCount, 0);
});

test('2. the webhook is usable only with products AND a signature key', () => {
  assert.strictEqual(CFG().usable, true);
  assert.strictEqual(CFG({ PAYHIP_PRODUCTS: '' }).reason, 'no-products-configured');
  // Without the API key the documented signature cannot be checked, so the
  // webhook is refused rather than accepted unverified.
  assert.strictEqual(CFG({ PAYHIP_API_KEY: '' }).reason, 'missing-api-key');
  assert.strictEqual(CFG({ PAYHIP_ENABLED: 'nope' }).enabled, false);
});

test('3. redemption additionally requires a product secret', () => {
  const noSecret = CFG({ PAYHIP_PRODUCT_SECRET: '' });
  assert.strictEqual(noSecret.usable, true, 'the webhook can still run');
  assert.strictEqual(noSecret.redeemUsable, false, 'but a licence can never be granted');
  assert.strictEqual(CFG().redeemUsable, true);
});

test('4. allow-list and per-product secrets are parsed, and never described', () => {
  const c = P.resolvePayhipConfig({
    PAYHIP_ENABLED: 'true',
    PAYHIP_API_KEY: API_KEY,
    PAYHIP_PRODUCTS: ' Live-Activation , second ',
    PAYHIP_PRODUCT_SECRETS: 'live-activation=s1, second=s2'
  });
  assert.ok(c.products.has('live-activation'));
  assert.ok(c.products.has('second'));
  assert.strictEqual(c.productSecrets.get('live-activation'), 's1');
  assert.strictEqual(c.productSecrets.get('second'), 's2');

  const described = JSON.stringify(P.describePayhipConfig(c));
  assert.ok(!described.includes('s1') && !described.includes('s2'), 'secrets never appear in describe()');
  assert.ok(!described.includes(API_KEY), 'the API key never appears in describe()');
});

// ================================================================ signature

test('5. the documented signature is hex sha256 of the store API key', () => {
  assert.strictEqual(P.expectedWebhookSignature(API_KEY), SIG);
  assert.strictEqual(P.expectedWebhookSignature(''), null, 'no key means no expected value');
});

test('6. signature verification fails closed', () => {
  assert.strictEqual(P.verifyWebhookSignature(API_KEY, SIG), true);
  assert.strictEqual(P.verifyWebhookSignature(API_KEY, SIG.toUpperCase()), true, 'case tolerant');
  assert.strictEqual(P.verifyWebhookSignature(API_KEY, SIG.replace(/.$/, '0')), false, 'mismatch');
  assert.strictEqual(P.verifyWebhookSignature(API_KEY, SIG.slice(0, -1)), false, 'truncated');
  assert.strictEqual(P.verifyWebhookSignature(API_KEY, ''), false);
  assert.strictEqual(P.verifyWebhookSignature(API_KEY, undefined), false);
  assert.strictEqual(P.verifyWebhookSignature('', SIG), false, 'an unset key never authorises');
  assert.strictEqual(P.verifyWebhookSignature(null, SIG), false);
});

test('7. a webhook with a missing or bad signature records nothing', async () => {
  for (const sig of [undefined, '', 'deadbeef', SIG.slice(0, 20)]) {
    const a = makeAdmin();
    const svc = P.createPayhipEntitlements({ admin: a.api, config: CFG(), fetchImpl: licenceFetch({}) });
    const out = await svc.handleWebhook(Object.assign({}, PAID, { signature: sig }));
    assert.strictEqual(out.outcome, 'signature-invalid', 'signature ' + sig);
    assert.ok(!a.calls.some((c) => c.name === 'record_payhip_purchase_safe'),
      'a forged payload must never reach the purchase RPC');
    assert.ok(!a.inserted.some((i) => i.table === 'payhip_purchases'), 'no purchase row');
  }
});

// ================================================================ licence API

test('8. a verified licence reports its own authoritative state', async () => {
  const f = licenceFetch({ body: validLicence() });
  const svc = P.createPayhipEntitlements({ admin: makeAdmin().api, config: CFG(), fetchImpl: f });
  const v = await svc.verifyLicence('AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(v.status, 'valid');
  assert.strictEqual(v.enabled, true);
  assert.strictEqual(v.productLink, LINK);
  assert.strictEqual(v.buyerEmail, 'buyer@example.com');
  assert.strictEqual(v.uses, 0);

  const call = f.seen[0];
  assert.match(call.url, /\/license\/verify\?license_key=AAAA-BBBB-CCCC-DDDD$/);
  assert.strictEqual(call.headers['product-secret-key'], SECRET, 'the product secret authenticates');
});

test('9. an empty response means INVALID, which differs from an outage', async () => {
  const svc = P.createPayhipEntitlements({
    admin: makeAdmin().api, config: CFG(), fetchImpl: licenceFetch({ body: {} })
  });
  const v = await svc.verifyLicence('NOPE-NOPE-NOPE-NOPE');
  assert.strictEqual(v.status, 'invalid');
});

test('10. a provider failure is UNAVAILABLE, never "invalid"', async () => {
  for (const opts of [{ status: 500, body: null }, { status: 429, body: null }, { throwErr: true }]) {
    const svc = P.createPayhipEntitlements({
      admin: makeAdmin().api, config: CFG(), fetchImpl: licenceFetch(opts)
    });
    const v = await svc.verifyLicence('AAAA-BBBB-CCCC-DDDD');
    assert.strictEqual(v.status, 'unavailable', JSON.stringify(opts));
  }
});

test('11. without a product secret nothing can be verified', async () => {
  const svc = P.createPayhipEntitlements({
    admin: makeAdmin().api,
    config: CFG({ PAYHIP_PRODUCT_SECRET: '' }),
    fetchImpl: licenceFetch({ body: validLicence() })
  });
  const v = await svc.verifyLicence('AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(v.status, 'unavailable');
});

test('12. multiple product secrets are tried in order', async () => {
  const seenSecrets = [];
  const fetchImpl = async (url, opts) => {
    seenSecrets.push(opts.headers['product-secret-key']);
    const good = opts.headers['product-secret-key'] === 'second-secret';
    return { ok: true, status: 200, json: async () => (good ? validLicence() : {}) };
  };
  const svc = P.createPayhipEntitlements({
    admin: makeAdmin().api,
    config: P.resolvePayhipConfig({
      PAYHIP_ENABLED: 'true', PAYHIP_API_KEY: API_KEY, PAYHIP_PRODUCTS: LINK,
      PAYHIP_PRODUCT_SECRETS: 'wrong-secret,second-secret'
    }),
    fetchImpl
  });
  const v = await svc.verifyLicence('AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(v.status, 'valid');
  assert.deepStrictEqual(seenSecrets, ['wrong-secret', 'second-secret']);
});

// ========================================================= webhook handling

test('13. a signed, allow-listed paid sale records a hashed, redacted purchase', async () => {
  const a = makeAdmin({ rpcResults: { record_payhip_purchase_safe: { success: true, duplicate: false } } });
  const svc = P.createPayhipEntitlements({ admin: a.api, config: CFG(), fetchImpl: licenceFetch({}) });
  const out = await svc.handleWebhook(PAID);
  assert.strictEqual(out.outcome, 'recorded');
  const call = a.calls.find((c) => c.name === 'record_payhip_purchase_safe');
  assert.strictEqual(call.args.p_sale_id, 'SALE-1');
  assert.strictEqual(call.args.p_price_cents, 5000, 'amounts are cents');
  assert.match(call.args.p_licence_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(call.args).includes('AAAA-BBBB'), 'raw key never persisted');
  assert.strictEqual(call.args.p_payload.items[0].product_key, LINK, 'non-secret fields survive');
});

test('14. a replayed webhook is idempotent', async () => {
  const a = makeAdmin({ rpcResults: { record_payhip_purchase_safe: { success: true, duplicate: true } } });
  const svc = P.createPayhipEntitlements({ admin: a.api, config: CFG(), fetchImpl: licenceFetch({}) });
  const out = await svc.handleWebhook(PAID);
  assert.strictEqual(out.outcome, 'duplicate');
  assert.strictEqual(a.calls.filter((c) => c.name === 'record_payhip_purchase_safe').length, 1);
});

test('15. a product that is not allow-listed is refused', async () => {
  const a = makeAdmin();
  const svc = P.createPayhipEntitlements({ admin: a.api, config: CFG(), fetchImpl: licenceFetch({}) });
  const out = await svc.handleWebhook(Object.assign({}, PAID, {
    items: [{ product_id: '999', product_key: 'other', license_key: 'X' }]
  }));
  assert.strictEqual(out.outcome, 'product-not-allowed');
  assert.ok(!a.calls.some((c) => c.name === 'record_payhip_purchase_safe'));
});

test('16. a paid sale with no licence key records nothing', async () => {
  const a = makeAdmin();
  const svc = P.createPayhipEntitlements({ admin: a.api, config: CFG(), fetchImpl: licenceFetch({}) });
  const out = await svc.handleWebhook(Object.assign({}, PAID, {
    items: [{ product_id: '2804256', product_key: LINK }]
  }));
  assert.strictEqual(out.outcome, 'no-licence-key');
  assert.ok(!a.calls.some((c) => c.name === 'record_payhip_purchase_safe'));
});

test('17. a refund revokes; unrelated events are ignored', async () => {
  const a = makeAdmin({ rpcResults: { revoke_payhip_entitlement_safe: { success: true, status: 'refunded' } } });
  const svc = P.createPayhipEntitlements({ admin: a.api, config: CFG(), fetchImpl: licenceFetch({}) });
  const out = await svc.handleWebhook(Object.assign({}, PAID, { type: 'refunded', amount_refunded: 5000 }));
  assert.strictEqual(out.outcome, 'revoked');
  const call = a.calls.find((c) => c.name === 'revoke_payhip_entitlement_safe');
  assert.strictEqual(call.args.p_sale_id, 'SALE-1');
  assert.strictEqual(call.args.p_status, 'refunded');

  const b = makeAdmin();
  const svc2 = P.createPayhipEntitlements({ admin: b.api, config: CFG(), fetchImpl: licenceFetch({}) });
  const out2 = await svc2.handleWebhook({ type: 'subscription.created', id: 'S', signature: SIG });
  assert.match(out2.outcome, /^ignored:/);
  assert.strictEqual(b.calls.length, 0);
});

// ============================================== ACCESS CONTROL (executed)

test('18. new user WITHOUT activation: Live Mode denied (403)', async () => {
  const state = await runActivation({ hasActivation: false, hasDeposit: false });
  assert.strictEqual(state.activated, false);
  assert.strictEqual(state.reason, 'activation-required');
  const res = runRefusal(state);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.payload.code, 'LIVE_ACTIVATION_REQUIRED');
  assert.strictEqual(res.payload.retryable, false);
});

test('19. valid activation but no funding: entry refused at the funding gate', () => {
  // The resolver proves permission; funding is a separate gate that runs after it.
  // Activation must never be accepted as funding.
  assert.match(SERVER, /code: 'LIVE_FUNDING_REQUIRED'/);
  assert.match(SERVER, /fundingRequired: true/);
  assert.match(SERVER, /if \(liveBalance <= 0\)/);
  assert.match(SERVER, /const liveBalance = fundingWallet \? \(Number\(fundingWallet\.live_balance\) \|\| 0\) : 0;/);
  // A PRESENCE check only: no minimum trading amount is re-introduced.
  assert.ok(!/liveBalance\s*<\s*\d/.test(SERVER), 'no numeric minimum may appear');
});

test('20. valid activation with funds but NO deposit is allowed (promo-credit case)', async () => {
  // This is the branch that proves activation itself grants permission: no
  // confirmed deposit, so the grandfather shortcut cannot be what allowed it.
  const state = await runActivation({ hasActivation: true, hasDeposit: false });
  assert.strictEqual(state.activated, true);
  assert.strictEqual(state.reason, 'licensed');
});

test('20b. valid activation AND a qualifying deposit is allowed', async () => {
  // A funded account short-circuits to the grandfather branch first; the outcome
  // is the same (allowed) and the funding gate is evaluated separately.
  const state = await runActivation({ hasActivation: true, hasDeposit: true });
  assert.strictEqual(state.activated, true);
  assert.ok(['licensed', 'grandfathered-deposit'].includes(state.reason));
});

test('21. a confirmed deposit NEVER satisfies activation (no grandfathering)', async () => {
  // Approved model: the $50 activation and the $100 deposit are independent.
  // A deposit must not unlock Live Mode, so a funded account with no
  // entitlement is refused - there is no deposit-based branch left to hit.
  const state = await runActivation({ hasActivation: false, hasDeposit: true });
  assert.strictEqual(state.activated, false);
  assert.strictEqual(state.reason, 'activation-required');
  assert.strictEqual(state.exempt, false);
  assert.ok(!SERVER.includes('grandfathered-deposit'), 'the exemption must be gone from the resolver');
});

test('22. a Payhip outage FAILS CLOSED, for funded accounts too', async () => {
  // With no deposit branch to bypass the lookup, an unreadable entitlement store
  // is an unproven entitlement - a retryable refusal, never an unlock. The deposit
  // fact is irrelevant to this decision by design.
  const state = await runActivation({ hasActivation: null, hasDeposit: true });
  assert.strictEqual(state.activated, false);
  assert.strictEqual(state.reason, 'activation-unavailable');
  assert.strictEqual(state.retryable, true);
});

test('23. an UNREADABLE entitlement store denies a new user (no fail-open)', async () => {
  const state = await runActivation({ hasActivation: null, hasDeposit: false });
  assert.strictEqual(state.activated, false, 'unknown must never mean activated');
  assert.strictEqual(state.reason, 'activation-unavailable');
  assert.strictEqual(state.retryable, true);

  const res = runRefusal(state);
  assert.strictEqual(res.statusCode, 503, 'retryable, not a permanent refusal');
  assert.strictEqual(res.payload.code, 'ACTIVATION_UNAVAILABLE');
});

test('24. invalid licence: redemption denied and nothing is claimed', async () => {
  const a = makeAdmin({ rpcResults: { redeem_payhip_entitlement_safe: { success: true } } });
  const svc = P.createPayhipEntitlements({
    admin: a.api, config: CFG(), fetchImpl: licenceFetch({ body: {} })
  });
  const out = await svc.redeem(42, 'FAKE-KEY');
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.reason, 'invalid-licence');
  assert.ok(!a.calls.some((c) => c.name === 'redeem_payhip_entitlement_safe'),
    'an unverified key must never reach the claim function');
});

test('25a. a REAL licence we have no sale record for is not called "invalid"', async () => {
  // Payhip verified the key (enabled, allow-listed) but the database has no
  // entitlement - i.e. the paid webhook never landed (Payhip retries for 3 hours)
  // or the DB was down when it did. The buyer must be told the truth: retry.
  const a = makeAdmin({
    rpcResults: { redeem_payhip_entitlement_safe: { success: false, reason: 'invalid_licence' } }
  });
  const svc = P.createPayhipEntitlements({
    admin: a.api, config: CFG(), fetchImpl: licenceFetch({ body: validLicence() })
  });
  const out = await svc.redeem(42, 'AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(out.success, false, 'nothing is granted without a recorded sale');
  assert.strictEqual(out.reason, 'not-recorded');
  assert.strictEqual(out.retryable, true, 'a later retry can succeed once the webhook lands');
  assert.ok(a.calls.some((c) => c.name === 'redeem_payhip_entitlement_safe'),
    'the claim function was still consulted (it is the authority)');
  const event = a.inserted.find((i) => i.table === 'payhip_events' && i.payload.outcome === 'not-recorded');
  assert.ok(event, 'operators can see this in payhip_events instead of a misleading refusal');
  // and the customer-facing string explains what to do
  assert.match(SERVER, /'not-recorded': '[^']*confirming your purchase/);
  assert.ok(!/\bnot-recorded\b[^\n]*invalid/i.test(SERVER), 'never described as an invalid key');
});

test('25b. an unknown key is still reported as invalid, and reaches no claim', async () => {
  const a = makeAdmin({ rpcResults: { redeem_payhip_entitlement_safe: { success: true } } });
  const svc = P.createPayhipEntitlements({
    admin: a.api, config: CFG(), fetchImpl: licenceFetch({ body: {} })
  });
  const out = await svc.redeem(42, 'NOPE-NOPE');
  assert.strictEqual(out.reason, 'invalid-licence', 'the provider says this key does not exist');
  assert.ok(!a.calls.some((c) => c.name === 'redeem_payhip_entitlement_safe'));
});

test('25. a reused licence is refused for the second account by the database', async () => {
  const a = makeAdmin({
    rpcResults: { redeem_payhip_entitlement_safe: { success: false, reason: 'claimed_by_other_account' } }
  });
  const svc = P.createPayhipEntitlements({
    admin: a.api, config: CFG(), fetchImpl: licenceFetch({ body: validLicence() })
  });
  const out = await svc.redeem(99, 'AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.reason, 'claimed_by_other_account');
  // The one-account rule is a row lock in migration 050, not a service check.
  assert.match(MIGRATION, /FOR UPDATE/);
  assert.match(MIGRATION, /claimed_by_other_account/);
});

test('25c. the browser tells a real-but-unconfirmed buyer the truth, in their language', () => {
  // The refusal is rendered from the reason, not from the English server string:
  // every locale has its own sentence.
  assert.match(INDEX, /const confirming = data\.reason === 'not-recorded';/);
  assert.match(INDEX, /confirming\s*\n\s*\? t\('liveActivation\.confirming'\)/);

  const i = INDEX.indexOf('const TRANSLATIONS');
  const start = INDEX.indexOf('{', i);
  let depth = 0;
  let end = -1;
  for (let k = start; k < INDEX.length; k++) {
    if (INDEX[k] === '{') depth++;
    else if (INDEX[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  const sb = {};
  vm.createContext(sb);
  vm.runInContext('this.T = ' + INDEX.slice(start, end + 1), sb);
  const T = sb.T;
  for (const lang of ['en', 'es', 'pt', 'fr', 'ar', 'zh']) {
    const v = T[lang] && T[lang]['liveActivation.confirming'];
    assert.ok(typeof v === 'string' && v.trim().length > 20, lang + ' has a confirming message');
    assert.ok(!/not valid/i.test(v), lang + ' never calls a real purchase invalid');
    if (lang === 'ar') assert.match(v, /[\u0600-\u06FF]/, 'Arabic is written in Arabic script');
  }
});

test('26. a disabled or refunded licence is refused', async () => {
  const a = makeAdmin();
  const svc = P.createPayhipEntitlements({
    admin: a.api, config: CFG(), fetchImpl: licenceFetch({ body: validLicence({ enabled: false }) })
  });
  const out = await svc.redeem(42, 'AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.reason, 'licence-disabled');
  assert.ok(!a.calls.some((c) => c.name === 'redeem_payhip_entitlement_safe'));
});

test('27. a licence for a different product is refused', async () => {
  const a = makeAdmin();
  const svc = P.createPayhipEntitlements({
    admin: a.api, config: CFG(), fetchImpl: licenceFetch({ body: validLicence({ product_link: 'OTHER' }) })
  });
  const out = await svc.redeem(42, 'AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(out.reason, 'wrong-product');
  assert.ok(!a.calls.some((c) => c.name === 'redeem_payhip_entitlement_safe'));
});

test('28. a Payhip outage during redemption denies, retryably, and claims nothing', async () => {
  const a = makeAdmin();
  const svc = P.createPayhipEntitlements({
    admin: a.api, config: CFG(), fetchImpl: licenceFetch({ throwErr: true })
  });
  const out = await svc.redeem(42, 'AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.reason, 'unavailable');
  assert.strictEqual(out.retryable, true);
  assert.ok(!a.calls.some((c) => c.name === 'redeem_payhip_entitlement_safe'));
});

test('29. redemption without a configured secret cannot grant anything', async () => {
  const a = makeAdmin();
  const svc = P.createPayhipEntitlements({
    admin: a.api,
    config: CFG({ PAYHIP_PRODUCT_SECRET: '' }),
    fetchImpl: licenceFetch({ body: validLicence() })
  });
  const out = await svc.redeem(42, 'AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.reason, 'unavailable');
});

test('30. a valid licence for an allow-listed product is claimed once', async () => {
  const a = makeAdmin({
    rpcResults: { redeem_payhip_entitlement_safe: { success: true, duplicate: false } }
  });
  const svc = P.createPayhipEntitlements({
    admin: a.api, config: CFG(), fetchImpl: licenceFetch({ body: validLicence() })
  });
  const out = await svc.redeem(42, 'AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(out.success, true);
  const call = a.calls.find((c) => c.name === 'redeem_payhip_entitlement_safe');
  assert.strictEqual(call.args.p_user_id, 42, 'identity comes from the authenticated caller');
  assert.match(call.args.p_licence_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(call.args).includes('AAAA-BBBB'));
});

test('31. verification attempts are throttled per account', async () => {
  const svc = P.createPayhipEntitlements({
    admin: makeAdmin().api, config: CFG(), fetchImpl: licenceFetch({ body: {} })
  });
  let last = null;
  for (let i = 0; i < 12; i++) last = await svc.redeem(7, 'KEY-' + i);
  assert.strictEqual(last.success, false);
  assert.strictEqual(last.reason, 'too-many-attempts');
  assert.ok(last.retryAfterMs > 0);
});

test('32. MARKETING_SANDBOX never needs an activation', async () => {
  const state = await runActivation({
    environment: 'MARKETING_SANDBOX', hasActivation: false, hasDeposit: false
  });
  assert.strictEqual(state.activated, true);
  assert.strictEqual(state.reason, 'sandbox');
});

test('33. with the requirement off, nothing is gated at all', async () => {
  const state = await runActivation({ activationRequired: false, hasActivation: false, hasDeposit: false });
  assert.strictEqual(state.activated, true);
  assert.strictEqual(state.reason, 'not-required');
});

// ============================================================= server wiring

test('34. both Live Mode gates run before any write', () => {
  const bot = SERVER.indexOf("app.post('/api/bot/start'");
  const botGate = SERVER.indexOf('const eligibility = await getLiveModeEligibility(userId)', bot);
  const botUpsert = SERVER.indexOf("from('bot_sessions')", bot);
  assert.ok(botGate > bot && botUpsert > botGate, 'eligibility gate precedes the session write');

  const trade = SERVER.indexOf("app.post('/api/trade'");
  const tradeGate = SERVER.indexOf('const eligibility = await getLiveModeEligibility(userId)', trade);
  const walletRead = SERVER.indexOf('const wallet = await getWallet(userId)', trade);
  assert.ok(tradeGate > trade && tradeGate < walletRead, 'eligibility gate precedes the balance read');
});

test('35. a rejected webhook answers 401 rather than a silent 200', () => {
  assert.ok(SERVER.includes("res.status(401).json({ ok: false, error: 'invalid_signature' })"));
  assert.ok(SERVER.includes("app.post('/api/payhip/webhook'"), 'dedicated, unshadowed path');
  assert.ok(!SERVER.includes("app.post('/api/webhook/payhip'"));
});

test('36. the module can never move money', () => {
  const code = SERVICE.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n');
  for (const banned of ['live_balance', 'bonus_balance', 'credit_payment_safe', 'record_trade_safe',
                        'updateWallet', 'wallets', 'transactions']) {
    assert.ok(!code.includes(banned), 'activation must not reference ' + banned);
  }
});

test('37. migration 050 is additive, service-role only and self-checking', () => {
  for (const t of ['payhip_products', 'payhip_purchases', 'payhip_entitlements', 'payhip_events']) {
    assert.ok(MIGRATION.includes('CREATE TABLE IF NOT EXISTS public.' + t), t + ' is additive');
  }
  assert.ok(!/TO anon|TO authenticated/.test(MIGRATION), 'no anon/authenticated policy');
  assert.ok(MIGRATION.includes('payhip_sale_id     TEXT NOT NULL UNIQUE'), 'sale id is the idempotency anchor');
  assert.ok(MIGRATION.includes('licence_key_hash TEXT NOT NULL UNIQUE'), 'one entitlement per key');
  assert.ok(MIGRATION.includes('RAISE EXCEPTION'), 'the self-check can fail the migration');
  assert.ok(!/UPDATE public\.wallets|UPDATE public\.transactions/.test(MIGRATION), 'no financial table written');
  assert.ok(!/ALTER TABLE public\.(wallets|users|deposits|withdrawals|trades)\s/.test(MIGRATION));
});

// ====================================================================== i18n

test('38. the activation copy exists in all six locales and promises no capital', () => {
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
  assert.match(T.en['liveActivation.body'], /does not add trading capital/i);
  assert.match(T.en['liveActivation.hint'], /never credits a balance/i);
});
