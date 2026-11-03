/**
 * The proposed Telegram referral-community onboarding message (docs).
 *
 * The /partners page now sends prospects to the Telegram group, so the pinned
 * onboarding copy is the next thing they read. This suite keeps that draft
 * honest and publishable:
 *   - it stays a DRAFT (nothing may claim it was published)
 *   - it covers the ten required points
 *   - it states only the real business rules (20% one-time, $100 minimum)
 *   - the real content guard accepts it without blocking or manual review
 *   - it never discloses the internal withdrawal minimum
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'telegram-referral-onboarding.md'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const { checkContent } = require(path.join(ROOT, 'services', 'ContentGuard.js'));

const MESSAGE = (DOC.match(/```text\n([\s\S]*?)```/) || [])[1];
const TELEGRAM_LIMIT = 3900;

test('1. the document is an unpublished proposal, not a record of a live post', () => {
    assert.match(DOC, /Status:\s*\*\*DRAFT — NOT PUBLISHED\.\*\*/,
        'the status line must say the message has not been published');
    assert.match(DOC, /Publishing needs\s+management authorisation/i,
        'authorisation must be explicit');
    assert.ok(!/the message has been (pinned|published|sent)/i.test(DOC),
        'the document must not claim the message is already live');
    assert.match(DOC, /no message has been sent to the live group/i,
        'the status must say nothing was sent');
    assert.match(DOC, /## 5\. How to publish it \(operator, after authorisation\)/,
        'the publish procedure must stay behind an authorisation step');
});

test('2. the draft covers the ten required onboarding points', () => {
    assert.ok(MESSAGE, 'the document must contain a ```text message block');
    const required = [
        /welcome to the arbitrix referral community/i,          // 1 welcome
        /how the programme works/i,                             // 2 how it works
        /how to register as a partner/i,                        // 3 registration
        /personal referral link/i,                              // 4 referral link
        /how to share your link/i,                              // 5 sharing
        /20%/,                                                  // 6 commission
        /\$100/,                                                // 7 minimum deposit
        /when rewards are credited/i,                           // 8 crediting
        /tracking your referrals/i,                             // 9 tracking
        /need help/i,                                           // 10 assistance
    ];
    required.forEach((re) => assert.match(MESSAGE, re, 'missing section: ' + re));
    // Sections are numbered 1..10 with the keycap emoji, in order.
    const nums = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    let cursor = -1;
    nums.forEach((n) => {
        const at = MESSAGE.indexOf(n);
        assert.ok(at > cursor, 'section ' + n + ' must appear after the previous one');
        cursor = at;
    });
});

test('3. the message states only the real business rules', () => {
    assert.match(SERVER, /const REFERRAL_REWARD_PERCENT_DEFAULT = 20;/, 'the platform reward is 20%');
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 100;/, 'the platform minimum is $100');
    assert.match(MESSAGE, /one-time 20% of the referred user's first qualifying deposit/i,
        'the reward must be described as one-time, on the FIRST qualifying deposit');
    assert.match(MESSAGE, /\$100\. A first deposit below \$100 does not qualify/i,
        'the qualifying minimum must be stated exactly');
    assert.match(MESSAGE, /no\s+recurring commission on downline activity/i,
        'the absence of a downline commission must be stated');
    assert.match(MESSAGE, /no flat per-referral bonus/i,
        'no flat per-referral reward may be implied');
    assert.ok(!/guaranteed (income|profit|return)/i.test(MESSAGE), 'no guaranteed-income claims');
    assert.ok(!/passive income|lifetime commission/i.test(MESSAGE), 'no unsafe claims');
});

test('4. the internal withdrawal minimum is never disclosed', () => {
    const serverMin = Number((SERVER.match(/const MIN_WITHDRAWAL_USD = (\d+);/) || [])[1]);
    assert.ok(Number.isFinite(serverMin) && serverMin > 0, 'the enforcement constant must exist');
    assert.ok(MESSAGE.indexOf('$' + serverMin) === -1,
        'the withdrawal minimum must not be published in the group message');
    assert.ok(MESSAGE.indexOf(String(serverMin)) === -1,
        'no bare withdrawal-minimum figure may appear');
    assert.ok(!/withdrawal minimum/i.test(MESSAGE), 'no withdrawal-minimum statement (policy)');
});

test('5. the real content guard accepts the draft without review', () => {
    const report = checkContent(MESSAGE, { locale: 'en', minDeposit: 100, referralPercent: 20 });
    assert.strictEqual(report.blocked, false, 'the draft must not be blocked: '
        + JSON.stringify(report.violations || []));
    assert.strictEqual(report.requiresApproval, false, 'the draft must not need manual approval: '
        + JSON.stringify(report.violations || []));
    assert.deepStrictEqual(report.violations || [], [], 'no guard violations');
});

test('6. the draft fits Telegram and stays plain text', () => {
    assert.ok(MESSAGE.length <= TELEGRAM_LIMIT,
        'message is ' + MESSAGE.length + ' chars (limit ' + TELEGRAM_LIMIT + ')');
    // The transport sets no parse_mode, so markdown/HTML would render literally.
    assert.ok(!/\*\*[^*]+\*\*/.test(MESSAGE), 'no markdown bold');
    assert.ok(!/<[a-z][^>]*>/i.test(MESSAGE), 'no HTML tags');
    // Links are limited to the two destinations the platform already publishes.
    const links = (MESSAGE.match(/https?:\/\/[^\s]+/g) || [])
        .map((l) => l.replace(/[.,;:)]+$/, ''));
    const allowed = ['https://arbitrix.pro', 'https://arbitrix.pro/partners', 'https://t.me/AlexArbitrix'];
    links.forEach((l) => assert.ok(allowed.indexOf(l) !== -1, 'unexpected link in the message: ' + l));
    assert.ok(!/t\.me\/\+/.test(MESSAGE), 'the group does not invite itself');
});

test('7. the document never touches application behaviour', () => {
    assert.match(DOC, /does not send, queue or pin anything/i,
        'the "what this does not do" section must stay');
    // No code paths are claimed: the procedure uses the existing admin endpoints.
    assert.match(DOC, /POST \/api\/admin\/marketing\/preview/);
    assert.match(DOC, /POST \/api\/admin\/marketing\/posts/);
    assert.match(DOC, /POST \/api\/admin\/marketing\/pin/);
    assert.match(DOC, /TELEGRAM_MARKETING_ENABLED/, 'the enable gate must be named');
    assert.match(DOC, /paused/, 'the pause gate must be named');
});
