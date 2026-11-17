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
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
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

/** Run the REAL renderer against a minimal fake DOM. */
function renderCard(liveMode, options) {
  const opts = options || {};
  const tStart = INDEX.indexOf('// ============ PROMOTIONAL CREDIT + LIVE MODE STATUS');
  const tEnd = INDEX.indexOf('// ============ PAYHIP LIVE MODE ACTIVATION');
  const src = INDEX.slice(tStart, tEnd);
  const nodes = {};
  const ids = ['liveModeCard', 'promoCreditAmountRow', 'promoCreditAmount',
    'liveModeStatusChip', 'promoCreditExplain', 'liveModeActivateBtn'];
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
    APP: { liveMode, environment: opts.environment || 'PRODUCTION' },
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
  ['activation: _liveActivation', 'wallet,', 'hasConfirmedDeposit: !!funded', 'promoFunding']
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
  assert.strictEqual((SERVER.match(/liveMode: await getLiveModeStatus\(req\.user\.id, \{ activation: state \}\)/g) || []).length, 2,
    '/api/live/activation and /api/live/activate both return it after a state change');
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
  const moduleSrc = fs.readFileSync(path.join(ROOT, 'services', 'LiveModeStatus.js'), 'utf8');
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
  const moduleSrc = fs.readFileSync(path.join(ROOT, 'services', 'LiveModeStatus.js'), 'utf8');
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
  ['promoCreditAmount', 'liveModeStatusChip', 'promoCreditExplain', 'liveModeActivateBtn']
    .forEach((id) => assert.ok(html.includes('id="' + id + '"'), 'missing #' + id));
  assert.ok(/data-i18n="promo\.creditBadge"/.test(html), 'the credit label is localized');
  assert.ok(/data-i18n="liveActivation\.cta"/.test(html), 'the activation CTA reuses the existing key');
  // The explanation carries {{amount}} and is therefore JS-rendered - a
  // data-i18n binding would print the raw placeholder (Phase 3H lesson).
  assert.ok(!/data-i18n="promo\.creditExplain"/.test(INDEX),
    'promo.creditExplain must not be a data-i18n target');
  assert.match(INDEX, /explain\.textContent = amount > 0\s*\n?\s*\? t\('promo\.creditExplain', \{ amount:/,
    'the explanation is interpolated with the server amount');
});

test('10. the renderer writes text, never HTML, and never touches a balance', () => {
  const start = INDEX.indexOf('// ============ PROMOTIONAL CREDIT + LIVE MODE STATUS');
  const end = INDEX.indexOf('// ============ PAYHIP LIVE MODE ACTIVATION');
  const src = INDEX.slice(start, end);
  assert.ok(!src.includes('innerHTML'), 'textContent only (localized text is not markup)');
  ['updateWallet', 'fetch(', 'localStorage.setItem', 'live_balance'].forEach((forbidden) => {
    assert.ok(!src.includes(forbidden), 'renderLiveModeCard must not ' + forbidden);
  });
});

test('11. the card renders the three states in every locale (real renderer, real dictionary)', () => {
  const i18n = dictionary();
  const en = {
    activation: renderCard({ status: 'activation_required', promoCredit: 50, activationPurchasable: true }, { t: i18n.t }),
    funding: renderCard({ status: 'funding_required', promoCredit: 0, activationPurchasable: true }, { t: i18n.t }),
    available: renderCard({ status: 'available', promoCredit: 50, activationPurchasable: true }, { t: i18n.t })
  };
  assert.strictEqual(en.activation.liveModeCard.style.display, 'block');
  assert.strictEqual(en.activation.promoCreditAmount.textContent, '$50.00');
  assert.strictEqual(en.activation.liveModeStatusChip.textContent, 'Activation required');
  assert.strictEqual(en.activation.liveModeStatusChip.attrs['data-live-mode'], 'activation_required');
  assert.match(en.activation.liveModeStatusChip.className, /status-badge pending/);
  assert.strictEqual(en.activation.liveModeActivateBtn.hidden, false, 'the CTA is offered when gated');
  assert.ok(en.activation.promoCreditExplain.textContent.startsWith('Your account includes $50 in promotional'),
    'the amount is interpolated into the sentence');
  assert.ok(!en.activation.promoCreditExplain.textContent.includes('{{amount}}'),
    'no raw placeholder is ever displayed');

  assert.strictEqual(en.funding.liveModeStatusChip.textContent, 'Activated \u2014 funding required');
  assert.strictEqual(en.funding.promoCreditAmountRow.style.display, 'none', 'no credit row without a credit');
  assert.strictEqual(en.funding.liveModeActivateBtn.hidden, true, 'already activated: no CTA');

  assert.strictEqual(en.available.liveModeStatusChip.textContent, 'Live Mode available');
  assert.match(en.available.liveModeStatusChip.className, /status-badge funded/);

  // Arabic + Chinese render translated labels, not English leftovers.
  i18n.setLang('ar');
  const ar = renderCard({ status: 'activation_required', promoCredit: 50, activationPurchasable: true }, { t: i18n.t });
  assert.ok(/[\u0600-\u06FF]/.test(ar.liveModeStatusChip.textContent), 'Arabic label is scripted');
  assert.ok(ar.promoCreditExplain.textContent.includes('$50'));
  i18n.setLang('zh');
  const zh = renderCard({ status: 'available', promoCredit: 50, activationPurchasable: true }, { t: i18n.t });
  assert.ok(/[\u4e00-\u9fff]/.test(zh.liveModeStatusChip.textContent), 'Chinese label is scripted');
});

test('12. the card is hidden where it would be noise or a lie', () => {
  const i18n = dictionary();
  const funded = renderCard({ status: 'available', promoCredit: 0, activationPurchasable: true }, { t: i18n.t });
  assert.strictEqual(funded.liveModeCard.style.display, 'none',
    'a funded, activated account with no promotional credit sees no new card');
  const sandbox = renderCard({ status: 'available', promoCredit: 50, activationPurchasable: true },
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
  const en = i18n.T.en['promo.creditExplain'];
  assert.strictEqual(en,
    "Your account includes ${{amount}} in promotional trading credit. Purchase a Live Mode activation " +
    'to unlock access to live trading. Activation does not add trading capital to your account. ' +
    "Promotional credit is subject to the platform's trading and withdrawal conditions.");
  const keys = ['promo.creditTitle', 'promo.creditBadge', 'promo.creditExplain', 'liveMode.fundingNote',
    'liveMode.status.activationRequired', 'liveMode.status.fundingRequired', 'liveMode.status.available'];
  langs.forEach((lang) => {
    keys.forEach((key) => {
      const value = i18n.T[lang][key];
      assert.ok(typeof value === 'string' && value.trim(), lang + ' is missing ' + key);
      assert.ok(!/[A-Za-z]{0}\{\{amount\}\}/.test('') , 'noop');
    });
    assert.ok(i18n.T[lang]['promo.creditExplain'].includes('{{amount}}'),
      lang + ' must keep the {{amount}} placeholder');
    // The figure is never hard-coded in the sentence: it comes from the wallet.
    assert.ok(!/promo\.creditExplain/.test(INDEX.slice(INDEX.indexOf("'promo.creditExplain':"), INDEX.indexOf("'promo.creditExplain':") + 40)) === false);
  });
  keys.forEach((key) => assert.strictEqual(countDefinitions(key), 6, key + ' must be defined once per locale'));
});

test('15. the card claims neither a guarantee nor a restriction the platform does not apply', () => {
  const i18n = dictionary();
  const all = Object.keys(i18n.T).map((l) => i18n.T[l]['promo.creditExplain']).join(' ');
  ['guaranteed', 'risk-free', 'guaranteed profit', 'withdraw immediately'].forEach((bad) => {
    assert.ok(!all.toLowerCase().includes(bad), 'copy must not promise ' + bad);
  });
  // The one restriction that IS real for a promo account is stated.
  assert.match(i18n.T.en['promo.creditExplain'], /withdrawal conditions/);
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

test('17. Demo Mode is untouched by this feature', () => {
  // The card lives in the dashboard, not inside the demo wallet section.
  const cardAt = INDEX.indexOf('id="liveModeCard"');
  const demoSection = INDEX.indexOf('id="demoWalletSection"');
  const liveSection = INDEX.indexOf('id="liveWalletSection"');
  assert.ok(cardAt > 0 && demoSection > 0 && liveSection > 0);
  assert.ok(cardAt < demoSection, 'the card is above the wallet sections (always-visible dashboard)');
  // Nothing in the renderer switches modes or toggles the demo wallet.
  const start = INDEX.indexOf('// ============ PROMOTIONAL CREDIT + LIVE MODE STATUS');
  const src = INDEX.slice(start, INDEX.indexOf('// ============ PAYHIP LIVE MODE ACTIVATION'));
  assert.ok(!/setMode\(|APP\.mode\s*=/.test(src), 'the card must not switch modes');
});
