'use strict';

/**
 * STANDALONE KYC UI HIDDEN — tests (UI-only change).
 *
 * Management approved hiding ONLY the standalone verification/KYC entry point.
 * This suite pins:
 *   - the standalone sidebar Verification tab is hidden;
 *   - there is no standalone KYC step in registration/onboarding;
 *   - the approved "verification is not required" wording is used and localized;
 *   - the KYC form, the backend KYC endpoints, the withdrawal-triggered
 *     verification path, and all backend verification behavior are PRESERVED
 *     (nothing deleted, renamed, or disabled).
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const KYC_SERVICE = fs.readFileSync(path.join(__dirname, '..', 'services', 'KYCService.js'), 'utf8');
const LOCALES = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function loadTranslations() {
    const blocks = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const blk = blocks.find((b) => b.includes('const TRANSLATIONS'));
    const start = blk.indexOf('const TRANSLATIONS');
    let i = blk.indexOf('{', start), depth = 0, end = -1;
    for (; i < blk.length; i++) {
        if (blk[i] === '{') depth++;
        else if (blk[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + blk.slice(blk.indexOf('{', start), end + 1), sandbox);
    return sandbox.T;
}

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start), depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' should be brace-matchable');
    return INDEX.slice(start, end + 1);
}

const T = loadTranslations();

test('the standalone verification sidebar tab is hidden', () => {
    const link = INDEX.match(/<a class="sidebar-link[^"]*" id="verificationSidebarLink"[^>]*>/);
    assert.ok(link, 'verification sidebar link should still exist in the DOM');
    assert.ok(/\bhidden\b/.test(link[0]), 'verification sidebar link must be hidden');
});

test('the standalone verification modal still exists but is only reachable from the withdrawal flow', () => {
    assert.ok(/id="verificationModal"/.test(INDEX), 'KYC modal must not be deleted');
    // Every invocation of openVerificationModal must come from the withdraw
    // KYC-required screen or the (hidden) sidebar handler listener — no new
    // standalone/onboarding entry point.
    const callers = [...INDEX.matchAll(/openVerificationModal\(\)/g)];
    const inlineOnclicks = [...INDEX.matchAll(/onclick="[^"]*openVerificationModal\(\)[^"]*"/g)].map((m) => m[0]);
    assert.ok(inlineOnclicks.length >= 1, 'withdrawal-triggered verification must remain');
    for (const c of inlineOnclicks) {
        assert.ok(/closeWithdrawModal\(\)/.test(c), 'the only inline caller is the withdrawal KYC screen');
    }
    assert.ok(callers.length >= 2, 'definition + callers should exist');
});

test('registration and onboarding contain no standalone KYC step or prompt', () => {
    const onboardAt = INDEX.indexOf('id="onboardingModal"');
    assert.ok(onboardAt > 0, 'onboarding modal should exist');
    const onboard = INDEX.slice(onboardAt, onboardAt + 5000);
    assert.ok(!/kyc|verification|Verification/.test(onboard), 'onboarding has no KYC step');
    assert.ok(!/openVerificationModal/.test(onboard), 'onboarding never opens the KYC form');

    const signupAt = INDEX.indexOf('async function handleSignup');
    assert.ok(signupAt > 0, 'handleSignup should exist');
    assert.ok(!/kyc|verification|Verification/.test(INDEX.slice(signupAt, signupAt + 4000)),
        'registration must not require verification');
});

test('the approved "verification is not required" wording is displayed and localized', () => {
    assert.ok(/data-i18n="support\.verificationNotRequired"/.test(INDEX),
        'the approved wording must be wired via data-i18n');
    for (const loc of LOCALES) {
        const v = T[loc] && T[loc]['support.verificationNotRequired'];
        assert.ok(typeof v === 'string' && v.trim(), `${loc}: wording must be present`);
    }
    // English wording must match the approved message (meaning-preserving).
    assert.ok(/Verification is not required/i.test(T.en['support.verificationNotRequired']));
    assert.ok(/additional checks may still be required/i.test(T.en['support.verificationNotRequired']));
});

test('openVerificationModal keeps its sandbox/demo/live behavior intact', () => {
    const fn = extractFunction('openVerificationModal');
    assert.ok(/MARKETING_SANDBOX/.test(fn), 'sandbox short-circuit preserved');
    assert.ok(/verificationSandboxInfoModal/.test(fn), 'sandbox info modal preserved');
    assert.ok(/APP\.mode === 'demo'/.test(fn), 'demo short-circuit preserved');
    assert.ok(/verificationDemoInfoModal/.test(fn), 'demo info modal preserved');
    assert.ok(/getElementById\('verificationModal'\)\.classList\.add\('open'\)/.test(fn),
        'live path still opens the real KYC form (withdrawal-triggered)');
});

test('withdrawal-triggered verification is preserved', () => {
    const withdraw = INDEX.slice(INDEX.indexOf('id="withdrawModal"'), INDEX.indexOf('id="withdrawModal"') + 9000);
    assert.ok(/id="withdrawKycRequired"/.test(withdraw), 'withdraw KYC-required screen preserved');
    assert.ok(/withdraw\.startVerification/.test(withdraw), 'Start Verification action preserved');
    assert.ok(/openVerificationModal\(\)/.test(withdraw), 'withdraw screen still opens verification');
});

test('all backend verification endpoints are preserved and unchanged', () => {
    const endpoints = [
        "/api/kyc/status", "/api/kyc/personal-info", "/api/kyc/upload",
        "/api/kyc/submit", "/api/kyc/document/:documentId", "/api/kyc/can-withdraw",
        "/api/kyc/config",
    ];
    for (const ep of endpoints) {
        assert.ok(SERVER.includes("'" + ep + "'"), `${ep} must remain defined`);
    }
    // The withdrawal KYC gate must still be present and server-side.
    assert.ok(/kycService\.getVerificationStatus\(userId\)/.test(SERVER));
    assert.ok(/verificationRequired: true/.test(SERVER));
    // The KYC service module must remain (not gutted).
    assert.ok(/getVerificationStatus/.test(KYC_SERVICE));
    assert.ok(/VERIFICATION_STATUS|status/.test(KYC_SERVICE));
});

test('this change is frontend-only: no support/KYC-hide code leaked into the backend', () => {
    for (const marker of ['OFFICIAL_SUPPORT', 'arbitrix-support-telegram', 'openSupportModal',
        'supportModal', 'verificationNotRequired']) {
        assert.ok(!SERVER.includes(marker), `server.js must not contain ${marker}`);
        assert.ok(!KYC_SERVICE.includes(marker), `KYCService.js must not contain ${marker}`);
    }
});
