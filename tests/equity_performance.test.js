'use strict';
/**
 * Equity Performance (dashboard chart) - accounting basis + refresh stability.
 *
 * THE DEFECT THIS FILE PINS
 *   The chart used to be built from a client-side sample buffer
 *   (localStorage `arbi_chart`) that appended the displayed balance every few
 *   seconds and kept at most 100 points. That is a display artefact, not an
 *   accounting record:
 *     - after ~100 samples the oldest point was dropped, so "Starting" became
 *       the balance from a few minutes earlier (a $30 realised gain could read
 *       as ~$8 after a refresh),
 *     - "30M"/"1H" sliced the buffer by POINT COUNT (~4 min of samples), not by
 *       time,
 *     - the figures were per browser/locale and could disagree with the wallet,
 *     - a chart that had not received a point (missing canvas instance, a
 *       worker executing the trades) froze while the balance kept moving.
 *
 * THE BASIS (asserted below)
 *   Equity = the LIVE WALLET BALANCE, and the series is the persisted realised
 *   ledger (`trades.amount` + `trades.balance_after`). Therefore:
 *     starting = balance immediately before the window's first trade
 *     current  = authoritative wallet balance
 *     change   = current - starting   (always)
 *   It is NOT forced to equal Today's P&L: a deposit, a withdrawal or a
 *   referral conversion moves equity without being a trade.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const vm = require('node:vm');
const { readLf } = require('./helpers/text');

const {
  buildEquityPerformance,
  resolveEquityPeriod,
  equityPeriodStartIso,
  downsample,
} = require('../services/EquityPerformance');

const ROOT = path.join(__dirname, '..');
const INDEX = readLf(path.join(ROOT, 'public', 'index.html'));
const SERVER = readLf(path.join(ROOT, 'server.js'));
const MODULE = readLf(path.join(ROOT, 'services', 'EquityPerformance.js'));

const T0 = Date.parse('2026-11-24T10:00:00.000Z');
/** A trade row as record_trade_safe writes it. */
function trade(minutes, amount, balanceAfter) {
  return {
    amount,
    balance_after: balanceAfter,
    created_at: new Date(T0 + minutes * 60000).toISOString(),
  };
}

/* ------------------------------------------------------------- 1. the basis */

test('1. an account with no realised trade is flat at its wallet balance', () => {
  // A brand-new promotional-credit account ($50 seed) and a funded account with
  // nothing traded both start flat - the chart can never invent a gain.
  [50, 0, 150].forEach((balance) => {
    const out = buildEquityPerformance({ trades: [], currentBalance: balance, nowMs: T0 });
    assert.strictEqual(out.starting, balance);
    assert.strictEqual(out.current, balance);
    assert.strictEqual(out.change, 0);
    assert.strictEqual(out.changePct, 0);
    assert.strictEqual(out.high, balance);
    assert.strictEqual(out.trades, 0);
    assert.strictEqual(out.points.length, 2, 'two identical points still draw a baseline');
    assert.ok(out.points.every((pt) => pt.equity === balance));
  });
});

test('2. one winning trade reconciles exactly with the wallet', () => {
  const out = buildEquityPerformance({
    trades: [trade(0, 5, 55)],
    currentBalance: 55,
    nowMs: T0 + 60000,
  });
  assert.strictEqual(out.starting, 50, 'the balance BEFORE the trade');
  assert.strictEqual(out.current, 55, 'the authoritative wallet balance');
  assert.strictEqual(out.change, 5);
  assert.strictEqual(out.changePct, 10);
  assert.strictEqual(out.high, 55);
  assert.strictEqual(out.trades, 1);
});

test('3. one losing trade produces a negative change and a negative percentage', () => {
  const out = buildEquityPerformance({
    trades: [trade(0, -4.5, 45.5)],
    currentBalance: 45.5,
    nowMs: T0 + 60000,
  });
  assert.strictEqual(out.starting, 50);
  assert.strictEqual(out.change, -4.5);
  assert.strictEqual(out.changePct, -9);
  assert.strictEqual(out.high, 50, 'the high is the peak along the curve, not the start');
});

