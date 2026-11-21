/**
 * Live Mode access refusals + First Trade badge integrity (frontend).
 *
 * The server refuses Live trading with machine-readable codes
 * (LIVE_ACTIVATION_REQUIRED / LIVE_DEPOSIT_REQUIRED) BEFORE any financial write.
 * The UI must never claim a start or a trade in that case:
 *   - startBot() must not reach beginBotRun() for either refusal,
 *   - a refused trade must be rolled back COMPLETELY (balance, P&L, counters,
 *     history), so it cannot unlock the "First Trade" badge,
 *   - a genuinely persisted trade must behave exactly as before.
 *
 * The REAL functions are executed in a vm sandbox; only the DOM, fetch and
 * timers are stubbed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFn(name) {
  const plain = INDEX.indexOf('function ' + name + '(');
  const isAsync = plain >= 6 && INDEX.slice(plain - 6, plain) === 'async ';
  const start = isAsync ? plain - 6 : plain;
  assert.ok(plain >= 0, name + ' must exist in public/index.html');
  let i = INDEX.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return INDEX.slice(start, end + 1);
}

const ACTIVATION = { error: 'Live Mode activation required', code: 'LIVE_ACTIVATION_REQUIRED', activationRequired: true };
const DEPOSIT = { error: 'A confirmed deposit is required', code: 'LIVE_DEPOSIT_REQUIRED', depositRequired: true, minDeposit: 100 };

/* ------------------------------------------------------------------ startBot */

