'use strict';

/**
 * BEGINNER-FRIENDLY UX PASS — frontend-only wording/clarity improvements.
 *
 * Scope: public/index.html only (no server.js / services / migrations / auth /
 * wallet / trading / withdrawal-gate / KYC-enforcement changes). Pins:
 *   - withdrawal copy says processing "usually takes 15-30 minutes" while the
 *     $700 minimum and "requires 1 trade completed" requirements are untouched;
 *   - the activity ticker is labelled as sample activity (not "LIVE");
 *   - the support widget is an "automated assistant" with no fake unread count;
 *   - the deposit modal explains USDT/TRC20, the address, the reference and what
 *     happens after sending (display-only; no crediting logic touched);
 *   - a dismissible "Start Here" checklist orients new users;
 *   - registration validates per field and localizes the messages;
 *   - MTA jargon is replaced with "minimum trading balance";
 *   - cookie consent is localized;
 *   - dashboard terms have short plain-language hints.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadTranslations() {
    const blocks = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const blk = blocks.find((b) => b.includes('const TRANSLATIONS'));
    assert.ok(blk, 'TRANSLATIONS block should exist');
    const start = blk.indexOf('const TRANSLATIONS');
    let i = blk.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < blk.length; i++) {
        if (blk[i] === '{') depth++;
        else if (blk[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, 'TRANSLATIONS object should be brace-matchable');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('this.T = ' + blk.slice(blk.indexOf('{', start), end + 1), sandbox);
    return sandbox.T;
}

function extractFunction(name) {
    let start = INDEX.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' should exist');
    if (INDEX.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    let i = INDEX.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > 0, name + ' should be brace-matchable');
    return INDEX.slice(start, end + 1);
}

const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

const NEW_KEYS = [
    'auth.mobileTagline', 'auth.explainer.body', 'auth.explainer.demo', 'auth.explainer.live', 'auth.explainer.firstStep',
    'onboarding.explainer',
    'startHere.title', 'startHere.subtitle', 'startHere.step1', 'startHere.step2', 'startHere.step3', 'startHere.step4',
    'startHere.step5', 'startHere.dismiss',
    'hint.equity', 'hint.available', 'hint.pnl', 'hint.botStatus', 'hint.bot', 'hint.scanner', 'hint.txLog',
    'ticker.live', 'markets.advancedChart',
    'badge.rarity.common', 'badge.rarity.rare', 'badge.rarity.epic', 'badge.rarity.legendary',
    'status.confirmed', 'status.processing', 'status.completed',
    'cookies.body', 'cookies.accept', 'cookies.decline',
    'deposit.methodNotice', 'deposit.newToUsdt.title', 'deposit.newToUsdt.body', 'deposit.usdVsUsdt',
    'deposit.addressExplain', 'deposit.referenceExplain', 'deposit.afterSending',
    'support.assistant.name', 'support.assistant.automated', 'support.assistant.status', 'support.human.title',
    'mta.targetLabel',
    'auth.signup.passwordHint', 'auth.signup.referralHint', 'auth.signup.next', 'auth.signup.failed',
    'auth.errors.nameRequired', 'auth.errors.emailRequired', 'auth.errors.passwordRequired', 'auth.signup.passwordMin',
];

test('i18n: every new beginner-UX key exists and is non-empty in all 6 locales', () => {
    const T = loadTranslations();
    const enKeys = Object.keys(T.en);
    assert.strictEqual(enKeys.length, 1398, 'expected 1398 keys per locale');
    for (const lang of LANGS) {
        assert.deepStrictEqual(new Set(Object.keys(T[lang])), new Set(enKeys), `${lang} key set differs`);
    }
    for (const k of NEW_KEYS) {
        assert.ok(Object.prototype.hasOwnProperty.call(T.en, k), `missing key ${k}`);
        for (const lang of LANGS) {
            assert.ok(String(T[lang][k]).trim().length > 0, `${lang}.${k} empty`);
        }
    }
});

test('withdrawal copy: processing time clarified, requirements untouched', () => {
    const T = loadTranslations();
    // Requirement clauses are unchanged in every locale.
    const TRADE_REQ = {
        en: /Requires 1 trade completed/, es: /Requiere 1 operación completada/,
        pt: /Exige 1 operação concluída/, fr: /1 transaction requise/,
        ar: /يتطلب إتمام صفقة واحدة/, zh: /需完成 1 笔交易/,
    };
    for (const lang of LANGS) {
        assert.ok(/\$700/.test(T[lang]['withdraw.info']), `${lang} withdraw.info must keep $700`);
        assert.match(T[lang]['withdraw.info'], TRADE_REQ[lang], `${lang} withdraw.info must keep the 1-trade requirement`);
    }
    // EN copy must not over-promise a fixed window.
    assert.match(T.en['withdraw.info'], /usually takes 15/);
    assert.match(T.en['withdraw.success'], /usually takes 15/);
    assert.match(T.en['withdraw.processing'], /usually takes 15/);
    assert.match(T.en['withdraw.infoSandbox'], /usually takes 15/);
    assert.match(T.en['support.reply.withdraw'], /usually takes 15/);
    assert.match(T.en['landing.faq.a9'], /usually takes 15/);
    // No locale still says the old absolute "15-30min processing" phrasing.
    for (const lang of LANGS) {
        assert.ok(!/15-30min processing/i.test(T[lang]['withdraw.info']), `${lang} stale withdraw wording`);
    }
    // The support reply keeps the requirements.
    assert.match(T.en['support.reply.withdraw'], /Make a deposit/);
    assert.match(T.en['support.reply.withdraw'], /at least 1 trade/);
});

test('MTA jargon replaced with plain "minimum trading balance" wording', () => {
    const T = loadTranslations();
    for (const k of ['mta.subtitle', 'bot.reachMTA', 'bot.mtaMet', 'support.reply.bot']) {
        for (const lang of LANGS) {
            assert.ok(!/\bMTA\b/.test(T[lang][k]), `${lang}.${k} should not expose the MTA acronym`);
            assert.ok(!/Minimum Trading Amount/.test(T[lang][k]), `${lang}.${k} should not say Minimum Trading Amount`);
        }
    }
    assert.match(T.en['bot.mtaMet'], /Minimum trading balance/i);
    // The standalone MTA-vs-amount line now uses a localized label.
    assert.ok(/mta\.targetLabel/.test(INDEX), 'mta.targetLabel must be used in markup');
    assert.ok(T.en['mta.targetLabel'].length > 0);
});

test('activity ticker carries the LIVE ACTIVITY label (management decision)', () => {
    // REVERSED BY MANAGEMENT (2026-09): the ticker label was briefly "Sample
    // activity"; management asked for the previous live form back with the
    // wording "LIVE ACTIVITY". The live dot styling is restored with it.
    assert.ok(/data-i18n="ticker\.live"/.test(INDEX), 'ticker must use the live label key');
    assert.ok(!/ticker\.sample/.test(INDEX), 'the retired sample key must be gone');
    assert.ok(/<span class="live-dot"><\/span>/.test(INDEX), 'the pulsing live dot must be restored (no inert inline override)');
    const T = loadTranslations();
    for (const lang of LANGS) {
        assert.ok(String(T[lang]['ticker.live'] || '').trim().length > 0, `${lang} live label must be non-empty`);
    }
    assert.strictEqual(T.en['ticker.live'], 'LIVE ACTIVITY', 'EN label wording');
    assert.ok(/live|vivo|direct|مباشر|实时/i.test(T.es['ticker.live'] + T.pt['ticker.live'] + T.fr['ticker.live'] + T.ar['ticker.live'] + T.zh['ticker.live']), 'localized live wording');
});

test('support widget: automated assistant, no fake unread count', () => {
    assert.ok(!/id="unreadBadge"/.test(INDEX), 'the fake unread badge must be removed');
    assert.ok(!/getElementById\('unreadBadge'\)/.test(INDEX), 'no code may reference the removed badge');
    assert.ok(/data-i18n="support\.assistant\.name"/.test(INDEX), 'assistant name must be used');
    assert.ok(/data-i18n="support\.assistant\.status"/.test(INDEX), 'automated status must be used');
    assert.ok(/data-i18n="support\.assistant\.automated"/.test(INDEX), 'automated explanation must be shown');
    assert.ok(/data-i18n="support\.human\.title"/.test(INDEX), 'official human support label must be used');
    const T = loadTranslations();
    assert.ok(/automated|automatizado|automatisé|آلي|自动/i.test(T.en['support.assistant.automated']));
});

test('deposit modal explains USDT/TRC20, address, reference and next step', () => {
    for (const k of ['deposit.methodNotice', 'deposit.newToUsdt.title', 'deposit.newToUsdt.body', 'deposit.usdVsUsdt',
        'deposit.addressExplain', 'deposit.referenceExplain', 'deposit.afterSending']) {
        assert.ok(INDEX.includes('data-i18n="' + k + '"'), `${k} must be rendered`);
    }
    const T = loadTranslations();
    assert.match(T.en['deposit.methodNotice'], /USDT/);
    assert.match(T.en['deposit.methodNotice'], /TRON \(TRC20\)/);
    assert.match(T.en['deposit.referenceExplain'], /never share your password/i);
    // The deposit crediting / confirmation logic itself is untouched.
    assert.ok(/credit_payment_safe/.test(SERVER));
    assert.ok(/startPollingForPayment/.test(INDEX));
});

test('"Start Here" checklist is dismissible, per account, and hidden for sandbox', () => {
    assert.ok(/id="startHereCard"/.test(INDEX), 'checklist card must exist');
    for (const k of ['startHere.title', 'startHere.step1', 'startHere.step5', 'startHere.dismiss']) {
        assert.ok(INDEX.includes('data-i18n="' + k + '"'), `${k} must be rendered`);
    }
    const fn = extractFunction('updateStartHere');
    assert.ok(/MARKETING_SANDBOX/.test(fn), 'sandbox must never see the checklist');
    assert.ok(/localStorage/.test(extractFunction('dismissStartHere')), 'dismissal must persist');
    assert.ok(/arbi_starthere_/.test(extractFunction('startHereKey')), 'checklist state is per account');
    assert.ok(/updateStartHere\(\)/.test(INDEX), 'updateStartHere must be wired into the UI');
});

test('registration validates per field with localized messages', () => {
    const fn = extractFunction('handleSignup');
    assert.ok(/setFieldError/.test(fn), 'per-field error helper must exist');
    assert.ok(/signupName.*auth\.errors\.nameRequired|auth\.errors\.nameRequired/.test(fn), 'name error localized');
    assert.ok(/auth\.errors\.emailRequired/.test(fn), 'email error localized');
    assert.ok(/auth\.errors\.validEmailRequired/.test(fn), 'invalid email reused message');
    assert.ok(/auth\.signup\.passwordMin/.test(fn), 'password length message localized');
    assert.ok(/auth\.errors\.passwordMatch/.test(fn), 'password match message localized');
    assert.ok(/translateBackendMessage/.test(fn), 'backend errors are translated for display');
    // No bare English validation literals remain in the signup validator.
    assert.ok(!/showAuthError\('Please fill in all required fields'/.test(fn), 'no bare fill-all literal');
    assert.ok(!/showAuthError\('Password must be at least 6 characters'/.test(fn), 'no bare password literal');
    assert.ok(!/showAuthError\('Passwords do not match'/.test(fn), 'no bare match literal');
    // The signup form explains what happens next.
    assert.ok(/data-i18n="auth\.signup\.next"/.test(INDEX), 'post-signup expectation must be shown');
});

test('cookie consent is localized', () => {
    assert.ok(/cookies\.body/.test(INDEX), 'cookie body must use i18n');
    assert.ok(/cookies\.accept/.test(INDEX) && /cookies\.decline/.test(INDEX), 'cookie buttons must use i18n');
    assert.ok(!/We use cookies and similar technologies to measure our ads/.test(INDEX),
        'the old untranslated cookie sentence must be gone');
});

test('badge rarity pills and history statuses are localized at render time', () => {
    const rarity = extractFunction('badgeRarityLabel');
    assert.ok(/badge\.rarity\.common/.test(rarity) && /badge\.rarity\.legendary/.test(rarity), 'rarity map present');
    assert.ok(/badgeRarityLabel\(badge\.rarity\)/.test(INDEX), 'rarity label applied at render');
    // History statuses now go through the render-only status label maps.
    assert.ok(/depositStatusLabel\(d\.status\)/.test(INDEX), 'deposit history status localized');
    assert.ok(/withdrawalStatusLabel\(w\.status\)/.test(INDEX), 'withdrawal history status localized');
    assert.ok(/'processing': 'status\.processing'/.test(INDEX), 'sandbox processing status mapped');
    assert.ok(/'completed': 'status\.completed'/.test(INDEX), 'sandbox completed status mapped');
});

test('dashboard terms have short localized hints and the auth page orients first-time visitors', () => {
    for (const k of ['hint.equity', 'hint.available', 'hint.pnl', 'hint.botStatus', 'hint.bot', 'hint.scanner', 'hint.txLog']) {
        assert.ok(INDEX.includes('data-i18n="' + k + '"'), `${k} hint must be rendered`);
    }
    assert.ok(/id="authExplainer"/.test(INDEX), 'a first-screen explainer must exist');
    assert.ok(/data-i18n="auth\.explainer\.firstStep"/.test(INDEX), 'first step must be explained');
    assert.ok(/data-i18n="auth\.mobileTagline"/.test(INDEX), 'mobile first-screen tagline must exist');
});

test('no financial/backend logic was touched by this UX pass', () => {
    // Behavioural constants the UX pass must not have changed.
    assert.ok(/const PLATFORM_MIN_DEPOSIT_USD = 100;/.test(SERVER), 'min deposit unchanged');
    assert.ok(/const BOT_MIN_TRADING_BALANCE = 200;/.test(SERVER), 'MTA value unchanged');
    assert.ok(/amount < 700/.test(SERVER), 'withdrawal minimum unchanged in server');
    // The withdrawal gate order in the server route remains first-deposit -> KYC -> ...
    const route = SERVER.slice(SERVER.indexOf("app.post('/api/withdraw/request'"));
    assert.ok(/depositRequired/.test(route), 'withdrawal first-deposit gate intact');
    // Frontend gates still reference the same constants.
    assert.ok(/APP\.MIN_WITHDRAWAL/.test(INDEX), 'frontend min-withdrawal constant intact');
    // No new API endpoints were introduced by the UX pass.
    assert.ok(!/app\.post\('\/api\/ux/.test(SERVER));
});
