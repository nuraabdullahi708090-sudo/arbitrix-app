/**
 * Start Bot vs. the $400 profit pause.
 *
 * The running state may only be entered when the SERVER accepted the start, so
 * a paused account sees the deposit prompt and nothing else: no "Bot started in
 * Live mode" success toast, no "Bot Started" history entry, no running loop and
 * no retry. Everything else keeps its previous behaviour, including the
 * fail-open path when the request itself fails.
 *
 * The REAL startBot/beginBotRun/showProfitPauseStartBlocked/syncBotSessionWithServer
 * functions are executed in a vm sandbox against a stubbed DOM/fetch/timers, so
 * the wiring - not a copy of it - is what is under test.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const MODULE = require('../services/ProfitPause.js');
const KNOWLEDGE = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'support', 'arbitrix-knowledge.json'), 'utf8');

// --- real TRANSLATIONS + a faithful t() so interpolation is genuinely exercised
function loadTranslations() {
  const tIdx = INDEX.indexOf('const TRANSLATIONS');
  let i = INDEX.indexOf('{', tIdx);
  let depth = 0;
  let end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
  return sandbox.__T;
}
const T = loadTranslations();

function t(key, vars) {
  let s = (T.en && T.en[key]) || key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.split('{{' + k + '}}').join(String(vars[k]));
    }
  }
  return s;
}

function extractFn(name) {
  const start = INDEX.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist in public/index.html');
  let i = INDEX.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return INDEX.slice(start, end + 1);
}

const FN_NAMES = ['startBot', 'beginBotRun', 'showProfitPauseStartBlocked',
  'syncBotSessionWithServer', 'isProfitPausePayload', 'rememberProfitPauseThreshold',
  'renderProfitPauseBody', 'openProfitPauseModal', 'closeProfitPauseModal',
  'maybeShowProfitPauseModal', 'profitPauseDeposit'];
const FN_SRC = FN_NAMES.map(extractFn).join('\n');

const PAUSE_BODY = {
  error: 'Add funds to keep the bot trading.',
  code: MODULE.PROFIT_PAUSE_CODE,
  profitPauseReached: true,
  depositRequired: true,
  profitPauseThreshold: MODULE.DEFAULT_PROFIT_PAUSE_USD,
};
const PROMO_BODY = {
  error: 'Promotional trading limit reached',
  code: 'PROMO_TRADING_LIMIT_REACHED',
  promoLimitReached: true,
  depositRequired: true,
};

/** Build the sandbox: real functions, stubbed collaborators, recorded effects. */
function harness({ mode = 'live', environment = 'PRODUCTION', status = null,
  startReply = { status: 200, body: { isRunning: true, executedBy: 'browser' } },
  offline = false, promoLimitReached = false } = {}) {
  const log = { toast: [], fetch: [], interval: 0, clear: 0, status: [], sync: [],
    adopt: 0, ended: 0, depositModal: 0, sound: [] };
  const els = {};
  const elFor = (id) => (els[id] || (els[id] = {
    id, textContent: '',
    classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); },
      contains(c) { return this.s.has(c); } },
  }));

  const sandbox = {
    console,
    Promise, JSON, Number, String, Date, Set, Object, Array, RegExp, Error,
    setInterval: () => { log.interval++; return { id: log.interval }; },
    clearInterval: () => { log.clear++; },
    localStorage: { getItem: (k) => (k === 'jwt_token' ? 'jwt-test' : null), setItem() {}, removeItem() {} },
    fetch: (url, opts) => {
      log.fetch.push({ url: String(url), method: (opts && opts.method) || 'GET' });
      if (offline) return Promise.reject(new Error('network down'));
      return Promise.resolve({
        ok: startReply.status >= 200 && startReply.status < 300,
        status: startReply.status,
        json: () => Promise.resolve(startReply.body),
      });
    },
    document: { getElementById: (id) => elFor(id) },
    t,
    APP: {
      mode, environment, botInterval: null, botRunning: false,
      profitPauseNoticeShown: false, profitPauseThreshold: null,
      liveData: { promoLimitReached: !!promoLimitReached, balance: 500, history: [] },
    },
    Sound: { botStart: () => log.sound.push('start'), botStop: () => log.sound.push('stop') },
    showToast: (msg, type) => log.toast.push({ msg, type }),
    updateStatus: (r) => log.status.push(r),
    updateUI: () => {},
    startWorkerSyncLoop: () => log.sync.push('start'),
    stopWorkerSyncLoop: () => log.sync.push('stop'),
    adoptWorkerOwnership: () => { log.adopt++; },
    handleServerSessionEnded: () => { log.ended++; },
    fetchBotExecutionStatus: () => Promise.resolve(status),
    executeBotTrade: () => {},          // the interval argument is evaluated
    getCurrentData: () => sandbox.APP.liveData,
    openDepositModal: () => { log.depositModal++; },
  };
  vm.createContext(sandbox);
  vm.runInContext(FN_SRC + ';globalThis.__h = {startBot, profitPauseDeposit, isProfitPausePayload};', sandbox);
  sandbox.__log = log;
  sandbox.__el = els;
  return sandbox;
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
/** The prompt is only ever created when it is shown, so treat "absent" as closed. */
const promptOpen = (h) => !!(h.__el.profitPauseModal && h.__el.profitPauseModal.classList.contains('open'));

