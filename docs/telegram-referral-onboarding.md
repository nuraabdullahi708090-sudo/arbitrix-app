# Telegram referral-community onboarding (proposal)

Status: **DRAFT — NOT PUBLISHED.** No message has been sent to the live group and
nothing in this document changes application behaviour. Publishing needs
management authorisation plus an operator action in Telegram (see §5).

Related: `docs/TELEGRAM_MARKETING_DEPLOYMENT.md` (publisher runbook),
`services/MarketingContent.js` (welcome + START HERE templates),
`supabase/migrations/038_marketing_broadcast.sql` (queue, control, audit).

---

## 1. Why this exists

The `/partners` landing page now sends a prospective partner to the Telegram
community instead of to the website (`https://t.me/+CF9kWr61sqs1MTY0`). That
makes the group the first thing a prospect reads, so the group itself must
explain the programme before anyone registers.

This document is the proposed pinned onboarding message, plus how to publish it.
It is deliberately separate from the landing-page change: the page shipped with
no dependency on any Telegram administrative action.

---

## 2. What already exists in the repository

| Capability | Where | Notes |
|---|---|---|
| Welcome message on join | `services/MarketingOnboarding.js` + `MarketingContent.js` (`welcome`) | Sends once per joining member (per process), personalised with the member's first name; en / pt / ar. |
| Pinnable "START HERE" guide | `MarketingContent.js` (`startHere`) + `POST /api/admin/marketing/start-here` | Covers the next steps, the referral section, the one-time reward and responsible promotion. **Queue only — pinning is a separate admin call.** |
| Manual pin | `POST /api/admin/marketing/pin` (`{ messageId }` or `{ postId }`) | Pins **only** the configured group; the message id must come from a published post. |
| Scheduled content | `POST /api/admin/marketing/posts` (`kind: 'custom'`) | Runs the content guard, then queues (`scheduled` or `awaiting_approval`). |
| Publish control | `GET /api/admin/marketing/status`, `POST /api/admin/marketing/control` | Three gates: `TELEGRAM_MARKETING_ENABLED`, control row `paused`, control row `dry_run`. Migration 038 seeds paused + dry_run. |

---

## 3. Does the group already have pinned referral guidelines?

**Cannot be confirmed from this environment, and no code can answer it.**
Pinned state lives only in Telegram. What the repository shows is a capability,
not an action:

* the START HERE guide exists and is pinnable, but pinning is an explicit admin
  call (`POST /api/admin/marketing/pin`) with a real published message id — there
  is no automatic pin anywhere in the codebase (pinned by
  `tests/telegram_partner_welcome.test.js`);
* the welcome message is sent to joiners and is not a substitute for a pinned
  reference;
* there is no dedicated "programme rules" message: the START HERE guide covers
  the reward, the deposit minimum and responsible promotion, but not payouts,
  tracking or the payout workflow in the detail a new partner needs.

**Operator check (30 seconds):** open the group in Telegram and look at the
pinned-message bar, or run `node scripts/diagnose-telegram.js` in the Render
shell and read the marketing block. If the only pin is a general welcome, treat
the guidelines as missing and use §4.

---

## 4. Proposed pinned message (English, plain text)

Telegram is sent **without `parse_mode`** (see `MarketingContent.js`), so this
draft uses plain text plus emoji — no `**markdown**` and no HTML. It is 2,560
characters, inside the 3,900-character limit enforced by
`POST /api/admin/marketing/posts`.

The draft was checked against the real content guard
(`services/ContentGuard.js` with `minDeposit: 100`, `referralPercent: 20`):
`blocked = false`, `requiresApproval = false`, no violations. Re-run that check
(`POST /api/admin/marketing/preview`) before queueing, because the guard rules
can change independently of this document.

