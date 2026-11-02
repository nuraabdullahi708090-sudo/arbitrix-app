'use strict';

/**
 * Audience-specific community links in the {{links}} block.
 *
 * Business rule: the Telegram GROUP is the community destination, so a group
 * post must promote the group and must never send members to the announcement
 * channel. Channel-audience content (channel intro, channel weekly posts) keeps
 * its channel link and channel button unchanged, because channel publishing is
 * still part of the system.
 *
 * The audience is decided when the row is built (buildPostRow) and travels in
 * the render context, so this file checks both the raw render() output and the
 * real queue rows produced by buildCalendarRows / buildStartHereRow.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    render,
    LABELS,
    LOCALES,
    WEEKLY_THEMES
} = require('../services/MarketingContent');
const { checkContent } = require('../services/ContentGuard');
const { resolveMarketingConfig } = require('../services/TelegramBroadcast');
const { buildCalendarRows, buildStartHereRow } = require('../services/MarketingOnboarding');

const ROOT = path.join(__dirname, '..');
const GROUP = 'https://t.me/+CF9kWr61sqs1MTY0';
const CHANNEL = 'https://t.me/ArbitrixAnnouncements';
const SUPPORT = 'https://t.me/ArbitrixSupportBot';
const ALEX = 'https://t.me/AlexArbitrix';

const FACTS = { minDeposit: 100, referralPercent: 20 };
const CONFIG = Object.assign(resolveMarketingConfig({ BASE_URL: 'https://arbitrix.pro' }), {
    groupChatId: '-1001111111111',
    channelChatId: '-1004336842902',
    announcementUrl: CHANNEL,
    groupOnly: true,
    enabled: true,
    dryRun: false
});

/** Channel promotional wording that must not appear in group content. */
function channelWording(locale) {
    const labels = LABELS[locale];
    return [labels.announcements, labels.channel, 'ArbitrixAnnouncements'];
}

function weekly(locale, theme, audience) {
    return render('weekly', locale, Object.assign({}, CONFIG, FACTS, { theme, audience }));
}

