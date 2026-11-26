'use strict';

/**
 * Admin deposit reconciliation panel.
 *
 * A rounded or late payment, and a confirmed deposit that was never credited,
 * used to be visible only through an undocumented API route. This pins the admin
 * surface built on it, and - most importantly - that the panel remains READ-ONLY:
 * reconciliation is a human act and nothing here may credit a wallet.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function adminMarkup() {
    const start = INDEX.indexOf('id="adminTabContentDeposits"');
    const end = INDEX.indexOf('id="adminTabContentWithdrawals"');
    assert.ok(start > 0 && end > start, 'the deposits tab markup exists');
    return INDEX.slice(start, end);
}

test('the panel lives in the Deposits tab and refreshes from the read-only route', () => {
    const markup = adminMarkup();
    for (const id of ['reconciliationSummary', 'reconciliationTable', 'reconciliationWindow']) {
        assert.match(markup, new RegExp('id="' + id + '"'), id + ' is inside the Deposits tab');
    }
    assert.match(markup, /onclick="loadDepositReconciliation\(\)"/, 'refresh button wired');
    assert.match(markup, /onchange="loadDepositReconciliation\(\)"/, 'window selector wired');
    assert.match(INDEX, /fetch\('\/api\/admin\/deposits\/reconciliation\?hours='/,
        'uses the existing read-only endpoint');
    assert.match(SERVER, /app\.get\('\/api\/admin\/deposits\/reconciliation', authMiddleware, adminMiddleware/,
        'the route is admin-gated');
});

test('it loads when the admin opens the Deposits tab', () => {
    assert.match(INDEX, /if \(tab === 'deposits' && typeof loadDepositReconciliation === 'function'\)\s*\{\s*loadDepositReconciliation\(\);/);
});

test('READ-ONLY: the panel cannot credit, confirm or mutate anything', () => {
    const js = INDEX.slice(INDEX.indexOf('async function loadDepositReconciliation'),
        INDEX.indexOf('function renderAdminDeposits'));
    assert.ok(js.length > 400, 'the panel implementation is present');
    assert.ok(!/method:\s*'POST'|method:\s*"POST"/.test(js), 'no POST from the panel');
    for (const forbidden of ['/api/admin/deposits/', '/confirm', '/credit', 'record_trade', 'live_balance']) {
        if (forbidden === '/api/admin/deposits/') continue;
        assert.ok(!js.includes(forbidden), 'the panel must not reference ' + forbidden);
    }
    assert.match(js, /Bearer ' \+ token/, 'it authenticates as the admin');
});

test('the note states that nothing is credited automatically, in all six locales', () => {
    const i = INDEX.indexOf('const TRANSLATIONS');
    const start = INDEX.indexOf('{', i);
    let depth = 0;
    let end = -1;
    for (let k = start; k < INDEX.length; k++) {
        if (INDEX[k] === '{') depth++;
        else if (INDEX[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    const sb = {};
    vm.createContext(sb);
    vm.runInContext('this.T = ' + INDEX.slice(start, end + 1), sb);
    const T = sb.T;
    for (const lang of ['en', 'es', 'pt', 'fr', 'ar', 'zh']) {
        for (const key of ['admin.reconciliation.title', 'admin.reconciliation.desc',
            'admin.reconciliation.stale', 'admin.reconciliation.uncredited',
            'admin.reconciliation.empty']) {
            const v = T[lang] && T[lang][key];
            assert.ok(typeof v === 'string' && v.trim(), lang + ' has ' + key);
        }
        assert.match(T[lang]['admin.reconciliation.stale'], /\{\{count\}\}/, lang + ' keeps {{count}}');
        assert.match(T[lang]['admin.reconciliation.uncredited'], /\{\{count\}\}/, lang + ' keeps {{count}}');
    }
    assert.match(T.en['admin.reconciliation.desc'], /[Nn]othing here is credited automatically/);
});

test('the renderer interpolates counts and escapes what it prints', () => {
    const start = INDEX.indexOf('function renderAdminReconciliation');
    const end = INDEX.indexOf('function renderAdminDeposits');
    const js = INDEX.slice(start, end > start ? end : start + 6000);
    assert.match(js, /t\('admin\.reconciliation\.stale', \{ count: stale\.length \}\)/);
    assert.match(js, /t\('admin\.reconciliation\.uncredited', \{ count: uncredited\.length \}\)/);
    assert.match(js, /replace\(\/\[&<>"']\/g/, 'values are HTML-escaped before insertion');
    assert.match(js, /toFixed\(4\)/, 'the exact on-chain amount is shown for a stale invoice');
});

test('a language switch re-renders the panel from its cached data', () => {
    assert.match(INDEX, /adminReconciliation: null,/);
    assert.match(INDEX, /I18N_RERENDER_CACHE\.adminReconciliation = data;/);
    assert.match(INDEX, /renderAdminReconciliation\(I18N_RERENDER_CACHE\.adminReconciliation\)/);
});

test('the endpoint stays read-only on the server', () => {
    const start = SERVER.indexOf("app.get('/api/admin/deposits/reconciliation'");
    const end = SERVER.indexOf('app.', start + 10);
    const route = SERVER.slice(start, end > start ? end : start + 3000);
    assert.ok(!/\.insert\(|\.update\(|\.upsert\(|\.rpc\(/.test(route),
        'the reconciliation route performs no writes');
    // The projection grew (provider id, tx hash, payout address) so an operator can
    // investigate a payment instead of guessing, but the fields this test exists to
    // protect are all still there.
    assert.match(route, /select\('id, invoice_id, user_id, amount_usd, amount_crypto/);
    for (const field of ['provider', 'provider_invoice_ref', 'provider_tx_hash', 'wallet_address']) {
        assert.ok(route.includes(field), 'the reconciliation projection includes ' + field);
    }
});
