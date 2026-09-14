'use strict';

/**
 * ACHIEVEMENTS PANEL RELOCATION — tests.
 *
 * The Achievements panel was removed from the main dashboard so the dashboard
 * stays focused on trading, and moved into Profile Settings as a collapsed
 * section. This is a DISPLAY/LOCATION change only:
 *   - the panel markup, ids and styling are preserved (no feature loss);
 *   - BADGES, renderBadges() and checkBadges() are untouched, so unlocking,
 *     toasts, confetti, ticker announcements and per-wallet persistence still
 *     work exactly as before;
 *   - nothing financial (balances, trades, deposits, withdrawals, MTA,
 *     subscription) or the activity ticker banner is touched.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' must be brace-matchable');
    return INDEX.slice(start, end + 1);
}

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx), depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const MAIN_START = INDEX.indexOf('id="mainContent"');
const PROFILE_START = INDEX.indexOf('id="profileModal"');
const NEXT_OVERLAY = INDEX.indexOf('<div class="modal-overlay"', PROFILE_START + 10);
const PANEL_AT = INDEX.indexOf('achievements-card profile-achievements');

test('the Achievements panel is gone from the main dashboard', () => {
    assert.ok(MAIN_START > 0 && PROFILE_START > MAIN_START, 'dashboard and profile modal must both be found');
    const dashboard = INDEX.slice(MAIN_START, PROFILE_START);
    assert.ok(!/achievements-card/.test(dashboard), 'no achievements card markup may remain in the dashboard');
    assert.ok(!/id="badgesGrid"/.test(dashboard), 'the badges grid must not be rendered in the dashboard');
    assert.ok(!/id="achievementsCounter"/.test(dashboard), 'the achievements counter must not be in the dashboard');
    // The dashboard still keeps its real content (nothing else was removed).
    for (const keep of ['id="startHereCard"', 'class="chart-card"', 'class="trading-stats-card"', 'id="mtaProgressCard"']) {
        assert.ok(dashboard.includes(keep), 'dashboard must still contain ' + keep);
    }
});

test('the achievements feature is preserved, not deleted', () => {
    assert.ok(PANEL_AT > 0, 'the panel markup must still exist somewhere');
    for (const id of ['achievementsCounter', 'achievementsProgressFill', 'achievementsProgressText', 'achievementsProgressPct', 'badgesGrid']) {
        assert.strictEqual((INDEX.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id + ' must exist exactly once');
    }
    // Original pieces of the card are intact.
    for (const frag of ['class="badges-grid" id="badgesGrid"', 'class="achievements-progress-bar"',
                        'class="achievements-progress-label"', 'data-i18n="achievements.title"',
                        'data-i18n="achievements.startTrading"', 'fas fa-medal']) {
        assert.ok(INDEX.includes(frag), 'preserved fragment missing: ' + frag);
    }
    // The badge catalogue and its logic are untouched.
    const badges = INDEX.slice(INDEX.indexOf('const BADGES = ['), INDEX.indexOf('const BADGES = [') + 3000);
    assert.ok(/first_trade/.test(badges) && /diamond_hands/.test(badges), 'the BADGES catalogue must be intact');
    assert.ok(extractFunction('renderBadges').includes('badgesGrid'), 'renderBadges must still target the same grid');
    assert.ok(extractFunction('checkBadges').includes('BADGES.forEach'), 'checkBadges logic must be intact');
    assert.ok(/localStorage\.setItem\('arbi_badges'/.test(INDEX), 'badge persistence must be untouched');
});

test('achievements are reachable from Profile Settings', () => {
    assert.ok(PROFILE_START > 0 && NEXT_OVERLAY > PROFILE_START, 'profile modal bounds must be found');
    const profileModal = INDEX.slice(PROFILE_START, NEXT_OVERLAY);
    assert.ok(profileModal.includes('achievements-card profile-achievements'), 'the panel must live inside the profile modal');
    assert.ok(profileModal.includes('id="badgesGrid"'), 'the grid must live inside the profile modal');
    // The profile modal keeps all of its existing settings.
    for (const keep of ['id="profileDisplayName"', 'id="profileEmail"', 'data-lang="en"', 'id="soundEnabledToggle"',
                        'id="subscriptionProfileCard"', 'openSupportModal()']) {
        assert.ok(profileModal.includes(keep), 'profile modal must still contain ' + keep);
    }
});

test('the panel is a simple collapsible section (no new page or navigation)', () => {
    assert.ok(/<details class="achievements-card profile-achievements" id="profileAchievements">/.test(INDEX), 'details wrapper');
    assert.ok(/<summary class="achievements-header">/.test(INDEX), 'summary header');
    // Collapsed by default: no `open` attribute on the wrapper.
    assert.ok(!/<details class="achievements-card profile-achievements"[^>]*\bopen\b/.test(INDEX), 'must start collapsed');
    // No new nav entries or routes were invented for it.
    assert.ok(!/openAchievementsModal|achievementsPage|href="#\/achievements"/.test(INDEX), 'no new navigation system');
});

test('styling is preserved and the wrapper is styled', () => {
    for (const rule of ['.achievements-card{', '.achievements-card::before{', '.achievements-header{',
                        '.achievements-title{', '.achievements-counter{', '.achievements-progress{',
                        '.achievements-progress-bar{', '.achievements-progress-fill{', '.achievements-progress-label{',
                        '.badges-grid{', '.badge-item{']) {
        assert.ok(INDEX.includes(rule), 'original CSS rule must survive: ' + rule);
    }
    assert.ok(/\.profile-achievements\>summary\{/.test(INDEX), 'summary styling must exist');
    assert.ok(/\.profile-achievements\>summary::\-webkit-details-marker\{display:none;\}/.test(INDEX), 'default marker hidden');
    assert.ok(/\.profile-achievements\[open\]\>summary::after\{transform:rotate\(180deg\);\}/.test(INDEX), 'collapse indicator');
    // Mobile badge grid rules are untouched.
    assert.ok(/\.badges-grid\{grid-template-columns:repeat\(2,1fr\);\}/.test(INDEX), 'mobile 2-column rule preserved');
    // The narrower modal needs width-driven columns, otherwise the fixed
    // 3-column rule squeezes cells and long names overflow. Scoped only to the
    // profile section, with a break-word backstop.
    assert.ok(/\.profile-achievements \.badges-grid\{grid-template-columns:repeat\(auto-fill,minmax\(104px,1fr\)\);\}/.test(INDEX), 'adaptive columns inside the profile section');
    assert.ok(/\.profile-achievements \.badge-name,\.profile-achievements \.badge-desc\{overflow-wrap:break-word;\}/.test(INDEX), 'break-word backstop');
    // The original global rules must remain byte-identical (not rewritten).
    assert.ok(INDEX.includes('.badges-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:14px 16px 16px;position:relative;z-index:1;}'), 'base .badges-grid rule untouched');
});

test('renderBadges still populates the moved panel (functional)', () => {
    const els = {};
    const mk = (id) => (els[id] = { id, innerHTML: '', textContent: '', style: {} });
    ['badgesGrid', 'achievementsCounter', 'achievementsProgressFill', 'achievementsProgressText', 'achievementsProgressPct'].forEach(mk);
    const sandbox = {
        els,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        document: { getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [] },
        t: (k) => k,
        APP: { currentWallet: 'demo', MTA: 200, unlockedBadges: { demo: ['first_trade', 'ten_trades'], live: [] } },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        'var APP;',
        'function getEl(id){ return document.getElementById(id); }',
        INDEX.slice(INDEX.indexOf('const BADGES = ['), INDEX.indexOf('];', INDEX.indexOf('const BADGES = [')) + 2),
        extractFunction('badgeRarityLabel'),
        extractFunction('getBadgeName'),
        extractFunction('getBadgeDesc'),
        extractFunction('renderBadges'),
        'globalThis.__render = renderBadges;',
    ].join('\n'), sandbox);
    vm.runInContext('__render()', sandbox);

    const grid = els.badgesGrid.innerHTML;
    const items = grid.match(/class="badge-item /g) || [];
    assert.strictEqual(items.length, 12, 'all 12 badges must render from the new location');
    assert.strictEqual((grid.match(/unlocked/g) || []).length >= 2, true, 'unlocked badges must be marked');
    assert.ok(/2 \/ 12/.test(els.achievementsCounter.innerHTML), 'counter must still update: ' + els.achievementsCounter.innerHTML);
    assert.strictEqual(els.achievementsProgressFill.style.width, '16.666666666666664%', 'progress fill must still update');
    assert.strictEqual(els.achievementsProgressPct.textContent, '17%', 'progress percent must still update');
});

test('i18n is unchanged (no new keys, all locales intact)', () => {
    const T = loadTranslations();
    const keys = Object.keys(T.en);
    assert.strictEqual(keys.length, 1398, 'dictionary size must match the current baseline');
    for (const lang of LANGS) {
        assert.deepStrictEqual(Object.keys(T[lang]).sort(), keys.slice().sort(), lang + ' key set must match EN');
        for (const k of ['achievements.title', 'achievements.unlocked', 'achievements.startTrading', 'achievements.allUnlocked', 'achievements.next']) {
            assert.ok(String(T[lang][k] || '').trim().length > 0, lang + ' missing ' + k);
        }
    }
});

test('nothing financial or unrelated was touched', () => {
    // Withdrawal minimum and gating copy stay as they were.
    assert.ok(/MIN_WITHDRAWAL: 700/.test(INDEX), 'the $700 withdrawal minimum must be intact');
    assert.ok(INDEX.includes("withdraw.info"), 'withdrawal info copy must be intact');
    // Deposits / withdrawals / trading / wallet / bot entry points still exist.
    for (const fn of ['openDepositModal', 'requestDepositAddress', 'openWithdrawModal', 'submitWithdrawAPI',
                      'executeBotTrade', 'persistLiveTrade', 'startBot', 'stopBot', 'updateTransactionLog',
                      'updateTradingStats', 'updateMTAProgress', 'syncWalletFromServer']) {
        assert.ok(INDEX.includes('function ' + fn + '(') || INDEX.includes(fn + ' = function'), 'missing: ' + fn);
    }
    // The activity ticker banner is untouched by this change.
    assert.ok(/<div class="ticker-label"><span class="live-dot"><\/span><span data-i18n="ticker\.live">LIVE ACTIVITY<\/span><\/div>/.test(INDEX), 'ticker banner must be unchanged');
});

test('no backend, schema or config file was modified by this change', () => {
    const root = path.join(__dirname, '..');
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(!/achievements-card|profileAchievements|badgesGrid/.test(serverSrc), 'server.js must not know about the panel');
    // The badge feature is client-side only; no API or schema involvement.
    assert.ok(!/badges/i.test(serverSrc) || !/renderBadges/.test(serverSrc), 'no badge rendering on the server');
});