function runStart(body, opts) {
  const o = opts || {};
  const calls = { begin: 0, activationModal: 0, depositModal: 0, toasts: [], status: [], stopped: 0 };
  const sandbox = {
    console,
    Promise,
    setTimeout,
    clearInterval,
    setInterval,
    calls,
    APP: {
      mode: 'live',
      environment: o.environment || 'PRODUCTION',
      botInterval: null,
      botRunning: false,
      liveData: { promoLimitReached: o.promoLimit || false },
      MIN_DEPOSIT: 100,
    },
    localStorage: { getItem: () => 'token' },
    fetch: () => Promise.resolve({
      ok: o.ok !== false,
      status: o.ok === false ? 403 : 200,
      json: () => Promise.resolve(body),
    }),
    showToast: (m) => calls.toasts.push(m),
    t: (k, vars) => (vars ? k + ':' + JSON.stringify(vars) : k),
    updateStatus: (running) => calls.status.push(!!running),
    stopWorkerSyncLoop: () => {},
    openLiveActivationModal: () => { calls.activationModal++; },
    openDepositModal: () => { calls.depositModal++; },
    isLiveAccessRefusal: null,
    isProfitPausePayload: () => false,
    showProfitPauseStartBlocked: () => {},
    fetchBotExecutionStatus: () => Promise.resolve(null),
    maybeShowProfitPauseModal: () => {},
    adoptWorkerOwnership: () => {},
    handleServerSessionEnded: () => { calls.stopped++; },
    beginBotRun: () => { calls.begin++; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = ['isLiveAccessRefusal', 'handleLiveAccessRefusal', 'isProfitPausePayload',
    'syncBotSessionWithServer', 'startBot'].map(extractFn).join('\n');
  vm.runInContext(src + '\nglobalThis.__start = startBot;', sandbox);
  return { sandbox, calls, run: () => sandbox.__start() };
}

function tick(fn) {
  return new Promise((resolve) => {
    fn();
    setTimeout(resolve, 60);
  });
}

test('an activation refusal never reaches beginBotRun and opens the activation modal', async () => {
  const h = runStart(ACTIVATION, { ok: false });
  await tick(h.run);
  assert.strictEqual(h.calls.begin, 0, 'beginBotRun must not run');
  assert.strictEqual(h.calls.activationModal, 1, 'the activation modal is opened');
  assert.strictEqual(h.calls.depositModal, 0, 'no deposit prompt for an activation refusal');
  assert.deepStrictEqual(h.calls.status, [false], 'the UI is told the bot is stopped');
  assert.ok(!h.calls.toasts.some((m) => /started/i.test(m)), 'no success toast');
  assert.ok(h.sandbox.APP.botRunning === false, 'no running state');
});

test('a deposit refusal never reaches beginBotRun and opens the deposit modal', async () => {
  const h = runStart(DEPOSIT, { ok: false });
  await tick(h.run);
  assert.strictEqual(h.calls.begin, 0, 'beginBotRun must not run');
  assert.strictEqual(h.calls.depositModal, 1, 'the deposit modal is opened');
  assert.strictEqual(h.calls.activationModal, 0, 'no activation prompt for a funding refusal');
  assert.deepStrictEqual(h.calls.status, [false], 'the UI is told the bot is stopped');
  assert.ok(!h.calls.toasts.some((m) => /started/i.test(m)), 'no success toast');
});

test('an accepted start still runs beginBotRun exactly as before', async () => {
  const h = runStart({ isRunning: true }, { ok: true });
  await tick(h.run);
  assert.strictEqual(h.calls.begin, 1, 'the control case still starts');
  assert.strictEqual(h.calls.activationModal, 0, 'no modal');
  assert.strictEqual(h.calls.depositModal, 0, 'no modal');
});

/* ------------------------------------------------------------ persistLiveTrade */

function runPersist(resBody, ok) {
  const calls = { announces: 0, refusals: 0, refusalBody: null };
  const data = {
    balance: 50, pnl: 0, trades: 3, wins: 1, streak: 1, maxStreak: 2,
    bestTrade: 5, worstTrade: -2, tradeAmounts: [1, 2, 3], history: [{ type: 'Trade Executed' }],
    hasTradingActivity: false, promoLimitReached: false,
  };
  const preCounters = {
    trades: 3, wins: 1, streak: 1, maxStreak: 2, bestTrade: 5, worstTrade: -2,
    tradeAmountsLength: 3, historyLength: 1, hasTradingActivity: false,
  };
  const sandbox = {
    console, Promise, setTimeout, calls,
    APP: { liveData: data, botInterval: null, botRunning: true, mode: 'live', MIN_DEPOSIT: 100 },
    localStorage: { getItem: () => 'token' },
    fetch: () => Promise.resolve({ ok: ok !== false, status: ok === false ? 403 : 200, json: () => Promise.resolve(resBody) }),
    announceTradeResult: () => { calls.announces++; },
    handleLiveAccessRefusal: (b) => { calls.refusals++; calls.refusalBody = b; },
    isLiveAccessRefusal: null,
    isProfitPausePayload: () => false,
    stopBot: () => {},
    showToast: () => {},
    t: (k) => k,
    saveData: () => {},
    updateUI: () => {},
    stopWorkerSyncLoop: () => {},
    updateStatus: () => {},
    openLiveActivationModal: () => {},
    openDepositModal: () => {},
    appendChartPoint: () => {},
    updateChartStats: () => {},
    filterChartData: (x) => x,
    formatCurrency: (v) => '$' + v,
    Sound: { tradeWin: () => {}, tradeLoss: () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = ['isLiveAccessRefusal', 'persistLiveTrade'].map(extractFn).join('\n');
  vm.runInContext(src + '\nglobalThis.__persist = persistLiveTrade;', sandbox);
  return {
    sandbox, data, calls,
    run: () => sandbox.__persist(-4, { symbol: 'XAU/USD', detail: 'Spot' }, 'k1', 50, 0, preCounters),
  };
}

test('a refused trade rolls back every optimistic counter, not just the balance', async () => {
  const h = runPersist(ACTIVATION, false);
  // simulate the optimistic update executeBotTrade already applied
  h.data.balance = 46; h.data.pnl = -4; h.data.trades = 4; h.data.history.unshift({ type: 'Trade Executed' });
  h.data.hasTradingActivity = true;
  await h.run();
  assert.strictEqual(h.data.balance, 50, 'balance restored');
  assert.strictEqual(h.data.pnl, 0, 'P&L restored');
  assert.strictEqual(h.data.trades, 3, 'trade count restored');
  assert.strictEqual(h.data.history.length, 1, 'history row removed');
  assert.strictEqual(h.data.tradeAmounts.length, 3, 'trade amounts restored');
  assert.strictEqual(h.data.hasTradingActivity, false, 'activity flag restored');
  assert.strictEqual(h.calls.refusals, 1, 'the refusal is surfaced, never silent');
  assert.strictEqual(h.calls.announces, 0, 'a refused trade is never announced');
});

test('a deposit refusal is surfaced through the same handler', async () => {
  const h = runPersist(DEPOSIT, false);
  await h.run();
  assert.strictEqual(h.calls.refusals, 1);
  assert.strictEqual(h.calls.refusalBody.code, 'LIVE_DEPOSIT_REQUIRED');
  assert.strictEqual(h.calls.announces, 0);
});

test('a persisted trade is announced exactly once and keeps its counters', async () => {
  const h = runPersist({ newBalance: 60, todayRealizedPnl: 10 }, true);
  h.data.balance = 56; h.data.pnl = 6; h.data.trades = 4;
  await h.run();
  assert.strictEqual(h.calls.refusals, 0, 'no refusal');
  assert.strictEqual(h.calls.announces, 1, 'a persisted trade is announced once');
  assert.strictEqual(h.data.balance, 60, 'authoritative balance adopted');
  assert.strictEqual(h.data.trades, 4, 'the persisted trade keeps its counter');
});

/* --------------------------------------------------------------- badge integrity */

test('the First Trade badge cannot unlock from a refused trade', async () => {
  // A BRAND-NEW Live account: its first trade is refused by the server.
  const h = runPersist(ACTIVATION, false);
  const APP = h.sandbox.APP;
  APP.suppressBadges = false;
  APP.currentWallet = 'live';
  APP.unlockedBadges = { live: [], demo: [] };
  APP.celebratedMilestones = { all_badges: false };
  const freshCounters = {
    trades: 0, wins: 0, streak: 0, maxStreak: 0, bestTrade: 0, worstTrade: 0,
    tradeAmountsLength: 0, historyLength: 0, hasTradingActivity: false,
  };
  Object.assign(h.data, {
    trades: 1, wins: 1, tradeAmounts: [], history: [{ type: 'Trade Executed' }], hasTradingActivity: true,
  });                                    // the optimistic update
  await h.sandbox.__persist(-4, { symbol: 'XAU/USD', detail: 'Spot' }, 'k1', 50, 0, freshCounters);
  assert.strictEqual(h.data.trades, 0, 'the refused trade is rolled back to zero');
  Object.assign(h.sandbox, {
    BADGES: [{ id: 'first_trade', condition: (d) => d.trades >= 1 }],
    getCurrentData: () => h.data,
    renderBadges: () => {}, saveData: () => {}, showToast: () => {},
    document: { querySelector: () => null }, t: (k) => k,
    Sound: { badge: () => {} }, getBadgeName: (b) => b.id, setTimeout: () => 0,
  });
  vm.runInContext(extractFn('checkBadges') + '\nglobalThis.__check = checkBadges;', h.sandbox);
  h.sandbox.__check();
  assert.deepStrictEqual(h.sandbox.APP.unlockedBadges.live, [], 'no badge from a refused first trade');
});

test('the First Trade badge still unlocks from persisted activity', () => {
  const sandbox = {
    APP: { suppressBadges: false, currentWallet: 'live', unlockedBadges: { live: [], demo: [] },
      celebratedMilestones: { all_badges: false } },
    BADGES: [{ id: 'first_trade', condition: (d) => d.trades >= 1 }],
    getCurrentData: () => ({ trades: 1 }),
    showToast: () => {}, t: (k) => k, Sound: { badge: () => {} },
    renderBadges: () => {}, saveData: () => {},
    document: { querySelector: () => null },
    getBadgeName: (b) => b.id, setTimeout: () => 0,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const fn = extractFn('checkBadges');
  vm.runInContext(fn + '\nglobalThis.__check = checkBadges;', sandbox);
  sandbox.__check();
  assert.deepStrictEqual(sandbox.APP.unlockedBadges.live, ['first_trade'], 'a real trade unlocks the badge');
});

test('badge evaluation is suspended while a live trade is in flight', () => {
  const sandbox = {
    APP: { suppressBadges: true, currentWallet: 'live', unlockedBadges: { live: [], demo: [] } },
    BADGES: [{ id: 'first_trade', condition: () => true }],
    getCurrentData: () => ({ trades: 9 }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractFn('checkBadges') + '\nglobalThis.__check = checkBadges;', sandbox);
  sandbox.__check();
  assert.deepStrictEqual(sandbox.APP.unlockedBadges.live, [], 'nothing unlocks while suppressed');
});

/* ------------------------------------------------------------------ source pins */

test('executeBotTrade defers badges to persistence and never announces a live trade optimistically', () => {
  const fn = extractFn('executeBotTrade');
  assert.ok(fn.includes('APP.suppressBadges = true'), 'badges are held during the request');
  assert.match(fn, /persistLiveTrade\([^)]*preCounters\)/, 'the counters snapshot is passed through');
  const liveBlock = fn.slice(fn.indexOf("if (APP.mode === 'live')"), fn.indexOf('} else {', fn.indexOf("if (APP.mode === 'live')")));
  assert.ok(!liveBlock.includes('announceTradeResult'), 'no optimistic result toast for a live trade');
  assert.ok(fn.includes('announceTradeResult(profit, asset);'), 'demo keeps its immediate announcement');
});

test('persistLiveTrade handles both Live access codes explicitly', () => {
  const fn = extractFn('persistLiveTrade');
  assert.ok(fn.includes('isLiveAccessRefusal(errBody)'), 'the refusal is detected by code');
  assert.ok(fn.includes('rollback();') && fn.includes('handleLiveAccessRefusal(errBody);'),
    'the trade is rolled back and the customer is told');
  assert.ok(fn.indexOf('isLiveAccessRefusal(errBody)') < fn.lastIndexOf('rollback();\n            return;'),
    'the explicit branch precedes the silent fallback');
});
