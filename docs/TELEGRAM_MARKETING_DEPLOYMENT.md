# Telegram Marketing Group and Announcement Channel - Deployment Runbook

This is the operator guide for the Arbitrix Telegram marketing system: the
partner group onboarding, the official announcement channel, the scheduled
content queue and the background publisher.

It supersedes the "what is still missing" sections of
`docs/TELEGRAM_RECOVERY_AUDIT.md` for marketing (that document remains the
record of the earlier database recovery work).

Everything below is ASCII so it can be read in any shell.

---

## 1. What runs where

| Component | Process | Purpose |
|---|---|---|
| Web app (`server.js`) | Render Web Service | Admin API, join webhook handling, preview/approval, single-shot test send |
| Marketing worker (`marketing-worker.js`) | Render Background Worker | Claims due posts from the queue and publishes them |
| Telegram Bot API | External | Delivery to the partner group and the announcement channel |
| Supabase (Postgres) | External | Queue, control row, consent store, send audit |

The web app NEVER publishes a queued post. It prepares, previews, approves and
observes. Only the worker publishes, and only when all three gates are open.

---

## 2. Three independent publishing gates

Content is published only when ALL of these are true:

1. `TELEGRAM_MARKETING_ENABLED=true` (environment switch, default off)
2. `telegram_marketing_control.paused = FALSE` (database)
3. `telegram_marketing_control.dry_run = FALSE` (database)

An additional environment switch, `TELEGRAM_MARKETING_DRY_RUN` (default `true`),
forces a dry run even when the database says otherwise. Leave it `true` until
the queue has been reviewed.

If the control row is unreadable (migration 038 not applied, wrong key, database
down) the worker FAILS CLOSED: it exits with code 1 and sends nothing.

---

## 3. Prerequisites

### 3.1 Database migrations

Apply in this order. All are additive and idempotent.

| File | Purpose |
|---|---|
| `supabase/migrations/038_marketing_broadcast.sql` | Queue, consent store, control row, send audit, claim RPCs |
| `supabase/migrations/043_marketing_claim_lease.sql` | Claim lease + fencing + crash recovery |
| `supabase/migrations/044_marketing_worker_heartbeat.sql` | Worker liveness columns (`worker_heartbeat_at`, `worker_id`, `worker_version`) |

`docs/sql/telegram_db_readiness.sql` is a read-only verifier for 038-044. Run it
first: its `verdict` rows say APPLIED / NOT APPLIED / PARTIAL per migration, and
section 10b reports the worker heartbeat age (OK / STALE / NEVER / MISSING). If
you prefer a direct check of 044:

```sql
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'telegram_marketing_control'
  and column_name in ('worker_heartbeat_at','worker_id','worker_version');
```

Three rows means the heartbeat migration is applied.

### 3.2 Telegram

1. The bot (`TELEGRAM_BOT_TOKEN`) must be a MEMBER of the partner group and an
   ADMINISTRATOR of it with **post messages** and (for pinning the Start Here
   guide) **pin messages**.
2. The bot must be an ADMINISTRATOR of the announcement channel with **post
   messages**.
3. Get each chat id by sending `/chatid` in that chat as an admin. The bot
   answers in a private message (it never posts the id into the group).
4. The group id and the channel id MUST be different. If
   `TELEGRAM_ANNOUNCEMENT_CHAT_ID` equals `TELEGRAM_MARKETING_CHAT_ID`, the
   channel destination is disabled on purpose and
   `config.channelConflictsWithGroup` reports `true`.
   A swap is not silent either: if the group id points at a `channel` (or the
   channel id at a `supergroup`), the readiness check reports a blocking issue
   ("the two destination ids look SWAPPED") instead of a warning, because
   publishing would send group copy to the announcement channel.
5. Both ids MUST be the numeric chat id (a `-100...` value). A `@username` or a
   `t.me` link is NOT accepted: the publisher addresses chats by id only, so
   such a value resolves to "not configured". `getChat` would still succeed on a
   username, which is why this is checked explicitly. The worker logs
   `worker_config_warning` (`username-not-supported`), the readiness check
   reports it as an issue, and this command prints the numeric id to use:

   ```bash
   node scripts/check-marketing-readiness.js --resolve-chat @ArbitrixAnnouncements
   ```

   It performs one read-only `getChat`; it sends and changes nothing.

Verify every Telegram-side requirement without sending anything:

```bash
node scripts/check-marketing-readiness.js
```

