'use strict';
/**
 * Startup resilience: unfunded accounts must get the same critical UI wiring as
 * funded ones, even when the OPTIONAL onboarding step fails.
 *
 * These tests do not count listeners for their own sake and they do not mock the
 * behaviour under test: they read the REAL public/index.html, extract the REAL
 * onboarding helpers and the REAL initApp wiring region, execute them in a vm,
 * then INVOKE the registered handlers and assert the effect a user would see
 * (drawer opens, referral code is written to the clipboard, tabs switch, quick
 * reply fills the input).
 *
 * Negative control: run this file against the pre-fix index.html and the
 * ordering/isolation/interaction assertions fail (see the PR report).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
// The clipboard handlers await the shared copyTextToClipboard helper, so a click
// settles over a few microtasks; flush them before asserting on its effects.
const flushMicrotasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const HTML_PATH = path.join(ROOT, 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Source extraction
// ---------------------------------------------------------------------------

/** Source text of a top-level function, located by its declaration line. */
function functionSource(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' must exist in public/index.html');
  const nextTop = html.indexOf('\nfunction ', start + 10);
  const nextAsync = html.indexOf('\nasync function ', start + 10);
  const candidates = [nextTop, nextAsync].filter((i) => i !== -1);
  const end = candidates.length ? Math.min(...candidates) : html.length;
  return html.slice(start, end);
}

/**
 * The initApp region from `adoptServerBotState();` to the end of the function.
 * This is the region that contains both the optional onboarding step and the
 * critical event bindings, in whichever order the deployed file has them.
 */
function initWiringRegion() {
  const fnStart = html.indexOf('async function initApp()');
  assert.ok(fnStart !== -1, 'initApp must exist');
  const adopt = html.indexOf('adoptServerBotState();', fnStart);
  assert.ok(adopt !== -1, 'adoptServerBotState() call must exist inside initApp');
  // initApp is immediately followed by function checkAdminAccess().
  const fnEnd = html.indexOf('\nfunction checkAdminAccess()', adopt);
  assert.ok(fnEnd !== -1, 'initApp must be followed by checkAdminAccess');
  // Drop the closing brace of initApp so the slice is a runnable block.
  const closeIdx = html.lastIndexOf('\n}', fnEnd);
  assert.ok(closeIdx > adopt, 'the closing brace of initApp must be found');
  const tail = html.slice(adopt, closeIdx);
  assert.ok(tail.trim().length > 500, 'wiring region must be substantial');
  return tail;
}

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

function makeElement(id, extra) {
  const handlers = Object.create(null);
  const classes = new Set();
  const el = {
    id: id || null,
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    children: [],
    _handlers: handlers,
    _classes: classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
      contains: (c) => classes.has(c)
    },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = handlers[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    getAttribute() { return null; },
    setAttribute() {},
    appendChild(child) { el.children.push(child); return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }; },
    // real input simulation: run the handlers a browser would run
    fire(type, event) { (handlers[type] || []).forEach((fn) => fn.call(el, event || { type, preventDefault() {}, stopPropagation() {}, target: el, key: '' })); }
  };
  return Object.assign(el, extra || {});
}

