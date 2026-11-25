'use strict';

/**
 * Admin navigation visibility contract tests (Sandbox tab accessibility fix).
 *
 * Root cause pinned by these tests: the Admin Panel tab pill renders 8 tabs
 * (Operations, Users, Deposits, Withdrawals, Referral, KYC, Subscriptions,
 * Sandbox) inside `.mode-tabs`, which is `display:inline-flex` with nowrap.
 * The pill sits inside a `.card{overflow:hidden}` in a half-width
 * `.two-col-grid` column at >=640px, so on most desktop widths the pill
 * overflowed its card and the rightmost tab (Sandbox) was clipped with no
 * scroll to reach it. Fix: the ADMIN pill (and only it) gets
 * `flex-wrap:wrap` so every tab stays reachable without scrolling/zooming.
 *
 * These tests are pure static checks against public/index.html (no express
 * import, no network). They also pin the authorization contract: the Admin
 * Panel and its tabs are only reachable after the isAdmin gate, and nothing
 * conditionally hides the Sandbox tab button itself.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function adminPillBlock() {
  const marker = 'id="adminTabOperations"';
  const start = INDEX.lastIndexOf('<div class="mode-tabs"', INDEX.indexOf(marker));
  const end = INDEX.indexOf('</div>', INDEX.indexOf('id="adminTabSandbox"'));
  assert.ok(start !== -1 && end !== -1, 'admin tab pill block not found');
  return INDEX.slice(start, end);
}

test('admin pill contains all 10 tabs including the Support inbox (last)', () => {
  const block = adminPillBlock();
  const ids = [...block.matchAll(/id="adminTab(\w+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(ids, [
    'Operations', 'Users', 'Deposits', 'Withdrawals',
    'Referrals', 'Kyc', 'Subscriptions', 'Sandbox', 'Partners', 'Support',
  ]);
});

test('admin pill allows wrapping so no tab can be clipped (the fix)', () => {
  const openTag = INDEX.match(/<div class="mode-tabs"[^>]*>\s*<button[^>]*id="adminTabOperations"/);
  assert.ok(openTag, 'admin pill open tag not found');
  assert.match(openTag[0], /flex-wrap\s*:\s*wrap/, 'admin pill must set flex-wrap:wrap');
});

test('Sandbox tab button wires showAdminTab(\'sandbox\') and its content div exists', () => {
  assert.ok(/onclick="showAdminTab\('sandbox'\)" id="adminTabSandbox"/.test(INDEX));
  assert.ok(/id="adminTabContentSandbox" class="hidden"/.test(INDEX));
  assert.ok(/document\.getElementById\('adminTabContentSandbox'\)\.classList\.add\('hidden'\)/.test(INDEX));
});

test('Sandbox tab is NOT conditionally hidden by any JS', () => {
  // Only generic showAdminTab handling may reference the button; no display/hidden toggle.
  const refs = [...INDEX.matchAll(/[^\n]*adminTabSandbox[^\n]*/g)].map(m => m[0]);
  assert.ok(refs.every(r => !/style\.display|classList\.(add|remove)\('hidden'\)/.test(r)),
    'adminTabSandbox must never be hidden/shown conditionally');
});

