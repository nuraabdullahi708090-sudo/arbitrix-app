'use strict';

/**
 * Instrument-claim audit.
 *
 * The platform displays 47 instruments across five classes. It does NOT route
 * orders to external venues, so no customer-facing copy may imply that it does,
 * and the "execution is not guaranteed" disclaimer must exist in every locale.
 *
 * This suite is the regression guard: the disclaimer cannot be silently dropped
 * and a future marketing edit cannot reintroduce an exchange-connectivity claim.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const ASSETS = require('../services/tradingAssets');

function translations() {
  const start = INDEX.indexOf('const TRANSLATIONS');
  let depth = 0;
  let end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(INDEX.slice(start, end + 1).replace('const TRANSLATIONS', 'globalThis.T') + ';', sandbox);
  return sandbox.T;
}

const LOCALES = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

test('the displayed universe is 47 instruments across five classes', () => {
  assert.strictEqual(ASSETS.TRADING_ASSETS.length, 47);
  const classes = new Set(ASSETS.TRADING_ASSETS.map((a) => a.category));
  assert.strictEqual(classes.size, 5);
  // Every instrument carries display metadata only - no endpoint, venue handle,
  // contract address or execution flag exists in the registry.
  for (const a of ASSETS.TRADING_ASSETS) {
    assert.deepStrictEqual(Object.keys(a).sort(), ['category', 'detail', 'name', 'symbol']);
  }
});

test('the markets section presents instruments as DISPLAYED, not as executable', () => {
  const T = translations();
  assert.strictEqual(T.en['landing.assets.title'], 'Supported Markets');
  assert.match(T.en['landing.assets.subtitle'], /displayed across the trading experience/i);
});

test('every locale carries the execution disclaimer', () => {
  const T = translations();
  for (const l of LOCALES) {
    const note = T[l]['landing.assets.note'];
    assert.ok(note && note.trim().length > 20, l + ' is missing landing.assets.note');
  }
  // English is the canonical wording other locales are derived from.
  assert.match(T.en['landing.assets.note'], /not a guarantee of execution/i);
});

test('no customer-facing copy claims external venue connectivity', () => {
  const T = translations();
  const banned = [
    /\bconnected (?:to|with) \d*\s*(?:exchanges?|venues?|brokers?)/i,
    /\broutes? (?:orders? )?(?:to|through) (?:an )?(?:exchange|venue|liquidity)/i,
    /\bexecutes? (?:on|through) (?:external|multiple) (?:exchanges?|venues?)/i,
    /\bdirect market access\b/i,
    /\bcolocat/i,
    /\bprime broker/i
  ];
  for (const l of LOCALES) {
    for (const [key, value] of Object.entries(T[l])) {
      if (typeof value !== 'string') continue;
      for (const re of banned) {
        assert.ok(!re.test(value), `${l}/${key} claims venue connectivity: ${value}`);
      }
    }
  }
});

test('"Automated Execution" is not described as exchange routing', () => {
  const T = translations();
  assert.strictEqual(T.en['landing.trust.security.title'], 'Automated Execution');
  // The label is acceptable only because nothing defines it as external routing.
  assert.ok(!/exchange/i.test(T.en['landing.trust.security.desc'] || ''));
});

test('the landing opportunity ticker is explicitly illustrative', () => {
  // The notifications use the shared registry for symbol names but present
  // simulated spreads. The disclaimer must remain visible in the markup.
  assert.ok(INDEX.includes('arbOpp.disclosure'), 'the ticker disclaimer key must be referenced');
  const T = translations();
  for (const l of LOCALES) {
    const disclaimer = T[l]['arbOpp.disclosure'];
    assert.ok(disclaimer && disclaimer.trim(), l + ' lost the ticker disclaimer');
  }
  // And the API says so too, so no client can present the values as live.
  const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(SERVER, /simulated:\s*true/);
});
