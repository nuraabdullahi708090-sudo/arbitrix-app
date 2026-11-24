'use strict';
/**
 * Return-to-dashboard navigation (PR #204).
 *
 * The owner's report: from Markets / Transaction Log / Referral / Admin the only
 * way back to the dashboard was the hamburger menu. Two entry points now do it in
 * one tap - the Kalderix brand (a real link) and a contextual `← Dashboard` control
 * in the toolbar - and the browser's Back button returns to the previous view.
 *
 * These tests execute the REAL router (`showView`) and the REAL helpers in a vm
 * with a fake DOM, so they check behaviour, not just source strings. Layout
 * (header height, overflow, overlap) is verified in the browser audit recorded in
 * docs/design/VISUAL_REVIEW_2026-11.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* ------------------------------------------------------------------ harness */
function mkElement(id) {
  const attrs = {};
  return {
    id,
    hidden: false,
    style: {},
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); },
      remove(...c) { c.forEach((x) => this.set.delete(x)); },
      contains(c) { return this.set.has(c); },
    },
    attrs,
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k]; },
  };
}

function buildSandbox() {
  const ids = [
    'kxViewOverview', 'markets', 'history', 'referral', 'adminPanel', 'kxViewTitle',
    'kxBackToDashboard', 'kxToolbarBrand', 'supportPanel',
  ];
  const els = {};
  ids.forEach((id) => { els[id] = mkElement(id); });
  // Two dialogs that "are open" - the helper must close them via their own button.
  const modalButton = { clicks: 0, click() { this.clicks++; } };
  const openModals = [0, 1].map((i) => {
    const el = mkElement('modal' + i);
    el.classList.add('open');
    el.querySelector = (sel) => (sel.indexOf('modal-close') !== -1 ? modalButton : null);
    return el;
  });
  const activeLink = mkElement('activeLink');
  const activeLinkFor = { current: activeLink };

  const history = {
    pushed: [],
    replaced: [],
    pushState(a, b, url) { this.pushed.push(url); sandbox.location.hash = url; },
    replaceState(a, b, url) { this.replaced.push(url); sandbox.location.hash = url; },
  };

  const sandbox = {
    APP: {},
    t: (k) => ({ 'sidebar.dashboard': 'Dashboard', 'sidebar.markets': 'Markets', 'sidebar.history': 'Transaction Log',
      'sidebar.referral': 'Referral', 'sidebar.admin': 'Admin Panel', 'nav.backToDashboard': 'Back to Dashboard' }[k] || ''),
    document: {
      body: { attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } },
      getElementById: (id) => els[id] || null,
      querySelectorAll: (sel) => {
        if (sel === '.sidebar-link') return [activeLink];
        if (sel.indexOf('.modal-overlay.open') !== -1) return openModals;
        return [];
      },
      querySelector: (sel) => {
        // The real router asks for the nav link that belongs to the view just set.
        const want = sel.match(/data-section="([^"]+)"/);
        const admin = sel.indexOf('adminSidebarLink');
        if (admin >= 0) return activeLinkFor.current;
        if (want) return activeLinkFor.current;
        return null;
      },
    },
    history,
    location: { hash: '' },
    window: { scrollTo() {} },
    console,
  };
  sandbox.__els = els;
  sandbox.__modalButton = modalButton;
  sandbox.__openModals = openModals;
  vm.createContext(sandbox);

  const start = INDEX.indexOf('// ============ VIEW ROUTER (Kalderix shell) ============');
  const end = INDEX.indexOf('function navigateToAdmin(e) {', start);
  assert.ok(start > 0 && end > start, 'the router block is locatable');
  vm.runInContext(INDEX.slice(start, end), sandbox);
  return sandbox;
}

const SECONDARY = ['markets', 'activity', 'referral', 'admin'];

/* ------------------------------------------------------- 1. markup + a11y */
test('the brand is a real link home and keeps its presentation', () => {
  const at = INDEX.indexOf('id="kxToolbarBrand"');
  assert.ok(at > 0, 'the brand carries a stable id');
  const tag = INDEX.slice(INDEX.lastIndexOf('<', at), INDEX.indexOf('>', at) + 1);
  assert.match(tag, /^<a\b/, 'a link, so Enter/Back/right-click behave natively');
  assert.match(tag, /class="app-header-brand kx-brand-link"/, 'the original class is preserved');
  assert.match(tag, /href="#overview"/, 'the dashboard hash route');
  assert.match(tag, /onclick="return goToDashboard\(event\)"/, 'the click is routed through one helper');
  assert.match(tag, /data-i18n-title="nav.backToDashboard"/, 'localized tooltip');

  // The logo mark + wordmark are untouched inside the link.
  const inner = INDEX.slice(at, INDEX.indexOf('</a>', at));
  assert.match(inner, /class="kx-logo"/, 'the mark is still rendered');
  assert.match(inner, /class="kx-wordmark"/, 'the wordmark is still rendered');
  assert.match(inner, /Kal<span>derix<\/span>/, 'and still reads Kalderix');
});