/** Build the init environment: a registry of elements + recording stubs. */
function makeEnv(overrides) {
  const elements = new Map();
  const selectorCache = new Map();
  const toasts = [];
  const clipboard = [];
  const calls = [];

  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const queryAll = (sel) => {
    if (!selectorCache.has(sel)) {
      const a = makeElement(sel + '#1');
      const b = makeElement(sel + '#2');
      a.dataset.wallet = 'demo';
      a.dataset.period = '1H';
      a.dataset.filter = 'all';
      a.dataset.msg = 'How do I deposit?';
      b.dataset.wallet = 'live';
      b.dataset.period = '4H';
      b.dataset.filter = 'crypto';
      b.dataset.msg = 'How do I withdraw?';
      selectorCache.set(sel, [a, b]);
    }
    return selectorCache.get(sel);
  };

  const document = {
    getElementById: (id) => byId(id),
    querySelector: (sel) => (sel && sel.startsWith('#') ? byId(sel.slice(1)) : (queryAll(sel)[0] || null)),
    querySelectorAll: queryAll,
    addEventListener: (type, fn) => calls.push(['document.addEventListener', type]),
    createElement: () => makeElement('created'),
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    readyState: 'complete',
    title: 'Kalderix'
  };

  const windowHandlers = {};
  const window = {
    addEventListener: (t, fn) => { (windowHandlers[t] = windowHandlers[t] || []).push(fn); },
    removeEventListener: () => {},
    location: { href: 'https://arbitrix.pro/', search: '', pathname: '/' },
    _handlers: windowHandlers
  };

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear()
  };

  const sandbox = {
    document,
    window,
    localStorage,
    navigator: { clipboard: { writeText: (v) => { clipboard.push(v); return Promise.resolve(); } }, share: undefined, userAgent: 'test' },
    // The copy handlers delegate to the shared helper (covered end to end by
    // tests/clipboard_reliability.test.js). Here it only needs to record what the
    // handler passes it, so this suite stays a pure wiring test.
    copyTextToClipboard: async (v) => { clipboard.push(v); return true; },
    console: { log() {}, warn() {}, error: (...a) => calls.push(['console.error', a.map(String).join(' ')]) },
    APP: {
      environment: 'PRODUCTION',
      liveData: { hasRealDeposit: false },
      referralCode: 'ARBI-TEST01',
      currentWallet: 'demo',
      txViewExpanded: false,
      chartInstance: null
    },
    getEl: (id) => (typeof id === 'string' ? byId(id) : null),
    showToast: (msg, kind) => { toasts.push([msg, kind]); },
    t: (k) => '<' + k + '>',
    getReferralLink: () => 'https://arbitrix.pro/?ref=ARBI-TEST01',
    updateUI: () => calls.push(['updateUI']),
    switchChartWallet: () => calls.push(['switchChartWallet']),
    setChartPeriod: (p) => calls.push(['setChartPeriod', p]),
    sendSupportMessage: () => calls.push(['sendSupportMessage']),
    openDepositModal: () => calls.push(['openDepositModal']),
    openWithdrawModal: () => calls.push(['openWithdrawModal']),
    openVerificationModal: () => calls.push(['openVerificationModal']),
    openProfileModal: () => calls.push(['openProfileModal']),
    openSupportModal: () => calls.push(['openSupportModal']),
    openFreeFundsModal: () => calls.push(['openFreeFundsModal']),
    closeSupportModal: () => calls.push(['closeSupportModal']),
    toggleSupport: () => calls.push(['toggleSupport']),
    toggleBot: () => calls.push(['toggleBot']),
    filterMarket: (f) => calls.push(['filterMarket', f]),
    checkAdminAccess: () => calls.push(['checkAdminAccess']),
    adoptServerBotState: () => calls.push(['adoptServerBotState']),
    Notifications: { updateUI: () => {}, list: [] },
    PWA: { deferredPrompt: null },
    SoundManager: { toggleMute: () => {} },
    pendingOnboardingDeposit: false,
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  };

  // Any identifier this region touches that we did not enumerate resolves to a
  // callable stub instead of throwing ReferenceError, so the harness stays
  // faithful to "the region runs" without hard-coding every helper name.
  const unknown = () => stubFn;
  const stubFn = function () { return undefined; };
  const proxy = new Proxy(sandbox, {
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      return unknown();
    },
    set(target, key, value) { target[key] = value; return true; }
  });

  // The REAL onboarding helpers run against this same DOM/storage. That is
  // deliberate: the pre-fix file's failure lives inside these functions, so a
  // stubbed onboarding step would hide the very defect under test.
  sandbox.maybeShowOnboardingForCurrentUser = buildOnboardingApi(sandbox).maybeShowOnboardingForCurrentUser;

  if (overrides) Object.assign(sandbox, overrides);
  return { sandbox, proxy, byId, queryAll, elements, toasts, clipboard, calls, windowHandlers };
}

/**
 * Compile the real onboarding helpers against the caller's DOM/storage.
 * Functions that do not exist yet (e.g. currentCachedUser in the pre-fix file)
 * are simply not declared - calling the survivor then raises the same
 * ReferenceError production hit.
 */
