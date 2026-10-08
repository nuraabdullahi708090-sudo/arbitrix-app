'use strict';

/**
 * PartnerLead — dedicated Meta conversion event for the referral-partner funnel.
 *
 * Context: the Meta partner-recruitment campaign is configured for a `Lead`
 * event that does NOT exist in this repository. The customer funnel uses
 * CompleteRegistration + LiveAccountActivated, which must stay untouched.
 * This suite pins the dedicated, additive partner signal:
 *
 *   1. /partners sets a QUERY-INDEPENDENT marker (arbi_partner_entry = '1') so
 *      UTM/click-id parameters cannot strip the attribution;
 *   2. a partner-attributed signup fires CompleteRegistration AND PartnerLead;
 *   3. an ordinary customer signup fires CompleteRegistration but NOT PartnerLead;
 *   4. every existing Meta event is unchanged;
 *   5. the existing safety behaviour is preserved (consent gate, PRODUCTION-only,
 *      MARKETING_SANDBOX exclusion, single pixel, no CAPI, no PII).
 *
 * Run: npm test (this file only: node --test tests/partner_lead_event.test.js)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PARTNERS = fs.readFileSync(path.join(ROOT, 'public', 'partners.html'), 'utf8');

const MARKER_KEY = 'arbi_partner_entry';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function sliceBetween(text, startMarker, endMarker) {
    const s = text.indexOf(startMarker);
    assert.ok(s !== -1, 'start marker not found: ' + startMarker);
    const from = s + startMarker.length;
    const e = text.indexOf(endMarker, from);
    assert.ok(e !== -1, 'end marker not found: ' + endMarker);
    return text.slice(from, e);
}

// Extract a whole top-level function declaration (8-space indented closing brace).
function funcSrc(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start !== -1, 'function not found: ' + name);
    const end = src.indexOf('\n        }', start);
    assert.ok(end !== -1, 'closing brace not found for: ' + name);
    return src.slice(start, end + '\n        }'.length);
}

function makeStorage(initial) {
    const m = Object.assign({}, initial || {});
    return {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
        setItem: (k, v) => { m[k] = String(v); },
        removeItem: (k) => { delete m[k]; },
        dump: () => Object.assign({}, m),
    };
}

// The REAL signup Meta block: the CompleteRegistration emission plus the
// dedicated partner-funnel block, extracted verbatim from handleSignup().
const SIGNUP_META_BLOCK = sliceBetween(
    INDEX,
    'Meta Pixel: fire only after the account was actually created server-side',
    '// ---- /Partner-funnel conversion ----'
) + '// ---- /Partner-funnel conversion ----';

// The REAL marker constants, extracted verbatim from index.html.
const PARTNER_VAR_LINES = (INDEX.match(/var PARTNER_ENTRY_(?:KEY|TTL_MS) = [^\n]*/g) || []).join('\n');

// Run the REAL helper sources + the REAL signup block against fake storages
// and a capturing fbq. Only the browser primitives are faked; the gate logic
// under test is the shipped code.
const HELPERS_SRC = [
    PARTNER_VAR_LINES,
    funcSrc(INDEX, '__metaConsented'),
    funcSrc(INDEX, '__metaProduction'),
    funcSrc(INDEX, 'trackMetaConversion'),
    funcSrc(INDEX, 'isPartnerFunnelEntry'),
    funcSrc(INDEX, 'clearPartnerFunnelEntry'),
].join('\n');