```text
📌 ARBITRIX REFERRAL PROGRAMME — START HERE

👋 Welcome to the Arbitrix referral community.
Arbitrix is an automated multi-asset arbitrage platform. This group is where
referral partners learn how the programme works, ask questions and get guidance
on referring new users.

1️⃣ HOW THE PROGRAMME WORKS
You introduce a new user to Arbitrix with your personal referral link. When
their first deposit of $100 or more is confirmed, you earn a one-time reward of
20% of that deposit. Later deposits do not earn again.

2️⃣ HOW TO REGISTER AS A PARTNER
Create your Arbitrix account at https://arbitrix.pro. A separate partner
account is not needed — every account can refer. Register first so your referral
link is issued to your own account.

3️⃣ HOW TO GET YOUR PERSONAL REFERRAL LINK
Log in, open your account dashboard and scroll to the Referral section. Your
referral code and your referral link are shown there, with copy buttons.

4️⃣ HOW TO SHARE YOUR LINK
Share it with people who genuinely want to use Arbitrix. Describe what the
platform does. Never promise profits and never describe trading as risk-free.
Self-referrals, duplicate accounts, fraudulent activity and misleading promotion
are not eligible for rewards.

5️⃣ THE REWARD
One-time 20% of the referred user's first qualifying deposit. There is no
recurring commission on downline activity and no flat per-referral bonus.
Worked examples are published on the partner page: https://arbitrix.pro/partners

6️⃣ MINIMUM QUALIFYING DEPOSIT
$100. A first deposit below $100 does not qualify, and a later top-up does not
retroactively qualify it.

7️⃣ WHEN REWARDS ARE CREDITED
Automatically, once the referred user's first deposit of $100 or more is
confirmed. Registration, link clicks and pending deposits do not qualify.

8️⃣ TRACKING YOUR REFERRALS
The Referral section shows your qualified referrals, your confirmed earnings
and your payout history.

9️⃣ PAYOUTS
Request a payout from the same Referral section: choose the amount (there is no
minimum payout), the asset USDT, the network TRC20 and your wallet address.
Requests are reviewed by our team before payment and paid in USDT on the TRC20
network. The transaction reference appears in your payout history.

🔟 NEED HELP
Ask here in the group. For account-specific issues, contact partner support:
https://t.me/AlexArbitrix

⚠️ Partners provide marketing and introductions only. Partners are not
authorized to provide investment or trading advice on behalf of Arbitrix.
Trading involves risk; referral rewards are not guaranteed earnings.
```

### Rules this message obeys

* one-time 20% of the **first** qualifying deposit; no recurring downline
  commission; no flat per-referral reward;
* qualifying minimum **$100**;
* no income guarantees, no profit promises, no "risk-free" framing (the guard
  reads negations correctly, so "never promise profits" stays publishable);
* no withdrawal-minimum statement anywhere (the platform's internal threshold is
  disclosed only inside the withdrawal pop-up);
* links: only the site and the official partner-support handle — both already
  used elsewhere in the repository.

---

## 5. How to publish it (operator, after authorisation)

Publishing is inert until three gates open (`TELEGRAM_MARKETING_ENABLED=true`,
control `paused=false`, control `dry_run=false`). Steps:

1. **Dry check** the copy (no writes):
   `POST /api/admin/marketing/preview { "locale": "en", "text": "<the draft>" }`
   → returns the rendered text and the guard report. A guard hit returns
   `awaiting_approval` later, never a silent publish.
2. **Queue** it:
   `POST /api/admin/marketing/posts { "kind": "custom", "audience": "group", "locale": "en", "content": "<the draft>" }`
3. If it lands in `awaiting_approval`, review then
   `PATCH /api/admin/marketing/posts/<id> { "action": "approve" }`.
4. Open the gates (see the deployment runbook) — the worker publishes it and the
   send audit records `telegram_message_id`.
5. **Pin** it: `POST /api/admin/marketing/pin { "postId": <id> }`.
6. Confirm in the Telegram client that the pinned bar shows the message, then
   re-close the gates if the pin was the only thing you needed.

Localised variants: the same call with `"locale": "pt"` or `"ar"` queues the
translated copy. The built-in START HERE template (`POST
/api/admin/marketing/start-here`) already ships en/pt/ar and can be used instead
if a fully localised pin is preferred to this custom text.

---

## 6. What this document does NOT do

* It does not send, queue or pin anything.
* It does not change the landing page, the bot, the worker or the database.
* It does not add a new template kind — the existing `custom` queue path is used,
  so no deployment is required to publish it.
