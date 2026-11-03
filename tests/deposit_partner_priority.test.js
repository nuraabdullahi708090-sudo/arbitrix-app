'use strict';

/**
 * DEPOSIT MODAL - CONDITIONAL PARTNER CONTACTS AND WHATSAPP PRIORITY.
 *
 * Two funding routes share one modal:
 *   "Buy from a Verified Partner"  -> the partner assistance section
 *                                     (Olivia on WhatsApp FIRST, Alex on Telegram SECOND)
 *   "I Already Have Crypto"        -> the USDT/TRC20 form ONLY, no partner contact
 *
 * The tests run the REAL renderers and the REAL selectDepositOption() against a
 * fake DOM, so the behaviour is exercised rather than the source text alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const WHATSAPP = 'https://wa.me/17828027841';
const ALEX = 'https://t.me/AlexArbitrix';
const METAS = {
  'arbitrix-partner-support-telegram': '@AlexArbitrix',
  'arbitrix-partner-support-telegram-2': '@OliviaArbitrix'
};

// --------------------------------------------------------------- helpers

function dict() {
  const i0 = INDEX.indexOf('const TRANSLATIONS');
  let i = INDEX.indexOf('{', i0), depth = 0, end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(INDEX.slice(i0, end + 1) + '; this.T = TRANSLATIONS;', ctx);
  return ctx.T;
}

function fn(name) {
  const start = INDEX.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist');
  let i = INDEX.indexOf('{', start), depth = 0, end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return INDEX.slice(start, end + 1);
}

const cryptoFlow = () => INDEX.slice(INDEX.indexOf('id="depositCryptoFlow"'),
  INDEX.indexOf('id="depositPaymentSection"'));
const partnerPanel = () => INDEX.slice(INDEX.indexOf('id="depositPartnerPanel"'),
  INDEX.indexOf('id="depositCryptoFlow"'));

/** Builds the pieces of the page the partner renderers touch. */
function sandbox(locale, metas, nodes) {
  const T = dict();
  const sb = {
    window: {},
    document: {
      getElementById: (id) => nodes[id] || null,
      querySelector: (sel) => {
        const m = /name="([^"]+)"/.exec(sel);
        return m && m[1] in metas ? { content: metas[m[1]] } : null;
      }
    },
    escapeHtml: (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    t: (k, vars) => String((T[locale] || T.en)[k] || T.en[k] || k)
      .replace(/\{\{(\w+)\}\}/g, (m0, g) => (vars && vars[g] != null ? vars[g] : m0)),
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(sb);
  const slots = INDEX.slice(INDEX.indexOf('const PAYMENT_PARTNER_SLOTS'),
    INDEX.indexOf('];', INDEX.indexOf('const PAYMENT_PARTNER_SLOTS')) + 2);
  const wa = INDEX.match(/const PARTNER_PRIMARY_WHATSAPP_URL = '[^']+';/)[0];
  vm.runInContext([
    slots,
    wa,
    fn('normalisePartnerTelegramUrl'),
    fn('getPaymentPartnerContacts'),
    fn('getPartnerSupportTelegramUrl'),
    fn('renderPaymentPartnerContacts'),
    fn('renderDepositPartnerAssistance')
  ].join('\n'), sb);
  return sb;
}

function renderPartner(locale = 'en', metas = METAS) {
  const box = { id: 'depositPartnerContacts', style: {}, innerHTML: '' };
  const nodes = { depositPartnerContacts: box, paymentPartnerContacts: { style: {}, innerHTML: '' } };
  const sb = sandbox(locale, metas, nodes);
  vm.runInContext('renderDepositPartnerAssistance();', sb);
  return { box, nodes };
}

// ------------------------------------------------- 1. the crypto route is clean

