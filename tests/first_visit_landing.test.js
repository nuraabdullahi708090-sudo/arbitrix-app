'use strict';

/**
 * STAGE 7 — FIRST-VISIT LANDING ROUTING tests.
 *
 * The public marketing landing is the default first screen for an anonymous
 * visitor. This is a DISPLAY/ROUTING change only:
 *   - no auth logic, API, middleware, database, deposit, withdrawal, trading,
 *     wallet, payment or referral logic is touched;
 *   - the existing ?action= / arbi_auth_entry entry-intent contract, referral
 *     capture and onboarding are preserved;
 *   - the dashboard stays gated (goToApp() only enters it with a session) and a
 *     session the server rejects never exposes private content.
 *
 * Real functions are extracted from public/index.html and run in a vm sandbox
 * with a minimal fake DOM / localStorage / fetch. Nothing here touches the
 * network, the database, real users or real money.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist in public/index.html');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (!depth) return INDEX.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces for ' + name);
}

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx), depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();

function makeEls() {
    return {
        landingPage: { style: { display: 'block' } },
        authPage: { style: { display: 'none' } },
        mainApp: { style: { display: 'none' } },
    };
}

// ---------------------------------------------------------------------------
// 1. First paint
// ---------------------------------------------------------------------------
test('1. first-paint defaults: landing visible, auth + dashboard hidden', () => {
    assert.ok(/<div id="landingPage" style="display:block;/.test(INDEX),
        '#landingPage must be visible on first paint (no auth flash)');
    assert.ok(/<div id="authPage" class="auth-page" style="display:none;">/.test(INDEX),
        '#authPage must be hidden on first paint');
    assert.ok(/<div id="mainApp" style="display:none;">/.test(INDEX),
        '#mainApp must stay hidden by default');
});

// ---------------------------------------------------------------------------
// 2. Landing actions
// ---------------------------------------------------------------------------
test('2a. landing exposes Create Account + Sign In actions in nav, mobile menu, hero and final CTA', () => {
    assert.ok((INDEX.match(/openAuthScreen\('signup'\)/g) || []).length >= 4,
        'Create Account action must appear in the nav, mobile menu, hero and final CTA');
    assert.ok((INDEX.match(/openAuthScreen\('signin'\)/g) || []).length >= 4,
        'Sign In action must appear in the nav, mobile menu, hero and final CTA');
});

test('2b. landing actions reuse existing i18n keys (no new/raw keys)', () => {
    const navStart = INDEX.indexOf('class="landing-nav-actions"');
    const navEnd = INDEX.indexOf('<!-- Hero Section -->');
    const navBlock = INDEX.slice(navStart, navEnd);
    assert.ok(navBlock.includes('openAuthScreen(\'signup\')') && navBlock.includes('openAuthScreen(\'signin\')'),
        'nav must contain both auth actions');
    assert.ok(navBlock.includes('data-i18n="auth.tab.signup"') && navBlock.includes('data-i18n="auth.tab.signin"'),
        'nav auth actions must reuse auth.tab.signup / auth.tab.signin');
    LANGS.forEach((l) => {
        assert.ok(T[l]['auth.tab.signup'], l + ' auth.tab.signup must exist');
        assert.ok(T[l]['auth.tab.signin'], l + ' auth.tab.signin must exist');
    });
});

test('2c. openAuthScreen(): signup -> signup tab, signin -> login tab (real function)', () => {
    const src = extractFunction('openAuthScreen');
    const els = makeEls();
    let login = 0, signup = 0, tracked = [];
    const sb = {
        document: { getElementById: (id) => els[id] || null },
        showLoginForm: () => { login++; },
        showSignupForm: () => { signup++; },
        trackLandingEvent: (n, d) => { tracked.push([n, d]); },
        window: { scrollTo: () => {} },
        console,
    };
    vm.createContext(sb);
    vm.runInContext(src + '\nopenAuthScreen("signup");', sb);
    assert.strictEqual(els.landingPage.style.display, 'none', 'landing hidden');
    assert.strictEqual(els.authPage.style.display, 'flex', 'auth shown');
    assert.strictEqual(els.mainApp.style.display, 'none', 'dashboard hidden');
    assert.strictEqual(signup, 1, 'signup tab activated');
    assert.strictEqual(login, 0, 'login tab not activated');

    vm.runInContext('openAuthScreen("signin");', sb);
    assert.strictEqual(login, 1, 'login tab activated for Sign In');
    assert.strictEqual(els.authPage.style.display, 'flex', 'auth still shown');
    assert.ok(tracked.length >= 1, 'landing CTA analytics preserved');
});

// ---------------------------------------------------------------------------
// 3. Dashboard gate
// ---------------------------------------------------------------------------
test('3a. goToApp() sends an anonymous visitor to the auth screen (no dashboard)', () => {
    const src = extractFunction('goToApp');
    const els = makeEls();
    let authCalls = 0, initCalls = 0;
    const sb = {
        localStorage: { getItem: () => null },
        document: { getElementById: (id) => els[id] || null },
        openAuthScreen: () => { authCalls++; },
        trackLandingEvent: () => {},
        trackMetaPageView: () => {},
        initApp: () => { initCalls++; },
        console,
    };
    vm.createContext(sb);
    vm.runInContext(src + '\ngoToApp("nav");', sb);
    assert.strictEqual(authCalls, 1, 'anonymous -> auth screen');
    assert.strictEqual(initCalls, 0, 'dashboard must not initialize');
    assert.strictEqual(els.mainApp.style.display, 'none', 'dashboard stays hidden');
});

test('3b. goToApp() enters the dashboard when a session token exists', () => {
    const src = extractFunction('goToApp');
    const els = makeEls();
    let authCalls = 0, initCalls = 0, tracked = 0;
    const sb = {
        localStorage: { getItem: (k) => (k === 'jwt_token' ? 'jwt' : null) },
        document: { getElementById: (id) => els[id] || null },
        openAuthScreen: () => { authCalls++; },
        trackLandingEvent: () => { tracked++; },
        trackMetaPageView: () => {},
        initApp: () => { initCalls++; },
        console,
    };
    vm.createContext(sb);
    vm.runInContext(src + '\ngoToApp("nav");', sb);
    assert.strictEqual(authCalls, 0, 'session -> no auth redirect');
    assert.strictEqual(els.mainApp.style.display, 'block', 'dashboard shown');
    assert.strictEqual(initCalls, 1, 'initApp ran');
    assert.ok(tracked >= 1, 'landing CTA analytics preserved');
});

test('3c. enterAppStartup() shows the dashboard and runs initApp (real function)', () => {
    const src = extractFunction('enterAppStartup');
    const els = makeEls();
    let initCalls = 0;
    const sb = {
        document: { getElementById: (id) => els[id] || null },
        initApp: () => { initCalls++; },
        console,
    };
    vm.createContext(sb);
    vm.runInContext(src + '\nenterAppStartup();', sb);
    assert.strictEqual(els.landingPage.style.display, 'none', 'landing hidden');
    assert.strictEqual(els.mainApp.style.display, 'block', 'dashboard shown');
    assert.strictEqual(initCalls, 1, 'initApp ran once');
});

// ---------------------------------------------------------------------------
// 4. Startup routing + session validation
// ---------------------------------------------------------------------------
test('4a. startup block declares the three explicit states and validates via /api/auth/me', () => {
    const start = INDEX.indexOf('// ============ STARTUP ============');
    const block = INDEX.slice(start, start + 6000);
    assert.ok(block.includes('/api/auth/me'), 'startup must validate with the existing endpoint');
    assert.ok(block.includes("sessionStorage.getItem('arbi_auth_entry')"), 'entry-intent contract preserved');
    assert.ok(block.includes('/[?&]action=(create-account|sign-in)/'), '?action= contract preserved');
    assert.ok(block.includes('applyAuthEntryIntent();'), 'entry intent still applied (tab + referral capture)');
    assert.ok(block.includes('enterAppStartup();'), 'valid session enters the dashboard');
    assert.ok(block.includes('showLanding();'), 'anonymous / rejected sessions show the landing');
    assert.ok(block.includes('if (startupEntryIntent && !startupToken) { showAuth(); return; }'),
        'explicit entry intent with no session shows the auth page');
    assert.ok(block.includes("localStorage.removeItem('jwt_token')"),
        'a server-rejected token is cleared (no private content)');
    assert.ok(block.includes("localStorage.removeItem('arbi_user')"),
        'stale cached user is cleared');
});

test('4b. validateStartupSession(): true / false(401,403) / unknown(offline,5xx) (real function)', async () => {
    const src = extractFunction('validateStartupSession');
    async function run(fetchImpl) {
        const sb = { fetch: fetchImpl, Promise, setTimeout, clearTimeout, AbortController, console };
        vm.createContext(sb);
        vm.runInContext(src + '\nglobalThis.__v = validateStartupSession("jwt");', sb);
        return sb.__v;
    }
    assert.strictEqual(await run(() => Promise.resolve({ ok: true, status: 200 })), true);
    assert.strictEqual(await run(() => Promise.resolve({ ok: false, status: 401 })), false);
    assert.strictEqual(await run(() => Promise.resolve({ ok: false, status: 403 })), false);
    assert.strictEqual(await run(() => Promise.resolve({ ok: false, status: 500 })), 'unknown');
    assert.strictEqual(await run(() => Promise.reject(new Error('offline'))), 'unknown');
});

test('4c. cached session handling only trusts token presence, not arbi_user alone', () => {
    const start = INDEX.indexOf('// ============ STARTUP ============');
    const block = INDEX.slice(start, start + 6000);
    assert.ok(/if \(!startupToken && startupUser\) \{[\s\S]*?localStorage\.removeItem\('arbi_user'\)/.test(block),
        'a cached user with no token is treated as anonymous (stale cleared)');
    assert.ok(block.includes('if (startupToken) {'), 'token presence drives the session check');
});

// ---------------------------------------------------------------------------
// 5. Contracts preserved
// ---------------------------------------------------------------------------
test('5a. entry-intent / referral contract is intact', () => {
    const entry = extractFunction('applyAuthEntryIntent');
    assert.ok(/sessionStorage\.setItem\('arbi_auth_entry'/.test(entry), 'entry intent still persisted');
    assert.ok(/populateReferralFromURL\(\)/.test(entry), 'referral capture still runs on entry');
    assert.ok(/showLoginForm\(\)/.test(entry) && /showSignupForm\(\)/.test(entry), 'tab selection unchanged');
});

test('5b. server.js untouched: no /login or /signup routes, "/" still serves index.html', () => {
    assert.ok(!/app\.get\(['"]\/login['"]/.test(SERVER), 'no /login route added');
    assert.ok(!/app\.get\(['"]\/signup['"]/.test(SERVER), 'no /signup route added');
    assert.ok(/app\.get\('\/', \(req, res\) => \{[\s\S]*?sendFile\(path\.join\(__dirname, 'public', 'index\.html'\)\)/.test(SERVER),
        'root still serves index.html');
});

test('5c. i18n dictionary size is pinned (1403 keys/locale)', () => {
    LANGS.forEach((l) => {
        assert.ok(T[l], 'locale ' + l + ' must exist');
        assert.strictEqual(Object.keys(T[l]).length, 1403, l + ' must still have 1403 keys');
    });
});

// ---------------------------------------------------------------------------
// 6. Login enters the dashboard
// ---------------------------------------------------------------------------
test('6. successful login (normal + 2FA) enters the dashboard, not the landing', () => {
    const fn = extractFunction('completeLogin');
    assert.strictEqual((fn.match(/enterAppStartup\(\);/g) || []).length, 2,
        'both the normal and 2FA login flows must enter the dashboard');
    assert.ok(!/landingPage\)?\.style\.display = 'block'/.test(fn),
        'login must not show the marketing landing as the post-login screen');
});

test('5d. no landing auth action references a missing translation key', () => {
    const navStart = INDEX.indexOf('class="landing-nav-actions"');
    const navEnd = INDEX.indexOf('<!-- Hero Section -->');
    const finalStart = INDEX.indexOf('class="landing-cta-actions"');
    const finalEnd = INDEX.indexOf('<!-- Footer -->');
    const slice = INDEX.slice(navStart, navEnd) + INDEX.slice(finalStart, finalEnd);
    const keys = [...slice.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(keys.length > 0, 'auth actions must carry data-i18n keys');
    LANGS.forEach((l) => {
        keys.forEach((k) => {
            assert.ok(T[l][k], 'locale ' + l + ' missing key ' + k);
        });
    });
});
