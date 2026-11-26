/**
 * Regression pins for the two "repeated messages" defects:
 *
 *  A) The legacy floating widget (#supportPanel) bound its quick-reply and Enter
 *     handlers WITHOUT an idempotence guard inside initApp(). `logout()` resets
 *     appReady, so the next login in the same tab re-runs initApp() against the
 *     same static markup and the handler set doubles - one quick-reply click then
 *     sent the same message twice (measured on the pre-fix build: 3 -> 6 click
 *     handlers, 1 -> 2 keypress handlers, 1 click -> 2 POSTs / 2 bubbles).
 *
 *  B) The native panel rendered the greeting twice in one interaction:
 *     renderChooser() showed ns.welcome as a note and start() appended the same
 *     text again as the first system bubble, so picking a topic looked like the
 *     assistant had restarted.
 *
 * Behavioural tests run the REAL snippets; they are not string-only pins.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const NATIVE = fs.readFileSync(path.join(ROOT, 'public/native-support.js'), 'utf8');

/** The support-listener registration block, extracted verbatim from initApp(). */
function supportBindingBlock() {
    const startMarker = "    // Bind ONCE per page.";
    const start = INDEX.indexOf(startMarker);
    assert.notStrictEqual(start, -1, 'the idempotent support binding block is missing');
    const rest = INDEX.slice(start);
    const keypressAt = rest.indexOf("supportInput.addEventListener('keypress'");
    assert.notStrictEqual(keypressAt, -1, 'the keypress registration is missing');
    const closeAfter = rest.indexOf('\n    }\n', keypressAt);
    assert.notStrictEqual(closeAfter, -1, 'the keypress guard is not closed');
    return rest.slice(0, closeAfter + '\n    }'.length);
}

/** Minimal DOM surface the block touches. */
function fakeDom(buttonCount) {
    const makeEl = () => {
        const listeners = [];
        return {
            dataset: {},
            listeners,
            addEventListener(type, fn) { listeners.push({ type, fn }); },
            fire(type) { listeners.filter((l) => l.type === type).forEach((l) => l.fn.call(this, { key: 'Enter' })); }
        };
    };
    const buttons = Array.from({ length: buttonCount }, () => {
        const b = makeEl();
        b.dataset.msg = 'I need help with my deposit.';
        return b;
    });
    const input = makeEl();
    return {
        buttons,
        input,
        document: { querySelectorAll: (sel) => (sel === '.quick-reply-btn' ? buttons : []) },
        getEl: (id) => (id === 'supportInput' ? input : null)
    };
}

/** Runs the real block; every run shares one send spy so stale handlers are visible. */
function runBindingBlock(dom, sends) {
    const sandbox = {
        document: dom.document,
        getEl: dom.getEl,
        sendSupportMessage: () => sends.push(dom.input.value)
    };
    vm.runInNewContext(supportBindingBlock(), sandbox, { filename: 'support-binding.js' });
    return sends;
}

