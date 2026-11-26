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
// Identity detection
// ---------------------------------------------------------------------------

test('identity: the cached user id wins', () => {
    assert.strictEqual(runIdentity(fakeStore({ arbi_user: JSON.stringify({ id: 42 }), jwt_token: 'tok' })), 'u42');
});

test('identity: falls back to a stable token fingerprint without a cached profile', () => {
    const a = runIdentity(fakeStore({ jwt_token: 'token-a' }));
    const b = runIdentity(fakeStore({ jwt_token: 'token-b' }));
    assert.match(a, /^k[0-9a-z]+$/, 'a token fingerprint is used');
    assert.strictEqual(a, runIdentity(fakeStore({ jwt_token: 'token-a' })), 'same token = same identity');
    assert.notStrictEqual(a, b, 'a different session is a different identity');
});

test('identity: signed out (or malformed cache) is null / still distinguishable', () => {
    assert.strictEqual(runIdentity(fakeStore({})), null);
    const malformed = runIdentity(fakeStore({ arbi_user: '{not json', jwt_token: 'tok' }));
    assert.match(malformed, /^k[0-9a-z]+$/, 'a broken cache falls back to the token');
});

test('identity: two different accounts never share an identity', () => {
    const a = runIdentity(fakeStore({ arbi_user: JSON.stringify({ id: 1 }) }));
    const b = runIdentity(fakeStore({ arbi_user: JSON.stringify({ id: 2 }) }));
    assert.notStrictEqual(a, b);
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
    assert.match(sync, /if \(identity !== state\.identity\) \{/, 'the reset is keyed on the identity, not on every sync');
    assert.match(sync, /resetAccountState\(\);/, 'the reset actually runs');
    assert.match(sync, /state\.identity = identity;/, 'the new identity is recorded');
    assert.match(sync, /if \(enabled && state\.open\) loadExisting\(\);/, 'an open panel hydrates the new account');
});

test('the same account syncing again does NOT reset (transcript preserved)', () => {
    const sync = NATIVE.slice(NATIVE.indexOf('    sync: function () {'), NATIVE.indexOf('    }\n', NATIVE.indexOf('    sync: function () {')));
    // The only reset call sits inside the identity-changed branch.
    const resetCalls = sync.split('resetAccountState();').length - 1;
    assert.strictEqual(resetCalls, 1);
    assert.ok(sync.indexOf('if (identity !== state.identity) {') < sync.indexOf('resetAccountState();'),
        'the reset must be inside the identity check');
});

test('every async continuation that renders is generation-guarded', () => {
    ['start', 'loadExisting', 'refresh', 'sendMessage', 'requestHuman', 'refreshBadge'].forEach((name) => {
        const src = fnSrc(name);
        assert.match(src, /if \(stale\(gen\)\) return;/, name + '() must discard a cross-account response');
    });
    assert.ok((NATIVE.match(/stale\(gen\)/g) || []).length >= 6);
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
    assert.match(NATIVE, /if \(!state\.conversationId \|\| state\.sending\) return;/, 'one in-flight send kept');
    assert.match(NATIVE, /setInterval\(function \(\) \{ if \(state\.open\) refresh\(\); \}, 5000\)/, '5s polling kept');
    assert.match(NATIVE, /if \(conv\.ai_paused && \(conv\.status === 'waiting' \|\| conv\.status === 'assigned'\)\)/, 'human takeover note kept');
    assert.match(NATIVE, /if \(!state\.started\) loadExisting\(\);/, 'open() still hydrates an existing conversation');
});

test('the PR #218 fixes are still in place', () => {
    assert.match(INDEX, /btn\.dataset\.supportBound === '1'/, 'quick-reply binding stays idempotent');
    assert.strictEqual(NATIVE.split("tt('ns.welcome')").length - 1, 1, 'the greeting still renders from one path');
});
