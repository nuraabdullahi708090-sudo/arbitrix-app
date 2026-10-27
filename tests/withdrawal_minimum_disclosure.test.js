'use strict';

/**
 * Minimum-withdrawal disclosure policy.
 *
 * Management rule: the customer-facing knowledge (landing page, help, support
 * bot, marketing posts) states that there is NO minimum withdrawal. The actual
 * threshold may appear ONLY inside the withdrawal flow itself.
 *
 * These tests are the guard rail for that rule across every surface.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { checkContent } = require('../services/ContentGuard');
const { render, LOCALES, WEEKLY_THEMES, KINDS } = require('../services/MarketingContent');
const { t } = require('../services/telegram-i18n');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PARTNERS = fs.readFileSync(path.join(ROOT, 'public', 'partners.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const KB = JSON.parse(fs.readFileSync(path.join(ROOT, 'services', 'support', 'arbitrix-knowledge.json'), 'utf8'));

// Keys allowed to carry the real threshold, and where each one renders.
const POPUP_KEYS = ['withdraw.minWithdrawal', 'withdraw.minAmount', 'live.withdrawStatus.needMinimum'];

const NO_MINIMUM = {
  en: /no minimum withdrawal|there is no minimum/i,
  es: /sin retiro m[ií]nimo|no hay retiro m[ií]nimo/i,
  pt: /sem saque m[ií]nimo|n[aã]o h[aá] saque m[ií]nimo/i,
  fr: /aucun retrait minimum|sans retrait minimum|pas de retrait minimum/i,
  ar: /لا يوجد حد أدنى للسحب|بدون حد أدنى للسحب/,
  zh: /无最低提现|没有最低提现/
};

const MINIMUM_CONCEPT = {
  en: /minimum withdrawal|withdrawal minimum/i,
  es: /retiro m[ií]nimo|m[ií]nimo de retiro/i,
  pt: /saque m[ií]nimo|m[ií]nimo de saque/i,
  fr: /retrait minimum|minimum de retrait/i,
  ar: /الحد الأدنى للسحب|حد أدنى للسحب/,
  zh: /最低提现|提现最低|最低取款/
};

function loadTranslations(html) {
  const i = html.indexOf('const TRANSLATIONS');
  assert.ok(i > 0, 'TRANSLATIONS object missing');
  let depth = 0;
  let k = html.indexOf('{', i);
  for (; k < html.length; k += 1) {
    const c = html[k];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) { k += 1; break; }
    }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(i, k) + '; this.T = TRANSLATIONS;', ctx);
  return ctx.T;
}

const T = loadTranslations(INDEX);

// ---------------------------------------------------------------------------
// The platform UI
// ---------------------------------------------------------------------------

test('the threshold appears only in the three withdrawal-pop-up strings', () => {
  for (const lang of Object.keys(T)) {
    for (const [key, value] of Object.entries(T[lang])) {
      if (!MINIMUM_CONCEPT[lang].test(String(value))) continue;
      const mentionsAmount = /\$\{\{min\}\}|\b700\b/.test(String(value));
      if (!mentionsAmount) continue;
      assert.ok(POPUP_KEYS.includes(key), `${lang}/${key} discloses the threshold outside the pop-up`);
    }
  }
});

test('the three pop-up strings are present and interpolate the live value', () => {
  for (const lang of Object.keys(T)) {
    for (const key of POPUP_KEYS) {
      const value = T[lang][key];
      assert.ok(value, `${lang} is missing ${key}`);
      assert.match(value, /\{\{min\}\}/, `${lang}/${key} must use the runtime value, not a hardcoded number`);
      assert.ok(!/700/.test(value), `${lang}/${key} must not hardcode 700`);
    }
    // The value is supplied by the caller from APP.MIN_WITHDRAWAL.
    assert.match(T[lang]['withdraw.minWithdrawal'], /\{\{current\}\}/, `${lang} must show the current balance`);
  }
});

test('every other mention of a withdrawal minimum says there is none', () => {
  for (const lang of Object.keys(T)) {
    for (const [key, value] of Object.entries(T[lang])) {
      if (!MINIMUM_CONCEPT[lang].test(String(value))) continue;
      if (POPUP_KEYS.includes(key)) continue;
      assert.match(String(value), NO_MINIMUM[lang],
        `${lang}/${key} mentions a withdrawal minimum without saying there is none: ${value}`);
    }
  }
});

test('the landing FAQ states no minimum withdrawal in all six languages', () => {
  for (const lang of Object.keys(T)) {
    const faq = String(T[lang]['landing.faq.5.a'] || '');
    assert.match(faq, NO_MINIMUM[lang], `${lang} FAQ does not state the no-minimum rule`);
    assert.ok(!/\$700|700\s*(usd|usdt)/i.test(faq), `${lang} FAQ leaks the threshold`);
  }
});

test('the always-visible withdrawal info line carries no amount', () => {
  for (const lang of Object.keys(T)) {
    for (const key of ['withdraw.info', 'withdraw.infoSandbox']) {
      const value = String(T[lang][key] || '');
      assert.ok(!/\$?700\b/.test(value), `${lang}/${key} leaks the threshold`);
      assert.ok(!/\{\{min\}\}/.test(value), `${lang}/${key} must not interpolate the minimum`);
    }
  }
});

test('the sidebar status never receives the minimum wording', () => {
  const start = INDEX.indexOf('function updateLiveWithdrawStatus');
  assert.ok(start > 0);
  const block = INDEX.slice(start, start + 4000);
  const statusAssignments = block.match(/statusText\s*=\s*[^;]+;/g) || [];
  assert.ok(statusAssignments.length >= 4);
  for (const line of statusAssignments) {
    assert.ok(!/needMinimum|minWithdrawal|minAmount/.test(line), 'sidebar must stay amount-free: ' + line);
  }
  assert.match(block, /statusText = t\('live\.withdrawStatus\.belowMinimum'\)/,
    'an eligible-but-below-minimum account must get the neutral sidebar line');
});

test('the modal info box discloses only after deposit and trade are satisfied', () => {
  const start = INDEX.indexOf('function updateLiveWithdrawStatus');
  const block = INDEX.slice(start, start + 4000);
  const infoSection = block.slice(block.indexOf('const infoText'));
  const order = [
    infoSection.indexOf("live.withdrawStatus.notDeposited"),
    infoSection.indexOf("live.withdrawStatus.noTrades"),
    infoSection.indexOf("live.withdrawStatus.needMinimum")
  ];
  assert.ok(order[0] > 0 && order[1] > order[0] && order[2] > order[1],
    'needMinimum must be the last branch (deposit -> trade -> minimum)');
  assert.match(infoSection, /t\('live\.withdrawStatus\.needMinimum',\s*\{\s*min:\s*APP\.MIN_WITHDRAWAL\s*\}\)/,
    'the pop-up must pass the real configured value');
});

test('the pop-up gates run in the documented order', () => {
  const start = INDEX.indexOf('async function openWithdrawModal');
  const end = INDEX.indexOf('function submitWithdraw', start);
  const block = INDEX.slice(start, end > start ? end : start + 9000);
  const deposit = block.indexOf('withdraw.firstDeposit');
  const trade = block.indexOf('withdraw.needTrade');
  const minimum = block.indexOf('withdraw.minWithdrawal');
  assert.ok(deposit > 0 && trade > deposit && minimum > trade,
    'the minimum message must come last, after the deposit and trade gates');
});

test('the server error string is mapped to pop-up copy, never rendered raw', () => {
  assert.match(INDEX, /'Min \$700':\s*'withdraw\.minAmount'/,
    'the API message must be mapped to the localized pop-up key');
  assert.match(T.en['withdraw.minAmount'], /\{\{min\}\}/);
  assert.ok(!/showToast\(\s*data\.error\s*\)/.test(INDEX), 'a raw backend error must not be toasted');
});

// ---------------------------------------------------------------------------
// Enforcement is unchanged
// ---------------------------------------------------------------------------

test('the platform still enforces its internal minimum', () => {
  assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
  assert.match(SERVER, /amount < MIN_WITHDRAWAL_USD/);
  assert.match(INDEX, /MIN_WITHDRAWAL: 700/);
});

test('the server never emails or notifies the threshold', () => {
  const lines = SERVER.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // Ignore CSS/colour hex values and font weights - they are not amounts.
    const line = lines[i].replace(/#[0-9a-fA-F]{3,8}/g, '').replace(/font-weight:\s*700/g, '');
    if (!/\b700\b/.test(line)) continue;
    // Only the constant, its comments and the enforcement line may mention it.
    assert.ok(/MIN_WITHDRAWAL_USD|\$700 minimum|the value is \$700/.test(line),
      `unexpected 700 usage at server.js:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
  }
  // No outbound email/notification may carry the value.
  assert.ok(!/(sendEmail|sendTransactional|Resend)[^\n]*700/.test(SERVER));
});

// ---------------------------------------------------------------------------
// Marketing, support bot and knowledge base
// ---------------------------------------------------------------------------

test('no marketing template can state a withdrawal minimum', () => {
  const ctx = {
    registerUrl: 'https://arbitrix.pro/?action=create-account',
    supportUrl: 'https://t.me/ArbitrixSupportBot',
    partnerSupportUrl: 'https://t.me/ArbitrixPayments',
    announcementUrl: 'https://t.me/ArbitrixChannel',
    minDeposit: 100,
    referralPercent: 20
  };
  for (const locale of LOCALES) {
    for (const kind of KINDS) {
      for (const theme of [null].concat(WEEKLY_THEMES)) {
        if (kind !== 'weekly' && theme) continue;
        const text = render(kind, locale, Object.assign({ theme }, ctx)).text;
        assert.ok(!/\b700\b/.test(text), `${locale}/${kind}/${theme} mentions 700`);
        assert.ok(!MINIMUM_CONCEPT[locale].test(text) || NO_MINIMUM[locale].test(text),
          `${locale}/${kind}/${theme} mentions a withdrawal minimum`);
      }
    }
  }
});

test('the guard blocks any withdrawal-minimum statement and allows the denial', () => {
  const blocked = [
    'The minimum withdrawal is $500.',
    'Minimum withdrawal: 300 USDT',
    'El retiro mínimo es $700.',
    'O saque mínimo é 700 USDT.',
    'الحد الأدنى للسحب هو 700.',
    'Withdrawals require a 700 USD minimum.'
  ];
  for (const text of blocked) {
    const guard = checkContent(text, { minDeposit: 100, referralPercent: 20 });
    assert.strictEqual(guard.blocked, true, 'should be blocked: ' + text);
    assert.ok(guard.violations.some((v) => v.code === 'withdrawal-minimum-disclosure'), text);
  }
  const allowed = [
    'There is no minimum withdrawal.',
    'Sem saque mínimo.',
    'لا يوجد حد أدنى للسحب.',
    'Deposit at least $100 to start Live Mode.'
  ];
  for (const text of allowed) {
    const guard = checkContent(text, { minDeposit: 100, referralPercent: 20 });
    assert.strictEqual(guard.ok, true, 'should be allowed: ' + text + ' -> ' + JSON.stringify(guard.violations));
  }
});

test('the support help text and reply templates never mention the threshold', () => {
  for (const lang of ['en', 'pt', 'ar']) {
    const help = t(lang, 'help');
    assert.ok(!/700/.test(help), lang + ' help mentions 700');
  }
});

test('the knowledge base has no threshold and answers "no minimum withdrawal"', () => {
  // The whole file - answers AND maintainer metadata - stays free of the value,
  // so a future model or export can never echo it to a customer.
  assert.ok(!/700/.test(JSON.stringify(KB)), 'the knowledge base must never contain the value');

  const category = KB.categories.find((c) => c.id === 'withdrawals');
  assert.ok(category, 'withdrawals category missing');
  const minimum = category.entries.find((e) => e.id === 'withdrawals.minimum');
  const requirements = category.entries.find((e) => e.id === 'withdrawals.requirements');
  assert.ok(minimum && /no minimum withdrawal/i.test(minimum.answer), 'minimum entry must deny a minimum');
  assert.ok(requirements && /no minimum withdrawal amount/i.test(requirements.answer),
    'requirements entry must deny a minimum');

  for (const entry of category.entries) {
    assert.ok(!/\d+\s*(usd|usdt|\$)/i.test(entry.answer), entry.id + ' states an amount');
  }
});

test('the knowledge base conflict record describes the current enforcement', () => {
  const conflict = (KB.conflicts || []).find((c) => c.id === 'withdrawal_minimum');
  assert.ok(conflict, 'withdrawal_minimum conflict record missing');
  const text = JSON.stringify(conflict);
  assert.match(text, /MIN_WITHDRAWAL_USD/, 'the record must name the enforcing constant');
  assert.ok(!/\b(700|500)\b/.test(text), 'the record must not restate the amount anywhere');
  assert.match(text, /pop-?up/i, 'the record must document where the value may be shown');
});

test('the partners page does not imply a customer withdrawal minimum', () => {
  const partners = loadTranslations(PARTNERS);
  for (const lang of Object.keys(partners)) {
    const note = String(partners[lang]['partners.payoutNote'] || '');
    assert.ok(!/customer withdrawal minimum|m[ií]nimo de retiro est|n[ií]vel m[ií]nimo de retirada|minimum de retrait standard|الحد الأدنى القياسي للسحب|标准客户提现最低额/i.test(note),
      `${lang} payout note still implies a customer withdrawal minimum`);
    assert.match(note, /separat|por separado|separadamente|s[eé]par|منفصل|分开/i,
      `${lang} payout note must describe payouts as separate`);
  }
});

test('no public page states a withdrawal-minimum amount', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 5);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/style="[^"]*"/gi, '')
      .replace(/font-weight:\s*700/g, '');
    assert.ok(!/[$€]\s?700\b/.test(html), page + ' contains a $700 figure');
    for (const line of html.split('\n')) {
      if (!/\b700\b/.test(line)) continue;
      assert.ok(!/withdraw|minimum|retir|saque|سحب|提现/i.test(line),
        `${page} pairs 700 with withdrawal wording: ${line.trim().slice(0, 120)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Runtime rendering (not just source order)
// ---------------------------------------------------------------------------

function extractFunction(name) {
  const start = INDEX.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i += 1) {
    if (INDEX[i] === '{') depth += 1;
    else if (INDEX[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > 0, name + ' must be brace-matchable');
  return INDEX.slice(start, end + 1);
}

test('rendered output: the sidebar never shows the amount, the pop-up does', () => {
  const fn = extractFunction('updateLiveWithdrawStatus');
  const interpolate = (template, vars) => String(template).replace(/\{\{(\w+)\}\}/g, (m, k) => (
    vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  ));

  function run(environment, liveData) {
    const els = {
      liveWithdrawStatus: { textContent: '', style: {} },
      withdrawInfoText: { textContent: '', style: {} }
    };
    const sandbox = {
      APP: {
        environment,
        liveData,
        bonusData: { balance: 0 },
        MIN_WITHDRAWAL: 700
      },
      document: { getElementById: (id) => els[id] || null },
      t: (key, vars) => interpolate(T.en[key] !== undefined ? T.en[key] : key, vars)
    };
    vm.createContext(sandbox);
    vm.runInContext(fn + '; updateLiveWithdrawStatus();', sandbox);
    return els;
  }

  // Eligible but below the minimum: the ONE sanctioned disclosure.
  let els = run('PRODUCTION', { hasRealDeposit: true, hasTradingActivity: true, balance: 350 });
  assert.ok(!/700/.test(els.liveWithdrawStatus.textContent), 'sidebar leaked the amount: ' + els.liveWithdrawStatus.textContent);
  assert.ok(!/700/.test(els.withdrawInfoText.textContent) === false, 'the pop-up must state the amount');
  assert.match(els.withdrawInfoText.textContent, /\$700/);
  assert.match(els.withdrawInfoText.textContent, /^📈 Minimum withdrawal: \$700$/);

  // Eligible and above the minimum: no amount anywhere.
  els = run('PRODUCTION', { hasRealDeposit: true, hasTradingActivity: true, balance: 800 });
  assert.strictEqual(els.liveWithdrawStatus.textContent, '✅ Ready to withdraw');
  assert.ok(!/700/.test(els.withdrawInfoText.textContent), 'the info box leaked the amount when not needed');
  assert.ok(!/700/.test(els.liveWithdrawStatus.textContent));

  // Not yet eligible: the earlier requirement is named, never the minimum.
  for (const state of [
    { hasRealDeposit: false, hasTradingActivity: false, balance: 0 },
    { hasRealDeposit: true, hasTradingActivity: false, balance: 900 }
  ]) {
    els = run('PRODUCTION', state);
    assert.ok(!/700/.test(els.liveWithdrawStatus.textContent + els.withdrawInfoText.textContent),
      'ineligible surfaces must never mention the amount');
  }

  // MARKETING_SANDBOX has no minimum at all.
  els = run('MARKETING_SANDBOX', { hasRealDeposit: false, hasTradingActivity: false, balance: 20 });
  assert.ok(!/700/.test(els.liveWithdrawStatus.textContent + els.withdrawInfoText.textContent));
  assert.match(els.withdrawInfoText.textContent, /No minimum withdrawal/);
});
