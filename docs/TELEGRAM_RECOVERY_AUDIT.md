# Arbitrix Telegram Recovery Audit

Audit date: 2026-10-27. Scope: repository and deployment reconstruction for the
Arbitrix Telegram support bot (@ArbitrixSupportBot), the partner marketing group
and the official announcement channel.

This document is READ-ONLY in intent: no code, no migration, no production
configuration and no Telegram message was changed to produce it. Every finding
carries a confidence label:

- **VERIFIED** - directly observed in this repository, in Git, or from a public
  read-only probe of production.
- **INFERRED** - a conclusion drawn from code plus indirect evidence, stated with
  its reasoning.
- **UNKNOWN** - cannot be established from this environment (no database
  credentials that resolve, no Render account access, no bot token).

---

## 1. Executive summary

- The project is `arbitrix-app` at `/workspace/project/arbitrix-app`, on branch
  `main`, HEAD `9ec7caa`, working tree clean. **VERIFIED**
- The **actual remote** `refs/heads/main` is **`87a648e`** (read-only
  `git ls-remote`). The local `origin/main` ref (`c13c6c1`) is **stale** because
  this clone is shallow and was not fetched after the last push. **VERIFIED**
- Therefore the branch is **4 commits ahead of production**, not 5:
  `3c48065` (Phase 1 account linking), `1d934a6` (Phase 2 conversion events +
  outbox), `535c87c` (atomic legacy deposit credit), `9ec7caa` (welcome copy).
  **VERIFIED**
- Production is Render (response header `x-render-origin-server: Render`) and is
  consistent with the `87a648e` build; `/api/telegram/webhook` rejects unsigned
  calls with `401 {"ok":false,"error":"invalid_secret"}`, so the bot is
  configured and fail-closed. **VERIFIED** (config) / **INFERRED** (exact build;
  `87a648e` touches no public asset, so it cannot be fingerprinted from outside).
- The **private support bot is live and hardened**. The **partner-group
  onboarding and channel publisher are fully implemented but inert**: flags
  default to off, the database control row seeds `paused = TRUE, dry_run = TRUE`,
  and migration 038 has **not** been verified as applied. **VERIFIED** (defaults)
  / **UNKNOWN** (migration state, production env values).
- Tests: `npm test` = **2488 tests, 2487 pass, 1 fail**. The single failure is the
  pre-existing `tests/how_it_works_video.test.js` master-asset check. The
  Telegram/support/marketing/conversion subset is **1045/1045 pass**. **VERIFIED**
- Two real defects remain open (detailed in section 9): `confirm_payment_with_credit`
  never sets `deposits.credited = TRUE` (silently suppresses deposit
  notifications on the NOWPayments/generic webhook path), and the marketing queue
  (038) has no stale-`sending` reaper, so a worker crash can orphan a post.
- No blocker prevents documenting or preparing; the blockers are all **activation**
  blockers: unapplied migrations, unset chat ids, and the deliberate three-gate
  publisher switch.

## 2. Repository and Git status

| Item | Value | Confidence |
|---|---|---|
| Working directory | `/workspace/project/arbitrix-app` | VERIFIED |
| Package | `arbitrix-app@1.0.0`, `main: server.js`, `start: node server.js` | VERIFIED |
| Branch | `main` | VERIFIED |
| HEAD | `9ec7caa3bb319f717fc91a3a137f37e01da74410` | VERIFIED |
| Working tree | clean (no staged/modified/untracked files) | VERIFIED |
| Clone | shallow (`is-shallow-repository` = true) | VERIFIED |
| Local `origin/main` ref | `c13c6c1` (**stale**) | VERIFIED |
| Actual `refs/heads/main` | `87a648ee5f801090727522fa54ed8f875cc6c960` | VERIFIED (ls-remote) |
| Ahead / behind real remote | ahead 4, behind 0 (fast-forward) | VERIFIED |
| Merge commits in range | none | VERIFIED |
| Commit author | `openhands <openhands@all-hands.dev>` | VERIFIED |
| Remote URL | embeds a `ghu_...` credential in `.git/config` (redacted here) | VERIFIED |

### Commit history (newest first)

| Commit | Parent | Subject | Deployed |
|---|---|---|---|
| `9ec7caa` | `535c87c` | feat: refine the partner welcome copy and Start Here guide | no |
| `535c87c` | `1d934a6` | fix: credit legacy deposits atomically before the conversion event | no |
| `1d934a6` | `3c48065` | feat: durable conversion events and a Telegram delivery outbox (Phase 2) | no |
| `3c48065` | `87a648e` | feat: securely link an Arbitrix account to Telegram (Phase 1) | no |
| `87a648e` | `c13c6c1` | fix: handle mixed human/bot join batches in the partner welcome | **yes** |
| `c13c6c1` | `e14e48e` | docs: record firstName on the marketing join event | yes |
| `e14e48e` | `1d18765` | feat: personalise the partner welcome and point members to their Referral page | yes |
| `1d18765` | `750b8ba` | feat: refine the partner welcome message, inline buttons and Start Here guide | yes |
| `750b8ba` | - | feat: answer /chatid and /id privately from any group | yes |

### Documentation present

| File | Size | Notes |
|---|---|---|
| `AGENTS.md` | 7363 lines | Primary project memory/changelog. Append-only in practice. |
| `UX_REVIEW.md` | - | Frontend UX notes, not Telegram. |
| `docs/KYC_DEPLOYMENT.md` | - | The only doc that names `supabase db push`. |
| `docs/PAYMENT_SYSTEM.md` | - | Payment architecture. |
| `README.md` | **absent** | There is no README in this repository. |

Two migration directories exist and must not be confused:

- `supabase/migrations/` - 41 files, `001` ... `041` (**authoritative**).
- `migrations/` - 5 legacy files (`001_create_password_reset_tokens`,
  `002_referral_system_improvements`, `003_referral_config`,
  `004_referral_config_audit`, `005_email_2fa`) with **overlapping numbering**.
  `AGENTS.md` records `003_referral_config.sql` as a historical bootstrap file.
  Always name the directory when referring to a migration number.

### Contradiction check of the documentation

`AGENTS.md` was treated as untrusted and re-checked against code:

| Claim in AGENTS.md | Result |
|---|---|
| "Migration 038 NOT applied", "migration 038 remains unapplied" | **UNKNOWN** - cannot be verified without database access; no code applies migrations automatically (VERIFIED that `server.js` executes no DDL). |
| "Multi-member welcome hardening DEPLOYED" at `87a648e` | **CONFIRMED** by `ls-remote`: remote main is `87a648e`. |
| "npm test = 2517 tests, 2516 pass" (line 7352) | **STALE** - the tree runs 2488/2487 (section 10). |
| "Phase 1 / Phase 2 / hardening NOT applied, NOT pushed" | **CONFIRMED** - those three commits are the undeployed ones. |

Lesson recorded for future sessions: never infer deployment state from the local
`origin/main` ref in a shallow clone; run `git ls-remote origin refs/heads/main`.

## 3. Work completed and verified (deployed)

Everything below is on the remote at `87a648e` and observable in production.

### 3.1 Private support bot - capabilities actually present

| Capability | Implementation | Evidence | Confidence |
|---|---|---|---|
| Webhook intake, fail-closed | `server.js:4739` `POST /api/telegram/webhook` -> `createTelegramWebhookHandler`; secret compared with `verifyTelegramWebhookSecret` (constant-time) | Production returns `401 {"ok":false,"error":"invalid_secret","secretProvided":false}` for an unsigned POST | VERIFIED |
| Webhook auto-registration on boot | `ensureWebhookRegistration({force:true})` in `services/TelegramSupportService.js:2943/2958`, scheduled after `listen()` | Code + AGENTS deployment notes | VERIFIED (code) |
| Secret/ID format validation | `isValidTelegramWebhookSecret` (441), `generateTelegramWebhookSecret` (452), `describeTelegramWebhookSecret` (472), `canonicalizeTelegramChatId` (346) | `tests/telegram_secret_format.test.js`, `tests/telegram_chat_id_canonicalization.test.js` | VERIFIED |
| `/start`, `/help` | `handleUserUpdate` 2178 / 2202; `FIRST_CONTACT_TEXT`, `USER_HELP_TEXT` | `tests/telegram_support_bot.test.js` (81 tests) | VERIFIED |
| Language selection en/pt/ar | `/language` 2218, inline keyboard `sendLanguagePicker` 1907, callback `handleLanguageCallback` 1937, persisted via migration 032 | `tests/telegram_multilingual.test.js`, `telegram_language_persistence.test.js` | VERIFIED |
| Human escalation | `/escalate` 2248 -> `notifySupport` 1497; `buildEscalationNotice` 929 | `tests/telegram_private_admin_notifications.test.js` | VERIFIED |
| Operator notifications | `notifySupport` 1497 fans out one DM per `TELEGRAM_ADMIN_IDS` entry; `TELEGRAM_NOTIFY_TARGET` defaults to `admins` (`resolveNotifyTarget` 557) | idem | VERIFIED |
| Operator replies | `/reply`, `/close`, `/chatid`, `/help` in `handleGroupUpdate` 2466; reply-to-notification threading via `threadMap` | idem | VERIFIED |
| Bot action status on notices | `NOTIFICATION_STATUS` / `resolveNotificationStatus` 2136 (`BOT REPLIED` / `HUMAN NEEDED` / `HUMAN REQUESTED` / `HUMAN CONVERSATION`) | `tests/telegram_bot_response_status.test.js` | VERIFIED |
| `/chatid` and `/id` from any group, answered privately | `routeUpdate` 672 -> kind `chatid`; `handleChatIdPrivate` 2425 | `tests/telegram_chatid_private.test.js` | VERIFIED |
| Storage-independent commands | `/start`, `/help`, `/chatid` reply without touching the database; storage failures raise 500 so Telegram retries | 2178-2247, `noteStorageFailure` 1631 | VERIFIED |
| AI-assisted answers | `createSupportAIServiceSafely` `server.js:4618`, `AI_SUPPORT_ENABLED` must be exactly `"true"`; default provider `knowledge` (offline, 39 approved entries across 16 categories in `services/support/arbitrix-knowledge.json`) | `tests/support_ai_service.test.js`, `support_ai_guardrails.test.js`, `support_knowledge.test.js` | VERIFIED (code); production flag UNKNOWN |
| Multilingual answer translation | `SupportTranslator` + `englishForRetrieval`; fidelity guard keeps numbers/links | `tests/support_translation_delivery.test.js`, `support_language_provenance.test.js` | VERIFIED (code); provider credential UNKNOWN |
| Delivery telemetry | `status()` 1373; `GET /api/telegram/status` `server.js:4814` (admin) returns the secret-free delivery trace | `tests/telegram_delivery_trace.test.js` | VERIFIED |
| Diagnostics | `scripts/diagnose-telegram.js`, `scripts/generate-telegram-secret.js` | `tests/telegram_diagnose.test.js` | VERIFIED |

Operational status: **live**. The bot is reachable, configured, and rejects
unsigned webhook calls. Whether `AI_SUPPORT_ENABLED` and a translation provider
credential are set in production is **UNKNOWN** (not observable without the host
environment).

### 3.2 Partner group - what is already deployed

Even though the publisher is inert, the **join handshake** is deployed:

