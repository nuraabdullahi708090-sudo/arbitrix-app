/**
 * Cross-account support transcript isolation.
 *
 * The native panel lives in the page, so a logout/login in the SAME tab reuses its
 * DOM. It used to keep `started` / `conversationId` / `lastId` / `seen` and the
 * rendered bubbles, so the next account could read the previous account's support
 * transcript (verified in a browser before the fix: A's two bubbles were still on
 * screen after B logged in).
 *
 * The fix ties that state to the authenticated account (user id, else a token
 * fingerprint): on a change - or when support is switched off - the account-scoped
 * state is dropped, the transcript is cleared, and any response still in flight for
 * the old account is discarded by a generation check. The same account syncing
 * again (page load, panel reopen, handler re-run) changes nothing, so its transcript
 * is preserved.
 *
 * These tests execute the real extracted functions against fakes, not copies.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const NATIVE = fs.readFileSync(path.join(ROOT, 'public/native-support.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/** Extract a top-level `function name(...) { ... }` from the module source. */
function fnSrc(name) {
    const start = NATIVE.indexOf('function ' + name + '(');
    assert.notStrictEqual(start, -1, name + '() is missing from the native client');
    let depth = 0;
    let i = NATIVE.indexOf('{', start);
    const bodyStart = i;
    for (; i < NATIVE.length; i++) {
        if (NATIVE[i] === '{') depth++;
        else if (NATIVE[i] === '}') {
            depth--;
            if (depth === 0) return NATIVE.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces in ' + name);
}

function runIdentity(store) {
    return vm.runInNewContext(fnSrc('accountIdentity') + '; accountIdentity();', { localStorage: store });
}

function fakeStore(map) {
    return { getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null) };
}

function runReset(state, opts) {
    const calls = { unread: [], cleared: 0 };
    const body = { innerHTML: 'A transcript', set(v) { this.innerHTML = v; } };
    const foot = { innerHTML: '<composer>' };
    const sandbox = {
        state,
        body,
        foot,
        setUnread: (n) => calls.unread.push(n),
        clearInterval: () => { calls.cleared++; }
    };
    vm.runInNewContext(fnSrc('resetAccountState') + '; resetAccountState();', sandbox);
    return { state, body, foot, calls };
}

function freshState() {
    return {
        conversationId: 900,
        lastId: 42,
        open: true,
        timer: 7,
        sending: true,
        unread: 3,
        started: true,
        seen: { 1: 'node', 2: 'node' },
        pendingNode: 'node',
        pendingClientId: 'c1',
        pendingText: 'A-private-question',
        identity: 'u1',
        generation: 5
    };
}

// ---------------------------------------------------------------------------
// Identity detection (security review of the original implementation)
// ---------------------------------------------------------------------------

test('identity is derived from the session token, in full - not from the cached profile', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.signature-part';
    const id = runIdentity(fakeStore({ arbi_user: JSON.stringify({ id: 42 }), jwt_token: token }));
    assert.strictEqual(id, 's:' + token, 'exact comparison: no id, no hash, no collision space');
    assert.doesNotMatch(id, /^u/, 'the cached user id is not part of the identity');
});

test('Q1: a STALE arbi_user cannot mask a real account switch', () => {
    // Account A was signed in: token A + cached profile A.
    const asA = runIdentity(fakeStore({ arbi_user: JSON.stringify({ id: 1 }), jwt_token: 'token-A' }));
    // Account B signs in on the same tab but the cached profile still says A.
    const staleCache = runIdentity(fakeStore({ arbi_user: JSON.stringify({ id: 1 }), jwt_token: 'token-B' }));
    assert.notStrictEqual(staleCache, asA, 'the switch must be detected from the token alone');
    const reset = vm.runInNewContext(fnSrc('shouldResetAccount') + '; shouldResetAccount(a, b);', { a: asA, b: staleCache });
    assert.strictEqual(reset, true, 'sync() must therefore reset the panel');
});

test('Q2: no fingerprint, so there is no collision space to reason about', () => {
    const long = 'x'.repeat(400) + 'A';
    assert.strictEqual(runIdentity(fakeStore({ jwt_token: long })), 's:' + long);
    const a = runIdentity(fakeStore({ jwt_token: long }));
    const b = runIdentity(fakeStore({ jwt_token: 'x'.repeat(400) + 'B' }));
    assert.notStrictEqual(a, b, 'tokens differing by one character are never conflated');
});

