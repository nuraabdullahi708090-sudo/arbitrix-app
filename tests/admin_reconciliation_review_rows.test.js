'use strict';

/**
 * Admin reconciliation panel: the review rows.
 *
 * The endpoint can now report four kinds of problem (a stale invoice, a
 * provider-confirmed invoice we never credited, a deposit row confirmed but not
 * credited, and a recorded webhook failure). Before this, the panel rendered only
 * two of them, so a "confirmed payment, needs review" row was invisible to the
 * administrator who had to act on it.
 *
 * These tests execute the REAL renderAdminReconciliation() and the REAL
 * loadDepositReconciliation() (only fetch and the DOM are faked), against the real
 * translations, so a template error or a missing key fails here rather than in
 * production.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/** The TRANSLATIONS literal, evaluated exactly as the page does. */
function loadTranslations() {
    const start = INDEX.indexOf('const TRANSLATIONS');
    const open = INDEX.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < INDEX.length; i += 1) {
        if (INDEX[i] === '{') depth += 1;
        else if (INDEX[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                const sandbox = {};
                vm.createContext(sandbox);
                vm.runInContext('this.T = ' + INDEX.slice(open, i + 1) + ';', sandbox);
                return sandbox.T;
            }
        }
    }
    throw new Error('TRANSLATIONS literal not found');
}

/** Extract a top-level function declaration from the page. */
function extractFunction(name) {
    const start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start > 0, 'missing function ' + name);
    // Keep the `async` keyword: without it the extracted body cannot be evaluated.
    const prefix = INDEX.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '';
    let depth = 0;
    let seenBrace = false;
    for (let i = INDEX.indexOf('{', start); i < INDEX.length; i += 1) {
        if (INDEX[i] === '{') { depth += 1; seenBrace = true; }
        else if (INDEX[i] === '}') {
            depth -= 1;
            if (seenBrace && depth === 0) return prefix + INDEX.slice(start, i + 1);
        }
    }
    throw new Error('unterminated function ' + name);
}

function makeSandbox({ translations, lang = 'en', elements = {}, fetchImpl } = {}) {
    const T = translations || loadTranslations();
    const store = Object.assign({}, elements);
    const document = {
        getElementById: (id) => store[id] || null
    };
    const sandbox = {
        document,
        window: {},
        console,
        localStorage: { getItem: () => 'jwt', setItem: () => {} },
        fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ success: true }) })),
        currentLang: lang,
        I18N_RERENDER_CACHE: {},
        formatTime: (v) => String(v || ''),
        APP: { environment: 'PRODUCTION' }
    };
    vm.createContext(sandbox);
    vm.runInContext(
        'const TRANSLATIONS = ' + JSON.stringify(T) + ';' +
        'function t(key, vars) { const s = (TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key]) || TRANSLATIONS.en[key] || key;' +
        '  return String(s).replace(/\\{\\{(\\w+)\\}\\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m)); }' +
        extractFunction('renderAdminReconciliation') + '\n' +
        extractFunction('loadDepositReconciliation') + '\n' +
        'this.renderAdminReconciliation = renderAdminReconciliation;' +
        'this.loadDepositReconciliation = loadDepositReconciliation;',
        sandbox
    );
    return { sandbox, store };
}

const REVIEW_PAYLOAD = {
    success: true,
    windowHours: 24,
    verified: true,
    counts: { stalePending: 1, confirmedButUncredited: 1, uncreditedConfirmedDeposits: 0, needsReview: 1 },
    stalePending: [{
        id: 41, invoiceId: 'ARB_STALE', userId: 7, amountUsd: 50, amountCrypto: 50.002,
        status: 'expired', provider: 'q8qpay', providerInvoiceId: 'q8q-1',
        payoutAddress: 'TAddr', createdAt: '2026-11-25T10:00:00Z'
    }],
    confirmedButUncredited: [{
        id: 42, invoiceId: 'ARB_CONFIRMED', userId: 8, amountUsd: 50, amountCrypto: 50.002,
        provider: 'q8qpay', providerInvoiceId: 'q8q-2', providerTxHash: 'f'.repeat(64),
        createdAt: '2026-11-25T11:00:00Z', reason: 'confirmed-but-not-credited'
    }],
    uncreditedConfirmed: [],
    needsReview: [{
        logId: 77, receivedAt: '2026-11-25T12:00:00Z', invoiceId: 'ARB_REVIEW', providerInvoiceId: 'q8q-3',
        outcome: 'amount_mismatch', message: 'The confirmed amount differs from the exact amount quoted',
        expectedAmountCrypto: '50.0020', confirmedAmountCrypto: '50.0000', providerStatus: 'confirmed',
        providerTxHash: 'a'.repeat(64), userId: 9, reason: 'amount-mismatch'
    }],
    providerChecks: [{
        invoiceId: 'ARB_STALE', providerInvoiceId: 'q8q-1', ok: true,
        providerStatus: 'confirmed', providerAmountCrypto: '50.0020', diagnosis: 'paid_but_uncredited', amountMatches: true
    }]
};

