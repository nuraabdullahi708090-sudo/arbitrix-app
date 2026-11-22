'use strict';
/**
 * Notification panel layout: the panel must open inside the viewport, anchored to
 * its bell, on phones.
 *
 * Background (measured on the pre-fix build at 390x844): the panel used
 * `position:fixed; bottom:0` for the mobile bottom sheet, but it lives inside
 * `.app-header` (#appToolbar), which carries `backdrop-filter: blur(12px)`. A
 * non-none backdrop-filter makes that element the CONTAINING BLOCK for
 * `position:fixed` descendants, so `bottom:0` resolved to the header's bottom
 * edge (y=103) instead of the viewport's (y=844). The panel rendered at y=-389,
 * 389px above the screen, and `elementFromPoint()` on its items returned null -
 * the bell "did nothing" although the open/close class toggled correctly.
 *
 * Two tiers:
 *   1. CSS invariants, always run. They describe the layout RULE (no fixed
 *      positioning for a panel inside a filtered ancestor; absolute + 100% top
 *      anchoring; viewport-bounded width/height), not a literal string match.
 *   2. Real-browser geometry via puppeteer-core + Chromium when available: real
 *      rects, real hit-testing, real clicks. Skips (never fails) where no browser
 *      exists, so CI stays green.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// CSS reader: split the stylesheet into top-level and @media segments, then read
// the declarations of a selector from each. Enough to assert LAYOUT RULES (which
// positioning a rule establishes) without pulling in a CSS parser dependency.
// ---------------------------------------------------------------------------

function stylesheetText(text) {
  const out = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  // Strip comments: a comment sitting between an opening brace and its selector
  // would otherwise be glued to that selector and hide the rule from rulesFor().
  return out.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

function segments(css) {
  const out = [];
  const re = /@media[^{]*\{/g;
  let m, last = 0;
  while ((m = re.exec(css))) {
    out.push({ media: null, text: css.slice(last, m.index) });
    let depth = 1, k = re.lastIndex;
    while (k < css.length && depth > 0) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') depth--;
      k++;
    }
    out.push({ media: m[0].slice(0, -1).trim(), text: css.slice(re.lastIndex, k - 1) });
    last = k;
    re.lastIndex = k;
  }
  out.push({ media: null, text: css.slice(last) });
  return out;
}

const CSS = stylesheetText(html);
const SEGMENTS = segments(CSS);

const decls = (body) => {
  const out = {};
  body.split(';').forEach((pair) => {
    const idx = pair.indexOf(':');
    if (idx === -1) return;
    const prop = pair.slice(0, idx).trim().toLowerCase();
    if (prop) out[prop] = pair.slice(idx + 1).trim();
  });
  return out;
};

/** Every declaration block for `selector`, tagged with its media context. */
function rulesFor(selector, mediaTest) {
  const found = [];
  for (const seg of SEGMENTS) {
    if (mediaTest && !mediaTest(seg.media)) continue;
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(seg.text))) {
      const sels = m[1].split(',').map((x) => x.trim());
      if (sels.indexOf(selector) === -1) continue;
      found.push({ media: seg.media, selector: m[1].trim(), d: decls(m[2]) });
    }
  }
  return found;
}
/** Rules whose selector ENDS with `selector` (covers `html[dir="rtl"] .x` too). */
function rulesEndingWith(selector, mediaTest) {
  const found = [];
  for (const seg of SEGMENTS) {
    if (mediaTest && !mediaTest(seg.media)) continue;
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(seg.text))) {
      const sels = m[1].split(',').map((x) => x.trim());
      if (!sels.some((x) => x.endsWith(selector))) continue;
      found.push({ media: seg.media, selector: m[1].trim(), d: decls(m[2]) });
    }
  }
  return found;
}

const isMobileMedia = (m) => !!m && /max-width\s*:\s*(\d+)px/.test(m) && Number(RegExp.$1) <= 640;
const mergedMobile = () => Object.assign({}, ...rulesFor('.notification-panel', isMobileMedia).map((r) => r.d));