- `routeUpdate` recognises `message.new_chat_members` before any text parsing and
  returns `kind: 'join'` with per-member `firstName` (672-745).
- `handleJoinUpdate` 2609 -> `services/MarketingOnboarding.js` `handleNewMembers`
  (~349) posts one welcome per service message, filters bots individually,
  personalises only when exactly one human joined, dedupes per
  `(chat, member, messageId)`, audits to `telegram_marketing_sends` when the
  store is available, and never throws into the webhook.
- `87a648e` fixed the mixed human+bot batch case.
- The welcome text and the 2x2 keyboard are rendered from
  `services/MarketingContent.js`; the four destinations default to the official
  URLs in `services/TelegramBroadcast.js:77-80`.

Activation gap: the join handshake **requires `TELEGRAM_MARKETING_CHAT_ID`**
(`MarketingOnboarding` `handleNewMembers` -> `validateDestination`), which is
**UNKNOWN** in production. Without it the welcome is skipped with
`marketing-group-not-configured`.

## 4. Work completed locally but not deployed

Four commits, all verified as absent from the remote:

### 4.1 `3c48065` - Phase 1: secure Telegram <-> account linking

- Migration `039_telegram_account_links.sql`: table `telegram_account_links`
  (pending rows hold a SHA-256 token hash + expiry; link rows hold chat/user ids),
  RPC `consume_telegram_link_token(TEXT,TEXT,TEXT)`.
- `services/TelegramAccountLinks.js` (334 lines) plus `server.js` routes
  `/api/telegram/link/start` (4754), `GET/DELETE /api/telegram/link`
  (4778/4798), all `authMiddleware`.
- Bot side: `/start lk_<token>` and `/unlink` -> `handleAccountLink` 2704, gated
  to private chats where `chat.id === from.id` (`accountLinkAction` 2660).
- **Fails closed without 039**: every endpoint returns
  `503 {"error":"Telegram linking is unavailable"}` (server.js 4767-4806).
- Tests: `tests/telegram_account_link.test.js` (1035 lines).

### 4.2 `1d934a6` - Phase 2: durable conversion events + Telegram outbox

- Migration `040_conversion_events.sql` (842 lines): `conversion_events`,
  `conversion_notifications`, capture triggers on `users`, `payment_invoices`,
  `deposits`, `referrals`; RPCs `conversion_record_event`,
  `conversion_claim_notifications`, `conversion_complete_notification`,
  `conversion_enqueue_pending_reminders`, `conversion_purge`,
  `conversion_user_is_sandbox`.
- `services/ConversionWorker.js` (484), `services/ConversionStore.js` (245),
  `services/conversion-i18n.js` (159), entrypoint `conversion-worker.js`.
- **Inert by default** (section 6).

### 4.3 `535c87c` - atomic legacy deposit credit + hardening

- Migration `041_legacy_deposit_atomic_credit.sql`: adds
  `deposits.credited`, `confirm_legacy_deposit_safe(BIGINT,BIGINT)`, replaces
  `conversion_capture_deposit()` to require the credit marker, adds
  `conversion_backfill_missing(INTEGER,INTEGER)`.
- `server.js` `confirmLegacyDepositAtomic()` + `confirmLegacyDeposit()`; admin
  deposit confirmation now credits -> ledger -> marker -> event in one
  transaction.
- Fixes a real race: previously the status flip could enqueue a
  "deposit confirmed" notification before the wallet was credited (reproduced in
  the pre-fix trigger body at `1d934a6`).

### 4.4 `9ec7caa` - approved welcome copy and Start Here refinement

- `services/MarketingContent.js` en/pt/ar: section 3 becomes
  "DISCOVER THE PARTNER PROGRAMME", `referralIntro` becomes the approved
  "After registering, log into your account and open the Referral page..."
  wording, and the duplicate referral step list is removed from the **welcome**
  (it remains in **Start Here**).
- Tests: `telegram_partner_welcome.test.js` (+63/-?), `telegram_welcome_personalisation.test.js`.

Consequence: the copy live in production today is the `e14e48e`/`c13c6c1`
version (personalised greeting, referral bullet), **not** the approved
`9ec7caa` wording. Posts published before deployment would need review after it.

---

## 5. Work deployed but disabled

These are on the remote and running in production, but inert by configuration.

### 5.1 Telegram marketing publisher (group + channel)

Deployed since `1d18765` / `e14e48e`; hardened in `87a648e`.

| Gate | Default | Where | Confidence |
|---|---|---|---|
| `TELEGRAM_MARKETING_ENABLED` | `false` (`boolFromEnv`) | `services/TelegramBroadcast.js` `resolveMarketingConfig` | VERIFIED (code) |
| `TELEGRAM_MARKETING_DRY_RUN` | `true` | idem | VERIFIED (code) |
| DB control row | `paused = TRUE, dry_run = TRUE` | `038_marketing_broadcast.sql:115-117` (`INSERT ... ON CONFLICT DO NOTHING`) | VERIFIED (code) / UNKNOWN (row state in production) |
| Worker process | not started by the web service | `marketing-worker.js`; no in-process start in `server.js`; no `render.yaml`/`Procfile` in repo | VERIFIED |

Behaviour when migration 038 is absent (checked in code, not just docs):
`GET /api/admin/marketing/status` returns `controlError: 'control-unreadable'`
and `control: null`; queueing endpoints return errors rather than a fake success;
`buildPostRow` never runs. The welcome/join path is unaffected because it does not
touch the queue.

### 5.2 AI support

`AI_SUPPORT_ENABLED` defaults to false; `createSupportAIServiceSafely`
(`server.js:4618`) returns `null` unless the value is exactly `"true"`. With no AI
the bot uses the pre-existing fixed answers, so behaviour is unchanged. Production
value **UNKNOWN**.

### 5.3 Support translation layer

`SUPPORT_TRANSLATION_ENABLED` defaults to `true`, but the layer reports itself
unavailable without a provider credential (`SUPPORT_TRANSLATION_ENABLED` +
`AI_SUPPORT_PROVIDER` + key). When unavailable, pt/ar customers receive localized
safe fallback text rather than English facts. Production credential **UNKNOWN**.

### 5.4 Trading worker (adjacent, for completeness)

`TRADING_WORKER_ENABLED` is unset and `worker.js` is inert; migrations 028/029 are
reported applied in `AGENTS.md` but that is **UNKNOWN** here. Not part of this
audit's change surface, listed only so the deployment checklist does not collide
with it.

## 6. Work partially implemented

| Capability | What exists | What is missing |
|---|---|---|
| Partner group welcome | Full join handshake, personalisation, bot filtering, dedupe, audit (`services/MarketingOnboarding.js`) | `TELEGRAM_MARKETING_CHAT_ID` not verified; the approved `9ec7caa` copy is not deployed |
| Start Here guide | `buildStartHereRow` (212), `POST /api/admin/marketing/start-here` (5198), manual pin route (5241, group only, `disable_notification: true`) | Requires 038 to queue; requires a human to call the API; no UI |
| Channel announcements | `audience: 'channel'`, separate `TELEGRAM_ANNOUNCEMENT_CHAT_ID`, approval statuses, guard, preview, delivery audit | Channel id not verified; no second-approver role; no channel-post ingestion |
| Approved content library | 7 weekly themes (`mon`..`sun`), `channelIntro`, `welcome`, `startHere` in en/pt/ar (`services/MarketingContent.js`) | No dedicated posts for Demo->Live conversion flow, deposit FAQ series, or partner success framing beyond the above |
| Admin controls | 10 admin routes (status, preview, posts CRUD-ish, sends, calendar seed, start-here, pin, control) | **No web UI at all** (`grep "admin/marketing" public/index.html` = 0). Every action is a manual API call |
| Operator notifications | Private DM fan-out, per-admin threading, status header | `TELEGRAM_ADMIN_IDS` contents **UNKNOWN**; each admin must have pressed `/start` |

## 7. Work not started

Genuinely absent from the repository (searched; no code, no migration, no test):

1. **Genuine arbitrage market observations.** `services/MarketOpportunities.js`
   is explicitly *simulated* metadata (bands 0.08-0.95% spread, `simulated: true`
   in the API response) used for the landing-page widget. There is no market-data
   feed, no exchange integration and no verified spread source. `ContentGuard`
   blocks presenting such data as a live signal.
2. **Verified trading / referral activity feed.** The conversion system captures
   only `registration`, `deposit_confirmed`, `referral_qualified` and
   `deposit_pending_reminder` (040:87). There is no trade or withdrawal event and
   no public activity feed. Deliberate: individual results must not be published.
3. **Leaderboards.** No table, query, template or test. `ContentGuard` marks
   aggregate user/trader/volume figures as `requiresApproval`
   ("requires verification against production data").
4. **Platform status / performance summaries.** No uptime, volume or
   performance aggregation and no publisher for one.
5. **Quiet hours / do-not-disturb windows.** No such concept in the worker or the
   queue schema.
6. **Group-wide mentions.** Telegram has no universal `@everyone` for ordinary
   groups; the code sends none (no `@channel`, no `mention` parse mode, no
   per-member DM broadcast). Any "notify everyone" idea needs `/subscribe`
   opt-in DMs or a pinned post, not a mention.
7. **Stale-`sending` recovery for the marketing queue.** See defect D2 (section 9).
8. **Marketing admin UI.** API-only today.
9. **Verified platform statistics** feeding public posts (the `MARKETING_FACTS`
   object only carries min deposit and referral percent).

## 8. Production configuration and feature-flag status

Environment values are not readable from this environment (no Render access, no
shell on the host). The table separates the code default from what can be proven.

| Variable | Code default | Production value | Evidence |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | - | **set** | INFERRED: the bot has been replying in production and the webhook is active |
| `TELEGRAM_WEBHOOK_SECRET` | - | **set** | VERIFIED: unsigned POST returns `401 invalid_secret`, not `503` |
| `TELEGRAM_WEBHOOK_AUTO_REGISTER` | `true` | UNKNOWN | - |
| `TELEGRAM_ADMIN_IDS` | empty | UNKNOWN | - |
| `TELEGRAM_NOTIFY_TARGET` | `admins` | UNKNOWN (defaults to admins) | code |
| `TELEGRAM_SUPPORT_CHAT_ID` | empty (legacy) | UNKNOWN | - |
| `TELEGRAM_BOT_USERNAME` | empty | UNKNOWN | - |
| `TELEGRAM_MARKETING_ENABLED` | `false` | UNKNOWN (must be unset/false for inert) | code default |
| `TELEGRAM_MARKETING_DRY_RUN` | `true` | UNKNOWN | code default |
| `TELEGRAM_MARKETING_CHAT_ID` | empty | UNKNOWN | - |
| `TELEGRAM_ANNOUNCEMENT_CHAT_ID` | empty | UNKNOWN | - |
| `TELEGRAM_MARKETING_TIMEZONE` | `UTC` | UNKNOWN | code default |
| `TELEGRAM_SUPPORT_USERNAME` | empty -> official default | UNKNOWN | code default |
| `TELEGRAM_PARTNER_SUPPORT_USERNAME` | empty -> official default | UNKNOWN | code default |
| `AI_SUPPORT_ENABLED` | `false` | UNKNOWN | code default |
| `AI_SUPPORT_PROVIDER` | `knowledge` | UNKNOWN | code default |
| `SUPPORT_TRANSLATION_ENABLED` | `true` (needs a provider) | UNKNOWN | code default |
| `CONVERSION_WORKER_ENABLED` | `false` | not deployed anyway | code |
| `CONVERSION_PENDING_REMINDERS_ENABLED` | `false` | not deployed | code |
| `CONVERSION_BACKFILL_ENABLED` | `true` | not deployed | code (records events only, sends nothing) |
| `PAYMENT_PROVIDER` | `nowpayments` (`PaymentService.js:79`) | UNKNOWN | relevant to defect D1 |
| `MIN_WITHDRAWAL_USD` (code const) | `700` | n/a (code) | `server.js` |

