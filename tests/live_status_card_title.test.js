'use strict';
/**
 * The dashboard status card used to be titled "Promotional Credit" for EVERY
 * account that saw it, including accounts with no promotional credit at all
 * ($0 unfunded, funded-but-$0). The header now follows the content: the credit
 * title only when a credit exists, otherwise a neutral Live Mode title.
 *
 * These tests execute the REAL renderLiveModeCard()/startHereLiveSteps() from
 * public/index.html against a minimal DOM, so they pin behaviour rather than a
 * source string.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function dictionary() {
    const at = INDEX.indexOf('const TRANSLATIONS');
    let depth = 0, end = -1;
    for (let i = INDEX.indexOf('{', at); i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('globalThis.T = ' + INDEX.slice(INDEX.indexOf('{', at), end + 1), sandbox);
    return sandbox.T;
}

function extractFunction(name) {
    const start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start > 0, name + ' must exist');
    let depth = 0, seen = false;
    for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
        if (INDEX[i] === '{') { depth++; seen = true; }
        else if (INDEX[i] === '}') { depth--; if (seen && depth === 0) return INDEX.slice(start, i + 1); }
    }
    throw new Error('unbalanced ' + name);
}

function el() {
    const node = { textContent: '', className: '', style: { display: '' }, classList: { add() {}, remove() {}, contains() { return false; } } };
    return node;
}

/** Run the real renderer with a given server payload. */
function render(liveMode) {
    const nodes = {
        liveModeCard: el(), liveModeCardTitle: el(), liveModeCardIcon: el(),
        promoCreditAmountRow: el(), promoCreditAmount: el(), liveModeStatusChip: el(),
        promoCreditExplain: el(), liveModeDepositBtn: el(),
    };
    const T = dictionary();
    const sandbox = {
        APP: { environment: 'PRODUCTION', liveMode, MIN_DEPOSIT: 50 },
        t: (key, vars) => String(T.en[key] !== undefined ? T.en[key] : key)
            .replace(/\{\{(\w+)\}\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m)),
        promoCreditText: (n) => '$' + Number(n || 0).toFixed(2),
        liveModeStatusView: () => ({ badge: 'pending', key: 'liveMode.status.depositRequired' }),
        document: { getElementById: (id) => nodes[id] || null },
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('renderLiveModeCard') + ';globalThis.render = renderLiveModeCard;', sandbox);
    sandbox.render();
    return nodes;
}

test('1. a $0 account never sees a "Promotional Credit" header', () => {
    const nodes = render({ status: 'activation_required', promoCredit: 0 });
    assert.strictEqual(nodes.liveModeCard.style.display, 'block', 'the status card still explains the block');
    assert.strictEqual(nodes.liveModeCardTitle.textContent, 'Live Mode');
    assert.strictEqual(nodes.promoCreditAmountRow.style.display, 'none', 'no $0.00 credit row');
    assert.match(nodes.liveModeCardIcon.className, /fa-bolt/, 'neutral icon, not the gift');
});

test('2. an account WITH a credit keeps the credit header and amount', () => {
    const nodes = render({ status: 'activation_required', promoCredit: 50 });
    assert.strictEqual(nodes.liveModeCardTitle.textContent, 'Promotional Credit');
    assert.strictEqual(nodes.promoCreditAmountRow.style.display, '');
    assert.strictEqual(nodes.promoCreditAmount.textContent, '$50.00');
    assert.match(nodes.liveModeCardIcon.className, /fa-gift/);
});

test('3. a funded $0 account gets the neutral header, not a credit claim', () => {
    const nodes = render({ status: 'funding_required', promoCredit: 0 });
    assert.strictEqual(nodes.liveModeCardTitle.textContent, 'Live Mode');
    assert.strictEqual(nodes.promoCreditAmountRow.style.display, 'none');
});

test('4. a funded account with no credit and no block keeps the dashboard clean', () => {
    const nodes = render({ status: 'available', promoCredit: 0 });
    assert.strictEqual(nodes.liveModeCard.style.display, 'none', 'no extra card');
});

test('5. the sandbox never sees the card and never renders a title', () => {
    const T = dictionary();
    const nodes = { liveModeCard: el(), liveModeCardTitle: el(), liveModeCardIcon: el() };
    const sandbox = {
        APP: { environment: 'MARKETING_SANDBOX', liveMode: { status: 'available', promoCredit: 50 } },
        t: (k) => T.en[k] || k,
        document: { getElementById: (id) => nodes[id] || null },
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('renderLiveModeCard') + ';globalThis.render = renderLiveModeCard;', sandbox);
    sandbox.render();
    assert.strictEqual(nodes.liveModeCard.style.display, 'none');
    assert.strictEqual(nodes.liveModeCardTitle.textContent, '', 'nothing written');
});

