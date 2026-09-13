'use strict';

/**
 * TRANSACTION HISTORY ACCESS — tests.
 *
 * Reported concern: a user whose trades had scrolled past the 30-minute window
 * believed their transaction history had disappeared. In fact
 * getRecentHistory(history, 30) is a pure read-only DISPLAY filter - nothing is
 * ever trimmed from the stored history. The problem was that "View More" only
 * expanded WITHIN that 30-minute window, so older entries were unreachable.
 *
 * Pins:
 *   - the dashboard still defaults to a short "Last 30 min" preview;
 *   - an explicit "Older activity" switch reveals entries older than 30
 *     minutes from the same stored history;
 *   - nothing is deleted, rewritten or re-credited, and no server call is made;
 *   - demo activity and Live transactions stay clearly separated;
 *   - an empty recent window does not hide older records.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' should be brace-matchable');
    return INDEX.slice(start, end + 1);
}

function makeEl(id) {
    const node = { id, style: {}, dataset: {}, textContent: '', innerHTML: '', classes: new Set() };
    node.classList = {
        add: (c) => node.classes.add(c),
        remove: (c) => node.classes.delete(c),
        contains: (c) => node.classes.has(c),
        toggle: (c, force) => { const on = force === undefined ? !node.classes.has(c) : !!force; if (on) node.classes.add(c); else node.classes.delete(c); },
    };
    return node;
}

const TX_IDS = ['tradeHistoryContainer', 'viewMoreTxBtn', 'txMoreCount', 'historyCount',
    'txRangeRecentLabel', 'txRangeAllLabel', 'txHintRecent', 'txHintAll',
    'txOlderLabelMore', 'txOlderLabelBack', 'viewOlderTxBtn', 'txOlderCount'];

function entry(minutesAgo, amount, type) {
    return {
        type: type || 'Trade Executed',
        detail: 'Bot',
        amount: amount,
        timestamp: Date.now() - minutesAgo * 60 * 1000,
        time: minutesAgo + 'm ago',
    };
}

function buildSandbox({ currentWallet = 'demo', demoHistory = [], liveHistory = [] } = {}) {
    const els = {};
    const el = (id) => els[id] || (els[id] = makeEl(id));
    TX_IDS.forEach(el);
    const APP = {
        currentWallet,
        txShowOlder: false,
        txViewExpanded: false,
        demoData: { history: demoHistory },
        liveData: { history: liveHistory },
        bonusData: { history: [] },
    };
    const sandbox = {
        APP, els, el,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        document: { getElementById: el, querySelectorAll: () => [] },
        t: (k) => k,
        formatCurrency: (n) => '$' + Number(n || 0).toFixed(2),
        txTypeLabel: (x) => 'TYPE:' + x,
        txDetailLabel: (x) => 'DETAIL:' + x,
    };
    vm.createContext(sandbox);
    vm.runInContext([
        extractFunction('getCurrentData'),
        extractFunction('getRecentHistory'),
        extractFunction('updateTransactionLog'),
        extractFunction('updateTransactionRangeControls'),
        extractFunction('toggleTransactionRange'),
        extractFunction('toggleTransactionView'),
    ].join('\n'), sandbox);
    sandbox.updateDynamicTranslations = () => {};
    return sandbox;
}

const renderCount = (sb) => (sb.els.tradeHistoryContainer.innerHTML.match(/class="tx-entry"/g) || []).length;

test('default view is still the short "Last 30 min" preview', () => {
    const demo = [entry(5, 12), entry(20, -4), entry(120, 9), entry(600, 30)];
    const sb = buildSandbox({ demoHistory: demo });
    vm.runInContext('updateTransactionLog()', sb);

    assert.strictEqual(sb.APP.txShowOlder, false, 'preview is the default');
    assert.strictEqual(renderCount(sb), 2, 'only entries inside the 30-minute window are previewed');
    assert.strictEqual(sb.els.historyCount.textContent, 2, 'count badge reflects the preview');
    assert.ok(!sb.els.txHintRecent.classes.has('hidden'), 'recent hint shown');
    assert.ok(sb.els.txHintAll.classes.has('hidden'), 'all-activity hint hidden');
    assert.ok(!sb.els.txRangeRecentLabel.classes.has('hidden'), '"Last 30 min" label shown');
    assert.ok(sb.els.txRangeAllLabel.classes.has('hidden'), '"All activity" label hidden');
});

test('older entries are never deleted - they stay in the stored history', () => {
    const demo = [entry(5, 12), entry(120, 9), entry(600, 30)];
    const sb = buildSandbox({ demoHistory: demo });
    const before = sb.APP.demoData.history.length;

    vm.runInContext('updateTransactionLog()', sb);
    vm.runInContext('toggleTransactionRange()', sb);
    vm.runInContext('updateTransactionLog()', sb);

    assert.strictEqual(sb.APP.demoData.history.length, before, 'history array must not be trimmed');
    assert.deepStrictEqual(sb.APP.demoData.history.map((e) => e.timestamp), demo.map((e) => e.timestamp), 'entries and order preserved');
});

test('the "Older activity" switch reveals entries older than the preview', () => {
    const demo = [entry(5, 12), entry(120, 9), entry(600, 30)];
    const sb = buildSandbox({ demoHistory: demo });
    vm.runInContext('updateTransactionLog()', sb);
    assert.strictEqual(renderCount(sb), 1, 'precondition: 1 recent entry');

    assert.ok(!sb.els.viewOlderTxBtn.classes.has('hidden'), 'the switch is offered when older entries exist');
    assert.strictEqual(sb.els.txOlderCount.textContent, '(2 history.entries)', 'older-entry count is shown');

    vm.runInContext('toggleTransactionRange()', sb);

    assert.strictEqual(sb.APP.txShowOlder, true, 'range switched');
    assert.strictEqual(renderCount(sb), 3, 'all stored entries are now visible');
    assert.strictEqual(sb.els.historyCount.textContent, 3);
    assert.ok(!sb.els.txHintAll.classes.has('hidden'), 'all-activity hint shown');
    assert.ok(sb.els.txHintRecent.classes.has('hidden'), 'recent hint hidden');
    assert.ok(!sb.els.txRangeAllLabel.classes.has('hidden'), '"All activity" label shown');
    assert.ok(sb.els.txRangeRecentLabel.classes.has('hidden'), '"Last 30 min" label hidden');
    assert.ok(!sb.els.txOlderLabelBack.classes.has('hidden'), 'the button offers the way back');
});

test('the user can switch back to the recent preview', () => {
    const sb = buildSandbox({ demoHistory: [entry(5, 12), entry(120, 9)] });
    vm.runInContext('toggleTransactionRange()', sb);
    assert.strictEqual(renderCount(sb), 2);
    vm.runInContext('toggleTransactionRange()', sb);
    assert.strictEqual(renderCount(sb), 1, 'back to the 30-minute preview');
    assert.strictEqual(sb.APP.txShowOlder, false);
});

test('demo activity and Live transactions stay separated in the history view', () => {
    const demo = [entry(5, 12, 'Trade Executed')];
    const live = [entry(5, 250, 'Deposit'), entry(200, -50, 'Withdraw')];
    const sb = buildSandbox({ currentWallet: 'demo', demoHistory: demo, liveHistory: live });

    vm.runInContext('updateTransactionLog()', sb);
    assert.ok(/TYPE:Trade Executed/.test(sb.els.tradeHistoryContainer.innerHTML), 'demo view shows demo activity');
    assert.ok(!/TYPE:Deposit/.test(sb.els.tradeHistoryContainer.innerHTML), 'demo view must not show Live records');

    sb.APP.currentWallet = 'live';
    vm.runInContext('toggleTransactionRange()', sb);
    vm.runInContext('updateTransactionLog()', sb);
    assert.ok(/TYPE:Deposit/.test(sb.els.tradeHistoryContainer.innerHTML), 'live view shows Live records');
    assert.ok(!/TYPE:Trade Executed/.test(sb.els.tradeHistoryContainer.innerHTML), 'live view must not show demo activity');
    assert.strictEqual(sb.APP.demoData.history.length, 1, 'the other wallet is untouched');
});

test('an empty 30-minute window does not hide older records', () => {
    const sb = buildSandbox({ demoHistory: [entry(300, 9), entry(900, 30)] });
    vm.runInContext('updateTransactionLog()', sb);

    assert.strictEqual(renderCount(sb), 0, 'nothing inside the preview window');
    assert.ok(/history\.noTransactions/.test(sb.els.tradeHistoryContainer.innerHTML), 'recent-empty state shown');
    assert.ok(!sb.els.viewOlderTxBtn.classes.has('hidden'), 'older entries remain reachable');

    vm.runInContext('toggleTransactionRange()', sb);
    assert.strictEqual(renderCount(sb), 2, 'older records are reachable from the empty preview');
});

test('a fully empty history shows the "no transactions yet" state', () => {
    const sb = buildSandbox({ demoHistory: [] });
    vm.runInContext('updateTransactionLog()', sb);
    assert.ok(/history\.noTransactions/.test(sb.els.tradeHistoryContainer.innerHTML));
    assert.ok(sb.els.viewOlderTxBtn.classes.has('hidden'), 'nothing to reveal');

    sb.APP.txShowOlder = true;
    vm.runInContext('updateTransactionLog()', sb);
    assert.ok(/history\.empty/.test(sb.els.tradeHistoryContainer.innerHTML), 'all-activity empty state is accurate');
});

test('"View More" still expands within the currently displayed range', () => {
    const demo = [];
    for (let i = 1; i <= 8; i++) demo.push(entry(i, i));
    const sb = buildSandbox({ demoHistory: demo });
    vm.runInContext('updateTransactionLog()', sb);

    assert.strictEqual(renderCount(sb), 5, 'first five rows by default');
    assert.ok(!sb.els.viewMoreTxBtn.classes.has('hidden'), 'View More offered');
    assert.strictEqual(sb.els.txMoreCount.textContent, '(3 history.entries)');

    vm.runInContext('toggleTransactionView()', sb);
    assert.strictEqual(renderCount(sb), 8, 'View More expands the range in view');

    vm.runInContext('toggleTransactionRange()', sb);
    assert.strictEqual(sb.APP.txViewExpanded, false, 'changing range resets the expansion');
});

test('getRecentHistory is a pure read-only filter', () => {
    const demo = [entry(5, 12), entry(120, 9)];
    const sb = buildSandbox({ demoHistory: demo });
    const snapshot = JSON.stringify(sb.APP.demoData.history);
    const out = vm.runInContext('getRecentHistory(APP.demoData.history, 30).length', sb);
    assert.strictEqual(out, 1, 'filters to the window');
    assert.strictEqual(JSON.stringify(sb.APP.demoData.history), snapshot, 'input array is not mutated');
});

test('the history view makes no requests and cannot move money', () => {
    const logFn = extractFunction('updateTransactionLog');
    const rangeFn = extractFunction('toggleTransactionRange');
    const ctrlFn = extractFunction('updateTransactionRangeControls');
    for (const fn of [logFn, rangeFn, ctrlFn]) {
        assert.ok(!/fetch\(/.test(fn), 'history rendering must not call the server');
        assert.ok(!/credit|debit|balance\s*[-+]?=|live_balance|bonus_balance/.test(fn), 'must not modify any balance');
    }
    assert.ok(!/txShowOlder/.test(extractFunction('getRecentHistory')), 'the filter knows nothing about display mode');
    assert.ok(/txShowOlder: false/.test(INDEX), 'the preview range is the shipped default');
});
