# Deployment: migrations 038-043 + the four pending commits

Status: **prepared, not executed**. Nothing in this directory has been applied to
production. Publishing (Telegram marketing) must stay disabled for the whole window.

Baseline measured by the operator with `docs/sql/telegram_db_readiness.sql`:
**038, 039, 040, 041, 042 and 043 all report NOT APPLIED.** So this is a fresh
install of the whole chain, not a repair.

## 1. Batches, in order

Copy ONE file per run into the Supabase SQL Editor, run it, wait for the result,
then continue. Do not merge two batches into one run.

| # | File | Bytes | sha256 (first 16) | What it does |
|---|------|-------|-------------------|--------------|
| 1 | `batch-1-038-marketing-broadcast.sql` | 14214 | `767c51bc7293fdaa` | queue, subscriptions, control row (`paused=TRUE, dry_run=TRUE`), send audit, RLS |
| 2 | `batch-2-039-telegram-account-links.sql` | 11562 | `65f2a4e699872f8b` | `telegram_account_links` + `consume_telegram_link_token()` |
| 3 | `batch-3-040-041-atomic.sql` | 56256 | `4735e3f778fe1d57` | conversion events/outbox + triggers **and** the legacy deposit credit marker, in ONE transaction |
| 4 | `batch-4-042-credit-marker.sql` | 10742 | `1500c6c1e67a2ee2` | `confirm_payment_with_credit()` now sets `payment_invoices.credited = TRUE` |
| 5 | `batch-5-043-claim-lease.sql` | 16359 | `5fafb1a4d2ccea51` | marketing claim lease + fenced finish (supersedes the 038 RPC signatures) |

Batches 1, 2, 4 and 5 are **byte-identical copies** of
`supabase/migrations/0NN_*.sql` (verified by sha256 against the source files).
Batch 3 is the two bodies concatenated between `begin;` and `commit;` with a
comment header; the wrapped bodies are byte-identical to 040 and 041.

Why batch 3 must be atomic: 040's legacy-deposit trigger reads
`deposits.credited`, a column that only 041 creates. Split across two commits, a
legacy deposit confirmed in between records no conversion event (its handler
raises a warning and returns - the deposit is still credited). One transaction
removes the window entirely. This was proven by fault injection: a failing
statement at the end of the batch rolled back *every* object from both
migrations, no tables, no column, no functions, no triggers.

## 2. How the Supabase SQL Editor behaves

- Paste the whole file, press Run. The editor shows only the **last** result set,
  so a `NOTICE` may not be visible. Success looks like "Success. No rows
  returned." with no error; a failure is loud and aborts the run.
- Batches 4 and 5 are single `DO` blocks - atomic by construction.
- Batch 1 carries its own `BEGIN; ... COMMIT;`. Do not wrap it again.
- Every batch is idempotent. Re-running a failed batch is safe, and a failed
  batch leaves nothing behind (proven for batch 3; the others are single-object
  DDL or single DO blocks).
- The readiness script is the authority on success, not the notice text. Re-run
  it after each batch if you want step-by-step confirmation, or once after batch
  5.

## 3. Order and worker coordination

1. **Back up**: Supabase - Database - Backups - confirm a restorable backup, or
   take one. 042 and 043 `CREATE OR REPLACE` functions; 040 adds triggers to
   `users`, `payment_invoices`, `deposits`, `referrals`.
2. **Pause guard** (idempotent, safe to run before batch 1 even if 038 is not
   applied - it does nothing on a missing table; skip if it errors):
   `update public.telegram_marketing_control set paused = true, dry_run = true, updated_at = now() where id = 1;`
3. Run batches 1 to 5 in order.
4. **Deploy the code** (push to `main`; Render auto-deploys). 043 and the worker
   code must move together - see the note below.
5. Verify (section 5), then leave publishing off.

043 and the worker: 043 drops the 2/5/2-argument RPCs and creates 4/6/3-argument
versions, so old code + 043 and new code + no 043 are both incompatible. Both
fail closed (nothing is sent, no duplicate), and neither matters while
`TELEGRAM_MARKETING_ENABLED` is unset and the control row is paused + dry-run,
because the worker exits at its first gate before touching the RPCs. Do not
enable publishing until migrations and code are both deployed and verified.

042 is compatible with the currently deployed server (it only starts setting a
marker), and the legacy deposit change in the code is deploy-order safe: if 041
is missing the server falls back to the previous status-then-credit sequence with
a loud warning.

## 4. Code release under test

`origin/main` = `87a648ee5f80...`, `HEAD` = four commits ahead:

| Commit | Subject | Frontend? | Migrations |
|---|---|---|---|
| `3c48065` | Telegram account links (Phase 1) | yes, `public/index.html` +221 | 039 |
| `1d934a6` | conversion events + delivery outbox (Phase 2) | no | 040 |
| `535c87c` | atomic legacy deposit credit | no | 041 |
| `9ec7caa` | partner welcome copy + Start Here guide | no | - |
| working tree | 042, 043, worker lease wiring, audit doc, readiness script | no | 042, 043 |

Nothing in the release enables the conversion worker, the marketing worker or
the trading worker: both worker entrypoints exit 0 when their switch is unset,
and `server.js` never starts them in-process.

## 5. Verification after deploy

1. `docs/sql/telegram_db_readiness.sql`: 169 rows `OK`, no
   `MISSING`/`DRIFT`/`PARTIAL`, verdict `No migration work required for 038-043`.
2. `select paused, dry_run from public.telegram_marketing_control where id = 1;`
   must be `t | t`.
3. HTTP: `/api/health` 200; `/` 200; `/reset-password.html` 200.
4. Anonymous probes must stay closed: `/api/admin/marketing/status` 401,
   `/api/telegram/status` 401, `/api/telegram/webhook` 401 on a bad secret.
5. Frontend smoke (the only customer-visible change): load `/`, sign in, open
   Profile - the Telegram link section renders, `/api/telegram/link` answers JSON
   for an authenticated session (not the SPA HTML).
6. First provider deposit after deploy: a `deposit_confirmed` row appears in
   `conversion_events` (042 + 040 working). No Telegram message is sent by this
   check unless the conversion worker is running, which it is not.

## 6. Rollback

| Object | Rollback | Effect |
|---|---|---|
| 043 | re-apply `038_marketing_broadcast.sql` | restores the 2/5/2 RPCs; the lease columns/index are additive and may stay. Only safe while no new-code worker runs. |
| 042 | re-apply `021_provider_referral_award_correctness.sql` | provider credits stop setting `credited` again (D1 returns) |
| 041 | `drop function confirm_legacy_deposit_safe(bigint,bigint); drop function conversion_backfill_missing(integer,integer);` then `alter table public.deposits drop column if exists credited;` | revert the code first: the new server falls back safely, the old server never used the column |
| 040 | drop its triggers and functions, then its tables (`conversion_notifications`, `conversion_events`) | the outbox has no producer once the triggers are gone |
| 039 | `drop table public.telegram_account_links;` | account linking stops working (fails closed) |
| 038 | `drop table` the four marketing tables | publishing already disabled |

Code rollback is `git revert <commit>` (or redeploy the previous Render build) -
never force-push. Reverting the code while 043 is applied is fine only because
publishing is disabled; do not leave that state with publishing enabled.

No migration or rollback in this set deletes customer money data.
