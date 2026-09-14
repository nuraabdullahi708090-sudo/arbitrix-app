'use strict';

/**
 * MODE-AWARE "START HERE" CARD - tests.
 *
 * The dashboard onboarding card previously showed demo-specific instructions
 * (including "Switch to Live Mode when ready") even while the account was in
 * LIVE Mode. The card is now mode-aware:
 *   - DEMO Mode  -> the original beginner checklist, unchanged.
 *   - LIVE Mode  -> a Live Mode checklist with exactly TWO steps, both
 *                   requirements the product actually enforces: the platform
 *                   minimum deposit and the minimum trading balance to start
 *                   the bot. (The withdrawal/verification steps were removed by
 *                   management direction.)
 *   - LIVE Mode with a confirmed deposit AND at least one completed trade ->
 *     a compact completion line instead of repeating the checklist (driven by
 *     the existing reliable server flags, no new tracking).
 *
 * Display only: no balance, trading rule, invoice, session or API is touched.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
const NEW_KEYS = ['startHere.live.title', 'startHere.live.subtitle', 'startHere.live.step1',
    'startHere.live.step2', 'startHere.live.ready'];
const REMOVED_KEYS = ['startHere.live.step3', 'startHere.live.step4'];

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' must be brace-matchable');
    return INDEX.slice(start, end + 1);
}

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx), depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();

/* ------------------------------------------------------------------ *
 * Behavioural sandbox: runs the REAL card functions against a DOM stub
 * ------------------------------------------------------------------ */
function runCard(opts) {
    const o = opts || {};
    const ids = ['startHereCard', 'startHereHeadDemo', 'startHereHeadLive', 'startHereStepsDemo',
        'startHereStepsLive', 'startHereStepsLiveReady'];
    const els = {};
    ids.forEach((id) => { els[id] = { id, innerHTML: '', textContent: '', style: { display: '' } }; });
    // Markup defaults (as shipped in the HTML).
    els.startHereHeadDemo.style.display = 'block';
    els.startHereHeadLive.style.display = 'none';
    els.startHereStepsDemo.style.display = 'flex';
    els.startHereStepsLive.style.display = 'none';
    els.startHereStepsLiveReady.style.display = 'none';
    const store = {};
    const sandbox = {
        els,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        document: { getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [] },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        TRANSLATIONS: T,
        currentLang: o.lang || 'en',
        APP: Object.assign({
            environment: 'PRODUCTION',
            mode: 'demo',
            MIN_DEPOSIT: 100,
            MTA: 200,
            MIN_WITHDRAWAL: 700,
            liveData: { hasRealDeposit: false, hasTradingActivity: false },
        }, o.APP || {}),
    };
    if (o.APP && o.APP.liveData) sandbox.APP.liveData = Object.assign({ hasRealDeposit: false, hasTradingActivity: false }, o.APP.liveData);
    if (o.dismissed) store['arbi_starthere_1'] = '1';
    vm.createContext(sandbox);
    vm.runInContext([
        'var TRANSLATIONS = globalThis.TRANSLATIONS;',
        'function currentCachedUser(){ return { id: 1 }; }',
        extractFunction('t'),
        extractFunction('startHereKey'),
        extractFunction('dismissStartHere'),
        extractFunction('startHereLiveSteps'),
        extractFunction('startHereLiveComplete'),
        extractFunction('renderStartHereLiveSteps'),
        extractFunction('updateStartHere'),
        'globalThis.__upd = updateStartHere;',
        'globalThis.__dis = dismissStartHere;',
        'globalThis.__setMode = function(m){ APP.mode = m; updateStartHere(); };',
        'globalThis.__setLang = function(l){ currentLang = l; updateStartHere(); };',
        'globalThis.__setLive = function(f){ APP.liveData.hasRealDeposit = f.hasRealDeposit; APP.liveData.hasTradingActivity = f.hasTradingActivity; updateStartHere(); };',
    ].join('\n'), sandbox);
    return { sandbox, els, store };
}

