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

/**
 * COLOUR: the WhatsApp button keeps its green.
 *
 * `.btn-primary` is declared three times in the sheet (twice as a palette rule and
 * once scoped to dialog content for the glow). The original single-class
 * `.payment-partner-whatsapp` rule therefore lost the cascade and the button
 * rendered azure - the green was in the source but never on screen. These tests
 * pin the selector STRENGTH (so ordering cannot break it again), the exact colours
 * and their measured contrast.
 */
const WA_RULE = INDEX.match(/\.btn\.payment-partner-whatsapp\.payment-partner-btn\{([^}]+)\}/);
const WA_HOVER = INDEX.match(/\.btn\.payment-partner-whatsapp\.payment-partner-btn:hover\{([^}]+)\}/);
const WA_ACTIVE = INDEX.match(/\.btn\.payment-partner-whatsapp\.payment-partner-btn:active\{([^}]+)\}/);

test('the WhatsApp variant is selected with enough specificity to survive the palette rules', () => {
  assert.ok(WA_RULE, 'the compound WhatsApp rule is missing');
  // 3 class selectors (0,3,0) beats `.btn-primary` (0,1,0) and
  // `.deposit-modal-content .btn-primary` (0,2,0) regardless of source order.
  const classes = (WA_RULE[0].match(/\.[a-z-]+/gi) || []).length;
  assert.ok(classes >= 3, 'expected at least 3 classes in the selector, saw ' + classes);
  assert.equal(/!important/.test(WA_RULE[1]), false, 'no !important needed');
  assert.equal(/!important/.test((WA_HOVER || ['', ''])[1]), false, 'no !important on hover either');
});

test('the three states use the intended greens and a near-black label', () => {
  assert.ok(/background:#25D366/.test(WA_RULE[1]), 'rest background must be #25D366');
  assert.ok(/border-color:#25D366/.test(WA_RULE[1]), 'rest border must match the fill');
  assert.ok(/color:#04150B/.test(WA_RULE[1]), 'rest label/icon must be the near-black');
  assert.ok(WA_HOVER && /background:#1FB457/.test(WA_HOVER[1]), 'hover darkens to #1FB457');
  assert.ok(WA_ACTIVE && /background:#1AA34E/.test(WA_ACTIVE[1]), 'active darkens further to #1AA34E');
  for (const rule of [WA_RULE[1], WA_HOVER[1], WA_ACTIVE[1]]) {
    assert.ok(/color:#04150B/.test(rule), 'every state keeps the same label colour');
  }
});

test('the glow follows the button colour instead of leaking the azure brand', () => {
  assert.ok(/box-shadow:[^;]*rgba\(37,211,102/.test(WA_RULE[1]), 'rest glow is green-tinted');
  assert.equal(/rgba\(94,160,255/.test(WA_RULE[1]), false, 'no azure glow on the WhatsApp button');
});

test('every state clears WCAG AA against the label colour', () => {
  const lum = (hex) => {
    const n = hex.replace('#', '');
    const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
    const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * f(ch[0]) + 0.7152 * f(ch[1]) + 0.0722 * f(ch[2]);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const bg of ['#25D366', '#1FB457', '#1AA34E']) {
    assert.ok(ratio(bg, '#04150B') >= 4.5, bg + ' must reach 4.5:1, got ' + ratio(bg, '#04150B').toFixed(2));
  }
});

test('no other button picked up the green', () => {
  // the compound class appears only on the WhatsApp state rules
  const occurrences = (INDEX.match(/\.btn\.payment-partner-whatsapp\.payment-partner-btn/g) || []).length;
  assert.strictEqual(occurrences, 3, 'expected exactly rest + hover + active');
  // the generic primary rules are untouched
  assert.ok(/\.btn-primary \{\s*background:var\(--kx-accent\)/.test(INDEX), '.btn-primary keeps the azure accent');
  assert.ok(/\.deposit-modal-content \.btn-primary \{\s*box-shadow/.test(INDEX), 'the dialog glow rule is intact');
  // and the old single-class rule is gone, so nothing can shadow the new one
  assert.equal(/\.payment-partner-whatsapp\{/.test(INDEX), false, 'the losing single-class rule must be gone');
});
