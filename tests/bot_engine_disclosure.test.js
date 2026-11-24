/**
 * The bot engine disclosure must never mislead: while the tab-bound loop is the
 * executor it must say so, and the moment a server-side worker owns the session
 * it must say THAT (otherwise a user would be told "closing the tab stops
 * trading" while a worker keeps trading their money - a concealed condition).
 *
 * The switch is driven by the server's own 409 WORKER_OWNED_SESSION response, so
 * it cannot be missed at cutover and needs no manual copy edit.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
// Code-only view, so a negative assertion cannot trip over an explanatory comment.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function translations() {
  const tIdx = INDEX.indexOf('const TRANSLATIONS');
  let i = INDEX.indexOf('{', tIdx), depth = 0, end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
  return sandbox.__T;
}

test('both disclosure variants exist and are non-empty in all 6 locales', () => {
  const T = translations();
  for (const l of LANGS) {
    for (const k of ['bot.engineNotice', 'bot.engineNoticeWorker', 'bot.workerManaged']) {
      assert.ok(T[l][k] && String(T[l][k]).trim().length > 20, l + '.' + k + ' missing/short');
    }
  }
});

test('the notice never claims more than the server proves: neutral browser copy, background copy only for server-owned sessions', () => {
  const T = translations();
  for (const l of LANGS) {
    assert.notStrictEqual(T[l]['bot.engineNotice'], T[l]['bot.engineNoticeWorker'], l + ' variants must differ');
  }
  // EN is the pinned contract (per-locale wording is reviewed, not machine-checked).
  // FINAL MODEL (2026-11): management removed the tab-closure warning. The
  // browser variant states only what is true in every deployment (a running bot
  // trades; activity is logged), and the background promise belongs to the
  // variant the server selects when a worker owns the session.
  assert.strictEqual(
    T.en['bot.engineNotice'],
    'Your bot trades automatically while it is running. Activity appears in the log below.'
  );
  assert.strictEqual(
    T.en['bot.engineNoticeWorker'],
    'Your bot runs automatically in the background, even when you close this page or switch to another app. Return anytime to monitor your trading activity.'
  );
  // The obsolete tab warning must not survive in ANY locale.
  const TAB_WARNING = /\btab\b|pesta\u00f1a|\baba\b|onglet|\u0639\u0644\u0627\u0645\u0629 \u062a\u0628\u0648\u064a\u0628|\u6807\u7b7e\u9875|\u5237\u65b0|actualis|actualiz|recarreg/i;
  for (const l of LANGS) {
    assert.ok(!TAB_WARNING.test(T[l]['bot.engineNotice']), l + ' browser copy still warns about the tab: ' + T[l]['bot.engineNotice']);
    assert.ok(!TAB_WARNING.test(T[l]['bot.engineNoticeWorker']), l + ' background copy still mentions the tab: ' + T[l]['bot.engineNoticeWorker']);
  }
  assert.ok(!INDEX.includes('Keep this tab open'), 'the obsolete warning is gone from the document');
  // The third variant covers "status not readable yet": it must be true in BOTH
  // engine modes, because guessing is exactly what this disclosure avoids.
  for (const l of LANGS) {
    assert.ok(T[l]['bot.engineNoticeUnknown'] && String(T[l]['bot.engineNoticeUnknown']).trim().length > 20,
      l + '.bot.engineNoticeUnknown missing/short');
  }
  assert.match(T.en['bot.engineNoticeUnknown'], /status is shown above/i);
  assert.match(T.en['bot.workerManaged'], /runs automatically/i);
});

test('the old technical bot wording is fully replaced in all 6 locales', () => {
  const T = translations();
  assert.strictEqual(
    T.en['bot.engineNoticeWorker'],
    'Your bot runs automatically in the background, even when you close this page or switch to another app. Return anytime to monitor your trading activity.'
  );
  assert.strictEqual(
    T.en['bot.workerManaged'],
    "\u{1F916} Your bot now runs automatically. It will keep trading even when you're offline."
  );
  // The previous sentences must not survive anywhere in the document.
  assert.ok(!INDEX.includes('run by the server, not this tab'), 'old workerManaged wording removed');
  assert.ok(!INDEX.includes('Managed by the server: this bot keeps trading'), 'old engineNoticeWorker wording removed');
  // The obsolete "in development" browser-loop copy is gone from the dictionary...
  assert.ok(!INDEX.includes('is in development'), 'obsolete engineNotice wording removed');
  assert.ok(!INDEX.includes('A server-side engine that keeps trading after you close the tab'), 'obsolete browser-loop copy removed');
  // ...and from the pre-hydration markup default, which is what a user sees right
  // after a refresh before the bot is started (applyTranslations has not run yet).
  const markupDefault = 'data-i18n="bot.engineNoticeUnknown">\u{1F916} The bot\'s current status is shown above. Trading runs automatically while the bot is running.</div>';
  assert.ok(INDEX.includes(markupDefault), 'the pre-hydration markup default shows the new copy');
  for (const l of LANGS) {
    assert.ok(T[l]['bot.engineNoticeWorker'] && String(T[l]['bot.engineNoticeWorker']).trim(), l + ' notice');
    assert.ok(T[l]['bot.workerManaged'] && String(T[l]['bot.workerManaged']).trim(), l + ' workerManaged');
  }
});

test('the disclosure switch is driven by the server 409, not by a manual copy edit', () => {
  const start = INDEX.indexOf('const res = await fetch(\'/api/trade\'');
  const body = INDEX.slice(start, start + 2500);
  assert.match(body, /errBody\.code === 'WORKER_OWNED_SESSION'/);
  assert.match(body, /adoptWorkerOwnership\(\)/, 'the tab loop must YIELD once the worker owns the session');
  // The worker copy is applied by the shared yield helper (used by the 409, by
  // fresh-tab adoption and by the startBot handover), never by a manual edit.
  assert.match(INDEX, /function adoptWorkerOwnership\(\)[\s\S]{0,400}?updateBotEngineNotice\('worker'\)/);
  // Scoped to the 409 branch itself (the NEXT branch, the promo cap, legitimately
  // stops the bot for real - the yield never goes through stopBot()).
  const branchAt = INDEX.indexOf("errBody.code === 'WORKER_OWNED_SESSION'");
  const nextAt = INDEX.indexOf('PROMO_TRADING_LIMIT_REACHED', branchAt);
  const branch = INDEX.slice(branchAt, nextAt > branchAt ? nextAt : branchAt + 900);
  assert.ok(!/stopBot\(/.test(stripComments(branch)), 'the handover must not end the server session (that would defeat background trading)');
});

test('the server emits exactly the code the client keys off', () => {
  // One definition (WORKER_OWNED_CODE) drives both enforcement points - the
  // /api/trade pre-check and the migration 031 database backstop mapping - so the
  // string the client keys off cannot drift between them.
  assert.match(SERVER, /const WORKER_OWNED_CODE = 'WORKER_OWNED_SESSION';/);
  assert.match(SERVER, /code: WORKER_OWNED_CODE/);
  assert.match(SERVER, /executedBy: 'worker'/);
});

test('updateBotEngineNotice picks the copy from APP.botExecutedBy and defaults to browser', () => {
  const start = INDEX.indexOf('function updateBotEngineNotice');
  const src = INDEX.slice(start, INDEX.indexOf('function stopBot('));
  const el = { textContent: '', attrs: {}, setAttribute(k, v) { el.attrs[k] = v; } };
  const sandbox = {
    APP: {},
    document: { getElementById: () => el },
    t: (k) => 'T:' + k,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  sandbox.updateBotEngineNotice();
  assert.strictEqual(el.textContent, 'T:bot.engineNoticeUnknown',
    'with no server answer the copy must claim neither mode');
  sandbox.updateBotEngineNotice('browser');
  assert.strictEqual(el.textContent, 'T:bot.engineNotice', 'the server says the tab is the executor');
  sandbox.updateBotEngineNotice('worker');
  assert.strictEqual(el.textContent, 'T:bot.engineNoticeWorker');
  assert.strictEqual(sandbox.APP.botExecutedBy, 'worker', 'state must be remembered for language switches');
  sandbox.updateBotEngineNotice('nonsense');
  assert.strictEqual(el.textContent, 'T:bot.engineNoticeUnknown', 'an unknown mode never over-promises');
});

test('a language switch re-applies the right variant (data-i18n alone would reset it)', () => {
  const fn = INDEX.slice(INDEX.indexOf('function updateDynamicTranslations'), INDEX.indexOf('function updateDynamicTranslations') + 1200);
  assert.match(fn, /updateBotEngineNotice\(\)/);
});

test('the disclosure copy sits in the live bot card and is still a data-i18n default', () => {
  // The element ships with the NEUTRAL variant: before the server reports which
  // engine owns the session, the page must not claim the tab stops trading.
  assert.match(INDEX, /id="botEngineNotice"[^>]*data-i18n="bot\.engineNoticeUnknown"/);
});

test('no sandbox file or sandbox string was touched by this change', () => {
  assert.ok(!/sandbox/i.test(INDEX.slice(INDEX.indexOf('function updateBotEngineNotice'), INDEX.indexOf('function stopBot('))));
});