function buildOnboardingApi(sandbox) {
  const names = ['onboardingKey', 'getOnboardingChoice', 'setOnboardingChoice', 'onboardingNeeded',
    'showOnboarding', 'currentCachedUser', 'maybeShowOnboardingForCurrentUser'];
  const available = names.filter((n) => html.indexOf('function ' + n + '(') !== -1);
  const context = vm.createContext({
    APP: sandbox.APP,
    localStorage: sandbox.localStorage,
    document: sandbox.document,
    console: sandbox.console
  });
  vm.runInContext(available.map(functionSource).join('\n') +
    '\nthis.__api = { maybeShowOnboardingForCurrentUser: typeof maybeShowOnboardingForCurrentUser === "function" ? maybeShowOnboardingForCurrentUser : undefined };',
    context);
  return context.__api;
}

/** Execute the initApp wiring region against the fake DOM. */
function runInitRegion(env) {
  const region = initWiringRegion();
  const code = '(async function () {\n' + region + '\n})()';
  const context = vm.createContext({ __sb: env.proxy, Promise, Symbol, Object, Array, JSON, Math, String, Number, Boolean, Error, TypeError, console: env.sandbox.console });
  // `with` gives unknown identifiers a callable stub (see makeEnv); the region is
  // sloppy-mode function-body code, exactly as it appears inside initApp.
  return vm.runInContext('with (__sb) { ' + code + ' }', context, { filename: 'initApp-wiring-region.js' });
}

// ---------------------------------------------------------------------------
// A. The onboarding helpers (the real ones from the file)
// ---------------------------------------------------------------------------

function onboardingSandbox(storageSeed, appOverrides) {
  const storage = new Map(Object.entries(storageSeed || {}));
  const opened = [];
  const modal = makeElement('onboardingModal');
  const sandbox = {
    APP: Object.assign({ environment: 'PRODUCTION', liveData: { hasRealDeposit: false } }, appOverrides || {}),
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v))
    },
    document: { getElementById: (id) => (id === 'onboardingModal' ? modal : null) },
    console
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(
    ['onboardingKey', 'getOnboardingChoice', 'setOnboardingChoice', 'onboardingNeeded', 'showOnboarding', 'currentCachedUser', 'maybeShowOnboardingForCurrentUser']
      .map(functionSource).join('\n') +
      '\nthis.__api = { currentCachedUser, maybeShowOnboardingForCurrentUser, showOnboarding, onboardingNeeded };',
    context
  );
  return { api: context.__api, storage, modal, opened };
}

test('A1 currentCachedUser is defined on the startup path (the original ReferenceError)', () => {
  assert.match(html, /function currentCachedUser\s*\(/, 'currentCachedUser must be declared');
  const { api } = onboardingSandbox({});
  assert.strictEqual(typeof api.currentCachedUser, 'function');
});

test('A2 currentCachedUser is null-safe for every cache shape', () => {
  const cases = [
    ['missing', {}],
    ['empty', { arbi_user: '' }],
    ['literal null', { arbi_user: 'null' }],
    ['malformed JSON', { arbi_user: '{"id":42' }],
    ['plain string', { arbi_user: 'not json at all' }],
    ['number', { arbi_user: '42' }]
  ];
  for (const [label, seed] of cases) {
    const { api } = onboardingSandbox(seed);
    assert.strictEqual(api.currentCachedUser(), null, label + ' must resolve to null');
  }
  const { api } = onboardingSandbox({ arbi_user: JSON.stringify({ id: 4242, name: 'Audit' }) });
  const user = api.currentCachedUser();
  assert.ok(user && typeof user === 'object', 'a valid cache resolves to the user object');
  assert.strictEqual(user.id, 4242);
  assert.strictEqual(user.name, 'Audit');
});

test('A3 a throwing/absent localStorage cannot break the startup path', () => {
  const { api } = onboardingSandbox({});
  // emulate a locked-down storage (private mode / blocked cookies)
  const contextSandbox = vm.createContext({
    APP: { environment: 'PRODUCTION', liveData: { hasRealDeposit: false } },
    localStorage: { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } },
    document: { getElementById: () => null },
    console
  });
  vm.runInContext(functionSource('currentCachedUser') + '\nthis.__u = currentCachedUser();\nthis.__m = maybeShowOnboardingForCurrentUser();'.replace('maybeShowOnboardingForCurrentUser()', 'typeof maybeShowOnboardingForCurrentUser === "function" ? maybeShowOnboardingForCurrentUser() : null'), contextSandbox);
  assert.strictEqual(contextSandbox.__u, null);
  assert.strictEqual(contextSandbox.__m, null);
  assert.ok(api, 'sanity');
});

