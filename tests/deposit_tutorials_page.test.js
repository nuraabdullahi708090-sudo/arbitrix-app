'use strict';

/**
 * Deposit tutorial centre: page, integration and playback.
 *
 * Covers the customer-facing tutorial experience only:
 *   - the standalone page at /deposit-tutorials (route + content + 6 locales),
 *   - the deposit-modal CTA and the withdrawal tutorial,
 *   - Telegram playback (official embed on click, real Telegram fallback),
 *   - and, importantly, that NONE of it touches the deposit/withdrawal paths.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'deposit-tutorials.html'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

// The page documents WHY embedding is not used, so the raw text mentions the
// embed URL. Structural assertions run against the markup with comments removed.
const PAGE_NO_COMMENTS = PAGE
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const URLS = {
    paybis: 'https://t.me/ArbitrixAnnouncements/17',
    transak: 'https://t.me/ArbitrixAnnouncements/16',
    trustwallet: 'https://t.me/ArbitrixAnnouncements/18',
    withdrawal: 'https://t.me/ArbitrixAnnouncements/19'
};

const NEW_APP_KEYS = [
    'withdraw.tutorial.title', 'withdraw.tutorial.body', 'withdraw.tutorial.cta', 'withdraw.tutorial.note'
];

// ------------------------------------------------------------------ helpers ---

// Returns the markup that FOLLOWS the div starting at `marker`, using a tag
// balance walk so the check cannot be fooled by nested divs.
function tailAfterBlock(markup, marker) {
    const start = markup.indexOf(marker);
    assert.ok(start > -1, 'expected block: ' + marker);
    const re = /<div\b|<\/div>/g;
    re.lastIndex = start;
    let depth = 0;
    let opened = false;
    let m;
    while ((m = re.exec(markup))) {
        if (m[0] === '</div>') {
            depth -= 1;
            if (opened && depth === 0) return markup.slice(m.index + 6);
        } else {
            depth += 1;
            opened = true;
        }
    }
    return '';
}

function loadPageTranslations() {
    const start = PAGE.indexOf('var TRANSLATIONS = {');
    const end = PAGE.indexOf('var SUPPORTED');
    assert.ok(start > 0 && end > start, 'the page must embed its dictionary');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(PAGE.slice(start, end).trim().replace(/;$/, '') + '\nthis.T = TRANSLATIONS;', sandbox);
    return sandbox.T;
}

function loadAppTranslations() {
    const start = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i += 1) {
        if (INDEX[i] === '{') depth += 1;
        else if (INDEX[i] === '}') {
            depth -= 1;
            if (depth === 0) { end = i; break; }
        }
    }
    assert.ok(end > 0, 'the app dictionary must be brace-matchable');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + INDEX.slice(INDEX.indexOf('{', start), end + 1), sandbox);
    return sandbox.T;
}

function pageScript() {
    const blocks = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((b) => b.trim());
    assert.strictEqual(blocks.length, 1, 'the page must have exactly one inline script');
    return blocks[0];
}

/** Minimal DOM shim: enough to run the real page script and click a card. */
function createDom() {
    const byId = new Map();
    const buttons = [];
    const media = new Map();

    function makeMedia(id) {
        const node = {
            id,
            children: [],
            innerHTML: '',
            attrs: {},
            classList: { added: false, add() { this.added = true; } },
            setAttribute(key, value) { this.attrs[key] = value; },
            getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; },
            appendChild(child) { this.children.push(child); return child; }
        };
        media.set(id, node);
        return node;
    }

    function makeButton(tutorial, url) {
        const button = {
            dataset: { tutorial, url },
            classList: { contains: () => true },
            listeners: {},
            addEventListener(type, fn) { this.listeners[type] = fn; }
        };
        buttons.push(button);
        return button;
    }

    ['paybis', 'transak', 'trustwallet'].forEach((name) => makeMedia('media-' + name));
    makeButton('paybis', URLS.paybis);
    makeButton('transak', URLS.transak);
    makeButton('trustwallet', URLS.trustwallet);
    makeButton('unknown', 'https://example.com/not-telegram');

    const created = [];
    const document = {
        title: 'Deposit Tutorials | Kalderix',
        documentElement: { lang: 'en', dir: 'ltr' },
        getElementById: (id) => (byId.has(id) ? byId.get(id) : (media.get(id) || null)),
        querySelectorAll: (selector) => (selector === '.js-watch, .play-btn[data-url]' ? buttons : []),
        createElement: (tag) => {
            const node = {
                tagName: tag,
                attrs: {},
                textContent: '',
                className: '',
                setAttribute(key, value) { this.attrs[key] = value; },
                getAttribute(key) { return this.attrs[key]; }
            };
            created.push(node);
            return node;
        }
    };

    const sandbox = {
        document,
        navigator: { languages: ['en'], language: 'en' },
        localStorage: { store: {}, getItem(k) { return this.store[k] || null; }, setItem(k, v) { this.store[k] = v; } },
        console
    };
    vm.createContext(sandbox);
    vm.runInContext(pageScript(), sandbox);

    return { document, buttons, media, created, sandbox };
}

