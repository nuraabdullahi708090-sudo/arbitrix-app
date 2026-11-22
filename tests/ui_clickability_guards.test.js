'use strict';
/**
 * Clickability guards for the dashboard shell.
 *
 * REPORTED: sidebar links and other buttons did not respond to clicks.
 *
 * ROOT CAUSE (reproduced in a headless browser, no source change needed to
 * observe it): `initApp()` makes the wallet-sync overlay visible, then runs a
 * long synchronous block (loadData, save-mode wiring, initTicker, initChart,
 * updateSupportLinks, ...) BEFORE the try/finally that hides it. `initChart()`
 * calls `new Chart(...)` on the Chart.js global, which is loaded from
 * cdn.jsdelivr.net. When that script is unavailable - ad-blocker, privacy
 * extension, corporate firewall, offline device, CDN outage - `initChart()`
 * threw `ReferenceError: Chart is not defined`, aborting `initApp()` before the
 * finally. `#walletSyncLoader` (position:fixed; inset:0; z-index:9999;
 * rgba(...,0.9); pointer-events:auto) stayed displayed, covering the viewport
 * and intercepting every pointer event: all 12 sidebar links measured as
 * blocked by `div#walletSyncLoader`.
 *
 * Measured, pre-fix: 2 of 8 functional checks passed. Post-fix: 8 of 8, and
 * 6 of 6 on a 390px viewport with the drawer open.
 *
 * These tests pin the two properties that keep the shell clickable, so a
 * refactor cannot silently reintroduce a permanently blocking overlay.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const idx = (needle) => {
  const at = HTML.indexOf(needle);
  assert.ok(at > 0, 'expected to find: ' + needle);
  return at;
};

function fnSource(name) {
  const at = HTML.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' must exist');
  // Bound by the next top-level "function " declaration at column 0.
  const rest = HTML.slice(at + 1);
  const next = rest.search(/\n(?=[a-zA-Z]?function |\/\/ =)/);
  return next > 0 ? HTML.slice(at, at + 1 + next) : HTML.slice(at);
}

const INIT_CHART = fnSource('initChart');
const INIT_APP = fnSource('initApp');

// ---------------------------------------------------------------------------
// 1. The specific root cause: a third-party global may not exist
// ---------------------------------------------------------------------------
test('initChart guards the Chart.js global before constructing a chart', () => {
  const guard = INIT_CHART.indexOf("typeof Chart === 'undefined'");
  // Match the CALL SITE, not the prose in the comment above it.
  const construct = INIT_CHART.indexOf('= new Chart(');
  assert.ok(guard > 0, 'the guard must exist');
  assert.ok(construct > guard, 'the guard must precede new Chart(...)');
  assert.match(INIT_CHART, /if \(typeof Chart === 'undefined'\) \{[\s\S]{0,320}return;/,
    'a missing library returns early instead of throwing');
  assert.match(INIT_CHART, /console\.warn\(/, 'the degradation is reported, not silent');
});

test('every chart consumer tolerates a missing chart instance', () => {
  // With the early return, APP.chartInstance stays null; the update paths must
  // not assume it exists or the same class of abort returns via another route.
  assert.match(HTML, /if\(!APP\.chartInstance\) return;/, 'the update path guards null');
  const guarded = HTML.match(/if\(APP\.chartInstance\) \{/g) || [];
  assert.ok(guarded.length >= 2, 'the remaining update paths guard null');
  assert.ok(!/APP\.chartInstance\.data(?!\s*[.=])/.test(HTML.replace(/if\(APP\.chartInstance\) \{[\s\S]{0,200}?\}/g, '')),
    'no unguarded chartInstance dereference outside a guard');
});

// ---------------------------------------------------------------------------
// 2. The structural cause: initApp must always dismiss the overlay
// ---------------------------------------------------------------------------
// All ordering checks are relative to the initApp() source, never to the file:
// earlier functions in this 29k-line page also contain try/finally blocks.
const inInit = (needle, from = 0) => {
  const at = INIT_APP.indexOf(needle, from);
  assert.ok(at > 0, 'initApp must contain: ' + needle);
  return at;
};

test('initApp hides the loader in a finally, not only on the happy path', () => {
  const finallyAt = inInit('} finally {');
  const hide = inInit("if (syncLoader) syncLoader.style.display = 'none';", finallyAt);
  assert.ok(hide > finallyAt, 'the dismissal lives inside the finally block');
});

test('the synchronous init that runs before the finally is itself guarded', () => {
  const show = inInit("if (syncLoader) syncLoader.style.display = 'flex';");
  const guardStart = inInit('try {', show);
  assert.ok(guardStart > show, 'a try block starts after the overlay is shown');
  assert.ok(guardStart < inInit('loadData();'), 'it wraps the synchronous init');
  const catchAt = inInit('} catch (initError) {', guardStart);
  const finallyAt = inInit('} finally {', catchAt);
  assert.ok(catchAt > guardStart, 'the synchronous init has a catch');
  assert.ok(catchAt < finallyAt, 'and the catch precedes the finally that dismisses the overlay');
  assert.match(INIT_APP.slice(catchAt, catchAt + 400), /console\.error\('\[initApp\] non-fatal init error/,
    'the failure is reported without aborting init');
});

test('showing and hiding the overlay are a single matched pair', () => {
  const shows = HTML.match(/syncLoader\.style\.display = 'flex'/g) || [];
  const hides = HTML.match(/syncLoader\.style\.display = 'none'/g) || [];
  assert.strictEqual(shows.length, 1, 'exactly one place shows the blocking overlay');
  assert.strictEqual(hides.length, 1, 'exactly one place hides it');
});

test('the overlay is display:none by default so it can never block an idle page', () => {
  const at = idx('id="walletSyncLoader"');
  const tag = HTML.slice(at - 200, HTML.indexOf('>', at) + 1);
  assert.match(tag, /display\s*:\s*none/, 'hidden in its own inline style');
  assert.match(tag, /z-index\s*:\s*9999/, 'and still above the shell when shown');
  // No !important pointer-events rule may re-enable it while hidden.
  assert.ok(!/#walletSyncLoader[^{]*\{[^}]*pointer-events\s*:\s*auto/.test(HTML), 'no forced pointer-events rule');
});

// ---------------------------------------------------------------------------
// 3. The shell itself stays intact
// ---------------------------------------------------------------------------
test('sidebar navigation is intact and wired', () => {
  const links = HTML.match(/class="sidebar-link[^"]*"/g) || [];
  assert.ok(links.length >= 10, 'sidebar links still exist (' + links.length + ')');
  const sections = (HTML.match(/data-section="/g) || []).length;
  assert.ok(sections >= 4, 'section links are still declared (' + sections + ')');
  // The router is bound with addEventListener at startup (not inline onclick),
  // which is exactly why an aborted initApp() left the links dead.
  assert.match(HTML, /document\.querySelectorAll\('\.sidebar-link\[data-section\]'\)\.forEach/,
    'the data-section links are bound');
  assert.match(HTML, /addEventListener\('click', function\(e\) \{\s*\n\s*e\.preventDefault\(\);/,
    'each bound link navigates on click');
  assert.match(HTML, /const el = document\.getElementById\(link\.dataset\.section\);/,
    'navigation targets the declared section');
});

test('the wallet-sync refresh escape hatch is still wired', () => {
  // The 8s watchdog prompt is the user's only manual recovery if the sync
  // itself never settles; it must keep working.
  assert.match(HTML, /walletSyncSlowPrompt\.style\.display = 'flex'/, 'the prompt still appears');
  assert.match(HTML, /walletSyncRefreshBtn\.onclick = function \(\) \{ location\.reload\(\); \}/,
    'and its button still reloads');
});

test('initApp delegates chart setup instead of touching the library itself', () => {
  // initApp must call initChart() (guarded) rather than constructing charts or
  // reaching for a CDN global inside its own synchronous body.
  assert.match(INIT_APP, /\binitChart\(\);/, 'chart setup goes through the guarded helper');
  assert.ok(!/= new Chart\(/.test(INIT_APP), 'initApp never constructs a chart directly');
  assert.ok(!/TradingView/.test(INIT_APP), 'initApp never touches the other CDN global directly');
});