Hosting: **Render**, verified by the `x-render-origin-server: Render` response
header behind Cloudflare. There is **no** `render.yaml`, `Procfile`, `Dockerfile`,
`app.json` or CI workflow in the repository, so the service configuration is
dashboard-managed (**INFERRED**, consistent with the observed auto-deploy on push).

## 9. Database migrations and unresolved defects

### 9.1 The four migrations in scope

| # | File | Creates / alters | Depends on | Idempotent / self-check |
|---|---|---|---|---|
| 038 | `038_marketing_broadcast.sql` (332 lines) | tables `telegram_marketing_posts`, `telegram_marketing_subscriptions`, `telegram_marketing_control`, `telegram_marketing_sends`; RPCs `claim_marketing_posts`, `finish_marketing_post`, `block_marketing_post`; RLS on all four; control row seeded paused+dry-run | nothing new (`service_role`) | yes (`IF NOT EXISTS`, `DROP ... IF EXISTS`, `DO $$` self-check) |
| 039 | `039_telegram_account_links.sql` (274) | table `telegram_account_links`; RPC `consume_telegram_link_token(TEXT,TEXT,TEXT)` | `users` | yes |
| 040 | `040_conversion_events.sql` (842) | tables `conversion_events`, `conversion_notifications`; RPCs `conversion_record_event`, `conversion_user_is_sandbox`, `conversion_capture_registration/deposit/referral`, `conversion_claim_notifications`, `conversion_complete_notification`, `conversion_enqueue_pending_reminders`, `conversion_purge`; 4 triggers | `users.environment` (013), `payment_invoices.credited` (008) - both already in production | yes |
| 041 | `041_legacy_deposit_atomic_credit.sql` (488) | `deposits.credited` column; RPC `confirm_legacy_deposit_safe(BIGINT,BIGINT)`; replaces `conversion_capture_deposit()`; RPC `conversion_backfill_missing(INTEGER,INTEGER)` | **040** (`conversion_record_event`, `conversion_user_is_sandbox`, `conversion_events`) plus `deposits/wallets/transactions/payment_invoices` | yes |

### 9.2 Ordering constraint - the documented sequence is still correct

**038 -> 039 -> 040 + 041 together. VERIFIED** by reading the SQL:

- 041 `CREATE OR REPLACE`s `conversion_capture_deposit()`, which is defined in
  040, and calls `conversion_record_event`.
- 040's legacy branch reads `NEW.credited`, a column that only 041 creates.
  Applying 040 alone is harmless but silent: the trigger's `EXCEPTION WHEN OTHERS`
  handler logs a warning and no event is recorded, so legacy deposits would get no
  notification until 041 lands.
- 038 and 039 are independent of each other and of 040/041.

### 9.3 Applied status

**UNKNOWN.** Reasons, each verified:

- `$SUPABASE_URL` host (`jmhgreazilmmvuqnghgt.supabase.co`) does **not resolve**
  from this environment (`socket.gethostbyname` -> `gaierror`), so no metadata
  query is possible.
- The repository has no migration ledger and no runner: no `supabase/config.toml`,
  no `supabase db push` in code, no DDL in `server.js`.
- Nothing about the deployed build proves schema state: `87a648e` predates every
  migration in scope, and the code for 038/039 is inert/fail-closed without them.

Safe read-only verification (run in the Supabase SQL editor, changes nothing):

```sql
select
 (to_regclass('public.telegram_marketing_posts')  is not null) as m038_posts,
 (to_regclass('public.telegram_marketing_control') is not null) as m038_control,
 (to_regclass('public.telegram_account_links')    is not null) as m039_links,
 (to_regclass('public.conversion_events')         is not null) as m040_events,
 (to_regclass('public.conversion_notifications')  is not null) as m040_outbox,
 exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='deposits'
            and column_name='credited')                         as m041_marker,
 (to_regprocedure('public.confirm_legacy_deposit_safe(bigint,bigint)') is not null) as m041_rpc,
 exists (select 1 from pg_trigger where tgname='conversion_capture_deposit_legacy') as m040_trigger;

select paused, dry_run from public.telegram_marketing_control where id = 1;
```

### 9.4 Defect D1 - `confirm_payment_with_credit` never sets `credited = TRUE`

**STILL PRESENT. VERIFIED by reading the SQL.**

- Definition: `supabase/migrations/021_provider_referral_award_correctness.sql:267`
  (originally `002_payment_system.sql:110`). Its invoice update sets
  `status='confirmed', confirmed_at, credited_at, transaction_hash` but **not**
  `credited`.
- Reachability (CORRECTED 2026-10-28 - the route table decides this, not the
  provider list): `server.js:4139` (`/api/webhook/nowpayments`) and
  `server.js:4189` (`/api/webhook/:provider`) both call
  `paymentService.processWebhook` (413) -> `handleWebhookEvent` (556) ->
  `handlePaymentConfirmed` (585) -> `confirmPaymentAtomic` (615) ->
  `rpc('confirm_payment_with_credit')`. `/api/webhook/:provider` is registered
  BEFORE the dedicated `/api/webhook/paymento` route (4237) and calls `next()`
  only for `q8qpay`, so the Paymento-specific route is unreachable for
  `/api/webhook/paymento`; Paymento traffic enters the generic handler instead.
  There it fails signature verification, because the generic handler reads
  `x-signature` / `x-signature-256` while Paymento signs with
  `X-HMAC-SHA256-SIGNATURE`. The defective RPC is therefore genuinely reachable
  for **NOWPayments**, whose dedicated route reads `x-signature` - exactly the
  header that provider expects. `PAYMENT_PROVIDER` defaults to `nowpayments`
  (`PaymentService.js:79`).
- Impact: the 040 trigger requires `status='confirmed' AND credited=TRUE`
  (`conversion_capture_deposit`), so a deposit credited through this path produces
  **no** `deposit_confirmed` event and therefore no Telegram notification. It is a
  silent gap, never a false message; money is unaffected because the wallet credit
  happens before the invoice update in that function.
- Which provider is active in production is **UNKNOWN** (no public endpoint
  exposes `PAYMENT_PROVIDER` and the Render environment cannot be read from
  here), so the blast radius is **INFERRED**: NOWPayments - the default - hits
  the defect; q8qpay (`credit_payment_safe`, 008) sets `credited = TRUE`
  correctly; Paymento does not reach the path at all (see the header mismatch
  above).
- Behavioural proof (local PostgreSQL 16, 2026-10-28, migrations 038-041 applied,
  throwaway container - no production access): replaying this function's own
  invoice UPDATE against a pending invoice left `credited = f` and produced **0**
  rows in `conversion_events` for `deposit:invoice:<id>`; adding only
  `credited = TRUE` produced **1**. No money-path statement was involved.
- Minimal future fix (not applied): a new migration that re-creates
  `confirm_payment_with_credit` with `credited = TRUE` in the same UPDATE, or
  backticked via `credited = COALESCE(credited, TRUE)` semantics.

### 9.5 Defect D2 - marketing queue has no stale-`sending` reaper (NEW finding)

**VERIFIED.** `claim_marketing_posts` (038:181) only claims `status='scheduled'`
rows and moves them to `sending`. `finish_marketing_post` (038:218) is the only
way back, and it requires `status='sending'`. If the worker dies between claim and
finish, the row stays `sending` forever: `attempts` never advances and the post is
never retried. The conversion outbox does not have this problem - 040 adds
`lease_expires_at` and reclaims expired leases (040:478-520). A future fix would
add an equivalent lease or an "age out `sending` rows older than N minutes" clause
to `claim_marketing_posts`.

### 9.6 Previously documented issues - current status

| Issue | Status |
|---|---|
| `confirm_payment_with_credit` missing `credited` | **STILL PRESENT** (D1) |
| Conversion notifications depend on correctly credited deposits | **RESOLVED BY DESIGN** in 041: trigger requires `credited=TRUE`, backfill re-derives only `credited=TRUE` legacy rows (verified in `conversion_backfill_missing`) |
| Migration application status unverified | **REMAINS** - section 9.3 |
| Stale test counts in documentation | **REMAINS** - `AGENTS.md:7352` says 2517/2516; actual 2488/2487 (section 10) |
| Stale local `origin/main` ref | **NEW** - caused a 1-commit error in the previous audit; always `ls-remote` |

### 9.7 Financial-event integrations (what can reach a chat, and on what basis)

Capture happens in the database (migration 040), delivery in a separate worker.
Nothing here can move money: the triggers only INSERT an event row.

| Event | Source of truth (authority) | Trigger / condition | Dedupe key | Message? | Dedupe + retry | Privacy note |
|---|---|---|---|---|---|---|
| `registration` | `users` INSERT | `conversion_capture_registration` (040:289) | `registration:<user id>` | **No** - no template exists, and `MESSAGE_KEYS_BY_EVENT` omits it ("Unknown events are never sent"), so it is recorded only | unique event key; outbox only for sendable events | no personal data beyond the user id |
| `deposit_confirmed` | `payment_invoices` (`status='confirmed' AND credited=TRUE`) or legacy `deposits` (`status='confirmed' AND credited=TRUE` after 041) | `conversion_capture_deposit` (040:340+ and 041 replacement) | `deposit:invoice:<id>` / `deposit:legacy:<id>` | Yes, to the **user's own linked chat only** | unique event key; outbox claim with lease + backoff; `maxAgeMinutes` 1440 drops stale sends | amount optionally quoted; no address, tx hash, email or balance |
| `referral_qualified` | `referrals` row qualified (status/`bonus_earned`) | `conversion_capture_referral` (040:405+) | `referral:<referral id>` | Yes, to the **referrer's** linked chat | same outbox | quotes **no** reward amount; points at the Referral section |
| `deposit_pending_reminder` | `payment_invoices` still pending | `conversion_enqueue_pending_reminders` (040:~690) | `reminder:invoice:<id>:<n>` | Yes, **promotional** - opt-in only, includes `/unsubscribe` | capped by `CONVERSION_REMINDER_MAX_PER_DEPOSIT` (1), delayed by `CONVERSION_REMINDER_DELAY_MINUTES` (30) | gated by `CONVERSION_PENDING_REMINDERS_ENABLED` (default **false**) |
| withdrawal | - | **no trigger, no event, no template** | - | No | - | deliberately absent |
| trade / P&L | - | **no trigger, no event, no template** | - | No | - | deliberately absent: individual results must never be published |

Correctness properties that matter operationally:

1. **The finance path is never blocked.** Every capture function wraps its body in
   `EXCEPTION WHEN OTHERS` and returns `NEW`, so a broken notification pipeline
   cannot fail a deposit, a credit or a referral award.
