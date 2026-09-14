'use strict';

/**
 * Referral-link attribution + persistence (Fix A + Fix B).
 *
 * These tests run the REAL functions extracted from public/index.html inside a
 * vm sandbox with a mocked window.location / sessionStorage / referral input:
 *
 *   getReferralCodeFromURL, isValidReferralCodeFormat,
 *   rememberPendingReferralCode, getPendingReferralCode,
 *   clearPendingReferralCode, populateReferralFromURL, applyAuthEntryIntent
 *
 * Nothing here touches the network, the database, real users or real money.
 * The register payload, the referral reward/qualification logic and the
 * dashboard read are asserted to be UNCHANGED.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const CODE = 'ARBI-TEST01';

// --- extract the real implementations (never re-implemented in the test) ---
function extractFunction(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at > -1, name + ' must exist in public/index.html');
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

const pendingKeyMatch = /const PENDING_REFERRAL_KEY = '([^']+)';/.exec(INDEX);
assert.ok(pendingKeyMatch, 'PENDING_REFERRAL_KEY must be declared');
const PENDING_KEY = pendingKeyMatch[1];

const CORE_SRC = [
  'const PENDING_REFERRAL_KEY = ' + JSON.stringify(PENDING_KEY) + ';',
  extractFunction(INDEX, 'getReferralCodeFromURL'),
  extractFunction(INDEX, 'isValidReferralCodeFormat'),
  extractFunction(INDEX, 'rememberPendingReferralCode'),
  extractFunction(INDEX, 'getPendingReferralCode'),
  extractFunction(INDEX, 'clearPendingReferralCode'),
  extractFunction(INDEX, 'populateReferralFromURL'),
].join('\n\n');

const ENTRY_SRC = CORE_SRC + '\n\n' + extractFunction(INDEX, 'applyAuthEntryIntent');

// --- sandbox environment ---
function makeStorage(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

function makeEnv(opts) {
  opts = opts || {};
  const storage = makeStorage(opts.stored);
  const listeners = {};
  const input = opts.noInput ? null : {
    value: opts.value || '',
    dataset: {},
    style: {},
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const calls = { signup: 0, login: 0 };
  const sandbox = {
    window: {
      location: {
        search: opts.search || '',
        pathname: opts.pathname || '/',
        href: 'https://arbitrix.pro' + (opts.pathname || '/') + (opts.search || ''),
      },
    },
    document: { getElementById: (id) => (id === 'signupReferral' ? input : null) },
    sessionStorage: storage,
    URLSearchParams,
    setTimeout: () => 0,
    console: { log: () => {}, error: () => {}, warn: () => {} },
    showLoginForm: () => { calls.login++; },
    showSignupForm: () => { calls.signup++; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(opts.entry ? ENTRY_SRC : CORE_SRC, sandbox);
  return {
    sandbox, input, storage, calls, listeners,
    populate: () => vm.runInContext('populateReferralFromURL()', sandbox),
    entry: () => vm.runInContext('applyAuthEntryIntent()', sandbox),
    pending: () => storage.getItem(PENDING_KEY),
    fire: (type) => (listeners[type] || []).forEach((fn) => fn()),
  };
}

// ============ Fix A: capture on every auth entry ============

test('1. /signup?ref=CODE populates the referral field (the generated share link)', () => {
  const e = makeEnv({ pathname: '/signup', search: '?ref=' + CODE });
  e.populate();
  assert.strictEqual(e.input.value, CODE);
  assert.strictEqual(e.pending(), CODE, 'code is remembered for later');
});

test('2. /?ref=CODE populates the referral field', () => {
  const e = makeEnv({ search: '?ref=' + CODE });
  e.populate();
  assert.strictEqual(e.input.value, CODE);
});

test('3. /ref/CODE works after the server redirect (both URL forms)', () => {
  const direct = makeEnv({ pathname: '/ref/' + CODE });
  direct.populate();
  assert.strictEqual(direct.input.value, CODE, 'path form captured');

  const redirected = makeEnv({ pathname: '/', search: '?ref=' + CODE });
  redirected.populate();
  assert.strictEqual(redirected.input.value, CODE, 'redirect target captured');
});

test('4. ?action=create-account&ref=CODE still works', () => {
  const e = makeEnv({ entry: true, search: '?action=create-account&ref=' + CODE });
  e.entry();
  assert.strictEqual(e.calls.signup, 1, 'signup tab is selected by the entry intent');
  assert.strictEqual(e.input.value, CODE);
});

test('5. ?action=sign-in&ref=CODE preserves the code for a later signup', () => {
  const e = makeEnv({ entry: true, search: '?action=sign-in&ref=' + CODE });
  e.entry();
  assert.strictEqual(e.calls.login, 1, 'login tab is selected');
  assert.strictEqual(e.pending(), CODE, 'code is remembered while the user signs in');

  // later, with no code in the URL, opening the signup form still has it
  const later = makeEnv({ stored: { [PENDING_KEY]: e.pending() } });
  later.populate();
  assert.strictEqual(later.input.value, CODE);
});

test('4b/5b. applyAuthEntryIntent captures on entry paths with NO ?action param', () => {
  // This is the regression that broke attribution: the capture never ran unless
  // ?action=create-account was present (showSignupForm was never called).
  const cases = [
    ['/signup?ref=' + CODE, '/signup', '?ref=' + CODE],
    ['/?ref=' + CODE, '/', '?ref=' + CODE],
    ['/ref/' + CODE, '/ref/' + CODE, ''],
  ];
  for (const [label, pathname, search] of cases) {
    const e = makeEnv({ entry: true, pathname, search });
    e.entry();
    assert.strictEqual(e.input.value, CODE, label + ' must capture the code');
    assert.strictEqual(e.calls.signup, 0, label + ' relies on the new capture, not showSignupForm');
  }
});

test('4c. direct landing on the signup page and returning from another page', () => {
  const fresh = makeEnv({ entry: true, pathname: '/signup' });
  fresh.entry();
  assert.strictEqual(fresh.input.value, '', 'nothing captured without a code');

  const returning = makeEnv({ entry: true, stored: { arbi_auth_entry: '?action=create-account', [PENDING_KEY]: CODE } });
  returning.entry();
  assert.strictEqual(returning.calls.signup, 1);
  assert.strictEqual(returning.input.value, CODE, 'code restored when coming back');
});

test('4d. capture is idempotent (repeated entry does not duplicate or change anything)', () => {
  const e = makeEnv({ entry: true, pathname: '/signup', search: '?ref=' + CODE });
  e.entry(); e.entry(); e.entry();
  assert.strictEqual(e.input.value, CODE);
  assert.strictEqual(e.storage.store.size, 1, 'exactly one storage entry');
});

// ============ Fix B: persistence ============

test('6. a reload preserves the pending code', () => {
  const first = makeEnv({ pathname: '/signup', search: '?ref=' + CODE });
  first.populate();
  assert.strictEqual(first.pending(), CODE);

  // "reload": new sandbox, same sessionStorage, no code in the URL
  const reload = makeEnv({ pathname: '/signup', stored: Object.fromEntries(first.storage.store) });
  reload.populate();
  assert.strictEqual(reload.input.value, CODE, 'restored from sessionStorage after reload');
});

test('7. navigating away and back preserves the pending code', () => {
  const first = makeEnv({ search: '?ref=' + CODE });
  first.populate();
  const carried = Object.fromEntries(first.storage.store);

  // away: /how-it-works is a separate document with no query string
  const away = makeEnv({ pathname: '/how-it-works', stored: carried });
  away.populate();
  assert.strictEqual(away.input.value, CODE, 'still remembered while away');

  // back on the app root, no ?ref in the URL
  const back = makeEnv({ pathname: '/', stored: carried });
  back.populate();
  assert.strictEqual(back.input.value, CODE, 'restored on return');
});

test('8. invalid codes are ignored (never filled, never stored)', () => {
  const cases = ['?ref=HACK', '?ref=ARBI-', '?ref=ARBI-TOOLONGCODE', '?ref=', '?referral=NOTACODE', '?ref=ARBI-TEST01!'];
  for (const search of cases) {
    const e = makeEnv({ search });
    e.populate();
    assert.strictEqual(e.input.value, '', search + ' must not populate');
    assert.strictEqual(e.pending(), null, search + ' must not be stored');
  }
});

test('9. a manually entered code is never overwritten', () => {
  const typed = makeEnv({ search: '?ref=' + CODE, value: 'ARBI-MINE99' });
  typed.populate();
  assert.strictEqual(typed.input.value, 'ARBI-MINE99', 'user value preserved');
  assert.strictEqual(typed.pending(), CODE, 'the link code is still remembered for later');

  // and after the user edits an auto-filled value, that edit sticks
  const edited = makeEnv({ search: '?ref=' + CODE });
  edited.populate();
  assert.strictEqual(edited.input.value, CODE);
  edited.input.value = 'ARBI-MINE99';
  edited.fire('input');           // user typed
  edited.populate();              // later entry/focus re-runs the capture
  assert.strictEqual(edited.input.value, 'ARBI-MINE99', 'edited value is respected');
});

test('9b. a newer link code replaces a value WE auto-filled', () => {
  const e = makeEnv({ search: '?ref=ARBI-FIRST1' });
  e.populate();
  assert.strictEqual(e.input.value, 'ARBI-FIRST1');
  e.sandbox.window.location.search = '?ref=ARBI-SECOND';
  e.populate();
  assert.strictEqual(e.input.value, 'ARBI-SECOND', 'newest link wins over our own prefill');
  assert.strictEqual(e.pending(), 'ARBI-SECOND');
});

test('10. the pending code is cleared after successful registration', () => {
  const fn = extractFunction(INDEX, 'handleSignup');
  const storeAt = fn.indexOf("localStorage.setItem('jwt_token'");
  const clearAt = fn.indexOf('clearPendingReferralCode();');
  assert.ok(storeAt > -1, 'handleSignup still stores the JWT');
  assert.ok(clearAt > -1, 'handleSignup must clear the pending referral code');
  assert.ok(clearAt > storeAt, 'clearing happens AFTER the account was created');
  assert.ok(clearAt < fn.indexOf("localStorage.setItem('arbi_user'", storeAt) + 1000, 'cleared inside the success path');
  // the error branches must NOT clear it (a failed signup keeps the code)
  const errorReturn = fn.indexOf('setButtonLoading(btn, false);');
  assert.ok(errorReturn > -1 && fn.slice(fn.indexOf('if (!response.ok)'), errorReturn).indexOf('clearPendingReferralCode') === -1,
    'a rejected registration must not clear the pending code');

  const e = makeEnv({ stored: { [PENDING_KEY]: CODE } });
  vm.runInContext('clearPendingReferralCode()', e.sandbox);
  assert.strictEqual(e.pending(), null, 'clearPendingReferralCode removes the stored code');
});

test('11. no referral code means no attribution and no stored code', () => {
  const e = makeEnv({ pathname: '/signup' });
  e.populate();
  assert.strictEqual(e.input.value, '');
  assert.strictEqual(e.pending(), null);
  assert.strictEqual(e.storage.store.size, 0, 'nothing is written to storage');
});

test('11b. the code is never sent to the backend before the user submits', () => {
  const capture = [
    extractFunction(INDEX, 'populateReferralFromURL'),
    extractFunction(INDEX, 'rememberPendingReferralCode'),
    extractFunction(INDEX, 'getPendingReferralCode'),
    extractFunction(INDEX, 'clearPendingReferralCode'),
  ].join('\n');
  assert.ok(!/fetch\s*\(/.test(capture), 'capture must not call fetch');
  assert.ok(!/XMLHttpRequest/.test(capture), 'capture must not use XHR');
  assert.ok(!/(referrer_id|referred_id)/.test(capture), 'capture must not touch identity fields');
  // registration payload is unchanged: only name/email/password/referralCode
  assert.ok(/JSON\.stringify\(\{\s*name,\s*email,\s*password,\s*referralCode:\s*referral\s*\}\)/.test(INDEX),
    'the register payload must stay { name, email, password, referralCode }');
});

// ============ scope: nothing else changed ============

test('12. backend referral behaviour is untouched (reward, qualification, dashboard read)', () => {
  // registration still reads referralCode and creates a PENDING referral row
  assert.ok(/const \{ name, email, password, referralCode \} = req\.body;/.test(SERVER));
  assert.ok(/status: 'pending'/.test(SERVER), 'referrals are still created pending');
  assert.ok(/bonus_earned: 0/.test(SERVER), 'no bonus at registration');
  // dashboard read unchanged
  assert.ok(/app\.get\('\/api\/referral\/detailed'/.test(SERVER));
  assert.ok(/\.eq\('referrer_id', userId\)/.test(SERVER), 'dashboard still scopes by referrer_id');
  // reward model unchanged (one-time percentage, no commission)
  assert.ok(/REFERRAL_REWARD_PERCENT_DEFAULT/.test(SERVER));
  assert.ok(!/referral_profit_commission_rate/.test(SERVER), 'no profit commission was reintroduced');
});

test('12b. no routing/redirect or attribute behaviour was altered', () => {
  assert.ok(/app\.get\('\/ref\/:code'/.test(SERVER), '/ref/:code route intact');
  const entry = extractFunction(INDEX, 'applyAuthEntryIntent');
  assert.ok(/sessionStorage\.setItem\('arbi_auth_entry'/.test(entry), 'auth entry intent persists as before');
  // the capture is additive: the original showSignupForm() call site still exists
  assert.ok(/Auto-populate referral code from URL[\s\S]{0,60}populateReferralFromURL\(\);/.test(INDEX),
    'showSignupForm still auto-populates');
});
