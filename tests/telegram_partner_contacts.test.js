'use strict';

/**
 * Telegram marketing fixtures: the payment-partner contacts are Alex and
 * Olivia, and Official Arbitrix Support stays a separate contact.
 *
 * The obsolete @Arbitrix_CSA1 handle must not be rendered by any marketing
 * template, button, link block or stored-post round trip.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    render, LABELS, LOCALES, KINDS, WEEKLY_THEMES, groupButtons
} = require('../services/MarketingContent');
const { buildStartHereRow } = require('../services/MarketingOnboarding');
const { resolveMarketingConfig, OFFICIAL_LINKS } = require('../services/TelegramBroadcast');

const ALEX = 'https://t.me/AlexArbitrix';
const OLIVIA = 'https://t.me/OliviaArbitrix';
const OFFICIAL = 'https://t.me/ArbitrixSupportBot';
const FACTS = { minDeposit: 100, referralPercent: 20 };

/** The production defaults: only BASE_URL supplied, every handle left empty. */
const CONFIG = Object.assign(resolveMarketingConfig({ BASE_URL: 'https://arbitrix.pro' }), {
    facts: FACTS, groupChatId: '-1001234567890', enabled: true, dryRun: false
});
const CTX = Object.assign({}, CONFIG, FACTS);

function allRenders() {
    const out = [];
    for (const locale of LOCALES) {
        for (const kind of KINDS) out.push({ locale, kind, out: render(kind, locale, CTX) });
        for (const theme of WEEKLY_THEMES) out.push({ locale, kind: 'weekly', out: render('weekly', locale, Object.assign({}, CTX, { theme })) });
    }
    return out;
}

test('the default partner contacts are Alex and Olivia, never the retired handle', () => {
    assert.strictEqual(OFFICIAL_LINKS.partnerSupportAlexUrl, ALEX);
    assert.strictEqual(OFFICIAL_LINKS.partnerSupportOliviaUrl, OLIVIA);
    assert.strictEqual(OFFICIAL_LINKS.supportUrl, OFFICIAL, 'official support is not a partner');
    const cfg = resolveMarketingConfig({});
    assert.strictEqual(cfg.partnerSupportAlexUrl, ALEX);
    assert.strictEqual(cfg.partnerSupportOliviaUrl, OLIVIA);
    assert.strictEqual(cfg.supportUrl, OFFICIAL);
    assert.strictEqual(cfg.partnerSupportUrl, ALEX, 'the single-value alias points at the first partner');
});

test('a configured handle still wins, per slot and independently', () => {
    const cfg = resolveMarketingConfig({
        TELEGRAM_PARTNER_SUPPORT_USERNAME: '@AlexBackup',
        TELEGRAM_PARTNER_SUPPORT_USERNAME_2: '@OliviaBackup'
    });
    assert.strictEqual(cfg.partnerSupportAlexUrl, 'https://t.me/AlexBackup');
    assert.strictEqual(cfg.partnerSupportOliviaUrl, 'https://t.me/OliviaBackup');
    // Overriding a partner never moves official support.
    assert.strictEqual(cfg.supportUrl, OFFICIAL);
});

test('both partners appear as buttons in the welcome and Start Here', () => {
    for (const locale of LOCALES) {
        for (const kind of ['welcome', 'startHere']) {
            const rows = render(kind, locale, CTX).replyMarkup.inline_keyboard;
            const urls = rows.flat().map((b) => b.url);
            assert.ok(urls.includes(ALEX), locale + ' ' + kind + ' links Alex');
            assert.ok(urls.includes(OLIVIA), locale + ' ' + kind + ' links Olivia');
            assert.ok(urls.includes(OFFICIAL), locale + ' ' + kind + ' keeps official support');
            assert.strictEqual(urls.filter((u) => u === OFFICIAL).length, 1, 'official support once');
        }
    }
});

test('the announcement/channel copy links both partners and official support', () => {
    const channel = render('channelIntro', 'en', CTX);
    const urls = channel.buttons.map((b) => b.url);
    assert.ok(urls.includes(ALEX) && urls.includes(OLIVIA), 'both partners offered');
    assert.ok(urls.includes(OFFICIAL), 'official support kept');
    assert.ok(channel.text.includes(ALEX) && channel.text.includes(OLIVIA), 'both partner lines in the copy');
});