It prints `READY`, `READY_WITH_WARNINGS` or `NOT_READY` plus the exact issue,
and never prints the bot token or a full chat id. Exit codes: `0` ready,
`2` not ready, `3` no bot token on that service.

When `SUPABASE_URL` and a service-role key are present it also READS the
publisher state and prints it - no admin JWT needed:

* whether migration 044 is applied,
* `telegram_marketing_control.paused` and `dry_run`,
* the worker heartbeat (healthy / stale / never) with worker id and version,
* the queue counts per status.

That section only issues SELECTs (pinned by tests). Add `--no-db` to skip it
and `--json` for machine-readable output.

If the service has database credentials but no bot token, use:

```bash
node scripts/check-marketing-readiness.js --db-only
```

It skips Telegram entirely and reports READY / READY_WITH_WARNINGS / NOT_READY
from the control row, the worker heartbeat and the queue alone. A stale or
missing heartbeat is reported as a warning (the publisher would not be running),
never as a silent pass.

### Rehearsing the worker's database contract (throwaway DB only)

The worker's publishing calls are unit-tested against fakes, so before the first
production run you can prove the RPCs behave as expected on a real PostgreSQL
(one with 038 + 043 + 044 applied):

```bash
psql -d arbitrix_rehearsal \
  -c "set arbitrix.rehearsal = 'yes';" \
  -f docs/sql/marketing_rpc_rehearsal.sql
```

It asserts eight things: the claim takes the due post and holds a lease; a
second worker claims nothing while that lease is held; a FOREIGN worker cannot
finish the post (fencing); the owner's finish publishes it with its message id;
the heartbeat leaves `paused`/`dry_run` untouched; `block_marketing_post`
records the reason; the send audit row inserts; an expired lease is reclaimed.

The script DELETEs marketing rows, so it refuses to run unless the session sets
`arbitrix.rehearsal = 'yes'`. Never point it at production.

### 3.3 Environment variables

Required for the worker:

| Variable | Notes |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Same bot as the support bot |
| `TELEGRAM_MARKETING_CHAT_ID` | Partner group, NUMERIC id (-100...). A @username is rejected |
| `TELEGRAM_ANNOUNCEMENT_CHAT_ID` | Announcement channel, NUMERIC id (-100...), different from the group |
| `SUPABASE_URL` | Same project as the web app |
| `SUPABASE_SERVICE_KEY` | Service-role key. `SUPABASE_SERVICE_ROLE_KEY` is also accepted (same credential) |

Publishing gates and behaviour:

| Variable | Default | Notes |
|---|---|---|
| `TELEGRAM_MARKETING_ENABLED` | `false` | Gate 1 |
| `TELEGRAM_MARKETING_DRY_RUN` | `true` | Forces a dry run regardless of the database |
| `TELEGRAM_MARKETING_LOCALE` | `en` | `en` / `pt` / `ar` |
| `TELEGRAM_MARKETING_TIMEZONE` | `UTC` | IANA name used to place the weekly calendar |
| `TELEGRAM_MARKETING_TICK_MS` | `60000` | Poll interval, 15000..900000 |
| `TELEGRAM_MARKETING_WORKER_ID` | `marketing-worker` | Claimant name in logs and `claimed_by` |
| `TELEGRAM_MARKETING_LEASE_SECONDS` | `180` | Claim lease, 30..900 |
| `TELEGRAM_MARKETING_REGISTER_URL` | `${BASE_URL}/?action=create-account` | Optional override |
| `TELEGRAM_MARKETING_HOW_IT_WORKS_URL` | `${BASE_URL}/how-it-works` | Optional override |
| `TELEGRAM_ANNOUNCEMENT_CHANNEL_URL` / `_USERNAME` | none | Adds the "official channel" link/button |
| `TELEGRAM_SUPPORT_USERNAME` | `ArbitrixSupportBot` | Customer support destination |
| `TELEGRAM_PARTNER_SUPPORT_USERNAME` | `AlexArbitrix` | Alex - the referral / partner-recruitment contact (also payment partner 1) |
| `TELEGRAM_PARTNER_SUPPORT_USERNAME_2` | `OliviaArbitrix` | Olivia - payment partner 2, listed only in the payment-help block |

---

## 4. Deploying the publisher on Render

1. Create a **Background Worker** service from the same repository and branch as
   the web service.
2. Start command:

   ```
   node marketing-worker.js
   ```

