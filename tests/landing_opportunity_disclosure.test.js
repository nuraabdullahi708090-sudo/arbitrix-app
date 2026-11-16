'use strict';

/**
 * Landing-page arbitrage notification card: the numbers must never be presented
 * as live market data.
 *
 * WHY THIS EXISTS
 *   `/api/market/opportunities` is built by services/MarketOpportunities.js from
 *   `Math.random()` bands. There is no market-data feed anywhere in the server
 *   (no exchange, oracle or price API is called), so the spread percentages are
 *   illustrative by construction. A card that shows "Arbitrage opportunity -
 *   Observed spread 0.35%" with no qualifier tells a visitor that a real
 *   opportunity exists at a real price, which is a misrepresentation and an
 *   advertising-compliance risk.
 *
 *   The card therefore carries a visible "Illustrative" tag and a plain-language
 *   disclaimer in every locale. These tests pin that disclosure, the localized
 *   copy, and the fact that the endpoint itself is still marked `simulated`.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const MARKET = fs.readFileSync(path.join(ROOT, 'services', 'MarketOpportunities.js'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let depth = 0;
    let end = -1;
    for (let i = INDEX.indexOf('{', tIdx); i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();

function cardMarkup() {
    const start = INDEX.indexOf('id="arbOpportunityCard"');
    assert.ok(start > 0, 'the opportunity card must exist');
    const end = INDEX.indexOf('</aside>', start);
    return INDEX.slice(start, end);
}

/* ------------------------------------------------------------------ *
 * 1. The card carries a visible disclosure
 * ------------------------------------------------------------------ */
test('the card has a visible "illustrative" tag next to the title', () => {
    const card = cardMarkup();
    assert.match(card, /class="arb-opp-tag" id="arbOppTag" data-i18n="arbOpp\.exampleTag"/,
        'the tag must be a real element wired to the dictionary');
    assert.ok(card.indexOf('arbOppTag') > card.indexOf('arbOppTitle'),
        'the tag sits immediately after the title, so it reads with the headline');
});

test('the card has a plain-language disclaimer line', () => {
    const card = cardMarkup();
    assert.match(card, /<p class="arb-opp-disclosure" id="arbOppDisclosure" data-i18n="arbOpp\.disclosure"/,
        'a disclaimer paragraph must render inside the card');
    // It must be visible: the disclosure is worthless hidden.
    assert.ok(!/arb-opp-disclosure[^}]*display\s*:\s*none/.test(INDEX), 'the note must not be display:none');
});

test('both disclosure keys exist and are non-empty in every locale', () => {
    for (const l of LANGS) {
        assert.ok(T[l], l + ' dictionary missing');
        for (const k of ['arbOpp.exampleTag', 'arbOpp.disclosure']) {
            assert.ok(Object.prototype.hasOwnProperty.call(T[l], k), l + ' missing ' + k);
            assert.ok(String(T[l][k]).trim().length > 0, l + ' empty ' + k);
        }
    }
});

test('the English disclaimer states the three negatives', () => {
    const s = T.en['arbOpp.disclosure'];
    assert.match(s, /not live market prices/i, 'must deny being live market data');
    assert.match(s, /not financial advice/i, 'must deny being financial advice');
    assert.match(s, /no profit is guaranteed/i, 'must deny a guaranteed profit');
});

test('the headline labels never promise a profit or a return', () => {
    // Only the affirmative labels are scanned: the disclaimer necessarily
    // CONTAINS these phrases in negated form ("not a guarantee of profit"),
    // so scanning it for the phrase itself would flag the very text that
    // protects the visitor.
    const banned = [
        /guaranteed profit/i, /risk[- ]free/i, /guaranteed return/i,
        /lucro garantido/i, /ganancia garantizada/i, /beneficio garantizado/i,
        /profit garanti/i, /benefice garanti/i,
        /\u0631\u0628\u062d \u0645\u0636\u0645\u0648\u0646/, // Arabic "guaranteed profit"
        /\u4fdd\u8bc1\u76c8\u5229/, // Chinese "guaranteed profit"
    ];
    for (const l of LANGS) {
        for (const k of ['arbOpp.exampleTag', 'arbOpp.title']) {
            const v = String(T[l][k]);
            for (const re of banned) {
                assert.ok(!re.test(v), l + '.' + k + ' must not promise a return: ' + v);
            }
        }
    }
});

test('every locale discloses that the numbers are an example, not a promise', () => {
    // A disclaimer must negate something (not / no / non / kein / ghayr / bu).
    const negation = [
        /not/i, /\bno\b/i, /ninguna|ninguno|ni /i, /n[a\u00e3]o/i, /pas |aucun|non /i,
        /\u063a\u064a\u0631/, /\u0644\u0627\s/, /\u4e0d/, /\u975e/,
    ];
    for (const l of LANGS) {
        const v = String(T[l]['arbOpp.disclosure']);
        assert.ok(negation.some((re) => re.test(v)), l + ' disclaimer must negate a claim: ' + v);
    }
});

/* ------------------------------------------------------------------ *
 * 2. The data source really is simulated (so the label is accurate)
 * ------------------------------------------------------------------ */
test('the endpoint marks the payload as simulated', () => {
    assert.match(SERVER, /simulated:\s*true/, 'the API must declare the payload simulated');
});

test('the module is documented as simulated and never reads a market feed', () => {
    assert.match(MARKET, /SIMULATED arbitrage opportunities/i);
    // no network / exchange / wallet access anywhere in the generator
    assert.ok(!/\bfetch\s*\(/.test(MARKET), 'must not perform network I/O');
    assert.ok(!/supabase|rpc\(|wallet|ledger|balance/i.test(MARKET.replace(/\/\*[\s\S]*?\*\//g, '')),
        'must not touch money or the database');
});

test('the card never claims the values are live', () => {
    // The badge title stays neutral; only the tag/disclaimer qualify the numbers.
    for (const l of LANGS) {
        assert.ok(!/live (spread|price|opportunit)/i.test(String(T[l]['arbOpp.title'])),
            l + ' title must not claim live data');
    }
});

/* ------------------------------------------------------------------ *
 * 3. The disclosure survives the layout/accessibility constraints
 * ------------------------------------------------------------------ */
test('the tag and note are styled to fit the compact card', () => {
    assert.match(INDEX, /\.arb-opp-tag\{[^}]*white-space:nowrap/);
    assert.match(INDEX, /\.arb-opp-disclosure\{[^}]*overflow-wrap:anywhere/);
    // readable minimum size, not microprint
    assert.match(INDEX, /\.arb-opp-disclosure\{[^}]*font-size:9\.5px/);
});

test('the card is still display-only (no trading or money path)', () => {
    const card = cardMarkup();
    assert.ok(!/onclick=/i.test(card), 'no inline handlers');
    assert.ok(!/<input|<form|<button[^>]*type="submit"/i.test(card), 'no inputs or submits');
});

test('the rotator still yields/respects reduced motion with the extra line', () => {
    assert.match(INDEX, /@media\(prefers-reduced-motion:reduce\)\{\.arb-opp-card/);
});

test('the disclosure is inside the card, not the page footer', () => {
    const card = cardMarkup();
    const at = card.indexOf('arbOppDisclosure');
    assert.ok(at > 0 && at < card.length, 'the note lives inside the card markup');
});
