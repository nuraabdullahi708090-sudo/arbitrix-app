'use strict';
/**
 * Clipboard reliability.
 *
 * The shipped copy handlers used to fire `navigator.clipboard.writeText(...)`
 * without awaiting it and then show the success toast immediately, so:
 *   - the "copied" confirmation appeared even when the write later failed
 *     (permission denied, document not focused, insecure origin, in-app webview);
 *   - on browsers without `navigator.clipboard` the handler threw and showed
 *     NOTHING at all (a silent dead button);
 *   - rejections surfaced as unhandled promise rejections.
 *
 * These tests run the REAL helper and the REAL click handlers extracted from
 * public/index.html in a vm sandbox with a fake DOM, so the behaviour under test
 * is the shipping code, not a re-implementation.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// Extraction of the shipping code under test
// ---------------------------------------------------------------------------

function helperSource() {
  const start = html.indexOf('async function copyTextToClipboard(text)');
  const end = html.indexOf('function copyWalletAddress()', start);
  assert.ok(start > 0 && end > start,
    'copyTextToClipboard must exist in public/index.html (the shared clipboard helper)');
  return html.slice(start, end);
}

/** The real `addEventListener('click', ...)` block for a button id. */
function handlerSource(varName) {
  const start = html.indexOf('const ' + varName + " = getEl('");
  assert.ok(start > 0, 'handler block for ' + varName + ' not found');
  const end = html.indexOf('\n    });', start);
  assert.ok(end > start, 'handler block for ' + varName + ' is not terminated');
  return html.slice(start, end + '\n    });'.length);
}

const HANDLERS = {
  copyReferralBtn: 'copyReferralBtn',
  copyReferralLinkBtn: 'copyReferralLinkBtn',
  copyLiveAddressBtn: 'copyLiveAddressBtn',
};

function handlersSource() {
  return Object.keys(HANDLERS).map(handlerSource).join('\n');
}

function sliceFunction(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start > 0, name + ' must exist');
  // walk braces so the whole function body is captured
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

function makeEnv(opts) {
  const o = opts || {};
  const toasts = [];
  const clipboardWrites = [];
  const focusCalls = [];

  const elements = {};
  const makeEl = (id) => {
    const el = {
      id,
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      click() { return this.listeners.click && this.listeners.click[0](); },
      focus() { focusCalls.push(id); },
      textContent: o.textByElement && o.textByElement[id] !== undefined ? o.textByElement[id] : '',
    };
    elements[id] = el;
    return el;
  };

  const bodyChildren = [];
  const document = {
    activeElement: makeEl('__active'),
    execCommand: o.execCommand,          // undefined in the "no fallback" case
    createElement() {
      const t = {
        value: '',
        style: {},
        parentNode: null,
        setAttribute() {},
        select() { t.selected = true; },
        setSelectionRange() { t.rangeSet = true; },
      };
      return t;
    },
    body: {
      appendChild(node) { node.parentNode = document.body; bodyChildren.push(node); },
      removeChild(node) { const i = bodyChildren.indexOf(node); if (i !== -1) bodyChildren.splice(i, 1); node.parentNode = null; },
    },
    getElementById(id) { return elements[id] || null; },
  };

  const window = {
    isSecureContext: o.isSecureContext !== undefined ? o.isSecureContext : true,
    getSelection: () => ({ rangeCount: 0, getRangeAt() { return null; }, removeAllRanges() {}, addRange() {} }),
  };

  const writeText = o.writeText || (o.clipboard ? undefined : null);
  const navigator = {
    clipboard: o.noClipboardApi ? undefined : { writeText: writeText || ((v) => { clipboardWrites.push(v); return Promise.resolve(); }) },
  };

  const sandbox = {
    console: { error() {}, warn() {}, log() {} },
    window, document, navigator,
    setTimeout, clearTimeout, Promise, JSON, String, Number, Boolean, Object, Array, Math, Error, Date,
    showToast(msg, type) { toasts.push({ msg, type }); },
    t: (key) => key,
    getEl(id) { return elements[id] || makeEl(id); },
    APP: { referralCode: o.referralCode },
    getReferralLink: () => o.referralLink || 'https://kalderix.example/signup?ref=CODE01',
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(helperSource() + '\n' + handlersSource(), sandbox);

  return { sandbox, toasts, clipboardWrites, bodyChildren, focusCalls, elements, getEl: (id) => sandbox.getEl(id) };
}

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// ---------------------------------------------------------------------------
// 1-7: the helper contract
// ---------------------------------------------------------------------------

test('1. a successful write resolves true and records the exact text', async () => {
  const env = makeEnv({});
  const ok = await env.sandbox.copyTextToClipboard('ARBI-TEST01');
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(env.clipboardWrites, ['ARBI-TEST01']);
});

test('2. success is reported only AFTER the clipboard promise resolves', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const env = makeEnv({ writeText: () => pending });
  const btn = env.getEl('copyReferralBtn');
  env.sandbox.APP.referralCode = 'ARBI-TEST01';

  const click = btn.click();               // do not await: inspect mid-flight state
  await settle();
  assert.deepStrictEqual(env.toasts, [],
    'no toast may be shown while the clipboard write is still pending');

  release();
  await click;
  await settle();
  assert.deepStrictEqual(env.toasts, [{ msg: 'common.codeCopied', type: 'success' }],
    'the success toast must appear once the write resolves');
});