function occurrences(text, needle) {
    return text.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// 1 + 2. Group weekly posts promote the community, never the channel
// ---------------------------------------------------------------------------
test('every weekly group post carries the community group link exactly once', () => {
    for (const locale of LOCALES) {
        for (const theme of WEEKLY_THEMES) {
            const text = weekly(locale, theme, 'group').text;
            assert.strictEqual(occurrences(text, GROUP), 1, locale + '/' + theme + ': community link exactly once');
            assert.ok(text.includes(LABELS[locale].community + ': ' + GROUP),
                locale + '/' + theme + ': the community link is labelled');
        }
    }
});

test('no weekly group post links, names or advertises the announcement channel', () => {
    for (const locale of LOCALES) {
        for (const theme of WEEKLY_THEMES) {
            const text = weekly(locale, theme, 'group').text;
            for (const wording of channelWording(locale)) {
                assert.ok(!text.includes(wording), locale + '/' + theme + ': must not contain ' + JSON.stringify(wording));
            }
        }
    }
});

test('a weekly group post keeps the support and partner contacts', () => {
    const text = weekly('en', 'mon', 'group').text;
    assert.ok(text.includes(SUPPORT), 'customer support link preserved');
    assert.ok(text.includes(ALEX), 'payment partner link preserved');
    assert.ok(text.includes(CONFIG.registerUrl), 'registration link preserved');
});

test('group weekly posts offer no channel button, only the approved contacts', () => {
    for (const locale of LOCALES) {
        for (const theme of WEEKLY_THEMES) {
            const out = weekly(locale, theme, 'group');
            const urls = out.buttons.map((b) => b.url);
            assert.ok(!urls.includes(CHANNEL), locale + '/' + theme + ': no channel button');
            assert.ok(!JSON.stringify(out.buttons).includes('ArbitrixAnnouncements'),
                locale + '/' + theme + ': no channel button text/url');
            assert.deepStrictEqual(urls, [CONFIG.registerUrl, SUPPORT, ALEX],
                locale + '/' + theme + ': approved button set');
        }
    }
});

// ---------------------------------------------------------------------------
// 3. Channel weekly posts keep their channel content
// ---------------------------------------------------------------------------
test('every weekly channel post keeps its announcement-channel link and button', () => {
    for (const locale of LOCALES) {
        for (const theme of WEEKLY_THEMES) {
            const out = weekly(locale, theme, 'channel');
            assert.strictEqual(occurrences(out.text, CHANNEL), 1, locale + '/' + theme + ': channel link exactly once');
            assert.ok(out.text.includes(LABELS[locale].announcements + ': ' + CHANNEL),
                locale + '/' + theme + ': labelled channel link');
            assert.ok(!out.text.includes(GROUP), locale + '/' + theme + ': the channel post does not promote the group');
            const urls = out.buttons.map((b) => b.url);
            assert.ok(urls.includes(CHANNEL), locale + '/' + theme + ': channel button present');
            assert.ok(!urls.includes(GROUP), locale + '/' + theme + ': no group button on channel content');
        }
    }
});

test('a channel weekly post keeps its support and partner contacts too', () => {
    const text = weekly('pt', 'thu', 'channel').text;
    assert.ok(text.includes(SUPPORT), 'support link preserved');
    assert.ok(text.includes(ALEX), 'partner link preserved');
});

test('audience is the only thing that differs between a group and a channel post', () => {
    for (const locale of LOCALES) {
        const group = weekly(locale, 'mon', 'group');
        const channel = weekly(locale, 'mon', 'channel');
        const strip = (t) => t
            .replace(LABELS[locale].community + ': ' + GROUP, '')
            .replace(LABELS[locale].announcements + ': ' + CHANNEL, '');
        assert.strictEqual(strip(group.text), strip(channel.text), locale + ': body copy identical');
    }
});

// ---------------------------------------------------------------------------
// 4. channelIntro is unchanged
// ---------------------------------------------------------------------------
test('channelIntro still introduces the channel and links it', () => {
    for (const locale of LOCALES) {
        const out = render('channelIntro', locale, Object.assign({}, CONFIG, FACTS, { audience: 'channel' }));
        assert.ok(out.text.includes(CHANNEL), locale + ': channel link');
        assert.ok(!out.text.includes(GROUP), locale + ': no community invite in channel content');
        assert.ok(out.buttons.some((b) => b.url === CHANNEL), locale + ': channel button');
    }
    // The intro copy itself is untouched.
    assert.ok(/official Arbitrix channel/i.test(render('channelIntro', 'en', Object.assign({}, CONFIG, { audience: 'channel' })).text));
});

test('channelIntro through the real row builder is explicit about its audience', () => {
    const { buildChannelIntroRow } = require('../services/MarketingOnboarding');
    const built = buildChannelIntroRow({ config: Object.assign({}, CONFIG, { facts: FACTS }), locale: 'en' });
    assert.strictEqual(built.row.audience, 'channel');
    assert.ok(built.row.content.includes(CHANNEL), 'queued channel intro keeps the channel link');
    assert.ok(!built.row.content.includes(GROUP), 'queued channel intro never carries the group invite');
});

// ---------------------------------------------------------------------------
// 5. Welcome and Start Here keep the PR #158 behaviour
// ---------------------------------------------------------------------------
test('welcome and Start Here still carry the community link exactly once and no channel', () => {
    for (const locale of LOCALES) {
        for (const kind of ['welcome', 'startHere']) {
            const text = render(kind, locale, Object.assign({}, CONFIG, FACTS)).text;
            assert.strictEqual(occurrences(text, GROUP), 1, locale + '/' + kind + ': community link exactly once');
            assert.ok(!text.includes(CHANNEL), locale + '/' + kind + ': no channel link');
            for (const wording of channelWording(locale)) {
                assert.ok(!text.includes(wording), locale + '/' + kind + ': no channel wording');
            }
        }
    }
});

// ---------------------------------------------------------------------------
// 6. Guard + keyboards
// ---------------------------------------------------------------------------
test('the content guard accepts both audiences', () => {
    for (const locale of LOCALES) {
        for (const audience of ['group', 'channel']) {
            const out = weekly(locale, 'wed', audience);
            const guard = checkContent(out.text, Object.assign({ locale }, FACTS));
            assert.strictEqual(guard.blocked, false, locale + '/' + audience + ': not blocked');
            assert.strictEqual(guard.requiresApproval, false, locale + '/' + audience + ': no approval needed');
        }
    }
});

test('the group invite line is exactly the fixed official URL', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'MarketingContent.js'), 'utf8');
    assert.strictEqual((src.match(/const OFFICIAL_GROUP_INVITE_URL = '[^']+';/g) || []).length, 1,
        'the invite is defined exactly once');
    assert.ok(src.includes("const OFFICIAL_GROUP_INVITE_URL = '" + GROUP + "';"),
        'the single constant is the official community invite');
});