2. **No false positives.** A deposit is only described as confirmed when the
   authoritative credit marker exists; `041` makes that marker the gate.
3. **Sandbox isolation.** `conversion_user_is_sandbox()` short-circuits every
   capture for MARKETING_SANDBOX users, so demos never notify.
4. **Recipients are explicit.** A message is only produced when a linked Telegram
   chat exists and (for promotional copy) the user opted in; there is no broadcast
   to non-consenting users.
5. **Public-post suitability.** All of the above are 1:1 transactional messages.
   None of them is suitable for a group or channel post, and none is routed there.

---

## 10. Test results

All commands were run read-only; no application code was changed to make
anything pass.

| Command | Result | Notes |
|---|---|---|
| `npm test` (130 test files) | **2488 tests, 2487 pass, 1 fail, 0 skipped**, exit 1 | Failure below |
| Telegram/marketing/support/conversion subset (43 files) | **1045 tests, 1045 pass, 0 fail**, exit 0 | The whole Telegram surface is green |
| `node --check` on `server.js`, `worker.js`, `marketing-worker.js`, `conversion-worker.js` + 11 services | all **OK** | Syntax only |
| `git ls-remote origin refs/heads/main` | `87a648e` | Establishes the real deployment base |

### The single failure (pre-existing, not caused by this branch)

`tests/how_it_works_video.test.js` -> "the served MP4 is a byte-identical copy of
the approved master (no re-encode)" fails because the `build/` master video was
never committed to the repository (only the served copy exists).

Proof it predates all Telegram work: a throwaway worktree at the **deployed
commit `87a648e`** runs the same file with the same result (9 tests, 8 pass, 1
fail). It is an environment/fixture issue, not a regression.

### Do the tests exercise real services?

No. The Telegram, marketing and conversion suites inject fakes:

- a fake/in-memory Supabase store (never a real database),
- a fake `fetch` transport (`createTelegramTransport({ token, fetchImpl })`),
- fake clocks and fake stores for the workers.

Evidence: no test references `api.telegram.org` or a live `SUPABASE_URL`; the only
match is an empty-string assignment in `marketing_bot_wiring.test.js`.

Consequence: **the SQL in 038/039/040/041 is not covered by the test suite.** The
tests assert migration text/structure and JS behaviour, not applied schema. That is
why section 9.3 matters.

## 11. Telegram group and channel configuration

### 11.1 What the code needs

| Requirement | Variable / action | Status |
|---|---|---|
| Bot token | `TELEGRAM_BOT_TOKEN` | set in production (INFERRED) |
| Webhook secret (charset `A-Za-z0-9_-`, 1-256 chars) | `TELEGRAM_WEBHOOK_SECRET` | set (VERIFIED: 401, not 503) |
| Operators | `TELEGRAM_ADMIN_IDS` (comma separated) | UNKNOWN |
| Notification target | `TELEGRAM_NOTIFY_TARGET` (`admins` default, `group` legacy) | UNKNOWN (defaults to admins) |
| Partner group | `TELEGRAM_MARKETING_CHAT_ID` | UNKNOWN - **required for the welcome** |
| Announcement channel | `TELEGRAM_ANNOUNCEMENT_CHAT_ID` | UNKNOWN - required for channel posts |
| Public channel URL | `TELEGRAM_ANNOUNCEMENT_CHANNEL_URL` or `..._USERNAME` | UNKNOWN |
| Support handles | `TELEGRAM_SUPPORT_USERNAME`, `TELEGRAM_PARTNER_SUPPORT_USERNAME` | UNKNOWN (official defaults) |
| Locale / timezone | `TELEGRAM_MARKETING_LOCALE` (en), `TELEGRAM_MARKETING_TIMEZONE` (UTC) | UNKNOWN |
| Bot rights | member of the group; **channel admin with post rights**; pin rights for Start Here | UNKNOWN |
| Admin DM precondition | every `TELEGRAM_ADMIN_IDS` entry must have sent `/start`, else Telegram 403 "bot can't initiate conversation" | UNKNOWN |

### 11.2 Discovering the ids

The bot answers `/chatid` or `/id` **privately** from any group where the sender is
an admin (`handleChatIdPrivate`, 2425; commit `750b8ba`). That is the safe way to
learn `TELEGRAM_MARKETING_CHAT_ID`. The channel id (`-100...`) must be read from
Telegram itself - the repository has no channel-id helper. INFERRED

### 11.3 Group-wide notifications

Telegram offers **no universal `@everyone`** for ordinary groups. The codebase
sends none and should not try. Mechanisms available, in order of politeness:

1. Pin the Start Here guide (`POST /api/admin/marketing/pin`, group only,
   `disable_notification: true`).
2. Scheduled group posts (Mon/Wed/Fri 09:00 by default) - visible, not pushy.
3. Opt-in DMs via `/subscribe` (`telegram_marketing_subscriptions`,
   `audience: 'subscribers'`, `/unsubscribe` recorded with `unsubscribed_at`).

## 12. Marketing automation capabilities and gaps

### 12.1 The twelve planned content workstreams

| # | Planned capability | Status | Evidence |
|---|---|---|---|
| 1 | New-member welcome and onboarding | **Implemented**, inert | `MarketingOnboarding.handleNewMembers`; `welcome` template; join route 2609 |
| 2 | Educational posts explaining arbitrage / the platform | **Partial** | `thu` theme ("WHAT ARBITRAGE MEANS HERE"), `channelIntro` |
| 3 | Demo Mode education -> Live conversion | **Partial** | `channelIntro`, `wed` FAQ theme; no dedicated funnel sequence |
| 4 | Genuine arbitrage market observations | **Not implemented** | `MarketOpportunities.js` is simulated; the guard blocks live-signal claims |
| 5 | Verified trading / referral activity updates | **Not implemented** (by design for individuals) | only registration/deposit/referral private events exist |
| 6 | Daily/weekly leaderboards | **Not implemented**; would need approval | `ContentGuard` review rule for aggregate figures |
| 7 | Partner -> trader education | **Partial** | `mon`, `fri` themes |
| 8 | Partner marketing guidance | **Implemented** | `tue` theme ("HOW TO DESCRIBE ARBITRIX ACCURATELY") |
| 9 | Deposit / trading FAQs | **Partial** | `wed` theme (6 Q&A) |
| 10 | Platform status / performance summaries | **Not implemented** | no aggregation, no publisher |
| 11 | Scheduled reminders / promotional campaigns | **Implemented**, disabled | `conversion_enqueue_pending_reminders` with `CONVERSION_PENDING_REMINDERS_ENABLED=false`; calendar seeding |
| 12 | Official announcements with approvals | **Implemented**, inert | queue statuses, guard, preview, channel audience |

### 12.2 The proposed schedule - what the code actually contains

`MarketingOnboarding.js:38-46` (`DEFAULT_SCHEDULE`):

| Day | Time | Audience | Theme |
|---|---|---|---|
| Mon | 09:00 | group | Partner programme - how it works |
| Wed | 09:00 | group | Common questions |
| Fri | 09:00 | group | Partner checklist |
| Tue | 18:00 | channel | Describe Arbitrix accurately |
| Thu | 18:00 | channel | What arbitrage means here |
| Sat | 18:00 | channel | Staying safe |
| Sun | 18:00 | channel | Weekend closer |

Close to, but not identical with, "morning engagement / evening educational /
midweek partner education / weekend campaign". The schedule is **proposed, not
authorised**: `calendar/seed` only writes rows, and rows stay `scheduled` until an
operator unpauses. Times are interpreted in `TELEGRAM_MARKETING_TIMEZONE` (default
UTC) via `nextSlot` / `localParts`.

### 12.3 Safety and reliability features - implemented vs missing

| Requirement | Implemented? | Detail |
|---|---|---|
| Daily/weekly schedule | Yes | `DEFAULT_SCHEDULE`, `nextSlot`, `buildCalendarRows` (idempotent dated keys) |
| Timezone handling | Yes | `TELEGRAM_MARKETING_TIMEZONE`; `localDateKey` in idempotency keys |
| Duplicate-post prevention | Yes | `idempotency_key UNIQUE` (038:37) + dated keys + `FOR UPDATE SKIP LOCKED` claim |
| Restart recovery | **Partial** | scheduled rows survive restarts; a row stuck in `sending` after a crash is **never** reclaimed (D2) |
| Retry handling | Yes | `attempts`/`max_attempts`; `finish_marketing_post` re-schedules with backoff (60s..1h) and honours `retry_after` (429) |
| Telegram rate limits | Yes | per-chat limiter 15/min (`createRateLimiter`, `TelegramBroadcast.js:162`), `retryAfterMs` |
| Quiet hours | **No** | no concept anywhere |
| Frequency limits | **Partial** | marketing 15/min per chat; conversion `CONVERSION_MIN_SEND_INTERVAL_MS` (1000), `maxAgeMinutes` 1440 |
| Admin-only configuration | Yes | 10 routes behind `authMiddleware + adminMiddleware`; chat ids never accepted from the client (`chatIdForAudience` resolves from config) |
| Preview / dry-run | Yes | `POST /api/admin/marketing/preview` is side-effect free; `dry_run` skips claiming and reports `dueNow` |
| Pause / resume | Yes | DB control row + `POST /api/admin/marketing/control` (booleans only) |
| Delivery history / failure reporting | Yes | `telegram_marketing_sends` audit, `last_error`, `GET /api/admin/marketing/sends`, worker JSON logs |
| Manual pinning | Yes | group only, `disable_notification: true`, requires a published message id |

## 13. Security, privacy and operational risks

| # | Risk | Severity | Detail / mitigation |
|---|---|---|---|
| R1 | Credential embedded in the `.git/config` remote URL (`ghu_...`) | Medium | Reported dead; never echo it; push with `GITHUB_TOKEN` in an ephemeral URL and avoid persisting it |
| R2 | Stale `origin/main` ref in a shallow clone | Medium | Already caused a deployment-status error in the previous audit; always `git ls-remote origin refs/heads/main` |
| R3 | Schema state unverifiable from here | **High** | 038-041 status UNKNOWN; applying 040 alone silently suppresses legacy deposit notifications |
| R4 | D1 - `confirm_payment_with_credit` omits `credited` | Medium | Silent missing notifications on the NOWPayments/generic path; no false message, no money impact |
| R5 | D2 - orphaned `sending` posts | Medium | A crash can permanently strand a post; the row must be reset manually |
| R6 | Webhook secret charset fragility | Medium | A non-conforming secret makes `setWebhook` fail and the bot goes mute; mitigated by `isValidTelegramWebhookSecret`, the boot log and `scripts/generate-telegram-secret.js`, not prevented |
| R7 | Deposit amounts in notifications | Low | `depositConfirmed` includes `{{amount}}`; no env toggle to suppress it. Recipient is the customer's own linked chat |
| R8 | Operator notices carry the customer's chat id and verbatim text | Low / internal | Correct for support; treat admin DMs as personal data - there is no redaction layer |
| R9 | Third-party data sharing if AI/translation is enabled | Medium | Customer text goes to the configured provider; `SUPPORT_TRANSLATION_ENABLED=false` is the kill switch |
| R10 | Content guard is regex-based | Medium | Accurate for known phrasings, cannot prove absence of novel claims; `requiresApproval` is the backstop, so a human must review flagged copy |
| R11 | No admin UI | Medium | Every action is a manual API call; a wrong body is one typo away. Always preview first |
| R12 | Content drift after a copy change | Low | Posts queued under the old copy remain; re-preview after deploying `9ec7caa` |
| R13 | Subscriber data | Low | `telegram_marketing_subscriptions` holds chat ids with `unsubscribed_at`; no export/erasure tooling |
| R14 | 038 seeds `paused + dry_run` with `ON CONFLICT DO NOTHING` | Low | If the row pre-exists with permissive values a re-apply will not reset it - always read the row (9.3) |

