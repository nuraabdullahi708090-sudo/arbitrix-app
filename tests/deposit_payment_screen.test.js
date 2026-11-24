'use strict';

/**
 * Deposit payment session (2026-11).
 *
 * Once an invoice exists the screen answers three questions in this order:
 * where to send, how much to send, and on which network. This suite pins that
 * contract end to end - detection, the exact strings, copy behaviour, the QR
 * payload, the removal of individual payment partners and the neutral wording -
 * by running the REAL showPaymentSection()/copy handlers against a fake DOM and
 * the REAL dictionary.
 *
 * Nothing here mocks the payment provider: the invoice object is exactly the
 * normalized shape services/providers/q8qpay.js returns.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readLf } = require('./helpers/text');

const ROOT = path.resolve(__dirname, '..');
const INDEX = readLf(path.join(ROOT, 'public', 'index.html'));
const SERVER = readLf(path.join(ROOT, 'server.js'));
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

const PAYOUT = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const INVOICE = {
  provider: 'q8qpay',
  id: 'INV-2026-0001',
  invoiceId: 'INV-2026-0001',
  payoutAddress: PAYOUT,
  amountUsdtExact: '50.0051',
  amount: '50.0051',
  currency: 'USDT',
  network: 'TRC20',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  qrData: null,
  whiteLabel: null
};

/* ------------------------------------------------------------------ helpers */

function dictionary() {
  const at = INDEX.indexOf('const TRANSLATIONS');
  assert.ok(at > 0, 'TRANSLATIONS must exist');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', at); i < INDEX.length; i += 1) {
    if (INDEX[i] === '{') depth += 1;
    else if (INDEX[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(INDEX.slice(at, end + 1) + ';globalThis.T = TRANSLATIONS;', sandbox);
  return sandbox.T;
}

function extractFunction(name) {
  const start = INDEX.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function ' + name + ' must exist');
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i += 1) {
    if (INDEX[i] === '{') depth += 1;
    else if (INDEX[i] === '}') {
      depth -= 1;
      if (depth === 0) return INDEX.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced function ' + name);
}

function fakeEl(id) {
  const el = {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  return el;
}

/**
 * Boots the payment-screen functions from the real bundle with:
 *  - a fake DOM that creates elements on demand,
 *  - the REAL dictionary (t) and the REAL setExactAmountInstruction /
 *    copyWalletAddress / copyDepositAmount / showPaymentSection,
 *  - stubs only for the surrounding side effects (timer, polling, progress).
 */
function boot(lang) {
  const T = dictionary();
  const els = new Map();
  const copied = [];
  const toasts = [];
  const calls = { timer: 0, poll: 0, progress: [], status: [], partnerLinks: 0, supportHelp: 0 };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, fakeEl(id));
        return els.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => []
    },
    t: (key, vars) => {
      let value = Object.prototype.hasOwnProperty.call(T[lang] || {}, key) ? T[lang][key] : (T.en[key] || key);
      if (vars) Object.keys(vars).forEach((k) => { value = value.split('{{' + k + '}}').join(String(vars[k])); });
      return value;
    },
    showToast: (msg, kind) => toasts.push({ msg, kind }),
    copyTextToClipboard: (text) => { copied.push(text); return Promise.resolve(true); },
    startDepositTimer: () => { calls.timer += 1; },
    startPollingForPayment: () => { calls.poll += 1; },
    updatePaymentProgress: (step) => { calls.progress.push(step); },
    updateCurrentStatus: (msg, colour) => { calls.status.push({ msg, colour }); },
    updatePaymentPartnerLinks: () => { calls.partnerLinks += 1; },
    updatePaymentSupportHelp: () => { calls.supportHelp += 1; },
    lastPaymentStatus: 'pending',
    currentInvoiceId: INVOICE.id,
    currentCurrency: 'USDT',
    currentNetwork: 'TRC20',
    isFinite,
    Number,
    String,
    Math,
    Date
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction('setExactAmountInstruction'),
    extractFunction('showPaymentSection'),
    extractFunction('copyWalletAddress'),
    extractFunction('copyDepositAmount'),
    extractFunction('copyInvoiceRef')
  ].join('\n'), sandbox);

  return { sandbox, els, copied, toasts, calls, T };
}

/** The payment section markup as shipped (from <div id="depositPaymentSection" to step 3). */
function paymentSection() {
  const start = INDEX.indexOf('<div id="depositPaymentSection"');
  const end = INDEX.indexOf('<!-- STEP 3: SUCCESS SECTION', start);
  assert.ok(start > 0 && end > start, 'payment section must exist');
  return INDEX.slice(start, end);
}