const vis = (els) => ({
    card: els.startHereCard.style.display,
    headDemo: els.startHereHeadDemo.style.display,
    headLive: els.startHereHeadLive.style.display,
    stepsDemo: els.startHereStepsDemo.style.display,
    stepsLive: els.startHereStepsLive.style.display,
    ready: els.startHereStepsLiveReady.style.display,
    liveHtml: els.startHereStepsLive.innerHTML,
});

/* ------------------------------------------------------------------ *
 * 1-6. Source / markup / dictionary contracts
 * ------------------------------------------------------------------ */

test('1. markup ships the demo checklist unchanged plus dedicated live containers', () => {
    assert.ok(INDEX.includes('id="startHereCard"'), 'card must exist');
    ['startHereHeadDemo', 'startHereHeadLive', 'startHereStepsDemo', 'startHereStepsLive', 'startHereStepsLiveReady']
        .forEach((id) => assert.ok(INDEX.includes('id="' + id + '"'), id + ' markup must exist'));
    // the five demo rows and their keys are byte-identical to the previous build
    ['startHere.step1', 'startHere.step2', 'startHere.step3', 'startHere.step4', 'startHere.step5']
        .forEach((k) => assert.ok(INDEX.includes('data-i18n="' + k + '"'), k + ' row must stay in the markup'));
    assert.ok(INDEX.includes('data-i18n="startHere.step5">Switch to Live Mode when ready</span>'), 'demo step 5 wording unchanged');
    // live steps are rendered at run time; only the completion line is static
    assert.ok(INDEX.includes('data-i18n="startHere.live.ready"'), 'completion line must be in the markup');
    assert.ok(/id="startHereStepsLive"[^>]*><\/div>/.test(INDEX), 'live steps container ships empty (rendered by JS)');
    assert.ok(/id="startHereStepsLive"[^>]*display:none/.test(INDEX), 'live steps container ships hidden');
    assert.ok(/id="startHereStepsLiveReady"[^>]*display:none/.test(INDEX), 'completion line ships hidden');
});

test('2. the live checklist has exactly the two approved steps', () => {
    const steps = extractFunction('startHereLiveSteps');
    assert.ok(steps.includes("'startHere.live.step1'") && steps.includes("'startHere.live.step2'"), 'two live steps');
    assert.ok(!steps.includes("'startHere.live.step3'") && !steps.includes("'startHere.live.step4'"), 'verification/withdrawal steps removed');
    assert.ok(steps.includes('APP.MIN_DEPOSIT'), 'step 1 uses the platform minimum deposit');
    assert.ok(steps.includes('APP.MTA'), 'step 2 uses the minimum trading balance (MTA)');
    assert.ok(!steps.includes('MIN_WITHDRAWAL'), 'the withdrawal minimum is no longer part of the card');
    assert.ok(!steps.includes('MIN_BONUS') && !steps.includes('BONUS_MIN_WITHDRAW'), 'no invented bonus requirement');
    assert.strictEqual((steps.match(/startHere\.live\.step/g) || []).length, 2, 'exactly two step entries');
    // demo wording must never appear in the live step keys
    ['startHere.step1', 'startHere.step2', 'startHere.step3', 'startHere.step4', 'startHere.step5']
        .forEach((k) => assert.ok(!steps.includes("'" + k + "'"), 'live steps must not reuse demo key ' + k));
});

