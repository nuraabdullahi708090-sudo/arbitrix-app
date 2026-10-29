'use strict';

/**
 * DEPOSIT DISCOVERABILITY + MOBILE DEPOSIT DIALOG - tests.
 *
 * Covers the funded-account UX work:
 *   - a Deposit action next to the available balance, on screen at every width;
 *   - the deposit dialog keeps its title/close visible (sticky header, no
 *     focus-driven scroll) and the support FAB cannot cover it;
 *   - the live-wallet card is titled "Live Wallet" (translation-key collision
 *     fixed) and an unfunded Live account is not called "Pending Deposit";
 *   - invoice-creation errors are actionable, translated, and never render the
 *     server's own message;
 *   - onboarding offers a path to funding without removing Demo Mode;
 *   - all six locales stay in parity.
 *
 * Nothing here touches crediting, verification, minimums or providers: the
 * existing deposit API, invoice generation and address flow stay the only way
 * an invoice is created.
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
const LOCALES = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

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

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx), depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

function makeEl(id) {
    const node = { id, style: {}, textContent: '', innerHTML: '', scrollTop: 0, classes: new Set() };
    node.classList = {
        add: (c) => node.classes.add(c),
        remove: (c) => node.classes.delete(c),
        contains: (c) => node.classes.has(c),
        toggle: (c, force) => { const on = force === undefined ? !node.classes.has(c) : !!force; if (on) node.classes.add(c); else node.classes.delete(c); },
    };
    return node;
}

// ---------------------------------------------------------------------------
// 1. Deposit action next to the available balance
// ---------------------------------------------------------------------------
test('the Available card carries a Deposit action that opens the existing dialog', () => {
    const cardAt = INDEX.indexOf('id="availableStatCard"');
    assert.ok(cardAt > 0, 'the Available stat card is identified');

    const btnAt = INDEX.indexOf('id="availableDepositBtn"');
    assert.ok(btnAt > cardAt, 'the action lives inside that card, next to the balance');

    const tagStart = INDEX.lastIndexOf('<button', btnAt);
    const tag = INDEX.slice(tagStart, INDEX.indexOf('</button>', tagStart) + '</button>'.length);
    assert.ok(/onclick="openDepositModal\(\)"/.test(tag), 'reuses openDepositModal() - no second deposit flow');
    assert.ok(/class="stat-deposit-btn"/.test(tag), 'uses the dedicated style');
    assert.ok(/data-i18n="stats\.depositCta"/.test(tag), 'label is translated, not hardcoded English');
    // The visible text lives inside a data-i18n span (applyTranslations owns it);
    // the English fallback text is the app-wide pattern, not a hardcoded label.
    assert.ok(/<span data-i18n="stats\.depositCta">[^<]*<\/span>/.test(tag), 'label is an i18n span');

    // It must not create an invoice or talk to the API by itself.
    assert.ok(!/requestDepositAddress|create-invoice|fetch\(/.test(tag), 'the button only opens the dialog');
});

test('the Deposit action is a >=44px touch target and never overflows narrow screens', () => {
    const rule = INDEX.slice(INDEX.indexOf('.stat-deposit-btn{'), INDEX.indexOf('}', INDEX.indexOf('.stat-deposit-btn{')) + 1);
    assert.ok(/min-height:44px/.test(rule), 'meets the 44px touch-target guidance');
    assert.ok(/width:100%/.test(rule), 'fills the card width');
    assert.ok(/white-space:normal/.test(rule) && /overflow-wrap:break-word/.test(rule), 'long translations wrap');
    assert.ok(/focus-visible/.test(INDEX), 'a visible keyboard focus ring exists');
});

test('the Deposit action is visible for production and hidden for MARKETING_SANDBOX', () => {
    const els = {};
    const el = (id) => els[id] || (els[id] = makeEl(id));
    const sandbox = {
        APP: { environment: 'PRODUCTION' },
        document: { getElementById: (id) => (id === 'availableDepositBtn' ? el(id) : null) },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('updateAvailableDepositButton'), sandbox);
    vm.runInContext('updateAvailableDepositButton()', sandbox);
    assert.strictEqual(els.availableDepositBtn.style.display, 'flex');

    sandbox.APP.environment = 'MARKETING_SANDBOX';
    vm.runInContext('updateAvailableDepositButton()', sandbox);
    assert.strictEqual(els.availableDepositBtn.style.display, 'none', 'sandbox recordings are unchanged');

    sandbox.APP.environment = 'PRODUCTION';
    vm.runInContext('updateAvailableDepositButton()', sandbox);
    assert.strictEqual(els.availableDepositBtn.style.display, 'flex', 'restored for production');
});

// ---------------------------------------------------------------------------
// 2. Mobile deposit dialog
// ---------------------------------------------------------------------------
test('the deposit dialog header (title + close) is wrapped in a sticky header', () => {
    const modalAt = INDEX.indexOf('id="depositModal"');
    const headAt = INDEX.indexOf('class="deposit-modal-head"', modalAt);
    assert.ok(headAt > modalAt, 'the dialog has a header element');

    const headEnd = INDEX.indexOf('</div>', headAt);
    const head = INDEX.slice(headAt, headEnd);
    assert.ok(/class="modal-close-btn"/.test(head), 'the close control is inside the sticky header');
    assert.ok(/<h3>/.test(head), 'the title is inside the sticky header');
    assert.ok(/data-i18n="deposit\.title"/.test(head), 'title still translated');
    assert.ok(/onclick="closeDepositModal\(\)"/.test(head), 'close still wired');

    // Scoped so the other .deposit-modal dialogs are untouched.
    assert.ok(/#depositModal \.deposit-modal-head\{position:sticky/.test(INDEX), 'header is sticky');
    assert.ok(/body:has\(#depositModal\.open\) \.support-widget\{display:none;\}/.test(INDEX),
        'the floating support launcher cannot cover the dialog');
    // Every hide of the launcher must stay scoped to an open dialog (:has),
    // never a global rule.
    const hides = INDEX.split('.support-widget{display:none;}');
    assert.ok(hides.length > 1, 'the scoped hide rules exist');
    for (let n = 1; n < hides.length; n++) {
        assert.ok(/:has\(#\w+\.open\) $/.test(hides[n - 1].slice(-60)),
            'support launcher hide #' + n + ' must be scoped to an open dialog');
    }
});

test('opening the dialog never scrolls its header out of view', () => {
    // openDepositModal() must (a) reset the panel scroll and (b) focus the amount
    // field with preventScroll, which is what previously pushed the title and
    // the close button off a 320px screen.
    const fn = extractFunction('openDepositModal');
    assert.ok(/scrollTop = 0/.test(fn), 'panel scroll is reset on open');
    assert.ok(/getElementById\('depositModalContent'\)/.test(fn), 'the scroll container is addressed by id');
    assert.ok(/id="depositModalContent"/.test(INDEX), 'the deposit panel carries that id');
    assert.ok(/focusWithoutScroll\(/.test(fn), 'focus goes through the scroll-safe helper');
    assert.ok(!/\.focus\(\)/.test(fn), 'no plain focus() remains in openDepositModal');

    const helper = extractFunction('focusWithoutScroll');
    assert.ok(/preventScroll: true/.test(helper), 'preventScroll is requested');
    assert.ok(/catch/.test(helper), 'older browsers still get a working fallback');
});

test('openDepositModal() opens at the top and focuses without scrolling (runtime)', () => {
    const els = {};
    const el = (id) => els[id] || (els[id] = makeEl(id));
    const panel = makeEl('panel');
    panel.scrollTop = 400;
    const focusCalls = [];
    const amount = makeEl('liveDepositAmount');
    amount.focus = (opts) => focusCalls.push(opts);
    els.liveDepositAmount = amount;
    el('depositOptions');
    el('depositModal');

    els.depositModalContent = panel;
    const sandbox = {
        APP: { mode: 'live', environment: 'PRODUCTION', MIN_DEPOSIT: 100 },
        document: { getElementById: el },
        resetDepositModal: () => {},
        updateDepositMinNotice: () => {},
        refreshDepositModeNotice: () => {},
        selectDepositOption: () => {},
        loadDepositOptions: () => {},
        updateFirstDepositCta: () => {},
        showToast: () => {},
        t: (k) => k,
        console: { log: () => {} },
    };
    vm.createContext(sandbox);
    vm.runInContext([extractFunction('focusWithoutScroll'), extractFunction('openDepositModal')].join('\n'), sandbox);
    vm.runInContext('openDepositModal()', sandbox);

    assert.strictEqual(panel.scrollTop, 0, 'the panel is scrolled back to the top');
    assert.strictEqual(focusCalls.length, 1, 'the amount field is focused once');
    assert.strictEqual(focusCalls[0] && focusCalls[0].preventScroll, true, 'focused with preventScroll');
    assert.ok(els.depositModal.classes.has('open'), 'the dialog opened');
});

test('Escape closes the deposit dialog but the Support Center keeps priority', () => {
    const closeCalls = [];
    const els = { depositModal: makeEl('depositModal'), supportModal: makeEl('supportModal') };
    els.depositModal.classes.add('open');
    let handler = null;
    const sandbox = {
        document: { getElementById: (id) => els[id] || null, addEventListener: (type, fn) => { if (type === 'keydown') handler = fn; } },
        closeDepositModal: () => closeCalls.push(1),
    };
    vm.createContext(sandbox);
    // Re-create the listener exactly as the page registers it.
    const at = INDEX.indexOf("document.addEventListener('keydown', function (e) {");
    assert.ok(at > 0, 'the Escape handler is registered');
    const end = INDEX.indexOf('\n});', at) + 4;
    vm.runInContext(INDEX.slice(at, end), sandbox);
    assert.ok(handler, 'a keydown listener exists');

    handler({ key: 'Enter' });
    assert.strictEqual(closeCalls.length, 0, 'other keys are ignored');

    handler({ key: 'Escape' });
    assert.strictEqual(closeCalls.length, 1, 'Escape closes the deposit dialog');

    els.supportModal.classes.add('open');
    handler({ key: 'Escape' });
    assert.strictEqual(closeCalls.length, 1, 'the Support Center handles Escape first');

    els.supportModal.classes.delete('open');
    els.depositModal.classes.delete('open');
    handler({ key: 'Escape' });
    assert.strictEqual(closeCalls.length, 1, 'a closed dialog is not re-closed');
});

test('the dialog stays responsive to viewport height', () => {
    assert.ok(/max-height:92vh/.test(INDEX), 'existing vh cap preserved');
    assert.ok(/max-height:92dvh/.test(INDEX), 'dynamic viewport height used where supported');
    assert.ok(/#depositModal \.deposit-modal-content\{display:flex;flex-direction:column/.test(INDEX),
        'the panel is a flex column so the header can stick');
});

// ---------------------------------------------------------------------------
// 3. Live-wallet wording
// ---------------------------------------------------------------------------
test('the live-wallet card is titled "Live Wallet", not "Deposit Funds"', () => {
    const cardAt = INDEX.indexOf('id="liveFunds"');
    assert.ok(cardAt > 0, 'the live wallet card exists');
    const headerAt = INDEX.indexOf('class="card-header"', cardAt);
    const header = INDEX.slice(headerAt, INDEX.indexOf('</div>', headerAt));
    assert.ok(/data-i18n="wallet\.liveTitle"/.test(header), 'uses its own key');
    assert.ok(!/data-i18n="deposit\.title"/.test(header), 'no longer collides with the deposit dialog title');

    const balanceRow = INDEX.slice(INDEX.indexOf('id="liveBalanceDisplay"', cardAt) - 400, INDEX.indexOf('id="liveBalanceDisplay"', cardAt));
    assert.ok(/data-i18n="wallet\.liveBalance"/.test(balanceRow), 'the balance row has its own key too');

    const T = loadTranslations();
    assert.strictEqual(T.en['wallet.liveTitle'], 'Live Wallet');
    assert.strictEqual(T.en['wallet.liveBalance'], 'Live Balance');
    for (const l of LOCALES) {
        assert.ok(String(T[l]['wallet.liveTitle'] || '').trim().length > 0, 'wallet.liveTitle missing for ' + l);
        assert.ok(String(T[l]['wallet.liveBalance'] || '').trim().length > 0, 'wallet.liveBalance missing for ' + l);
        assert.notStrictEqual(T[l]['wallet.liveTitle'], T[l]['deposit.title'],
            'wording must not be the deposit-dialog title for ' + l);
    }
});

test('an unfunded Live account is not described as a pending deposit', () => {
    const T = loadTranslations();
    const pendingWords = {
        en: /pending/i, es: /pendiente/i, pt: /pendente/i,
        fr: /en attente/i, ar: /\u0645\u0639\u0644\u0651\u0642/, zh: /\u5f85/,
    };
    for (const l of LOCALES) {
        const value = String(T[l]['status.livePending'] || '');
        assert.ok(value.trim().length > 0, 'status.livePending missing for ' + l);
        assert.ok(!pendingWords[l].test(value), 'must not imply a payment is pending (' + l + '): ' + value);
    }
    assert.strictEqual(T.en['status.livePending'], 'Live \u2022 Not funded yet');

    // The wording is only used on the "no confirmed deposit" branch, and the
    // funded branch keeps its own key. Deposit-status logic is untouched.
    const at = INDEX.indexOf("accountStatus.textContent = t('status.liveFunded')");
    assert.ok(at > 0, 'the funded branch still exists');
    const fn = INDEX.slice(at - 600, at + 200);
    assert.ok(/if \(APP\.mode === 'demo'\) accountStatus\.textContent = t\('status\.demoTrading'\)/.test(fn),
        'demo branch unchanged');
    assert.ok(/else accountStatus\.textContent = t\('status\.livePending'\)/.test(fn),
        'the unfunded branch still uses status.livePending');
    assert.ok(/else if \(APP\.liveData\.hasRealDeposit\)/.test(fn), 'a confirmed deposit still switches the wording');
});

// ---------------------------------------------------------------------------
// 4. Actionable deposit errors
// ---------------------------------------------------------------------------
function errorSandbox() {
    const els = {};
    const el = (id) => els[id] || (els[id] = makeEl(id));
    const sandbox = {
        document: { getElementById: el },
        t: (k) => 'T:' + k,
        console: { error: () => {} },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        extractFunction('depositInvoiceError'),
        extractFunction('showDepositInvoiceError'),
        extractFunction('clearDepositInvoiceError'),
    ].join('\n'), sandbox);
    return { sandbox, els };
}

test('each invoice failure maps to one safe, translated message', () => {
    const cases = [
        [429, 'deposit.errRateLimited', true],
        [503, 'deposit.errUnavailable', true],
        [500, 'deposit.errUnavailable', true],
        [502, 'deposit.errUnavailable', true],
        [400, 'deposit.errInvalid', true],
        [401, 'deposit.errSession', false],
        [403, 'deposit.errSession', false],
        [418, 'deposit.generateError', true],
    ];
    for (const [status, key, retryable] of cases) {
        const { sandbox } = errorSandbox();
        sandbox.__status = status;
        const err = vm.runInContext('depositInvoiceError(__status)', sandbox);
        assert.strictEqual(err.depositMessageKey, key, 'status ' + status + ' -> ' + key);
        assert.strictEqual(err.retryable, retryable, 'retryable for status ' + status);
        assert.ok(!/\d{3}/.test(err.message), 'no status code leaks into the thrown message');
    }
});

test('the error box shows translated text only and hides retry when it cannot help', () => {
    const { sandbox, els } = errorSandbox();
    sandbox.__err = vm.runInContext("depositInvoiceError(429)", sandbox);
    vm.runInContext('showDepositInvoiceError(__err)', sandbox);
    assert.strictEqual(els.depositInvoiceErrorText.textContent, 'T:deposit.errRateLimited');
    assert.ok(els.depositInvoiceError.classes.has('show'), 'the box is displayed');
    assert.notStrictEqual(els.depositRetryBtn.style.display, 'none', 'retry offered for a rate limit');

    sandbox.__err = vm.runInContext("depositInvoiceError(401)", sandbox);
    vm.runInContext('showDepositInvoiceError(__err)', sandbox);
    assert.strictEqual(els.depositInvoiceErrorText.textContent, 'T:deposit.errSession');
    assert.strictEqual(els.depositRetryBtn.style.display, 'none', 'an expired session needs a sign-in, not a retry');

    vm.runInContext('clearDepositInvoiceError()', sandbox);
    assert.ok(!els.depositInvoiceError.classes.has('show'), 'cleared');
    assert.strictEqual(els.depositInvoiceErrorText.textContent, '', 'no stale text');
});

test('the invoice request never renders a server message and offers help', () => {
    const fn = extractFunction('requestDepositAddress');
    assert.ok(/depositInvoiceError\(response\.status\)/.test(fn), 'the status selects the message');
    assert.ok(!/translateBackendMessage\(data\.error/.test(fn), 'server text is no longer passed to the UI');
    assert.ok(!/showToast\(t\('deposit\.generateError'\)/.test(fn), 'the generic-only toast is gone');
    assert.ok(/showDepositInvoiceError\(error\)/.test(fn), 'the actionable box is used');
    assert.ok(/console\.error/.test(fn), 'detail is kept in the console for support');
    assert.ok(!/innerHTML\s*=\s*[^'"]*(data\.error|error\.message)/.test(fn), 'no raw error render');

    const boxAt = INDEX.indexOf('id="depositInvoiceError"');
    const box = INDEX.slice(boxAt, INDEX.indexOf('</div>', INDEX.indexOf('deposit.getHelp', boxAt)));
    assert.ok(/id="depositRetryBtn"/.test(box), 'a retry action exists');
    assert.ok(/onclick="requestDepositAddress\(\)"/.test(box), 'retry re-runs the same existing call');
    assert.ok(/onclick="openSupportModal\(\)"/.test(box), 'the existing support route is offered');
    assert.ok(/role="alert"/.test(box), 'announced to assistive tech');
});

test('the new error keys exist in every locale and never expose technical detail', () => {
    const T = loadTranslations();
    const keys = ['deposit.retry', 'deposit.getHelp', 'deposit.errRateLimited', 'deposit.errUnavailable',
        'deposit.errSession', 'deposit.errInvalid'];
    for (const l of LOCALES) {
        for (const k of keys) {
            const v = String(T[l][k] || '');
            assert.ok(v.trim().length > 0, k + ' missing for ' + l);
            assert.ok(!/stack|trace|http|api|provider|invoice_|errno|err:/i.test(v), k + ' must stay user-facing (' + l + ')');
            assert.ok(!/\b(4\d\d|5\d\d)\b/.test(v), k + ' must not show a status code (' + l + ')');
        }
    }
    assert.match(T.en['deposit.errRateLimited'], /wait/i);
    assert.match(T.en['deposit.errUnavailable'], /try again/i);
});

// ---------------------------------------------------------------------------
// 5. Onboarding path to funding
// ---------------------------------------------------------------------------
test('onboarding offers a fund-Live path without removing Demo Mode', () => {
    const onbAt = INDEX.indexOf('id="onboardingModal"');
    const onb = INDEX.slice(onbAt, INDEX.indexOf('id="onboardingDepositBtn"', onbAt) + 400);
    assert.ok(/id="onboardingDepositBtn"/.test(onb), 'the funding action exists');
    assert.ok(/onclick="chooseOnboarding\('deposit'\)"/.test(onb), 'it uses the existing onboarding branch');
    assert.ok(/data-i18n="onboarding\.fundLive"/.test(onb), 'label translated');

    // Demo Mode stays the primary, and "Review Live Mode" is still offered.
    assert.ok(/id="onboardingPrimaryBtn" onclick="chooseOnboarding\('demo'\)"/.test(INDEX), 'Demo stays the primary choice');
    assert.ok(/id="onboardingSecondaryBtn" onclick="chooseOnboarding\('live'\)"/.test(INDEX), 'review-only Live kept');

    // Choosing "deposit" hands off to the EXISTING dialog; it creates nothing.
    const fn = extractFunction('chooseOnboarding');
    assert.ok(/openDepositModal\(\)/.test(fn), 'hands off to the existing deposit dialog');
    assert.ok(!/requestDepositAddress|create-invoice|fetch\(/.test(fn), 'no invoice is created by choosing it');

    const T = loadTranslations();
    for (const l of LOCALES) {
        assert.ok(String(T[l]['onboarding.fundLive'] || '').trim().length > 0, 'onboarding.fundLive missing for ' + l);
    }
});

// ---------------------------------------------------------------------------
// 6. Existing deposit + deposit-partner behaviour preserved
// ---------------------------------------------------------------------------
test('the deposit API, address flow and partner workstream are untouched', () => {
    // Same server-side invoice call and same guard rails.
    const fn = extractFunction('requestDepositAddress');
    assert.ok(/fetch\('\/api\/payment\/create-invoice'/.test(fn), 'the existing invoice endpoint is used');
    assert.ok(/APP\.mode === 'demo'/.test(fn), 'the demo-mode guard is preserved');
    assert.ok(/MIN_DEPOSIT_AMOUNT = APP\.MIN_DEPOSIT/.test(fn), 'the minimum still comes from APP.MIN_DEPOSIT');

    // The three-route funding menu and the partner directory are intact.
    for (const id of ['depositOptions', 'depositOptionWallet', 'depositOptionPartner', 'depositOptionCrypto',
        'depositPartnerPanel', 'depositPartnerList', 'depositPartnerEmpty', 'depositBuyCryptoLink',
        'depositWalletPanel', 'depositCryptoFlow']) {
        assert.ok(INDEX.indexOf('id="' + id + '"') > 0, id + ' must still exist');
    }
    assert.ok(/function selectDepositOption\(/.test(INDEX), 'option selection preserved');
    assert.ok(/function renderDepositPartners\(/.test(INDEX), 'partner rendering preserved');
    assert.ok(/function loadDepositOptions\(/.test(INDEX), 'options loading preserved');
    // The card route stays behind the single configurable destination meta and
    // stays disabled by default - this change never enables card payments.
    const metas = INDEX.match(/<meta name="arbitrix-buy-crypto" content="[^"]*">/g) || [];
    assert.strictEqual(metas.length, 1, 'exactly one configurable outward destination');
    assert.ok(!/card payments? (are|is) (now )?available/i.test(INDEX), 'no claim that card payments are live');
});

test('no new deposit entry point bypasses the existing dialog', () => {
    // Every new control opens openDepositModal(); nothing calls the API directly.
    const btnIds = ['availableDepositBtn', 'onboardingDepositBtn'];
    for (const id of btnIds) {
        const at = INDEX.indexOf('id="' + id + '"');
        assert.ok(at > 0, id + ' exists');
        const tag = INDEX.slice(at, INDEX.indexOf('>', at) + 1);
        assert.ok(!/requestDepositAddress|fetch\(|window\.open/.test(tag), id + ' never calls the API or opens a URL');
    }
    // Exactly the pre-existing two controls (live-wallet button + first-deposit
    // card) plus the new Available-card action; the sidebar and onboarding use
    // the same function from JS.
    const callSites = (INDEX.match(/onclick="openDepositModal\(\)"/g) || []).length;
    assert.strictEqual(callSites, 3, 'one deposit dialog, now reachable from the Available card too');
    assert.ok(/id="availableDepositBtn"[^>]*onclick="openDepositModal\(\)"/.test(INDEX), 'the new action is one of them');
});

// ---------------------------------------------------------------------------
// 6b. Narrow-screen density (keeps the action on the first screen at 320px)
// ---------------------------------------------------------------------------
test('narrow phones use a compact 2-column stat grid so the action stays above the fold', () => {
    const marker = '.stats-grid{grid-template-columns:repeat(2,1fr);}';
    const at = INDEX.indexOf(marker);
    assert.ok(at > 0, 'stats keep two columns at the narrow breakpoint');
    const context = INDEX.slice(Math.max(0, at - 600), at);
    assert.ok(/@media\(max-width:\s*379px\)\{/.test(context), 'the rule lives in the 379px breakpoint');
    assert.ok(/\.stats-grid \.card-body\{padding:8px 10px;?\}/.test(INDEX), 'card padding is trimmed');
    assert.ok(/\.stat-value\{font-size:16px;?\}/.test(INDEX), 'the value is scaled to fit a 2-column card');
    assert.ok(!/\.stats-grid\{grid-template-columns:1fr;\}/.test(INDEX), 'the tall single-column stack is gone');
    assert.ok(/\.stat-value\{font-size:22px;?\}/.test(INDEX), 'desktop size preserved');
});
// ---------------------------------------------------------------------------
// 7. i18n parity for all new keys
// ---------------------------------------------------------------------------
test('all six locales define the same keys and every new key is non-empty', () => {
    const T = loadTranslations();
    const base = Object.keys(T.en);
    for (const l of LOCALES) {
        const keys = Object.keys(T[l]);
        assert.strictEqual(keys.length, base.length, l + ' key count');
        const missing = base.filter((k) => !(k in T[l]));
        const extra = keys.filter((k) => !(k in T.en));
        assert.deepStrictEqual(missing, [], l + ' missing keys');
        assert.deepStrictEqual(extra, [], l + ' unexpected keys');
    }
    const added = ['wallet.liveTitle', 'wallet.liveBalance', 'stats.depositCta', 'onboarding.fundLive',
        'demoCta.liveBody', 'deposit.retry', 'deposit.getHelp', 'deposit.errRateLimited',
        'deposit.errUnavailable', 'deposit.errSession', 'deposit.errInvalid'];
    for (const l of LOCALES) {
        for (const k of added) {
            assert.ok(String(T[l][k] || '').trim().length > 0, k + ' must be translated for ' + l);
        }
    }
    // Nothing in the dictionary invents a payment provider or a card claim.
    for (const l of LOCALES) {
        assert.ok(!/visa|mastercard|stripe|paybis|transak|mercuryo/i.test(T[l]['demoCta.liveBody'] || ''), 'no provider claim in the live copy (' + l + ')');
    }
});