test('no template renders the retired @Arbitrix_CSA1 handle in any locale or kind', () => {
    for (const { locale, kind, out } of allRenders()) {
        const text = out.text || '';
        const urls = out.buttons.map((b) => b.url).join(' ');
        assert.ok(!/Arbitrix_CSA1/.test(text + ' ' + urls), `${locale}/${kind} must not mention @Arbitrix_CSA1`);
    }
});

test('the partner line lists both contacts, official support separately', () => {
    const out = render('startHere', 'en', CTX);
    assert.match(out.text, new RegExp('Alex: ' + ALEX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(out.text, new RegExp('Olivia: ' + OLIVIA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(out.text.indexOf(OFFICIAL) < out.text.indexOf(ALEX), 'official support is listed first, as its own line');
});

test('an unconfigured partner is omitted instead of inventing a contact', () => {
    const onlyAlex = Object.assign({}, CTX, { partnerSupportOliviaUrl: '' });
    const rows = render('welcome', 'en', onlyAlex).replyMarkup.inline_keyboard;
    const urls = rows.flat().map((b) => b.url);
    assert.ok(urls.includes(ALEX) && !urls.includes(OLIVIA));
    assert.ok(urls.includes(OFFICIAL), 'official support is unaffected');

    const none = Object.assign({}, CTX, { partnerSupportAlexUrl: '', partnerSupportUrl: '', partnerSupportOliviaUrl: '' });
    const empty = render('welcome', 'en', none);
    assert.ok(!empty.text.includes(ALEX) && !empty.text.includes(OLIVIA), 'no partner line');
    assert.ok(empty.buttons.some((b) => b.url === OFFICIAL), 'official support still offered');
});

test('the Start Here stored buttons keep both partners through the queue round trip', () => {
    const built = buildStartHereRow({ config: CONFIG, scheduledFor: '2026-10-29T09:00:00Z' });
    const stored = JSON.parse(JSON.stringify(built.content.buttons));
    const urls = groupButtons(stored).flat().map((b) => b.url);
    assert.deepStrictEqual(urls, [
        'https://arbitrix.pro/?action=create-account',
        'https://arbitrix.pro/how-it-works',
        OFFICIAL, ALEX, OLIVIA
    ]);
});

test('the labels are localized, labelled per partner and never reuse English', () => {
    for (const locale of LOCALES) {
        const b = LABELS[locale].buttons;
        for (const key of ['partnerAlex', 'partnerOlivia', 'support']) {
            assert.ok(String(b[key] || '').trim(), locale + ' missing buttons.' + key);
            assert.match(b[key], /^\p{Extended_Pictographic}\s/u, locale + ' ' + key + ' needs an icon');
            assert.ok(b[key].length <= 64, locale + ' ' + key + ' must fit Telegram limits');
        }
        assert.match(b.partnerAlex, /Alex/);
        assert.match(b.partnerOlivia, /Olivia/);
        assert.ok(!/Arbitrix_CSA1/.test(JSON.stringify(LABELS[locale])));
        if (locale !== 'en') {
            assert.notStrictEqual(b.partnerAlex, LABELS.en.buttons.partnerAlex, locale + ' Alex label untranslated');
            assert.notStrictEqual(b.partnerOlivia, LABELS.en.buttons.partnerOlivia, locale + ' Olivia label untranslated');
        }
    }
    // Names are proper nouns: they survive the translation.
    assert.match(LABELS.ar.buttons.partnerAlex, /Alex/);
    assert.match(LABELS.pt.buttons.partnerOlivia, /Olivia/);
});

test('no marketing service source still carries the retired handle', () => {
    const root = path.join(__dirname, '..', 'services');
    for (const file of ['MarketingContent.js', 'MarketingOnboarding.js', 'TelegramBroadcast.js', 'MarketingWorker.js', 'MarketingStore.js']) {
        const src = fs.readFileSync(path.join(root, file), 'utf8');
        assert.ok(!/Arbitrix_CSA1/.test(src), file + ' must not reference @Arbitrix_CSA1');
    }
});

test('nothing here can publish: the publisher stays inert by default', () => {
    const cfg = resolveMarketingConfig({});
    assert.strictEqual(cfg.enabled, false, 'TELEGRAM_MARKETING_ENABLED is off by default');
    assert.strictEqual(cfg.dryRun, true, 'dry run stays on by default');
    assert.strictEqual(cfg.groupChatId, '', 'no destination is configured by default');
});