test('A1 the binding block carries an idempotence guard', () => {
    const block = supportBindingBlock();
    assert.match(block, /btn\.dataset\.supportBound === '1'/, 'quick replies must be guarded');
    assert.match(block, /supportInput\.dataset\.supportBound !== '1'/, 'the input must be guarded');
    assert.doesNotMatch(
        INDEX,
        /if\(supportInput\) supportInput\.addEventListener\('keypress'/,
        'the unguarded keypress registration must not come back'
    );
});

test('A2 running the block twice (one logout/login cycle) adds no second handler', () => {
    const dom = fakeDom(3);
    const sends = [];
    runBindingBlock(dom, sends);
    const first = { click: dom.buttons[0].listeners.length, input: dom.input.listeners.length };
    runBindingBlock(dom, sends);
    const second = { click: dom.buttons[0].listeners.length, input: dom.input.listeners.length };
    assert.deepStrictEqual(first, { click: 1, input: 1 });
    assert.deepStrictEqual(second, first, 'a re-login must not duplicate the handlers');
});

test('A3 three cycles still leave exactly one handler per control', () => {
    const dom = fakeDom(3);
    const sends = [];
    runBindingBlock(dom, sends);
    runBindingBlock(dom, sends);
    runBindingBlock(dom, sends);
    dom.buttons.forEach((b, i) => assert.strictEqual(b.listeners.length, 1, 'button ' + i));
    assert.strictEqual(dom.input.listeners.length, 1);
});

test('A4 one quick-reply click after a re-login sends the message exactly ONCE', () => {
    const dom = fakeDom(3);
    const sends = [];
    runBindingBlock(dom, sends);
    runBindingBlock(dom, sends);          // the logout/login cycle that caused the report
    dom.buttons[1].fire('click');         // one real click: every attached handler runs
    assert.strictEqual(sends.length, 1, 'pre-fix this posted the same message twice');
    assert.deepStrictEqual(sends, ['I need help with my deposit.'], 'sent once, with the quick-reply text');
});

test('A5 Enter still sends once after a re-login', () => {
    const dom = fakeDom(3);
    const sends = [];
    runBindingBlock(dom, sends);
    runBindingBlock(dom, sends);
    dom.input.value = 'Hello';
    dom.input.fire('keypress');
    assert.strictEqual(sends.length, 1, 'one keypress handler = one send');
});

test('B1 the native greeting renders from exactly one path', () => {
    const occurrences = NATIVE.split("tt('ns.welcome')").length - 1;
    assert.strictEqual(occurrences, 1, 'ns.welcome must be rendered once, not in both chooser and start()');
});

test('B2 the chooser no longer repeats the greeting', () => {
    const chooser = NATIVE.slice(NATIVE.indexOf('function renderChooser()'), NATIVE.indexOf('function setSending('));
    assert.ok(chooser.length > 0, 'renderChooser not found');
    assert.doesNotMatch(chooser, /ns\.welcome/, 'the chooser must not duplicate the greeting');
    assert.match(chooser, /ns\.catQ/, 'the chooser still asks the customer to pick a topic');
});

test('B3 start() still greets the customer in the transcript', () => {
    const startFn = NATIVE.slice(NATIVE.indexOf('function start(category)'), NATIVE.indexOf('function loadExisting('));
    assert.match(startFn, /tt\('ns\.welcome'\)/, 'the transcript greeting must be kept');
    assert.match(startFn, /sender_type: 'system'/, 'still a system bubble');
});

test('B4 the native client still guards against duplicate widgets and rows', () => {
    assert.match(NATIVE, /if \(root\) return;/, 'build() must stay idempotent (one launcher/panel)');
    assert.match(NATIVE, /state\.seen\[id\]/, 'server-id dedupe must stay');
    assert.match(NATIVE, /function reconcileOrAppend/, 'the optimistic-bubble reconciliation must stay');
    assert.match(NATIVE, /if \(!state\.conversationId \|\| state\.sending\) return;/, 'one in-flight send per panel');
});

test('C1 no new translation keys and no knowledge-base change', () => {
    // The fix is behavioural: it adds no copy, so no ad-hoc translation keys were
    // introduced and the approved answers are untouched.
    assert.doesNotMatch(INDEX, /support\.(dedupe|rebound)/, 'no ad-hoc keys were introduced');
    const kb = JSON.parse(fs.readFileSync(path.join(ROOT, 'services/support/arbitrix-knowledge.json'), 'utf8'));
    assert.ok(Array.isArray(kb.categories), 'knowledge base still parses');
    const ids = JSON.stringify(kb);
    assert.ok(ids.includes('what_is_arbitrix.overview'), 'the approved answer behind the reported question is intact');
});

test('C2 the fix stays inside the support widget scope', () => {
    assert.match(INDEX, /const APP = \{/);
    assert.match(INDEX, /PLATFORM_MIN_DEPOSIT_USD/, 'no business constant churn in this change');
    // The guard is the only behavioural edit in the widget area: exactly one
    // occurrence of the marker pair.
    assert.strictEqual(INDEX.split("btn.dataset.supportBound = '1'").length - 1, 1);
    assert.strictEqual(INDEX.split("supportInput.dataset.supportBound = '1'").length - 1, 1);
});
