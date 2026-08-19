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

test('admin pill contains all 8 tabs including Sandbox (last)', () => {
  const block = adminPillBlock();
  const ids = [...block.matchAll(/id="adminTab(\w+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(ids, [
    'Operations', 'Users', 'Deposits', 'Withdrawals',
    'Referrals', 'Kyc', 'Subscriptions', 'Sandbox',
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

test('other mode-tabs pills are untouched by the fix', () => {
  const pills = [...INDEX.matchAll(/<div class="mode-tabs"[^>]*>/g)].map(m => m[0]);
  assert.strictEqual(pills.length, 3, 'expected 3 mode-tabs pills');
  const wrapped = pills.filter(t => /flex-wrap\s*:\s*wrap/.test(t));
  assert.strictEqual(wrapped.length, 1, 'only the admin pill may get flex-wrap:wrap');
  assert.ok(/adminTabOperations/.test(INDEX.slice(INDEX.indexOf(wrapped[0]), INDEX.indexOf(wrapped[0]) + 400)));
});

test('navigateToAdmin hides dashboard cards but never cards inside #adminPanel', () => {
  // Extract and run the REAL navigateToAdmin() source against a minimal DOM stub.
  const start = INDEX.indexOf('function navigateToAdmin(e) {');
  const end = INDEX.indexOf('\nfunction showAdminTab');
  assert.ok(start !== -1 && end > start, 'navigateToAdmin source not found');
  const src = INDEX.slice(start, end);
  assert.ok(src.includes("!el.closest('#adminPanel')"),
    'hide loop must skip cards nested inside #adminPanel');

  // Fake DOM: dashboard card + wallet section (outside admin), adminPanel,
  // an admin stat card and a sandbox control card (inside admin).
  const mkEl = (id, insideAdmin) => ({
    id,
    style: {},
    classList: { remove() {}, add() {} },
    closest: (sel) => (sel === '#adminPanel' && insideAdmin ? adminPanel : null),
  });
  const adminPanel = mkEl('adminPanel', true);
  const dashboardCard = mkEl('dashboardStatsCard', false);
  const walletSection = mkEl('walletSection1', false);
  const adminStatCard = mkEl('', true);
  const sandboxCard = mkEl('', true);
  const mainContent = {
    querySelectorAll: (sel) =>
      sel === '.card, .wallet-section'
        ? [dashboardCard, walletSection, adminPanel, adminStatCard, sandboxCard]
        : [],
  };
  const document = {
    getElementById: (id) =>
      ({ mainContent, adminPanel, sidebar: mkEl('sidebar', false), sidebarOverlay: mkEl('sidebarOverlay', false) }[id] || null),
    querySelectorAll: () => [],
  };
  const sandbox = {
    document,
    localStorage: { getItem: () => null },
    window: { scrollTo() {} },
    loadAdminData() {},
    console,
  };
  vm.runInNewContext(src + '\nnavigateToAdmin();', sandbox);

  // dashboard cards/sections outside #adminPanel are still hidden
  assert.strictEqual(dashboardCard.style.display, 'none');
  assert.strictEqual(walletSection.style.display, 'none');
  // #adminPanel itself remains visible
  assert.strictEqual(adminPanel.style.display, 'block');
  // cards inside #adminPanel are NOT hidden (display untouched)
  assert.strictEqual(adminStatCard.style.display, undefined);
  assert.strictEqual(sandboxCard.style.display, undefined);
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