3. Build command: the same install step as the web service (`npm ci`).
4. Add every variable from section 3.3 to the WORKER service. A variable set
   only on the web service is invisible to the worker.
5. Do NOT expose a port. The worker never listens.
6. Start it with publishing still disabled (`TELEGRAM_MARKETING_ENABLED` unset
   or `false`). The log line should be:

   ```
   {"event":"worker_disabled","component":"marketing-worker",...}
   ```

   and the process exits 0. That proves the service is wired correctly without
   publishing anything.

### 4.1 Liveness

Once enabled, the worker writes `telegram_marketing_control.worker_heartbeat_at`
on every tick, before evaluating any gate. A paused or dry-run worker is still
alive and still beats.

```
GET /api/admin/marketing/status
```

returns `worker.heartbeat` with `healthy`, `ageMs`, `staleAfterMs` (180000),
`workerId`, `version` and a `note`. Queue counts are in `queue`:

```
{ draft, awaiting_approval, approved, scheduled, sending, published, failed, blocked, cancelled }
```

Interpretation:

| Observation | Meaning |
|---|---|
| `healthy: true` | A worker is running the intended commit |
| `healthy: false`, `heartbeatAt: null` | The worker has never reached this database |
| `healthy: false`, `ageMs > staleAfterMs` | The worker stopped or cannot write to the database |
| `enabled: false` | `TELEGRAM_MARKETING_ENABLED` is off on the WEB service. The Background Worker has its own value, so read `heartbeat` for real liveness |
| `controlError: "control-unreadable"` | Migration 038 missing or wrong service key |

---

## 5. Operating the queue

All routes require an administrator session (JWT + admin role). None of them
accept a chat id, price, percentage or recipient list from the client.

| Action | Request |
|---|---|
| Status (gates, heartbeat, counts) | `GET /api/admin/marketing/status` |
| Preview a template, no write | `POST /api/admin/marketing/preview` `{"kind":"welcome\|startHere\|channelIntro\|weekly","theme":"mon..sun"}` |
| Queue custom copy | `POST /api/admin/marketing/posts` `{"kind":"custom","content":"..."}` |
| Queue Start Here (+ optional channel intro) | `POST /api/admin/marketing/start-here` `{"includeChannelIntro":true}` |
| Seed two weeks of calendar | `POST /api/admin/marketing/calendar/seed` `{"weeks":2}` |
| List posts (filter by status) | `GET /api/admin/marketing/posts?status=scheduled` |
| Publication history | `GET /api/admin/marketing/sends?postId=<id>` |
| Approve | `PATCH /api/admin/marketing/posts/<id>` `{"action":"approve"}` |
| Retry a failed post | `PATCH /api/admin/marketing/posts/<id>` `{"action":"retry","scheduledFor":"..."}` |
| Cancel / unschedule | `PATCH /api/admin/marketing/posts/<id>` `{"action":"cancel"}` |
| Pin a published message | `POST /api/admin/marketing/pin` `{"postId":<id>}` |
| Pause / resume / dry-run | `POST /api/admin/marketing/control` `{"paused":true,"dryRun":true}` |

State rules enforced by the API:

* `approve` only from `awaiting_approval` or `draft`. A `published` post can
  never be re-approved, so it cannot be published twice.
* `cancel` only from a non-terminal state; `unschedule` only from `scheduled` or
  `approved`.
* `retry` clears `attempts`, `claimed_by` and `lease_expires_at`, so the row is
  claimable again.
* Every transition is recorded in `telegram_marketing_sends`.

Seeding is idempotent: each slot has a dated idempotency key
(`cal:<audience>:<locale>:<theme>:<YYYY-MM-DD>`), so re-seeding the same window
returns `duplicates` instead of creating new rows.

---

## 6. Controlled delivery test (two messages)

The queue has to stay disabled while you prove delivery. Use the single-shot
test routes instead: they send the fixed, guarded test copy to ONE configured
destination and queue nothing.

Preview first (sends nothing):

```bash
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  "https://arbitrix.pro/api/admin/marketing/test-message?audience=group"
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  "https://arbitrix.pro/api/admin/marketing/test-message?audience=channel"
```

Send the partner-group test:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"audience":"group","confirm":"SEND TEST"}' \
  https://arbitrix.pro/api/admin/marketing/test-send
```

Send the announcement-channel test:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"audience":"channel","confirm":"SEND TEST"}' \
  https://arbitrix.pro/api/admin/marketing/test-send
```

