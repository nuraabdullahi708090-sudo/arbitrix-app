'use strict';

/**
 * Records the deposit tutorial from the SHIPPED frontend.
 *
 * Two modes:
 *
 *   stub (default)  Serves public/index.html locally and answers /api/* with a
 *                   fake backend. Fast, repeatable, no credentials. Every
 *                   payment detail is a placeholder and the recording carries a
 *                   "simulated data" badge, so it must never be presented as a
 *                   real transaction.
 *
 *   --live          Drives a real URL using a saved browser session. Use it to
 *                   re-shoot the same journey on a MARKETING_SANDBOX account so
 *                   the address, invoice and balances are genuine sandbox data.
 *                   It never submits a payment; it stops at "waiting for
 *                   payment" (or at "credited" only if the sandbox credits it).
 *
 * Usage
 *   node scripts/tutorial/record.js
 *   node scripts/tutorial/record.js --live --url https://arbitrix.pro \
 *        --storage-state ./sandbox-session.json --out build/video/deposit-tutorial-live
 *
 * A storage state is a Playwright/Puppeteer JSON dump of cookies + localStorage,
 * so the operator never hands over a password. See scripts/tutorial/README.md.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

function loadPuppeteer() {
  try {
    // Not a package.json dependency: the recorder is a working tool, not a
    // runtime dependency. Install it on demand.
    return require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
  } catch (error) {
    console.error(
      'puppeteer-core is required to record: npm i --no-save puppeteer-core\n' +
      'and point CHROMIUM_PATH at a Chromium binary if it is not /usr/bin/chromium.'
    );
    process.exit(3);
  }
}

function parseArgs(argv) {
  const args = { mode: 'stub', url: '', storageState: '', out: '', disclosure: null, lang: 'en', width: 1280, height: 720 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') args.mode = 'live';
    else if (a === '--stub') args.mode = 'stub';
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--storage-state') args.storageState = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--lang') args.lang = argv[++i];
    else if (a === '--disclosure') args.disclosure = true;
    else if (a === '--no-disclosure') args.disclosure = false;
    else if (a === '--width') args.width = Number(argv[++i]);
    else if (a === '--height') args.height = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  if (args.out === '') args.out = path.join(ROOT, 'build', 'video', 'deposit-tutorial');
  if (args.disclosure === null) args.disclosure = args.mode === 'stub';
  if (args.mode === 'live' && !args.url) args.url = 'https://arbitrix.pro';
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake backend (stub mode) -------------------------------------------
// Deliberately self-labelling values: nobody can mistake this address or id
// for a real destination, and the recording adds a visible disclosure badge.
const FAKE_INVOICE = {
  id: 'DEMO-INVOICE-0001',
  provider: 'q8qpay',
  amountUsdtExact: 100,
  amountUsd: 100,
  currency: 'USDT',
  network: 'TRC20',
  payoutAddress: 'TDEMONSTRATIONONLYDONOTSEND00000001',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 60000).toISOString()
};

function createStubServer() {
  let credited = false;
  const wallet = () => ({ live_balance: credited ? 150 : 50, demo_balance: 1000, bonus_balance: 0 });

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (url === '/api/auth/me') {
      return json({
        user: { id: 4242, email: 'tutorial@example.invalid', name: 'Alex Morgan', environment: 'PRODUCTION' },
        wallet: wallet(),
        hasRealDeposit: credited,
        hasTradingActivity: false,
        todayRealizedPnl: 0,
        mta: 200,
        referralCode: 'ARBDEMO01',
        environment: 'PRODUCTION',
        promoCreditFunded: true,
        promoRealizedProfit: 0,
        promoLimitReached: false
      });
    }
    if (url === '/api/_credit') { credited = true; return json({ ok: true }); }
    if (url.startsWith('/api/payment/invoice/') || url.startsWith('/api/deposit/status/')) {
      return json({
        success: true,
        invoice: Object.assign({}, FAKE_INVOICE, {
          status: credited ? 'confirmed' : 'pending',
          credited,
          amountUsd: credited ? 100 : 0
        })
      });
    }
    if (url === '/api/payment/create-invoice') return json({ success: true, invoice: FAKE_INVOICE });
    if (url.startsWith('/api/')) return json({ success: true });

    const rel = url === '/' ? '/index.html' : url;
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.js') ? 'application/javascript'
        : file.endsWith('.css') ? 'text/css'
          : file.endsWith('.png') ? 'image/png'
            : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file).pipe(res);
  });

  return { server, isCredited: () => credited };
}

// ---- overlay -------------------------------------------------------------
const OVERLAY_CSS = `
  #recStep{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483000;
    display:flex;align-items:center;gap:12px;max-width:min(92vw,760px);
    background:rgba(9,14,26,.92);border:1px solid rgba(240,185,11,.45);border-radius:999px;
    padding:9px 20px 9px 12px;pointer-events:none;box-shadow:0 10px 30px rgba(0,0,0,.45)}
  #recStep .chip{background:#F0B90B;color:#070B14;border-radius:999px;padding:4px 10px;
    font:800 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:1.4px;white-space:nowrap}
  #recStep .label{color:#fff;font:600 14px/1.25 -apple-system,Segoe UI,Roboto,sans-serif;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #recBrand{position:fixed;right:18px;bottom:16px;z-index:2147483000;
    font:800 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:2.4px;
    color:rgba(255,255,255,.40);pointer-events:none}
  #recDisclosure{position:fixed;left:16px;top:16px;z-index:2147483000;
    background:rgba(240,185,11,.14);border:1px solid rgba(240,185,11,.55);color:#F0B90B;
    border-radius:999px;padding:7px 13px;font:800 10px/1 -apple-system,Segoe UI,Roboto,sans-serif;
    letter-spacing:1.1px;text-transform:uppercase;pointer-events:none}
  .recDim{position:fixed;background:rgba(4,8,16,.55);z-index:2147482200;pointer-events:none;
    transition:all .18s ease-out}
  #recFocus{position:fixed;z-index:2147482400;pointer-events:none;border-radius:14px;
    box-shadow:0 0 0 3px #F0B90B,0 0 34px 8px rgba(240,185,11,.40);opacity:0;
    transition:opacity .22s ease-out}
  #recFocus.on{opacity:1;animation:recPulse 1.9s ease-in-out infinite}
  @keyframes recPulse{0%,100%{box-shadow:0 0 0 3px #F0B90B,0 0 26px 4px rgba(240,185,11,.32)}
    50%{box-shadow:0 0 0 4px #FCD535,0 0 44px 12px rgba(240,185,11,.50)}}
`;


// ---- recording -----------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return 0;
  }

  const scenes = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenes.json'), 'utf8')).scenes;
  const timeline = JSON.parse(fs.readFileSync(path.join(args.out, 'timeline.json'), 'utf8'));
  const frameDir = path.join(args.out, 'frames');
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  const stub = args.mode === 'stub' ? createStubServer() : null;
  let baseUrl = args.url;
  if (stub) {
    await new Promise((r) => stub.server.listen(0, '127.0.0.1', r));
    baseUrl = 'http://127.0.0.1:' + stub.server.address().port;
  }

  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1',
      '--font-render-hinting=none', '--disable-lcd-text', '--hide-scrollbars']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: args.width, height: args.height, deviceScaleFactor: 1 });

  if (args.storageState) {
    const sessionPath = path.resolve(args.storageState);
    if (!fs.existsSync(sessionPath)) throw new Error('storage state file not found: ' + args.storageState);
    // A session file carries a login token: it must never live inside the repo.
    if (sessionPath.startsWith(ROOT + path.sep) && !/[\\/]build[\\/]/.test(sessionPath)) {
      console.warn('WARNING: the session file is inside the repository. Move it outside (it holds a login token) ' +
        'and keep it out of Git.');
    }
    const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (Array.isArray(state.cookies)) await page.setCookie(...state.cookies);
    if (Array.isArray(state.origins)) {
      const origin = state.origins.find((o) => baseUrl.startsWith(o.origin));
      const local = origin ? origin.localStorage || [] : [];
      // Without the app's own token the recording would quietly shoot the login
      // page instead of the dashboard, which is worse than failing here.
      if (!local.some((e) => e && e.name === 'jwt_token' && e.value)) {
        throw new Error('storage state has no jwt_token for ' + baseUrl + ' - export cookies + localStorage ' +
          'while logged in to the sandbox account');
      }
      if (local.length) {
        await page.evaluateOnNewDocument((entries) => {
          for (const e of entries) localStorage.setItem(e.name, e.value);
        }, local);
      }
    }
  } else if (args.mode === 'stub') {
    await page.evaluateOnNewDocument((lang) => {
      localStorage.setItem('jwt_token', 'tutorial-session');
      localStorage.setItem('arbi_user', JSON.stringify({ id: 4242, email: 'tutorial@example.invalid', name: 'Alex Morgan' }));
      localStorage.setItem('arbi_lang', lang);
      localStorage.setItem('arbi_mode_4242', 'demo');
      // The post-registration funnel is shown once per account; a returning user
      // (the persona this tutorial teaches) has already answered it. Without this
      // the funnel modal sits on top of the deposit modal.
      localStorage.setItem('arbi_onboarding_4242', 'demo');
    }, args.lang);
  }

  let pageErrors = 0;
  page.on('pageerror', () => { pageErrors += 1; });
  // Surface a failing call immediately instead of waiting for a selector timeout.
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.warn('[page error]', String(msg.text()).slice(0, 240));
  });

  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof window.initApp === 'function', { timeout: 30000 });

  try {
    await page.evaluate(() => window.initApp && window.initApp());
  } catch (error) {
    console.warn('initApp threw:', error.message);
  }
  await sleep(2500);

  // Never let the one-time funnel cover the flow being demonstrated: the recorder
  // dismisses it and records the funnel as already answered for this account.
  const onboardingBlocking = await page.evaluate(() => {
    const modal = document.getElementById('onboardingModal');
    if (!modal || !modal.classList.contains('open')) return false;
    modal.classList.remove('open');
    try {
      const user = JSON.parse(localStorage.getItem('arbi_user') || '{}');
      if (user && user.id) localStorage.setItem('arbi_onboarding_' + user.id, 'demo');
    } catch (error) { /* storage is optional for the recording */ }
    return true;
  });
  if (onboardingBlocking) console.log('dismissed the one-time onboarding funnel');

  if (args.mode === 'live') {
    const loggedIn = await page.evaluate(() => Boolean(document.getElementById('mainApp') && document.getElementById('mainApp').offsetParent !== null));
    if (!loggedIn) {
      await browser.close();
      if (stub) stub.server.close();
      console.error(
        'The saved session did not reach the dashboard. Log in to the sandbox in a browser,\n' +
        'export cookies + localStorage for the site, and pass it with --storage-state.\n' +
        'Nothing was recorded.'
      );
      return 2;
    }
  }

  await page.addStyleTag({ content: OVERLAY_CSS });
  await page.evaluate((disclosure) => {
    const step = document.createElement('div');
    step.id = 'recStep';
    step.innerHTML = '<span class="chip"></span><span class="label"></span>';
    document.body.appendChild(step);

    for (const side of ['T', 'B', 'L', 'R']) {
      const panel = document.createElement('div');
      panel.className = 'recDim';
      panel.id = 'recDim' + side;
      panel.style.width = '0px';
      panel.style.height = '0px';
      document.body.appendChild(panel);
    }

    const ring = document.createElement('div');
    ring.id = 'recFocus';
    document.body.appendChild(ring);

    const brand = document.createElement('div');
    brand.id = 'recBrand';
    brand.textContent = 'ARBITRIX';
    document.body.appendChild(brand);

    if (disclosure) {
      const chip = document.createElement('div');
      chip.id = 'recDisclosure';
      chip.textContent = 'Simulated data - not a real payment';
      document.body.appendChild(chip);
    }
  }, args.disclosure);

  const frames = [];
  const marks = [];
  const focusLog = [];
  const started = Date.now();

  const setStep = (chip, label) => page.evaluate((c, l) => {
    const bar = document.getElementById('recStep');
    if (!bar) return;
    bar.querySelector('.chip').textContent = c;
    bar.querySelector('.label').textContent = l;
  }, chip, label);

  // Highlight: four dim panels around the target plus a pulsing gold ring, so the
  // eye lands on the exact control being described without hiding the context.
  async function focusOn(selector) {
    if (!selector) return;
    // Bring the target into view inside its own scroll container first: a modal
    // can be taller than the window, and a ring drawn off-screen teaches nothing.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, selector);
    await sleep(220);

    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      // Clamp so a tall panel (a whole modal section) cannot produce a ring that
      // runs off the viewport or covers the screen.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(r.width, vw * 0.9);
      const h = Math.min(r.height, vh * 0.62);
      const x = Math.max(0, Math.min(r.x, vw - w));
      const y = Math.max(0, Math.min(r.y, vh - h));
      return { x, y, w, h };
    }, selector);
    if (!box) { console.warn('focus target not visible:', selector); return; }
    focusLog.push({ selector, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) });
    await page.evaluate((b) => {
      const pad = 10;
      const x = Math.max(b.x - pad, 0);
      const y = Math.max(b.y - pad, 0);
      const w = b.w + pad * 2;
      const h = b.h + pad * 2;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const ring = document.getElementById('recFocus');
      ring.style.left = x + 'px'; ring.style.top = y + 'px';
      ring.style.width = w + 'px'; ring.style.height = h + 'px';
      ring.classList.add('on');

      const place = (id, left, top, width, height) => {
        const el = document.getElementById(id);
        el.style.left = left + 'px'; el.style.top = top + 'px';
        el.style.width = Math.max(width, 0) + 'px'; el.style.height = Math.max(height, 0) + 'px';
      };
      place('recDimT', 0, 0, vw, y);
      place('recDimB', 0, y + h, vw, vh - (y + h));
      place('recDimL', 0, y, x, h);
      place('recDimR', x + w, y, vw - (x + w), h);
    }, box);
  }

  async function clearFocus() {
    await page.evaluate(() => {
      const ring = document.getElementById('recFocus');
      if (ring) ring.classList.remove('on');
      for (const side of ['T', 'B', 'L', 'R']) {
        const el = document.getElementById('recDim' + side);
        if (el) { el.style.width = '0px'; el.style.height = '0px'; }
      }
    });
  }

  async function shoot() {
    const file = path.join(frameDir, `frame-${String(frames.length + 1).padStart(5, '0')}.png`);
    await page.screenshot({ path: file, optimizeForSpeed: true });
    frames.push(Date.now() - started);
  }

  async function captureFor(ms, actions) {
    const end = Date.now() + ms;
    const pending = actions ? actions() : Promise.resolve();
    while (Date.now() < end) await shoot();
    if (actions) await pending;
  }

  const waitCredited = (timeout) => page.waitForFunction(
    () => {
      const el = document.getElementById('depositStatusText');
      return Boolean(el && window.t && el.textContent.trim() === window.t('deposit.status.confirmed').trim());
    },
    { timeout, polling: 250 }
  );

  const actions = {
    1: async (scene) => {
      await setStep('STEP 1 OF 8', scene.title);
      await focusOn(scene.focus);
    },
    2: async (scene) => {
      await setStep('STEP 2 OF 8', scene.title);
      await page.evaluate(() => window.setMode && window.setMode('live'));
      await sleep(350);
      await focusOn(scene.focus);
    },
    3: async (scene) => {
      await setStep('STEP 3 OF 8', scene.title);
      await page.evaluate(() => window.openDepositModal && window.openDepositModal());
      await sleep(450);
      await focusOn(scene.focus);
    },
    4: async (scene) => {
      await setStep('STEP 4 OF 8', scene.title);
      await page.waitForSelector('#liveDepositAmount', { visible: true, timeout: 15000 });
      // Guard: an overlay on top of the field would swallow the click and, worse,
      // silently change the app state (a stray click on a modal option does).
      const hit = await page.evaluate(() => {
        const el = document.getElementById('liveDepositAmount');
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top ? (top.id || top.tagName) : null;
      });
      if (hit !== 'liveDepositAmount') {
        throw new Error('the amount field is covered by "' + hit + '" - a modal is in the way');
      }
      await page.click('#liveDepositAmount');
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await page.keyboard.type('100', { delay: 90 });
      const typed = await page.$eval('#liveDepositAmount', (el) => el.value);
      if (typed !== '100') throw new Error('amount field is "' + typed + '", expected 100');
      const mode = await page.evaluate(() => APP.mode);
      if (mode !== 'live') throw new Error('app left Live Mode while typing (mode=' + mode + ')');
      await focusOn(scene.focus);
    },
    5: async (scene) => {
      await setStep('STEP 5 OF 8', scene.title);
      // Same call the button makes; a click is brittle while frames are captured.
      await page.evaluate(() => window.requestDepositAddress && window.requestDepositAddress());
      try {
        await page.waitForFunction(() => {
          const s = document.getElementById('depositPaymentSection');
          return Boolean(s && s.offsetParent !== null);
        }, { timeout: 25000 });
      } catch (error) {
        const diag = await page.evaluate(() => ({
          mode: typeof APP !== 'undefined' ? APP.mode : 'n/a',
          amount: (document.getElementById('liveDepositAmount') || {}).value,
          inputDisplay: (document.getElementById('depositInputSection') || {}).style.display,
          paymentDisplay: (document.getElementById('depositPaymentSection') || {}).style.display,
          lastStatus: (document.getElementById('depositStatusText') || {}).textContent
        }));
        throw new Error('payment section never appeared: ' + JSON.stringify(diag));
      }
      await sleep(300);
      await focusOn(scene.focus);
    },
    6: async (scene) => {
      await setStep('STEP 6 OF 8', scene.title);
      if (stub) {
        await page.evaluate(() => fetch('/api/_credit', { method: 'POST' }).catch(() => {}));
        await waitCredited(9000);
      } else {
        // A real sandbox credits on its own schedule; the tutorial shows the
        // waiting state when it has not happened yet. Nothing is forced.
        await waitCredited(30000).catch(() => console.warn('not credited within 30s - recording the waiting state'));
      }
      await focusOn(scene.focus);
    },
    7: async (scene) => {
      await setStep('STEP 7 OF 8', scene.title);
      await page.evaluate(() => window.closeDepositModal && window.closeDepositModal());
      await sleep(700);
      await focusOn(scene.focus);
    },
    8: async (scene) => {
      await setStep('STEP 8 OF 8', scene.title);
      await page.evaluate(() => window.openSupportModal && window.openSupportModal());
      await sleep(450);
      await focusOn(scene.focus);
    }
  };

  for (const scene of scenes) {
    const ms = (timeline.find((t) => t.id === scene.id) || {}).ms || 8000;
    const startMs = Date.now() - started;
    await clearFocus();
    console.log('[scene ' + scene.id + '/' + scenes.length + '] mode=' + await page.evaluate(() => (typeof APP !== 'undefined' ? APP.mode : 'n/a')) + ' - ' + scene.title);
    await captureFor(ms, () => actions[scene.id](scene));
    if (scene.id === 6 && Date.now() - started - startMs < 10500) {
      while (Date.now() - started - startMs < 10500) await shoot();
    }
    marks.push({ id: scene.id, startMs, endMs: Date.now() - started, focus: scene.focus || null });
  }
  await shoot();

  fs.writeFileSync(path.join(args.out, 'frames.json'), JSON.stringify({
    mode: args.mode,
    baseUrl: args.mode === 'stub' ? 'local stub' : args.url,
    disclosure: args.disclosure,
    count: frames.length,
    timestamps: frames,
    marks,
    focusLog,
    totalMs: frames[frames.length - 1],
    pageErrors
  }, null, 2));

  await browser.close();
  if (stub) stub.server.close();
  console.log('frames:', frames.length,
    'duration(s):', (frames[frames.length - 1] / 1000).toFixed(1),
    'pageErrors:', pageErrors);
  return pageErrors === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('record failed:', error && error.message ? error.message : error);
    process.exit(1);
  });
