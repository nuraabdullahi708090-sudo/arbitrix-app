'use strict';

/**
 * Mobile modal-clipping regression (P2).
 *
 * Reproduced issue: on short viewports (320x568, 375x667) the centered
 * `.modal-overlay` + `.modal-content` modals (Profile Settings, Subscription,
 * 2FA) overflowed both the top and the bottom of the viewport. Flexbox
 * centering then placed the content's title and close button ABOVE the
 * viewport, and there was no way to scroll to them — `.modal-content` had
 * `max-height:none; overflow-y:visible`. The bottom-sheet modals
 * (deposit/withdraw/verification `.deposit-modal-content`) already used
 * `max-height:92vh; overflow-y:auto` and never clipped.
 *
 * Fix (UI-only, shared): `.modal-content{max-height:92vh; overflow-y:auto}`.
 *
 * Pins:
 *  - `.modal-content` declares BOTH max-height and internal scrolling;
 *  - the 92vh value matches the established `.deposit-modal-content` pattern;
 *  - `.modal-overlay` flex-centering is preserved (no reposition redesign);
 *  - deposit modals keep their independent 92vh+auto rule (untouched);
 *  - the change is CSS-only (no script/logic touched, no financial logic);
 *  - RTL safety: the rule uses no direction-dependent properties.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function getCssRule(src, selector) {
    const idx = src.indexOf(selector);
    assert.ok(idx >= 0, selector + ' rule should exist');
    const open = src.indexOf('{', idx);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return src.slice(open, end + 1);
}

test('P2 fix: .modal-content caps height and scrolls internally', () => {
    const rule = getCssRule(INDEX, '.modal-content {');
    assert.ok(/max-height:\s*92vh/.test(rule), 'modal-content must declare max-height: 92vh');
    assert.ok(/overflow-y:\s*auto/.test(rule), 'modal-content must scroll internally (overflow-y: auto)');
});

test('fix matches the established .deposit-modal-content pattern', () => {
    const depositRule = getCssRule(INDEX, '.deposit-modal-content{');
    const modalRule = getCssRule(INDEX, '.modal-content {');
    const depositCap = depositRule.match(/max-height:\s*([0-9]+vh)/);
    assert.ok(depositCap, 'deposit-modal-content has a vh cap');
    assert.ok(modalRule.includes('max-height: ' + depositCap[1]),
        '.modal-content uses the same vh cap as .deposit-modal-content');
});

test('overlay flex-centering is preserved (no layout redesign)', () => {
    const overlay = getCssRule(INDEX, '.modal-overlay {');
    assert.ok(overlay.includes('display: flex'), 'overlay remains flex');
    assert.ok(overlay.includes('align-items: center'), 'overlay remains centered');
    assert.ok(!/.modal-overlay \{[^}]*overflow/.test(INDEX), 'no overlay overflow hack added');
});

test('deposit modals keep their own 92vh/auto rule (untouched)', () => {
    const rule = getCssRule(INDEX, '.deposit-modal-content{');
    assert.ok(/max-height:\s*92vh/.test(rule));
    assert.ok(/overflow-y:\s*auto/.test(rule));
});

test('fix is CSS-only and direction-agnostic (RTL-safe)', () => {
    const rule = getCssRule(INDEX, '.modal-content {');
    assert.ok(!/direction|text-align|float|left:|right:/.test(rule),
        'modal-content rule must not use direction-dependent properties');
});