// ---------------------------------------------------------------------------
// 7. Real queue rows: same schedule, right links, group-only parking intact
// ---------------------------------------------------------------------------
test('queued calendar rows use the audience-specific link with unchanged schedules and keys', () => {
    const now = new Date('2026-11-03T00:00:00Z');
    const base = Object.assign({}, CONFIG, { facts: FACTS });

    // Group-only mode (production): the channel slots are not seeded at all.
    const groupOnlyRows = buildCalendarRows({ config: Object.assign({}, base, { groupOnly: true }), weeks: 1, now });
    assert.strictEqual(groupOnlyRows.length, 3, 'group-only seeds the three group slots only');
    assert.deepStrictEqual(groupOnlyRows.map((r) => r.row.audience), ['group', 'group', 'group']);
    for (const r of groupOnlyRows) {
        assert.ok(r.row.content.includes(GROUP), 'group row carries the community link');
        assert.ok(!r.row.content.includes(CHANNEL), 'group row never carries the channel link');
        assert.ok(!JSON.stringify(r.row.buttons).includes('ArbitrixAnnouncements'), 'group row has no channel button');
    }

    // The full schedule is untouched: with group-only off, both audiences seed.
    const allRows = buildCalendarRows({ config: Object.assign({}, base, { groupOnly: false }), weeks: 1, now });
    assert.strictEqual(allRows.length, 7, 'one week of the default schedule');
    const group = allRows.filter((r) => r.row.audience === 'group');
    const channel = allRows.filter((r) => r.row.audience === 'channel');
    assert.strictEqual(group.length, 3, 'three group slots');
    assert.strictEqual(channel.length, 4, 'four channel slots');

    for (const r of group) {
        assert.ok(r.row.content.includes(GROUP), 'group row carries the community link');
        assert.ok(!r.row.content.includes(CHANNEL), 'group row never carries the channel link');
        assert.ok(!JSON.stringify(r.row.buttons).includes('ArbitrixAnnouncements'), 'group row has no channel button');
    }
    for (const r of channel) {
        assert.ok(r.row.content.includes(CHANNEL), 'channel row keeps the channel link');
        assert.ok(!r.row.content.includes(GROUP), 'channel row does not promote the group');
    }
    // Schedules and idempotency keys are untouched by the content change.
    assert.deepStrictEqual(allRows.map((r) => r.row.idempotency_key.split(':')[3]),
        ['mon', 'wed', 'fri', 'tue', 'thu', 'sat', 'sun'], 'theme order unchanged');
    assert.deepStrictEqual(allRows.map((r) => r.row.audience),
        ['group', 'group', 'group', 'channel', 'channel', 'channel', 'channel'], 'slot order unchanged');
    for (const r of allRows) {
        assert.strictEqual(r.row.status, 'scheduled', 'status unchanged');
        assert.strictEqual(r.row.chat_id, null, 'destination still resolved at send time');
    }
});

test('queued Start Here row is group-audience and community-only', () => {
    const built = buildStartHereRow({ config: Object.assign({}, CONFIG, { facts: FACTS }), locale: 'en' });
    assert.strictEqual(built.row.audience, 'group');
    assert.ok(built.row.content.includes(GROUP));
    assert.ok(!built.row.content.includes(CHANNEL));
});

test('the worker still parks channel posts under group-only mode', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'MarketingWorker.js'), 'utf8');
    assert.ok(/GROUP_ONLY_PARK_MS/.test(src), 'parking window constant present');
    assert.ok(/config\.groupOnly && post\.audience === 'channel'/.test(src),
        'channel posts are still parked when group-only is on');
    assert.ok(src.includes('group-only-mode: announcement channel inactive'),
        'parking reason unchanged');
});

test('no other content path renders the links block without an audience', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'MarketingOnboarding.js'), 'utf8');
    assert.ok(/buildLinkContext\(config, name, audience\)/.test(src),
        'buildPostRow passes the audience into the render context');
    assert.ok(/audience: audience === 'channel' \? 'channel' : 'group'/.test(src),
        'the context defaults to the group, never to the channel');
});
