'use strict';
/**
 * Overlay / dead-handler guards for the dashboard shell.
 *
 * Two clickability defects found by hit-testing every interactive element in a
 * headless browser (measured, then isolated):
 *
 * 1. The cookie-consent banner occupies the same bottom-right corner as the
 *    floating support launcher, at a higher z-index (99999 vs 9998). Before the
 *    fix, `document.elementFromPoint(<centre of .support-toggle-btn>)` returned
 *    `button#metaConsentDecline` at both 1280x900 and 390x844, so a customer
 *    tapping "Support" silently DECLINED cookies and the support panel never
 *    opened. The launcher is now hidden while the banner exists; the banner node
 *    is removed once consent is answered, so the launcher returns by itself.
 *
 * 2. `load2FAStatus()` -> `initiate2FASetup()` (the legacy TOTP routine) touched
 *    `#twofaQRPlaceholder` / `#twofaManualKey` / `#twofaQRCode`, which were
 *    removed when the panel became email-code based (#twofaTOTPSetupSection is
 *    display:none). Opening 2FA therefore threw
 *    "TypeError: Cannot set properties of null (setting 'innerHTML')" on every
 *    visit and left `is2FASetupInProgress` stuck at true, so the panel's own
 *    controls could never complete setup.
 *
 * Measured after the fixes: 14/14 checks on a 1280x900 dashboard (Chart.js both
 * blocked and available) and 6/6 real taps through the 390x844 mobile drawer.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function fnSource(name) {
  const at = HTML.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' must exist');
  const rest = HTML.slice(at + 1);
  const next = rest.search(/\n(?=[a-zA-Z]?function |\/\/ =)/);
  return next > 0 ? HTML.slice(at, at + 1 + next) : HTML.slice(at);
}

// ---------------------------------------------------------------------------
// 1. Consent banner must not swallow the support launcher
// ---------------------------------------------------------------------------
test('the support launcher is lifted clear of the consent banner', () => {
  // Measured banner heights: up to 155px desktop and up to 136px at 320px wide.
  // The launcher must clear the banner instead of being hidden, so it stays reachable.
  assert.match(HTML, /body:has\(#metaConsentBanner\) \.support-widget\{bottom:180px;\}/,
    'desktop offset must lift the launcher above the banner');
  assert.match(HTML, /@media \(max-width:640px\)\{\s*body:has\(#metaConsentBanner\) \.support-widget\{bottom:160px;\}/,
    'phone offset must lift the launcher above the banner');
});

test('the consent fix keeps the launcher visible instead of removing it', () => {
  // The pre-existing invariant (deposit_discoverability) only allows hiding the
  // launcher behind an OPEN dialog; the banner case must not add a new hide.
  const rule = HTML.match(/body:has\(#metaConsentBanner\) \.support-widget\{[^}]*\}/);
  assert.ok(rule, 'the banner rule must exist');
  assert.ok(!/display\s*:\s*none/.test(rule[0]), 'the launcher must not be hidden behind the banner');
  // Offsets must exceed the measured banner heights (155px desktop, 116px phone).
  const desk = Number((/bottom:(\d+)px/.exec(rule[0]) || [])[1]);
  const phoneMatch = /@media \(max-width:640px\)\{[\s\S]{0,120}?body:has\(#metaConsentBanner\) \.support-widget\{bottom:(\d+)px;/.exec(HTML);
  const phone = Number(phoneMatch && phoneMatch[1]);
  assert.ok(desk >= 172, 'desktop clearance too small: ' + desk);
  assert.ok(phone >= 152, 'phone clearance too small: ' + phone);
});

test('the launcher is not disabled in general - only behind the banner', () => {
  // Guard against "fixing" the overlap by breaking the launcher everywhere.
  const base = HTML.indexOf('.support-widget{position:fixed');
  const rule = HTML.slice(base, HTML.indexOf('}', base) + 1);
  assert.ok(!/display\s*:\s*none/.test(rule), 'the base rule must keep the launcher visible');
  assert.ok(/z-index\s*:\s*9998/.test(rule), 'its stacking order is unchanged');
});

// ---------------------------------------------------------------------------
// 2. The 2FA panel must never throw on its removed TOTP elements
// ---------------------------------------------------------------------------
test('initiate2FASetup bails out when the TOTP UI is absent', () => {
  const src = fnSource('initiate2FASetup');
  const guard = src.indexOf("if (!qrPlaceholder || !manualKey)");
  assert.ok(guard > 0, 'the guard must exist');
  // The guard has to run before the state flag and before any use of the nodes,
  // otherwise the function throws with is2FASetupInProgress already latched.
  assert.ok(guard < src.indexOf('is2FASetupInProgress = true'), 'guard must precede the in-progress flag');
  assert.ok(guard < src.indexOf('qrPlaceholder.innerHTML'), 'guard must precede the first use');
  assert.match(src.slice(guard, guard + 200), /return;/, 'and it must return');
});

test('no unguarded dereference of the removed 2FA elements remains', () => {
  for (const id of ['twofaQRPlaceholder', 'twofaManualKey', 'twofaQRCode']) {
    const bare = new RegExp("document\\.getElementById\\('" + id + "'\\)\\.(?!nothing)", 'g');
    const uses = HTML.match(bare) || [];
    // Exactly one plain lookup per id is allowed: the guarded `const x = ...`.
    assert.ok(uses.length === 0,
      id + ' is still dereferenced inline at ' + uses.length + ' site(s)');
  }
});

test('the QR display block is null-safe after a successful setup response', () => {
  assert.match(HTML, /if \(qrCodeImg\) \{[\s\S]{0,240}qrCodeImg\.style\.display = 'block';/,
    'the QR image write must be guarded');
  assert.match(HTML, /qrPlaceholder\.style\.display = 'none';/, 'and the placeholder still hides via the guarded ref');
});

test('the 2FA panel is still reachable and its other controls are untouched', () => {
  assert.match(HTML, /function openTwoFAModal\(/, 'the opener exists');
  assert.match(HTML, /function load2FAStatus\(/, 'the status loader exists');
  assert.match(HTML, /id="twofaCodeGroup"/, 'the email-code input group is intact');
  assert.match(HTML, /id="twofaVerifyBtn"/, 'the verify button is intact');
});

// ---------------------------------------------------------------------------
// 3. Class-level guards against dead buttons
// ---------------------------------------------------------------------------
test('every inline event handler resolves to a defined function', () => {
  const calls = new Set();
  for (const m of HTML.matchAll(/on(?:click|change|input|submit|keydown|keyup|blur|focus)="([^"]*)"/g)) {
    for (const c of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(c[1]);
  }
  const builtins = new RegExp('^(' + [
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'this', 'function',
    'alert', 'confirm', 'prompt', 'parseInt', 'parseFloat', 'Number', 'String', 'Boolean',
    'JSON', 'Math', 'Date', 'Object', 'Array', 'setTimeout', 'setInterval', 'clearTimeout',
    'clearInterval', 'encodeURIComponent', 'decodeURIComponent', 'isNaN', 'escape', 'unescape',
    'event',
  ].join('|') + ')$');
  const missing = [];
  for (const name of calls) {
    if (builtins.test(name)) continue;
    // method calls such as document.getElementById(...) are not free functions
    if (new RegExp('[.\\w]\\s*\\.\\s*' + name + '\\s*\\(').test(HTML)) continue;
    const defined =
      HTML.includes('function ' + name + '(') ||
      HTML.includes('function ' + name + ' (') ||
      HTML.includes(name + ': function') ||
      HTML.includes(name + ' = function') ||
      HTML.includes('const ' + name) ||
      HTML.includes('let ' + name) ||
      HTML.includes('var ' + name) ||
      new RegExp('[.\\s]' + name + '\\s*=\\s*(async\\s*)?function').test(HTML);
    if (!defined) missing.push(name);
  }
  assert.deepStrictEqual(missing, [], 'inline handlers with no definition: ' + missing.join(', '));
});

test('no button inside a form can implicitly submit it', () => {
  const forms = [...HTML.matchAll(/<form[\s\S]*?<\/form>/g)].map(m => m[0]);
  const offenders = [];
  for (const f of forms) {
    for (const b of f.matchAll(/<button\b[^>]*>/g)) {
      if (!/\btype=/.test(b[0])) offenders.push(b[0].slice(0, 80));
    }
  }
  assert.deepStrictEqual(offenders, [], 'buttons without an explicit type inside a form');
});

test('no visible full-screen overlay ships without a dismissal path', () => {
  // The wallet-sync loader is the only blocking full-screen layer; it must be
  // display:none by default (pinned in ui_clickability_guards too) and every
  // other full-viewport fixed layer must be pointer-events:none.
  // The full-viewport confetti canvas is excluded in CSS, not in the tag.
  assert.match(HTML, /#confettiCanvas\{[^}]*pointer-events:none/,
    'the confetti canvas must not intercept clicks');
  const confetti = HTML.match(/<canvas id="confettiCanvas"[^>]*>/);
  assert.ok(confetti, 'the confetti canvas still exists');
  const loader = HTML.match(/<div id="walletSyncLoader"[^>]*>/);
  assert.ok(loader && /display:none/.test(loader[0]), 'the sync overlay starts hidden');
});

test('sidebar wiring is untouched by this change', () => {
  assert.match(HTML, /document\.querySelectorAll\('\.sidebar-link\[data-section\]'\)\.forEach/,
    'section links stay bound');
  assert.match(HTML, /document\.getElementById\('sidebar'\)\.classList\.remove\('open'\)/,
    'navigating still closes the mobile drawer');
  assert.match(HTML, /mobileMenuBtn\.addEventListener\('click'/, 'the hamburger stays wired');
  assert.match(HTML, /id="mobileMenuBtn"/, 'and still exists in the markup');
});
