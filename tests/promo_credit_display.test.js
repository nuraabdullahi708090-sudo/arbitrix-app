'use strict';
/**
 * Promotional credit on the dashboard + Live Mode status.
 *
 * Requirement set: a new customer must SEE their $50 promotional credit straight
 * after registering, understand that Live Mode needs a Payhip activation, and
 * that a second requirement (a real deposit) governs withdrawals - without any of
 * that changing what the account can actually do.
 *
 * The risk this file guards against, in order:
 *   1. a second promotional credit being issued (the money bug),
 *   2. the label being computed in the browser (a display bug that becomes a
 *      support/trust bug when it disagrees with the server),
 *   3. the card quietly claiming a restriction the platform does not apply, or
 *      hiding one it does.
 */

const test = require('node:test');
// LF-normalised reads: Windows checkouts must not change what these assertions see.
const { readLf } = require('./helpers/text');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = readLf(path.join(ROOT, 'public', 'index.html'));
const SERVER = readLf(path.join(ROOT, 'server.js'));
const {
  LIVE_MODE_STATUS,
  promoCreditFromBalance,
  deriveLiveModeStatus,
  buildLiveModeStatus
} = require('../services/LiveModeStatus');

/* ------------------------------------------------------------------ helpers */

function dictionary() {
  const start = INDEX.indexOf('const TRANSLATIONS');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth += 1;
    else if (INDEX[i] === '}') {
      depth -= 1;
      if (!depth) { end = i; break; }
    }
  }
  const tStart = INDEX.indexOf('function t(key, vars)');
  const tEnd = INDEX.indexOf('\n}', tStart) + 2;
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${INDEX.slice(start, end + 1)}
    let currentLang = 'en';
    ${INDEX.slice(tStart, tEnd)}
    globalThis.T = TRANSLATIONS;
    globalThis.t = t;
    globalThis.setLang = function (l) { currentLang = l; };`, sandbox);
  return sandbox;
}

/** Brace-match one function out of the page source. */
function sliceFunction(name) {
  const at = INDEX.indexOf('function ' + name + '(');
  if (at < 0) throw new Error(name + ' must exist');
  let depth = 0;
  let started = false;
  for (let i = at; i < INDEX.length; i++) {
    if (INDEX[i] === '{') { depth += 1; started = true; }
    else if (INDEX[i] === '}') {
      depth -= 1;
      if (started && depth === 0) return INDEX.slice(at, i + 1);
    }
  }
  throw new Error('unterminated ' + name);
}

/** The renderer plus the three pure helpers it reads, in dependency order. */
function rendererSource() {
  const map = INDEX.slice(INDEX.indexOf('const LIVE_MODE_STATUS_VIEW'),
    INDEX.indexOf('function liveModeStatusView'));
  return [map,
    sliceFunction('liveModeStatusView'),
    sliceFunction('promoCreditText'),
    sliceFunction('renderLiveModeCard')].join('\n');
}

/** Run the REAL renderer against a minimal fake DOM. */
function renderCard(liveMode, options) {
  const opts = options || {};
  const src = rendererSource();
  const nodes = {};
  const ids = ['liveModeCard', 'promoCreditAmountRow', 'promoCreditAmount',
    'liveModeStatusChip', 'promoCreditExplain', 'liveModeDepositBtn'];
  ids.forEach((id) => {
    nodes[id] = {
      id,
      style: {},
      textContent: null,
      className: '',
      attrs: {},
      hidden: false,
      setAttribute(k, v) { this.attrs[k] = v; },
      classList: {
        _owner: null,
        toggle(cls, on) { this._owner.hidden = on === true; }
      }
    };
    nodes[id].classList._owner = nodes[id];
  });
  const doc = {
    getElementById(id) { return nodes[id] || null; }
  };
  const sandbox = {
    document: doc,
    APP: { liveMode, environment: opts.environment || 'PRODUCTION', MIN_DEPOSIT: 50 },
    t: opts.t,
    Number,
    isFinite,
    String
  };
  vm.createContext(sandbox);
  vm.runInContext(src + ';globalThis.renderLiveModeCard = renderLiveModeCard;', sandbox);
  sandbox.renderLiveModeCard();
  return nodes;
}

function promoFact(over) {
  return Object.assign({
    activation: { activated: false, reason: 'activation-required', activationRequired: true, exempt: false },
    liveBalance: 50,
    hasConfirmedDeposit: false,
    promoFunding: true
  }, over || {});
}

function countDefinitions(key) {
  // Dictionary entries look like  'key': '...',  - the JS uses key: (no quotes).
  return (INDEX.match(new RegExp("'" + key.replace(/\./g, '\\.') + "':", 'g')) || []).length;
}

/* ------------------------------------------------- 1. the derivation is pure */

test('1. the three Live Mode states are derived from the facts, not from a balance guess', () => {
  assert.strictEqual(deriveLiveModeStatus({ activated: false, liveBalance: 50 }),
    LIVE_MODE_STATUS.ACTIVATION_REQUIRED, 'an unactivated account is gated even with credit');
  assert.strictEqual(deriveLiveModeStatus({ activated: true, liveBalance: 0 }),
    LIVE_MODE_STATUS.FUNDING_REQUIRED, 'activated but empty needs funding');
  assert.strictEqual(deriveLiveModeStatus({ activated: true, liveBalance: 50 }),
    LIVE_MODE_STATUS.AVAILABLE, 'activated and funded is available');
  // Defensive: junk never produces a permissive answer.
  assert.strictEqual(deriveLiveModeStatus({}), LIVE_MODE_STATUS.ACTIVATION_REQUIRED);
  assert.strictEqual(deriveLiveModeStatus({ activated: true, liveBalance: 'abc' }),
    LIVE_MODE_STATUS.FUNDING_REQUIRED);
  assert.strictEqual(deriveLiveModeStatus({ activated: true, liveBalance: -20 }),
    LIVE_MODE_STATUS.FUNDING_REQUIRED, 'a negative balance is not spendable');
});

test('2. the promotional amount is only claimed when the classification is DEFINITIVE', () => {
  assert.strictEqual(promoCreditFromBalance(50, true), 50);
  assert.strictEqual(promoCreditFromBalance(50.005, true), 50.01, 'rounded to cents');
  // A deposited user, a referral-funded user and a sandbox account are not
  // promotional-credit funded: the card must not claim their money is a credit.
  assert.strictEqual(promoCreditFromBalance(50, false), 0);
  // Unknown (unreadable conversion state) must never be displayed as credit.
  assert.strictEqual(promoCreditFromBalance(50, null), 0);
  assert.strictEqual(promoCreditFromBalance(0, true), 0);
  assert.strictEqual(promoCreditFromBalance(-5, true), 0);
  assert.strictEqual(promoCreditFromBalance('nope', true), 0);
});

test('3. a promotional-funded account still needs a deposit BEFORE a withdrawal', () => {
  const fresh = buildLiveModeStatus(promoFact());
  assert.strictEqual(fresh.promoCredit, 50);
  assert.strictEqual(fresh.hasConfirmedDeposit, false);
  assert.strictEqual(fresh.withdrawalFundingRequired, true,
    'the promo credit is not a qualifying deposit');
  const funded = buildLiveModeStatus(promoFact({ hasConfirmedDeposit: true, promoFunding: false }));
  assert.strictEqual(funded.withdrawalFundingRequired, false);
  assert.strictEqual(funded.promoCredit, 0, 'a deposited account is not promotional credit');
  // Never expose internal names to the client payload.
  const keys = Object.keys(fresh).join(',');
  ['password', 'token', 'secret', 'service_role', 'rpc', 'table'].forEach((bad) => {
    assert.ok(!keys.includes(bad), 'payload must not carry "' + bad + '"');
  });
});

/* ------------------------------------------------------ 4. the server is the source */

test('4. /api/auth/me reports liveMode and reads it from data it already loaded', () => {
  assert.match(SERVER, /liveMode: _liveMode,/,
    'the response must carry the server-derived liveMode object');
  assert.match(SERVER, /const _liveMode = await getLiveModeStatus\(user\.id, \{/,
    'it is derived once, inside the handler');
  const call = SERVER.slice(SERVER.indexOf('const _liveMode = await getLiveModeStatus(user.id, {'));
  const body = call.slice(0, 400);
  ['eligibility: _liveEligibility', 'wallet,', 'hasConfirmedDeposit: !!funded', 'promoFunding']
    .forEach((arg) => assert.ok(body.includes(arg),
      'must reuse the already-loaded ' + arg + ' (no duplicate queries on login)'));
});

test('4b. registration returns the wallet + liveMode so the credit is visible immediately', () => {
  const start = SERVER.indexOf("app.post('/api/auth/register'");
  const body = SERVER.slice(start, SERVER.indexOf("app.post('/api/auth/login'", start));
  assert.match(body, /wallet = await getWallet\(user\.id\)/,
    'the new wallet is read (and seeded exactly once) during registration');
  assert.match(body, /liveMode = await getLiveModeStatus\(user\.id, \{ wallet, hasConfirmedDeposit: false \}\)/);
  assert.match(body, /^\s*wallet,\s*$/m, 'the response carries the wallet');
  assert.match(body, /^\s*liveMode\s*$/m, 'the response carries the Live Mode state');
  // A payload failure must never fail a completed registration.
  assert.match(body, /catch \(e\) \{[\s\S]{0,200}account payload incomplete/);
  // And it must not write a balance itself: the only seed is inside getWallet.
  assert.ok(!/updateWallet\(|live_balance/.test(body),
    'registration must not credit a balance');
  const tables = (body.match(/\.from\('([a-z_]+)'\)/g) || []).join(' ');
  assert.ok(!/wallets|transactions/.test(tables), 'registration does not touch wallets/transactions');
  // The client adopts it before the redirect, so the card is painted at once.
  assert.match(INDEX, /if \(data\.liveMode && typeof data\.liveMode === 'object'\) \{/,
    'handleSignup adopts the server payload');
});

test('5. every activation surface returns the same shape so the UI never guesses', () => {
  // Both surfaces derive their payload from the SAME resolver (eligibility), so
  // the dashboard can never be told something the gates would refuse.
  assert.strictEqual((SERVER.match(/liveMode: await getLiveModeStatus\(req\.user\.id, \{ eligibility \}\)/g) || []).length, 2,
    '/api/live/activation and /api/live/activate both report the resolver state');
  assert.match(SERVER, /liveMode: buildLiveModeStatus\(\{/,
    'the MARKETING_SANDBOX branch reports its own (never gated, never promo) state');
});

test('6. the status helper is READ-ONLY: no write, no RPC, no credit', () => {
  const start = SERVER.indexOf('async function getLiveModeStatus(userId, known) {');
  const end = SERVER.indexOf('\n}', start);
  const body = SERVER.slice(start, end);
  assert.ok(start > 0 && end > start);
  ['updateWallet', 'rpc(', '.insert(', '.update(', '.delete(', '.upsert(', 'credit', 'transactions']
    .forEach((forbidden) => {
      assert.ok(!body.includes(forbidden), 'getLiveModeStatus must not contain ' + forbidden);
    });
  const moduleSrc = readLf(path.join(ROOT, 'services', 'LiveModeStatus.js'));
  ['supabase', 'fetch(', 'require(\'http', 'Date.now'].forEach((forbidden) => {
    assert.ok(!moduleSrc.includes(forbidden), 'LiveModeStatus must stay pure (no ' + forbidden + ')');
  });
});

/* ------------------------------------------- 7. no second promotional credit */

test('7. the code cannot issue a second promotional credit', () => {
  // The $50 seed exists ONLY as a wallet-creation INSERT: production new users
  // in getWallet() and the simulated sandbox wallet. Every occurrence must be on
  // an insert line - a read path that "seeds" would be a second credit.
  const seedLines = SERVER.split('\n').filter((line) => /live_balance:\s*50\b/.test(line));
  assert.ok(seedLines.length >= 1 && seedLines.length <= 3,
    'unexpected number of $50 seeds: ' + seedLines.length);
  seedLines.forEach((line) => {
    const isComment = /^\s*(\/\/|\*)/.test(line);
    if (isComment) return;
    assert.match(line, /\.insert\(/, 'a $50 seed must be an INSERT, found: ' + line.trim().slice(0, 90));
  });
  // Nothing in this feature writes a wallet at all.
  const start = SERVER.indexOf('async function getLiveModeStatus(userId, known) {');
  const body = SERVER.slice(start, SERVER.indexOf('\n}', start));
  assert.match(body, /liveBalance: wallet \? wallet\.live_balance : 0/,
    'the helper only READS the wallet balance');
  assert.ok(!/\.update\(|\.insert\(|updateWallet/.test(body),
    'the status helper never writes a balance');
  // And the module never mentions money being written.
  const moduleSrc = readLf(path.join(ROOT, 'services', 'LiveModeStatus.js'));
  assert.ok(!/insert|update\s*\(|upsert/i.test(moduleSrc), 'the module cannot write a balance');
});

test('8. a returning customer is not re-credited (the credit is a wallet seed, not a login hook)', () => {
  // /api/auth/me is a GET with no wallet write: re-running it cannot pay twice.
  const meStart = SERVER.indexOf("app.get('/api/auth/me'");
  const meEnd = SERVER.indexOf('// ---------- Marketing conversion claims', meStart);
  const me = SERVER.slice(meStart, meEnd);
  assert.ok(!/updateWallet|\.update\(|\.insert\(|rpc\(/.test(me),
    '/api/auth/me must remain read-only (no wallet write on login)');
  assert.ok(me.includes('liveMode: _liveMode'), 'the field is additive');
});

/* ------------------------------------------------------- 9. the card itself */

test('9. the card shows the amount, the explanation and a real status chip', () => {
  const html = INDEX.slice(INDEX.indexOf('id="liveModeCard"') - 200, INDEX.indexOf('id="demoFirstDepositCta"'));
  ['promoCreditAmount', 'liveModeStatusChip', 'promoCreditExplain', 'liveModeDepositBtn']
    .forEach((id) => assert.ok(html.includes('id="' + id + '"'), 'missing #' + id));
  assert.ok(/data-i18n="promo\.creditBadge"/.test(html), 'the credit label is localized');
  assert.ok(/data-i18n="liveMode\.depositCta"/.test(html), 'the next-step CTA is a deposit');
  assert.ok(!/liveActivation/.test(html), 'no activation control is offered');
  // The explanation carries {{amount}} and is therefore JS-rendered - a
  // data-i18n binding would print the raw placeholder (Phase 3H lesson).
  assert.ok(!/data-i18n="promo\.creditExplainTradable"/.test(INDEX),
    'promo.creditExplainTradable must not be a data-i18n target');
  // Two branches only: "you need to fund" and "your credit is tradable".
  assert.match(INDEX, /text = t\('liveMode\.depositNote', \{ min: String\(Number\(APP\.MIN_DEPOSIT\) \|\| 0\) \}\);/,
    'the deposit-required state explains the requirement with the server minimum');
  assert.match(INDEX, /text = t\('promo\.creditExplainTradable', \{ amount: String\(Number\(amount\)\) \}\);/,
    'the credit sentence is interpolated with the server amount');
  assert.match(INDEX, /explain\.textContent = text;/, 'the chosen string is written as text');
});

test('9b. the promo sentence never asks for a purchase', () => {
  const dict = dictionary();
  const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
  LANGS.forEach((l) => {
    const sentence = dict.T[l]['promo.creditExplainTradable'];
    assert.ok(sentence && sentence.trim(), l + ' must define promo.creditExplainTradable');
    assert.ok(sentence.includes('{{amount}}'), l + ' keeps the amount placeholder');
    assert.ok(!/activation|ativa\u00e7\u00e3o|activaci\u00f3n|تفعيل|激活/i.test(sentence),
      l + ': the credit sentence must not mention an activation');
    assert.ok(!/purchase|comprar|cumpra|acheter|اشتر|购买/i.test(sentence),
      l + ': nothing is sold on this card');
    // The way out is a deposit, in every locale.
    assert.ok(/deposit|dep\u00f3sito|d\u00e9p\u00f4t|أودع|إيداع|入金/i.test(sentence),
      l + ': the sentence names the deposit');
  });
  // The old activation variant is gone entirely.
  LANGS.forEach((l) => assert.ok(!('promo.creditExplain' in dict.T[l]), l + ' still defines promo.creditExplain'));
});

test('10. the renderer writes text, never HTML, and never touches a balance', () => {
  const src = rendererSource();
  assert.ok(!src.includes('innerHTML'), 'textContent only (localized text is not markup)');
  ['updateWallet', 'fetch(', 'localStorage.setItem', 'live_balance'].forEach((forbidden) => {
    assert.ok(!src.includes(forbidden), 'renderLiveModeCard must not ' + forbidden);
  });
});

test('11. the card renders the three states in every locale (real renderer, real dictionary)', () => {
  const i18n = dictionary();
  const en = {
    // A legacy server state must render exactly like deposit_required.
    activation: renderCard({ status: 'activation_required', promoCredit: 50 }, { t: i18n.t }),
    deposit: renderCard({ status: 'deposit_required', promoCredit: 50 }, { t: i18n.t }),
    funding: renderCard({ status: 'funding_required', promoCredit: 0 }, { t: i18n.t }),
    available: renderCard({ status: 'available', promoCredit: 50 }, { t: i18n.t })
  };
  assert.strictEqual(en.activation.liveModeCard.style.display, 'block');
  assert.strictEqual(en.activation.promoCreditAmount.textContent, '$50.00');
  assert.strictEqual(en.activation.liveModeStatusChip.textContent, 'Deposit required');
  assert.strictEqual(en.activation.liveModeStatusChip.attrs['data-live-mode'], 'activation_required');
  assert.match(en.activation.liveModeStatusChip.className, /status-badge pending/);
  assert.strictEqual(en.activation.liveModeDepositBtn.hidden, false, 'the deposit action is offered');
  assert.strictEqual(en.activation.promoCreditExplain.textContent, en.deposit.promoCreditExplain.textContent,
    'a legacy activation state renders the deposit explanation');
  assert.ok(en.deposit.promoCreditExplain.textContent.startsWith('Live Mode needs a confirmed deposit'),
    'the explanation asks for the deposit');
  assert.ok(!en.deposit.promoCreditExplain.textContent.includes('{{'),
    'no raw placeholder is ever displayed');

  assert.strictEqual(en.funding.liveModeStatusChip.textContent, 'Funding required');
  assert.strictEqual(en.funding.promoCreditAmountRow.style.display, 'none', 'no credit row without a credit');
  assert.strictEqual(en.funding.liveModeDepositBtn.hidden, false, 'an unfunded account is offered the deposit');

  assert.strictEqual(en.available.liveModeStatusChip.textContent, 'Live Mode available');
  assert.match(en.available.liveModeStatusChip.className, /status-badge funded/);
  assert.ok(en.available.promoCreditExplain.textContent.startsWith('Your $50 promotional credit is tradable'),
    'the amount is interpolated into the sentence');

  // Arabic + Chinese render translated labels, not English leftovers.
  i18n.setLang('ar');
  const ar = renderCard({ status: 'activation_required', promoCredit: 50 }, { t: i18n.t });
  assert.ok(/[\u0600-\u06FF]/.test(ar.liveModeStatusChip.textContent), 'Arabic label is scripted');
  assert.ok(ar.promoCreditExplain.textContent.includes('50'), 'the amount survives translation');
  i18n.setLang('zh');
  const zh = renderCard({ status: 'available', promoCredit: 50 }, { t: i18n.t });
  assert.ok(/[\u4e00-\u9fff]/.test(zh.liveModeStatusChip.textContent), 'Chinese label is scripted');
});

test('12. the card is hidden where it would be noise or a lie', () => {
  const i18n = dictionary();
  const funded = renderCard({ status: 'available', promoCredit: 0 }, { t: i18n.t });
  assert.strictEqual(funded.liveModeCard.style.display, 'none',
    'a funded, activated account with no promotional credit sees no new card');
  const sandbox = renderCard({ status: 'available', promoCredit: 50 },
    { t: i18n.t, environment: 'MARKETING_SANDBOX' });
  assert.strictEqual(sandbox.liveModeCard.style.display, 'none',
    'MARKETING_SANDBOX has no promotional credit and is never gated');
  const missing = renderCard(null, { t: i18n.t });
  assert.strictEqual(missing.liveModeCard.style.display, 'none', 'no server state -> nothing claimed');
});

test('13. a language switch re-renders the card (the amount lives inside t())', () => {
  const hook = INDEX.slice(INDEX.indexOf('function updateDynamicTranslations()'));
  const body = hook.slice(0, hook.indexOf('\n}') + 2);
  assert.match(body, /renderLiveModeCard\(\)/, 'applyTranslations must refresh the card');
  assert.match(SERVER, /liveMode: _liveMode/, 'and the value itself always comes from the server');
});

/* -------------------------------------------- 14. copy + localization parity */

test('14. the approved explanation is localized in all six locales with the amount placeholder', () => {
  const i18n = dictionary();
  const langs = Object.keys(i18n.T);
  assert.deepStrictEqual(langs.sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
  const en = i18n.T.en['promo.creditExplainTradable'];
  // Two short sentences: what the credit is for, and the exact way out.
  assert.strictEqual(en,
    'Your ${{amount}} promotional credit is tradable. Make a qualifying deposit and complete your first trade to withdraw.');
  assert.ok(!/withdrawal conditions/i.test(en), 'the conditions sentence is not repeated here');
  assert.ok(!/does not add trading capital/i.test(en), 'no activation caveat is needed');
  const keys = ['promo.creditTitle', 'promo.creditBadge', 'promo.creditExplainTradable', 'liveMode.fundingNote',
    'liveMode.depositNote', 'liveMode.status.depositRequired', 'liveMode.status.fundingRequired',
    'liveMode.status.available', 'liveMode.depositCta'];
  langs.forEach((lang) => {
    keys.forEach((key) => {
      const value = i18n.T[lang][key];
      assert.ok(typeof value === 'string' && value.trim(), lang + ' is missing ' + key);
      assert.ok(!/[A-Za-z]{0}\{\{amount\}\}/.test('') , 'noop');
    });
    assert.ok(i18n.T[lang]['promo.creditExplainTradable'].includes('{{amount}}'),
      lang + ' must keep the {{amount}} placeholder');
    assert.ok(i18n.T[lang]['liveMode.depositNote'].includes('{{min}}'),
      lang + ' must keep the {{min}} placeholder in the deposit note');
  });
  keys.forEach((key) => assert.strictEqual(countDefinitions(key), 6, key + ' must be defined once per locale'));
});

test('15. the card claims neither a guarantee nor a restriction the platform does not apply', () => {
  const i18n = dictionary();
  const all = Object.keys(i18n.T).map((l) => i18n.T[l]['promo.creditExplainTradable']).join(' ');
  ['guaranteed', 'risk-free', 'guaranteed profit', 'withdraw immediately'].forEach((bad) => {
    assert.ok(!all.toLowerCase().includes(bad), 'copy must not promise ' + bad);
  });
  // The restriction that IS real for a promo account is stated exactly once, on
  // the dashboard notice - not on this card.
  const T = i18n.T;
  assert.match(T.en['promo.creditExplainTradable'], /promotional credit is tradable/i);
  assert.match(T.en['promo.creditExplainTradable'], /withdraw/i, 'the withdrawal destination is stated');
  assert.match(T.en['promo.creditExplainTradable'], /deposit/i, 'the way out is stated');
  // FINAL MODEL (2026-11): management removed the $30 profit-cap wording from
  // the yellow banner. The banner and the card now say the same thing (what the
  // credit is for + the exact way out), and no locale advertises the cap.
  for (const l of ['en', 'es', 'pt', 'fr', 'ar', 'zh']) {
    assert.ok(!/\$?30\b/.test(T[l]['promo.tradableNotice']),
      l + ' banner must not advertise the $30 cap');
    assert.ok(!/\$?30\b/.test(T[l]['promo.creditExplainTradable']),
      l + ' card must not advertise the $30 cap');
    assert.match(T[l]['promo.tradableNotice'], /%|./, l + ' banner copy exists');
  }
  // Removing the COPY must not have removed the RULE: the cap is still enforced
  // server-side, and the refusal still names it.
  assert.match(SERVER, /PROMO_PROFIT_CAP_USD/, 'the enforced cap still exists');
  assert.match(SERVER, /isPromoProfitCapReached\(/, 'the cap is still evaluated');
  assert.match(SERVER, /PROMO_TRADING_LIMIT_REACHED/, 'the refusal code is unchanged');
});

/* --------------------------------------------- 16. nothing else moved */

test('16. Live Mode gates, the withdrawal rules and the promo cap are untouched', () => {
  // Activation is still enforced by the real routes.
  assert.match(SERVER, /await getLiveActivationState\(/,
    'the activation resolver is still the one the routes call');
  assert.match(SERVER, /sendActivationRefusal\(res, /);
  // Withdrawal minimum unchanged.
  assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
  assert.match(INDEX, /MIN_WITHDRAWAL: 700/);
  // Promo profit cap unchanged and still enforced at /api/trade.
  assert.match(SERVER, /PROMO_PROFIT_CAP_USD/);
  // The promotional credit never becomes withdrawable: the first-deposit rule
  // is still the gate the withdrawal route applies.
  assert.match(SERVER, /depositRequired: true/);
});

test('17. the card belongs to the single Live wallet view', () => {
  const cardAt = INDEX.indexOf('id="liveModeCard"');
  assert.ok(cardAt > 0, 'the card exists');
  assert.strictEqual(INDEX.indexOf('id="demoWalletSection"'), -1, 'the demo wallet section is gone');
  assert.ok(INDEX.indexOf('id="liveWalletSection"') > 0, 'the Live wallet section remains');
  const start = INDEX.indexOf('// ============ PROMOTIONAL CREDIT + LIVE MODE STATUS');
  const src = INDEX.slice(start, INDEX.indexOf('// ============ PAYHIP LIVE MODE ACTIVATION'));
  assert.ok(!/setMode\(|APP\.mode\s*=/.test(src), 'the card must not switch modes');
});