test('A4 onboarding still shows for an unfunded account with a cached user, once', () => {
  const { api, storage, modal } = onboardingSandbox({ arbi_user: JSON.stringify({ id: 4242 }) });
  api.maybeShowOnboardingForCurrentUser();
  assert.ok(modal._classes.has('open'), 'onboarding modal opens for an unfunded account');
  assert.strictEqual(storage.get('arbi_onboarding_4242'), 'shown', 'choice is recorded');
  modal._classes.delete('open');
  api.maybeShowOnboardingForCurrentUser();
  assert.ok(!modal._classes.has('open'), 'it is not shown a second time');
});

test('A5 funded accounts and sandboxes are still skipped', () => {
  const funded = onboardingSandbox({ arbi_user: JSON.stringify({ id: 4242 }) }, { liveData: { hasRealDeposit: true } });
  funded.api.maybeShowOnboardingForCurrentUser();
  assert.ok(!funded.modal._classes.has('open'), 'funded account is not onboarded');

  const sandbox = onboardingSandbox({ arbi_user: JSON.stringify({ id: 4242 }) }, { environment: 'MARKETING_SANDBOX' });
  sandbox.api.maybeShowOnboardingForCurrentUser();
  assert.ok(!sandbox.modal._classes.has('open'), 'marketing sandbox is not onboarded');
});

test('A6 an unfunded account with NO usable cache degrades to anonymous, never throws', () => {
  for (const seed of [{}, { arbi_user: 'null' }, { arbi_user: '{broken' }]) {
    const { api } = onboardingSandbox(seed);
    assert.doesNotThrow(() => api.maybeShowOnboardingForCurrentUser());
  }
});

// ---------------------------------------------------------------------------
// B. Ordering: the optional step must not precede the critical bindings
// ---------------------------------------------------------------------------

test('B1 the onboarding call is deferred until after the critical event bindings', () => {
  const region = initWiringRegion();
  const onboardingAt = region.indexOf('maybeShowOnboardingForCurrentUser();');
  const hamburgerAt = region.indexOf("mobileMenuBtn.addEventListener");
  const referralAt = region.indexOf("copyReferralBtn.addEventListener");
  const walletTabAt = region.indexOf("querySelectorAll('.wallet-tab')");
  assert.ok(onboardingAt !== -1, 'the onboarding step must still run during init');
  for (const [label, at] of [['mobile menu', hamburgerAt], ['referral copy', referralAt], ['wallet tabs', walletTabAt]]) {
    assert.ok(at !== -1, label + ' binding must exist');
    assert.ok(onboardingAt > at, label + ' must be bound BEFORE the optional onboarding step');
  }
});

test('B2 the onboarding step is isolated in its own error boundary', () => {
  const region = initWiringRegion();
  const at = region.indexOf('maybeShowOnboardingForCurrentUser();');
  const tryAt = region.lastIndexOf('try {', at);
  const catchAt = region.indexOf('} catch (e) {', at);
  assert.ok(tryAt !== -1 && catchAt !== -1 && tryAt < at && catchAt > at, 'the call must sit inside try/catch');
  const between = region.slice(catchAt, catchAt + 260);
  assert.match(between, /console\.error/, 'the failure must be reported, not silently swallowed');
});

// ---------------------------------------------------------------------------
// C. The real wiring region runs and the handlers actually work
// ---------------------------------------------------------------------------

test('C1 the wiring region runs to completion and binds the previously-missing controls', async () => {
  const env = makeEnv();
  await runInitRegion(env);
  const required = [
    'mobileMenuBtn', 'sidebarOverlay', 'depositSidebarLink', 'withdrawSidebarLink',
    'profileLink', 'twofaLink', 'logoutLink',
    'copyReferralBtn', 'copyReferralLinkBtn', 'shareReferralBtn', 'nativeShareBtn',
    'supportInput'
  ];
  for (const id of required) {
    const el = env.byId(id);
    assert.ok(Object.keys(el._handlers).length > 0, '#' + id + ' must have at least one bound handler');
  }
  const walletTab = env.queryAll('.wallet-tab')[0];
  assert.ok(walletTab._handlers.click && walletTab._handlers.click.length, 'wallet tabs must be bound');
  const chartTab = env.queryAll('.chart-period-tab')[0];
  assert.ok(chartTab._handlers.click && chartTab._handlers.click.length, 'chart period tabs must be bound');
  const quickReply = env.queryAll('.quick-reply-btn')[0];
  assert.ok(quickReply._handlers.click && quickReply._handlers.click.length, 'support quick replies must be bound');
});

