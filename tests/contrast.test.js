'use strict';

/**
 * CONTRAST — WCAG 2.1 maths over the design tokens.
 *
 * The redesign's dark surfaces made the accent usable as a fill but not as small
 * text (#7C5CFF on #111726 measures 4.11:1), and dark text on a violet fill was
 * 4.41:1. Both were fixed with dedicated tokens. This test computes the real
 * ratios from the token values, so a future palette tweak that reintroduces a
 * failing pair fails here instead of reaching customers.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const DS = INDEX.slice(INDEX.indexOf('<style id="kx-design-system">'));
const CSS = DS.slice(0, DS.indexOf('</style>'));

const hex = (name) => {
    const m = CSS.match(new RegExp('--' + name + '\\s*:\\s*(#[0-9A-Fa-f]{6})'));
    assert.ok(m, `token --${name} is a hex colour`);
    return m[1];
};
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lum = (h) => {
    const [r, g, b] = rgb(h).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
// rgba(124,92,255,0.1) over a surface, as the weak accents are rendered.
const tint = (fg, bg, alpha) => {
    const f = rgb(fg), b = rgb(bg);
    const mix = f.map((v, i) => v * alpha + b[i] * (1 - alpha));
    return '#' + mix.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
};

const SURFACES = ['kx-bg', 'kx-surface', 'kx-surface-2', 'kx-elevated'];

test('1. body text meets 4.5:1 on every surface', () => {
    ['kx-text', 'kx-text-2', 'kx-text-3'].forEach((fg) => {
        SURFACES.forEach((bg) => {
            const r = ratio(hex(fg), hex(bg));
            assert.ok(r >= 4.5, `${fg} on ${bg} is ${r.toFixed(2)}:1 (needs 4.5)`);
        });
    });
});

test('2. the accent reads as text as well as a fill (emerald accent)', () => {
    // The violet accent could not be used as small text (4.11:1), which is why
    // --kx-accent-text existed. The emerald accent clears AA on every surface on
    // its own, so both roles are legible and the text token stays the documented
    // choice for anything under 16px.
    SURFACES.forEach((bg) => {
        const accent = ratio(hex('kx-accent'), hex(bg));
        assert.ok(accent >= 4.5, `kx-accent on ${bg} is ${accent.toFixed(2)}:1 (needs 4.5)`);
        const r = ratio(hex('kx-accent-text'), hex(bg));
        assert.ok(r >= 4.5, `kx-accent-text on ${bg} is ${r.toFixed(2)}:1`);
    });
    // Ink on an accent fill must also pass, because primary buttons use it.
    const onAccent = ratio(hex('kx-on-accent'), hex('kx-accent'));
    assert.ok(onAccent >= 4.5, `kx-on-accent on kx-accent is ${onAccent.toFixed(2)}:1`);
    // And the rules really route accent TEXT through the text token.
    ['a { color: var(--kx-accent-text); }',
        '.ticker-item .ticker-amount,',
        '.landing-section-tag,',
        '.landing-compare-tag,',
        '.landing-testimonial-avatar,',
        '.language-option.active { color: var(--kx-accent-text); }',
        '.ticker-label { color: var(--kx-accent-text);',
        '.stat-withdraw-btn { background: var(--kx-accent-weak); border-color: var(--kx-accent-border); color: var(--kx-accent-text); }'
    ].forEach((needle) => assert.ok(CSS.includes(needle), 'missing: ' + needle.trim()));
});

test('3. text on a violet fill meets 4.5:1', () => {
    const r = ratio(hex('kx-on-accent'), hex('kx-accent'));
    assert.ok(r >= 4.5, `--kx-on-accent on --kx-accent is ${r.toFixed(2)}:1`);
    // Every filled control must use the token, not a hard-coded dark.
    ['.btn-primary,', '.mode-tab.active,', '.network-btn.active,', '.ios-step-num,', '.landing-step-number { color: var(--kx-on-accent); }',
        '.stat-deposit-btn { background: var(--kx-accent); color: var(--kx-on-accent); }'
    ].forEach((needle) => assert.ok(CSS.includes(needle), 'missing: ' + needle.trim()));
});

test('4. accent text on the tinted (weak) surfaces still passes', () => {
    SURFACES.forEach((bg) => {
        const weak = tint(hex('kx-accent'), hex(bg), 0.12);
        const r = ratio(hex('kx-accent-text'), weak);
        assert.ok(r >= 4.5, `accent-text on a 12% accent tint over ${bg} is ${r.toFixed(2)}:1`);
    });
});

test('5. danger text on a red-tinted panel passes', () => {
    const panel = tint(hex('kx-danger'), hex('kx-surface'), 0.14);
    const plain = ratio(hex('kx-danger-text'), hex('kx-surface'));
    const tinted = ratio(hex('kx-danger-text'), panel);
    assert.ok(plain >= 4.5, `danger-text on a surface is ${plain.toFixed(2)}:1`);
    assert.ok(tinted >= 4.5, `danger-text on a tinted panel is ${tinted.toFixed(2)}:1`);
    // The darker --kx-danger red was 4.0:1 on that panel; it must not be used as text.
    assert.ok(ratio(hex('kx-danger'), panel) < 4.5, 'the fill red stays a fill colour');
});

test('6. status pills and badges keep readable text', () => {
    const pairs = [['kx-success-text', 'kx-success'], ['kx-warning-text', 'kx-warning'],
        ['kx-danger-text', 'kx-danger'], ['kx-accent-text', 'kx-accent']];
    pairs.forEach(([text, fill]) => {
        const panel = tint(hex(fill), hex('kx-surface'), 0.14);
        const r = ratio(hex(text), panel);
        assert.ok(r >= 4.5, `${text} on a tinted ${fill} pill is ${r.toFixed(2)}:1`);
    });
});

test('7. the legacy below-AA rules are overridden, not merely present', () => {
    // The old rules still exist (this pass does not rewrite legacy markup), so what
    // matters is that the design system comes AFTER them and replaces the pair.
    const statRule = INDEX.indexOf('.stat-deposit-btn{display:flex');
    const dsStart = INDEX.indexOf('<style id="kx-design-system">');
    assert.ok(statRule > 0 && dsStart > statRule, 'the override block loads after the legacy rule');
    assert.ok(CSS.includes('.stat-deposit-btn { background: var(--kx-accent); color: var(--kx-on-accent); }'),
        'the failing gradient/dark-text button is replaced');
    assert.ok(CSS.includes('.landing-section-tag { background: var(--kx-accent-weak); border: 1px solid var(--kx-accent-border); }'),
        'the section tag keeps the accent but on a readable surface');
    assert.ok(INDEX.indexOf('.badge-rarity{position:absolute') < dsStart, 'the legacy 8px badge rule precedes the layer');
    assert.ok(CSS.includes('.badge-rarity { font-size: 11px; }'), 'the floor is enforced in the layer');
});
