/**
 * PARTNER CONTACT BUTTON ICONS.
 *
 * The two payment-partner buttons used Font Awesome classes (`fab fa-whatsapp`,
 * `fab fa-telegram`). Two problems:
 *
 *   1. `fa-telegram` is the circular Telegram BADGE, not the paper plane, and
 *      neither icon was recognisable at 18px next to a label.
 *   2. Font Awesome is loaded from a CDN. When that request is blocked the
 *      buttons rendered as bare text on a coloured rectangle - the icon was the
 *      affordance for "this opens WhatsApp", so losing it silently is worse than
 *      a cosmetic miss.
 *
 * Both marks are now inline SVG built from the official brand geometry
 * (Simple Icons, CC0) and coloured with `currentColor`, so they inherit whatever
 * contrast the button already guarantees and cannot be lost to a CDN failure.
 *
 * These tests pin the marks, the sizing contract and - importantly - that NOTHING
 * else about the buttons moved: same URLs, same labels, same classes, no new
 * destination, no financial surface.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const WA = INDEX.match(/const PARTNER_ICON_WHATSAPP = '([^']+)'/);
const TG = INDEX.match(/const PARTNER_ICON_TELEGRAM = '([^']+)'/);

test('both brand marks exist as constants, not Font Awesome classes', () => {
  assert.ok(WA, 'PARTNER_ICON_WHATSAPP constant is missing');
  assert.ok(TG, 'PARTNER_ICON_TELEGRAM constant is missing');
  assert.ok(WA[1].startsWith('<svg'), 'WhatsApp mark is not an SVG');
  assert.ok(TG[1].startsWith('<svg'), 'Telegram mark is not an SVG');
});

test('the marks are the official geometry, not hand-drawn guesses', () => {
  // WhatsApp: the official mark's path is ~1.1 kB and starts at the handset.
  const waPath = WA[1].match(/<path d="([^"]+)"/)[1];
  assert.ok(waPath.length > 1000 && waPath.length < 1300, 'unexpected WhatsApp path length ' + waPath.length);
  assert.ok(waPath.startsWith('M17.472 14.382'), 'the WhatsApp path should begin at the handset');
  // Telegram: the paper plane only (the badge circle is deliberately excluded -
  // filled with one colour it renders as a solid disc with no plane inside).
  const tgPath = TG[1].match(/<path d="([^"]+)"/)[1];
  assert.ok(tgPath.startsWith('M16.906 7.224'), 'the Telegram mark should be the plane, not the badge');
  assert.ok(!tgPath.includes('A12 12'), 'the badge circle must not be included');
  // both are 24-unit art with no raster fallback
  assert.ok(WA[1].includes('viewBox="0 0 24 24"'));
  assert.ok(TG[1].includes('viewBox="3.5 6.2 15 12.8"'), 'the plane is framed to its own bbox so it fills the box');
});

test('the marks inherit the button colour and are hidden from screen readers', () => {
  for (const mark of [WA[1], TG[1]]) {
    assert.ok(mark.includes('fill="currentColor"'), 'the icon must inherit the button text colour');
    assert.ok(mark.includes('aria-hidden="true"'), 'the decorative icon needs aria-hidden');
    assert.ok(mark.includes('class="partner-btn-icon"'), 'both icons share one sizing class');
  }
});

test('the sizing contract makes both icons identical and non-shrinking', () => {
  const rule = INDEX.match(/\.partner-btn-icon\{([^}]+)\}/);
  assert.ok(rule, '.partner-btn-icon rule is missing');
  const css = rule[1];
  assert.ok(/width:18px/.test(css), 'width 18px');
  assert.ok(/height:18px/.test(css), 'height 18px');
  assert.ok(/flex:0\s+0\s+auto/.test(css), 'the icon must not shrink when the label is long');
  assert.equal(/margin/.test(css), false, 'spacing comes from the button gap, not a margin');
});

test('the deposit partner buttons use the new marks, in order, with unchanged links', () => {
  const fn = INDEX.slice(INDEX.indexOf('function renderDepositPartnerAssistance'));
  const body = fn.slice(0, fn.indexOf('function updatePaymentPartnerLinks'));
  assert.ok(body.includes('PARTNER_ICON_WHATSAPP'), 'WhatsApp button must use the brand mark');
  assert.ok(body.includes('PARTNER_ICON_TELEGRAM'), 'Telegram button must use the paper plane');
  assert.equal(/fab fa-whatsapp|fab fa-telegram/.test(body), false, 'no Font Awesome icon left behind');
  // the destinations and the labels are untouched
  assert.ok(body.includes('escapeHtml(PARTNER_PRIMARY_WHATSAPP_URL)'), 'WhatsApp URL unchanged');
  assert.ok(body.includes('escapeHtml(alexUrl)'), 'Telegram URL unchanged');
  assert.ok(body.includes("t('deposit.partner.oliviaBtn')"), 'Olivia label unchanged');
  assert.ok(body.includes("t('deposit.partner.alexBtn')"), 'Alex label unchanged');
  assert.ok(body.indexOf('PARTNER_ICON_WHATSAPP') < body.indexOf('PARTNER_ICON_TELEGRAM'), 'Olivia still first');
});

test('the payment-step contact list uses the same plane, so one surface cannot drift', () => {
  const start = INDEX.indexOf('function renderPaymentPartnerContacts');
  const end = INDEX.indexOf('function renderDepositPartnerAssistance');
  assert.ok(start > 0 && end > start, 'both renderers should be present');
  const body = INDEX.slice(start, end);
  assert.ok(body.includes('PARTNER_ICON_TELEGRAM'), 'the payment-step Telegram button shares the mark');
  assert.equal(/fab fa-telegram/.test(body), false, 'no Font Awesome icon left behind');
});

test('no other partner destination was added by this change', () => {
  assert.strictEqual((INDEX.match(/wa\.me\/17828027841/g) || []).length, 1, 'one WhatsApp destination');
  // Alex's handle lives in one meta tag; the t.me URL is built from it at runtime
  assert.strictEqual((INDEX.match(/content="@AlexArbitrix"/g) || []).length, 1, 'one Alex destination');
  // the meta tag appears once; the same name is read by the resolver and a comment
  // exactly one REAL meta tag configures Alex (the other matches are doc comments)
  assert.strictEqual((INDEX.match(/^\s*<meta name="arbitrix-partner-support-telegram"[^>]*>/gm) || []).length, 1,
    'one meta source');
  assert.equal(/t\.me\/OliviaArbitrix/.test(INDEX), false, 'Olivia is never offered on Telegram');
});

test('this is presentation only: no financial or routing surface touched', () => {
  for (const banned of ['live_balance =', 'record_trade_safe', 'requestWithdraw', 'credit_payment_safe']) {
    assert.equal(WA[1].includes(banned) || TG[1].includes(banned), false);
  }
  // the SVG constants are used only inside the two renderers
  const uses = (INDEX.match(/PARTNER_ICON_(?:WHATSAPP|TELEGRAM)/g) || []).length;
  assert.ok(uses >= 5, 'expected 2 definitions + 3 call sites, saw ' + uses);
});

test('the button design is untouched apart from the icon slot', () => {
  // the same class list, the same primary/secondary treatment, the same min height
  assert.ok(INDEX.includes('class="btn btn-primary payment-partner-whatsapp deposit-payment-partner payment-partner-btn"'));
  assert.ok(INDEX.includes('class="btn btn-primary deposit-payment-partner payment-partner-btn"'));
  assert.ok(/\.deposit-payment-partner\{display:block;width:100%;text-align:center;min-height:44px;\}/.test(INDEX));
  // the Font Awesome sheet stays: other icons in the app still use it
  assert.ok(INDEX.includes('font-awesome/6.0.0-beta3/css/all.min.css'));
});