test('3. completion state uses the existing reliable server flags only', () => {
    const fn = extractFunction('startHereLiveComplete');
    assert.ok(fn.includes('hasRealDeposit'), 'uses the confirmed-deposit flag');
    assert.ok(fn.includes('hasTradingActivity'), 'uses the completed-trade flag');
    assert.ok(!/localStorage|sessionStorage|fetch\(/.test(fn), 'no new/fake tracking or extra request');
});

test('4. updateStartHere is mode-aware and the card re-renders on language switch', () => {
    const fn = extractFunction('updateStartHere');
    assert.ok(fn.includes("APP.mode === 'live'"), 'branches on the active mode');
    assert.ok(fn.includes('startHereHeadLive') && fn.includes('startHereHeadDemo'), 'toggles the headers');
    assert.ok(fn.includes('startHereStepsLive') && fn.includes('startHereStepsDemo'), 'toggles the step lists');
    assert.ok(fn.includes('renderStartHereLiveSteps()'), 'renders the live steps');
    const dyn = extractFunction('updateDynamicTranslations');
    assert.ok(dyn.includes('updateStartHere()'), 'language switch must rebuild the card');
});

test('5. dictionaries: 7 new keys in all 6 locales, EN exact, no demo wording', () => {
    LANGS.forEach((l) => NEW_KEYS.forEach((k) => {
        assert.ok(typeof T[l][k] === 'string' && T[l][k].length > 0, l + ' missing ' + k);
    }));
    assert.strictEqual(T.en['startHere.live.title'], 'Live Mode Guide');
    assert.strictEqual(T.en['startHere.live.subtitle'], "You're in Live Mode. Trades use real funds.");
    assert.strictEqual(T.en['startHere.live.step1'], 'Deposit at least ${{min}} to activate Live funding');
    assert.strictEqual(T.en['startHere.live.step2'], 'Maintain at least ${{mta}} available balance to start the bot');
    // the removed LIVE steps must not exist in ANY locale
    LANGS.forEach((l) => REMOVED_KEYS.forEach((k) => {
        assert.ok(!(k in T[l]), l + ' must not keep the removed key ' + k);
    }));
    assert.strictEqual(T.en['startHere.live.ready'], "You're ready for Live Mode. Review your settings before starting your bot.");
    // localised values are real translations (spot checks via code points)
    assert.strictEqual(T.zh['startHere.live.step1'], '\u5165\u91d1\u81f3\u5c11 ${{min}} \u4ee5\u6fc0\u6d3b\u5b9e\u76d8\u8d44\u91d1');
    assert.strictEqual(T.ar['startHere.live.step2'], '\u062d\u0627\u0641\u0638 \u0639\u0644\u0649 \u0631\u0635\u064a\u062f \u0645\u062a\u0627\u062d \u0644\u0627 \u064a\u0642\u0644 \u0639\u0646 ${{mta}} \u0644\u0628\u062f\u0621 \u0627\u0644\u0631\u0648\u0628\u0648\u062a');
    assert.ok(T.es['startHere.live.title'].includes('\u00ed'), 'es keeps the accented copy');
    assert.ok(T.fr['startHere.live.subtitle'].includes('\u00e9'), 'fr keeps the accented copy');
    // no demo wording anywhere in the live keys
    LANGS.forEach((l) => NEW_KEYS.forEach((k) => {
        const v = T[l][k];
        assert.ok(!/switch to live mode when ready/i.test(v), l + ' ' + k + ' must not repeat the demo sentence');
        assert.ok(!/\bdemo\b/i.test(v), l + ' ' + k + ' must not mention demo');
        assert.ok(!/\u8bd5\u7528|\u30c7\u30e2|\u062a\u062c\u0631\u064a\u0628/i.test(v), l + ' ' + k + ' must not mention demo (non-latin)');
    }));
    // demo copy + dictionary size untouched by the mode change
    LANGS.forEach((l) => assert.ok(typeof T[l]['startHere.step5'] === 'string' && T[l]['startHere.step5'].length > 0, l + ' must keep its startHere.step5 value'));
    assert.strictEqual(T.en['startHere.step5'], 'Switch to Live Mode when ready');
    const sizes = LANGS.map((l) => Object.keys(T[l]).length);
    assert.ok(sizes.every((n) => n === sizes[0]), 'locales must keep identical key counts');
    assert.strictEqual(new Set(LANGS.map((l) => Object.keys(T[l]).sort().join('|'))).size, 1, 'identical key sets');
});

/* ------------------------------------------------------------------ *
 * 7-13. Behaviour
 * ------------------------------------------------------------------ */

test('7. DEMO mode shows the demo card and hides every live element', () => {
    const { sandbox, els } = runCard({ APP: { mode: 'demo' } });
    vm.runInContext('__upd()', sandbox);
    const v = vis(els);
    assert.strictEqual(v.card, 'block', 'card visible in demo');
    assert.strictEqual(v.headDemo, 'block', 'demo header visible');
    assert.strictEqual(v.stepsDemo, 'flex', 'demo steps visible');
    assert.strictEqual(v.headLive, 'none', 'live header hidden');
    assert.strictEqual(v.stepsLive, 'none', 'live steps hidden');
    assert.strictEqual(v.ready, 'none', 'completion line hidden');
});

test('8. LIVE mode hides the demo instructions and shows the live checklist', () => {
    const { sandbox, els } = runCard({ APP: { mode: 'live' } });
    vm.runInContext('__upd()', sandbox);
    const v = vis(els);
    assert.strictEqual(v.headDemo, 'none', 'demo header hidden in live');
    assert.strictEqual(v.stepsDemo, 'none', 'demo steps hidden in live');
    assert.strictEqual(v.headLive, 'block', 'live header visible');
    assert.strictEqual(v.stepsLive, 'flex', 'live steps visible');
    assert.strictEqual(v.ready, 'none', 'completion line hidden while incomplete');
    // the demo wording (including the previously reported sentence) is gone
    assert.ok(!v.liveHtml.includes('Start the demo bot'), 'no demo step text');
    assert.ok(!v.liveHtml.includes('Watch how demo activity'), 'no demo step text');
    assert.ok(!v.liveHtml.includes('Switch to Live Mode when ready'), 'no outdated sentence');
    // live steps render with the configured amounts interpolated
    ['Deposit at least $100 to activate Live funding', 'Maintain at least $200 available balance to start the bot']
        .forEach((frag) => assert.ok(v.liveHtml.includes(frag), 'live checklist must contain: ' + frag));
    ['Verify your account to withdraw', '$700', 'wmin'].forEach((frag) => {
        assert.ok(!v.liveHtml.includes(frag), 'removed LIVE step copy must not render: ' + frag);
    });
    assert.ok(INDEX.includes('data-i18n="startHere.live.title">Live Mode Guide<'), 'live header carries the guide title');
    const nums = v.liveHtml.match(/class="sh-num">(\d)</g) || [];
    assert.strictEqual(nums.length, 2, 'exactly two numbered live steps');
    assert.ok(v.liveHtml.includes('class="sh-num">1</span>') && v.liveHtml.includes('class="sh-num">2</span>'), 'numbering 1..2 preserved');
    assert.ok(!v.liveHtml.includes('class="sh-num">3</span>'), 'no third step');
});

test('9. LIVE completion state shows the compact line instead of the checklist', () => {
    const { sandbox, els } = runCard({ APP: { mode: 'live', liveData: { hasRealDeposit: true, hasTradingActivity: true } } });
    vm.runInContext('__upd()', sandbox);
    const v = vis(els);
    assert.strictEqual(v.ready, 'block', 'completion line visible');
    assert.strictEqual(v.stepsLive, 'none', 'checklist not repeated');
    assert.strictEqual(v.headLive, 'block', 'live header kept');
    assert.strictEqual(v.stepsDemo, 'none', 'demo steps still hidden');
});

test('10. switching DEMO -> LIVE -> DEMO updates the card in both directions', () => {
    const { sandbox, els } = runCard({ APP: { mode: 'demo' } });
    vm.runInContext('__upd()', sandbox);
    assert.strictEqual(vis(els).stepsDemo, 'flex', 'starts on the demo card');

    vm.runInContext('__setMode("live")', sandbox);
    let v = vis(els);
    assert.strictEqual(v.stepsDemo, 'none', 'demo card hidden after switching to live');
    assert.strictEqual(v.stepsLive, 'flex', 'live card shown after switching to live');
    assert.strictEqual(v.stepsLive, 'flex', 'live steps visible');

    vm.runInContext('__setMode("demo")', sandbox);
    v = vis(els);
    assert.strictEqual(v.stepsDemo, 'flex', 'demo card restored after switching back');
    assert.strictEqual(v.stepsLive, 'none', 'live card hidden after switching back');
    assert.strictEqual(v.headDemo, 'block', 'demo header restored');

    // and live -> complete -> live again stays consistent
    vm.runInContext('__setMode("live")', sandbox);
    vm.runInContext('__setLive({hasRealDeposit:true, hasTradingActivity:true})', sandbox);
    assert.strictEqual(vis(els).ready, 'block', 'completion state appears');
    vm.runInContext('__setLive({hasRealDeposit:true, hasTradingActivity:false})', sandbox);
    assert.strictEqual(vis(els).ready, 'none', 'checklist returns without a completed trade');
    assert.strictEqual(vis(els).stepsLive, 'flex', 'checklist visible again');
});

test('11. dismiss still works in both modes', () => {
    const demo = runCard({ APP: { mode: 'demo' } });
    vm.runInContext('__dis()', demo.sandbox);
    assert.strictEqual(demo.els.startHereCard.style.display, 'none', 'dismissed in demo');
    assert.strictEqual(demo.store['arbi_starthere_1'], '1', 'per-account flag stored');

    const live = runCard({ APP: { mode: 'live' } });
    vm.runInContext('__dis()', live.sandbox);
    assert.strictEqual(live.els.startHereCard.style.display, 'none', 'dismissed in live');

    const pre = runCard({ APP: { mode: 'live' }, dismissed: true });
    vm.runInContext('__upd()', pre.sandbox);
    assert.strictEqual(pre.els.startHereCard.style.display, 'none', 'stays dismissed across reloads in live mode');
});

test('12. MARKETING_SANDBOX accounts never see the card', () => {
    const { sandbox, els } = runCard({ APP: { mode: 'live', environment: 'MARKETING_SANDBOX' } });
    vm.runInContext('__upd()', sandbox);
    assert.strictEqual(els.startHereCard.style.display, 'none', 'sandbox card hidden');
});

test('13. live steps localise on language switch and fall back to EN', () => {
    const { sandbox, els } = runCard({ APP: { mode: 'live' } });
    vm.runInContext('__upd()', sandbox);
    assert.ok(els.startHereStepsLive.innerHTML.includes('Maintain at least $200 available balance'), 'en by default');

    vm.runInContext('__setLang("es")', sandbox);
    assert.ok(els.startHereStepsLive.innerHTML.includes(T.es['startHere.live.step2'].replace('{{mta}}', '200')), 'es after switch');
    assert.ok(!els.startHereStepsLive.innerHTML.includes('Minimum trading balance'), 'en copy replaced');

    vm.runInContext('__setLang("ar")', sandbox);
    assert.ok(els.startHereStepsLive.innerHTML.includes(T.ar['startHere.live.step2'].replace('{{mta}}', '200')), 'ar after switch');

    vm.runInContext('__setLang("zh")', sandbox);
    assert.ok(els.startHereStepsLive.innerHTML.includes(T.zh['startHere.live.step1'].replace('{{min}}', '100')), 'zh after switch');

    vm.runInContext('__setLang("de")', sandbox); // unsupported locale -> EN fallback
    assert.ok(els.startHereStepsLive.innerHTML.includes('Maintain at least $200 available balance'), 'EN fallback for unknown locale');
    assert.ok(!els.startHereStepsLive.innerHTML.includes('startHere.live.'), 'no raw keys rendered');
});

test('14. amounts follow the configured constants (not hardcoded copy)', () => {
    const { sandbox, els } = runCard({
        APP: { mode: 'live', MIN_DEPOSIT: 250, MTA: 300, MIN_WITHDRAWAL: 900 },
    });
    vm.runInContext('__upd()', sandbox);
    const html = els.startHereStepsLive.innerHTML;
    assert.ok(html.includes('Deposit at least $250'), 'minimum deposit follows APP.MIN_DEPOSIT');
    assert.ok(html.includes('Maintain at least $300'), 'MTA follows APP.MTA');
    assert.ok(!html.includes('$900'), 'the withdrawal minimum is not part of the card');
});