test('6. the markup exposes the ids the renderer writes and a sane default', () => {
    assert.match(INDEX, /id="liveModeCardTitle"[^>]*>Promotional Credit</);
    assert.match(INDEX, /id="liveModeCardIcon"/);
    assert.match(INDEX, /data-i18n="promo\.creditTitle"[^>]*id="liveModeCardTitle"|id="liveModeCardTitle"[^>]*data-i18n="promo\.creditTitle"/);
});

test('7. a language switch re-renders the card (dynamic strings are not data-i18n only)', () => {
    const dyn = extractFunction('updateDynamicTranslations');
    assert.match(dyn, /renderLiveModeCard\(\)/);
    assert.ok(dyn.indexOf('renderLiveModeCard()') < dyn.indexOf('updateStartHere()'), 'title/amount rebuilt before the checklist');
});

test('8. the LIVE checklist states the blocker, not a generic next step', () => {
    const T = dictionary();
    const run = (app) => {
        const sandbox = { APP: app, t: (k, v) => String(T.en[k] || k).replace(/\{\{(\w+)\}\}/g, (m, x) => (v && v[x] !== undefined ? v[x] : m)) };
        vm.createContext(sandbox);
        vm.runInContext(extractFunction('startHereLiveSteps') + ';globalThis.f = startHereLiveSteps;', sandbox);
        return sandbox.f();
    };
    const unfunded = run({ MIN_DEPOSIT: 50, liveData: { hasRealDeposit: false } });
    assert.deepStrictEqual(Array.from(unfunded.map((s) => s.key)), ['startHere.live.stepDeposit', 'startHere.live.step3']);
    assert.strictEqual(unfunded[0].vars.min, '50', 'the minimum comes from APP.MIN_DEPOSIT');

    const funded = run({ MIN_DEPOSIT: 50, liveData: { hasRealDeposit: true } });
    assert.deepStrictEqual(Array.from(funded.map((s) => s.key)), ['startHere.live.step3']);

    const custom = run({ MIN_DEPOSIT: 100, liveData: { hasRealDeposit: false } });
    assert.strictEqual(custom[0].vars.min, '100', 'no hard-coded amount');

    const missing = run({ liveData: null });
    assert.strictEqual(missing.length, 2, 'an unknown account still gets the deposit step first');
    assert.strictEqual(missing[0].vars.min, '50', 'falls back to the platform default');
});

test('9. the two new keys are present, localized and placeholder-correct', () => {
    const T = dictionary();
    const enKeys = Object.keys(T.en);
    LANGS.forEach((l) => {
        assert.strictEqual(Object.keys(T[l]).length, enKeys.length, l + ' key count');
        assert.ok(T[l]['liveMode.cardTitle'] && T[l]['liveMode.cardTitle'].trim(), l + ' cardTitle');
        assert.ok(T[l]['startHere.live.stepDeposit'] && T[l]['startHere.live.stepDeposit'].trim(), l + ' stepDeposit');
        assert.ok(/\{\{min\}\}/.test(T[l]['startHere.live.stepDeposit']), l + ' stepDeposit must interpolate the minimum');
        assert.ok(!/\{\{/.test(T[l]['liveMode.cardTitle']), l + ' cardTitle has no placeholder');
        assert.ok(!/\$?\d/.test(T[l]['liveMode.cardTitle']), l + ' cardTitle quotes no amount');
    });
    // Arabic stays right-to-left native script; the card title is not English.
    assert.match(T.ar['liveMode.cardTitle'], /[\u0600-\u06FF]/);
    assert.match(T.zh['liveMode.cardTitle'], /[\u4e00-\u9FFF]/);
});

test('10. display-only: no request, no balance write, no gate change', () => {
    const body = extractFunction('renderLiveModeCard') + extractFunction('startHereLiveSteps');
    assert.ok(!/fetch\(|\/api\/|liveData\.balance\s*=|localStorage\.setItem/i.test(body));
    // The checklist never claims an account can trade before it is funded.
    const T = dictionary();
    assert.match(T.en['startHere.live.stepDeposit'], /deposit/i);
    assert.match(T.en['startHere.live.step3'], /trade/i);
});
