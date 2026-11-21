'use strict';

/**
 * PWA branding and installability contract.
 *
 * The manifest used to be a runtime Blob URL and the icons were SVG data URIs.
 * A Blob cannot be re-fetched by the platform at install time and iOS ignores
 * an SVG apple-touch-icon, so both are now real files. These tests pin the
 * files the browser and the OS actually read, including the PNG pixel data of
 * the maskable icon (its safe zone cannot be verified from markup alone).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PUBLIC = path.join(ROOT, 'public');

/* ---------------------------------------------------------------- helpers */

// Minimal 8-bit PNG reader: enough to assert dimensions, opacity and the
// position of the artwork. Deliberately dependency-free.
function decodePng(file) {
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.subarray(1, 4).toString('latin1'), 'PNG', file + ' is a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  assert.strictEqual(bitDepth, 8, file + ' is 8-bit');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(channels > 0, file + ' is RGB or RGBA (colour type ' + colorType + ')');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.from(line);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) cur[x] = (cur[x] + a) & 255;
      else if (filter === 2) cur[x] = (cur[x] + b) & 255;
      else if (filter === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

function px(img, x, y) {
  const i = (y * img.width + x) * img.channels;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.channels === 4 ? img.data[i + 3] : 255];
}

const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));

/* ------------------------------------------------------------------ tests */

