/**
 * Deposit funding options: verified human partner directory + the
 * disabled-by-default card-to-crypto switch.
 *
 * These tests pin the security and behaviour contracts that matter:
 *   - only ACTIVE + VERIFIED partners are ever exposed to a customer;
 *   - a Telegram handle is validated server-side and the link is BUILT by the
 *     server, so an administrator cannot store an arbitrary URL;
 *   - the card option cannot be enabled by an environment variable alone;
 *   - the partner experience never creates an invoice, never credits a balance
 *     and never becomes a second deposit-verification path;
 *   - the existing deposit rules (minimum $100, USDT/TRC20, atomic crediting)
 *     are untouched.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SERVER = read('server.js');
const INDEX = read('public/index.html');
const MIGRATION = read('supabase/migrations/045_deposit_partners.sql');

const partners = require('../services/DepositPartners');
const card = require('../services/CardPayments');

// ---------------------------------------------------------------- partner module

test('telegram handles: @name, name, t.me/... and full URLs normalize to one value', () => {
  const cases = [
    '@Arbitrix_CSA1', 'Arbitrix_CSA1', 'arbitrix_csa1',
    't.me/Arbitrix_CSA1', 'https://t.me/Arbitrix_CSA1', 'https://t.me/Arbitrix_CSA1/'
  ];
  for (const raw of cases) {
    const result = partners.normalizeTelegramUsername(raw);
    assert.strictEqual(result.ok, true, raw);
    assert.strictEqual(result.username, 'arbitrix_csa1', raw);
  }
});

test('telegram handles: arbitrary URLs, paths, schemes and junk are rejected', () => {
  const bad = [
    '', '   ', null, undefined, 42,
    'https://evil.example.com/Arbitrix', 'http://t.me.evil.com/x',
    't.me/ab', 'a'.repeat(40), 'has space', 'user-name', 't.me/name?x=1',
    'javascript:alert(1)', '@', 'name<'
  ];
  for (const raw of bad) {
    assert.strictEqual(partners.normalizeTelegramUsername(raw).ok, false, String(raw));
  }
});

test('telegram links are always built on t.me, never taken from input', () => {
  assert.strictEqual(partners.telegramProfileUrl('Arbitrix_CSA1'), 'https://t.me/arbitrix_csa1');
  assert.strictEqual(partners.telegramProfileUrl('https://evil.example.com/x'), null);
  assert.strictEqual(partners.telegramProfileUrl(null), null);
});

test('display name and list sanitizers reject markup and runaway input', () => {
  const cleaned = partners.sanitizeDisplayName('  <b>Tunde</b>  ');
  assert.strictEqual(cleaned.ok, true);
  assert.strictEqual(cleaned.value, 'b Tunde /b');
  assert.ok(!cleaned.value.includes('<'));
  assert.strictEqual(partners.sanitizeDisplayName('x'.repeat(61)).ok, false);
  assert.deepStrictEqual(partners.sanitizeList('Nigeria, South Africa ,nigeria').items, ['Nigeria', 'South Africa']);
  assert.strictEqual(partners.sanitizeList('x'.repeat(41)).ok, false);
  assert.strictEqual(partners.parseDisplayOrder('abc'), 100);
  assert.strictEqual(partners.parseDisplayOrder(-5), 0);
});

test('only ACTIVE and VERIFIED partners are customer-visible', () => {
  const row = (over) => Object.assign({
    id: 1, display_name: 'Partner', telegram_username: 'arbitrix_csa1',
    services: ['direct_sale'], serves_worldwide: false,
    countries: ['Nigeria'], payment_methods: ['Bank transfer'],
    is_active: true, is_verified: true, display_order: 100,
    created_at: 'secret', updated_at: 'secret'
  }, over || {});

  const visible = partners.toPublicPartner(row());
  assert.ok(visible);
  assert.strictEqual(visible.telegramUrl, 'https://t.me/arbitrix_csa1');

  assert.strictEqual(partners.toPublicPartner(row({ is_active: false })), null, 'inactive hidden');
  assert.strictEqual(partners.toPublicPartner(row({ is_verified: false })), null, 'unverified hidden');
  assert.strictEqual(partners.toPublicPartner(row({ telegram_username: 'not a handle' })), null, 'corrupt handle hidden');

  // Administrative fields are never exposed.
  for (const forbidden of ['id', 'created_at', 'updated_at', 'is_active', 'is_verified', 'display_order']) {
    assert.ok(!(forbidden in visible), 'public projection must not expose ' + forbidden);
  }
});

test('public list ordering follows display_order then name', () => {
  const rows = [
    { id: 1, display_name: 'Zeta', telegram_username: 'zeta_partner', services: ['direct_sale'], serves_worldwide: true, is_active: true, is_verified: true, display_order: 20 },
    { id: 2, display_name: 'Alpha', telegram_username: 'alpha_partner', services: ['guided_assistance'], serves_worldwide: true, is_active: true, is_verified: true, display_order: 10 },
    { id: 3, display_name: 'Beta', telegram_username: 'beta_partner', services: ['direct_sale'], serves_worldwide: true, is_active: false, is_verified: true, display_order: 1 }
  ];
  const list = partners.toPublicPartnerList(rows);
  assert.deepStrictEqual(list.map((p) => p.displayName), ['Alpha', 'Zeta']);
  assert.deepStrictEqual(partners.toPublicPartnerList(null), []);
});

// ---------------------------------------------------------------- card switch

test('card payments are disabled by default and cannot be enabled by a flag alone', () => {
  assert.deepStrictEqual(card.APPROVED_CARD_PROVIDERS, [], 'no provider is approved');

  assert.strictEqual(card.resolveCardPaymentConfig({}).enabled, false);
  assert.strictEqual(card.resolveCardPaymentConfig({ CARD_PAYMENTS_ENABLED: 'true' }).reason, 'no-provider');
  assert.strictEqual(
    card.resolveCardPaymentConfig({ CARD_PAYMENTS_ENABLED: 'true', CARD_PAYMENT_PROVIDER: 'transak' }).enabled,
    false,
    'an unapproved provider must fail closed'
  );
  assert.strictEqual(
    card.resolveCardPaymentConfig({ CARD_PAYMENTS_ENABLED: 'true', CARD_PAYMENT_PROVIDER: 'transak' }).reason,
    'provider-not-approved'
  );
});

test('card config exposes no credential and only USDT/TRC20', () => {
  const cfg = card.resolveCardPaymentConfig({ CARD_PAYMENTS_ENABLED: 'true', CARD_PAYMENT_PROVIDER: 'x' });
  assert.deepStrictEqual(Object.keys(cfg).sort(), ['asset', 'enabled', 'network', 'provider', 'reason']);
  assert.strictEqual(cfg.asset, 'USDT');
  assert.strictEqual(cfg.network, 'TRC20');
  assert.ok(!JSON.stringify(cfg).toLowerCase().includes('api_key'));
  assert.strictEqual(card.isSupportedCardAsset('USDT', 'TRC20'), true);
  assert.strictEqual(card.isSupportedCardAsset('USDT', 'ERC20'), false, 'no extra network without approval');
});

// ---------------------------------------------------------------- server wiring

test('the customer options route is authenticated and never touches money', () => {
  const route = SERVER.slice(
    SERVER.indexOf("app.get('/api/deposit/options'"),
    SERVER.indexOf("app.get('/api/deposit/options'") + 2600
  );
  assert.ok(route.includes('authMiddleware'), 'customers must be authenticated');
  assert.ok(!route.includes('createInvoice'), 'must not create an invoice');
  assert.ok(!route.includes('paymentService'), 'must not reach a provider');
  assert.ok(!route.includes('rpc('), 'must not call a credit RPC');
  assert.ok(route.includes("res.set('Cache-Control', 'no-store')"), 'no caching of per-user options');
  assert.ok(route.includes('PLATFORM_MIN_DEPOSIT_USD'), 'minimum comes from the single source');
});

test('every admin partner route requires auth AND admin', () => {
  const routes = [
    ["app.get('/api/admin/deposit-partners'", 'GET'],
    ["app.post('/api/admin/deposit-partners'", 'POST'],
    ["app.put('/api/admin/deposit-partners/:id'", 'PUT'],
    ["app.delete('/api/admin/deposit-partners/:id'", 'DELETE']
  ];
  for (const [needle] of routes) {
    const i = SERVER.indexOf(needle);
    assert.ok(i > 0, 'route missing: ' + needle);
    const line = SERVER.slice(i, SERVER.indexOf('\n', i));
    assert.ok(line.includes('authMiddleware') && line.includes('adminMiddleware'), needle + ' must be admin-gated');
  }
});

test('admin writes validate the Telegram handle server-side and default to hidden', () => {
  const create = SERVER.slice(
    SERVER.indexOf("app.post('/api/admin/deposit-partners'"),
    SERVER.indexOf("app.put('/api/admin/deposit-partners/:id'")
  );
  assert.ok(create.includes('buildDepositPartnerPayload'), 'payload is validated');
  assert.ok(create.includes('is_active: false'), 'a new partner is not activated implicitly');
  assert.ok(create.includes('is_verified: false'), 'a new partner is not verified implicitly');
  assert.ok(!/req\.body\.(is_admin|role)/.test(create), 'no client-controlled privileges');
});

test('the partner directory cannot become a deposit-verification path', () => {
  const slice = SERVER.slice(
    SERVER.indexOf("app.get('/api/deposit/options'"),
    SERVER.indexOf("app.get('/api/payment/health'")
  );
  for (const forbidden of ['live_balance', 'record_trade_safe', 'credit_payment_safe', 'deposits', 'withdrawals']) {
    assert.ok(!slice.includes(forbidden), 'partner/deposit-options block must not touch ' + forbidden);
  }
});

test('existing deposit rules are unchanged by this feature', () => {
  assert.ok(SERVER.includes('const PLATFORM_MIN_DEPOSIT_USD = 100;'));
  assert.ok(SERVER.includes("if (!amount || typeof amount !== 'number' || amount < MIN_DEPOSIT_AMOUNT)"));
  const paymentService = read('services/PaymentService.js');
  assert.ok(paymentService.includes('confirm_payment_with_credit'), 'provider credit RPC intact');
  assert.ok(paymentService.includes("rpc('confirm_payment_with_credit'"), 'atomic credit still used');
  assert.ok(SERVER.includes('credit_payment_safe'), 'q8qpay credit path intact');
  assert.ok(SERVER.includes("status: 'pending'"), 'deposit rows still insert as pending');
});

// ---------------------------------------------------------------- migration

test('migration 045: additive, idempotent and self-checking', () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS public\.deposit_partners/.test(MIGRATION));
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS deposit_partners_telegram_username_key/.test(MIGRATION));
  assert.ok(/CHECK \(telegram_username ~ '\^\[a-z\]\[a-z0-9_\]\{4,31\}\$'\)/.test(MIGRATION),
    'the handle format is enforced by the database too');
  assert.ok(/BEGIN;/.test(MIGRATION) && /COMMIT;/.test(MIGRATION), 'single transaction');
  assert.ok(/DO \$\$/.test(MIGRATION), 'self-check block present');
  assert.ok(/RAISE EXCEPTION/.test(MIGRATION));
  // No financial object is created or altered.
  assert.ok(!/ALTER TABLE public\.(wallets|deposits|payment_invoices|transactions|withdrawals)/.test(MIGRATION));
});

test('migration 045: RLS on, service_role only, anon/authenticated denied', () => {
  assert.ok(/ALTER TABLE public\.deposit_partners ENABLE ROW LEVEL SECURITY;/.test(MIGRATION));
  assert.ok(/CREATE POLICY deposit_partners_service_all ON public\.deposit_partners\s+FOR ALL TO service_role/.test(MIGRATION));
  assert.ok(/REVOKE ALL ON public\.deposit_partners FROM anon;/.test(MIGRATION));
  assert.ok(/REVOKE ALL ON public\.deposit_partners FROM authenticated;/.test(MIGRATION));
  assert.ok(!/TO anon/.test(MIGRATION), 'no anon policy');
  assert.ok(!/TO authenticated/.test(MIGRATION), 'no authenticated policy');
});

// ---------------------------------------------------------------- frontend

test('deposit page renders exactly TWO routes: verified partner and existing crypto', () => {
  const i = INDEX.indexOf('id="depositOptions"');
  assert.ok(i > 0, 'options block present');
  const block = INDEX.slice(i, INDEX.indexOf('id="depositCryptoFlow"'));
  const cards = block.match(/id="depositOption(?:Partner|Crypto|Card|Wallet)"/g) || [];
  assert.deepStrictEqual(cards, ['id="depositOptionPartner"', 'id="depositOptionCrypto"'],
    'the menu offers the partner route and the direct crypto route, nothing else');
  assert.ok(block.includes('data-i18n="deposit.choose.partner.title"'));
  assert.ok(block.includes('data-i18n="deposit.choose.crypto.title"'));
  // No card route, and no external-purchase route either. Neither is offered, so
  // the interface never advertises a method the platform cannot deliver.
  assert.ok(!block.includes('depositOptionCard'), 'no card route in the menu');
  assert.ok(!block.includes('depositOptionWallet'), 'no external-purchase route in the menu');
  assert.ok(!/credit-card/.test(block), 'no card icon in the menu');
  assert.ok(!INDEX.includes('deposit.choose.card'), 'the card copy is fully retired');
  assert.ok(!INDEX.includes('deposit.choose.wallet'), 'the external-purchase menu copy is retired');
  assert.ok(!INDEX.includes('deposit.wallet.'), 'the external-purchase panel copy is retired');
});

test('the partner panel states that a partner cannot credit an account', () => {
  const i = INDEX.indexOf('id="depositPartnerPanel"');
  const block = INDEX.slice(i, INDEX.indexOf('id="depositCryptoFlow"'));
  for (const key of [
    'deposit.partner.safety.1', 'deposit.partner.safety.2', 'deposit.partner.safety.3',
    'deposit.partner.safety.4', 'deposit.partner.safety.5', 'deposit.partner.safety.6',
    'deposit.partner.disclaimer'
  ]) {
    assert.ok(block.includes('data-i18n="' + key + '"'), 'missing copy: ' + key);
  }
  assert.ok(!/contenteditable|<input|<textarea/.test(block), 'the panel collects no secrets');
});

test('the client re-validates the Telegram URL before rendering a link', () => {
  const fn = INDEX.slice(INDEX.indexOf('function renderDepositPartners'), INDEX.indexOf('function updateDepositReferenceBox'));
  assert.ok(/t\\\.me/.test(fn) || fn.includes('t\\.me'), 't.me URL shape is enforced in the client');
  assert.ok(fn.includes('escapeHtml(p.telegramUrl)'), 'the URL is escaped');
  assert.ok(fn.includes('rel="noopener noreferrer"'), 'external link is isolated');
});

test('opening the deposit modal never creates an invoice for the partner route', () => {
  const fn = INDEX.slice(INDEX.indexOf('function openDepositModal'), INDEX.indexOf('function refreshDepositModeNotice'));
  assert.ok(fn.includes("loadDepositOptions(false)"), 'options are loaded');
  assert.ok(!fn.includes('create-invoice'), 'no invoice on open');
  assert.ok(!fn.includes('requestDepositAddress'), 'no invoice on open');
  assert.ok(fn.includes("APP.environment === 'MARKETING_SANDBOX'"), 'sandbox keeps its old flow');
});

test('the partner panel reuses the existing invoice reference and creates no address', () => {
  const fn = INDEX.slice(INDEX.indexOf('function updateDepositReferenceBox'), INDEX.indexOf('function copyDepositReference'));
  assert.ok(fn.includes('currentInvoiceId'), 'uses the existing invoice id');
  assert.ok(!fn.includes('fetch('), 'no request');
  const copyFn = INDEX.slice(INDEX.indexOf('function copyDepositReference'), INDEX.indexOf('async function loadDepositOptions'));
  assert.ok(!copyFn.includes('fetch('), 'copying performs no network call');
});

test('all new UI copy exists in all six locales', () => {
  const tIdx = INDEX.indexOf('const TRANSLATIONS');
  let i = INDEX.indexOf('{', tIdx);
  let depth = 0;
  let end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(INDEX.slice(tIdx, end + 1) + '; this.T = TRANSLATIONS;', ctx);
  const T = ctx.T;
  const locales = Object.keys(T);
  assert.deepStrictEqual(locales, ['en', 'es', 'pt', 'fr', 'ar', 'zh']);

  const required = [
    'deposit.choose.title', 'deposit.partner.modelNote',
    'deposit.partner.contactPaymentPartner', 'deposit.partner.paymentPartnerNote',
    'deposit.choose.partner.title', 'deposit.choose.partner.desc',
    'deposit.choose.crypto.title', 'deposit.choose.crypto.desc',
    'deposit.partner.title', 'deposit.partner.intro', 'deposit.partner.empty',
    'deposit.partner.chat', 'deposit.partner.verified', 'deposit.partner.refTitle',
    'deposit.partner.refHint', 'deposit.partner.refReady', 'deposit.partner.disclaimer',
    'admin.tab.partners', 'admin.partner.help', 'admin.partner.migration'
  ];
  for (const locale of locales) {
    for (const key of required) {
      assert.ok(T[locale][key] && String(T[locale][key]).trim(), locale + ' missing ' + key);
    }
  }
  // Placeholder parity for the one interpolated sentence.
  for (const locale of locales) {
    assert.ok(T[locale]['deposit.partner.refReady'].includes('{{asset}}'), locale);
    assert.ok(T[locale]['deposit.partner.refReady'].includes('{{network}}'), locale);
  }
});

test('no locale offers card purchasing and none claims a card checkout exists', () => {
  const tIdx = INDEX.indexOf('const TRANSLATIONS');
  let i = INDEX.indexOf('{', tIdx);
  let depth = 0;
  let end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(INDEX.slice(tIdx, end + 1) + '; this.T = TRANSLATIONS;', ctx);
  const T = ctx.T;
  for (const locale of Object.keys(T)) {
    const keys = Object.keys(T[locale]);
    assert.strictEqual(keys.filter((k) => k.indexOf('deposit.choose.card') === 0).length, 0,
      locale + ' must not keep card-route copy');
    // No ROUTE title/description may advertise a card checkout in any language.
    // (Guidance text may mention that card availability depends on the country;
    // that is a caveat, not an offer.)
    const routeCopy = keys
      .filter((k) => k.indexOf('deposit.choose.') === 0)
      .map((k) => String(T[locale][k]).toLowerCase())
      .join(' | ');
    assert.ok(!/with card|con tarjeta|com cartão|par carte|بالبطاقة|银行卡/.test(routeCopy),
      locale + ' must not advertise a card purchase route');
  }
  // The partner panel still states plainly that Arbitrix does not process cards.
  const panelCopy = Object.keys(T.en)
    .filter((k) => k.indexOf('deposit.partner.') === 0)
    .map((k) => String(T.en[k]).toLowerCase())
    .join(' | ');
  assert.ok(/does not process card payments/.test(panelCopy),
    'the partner route explains that Arbitrix does not process card payments');
});

// ------------------------------------------------- approved label + partner model

test('the partner option uses the approved label and never implies a guaranteed sale', () => {
  const tIdx = INDEX.indexOf('const TRANSLATIONS');
  let i = INDEX.indexOf('{', tIdx);
  let depth = 0;
  let end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(INDEX.slice(tIdx, end + 1) + '; this.T = TRANSLATIONS;', ctx);
  const T = ctx.T;
  assert.strictEqual(T.en['deposit.choose.partner.title'], 'Buy from a Verified Partner');
  for (const locale of Object.keys(T)) {
    assert.ok(String(T[locale]['deposit.choose.partner.title'] || '').trim(), locale + ' title');
    const desc = String(T[locale]['deposit.choose.partner.desc'] || '');
    assert.ok(desc.trim(), locale + ' description');
    // The menu description may not promise a completed sale or transfer.
    assert.ok(!/guarantee|instant|will sell you|sells you usdt/i.test(desc),
      locale + ' must not promise a sale');
  }
});

test('the partner panel states the model and that payment never credits an account', () => {
  const panel = INDEX.slice(INDEX.indexOf('id="depositPartnerPanel"'), INDEX.indexOf('id="depositCryptoFlow"'));
  assert.ok(panel.includes('data-i18n="deposit.partner.modelNote"'), 'model note rendered');
  const note = (INDEX.match(/'deposit\.partner\.modelNote': '([^']*)'/) || [])[1] || '';
  assert.match(note, /help you obtain USDT yourself/i);
  assert.match(note, /whether a partner sells USDT or guides you/i);
  assert.match(note, /never credits your Arbitrix account/i);
  assert.match(note, /address generated for your own deposit/i);
});

// ============================================ service model + worldwide coverage

const baseRow = (over) => Object.assign({
  id: 7, display_name: 'Partner', telegram_username: 'arbitrix_csa1',
  services: ['direct_sale'], serves_worldwide: false,
  countries: ['Nigeria'], payment_methods: ['Bank transfer'],
  is_active: true, is_verified: true, display_order: 100
}, over || {});

test('a direct-sale partner exposes the sale capability and its own methods', () => {
  const p = partners.toPublicPartner(baseRow());
  assert.strictEqual(p.directSale, true);
  assert.strictEqual(p.guidedAssistance, false);
  assert.strictEqual(p.paymentMethodsApplyToDirectSale, true);
  assert.strictEqual(p.paymentMethodsDependOnExternalService, false, 'no guidance, no dependence');
  assert.deepStrictEqual(p.paymentMethods, ['Bank transfer']);
  assert.deepStrictEqual(p.services, ['direct_sale']);
});

test('a guided-assistance partner exposes guidance and no invented methods', () => {
  const p = partners.toPublicPartner(baseRow({
    services: ['guided_assistance'], payment_methods: []
  }));
  assert.strictEqual(p.directSale, false);
  assert.strictEqual(p.guidedAssistance, true);
  assert.strictEqual(p.paymentMethodsApplyToDirectSale, false);
  assert.strictEqual(p.paymentMethodsDependOnExternalService, true);
  assert.deepStrictEqual(p.paymentMethods, [], 'guidance must not imply partner-accepted methods');
});

test('a partner offering both services reports both', () => {
  const p = partners.toPublicPartner(baseRow({
    services: ['guided_assistance', 'direct_sale'], payment_methods: ['Bank transfer', 'Mobile money']
  }));
  assert.strictEqual(p.directSale, true);
  assert.strictEqual(p.guidedAssistance, true);
  assert.strictEqual(p.paymentMethodsApplyToDirectSale, true);
  assert.strictEqual(p.paymentMethodsDependOnExternalService, true, 'guided sales still depend on the service');
  assert.deepStrictEqual(p.services, ['direct_sale', 'guided_assistance'], 'canonical order');
});

test('worldwide coverage is explicit and never inferred', () => {
  const worldwide = partners.toPublicPartner(baseRow({
    services: ['guided_assistance'], serves_worldwide: true,
    countries: ['Nigeria', 'South Africa'], payment_methods: []
  }));
  assert.strictEqual(worldwide.servesWorldwide, true);
  assert.deepStrictEqual(worldwide.countries, [], 'a worldwide partner has no country restriction to list');

  const limited = partners.toPublicPartner(baseRow({ serves_worldwide: false, countries: ['Nigeria', 'Ghana', 'Kenya'] }));
  assert.strictEqual(limited.servesWorldwide, false);
  assert.deepStrictEqual(limited.countries, ['Nigeria', 'Ghana', 'Kenya'], 'many countries are allowed');
});

test('a partner with no service or no coverage statement is never shown', () => {
  assert.strictEqual(partners.toPublicPartner(baseRow({ services: [] })), null, 'no service');
  assert.strictEqual(partners.toPublicPartner(baseRow({ services: 'garbage' })), null, 'unknown service');
  assert.strictEqual(partners.toPublicPartner(baseRow({ serves_worldwide: false, countries: [] })), null,
    'no coverage statement at all');
  // ...and the same rows stay hidden through the list projection.
  const list = partners.toPublicPartnerList([
    baseRow({ id: 1, display_name: 'NoService', services: [] }),
    baseRow({ id: 2, display_name: 'NoCoverage', services: ['direct_sale'], countries: [], serves_worldwide: false }),
    baseRow({ id: 3, display_name: 'Visible', services: ['direct_sale'], serves_worldwide: true })
  ]);
  assert.deepStrictEqual(list.map((p) => p.displayName), ['Visible']);
  assert.ok(!('id' in list[0]), 'the public projection carries no database id');
});

test('service identifiers are parsed strictly and canonically', () => {
  assert.deepStrictEqual(partners.sanitizeServices('direct_sale'), { ok: true, services: ['direct_sale'], reason: null });
  assert.deepStrictEqual(partners.sanitizeServices('guided_assistance,direct_sale').services,
    ['direct_sale', 'guided_assistance']);
  assert.deepStrictEqual(partners.sanitizeServices(['Direct Sale', 'GUIDED ASSISTANCE']).services,
    ['direct_sale', 'guided_assistance'], 'tolerant of case/spacing');
  assert.strictEqual(partners.sanitizeServices('escrow').ok, false, 'unknown capability rejected');
  assert.strictEqual(partners.sanitizeServices(42).ok, false);
  assert.deepStrictEqual(partners.sanitizeServices('').services, [], 'empty stays empty');
});

test('the admin payload requires a service and accepts worldwide coverage', () => {
  const src = SERVER.slice(SERVER.indexOf('function buildDepositPartnerPayload'),
    SERVER.indexOf("app.get('/api/admin/deposit-partners'"));
  assert.match(src, /sanitizeServices/);
  assert.match(src, /services-required/);
  assert.match(src, /servesWorldwide/);
  assert.match(src, /serves_worldwide/);
  assert.match(src, /sanitizeList\(source\.countries\)/);
});

test('the migration models services and worldwide coverage with a subset CHECK', () => {
  assert.match(MIGRATION, /services\s+TEXT\[\]/);
  assert.match(MIGRATION, /serves_worldwide\s+BOOLEAN/);
  assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS services/);
  assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS serves_worldwide/);
  assert.match(MIGRATION, /deposit_partners_services_valid/);
  assert.match(MIGRATION, /services <@ ARRAY\['direct_sale', 'guided_assistance'\]/);
  // The self-check asserts the exact schema the server depends on (the messages
  // became stricter with the hardening, so they now name the required shape).
  assert.match(MIGRATION, /deposit_partners\.services must be TEXT\[\] NOT NULL DEFAULT/);
  assert.match(MIGRATION, /deposit_partners\.serves_worldwide must be BOOLEAN NOT NULL DEFAULT FALSE/);
});

test('the public options route selects the service and coverage columns', () => {
  const src = SERVER.slice(SERVER.indexOf("app.get('/api/deposit/options'"),
    SERVER.indexOf('// ---------- ADMIN: DEPOSIT PARTNER DIRECTORY'));
  assert.match(src, /services/);
  assert.match(src, /serves_worldwide/);
  assert.match(src, /\.eq\('is_active', true\)/);
  assert.match(src, /\.eq\('is_verified', true\)/);
});

test('the customer card renders services, coverage and method handling from the server', () => {
  const src = INDEX.slice(INDEX.indexOf('function renderDepositPartners'),
    INDEX.indexOf('function updateDepositReferenceBox'));
  assert.match(src, /p\.directSale === true/);
  assert.match(src, /p\.guidedAssistance === true/);
  assert.match(src, /deposit\.partner\.service\.direct/);
  assert.match(src, /deposit\.partner\.service\.guided/);
  assert.match(src, /p\.servesWorldwide === true/);
  assert.match(src, /deposit\.partner\.worldwide/);
  assert.match(src, /deposit\.partner\.serves/);
  assert.match(src, /paymentMethodsApplyToDirectSale/);
  assert.match(src, /paymentMethodsDependOnExternalService/);
  assert.match(src, /deposit\.partner\.methodsDepend/);
  // the t.me link is still the only contact affordance
  assert.match(src, /rel="noopener noreferrer"/);
});

test('the admin form and table expose the service model and coverage', () => {
  for (const id of ['adminPartnerServiceDirect', 'adminPartnerServiceGuided', 'adminPartnerWorldwide']) {
    assert.ok(INDEX.includes('id="' + id + '"'), 'missing control ' + id);
  }
  const js = INDEX.slice(INDEX.indexOf('async function adminCreatePartner'),
    INDEX.indexOf('async function adminTogglePartner'));
  assert.match(js, /direct_sale/);
  assert.match(js, /guided_assistance/);
  assert.match(js, /servesWorldwide/);
  assert.match(js, /admin\.partner\.servicesRequired/);
  const table = INDEX.slice(INDEX.indexOf('function renderAdminPartners'),
    INDEX.indexOf('async function adminCreatePartner'));
  assert.match(table, /admin\.partner\.serviceDirect/);
  assert.match(table, /admin\.partner\.serviceGuided/);
  assert.match(table, /serves_worldwide/);
  assert.match(table, /admin\.partner\.noServices/);
});

test('no partner code can credit a balance or touch a financial table', () => {
  for (const file of ['services/DepositPartners.js']) {
    const src = read(file);
    assert.ok(!/wallets|live_balance|bonus_balance|record_trade_safe|credit_|transactions|deposits\b/.test(src),
      file + ' must stay contact metadata only');
  }
  const adminBlock = SERVER.slice(SERVER.indexOf('// ---------- ADMIN: DEPOSIT PARTNER DIRECTORY'),
    SERVER.indexOf("app.get('/api/payment/health'"));
  assert.ok(!/wallets|live_balance|bonus_balance|credit_payment|record_trade_safe/.test(adminBlock),
    'partner admin routes must not touch money');
  const options = SERVER.slice(SERVER.indexOf("app.get('/api/deposit/options'"),
    SERVER.indexOf('// ---------- ADMIN: DEPOSIT PARTNER DIRECTORY'));
  assert.ok(!/wallets|live_balance|credit_payment|create-invoice|createInvoice/.test(options),
    'the options route must not create or credit anything');
});

test('every locale covers the service model with consistent keys', () => {
  const tIdx = INDEX.indexOf('const TRANSLATIONS');
  let i = INDEX.indexOf('{', tIdx);
  let depth = 0;
  let end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(INDEX.slice(tIdx, end + 1) + '; this.T = TRANSLATIONS;', ctx);
  const T = ctx.T;
  const keys = [
    'deposit.partner.servicesIntro', 'deposit.partner.service.direct', 'deposit.partner.service.guided',
    'deposit.partner.worldwide', 'deposit.partner.serves', 'deposit.partner.methodsDepend',
    'admin.partner.services', 'admin.partner.serviceDirect', 'admin.partner.serviceGuided',
    'admin.partner.servicesHint', 'admin.partner.servicesRequired', 'admin.partner.worldwide',
    'admin.partner.countriesHint', 'admin.partner.methodsHint', 'admin.partner.coverage',
    'admin.partner.noServices'
  ];
  const locales = Object.keys(T);
  assert.strictEqual(locales.length, 6);
  for (const locale of locales) {
    for (const key of keys) {
      const value = T[locale][key];
      assert.ok(typeof value === 'string' && value.trim().length > 0, locale + ' missing ' + key);
      assert.ok(!/\{\{/.test(value), locale + ' ' + key + ' must not carry a placeholder');
    }
  }
  // identical key sets across locales
  const base = Object.keys(T.en).sort().join('|');
  for (const locale of locales) assert.strictEqual(Object.keys(T[locale]).sort().join('|'), base, locale + ' key set');
});

// =========================================== migration hardening (045, 2026-10-29)

test('sequence privileges are guarded and revoked from PUBLIC/anon/authenticated', () => {
  // The grant must live inside an IF EXISTS block, like migration 039, so a
  // pre-existing table with a different key design cannot abort the migration.
  const guard = MIGRATION.slice(MIGRATION.indexOf('DO $$', MIGRATION.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE')),
    MIGRATION.indexOf('END $$;', MIGRATION.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE')) + 7);
  assert.match(guard, /IF EXISTS/);
  assert.match(guard, /relname = 'deposit_partners_id_seq'/);
  assert.match(guard, /relkind = 'S'/);
  assert.match(guard, /REVOKE ALL ON SEQUENCE public\.deposit_partners_id_seq FROM PUBLIC, anon, authenticated/);
  assert.match(guard, /GRANT USAGE, SELECT ON SEQUENCE public\.deposit_partners_id_seq TO service_role/);
  assert.match(guard, /EXECUTE '/, 'the statements must run dynamically so a missing sequence is simply skipped');

  // No sequence privilege may be touched OUTSIDE that guard.
  const outside = MIGRATION.replace(/DO \$\$[\s\S]*?END \$\$;/g, '');
  assert.ok(!/ON SEQUENCE/.test(outside), 'unguarded sequence statement found');
});

test('the self-check asserts exact element type, nullability and defaults', () => {
  for (const fragment of [
    "udt_name = '_text'",                        // TEXT[] specifically, not any array
    "is_nullable = 'NO'",
    "position('{}' in column_default) > 0",
    "udt_name = 'bool'",
    "lower(column_default) = 'false'"
  ]) {
    assert.ok(MIGRATION.includes(fragment), 'missing assertion: ' + fragment);
  }
});

test('the constraint self-check is scoped to public.deposit_partners', () => {
  const start = MIGRATION.indexOf("SELECT 1\n        FROM pg_constraint c");
  assert.ok(start > 0, 'scoped constraint query not found');
  const block = MIGRATION.slice(start, MIGRATION.indexOf('SELECT c.relrowsecurity'));
  assert.match(block, /FROM pg_constraint c/);
  assert.match(block, /JOIN pg_class t ON t\.oid = c\.conrelid/);
  assert.match(block, /JOIN pg_namespace n ON n\.oid = t\.relnamespace/);
  assert.match(block, /n\.nspname = 'public'/);
  assert.match(block, /t\.relname = 'deposit_partners'/);
  assert.match(block, /c\.contype = 'c'/);
  assert.ok(!/^\s*WHERE conname = 'deposit_partners_services_valid'$/m.test(block),
    'an unscoped conname-only probe would accept a same-named constraint elsewhere');
});

test('the services CHECK rejects NULL elements and duplicates as well as unknown values', () => {
  assert.match(MIGRATION, /array_position\(services, NULL\) IS NULL/);
  assert.match(MIGRATION, /cardinality\(services\) = \(/);
  assert.match(MIGRATION, /CASE WHEN 'direct_sale' = ANY \(services\) THEN 1 ELSE 0 END/);
  assert.match(MIGRATION, /CASE WHEN 'guided_assistance' = ANY \(services\) THEN 1 ELSE 0 END/);

  // Mirror of the SQL predicate. The same truth table was executed against
  // PostgreSQL 16: the first four rows succeeded, the last three were rejected.
  const allows = (services) => {
    const known = ['direct_sale', 'guided_assistance'];
    if (!services.every((v) => known.indexOf(v) !== -1)) return false;      // <@
    if (services.some((v) => v === null)) return false;                     // array_position
    const present = (services.indexOf('direct_sale') !== -1 ? 1 : 0) +
      (services.indexOf('guided_assistance') !== -1 ? 1 : 0);
    return services.length === present;                                     // cardinality
  };
  assert.strictEqual(allows([]), true, 'empty list stays schema-legal (invisible in the app)');
  assert.strictEqual(allows(['direct_sale']), true);
  assert.strictEqual(allows(['guided_assistance']), true);
  assert.strictEqual(allows(['direct_sale', 'guided_assistance']), true, 'both services supported');
  assert.strictEqual(allows(['direct_sale', 'direct_sale']), false, 'duplicates rejected');
  assert.strictEqual(allows(['direct_sale', null]), false, 'NULL element rejected');
  assert.strictEqual(allows(['escrow']), false, 'unknown capability rejected');
});

/* ---------------------------------------------------------------------------
 * The admin "Visible to customers" indicator must agree with the server.
 *
 * The bug this pins: the admin table derived visibility from is_active &&
 * is_verified only, so a partner created as Active + Verified but WITHOUT a
 * service or WITHOUT disclosed coverage showed a green tick while the public
 * listing hid it. The indicator now comes from the server, computed with the
 * same helper the public listing uses - there is no second implementation.
 * ------------------------------------------------------------------------- */