test('3. a rejected write without a working fallback resolves false and reports failure', async () => {
  const env = makeEnv({ writeText: () => Promise.reject(new DOMExceptionLike('denied')) , execCommand: undefined });
  const ok = await env.sandbox.copyTextToClipboard('ARBI-TEST01');
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(env.toasts, [], 'the helper itself never toasts');
});

test('4. a missing clipboard API falls back to execCommand', async () => {
  const viaFallback = makeEnv({ noClipboardApi: true, execCommand: () => true });
  assert.strictEqual(await viaFallback.sandbox.copyTextToClipboard('code'), true,
    'legacy path must succeed when execCommand returns true');

  const noFallback = makeEnv({ noClipboardApi: true, execCommand: undefined });
  assert.strictEqual(await noFallback.sandbox.copyTextToClipboard('code'), false,
    'with neither API the helper must report failure, not throw');
});

test('5. a rejected write still succeeds through the fallback', async () => {
  const env = makeEnv({ writeText: () => Promise.reject(new Error('NotAllowedError')), execCommand: () => true });
  assert.strictEqual(await env.sandbox.copyTextToClipboard('ARBI-TEST01'), true);
});

test('6. fallback failure resolves false', async () => {
  const env = makeEnv({ writeText: () => Promise.reject(new Error('NotAllowedError')), execCommand: () => false });
  assert.strictEqual(await env.sandbox.copyTextToClipboard('ARBI-TEST01'), false);
});

test('7. the fallback textarea is always cleaned up and focus is restored', async () => {
  const env = makeEnv({ noClipboardApi: true, execCommand: () => true });
  await env.sandbox.copyTextToClipboard('ARBI-TEST01');
  assert.strictEqual(env.bodyChildren.length, 0, 'the temporary textarea must be removed');
  assert.deepStrictEqual(env.focusCalls, ['__active'], 'focus must return to the previously active element');

  const failing = makeEnv({ noClipboardApi: true, execCommand: () => { throw new Error('boom'); } });
  assert.strictEqual(await failing.sandbox.copyTextToClipboard('x'), false);
  assert.strictEqual(failing.bodyChildren.length, 0, 'cleanup must also run when execCommand throws');
});

test('7b. an insecure context skips the async API and uses the fallback', async () => {
  const env = makeEnv({ isSecureContext: false, execCommand: () => true });
  assert.strictEqual(await env.sandbox.copyTextToClipboard('x'), true);
  assert.deepStrictEqual(env.clipboardWrites, [], 'writeText must not be attempted on an insecure origin');
});