// ---------------------------------------------------------------------------
// Tier 1 - layout invariants (always run)
// ---------------------------------------------------------------------------

test('the notification panel is a child of the positioned bell wrapper', () => {
  // Anchoring only works if .notification-wrapper is the nearest positioned
  // ancestor; otherwise `position:absolute` would resolve somewhere else.
  const idx = html.indexOf('id="notificationPanel"');
  assert.ok(idx > 0, 'panel must exist');
  const before = html.slice(Math.max(0, idx - 1200), idx);
  const wrapperAt = before.lastIndexOf('class="notification-wrapper"');
  assert.ok(wrapperAt !== -1, 'the panel must live inside .notification-wrapper');
  assert.ok(!/<div[^>]*id="mainContent"[^>]*>[\s\S]*$/.test(before.slice(wrapperAt)),
    'the wrapper must still contain the panel (no stray close)');
  assert.ok(rulesFor('.notification-wrapper').some((r) => r.d.position === 'relative'),
    '.notification-wrapper must be positioned so absolute anchoring resolves against it');
});

test('on mobile the panel is NOT position:fixed (the containing-block trap)', () => {
  const mobile = rulesFor('.notification-panel', isMobileMedia);
  assert.ok(mobile.length > 0, 'a mobile rule for .notification-panel must exist');
  for (const rule of mobile) {
    assert.notStrictEqual(rule.d.position, 'fixed',
      'position:fixed inside the backdrop-filtered header is the defect: it anchors to the header (' + rule.media + ')');
  }
});

