'use strict';

/**
 * MARKETING SANDBOX has NO identity verification / KYC — regression tests.
 *
 * The sandbox is a simulated marketing environment: no KYC is ever required or
 * possible for a sandbox account. Pins:
 *  - server: every KYC write endpoint 403-blocks sandbox accounts (no KYC rows);
 *  - server: /api/kyc/can-withdraw short-circuits for sandbox WITHOUT weakening
 *    the production verification requirement;
 *  - frontend: openVerificationModal() short-circuits for MARKETING_SANDBOX and
 *    never opens the real KYC form (informational modal instead);
 *  - frontend: openWithdrawModal() short-circuits for sandbox BEFORE the KYC
 *    capability call, and the production KYC gate is intact;
 *  - demo (non-sandbox) and production verification paths are unchanged;
 *  - i18n: sandbox info keys exist + are non-empty in all 6 locales.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    let i = src.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' should be brace-matchable');
    return src.slice(start, end + 1);
}

// ---------- server ----------

test('server: all KYC write endpoints block sandbox accounts', () => {
    const callSites = SERVER.match(/if \(await blockSandboxKyc\(req, res\)\) return;/g) || [];
    assert.ok(callSites.length >= 4, `expected >=4 KYC endpoints guarded, got ${callSites.length}`);
    const guard = extractFunction(SERVER, 'blockSandboxKyc');
    assert.ok(guard.includes("await isMarketingSandboxUser(req.user.id)"), 'guard must use the server classification');
    assert.ok(guard.includes('status(403)'), 'guard must 403 (never create KYC rows)');
});

test('server: can-withdraw short-circuits sandbox without weakening production KYC', () => {
    const idx = SERVER.indexOf("app.get('/api/kyc/can-withdraw'");
    assert.ok(idx > 0);
    const body = SERVER.slice(idx, idx + 1600);
    const sbxIdx = body.indexOf('isMarketingSandboxUser(userId)');
    const prodIdx = body.indexOf('kycService.getVerificationStatus(userId)');
    assert.ok(sbxIdx > 0, 'sandbox branch must exist');
    assert.ok(prodIdx > sbxIdx, 'production verification check must remain AFTER the sandbox branch');
    assert.ok(body.includes('canWithdraw: true'), 'sandbox reports canWithdraw without KYC');
    assert.ok(/canWithdraw: requiresVerification \? isVerified : true/.test(body),
        'production can-withdraw is driven by WITHDRAWAL_REQUIRES_VERIFICATION');
    assert.ok(/const requiresVerification = WITHDRAWAL_REQUIRES_VERIFICATION;/.test(body),
        'the flag is read from the single server constant');
});

test('server: sandbox handlers never touch the production KYC surfaces', () => {
    // Every sandbox handler/-helper function must stay clear of KYC tables and
    // the KYC service (KYC has no role in the sandbox at all).
    const names = [...SERVER.matchAll(/async function ([A-Za-z]*[Ss]andbox[A-Za-z]*)\(/g)].map((m) => m[1]);
    assert.ok(names.length >= 20, `expected the sandbox handler set, got ${names.length}`);
    for (const name of names) {
        if (name === 'blockSandboxKyc') continue; // the KYC guard itself
        const fn = extractFunction(SERVER, name);
        assert.ok(
            !/kycService|verification_profiles|verification_documents|verification_history|admin_review_history/.test(fn),
            `${name} must not reference KYC surfaces`
        );
    }
});

// ---------- frontend: verification modal ----------

test('frontend: openVerificationModal short-circuits MARKETING_SANDBOX before any KYC path', () => {
    const fn = extractFunction(INDEX, 'openVerificationModal');
    const sbxIdx = fn.indexOf("APP.environment === 'MARKETING_SANDBOX'");
    const demoIdx = fn.indexOf("APP.mode === 'demo'");
    const liveIdx = fn.indexOf("APP.mode === 'live'");
    const formIdx = fn.indexOf("getElementById('verificationModal').classList.add('open')");
    assert.ok(sbxIdx > 0, 'sandbox branch must exist');
    assert.ok(sbxIdx < demoIdx && sbxIdx < liveIdx && sbxIdx < formIdx, 'sandbox must be checked FIRST');
    assert.ok(fn.includes("getElementById('verificationSandboxInfoModal')"), 'sandbox shows the info modal');
    const sbxBlock = fn.slice(sbxIdx, demoIdx);
    assert.ok(sbxBlock.includes('return;'), 'sandbox branch must return before the KYC form');
});

test('frontend: openVerificationModal runtime behavior per environment/mode', () => {
    const fnSrc = extractFunction(INDEX, 'openVerificationModal');
    function run(environment, mode, hasTradingActivity) {
        const opened = [];
        const els = {
            verificationSandboxInfoModal: { classList: { add: (c) => opened.push('sandboxInfo:' + c) } },
            verificationDemoInfoModal: { classList: { add: (c) => opened.push('demoInfo:' + c) } },
            verificationModal: { classList: { add: (c) => opened.push('kycForm:' + c) } },
        };
        const toasts = [];
        const ctx = {
            APP: { environment, mode, liveData: { hasTradingActivity } },
            document: { getElementById: (id) => els[id] || null },
            showToast: (msg, kind) => toasts.push(msg),
            t: (k) => k,
            loadVerificationStatus: () => opened.push('loadVerificationStatus'),
        };
        vm.createContext(ctx);
        vm.runInContext(fnSrc + '; openVerificationModal();', ctx);
        return { opened, toasts };
    }

    // Sandbox (any mode): info modal only — never the KYC form, no status fetch.
    for (const mode of ['demo', 'live']) {
        for (const traded of [false, true]) {
            const r = run('MARKETING_SANDBOX', mode, traded);
            assert.deepStrictEqual(r.opened, ['sandboxInfo:open'], `sandbox ${mode}/${traded} must only open the info modal`);
            assert.deepStrictEqual(r.toasts, [], 'sandbox must not prompt for a trade');
        }
    }

    // Production demo: unchanged demo info modal.
    let r = run('PRODUCTION', 'demo', false);
    assert.deepStrictEqual(r.opened, ['demoInfo:open']);

    // Production live without a trade: unchanged toast, no form.
    r = run('PRODUCTION', 'live', false);
    assert.ok(r.toasts.length === 1 && r.opened.length === 0, 'production trade prompt unchanged');

    // Production live with a trade: unchanged KYC form + status load.
    r = run('PRODUCTION', 'live', true);
    assert.deepStrictEqual(r.opened, ['kycForm:open', 'loadVerificationStatus']);
});

test('frontend: sandbox info modal markup + close helper', () => {
    assert.ok(INDEX.includes('id="verificationSandboxInfoModal"'), 'sandbox info modal must exist');
    assert.ok(INDEX.includes('onclick="closeVerificationSandboxInfo()"'), 'close button wired');
    assert.ok(INDEX.includes("data-i18n=\"kyc.sandboxInfo.title\""), 'title wired to i18n');
    assert.ok(INDEX.includes("data-i18n=\"kyc.sandboxInfo.body\""), 'body wired to i18n');
    const close = extractFunction(INDEX, 'closeVerificationSandboxInfo');
    assert.ok(close.includes("getElementById('verificationSandboxInfoModal')"));
    assert.ok(close.includes("classList.remove('open')"));
});

// ---------- frontend: withdrawal ----------

test('frontend: sandbox withdraw skips the KYC capability call; production gate intact', () => {
    const fn = extractFunction(INDEX, 'openWithdrawModal');
    const sbxIdx = fn.indexOf("const isSandbox = APP.environment === 'MARKETING_SANDBOX'");
    const sbxReturn = fn.indexOf('syncSandboxWithdrawHistory();');
    const kycFetch = fn.indexOf("fetch('/api/kyc/can-withdraw'");
    assert.ok(sbxIdx > 0 && kycFetch > 0, 'both branches must exist');
    assert.ok(sbxIdx < kycFetch, 'sandbox short-circuit must precede the KYC check');
    assert.ok(sbxReturn > 0 && sbxReturn < kycFetch, 'sandbox path still refreshes the simulated history');
    const sbxBlock = fn.slice(sbxIdx, kycFetch);
    assert.ok(sbxBlock.includes('return;'), 'sandbox path returns before the KYC request');
    assert.ok(sbxBlock.includes("getEl('withdrawKycRequired').style.display = 'none'"), 'no verification-required screen for sandbox');
    // Production gate unchanged.
    assert.ok(fn.includes('if (!kycData.canWithdraw)'), 'production KYC gate must remain');
    assert.ok(fn.includes('if (!isSandbox) {'), 'production-only min/deposit/trade gates must remain');
    assert.ok(/MIN_WITHDRAWAL:\s*500/.test(INDEX), 'production withdrawal minimum stays 500');
});

// ---------- i18n ----------

test('i18n: sandbox info keys exist in all 6 locales (parity intact)', () => {
    const blocks = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const blk = blocks.find((b) => b.includes('const TRANSLATIONS'));
    const start = blk.indexOf('const TRANSLATIONS');
    let i = blk.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < blk.length; i++) {
        if (blk[i] === '{') depth++;
        else if (blk[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + blk.slice(blk.indexOf('{', start), end + 1), sandbox);
    const T = sandbox.T;
    assert.deepStrictEqual(Object.keys(T).sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
    const enKeys = Object.keys(T.en);
    for (const lang of Object.keys(T)) {
        assert.deepStrictEqual(new Set(Object.keys(T[lang])), new Set(enKeys), `${lang} key set differs`);
        for (const k of ['kyc.sandboxInfo.title', 'kyc.sandboxInfo.body']) {
            assert.ok(T[lang][k] && String(T[lang][k]).length > 0, `${lang}.${k} missing/empty`);
        }
    }
    // The sandbox copy must never claim a KYC requirement.
    for (const lang of Object.keys(T)) {
        const body = T[lang]['kyc.sandboxInfo.body'];
        assert.ok(/KYC|身份验证|التحقق|vérifi|verifica|verificação/i.test(body), `${lang} body should state the no-KYC rule`);
        assert.ok(!/must|required before|obligatoire|debes|obligat|يجب أن|必须/.test(body) || /without KYC|no KYC/i.test(body), `${lang} body must not imply a requirement`);
    }
});