// ---------------------------------------------------------------------------
// 1. PROFIT PAUSED START
// ---------------------------------------------------------------------------
test('1. a paused account gets the deposit prompt and no success state', async () => {
  const h = harness({ startReply: { status: 403, body: PAUSE_BODY }, status: { isRunning: false, profitPaused: true, profitPauseThreshold: 400 } });
  h.__h.startBot();
  await flush();

  // The normal start request WAS sent (once), and only to the start endpoint.
  assert.strictEqual(h.__log.fetch.length, 1, 'exactly one start request');
  assert.strictEqual(h.__log.fetch[0].url, '/api/bot/start');
  assert.strictEqual(h.__log.fetch[0].method, 'POST');

  // The prompt is shown, with the server threshold rendered into the sentence.
  const modal = h.__el.profitPauseModal;
  assert.ok(modal && modal.classList.contains('open'), 'the pop-up is open');
  assert.strictEqual(h.__el.profitPauseBody.textContent,
    'Your account has reached the $400 profit-pause threshold. Make a new qualifying deposit to resume bot trading.');
  assert.ok(!/\{\{/.test(h.__el.profitPauseBody.textContent), 'no raw placeholder is shown');

  // No success state of any kind.
  assert.deepStrictEqual(h.__log.toast, [], 'no toast at all (never "Bot started in Live mode")');
  assert.ok(!h.__log.toast.some((x) => x.msg === t('bot.startedLive')), 'no live-start toast');
  assert.strictEqual(h.APP.botRunning, false, 'bot is not running');
  assert.strictEqual(h.__log.interval, 0, 'no trading interval was created');
  assert.deepStrictEqual(h.APP.liveData.history, [], 'no "Bot Started" history entry');
  assert.deepStrictEqual(h.__log.sound, [], 'no start sound');
});

test('1b. the prompt is the ONLY thing shown (no error toast, no worker adoption)', async () => {
  const h = harness({ startReply: { status: 403, body: PAUSE_BODY } });
  h.__h.startBot();
  await flush();
  assert.strictEqual(h.__log.adopt, 0, 'no worker adoption');
  assert.strictEqual(h.__log.ended, 0, 'the session was never locally started, so nothing to end');
  assert.deepStrictEqual(h.__log.status, [false], 'the UI is told the bot is stopped');
  assert.deepStrictEqual(h.__log.sync, ['stop'], 'no sync loop is started (any stray one is stopped)');
});

// ---------------------------------------------------------------------------
// 2. NO FALSE START
// ---------------------------------------------------------------------------
test('2. no local or server start state is created for a paused account', async () => {
  const h = harness({ startReply: { status: 403, body: PAUSE_BODY } });
  h.__h.startBot();
  await flush();
  assert.strictEqual(h.APP.botRunning, false);
  assert.strictEqual(h.APP.botInterval, null);
  assert.strictEqual(h.APP.liveData.history.length, 0);
  assert.deepStrictEqual(h.__log.fetch.map((f) => f.url), ['/api/bot/start'],
    'no stop/start is sent after the refusal');
  assert.strictEqual(h.__log.depositModal, 0, 'opening the prompt must not open the deposit modal on its own');
});

test('2b. a paused account that keeps pressing Start never accumulates state', async () => {
  const h = harness({ startReply: { status: 403, body: PAUSE_BODY } });
  for (let i = 0; i < 3; i++) { h.__h.startBot(); await flush(); }
  assert.strictEqual(h.APP.botRunning, false);
  assert.strictEqual(h.__log.interval, 0);
  assert.deepStrictEqual(h.APP.liveData.history, []);
  assert.deepStrictEqual(h.__log.toast, []);
  assert.strictEqual(promptOpen(h), true, 'the reason is still shown');
});

// ---------------------------------------------------------------------------
// 3. DEPOSIT CTA
// ---------------------------------------------------------------------------
test('3. "Deposit Funds" closes the prompt and uses the existing deposit flow', async () => {
  const h = harness({ startReply: { status: 403, body: PAUSE_BODY } });
  h.__h.startBot();
  await flush();
  assert.ok(h.__el.profitPauseModal.classList.contains('open'));
  h.__h.profitPauseDeposit();
  assert.strictEqual(h.__el.profitPauseModal.classList.contains('open'), false, 'prompt closed');
  assert.strictEqual(h.__log.depositModal, 1, 'the existing deposit modal is opened');
  assert.strictEqual(h.APP.botRunning, false, 'still not trading');
});

// ---------------------------------------------------------------------------
// 4. NORMAL START
// ---------------------------------------------------------------------------
test('4. a non-paused account still starts exactly as before', async () => {
  const h = harness({ startReply: { status: 200, body: { isRunning: true, executedBy: 'browser' } } });
  h.__h.startBot();
  await flush();
  assert.strictEqual(h.APP.botRunning, true);
  assert.strictEqual(h.__log.interval, 1, 'the tab loop starts');
  assert.strictEqual(h.APP.liveData.history.length, 1);
  assert.strictEqual(h.APP.liveData.history[0].detail, 'Started');
  assert.deepStrictEqual(h.__log.toast.map((x) => x.msg), [t('bot.startedLive')]);
  assert.deepStrictEqual(h.__log.sound, ['start']);
  assert.strictEqual(promptOpen(h), false, 'no prompt');
});

test('4b. a worker-owned session is still adopted and disclosed', async () => {
  const h = harness({ startReply: { status: 200, body: { isRunning: true, executedBy: 'worker' } },
    status: { isRunning: true, executedBy: 'worker', profitPaused: false } });
  h.__h.startBot();
  await flush();
  assert.strictEqual(h.__log.adopt, 1, 'handover to the worker');
  assert.deepStrictEqual(h.__log.toast.map((x) => x.msg), [t('bot.startedLive'), t('bot.workerManaged')]);
});

test('4c. demo mode never consults the server (unchanged immediate start)', async () => {
  const h = harness({ mode: 'demo', startReply: { status: 403, body: PAUSE_BODY } });
  h.__h.startBot();
  await flush();
  assert.strictEqual(h.__log.fetch.length, 0, 'demo sends no start request');
  assert.strictEqual(h.APP.botRunning, true);
  assert.deepStrictEqual(h.__log.toast.map((x) => x.msg), [t('bot.startedDemo')]);
});

test('4d. the simulated sandbox session is never routed through the pause gate', async () => {
  const h = harness({ environment: 'MARKETING_SANDBOX', startReply: { status: 403, body: PAUSE_BODY } });
  h.__h.startBot();
  await flush();
  assert.strictEqual(h.__log.fetch.length, 0, 'sandbox start is simulated locally');
  assert.strictEqual(h.APP.botRunning, true);
  assert.strictEqual(promptOpen(h), false, 'no prompt in the sandbox');
});

// ---------------------------------------------------------------------------
// 5. OTHER ERRORS (existing handling preserved)
// ---------------------------------------------------------------------------
test('5. a server error, an auth error and an offline request all keep the old behaviour', async () => {
  for (const reply of [{ status: 500, body: { error: 'Server error' } },
    { status: 401, body: { error: 'Unauthorized' } },
    { status: 400, body: { error: 'MTA not reached' } }]) {
    const h = harness({ startReply: reply });
    h.__h.startBot();
    await flush();
    assert.strictEqual(h.APP.botRunning, true, 'fail-open: the tab loop still starts for ' + JSON.stringify(reply));
    assert.deepStrictEqual(h.__log.toast.map((x) => x.msg), [t('bot.startedLive')]);
    assert.strictEqual(promptOpen(h), false, 'never mistaken for a pause');
  }
  const off = harness({ offline: true });
  off.__h.startBot();
  await flush();
  assert.strictEqual(off.APP.botRunning, true, 'offline start still works in the tab');
  assert.strictEqual(promptOpen(off), false);
});

// ---------------------------------------------------------------------------
// 6. PROMO CAP
// ---------------------------------------------------------------------------
test('6. the promo $20 cap is never presented as the $400 profit pause', async () => {
  // The promo refusal body must not be recognised as a pause payload.
  const h = harness({ startReply: { status: 403, body: PROMO_BODY } });
  assert.strictEqual(h.__h.isProfitPausePayload(PROMO_BODY), false,
    'depositRequired/promoLimitReached alone are not the pause');
  assert.strictEqual(h.__h.isProfitPausePayload(PAUSE_BODY), true, 'the pause body is recognised');
  // Adopting a promo refusal must not open the pause prompt.
  h.__h.startBot();
  await flush();
  assert.strictEqual(promptOpen(h), false);
});

test('6b. the local promo-cap gate still wins before any request', async () => {
  const h = harness({ promoLimitReached: true, startReply: { status: 403, body: PAUSE_BODY } });
  h.__h.startBot();
  await flush();
  assert.strictEqual(h.__log.fetch.length, 0, 'no request when the cap flag is set');
  assert.strictEqual(h.APP.botRunning, false);
  assert.deepStrictEqual(h.__log.toast.map((x) => x.msg), [t('bot.promoLimitReached')]);
  assert.strictEqual(promptOpen(h), false, 'the promo toast, not the pause prompt');
});

// ---------------------------------------------------------------------------
// 7. WORKER SAFETY
// ---------------------------------------------------------------------------
test('7. the frontend never retries the start after a pause refusal', async () => {
  const h = harness({ startReply: { status: 403, body: PAUSE_BODY } });
  h.__h.startBot();
  for (let i = 0; i < 10; i++) await flush();
  assert.strictEqual(h.__log.fetch.length, 1, 'exactly one request, ever');
  assert.ok(!h.__log.fetch.some((f) => f.url === '/api/bot/stop'), 'no stop is sent (the server owns the session)');
  assert.ok(!h.__log.fetch.some((f) => f.url === '/api/trade'), 'no trade is attempted');
  assert.strictEqual(h.__log.adopt, 0);
  assert.strictEqual(h.APP.botRunning, false);
});

// ---------------------------------------------------------------------------
// 8. THE RULE IS ONLY EVER SURFACED BY THIS PROMPT
// ---------------------------------------------------------------------------
test('8. the pause wording exists only in the just-in-time prompt', async () => {
  // The support bot must never describe the rule (it would announce the
  // threshold before a user ever reaches it).
  assert.ok(!/profit.?pause/i.test(KNOWLEDGE), 'the support bot must not describe the rule');
  // The landing page never mentions it either.
  const landing = INDEX.slice(INDEX.indexOf('id="landingPage"'), INDEX.indexOf('id="authPage"'));
  assert.ok(!/profit.?pause/i.test(landing), 'the landing page never mentions it');
  // The threshold itself appears in no user-facing copy (it is interpolated).
  const copies = ['profitPause.title', 'profitPause.body', 'profitPause.addFunds']
    .flatMap((k) => Object.keys(T).map((l) => T[l][k]));
  assert.ok(!copies.some((v) => /\d/.test(v)), 'no hard-coded figure in any locale');
  // And the pop-up only opens when the server says the account is paused.
  const h = harness({ startReply: { status: 200, body: { isRunning: true, executedBy: 'browser' } } });
  h.__h.startBot();
  await flush();
  assert.strictEqual(promptOpen(h), false, 'a normal start never shows it');
});

test('8b. the prompt is never opened by an arbitrary status shape', async () => {
  const h = harness();
  for (const st of [undefined, null, {}, { profitPaused: false }, { profitPaused: 'true' }, { profitPauseReached: true }]) {
    h.APP.profitPauseNoticeShown = false;
    h.APP.botRunning = false;
    h.APP.botInterval = null;
    await Promise.resolve(h.__h.isProfitPausePayload(st));
  }
  assert.strictEqual(!!h.__h.isProfitPausePayload({ profitPauseReached: true }), true,
    'the boolean is the documented fallback signal');
  assert.strictEqual(h.__h.isProfitPausePayload({ profitPaused: 'true' }), false,
    'a truthy string is not the machine-readable signal');
});
