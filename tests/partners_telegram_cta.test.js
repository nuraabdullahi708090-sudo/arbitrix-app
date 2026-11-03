/**
 * Referral partner landing page (/partners) - Telegram-community primary CTA.
 *
 * The primary CTA on the partner recruitment page now sends a prospective partner
 * to the Arbitrix Telegram community (the education/onboarding entry point).
 * Registration, referral-link tracking and commission payment stay on Arbitrix.
 *
 * What this suite pins:
 *   1. the exact group invite on every primary CTA, in all three placements
 *   2. the approved wording (button label + supporting line) and its translations
 *   3. external-link security attributes + a recognisable Telegram icon
 *   4. responsive behaviour (no CTA is hidden or clipped on a phone)
 *   5. the referral registration deep links still work for anyone who needs them
 *   6. attribution: the existing funnel markers are still armed by a CTA click
 *   7. partner-dashboard access (Sign In) is untouched
 *   8. no referral / financial business logic changed
 *   9. the published business rules are the real ones (one-time 20%, $100 minimum)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE = read('public/partners.html');
const INDEX = read('public/index.html');
const SERVER = read('server.js');

const COMMUNITY_URL = 'https://t.me/+CF9kWr61sqs1MTY0';
const CTA_LABEL = 'Join Our Telegram Community';
const CTA_NOTE = 'Learn how Arbitrix referrals work, get step-by-step guidance and '
    + 'discover how to earn commissions by referring new users.';
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

/** Every anchor that leaves the site. */
function externalAnchors(html) {
    const out = [];
    const re = /<a\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const attrs = m[1];
        const href = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs);
        if (href && /^https?:/i.test(href[1])) out.push({ href: href[1], attrs: attrs });
    }
    return out;
}

