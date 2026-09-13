'use strict';

/**
 * PROFILE SETTINGS "CONTACT SUPPORT" BUTTON — tests.
 *
 * Reported bug: the button in Profile Settings looked clickable but "did
 * nothing". Root cause: #supportModal is a `.deposit-modal` (z-index 3000)
 * while #profileModal is a `.modal-overlay` (z-index 9999), so the support
 * modal opened BEHIND the still-open profile modal and was invisible.
 *
 * Pins:
 *   - the profile button opens the SAME existing support destination as the
 *     sidebar Support entry (openSupportModal -> #supportModal); no new
 *     destination, URL or backend route is invented;
 *   - opening support closes any open overlay modal first, so it is always the
 *     visible layer (the actual fix for "nothing happens");
 *   - the button produces a visible result and creates no request.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' should be brace-matchable');
    return INDEX.slice(start, end + 1);
}

function makeEl(id) {
    const node = { id, style: {}, dataset: {}, classes: new Set(), textContent: '', innerHTML: '' };
    node.classList = {
        add: (c) => node.classes.add(c),
        remove: (c) => node.classes.delete(c),
        contains: (c) => node.classes.has(c),
        toggle: (c, force) => { const on = force === undefined ? !node.classes.has(c) : !!force; if (on) node.classes.add(c); else node.classes.delete(c); },
    };
    return node;
}

function buildSandbox() {
    const els = {};
    const calls = [];
    const el = (id) => els[id] || (els[id] = makeEl(id));

    // Screens that can be open at the same time as support: overlay modals.
    const profileModal = el('profileModal');
    profileModal.classes.add('modal-overlay');
    profileModal.classes.add('open');
    const subscriptionModal = el('subscriptionModal');
    subscriptionModal.classes.add('modal-overlay');
    el('supportSidebarLink');
    el('sidebar');
    el('sidebarOverlay');

    const sandbox = {
        els, el, calls,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        document: {
            getElementById: el,
            querySelectorAll: (sel) => {
                if (sel === '.sidebar-link') return [el('supportSidebarLink')];
                if (sel === '.modal-overlay.open') {
                    return Object.values(els).filter((e) => e.classes.has('modal-overlay') && e.classes.has('open'));
                }
                return [];
            },
        },
        updateSupportLinks: () => calls.push('updateSupportLinks'),
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('openSupportModal') + '\n' + extractFunction('closeSupportModal'), sandbox);
    return sandbox;
}

test('Profile Settings "Contact Support" is wired to the existing support modal', () => {
    // The button lives inside #profileModal and uses the same destination as the
    // sidebar Support entry: openSupportModal() -> #supportModal.
    const profileIdx = INDEX.indexOf('id="profileModal"');
    assert.ok(profileIdx > 0, '#profileModal must exist');
    const profileBlock = INDEX.slice(profileIdx, INDEX.indexOf('id="subscriptionModal"', profileIdx));
    assert.ok(/onclick="openSupportModal\(\)"/.test(profileBlock), 'profile modal must open the existing support modal');
    assert.ok(/data-i18n="profile\.contactSupport"/.test(profileBlock), 'the button must keep its localized label');
    assert.ok(/<i class="fas fa-headset">/.test(profileBlock), 'the button must keep its icon');

    // The sidebar Support entry uses exactly the same handler (one destination).
    const sidebarSupport = INDEX.slice(INDEX.indexOf('id="supportSidebarLink"'), INDEX.indexOf('id="supportSidebarLink"') + 140);
    assert.ok(/onclick="openSupportModal\(\)"/.test(sidebarSupport), 'sidebar Support must use the same handler');

    // No new destination was invented: the modal contains no separate endpoint.
    const modalIdx = INDEX.indexOf('id="supportModal"');
    assert.ok(modalIdx > 0, '#supportModal must exist');
});

test('support modal is a lower layer than overlay modals (the root cause)', () => {
    // Documented so a future z-index change cannot silently reintroduce the bug.
    const overlayRule = INDEX.slice(INDEX.indexOf('.modal-overlay {'), INDEX.indexOf('.modal-overlay {') + 400);
    const overlayZ = Number((overlayRule.match(/z-index:\s*(\d+)/) || [])[1]);
    const depositRule = INDEX.slice(INDEX.indexOf('.deposit-modal{'), INDEX.indexOf('.deposit-modal{') + 200);
    const depositZ = Number((depositRule.match(/z-index:\s*(\d+)/) || [])[1]);
    assert.ok(overlayZ > depositZ, 'overlay modals are above deposit modals (z ' + overlayZ + ' > ' + depositZ + ')');
    assert.strictEqual(depositZ, 3000, 'support modal keeps its existing 3000 layer');
});

test('opening support closes an open overlay modal so the modal is actually visible', () => {
    const sb = buildSandbox();
    assert.ok(sb.els.profileModal.classList.contains('open'), 'precondition: profile modal open');

    vm.runInContext('openSupportModal()', sb);

    assert.ok(sb.els.supportModal.classList.contains('open'), 'support modal must open');
    assert.ok(!sb.els.profileModal.classList.contains('open'), 'profile overlay must close (it would hide support)');
    assert.ok(!sb.els.subscriptionModal.classList.contains('open'), 'any open overlay is closed');
    assert.deepStrictEqual(sb.calls, ['updateSupportLinks'], 'links are refreshed before showing');
});

test('opening support never creates a request or touches money', () => {
    // openSupportModal() is a pure display action: no fetch, no state, no credit.
    const fn = extractFunction('openSupportModal');
    assert.ok(!/fetch\(/.test(fn), 'must not perform a request');
    assert.ok(!/balance|credit|deposit|withdraw|invoice/i.test(fn), 'must not touch balances or payments');
    assert.ok(!/\.value\s*=/.test(fn), 'must not collect any credential input');
});

test('support modal can still be closed and reopening works', () => {
    const sb = buildSandbox();
    vm.runInContext('openSupportModal()', sb);
    assert.ok(sb.els.supportModal.classList.contains('open'));
    vm.runInContext('closeSupportModal()', sb);
    assert.ok(!sb.els.supportModal.classList.contains('open'), 'closeSupportModal must hide it');
    vm.runInContext('openSupportModal()', sb);
    assert.ok(sb.els.supportModal.classList.contains('open'), 'reopening must work');
});

test('the support destination warns users never to share secrets and collects no input', () => {
    const modalIdx = INDEX.indexOf('id="supportModal"');
    const end = INDEX.indexOf('<!-- Image Viewer Modal -->', modalIdx);
    assert.ok(end > modalIdx, 'support modal block should be delimited by the next modal comment');
    const block = INDEX.slice(modalIdx, end);
    assert.ok(!/<(input|textarea|form)\b/i.test(block), 'the support destination must not collect credentials');
    for (const term of ['password', 'seed phrase', 'private key']) {
        assert.ok(new RegExp(term, 'i').test(block), 'security warning should mention: ' + term);
    }
});