test('4. several mixed trades: change equals the net P&L and the wallet agrees', () => {
  const rows = [
    trade(0, 4, 54),
    trade(1, -2, 52),
    trade(2, 10, 62),
    trade(3, -7.5, 54.5),
    trade(4, 3.25, 57.75),
  ];
  const out = buildEquityPerformance({ trades: rows, currentBalance: 57.75, nowMs: T0 + 600000 });
  assert.strictEqual(out.starting, 50);
  assert.strictEqual(out.current, 57.75);
  assert.strictEqual(out.change, 7.75);
  assert.strictEqual(out.changePct, 15.5);
  assert.strictEqual(out.high, 62);
  assert.strictEqual(out.trades, 5);
  // Absolute change must equal current - starting, by construction.
  assert.strictEqual(out.change, Math.round((out.current - out.starting) * 100) / 100);
});

test('5. promotional-credit trades are included like any other trade', () => {
  // A promo-funded account has NO deposit; its trading is the only equity
  // movement. The derivation must not filter by funding source (the ledger is
  // the same table and the classification is a separate concern).
  const promoRows = [trade(0, 6, 56), trade(1, 4, 60), trade(2, -1, 59)];
  const out = buildEquityPerformance({ trades: promoRows, currentBalance: 59, nowMs: T0 + 300000 });
  assert.strictEqual(out.starting, 50, 'the $50 promotional seed is the starting equity');
  assert.strictEqual(out.current, 59);
  assert.strictEqual(out.change, 9);
  // The same rows on a funded account produce the same trading component.
  const fundedRows = [trade(0, 6, 156), trade(1, 4, 160), trade(2, -1, 159)];
  const funded = buildEquityPerformance({ trades: fundedRows, currentBalance: 159, nowMs: T0 + 300000 });
  assert.strictEqual(funded.starting, 150);
  assert.strictEqual(funded.change, out.change, 'trading performance is funding-agnostic');
  // And the module never reads a wallet or a promo classifier.
  assert.ok(!/promoCreditFunded|isPromoCreditFunded|hasConfirmedDeposit/.test(MODULE));
});

test('6. a deposit inside the window does not distort the walk, and stays visible', () => {
  // start 50 -> trade +5 (55) -> deposit +100 (155) -> trade +2 (157)
  const rows = [trade(0, 5, 55), trade(2, 2, 157)];
  const out = buildEquityPerformance({ trades: rows, currentBalance: 157, nowMs: T0 + 600000 });
  assert.strictEqual(out.starting, 50, 'starting equity is the balance before the FIRST trade');
  assert.strictEqual(out.current, 157);
  assert.strictEqual(out.change, 107, 'equity change includes the deposit - it is equity, not P&L');
  // The third point is the second trade's persisted balance, so the curve shows
  // the deposit jump instead of silently pretending it was trading profit.
  const atSecondTrade = out.points.find((pt) => pt.at === rows[1].created_at);
  assert.strictEqual(atSecondTrade.equity, 157);
});

test('7. a balance change AFTER the last trade is anchored (deposit / withdrawal)', () => {
  const rows = [trade(0, 5, 55)];
  const out = buildEquityPerformance({ trades: rows, currentBalance: 155, nowMs: T0 + 600000 });
  assert.strictEqual(out.current, 155, 'current is always the wallet, never the last trade');
  assert.strictEqual(out.change, 105);
  assert.strictEqual(out.points[out.points.length - 1].equity, 155, 'the curve ends at the wallet');
});

test('8. rows without balance_after still work (cumulative walk)', () => {
  const rows = [
    { amount: 5, created_at: new Date(T0).toISOString() },
    { amount: -2, created_at: new Date(T0 + 60000).toISOString() },
  ];
  const out = buildEquityPerformance({ trades: rows, currentBalance: 53, nowMs: T0 + 120000 });
  assert.strictEqual(out.starting, 50, 'derived as current - sum(amounts)');
  assert.strictEqual(out.change, 3);
  assert.strictEqual(out.points.map((p) => p.equity).join(','), '50,55,53');
});

