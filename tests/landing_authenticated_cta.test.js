'use strict';

/**
 * LANDING-PAGE AUTHENTICATED CTA STATE - regression tests.
 *
 * An authenticated visitor has no use for "Create Account" / "Sign In" (they are
 * already signed in). The landing therefore exposes a single session-dependent UI
 * update, `updateLandingAuthUI(authenticated)` in public/index.html, which:
 *   logged out -> shows Create Account + Sign In, hides the greeting
 *   logged in  -> hides Create Account + Sign In, shows the greeting
 * and NEVER touches "Launch App" (it keeps its purpose: the only landing CTA that
 * enters the dashboard) or the demo CTAs ("Try Demo Mode").
 *
 * The helper is a pure UI setter: `authenticated` is always supplied by the caller
 * from authoritative session knowledge (server-validated startup routing, a session
 * the server just issued on signup/login, or an explicit logout). It never inspects
 * localStorage itself.
 *
 * These tests run the REAL helper in a vm sandbox with a tiny fake DOM, and pin the
 * real call sites (startup routing, signup return, both login flows, logout). No
 * network, no database, no real users. Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function extractFunction(name) {
    const start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist in public/index.html');
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (!depth) return INDEX.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces for ' + name);
}

function slice(from, to) {
    const a = INDEX.indexOf(from);
    assert.ok(a >= 0, 'marker must exist: ' + from);
    const b = INDEX.indexOf(to, a + from.length);
    assert.ok(b > a, 'end marker must follow start: ' + to);
    return INDEX.slice(a, b);
}

// The full logout click handler (same delimitation as tests/logout_scroll_lock.test.js).
const LOGOUT_HANDLER = (() => {
    const start = INDEX.indexOf("const logoutLink = getEl('logoutLink');");
    assert.ok(start >= 0, 'logout binding must exist');
    const end = INDEX.indexOf("document.querySelectorAll('.sidebar-link[data-section]')", start);
    assert.ok(end > start, 'logout handler must be delimited');
    return INDEX.slice(start, end);
})();

// Landing markup regions that carry the Create Account / Sign In actions.
const NAV_CTAS = slice('class="landing-nav-actions"', 'id="landingMobileMenu"');
const MOBILE_CTAS = slice('id="landingMobileMenu"', '</nav>');
const HERO_CTAS = slice('class="landing-hero-cta"', 'class="landing-hero-trust"');
const FINAL_CTAS = slice('class="landing-cta-actions"', 'class="landing-cta-note"');
const AUTH_PAGE = slice('id="authPage"', 'id="mainApp"');

const countTagged = (s) => (s.match(/js-landing-auth-cta/g) || []).length;

// A fake DOM modelling the real landing: one element per tagged CTA, the greeting
// (inline display:none in the markup) and Launch App (never tagged, never touched).
function makeDom(taggedCount) {
    const buttons = [];
    for (let i = 0; i < taggedCount; i++) buttons.push({ style: { display: '' } });
    return {
        buttons,
        greeting: { style: { display: 'none' } },
        launchApp: { style: { display: '' } },
        demoCta: { style: { display: '' } },
        document: {
            querySelectorAll: (sel) => (sel === '.js-landing-auth-cta' ? buttons : []),
            getElementById: (id) => (id === 'landingUserGreeting' ? null : null),
        },
    };
}

// Run the REAL updateLandingAuthUI() against the fake DOM.
function runUpdate(authenticated, dom) {
    const sandbox = {
        document: {
            querySelectorAll: dom.document.querySelectorAll,
            getElementById: (id) => (id === 'landingUserGreeting' ? dom.greeting : null),
        },
        console,
    };
    vm.createContext(sandbox);
    const arg = authenticated === undefined ? '' : JSON.stringify(authenticated);
    vm.runInContext(extractFunction('updateLandingAuthUI') + '\nupdateLandingAuthUI(' + arg + ');', sandbox);
    return dom;
}

// ---------------------------------------------------------------------------
// 1. Tagging: exactly the Create Account / Sign In actions, never Launch App
// ---------------------------------------------------------------------------
test('1a. every landing auth CTA carries the shared hook class (8 in markup)', () => {
    const total = countTagged(NAV_CTAS) + countTagged(MOBILE_CTAS) + countTagged(HERO_CTAS) + countTagged(FINAL_CTAS);
    assert.strictEqual(total, 8, 'nav + mobile menu + hero + final CTA = 2 each');
    [['nav', NAV_CTAS], ['mobile menu', MOBILE_CTAS], ['hero', HERO_CTAS], ['final CTA', FINAL_CTAS]]
        .forEach(([label, block]) => {
            assert.strictEqual(countTagged(block), 2, label + ' must expose exactly two auth CTAs');
            assert.match(block, /js-landing-auth-cta[^>]*>[\s\S]{0,200}openAuthScreen\('signup'\)|openAuthScreen\('signup'\)[\s\S]{0,200}js-landing-auth-cta/,
                label + ' must tag a Create Account action');
            assert.match(block, /js-landing-auth-cta[^>]*>[\s\S]{0,200}openAuthScreen\('signin'\)|openAuthScreen\('signin'\)[\s\S]{0,200}js-landing-auth-cta/,
                label + ' must tag a Sign In action');
        });
});

test('1b. Launch App and the demo CTAs are never tagged', () => {
    const launchNav = slice('class="landing-nav-actions"', 'id="landingMobileMenu"');
    const launchMobile = slice('id="landingMobileMenu"', '</nav>');
    assert.match(launchNav, /goToApp\('nav'\)[\s\S]{0,200}landing\.launchApp/, 'nav Launch App kept');
    assert.match(launchMobile, /goToApp\('nav'\)[\s\S]{0,200}landing\.launchApp/, 'mobile Launch App kept');
    // The Launch App buttons must not carry the hide-me class.
    const launchButtons = [...INDEX.matchAll(/<button[^>]*goToApp\('nav'\)[^>]*>/g)].map((m) => m[0]);
    assert.strictEqual(launchButtons.length, 2, 'exactly two Launch App buttons (nav + mobile)');
    launchButtons.forEach((b) => assert.ok(!b.includes('js-landing-auth-cta'), 'Launch App must stay visible'));
    // Demo CTAs ("Try Demo Mode") are out of scope here and must not be tagged.
    ['hero_demo', 'final_cta'].forEach((src) => {
        const btn = INDEX.match(new RegExp("<button[^>]*goToApp\\('" + src + "'\\)[^>]*>"));
        assert.ok(btn, src + ' demo CTA must exist');
        assert.ok(!btn[0].includes('js-landing-auth-cta'), src + ' demo CTA must not be hidden');
    });
});

test('1c. the helper selects exactly the shared hook class and is a pure UI setter', () => {
    const fn = extractFunction('updateLandingAuthUI');
    assert.match(fn, /querySelectorAll\('\.js-landing-auth-cta'\)/, 'must target the shared class');
    assert.ok(!/localStorage|jwt_token|fetch\(/.test(fn),
        'must not read session storage or the network - the caller supplies the state');
    assert.strictEqual((INDEX.match(/querySelectorAll\('\.js-landing-auth-cta'\)/g) || []).length, 1,
        'one selector, one place that hides/shows the auth CTAs');
});

// ---------------------------------------------------------------------------
// 2/3. Behaviour for each session state
// ---------------------------------------------------------------------------
test('2. logged out: Create Account + Sign In visible, greeting hidden, Launch App visible', () => {
    const dom = runUpdate(false, makeDom(8));
    dom.buttons.forEach((b) => assert.strictEqual(b.style.display, '', 'auth CTA restored'));
    assert.strictEqual(dom.greeting.style.display, 'none', 'greeting hidden when logged out');
    assert.strictEqual(dom.launchApp.style.display, '', 'Launch App untouched');
    assert.strictEqual(dom.demoCta.style.display, '', 'demo CTA untouched');
});

test('3. logged in: Create Account + Sign In hidden, greeting shown, Launch App visible', () => {
    const dom = runUpdate(true, makeDom(8));
    dom.buttons.forEach((b) => assert.strictEqual(b.style.display, 'none', 'auth CTA hidden'));
    assert.strictEqual(dom.greeting.style.display, 'inline-block', 'greeting shown when logged in');
    assert.strictEqual(dom.launchApp.style.display, '', 'Launch App stays visible');
    assert.strictEqual(dom.demoCta.style.display, '', 'demo CTA stays visible');
});

test('3b. the state is reversible in both directions (no one-way lock)', () => {
    const dom = makeDom(8);
    runUpdate(true, dom);
    assert.ok(dom.buttons.every((b) => b.style.display === 'none'), 'hidden after login');
    runUpdate(false, dom);
    assert.ok(dom.buttons.every((b) => b.style.display === ''), 'restored after logout');
    runUpdate(true, dom);
    assert.ok(dom.buttons.every((b) => b.style.display === 'none'), 'hidden again');
});

test('3c. only an explicit true means authenticated; unknown values mean logged out', () => {
    [undefined, null, false, 'true', 1, 0, 'yes', {}].forEach((v) => {
        const dom = runUpdate(v, makeDom(2));
        assert.ok(dom.buttons.every((b) => b.style.display === ''),
            'value ' + JSON.stringify(v) + ' must be treated as logged out');
    });
});

test('3d. a missing greeting element never throws', () => {
    const sandbox = {
        document: { querySelectorAll: () => [], getElementById: () => null },
        console,
    };
    vm.createContext(sandbox);
    assert.doesNotThrow(() => vm.runInContext(
        extractFunction('updateLandingAuthUI') + '\nupdateLandingAuthUI(true);', sandbox));
});

// ---------------------------------------------------------------------------
// 4. Mobile menu follows the same state
// ---------------------------------------------------------------------------
test('4. the mobile menu carries the same two auth CTAs and follows the same state', () => {
    assert.match(MOBILE_CTAS, /js-landing-auth-cta[^>]*openAuthScreen\('signup'\)|openAuthScreen\('signup'\)[^>]*js-landing-auth-cta/,
        'mobile Create Account tagged');
    assert.match(MOBILE_CTAS, /js-landing-auth-cta[^>]*openAuthScreen\('signin'\)|openAuthScreen\('signin'\)[^>]*js-landing-auth-cta/,
        'mobile Sign In tagged');
    // Same selector, same helper -> the mobile buttons follow the desktop state.
    const dom = makeDom(countTagged(MOBILE_CTAS));
    runUpdate(true, dom);
    assert.ok(dom.buttons.every((b) => b.style.display === 'none'), 'mobile auth CTAs hidden when logged in');
    runUpdate(false, dom);
    assert.ok(dom.buttons.every((b) => b.style.display === ''), 'mobile auth CTAs restored when logged out');
});

// ---------------------------------------------------------------------------
// 5. Logout restores the logged-out UI (no stale authenticated state)
// ---------------------------------------------------------------------------
test('5a. logout applies the logged-out landing state', () => {
    assert.match(LOGOUT_HANDLER, /updateLandingAuthUI\(false\);/, 'logout must reset the landing CTA state');
    assert.match(LOGOUT_HANDLER, /localStorage\.removeItem\('jwt_token'\)/, 'logout still clears the session');
});

test('5b. logging in then out leaves the Create Account + Sign In actions visible (real handler state)', () => {
    const dom = makeDom(8);
    runUpdate(true, dom);                                            // session established
    assert.ok(dom.buttons.every((b) => b.style.display === 'none'));
    runUpdate(false, dom);                                           // the exact call logout makes
    assert.ok(dom.buttons.every((b) => b.style.display === ''), 'no stale hidden state after logout');
    assert.strictEqual(dom.greeting.style.display, 'none', 'greeting cleared after logout');
});

test('5c. the earlier logout scroll-lock cleanup is still intact', () => {
    const close = LOGOUT_HANDLER.indexOf('closeMobileNav()');
    const showAuth = LOGOUT_HANDLER.indexOf("getEl('authPage').style.display = 'flex';");
    assert.ok(close >= 0 && showAuth >= 0 && close < showAuth,
        'logout must still release the drawer lock before showing the auth page');
});

// ---------------------------------------------------------------------------
// 6. Startup / session restoration
// ---------------------------------------------------------------------------
test('6a. startup routing applies the logged-out landing state on both entry screens', () => {
    assert.match(extractFunction('showLanding'), /updateLandingAuthUI\(false\);/,
        'the landing screen (anonymous / server-rejected session) shows the auth CTAs');
    assert.match(extractFunction('showAuth'), /updateLandingAuthUI\(false\);/,
        'the auth screen also normalises the landing state');
});

test('6b. a server-rejected or missing session cannot leave a stale authenticated landing', () => {
    const cachedBlock = slice('if (startupUser) {', 'applyAuthEntryIntent();');
    assert.match(cachedBlock, /updateLandingAuthUI\(true\);/,
        'the cached session applies the authenticated state optimistically');
    // ...and startupRouting is authoritative: both of its screens re-apply false.
    assert.match(extractFunction('showLanding'), /updateLandingAuthUI\(false\);/);
    assert.match(extractFunction('showAuth'), /updateLandingAuthUI\(false\);/);
});

// ---------------------------------------------------------------------------
// 7/8. Signup return + login flows
// ---------------------------------------------------------------------------
test('7. a successful signup returning to the landing applies the authenticated state', () => {
    const signupReturn = slice("showAuthSuccess('Account created successfully!", 'showOnboarding(data.user);');
    assert.match(signupReturn, /landingPage'\)\.style\.display = 'block'/,
        'signup still returns the new user to the landing page');
    assert.match(signupReturn, /updateLandingAuthUI\(true\);/,
        'the returned landing must show the authenticated state (Launch App only)');
});

test('8. both login flows apply the authenticated landing state', () => {
    const fn = extractFunction('completeLogin');
    assert.strictEqual((fn.match(/updateLandingAuthUI\(true\);/g) || []).length, 2,
        'the normal and 2FA login flows both set the authenticated state');
    assert.strictEqual((fn.match(/enterAppStartup\(\);/g) || []).length, 2,
        'login still enters the dashboard (unchanged)');
});

// ---------------------------------------------------------------------------
// 9/10. Launch App behaviour (real goToApp)
// ---------------------------------------------------------------------------
function runGoToApp(token) {
    const els = {
        landingPage: { style: { display: 'block' } },
        authPage: { style: { display: 'none' } },
        mainApp: { style: { display: 'none' } },
    };
    let authCalls = 0, initCalls = 0, tracked = [];
    const sb = {
        localStorage: { getItem: (k) => (k === 'jwt_token' ? token : null) },
        document: { getElementById: (id) => els[id] || null },
        openAuthScreen: (m) => { authCalls++; sb.__authMode = m; },
        trackLandingEvent: (n, d) => { tracked.push([n, d]); },
        trackMetaPageView: () => {},
        initApp: () => { initCalls++; },
        console,
    };
    vm.createContext(sb);
    vm.runInContext(extractFunction('goToApp') + '\ngoToApp("nav");', sb);
    return { els, authCalls, initCalls, tracked, mode: sb.__authMode };
}

test('9. Launch App opens the dashboard for an authenticated user', () => {
    const r = runGoToApp('jwt');
    assert.strictEqual(r.authCalls, 0, 'no auth redirect for a session');
    assert.strictEqual(r.els.mainApp.style.display, 'block', 'dashboard shown');
    assert.strictEqual(r.els.landingPage.style.display, 'none', 'landing hidden');
    assert.strictEqual(r.initCalls, 1, 'initApp ran');
    assert.ok(r.tracked.length >= 1, 'Launch App analytics preserved');
});

test('10. Launch App opens signup for a logged-out user', () => {
    const r = runGoToApp(null);
    assert.strictEqual(r.authCalls, 1, 'anonymous Launch App -> auth screen');
    assert.strictEqual(r.mode, 'signup', 'and specifically the Create Account screen');
    assert.strictEqual(r.initCalls, 0, 'dashboard never initialised');
    assert.strictEqual(r.els.mainApp.style.display, 'none', 'dashboard stays hidden');
});

// ---------------------------------------------------------------------------
// 11/12. Auth screen + analytics untouched
// ---------------------------------------------------------------------------
test('11. the auth page\'s own tabs and forms are not affected', () => {
    assert.strictEqual(countTagged(AUTH_PAGE), 0, 'no auth-page element carries the landing hook class');
    assert.match(AUTH_PAGE, /id="signupTab"/, 'auth page tabs unchanged');
    assert.match(AUTH_PAGE, /id="loginTab"/, 'auth page tabs unchanged');
    assert.match(extractFunction('openAuthScreen'), /showSignupForm\(\)|showLoginForm\(\)/,
        'openAuthScreen still switches the auth tabs');
});

test('12. landing CTA analytics are unchanged', () => {
    const openAuth = extractFunction('openAuthScreen');
    assert.match(openAuth, /trackLandingEvent\('auth_cta_click'/, 'auth CTA analytics preserved');
    const goToApp = extractFunction('goToApp');
    assert.match(goToApp, /trackLandingEvent\('hero_cta_click'/, 'Launch App analytics preserved');
    assert.ok(!/updateLandingAuthUI/.test(openAuth + goToApp),
        'the UI helper must not be entangled with the navigation/analytics functions');
});
