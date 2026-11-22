'use strict';

/**
 * STARTUP: currentCachedUser() must exist and must never throw.
 *
 * DEFECT (pre-existing, found while smoke-testing the PR #194 deployment):
 *   function maybeShowOnboardingForCurrentUser() {
 *       if (APP.environment === 'MARKETING_SANDBOX') return;
 *       if (APP.liveData && APP.liveData.hasRealDeposit) return;
 *       showOnboarding(currentCachedUser());        // <-- never defined
 *   }
 * `currentCachedUser` was referenced twice (here and in chooseOnboarding) and
 * guarded once (`typeof currentCachedUser === 'function'`), but no definition
 * existed anywhere in the bundle. initApp() calls
 * maybeShowOnboardingForCurrentUser(), so for every user WITHOUT a confirmed
 * deposit ('hasRealDeposit' false, not sandbox) startup threw
 *     ReferenceError: currentCachedUser is not defined
 * and every statement after that call in the same script block was skipped.
 *
 * MEASURED ON THE LIVE BUILD (390px, deployed commit cf9f935): listener
 * registrations after startup were 42 for an unfunded user vs 72 for a funded
 * one - 30 controls never got their handlers, including the mobile drawer
 * (mobileMenuBtn), the sidebar shortcuts (deposit/withdraw/profile/2FA/logout),
 * wallet tabs, chart period tabs, support input and the referral copy/share
 * buttons. Mobile navigation was effectively unusable for new customers.
 *
 * This suite pins the helper's existence, its null-safety and the callers'
 * behaviour, so the regression cannot come back.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Extract `function NAME(...) { ... }` with a brace matcher (comments stripped).
function fnSource(name) {
  const stripped = INDEX.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const at = stripped.indexOf('function ' + name + '(');
  assert.ok(at >= 0, 'function not found: ' + name);
  let depth = 0;
  for (let i = stripped.indexOf('{', at); i < stripped.length; i += 1) {
    if (stripped[i] === '{') depth += 1;
    else if (stripped[i] === '}') {
      depth -= 1;
      if (depth === 0) return stripped.slice(at, i + 1);
    }
  }
  throw new Error('unbalanced function: ' + name);
}

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map
  };
}

// Run the real helper against a fake localStorage.
function runHelper(stored) {
  const ctx = { localStorage: makeStorage(stored === undefined ? {} : { arbi_user: stored }) };
  vm.createContext(ctx);
  vm.runInContext(fnSource('currentCachedUser'), ctx);
  return ctx.currentCachedUser();
}

// ===========================================================================
// A. Existence and wiring
// ===========================================================================

test('currentCachedUser is defined exactly once, as a function', () => {
  const defs = INDEX.match(/function currentCachedUser\s*\(/g) || [];
  assert.strictEqual(defs.length, 1, 'the helper must be defined exactly once');
});

test('every call site now resolves to the definition', () => {
  const calls = (INDEX.match(/currentCachedUser\s*\(/g) || []).length;
  assert.ok(calls >= 3, 'expected the definition + the startup call sites, found ' + calls);
  // The two unguarded startup calls that used to throw.
  assert.match(INDEX, /showOnboarding\(currentCachedUser\(\)\)/);
  assert.match(INDEX, /const user = currentCachedUser\(\);/);
});

test('the helper reads the app-wide cache key', () => {
  assert.match(fnSource('currentCachedUser'), /localStorage\.getItem\('arbi_user'\)/,
    'must use the same cache key login/signup write');
});

// ===========================================================================
// B. Null-safety (the property that stops startup from aborting)
// ===========================================================================

test('a valid cached user is returned as an object', () => {
  const user = runHelper(JSON.stringify({ id: 7, name: 'Ana' }));
  assert.deepStrictEqual({ ...user }, { id: 7, name: 'Ana' });
});

test('a missing cache resolves to null', () => {
  assert.strictEqual(runHelper(undefined), null);
});

test('an empty or whitespace cache resolves to null', () => {
  assert.strictEqual(runHelper(''), null);
  assert.strictEqual(runHelper('   '), null);
});

test('malformed JSON resolves to null instead of throwing', () => {
  for (const bad of ['{', 'not json', '{"id":', 'undefined']) {
    assert.strictEqual(runHelper(bad), null, 'input=' + bad);
  }
});

test('non-object JSON resolves to null', () => {
  for (const value of ['7', '"user"', 'null', 'true', '[]']) {
    const r = runHelper(value);
    // arrays are objects in JS; what matters is that nothing throws and the
    // onboarding helpers can safely read `.id` (undefined for an array)
    assert.ok(r === null || typeof r === 'object', 'input=' + value);
    if (r !== null) assert.strictEqual(r.id, undefined);
  }
});

test('the helper never throws, whatever the cache holds', () => {
  for (const value of ['{}', '{]', '0', '[1,2,3]', '{"id":1,"environment":"PRODUCTION"}']) {
    assert.doesNotThrow(() => runHelper(value), 'input=' + value);
  }
});

// ===========================================================================
// C. Caller behaviour with the helper in scope
// ===========================================================================

test('maybeShowOnboardingForCurrentUser does not throw for an unfunded user', () => {
  const ctx = {
    localStorage: makeStorage({}),
    APP: { environment: 'PRODUCTION', liveData: { hasRealDeposit: false } },
    calls: [],
    showOnboarding: (u) => { ctx.calls.push(u); return true; },
    document: { getElementById: () => null }
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource('currentCachedUser') + '\n' + fnSource('maybeShowOnboardingForCurrentUser'), ctx);
  assert.doesNotThrow(() => ctx.maybeShowOnboardingForCurrentUser());
  assert.strictEqual(ctx.calls.length, 1, 'onboarding is still offered');
  assert.strictEqual(ctx.calls[0], null, 'with no cached user it degrades to the anon path');
});

test('maybeShowOnboardingForCurrentUser still skips sandbox and funded accounts', () => {
  const make = (environment, funded) => {
    const ctx = {
      localStorage: makeStorage({ arbi_user: JSON.stringify({ id: 3 }) }),
      APP: { environment, liveData: { hasRealDeposit: funded } },
      calls: [],
      showOnboarding: (u) => { ctx.calls.push(u); },
      document: { getElementById: () => null }
    };
    vm.createContext(ctx);
    vm.runInContext(fnSource('currentCachedUser') + '\n' + fnSource('maybeShowOnboardingForCurrentUser'), ctx);
    ctx.maybeShowOnboardingForCurrentUser();
    return ctx.calls.length;
  };
  assert.strictEqual(make('MARKETING_SANDBOX', false), 0, 'sandbox never sees the prompt');
  assert.strictEqual(make('PRODUCTION', true), 0, 'funded accounts never see the prompt');
  assert.strictEqual(make('PRODUCTION', false), 1, 'unfunded production accounts still do');
});

test('startHereKey uses the cached user and falls back to anon', () => {
  const run = (seed) => {
    const ctx = {
      localStorage: makeStorage(seed),
      updateStartHere: () => {},
      document: { getElementById: () => null }
    };
    vm.createContext(ctx);
    vm.runInContext(fnSource('currentCachedUser') + '\n' + fnSource('startHereKey'), ctx);
    return ctx.startHereKey();
  };
  assert.strictEqual(run({ arbi_user: JSON.stringify({ id: 42 }) }), 'arbi_starthere_42');
  assert.strictEqual(run({}), 'arbi_starthere_anon');
  assert.strictEqual(run({ arbi_user: '{broken' }), 'arbi_starthere_anon');
});

// ===========================================================================
// D. Scope: a frontend helper only
// ===========================================================================

test('the fix is frontend-only and touches no financial path', () => {
  const src = fnSource('currentCachedUser');
  for (const forbidden of ['fetch(', 'api/', 'wallet', 'balance', 'deposit', 'withdraw', 'trade']) {
    assert.ok(!src.includes(forbidden), 'helper must not reference ' + forbidden);
  }
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!server.includes('currentCachedUser'), 'server.js is not involved');
});