/** The page's inline translation dictionary, evaluated with the page's own order. */
function loadTranslations() {
    const tIdx = PAGE.indexOf('const TRANSLATIONS');
    assert.ok(tIdx >= 0, 'the page must define const TRANSLATIONS');
    let i = PAGE.indexOf('{', tIdx);
    let depth = 0;
    let end = -1;
    for (; i < PAGE.length; i++) {
        if (PAGE[i] === '{') depth++;
        else if (PAGE[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    assert.ok(end > tIdx, 'the TRANSLATIONS object must be a plain object literal');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(PAGE.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();

/* ==================================================================== *
 * 1. The exact destination
 * ==================================================================== */
test('1. every primary CTA points at the exact Telegram group invite', () => {
    const ctas = PAGE.match(/<a class="btn btn-primary js-apply-cta js-community-cta"[^>]*>/g) || [];
    assert.strictEqual(ctas.length, 3,
        'the primary CTA must exist in the topbar, the hero and the final CTA block');
    ctas.forEach((a) => {
        assert.ok(a.indexOf('href="' + COMMUNITY_URL + '"') !== -1,
            'the href must be exactly ' + COMMUNITY_URL + ' (got: ' + a + ')');
    });
    assert.strictEqual((PAGE.match(/t\.me\/\+CF9kWr61sqs1MTY0/g) || []).length, 3,
        'the invite must appear exactly three times, once per CTA');
    assert.ok(!/t\.me\/\+CF9kWr61sqs1MTY0\?/.test(PAGE),
        'no query string may be appended to the invite (Telegram would reject it)');
});

test('2. registration is offered only as a small secondary link', () => {
    const blocks = PAGE.match(/<p class="cta-register"><a[^>]*>[^<]*<\/a><\/p>/g) || [];
    assert.strictEqual(blocks.length, 2,
        'exactly two secondary registration links: under the hero CTA and the final CTA');
    blocks.forEach((b) => {
        assert.ok(b.indexOf('href="/?action=create-account&amp;src=partners"') !== -1,
            'must use the existing registration deep link: ' + b);
        assert.match(b, /class="cta-register-link js-apply-cta"/,
            'must be a text link that also arms the funnel attribution');
        assert.ok(!/btn/.test(b), 'must not be a button: ' + b);
        assert.match(b, /data-i18n="partners\.cta\.registerNote"/, 'must be localized');
    });
    // No primary/CTA button may point at registration.
    const primary = PAGE.match(/<a class="btn btn-primary[^"]*"[^>]*>/g) || [];
    assert.strictEqual(primary.length, 3);
    primary.forEach((a) => assert.ok(a.indexOf('action=create-account') === -1,
        'a primary button must never go straight to registration: ' + a));
    // The secondary also carries the storage-independent funnel signal.
    assert.strictEqual((PAGE.match(/action=create-account&amp;src=partners/g) || []).length, 2);
});

/* ==================================================================== *
 * 2. Wording
 * ==================================================================== */
test('3. the button label and supporting line are the approved copy', () => {
    assert.strictEqual(
        PAGE.split('<span data-i18n="partners.cta.joinCommunity">' + CTA_LABEL + '</span>').length - 1,
        3, 'all three CTAs carry the approved English label as their static default');
    const notes = PAGE.split('<p class="cta-note" data-i18n="partners.cta.communityNote">' + CTA_NOTE + '</p>').length - 1;
    assert.strictEqual(notes, 2, 'the supporting line appears under the hero CTA and the final CTA');
    assert.strictEqual(T.en['partners.cta.joinCommunity'], CTA_LABEL);
    assert.strictEqual(T.en['partners.cta.communityNote'], CTA_NOTE);
});

test('4. the label and the supporting line are translated in all six locales', () => {
    assert.deepStrictEqual(Object.keys(T).sort(), LANGS.slice().sort(), 'the six locales must exist');
    LANGS.forEach((lang) => {
        const label = T[lang]['partners.cta.joinCommunity'];
        const note = T[lang]['partners.cta.communityNote'];
        assert.ok(typeof label === 'string' && label.trim(), lang + ' needs a joinCommunity label');
        assert.ok(typeof note === 'string' && note.trim(), lang + ' needs a communityNote line');
        const register = T[lang]['partners.cta.registerNote'];
        assert.ok(typeof register === 'string' && register.trim(),
            lang + ' needs a registerNote label for the secondary link');
        if (lang !== 'en') {
            assert.notStrictEqual(register, T.en['partners.cta.registerNote'],
                lang + ' secondary label must be translated');
        }
        assert.ok(/telegram|تيليجرام/i.test(label),
            lang + ' must name Telegram in the button label');
        if (lang !== 'en') {
            assert.notStrictEqual(label, T.en['partners.cta.joinCommunity'], lang + ' must not fall back to English');
            assert.notStrictEqual(note, T.en['partners.cta.communityNote'], lang + ' note must be translated');
        }
    });
    assert.ok(/[\u0600-\u06FF]/.test(T.ar['partners.cta.joinCommunity']), 'Arabic must be in Arabic script');
    assert.ok(/[\u4e00-\u9FFF]/.test(T.zh['partners.cta.joinCommunity']), 'Chinese must be in Chinese script');
    assert.ok(/telegram/i.test(T.es['partners.cta.joinCommunity']), 'Spanish keeps the product name');
});

/* ==================================================================== *
 * 3. Link safety + icon
 * ==================================================================== */
test('5. the Telegram CTA opens in a new tab with safe rel attributes', () => {
    const ext = externalAnchors(PAGE);
    assert.strictEqual(ext.length, 3, 'exactly three external anchors may exist (the three CTAs)');
    ext.forEach((a) => {
        assert.strictEqual(a.href, COMMUNITY_URL);
        assert.match(a.attrs, /target="_blank"/, 'external links must open in a new tab');
        assert.match(a.attrs, /rel="noopener noreferrer"/, 'external links need noopener noreferrer');
    });
});

test('6. the CTA carries a recognisable Telegram icon', () => {
    assert.strictEqual((PAGE.match(/<i class="fab fa-telegram" aria-hidden="true"><\/i>/g) || []).length, 3,
        'each CTA must show the Telegram brand icon');
    assert.match(PAGE, /cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome[^"]*css\/all\.min\.css/,
        'the Font Awesome stylesheet that renders the icon must still be loaded');
    assert.match(PAGE, /\.btn \{[^}]*display:\s*inline-flex/, 'the icon sits inside the flex button');
});

/* ==================================================================== *
 * 4. Responsive
 * ==================================================================== */
test('7. the CTA stays prominent on mobile and desktop', () => {
    // Base button contract: never clipped, always a >= 44px tap target.
    assert.match(PAGE, /\.btn \{[^}]*min-height:\s*46px/, 'buttons keep a 46px minimum height');
    assert.match(PAGE, /\.btn \{[^}]*white-space:\s*normal/, 'long localized labels must wrap, not clip');
    assert.match(PAGE, /\.btn \{[^}]*overflow-wrap:\s*anywhere/, 'long words must break rather than overflow');
    assert.match(PAGE, /\.btn \{[^}]*max-width:\s*100%/, 'buttons may never exceed the viewport');
    // The hero/final CTA rows stay centred and wrap.
    assert.match(PAGE, /\.hero-actions,\s*\.bottom-cta \{[^}]*flex-wrap:\s*wrap/, 'CTA rows must wrap');
    // Small screens: the topbar buttons share the row, and the supporting line scales down.
    assert.match(PAGE, /@media \(max-width:\s*640px\)[\s\S]{0,400}?\.top-actions \.btn \{[^}]*flex:/,
        'the topbar CTAs must stay laid out on a phone');
    assert.match(PAGE, /\.cta-note \{[^}]*font-size:\s*13px/, 'the supporting line must be readable');
    assert.match(PAGE, /\.cta-note \{[^}]*overflow-wrap:\s*anywhere/, 'the supporting line must wrap safely');
    assert.match(PAGE, /@media \(max-width:\s*640px\)[\s\S]{0,600}?\.cta-note \{[^}]*font-size:\s*12\.5px/,
        'the supporting line must scale down on phones');
    // The secondary registration link wraps instead of overflowing and keeps a
    // comfortable tap target while staying visually subordinate.
    assert.match(PAGE, /\.cta-register-link \{[^}]*min-height:\s*44px/, 'secondary link tap target >= 44px');
    assert.match(PAGE, /\.cta-register-link \{[^}]*font-size:\s*13px/, 'secondary link is smaller than the button');
    assert.match(PAGE, /\.cta-register-link \{[^}]*text-decoration:\s*underline/, 'secondary reads as a link');
    assert.match(PAGE, /\.cta-register-link \{[^}]*overflow-wrap:\s*anywhere/, 'secondary text wraps safely');
    assert.match(PAGE, /\.cta-register-link:focus-visible \{[^}]*outline:/, 'secondary link has a focus ring');
    assert.match(PAGE, /@media \(max-width:\s*640px\)[\s\S]{0,900}?\.cta-register-link \{[^}]*font-size:\s*12\.5px/,
        'secondary link scales down on phones');
    // Nothing may hide the primary CTA on any breakpoint.
    assert.ok(!/js-community-cta[^{]*\{[^}]*display:\s*none/.test(PAGE),
        'the community CTA must never be hidden by CSS');
    assert.ok(!/\.top-actions[^{]*\{[^}]*display:\s*none/.test(PAGE),
        'the topbar action row must never be hidden');
});

/* ==================================================================== *
 * 5. Registration + sign-in still work
 * ==================================================================== */
test('8. the registration and sign-in deep links still work in the app shell', () => {
    assert.match(INDEX, /action=create-account/, 'the app shell must still open the signup tab');
    assert.match(INDEX, /action=sign-in/, 'the app shell must still open the login tab');
    assert.match(INDEX, /function applyAuthEntryIntent\(\)/, 'the shared entry-intent handler must remain');
    assert.match(INDEX, /function populateReferralFromURL\(\)/,
        'a referral code in the URL must still be captured on entry');
    // The page still offers the dashboard route for existing partners.
    assert.match(PAGE, /<a class="btn btn-secondary" href="\/\?action=sign-in"[^>]*data-i18n="partners\.signIn"/,
        'Sign In must remain on the page');
    // The secondary registration link targets that same app-shell intent.
    assert.match(PAGE, /href="\/\?action=create-account&amp;src=partners"/,
        'the secondary link must use the supported registration deep link, not an invented /signup route');
});

test('9. partner-dashboard access is untouched', () => {
    assert.match(SERVER, /app\.get\('\/api\/referral\/partner'/, 'the partner dashboard endpoint must still exist');
    assert.match(SERVER, /app\.post\('\/api\/referral\/payouts\/request'/, 'payout requests must still be reachable');
    assert.match(SERVER, /app\.get\('\/api\/referral\/stats'/, 'referral stats must still be served');
    // The landing page cannot interfere with the dashboard: it makes no API calls.
    assert.ok(!/\/api\//.test(PAGE), 'the landing page must not call any API');
    assert.ok(!/\bfetch\s*\(/.test(PAGE), 'the landing page must not call fetch');
    assert.ok(!/<form\b/i.test(PAGE), 'the landing page must not collect credentials');
});

/* ==================================================================== *
 * 6. Attribution / tracking preserved
 * ==================================================================== */
test('10. the query-string attribution capture is unchanged', () => {
    assert.ok(PAGE.includes("sessionStorage.setItem('arbi_auth_entry', window.location.search || '/partners')"),
        'UTM / referral query parameters must still be remembered for the auth entry');
});

test('11. the funnel markers are still armed by a CTA click', () => {
    assert.match(PAGE, /function markPartnerEntry\(\)/);
    assert.match(PAGE, /sessionStorage\.setItem\('arbi_partner_entry',\s*'1'\)/);
    assert.match(PAGE, /localStorage\.setItem\('arbi_partner_entry',\s*String\(Date\.now\(\)\)\)/);
    assert.match(PAGE, /querySelectorAll\('\.js-apply-cta'\)/,
        'the community CTAs must keep the selector the attribution handler binds to');
    assert.match(PAGE, /addEventListener\('click', markPartnerEntry\)/);
    assert.strictEqual((PAGE.match(/setItem\('arbi_partner_entry'/g) || []).length, 2,
        'exactly the two existing marker writes (session + timestamped localStorage)');
    // The selector now covers the three community CTAs AND the two secondary
    // registration links, so BOTH routes into the funnel are attributed.
    assert.strictEqual((PAGE.match(/class="[^"]*js-apply-cta[^"]*"/g) || []).length, 5,
        '3 community CTAs + 2 secondary registration links');
    // The app shell still reads those markers with the same 1-hour window.
    assert.match(INDEX, /PARTNER_ENTRY_TTL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
    assert.match(INDEX, /function isPartnerFunnelEntry\(\)/);
    assert.match(INDEX, /src=partners/, 'the URL signal stays supported for other partner entry paths');
});

test('12. clicking the community CTA arms both markers, and loading the page arms none', () => {
    const from = PAGE.indexOf('function markPartnerEntry()');
    assert.ok(from !== -1);
    const src = PAGE.slice(from, PAGE.indexOf('applyTranslations();', from));

    const makeStorage = () => {
        const data = {};
        return {
            getItem: (k) => (k in data ? data[k] : null),
            setItem: (k, v) => { data[k] = String(v); },
            removeItem: (k) => { delete data[k]; },
            dump: () => Object.assign({}, data),
        };
    };
    const sessionStorage = makeStorage();
    const localStorage = makeStorage();
    const bound = [];
    const sandbox = {
        console: { log: () => {}, error: () => {} },
        sessionStorage,
        localStorage,
        document: {
            querySelectorAll: (sel) => (sel === '.js-apply-cta'
                ? [0, 1, 2, 3, 4].map(() => ({
                    addEventListener: (t, fn) => { if (t === 'click') bound.push(fn); }
                }))
                : []),
        },
        window: { location: { search: '?utm_source=facebook&utm_campaign=partners&fbclid=abc' } },
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);

    assert.strictEqual(bound.length, 5, '3 community CTAs + 2 registration links must be armed');
    assert.deepStrictEqual(sessionStorage.dump(), {}, 'loading the page must arm nothing');
    assert.deepStrictEqual(localStorage.dump(), {}, 'loading the page must arm nothing');

    bound[0]();   // the click that opens Telegram
    assert.strictEqual(sessionStorage.dump().arbi_partner_entry, '1', 'the click arms the session marker');
    const ts = Number(localStorage.dump().arbi_partner_entry);
    assert.ok(Number.isFinite(ts) && Math.abs(Date.now() - ts) < 60000,
        'the click arms the timestamped cross-tab marker');

    // The secondary registration link must arm the SAME markers (direct path).
    sessionStorage.removeItem('arbi_partner_entry');
    localStorage.removeItem('arbi_partner_entry');
    bound[3]();
    assert.strictEqual(sessionStorage.dump().arbi_partner_entry, '1',
        'the registration link arms the session marker too');
    assert.ok(Number.isFinite(Number(localStorage.dump().arbi_partner_entry)),
        'the registration link arms the timestamped marker too');
});

/* ==================================================================== *
 * 7. Business rules untouched
 * ==================================================================== */
test('13. the referral business logic is unchanged', () => {
    assert.match(SERVER, /const REFERRAL_REWARD_PERCENT_DEFAULT = 20;/,
        'the reward stays 20% of the initial qualifying deposit');
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/,
        'the qualifying deposit minimum stays $100');
    assert.ok(!/REFERRAL_PROFIT_COMMISSION_RATE|credit_referral_commission/.test(SERVER),
        'there must be no recurring downline commission');
    assert.ok(!/REFERRAL_REWARD_DEFAULT_USD/.test(SERVER),
        'there must be no flat referral reward');
    // No financial logic lives on the landing page at all.
    assert.ok(!/record_trade|wallet|live_balance|bonus_balance/i.test(PAGE),
        'the landing page must not touch any financial state');
});

test('14. the published rules match the real ones (no invented rewards)', () => {
    const copy = PAGE.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ');
    assert.match(copy, /20% of the referred user's first qualifying deposit of \$100 or more/,
        'the reward statement stays exact');
    // The reward is one-time BY CONSTRUCTION: only the FIRST qualifying deposit earns.
    assert.match(copy, /first qualifying deposit/i, 'the reward must be tied to the first deposit');
    assert.ok(!/every qualifying deposit|each qualifying deposit|on all deposits/i.test(copy),
        'no wording may imply a reward on later deposits');
    assert.match(copy, /not guaranteed earnings/i, 'the disclaimer must stay');
    assert.ok(!/guaranteed (income|profit|return)/i.test(copy), 'no guaranteed-income claims');
    assert.ok(!/(lifetime|recurring|passive)\s+(commission|income|earnings)/i.test(copy),
        'no recurring-commission claims');
    assert.ok(!/\$20\s+(per|for every|for each)\s+referral/i.test(copy), 'no flat per-referral reward');
});

/* ==================================================================== *
 * 8. Page hygiene
 * ==================================================================== */
test('15. the page keeps its identity, locale switch and video', () => {
    assert.match(PAGE, /<html lang="en"/);
    assert.match(PAGE, /arbi_lang/, 'the shared language key must still be used');
    assert.match(PAGE, /id="demoVideo"/, 'the payout walkthrough video must remain');
    assert.match(PAGE, /href="\/how-it-works"/, 'the secondary "See How It Works" CTA stays');
    assert.match(PAGE, /href="#demo"/, 'the hero demo anchor stays');
    assert.match(PAGE, /arbitrix-partner-support-telegram/, 'partner support handles stay meta-driven');
});

test('16. all six locales keep identical, complete key sets', () => {
    const sizes = LANGS.map((l) => Object.keys(T[l]).length);
    assert.strictEqual(new Set(sizes).size, 1, 'identical key counts: ' + sizes.join('/'));
    const keyStr = (l) => Object.keys(T[l]).sort().join('|');
    assert.strictEqual(new Set(LANGS.map(keyStr)).size, 1, 'identical key sets');
    LANGS.forEach((l) => {
        Object.keys(T[l]).forEach((k) => {
            assert.ok(k.startsWith('partners.'), l + ' has a non-partners key: ' + k);
            assert.ok(typeof T[l][k] === 'string' && T[l][k].trim(), l + '/' + k + ' must be non-empty');
        });
    });
    assert.strictEqual(T.en['partners.cta.registerNote'], 'Already ready to join? Create an account',
        'the secondary label must match the approved English copy');
    assert.strictEqual(T.en['partners.cta.apply'], undefined,
        'the retired apply CTA label must not linger in any locale');
    LANGS.forEach((l) => assert.strictEqual(T[l]['partners.cta.apply'], undefined,
        l + ' must not carry the retired apply label'));
});

test('17. no partner referral code is hardcoded on the page', () => {
    // Attribution is passive: the page never bakes in one partner's code, because
    // that would attribute every visitor to that partner.
    assert.ok(!/ARBI-[A-Z0-9]{4,8}/.test(PAGE), 'no referral-code literal may appear on the page');
    assert.ok(!/[?&]ref=/.test(PAGE), 'the registration link must not carry a ref parameter');
    assert.ok(!/[?&]referral=/.test(PAGE), 'no referral parameter either');
    // The app shell still honours real referral links (?ref=, ?referral=, /ref/<code>).
    assert.match(INDEX, /urlParams\.get\('ref'\)/, '?ref= capture must remain');
    assert.match(INDEX, /urlParams\.get\('referral'\)/, '?referral= capture must remain');
    assert.match(INDEX, /pathname\.match\(\/\\\/ref\\\//, '/ref/<code> capture must remain');
});