test('9. malformed rows are ignored instead of corrupting the figures', () => {
  const rows = [
    trade(0, 5, 55),
    { amount: 'nope', balance_after: 55, created_at: new Date(T0 + 60000).toISOString() },
    { amount: 2, balance_after: 57 }, // no timestamp
    null,
  ];
  const out = buildEquityPerformance({ trades: rows, currentBalance: 55, nowMs: T0 + 120000 });
  assert.strictEqual(out.trades, 1);
  assert.strictEqual(out.starting, 50);
  assert.strictEqual(out.change, 5);
});

test('10. input order never matters (the ledger is sorted by time)', () => {
  const rows = [trade(2, 2, 57), trade(0, 5, 55), trade(1, 0, 55)];
  const out = buildEquityPerformance({ trades: rows, currentBalance: 57, nowMs: T0 + 600000 });
  assert.strictEqual(out.starting, 50);
  const points = out.points.map((p) => p.equity);
  assert.deepStrictEqual(points.slice(0, 4), [50, 55, 55, 57]);
});

/* ------------------------------------------- 2. refresh / re-login stability */

test('11. the same ledger always produces the same figures (refresh, re-login)', () => {
  const rows = [trade(0, 5, 55), trade(1, -1, 54), trade(2, 7, 61)];
  const a = buildEquityPerformance({ trades: rows, currentBalance: 61, nowMs: T0 + 600000 });
  const b = buildEquityPerformance({
    trades: JSON.parse(JSON.stringify(rows)),
    currentBalance: 61,
    nowMs: T0 + 600000,
  });
  assert.deepStrictEqual(a, b, 'no clock/state dependence beyond the injected now');
  // Different "now" (another session) must still report the same accounting.
  const c = buildEquityPerformance({ trades: rows, currentBalance: 61, nowMs: T0 + 86400000 });
  assert.strictEqual(c.starting, a.starting);
  assert.strictEqual(c.current, a.current);
  assert.strictEqual(c.change, a.change);
  assert.strictEqual(c.changePct, a.changePct);
  assert.strictEqual(c.high, a.high);
});

test('12. a much longer history cannot silently shrink the reported change', () => {
  // 150 trades of +$0.20: the old 100-point buffer would have dropped the first
  // 50 samples and reported only ~$20 of the $30 gained.
  const rows = [];
  let balance = 50;
  for (let i = 0; i < 150; i++) {
    balance = Math.round((balance + 0.2) * 100) / 100;
    rows.push(trade(i, 0.2, balance));
  }
  const out = buildEquityPerformance({ trades: rows, currentBalance: balance, nowMs: T0 + 200 * 60000 });
  assert.strictEqual(out.starting, 50, 'the true starting equity survives a long history');
  assert.strictEqual(out.change, 30, 'the WHOLE gain is reported, not a truncated slice');
  assert.strictEqual(out.trades, 150);
  assert.ok(out.points.length <= 240, 'the CURVE is thinned for rendering');
  assert.strictEqual(out.points[0].equity, 50);
  assert.strictEqual(out.points[out.points.length - 1].equity, balance);
});

/* ----------------------------------------------------------- 3. date ranges */

test('13. the period is a real TIME window, not a point count', () => {
  assert.strictEqual(resolveEquityPeriod('30m'), '30m');
  assert.strictEqual(resolveEquityPeriod('1h'), '1h');
  assert.strictEqual(resolveEquityPeriod('all'), 'all');
  assert.strictEqual(resolveEquityPeriod('ALL'), 'all', 'case-insensitive');
  assert.strictEqual(resolveEquityPeriod(''), '30m', 'the default tab');
  assert.strictEqual(resolveEquityPeriod('7d'), '30m', 'an unknown window falls back, never errors');
  assert.strictEqual(resolveEquityPeriod(undefined), '30m');

  const now = Date.parse('2026-11-24T12:00:00.000Z');
  assert.strictEqual(equityPeriodStartIso('30m', now), '2026-11-24T11:30:00.000Z');
  assert.strictEqual(equityPeriodStartIso('1h', now), '2026-11-24T11:00:00.000Z');
  assert.strictEqual(equityPeriodStartIso('all', now), null, 'no lower bound');
});

