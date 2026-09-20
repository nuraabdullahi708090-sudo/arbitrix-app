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

test('the browser copy promises tab-bound behaviour; the worker copy states the opposite', () => {
  const T = translations();
  for (const l of LANGS) {
    assert.notStrictEqual(T[l]['bot.engineNotice'], T[l]['bot.engineNoticeWorker'], l + ' variants must differ');
  }
  // EN is the pinned contract (per-locale wording is reviewed, not machine-checked).
  assert.match(T.en['bot.engineNotice'], /close or refresh/i);
  assert.match(T.en['bot.engineNoticeWorker'], /keeps trading after you close this tab/i);
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
  const el = { textContent: '' };
  const sandbox = {
    APP: {},
    document: { getElementById: () => el },
    t: (k) => 'T:' + k,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  sandbox.updateBotEngineNotice();
  assert.strictEqual(el.textContent, 'T:bot.engineNotice', 'default must be the browser copy');
  sandbox.updateBotEngineNotice('worker');
  assert.strictEqual(el.textContent, 'T:bot.engineNoticeWorker');
  assert.strictEqual(sandbox.APP.botExecutedBy, 'worker', 'state must be remembered for language switches');
});

test('a language switch re-applies the right variant (data-i18n alone would reset it)', () => {
  const fn = INDEX.slice(INDEX.indexOf('function updateDynamicTranslations'), INDEX.indexOf('function updateDynamicTranslations') + 1200);
  assert.match(fn, /updateBotEngineNotice\(\)/);
});

test('the disclosure copy sits in the live bot card and is still a data-i18n default', () => {
  assert.match(INDEX, /id="botEngineNotice"[^>]*data-i18n="bot\.engineNotice"/);
});

test('no sandbox file or sandbox string was touched by this change', () => {
  assert.ok(!/sandbox/i.test(INDEX.slice(INDEX.indexOf('function updateBotEngineNotice'), INDEX.indexOf('function stopBot('))));
});