test('7c. empty/absent text never writes and never succeeds', async () => {
  const env = makeEnv({ execCommand: () => true });
  assert.strictEqual(await env.sandbox.copyTextToClipboard(''), false);
  assert.strictEqual(await env.sandbox.copyTextToClipboard(null), false);
  assert.deepStrictEqual(env.clipboardWrites, []);
  assert.deepStrictEqual(env.bodyChildren, []);
});

// ---------------------------------------------------------------------------
// 8-10: the real referral / address handlers
// ---------------------------------------------------------------------------

test('8. the referral CODE button copies the code and confirms', async () => {
  const env = makeEnv({ referralCode: 'ARBI-TEST01' });
  await env.getEl('copyReferralBtn').click();
  assert.deepStrictEqual(env.clipboardWrites, ['ARBI-TEST01']);
  assert.deepStrictEqual(env.toasts, [{ msg: 'common.codeCopied', type: 'success' }]);
});

test('8b. the referral code button reports failure instead of a false success', async () => {
  const env = makeEnv({ referralCode: 'ARBI-TEST01',
    writeText: () => Promise.reject(new Error('NotAllowedError')), execCommand: () => false });
  await env.getEl('copyReferralBtn').click();
  assert.deepStrictEqual(env.toasts, [{ msg: 'common.copyFailed', type: 'error' }]);
  assert.ok(!env.toasts.some((x) => x.type === 'success'), 'no success toast on failure');
});

test('8c. the referral code button never claims success while the code is still loading', async () => {
  const env = makeEnv({ referralCode: '' });
  await env.getEl('copyReferralBtn').click();
  assert.deepStrictEqual(env.toasts, [{ msg: 'referral.codeLoading', type: 'info' }]);
  assert.deepStrictEqual(env.clipboardWrites, []);
});

test('9. the referral LINK button copies the link and confirms', async () => {
  const env = makeEnv({ referralLink: 'https://kalderix.example/signup?ref=CODE01' });
  await env.getEl('copyReferralLinkBtn').click();
  assert.deepStrictEqual(env.clipboardWrites, ['https://kalderix.example/signup?ref=CODE01']);
  assert.deepStrictEqual(env.toasts, [{ msg: 'common.linkCopied', type: 'success' }]);
});

test('9b. the referral link button reports failure when neither API works', async () => {
  const env = makeEnv({ noClipboardApi: true, execCommand: undefined });
  await env.getEl('copyReferralLinkBtn').click();
  assert.deepStrictEqual(env.toasts, [{ msg: 'common.copyFailed', type: 'error' }]);
});

test('9c. the live wallet address button copies and confirms / reports failure', async () => {
  const ok = makeEnv({ textByElement: { liveWalletAddress: 'TXyz123' } });
  await ok.getEl('copyLiveAddressBtn').click();
  assert.deepStrictEqual(ok.clipboardWrites, ['TXyz123']);
  assert.deepStrictEqual(ok.toasts, [{ msg: 'common.addressCopied', type: 'success' }]);

  const bad = makeEnv({ textByElement: { liveWalletAddress: 'TXyz123' }, noClipboardApi: true, execCommand: null });
  await bad.getEl('copyLiveAddressBtn').click();
  assert.deepStrictEqual(bad.toasts, [{ msg: 'common.copyFailed', type: 'error' }]);
});

test('10. repeated attempts: every click copies and reports its own outcome', async () => {
  let mode = 'ok';
  let attempts = 0;
  const env = makeEnv({ referralCode: 'ARBI-TEST01',
    writeText: () => { attempts++; return mode === 'ok' ? Promise.resolve() : Promise.reject(new Error('denied')); } });
  env.sandbox.document.execCommand = () => false;   // no rescue via the fallback

  await env.getEl('copyReferralBtn').click();
  await env.getEl('copyReferralBtn').click();
  mode = 'fail';
  await env.getEl('copyReferralBtn').click();
  mode = 'ok';
  await env.getEl('copyReferralBtn').click();

  assert.strictEqual(attempts, 4, 'each click attempts a copy');
  assert.deepStrictEqual(env.toasts.map((x) => x.type), ['success', 'success', 'error', 'success'],
    'the failure is reported as a failure and the next success still succeeds');
});