test('the toolbar control is a labelled navigation link, not a close button', () => {
  const at = INDEX.indexOf('id="kxBackToDashboard"');
  const tag = INDEX.slice(INDEX.lastIndexOf('<', at), INDEX.indexOf('>', at) + 1);
  assert.match(tag, /^<a\b/, 'navigation is a link');
  assert.match(tag, /href="#overview"/);
  assert.match(tag, /hidden/, 'hidden until a secondary view is shown');
  assert.match(tag, /aria-label|data-i18n-aria-label/, 'has an accessible name');

  const block = INDEX.slice(at, INDEX.indexOf('</a>', at));
  assert.match(block, /fa-arrow-left/, 'a back arrow, not an X');
  assert.ok(!/fa-xmark|fa-times|fa-close/.test(block), 'no generic close glyph');
  assert.match(block, /data-i18n="sidebar\.dashboard"/, 'the visible label is the localized word Dashboard');
});

test('the control does not rely on !important and collapses on small screens', () => {
  assert.match(INDEX, /\.kx-back-dash\[hidden\]\{display:none;\}/, 'attribute selector wins without !important');
  assert.match(INDEX, /@media \(max-width:479px\)\{[\s\S]{0,400}?\.kx-back-dash\{width:32px;height:30px;/,
    'icon-only below 480px (the labelled pill wraps the toolbar at 431px)');
  assert.match(INDEX, /\.kx-back-dash \.kx-back-dash-label\{\s*position:absolute;width:1px;height:1px/,
    'the label stays in the accessibility tree');
  assert.match(INDEX, /@media \(max-width:340px\)\{[\s\S]{0,200}?\.kx-back-dash\{width:30px;height:28px;\}/,
    '320px gives back the last few pixels instead of wrapping');
  assert.match(INDEX, /\.kx-brand-link:focus-visible\{outline:2px solid var\(--kx-accent\)/, 'keyboard focus is visible');
  assert.match(INDEX, /\.app-header-brand\{text-decoration:none;color:inherit;\}/, 'the link looks like the old div');
});

/* -------------------------------------------- 2. behaviour: every secondary view */
test('the control is hidden on the dashboard and shown on every secondary view', () => {
  const sandbox = buildSandbox();
  const back = sandbox.__els.kxBackToDashboard;

  vm.runInContext("showView('overview')", sandbox);
  assert.strictEqual(back.hidden, true, 'hidden on the dashboard');
  assert.strictEqual(back.getAttribute('aria-hidden'), 'true');

  SECONDARY.forEach((name) => {
    vm.runInContext("showView('" + name + "')", sandbox);
    assert.strictEqual(back.hidden, false, name + ': the control is offered');
    assert.strictEqual(back.getAttribute('aria-hidden'), 'false');
  });

  vm.runInContext("showView('overview')", sandbox);
  assert.strictEqual(back.hidden, true, 'hidden again after returning');
});

test('the toolbar title and the active nav link follow the view', () => {
  const sandbox = buildSandbox();
  const title = sandbox.__els.kxViewTitle;
  const expected = {
    overview: 'Dashboard', markets: 'Markets', activity: 'Transaction Log',
    referral: 'Referral', admin: 'Admin Panel',
  };
  Object.keys(expected).forEach((view) => {
    vm.runInContext("showView('" + view + "')", sandbox);
    assert.strictEqual(title.textContent, expected[view], view + ': title is accurate');
    assert.strictEqual(sandbox.document.body.attrs['data-kx-view'], view);
  });
});

test('the control returns to the dashboard from every secondary view', () => {
  SECONDARY.forEach((startView) => {
    const sandbox = buildSandbox();
    vm.runInContext("showView('" + startView + "')", sandbox);
    assert.strictEqual(sandbox.APP.kxView, startView);

    const returned = vm.runInContext('goToDashboard({ preventDefault() { this.prevented = true; } })', sandbox);
    assert.strictEqual(returned, false, 'the inline handler return value cancels the default');
    assert.strictEqual(sandbox.APP.kxView, 'overview', startView + ' -> overview');
    assert.strictEqual(sandbox.__els.kxViewOverview.hidden, false, 'the dashboard host is visible');
    assert.strictEqual(sandbox.__els.markets.style.display, 'none', 'the other hosts are hidden');
    assert.strictEqual(sandbox.__els.kxBackToDashboard.hidden, true, 'the control hides itself');
    assert.strictEqual(sandbox.__els.kxViewTitle.textContent, 'Dashboard');
    assert.strictEqual(sandbox.location.hash, '#overview');
  });
});

test('the brand does the same thing as the control', () => {
  SECONDARY.forEach((startView) => {
    const sandbox = buildSandbox();
    vm.runInContext("showView('" + startView + "')", sandbox);
    vm.runInContext('goToDashboard({ preventDefault() {} })', sandbox);
    assert.strictEqual(sandbox.APP.kxView, 'overview', 'brand from ' + startView);
  });
  // Both entry points call one helper, so they cannot drift apart.
  const tagBrand = INDEX.slice(INDEX.indexOf('id="kxToolbarBrand"') - 120, INDEX.indexOf('id="kxToolbarBrand"') + 200);
  const tagBack = INDEX.slice(INDEX.indexOf('id="kxBackToDashboard"') - 120, INDEX.indexOf('id="kxBackToDashboard"') + 200);
  assert.match(tagBrand, /goToDashboard\(event\)/);
  assert.match(tagBack, /goToDashboard\(event\)/);
});

test('returning to the dashboard closes whatever was open on top of it', () => {
  const sandbox = buildSandbox();
  vm.runInContext("showView('markets')", sandbox);
  sandbox.__els.supportPanel.classList.add('open');
  sandbox.document.body.style.overflow = 'hidden';

  vm.runInContext('goToDashboard({ preventDefault() {} })', sandbox);

  assert.strictEqual(sandbox.__modalButton.clicks, 2, 'each open dialog ran its own close handler');
  sandbox.__openModals.forEach((m, i) => assert.ok(!m.classList.contains('open'), 'dialog ' + i + ' closed'));
  assert.ok(!sandbox.__els.supportPanel.classList.contains('open'), 'the support panel is closed');
  assert.strictEqual(sandbox.document.body.style.overflow, '', 'the scroll lock is released');
});

/* -------------------------------------------------------- 3. history / Back */
test('a user navigation pushes, so Back returns to the previous view', () => {
  const sandbox = buildSandbox();
  vm.runInContext("showView('overview', { initial: true, silentHash: true })", sandbox);
  assert.deepStrictEqual(sandbox.history.pushed, [], 'boot adds no history entry');
  assert.deepStrictEqual(sandbox.history.replaced, [], 'and does not rewrite the URL');

  vm.runInContext("showView('markets')", sandbox);
  vm.runInContext("showView('referral')", sandbox);
  assert.deepStrictEqual(sandbox.history.pushed, ['#markets', '#referral']);

  // Re-rendering the same view must not stack duplicate entries.
  vm.runInContext("showView('referral')", sandbox);
  assert.deepStrictEqual(sandbox.history.pushed, ['#markets', '#referral'], 'no duplicate entry');

  // The hash reconciliation (a Back press) stays silent.
  sandbox.location.hash = '#markets';
  vm.runInContext("showView(kxViewFromHash(), { silentHash: true })", sandbox);
  assert.deepStrictEqual(sandbox.history.pushed, ['#markets', '#referral'], 'Back is not recorded as a new entry');
  assert.strictEqual(sandbox.APP.kxView, 'markets', 'the hash drove the view');
});

test('deep links resolve on load and show the control immediately', () => {
  const sandbox = buildSandbox();
  sandbox.location.hash = '#referral';
  vm.runInContext("showView(kxViewFromHash(), { silentHash: true, initial: true })", sandbox);
  assert.strictEqual(sandbox.APP.kxView, 'referral');
  assert.strictEqual(sandbox.__els.kxBackToDashboard.hidden, false);
  assert.strictEqual(sandbox.__els.kxViewTitle.textContent, 'Referral');
  assert.strictEqual(sandbox.kxNormalizeView('nonsense'), 'overview', 'unknown hashes still fall back home');
});

/* -------------------------------------------------------------------- 4. i18n */
test('one new key names the control in every locale', () => {
  const start = INDEX.indexOf('const TRANSLATIONS = {');
  let depth = 0, end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const sandbox = {};
  vm.runInNewContext('this.__T = ' + INDEX.slice(INDEX.indexOf('{', start), end) + ';', sandbox);
  const T = sandbox.__T;
  const langs = Object.keys(T).sort();
  assert.deepStrictEqual(langs, ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
  const base = Object.keys(T.en).sort();
  langs.forEach((l) => {
    assert.deepStrictEqual(Object.keys(T[l]).sort(), base, l + ': identical key set');
    assert.ok(String(T[l]['nav.backToDashboard'] || '').trim(), l + ': the key is translated');
  });
  assert.strictEqual(T.en['nav.backToDashboard'], 'Back to Dashboard');
  // The visible label reuses the existing Dashboard wording instead of a new key.
  assert.strictEqual(T.en['sidebar.dashboard'], 'Dashboard');
});

/* ------------------------------------------------------------------- 5. scope */
test('the change is navigation only', () => {
  ['kxCloseTransientSurfaces', 'kxSyncDashboardNav', 'goToDashboard'].forEach((name) => {
    const at = INDEX.indexOf('function ' + name);
    assert.ok(at > 0, name + ' exists');
    const src = INDEX.slice(at, INDEX.indexOf('\n}', at));
    assert.ok(!/fetch\(|XMLHttpRequest|\/api\/|record_trade|updateWallet/.test(src),
      name + ' performs no request and touches no money');
  });
  // showView still owns visibility/title/active state and nothing financial.
  const at = INDEX.indexOf('function showView(name, opts) {');
  const src = INDEX.slice(at, INDEX.indexOf('\n}', INDEX.indexOf('return view;', at)));
  assert.ok(!/fetch\(|balance|trade/.test(src), 'the router cannot move money');
  assert.ok(/kxSyncDashboardNav\(view\)/.test(src), 'the control is synced by the router');
});
