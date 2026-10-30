'use strict';

/**
 * Telegram marketing fixtures and the partner-contact POLICY:
 *   - referral / partner-recruitment enquiries: ALEX ONLY (business decision);
 *   - payment assistance: both payment partners (Alex and Olivia);
 *   - Official Arbitrix Support stays a separate contact, never a partner.
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
const { checkContent } = require('../services/ContentGuard');
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
const CHANNEL = 'https://t.me/ArbitrixAnnouncements';
const CTX = Object.assign({}, CONFIG, FACTS, { announcementUrl: CHANNEL });

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

test('the recruitment keyboard offers official support and Alex only', () => {
    for (const locale of LOCALES) {
        for (const kind of ['welcome', 'startHere']) {
            const rows = render(kind, locale, CTX).replyMarkup.inline_keyboard;
            const urls = rows.flat().map((b) => b.url);
            assert.ok(urls.includes(ALEX), locale + ' ' + kind + ' links Alex');
            assert.ok(!urls.includes(OLIVIA), locale + ' ' + kind + ' must not offer a payment partner');
            assert.ok(urls.includes(OFFICIAL), locale + ' ' + kind + ' keeps official support');
            assert.strictEqual(urls.filter((u) => u === OFFICIAL).length, 1, 'official support once');
            assert.deepStrictEqual(rows.map((row) => row.length), [2, 2], locale + ' ' + kind + ' stays 2x2');
        }
    }
});

test('the channel copy keeps official support, offers Alex, and lists both partners for payments', () => {
    const channel = render('channelIntro', 'en', CTX);
    const urls = channel.buttons.map((b) => b.url);
    assert.ok(urls.includes(ALEX), 'Alex is the recruitment contact');
    assert.ok(!urls.includes(OLIVIA), 'a payment partner is not a recruitment button');
    assert.ok(urls.includes(OFFICIAL), 'official support kept');
    // Payment help is a payment-specific block: BOTH partners appear there.
    assert.match(channel.text, /Payment help:/);
    assert.ok(channel.text.includes(ALEX) && channel.text.includes(OLIVIA), 'both payment partners listed');
    assert.ok(channel.text.indexOf(OFFICIAL) < channel.text.indexOf(ALEX), 'official support listed first');
});

test('no template renders the retired @Arbitrix_CSA1 handle in any locale or kind', () => {
    for (const { locale, kind, out } of allRenders()) {
        const text = out.text || '';
        const urls = out.buttons.map((b) => b.url).join(' ');
        assert.ok(!/Arbitrix_CSA1/.test(text + ' ' + urls), `${locale}/${kind} must not mention @Arbitrix_CSA1`);
    }
});

test('the partner line lists Alex alone, official support separately', () => {
    const out = render('startHere', 'en', CTX);
    assert.match(out.text, new RegExp('Partner support:'));
    assert.match(out.text, new RegExp('Alex: ' + ALEX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(!out.text.includes(OLIVIA), 'Olivia must not appear in a recruitment message');
    assert.ok(out.text.indexOf(OFFICIAL) < out.text.indexOf(ALEX), 'official support is listed first, as its own line');
});

test('Olivia appears only in payment-support copy, never as a recruitment contact', () => {
    for (const locale of LOCALES) {
        // Recruitment flows list Alex alone.
        for (const kind of ['startHere', 'weekly']) {
            const out = render(kind, locale, Object.assign({}, CTX, { theme: 'mon' }));
            const blob = out.text + ' ' + JSON.stringify(out.buttons);
            assert.ok(!blob.includes(OLIVIA), `${locale}/${kind} is a recruitment message and must list Alex only`);
        }
        // The group welcome names her, but only inside the payment-support block,
        // and the role split is stated explicitly.
        const welcome = render('welcome', locale, CTX);
        assert.ok(welcome.text.includes(OLIVIA), locale + '/welcome lists the payment partner');
        assert.ok(welcome.text.includes(LABELS[locale].welcomePaymentTitle));
        assert.ok(welcome.text.includes(LABELS[locale].welcomeOliviaRole), locale + ' Olivia is labelled payment support');
        assert.ok(welcome.text.includes(LABELS[locale].welcomeContactNote), locale + ' the role split is stated');
        assert.strictEqual(welcome.text.split(OLIVIA).length - 1, 1, locale + ' Olivia appears exactly once');
        // ...and the payment block in the channel intro keeps both.
        const channel = render('channelIntro', locale, CTX);
        assert.ok(channel.text.includes(ALEX) && channel.text.includes(OLIVIA),
            locale + '/channelIntro payment help lists both payment partners');
        assert.ok(!JSON.stringify(channel.buttons).includes(OLIVIA),
            locale + '/channelIntro does not turn a payment partner into a recruitment button');
    }
});

test('the welcome points members to the official announcement channel', () => {
    for (const locale of LOCALES) {
        const out = render('welcome', locale, CTX);
        assert.ok(out.text.includes(CHANNEL), locale + ' welcome links the channel');
        assert.ok(out.text.includes(LABELS[locale].welcomeAnnounceTitle), locale + ' channel heading');
        assert.ok(out.text.includes(LABELS[locale].welcomeAnnounceBody), locale + ' channel explanation');
        // The explanation must say it is where announcements/updates are published.
        assert.ok(LABELS[locale].welcomeAnnounceBody.length > 20, locale + ' explanation is a real sentence');
    }
    // Unconfigured: the whole section is omitted, heading included (no dangling label).
    const bare = render('welcome', 'en', Object.assign({}, CTX, { announcementUrl: '' }));
    assert.ok(!bare.text.includes('OFFICIAL ANNOUNCEMENTS'), 'no heading without a channel link');
    assert.ok(!bare.text.includes(CHANNEL), 'no channel link when unset');
    assert.ok(!/OFFICIAL ANNOUNCEMENTS\s*$/.test(bare.text.trimEnd()), 'no dangling heading');
});

test('the pinned Start Here guide points at the channel without repeating the partners', () => {
    for (const locale of LOCALES) {
        const out = render('startHere', locale, CTX);
        assert.ok(out.text.includes(CHANNEL), locale + ' Start Here links the channel');
        assert.ok(out.text.includes(LABELS[locale].welcomeAnnounceTitle), locale + ' channel heading');
        assert.ok(!out.text.includes(OLIVIA), locale + ' Start Here stays recruitment-only (Alex)');
        assert.ok(out.text.includes(ALEX), locale + ' Alex stays the recruitment contact');
        assert.ok(!/\n{3,}/.test(out.text), locale + ' no triple blank lines');
    }
    const bare = render('startHere', 'en', Object.assign({}, CTX, { announcementUrl: '' }));
    assert.ok(!bare.text.includes('OFFICIAL ANNOUNCEMENTS'), 'no dangling channel heading when unset');
});

test('the welcome names both payment partners and keeps referral with Alex alone', () => {
    for (const locale of LOCALES) {
        const text = render('welcome', locale, CTX).text;
        const alexLine = text.split('\n').find((l) => l.includes(ALEX) && l.includes('Alex'));
        const oliviaLine = text.split('\n').find((l) => l.includes(OLIVIA) && l.includes('Olivia'));
        assert.ok(alexLine, locale + ' welcome has an Alex bullet');
        assert.ok(oliviaLine, locale + ' welcome has an Olivia bullet');
        // Alex carries BOTH roles; Olivia is labelled payments only.
        assert.ok(alexLine.includes(LABELS[locale].welcomeAlexRole), locale + ' Alex carries referral + payments');
        assert.ok(oliviaLine.includes(LABELS[locale].welcomeOliviaRole), locale + ' Olivia is payment support');
        assert.ok(!oliviaLine.includes(LABELS[locale].welcomeAlexRole), locale + ' Olivia is not given the referral role');
        // Exactly one role-split note, naming Alex as the only referral contact.
        assert.strictEqual(text.split(LABELS[locale].welcomeContactNote).length - 1, 1, locale + ' one role note');
    }
});

test('the welcome keeps official support separate from the payment partners', () => {
    for (const locale of LOCALES) {
        const out = render('welcome', locale, CTX);
        const text = out.text;
        const supportAt = text.indexOf(OFFICIAL);
        const paymentAt = text.indexOf(LABELS[locale].welcomePaymentTitle);
        assert.ok(supportAt > -1, locale + ' official support link present');
        assert.ok(paymentAt > -1, locale + ' payment heading present');
        assert.ok(supportAt < paymentAt, locale + ' official support is listed before the partners');
        assert.ok(text.includes(LABELS[locale].welcomeSupportTitle), locale + ' support has its own heading');
        // Official support is never described as a partner.
        const supportLine = text.slice(supportAt).split('\n')[0];
        assert.ok(!/partner/i.test(supportLine), locale + ' official support line must not say partner');
        assert.ok(out.buttons.some((b) => b.url === OFFICIAL), locale + ' support button kept');
    }
});

test('the welcome keeps the existing links and the 2x2 keyboard', () => {
    for (const locale of LOCALES) {
        const out = render('welcome', locale, CTX);
        for (const url of [CONFIG.registerUrl, CONFIG.howItWorksUrl, ALEX, OFFICIAL]) {
            const inText = out.text.includes(url);
            const inButtons = out.buttons.some((b) => b.url === url);
            assert.ok(inText || inButtons, locale + ' keeps ' + url);
        }
        assert.deepStrictEqual(out.replyMarkup.inline_keyboard.map((r) => r.length), [2, 2],
            locale + ' keyboard layout unchanged');
        assert.ok(!JSON.stringify(out.buttons).includes(CHANNEL), 'the channel is linked in the copy, not as a button');
    }
});

test('the welcome contacts block is fully localized and passes the content guard', () => {
    for (const locale of LOCALES) {
        const labels = LABELS[locale];
        for (const key of ['welcomeAnnounceTitle', 'welcomeAnnounceBody', 'welcomeSupportTitle',
            'welcomePaymentTitle', 'welcomeAlexRole', 'welcomeOliviaRole', 'welcomeContactNote']) {
            assert.ok(String(labels[key] || '').trim(), locale + ' missing ' + key);
            if (locale !== 'en') {
                assert.notStrictEqual(labels[key], LABELS.en[key], locale + ' ' + key + ' is still English');
            }
        }
        const out = render('welcome', locale, CTX);
        const guard = checkContent(out.text, Object.assign({ locale }, FACTS));
        assert.strictEqual(guard.blocked, false, locale + ' welcome blocked by the guard');
        assert.strictEqual(guard.requiresApproval, false, locale + ' welcome needs approval');
    }
});

test('the welcome omits the payment section and adapts the note when a partner is unconfigured', () => {
    const alexOnly = Object.assign({}, CTX, { partnerSupportOliviaUrl: '' });
    const text = render('welcome', 'en', alexOnly).text;
    assert.ok(text.includes(ALEX) && !text.includes(OLIVIA), 'only the configured partner is listed');
    assert.ok(text.includes(LABELS.en.welcomeContactNoteAlex), 'the note names Alex for both roles');
    assert.ok(!text.includes(LABELS.en.welcomeContactNote), 'the two-partner note is not used');

    const none = Object.assign({}, CTX, {
        partnerSupportAlexUrl: '', partnerSupportUrl: '', partnerSupportOliviaUrl: ''
    });
    const bare = render('welcome', 'en', none).text;
    assert.ok(!bare.includes(LABELS.en.welcomePaymentTitle), 'no payment heading without partners');
    assert.ok(bare.includes(CHANNEL) && bare.includes(OFFICIAL), 'the channel and support blocks survive');
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

test('the Start Here stored buttons keep the recruitment contact through the queue round trip', () => {
    const built = buildStartHereRow({ config: CONFIG, scheduledFor: '2026-10-29T09:00:00Z' });
    const stored = JSON.parse(JSON.stringify(built.content.buttons));
    const urls = groupButtons(stored).flat().map((b) => b.url);
    assert.deepStrictEqual(urls, [
        'https://arbitrix.pro/?action=create-account',
        'https://arbitrix.pro/how-it-works',
        OFFICIAL, ALEX
    ]);
    assert.ok(!JSON.stringify(stored).includes(OLIVIA), 'no payment partner is queued as a recruitment button');
});

test('the labels are localized per purpose and never reuse English', () => {
    for (const locale of LOCALES) {
        const b = LABELS[locale].buttons;
        const l = LABELS[locale];
        // Buttons are the recruitment keyboard: official support + Alex.
        for (const key of ['partnerAlex', 'support']) {
            assert.ok(String(b[key] || '').trim(), locale + ' missing buttons.' + key);
            assert.match(b[key], /^\p{Extended_Pictographic}\s/u, locale + ' ' + key + ' needs an icon');
            assert.ok(b[key].length <= 64, locale + ' ' + key + ' must fit Telegram limits');
        }
        assert.match(b.partnerAlex, /Alex/);
        assert.strictEqual(b.partnerOlivia, undefined, locale + ' must not ship an Olivia recruitment button');
        // Payment labels exist for the payment-specific block only.
        assert.match(l.paymentAlex, /Alex/);
        assert.match(l.paymentOlivia, /Olivia/);
        assert.ok(String(l.paymentSupportLine || '').trim(), locale + ' missing paymentSupportLine');
        assert.ok(String(l.partnerSupportLine || '').trim(), locale + ' missing partnerSupportLine');
        assert.ok(!/Arbitrix_CSA1/.test(JSON.stringify(l)));
        if (locale !== 'en') {
            assert.notStrictEqual(b.partnerAlex, LABELS.en.buttons.partnerAlex, locale + ' Alex label untranslated');
            assert.notStrictEqual(l.paymentOlivia, LABELS.en.paymentOlivia, locale + ' Olivia payment label untranslated');
            assert.notStrictEqual(l.partnerSupportLine, LABELS.en.partnerSupportLine, locale + ' partner line untranslated');
        }
    }
    // Names are proper nouns: they survive the translation.
    assert.match(LABELS.ar.buttons.partnerAlex, /Alex/);
    assert.match(LABELS.pt.paymentOlivia, /Olivia/);
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