function runSignupMeta(opts) {
    opts = opts || {};
    let calls = [];
    const sessionStorage = makeStorage(opts.session);
    // Consent defaults to deny in the shipped code; grant it here unless a test
    // explicitly overrides it (the consent test passes meta_consent: '0').
    const localStorage = makeStorage(Object.assign({ meta_consent: '1' }, opts.local || {}));
    const replaced = [];
    const sandbox = {
        console: { log: () => {}, warn: () => {}, error: () => {} },
        sessionStorage: sessionStorage,
        localStorage: localStorage,
        APP: opts.app,
        URL: URL,                             // browser primitive; not a vm-context global
    };
    sandbox.window = sandbox;                 // real code reads window.fbq / window.location
    sandbox.location = opts.location || { search: '', href: 'https://arbitrix.pro/', pathname: '/', hash: '' };
    sandbox.history = { replaceState: (a, b, url) => { replaced.push(url); } };
    sandbox.fbq = (...args) => calls.push(args);
    sandbox._fbPixelInited = opts.inited === false ? false : true;
    vm.createContext(sandbox);
    vm.runInContext(HELPERS_SRC, sandbox);
    // Measured BEFORE any signup runs, so it reflects the entry state.
    const helperValue = (typeof sandbox.isPartnerFunnelEntry === 'function') ? sandbox.isPartnerFunnelEntry() : null;
    const perRun = [];
    // Default: one signup run (opt out with runs: 0 for pure helper-signal tests).
    const runCount = (opts.runs === 0) ? 0 : (opts.runs || 1);
    for (let i = 0; i < runCount; i++) {
        calls = [];
        vm.runInContext(SIGNUP_META_BLOCK, sandbox);
        perRun.push(calls.map((a) => a[1]));
    }
    return {
        perRun: perRun,
        events: perRun[0] || [],
        session: sessionStorage,
        localStorage: localStorage,
        replaced: replaced,
        helperValue: helperValue,
    };
}

// ===========================================================================
// 1. PARTNER ATTRIBUTION (public/partners.html)
// ===========================================================================
test('partners.html: sets the dedicated query-independent partner marker', () => {
    assert.match(PARTNERS, /sessionStorage\.setItem\('arbi_partner_entry',\s*'1'\)/,
        'partners.html must set arbi_partner_entry = "1"');
});

test('partners.html: writes BOTH the session marker and a timestamped localStorage marker (query-independent)', () => {
    const lines = PARTNERS.split('\n').filter((l) => l.indexOf("setItem('arbi_partner_entry'") !== -1);
    assert.strictEqual(lines.length, 2, 'a sessionStorage AND a localStorage write are expected');
    assert.ok(lines.some((l) => /sessionStorage\.setItem\('arbi_partner_entry',\s*'1'\)/.test(l)),
        'the existing sessionStorage marker must be preserved verbatim');
    assert.ok(lines.some((l) => /localStorage\.setItem\('arbi_partner_entry',\s*String\(Date\.now\(\)\)\)/.test(l)),
        'a timestamped localStorage fallback is required for cross-tab attribution');
    lines.forEach((l) => {
        assert.ok(!/location\.search/.test(l), 'marker writes must be query-independent: ' + l.trim());
        assert.ok(!/location\.href/.test(l), 'marker writes must not depend on the full URL: ' + l.trim());
    });
});