const visibilityRow = (over) => Object.assign({
  id: 11, display_name: 'Partner', telegram_username: 'arbitrix_csa1',
  services: ['direct_sale'], serves_worldwide: false, countries: ['Nigeria'],
  payment_methods: ['Bank transfer'], is_active: true, is_verified: true,
  display_order: 100
}, over || {});

test('the visibility rule is exactly: active AND verified AND a service AND coverage', () => {
  const cases = [
    ['active + verified + service + country list', {}, true],
    ['active + verified + service + worldwide', { serves_worldwide: true, countries: [] }, true],
    ['both services offered', { services: ['direct_sale', 'guided_assistance'] }, true],
    ['missing services (empty list)', { services: [] }, false],
    ['missing services (unparseable)', { services: 'escrow' }, false],
    ['missing coverage (no list, not worldwide)', { countries: [], serves_worldwide: false }, false],
    ['inactive', { is_active: false }, false],
    ['unverified', { is_verified: false }, false],
    ['inactive + unverified + no service + no coverage', {
      is_active: false, is_verified: false, services: [], countries: [], serves_worldwide: false
    }, false]
  ];
  for (const [label, over, expected] of cases) {
    assert.strictEqual(partners.isCustomerVisible(visibilityRow(over)), expected, label);
  }
});

