'use strict';

/**
 * The group welcome message points members at the COMMUNITY GROUP, never at the
 * announcement channel.
 *
 * Business decision: automated publishing now happens in the Telegram group only,
 * so the channel is no longer promoted in the join-triggered welcome. The channel
 * itself stays configured for the publisher - this file proves the welcome is
 * independent of that configuration rather than that the channel was removed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { render, LABELS, LOCALES } = require('../services/MarketingContent');
const { checkContent } = require('../services/ContentGuard');
const { resolveMarketingConfig } = require('../services/TelegramBroadcast');

const GROUP_INVITE = 'https://t.me/+CF9kWr61sqs1MTY0';
const CHANNEL = 'https://t.me/ArbitrixAnnouncements';
const SUPPORT = 'https://t.me/ArbitrixSupportBot';
const ROOT = path.join(__dirname, '..');

const FACTS = { minDeposit: 100, referralPercent: 20 };
const CONFIG = Object.assign(resolveMarketingConfig({ BASE_URL: 'https://arbitrix.pro' }), {
    facts: FACTS,
    groupChatId: '-1004336842902',
    enabled: true,
    dryRun: false
});
/** The channel is CONFIGURED here on purpose: the welcome must still ignore it. */
const CTX = Object.assign({}, CONFIG, FACTS, { announcementUrl: CHANNEL });
const CTX_NO_CHANNEL = Object.assign({}, CTX, { announcementUrl: '' });

// ---------------------------------------------------------------------------
// 1. The correct group link is present
// ---------------------------------------------------------------------------
test('the welcome shares the official community group link in every language', () => {
    for (const locale of LOCALES) {
        const text = render('welcome', locale, CTX).text;
        assert.ok(text.includes(GROUP_INVITE), locale + ': welcome must share the group invite');
        assert.ok(text.includes(LABELS[locale].welcomeGroupTitle), locale + ': group heading');
        assert.ok(text.includes(LABELS[locale].welcomeGroupBody), locale + ': group explanation');
        assert.strictEqual(text.split(GROUP_INVITE).length - 1, 1, locale + ': the invite appears exactly once');
    }
});

test('the group section is independent of any channel configuration', () => {
    for (const locale of LOCALES) {
        assert.strictEqual(
            render('welcome', locale, CTX_NO_CHANNEL).text,
            render('welcome', locale, CTX).text,
            locale + ': the welcome must not change with or without the channel URL'
        );
    }
});

// ---------------------------------------------------------------------------
// 2. The announcement channel is gone from the welcome
// ---------------------------------------------------------------------------
test('the welcome never contains the announcement channel link', () => {
    for (const locale of LOCALES) {
        const text = render('welcome', locale, CTX).text;
        assert.ok(!text.includes(CHANNEL), locale + ': no channel URL');
        assert.ok(!text.includes('ArbitrixAnnouncements'), locale + ': no channel handle');
        assert.ok(!text.includes(LABELS[locale].welcomeAnnounceTitle), locale + ': no channel heading');
        assert.ok(!text.includes(LABELS[locale].welcomeAnnounceBody), locale + ': no channel invitation');
        // No wording that invites a subscription/follow to a channel.
        assert.ok(!/(subscribe|follow).{0,30}channel/i.test(text), locale + ': no follow-the-channel wording');
    }
});

test('no welcome render, in any language or shape, carries a channel link', () => {
    const variants = [
        CTX,
        CTX_NO_CHANNEL,
        Object.assign({}, CTX, { partnerSupportOliviaUrl: '' }),
        Object.assign({}, CTX, { partnerSupportAlexUrl: '', partnerSupportUrl: '', partnerSupportOliviaUrl: '' }),
        Object.assign({}, CTX, { supportUrl: '' })
    ];
    for (const locale of LOCALES) {
        for (const ctx of variants) {
            const out = render('welcome', locale, ctx);
            assert.ok(!out.text.includes('ArbitrixAnnouncements'), locale + ': text is channel-free');
            assert.ok(!JSON.stringify(out.buttons).includes('ArbitrixAnnouncements'), locale + ': buttons are channel-free');
        }
    }
});