Privacy controls that must hold before any aggregate or individual-results content
is published (currently satisfied by *not* publishing such content):

1. No per-user financial detail in any group or channel post.
2. Aggregate figures (users, volume, win rate, payouts) must be computed from
   production data and pass human approval - enforced as `requiresApproval`.
3. No names, usernames, countries or testimonials without verifiable consent.
4. Never present simulated data (`MarketOpportunities`) as live.
5. Demo results are never described as real profits.

## 14. Recommended implementation order

Each step is independently reversible. None of them is authorised by this audit.

**Step 0 - ground truth (read-only).** `git ls-remote origin refs/heads/main` and
the section 9.3 SQL.

**Step 1 - close the documentation gaps.** Correct `AGENTS.md:7352` (2517 ->
2488) and record this audit. No deploy.

**Step 2 - deploy the four undeployed commits** (`3c48065`, `1d934a6`, `535c87c`,
`9ec7caa`) as a fast-forward. Safe without migrations: Phase 1 endpoints answer
503, the conversion worker is off, and the marketing copy change is inert. This is
what puts the approved welcome wording live.

**Step 3 - apply migrations** `038` -> `039` -> then `040` and `041` **in one
batch**. Re-run the verification SQL; confirm the control row is
`paused = true, dry_run = true`.

**Step 4 - configure the partner group.** Set `TELEGRAM_MARKETING_CHAT_ID`
(discovered with `/chatid`), confirm the bot is a member, confirm every admin has
pressed `/start`. The welcome handshake goes live here - it does not need 038.

**Step 5 - configure the channel.** Set `TELEGRAM_ANNOUNCEMENT_CHAT_ID` (and the
public URL) and make the bot a channel admin with post rights.

**Step 6 - rehearse in dry run.** Preview `welcome`, `startHere`, `channelIntro`
and a weekly theme in en/pt/ar; read the guard result; seed the calendar; queue
Start Here; send it; pin it manually.

**Step 7 - enable publishing** (a separate, explicit decision):
`TELEGRAM_MARKETING_ENABLED=true`, `POST .../control {"paused":false,"dryRun":false}`,
`TELEGRAM_MARKETING_DRY_RUN=false`, and run `node marketing-worker.js` as its own
Background Worker.

**Step 8 - enable conversion notifications** (last, separately):
`CONVERSION_WORKER_ENABLED=true` on its own Background Worker with `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`. Leave
`CONVERSION_PENDING_REMINDERS_ENABLED=false`. Requires Phase 1 linking to be live
so recipients exist.

**Step 9 - follow-up defects.** D1 (`credited` marker), D2 (queue lease), optional
quiet hours, optional admin UI.

## 15. Exact next commands and manual actions

Nothing below was executed; several are production-changing.

### 15.1 Verify (safe, read-only)

```bash
git ls-remote origin refs/heads/main     # expect 87a648e today
git log --oneline 87a648e..HEAD          # expect the 4 undeployed commits
npm test                                 # expect 2487 pass / 1 known fail
```

Then run the SQL from section 9.3 in the Supabase SQL editor.

### 15.2 Deploy the code (fast-forward only)

```bash
# only after confirming the remote is still 87a648e and tests are green
git push https://${GITHUB_TOKEN}@github.com/nuraabdullahi708090-sudo/arbitrix-app.git main:main
```

Render auto-deploys on push (~1 minute). Never force, rebase, amend or reset.

### 15.3 Apply migrations (this order)

```
supabase/migrations/038_marketing_broadcast.sql
supabase/migrations/039_telegram_account_links.sql
supabase/migrations/040_conversion_events.sql        \
supabase/migrations/041_legacy_deposit_atomic_credit.sql  / same batch
```

Paste each into the Supabase SQL editor (the repo has no `supabase/config.toml`, so
`supabase db push` would need `supabase link` first). Each file is idempotent and
self-checking; a failure rolls itself back. Re-run 9.3 afterwards.

### 15.4 Environment variables (Render dashboard)

```
TELEGRAM_MARKETING_CHAT_ID=-100xxxxxxxxxx      # partner group
TELEGRAM_ANNOUNCEMENT_CHAT_ID=-100xxxxxxxxxx   # channel
TELEGRAM_ANNOUNCEMENT_CHANNEL_URL=https://t.me/<channel>
TELEGRAM_SUPPORT_USERNAME=@ArbitrixSupportBot
TELEGRAM_PARTNER_SUPPORT_USERNAME=@Arbitrix_CSA1
TELEGRAM_MARKETING_LOCALE=en
TELEGRAM_MARKETING_TIMEZONE=UTC
# later, deliberately:
# TELEGRAM_MARKETING_ENABLED=true
# TELEGRAM_MARKETING_DRY_RUN=false
# CONVERSION_WORKER_ENABLED=true
```

Never set `CONVERSION_PENDING_REMINDERS_ENABLED=true` without a content review.

### 15.5 Operator steps inside Telegram

1. Add @ArbitrixSupportBot to the partner group; run `/chatid` there as an admin;
   copy the id into `TELEGRAM_MARKETING_CHAT_ID`.
