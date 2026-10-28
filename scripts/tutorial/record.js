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
  #recCaption{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;
    background:linear-gradient(180deg,rgba(9,14,26,0),rgba(9,14,26,.92) 28%);
    padding:34px 40px 22px;font:600 20px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;
    color:#fff;text-align:center;letter-spacing:.2px;pointer-events:none;
    text-shadow:0 2px 10px rgba(0,0,0,.65)}
  #recCaption .recStep{display:block;font:700 13px/1 -apple-system,Segoe UI,Roboto,sans-serif;
    letter-spacing:1.6px;text-transform:uppercase;color:#F0B90B;margin-bottom:8px}
  #recBrand{position:fixed;right:18px;bottom:18px;z-index:2147483000;
    font:700 12px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:2px;
    color:rgba(255,255,255,.45);pointer-events:none}
  #recDisclosure{position:fixed;left:18px;top:18px;z-index:2147483000;
    display:flex;align-items:center;gap:8px;background:rgba(240,185,11,.14);
    border:1px solid rgba(240,185,11,.55);color:#F0B90B;border-radius:999px;
    padding:7px 14px;font:700 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;
    letter-spacing:1.1px;text-transform:uppercase;pointer-events:none}
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
    const state = JSON.parse(fs.readFileSync(args.storageState, 'utf8'));
    if (Array.isArray(state.cookies)) await page.setCookie(...state.cookies);
    if (Array.isArray(state.origins)) {
      const origin = state.origins.find((o) => baseUrl.startsWith(o.origin));
      const local = origin ? origin.localStorage || [] : [];
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
    }, args.lang);
  }

  let pageErrors = 0;
  page.on('pageerror', () => { pageErrors += 1; });

  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof window.initApp === 'function', { timeout: 30000 });

  try {
    await page.evaluate(() => window.initApp && window.initApp());
  } catch (error) {
    console.warn('initApp threw:', error.message);
  }
  await sleep(2500);

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
    const bar = document.createElement('div');
    bar.id = 'recCaption';
    bar.innerHTML = '<span class="recStep"></span><span class="recText"></span>';
    document.body.appendChild(bar);

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
  const started = Date.now();

  const setCaption = (step, text) => page.evaluate((s, t) => {
    const bar = document.getElementById('recCaption');
    if (!bar) return;
    bar.querySelector('.recStep').textContent = s;
    bar.querySelector('.recText').textContent = t;
  }, step, text);

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
    1: async () => setCaption('Step 1 of 8', 'Your dashboard starts in Demo Mode'),
    2: async () => {
      await setCaption('Step 2 of 8', 'Switch to Live Mode');
      await page.evaluate(() => window.setMode && window.setMode('live'));
    },
    3: async () => {
      await setCaption('Step 3 of 8', 'Open the deposit window');
      await page.evaluate(() => window.openDepositModal && window.openDepositModal());
    },
    4: async () => {
      await setCaption('Step 4 of 8', 'Enter the amount and generate payment');
      await page.waitForSelector('#liveDepositAmount', { visible: true, timeout: 15000 });
      await page.click('#liveDepositAmount');
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await page.keyboard.type('100', { delay: 90 });
      const value = await page.$eval('#liveDepositAmount', (el) => el.value);
      if (value !== '100') throw new Error('amount field is "' + value + '", expected 100');
    },
    5: async () => {
      await setCaption('Step 5 of 8', 'Send USDT on TRON (TRC20) to this address');
      // Same call the button makes; a click is brittle while frames are captured.
      await page.evaluate(() => window.requestDepositAddress && window.requestDepositAddress());
      await page.waitForFunction(() => {
        const s = document.getElementById('depositPaymentSection');
        return Boolean(s && s.offsetParent !== null);
      }, { timeout: 25000 });
    },
    6: async () => {
      await setCaption('Step 6 of 8', 'Watch the status change to credited');
      if (stub) {
        await page.evaluate(() => fetch('/api/_credit', { method: 'POST' }).catch(() => {}));
        await waitCredited(9000);
      } else {
        // A real sandbox credits on its own schedule; the tutorial illustrates the
        // waiting state when it has not happened yet. Nothing is forced.
        await waitCredited(30000).catch(() => console.warn('not credited within 30s - recording the waiting state'));
      }
    },
    7: async () => {
      await setCaption('Step 7 of 8', 'Your Live balance is funded');
      await page.evaluate(() => window.closeDepositModal && window.closeDepositModal());
    },
    8: async () => {
      await setCaption('Step 8 of 8', 'Help is one message away');
      await page.evaluate(() => window.openSupportModal && window.openSupportModal());
    }
  };

  for (const scene of scenes) {
    const ms = (timeline.find((t) => t.id === scene.id) || {}).ms || 8000;
    const startMs = Date.now() - started;
    await captureFor(ms, actions[scene.id]);
    if (scene.id === 6 && Date.now() - started - startMs < 10500) {
      while (Date.now() - started - startMs < 10500) await shoot();
    }
    marks.push({ id: scene.id, startMs, endMs: Date.now() - started });
  }
  await shoot();

  fs.writeFileSync(path.join(args.out, 'frames.json'), JSON.stringify({
    mode: args.mode,
    baseUrl: args.mode === 'stub' ? 'local stub' : args.url,
    disclosure: args.disclosure,
    count: frames.length,
    timestamps: frames,
    marks,
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