// ---------------------------------------------------------------------------
// 3. Existing welcome functionality is intact
// ---------------------------------------------------------------------------
test('the rest of the welcome is unchanged', () => {
    const text = render('welcome', 'en', CTX).text;
    const kept = [
        'Welcome to the Arbitrix Partners Community!',
        'automated multi-asset arbitrage platform',
        'YOUR NEXT STEPS',
        'EXPLORE ARBITRIX',
        'CREATE YOUR ACCOUNT',
        'DISCOVER THE PARTNER PROGRAMME',
        "log into your account and open the Referral page",
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
    assert.ok(!/\n{3,}/.test(text), 'no triple blank lines after removing the channel block');
    assert.ok(!text.trimEnd().endsWith(':'), 'no dangling label at the end');
});

test('the welcome keyboard still offers registration, guide, support and the recruitment partner', () => {
    const buttons = render('welcome', 'en', CTX).buttons;
    const urls = buttons.map((b) => b.url);
    assert.ok(urls.some((u) => u.includes('action=create-account')), 'Create Account');
    assert.ok(urls.some((u) => u.includes('/how-it-works')), 'How It Works');
    assert.ok(urls.includes(SUPPORT), 'Customer Support');
    assert.ok(urls.includes('https://t.me/AlexArbitrix'), 'Contact Alex');
    assert.ok(!urls.some((u) => u.includes('ArbitrixAnnouncements')), 'no channel button');
    assert.deepStrictEqual(buttons.map((b) => b.row), [0, 0, 1, 1], 'two rows of two');
});

test('the welcome is still publishable by the content guard', () => {
    for (const locale of LOCALES) {
        const out = render('welcome', locale, CTX);
        const guard = checkContent(out.text, { locale, facts: FACTS });
        assert.strictEqual(guard.blocked, false, locale + ': guard blocked the welcome: ' + JSON.stringify(guard.violations));
    }
});

// ---------------------------------------------------------------------------
// 4. Scope: only the welcome changed
// ---------------------------------------------------------------------------
test('the announcement channel is still configured and still used by the other messages', () => {
    // Configuration is untouched: the channel URL still resolves from the env.
    const cfg = resolveMarketingConfig({ TELEGRAM_ANNOUNCEMENT_CHANNEL_URL: CHANNEL });
    assert.strictEqual(cfg.announcementUrl, CHANNEL, 'the channel URL is still configured');

    // Start Here (a queued publisher post, not the welcome) is out of scope here.
    const startHere = render('startHere', 'en', CTX).text;
    assert.ok(startHere.includes(CHANNEL), 'Start Here keeps its channel reference (unchanged by this task)');
});

test('the welcome builds its community block from the group constant, not from announceSection', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services/MarketingContent.js'), 'utf8');
    assert.strictEqual((src.match(/const OFFICIAL_GROUP_INVITE_URL = 'https:\/\/t\.me\/\+CF9kWr61sqs1MTY0';/g) || []).length, 1,
        'the group invite is defined exactly once');

    const start = src.indexOf('function welcomeContactsBlock');
    const body = src.slice(start, src.indexOf('function buildLinksBlock', start));
    assert.ok(body.includes('OFFICIAL_GROUP_INVITE_URL'), 'the welcome uses the group invite');
    assert.ok(!body.includes('announceSection('), 'the welcome no longer renders the channel section');
});

test('nothing here touches the publisher, the queue or the group-only switch', () => {
    const worker = fs.readFileSync(path.join(ROOT, 'services/MarketingWorker.js'), 'utf8');
    assert.ok(worker.includes('GROUP_ONLY_PARK_MS'), 'group-only parking is untouched');
    const broadcast = fs.readFileSync(path.join(ROOT, 'services/TelegramBroadcast.js'), 'utf8');
    assert.ok(broadcast.includes('TELEGRAM_ANNOUNCEMENT_CHANNEL_URL'), 'the channel config still resolves');
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'supabase/migrations')), true);
});