2. Add it to the channel as an administrator with "Post messages" (and "Pin
   messages" if Start Here will be pinned).
3. Have every operator press `/start` in a private chat with the bot, otherwise
   their notifications fail with 403.

### 15.6 Rehearsal calls (need an admin JWT)

```bash
TOKEN=<admin jwt>; API=https://arbitrix.pro
curl -s -H "Authorization: Bearer $TOKEN" $API/api/admin/marketing/status
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"kind":"welcome","locale":"en"}' $API/api/admin/marketing/preview
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"weeks":2}' $API/api/admin/marketing/calendar/seed
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"locale":"en"}' $API/api/admin/marketing/start-here
```

Repeat the preview for `startHere`, `channelIntro` and a weekly theme.

### 15.7 Enabling, pausing and rolling back

```bash
# enable (three gates)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"paused":false,"dryRun":false}' $API/api/admin/marketing/control
# pause immediately (no deploy needed)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"paused":true,"dryRun":true}' $API/api/admin/marketing/control
```

Rollback ladder: pause the control row -> `TELEGRAM_MARKETING_ENABLED=false` ->
stop the background worker -> `git revert` the deploy commit (Render redeploys).
Migrations are additive; rollback means stopping use, not dropping tables.

### 15.8 Diagnostics

```bash
node scripts/diagnose-telegram.js          # in the Render shell: token/webhook/storage facts, no secrets
node scripts/generate-telegram-secret.js   # compliant secret if the current one is rejected
```

---

## 16. Database readiness verification (2026-10-28)

### 16.1 The script

`docs/sql/telegram_db_readiness.sql` - 631 lines, SELECT-only, no DDL/DML, safe to
run repeatedly on production. It verifies, against the migrations' own definitions:

| Section | What it proves |
|---|---|
| 1-2 | prerequisite tables exist, plus `users.environment` (013) and `payment_invoices.credited` (006) |
| 3a/3b | every column 038, 039, 040 and 041 create - including `deposits.credited` |
| 4 | exact function signatures via `to_regprocedure()` + `SECURITY DEFINER` present |
| 5 | the four 040 triggers exist and are enabled |
| 6 | the indexes, with the UNIQUE ones asserted as unique |
| 7 | status/locale/audience CHECK constraints and the uniqueness anchors (`idempotency_key`, `dedupe_key`, notifications key) |
| 8 | RLS enabled, exactly one `service_role` policy, zero anon/authenticated/public policies |
| 9 | the RPCs are not executable by `anon`/`authenticated` |
| 10 | the marketing control row exists and is paused + dry-run (a live publisher shows as REVIEW) |
| 11 | queue volumes by status (counts only) |
| 12 | orphaned work: marketing rows stuck in `sending`, conversion notices with an expired lease |
| 13 | defect D1 impact: confirmed invoices whose `credited` marker was never set |
| 14 | verdict per migration: APPLIED / PARTIAL / NOT APPLIED + the required next action |

Design note: sections 10-13 read their tables through `query_to_xml('select ...')`,
so the file still parses and runs on a database where 038-041 have never been
applied. That is what makes it usable as a *pre-deployment* check.

### 16.2 Validated against real PostgreSQL 16.15 (throwaway Docker container, removed)

Three states were executed end to end - the script itself, and the migrations:

| Scenario | Script result | Verdict row |
|---|---|---|
| Prerequisites only (no 038-041) | exit 0, 140 MISSING, **0 SQL errors** | all NOT APPLIED; action "Apply 038, then 039, then 040 + 041 together" |
| 038 + 039 + 040, no 041 | exit 0, 5 non-OK rows (`deposits.credited`, `confirm_legacy_deposit_safe`, `conversion_backfill_missing` + grants) | 040 APPLIED, 041 NOT APPLIED; action "Apply 041 now (040 alone suppresses legacy deposit events)" |
| 038 -> 039 -> (040 + 041 in ONE transaction) | exit 0, **162 OK, 0 MISSING/DRIFT** | all four APPLIED; action "No migration work required for 038-041" |

The migrations applied cleanly in that order and their own self-checks passed
(`conversion_events: schema, RLS and capture triggers verified`;
`legacy deposit integrity: marker, atomic RPC, trigger guard and backfill verified`).
Two corrections to an earlier draft of the script came out of this run: the real
constraint is `conversion_events_type_check` (not `..._event_type_check`), and the
notifications uniqueness anchor is `conversion_notifications_key_key`.

### 16.3 What still prevents verification of PRODUCTION

**Nothing in the repository and nothing in this environment can confirm the
production state.** Specifically:

1. The Supabase host in `SUPABASE_URL` does not resolve from this sandbox, so no
   query - not even a read-only one - can be executed against it.
2. The repository has no migration ledger and no runner (`supabase/config.toml`
   absent), so "which migrations are applied" is not recorded anywhere in Git.
3. There is no public endpoint that reports schema state, and adding one would
   widen the production surface.
4. `ADMIN_JWT` is expired (`401 Invalid token`), so even the authenticated
   admin surfaces are closed to this environment.

**The script is therefore the verification instrument; it has to be run by an
operator** (Supabase SQL editor). Expected output for a fully migrated database is
"162 OK / 0 problems / all four APPLIED".

## 17. Defect D1 - payment-crediting analysis (2026-10-28)

### 17.1 Is it reachable through the configured provider path?

**YES - for NOWPayments, the default provider.** The decisive factor is route
registration order, not the provider list:

| Route | Line | Reaches `confirm_payment_with_credit`? |
|---|---|---|
| `/api/webhook/nowpayments` | 4139 | **YES** - reads `x-signature`, which is what the provider's `verifyWebhook` expects |
| `/api/webhook/:provider` | 4189 | YES for any provider that is not `q8qpay` - it `next()`s only for q8qpay |
| `/api/webhook/paymento` | 4237 | **unreachable** - shadowed by 4189; and Paymento traffic that does arrive there fails signature verification (generic reads `x-signature`, Paymento signs with `X-HMAC-SHA256-SIGNATURE`) |
| `/api/webhook/q8qpay` | 4381 | NO - dedicated route calls `credit_payment_safe`, which is correct |

So the schema-level claim "q8qpay and Paymento both set `credited`" was
**incomplete**: `paymento_credit_user_safe` does set it, but that function is not
reachable from the webhook route. The live exposure is NOWPayments.

Which provider production actually runs is UNKNOWN from here (no endpoint exposes
`PAYMENT_PROVIDER`, Render env unreadable). Defaults to `nowpayments`.

### 17.2 Can the missing assignment suppress notifications?

**YES - proven, not inferred.** On local PostgreSQL 16 with 038-041 applied,
replaying this function's own invoice UPDATE against a pending invoice:

| Step | `credited` | `conversion_events` rows for `deposit:invoice:<id>` |
|---|---|---|
| UPDATE exactly as `confirm_payment_with_credit` writes it | `f` | **0** |
| same row, then `credited = TRUE` (what `credit_payment_safe` does) | `t` | **1** |

Cause: the 040 trigger fires on `UPDATE OF status, credited` and returns early
unless `COALESCE(NEW.credited, FALSE)`, so a bare status flip records nothing.
`ConversionWorker` re-checks `credited !== true` before sending (306, 315), so the
suppression holds a second time by design. The failure mode is silent absence -
never a false "deposit received" message.

### 17.3 Are wallet balances and ledger entries correct?

**YES.** `confirm_payment_with_credit` runs entirely inside one PL/pgSQL function,
i.e. one transaction:

1. idempotency: `status='pending' ... FOR UPDATE` + optional duplicate
   `transaction_hash` check;
2. wallet row locked (`FOR UPDATE`), credited (`live_balance + amount`) or created;
3. invoice updated to `confirmed` (the step missing `credited`);
4. `transactions` row inserted (`type='Deposit'`, signed amount);
5. referral qualification delegated to `award_referral_qualification_safe()`
   wrapped in its own `EXCEPTION` block with a `RAISE WARNING`.

Any failure rolls the whole thing back, so a wallet can never be credited without
its ledger row appearing. The defect is confined to the audit marker.

Two real but non-monetary consequences worth recording:

- `is_first_deposit` in the return value is computed as "no confirmed invoices for
  this user", but the loop does not count the row being confirmed, so the value
  reported to the caller is only advisory.
- `credit_payment_safe` counts first deposits with `credited = TRUE` (008:155).
  After a NOWPayments credit (marker false), a later q8qpay deposit would also be
  seen as a "first" deposit there. **No double referral reward results**, because
  the award is gated on the `referrals` row still being `pending` (row-locked,
  `GET DIAGNOSTICS`), not on that count.

### 17.4 Minimal fix - IMPLEMENTED in `042_confirm_payment_credit_marker.sql` (not applied)

`supabase/migrations/042_confirm_payment_credit_marker.sql` (250 lines, written
2026-10-28, **NOT applied to production**):

- `CREATE OR REPLACE FUNCTION public.confirm_payment_with_credit(...)` copied from
  021 **byte-identically except one line** added to the invoice UPDATE:
  `credited = TRUE,` immediately after `status = 'confirmed',`. Verified by
  `tests/migration_042_payment_credit_marker.test.js`, which diffs the two
  function bodies line by line and requires exactly one inserted line;
- the whole file is one `DO $migration$ ... $migration$;` block, so a failed
  self-check rolls the function back;
- preconditions: `payment_invoices`, `wallets`, `transactions`,
  `payment_invoices.credited` (006) and `award_referral_qualification_safe`
  (021). It REFUSES to run without 021 rather than silently upgrading the
  retired flat-reward logic;
- `REVOKE`/`GRANT` restored to `service_role` only (role-guarded, so it also runs
  on a plain PostgreSQL without Supabase roles);
- **no backfill.** Historical invoices keep `credited = false`; retroactively
  setting it would emit notifications for old deposits. `conversion_backfill_missing`
  (041) is deliberately limited to the legacy `deposits` table;
- deliberately unchanged: idempotency, the wallet/ledger writes, the referral call,
  the return shape, `PaymentService`, `server.js`.

Risk: minimal. The added assignment does not participate in any idempotency check
in this function (it keys on `status='pending'`), and it makes the marker agree
with the `credited: true` the function already returns in JSON.

### 17.5 Tests that prove the fix (written; behavioural run done on PostgreSQL 16)

1. **Source test** (fast, CI-safe, no database): the 042 body differs from the 021
   body by exactly the `credited = TRUE,` line - same technique as
   `tests/referral_provider_award.test.js`, which already proves "only the referral
   block changed" for four functions.
2. **Behavioural test against a real PostgreSQL** (the pattern used for 038-041
   above): call `confirm_payment_with_credit` on a pending invoice and assert
   `credited = TRUE`, `live_balance` credited once, exactly one `transactions`
   row, and exactly one `conversion_events` row for `deposit:invoice:<id>`;
   call it twice and assert the second call raises "Invoice not found or already
   processed" with no second credit and no second event.
3. **Regression pin**: `credit_payment_safe` and `paymento_credit_user_safe`
   still set `credited = TRUE` (unchanged files).
4. **Idempotency pin**: the 042 function still keys on `status='pending'` and the
   `transaction_hash` duplicate check - i.e. adding the marker did not become the
   idempotency mechanism.

---

## 18. Deployment checklist for the four pending commits (2026-10-28)

> **Updated 2026-10-28 (later the same day):** two migrations were added after this
> checklist was written - `042_confirm_payment_credit_marker.sql` (fixes D1, section 17)
> and `043_marketing_claim_lease.sql` (fixes the queue claim leak, section 19). They are
> part of the same release and must be applied after 041. Their commands, ordering rules
> (043 drops the old RPC signatures), verification queries and per-migration rollback are
> in **section 21**. The readiness script now verifies them too.

**Scope verified this session:** `git ls-remote origin refs/heads/main` =
`87a648e`; `HEAD` = `9ec7caa`; `rev-list --left-right --count 87a648e...HEAD` =
`0 4`. The range is these four commits, and nothing else:

| Commit | Subject | Touches |
|---|---|---|
| `3c48065` | securely link an Arbitrix account to Telegram (Phase 1) | `server.js` (+3 routes), `services/TelegramAccountLinks.js` (new), migration 039, tests |
| `1d934a6` | durable conversion events and a Telegram delivery outbox (Phase 2) | migration 040, `services/Conversion*.js`, `conversion-worker.js`, tests |
| `535c87c` | credit legacy deposits atomically before the conversion event | migration 041, `server.js`, tests |
| `9ec7caa` | refine the partner welcome copy and Start Here guide | `services/MarketingContent.js` + tests (copy only) |

### 18.1 Preconditions

- [ ] `npm test` green except the known video-master fixture failure (2488 / 2487 / 1).
- [ ] Working tree clean apart from documentation (`docs/`).
- [ ] Remote confirmed still at `87a648e` immediately before the push.
- [ ] Section 16 script run against production; its verdict recorded in the change log.
- [ ] A support/rollback window agreed (this deploy touches deposit notification,
      not deposit money).

### 18.2 Migration dependencies (must be applied in this order)

```
038_marketing_broadcast.sql        (independent)
039_telegram_account_links.sql     (needs users)
040_conversion_events.sql   \
041_legacy_deposit_atomic_credit.sql  /  SAME transaction, same sitting
```

040 alone is a **hazard**: its legacy-deposit trigger requires `deposits.credited`
which only 041 adds, so in the 040-without-041 window a legacy deposit confirmation
records no event. Verified live (section 16.2, middle row). Apply 040 and 041
together with `psql -1 -f 040 -f 041` (or paste them into one SQL-editor run
wrapped in `begin; ... commit;`).

Also verify (section 16) that the prerequisites exist: `users.environment` from
013 and `payment_invoices.credited` from 006.

### 18.3 Environment variables

Required for the code to activate at all:

| Variable | Used by | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | both workers | already set in production (the web app runs) |
| `TELEGRAM_BOT_TOKEN` | conversion worker | already set (support bot runs) |
| `TELEGRAM_ADMIN_IDS` | support bot, notifications | already set |
| `TELEGRAM_MARKETING_CHAT_ID` | onboarding + group posts | **unset/unverified** - the documented blocker |
| `TELEGRAM_ANNOUNCEMENT_CHAT_ID` | channel posts | optional until channel content is queued |

Optional, safe to leave unset: `TELEGRAM_MARKETING_LOCALE` (default `en`),
`TELEGRAM_MARKETING_TIMEZONE`, `TELEGRAM_MARKETING_TICK_MS`,
`TELEGRAM_MARKETING_REGISTER_URL`, `TELEGRAM_MARKETING_HOW_IT_WORKS_URL`,
`TELEGRAM_ANNOUNCEMENT_CHANNEL_URL`, `TELEGRAM_ANNOUNCEMENT_CHANNEL_USERNAME`,
`MARKETING_FACT_MIN_DEPOSIT` / `_REFERRAL_PERCENT` / `_PROMO_CREDIT`,
`CONVERSION_TICK_MS`, `CONVERSION_PURGE_*`, `CONVERSION_WORKER_ID`,
`TELEGRAM_MARKETING_WORKER_ID`.

### 18.4 Flags that MUST stay off through this deployment

| Flag | Required during deploy | Why |
|---|---|---|
| `TELEGRAM_MARKETING_ENABLED` | **unset / false** | publishing engine stays inert |
| `TELEGRAM_MARKETING_DRY_RUN` | **true** (default) | second gate for the same engine |
| DB control row `paused`, `dry_run` | **true, true** | third gate; `block` query in section 10 |
| `CONVERSION_WORKER_ENABLED` | **false** | no notification worker until linking is proven live |
| `CONVERSION_PENDING_REMINDERS_ENABLED` | **false** | promotional path, not part of this deployment |
| `TRADING_WORKER_ENABLED` | unchanged (off) | unrelated, out of scope |

Deploying the code with all of these off changes only two user-visible things: the
partner welcome copy (`9ec7caa`, if the group id is configured) and the availability
of the `/api/telegram/link` endpoints that answer `503` until migration 039 is
applied.

### 18.5 Background workers

No new worker is required *for this deployment*. The two existing optional workers
stay in their current state:

- `marketing-worker.js` - not started (`TELEGRAM_MARKETING_ENABLED` unset).
- `conversion-worker.js` - not started (`CONVERSION_WORKER_ENABLED` unset).

When they are eventually enabled, each needs its own Render Background Worker with
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`; the web service does
not run them, and neither process is spawned by `server.js`.

### 18.6 Tests

- [ ] `npm test` (full) - expect 2488 / 2487 pass, 1 known video-master failure.
- [ ] Telegram subset (`tests/telegram_*`, `tests/support_*`, `tests/marketing_*`,
      `tests/conversion_*`, `tests/partner_*`) - expect 100% pass.
- [ ] `node --check` on `server.js`, `conversion-worker.js`, `marketing-worker.js`,
      `services/*.js`.
- [ ] Section 16 SQL script on a **staging** database after applying 038-041:
      expect 162 OK / 0 problems.

### 18.7 Post-deployment verification (in this order)

1. `GET /api/health` -> `{"status":"ok"}`; `GET /` and `/partners` -> 200.
2. Run the section 16 script: verdict must read all four APPLIED and
   "No migration work required for 038-041"; control row `paused=true, dry_run=true`.
3. `POST /api/telegram/webhook` with no secret -> `401 invalid_secret` (unchanged).
4. `GET /api/telegram/link?token=probe` -> must now answer a JSON error (400-class),
   **not** the SPA HTML. HTML means the Phase 1 route is not in the running build.
5. `GET /api/admin/marketing/status` with an admin JWT -> 200 with
   `paused: true`, `dryRun: true`, and the queue counts from section 11.
6. Send `/start` to the support bot -> reply (proves the bot is healthy).
7. Group welcome: post a test join in the partner group (or add/remove a test
   account) and confirm the new approved copy renders with the four buttons.
   Requires `TELEGRAM_MARKETING_CHAT_ID`; without it the handshake stays silent.
8. Money smoke test in a controlled way: one real minimum deposit through the active
   provider, then confirm (a) the balance and ledger row, (b) with D1 unfixed and
   the conversion worker still off, that no crash occurs. Do **not** enable the
   conversion worker for this check.

### 18.8 Rollback

| Situation | Action | Blast radius |
|---|---|---|
| Bad copy or button URL | `git revert 9ec7caa` | welcome text only |
| Phase 1 misbehaves | `git revert 3c48065` | link endpoints disappear; no data loss |
| Conversion capture wrong | stop the worker (already off) then `git revert 1d934a6` | events stop being recorded; no money impact |
| 041 problems | revert the commit; the `deposits.credited` column and the RPC stay (additive) | legacy deposit credit returns to the old path |
| Migrations must be undone | `drop` the five tables + `drop column deposits.credited` (see 038/039/040/041 headers for the exact teardown) | only after the code is reverted, and only if no data must be kept |
| Publishing or messaging goes wrong | set the control row `paused=true, dry_run=true` | instant, no deploy needed |

Never force-push, rebase, amend or reset `main`; Render auto-deploys on push.

### 18.9 Residual risks accepted by deploying

1. **D1 stays open** unless 042 ships with it: NOWPayments deposits credit money
   correctly but emit no notification. Silent, never false.
2. **D2 stays open**: a crashed marketing worker orphans a `sending` post
   (section 19).
3. The group welcome remains gated on `TELEGRAM_MARKETING_CHAT_ID`; deploy does not
   set it.
4. Phase 1/Phase 2 are dead code without 039/040; if the migrations are skipped the
   endpoints answer 503 and the worker exits, which is the designed safe direction.

---

## 19. Marketing queue recovery - recommendation (design only, NOT implemented)

### 19.1 The defect, precisely

`claim_marketing_posts` (`038:186-215`) selects only:

```sql
WHERE p.status = 'scheduled' AND p.scheduled_for IS NOT NULL
  AND p.scheduled_for <= COALESCE(p_now, now()) AND p.attempts < p.max_attempts
```

There is no branch for `status = 'sending'`, and the table has no `claimed_by`,
`lease_expires_at` or `last_attempt_at` column. `finish_marketing_post` only acts on
a row that is still `sending`. Consequence: if the worker dies between claiming and
finishing (crash, OOM, deploy, Render restart, a hung Telegram call), the row stays
`sending` forever, is never claimed again, and its content is never published or
failed. Nothing in the system notices. Section 12 of the SQL script is the only
thing that will show them (`status='sending'` older than 10 minutes).

The conversion outbox (040) already solved exactly this shape of problem - it is
the model to copy, not invent.

### 19.2 The change - IMPLEMENTED in `043_marketing_claim_lease.sql` (not applied)

**Columns on `telegram_marketing_posts`** (mirroring `conversion_notifications`):

```
claimed_by        TEXT
lease_expires_at  TIMESTAMPTZ
last_attempt_at   TIMESTAMPTZ
```

plus `CREATE INDEX IF NOT EXISTS telegram_marketing_posts_lease_idx
ON public.telegram_marketing_posts (lease_expires_at) WHERE status = 'sending';`

**`claim_marketing_posts(p_now, p_limit, p_worker_id TEXT DEFAULT NULL,
p_lease_seconds INTEGER DEFAULT 180)`** - the two new parameters default, so the
existing call site keeps compiling; clamp the lease the way 040 does
(`LEAST(GREATEST(...,30),900)`). Add the reclaim branch:

```sql
   OR (p.status = 'sending'
       AND (p.lease_expires_at IS NULL OR p.lease_expires_at < COALESCE(p_now, now()))
       AND p.attempts < p.max_attempts)
```

and set, in the UPDATE: `claimed_by = COALESCE(NULLIF(p_worker_id,''),'worker')`,
`lease_expires_at = COALESCE(p_now, now()) + make_interval(secs => v_lease)`,
`last_attempt_at = now()`. `FOR UPDATE SKIP LOCKED` already prevents two workers
claiming the same row in the same instant.

**`finish_marketing_post(..., p_worker_id TEXT DEFAULT NULL)`** - fence on the
claimant exactly as `conversion_complete_notification` does after `535c87c`:

```sql
WHERE id = p_id AND status = 'sending'
  AND (p_worker_id IS NULL OR claimed_by = p_worker_id)
```

A worker whose lease was reclaimed therefore cannot overwrite the new owner's
outcome (it gets "no row" instead of a false `published`).

**Reclaim must not double-post.** A lease expiry does not prove the send failed; the
original worker may have posted and then died before `finish`. Two cheap guards:

1. before re-sending, skip any post that already has a `sent` row in
   `telegram_marketing_sends` (`post_id`, `status='sent'`) -> mark it `published`;
2. keep the default lease comfortably above a send+finish cycle (180 s is generous
   for one Telegram call) so a reclaim only happens after a real death.

**Poison posts.** The `attempts < max_attempts` guard already bounds retries; a post
that expires its lease `max_attempts` times should be terminal `failed` with
`last_error='lease_expired'`. That transition is best done by the reclaim statement
itself (set `failed` and exclude it from the claim) rather than by a separate
sweeper, so there is no second moving part.

### 19.3 Operator escape hatch available today (no code change)

Section 12 of the SQL script lists orphans. A single stuck post can be requeued with:

```sql
update public.telegram_marketing_posts
   set status = 'scheduled', scheduled_for = now(), attempts = 0, last_error = null,
       updated_at = now()
 where id = <id> and status = 'sending';
```

That is a manual, auditable action - acceptable while publishing is off, which it is.

### 19.4 Why not simply re-schedule on boot

A "reset everything in `sending` at startup" sweep is tempting but unsafe with more
than one worker process: worker A can be mid-send while worker B starts and resets
A's row, producing a duplicate channel post. The lease + fence makes recovery
*legitimate* rather than *racy*, and it is the pattern already proven in this
codebase. Queue `sending` recovery is therefore implemented as a lease, not as a
boot-time sweep - and `tests/marketing_lease_recovery.test.js` pins that no mass
reset exists.

### 19.5 Tests (written: `tests/marketing_lease_recovery.test.js`, 18 tests)

SQL behaviour was executed against PostgreSQL 16 while authoring 043; the JS suite
pins the contract and the worker logic:

1. Expired lease is reclaimed by the next claim; a live lease is not (SQL run +
   the claim's due/lease predicates pinned).
2. `NULL` lease on a `sending` row is reclaimed (defence, as in 040) - SQL run.
3. A fenced `finish` from the previous owner is refused after reclaim - SQL run
   (returns no row) and worker run (`post_lease_lost`, send still audited).
4. `attempts = max_attempts` stops reclaiming and the row ends `failed` with
   `last_error = lease_expired` - SQL run + source pin.
5. A post with a `sent` audit row is reconciled to `published`, never re-sent -
   worker run (zero transport calls, original message id preserved).
6. Two workers claim and publish their own posts; `FOR UPDATE SKIP LOCKED` is
   asserted to still be the concurrency primitive.
7. An unreadable send audit fails CLOSED (no send, retry scheduled).

## 20. The single next action required

**Run `docs/sql/telegram_db_readiness.sql` in the Supabase SQL editor and send back
the "verdict" result set (five rows).**

Everything else is sequenced behind that one read:

- if 038-041 read APPLIED and the control row is `paused=true, dry_run=true`, the
  database is ready and the four commits can be deployed (section 18);
- if 040 reads APPLIED but 041 does not, **apply 041 immediately** - that is the
  only genuinely dangerous state, and section 16.2 shows exactly how it arises;
- if nothing is applied, the deploy is still safe (the new code fails closed to 503 /
  worker-exits) but the features stay dark until 038->039->(040+041) are applied.

No push, deploy, migration or Telegram message was performed in this session.

---

## Appendix A - Evidence log (this audit)

| Check | Observed |
|---|---|
| `git status --porcelain` | empty (clean) |
| `git rev-parse HEAD` | `9ec7caa3bb319f717fc91a3a137f37e01da74410` |
| `git rev-parse origin/main` | `c13c6c1283e1207a3d971f4f8294adce92a93d4b` (stale ref) |
| `git ls-remote origin refs/heads/main` | `87a648ee5f801090727522fa54ed8f875cc6c960` |
| `git rev-list --left-right --count 87a648e...HEAD` | `0 4` (behind 0, ahead 4) |
| `curl -D- https://arbitrix.pro/api/health` | `HTTP/2 200`, `x-render-origin-server: Render`, `{"status":"ok"}` |
| served `/` sha256 vs `git show origin/main:public/index.html` | identical |
| POST `/api/telegram/webhook` unsigned | `401 {"ok":false,"error":"invalid_secret","secretProvided":false}` |
| `GET /api/telegram/link` on production | SPA HTML -> Phase 1 (`3c48065`) not deployed |
| `GET /api/admin/marketing/status` unauthenticated | `401 {"error":"Unauthorized"}` |
| `npm test` | 2488 total, 2487 pass, 1 fail (video master fixture) |
| Telegram subset (43 files) | 1045 / 1045 pass |
| Worktree at `87a648e` running the video test | 9 tests, 8 pass, 1 fail (same test) |
| `node --check` (15 files) | all OK |
| Supabase DNS | `jmhgreazilmmvuqnghgt.supabase.co` does not resolve from this sandbox |
| `git ls-remote origin refs/heads/main` (2026-10-28) | `87a648e` (unchanged) |
| `git rev-list --left-right --count 87a648e...HEAD` (2026-10-28) | `0 4` |
| Section 16 script, no migrations applied, PG 16.15 | exit 0, 140 MISSING, 0 SQL errors |
| Section 16 script, 038+039+040 (no 041) | 5 non-OK rows; action "Apply 041 now" |
| Section 16 script, 038->039->(040+041 in one tx) | 162 OK, 0 problems, all APPLIED |
| 040 + 041 applied as one transaction | exit 0; both self-checks passed |
| D1 replay: invoice UPDATE without `credited` | `credited=f`, 0 events for that invoice |
| D1 replay: same row + `credited = TRUE` | `credited=t`, exactly 1 event |

## Appendix B - What this audit deliberately did not do

- No commit, push, deploy or Render change.
- No migration applied; no production data read or written.
- No Telegram message sent. The only Telegram interaction was one unsigned webhook
  POST to production, rejected before processing (no state).
- No file modified except the creation of this document.
- `AGENTS.md` was left untouched: it is append-only project memory edited by many
  prior sessions, and scripted edits to its non-ASCII content have corrupted it
  before. A one-line pointer can be appended later on request.

## 21. Migrations 038-043: exact production commands and verification (2026-10-28)

This section is the operational counterpart of section 18. It covers the two fixes
implemented after the first audit pass:

| File | What it fixes | Risk if skipped |
| --- | --- | --- |
| `042_confirm_payment_credit_marker.sql` | `confirm_payment_with_credit()` never set `payment_invoices.credited`, so the 040 trigger recorded no `deposit_confirmed` event: provider-paid deposits credit the money and the customer gets NO Telegram notification. | Silent. Money is correct, the notification never happens. |
| `043_marketing_claim_lease.sql` | Adds the claim lease + fenced finish, so a marketing worker that dies mid-send no longer strands a post in `sending` forever. | Silent. Nothing is published or failed, forever. |

Neither migration is applied, and this environment cannot apply them: the Supabase
host in `SUPABASE_URL` does not resolve from the sandbox, and there is no database
password or DDL-capable credential. Everything below is therefore written to be
executed by an operator in the Supabase dashboard, and every step is verifiable.

### 21.1 What is actually applied right now: unknown

The audit could only probe HTTP, which says nothing about the database. The code
probes that WOULD tell us (`/api/telegram/status`, `/api/admin/marketing/status`)
return `401` without a JWT, and the supplied `ADMIN_JWT` is expired.

So: do not assume. Run the readiness script first (21.2); its `NEXT ACTION` row
tells you exactly which migration to apply next, and it is safe to run repeatedly.

### 21.2 Step 1 - measure (read-only, no changes)

Copy `docs/sql/telegram_db_readiness.sql` into the Supabase SQL editor and run it.
It is `SELECT`-only: 18 statements, no `CREATE`/`ALTER`/`INSERT`/`UPDATE`/`DELETE`/
`DROP`/`GRANT`. Expected on a fully migrated database: 169 rows with status `OK`,
zero `MISSING`/`DRIFT`/`PARTIAL`, and

```
verdict | 042 provider credit marker | APPLIED
verdict | 043 marketing claim lease  | APPLIED
verdict | NEXT ACTION                | No migration work required for 038-043
```

On a database that has 038-041 but neither fix:

```
verdict | 042 provider credit marker | NOT APPLIED | function present but the marker is ABSENT...
verdict | 043 marketing claim lease  | NOT APPLIED
verdict | NEXT ACTION                | Apply 042 (provider credits currently emit no deposit notification)
```

The four intermediate states were executed against PostgreSQL 16 while writing this
section (`NOTHING` -> `038-041` -> `+042` -> `+043`), and the verdict moved correctly
through `Apply 040 + 041 together` -> `Apply 042` -> `Apply 043` -> `No migration work
required for 038-043`.

### 21.3 Step 2 - back up first

Supabase dashboard -> Database -> Backups. Confirm there is a restorable backup (or
take one) before running any DDL. Migrations 038-043 are additive, but 042 and 043
`CREATE OR REPLACE` functions that money and the queue depend on.

### 21.4 Step 3 - apply in order, one file at a time

In the SQL editor, paste and run each file separately, in this order, and read the
`NOTICE`/error of each before continuing:

1. `supabase/migrations/038_marketing_broadcast.sql` (if not already applied)
2. `supabase/migrations/039_telegram_account_links.sql` (if not already applied)
3. `040_conversion_events.sql` and `041_legacy_deposit_atomic_credit.sql` -
   **together, in one transaction**, because 040 alone suppresses legacy deposit
   events until 041 restores the marker:

   ```sql
   begin;
   \i supabase/migrations/040_conversion_events.sql
   \i supabase/migrations/041_legacy_deposit_atomic_credit.sql
   commit;
   ```

   In the dashboard editor (which has no `\i`), paste the contents of 040 followed by
   the contents of 041 between `begin;` and `commit;`.

4. `042_confirm_payment_credit_marker.sql` - expect
   `NOTICE: migration 042: credited = TRUE ... verified`.
5. `043_marketing_claim_lease.sql` - expect
   `NOTICE: migration 043: lease claim, fenced finish and poison-post handling verified`.

All five are idempotent: re-running any of them is a no-op (043 re-applies its
`CREATE OR REPLACE` functions and its `ADD COLUMN IF NOT EXISTS`).

### 21.5 Ordering versus the code deploy

042 is callable by the CURRENT deployed server, so it can be applied before or after
the deploy - it only starts setting a marker.

043 DROPS the three 038 signatures and creates 4/6/3-argument versions, so it is
mutually exclusive with a running worker in BOTH directions:

- old code + 043 applied = the worker calls signatures that no longer exist;
- new code + 043 not applied = the worker passes `p_worker_id`/`p_lease_seconds` to a
  function that does not accept them, so `claimDue` fails (`claim-failed`) and nothing is
  claimed.

Both fail CLOSED (no send, no duplicate) but neither publishes. Today this is moot:
`TELEGRAM_MARKETING_ENABLED` is unset and the control row is `paused` + `dry_run`, so the
worker exits at its first gate and never reaches the RPCs. Apply 043 with the code, or
before it, but never leave the pair mismatched while publishing is enabled. If publishing
was ever enabled, pause it first:

```sql
update public.telegram_marketing_control set paused = true, dry_run = true, updated_at = now() where id = 1;
```

Recommended sequence: apply the migrations -> deploy the code -> verify (21.6) ->
leave publishing disabled.

### 21.6 Step 4 - verify

1. Re-run `docs/sql/telegram_db_readiness.sql`: every row `OK` and the verdict says
   `No migration work required for 038-043`.
2. Confirm the marker function:
   ```sql
   select pg_get_functiondef(to_regprocedure('public.confirm_payment_with_credit(bigint,bigint,numeric,text)')) ~ 'credited = TRUE' as marker_ok;
   select to_regprocedure('public.claim_marketing_posts(timestamp with time zone, integer, text, integer)') is not null as claim_lease_ok;
   ```
   Both must be `true`. The readiness script already asserts the same two things
   (sections 4, 4b, 6, 14).
3. Confirm the queue is still inert:
   ```sql
   select paused, dry_run from public.telegram_marketing_control where id = 1;   -- must be t, t
   ```
4. After the first real provider deposit post-deploy, a `deposit_confirmed` row should
   appear in `conversion_events` for that invoice within seconds (section 3 of the
   readiness script lists the outbox tables).
5. Orphan watch (marketing): nothing should sit in `sending` for longer than the lease:
   ```sql
   select id, status, claimed_by, lease_expires_at from public.telegram_marketing_posts
    where status = 'sending' and (lease_expires_at is null or lease_expires_at < now() - interval '1 minute');
   ```

### 21.7 Rollback

| Migration | Rollback | Blast radius |
| --- | --- | --- |
| 042 | Re-apply `021_provider_referral_award_correctness.sql` (it re-creates the same function without the marker). | Provider-credited deposits stop emitting notifications again; no money is involved. |
| 043 | Re-apply `038_marketing_broadcast.sql` (it re-creates the 2/5/2-argument functions). The added columns and the index are additive and may stay. | Marketing claims lose crash recovery; publishing is disabled anyway. |

Neither rollback touches data. No `DROP TABLE`, no `DELETE` is required by either
migration or its rollback.

### 21.8 What is still NOT fixed by 038-043

- `confirm_legacy_deposit_safe` (041) and `confirm_payment_with_credit` (042) are the
  two credit paths that exist. Any future provider that credits money by writing
  `payment_invoices` directly will reproduce D1.
- The marketing queue has no dead-letter UI: a `failed` post must be read from the
  table (or the admin `/posts` route) and retried by an operator.
- Nothing in this release enables the marketing worker, the conversion worker or the
  trading worker.

## 22. Ready-to-paste deploy batches and their validation (2026-10-28)

Section 21 describes the procedure; this section is the artifact set that ships
with it, so the operator copies five files instead of assembling SQL by hand.

    docs/sql/deploy/README.md                        runbook: order, expectations, rollback
    docs/sql/deploy/batch-1-038-marketing-broadcast.sql
    docs/sql/deploy/batch-2-039-telegram-account-links.sql
    docs/sql/deploy/batch-3-040-041-atomic.sql
    docs/sql/deploy/batch-4-042-credit-marker.sql
    docs/sql/deploy/batch-5-043-claim-lease.sql

Batches 1, 2, 4 and 5 are byte-identical copies of the migration files (sha256
compared against the source); batch 3 is 040 and 041 concatenated between
`begin;` and `commit;` with a comment header, and the wrapped bodies are byte-
identical to both files. No statement was added, removed or reordered anywhere.

### 22.1 Validation performed (PostgreSQL 16, never staging or production)

All five batches were executed in order against a fresh database built from the
production-shaped scaffold (users with `environment`, `payment_invoices` with
`credited`, wallets, transactions, referrals, deposits):

    batch 1 .. 5 -> exit 0 each, with these self-checks in the output:
      038: policies created (drop-if-exists notices only)
      039: table, indexes and RLS created
      040: NOTICE conversion_events: schema, RLS and capture triggers verified
      041: NOTICE legacy deposit integrity: marker, atomic RPC, trigger guard and backfill verified
      042: NOTICE migration 042: verified - credited = TRUE is set in the invoice UPDATE ...
      043: NOTICE migration 043: lease claim, fenced finish and poison-post handling verified

then `docs/sql/telegram_db_readiness.sql` on the same database:

    169 rows OK, zero MISSING/DRIFT/PARTIAL
    verdict: 038..043 all APPLIED
    NEXT ACTION: No migration work required for 038-043

### 22.2 The 040+041 batch is genuinely atomic (fault injection)

A sabotaged copy with `select 1/0;` inserted immediately before `commit;` was run
against the same starting state. It failed with `ERROR: division by zero` and
left **no** trace of either migration: `conversion_events` and
`conversion_notifications` absent, `deposits.credited` absent,
`confirm_legacy_deposit_safe()` and `conversion_backfill_missing()` absent, zero
triggers on `deposits`. Running the real batch on that same database immediately
afterwards succeeded and passed both self-checks - a failed attempt neither
half-applies nor blocks a retry.

### 22.3 Worker coordination (043)

043 drops the 2/5/2-argument RPCs and creates 4/6/3-argument versions, so 043 and
the worker code must ship in the same window. Both mismatched states fail closed
(`claim-failed`), and neither can publish while `TELEGRAM_MARKETING_ENABLED` is
unset and `telegram_marketing_control` is `paused = TRUE, dry_run = TRUE`. The
deployment leaves publishing disabled; nothing in this set enables the marketing,
conversion or trading worker.

### 22.4 Deploy-order facts that reduce coupling

* 042 works with the currently deployed server (it only starts setting a marker).
* The legacy deposit change is deploy-order safe: with 041 absent the server logs
  a warning and falls back to the previous status-then-credit sequence, so
  deploying the code before or after 041 cannot strand a deposit.
* `server.js` never starts the conversion or marketing worker in-process, and
  both entrypoints exit 0 when their switch is unset.
