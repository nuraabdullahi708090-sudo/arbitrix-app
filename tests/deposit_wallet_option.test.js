'use strict';

/**
 * EXTERNAL WALLET FUNDING ROUTE (Option 1) - pins.
 *
 * Card-to-crypto purchasing is POSTPONED, so the deposit menu offers:
 *   1. buy crypto in an external wallet / purchase service (guidance + ONE
 *      outward link; no embedded widget, no deep link),
 *   2. contact a verified human partner on Telegram,
 *   3. the existing USDT/TRC20 deposit flow.
 *
 * The route must never be able to credit an account, must never advertise card
 * purchasing, and must never let a customer-supplied value become a destination
 * or an address.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const card = require('../services/CardPayments');

// Comments legitimately mention the postponed card work, so executable checks
// run against the source with comments removed.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const sliceBetween = (startMarker, endMarker) => {
  const i = INDEX.indexOf(startMarker);
  assert.ok(i > 0, 'marker not found: ' + startMarker);
  const j = INDEX.indexOf(endMarker, i);
  assert.ok(j > i, 'end marker not found: ' + endMarker);
  return INDEX.slice(i, j);
};

// ---------------------------------------------------------------- the menu

test('the funding menu offers wallet, partner and crypto - never card', () => {
  const menu = sliceBetween('id="depositOptions"', 'id="depositWalletPanel"');
  assert.ok(menu.includes('id="depositOptionWallet"'));
  assert.ok(menu.includes('id="depositOptionPartner"'));
  assert.ok(menu.includes('id="depositOptionCrypto"'));
  assert.ok(!menu.includes('depositOptionCard'), 'no card route');
  assert.ok(!menu.includes('deposit.choose.card'), 'no card copy');
  assert.ok(!/credit-card|fa-credit-card/.test(menu), 'no card icon');
});

test('the wallet route explains the journey without promising a card purchase', () => {
  const panel = sliceBetween('id="depositWalletPanel"', 'THE EXISTING CRYPTO DEPOSIT FLOW');
  for (const key of [
    'deposit.wallet.intro', 'deposit.wallet.step1', 'deposit.wallet.step2',
    'deposit.wallet.step3', 'deposit.wallet.step4', 'deposit.wallet.feesNote',
    'deposit.wallet.notCredited', 'deposit.wallet.noProof'
  ]) {
    assert.ok(panel.includes('data-i18n="' + key + '"'), 'missing guidance: ' + key);
  }
  assert.ok(/does not process card payments/i.test(
    (INDEX.match(/'deposit\.wallet\.intro': '([^']*)'/) || [])[1] || ''),
    'the route states that Arbitrix does not process card payments');
  // No promise that a card purchase works in a given country.
  const panelCopy = (panel.match(/data-i18n="[^"]+">([^<]*)</g) || []).join(' ');
  assert.ok(!/guaranteed|available in your country|instant card/i.test(panelCopy));
});

// ------------------------------------------------- the outward link is safe

const runResolve = (windowUrl, metaContent) => {
  const src = sliceBetween('function resolveBuyCryptoUrl', 'function updateDepositWalletPanel');
  const ctx = vm.createContext({
    window: windowUrl === undefined ? {} : { ARBITRIX_BUY_CRYPTO_URL: windowUrl },
    document: {
      querySelector: (sel) => (sel === 'meta[name="arbitrix-buy-crypto"]'
        ? { getAttribute: () => metaContent }
        : null)
    }
  });
  vm.runInContext(src + '; this.resolve = resolveBuyCryptoUrl;', ctx);
  return ctx.resolve();
};

test('only a plain https destination can become the outward link', () => {
  assert.strictEqual(runResolve(undefined, 'https://example.org/buy-usdt'),
    'https://example.org/buy-usdt');
  assert.strictEqual(runResolve('https://example.org/buy', ''), 'https://example.org/buy');
  // window wins over the meta tag
  assert.strictEqual(runResolve('https://a.example/x', 'https://b.example/y'), 'https://a.example/x');
  for (const bad of [
    '', '   ', 'javascript:alert(1)', 'JavaScript:alert(1)',
    'http://example.org/buy-usdt', 'data:text/html,<script>alert(1)</script>',
    't.me/example', 'https://exa mple.com', 'https://x.com/"onmouseover'
  ]) {
    assert.strictEqual(runResolve(bad, bad), '', 'must reject: ' + bad);
  }
});

test('the destination is configured in exactly ONE place and is https when set', () => {
  const metas = INDEX.match(/<meta name="arbitrix-buy-crypto" content="([^"]*)">/g) || [];
  assert.strictEqual(metas.length, 1, 'exactly one meta element');
  const value = (metas[0].match(/content="([^"]*)"/) || [])[1];
  // Empty is the safe default (nothing unverified is recommended). Any value an
  // operator sets must be a plain https URL - resolveBuyCryptoUrl rejects the
  // rest at runtime, so a malformed value can never render a live link.
  if (value !== '') {
    assert.match(value, /^https:\/\/[^\s"'<>]+$/, 'a plain https URL');
  }
  // The page never hard-codes a t.me / provider URL for this route anywhere else.
  const panel = sliceBetween('id="depositWalletPanel"', 'THE EXISTING CRYPTO DEPOSIT FLOW');
  assert.ok(!/https?:\/\//.test(panel), 'the panel itself hard-codes no destination');
});

test('the outward link opens in a new tab and cannot control the opener', () => {
  const link = (INDEX.match(/<a id="depositBuyCryptoLink"[^>]*>/) || [])[0];
  assert.ok(link, 'link element present');
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(link, /href="#"/, 'the href is resolved at runtime, never baked in');
  assert.match(link, /style="[^"]*display:none/, 'hidden until a valid destination resolves');
});

// ------------------------------------------- it cannot credit or bypass checks

test('the wallet route cannot credit an account or create an invoice', () => {
  const fn = sliceBetween('function selectDepositOption', 'function resolveBuyCryptoUrl')
    + sliceBetween('function updateDepositWalletPanel', 'function focusDepositAmount')
    + sliceBetween('function focusDepositAmount', 'function renderDepositPartners');
  const code = stripComments(fn);
  assert.ok(!/fetch\(/.test(code), 'the route makes no request');
  assert.ok(!/create-invoice/.test(code), 'the route never creates an invoice');
  assert.ok(!/credit|wallet\/balance|record_trade/i.test(code), 'the route never credits');
  assert.ok(!/payment\/status/.test(code), 'the route never polls a payment');
});

test('the address shown is the server-generated one, never a customer value', () => {
  const fn = sliceBetween('function updateDepositWalletPanel', 'function focusDepositAmount');
  assert.ok(fn.includes("document.getElementById('liveWalletAddress')"),
    'the address is read from the server-populated element');
  assert.ok(fn.includes('currentInvoiceId'), 'nothing is shown before an invoice exists');
  assert.ok(!/localStorage|sessionStorage|prompt\(|input\.value/.test(fn),
    'no stored or typed value can become the address');
  // ...and the deposit request itself still sends no address to the server.
  const req = sliceBetween("fetch('/api/payment/create-invoice'", '});');
  assert.ok(!/address/i.test(req), 'the client never supplies a deposit address');
  assert.ok(SERVER.includes('PLATFORM_MIN_DEPOSIT_USD = 100'), 'minimum deposit unchanged');
});

test('the guidance says a purchase is not a deposit and a receipt is not proof', () => {
  const copy = (key) => (INDEX.match(new RegExp("'" + key + "': '([^']*)'")) || [])[1] || '';
  const notCredited = copy('deposit.wallet.notCredited');
  const noProof = copy('deposit.wallet.noProof');
  assert.match(notCredited, /does not credit/i);
  assert.match(notCredited, /verifies it on-chain/i);
  assert.match(noProof, /not proof of payment/i);
  const fees = copy('deposit.wallet.feesNote');
  assert.match(fees, /TRX/, 'the TRON network fee is explained');
});

test('every locale carries the wallet route copy', () => {
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
  const keys = Object.keys(T.en).filter((k) => k.indexOf('deposit.wallet.') === 0);
  assert.strictEqual(keys.length, 21, '21 wallet keys');
  for (const locale of Object.keys(T)) {
    for (const key of keys) {
      assert.ok(String(T[locale][key] || '').trim(), locale + ' missing ' + key);
    }
    assert.ok(!Object.keys(T[locale]).some((k) => k.indexOf('deposit.choose.card') === 0),
      locale + ' keeps no card-route copy');
  }
});

// ------------------------------------------- postponed card scaffolding

test('card-payment scaffolding is retained but unreachable from the UI', () => {
  assert.deepStrictEqual(card.APPROVED_CARD_PROVIDERS, [], 'no provider is approved');
  assert.strictEqual(card.resolveCardPaymentConfig({ CARD_PAYMENTS_ENABLED: 'true' }).enabled, false,
    'a flag alone cannot enable card payments');
  assert.strictEqual(card.resolveCardPaymentConfig({
    CARD_PAYMENTS_ENABLED: 'true', CARD_PAYMENT_PROVIDER: 'transak'
  }).enabled, false, 'an unapproved provider cannot be enabled');
  // The customer UI does not read or reference the card switch at all.
  const indexCode = stripComments(INDEX);
  assert.ok(!/CardPayments|depositOptionCard|deposit\.choose\.card/.test(indexCode),
    'no executable reference to the postponed card route');
  assert.ok(!INDEX.includes("data.card"), 'the page ignores any card field server-side');
  // The module is still wired server-side for a future approved integration.
  assert.ok(SERVER.includes('CardPayments'), 'the server keeps the switch');
  assert.ok(!/createCheckout|hostedCheckout|transakSession/i.test(cardSource()),
    'no provider checkout call exists');
});

function cardSource() {
  return fs.readFileSync(path.join(ROOT, 'services', 'CardPayments.js'), 'utf8');
}

// -------------------------------------------------- deposit flow preserved

test('the existing crypto deposit route is intact and warns about the network', () => {
  const flow = sliceBetween('id="depositCryptoFlow"', 'STEP 3: SUCCESS SECTION');
  assert.ok(flow.includes('id="liveWalletAddress"'), 'address element');
  assert.ok(flow.includes('id="liveDepositAmount"'), 'amount field');
  assert.ok(flow.includes('id="getAddressBtn"'), 'generate payment action');
  assert.ok(flow.includes('data-i18n="deposit.safetyWarningBody"'), 'network warning');
  assert.match(INDEX, /const APP = \{[\s\S]*?MIN_DEPOSIT: 100/);
  assert.match(INDEX, /MIN_WITHDRAWAL: 700/);
});

// ------------------------------------------------------- approved menu labels

const TRANSLATIONS = (() => {
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
  return ctx.T;
})();

test('the three approved option labels are used verbatim in English', () => {
  assert.strictEqual(TRANSLATIONS.en['deposit.choose.wallet.title'], 'Buy USDT with an External Service');
  assert.strictEqual(TRANSLATIONS.en['deposit.choose.partner.title'], 'Buy from a Verified Partner');
  assert.strictEqual(TRANSLATIONS.en['deposit.choose.crypto.title'], 'I Already Have Crypto');
  // ...and the markup defaults agree with the dictionary, so the first paint
  // shows the approved labels before applyTranslations runs.
  const menu = sliceBetween('id="depositOptions"', 'id="depositWalletPanel"');
  assert.ok(menu.includes('>Buy USDT with an External Service<'));
  assert.ok(menu.includes('>Buy from a Verified Partner<'));
  assert.ok(menu.includes('>I Already Have Crypto<'));
});

test('every locale names all three options and never claims country availability', () => {
  const countryClaims = /\bnigeria\b|\bsouth africa\b|\bngn\b|\bzar\b/i;
  const availability = /available in (your|all|any) countr|guaranteed|instant delivery|we support every countr/i;
  for (const locale of Object.keys(TRANSLATIONS)) {
    const t = TRANSLATIONS[locale];
    for (const key of ['deposit.choose.wallet.title', 'deposit.choose.partner.title', 'deposit.choose.crypto.title']) {
      assert.ok(String(t[key] || '').trim(), locale + ' missing ' + key);
    }
    const copy = Object.keys(t)
      .filter((k) => k.indexOf('deposit.choose.') === 0 || k.indexOf('deposit.wallet.') === 0)
      .map((k) => String(t[k]))
      .join(' | ');
    assert.ok(!countryClaims.test(copy), locale + ' must not claim a country');
    assert.ok(!availability.test(copy), locale + ' must not guarantee availability');
  }
});

test('the journey puts the Arbitrix address before the external link', () => {
  const panel = sliceBetween('id="depositWalletPanel"', 'THE EXISTING CRYPTO DEPOSIT FLOW');
  const addressAt = panel.indexOf('id="depositWalletAddress"');
  const stepsAt = panel.indexOf('deposit-wallet-steps');
  const linkAt = panel.indexOf('id="depositBuyCryptoLink"');
  assert.ok(addressAt > 0 && stepsAt > 0 && linkAt > 0);
  assert.ok(addressAt < stepsAt, 'address first');
  assert.ok(stepsAt < linkAt, 'instructions before the external link');
  // Step 1 is the Arbitrix invoice, not the provider purchase.
  assert.match(TRANSLATIONS.en['deposit.wallet.step1'], /generate the deposit address/i);
  assert.match(TRANSLATIONS.en['deposit.wallet.step3'], /TRON \(TRC20\)/);
  assert.match(TRANSLATIONS.en['deposit.wallet.step4'], /exact address/i);
});

test('instructions cover new users, existing wallet users and existing USDT holders', () => {
  for (const key of ['deposit.wallet.help.new', 'deposit.wallet.help.existing', 'deposit.wallet.help.hold']) {
    assert.ok(String(TRANSLATIONS.en[key] || '').trim(), 'missing ' + key);
  }
  assert.match(TRANSLATIONS.en['deposit.wallet.help.new'], /install a wallet|create an exchange account/i);
  assert.match(TRANSLATIONS.en['deposit.wallet.help.existing'], /skip setup/i);
  assert.match(TRANSLATIONS.en['deposit.wallet.help.hold'], /skip buying/i);
  // The wallet guidance never mentions secrets at all (nothing to type in).
  for (const locale of Object.keys(TRANSLATIONS)) {
    const copy = Object.keys(TRANSLATIONS[locale])
      .filter((k) => k.indexOf('deposit.wallet.') === 0)
      .map((k) => String(TRANSLATIONS[locale][k]))
      .join(' | ');
    assert.ok(!/seed phrase|private key|recovery phrase|password|otp/i.test(copy),
      locale + ' wallet guidance must not mention secrets');
  }
  // The partner panel mentions them only as a WARNING never to share them.
  assert.match(TRANSLATIONS.en['deposit.partner.safety.2'], /never share/i);
  assert.match(TRANSLATIONS.en['deposit.partner.safety.2'], /password/i);
});

test('no unverified purchase destination is recommended by default', () => {
  const metas = INDEX.match(/<meta name="arbitrix-buy-crypto" content="([^"]*)">/g) || [];
  assert.strictEqual(metas.length, 1, 'exactly one configurable destination');
  const meta = (INDEX.match(/<meta name="arbitrix-buy-crypto" content="([^"]*)">/) || [])[1];
  // Neutralised on purpose: no provider is presented as a confirmed TRC20
  // solution. Its own "buy USDT" page named no network at all, so a beginner
  // could end up holding USDT on a network Arbitrix cannot credit.
  assert.strictEqual(meta, '', 'the destination must stay unset until one is verified');
  assert.ok(!/\/download$/.test(meta), 'never a generic download page');
});

test('the wallet route names no provider anywhere in customer copy (6 locales)', () => {
  const keys = [
    'deposit.choose.wallet.title', 'deposit.choose.wallet.desc',
    'deposit.wallet.title', 'deposit.wallet.intro', 'deposit.wallet.providersNote',
    'deposit.wallet.open', 'deposit.wallet.help.delivery'
  ];
  const VENDOR = /trust ?wallet|metamask|binance|moonpay|ramp|mercuryo|banxa|transak/i;
  for (const locale of Object.keys(TRANSLATIONS)) {
    for (const key of keys) {
      const value = String(TRANSLATIONS[locale][key] || '');
      assert.ok(!VENDOR.test(value), locale + ' ' + key + ' names an unverified provider: ' + value);
    }
  }
});

test('the neutral route keeps the address-first journey and the network warnings', () => {
  const panel = sliceBetween('<div id="depositWalletPanel"', '<!-- THE EXISTING CRYPTO DEPOSIT FLOW');
  // address before the (optional) outward link
  assert.ok(panel.indexOf('depositWalletAddress') < panel.indexOf('depositBuyCryptoLink'));
  // still hidden until a verified destination resolves
  assert.match(panel, /id="depositBuyCryptoLink"[^>]*style="display:none/);
  // the two warnings that make the neutral route safe
  assert.match(panel, /TRON \(TRC20\) network only/);
  assert.ok(/does not credit your Arbitrix account/i.test(panel));
  assert.ok(/not proof of payment/i.test(panel));
});