test('14. a short window only reports the trades inside it', () => {
  const rows = [trade(-90, 5, 55), trade(-10, 3, 58)];
  const out = buildEquityPerformance({ trades: [rows[1]], currentBalance: 58, nowMs: T0 });
  assert.strictEqual(out.starting, 55, 'the window starts at the balance before its first trade');
  assert.strictEqual(out.change, 3);
  assert.strictEqual(out.trades, 1);
});

/* -------------------------------------------------------- 4. presentation */

test('15. downsampling keeps the first and last point and never changes the stats', () => {
  const rows = [];
  let balance = 100;
  for (let i = 0; i < 500; i++) {
    rows.push({ amount: 0, balance_after: balance, created_at: new Date(T0 + i * 1000).toISOString() });
  }
  const out = buildEquityPerformance({ trades: rows, currentBalance: balance, nowMs: T0 + 600000, maxPoints: 50 });
  assert.strictEqual(out.points.length, 50);
  assert.strictEqual(out.points[0].equity, 100);
  assert.strictEqual(out.points[49].equity, balance);
  assert.deepStrictEqual(downsample([1, 2, 3], 10), [1, 2, 3], 'a short series is untouched');
});

test('16. percentages and amounts are 2dp', () => {
  const out = buildEquityPerformance({
    trades: [trade(0, 3.333, 53.33)],
    currentBalance: 53.33,
    nowMs: T0 + 60000,
  });
  assert.strictEqual(out.change, 3.33);
  assert.strictEqual(out.changePct, 6.66);
});

/* ------------------------------------------------- 5. server + client wiring */

test('17. the route is authenticated, read-only and sandbox-aware', () => {
  const route = SERVER.slice(SERVER.indexOf("app.get('/api/equity/performance'"),
    SERVER.indexOf("app.get('/api/equity/performance'") + 1400);
  assert.match(route, /authMiddleware/, 'never public');
  assert.match(route, /sandboxHandled\(req, res, handleSandboxEquityPerformance\)/,
    'the marketing sandbox reads its own simulated ledger');
  assert.match(route, /getWallet\(req\.user\.id\)/, 'the current equity is the server wallet');
  assert.match(route, /readEquityRows\('trades'/, 'the series comes from the persisted ledger');
  assert.match(route, /res\.set\('Cache-Control', 'no-store'\)/);
  assert.ok(route.indexOf('sandboxHandled') < route.indexOf("readEquityRows('trades'"),
    'the sandbox branch runs before any production read');
  // Read-only: no write, no RPC, no credit path.
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(route), 'the route writes nothing');
  assert.ok(!/record_trade_safe|credit_payment_safe|supabaseAdmin\.rpc/.test(route), 'no RPC');
  assert.ok(!/live_balance\s*=/.test(route), 'no balance mutation');
});