// ---------------------------------------------------------------------------
// 11-12: the neighbouring fixes are untouched
// ---------------------------------------------------------------------------

test('11. the PR #197 startup fix is intact', () => {
  assert.strictEqual((html.match(/function currentCachedUser\(/g) || []).length, 1,
    'the null-safe currentCachedUser helper must still exist exactly once');
  assert.strictEqual((html.match(/optional onboarding step failed/g) || []).length, 1,
    'onboarding must still sit in its own error boundary');
  const helper = helperSource();
  assert.ok(!/currentCachedUser|maybeShowOnboardingForCurrentUser/.test(helper),
    'the clipboard work must not touch startup wiring');
});

test('12. the PR #198 notification-panel fix is intact', () => {
  assert.match(html, /\.notification-panel\{position:absolute;top:calc\(100% \+ 8px\);right:0;left:auto;bottom:auto;width:min\(92vw,360px\)/,
    'the mobile notification-panel rule must still anchor to its bell');
  const clipDiffRegion = html.slice(html.indexOf('async function copyTextToClipboard'),
    html.indexOf('function copyWalletAddress()'));
  assert.ok(!/notification-panel|backdrop-filter/.test(clipDiffRegion),
    'the clipboard helper must not touch the notification panel');
});

// ---------------------------------------------------------------------------
// The pre-fix pattern must stay gone
// ---------------------------------------------------------------------------

test('13. no handler calls navigator.clipboard directly (the helper is the only place)', () => {
  const helper = helperSource();
  const directCalls = html.split('navigator.clipboard').length - 1
    - (helper.split('navigator.clipboard').length - 1);
  assert.strictEqual(directCalls, 0,
    'every clipboard write must go through copyTextToClipboard so it can be awaited (' +
    directCalls + ' direct call(s) remain)');

  // and no handler may toast success immediately after a fire-and-forget write
  assert.ok(!/navigator\.clipboard\.writeText\([^)]*\);\s*\n\s*showToast/.test(html),
    'a write followed immediately by a toast is the pre-fix false-success bug');
});

test('14. the old fire-and-forget handlers are gone', () => {
  for (const block of ['copyReferralBtn', 'copyReferralLinkBtn', 'copyLiveAddressBtn']) {
    const src = handlerSource(block);
    assert.match(src, /await copyTextToClipboard/, block + ' must await the shared helper');
    assert.ok(!/navigator\.clipboard/.test(src), block + ' must not touch the clipboard API directly');
    assert.ok(!/showToast\(t\('(?:common\.codeCopied|common\.linkCopied|common\.addressCopied)'\),\s*'success'\)/.test(src),
      block + ' must choose the toast from the copy result, not unconditionally');
  }
});

// ---------------------------------------------------------------------------
// copy feedback copy: every locale has the new failure message
// ---------------------------------------------------------------------------

test('every locale ships a copyFailed message and no locale lost a copy message', () => {
  const locales = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
  const failed = html.match(/'common\.copyFailed':\s*'([^']+)'/g) || [];
  assert.strictEqual(failed.length, 6, 'one common.copyFailed per locale');
  for (const key of ['common.codeCopied', 'common.linkCopied', 'common.addressCopied',
    'deposit.copyAddressFailed', 'deposit.copyAmountFailed', 'deposit.copyInvoiceRefFailed']) {
    const hits = html.match(new RegExp("'" + key.replace('.', '\\.') + "':", 'g')) || [];
    assert.ok(hits.length >= 6, key + ' must still be defined in all locales');
  }
  // the failure copy is a plain instruction, not a fake confirmation
  const en = /'common\.copyFailed':\s*'([^']+)'/.exec(html);
  assert.match(en[1], /copy failed/i);
  assert.ok(!/✅|copied to clipboard/i.test(en[1]), 'the failure message must not claim success');
  assert.strictEqual(locales.length, 6);
});

// small helper used above for a realistic rejection value
function DOMExceptionLike(name) {
  const e = new Error(name);
  e.name = name;
  return e;
}
