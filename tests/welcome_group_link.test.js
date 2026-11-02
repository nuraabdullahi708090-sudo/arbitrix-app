'use strict';

/**
 * The two community messages - the join-triggered WELCOME and the pinned START
 * HERE guide - point members at the community GROUP and never at the
 * announcement channel.
 *
 * Business decision: automated publishing runs in the Telegram group only. The
 * channel stays configured for the publisher (channelIntro / weekly posts keep
 * their channel link), so these tests also prove that removing the promotion
 * from the two community messages did not touch the publishing system.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { render, LABELS, LOCALES } = require('../services/MarketingContent');
const { checkContent } = require('../services/ContentGuard');
const { resolveMarketingConfig } = require('../services/TelegramBroadcast');
const { buildStartHereRow } = require('../services/MarketingOnboarding');

const GROUP_INVITE = 'https://t.me/+CF9kWr61sqs1MTY0';
const CHANNEL = 'https://t.me/ArbitrixAnnouncements';
const SUPPORT = 'https://t.me/ArbitrixSupportBot';
const ROOT = path.join(__dirname, '..');
const COMMUNITY_KINDS = ['welcome', 'startHere'];

const FACTS = { minDeposit: 100, referralPercent: 20 };
const CONFIG = Object.assign(resolveMarketingConfig({ BASE_URL: 'https://arbitrix.pro' }), {
    facts: FACTS,
    groupChatId: '-1004336842902',
    enabled: true,
    dryRun: false
});
/** The channel is CONFIGURED here on purpose: both messages must still ignore it. */
const CTX = Object.assign({}, CONFIG, FACTS, { announcementUrl: CHANNEL });
const CTX_NO_CHANNEL = Object.assign({}, CTX, { announcementUrl: '' });

// ---------------------------------------------------------------------------
// 1. The group link is present where intended
// ---------------------------------------------------------------------------
test('the welcome and Start Here share the official community group link in every language', () => {
    for (const kind of COMMUNITY_KINDS) {
        for (const locale of LOCALES) {
            const text = render(kind, locale, CTX).text;
            const label = locale + '/' + kind;
            assert.ok(text.includes(GROUP_INVITE), label + ': must share the group invite');
            assert.ok(text.includes(LABELS[locale].welcomeGroupTitle), label + ': group heading');
            assert.ok(text.includes(LABELS[locale].welcomeGroupBody), label + ': group explanation');
            assert.strictEqual(text.split(GROUP_INVITE).length - 1, 1, label + ': the invite appears exactly once');
        }
    }
});

test('the community section is identical in both messages and independent of the channel URL', () => {
    for (const locale of LOCALES) {
        const section = [LABELS[locale].welcomeGroupTitle, LABELS[locale].welcomeGroupBody, GROUP_INVITE].join('\n');
        for (const kind of COMMUNITY_KINDS) {
            const text = render(kind, locale, CTX).text;
            assert.ok(text.includes(section), locale + '/' + kind + ': renders the shared community block');
            assert.strictEqual(
                render(kind, locale, CTX_NO_CHANNEL).text,
                text,
                locale + '/' + kind + ': must not change with or without the channel URL'
            );
        }
    }
});

// ---------------------------------------------------------------------------
// 2. The announcement channel is gone from both community messages
// ---------------------------------------------------------------------------
test('neither community message promotes the announcement channel', () => {
    for (const kind of COMMUNITY_KINDS) {
        for (const locale of LOCALES) {
            const text = render(kind, locale, CTX).text;
            const label = locale + '/' + kind;
            assert.ok(!text.includes(CHANNEL), label + ': no channel URL');
            assert.ok(!text.includes('ArbitrixAnnouncements'), label + ': no channel handle');
            assert.ok(!/OFFICIAL ANNOUNCEMENTS/i.test(text), label + ': no channel heading');
            assert.ok(!/(subscribe|follow).{0,30}channel/i.test(text), label + ': no follow-the-channel wording');
        }
    }
});

test('no render shape of either message carries a channel link', () => {
    const variants = [
        CTX,
        CTX_NO_CHANNEL,
        Object.assign({}, CTX, { partnerSupportOliviaUrl: '' }),
        Object.assign({}, CTX, { partnerSupportAlexUrl: '', partnerSupportUrl: '', partnerSupportOliviaUrl: '' }),
        Object.assign({}, CTX, { supportUrl: '' })
    ];
    for (const kind of COMMUNITY_KINDS) {
        for (const locale of LOCALES) {
            for (const ctx of variants) {
                const out = render(kind, locale, ctx);
                assert.ok(!out.text.includes('ArbitrixAnnouncements'), locale + '/' + kind + ': text is channel-free');
                assert.ok(!JSON.stringify(out.buttons).includes('ArbitrixAnnouncements'), locale + '/' + kind + ': buttons are channel-free');
            }
        }
    }
});

test('the queued Start Here row is channel-free end to end', () => {
    const built = buildStartHereRow({ config: CTX, scheduledFor: '2026-11-04T09:00:00Z' });
    const row = built.row;
    assert.ok(row.content.includes(GROUP_INVITE), 'the stored post shares the group invite');
    assert.ok(!row.content.includes('ArbitrixAnnouncements'), 'the stored post never links the channel');
    assert.ok(!JSON.stringify(row.buttons).includes('ArbitrixAnnouncements'), 'no channel button is stored');
    assert.strictEqual(row.status, 'scheduled', 'the row is still publishable without manual approval');
});