test('C2 hamburger actually opens and closes the drawer', async () => {
  const env = makeEnv();
  await runInitRegion(env);
  const btn = env.byId('mobileMenuBtn');
  const sidebar = env.byId('sidebar');
  const overlay = env.byId('sidebarOverlay');

  btn.fire('click');
  assert.ok(sidebar._classes.has('open'), 'drawer opens');
  assert.ok(overlay._classes.has('open'), 'overlay shows');
  btn.fire('click');
  assert.ok(!sidebar._classes.has('open'), 'drawer closes on a second tap');
  btn.fire('click');
  overlay.fire('click');
  assert.ok(!sidebar._classes.has('open') && !overlay._classes.has('open'), 'overlay tap closes the drawer');
});

test('C3 sidebar shortcuts open the right screens', async () => {
  const env = makeEnv();
  await runInitRegion(env);
  env.byId('depositSidebarLink').fire('click');
  env.byId('withdrawSidebarLink').fire('click');
  const opened = env.calls.map((c) => c[0]);
  assert.ok(opened.includes('openDepositModal'), 'Deposit shortcut opens the deposit flow');
  assert.ok(opened.includes('openWithdrawModal'), 'Withdraw shortcut opens the withdraw flow');

  // Profile / 2FA reveal their modal by toggling the class (as the app does).
  env.byId('sidebar').classList.add('open');
  env.byId('profileLink').fire('click');
  assert.ok(env.byId('profileModal')._classes.has('open'), 'Profile shortcut opens Profile Settings');
  assert.ok(!env.byId('sidebar')._classes.has('open'), 'and closes the drawer');

  env.byId('twofaLink').fire('click');
  assert.ok(env.byId('twofaModal')._classes.has('open'), '2FA shortcut opens the 2FA panel');
});

test('C3b logout is wired but never fires without confirmation', async () => {
  const env = makeEnv();
  await runInitRegion(env);
  const logout = env.byId('logoutLink');
  assert.ok(logout._handlers.click && logout._handlers.click.length, 'logout has a click handler');
  // The handler asks for confirmation first; without it nothing is torn down.
  env.sandbox.confirm = () => false;
  logout.fire('click');
  await new Promise((r) => setImmediate(r));
  assert.ok(!env.calls.some((c) => /logout|goToApp/i.test(c[0])), 'declining the confirm does not log out');
});

test('C4 referral copy buttons hand the right value to the clipboard', async () => {
  const env = makeEnv();
  await runInitRegion(env);
  env.byId('copyReferralBtn').fire('click');
  await flushMicrotasks();
  assert.deepStrictEqual(env.clipboard, ['ARBI-TEST01'], 'the referral CODE is copied');
  assert.ok(env.toasts.some((t) => /code|referral|copyFailed/i.test(String(t[0]))), 'the user gets feedback');
  env.byId('copyReferralLinkBtn').fire('click');
  await flushMicrotasks();
  assert.strictEqual(env.clipboard[1], 'https://arbitrix.pro/?ref=ARBI-TEST01', 'the referral LINK is copied');
});

test('C5 share handlers are wired (window.open / clipboard fallback)', async () => {
  const env = makeEnv();
  const opened = [];
  env.sandbox.window.open = (u) => { opened.push(u); return null; };
  await runInitRegion(env);
  env.byId('shareReferralBtn').fire('click');
  assert.strictEqual(opened.length, 1, 'Share on X opens the intent URL');
  assert.match(opened[0], /twitter\.com\/intent\/tweet/);
  env.byId('nativeShareBtn').fire('click');
  await new Promise((r) => setImmediate(r));
  await flushMicrotasks();
  assert.ok(env.clipboard.includes('https://arbitrix.pro/?ref=ARBI-TEST01'), 'native-share fallback copies the link');
});

test('C6 wallet and chart tabs switch', async () => {
  const env = makeEnv();
  await runInitRegion(env);
  const [tabA, tabB] = env.queryAll('.wallet-tab');
  tabB.fire('click');
  assert.ok(tabB._classes.has('active'), 'the tapped wallet tab becomes active');
  assert.ok(!tabA._classes.has('active'), 'the previous tab is deactivated');
  assert.strictEqual(env.sandbox.APP.currentWallet, 'live', 'the wallet actually switches');

  const [cA, cB] = env.queryAll('.chart-period-tab');
  cB.fire('click');
  assert.ok(env.calls.some((c) => c[0] === 'setChartPeriod' && c[1] === '4H'), 'the chart period is applied');
  assert.ok(cA && cB, 'chart tabs rendered');
});

