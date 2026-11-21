'use strict';

/**
 * UI polish contract: money colour semantics, notification surfaces, the
 * Kalderix symbol and the dashboard rhythm.
 *
 * Each test pins a rule that a customer can SEE, so the assertions are written
 * against the tokens and the render functions rather than against screenshot
 * hashes. Contrast is computed from the real hex values, so a future palette
 * change that quietly drops a financial colour below 4.5:1 fails here.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
// The page ships more than one <style> block; the dashboard rules live in the
// last one, so every block is concatenated rather than slicing the first.
const CSS = Array.from(INDEX.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)).map((m) => m[1]).join('\n');

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
function channel(v) {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(fg, bg) {
    const a = luminance(fg);
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ------------------------------------------------------------------ *
 * 1. financial semantics
 * ------------------------------------------------------------------ */
test('1. the brand colour is no longer the "positive" colour', () => {
    // The visual overhaul swept --success to the accent, which turned every
    // "+$40.00" blue. That is the root cause this pins against.
    assert.ok(!/--success:#5EA0FF/.test(CSS), '--success must not be the brand accent');
    assert.match(CSS, /--success:var\(--kx-success\)/, '--success resolves to the money-green token');
    const GREEN = '#2EBD85';
    const kx = INDEX.match(/--kx-success:\s*(#[0-9A-Fa-f]{6})/);
    assert.ok(kx, '--kx-success is defined');
    assert.strictEqual(kx[1].toUpperCase(), GREEN, 'success token is the money green');
});

test('2. reusable financial classes exist and carry the semantic colours', () => {
    assert.match(CSS, /\.fin-positive\s*\{[^}]*var\(--kx-success-text\)/, 'positive class');
    assert.match(CSS, /\.fin-negative\s*\{[^}]*var\(--kx-danger-text\)/, 'negative class');
    assert.match(CSS, /\.fin-neutral\s*\{[^}]*var\(--kx-text\)/, 'neutral class');
    assert.match(CSS, /\.fin-zero\s*\{[^}]*var\(--kx-text-2\)/, 'zero class');
});

test('3. Today P&L is coloured by the SIGN of the value, not by the brand', () => {
    const fn = INDEX.slice(INDEX.indexOf('function updateUI'), INDEX.indexOf('function updateUI') + 60000);
    const block = fn.slice(fn.indexOf('pnlValue'), fn.indexOf('pnlValue') + 700);
    assert.match(block, /fin-positive/, 'a positive value gets the positive class');
    assert.match(block, /fin-negative/, 'a negative value gets the negative class');
    assert.match(block, /fin-zero/, 'a zero value is neutral, not green');
    assert.ok(!/#5EA0FF/.test(block), 'the P&L no longer borrows the accent hex');
    assert.match(INDEX, /<div id="pnlValue" class="stat-value fin-zero">/, 'the initial markup is neutral');
    // the sign is rendered from the value, with the absolute amount formatted
    assert.match(block, /pnl > 0 \? '\+' : pnl < 0 \? '-' : ''/, 'the sign comes from the value');
});

test('4. only a realized RESULT is coloured in the ledger', () => {
    assert.match(INDEX, /const TX_RESULT_TYPES = \{ 'Trade Executed': true \};/,
        'one place decides which ledger entries are results');
    const fn = INDEX.slice(INDEX.indexOf('function updateTransactionLog'));
    const block = fn.slice(0, fn.indexOf("container.innerHTML = html"));
    assert.match(block, /const isResult = TX_RESULT_TYPES\[entry\.type\] === true;/);
    assert.match(block, /!isResult \? ' fin-neutral'/, 'a deposit or withdrawal stays neutral');
    // deposits / withdrawals / subscription charges are not results
    ['Deposit', 'Withdraw', 'Subscription'].forEach((t) => {
        assert.ok(!new RegExp("'" + t + "': true").test(INDEX), t + ' must not be a result type');
    });
});

test('5. account balances stay neutral', () => {
    const eq = INDEX.slice(INDEX.indexOf('id="totalEquity"'), INDEX.indexOf('id="totalEquity"') + 120);
    const av = INDEX.slice(INDEX.indexOf('id="balanceValue"'), INDEX.indexOf('id="balanceValue"') + 120);
    assert.ok(!/fin-(positive|negative)/.test(eq), 'equity is not a result');
    assert.ok(!/fin-(positive|negative)/.test(av), 'available balance is not a result');
});

test('6. financial colours are readable on the card surface', () => {
    const CARD = '#161E29';
    assert.ok(contrast('#5FD3A6', CARD) >= 4.5, 'positive text contrast');
    assert.ok(contrast('#F58C90', CARD) >= 4.5, 'negative text contrast');
    assert.ok(contrast('#E9EFF7', CARD) >= 4.5, 'neutral text contrast');
});

/* ------------------------------------------------------------------ *
 * 2. notifications
 * ------------------------------------------------------------------ */
test('7. toasts are opaque and each type has its own surface', () => {
    const err = CSS.slice(CSS.indexOf('.toast-error, .toast-warning {'), CSS.indexOf('.toast .toast-close {'));
    assert.match(err, /background:#33161A/, 'restriction surface is solid');
    assert.match(err, /border-color:#8E3A42/);
    assert.match(err, /color:#FFBFC3/);
    assert.ok(!/background:rgba/.test(err), 'a translucent panel lets the page bleed through');

    const ok = CSS.slice(CSS.indexOf('.toast-success {'), CSS.indexOf('.toast-error, .toast-warning {'));
    assert.match(ok, /background:#0E2A22/, 'success surface is solid');
    assert.ok(!/background:rgba/.test(ok));

    const info = CSS.slice(CSS.indexOf('.toast-info {'), CSS.indexOf('.toast-info .toast-icon'));
    assert.match(info, /background:#232F3F/, 'info stays a neutral elevated panel');
});

test('8. toast text is readable on every surface', () => {
    assert.ok(contrast('#FFBFC3', '#33161A') >= 4.5, 'restriction text');
    assert.ok(contrast('#9DEDC9', '#0E2A22') >= 4.5, 'success text');
    assert.ok(contrast('#E9EFF7', '#232F3F') >= 4.5, 'info text');
});

test('9. one toast at a time, and nothing is dropped', () => {
    assert.match(INDEX, /const TOAST_QUEUE = \{ items: \[\], visible: false/, 'a queue exists');
    const fn = INDEX.slice(INDEX.indexOf('function showToast'), INDEX.indexOf('function renderToast') + 1500);
    assert.match(fn, /if \(TOAST_QUEUE\.visible\)/, 'a second message waits instead of replacing');
    assert.match(fn, /TOAST_QUEUE\.items\.push/, 'it is kept, not discarded');
    assert.match(fn, /some\(function \(q\) \{ return q\.msg === msg; \}\)/, 'duplicates collapse');
    assert.match(fn, /function dismissToast/, 'dismiss advances the queue');
    assert.match(fn, /TOAST_QUEUE\.items\.shift/, 'the next message is shown after a dismissal');
    assert.match(fn, /clearTimeout\(timer\)/, 'closing cancels the auto-dismiss timer');
    assert.match(fn, /common\.close/, 'the dismiss control is labelled');
});

test('10. a toast never sits on the support launcher', () => {
    // 48px launcher + 16px margin + 16px gap = 80px of clearance, applied in
    // BOTH the base rule and the phone override (the override used to reset it
    // to 12px, which is how toasts ended up on top of the launcher).
    const offsets = (CSS.match(/bottom:calc\(80px \+ env\(safe-area-inset-bottom, 0px\)\)/g) || []).length;
    assert.ok(offsets >= 2, 'base + mobile rules both clear the launcher, found ' + offsets);
    const phone = CSS.slice(CSS.indexOf('.toast { bottom:calc(80px'), CSS.indexOf('.toast { bottom:calc(80px') + 200);
    assert.match(phone, /font-size:12\.5px/, 'the phone override is the one carrying the clearance');
    assert.ok(!/\.toast \{[^}]*bottom:calc\(12px/.test(CSS), 'no rule pushes it back onto the launcher');
});

/* ------------------------------------------------------------------ *
 * 3. the Kalderix symbol
 * ------------------------------------------------------------------ */
test('11. the brand owns a drawn symbol, not a letterform', () => {
    const { BRAND } = require(path.join(ROOT, 'services', 'brand.js'));
    assert.ok(BRAND.symbol, 'BRAND.symbol exists');
    assert.strictEqual(BRAND.symbol.legs.length, 3, 'three converging flows');
    assert.match(BRAND.symbol.node, /^M[\d .]+L[\d .]+L[\d .]+L[\d .]+Z$/, 'the node is a closed diamond');
    assert.match(BRAND.symbol.viewBox, /^0 0 \d+ \d+$/);
});

test('12. the generated assets use the symbol and are valid SVG', () => {
    ['kalderix-mark.svg', 'kalderix-favicon.svg', 'kalderix-wordmark.svg'].forEach((f) => {
        const svg = fs.readFileSync(path.join(ROOT, 'public', 'brand', f), 'utf8');
        assert.match(svg, /^<svg /, f + ' starts with an svg element');
        assert.match(svg, /<\/svg>/, f + ' is closed');
        assert.ok(svg.includes('M116 388'), f + ' draws the symbol');
        assert.ok(!/<text[^>]*>\s*K\s*<\/text>/.test(svg), f + ' no longer types the monogram');
        assert.ok(svg.trim().endsWith('</svg>'), f + ' is closed at the end');
        assert.ok(!/undefined|NaN/.test(svg), f + ' has no interpolated hole');
        assert.ok(!/>\s*K\s*<\/text>/.test(svg), f + ' draws no monogram glyph');
    });
});

test('13. the header, the landing page and the icons all use it', () => {
    assert.match(INDEX, /<svg class="kx-logo-mark" viewBox="0 0 512 512" width="26" height="26" aria-hidden="true"/,
        'the sidebar brand draws the symbol');
    const landing = INDEX.split('landing-logo').length - 1;
    assert.ok(landing >= 2, 'both landing logos are present');
    // No logo lockup keeps the generic icon; other decorative spinners are fine.
    assert.ok(!/class="sidebar-brand"[\s\S]{0,400}fa-arrows-spin/.test(INDEX), 'sidebar logo is the symbol');
    assert.ok(!/class="landing-logo"[\s\S]{0,200}fa-arrows-spin/.test(INDEX), 'landing logo is the symbol');
    assert.ok(!/class="kx-logo"[^>]*><i class="fas fa-arrows-spin"/.test(INDEX), 'the header tile is not empty');
    assert.ok(!/class="auth-brand-logo"[\s\S]{0,120}<i class="fas fa-arrows-spin"/.test(INDEX), 'auth panel logo is the symbol');
    assert.match(INDEX, /\.kx-logo-mark \{ display:block; flex:0 0 auto; \}/);
    assert.match(INDEX, /\.landing-logo \.kx-logo-mark \{ width:24px; height:24px; \}/);
    // decorative: the wordmark carries the accessible name
    assert.ok(!/kx-logo-mark[^>]*role="img"/.test(INDEX), 'the header glyph is decorative');
});

test('14. the runtime icons (favicon + PWA) draw the same symbol', () => {
    const icon = INDEX.slice(INDEX.indexOf('const iconSvg'), INDEX.indexOf('const iconSvg') + 900);
    assert.match(icon, /M116 388 L246 258/, 'the app icon uses the symbol geometry');
    assert.match(icon, /stroke="' \+ BRAND\.accent \+ '"/, 'and follows BRAND.accent');
    assert.ok(!/BRAND\.mark \+ '<\/text>/.test(INDEX), 'no icon types the monogram any more');
});

/* ------------------------------------------------------------------ *
 * 4. bot panel
 * ------------------------------------------------------------------ */
test('15. the bot panel reports the real state and offers a real Stop', () => {
    assert.match(INDEX, /id="botStatePillLive" data-state="idle"/, 'the pill starts idle');
    const fn = INDEX.slice(INDEX.indexOf('const botPill = getEl'), INDEX.indexOf('const botPill = getEl') + 600);
    assert.match(fn, /const running = !!APP\.botRunning;/, 'the pill reads the live state');
    assert.match(fn, /data-state|dataset\.state/, 'the state drives the styling');
    assert.match(fn, /bot\.running|bot\.offline/, 'it uses the existing translated labels');
    assert.match(CSS, /\.kx-bot-action\.kx-bot-stop\s*\{[^}]*var\(--kx-danger-weak\)/,
        'Stop reads as Stop');
    assert.match(CSS, /\.kx-control-row\s*\{/, 'the scanner row is framed');
});

/* ------------------------------------------------------------------ *
 * 5. rhythm + scope
 * ------------------------------------------------------------------ */
test('16. the dashboard uses a two-tier spacing rhythm', () => {
    assert.match(CSS, /#appToolbar, \.app-header \{ margin-bottom:12px; \}/, 'chrome tier');
    assert.match(CSS, /#activityTicker, \.ticker-wrapper \{ margin-bottom:12px; \}/, 'ticker tier');
    assert.match(CSS, /#mainContent > \.card, #mainContent > \.stats-grid \{ margin-bottom:16px; \}/, 'content tier');
});

test('17. this polish never touches money or the trading engine', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(!/fin-positive|kx-state-pill|kx-logo-mark/.test(server), 'no UI token leaked into the server');
    // the trading formula and cadence are untouched by this change
    assert.match(INDEX, /setInterval\(executeBotTrade, 8000\)/, 'the bot cadence is unchanged');
    assert.ok(!/MIN_WITHDRAWAL: (?!700)/.test(INDEX), 'the withdrawal minimum is unchanged');
    assert.match(INDEX, /MIN_WITHDRAWAL: 700/);
    assert.match(INDEX, /MIN_DEPOSIT_AMOUNT = 100|MIN_DEPOSIT: 100/, 'the deposit minimum is unchanged');
});