// ---------------------------------------------------------------------------
// 3. Everything else is intact
// ---------------------------------------------------------------------------
test('the welcome keeps its approved copy', () => {
    const text = render('welcome', 'en', CTX).text;
    const kept = [
        'Welcome to the Arbitrix Partners Community!',
        'automated multi-asset arbitrage platform',
        'YOUR NEXT STEPS',
        'EXPLORE ARBITRIX',
        'CREATE YOUR ACCOUNT',
        'DISCOVER THE PARTNER PROGRAMME',
        'log into your account and open the Referral page',
        'REFERRAL REWARD',
        '20% of a referred user',
        'first qualifying deposit of $100 or more',
        'NEED HELP?',
        'OFFICIAL COMMUNITY',
        GROUP_INVITE,
        'OFFICIAL CUSTOMER SUPPORT',
        SUPPORT,
        'PAYMENT SUPPORT PARTNERS',
        'Choose an option below to get started!'
    ];
    for (const line of kept) {
        assert.ok(text.includes(line), 'welcome lost approved copy: ' + line);
    }
    assert.ok(!/\n{3,}/.test(text), 'no triple blank lines');
});

test('Start Here keeps its guide, responsible-promotion note, support lines and keyboard', () => {
    const text = render('startHere', 'en', CTX).text;
    const kept = [
        'START HERE',
        'Welcome to the Arbitrix Partners Community!',
        'YOUR NEXT STEPS',
        'EXPLORE ARBITRIX',
        'CREATE YOUR ACCOUNT',
        'DISCOVER THE PARTNER PROGRAMME',
        'PROMOTE RESPONSIBLY',
        'Never promise profits',
        'REFERRAL REWARD',
        'NEED HELP?',
        'Customer support: ' + SUPPORT,
        'OFFICIAL COMMUNITY',
        GROUP_INVITE,
        'Choose an option below to get started!'
    ];
    for (const line of kept) {
        assert.ok(text.includes(line), 'Start Here lost approved copy: ' + line);
    }
    // The community block sits where the channel block used to be: between the
    // responsible-promotion note and the NEED HELP section.
    assert.ok(text.indexOf('PROMOTE RESPONSIBLY') < text.indexOf('OFFICIAL COMMUNITY'), 'community block after the guidance');
    assert.ok(text.indexOf('OFFICIAL COMMUNITY') < text.indexOf('NEED HELP?'), 'community block before support');
    assert.ok(!/\n{3,}/.test(text), 'no triple blank lines');

    const buttons = render('startHere', 'en', CTX).buttons;
    assert.deepStrictEqual(buttons.map((b) => b.url), [
        'https://arbitrix.pro/?action=create-account',
        'https://arbitrix.pro/how-it-works',
        SUPPORT,
        'https://t.me/AlexArbitrix'
    ], 'the four Start Here destinations are unchanged');
    assert.deepStrictEqual(buttons.map((b) => b.row), [0, 0, 1, 1], 'two rows of two');
});

test('both community messages stay publishable by the content guard', () => {
    for (const kind of COMMUNITY_KINDS) {
        for (const locale of LOCALES) {
            const out = render(kind, locale, CTX);
            const guard = checkContent(out.text, { locale, facts: FACTS });
            assert.strictEqual(guard.blocked, false, locale + '/' + kind + ' blocked: ' + JSON.stringify(guard.violations));
        }
    }
});

// ---------------------------------------------------------------------------
// 4. Scope: the publishing system is untouched
// ---------------------------------------------------------------------------
test('the announcement channel is still configured and still used by the publisher', () => {
    // Configuration is untouched: the channel URL still resolves from the env.
    const cfg = resolveMarketingConfig({ TELEGRAM_ANNOUNCEMENT_CHANNEL_URL: CHANNEL });
    assert.strictEqual(cfg.announcementUrl, CHANNEL, 'the channel URL is still configured');

    // Channel-audience content is NOT part of this change: the channel intro and
    // the weekly posts keep their channel link through the links block.
    const channelIntro = render('channelIntro', 'en', CTX).text;
    const weekly = render('weekly', 'en', Object.assign({}, CTX, { theme: 'tue' })).text;
    assert.ok(channelIntro.includes(CHANNEL), 'channelIntro keeps its channel link');
    assert.ok(weekly.includes(CHANNEL), 'weekly posts keep their channel link');
});

test('the two community messages no longer reference the retired channel section', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services/MarketingContent.js'), 'utf8');
    assert.strictEqual((src.match(/const OFFICIAL_GROUP_INVITE_URL = 'https:\/\/t\.me\/\+CF9kWr61sqs1MTY0';/g) || []).length, 1,
        'the group invite is defined exactly once');
    assert.strictEqual((src.match(/function communitySection\(/g) || []).length, 1, 'one community builder');
    assert.ok(!src.includes('function announceSection'), 'the channel section builder is gone');
    assert.ok(!src.includes("'{{announceSection}}'"), 'no template still asks for the channel section');
    assert.strictEqual((src.match(/'{{communitySection}}'/g) || []).length, 3, 'en, pt and ar Start Here all use it');
    assert.ok(!/welcomeAnnounce(Title|Body)/.test(src), 'the channel labels are retired');
});

test('nothing here touches the publisher, the queue or the group-only switch', () => {
    const worker = fs.readFileSync(path.join(ROOT, 'services/MarketingWorker.js'), 'utf8');
    assert.ok(worker.includes('GROUP_ONLY_PARK_MS'), 'group-only parking is untouched');
    const broadcast = fs.readFileSync(path.join(ROOT, 'services/TelegramBroadcast.js'), 'utf8');
    assert.ok(broadcast.includes('TELEGRAM_ANNOUNCEMENT_CHANNEL_URL'), 'the channel config still resolves');
    assert.ok(fs.existsSync(path.join(ROOT, 'supabase/migrations')), 'migrations untouched');
});