test('the manifest is a static file and the page links exactly one', () => {
  const links = INDEX.match(/<link[^>]*rel="manifest"[^>]*>/g) || [];
  assert.strictEqual(links.length, 1, 'exactly one manifest link');
  assert.match(links[0], /href="\/manifest\.webmanifest"/);
  assert.ok(!/id="manifest-link"/.test(INDEX), 'the runtime-written link is gone');
  assert.ok(!/new Blob\(\[JSON\.stringify\(manifest\)\]/.test(INDEX), 'no Blob manifest');
  assert.ok(!/URL\.createObjectURL/.test(INDEX.slice(0, INDEX.indexOf('const PWA ='))),
    'no object URL is created for the manifest');
});

test('the manifest declares the Kalderix identity and the app root', () => {
  assert.strictEqual(manifest.name, 'Kalderix');
  assert.strictEqual(manifest.short_name, 'Kalderix');
  assert.strictEqual(manifest.start_url, '/');
  assert.strictEqual(manifest.scope, '/');
  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual(manifest.id, '/');
});

test('theme and background colours are the live design tokens', () => {
  const bg = (INDEX.match(/--kx-bg:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
  assert.ok(bg, 'the page defines --kx-bg');
  assert.strictEqual(manifest.background_color, bg, 'manifest background matches --kx-bg');
  assert.strictEqual(manifest.theme_color, bg, 'manifest theme matches --kx-bg');
  const meta = (INDEX.match(/<meta name="theme-color" content="([^"]+)"/) || [])[1];
  assert.strictEqual(meta, bg, 'the theme-color meta matches too');
});

test('every manifest icon is a real PNG with the declared dimensions', () => {
  assert.ok(manifest.icons.length >= 3);
  for (const icon of manifest.icons) {
    assert.strictEqual(icon.type, 'image/png', icon.src + ' is a PNG');
    const file = path.join(PUBLIC, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), 'exists: ' + icon.src);
    const img = decodePng(file);
    assert.strictEqual(img.width + 'x' + img.height, icon.sizes, icon.src + ' matches its declared size');
  }
});

test('standard icons keep transparent corners (rounded artwork for "any")', () => {
  for (const icon of manifest.icons.filter((i) => i.purpose === 'any')) {
    const img = decodePng(path.join(PUBLIC, icon.src.replace(/^\//, '')));
    assert.strictEqual(px(img, 0, 0)[3], 0, icon.src + ' has a transparent corner');
  }
});

test('maskable icons are full-bleed and keep the artwork inside the safe zone', () => {
  const maskable = manifest.icons.filter((i) => String(i.purpose).includes('maskable'));
  assert.ok(maskable.length >= 1, 'a maskable icon is declared');
  const bg = manifest.background_color;
  const bgRgb = [parseInt(bg.slice(1, 3), 16), parseInt(bg.slice(3, 5), 16), parseInt(bg.slice(5, 7), 16)];
  for (const icon of maskable) {
    const img = decodePng(path.join(PUBLIC, icon.src.replace(/^\//, '')));
    for (const [x, y] of [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]]) {
      const p = px(img, x, y);
      assert.strictEqual(p[3], 255, icon.src + ' corner is opaque (full bleed)');
      assert.deepStrictEqual([p[0], p[1], p[2]], bgRgb, icon.src + ' corner is the brand background');
    }
    // Android crops to a circle of diameter 80% of the icon: key artwork must
    // stay inside a radius of 40% of the size, measured from the centre.
    const cx = img.width / 2, cy = img.height / 2;
    let maxRadius = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const p = px(img, x, y);
        const isArt = Math.abs(p[0] - bgRgb[0]) + Math.abs(p[1] - bgRgb[1]) + Math.abs(p[2] - bgRgb[2]) > 60;
        if (!isArt) continue;
        maxRadius = Math.max(maxRadius, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
      }
    }
    const limit = 0.4 * img.width;
    assert.ok(maxRadius <= limit, icon.src + ' artwork radius ' + maxRadius.toFixed(1) + ' <= ' + limit);
  }
});

test('the apple touch icon is a 180px opaque PNG (iOS ignores SVG here)', () => {
  const tag = (INDEX.match(/<link rel="apple-touch-icon"[^>]*>/) || [])[0] || '';
  assert.match(tag, /sizes="180x180"/, 'declares 180x180');
  assert.match(tag, /href="\/icons\/apple-touch-icon-180\.png"/, 'points at the PNG');
  const img = decodePng(path.join(PUBLIC, 'icons', 'apple-touch-icon-180.png'));
  assert.strictEqual(img.width, 180);
  assert.strictEqual(img.height, 180);
  // iOS composites its own mask: no transparency anywhere.
  for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179]]) {
    assert.strictEqual(px(img, x, y)[3], 255, 'opaque at ' + x + ',' + y);
  }
});

test('the favicon links resolve and no icon link is a data URI', () => {
  const head = INDEX.slice(0, INDEX.indexOf('</head>'));
  assert.ok(!/rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="data:/.test(head),
    'no icon link is a data URI');
  const hrefs = [...head.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 3, 'svg favicon, 32px PNG and the apple icon');
  for (const href of hrefs) {
    assert.ok(fs.existsSync(path.join(PUBLIC, href.replace(/^\//, ''))), 'resolves: ' + href);
  }
});

test('the app presents one Kalderix name to the install surface', () => {
  assert.match(INDEX, /<meta name="apple-mobile-web-app-title" content="Kalderix">/);
  assert.match(INDEX, /<meta name="application-name" content="Kalderix">/);
  assert.match(INDEX, /<title>Kalderix \|/);
  // The installed-app surfaces must not carry the pre-rename name.
  const head = INDEX.slice(0, INDEX.indexOf('</head>'));
  assert.ok(!/content="Arbitrix"/.test(head), 'no Arbitrix in the head metadata');
});

test('applyBrandAssets no longer writes SVG data URIs over the icon links', () => {
  const fn = INDEX.slice(INDEX.indexOf('function applyBrandAssets()'));
  const body = fn.slice(0, fn.indexOf('\napplyBrandAssets();'));
  assert.ok(!/iconMarkup/.test(body), 'the runtime SVG icon builder is gone');
  assert.match(body, /apple\.setAttribute\('href', '\/icons\/apple-touch-icon-180\.png'\)/,
    'it keeps the real PNG');
  assert.match(body, /fav\.setAttribute\('href', '\/brand\/kalderix-favicon\.svg'\)/,
    'it keeps the real favicon file');
});

test('the service worker leaves the manifest and icons alone', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  // Only same-origin navigations are intercepted: static assets and the
  // manifest are fetched from the network, so a new manifest always lands.
  assert.match(sw, /request\.mode !== 'navigate'/, 'non-navigation requests fall through');
  assert.ok(!/manifest\.webmanifest/.test(sw), 'the manifest is not cached by the worker');
  assert.ok(!/icons\//.test(sw), 'icon assets are not cached by the worker');
  // The legacy cache name is deliberately preserved for existing installs.
  assert.match(sw, /SHELL_CACHE = 'arbitrix-shell-v1'/, 'cache name kept for compatibility');
});