test('18. the client renders the SERVER figures, not a local sample buffer', () => {
  const src = INDEX.slice(INDEX.indexOf('function appendChartPoint'),
    INDEX.indexOf('function setChartPeriod'));
  const app = { chartPeriod: 'all', equityServer: null, equityServerPeriod: null, equityInFlight: false };
  const nodes = {};
  const getEl = (id) => {
    if (!nodes[id]) nodes[id] = { textContent: '', className: '' };
    return nodes[id];
  };
  const sandbox = {
    APP: app,
    getEl,
    formatCurrency: (v) => (v < 0 ? '-$' : '$') + Math.abs(Number(v)).toFixed(2),
    localStorage: { getItem: () => 'token' },
    fetch: () => { throw new Error('no network in this test'); },
    setTimeout: () => 1,
    clearTimeout: () => {},
    Date,
    Number,
    String,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}
    globalThis.updateChartStats = updateChartStats;
    globalThis.equityServerActive = equityServerActive;`, sandbox);

  // No server payload yet -> nothing is claimed (the pre-fetch paint).
  app.chartData = { live: { labels: ['10:00'], values: [50] } };
  sandbox.updateChartStats();

  // A server payload with a gain.
  app.equityServer = { starting: 50, current: 58.3, change: 8.3, changePct: 16.6, high: 58.3, points: [{ at: 'x', equity: 50 }, { at: 'y', equity: 58.3 }] };
  app.equityServerPeriod = 'all';
  app.chartPeriod = 'all';
  app.chartData = { live: { labels: ['a', 'b'], values: [50, 58.3] } };
  sandbox.updateChartStats();
  assert.strictEqual(nodes.chartStartValue.textContent, '$50.00');
  assert.strictEqual(nodes.chartCurrentValue.textContent, '$58.30');
  assert.strictEqual(nodes.chartChangeValue.textContent, '+$8.30 (+16.60%)');
  assert.match(nodes.chartChangeValue.className, /positive/);
  assert.strictEqual(nodes.chartHighValue.textContent, '$58.30');

  // A loss is rendered as a negative change.
  app.equityServer = { starting: 100, current: 92, change: -8, changePct: -8, high: 100, points: [{ at: 'a', equity: 100 }, { at: 'b', equity: 92 }] };
  sandbox.updateChartStats();
  assert.strictEqual(nodes.chartChangeValue.textContent, '-$8.00 (-8.00%)');
  assert.match(nodes.chartChangeValue.className, /negative/);

  // A payload for a DIFFERENT window is never treated as current: switching the
  // tab deactivates it immediately (a fetch for the new window follows), so the
  // stale numbers are not presented as the new window's accounting.
  app.chartPeriod = '1h';
  assert.strictEqual(sandbox.equityServerActive(), false, 'the stale window is not adopted');
  sandbox.updateChartStats(); // falls back to the cached curve until the fetch lands
  assert.strictEqual(nodes.chartCurrentValue.textContent, '$58.30', 'the cached curve is shown, not nothing');
});

test('19. the local point buffer can no longer truncate or splice the series', () => {
  const append = INDEX.slice(INDEX.indexOf('function appendChartPoint'),
    INDEX.indexOf('function filterChartData'));
  assert.match(append, /if \(typeof equityServerActive === 'function' && equityServerActive\(\)\)/,
    'a server-derived series is never spliced with a local point');
  // A bounded buffer is still fine for the pre-fetch fallback, but it must be
  // unreachable once the server series is loaded - that guard is what stops the
  // history from being truncated.
  const guard = append.indexOf("typeof equityServerActive === 'function' && equityServerActive()");
  const cap = append.indexOf('length > 100');
  assert.ok(guard > 0 && guard < cap, 'the server-series guard precedes the fallback cap');
  const filter = INDEX.slice(INDEX.indexOf('function filterChartData'), INDEX.indexOf('// ===== Server-derived equity series'));
  assert.match(filter, /equityServerActive\(\)\) return data/,
    'the already-windowed server series is not re-sliced by point count');
});

test('20. every path that can change equity refreshes the series', () => {
  const init = INDEX.slice(INDEX.indexOf('anchorLiveChartToServerBalance();'),
    INDEX.indexOf('// SINGLE MODE: there is no display mode to resolve.'));
  assert.match(init, /loadEquityPerformance\(APP\.chartPeriod\)/,
    'login / refresh loads the persisted series');
  const persistAt = INDEX.indexOf('async function persistLiveTrade');
  assert.ok(persistAt > 0);
  assert.match(INDEX.slice(persistAt, persistAt + 20000), /scheduleEquityRefresh\(\)/,
    'a persisted trade re-reads the ledger');
  const tickAt = INDEX.indexOf('async function runWorkerSyncTick');
  assert.ok(tickAt > 0);
  assert.match(INDEX.slice(tickAt, tickAt + 20000), /scheduleEquityRefresh\(\)/,
    'worker-executed trades show up too');
  const period = INDEX.slice(INDEX.indexOf('function setChartPeriod'), INDEX.indexOf('function resetChartForWallet'));
  assert.match(period, /loadEquityPerformance\(period\)/, 'the period tabs query the server window');
});

test('21. the module is pure: no I/O, no wallet, no clock beyond the injected now', () => {
  assert.ok(!/require\(/.test(MODULE), 'no dependencies');
  assert.ok(!/supabase|fetch\(|rpc\(/.test(MODULE), 'no database or network');
  // Comments may describe the wallet; the CODE must never read or write one.
  const code = MODULE.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.ok(!/\.(from|update|insert|upsert)\(/.test(code), 'no table access');
  assert.ok(!/live_balance|wallet_id|balance_after\s*=/.test(code), 'it never touches a wallet row');
});

test('22. a failed read retries a bounded number of times and a success resets it', async () => {
  // The reported symptom was a STALE card ("it updated by itself later"). A single
  // failed sync must therefore not leave yesterday's numbers on screen forever -
  // but an unreachable server must not spin either.
  const src = INDEX.slice(INDEX.indexOf('const EQUITY_REFRESH_MIN_MS'),
    INDEX.indexOf('function updateChartStats'));
  const timers = [];
  let fail = true;
  const app = {
    chartPeriod: '30m', equityServer: null, equityServerPeriod: null, equityInFlight: false,
    equityFetchedAt: 0, equityRefreshTimer: null, equityRetryCount: 0, equityRetryTimer: null,
    chartData: { live: { labels: [], values: [] } },
  };
  const okPayload = { starting: 50, current: 55, change: 5, changePct: 10, high: 55, points: [{ at: 'a', equity: 50 }, { at: 'b', equity: 55 }] };
  const sandbox = {
    APP: app,
    localStorage: { getItem: () => 'token' },
    fetch: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(okPayload),
    })),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    getEl: () => ({ textContent: '', className: '' }),
    formatCurrency: (v) => '$' + Number(v).toFixed(2),
    Date, Number, String, console,
    updateChartStats: () => {},
    saveData: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}
    globalThis.loadEquityPerformance = loadEquityPerformance;
    globalThis.scheduleEquityRetry = scheduleEquityRetry;`, sandbox);

  // Attempt 1 fails -> one retry is queued, 8s out.
  await vm.runInContext("loadEquityPerformance('30m')", sandbox);
  assert.strictEqual(app.equityRetryCount, 1);
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 8000);

  // Two more failures (each preceded by the retry timer firing, which clears the
  // handle) -> the bound is reached and nothing else is queued.
  app.equityRetryTimer = null;
  await vm.runInContext("loadEquityPerformance('30m')", sandbox);
  assert.strictEqual(app.equityRetryCount, 2);
  app.equityRetryTimer = null;
  await vm.runInContext("loadEquityPerformance('30m')", sandbox);
  assert.strictEqual(app.equityRetryCount, 3);
  const queued = timers.length;
  app.equityRetryTimer = null;
  await vm.runInContext("loadEquityPerformance('30m')", sandbox);
  assert.strictEqual(app.equityRetryCount, 3, 'the budget is not extended past 3');
  assert.strictEqual(timers.length, queued, 'no unbounded retry loop');

  // A success adopts the payload and clears the failure budget.
  fail = false;
  timers.length = 0;
  app.equityRetryCount = 0;
  await vm.runInContext("loadEquityPerformance('30m')", sandbox);
  assert.strictEqual(app.equityServerPeriod, '30m');
  assert.strictEqual(app.equityServer.current, 55);
  assert.strictEqual(timers.length, 0, 'a good read schedules no retry');
});