/* ------------------------------------------------------- 1. invoice display */

test('1. a successful invoice immediately shows the receiving address and the exact amount', async () => {
  const { sandbox, els, calls } = boot('en');
  sandbox.showPaymentSection(INVOICE, 50);

  assert.strictEqual(els.get('depositPaymentSection').style.display, 'block', 'payment screen shown');
  assert.strictEqual(els.get('depositInputSection').style.display, 'none', 'input step hidden');
  assert.strictEqual(els.get('liveWalletAddress').textContent, PAYOUT,
    'the address comes straight from the invoice');
  assert.strictEqual(els.get('liveDepositDisplayAmount').textContent, '50.0051',
    'the EXACT provider amount, including its precision');
  assert.strictEqual(sandbox.window.currentPaymentAddress, PAYOUT);
  assert.strictEqual(sandbox.window.currentPaymentAmount, '50.0051');
  assert.strictEqual(calls.poll, 1, 'payment polling still starts');
  assert.strictEqual(calls.progress[0], 'created', 'progress starts at Created');
});

test('2. the address panel precedes the amount, network, QR and status in the shipped markup', () => {
  const section = paymentSection();
  const pos = (needle) => {
    const at = section.indexOf(needle);
    assert.ok(at > 0, needle + ' must exist in the payment section');
    return at;
  };
  const order = [
    'pay-panel-address',
    'pay-panel-amount',
    'pay-panel-network',
    'pay-qr',
    'pay-warning',
    'pay-status'
  ].map(pos);
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1] < order[i], 'payment sections must be ordered: ' + i);
  }
  // The old flow listed the amount block first and the address after the QR.
  assert.ok(pos('id="walletAddressContainer"') < pos('id="qrCodeImage"'), 'address before the QR');
});

test('3. the screen carries the exact-amount + TRC20 warning in every locale', () => {
  const T = dictionary();
  assert.strictEqual(T.en['deposit.paymentWarning'],
    'Send USDT only through the TRON (TRC20) network. Send the exact amount displayed above.');
  LANGS.forEach((l) => {
    const value = T[l]['deposit.paymentWarning'];
    assert.ok(value && value.trim(), l + ' warning copy');
    assert.match(value, /TRON \(TRC20\)/, l + ' names the network');
    assert.match(value, /USDT/, l + ' names the asset');
  });
  assert.match(paymentSection(), /data-i18n="deposit\.paymentWarning"/);
});

/* ------------------------------------------------------------ 2. copy exact */

test('4. Copy Address copies the exact invoice address', async () => {
  const { sandbox, copied, toasts } = boot('en');
  sandbox.showPaymentSection(INVOICE, 50);
  sandbox.copyWalletAddress();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(copied, [PAYOUT], 'the full address, unmodified');
  const last = toasts[toasts.length - 1];
  assert.strictEqual(last.msg, 'Address copied to clipboard!');
  assert.strictEqual(last.kind, 'success');
});

test('5. Copy Amount copies the exact invoice amount, not a rounded display value', async () => {
  const { sandbox, copied } = boot('en');
  // 50.0051 would round to 50.01 with 2dp, so copying must not come from a
  // reformatted value.
  sandbox.showPaymentSection(INVOICE, 50);
  sandbox.copyDepositAmount();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(copied, ['50.0051']);
  assert.notStrictEqual(copied[0], '50.01');
});

test('6. a provider amount with more precision is preserved verbatim', async () => {
  const { sandbox, els, copied } = boot('en');
  const invoice = Object.assign({}, INVOICE, { amountUsdtExact: '50.002037' });
  sandbox.showPaymentSection(invoice, 50);
  assert.strictEqual(els.get('liveDepositDisplayAmount').textContent, '50.002037');
  sandbox.copyDepositAmount();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(copied, ['50.002037']);
});

/* ------------------------------------------------------------------ 3. QR */

test('7. the QR encodes the actual invoice address, amount and network', () => {
  const { sandbox, els } = boot('en');
  sandbox.showPaymentSection(INVOICE, 50);
  const html = els.get('qrCodeImage').innerHTML;
  const m = html.match(/src="([^"]+)"/);
  assert.ok(m, 'a QR image is rendered');
  const url = m[1].replace(/&amp;/g, '&');
  assert.match(url, /^https:\/\/api\.qrserver\.com\/v1\/create-qr-code\//);
  const data = decodeURIComponent((url.match(/[?&]data=([^&]+)/) || [])[1] || '');
  assert.ok(data.indexOf(PAYOUT) !== -1, 'the QR contains the invoice address');
  assert.ok(data.indexOf('amount=50.0051') !== -1, 'the QR contains the exact amount');
  assert.ok(data.indexOf('network=TRC20') !== -1, 'the QR states the network');
  assert.ok(data.indexOf('token=USDT') !== -1);
});