test('Q3: malformed, missing or unreadable auth data fails closed to null', () => {
    assert.strictEqual(runIdentity(fakeStore({ arbi_user: '{not json', jwt_token: 'tok' })), 's:tok',
        'a broken cache is ignored, the token still identifies the session');
    assert.strictEqual(runIdentity(fakeStore({})), null, 'signed out');
    assert.strictEqual(runIdentity(fakeStore({ arbi_user: JSON.stringify({ id: 9 }) })), null,
        'a cached profile without a session token is NOT an authenticated identity');
    const throwing = { getItem() { throw new Error('storage disabled'); } };
    assert.strictEqual(runIdentity(throwing), null, 'unreadable storage fails closed');
    assert.strictEqual(runIdentity(fakeStore({ jwt_token: '' })), null);
});

test('the reset decision covers login, switch and sign-out', () => {
    const decide = (a, b) => vm.runInNewContext(fnSrc('shouldResetAccount') + '; shouldResetAccount(a, b);', { a, b });
    assert.strictEqual(decide('s:tokA', 's:tokA'), false, 'same session -> keep the transcript');
    assert.strictEqual(decide('s:tokA', 's:tokB'), true, 'different account -> reset');
    assert.strictEqual(decide(null, 's:tokB'), true, 'login -> reset (nothing to keep)');
    assert.strictEqual(decide('s:tokA', null), true, 'logout / support disabled -> reset');
    assert.strictEqual(decide('u1', 's:tokA'), true, 'a legacy cached-id identity never matches a real session');
    assert.strictEqual(decide(null, null), false, 'signed out twice is not a transition');
});

test('the identity is never rendered or serialised', () => {
    assert.doesNotMatch(NATIVE, /JSON\.stringify\(state\)/, 'state (which holds the token copy) is never serialised');
    assert.doesNotMatch(NATIVE, /console\.[a-z]+\([^)]*state\.identity/, 'the identity is never logged');
    assert.doesNotMatch(NATIVE, /textContent\s*=\s*state\.identity|innerHTML\s*=\s*state\.identity/, 'never rendered');
});

// ---------------------------------------------------------------------------
// Account-state reset
// ---------------------------------------------------------------------------

test('reset clears every account-scoped field, the cursor map and the timer', () => {
    const { state, calls } = runReset(freshState());
    assert.strictEqual(state.conversationId, null);
    assert.strictEqual(state.lastId, 0);
    assert.strictEqual(state.started, false);
    assert.strictEqual(state.sending, false);
    assert.deepStrictEqual(Object.keys(state.seen), [], 'the dedupe map must not survive');
    assert.strictEqual(state.pendingNode, null);
    assert.strictEqual(state.pendingClientId, null);
    assert.strictEqual(state.pendingText, null, 'the previous account text must not linger');
    assert.deepStrictEqual(calls.unread, [0], 'the unread badge is cleared');
    assert.strictEqual(calls.cleared, 1, 'the poll timer is stopped');
});

test('reset wipes the rendered transcript and the composer', () => {
    const { body, foot } = runReset(freshState());
    assert.strictEqual(body.innerHTML, '', 'the previous account messages are gone from the DOM');
    assert.strictEqual(foot.innerHTML, '');
});

