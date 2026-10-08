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

// Run the REAL helper sources + the REAL signup block against fake storages
// and a capturing fbq. Only the browser primitives are faked; the gate logic
// under test is the shipped code.
function runSignupMeta(opts) {
    opts = opts || {};
    const calls = [];
    const sessionStorage = makeStorage(opts.session);
    // Consent defaults to deny in the shipped code; grant it here unless a test
    // explicitly overrides it (the consent test passes meta_consent: '0').
    const localStorage = makeStorage(Object.assign({ meta_consent: '1' }, opts.local || {}));
    const sandbox = {
        console: { log: () => {}, warn: () => {}, error: () => {} },
        sessionStorage: sessionStorage,
        localStorage: localStorage,
        APP: opts.app,
    };
    sandbox.window = sandbox;                 // real code reads window.fbq
    sandbox.fbq = (...args) => calls.push(args);
    sandbox._fbPixelInited = opts.inited === false ? false : true;
    vm.createContext(sandbox);
    const src = [
        "var PARTNER_ENTRY_KEY = '" + MARKER_KEY + "';",
        funcSrc(INDEX, '__metaConsented'),
        funcSrc(INDEX, '__metaProduction'),
        funcSrc(INDEX, 'trackMetaConversion'),
        funcSrc(INDEX, 'isPartnerFunnelEntry'),
        funcSrc(INDEX, 'clearPartnerFunnelEntry'),
        SIGNUP_META_BLOCK,
    ].join('\n');
    vm.runInContext(src, sandbox);
    return { events: calls.map((a) => a[1]), calls: calls, session: sessionStorage, localStorage: localStorage };
}

// ===========================================================================
// 1. PARTNER ATTRIBUTION (public/partners.html)
// ===========================================================================
test('partners.html: sets the dedicated query-independent partner marker', () => {
    assert.match(PARTNERS, /sessionStorage\.setItem\('arbi_partner_entry',\s*'1'\)/,
        'partners.html must set arbi_partner_entry = "1"');
});

test('partners.html: the partner marker assignment does not depend on window.location.search', () => {
    const line = PARTNERS.split('\n').find((l) => l.indexOf("setItem('arbi_partner_entry'") !== -1);
    assert.ok(line, 'the marker line must exist');
    assert.ok(!/location\.search/.test(line), 'the marker must be query-independent');
    assert.ok(!/location\.href/.test(line), 'the marker must not depend on the full URL');
});

test('partners.html: the legacy arbi_auth_entry behaviour is preserved verbatim', () => {
    assert.ok(
        PARTNERS.includes("sessionStorage.setItem('arbi_auth_entry', window.location.search || '/partners')"),
        'the existing auth-tab deep-link contract must be unchanged'
    );
});

test('functional: the partner marker survives a UTM query string (auth entry does not)', () => {
    // Run the REAL attribution statements from partners.html with an ad-style URL.
    const at = PARTNERS.indexOf("try { sessionStorage.setItem('arbi_auth_entry'");
    assert.ok(at !== -1, 'the auth-entry statement must exist');
    const block = PARTNERS.slice(at, PARTNERS.indexOf('applyTranslations();', at));
    const sessionStorage = makeStorage();
    const sandbox = {
        console: { log: () => {}, error: () => {} },
        sessionStorage: sessionStorage,
        window: { location: { search: '?utm_source=facebook&utm_campaign=partners&fbclid=abc123' } },
    };
    vm.createContext(sandbox);
    vm.runInContext(block, sandbox);
    const dump = sessionStorage.dump();
    assert.strictEqual(dump[MARKER_KEY], '1',
        'the partner marker must be set even when the ad URL carries UTM parameters');
    assert.strictEqual(dump['arbi_auth_entry'], '?utm_source=facebook&utm_campaign=partners&fbclid=abc123',
        'legacy auth-entry behaviour is unchanged (stores the query string)');
    assert.ok(!dump['arbi_auth_entry'].includes('/partners'),
        'documents the defect being fixed: the legacy value loses the /partners signal under UTM');
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

test('index.html: the marker helpers use one key, compare to "1", and are exported', () => {
    assert.ok(INDEX.includes("var PARTNER_ENTRY_KEY = '" + MARKER_KEY + "';"), 'single key constant');
    assert.match(funcSrc(INDEX, 'isPartnerFunnelEntry'),
        /sessionStorage\.getItem\(PARTNER_ENTRY_KEY\) === '1'/,
        'the marker must be read as the exact string "1"');
    assert.match(funcSrc(INDEX, 'isPartnerFunnelEntry'), /catch \(e\) \{ return false; \}/,
        'a storage failure must fail closed');
    assert.match(funcSrc(INDEX, 'clearPartnerFunnelEntry'), /sessionStorage\.removeItem\(PARTNER_ENTRY_KEY\)/);
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