test('on mobile the panel is anchored below its bell, not to the viewport edge', () => {
  const merged = mergedMobile();
  assert.strictEqual(merged.position, 'absolute', 'mobile panel must use absolute positioning');
  assert.ok(/^calc\(\s*100%\s*\+/.test(merged.top || ''),
    'top must be 100% (the bell wrapper height) plus a gap, got: ' + merged.top);
  assert.ok(!('bottom' in merged) || merged.bottom === 'auto', 'bottom must not pin the panel');
  assert.strictEqual(merged.right, '0', 'the panel is right-aligned to the bell in LTR');
});

test('the mobile panel width is viewport-bounded, never 100% of the wrapper', () => {
  const merged = mergedMobile();
  assert.ok(/vw/.test(merged.width || ''), 'width must be expressed in vw units, got: ' + merged.width);
  assert.notStrictEqual(merged.width, '100%', '100% would be the 36px-wide wrapper');
  // and no rule in any media context may re-introduce a bare 100% width
  const any100 = rulesFor('.notification-panel').filter((r) => (r.d.width || '') === '100%');
  assert.deepStrictEqual(any100, [], 'no rule may set .notification-panel width:100%');
});

test('the mobile panel height is viewport-bounded and the list scrolls inside', () => {
  const merged = mergedMobile();
  assert.ok(/(vh|dvh)/.test(merged['max-height'] || ''), 'max-height must use viewport units, got: ' + merged['max-height']);
  const list = rulesFor('.notification-list').map((r) => r.d['overflow-y']);
  assert.ok(list.some((v) => v === 'auto'), 'the list must scroll inside the capped panel');
});

test('RTL mirrors the anchoring instead of falling back to the LTR edge', () => {
  const rtl = rulesEndingWith('.notification-panel').filter((r) => /dir="rtl"/.test(r.selector));
  assert.ok(rtl.some((r) => isMobileMedia(r.media) && r.d.left === '0'), 'a mobile RTL rule must anchor left:0');
  assert.ok(rtl.some((r) => r.d.left === '0'), 'the base RTL rule must still exist');
});

test('the desktop panel rule is unchanged', () => {
  const merged = Object.assign({}, ...rulesFor('.notification-panel', (m) => m === null).map((r) => r.d));
  assert.strictEqual(merged.position, 'absolute');
  assert.strictEqual(merged.top, 'calc(100% + 8px)');
  assert.strictEqual(merged.right, '0');
  assert.strictEqual(merged.width, '360px');
  assert.strictEqual(merged['max-height'], '480px');
});

test('the fix keeps the header blur (it does not "solve" the trap by deleting it)', () => {
  const header = rulesFor('.app-header').map((r) => r.d).filter((d) => d['backdrop-filter']);
  assert.ok(header.length > 0, '.app-header must still declare backdrop-filter');
  assert.match(header[header.length - 1]['backdrop-filter'], /blur\(/, 'the frosted toolbar look is preserved');
});

test('the panel keeps its interaction surface (no changes to open/close or items)', () => {
  const base = Object.assign({}, ...rulesFor('.notification-panel', (m) => m === null).map((r) => r.d));
  assert.strictEqual(base.display, 'none', 'closed by default');
  const openRule = rulesFor('.notification-panel.open');
  assert.ok(openRule.length > 0, '.open must still exist');
  assert.ok(openRule.some((r) => r.d.display === 'flex'), '.open must still display the panel');
  assert.match(base['z-index'] || '', /^1000\d$/, 'stacking order unchanged (above page content, below modals)');
  // handlers untouched by this PR
  assert.match(html, /function toggleNotifications\(/, 'toggleNotifications must exist');
  assert.match(html, /id="notificationBtn"[^>]*onclick="toggleNotifications\(\)"/, 'the bell keeps its inline handler');
});

// ---------------------------------------------------------------------------
// Tier 2 - real browser geometry (skips when no browser is available)
// ---------------------------------------------------------------------------

function loadPuppeteer() {
  try { return require('puppeteer-core'); } catch (e) { return null; }
}
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';

function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/auth/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        user: { id: 9001, name: 'Panel Audit' },
        wallet: { demo_balance: 1000, live_balance: 0, bonus_balance: 0 },
        hasRealDeposit: false, todayRealizedPnl: 0, environment: 'PRODUCTION'
      }));
    }
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function measureViewport(browser, base, width, height) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, isMobile: width < 700, hasTouch: width < 700, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(() => { try {
    localStorage.setItem('jwt_token', 'test');
    localStorage.setItem('meta_consent', '1');
    localStorage.setItem('arbi_onboarding_9001', 'shown');
    localStorage.setItem('arbi_mode_9001', 'live');
    localStorage.setItem('arbi_user', JSON.stringify({ id: 9001, name: 'Panel Audit' }));
  } catch (e) {} });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2200));
  await page.evaluate(() => {
    const i = document.getElementById('iosInstallModal');
    if (i) { i.classList.remove('open'); i.style.display = 'none'; }
    for (let k = 1; k <= 6; k++) Notifications.add('info', 'Notification ' + k, 'Body ' + k);
  });

  const bell = await page.evaluate(() => {
    const b = document.getElementById('notificationBtn');
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      clickable: !!hit && (b === hit || b.contains(hit)) };
  });
  // real click, then measure the real layout
  await page.mouse.click(bell.x, bell.y);
  await new Promise((r) => setTimeout(r, 400));
  const open = await page.evaluate(() => {
    const panel = document.getElementById('notificationPanel');
    const wrapper = panel.parentElement;           // .notification-wrapper
    const pr = panel.getBoundingClientRect();
    const wr = wrapper.getBoundingClientRect();
    const header = document.getElementById('appToolbar');
    const hr = header.getBoundingClientRect();
    const cs = getComputedStyle(panel);
    const item = panel.querySelector('.notification-item');
    let itemClickable = null;
    if (item) {
      const ir = item.getBoundingClientRect();
      const cx = Math.round(ir.x + ir.width / 2), cy = Math.round(ir.y + ir.height / 2);
      const inside = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
      const hit = inside ? document.elementFromPoint(cx, cy) : null;
      itemClickable = !!hit && (item === hit || item.contains(hit));
    }
    return {
      position: cs.position,
      rect: { top: Math.round(pr.top), left: Math.round(pr.left), right: Math.round(pr.right), bottom: Math.round(pr.bottom), w: Math.round(pr.width), h: Math.round(pr.height) },
      wrapperBottom: Math.round(wr.bottom), headerBottom: Math.round(hr.bottom),
      bellBottom: Math.round(document.getElementById('notificationBtn').getBoundingClientRect().bottom),
      viewport: { w: innerWidth, h: innerHeight },
      itemClickable,
      items: panel.querySelectorAll('.notification-item').length,
      hOverflow: document.documentElement.scrollWidth - innerWidth,
      scrollLocked: getComputedStyle(document.body).overflow
    };
  });
  // real click again -> closes
  await page.mouse.click(bell.x, bell.y);
  await new Promise((r) => setTimeout(r, 350));
  const closed = await page.evaluate(() => !document.getElementById('notificationPanel').classList.contains('open'));
  // and once more -> re-opens (repeatability)
  await page.mouse.click(bell.x, bell.y);
  await new Promise((r) => setTimeout(r, 350));
  const reopened = await page.evaluate(() => document.getElementById('notificationPanel').classList.contains('open'));
  await ctx.close();
  return { width, height, bell, open, closed, reopened, errors };
}