Expected response: `success: true` plus the `messageId` Telegram returned. A
failed send answers `502` with Telegram's own description and is recorded in
`telegram_marketing_sends` as `failed`.

What the test copy contains:

* Partner group: "DELIVERY TEST - PARTNER GROUP", one line saying no action is
  needed, the customer support link and the partner payment support link.
* Announcement channel: "DELIVERY TEST - OFFICIAL CHANNEL", the same notice, and
  links to registration, How It Works and customer support.

No amount, no percentage, no claim and no call to action beyond those links.

---

## 7. Go-live checklist

1. `node scripts/check-marketing-readiness.js` reports `READY`.
2. Migrations 038, 043 and 044 applied.
3. Both controlled test messages received in the right chats.
4. `POST /api/admin/marketing/preview` reviewed for each template.
5. `POST /api/admin/marketing/calendar/seed` run; `GET /posts` shows the
   expected `scheduled` rows and no duplicates.
6. `POST /api/admin/marketing/control {"paused":false,"dryRun":false}`.
7. `TELEGRAM_MARKETING_ENABLED=true` on the worker service and
   `TELEGRAM_MARKETING_DRY_RUN=false` on the worker service.
8. Restart the worker and confirm `GET /api/admin/marketing/status` reports
   `worker.heartbeat.healthy: true`.
9. Publish the Start Here guide (`POST /api/admin/marketing/start-here`), then
   pin it (`POST /api/admin/marketing/pin`).

---

## 8. Rollback

Fastest, no deploy and no database write on the host:

```
POST /api/admin/marketing/control {"paused":true,"dryRun":true}
```

This stops the worker within one tick. It does not delete anything.

Additional layers, in order of blast radius:

1. `TELEGRAM_MARKETING_ENABLED=false` on the worker service (worker exits).
2. Stop or delete the Render Background Worker service.
3. Cancel queued posts: `PATCH /api/admin/marketing/posts/<id> {"action":"cancel"}`.
4. Full removal (irreversible): drop the marketing tables. Only do this if the
   queue and history are no longer needed.

The controlled test routes are unaffected by the gates, but they require an
administrator JWT and the exact `SEND TEST` confirmation, so they cannot be
triggered by a customer.

---

## 9. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Worker logs `worker_misconfigured` and exits 1 | Missing `SUPABASE_URL` / service key, or migration 038 not applied | `worker_misconfigured.reason` and `.detail` in the log |
| `controlError: control-unreadable` in status | Wrong service key or 038 missing | Run `docs/sql/telegram_db_readiness.sql` |
| `worker.heartbeat.healthy: false` | Worker not running, or cannot reach the database | Restart the worker; check its logs for `heartbeat_failed` |
| Post stays `scheduled` | Worker paused, dry-run, or `TELEGRAM_MARKETING_ENABLED` false | `GET /api/admin/marketing/status` |
| Post `failed` with `destination: announcement-channel-not-configured` | `TELEGRAM_ANNOUNCEMENT_CHAT_ID` unset, malformed, or equal to the group id | Readiness script |
| Post `failed` with a Telegram description | Bot is not an admin / lacks post rights | Readiness script |
| Post `blocked` | Content guard rejected the rendered copy | `last_error` names the guard codes |
| `REVOKED` / no welcome on join | Bot lacks read access, or the join was in a different chat | Only `TELEGRAM_MARKETING_CHAT_ID` receives onboarding |
| Duplicate-looking posts | Two workers with different ids claiming; check the send audit | `GET /api/admin/marketing/sends?postId=` |

---

## 10. Deliberate limits

* Destinations are numeric chat ids only. Usernames are not resolved at
  runtime: one guided `--resolve-chat` call is preferred over a Telegram
  dependency on every worker boot.


* No live arbitrage signal feed. `services/MarketOpportunities.js` is simulated
  metadata and the content guard blocks presenting it as a live signal.
* No automatic pinning. Pinning is an explicit admin action after a post is
  published, because a pin needs a real message id.
* No bonus, matching, cashback or "flash" campaign. There is no bonus engine and
  the guard rejects such copy.
* No fabricated testimonials, win rates or user counts.
* No recurring or lifetime commission claims: the referral reward is one-time,
  20% of the referred user's first qualifying deposit of at least USD 100.
* The withdrawal minimum is never advertised. It is disclosed only inside the
  withdrawal flow.
* Subscriber broadcasts (`audience: subscribers`) only reach chats that sent
  `/subscribe`. Account linking is not marketing consent.