test('reset bumps the generation so in-flight responses are discarded', () => {
    const { state } = runReset(freshState());
    assert.strictEqual(state.generation, 6, 'generation is incremented');
    const stale = vm.runInNewContext(fnSrc('stale') + '; stale(5);', { state: { generation: 6 } });
    const live = vm.runInNewContext(fnSrc('stale') + '; stale(6);', { state: { generation: 6 } });
    assert.strictEqual(stale, true, 'a response from the previous generation is stale');
    assert.strictEqual(live, false, 'the current generation still renders');
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test('state declares identity and generation', () => {
    const decl = NATIVE.slice(NATIVE.indexOf('var state = {'), NATIVE.indexOf('};', NATIVE.indexOf('var state = {')));
    assert.match(decl, /identity:\s*null/);
    assert.match(decl, /generation:\s*0/);
});

test('sync() resets on an account change or when support is disabled', () => {
    const sync = NATIVE.slice(NATIVE.indexOf('    sync: function () {'), NATIVE.indexOf('    }\n', NATIVE.indexOf('    sync: function () {')));
    assert.match(sync, /var identity = enabled \? accountIdentity\(\) : null;/, 'support off resolves to no identity');
    assert.match(sync, /if \(shouldResetAccount\(state\.identity, identity\)\) \{/, 'the reset is keyed on the identity, not on every sync');
    assert.match(sync, /resetAccountState\(\);/, 'the reset actually runs');
    assert.match(sync, /state\.identity = identity;/, 'the new identity is recorded');
    assert.match(sync, /if \(enabled && identity && state\.open\) loadExisting\(\);/, 'an open panel hydrates only an AUTHENTICATED new account');
});

test('the same account syncing again does NOT reset (transcript preserved)', () => {
    const sync = NATIVE.slice(NATIVE.indexOf('    sync: function () {'), NATIVE.indexOf('    }\n', NATIVE.indexOf('    sync: function () {')));
    // The only reset call sits inside the identity-changed branch.
    const resetCalls = sync.split('resetAccountState();').length - 1;
    assert.strictEqual(resetCalls, 1);
    assert.ok(sync.indexOf('if (shouldResetAccount(state.identity, identity)) {') < sync.indexOf('resetAccountState();'),
        'the reset must be inside the identity check');
});

test('every async continuation that renders is generation-guarded', () => {
    ['ensureConversation', 'loadExisting', 'refresh', 'sendMessage', 'requestHuman', 'refreshBadge', 'markRead'].forEach((name) => {
        const src = fnSrc(name);
        assert.match(src, /if \(stale\(gen\)\) return( null)?;/, name + '() must discard a cross-account response');
    });
    assert.ok((NATIVE.match(/stale\(gen\)/g) || []).length >= 6);
});

test('Q3: a reset caused by a missing session never re-fetches a transcript', () => {
    const sync = NATIVE.slice(NATIVE.indexOf('    sync: function () {'), NATIVE.indexOf('    }\n', NATIVE.indexOf('    sync: function () {')));
    assert.match(sync, /if \(enabled && identity && state\.open\) loadExisting\(\);/,
        'hydration is gated on an authenticated identity, so a signed-out reset leaves the panel empty');
});

test('opening or closing the panel never touches the identity', () => {
    const open = fnSrc('open');
    const hide = fnSrc('hide');
    assert.doesNotMatch(open, /identity|resetAccountState/);
    assert.doesNotMatch(hide, /identity|resetAccountState/);
});

test('human handoff, polling and duplicate protection are untouched', () => {
    const append = fnSrc('appendMessage');
    assert.match(append, /var known = state\.seen\[id\];/, 'server-id dedupe kept');
    assert.match(append, /if \(known\) \{/, 'a repeated row refreshes instead of re-rendering');
    assert.match(NATIVE, /function reconcileOrAppend/, 'optimistic reconciliation kept');
    assert.match(NATIVE, /if \(state\.sending\) return;/, 'one in-flight send kept');
    assert.match(NATIVE, /if \(state\.creating\) return state\.creating;/, 'one in-flight conversation creation');
    assert.match(NATIVE, /setInterval\(function \(\) \{ if \(state\.open\) refresh\(\); \}, 5000\)/, '5s polling kept');
    assert.match(NATIVE, /if \(conv\.ai_paused && \(conv\.status === 'waiting' \|\| conv\.status === 'assigned'\)\)/, 'human takeover note kept');
    assert.match(NATIVE, /if \(!state\.started\) loadExisting\(\);/, 'open() still hydrates an existing conversation');
});

test('the PR #218 fixes are still in place', () => {
    assert.match(INDEX, /btn\.dataset\.supportBound === '1'/, 'quick-reply binding stays idempotent');
    // The greeting is now the human-only welcome, rendered from exactly one place.
    assert.strictEqual(NATIVE.split("tt('ns.welcome')").length - 1, 0, 'no AI-era greeting remains');
    assert.strictEqual(NATIVE.split("copy('welcome')").length - 1, 1, 'the welcome renders from one path');
});
