/* Browser verification for the native in-app support surfaces.
 * Real page + real DOM; the backend is the stub in stub.js (no database).
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..', '..', 'public');
const PORT = 8137;
const SHOTS = process.env.NS_SHOTS || require('node:os').tmpdir() + '/ns-shots';
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  <<< ' + (extra === undefined ? '' : extra)));
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(ROOT, url === '/' ? 'index.html' : url);
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

async function newPage(browser, width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(fs.readFileSync(path.join(__dirname, 'stub.js'), 'utf8'));
  page.on('pageerror', (e) => { page.__errors = (page.__errors || []).concat(String(e.message || e)); });
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('typeof window.NativeSupport === "object"', { timeout: 20000 });
  await page.evaluate(() => {
    ['landingPage', 'authPage'].forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    // Bypassing initApp skips the app's flex shell (height:100vh + inner scroll
    // container). Flatten it so the page itself scrolls, as a user's wheel would.
    const main = document.getElementById('mainApp');
    if (main) { main.style.display = 'block'; main.style.position = 'static'; main.style.height = 'auto'; main.style.overflow = 'visible'; }
    const admin = document.getElementById('adminPanel'); if (admin) admin.classList.remove('hidden');
    const loader = document.getElementById('walletSyncLoader'); if (loader) loader.style.display = 'none';
    document.documentElement.style.overflow = 'auto';
    document.body.style.overflow = 'auto';
  });
  return page;
}

const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  const shown = typeof el.checkVisibility === 'function'
    ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })
    : st.display !== 'none';
  return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left),
    display: st.display, visibility: st.visibility, opacity: st.opacity, shown: shown };
}, sel);

const hitOk = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return 'missing';
  if (getComputedStyle(el).position !== 'fixed') {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    // The app shell scrolls inner containers, so walk the ancestors as a user's
    // wheel/touch would until the element is really inside the viewport.
    let node = el.parentElement;
    while (node) {
      if (node.scrollHeight - node.clientHeight > 4) {
        const nr = node.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        node.scrollTop += Math.round(er.top - nr.top - (nr.height / 2) + (er.height / 2));
      }
      node = node.parentElement;
    }
    let er2 = el.getBoundingClientRect();
    if (er2.top < 0 || er2.bottom > window.innerHeight) {
      window.scrollBy(0, Math.round(er2.top + er2.height / 2 - window.innerHeight / 2));
      er2 = el.getBoundingClientRect();
    }
    if (er2.top < 0 || er2.bottom > window.innerHeight) {
      const sc = document.scrollingElement;
      if (sc) sc.scrollTop = Math.max(0, sc.scrollTop + er2.top - (window.innerHeight / 2) + (er2.height / 2));
    }
  }
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  if (x < 2 || y < 2 || x > window.innerWidth - 2 || y > window.innerHeight - 2) {
    return 'outside-viewport:' + JSON.stringify({ x: x, y: y, w: window.innerWidth, h: window.innerHeight, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  }
  const hit = document.elementFromPoint(x, y);
  if (!hit) return 'nothing-at-point';
  return (hit === el || el.contains(hit) || hit.contains(el)) ? 'hit' : ('blocked-by:' + hit.className + '/' + hit.tagName);
}, sel);

const overflow = (page) => page.evaluate(() => ({
  doc: document.documentElement.scrollWidth, win: window.innerWidth,
  over: document.documentElement.scrollWidth - window.innerWidth,
}));

async function customerFlow(page, lang) {
  await page.evaluate((l) => {
    if (l && typeof setLanguage === 'function') setLanguage(l);
    APP.nativeSupport = true;
    window.NativeSupport.sync();
  }, lang || 'en');
  await page.waitForSelector('.ns-launcher.show', { timeout: 10000 });
  check(`[${lang}] launcher visible`, !!(await visible(page, '.ns-launcher.show')));
  // The cookie banner is present on a first visit and overlaps the corner.
  const banner = await page.evaluate(() => !!document.getElementById('metaConsentBanner'));
  if (banner) {
    const lifted = await hitOk(page, '.ns-launcher');
    check(`[${lang}] launcher is NOT blocked by the consent banner`, lifted === 'hit', lifted);
  }
  check(`[${lang}] legacy assistant launcher replaced`, await page.evaluate(() => document.body.getAttribute('data-support-surface') === 'native'
    && getComputedStyle(document.querySelector('.support-widget')).display === 'none'));
  if (banner) await page.evaluate(() => { if (typeof grantConsent === 'function') grantConsent(); });
  await new Promise((r) => setTimeout(r, 200));
  check(`[${lang}] launcher hit-test`, (await hitOk(page, '.ns-launcher')) === 'hit', await hitOk(page, '.ns-launcher'));

  await page.click('.ns-launcher');
  await page.waitForSelector('.ns-panel.open');
  await page.waitForSelector('.ns-cats button', { timeout: 10000 });
  const cats = await page.$$eval('.ns-cats button', (b) => b.map((x) => x.textContent));
  check(`[${lang}] five categories rendered`, cats.length === 5, cats.join('|'));
  check(`[${lang}] category labels localized`, lang === 'ar' ? /إيداع/.test(cats.join(' ')) : cats[0] === 'Deposit issues', cats[0]);
  check(`[${lang}] close button hit-test`, (await hitOk(page, '.ns-head button')) === 'hit');
  await page.screenshot({ path: path.join(SHOTS, `widget-chooser-${lang}.png`) });

  // category -> conversation creation
  await page.evaluate(() => { document.querySelectorAll('.ns-cats button')[0].click(); });
  await page.waitForSelector('.ns-row textarea', { timeout: 10000 });
  const calls = await page.evaluate(() => window.__NS.calls.slice());
  check(`[${lang}] POST conversation created on category pick`,
    calls.some((c) => c === 'POST /api/support/conversations'), calls.slice(-3).join(' ; '));

  // send + AI reply
  await page.evaluate(() => {
    const ta = document.querySelector('.ns-row textarea');
    ta.value = 'How do I deposit USDT?';
    document.querySelector('.ns-row button').click();
  });
  await page.waitForFunction(() => document.querySelectorAll('.ns-msg').length >= 3, { timeout: 10000 });
  const msgs = await page.$$eval('.ns-msg', (n) => n.map((x) => ({ cls: x.className, text: x.textContent })));
  check(`[${lang}] customer + AI reply rendered`, msgs.some((m) => /customer/.test(m.cls)) && msgs.some((m) => /ns-msg ai/.test(m.cls)), JSON.stringify(msgs.map((m) => m.cls)));
  check(`[${lang}] AI reply text visible`, msgs.some((m) => /approved answer/.test(m.text)));

  // failed send + retry
  await page.evaluate(() => window.__NS_FAIL_NEXT_SEND());
  await page.evaluate(() => {
    const ta = document.querySelector('.ns-row textarea');
    ta.value = 'this one fails';
    document.querySelector('.ns-row button').click();
  });
  await page.waitForSelector('.ns-msg.failed', { timeout: 10000 });
  const failedText = await page.$eval('.ns-msg.failed', (n) => n.textContent);
  check(`[${lang}] failed send marked`, /Not sent|لم يتم|Something went wrong|حدث خطأ/.test(failedText), failedText.slice(-40));
  await page.evaluate(() => {
    const ta = document.querySelector('.ns-row textarea');
    ta.value = 'retry works';
    document.querySelector('.ns-row button').click();
  });
  await page.waitForFunction(() => document.querySelectorAll('.ns-msg.failed').length === 1, { timeout: 10000 });
  check(`[${lang}] retry after failure`, (await page.$$('.ns-msg.failed')).length === 1);

  // support-unavailable: the server parks the thread and returns a hand-off notice
  const aiBefore = await page.evaluate(() => document.querySelectorAll('.ns-msg.ai').length);
  await page.evaluate(() => { window.__NS.forceUnavailable = true; });
  await page.evaluate(() => {
    const ta = document.querySelector('.ns-row textarea');
    ta.value = 'no rpc on this deployment';
    document.querySelector('.ns-row button').click();
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.ns-msg.system')]
    .some((n) => /support agent will reply/i.test(n.textContent)), { timeout: 10000 });
  const aiAfter = await page.evaluate(() => document.querySelectorAll('.ns-msg.ai').length);
  check(`[${lang}] support-unavailable shows a hand-off, never an AI answer`, aiAfter === aiBefore, aiBefore + '->' + aiAfter);
  await page.evaluate(() => { window.__NS.forceUnavailable = false; });

  // human request
  await page.evaluate(() => { const b = [...document.querySelectorAll('.ns-link')].find((x) => /human|موظف|التحدث/.test(x.textContent)); if (b) b.click(); });
  await page.waitForFunction(() => document.querySelectorAll('.ns-msg.system').length >= 2, { timeout: 10000 });
  check(`[${lang}] human-request notice rendered`, (await page.$$('.ns-msg.system')).length >= 2);

  // unread badge
  await page.evaluate(() => { window.__NS.conv.unread_for_customer = 3; window.NativeSupport.close(); window.NativeSupport.sync(); });
  await page.waitForSelector('.ns-launcher.show .ns-badge', { timeout: 10000 });
  const badge = await page.$eval('.ns-badge', (n) => ({ text: n.textContent, display: getComputedStyle(n).display }));
  check(`[${lang}] unread badge shows the count`, badge.text === '3' && badge.display !== 'none', JSON.stringify(badge));

  const ov = await overflow(page);
  check(`[${lang}] no horizontal overflow with the panel open`, ov.over <= 0, JSON.stringify(ov));
  await page.evaluate(() => window.NativeSupport.open());
  await page.waitForSelector('.ns-panel.open');
  const panel = await visible(page, '.ns-panel');
  check(`[${lang}] panel fits the viewport`, panel && panel.left >= 0 && panel.left + panel.w <= ov.win + 1, JSON.stringify(panel));
  await page.screenshot({ path: path.join(SHOTS, `widget-thread-${lang}.png`) });
}

async function adminFlow(page, width) {
  await page.evaluate(() => { if (typeof setLanguage === 'function') setLanguage('en'); APP.isAdmin = true; APP.nativeSupport = true; });
  await page.evaluate(() => showAdminTab('support'));
  await page.waitForSelector('#adminTabContentSupport:not(.hidden)', { timeout: 10000 });
  const paneVis = await visible(page, '#adminTabContentSupport');
  check('[admin] Support tab pane visible', !!(paneVis && paneVis.shown && paneVis.h > 100), JSON.stringify(paneVis));
  await page.waitForFunction(() => document.querySelectorAll('#nsInboxList .ns-item').length === 2, { timeout: 10000 });
  const rows = await page.$$eval('#nsInboxList .ns-item', (n) => n.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  check('[admin] inbox lists both conversations with customer identity',
    rows.length === 2 && /Ada Lovelace/.test(rows[0]) && /Grace Hopper/.test(rows[1]), rows.join(' || '));
  const counts = await page.$eval('#nsInboxCounts', (n) => n.textContent);
  check('[admin] counts rendered', /Waiting 1/.test(counts) && /Unread 1/.test(counts), counts);
  if (typeof width === 'object' && width.tall) {
    const rowHit = await hitOk(page, '#nsInboxList .ns-item');
    check('[admin] row hit-test (tall viewport: z-order/overlap)', rowHit === 'hit', rowHit);
  } else {
    const rowBox = await page.evaluate(() => {
      const el = document.querySelector('#nsInboxList .ns-item');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    check('[admin] row is a real tap target (>=44px)', !!(rowBox && rowBox.h >= 44 && rowBox.w > 100), JSON.stringify(rowBox));
  }
  await page.screenshot({ path: path.join(SHOTS, `admin-inbox-${width}.png`) });

  await page.evaluate(() => document.querySelector('#nsInboxList .ns-item').click());
  await page.waitForFunction(() => document.querySelectorAll('.ns-thread-msgs .ns-msg').length >= 2, { timeout: 10000 });
  const thread = await page.$eval('.ns-thread-msgs', (n) => n.textContent);
  check('[admin] thread history rendered', /nothing arrived/.test(thread));
  await page.waitForFunction(() => { const c = document.getElementById('nsContextPanel'); return c && /Live balance/.test(c.textContent); }, { timeout: 10000 });
  const ctx = await page.$eval('#nsContextPanel', (n) => n.textContent.replace(/\s+/g, ' '));
  check('[admin] customer context includes balance + deposits', /250\.00/.test(ctx) && /confirmed/.test(ctx), ctx.slice(0, 120));

  // reply
  await page.waitForSelector('.ns-thread .ns-row textarea');
  await page.evaluate(() => {
    document.querySelector('.ns-thread .ns-row textarea').value = 'We are checking your deposit now.';
  });
  const sent = await page.evaluate(() => {
    const row = document.querySelector('.ns-thread .ns-row');
    if (!row) return 'no-row';
    const ta = row.querySelector('textarea');
    const btn = row.querySelector('button');
    if (!ta || !btn) return 'no-parts';
    if (!String(ta.value || '').trim()) return 'empty-textarea';
    btn.click();
    return 'clicked';
  });
  let replySeen = false;
  try {
    await page.waitForFunction(() => window.__NS.calls.some((c) => /^POST \/api\/admin\/support\/conversations\/\d+\/messages/.test(c)), { timeout: 6000 });
    replySeen = true;
  } catch (e) {
    const calls = await page.evaluate(() => window.__NS.calls.slice(-6));
    check('[admin] agent reply posted', false, sent + ' | last calls: ' + calls.join(' ; '));
  }
  if (replySeen) check('[admin] agent reply posted', true);

  // controls
  // The toolbar is state-driven: a paused thread offers Resume AI, an active one
  // offers Take over. Both states are exercised.
  const pausedLabels = await page.$$eval('.ns-thread .ns-toolbar button', (b) => b.map((x) => x.textContent.trim()));
  check('[admin] paused thread shows Resume (not Take over)',
    pausedLabels.some((l) => /Resume/.test(l)) && !pausedLabels.some((l) => /Take over/.test(l)), pausedLabels.join('|'));
  for (const action of ['resume', 'assign', 'resolve']) {
    await page.evaluate((a) => {
      const labels = { resume: /Resume/, assign: /Assign/, resolve: /Resolve/ };
      const b = [...document.querySelectorAll('.ns-thread .ns-toolbar button')].find((x) => labels[a].test(x.textContent));
      if (b) b.click();
    }, action);
    await page.waitForFunction((a) => window.__NS.calls.some((c) => c.indexOf('/' + a) !== -1 && c.indexOf('POST') === 0), { timeout: 10000 }, action);
    check('[admin] control fired: ' + action, true);
  }
  // Un-pause in the stub, re-select, and the toolbar must offer Take over.
  await page.evaluate(() => { window.__NS.downstream[0].ai_paused = false; window.__NS.downstream[0].status = 'open'; });
  await page.evaluate(() => document.querySelector('#nsInboxList .ns-item').click());
  await page.waitForFunction(() => [...document.querySelectorAll('.ns-thread .ns-toolbar button')].some((x) => /Take over/.test(x.textContent)), { timeout: 10000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll('.ns-thread .ns-toolbar button')].find((x) => /Take over/.test(x.textContent)); b.click(); });
  await page.waitForFunction(() => window.__NS.calls.some((c) => c.indexOf('/takeover') !== -1), { timeout: 10000 });
  check('[admin] control fired: takeover (active thread)', true);
  const posted = await page.evaluate(() => window.__NS.calls.filter((c) => /admin\/support\/conversations\/\d+\//.test(c)));
  const realErrors = (page.__errors || []).filter((e) => !/TradingView is not defined|Chart is not defined/.test(e));
  check('[admin] no product page errors', realErrors.length === 0, realErrors.join(' | '));
  return posted;
}

async function newConversationFlow(page) {
  await page.evaluate(() => showAdminTab('support'));
  await page.waitForSelector('#nsInboxNewBtn');
  await page.click('#nsInboxNewBtn');
  await page.waitForSelector('#nsInboxThread input[type="search"]', { timeout: 10000 });
  check('[admin] new-conversation composer opens', true);
  await page.evaluate(() => {
    const el = document.querySelector('#nsInboxThread input[type="search"]');
    el.value = 'ada';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.__NS.calls.some((c) => c.indexOf('/api/admin/support/customers?search=') !== -1), { timeout: 10000 });
  await page.waitForFunction(() => /ada@example\.com/.test(document.getElementById('nsInboxThread').textContent), { timeout: 10000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll('#nsInboxThread .ns-link')].find((x) => /ada/.test(x.textContent)); b.click(); });
  await page.evaluate(() => {
    const ta = document.querySelector('#nsInboxThread textarea');
    ta.value = 'Hello Ada, we are reviewing your account.';
    const b = [...document.querySelectorAll('#nsInboxThread button')].find((x) => /Send/.test(x.textContent));
    b.click();
  });
  await page.waitForFunction(() => window.__NS.calls.some((c) => c === 'POST /api/admin/support/conversations'), { timeout: 10000 });
  check('[admin] administrator-initiated conversation sent', true);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serve();
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--host-resolver-rules=MAP * 127.0.0.1'] });
  try {
    // customer: en at three mobile widths + ar
    for (const w of [360, 390, 430]) {
      const page = await newPage(browser, w, 844);
      await customerFlow(page, 'en');
      const ov = await overflow(page);
      check(`[en@${w}] no horizontal overflow`, ov.over <= 0, JSON.stringify(ov));
      await page.close();
    }
    const arPage = await newPage(browser, 390, 844);
    await customerFlow(arPage, 'ar');
    const dir = await arPage.evaluate(() => document.documentElement.dir);
    check('[ar] document direction is rtl', dir === 'rtl', dir);
    const arOverflow = await overflow(arPage);
    check('[ar] no horizontal overflow', arOverflow.over <= 0, JSON.stringify(arOverflow));
    await arPage.close();

    // admin desktop + mobile
    const adminPage = await newPage(browser, 1280, 900);
    const controlCalls = await adminFlow(adminPage, 1280);
    const tallPage = await newPage(browser, 1280, 2600);
    await adminFlow(tallPage, { tall: true });
    await tallPage.close();
    await newConversationFlow(adminPage);
    const adminOv = await overflow(adminPage);
    check('[admin@1280] no horizontal overflow', adminOv.over <= 0, JSON.stringify(adminOv));
    await adminPage.screenshot({ path: path.join(SHOTS, 'admin-thread-1280.png'), fullPage: false });
    await adminPage.close();

    const adminMobile = await newPage(browser, 390, 844);
    await adminFlow(adminMobile, 390);
    const mOv = await overflow(adminMobile);
    check('[admin@390] no horizontal overflow', mOv.over <= 0, JSON.stringify(mOv));
    await adminMobile.screenshot({ path: path.join(SHOTS, 'admin-inbox-390.png') });
    await adminMobile.close();
  } finally {
    await browser.close();
    srv.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\nTOTAL ' + results.length + ' checks, PASS ' + (results.length - failed.length) + ', FAIL ' + failed.length);
  if (failed.length) { failed.forEach((f) => console.log('  FAILED: ' + f.name + ' :: ' + f.extra)); process.exitCode = 1; }
})();
