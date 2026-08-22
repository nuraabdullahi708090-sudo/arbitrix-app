'use strict';

/**
 * MARKETING SANDBOX withdraw-section "$700 minimum" removal — regression tests.
 *
 * Sandbox withdrawals are balance-only (no $700 minimum), so the sandbox
 * account's withdraw section must never display "$700 minimum" wording. Pins:
 *  - sandbox variant keys exist, are non-empty in all 6 locales, and contain
 *    NO "700";
 *  - the production keys still contain the $700 wording (unchanged);
 *  - updateLiveWithdrawStatus() renders the sandbox variants ONLY when
 *    APP.environment === 'MARKETING_SANDBOX' (production unchanged);
 *  - production gating logic is unchanged (MIN_WITHDRAWAL stays 700; the
 *    min/deposit/trade gates are still only SKIPPED for sandbox, not removed);
 *  - the language-switch re-render hook re-renders the withdraw text so the
 *    sandbox variant survives setLanguage();
 *  - i18n parity: identical key sets, no empty values, no new duplicate keys.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function loadTranslations() {
    const blocks = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const blk = blocks.find((b) => b.includes('const TRANSLATIONS'));
    assert.ok(blk, 'TRANSLATIONS block should exist');
    const start = blk.indexOf('const TRANSLATIONS');
    let i = blk.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < blk.length; i++) {
        if (blk[i] === '{') depth++;
        else if (blk[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, 'TRANSLATIONS object should be brace-matchable');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + blk.slice(blk.indexOf('{', start), end + 1), sandbox);
    return sandbox.T;
}

// Extract a top-level function body by brace matching.
function extractFunction(name) {
    const start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
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

const SANDBOX_KEYS = ['withdraw.infoSandbox', 'live.withdrawStatus.readySandbox'];

test('sandbox withdraw variant keys exist in all 6 locales and contain no "700"', () => {
    const T = loadTranslations();
    assert.deepStrictEqual(Object.keys(T).sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
    for (const lang of Object.keys(T)) {
        for (const key of SANDBOX_KEYS) {
            assert.ok(T[lang][key], `${lang}.${key} missing`);
            assert.ok(!T[lang][key].includes('700'), `${lang}.${key} must not mention $700`);
        }
    }
});

test('production withdraw keys still carry the $700 wording (unchanged)', () => {
    const T = loadTranslations();
    for (const lang of Object.keys(T)) {
        assert.ok(T[lang]['withdraw.info'].includes('$700'), `${lang} withdraw.info changed`);
        assert.ok(T[lang]['live.withdrawStatus.ready'].includes('$700'), `${lang} live.withdrawStatus.ready changed`);
        assert.ok(T[lang]['withdraw.min700'].includes('$700'), `${lang} withdraw.min700 changed`);
    }
});

test('updateLiveWithdrawStatus renders sandbox variants only for MARKETING_SANDBOX', () => {
    const fnSrc = extractFunction('updateLiveWithdrawStatus');
    function run(environment, liveData) {
        const els = {
            liveWithdrawStatus: { textContent: '', style: {} },
            withdrawInfoText: { textContent: '', style: {} },
        };
        const sandbox = {
            APP: {
                environment,
                liveData,
                MTA: 143,
                MIN_WITHDRAWAL: 700,
            },
            document: { getElementById: (id) => els[id] || null },
            t: (key) => key,
        };
        vm.createContext(sandbox);
        vm.runInContext(fnSrc + '; updateLiveWithdrawStatus();', sandbox);
        return els;
    }
    const funded = { hasRealDeposit: true, hasTradingActivity: true, balance: 1500 };

    // Sandbox: ready state uses the sandbox variant (no $700 wording) for BOTH
    // the sidebar status and the withdraw modal info box.
    let els = run('MARKETING_SANDBOX', { ...funded });
    assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.readySandbox');
    assert.strictEqual(els.withdrawInfoText.textContent, 'withdraw.infoSandbox');

    // Production: ready state keeps the $700 production wording.
    els = run('PRODUCTION', { ...funded });
    assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.ready');
    assert.strictEqual(els.withdrawInfoText.textContent, 'withdraw.info');

    // Undefined environment (pre-sync) behaves as production.
    els = run(undefined, { ...funded });
    assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.ready');

    // Sandbox non-ready branches unchanged (no $700 keys involved there).
    els = run('MARKETING_SANDBOX', { hasRealDeposit: false, hasTradingActivity: false, balance: 0 });
    assert.strictEqual(els.liveWithdrawStatus.textContent, 'live.withdrawStatus.notDeposited');
    assert.strictEqual(els.withdrawInfoText.textContent, 'live.withdrawStatus.notDeposited');
});

test('production gating logic is unchanged (MIN_WITHDRAWAL=700, gates skipped only for sandbox)', () => {
    assert.ok(/MIN_WITHDRAWAL:\s*700/.test(INDEX), 'APP.MIN_WITHDRAWAL must stay 700');
    const submit = extractFunction('submitWithdraw');
    assert.ok(submit.includes("APP.environment === 'MARKETING_SANDBOX'"), 'sandbox flag must remain in submitWithdraw');
    assert.ok(submit.includes('!isSandbox && amount < APP.MIN_WITHDRAWAL'), 'production $700 submit gate must remain');
    const open = extractFunction('openWithdrawModal');
    assert.ok(open.includes('if (!isSandbox)'), 'production-only gate block must remain in openWithdrawModal');
    assert.ok(open.includes('APP.liveData.balance < APP.MIN_WITHDRAWAL'), 'Gate 2 min-withdrawal check must remain for production');
});

test('language switch re-renders the withdraw status/info text (hook in updateDynamicTranslations)', () => {
    const hook = extractFunction('updateDynamicTranslations');
    assert.ok(hook.includes('updateLiveWithdrawStatus();'), 'updateDynamicTranslations must re-render withdraw text');
    // applyTranslations must end by calling updateDynamicTranslations (ordering:
    // data-i18n pass first, dynamic overrides after).
    const apply = extractFunction('applyTranslations');
    assert.ok(apply.indexOf('updateDynamicTranslations();') > apply.indexOf('querySelectorAll'), 'updateDynamicTranslations must run after the data-i18n pass');
});

test('i18n parity: identical key sets across all 6 locales, no empty values', () => {
    const T = loadTranslations();
    const en = Object.keys(T.en);
    assert.strictEqual(en.length, 1235, 'expected 1235 keys per locale');
    for (const [lang, dict] of Object.entries(T)) {
        const keys = Object.keys(dict);
        assert.deepStrictEqual(new Set(keys), new Set(en), `${lang} key set differs from en`);
        for (const k of keys) assert.ok(String(dict[k]).length > 0, `${lang}.${k} empty`);
    }
});