test('the indicator can never say "visible" when the public listing would hide the row', () => {
  // Whatever the admin route returns must be produced by isCustomerVisible, and
  // that function must agree with the projection that actually feeds customers.
  const src = SERVER.slice(SERVER.indexOf("app.get('/api/admin/deposit-partners'"),
    SERVER.indexOf("app.post('/api/admin/deposit-partners'"));
  assert.match(src, /visibleToCustomers:\s*depositPartners\.isCustomerVisible\(row\)/,
    'the admin route must compute the flag with the authoritative helper');

  const rows = [
    visibilityRow(),
    visibilityRow({ services: [] }),
    visibilityRow({ countries: [], serves_worldwide: false }),
    visibilityRow({ is_active: false }),
    visibilityRow({ is_verified: false })
  ];
  for (const row of rows) {
    const listed = partners.toPublicPartnerList([row]).length === 1;
    // This is exactly what the server puts in `visibleToCustomers`.
    assert.strictEqual(partners.isCustomerVisible(row), listed,
      'admin indicator and public projection must agree for ' + JSON.stringify({
        services: row.services, countries: row.countries, worldwide: row.serves_worldwide,
        active: row.is_active, verified: row.is_verified
      }));
  }
});

test('the admin table renders the server flag instead of re-deriving it', () => {
  const fn = INDEX.slice(INDEX.indexOf('function renderAdminPartners'),
    INDEX.indexOf('async function adminCreatePartner'));
  assert.match(fn, /const visible = p\.visibleToCustomers === true;/,
    'the badge must read the server-computed field');
  assert.ok(!/const visible = p\.is_active === true && p\.is_verified === true/.test(fn),
    'the old two-flag derivation must be gone');
  // Still the same 9-column table, one column per <th>.
  assert.match(fn, /colspan="9"/);
});