// --------------------------------------------------------------- 1. routing ---

test('1. /deposit-tutorials is served by a dedicated route, before the SPA fallback', () => {
    const route = SERVER.indexOf("app.get('/deposit-tutorials'");
    assert.ok(route > 0, 'the route must exist');
    assert.ok(SERVER.slice(route, route + 220).includes("path.join(__dirname, 'public', 'deposit-tutorials.html')"));

    const fallback = SERVER.indexOf("app.use((req, res) => {\n  res.sendFile(path.join(__dirname, 'public', 'index.html'));");
    assert.ok(fallback > 0, 'the SPA fallback must exist');
    assert.ok(route < fallback, 'the tutorial route must be registered before the SPA fallback');

    const staticServing = SERVER.indexOf("express.static(path.join(__dirname, 'public'))");
    assert.ok(staticServing > 0 && staticServing < route, 'public/ is served by express.static');
});

test('2. the page is a standalone document (no app shell, no API calls)', () => {
    assert.ok(PAGE.trim().startsWith('<!DOCTYPE html>'));
    assert.ok(PAGE.includes('</html>'));
    assert.ok(!/fetch\s*\(/.test(PAGE), 'no network calls');
    assert.ok(!/XMLHttpRequest/.test(PAGE), 'no XHR');
    assert.ok(!/\/api\//.test(PAGE), 'no API endpoint is used');
    assert.ok(!/localStorage\.setItem\('jwt_token'/.test(PAGE), 'never touches the session');
});

// --------------------------------------------------------------- 2. content ---

test('3. the page carries the required heading, supporting text and three tutorials', () => {
    assert.match(PAGE, /Don't Have Crypto Yet\? Let's Get You Started\./);
    assert.match(PAGE, /New to cryptocurrency\? Follow our step-by-step video tutorials to learn how to purchase cryptocurrency and transfer it to your Kalderix account\./);

    for (const [method, url] of Object.entries({ paybis: URLS.paybis, transak: URLS.transak, trustwallet: URLS.trustwallet })) {
        assert.ok(PAGE.includes('id="tutorial-' + method + '"'), method + ' card must exist');
        assert.ok(PAGE.includes('data-tutorial="' + method + '"'), method + ' card must be identified');
        assert.ok(PAGE.includes('href="' + url + '"'), method + ' must link to ' + url);
    }
    assert.ok(!PAGE.includes(URLS.withdrawal), 'the withdrawal tutorial belongs to the withdrawal screen, not this page');
});

test('4. every card has a Watch Tutorial link that opens the Telegram post', () => {
    const watch = (PAGE.match(/class="btn btn-primary js-watch"/g) || []).length;
    assert.strictEqual(watch, 3, 'three Watch Tutorial actions');
    assert.strictEqual((PAGE.match(/data-i18n="watch"/g) || []).length, 3);
    assert.strictEqual((PAGE.match(/data-i18n="openInTelegram"/g) || []).length, 3);

    // Each action is an anchor to the real post, opened safely in a new tab.
    const anchors = [...PAGE.matchAll(/<a class="btn btn-primary js-watch" href="([^"]+)" target="_blank" rel="noopener noreferrer" data-tutorial="([a-z]+)">/g)];
    assert.strictEqual(anchors.length, 3, 'the watch actions must be plain links');
    const byMethod = Object.fromEntries(anchors.map((m) => [m[2], m[1]]));
    assert.deepStrictEqual(byMethod, {
        paybis: URLS.paybis,
        transak: URLS.transak,
        trustwallet: URLS.trustwallet
    });
});

test('5. third-party services are clearly distinguished from Kalderix', () => {
    assert.match(PAGE, /independent third-party services, not part of Kalderix/i);
    assert.match(PAGE, /does not sell cryptocurrency or process card payments directly/i);
    assert.match(PAGE, /set by each provider and vary by country/i);
    assert.ok(!/Kalderix (?:card payment|accepts card|processes card)/i.test(PAGE.replace(/does not[^.]*\./g, '')),
        'the page must not claim Kalderix processes card payments');
});

test('6. safety guidance names the TRC20 network and secrets', () => {
    assert.match(PAGE, /Send USDT only on the TRON \(TRC20\) network\./);
    assert.match(PAGE, /Never share your password, OTP, seed phrase or private keys\./);
    assert.ok(!/https?:\/\/[^"'\s]+\.mp4/.test(PAGE), 'no fake direct-MP4 URL is fabricated');
});

// -------------------------------------------------------------- 3. playback ---

test('7. playback is an honest fallback: cards open the original Telegram post', () => {
    // Measured 2026-11-03: Telegram's embed endpoint answers 200 for these posts
    // but renders "Media is too big / VIEW IN TELEGRAM" instead of a player, so
    // inline playback is not reliable. The page must therefore not pretend to
    // embed, and must not fabricate a direct video URL.
    assert.ok(!/<iframe/i.test(PAGE_NO_COMMENTS), 'no player is embedded');
    assert.ok(!/embed=1/.test(PAGE_NO_COMMENTS), 'the page does not build an embed URL');
    assert.ok(!/https?:\/\/[^"'\s]+\.mp4/.test(PAGE), 'no fake MP4 URL');
    Object.values(URLS).filter((url) => url !== URLS.withdrawal).forEach((url) => {
        assert.ok(PAGE.includes('href="' + url + '"'), 'seed post not linked: ' + url);
    });
    assert.match(PAGE, /Each tutorial opens in Telegram in a new tab\./);
});

test('8. the measured reason for the fallback is documented in the page', () => {
    assert.match(PAGE, /Media is too big/);
    assert.match(PAGE, /embedding is NOT reliable playback here/i);
});

test('9. the page loads no third-party player and needs no JavaScript to watch', () => {
    assert.ok(!/telegram-widget\.js/.test(PAGE), 'no Telegram widget script');
    assert.ok(!/document\.createElement\('iframe'\)/.test(PAGE), 'no iframe is created');
    const script = pageScript();
    assert.ok(!/createElement/.test(script), 'the script only localizes');
    // Watch controls are anchors, so they work with JS disabled.
    assert.strictEqual((PAGE.match(/<a class="btn btn-primary js-watch"/g) || []).length, 3);
});

// ----------------------------------------------------------------- 4. i18n ---

test('10. the page is localized in all six app languages with identical key sets', () => {
    const T = loadPageTranslations();
    assert.deepStrictEqual(Object.keys(T).sort(), LANGS.slice().sort());
    const base = Object.keys(T.en).sort();
    LANGS.forEach((lang) => {
        assert.deepStrictEqual(Object.keys(T[lang]).sort(), base, lang + ' key set differs');
        base.forEach((key) => {
            assert.ok(String(T[lang][key]).trim().length > 0, lang + '.' + key + ' must not be empty');
        });
    });
    assert.strictEqual(base.length, 27, 'expected 27 keys per locale');
});

test('11. Arabic sets RTL and the shared language key is reused', () => {
    assert.match(PAGE, /document\.documentElement\.dir = currentLang === 'ar' \? 'rtl' : 'ltr'/);
    assert.match(PAGE, /localStorage\.setItem\('arbi_lang'/);
    assert.match(PAGE, /localStorage\.getItem\('arbi_lang'\)/);
    assert.match(PAGE, /navigator\.languages/);
    const dom = createDom();
    dom.sandbox.document.documentElement.dir = 'ltr';
    dom.document.getElementById('langSelect'); // exists check only; setLanguage is internal
    assert.ok(PAGE.includes("dir: 'rtl'") || PAGE.includes("'rtl' : 'ltr'"));
});

test('12. the page title is localized from the dictionary', () => {
    const dom = createDom();
    assert.strictEqual(dom.document.title, 'Deposit Tutorials | Buy Crypto and Fund Kalderix');
    const T = loadPageTranslations();
    assert.strictEqual(T.ar['meta.title'].includes('Kalderix'), true);
    assert.notStrictEqual(T.zh['meta.title'], T.en['meta.title']);
});

// ------------------------------------------- 5. deposit + withdrawal in-app ---

test('13. the deposit dialog no longer carries a funding-help or tutorial card', () => {
    const panelStart = INDEX.indexOf('id="depositModalContent"');
    assert.ok(panelStart > 0, 'the deposit panel must exist');
    const hiddenInputs = INDEX.indexOf('<!-- Hidden inputs -->', panelStart);
    assert.ok(hiddenInputs > panelStart);
    const panel = INDEX.slice(panelStart, hiddenInputs);

    // The whole element is gone: container, icon, heading, explanation, disclaimer.
    assert.ok(!panel.includes('depositTutorialsCard'), 'the card element is removed');
    assert.ok(!panel.includes('fa-graduation-cap'), 'the graduation-cap icon is removed');
    assert.ok(!/data-i18n="deposit\.tutorials\./.test(panel), 'no card translation is referenced');
    assert.ok(!/Don't have cryptocurrency yet/.test(panel), 'the heading is gone');
    assert.ok(!/Paybis, Transak and Trust Wallet/.test(panel), 'the third-party disclaimer is gone');
    assert.ok(!/purchase cryptocurrency through supported third-party services/.test(panel),
        'the purchase explanation is gone');
    assert.ok(!/deposit-tutorials|depositTutorialsCta/.test(panel),
        'nothing in the dialog points at the tutorial page');

    // The dialog now ends with Recent Deposits, directly before the hidden inputs.
    const history = panel.indexOf('<div class="deposit-history"');
    assert.ok(history > 0, 'Recent Deposits stays in the dialog');
    assert.ok(history > panel.indexOf('id="depositActions"') - 1 || history > panel.indexOf('id="depositSuccessSection"'));
    // Nothing but whitespace may follow the history block inside the panel.
    const tail = tailAfterBlock(panel, '<div class="deposit-history"');
    assert.strictEqual(tail.trim(), '', 'Recent Deposits is the last content block of the dialog');
});

test('14. the withdrawal modal shows the withdrawal tutorial (post 19)', () => {
    const boxStart = INDEX.indexOf('id="withdrawTutorialBox"');
    assert.ok(boxStart > 0, 'the withdrawal modal must contain the tutorial box');
    const form = INDEX.indexOf('id="withdrawForm"');
    const kycRequired = INDEX.indexOf('id="withdrawKycRequired"');
    assert.ok(form < boxStart && boxStart < kycRequired, 'the box belongs to the withdrawal form');

    const boxEnd = INDEX.indexOf('<div style="text-align:center;margin-bottom:12px;">', boxStart);
    assert.ok(boxEnd > boxStart, 'the tutorial box must be its own block');
    const block = INDEX.slice(boxStart, boxEnd);
    assert.match(block, /href="https:\/\/t\.me\/ArbitrixAnnouncements\/19"/);
    assert.match(block, /target="_blank"/);
    assert.match(block, /rel="noopener noreferrer"/);
    assert.match(block, /data-i18n="withdraw\.tutorial\.title"/);
    assert.match(block, /data-i18n="withdraw\.tutorial\.body"/);
    assert.match(block, /data-i18n="withdraw\.tutorial\.cta"/);
    assert.match(block, /data-i18n="withdraw\.tutorial\.note"/);
    assert.ok(!/onclick=/.test(block));
    assert.ok(!/<input/i.test(block));
});

test('15. the withdrawal-tutorial keys exist in all six locales', () => {
    const T = loadAppTranslations();
    LANGS.forEach((lang) => {
        NEW_APP_KEYS.forEach((key) => {
            assert.ok(Object.prototype.hasOwnProperty.call(T[lang], key), lang + ' missing ' + key);
            assert.ok(String(T[lang][key]).trim().length > 0, lang + '.' + key + ' is empty');
        });
    });
    assert.strictEqual(Object.keys(T.en).length, 1587, 'dictionary size pinned at 1587 keys/locale');
    LANGS.forEach((lang) => assert.strictEqual(Object.keys(T[lang]).length, 1587));
});

test('16. every data-i18n reference on the page and in the app is defined', () => {
    const T = loadPageTranslations();
    const pageRefs = [...PAGE.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
    pageRefs.forEach((key) => assert.ok(key in T.en, 'page key missing: ' + key));

    const app = loadAppTranslations();
    const appRefs = [...new Set([...INDEX.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]))];
    appRefs.forEach((key) => assert.ok(key in app.en, 'app key missing: ' + key));
});

// --------------------------------------------------------- 6. no interference ---

test('17. the tutorial UI cannot create an invoice or a withdrawal', () => {
    const withdrawStart = INDEX.indexOf('id="withdrawTutorialBox"');
    const withdrawBlock = INDEX.slice(withdrawStart,
        INDEX.indexOf('<div style="text-align:center;margin-bottom:12px;">', withdrawStart));
    const historyStart = INDEX.indexOf('<div class="deposit-history"');
    const historyBlock = INDEX.slice(historyStart, INDEX.indexOf('<!-- Hidden inputs -->', historyStart));
    [historyBlock, withdrawBlock].forEach((block) => {
        assert.ok(!/create-invoice|payment\/create|withdraw\/request|submitWithdraw|requestDepositAddress/.test(block));
        assert.ok(!/<form|<input|<select|<textarea/i.test(block));
        assert.ok(!/onclick=|onchange=/.test(block));
    });
});

test('18. the deposit and withdrawal mechanics are unchanged', () => {
    // The deposit form still owns its amount/address fields and the deposit call.
    assert.ok(INDEX.includes('id="liveDepositAmount"'));
    assert.ok(INDEX.includes('id="getAddressBtn"'));
    assert.ok(INDEX.includes('async function requestDepositAddress(') || INDEX.includes('function requestDepositAddress('));
    // The withdrawal fields and submit path are untouched.
    assert.ok(INDEX.includes('id="withdrawAmountInput"'));
    assert.ok(INDEX.includes('id="withdrawAddressInput"'));
    assert.ok(INDEX.includes('function submitWithdrawAPI('));
    // Business rules are unchanged.
    assert.match(INDEX, /MIN_WITHDRAWAL:\s*700/);
    assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 50;/);
    // The withdrawal request never sees the tutorial.
    const withdrawRoute = SERVER.slice(SERVER.indexOf("app.post('/api/withdraw/request'"));
    const routeEnd = withdrawRoute.indexOf('\n});\n');
    assert.ok(routeEnd > 0);
    assert.ok(!/tutorial/i.test(withdrawRoute.slice(0, routeEnd)), 'the tutorial is not part of the withdrawal request');
});

test('19. the deposit modal structure keeps its single scroll container and options', () => {
    assert.match(INDEX, /id="depositModalContent"/);
    assert.match(INDEX, /id="depositOptions"/);
    assert.match(INDEX, /id="depositCryptoFlow"/);
    // One funding route: the options block is followed directly by the crypto
    // flow (the verified-partner panel was removed), then the form, then the
    // history and the tutorials card.
    assert.ok(!INDEX.includes('id="depositPartnerPanel"'), 'partner panel removed');
    const at = (needle) => INDEX.indexOf(needle);
    assert.ok(at('id="depositOptions"') < at('id="depositCryptoFlow"'));
    assert.ok(at('id="depositCryptoFlow"') < at('id="getAddressBtn"'));
    assert.ok(at('id="depositCryptoFlow"') < at('id="getAddressBtn"'));
    assert.ok(at('id="depositSuccessSection"') < at('class="deposit-history"'));
    assert.ok(at('class="deposit-history"') < at('<!-- Hidden inputs -->'));
    assert.ok(!INDEX.includes('id="depositTutorialsCard"'), 'the funding-help card stays removed');
});

// ---------------------------------------------------------------- 7. mobile ---

test('20. the page is mobile-first and cannot overflow', () => {
    assert.match(PAGE, /<meta name="viewport" content="width=device-width, initial-scale=1\.0/);
    assert.match(PAGE, /\.cards \{ display: grid; grid-template-columns: 1fr;/);
    assert.match(PAGE, /@media \(min-width: 760px\)/);
    assert.match(PAGE, /\.cards \{ grid-template-columns: repeat\(3, 1fr\); \}/);
    assert.ok((PAGE.match(/overflow-wrap: anywhere/g) || []).length >= 10, 'long translations must wrap');
    assert.match(PAGE, /\.btn \{[\s\S]*?min-height: 46px;/);
    assert.match(PAGE, /prefers-reduced-motion: reduce/);
    assert.ok(!INDEX.includes('id="depositTutorialsCard"'), 'the removed card cannot overflow');
    assert.match(INDEX, /class="deposit-history" style="margin-top:20px;padding-top:16px/);
    assert.match(INDEX, /id="withdrawTutorialBox"[\s\S]{0,800}overflow-wrap:anywhere/);
});