test('1. "I Already Have Crypto" shows no partner contact anywhere in the deposit form', () => {
  const flow = cryptoFlow();
  assert.ok(flow.length > 500, 'the crypto flow slice exists');
  assert.ok(!/depositCryptoPartnerContacts/.test(INDEX), 'the partner list was removed from the crypto route');
  assert.ok(!/depositCryptoPartnerHelp/.test(INDEX), 'the partner help block was removed');
  assert.ok(!/payment-partner-list/.test(flow), 'no partner grid inside the crypto form');
  assert.ok(!/wa\.me|t\.me\//.test(flow), 'no partner destination inside the crypto form');
  // The deposit essentials are still there.
  assert.match(flow, /USDT/, 'USDT instructions remain');
  assert.match(flow, /TRON \(TRC20\)/, 'the TRC20 network warning remains');
  assert.match(flow, /id="liveDepositAmount"/, 'the amount input remains');
  assert.match(flow, /id="getAddressBtn"/, 'Generate Payment remains');
});

test('2. the partner section lives outside the crypto flow, in the partner panel', () => {
  const panel = partnerPanel();
  assert.ok(/id="depositPartnerContacts" class="payment-partner-list"/.test(panel),
    'the partner contact container belongs to the partner panel');
  assert.ok(!/id="depositPartnerContacts"/.test(cryptoFlow()), 'and not to the crypto flow');
});

// --------------------------------------- 3. the partner section is Olivia-first

test('3. Olivia (WhatsApp) is rendered before Alex (Telegram)', () => {
  const { box } = renderPartner();
  const olivia = box.innerHTML.indexOf('data-partner="olivia"');
  const alex = box.innerHTML.indexOf('data-partner="alex"');
  assert.ok(olivia >= 0 && alex >= 0, 'both contacts rendered');
  assert.ok(olivia < alex, 'Olivia comes first');
});

test('4. Olivia\'s WhatsApp link is exactly https://wa.me/17828027841', () => {
  const { box } = renderPartner();
  assert.ok(box.innerHTML.includes('href="' + WHATSAPP + '"'), 'the wa.me link');
  assert.match(box.innerHTML, /<i class="fab fa-whatsapp"[^>]*><\/i>/, 'WhatsApp icon');
  assert.ok(/target="_blank"/.test(box.innerHTML), 'opens in a new tab/window');
  assert.ok(/rel="noopener noreferrer"/.test(box.innerHTML), 'safe rel');
  // Exactly one destination constant, and no other form of the number.
  assert.strictEqual((INDEX.match(/wa\.me\/17828027841/g) || []).length, 1, 'single WhatsApp URL');
  assert.ok(!/\+17828027841/.test(INDEX), 'the number is not duplicated as a tel: link');
});

test('5. Alex keeps his existing Telegram link and is labelled the backup', () => {
  const { box } = renderPartner();
  assert.ok(box.innerHTML.includes('href="' + ALEX + '"'), 'Alex keeps https://t.me/AlexArbitrix');
  assert.match(box.innerHTML, /<i class="fab fa-telegram"[^>]*><\/i>/, 'Telegram icon');
  assert.match(box.innerHTML, /BACKUP CONTACT/, 'labelled as the backup');
  assert.match(box.innerHTML, /If you cannot reach Olivia on WhatsApp/, 'backup explanation present');
  assert.ok(!/t\.me\/OliviaArbitrix/.test(box.innerHTML), 'Olivia\'s old Telegram is never offered');
  assert.strictEqual((INDEX.match(/<meta name="arbitrix-partner-support-telegram" content="@AlexArbitrix">/g) || []).length, 1,
    'Alex is still configured from the one meta tag');
});

test('6. the approved heading and wording are used', () => {
  const T = dict();
  assert.strictEqual(T.en['deposit.partner.title'], 'Need help getting USDT?');
  assert.strictEqual(T.en['deposit.partner.intro'],
    'Our payment partners can help you obtain USDT and fund your Arbitrix account.');
  assert.strictEqual(T.en['deposit.partner.primaryLabel'], 'PRIMARY CONTACT \u2014 WHATSAPP');
  assert.strictEqual(T.en['deposit.partner.backupLabel'], 'BACKUP CONTACT \u2014 TELEGRAM');
  assert.strictEqual(T.en['deposit.partner.oliviaBtn'], 'Contact Olivia on WhatsApp');
  assert.strictEqual(T.en['deposit.partner.alexBtn'], 'Contact Alex on Telegram');
  assert.strictEqual(T.en['deposit.partner.alexNote'],
    'If you cannot reach Olivia on WhatsApp, contact Alex on Telegram for assistance.');
  assert.match(partnerPanel(), /data-i18n="deposit\.partner\.title"[^>]*>Need help getting USDT\?</);
  assert.match(partnerPanel(), /data-i18n="deposit\.partner\.intro"/);
});

// --------------------------------------------------- 7. switching the two routes

test('7. switching between the two funding options updates the view immediately', () => {
  const nodes = {
    depositCryptoFlow: { style: {} },
    depositPartnerPanel: { style: {} },
    depositOptionPartner: { classList: { _v: '', add(c) { this._v += ' ' + c; }, remove(c) { this._v = this._v.replace(' ' + c, ''); } } },
    depositOptionCrypto: { classList: { _v: '', add(c) { this._v += ' ' + c; }, remove(c) { this._v = this._v.replace(' ' + c, ''); } } }
  };
  const partnerBox = { style: {}, innerHTML: '' };
  const sb = sandbox('en', METAS, Object.assign({
    depositPartnerContacts: partnerBox,
    paymentPartnerContacts: { style: {}, innerHTML: '' }
  }, nodes));
  vm.runInContext('let depositOptionState = { selected: "crypto" };', sb);
  vm.runInContext(fn('selectDepositOption'), sb);
  vm.runInContext('renderDepositPartnerAssistance();', sb);

  // partner route
  vm.runInContext('selectDepositOption("partner");', sb);
  assert.notStrictEqual(nodes.depositPartnerPanel.style.display, 'none', 'partner panel visible');
  assert.strictEqual(nodes.depositCryptoFlow.style.display, 'none', 'crypto form hidden');
  assert.ok(/data-partner="olivia"/.test(partnerBox.innerHTML), 'partner contacts available');

  // back to the direct route: no partner content, the form is back
  vm.runInContext('selectDepositOption("crypto");', sb);
  assert.strictEqual(nodes.depositPartnerPanel.style.display, 'none', 'partner panel hidden');
  assert.strictEqual(nodes.depositCryptoFlow.style.display, 'block', 'crypto form visible');
  const flow = cryptoFlow();
  assert.ok(!/data-partner=|wa\.me|t\.me\//.test(flow), 'nothing partner-related can show in the crypto route');

  // and back again, without a reload
  vm.runInContext('selectDepositOption("partner");', sb);
  assert.notStrictEqual(nodes.depositPartnerPanel.style.display, 'none');
});

// ------------------------------------------------------------ 8. responsive/mobile

test('8. the partner buttons and copy stay mobile-friendly', () => {
  assert.match(INDEX, /\.payment-partner-card \.deposit-payment-partner\{margin:0;min-height:44px;\}/,
    'tappable buttons (>=44px)');
  assert.match(INDEX, /\.payment-partner-list\{display:grid;grid-template-columns:1fr;gap:8px;min-width:0;\}/,
    'single column first, min-width guard');
  assert.match(INDEX, /@media \(min-width:420px\)\{\.payment-partner-list\{grid-template-columns:1fr 1fr;\}\}/,
    'two columns on wider screens');
  assert.match(INDEX, /\.deposit-partner-note\{font-size:10\.5px;color:var\(--text-secondary\);line-height:1\.5;margin:0;overflow-wrap:anywhere;\}/,
    'the backup note wraps instead of overflowing');
  assert.match(INDEX, /\.payment-partner-whatsapp\{background:#25D366;border-color:#25D366;color:#04150B;\}/,
    'WhatsApp is visually distinct');
  assert.match(INDEX, /\.payment-partner-name\{font-size:12px;font-weight:700;color:var\(--text-primary\);overflow-wrap:anywhere;\}/,
    'names wrap');
});

// ------------------------------------------------------- 9. deposit flow untouched

test('9. Generate Payment and the deposit rules are untouched', () => {
  const flow = cryptoFlow();
  assert.match(flow, /id="getAddressBtn"/);
  assert.match(flow, /onclick="requestDepositAddress\(\)"/);
  assert.ok(/function requestDepositAddress\(/.test(INDEX), 'the generator still exists');
  assert.match(INDEX, /MIN_DEPOSIT:\s*100/, 'minimum deposit unchanged');
  assert.match(INDEX, /MIN_WITHDRAWAL:\s*700/, 'minimum withdrawal unchanged');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /PLATFORM_MIN_DEPOSIT_USD = 100/, 'server minimum unchanged');
  assert.match(server, /app\.post\('\/api\/payment\/create-invoice'/, 'invoice route unchanged');
  // The partner renderers cannot move money or call the network.
  for (const name of ['renderDepositPartnerAssistance', 'renderPaymentPartnerContacts']) {
    const body = fn(name);
    assert.ok(!/fetch\(|create-invoice|credit_payment_safe|record_trade|rpc\(/i.test(body),
      name + ' must not touch money or the network');
  }
});

// ---------------------------------------------------------------- 10. locales

test('10. the new keys exist, translated, in all six locales', () => {
  const T = dict();
  assert.deepStrictEqual(Object.keys(T).sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
  const keys = ['deposit.partner.title', 'deposit.partner.intro', 'deposit.partner.primaryLabel',
    'deposit.partner.backupLabel', 'deposit.partner.oliviaBtn', 'deposit.partner.alexBtn',
    'deposit.partner.alexNote'];
  const sizes = Object.keys(T).map((l) => Object.keys(T[l]).length);
  assert.strictEqual(new Set(sizes).size, 1, 'identical key counts');
  for (const locale of Object.keys(T)) {
    for (const key of keys) {
      assert.ok(String(T[locale][key] || '').trim(), locale + ' missing ' + key);
      if (locale !== 'en') assert.notStrictEqual(T[locale][key], T.en[key], locale + ' ' + key + ' untranslated');
    }
    // The retired crypto-route copy must be gone from every locale.
    assert.ok(!Object.prototype.hasOwnProperty.call(T[locale], 'deposit.crypto.partnerHelp'));
    assert.ok(!Object.prototype.hasOwnProperty.call(T[locale], 'deposit.crypto.partnerNote'));
  }
});

test('11. the partner cards render in Arabic (RTL) and Spanish without raw keys', () => {
  for (const locale of ['ar', 'es', 'pt', 'fr', 'zh']) {
    const { box } = renderPartner(locale);
    assert.ok(!/\{\{|\bundefined\b|deposit\.partner\./.test(box.innerHTML), locale + ' renders no raw key');
    assert.ok(box.innerHTML.includes(WHATSAPP), locale + ' keeps the WhatsApp link');
    assert.ok(box.innerHTML.includes(ALEX), locale + ' keeps the Telegram link');
  }
  assert.match(renderPartner('ar').box.innerHTML, /wa\.me\/17828027841/);
});