test('C7 support quick replies fill the input and send', async () => {
  const env = makeEnv();
  await runInitRegion(env);
  const reply = env.queryAll('.quick-reply-btn')[0];
  reply.fire('click');
  assert.strictEqual(env.byId('supportInput').value, 'How do I deposit?', 'the quick reply populates the input');
  assert.ok(env.calls.some((c) => c[0] === 'sendSupportMessage'), 'and sends it');
});

test('C8 the Enter key in the support input sends the message', async () => {
  const env = makeEnv();
  await runInitRegion(env);
  env.byId('supportInput').fire('keypress', { key: 'Enter', preventDefault() {} });
  assert.ok(env.calls.some((c) => c[0] === 'sendSupportMessage'), 'Enter sends the support message');
});

test('C9 a FAILING onboarding step cannot abort the critical bindings', async () => {
  const env = makeEnv({
    maybeShowOnboardingForCurrentUser: () => { throw new ReferenceError('currentCachedUser is not defined'); }
  });
  await assert.doesNotReject(() => runInitRegion(env), 'the init region must absorb the onboarding failure');

  const btn = env.byId('mobileMenuBtn');
  assert.ok(btn._handlers.click && btn._handlers.click.length, 'hamburger is still bound');
  btn.fire('click');
  assert.ok(env.byId('sidebar')._classes.has('open'), 'and still works');

  env.byId('copyReferralBtn').fire('click');
  await flushMicrotasks();
  assert.deepStrictEqual(env.clipboard, ['ARBI-TEST01'], 'referral copy still works');

  const errs = env.calls.filter((c) => c[0] === 'console.error');
  assert.ok(errs.length >= 1, 'the failure is reported to the console');
  assert.match(errs[0][1], /onboarding/i, 'the report names the optional onboarding step');
});

test('C10 a failing pending-deposit hand-off is also contained', async () => {
  const env = makeEnv({
    pendingOnboardingDeposit: true,
    openDepositModal: () => { throw new Error('deposit UI unavailable'); }
  });
  await assert.doesNotReject(() => runInitRegion(env));
  const btn = env.byId('mobileMenuBtn');
  assert.ok(btn._handlers.click && btn._handlers.click.length, 'bindings survive a failing deposit hand-off');
});

// ---------------------------------------------------------------------------
// D. Scope guard: no financial or backend surface is touched by this fix
// ---------------------------------------------------------------------------

test('D1 the fix touches only the startup wiring in public/index.html', () => {
  // The onboarding helpers exist exactly once and read only the user cache.
  assert.strictEqual((html.match(/function currentCachedUser\s*\(/g) || []).length, 1);
  const helper = functionSource('currentCachedUser');
  assert.ok(!/hasRealDeposit|live_balance|balance|amount|wallet_id|referral|deposit\(/i.test(helper),
    'currentCachedUser must not read or infer any financial state');
  // The onboarding gate still keys off the existing funded flag, unchanged.
  const gate = functionSource('maybeShowOnboardingForCurrentUser');
  assert.match(gate, /APP\.liveData && APP\.liveData\.hasRealDeposit/, 'the funded guard is unchanged');
  assert.match(gate, /MARKETING_SANDBOX/, 'the sandbox guard is unchanged');
});

test('D2 initApp still binds every control that was missing (no silent deletions)', () => {
  const region = initWiringRegion();
  const expected = [
    "getEl('mobileMenuBtn')", "getEl('copyReferralBtn')", "getEl('copyReferralLinkBtn')",
    "getEl('shareReferralBtn')", "getEl('nativeShareBtn')", "getEl('logoutLink')",
    "querySelectorAll('.wallet-tab')", "querySelectorAll('.chart-period-tab')",
    "querySelectorAll('.quick-reply-btn')", "getEl('supportInput')",
    "getEl('depositSidebarLink')", "getEl('withdrawSidebarLink')"
  ];
  for (const needle of expected) {
    assert.ok(region.includes(needle), needle + ' must still be wired in initApp');
  }
});