test('real browser: the panel opens inside the viewport, anchored to its bell', async (t) => {
  const puppeteer = loadPuppeteer();
  if (!puppeteer) return t.skip('puppeteer-core is not installed');
  if (!fs.existsSync(CHROME)) return t.skip('no Chromium at ' + CHROME);
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  } catch (e) {
    return t.skip('Chromium could not be launched: ' + e.message);
  }
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const [w, h] of [[390, 844], [360, 800], [1280, 900]]) {
      const r = await measureViewport(browser, base, w, h);
      const tag = w + 'x' + h;
      assert.deepStrictEqual(r.errors, [], tag + ': no page errors');

      // 1. the bell itself is tappable
      assert.ok(r.bell.clickable, tag + ': the bell must be clickable');

      // 2. geometry: fully inside the viewport (this is what the pre-fix build broke)
      const { rect, viewport } = r.open;
      assert.ok(rect.top >= 0, tag + ': panel top must not be above the viewport (got ' + rect.top + ')');
      assert.ok(rect.bottom <= viewport.h, tag + ': panel bottom must stay on screen (got ' + rect.bottom + ' > ' + viewport.h + ')');
      assert.ok(rect.left >= 0 && rect.right <= viewport.w, tag + ': panel must not overflow horizontally');
      assert.strictEqual(r.open.hOverflow, 0, tag + ': no horizontal page overflow');

      // 4. it hangs BELOW its bell (anchored to the wrapper, not to the header/viewport edge)
      assert.ok(/^absolute$/.test(r.open.position) || w > 640,
        tag + ': mobile panel must use absolute positioning, got ' + r.open.position);
      assert.ok(Math.abs(rect.top - (r.open.wrapperBottom + 8)) <= 2,
        tag + ': panel top must be 8px under the bell wrapper (top=' + rect.top + ', wrapperBottom=' + r.open.wrapperBottom + ')');
      assert.ok(rect.top >= r.open.bellBottom + 4,
        tag + ': the panel must start below the bell, never cover it (top=' + rect.top + ', bellBottom=' + r.open.bellBottom + ')');

      // 5. content is reachable
      assert.ok(r.open.items > 0, tag + ': seeded notifications must render');
      assert.strictEqual(r.open.itemClickable, true, tag + ': notification items must be hit-testable');

      // 6. the bell stays usable while the panel is open (pre-fix the panel covered
      //    it, so a second tap never reached the bell and the panel could not close)
      assert.strictEqual(r.closed, true, tag + ': the panel must close on a second click');
      assert.strictEqual(r.reopened, true, tag + ': the panel must re-open on a third click');
    }
  } finally {
    await browser.close();
    server.close();
  }
});