test('the panel renders every review list with the evidence an operator needs', () => {
    const body = { innerHTML: '', textContent: '' };
    const summary = { innerHTML: '', textContent: '' };
    const { sandbox } = makeSandbox({
        elements: { reconciliationTable: body, reconciliationSummary: summary }
    });
    sandbox.renderAdminReconciliation(REVIEW_PAYLOAD);

    // The webhook failure: reference, both amounts, the outcome and the reason.
    assert.ok(body.innerHTML.includes('ARB_REVIEW'), 'the recorded webhook failure is listed');
    assert.ok(body.innerHTML.includes('amount_mismatch'), 'with its outcome');
    assert.ok(body.innerHTML.includes('50.0020'), 'and the expected amount');
    assert.ok(body.innerHTML.includes('50.0000'), 'and the confirmed amount');
    assert.ok(body.innerHTML.includes('tx aaaaaaaaaaaaaaaaaa'), 'and the transaction hash');

    // The provider-confirmed-but-uncredited case.
    assert.ok(body.innerHTML.includes('Provider confirms payment - not credited'));

    // Our own confirmed-but-uncredited invoice.
    assert.ok(body.innerHTML.includes('ARB_CONFIRMED'));

    // The stale invoice (unchanged behaviour).
    assert.ok(body.innerHTML.includes('ARB_STALE'));

    // The summary counts the review rows.
    assert.match(summary.textContent, /need review/);
});

test('the panel still renders an empty window without inventing rows', () => {
    const body = { innerHTML: '' };
    const summary = { textContent: '' };
    const { sandbox } = makeSandbox({ elements: { reconciliationTable: body, reconciliationSummary: summary } });
    sandbox.renderAdminReconciliation({
        success: true, stalePending: [], uncreditedConfirmed: [], confirmedButUncredited: [], needsReview: [], providerChecks: []
    });
    assert.match(body.innerHTML, /Nothing to reconcile/);
    assert.ok(!body.innerHTML.includes('<tr style="border-bottom'), 'no data rows');
});

test('the translations for the review rows exist in all six locales', () => {
    const T = loadTranslations();
    const langs = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
    for (const key of ['admin.reconciliation.needsReview', 'admin.reconciliation.verify',
        'admin.reconciliation.providerPaid', 'admin.reconciliation.providerPending',
        'admin.reconciliation.reason']) {
        for (const lang of langs) {
            assert.ok(T[lang][key] && T[lang][key].length > 0, lang + '.' + key + ' must exist');
        }
    }
    // Placeholder parity: a lost {{count}}/{{status}}/{{reason}} renders literally.
    for (const lang of langs) {
        assert.match(T[lang]['admin.reconciliation.needsReview'], /\{\{count\}\}/, lang);
        assert.match(T[lang]['admin.reconciliation.providerPending'], /\{\{status\}\}/, lang);
        assert.match(T[lang]['admin.reconciliation.reason'], /\{\{reason\}\}/, lang);
    }
});

test('the verify action asks the provider, and the default load does not', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        return { ok: true, json: async () => ({ success: true, stalePending: [], uncreditedConfirmed: [] }) };
    };
    const body = { innerHTML: '' };
    const summary = { textContent: '' };
    const { sandbox } = makeSandbox({
        elements: { reconciliationTable: body, reconciliationSummary: summary },
        fetchImpl
    });

    await sandbox.loadDepositReconciliation();
    assert.strictEqual(calls.length, 1);
    assert.ok(!calls[0].includes('verify=1'), 'a plain load does not hit the provider: ' + calls[0]);

    await sandbox.loadDepositReconciliation(true);
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1].includes('verify=1'), 'the explicit action asks for a provider check: ' + calls[1]);
});

test('the panel performs no write and no credit', () => {
    const renderer = extractFunction('renderAdminReconciliation') + extractFunction('loadDepositReconciliation');
    for (const banned of ['POST', 'PUT', 'DELETE', 'credit_payment_safe', '.rpc(', 'wallet']) {
        assert.ok(!renderer.includes(banned), 'the reconciliation panel must not contain ' + banned);
    }
    // Only a GET of the read-only endpoint.
    assert.match(renderer, /fetch\('\/api\/admin\/deposits\/reconciliation\?hours=/);
});