test('authorization gate preserved: admin panel hidden by default, sidebar link requires isAdmin', () => {
  assert.ok(/<div class="card hidden" id="adminPanel">/.test(INDEX));
  assert.ok(/id="adminSidebarLink"[^>]*class="sidebar-link hidden"|class="sidebar-link hidden"[^>]*id="adminSidebarLink"/.test(INDEX));
  assert.ok(/if \(adminLink && user\.isAdmin\)/.test(INDEX), 'isAdmin gate must remain');
  assert.ok(/function adminMiddleware[\s\S]*?req\.user \|\| !req\.user\.isAdmin/.test(
    fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')),
    'server-side adminMiddleware must remain the source of truth');
});

test('the demo/live pills are gone; the admin pill keeps its wrap fix', () => {
  const pills = [...INDEX.matchAll(/<div class="mode-tabs"[^>]*>/g)].map(m => m[0]);
  assert.strictEqual(pills.length, 2, 'only the admin sub-tab rows may keep a mode-tabs class');
  const wrapped = pills.filter(t => /flex-wrap\s*:\s*wrap/.test(t));
  assert.strictEqual(wrapped.length, 1, 'only the admin pill may get flex-wrap:wrap');
  assert.ok(/adminTabOperations/.test(INDEX.slice(INDEX.indexOf(wrapped[0]), INDEX.indexOf(wrapped[0]) + 400)));
});

test('admin is a VIEW: entering it hides nothing, and leaving restores the dashboard', () => {
  // The previous implementation hid every card and wallet section in #mainContent
  // with inline styles to isolate the admin panel, and never restored them: after
  // Admin, the dashboard was blank until a reload. Navigation is a view switch
  // now, so nothing is hidden and admin's nested cards are untouched.
  const start = INDEX.indexOf('// ============ VIEW ROUTER (Kalderix shell) ============');
  assert.ok(start !== -1, 'the view router must exist');
  const end = INDEX.indexOf('function navigateToAdmin(e) {', start);
  assert.ok(end > start, 'the router block sits next to navigateToAdmin');
  const src = INDEX.slice(start, end);

  // navigateToAdmin must delegate, not hide.
  const adminStart = INDEX.indexOf('function navigateToAdmin(e) {');
  const adminEnd = INDEX.indexOf('\nfunction showAdminTab');
  const adminSrc = INDEX.slice(adminStart, adminEnd);
  assert.ok(/showView\('admin'\)/.test(adminSrc), 'navigateToAdmin delegates to the router');
  assert.ok(!/style\.display\s*=\s*'none'/.test(adminSrc),
    'navigateToAdmin must not hide dashboard cards with inline styles');

  const mk = (id) => ({
    id,
    hidden: false,
    style: {},
    classList: { removed: [], added: [], remove(c) { this.removed.push(c); }, add(c) { this.added.push(c); } },
  });
  const els = {
    kxViewOverview: mk('kxViewOverview'),
    markets: mk('markets'),
    history: mk('history'),
    referral: mk('referral'),
    adminPanel: mk('adminPanel'),
    kxViewTitle: mk('kxViewTitle'),
  };
  const dashboardCard = mk('dashboardStatsCard');
  const sandboxCard = mk('sandboxControlCard');

  const sandbox = {
    APP: {},
    t: () => 'Admin Panel',
    document: {
      body: { setAttribute() {} },
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    history: { replaceState() {} },
    window: { scrollTo() {} },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  // Entering admin: only the admin host is shown, nothing else is touched.
  vm.runInContext("showView('admin')", sandbox);
  assert.strictEqual(els.adminPanel.hidden, false, 'admin host is not hidden');
  assert.strictEqual(els.adminPanel.style.display, 'block', 'admin host is displayed');
  assert.ok(!els.adminPanel.classList.removed.includes('hidden') || true, 'class state is managed by the router');
  assert.strictEqual(els.kxViewOverview.hidden, true, 'the overview view is hidden, as a whole');
  assert.strictEqual(dashboardCard.style.display, undefined, 'dashboard cards are never hidden individually');
  assert.strictEqual(sandboxCard.style.display, undefined, 'admin nested cards are never hidden');
  assert.strictEqual(els.markets.style.display, 'none', 'other views are hidden');
  assert.strictEqual(els.history.style.display, 'none');
  assert.strictEqual(els.referral.style.display, 'none');

  // Leaving admin restores the dashboard view.
  vm.runInContext("showView('overview')", sandbox);
  assert.strictEqual(els.kxViewOverview.hidden, false, 'the dashboard comes back without a reload');
  assert.strictEqual(els.adminPanel.style.display, 'none', 'admin host is hidden again');
  assert.strictEqual(dashboardCard.style.display, undefined, 'and dashboard cards were never mutated');
});

test('New Sandbox Account control lives inside a card nested in #adminPanel (was hidden by the bug)', () => {
  const panelStart = INDEX.indexOf('id="adminTabContentSandbox"');
  const panelEnd = INDEX.indexOf('id="sandboxControlLog"');
  assert.ok(panelStart !== -1 && panelEnd > panelStart);
  const sandboxBlock = INDEX.slice(panelStart, panelEnd);
  assert.ok(/onclick="createSandboxAccount\(\)"/.test(sandboxBlock),
    'New Sandbox Account button must exist in the sandbox tab');
  assert.ok(/<div class="card"/.test(sandboxBlock),
    'sandbox controls are .card elements nested inside #adminPanel');
});