test('partners.html: all three Apply CTAs carry src=partners (survives tab boundaries without storage)', () => {
    const ctas = PARTNERS.match(/href="\/\?action=create-account[^"]*"/g) || [];
    assert.strictEqual(ctas.length, 3, 'topbar + hero + bottom Apply CTAs');
    ctas.forEach((h) => assert.match(h, /[?&]src=partners"/, 'each Apply CTA must carry src=partners: ' + h));
    assert.ok(!/action=sign-in[^"]*src=partners/.test(PARTNERS), 'the Sign In deep link must not be changed');
});

test('partners.html: the legacy arbi_auth_entry behaviour is preserved verbatim', () => {
    assert.ok(
        PARTNERS.includes("sessionStorage.setItem('arbi_auth_entry', window.location.search || '/partners')"),
        'the existing auth-tab deep-link contract must be unchanged'
    );
});

test('functional: merely LOADING /partners arms NO attribution (auth entry only)', () => {
    // Run the REAL attribution statements from partners.html with an ad-style URL.
    const at = PARTNERS.indexOf("try { sessionStorage.setItem('arbi_auth_entry'");
    assert.ok(at !== -1, 'the auth-entry statement must exist');
    const block = PARTNERS.slice(at, PARTNERS.indexOf('applyTranslations();', at));
    const sessionStorage = makeStorage();
    const localStorage = makeStorage();
    const sandbox = {
        console: { log: () => {}, error: () => {} },
        sessionStorage: sessionStorage,
        localStorage: localStorage,
        window: { location: { search: '?utm_source=facebook&utm_campaign=partners&fbclid=abc123' } },
        document: { querySelectorAll: () => [] },   // pure page-load harness: no CTA click
    };
    vm.createContext(sandbox);
    vm.runInContext(block, sandbox);
    const dump = sessionStorage.dump();
    assert.strictEqual(dump[MARKER_KEY], undefined,
        'merely visiting /partners must NOT arm the session marker');
    assert.strictEqual(localStorage.dump()[MARKER_KEY], undefined,
        'merely visiting /partners must NOT arm the localStorage marker');
    assert.strictEqual(dump['arbi_auth_entry'], '?utm_source=facebook&utm_campaign=partners&fbclid=abc123',
        'legacy auth-entry behaviour is unchanged (stores the query string)');
    assert.ok(!dump['arbi_auth_entry'].includes('/partners'),
        'documents the defect being fixed: the legacy value loses the /partners signal under UTM');
});

test('functional: clicking an Apply CTA arms BOTH markers synchronously (before navigation)', () => {
    const from = PARTNERS.indexOf('function markPartnerEntry()');
    assert.ok(from !== -1, 'markPartnerEntry must exist');
    const src = PARTNERS.slice(from, PARTNERS.indexOf('applyTranslations();', from));
    const sessionStorage = makeStorage();
    const localStorage = makeStorage();
    const bound = [];
    const mkEl = () => ({ addEventListener: (t, fn) => { if (t === 'click') bound.push(fn); } });
    const sandbox = {
        console: { log: () => {}, error: () => {} },
        sessionStorage: sessionStorage,
        localStorage: localStorage,
        document: { querySelectorAll: (sel) => (sel === '.js-apply-cta' ? [mkEl(), mkEl(), mkEl()] : []) },
        window: { location: { search: '' } },
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    assert.strictEqual(bound.length, 3, 'all three Apply CTAs must be bound to the click handler');
    assert.strictEqual(sessionStorage.dump()[MARKER_KEY], undefined, 'nothing is armed before the click');
    assert.strictEqual(localStorage.dump()[MARKER_KEY], undefined, 'nothing is armed before the click');
    bound[0]();   // simulate the user clicking Apply
    assert.strictEqual(sessionStorage.dump()[MARKER_KEY], '1', 'the click arms the session marker');
    const ts = Number(localStorage.dump()[MARKER_KEY]);
    assert.ok(Number.isFinite(ts) && ts > 0, 'the click arms the timestamped localStorage marker');
    assert.ok(Math.abs(Date.now() - ts) < 60 * 1000, 'the timestamp must be the current time');
});

test('partners.html: every marker write lives inside the Apply-click handler (never at page load)', () => {
    const from = PARTNERS.indexOf('function markPartnerEntry()');
    assert.ok(from !== -1, 'markPartnerEntry must exist');
    const fnBody = PARTNERS.slice(from, PARTNERS.indexOf('\n        }', from));
    const writes = PARTNERS.split('\n').filter((l) => l.indexOf("setItem('arbi_partner_entry'") !== -1);
    assert.strictEqual(writes.length, 2, 'exactly two marker writes (session + localStorage)');
    writes.forEach((l) => assert.ok(fnBody.indexOf(l.trim()) !== -1,
        'every arbi_partner_entry write must be inside markPartnerEntry(): ' + l.trim()));
    assert.match(PARTNERS, /querySelectorAll\('\.js-apply-cta'\)/, 'the handler must target the Apply CTAs');
    assert.match(PARTNERS, /addEventListener\('click', markPartnerEntry\)/, 'the binding must be a click handler');
});

// ===========================================================================
// 2. PARTNER-ATTRIBUTED SIGNUP -> CompleteRegistration AND PartnerLead
// ===========================================================================
test('index.html: PartnerLead is fired after CompleteRegistration inside handleSignup', () => {
    const signupStart = INDEX.indexOf('async function handleSignup()');
    const blockAt = INDEX.indexOf(SIGNUP_META_BLOCK);
    assert.ok(signupStart !== -1 && blockAt > signupStart, 'the block must live inside handleSignup');
    const cr = SIGNUP_META_BLOCK.indexOf("trackMetaConversion('CompleteRegistration')");
    const pl = SIGNUP_META_BLOCK.indexOf("trackMetaConversion('PartnerLead')");
    assert.ok(cr !== -1, 'CompleteRegistration must still be emitted');

    assert.ok(pl !== -1, 'PartnerLead must be emitted');
    assert.ok(cr < pl, 'PartnerLead must be fired AFTER CompleteRegistration');
});

test('index.html: PartnerLead is gated on the partner-funnel marker', () => {
    assert.match(SIGNUP_META_BLOCK,
        /if \(typeof isPartnerFunnelEntry === 'function' && isPartnerFunnelEntry\(\)\) \{[\s\S]*PartnerLead/,
        'PartnerLead must be guarded by isPartnerFunnelEntry()');
    assert.match(SIGNUP_META_BLOCK, /clearPartnerFunnelEntry\(\)/,
        'the marker must be consumed (one-shot) so it cannot leak into a later signup');
});

test('index.html: the helpers keep the sessionStorage semantics and add a 1h localStorage + URL signal', () => {
    const helper = funcSrc(INDEX, 'isPartnerFunnelEntry');
    assert.ok(INDEX.includes("var PARTNER_ENTRY_KEY = '" + MARKER_KEY + "';"), 'single key constant');
    assert.match(helper, /sessionStorage\.getItem\(PARTNER_ENTRY_KEY\) === '1'/,
        'the existing sessionStorage semantics are preserved verbatim');
    assert.match(helper, /catch \(e\) \{ return false; \}/, 'a failure elsewhere must fail closed');
    assert.match(helper, /Number\(localStorage\.getItem\(PARTNER_ENTRY_KEY\)\)/, 'localStorage fallback');
    assert.match(helper, /PARTNER_ENTRY_TTL_MS/, 'the localStorage fallback must be TTL-bounded');
    assert.match(helper, /src=partners/, 'the URL signal must be accepted');
    assert.match(INDEX, /var PARTNER_ENTRY_TTL_MS = 60 \* 60 \* 1000;/, 'the TTL must be exactly 1 hour');
    const clear = funcSrc(INDEX, 'clearPartnerFunnelEntry');
    assert.match(clear, /sessionStorage\.removeItem\(PARTNER_ENTRY_KEY\)/, 'one-shot sessionStorage clear preserved');
    assert.match(clear, /localStorage\.removeItem\(PARTNER_ENTRY_KEY\)/, 'one-shot localStorage clear');
    assert.match(clear, /searchParams\.delete\('src'\)/, 'the URL signal must be consumed');
    assert.ok(INDEX.includes('window.isPartnerFunnelEntry = isPartnerFunnelEntry;'), 'exported for parity');
    assert.ok(INDEX.includes('window.clearPartnerFunnelEntry = clearPartnerFunnelEntry;'), 'exported for parity');
});

test('functional: partner-attributed signup fires CompleteRegistration AND PartnerLead (and consumes the marker)', () => {
    const r = runSignupMeta({ session: { [MARKER_KEY]: '1' }, app: { environment: 'PRODUCTION' } });
    assert.deepStrictEqual(r.events, ['CompleteRegistration', 'PartnerLead']);
    assert.strictEqual(r.session.dump()[MARKER_KEY], undefined, 'the marker must be cleared after use');
});

test('functional: an ordinary customer signup fires CompleteRegistration but NOT PartnerLead', () => {
    const r = runSignupMeta({ session: {}, app: { environment: 'PRODUCTION' } });
    assert.deepStrictEqual(r.events, ['CompleteRegistration']);
});

test('functional: a non-"1" marker value is not treated as a partner entry', () => {
    for (const v of ['0', '', 'true', 'yes', '2']) {
        const r = runSignupMeta({ session: { [MARKER_KEY]: v }, app: { environment: 'PRODUCTION' } });
        assert.deepStrictEqual(r.events, ['CompleteRegistration'], 'value ' + JSON.stringify(v) + ' must not fire PartnerLead');
    }
});

// ---------------------------------------------------------------------------
// 2b. CROSS-TAB / STORAGE-INDEPENDENT ATTRIBUTION (the missing-PartnerLead fix)
// ---------------------------------------------------------------------------
test('functional: a fresh (<1h) localStorage marker is accepted (cross-tab attribution)', () => {
    const r = runSignupMeta({ runs: 0, session: {}, local: { [MARKER_KEY]: String(Date.now() - 5 * 60 * 1000) } });
    assert.strictEqual(r.helperValue, true, 'a partner visit minutes ago must attribute a signup in another tab');
});

test('functional: a localStorage marker older than 1 hour is NOT accepted', () => {
    const r = runSignupMeta({ runs: 0, session: {}, local: { [MARKER_KEY]: String(Date.now() - 61 * 60 * 1000) } });
    assert.strictEqual(r.helperValue, false, 'a stale partner visit must never attribute a later customer signup');
});

test('functional: the 1-hour TTL boundary is exclusive', () => {
    const inside = runSignupMeta({ runs: 0, session: {}, local: { [MARKER_KEY]: String(Date.now() - 59 * 60 * 1000) } });
    const outside = runSignupMeta({ runs: 0, session: {}, local: { [MARKER_KEY]: String(Date.now() - 60 * 60 * 1000 - 1000) } });
    assert.strictEqual(inside.helperValue, true, '59 minutes is inside the window');
    assert.strictEqual(outside.helperValue, false, '60min+1s is outside the window');
});

test('functional: a junk / empty / zero localStorage value is not a partner signal', () => {
    for (const v of ['', 'null', 'abc', '0', 'NaN', 'undefined', '-1']) {
        const r = runSignupMeta({ runs: 0, session: {}, local: { [MARKER_KEY]: v } });
        assert.strictEqual(r.helperValue, false, JSON.stringify(v) + ' must not attribute');
    }
});

test('functional: ?src=partners in the URL is accepted (works without any storage)', () => {
    const r = runSignupMeta({
        runs: 0, session: {}, local: {},
        location: { search: '?action=create-account&src=partners', href: 'https://arbitrix.pro/?action=create-account&src=partners', pathname: '/', hash: '' },
    });
    assert.strictEqual(r.helperValue, true);
});

test('functional: other / malformed src values are not partner signals', () => {
    for (const s of ['', '?action=create-account', '?src=other', '?src=partners-x', '?xsrc=partners', '?other=1']) {
        const r = runSignupMeta({
            runs: 0, session: {}, local: {},
            location: { search: s, href: 'https://arbitrix.pro/' + s, pathname: '/', hash: '' },
        });
        assert.strictEqual(r.helperValue, false, JSON.stringify(s) + ' must not attribute');
    }
});

test('functional: the sessionStorage marker is unchanged (wins on its own)', () => {
    const r = runSignupMeta({ runs: 0, session: { [MARKER_KEY]: '1' }, local: {} });
    assert.strictEqual(r.helperValue, true);
});

test('functional: a partner signup attributed ONLY by the localStorage fallback fires both events and consumes it', () => {
    const r = runSignupMeta({ session: {}, local: { [MARKER_KEY]: String(Date.now() - 60 * 1000) } });
    assert.deepStrictEqual(r.events, ['CompleteRegistration', 'PartnerLead']);
    assert.strictEqual(r.localStorage.dump()[MARKER_KEY], undefined, 'the localStorage marker must be consumed');
});

test('functional: a partner signup attributed ONLY by ?src=partners fires both events and strips the URL signal', () => {
    const r = runSignupMeta({
        session: {}, local: {},
        location: { search: '?action=create-account&src=partners', href: 'https://arbitrix.pro/?action=create-account&src=partners', pathname: '/', hash: '' },
    });
    assert.deepStrictEqual(r.events, ['CompleteRegistration', 'PartnerLead']);
    assert.strictEqual(r.replaced.length, 1, 'the URL signal must be consumed exactly once');
    assert.ok(!/src=partners/.test(r.replaced[0]), 'the consumed URL must no longer carry src=partners');
    assert.match(r.replaced[0], /action=create-account/, 'other query parameters must be preserved');
});

test('functional: a normal customer signup with an EXPIRED partner visit stays CompleteRegistration-only', () => {
    const r = runSignupMeta({ session: {}, local: { [MARKER_KEY]: String(Date.now() - 2 * 60 * 60 * 1000) } });
    assert.deepStrictEqual(r.events, ['CompleteRegistration'], 'an old partner visit must not create a partner lead');
});

test('functional: attribution is ONE-SHOT - a second signup in the same session emits no PartnerLead', () => {
    const r = runSignupMeta({ runs: 2, session: { [MARKER_KEY]: '1' } });
    assert.deepStrictEqual(r.perRun[0], ['CompleteRegistration', 'PartnerLead']);
    assert.deepStrictEqual(r.perRun[1], ['CompleteRegistration'], 'the consumed marker must not fire twice');
});

// ===========================================================================
// 3. SAFETY GATES PRESERVED (consent + PRODUCTION-only + sandbox exclusion)
// ===========================================================================
test('functional: MARKETING_SANDBOX suppresses PartnerLead (and every Meta event)', () => {
    const r = runSignupMeta({ session: { [MARKER_KEY]: '1' }, app: { environment: 'MARKETING_SANDBOX' } });
    assert.deepStrictEqual(r.events, [], 'sandbox accounts must emit nothing');
});

test('functional: the cached-sandbox fallback also suppresses PartnerLead', () => {
    const r = runSignupMeta({
        session: { [MARKER_KEY]: '1' },
        app: undefined,                                                     // APP not adopted yet
        local: { arbi_user: JSON.stringify({ environment: 'MARKETING_SANDBOX' }) },
    });
    assert.deepStrictEqual(r.events, []);
});

test('functional: consent is required for PartnerLead', () => {
    const r = runSignupMeta({ session: { [MARKER_KEY]: '1' }, local: { meta_consent: '0' }, app: { environment: 'PRODUCTION' } });
    assert.deepStrictEqual(r.events, [], 'no consent => no events');
});

test('functional: an uninitialised pixel emits nothing', () => {
    const r = runSignupMeta({ session: { [MARKER_KEY]: '1' }, inited: false, app: { environment: 'PRODUCTION' } });
    assert.deepStrictEqual(r.events, []);
});

test('PartnerLead goes through the shared gate helper, never straight to fbq()', () => {
    assert.ok(!/fbq\('track',\s*'PartnerLead'/.test(INDEX),
        'PartnerLead must not be emitted by calling fbq directly');
    assert.match(SIGNUP_META_BLOCK, /trackMetaConversion\('PartnerLead'\)/);
});

// ===========================================================================
// 4. EXISTING META SURFACE UNCHANGED
// ===========================================================================
test('the existing Meta events and their call sites are unchanged', () => {
    const events = {
        CompleteRegistration: 1,
        Login: 1,
        ViewContent: 3,
        StartDemo: 2,
        LiveAccountActivated: 1,
    };
    for (const [name, expected] of Object.entries(events)) {
        const n = (INDEX.match(new RegExp("trackMetaConversion\\('" + name + "'\\)", 'g')) || []).length;
        assert.strictEqual(n, expected, name + ' call sites changed');
    }
    assert.ok(INDEX.includes("fbq('track', 'PageView')"), 'PageView init path intact');
    assert.ok(INDEX.includes('trackMetaPageView()'), 'PageView SPA path intact');
    assert.ok(INDEX.includes('function trackMetaInit()'), 'init helper intact');
});

test('exactly one pixel, one ID, one loader — no second pixel added', () => {
    const inits = INDEX.match(/fbq\('init'/g) || [];
    assert.strictEqual(inits.length, 1, 'exactly one fbq init');
    assert.ok(INDEX.includes("fbq('init', '2122253382062919')"), 'the existing pixel ID is unchanged');
    const loaders = INDEX.match(/connect\.facebook\.net\/en_US\/fbevents\.js/g) || [];
    assert.strictEqual(loaders.length, 2, 'the single loader definition (startup + late-load path) is unchanged');
    assert.ok(!/fbq\('init',\s*'[0-9]+'\)/.test(INDEX.replace("fbq('init', '2122253382062919')", '')), 'no additional pixel ID');
});

test('no Meta Conversions API / server-side tracking was added', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    for (const src of [INDEX, server, PARTNERS]) {
        assert.ok(!/graph\.facebook\.com/.test(src), 'no Graph API call');
        assert.ok(!/_fbp|_fbc/.test(src), 'no fbp/fbc cookie plumbing');
        assert.ok(!/META_ACCESS_TOKEN|META_PIXEL_ID|DATASET_ID/.test(src), 'no CAPI credentials');
    }
});

test('LiveAccountActivated is untouched (helper, server claim, and its 3 transitions)', () => {
    assert.ok(INDEX.includes('async function fireLiveAccountActivatedIfFirst()'), 'helper intact');
    assert.ok(INDEX.includes("trackMetaConversion('LiveAccountActivated')"), 'event intact');
    assert.ok(INDEX.includes('/api/tracking/claim-live-activated'), 'server claim intact');
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(server.includes("app.get('/api/tracking/claim-live-activated', authMiddleware"), 'claim route intact');
    const callers = (INDEX.match(/window\.fireLiveAccountActivatedIfFirst\(\)/g) || []).length;
    assert.strictEqual(callers, 3, 'the three funded-flag transitions are unchanged');
});

test('no server claim ledger / migration was added for PartnerLead', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(!/PartnerLead/.test(server), 'server.js must not reference PartnerLead in this task');
    const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'));
    assert.ok(!migrations.some((f) => /038/.test(f)), 'no new migration for this task');
});