test('8. a provider-supplied qrData is used verbatim', () => {
  const { sandbox, els } = boot('en');
  const invoice = Object.assign({}, INVOICE, { qrData: 'tron:' + PAYOUT + '?amount=50.0051' });
  sandbox.showPaymentSection(invoice, 50);
  const url = els.get('qrCodeImage').innerHTML.match(/src="([^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.ok(decodeURIComponent(url).indexOf('tron:' + PAYOUT) !== -1);
});

/* ------------------------------------------------------- 4. network clarity */

test('9. the network is stated explicitly as USDT - TRON (TRC20)', () => {
  const section = paymentSection();
  assert.match(section, /id="q8qpayNetworkBadge"/);
  assert.match(section, /USDT<\/span>/);
  assert.match(section, /TRON \(TRC20\)<\/span>/);
  assert.match(section, /data-i18n="deposit\.networkLabel"/);
  const T = dictionary();
  LANGS.forEach((l) => {
    assert.ok(T[l]['deposit.networkLabel'].trim(), l + ' network label');
  });
});

/* ------------------------------------------------ 5. no individual partners */

test('10. the generated payment session carries no Alex/Olivia card or contact wording', () => {
  // Strip HTML comments: the markup documents WHY partners were removed.
  const section = paymentSection().replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/id="paymentPartnerContacts"/.test(section), 'no partner container');
  assert.ok(!/data-partner="(alex|olivia)"/i.test(section), 'no partner buttons');
  assert.ok(!/Contact (Alex|Olivia)/i.test(section), 'no instruction to contact a person');
  assert.ok(!/Payment Partner/i.test(section), 'no payment-partner role wording');
  assert.ok(!/t\.me\//.test(section), 'no partner Telegram destination');

  // The shared renderer can no longer inject one either.
  const fn = extractFunction('renderPaymentPartnerContacts');
  assert.match(fn, /const containers = \[\];/);
});

test('11. official Kalderix support remains available in the payment session and elsewhere', () => {
  const section = paymentSection();
  assert.match(section, /id="paymentSupportFallbackBtn"[^>]*onclick="openSupportModal\(\)"/);
  assert.match(section, /data-i18n="support\.contactOfficial"/);
  // General support is still reachable from the app shell.
  assert.match(INDEX, /<meta name="arbitrix-support-telegram"/);
  assert.match(INDEX, /id="supportSidebarLink"/);
  assert.match(INDEX, /function openSupportModal/);
  // ... and the payment help copy points at it, not at a person.
  const T = dictionary();
  LANGS.forEach((l) => {
    ['support.paymentHelp.pending', 'support.paymentHelp.detected', 'support.paymentHelp.failed'].forEach((k) => {
      const value = T[l][k];
      assert.ok(value && value.trim(), l + ':' + k);
      assert.ok(!/(partner|Alex|Olivia)/i.test(value), l + ':' + k + ' must not name a payment partner');
    });
  });
});

/* ------------------------------------------------- 6. activity-log wording */

test('12. no misleading "the log below" wording remains in any locale', () => {
  const T = dictionary();
  assert.ok(!/Activity appears in the log below/.test(INDEX), 'the removed sentence is gone from the page');
  LANGS.forEach((l) => {
    const value = T[l]['bot.engineNotice'];
    assert.ok(value && value.trim(), l + ' notice copy');
    assert.ok(!/log below|journal ci-dessous|registro de abajo|registro abaixo|السجل أدناه|下方记录/i.test(value),
      l + ' must not point at a log "below"');
    assert.ok(!/tab/i.test(value), l + ' must not talk about the tab');
  });
  assert.strictEqual(T.en['bot.engineNotice'],
    'Your bot executes trades automatically on supported markets while it is running.',
    'the replacement is accurate whether the bot is running or stopped');
});

/* ------------------------------------------------------ 7. no false claims */

test('13. the receiving address is never described as unique or personal', () => {
  const T = dictionary();
  LANGS.forEach((l) => {
    const value = T[l]['deposit.addressExplain'];
    assert.ok(value && value.trim(), l + ' hint copy');
    assert.ok(!/\bpersonal\b|\bunique\b|\bexclusive\b|your own/i.test(value),
      l + ' must not claim a unique/personal address (q8qpay assignment is not verified)');
    assert.match(value, /TRON \(TRC20\)/, l + ' names the network');
  });
});

/* -------------------------------------------------- 8. mechanics untouched */

test('14. webhook reconciliation, polling and crediting are untouched', () => {
  // The client still polls and still relies on the server to confirm.
  assert.match(INDEX, /startPollingForPayment\(currentInvoiceId\)/);
  assert.match(INDEX, /async function startPollingForPayment|function startPollingForPayment/);
  // The provider webhook + signature + re-verification path is unchanged.
  assert.match(SERVER, /app\.post\('\/api\/webhook\/q8qpay'/);
  assert.match(SERVER, /X-Webhook-Signature/i);
  assert.match(SERVER, /credit_payment_safe/);
  // The exact amount the customer is told to send is the one the webhook checks.
  assert.match(SERVER, /amountUsdtExact/);
  const provider = readLf(path.join(ROOT, 'services', 'providers', 'q8qpay.js'));
  assert.match(provider, /payoutAddress: data\.payoutAddress/, 'the address comes from the provider response');
  assert.match(provider, /amountUsdtExact: data\.amountUsdtExact/, 'the amount comes from the provider response');
  // Crediting is never driven by a screenshot or a customer-supplied hash.
  assert.ok(!/req\.body\.txHash.*credit|screenshot.*credit/i.test(SERVER));
});

test('15. nothing on the payment screen echoes a hardcoded address or amount', () => {
  const section = paymentSection();
  assert.ok(!/T[A-Za-z0-9]{33}/.test(section), 'no literal TRC20 address in the markup');
  assert.match(section, /id="liveDepositDisplayAmount">0\.00</, 'placeholder only');
  assert.match(section, /id="liveWalletAddress"[^>]*>Loading\.\.\.</, 'placeholder only');
});

/* -------------------------------------------------------- 9. mobile layout */

test('16. the mobile layout contract: wrapping address, big tap targets, large QR', () => {
  const css = INDEX.slice(INDEX.indexOf('.pay-address{'), INDEX.indexOf('@media (max-width:430px){') + 400);
  assert.ok(/\.pay-address\{[^}]*word-break:break-all/.test(css), 'the address may break anywhere');
  assert.ok(/\.pay-address\{[^}]*overflow-wrap:anywhere/.test(css), 'no horizontal overflow from the address');
  assert.ok(/\.pay-address\{[^}]*color:#7CF7C4/.test(css), 'high-contrast address colour');
  assert.ok(/\.pay-copy-btn\{[^}]*min-height:48px/.test(css), 'copy target is >= 48px');
  assert.ok(/\.pay-copy-btn\{[^}]*width:100%/.test(css), 'copy target spans the panel');
  assert.ok(/\.pay-qr-box\{[^}]*width:200px/.test(css), 'QR is large on desktop');
  assert.ok(/@media \(max-width:430px\)\{[\s\S]{0,240}\.pay-qr-box\{width:180px/.test(css), 'QR stays >= 180px on phones');
  assert.ok(/@media \(max-width:430px\)\{[\s\S]{0,240}\.pay-copy-btn\{min-height:50px/.test(css), 'bigger target on phones');
  assert.ok(/\.pay-address\{[^}]*user-select:all/.test(css), 'the address can be selected in one gesture');
});

test('17. the copy actions degrade safely when there is no invoice', async () => {
  const { sandbox, copied } = boot('en');
  // No showPaymentSection() call: the raw values are empty and the placeholders
  // must not be copied.
  sandbox.copyWalletAddress();
  sandbox.copyDepositAmount();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(copied, []);
  // resetDepositModal() clears them explicitly.
  const reset = extractFunction('resetDepositModal');
  assert.match(reset, /window\.currentPaymentAddress = ''/);
  assert.match(reset, /window\.currentPaymentAmount = ''/);
});

test('18. i18n parity: 1597 keys, identical sets, no empties', () => {
  const T = dictionary();
  const base = Object.keys(T.en).sort();
  assert.strictEqual(base.length, 1597);
  const keys = base.join('|');
  LANGS.forEach((l) => {
    assert.strictEqual(Object.keys(T[l]).sort().join('|'), keys, l + ' identical key set');
    Object.entries(T[l]).forEach(([k, v]) => {
      assert.ok(typeof v === 'string' && v.trim(), l + ':' + k + ' must not be empty');
    });
    ['deposit.sendTitle', 'deposit.sendIntro', 'deposit.networkLabel', 'deposit.paymentWarning']
      .forEach((k) => assert.ok(T[l][k], l + ' missing ' + k));
  });
});
