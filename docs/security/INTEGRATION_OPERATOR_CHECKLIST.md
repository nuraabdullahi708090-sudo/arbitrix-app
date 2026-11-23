# Integration and go-live operator checklist

Covers PR **#201** (`fix/trusted-proxy-and-auth-hardening`, which contains all of #200) and
PR **#202** (`fix/onboarding-activation-ux`).

This checklist is the operator-facing half of the pre-merge audit. The audit itself changed
no production configuration, applied no migration and merged nothing: every step below is
yours to run, in order. Nothing in this file is a secret, and no step asks you to paste a
secret into chat.

Background, findings and the reasoning behind each item:
`docs/security/AUTH_SESSION_HARDENING.md` (sections 1-9),
`docs/security/ADMIN_PROVISIONING.md`, `docs/ux/ONBOARDING_ACTIVATION_AUDIT.md`.

---

## 0. Re-verify state before you start (read-only)

The facts below were true at the time of writing; confirm them yourself rather than trusting
this file.

```bash
REPO=nuraabdullahi708090-sudo/arbitrix-app
gh pr view 201 --repo $REPO --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup \
  -q '"head=\(.headRefOid[0:7]) \(.mergeable)/\(.mergeStateStatus) " + ([.statusCheckRollup[]|"\(.name)=\(.conclusion//.status)"]|join(" "))'
gh pr view 202 --repo $REPO --json draft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup \
  -q '"draft=\(.draft) head=\(.headRefOid[0:7]) \(.mergeable)/\(.mergeStateStatus)"'
```

Expected: both `MERGEABLE/CLEAN` with `npm test` and `static checks` green.

**Blocking precondition:** #202 is an **open DRAFT**. A draft cannot be merged; it must be
marked "Ready for review" first (GitHub UI, or
`gh pr ready 202 --repo nuraabdullahi708090-sudo/arbitrix-app`). Do this in step 3.3, after
#201 is merged and verified, so #202 is reviewed against the merged `main`.

---

## 1. Pre-merge, read-only (do all of this BEFORE merging anything)

### 1.1 Take a database snapshot

Both PRs are code-only with one additive migration (`056`), but `056` creates an index on
`users`, so there must be a restore point. Supabase Free has no scheduled backups.

```bash
# Either: the CLI (uses the linked project)
supabase db dump --db-url "$SUPABASE_DB_URL" -f pre_201_$(date +%F).sql

# Or: pg_dump directly (use the SESSION pooler on port 5432, never 6543)
pg_dump "$SUPABASE_DB_URL" -Fc --no-owner -f pre_201_$(date +%F).dump
pg_restore --list pre_201_$(date +%F).dump | head   # proves the dump is not empty
ls -l pre_201_*                                     # a 0-byte file means it failed
```

Do not proceed if the dump is empty or `pg_restore --list` errors.

### 1.2 Inventory the legacy administrator

`#201` (via #200) removed the unconditional seeder that used to create `admin@arbitrix.ai`
with a published password. The seeder is gone, but **an existing row is untouched** - if the
account was ever seeded, that password still works.

```sql
-- read-only
select id, email, is_admin, created_at
from public.users
where lower(email) in ('admin@arbitrix.ai') or is_admin is true
order by created_at;
```

If `admin@arbitrix.ai` exists, plan its rotation (step 2.1). Do not delete it blind - it may
own audit rows.

### 1.3 Decide the four configuration questions

Answer these now; each one is applied at a specific later step, so deciding early avoids a
second deploy window.

| Question | Default in code | Decide |
|---|---|---|
| Is `RATE_LIMIT_IP_MAX` / `AUTH_RATE_LIMIT_LOGIN_IP_MAX` / `AUTH_RATE_LIMIT_REGISTER_IP_MAX` currently set in Render? | unset | If they are set to a small value while no proxy is trusted, they cap **every customer combined**. Either configure proxy trust (2.3) or unset them. Never set them to `0` in production (0 = unlimited). |
| `TRUST_PROXY` vs `TRUST_PROXY_HOPS` for Cloudflare -> Render | neither (trust nothing) | See 2.3. |
| `AUTH_REVOCATION_REQUIRE_STORE` | `false` (fail-open) | See 2.4. |
| Rotate `JWT_SECRET` / `TOTP_ENCRYPTION_KEY`? | existing values | See 2.5 / 2.6. `TOTP_ENCRYPTION_KEY` rotation is destructive for enrolled TOTP users. |

---

## 2. Merge sequence

Order matters for one reason only: `#201` contains `#200`'s commits, so merging `#201` first
supersedes `#200` cleanly and leaves nothing behind. The two PRs are otherwise independent -
rehearsed in both orders, they produce byte-identical trees (only `AGENTS.md` conflicts, in
both directions).

### 2.1 Merge #201

```bash
gh pr merge 201 --repo nuraabdullahi708090-sudo/arbitrix-app --squash   # or --merge
```

Render auto-deploys on `main`. `#200` is then fully contained: close it with a pointer
rather than merging it (a comment on #200 already says so).

**Gate A - the deploy came up.** Within ~2 minutes:

```bash
curl -fsS https://<host>/api/health   # {"status":"ok"}
```

Then read the boot log. Expected lines and what they mean:

| Log line | Meaning | Action |
|---|---|---|
| `[proxy] client IP trust: none (default: no proxy is trusted)` | proxy trust off (safe default) | expected until 2.3 |
| `[proxy] per-IP auth limits run in SHARED-ADDRESS mode ...` | every visitor shares the edge IP | expected until 2.3; per-IP caps are shared |
| `[proxy] client IP trust: hops (TRUST_PROXY_HOPS: N)` | proxy trust configured | confirm N matches the topology |
| `[proxy] ... was rejected by Express (...)` | a typo in `TRUST_PROXY` was ignored | fix the value; the app fell back to trusting nothing |
| `[rate-limit] DISABLED in production (0 = unlimited): ...` | a limiter is off | unset those variables unless deliberate |
| `Production secret strength: ...` | short `JWT_SECRET` / `TOTP_ENCRYPTION_KEY` | rotate (2.5 / 2.6) |
| `Production configuration invalid: ...` + process exit | the guard refused to boot | the deploy is down: set the missing variable and redeploy |

No line about "Production configuration invalid" may appear: that guard exits the process.

**Gate B - authentication still works end to end** (no admin session needed):

```bash
# a wrong password must be a clean 401, not a 500
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<host>/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"x"}'

# the rate limiter must answer 429 with Retry-After after the configured budget
for i in $(seq 1 12); do
  curl -s -o /dev/null -D - -X POST https://<host>/api/auth/login \
    -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"x"}' \
    | grep -iE '^(HTTP/|Retry-After)'
done | tail -6
```

Expected: `401` repeated, then `429` with a `Retry-After` header. A `503` here means the
revocation store is unreachable **and** `AUTH_REVOCATION_REQUIRE_STORE=true`; see 2.4.

### 2.2 Close #200 as superseded

```bash
gh pr close 200 --repo nuraabdullahi708090-sudo/arbitrix-app \
  --comment 'Superseded by #201, which contains every commit of this branch plus the follow-up hardening. Merged via #201; closing rather than merging to avoid a duplicate merge commit.'
```

### 2.3 Mark #202 ready and merge it

```bash
gh pr ready 202 --repo nuraabdullahi708090-sudo/arbitrix-app
gh pr view 202 --repo nuraabdullahi708090-sudo/arbitrix-app --json mergeable -q .mergeable
gh pr merge 202 --repo nuraabdullahi708090-sudo/arbitrix-app --squash
```

If GitHub reports a conflict, it is `AGENTS.md` only: both branches append a documentation
section at the end. Keep **both** sections (either order produces the same final content).
`server.js` auto-merges; nothing else conflicts.

**Gate C - #202 behaviour on the live site.** In a browser as a live-but-unfunded account:
the activation copy matches the account state, and the deposit dialog opens from the
Available card. No console errors.

---

## 3. Database: migration 056 (after the code is live, not before)

`056_users_email_unique.sql` adds `UNIQUE INDEX users_email_lower_unique ON public.users
(lower(email))`. It is additive and non-destructive: no row is inserted, updated or deleted,
and it refuses to run when duplicates exist.

**Why it is safe to deploy the code first:** the application works without the index. The
code path that needs it (`findAccountByEmail`) also re-checks in JavaScript and reports
`ambiguous` instead of guessing, so a missing index degrades the guarantee, it does not
break login. Applying it closes the concurrent-registration race.

### 3.1 Pre-flight (read-only)

```sql
-- Duplicate non-null keys, case-insensitively. MUST return 0 rows before applying.
select lower(email) as key, count(*) as n, array_agg(id order by id) as ids
from public.users
where email is not null
group by 1
having count(*) > 1
order by n desc;

-- Blank/whitespace addresses are ordinary keys in the index: two of them collide.
select count(*) from public.users where email is not null and btrim(email) = '';
```

If the first query returns rows, resolve them first (usually a support decision: which row
does the customer own, which is the stale duplicate). The migration will refuse and change
nothing rather than pick one.

### 3.2 Apply

Run the file in the Supabase SQL editor (it is idempotent):

```sql
\i supabase/migrations/056_users_email_unique.sql   -- or paste the file contents
```

Large `users` table? The plain `CREATE UNIQUE INDEX` takes a SHARE lock that blocks writes to
`users` while it builds. At current size this is milliseconds. If it ever is not, run
`CREATE UNIQUE INDEX CONCURRENTLY users_email_lower_unique ON public.users (lower(email));`
outside a transaction and skip the file's final self-check section (CONCURRENTLY cannot run
inside a transaction).

### 3.3 Verify

```sql
select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'users' and indexname = 'users_email_lower_unique';
```

Expected: one row, `... UNIQUE ... ((lower(email)))`. Then confirm the behaviour end to end:
log in with a mixed-case spelling of a known address - it must succeed (this already worked
before 056, via the JavaScript path).

### 3.4 Rollback (056 only)

```sql
drop index if exists public.users_email_lower_unique;
```

No data is restored because none was changed.

---

## 4. Configuration after the merge

Each change below is a Render environment edit plus a restart (or a redeploy). Do them one at
a time so a log line or a metric can be attributed.

### 4.1 Trusted proxy for Cloudflare -> Render

Current behaviour with nothing configured: `req.ip` is the socket peer. Behind Cloudflare ->
Render that peer is Render's router, so every customer shares one address for rate limiting.

Choose one:

* **`TRUST_PROXY_HOPS=2`** - trust two hops (Render's router, then the Cloudflare edge), so
  `req.ip` becomes the customer. Correct **only while the app cannot be reached around the
  proxy**: the platform also serves a `*.onrender.com` hostname, and a caller hitting that
  directly can send its own `X-Forwarded-For`. If that hostname is reachable, prefer CIDRs or
  close direct access.
* **`TRUST_PROXY=<Cloudflare CIDR list>`** - trust specific ranges (Cloudflare publishes
  them). Does not depend on hop counting; the safer choice when direct access exists.
* **Leave it unset** - safe against spoofing, but per-IP limits are shared. Acceptable if you
  also unset the explicit per-IP caps (see 1.3).

Verify after the restart: the boot log must print `[proxy] client IP trust: hops (...)`
or `... cidrs (...)` - never `none` if you just configured it - and must not print
`[proxy] ... was rejected by Express`. A rejected value silently leaves trust off.

Never set `TRUST_PROXY=true`, `*` or `all`: the code refuses them, and they would let any
client choose its own address.

### 4.2 Revocation store strictness (`AUTH_REVOCATION_REQUIRE_STORE`)

Default `false`. With the store unreachable, a token revoked on **another** instance (or
before a restart) cannot be verified, so the request is allowed and a warning is logged
(`[auth] revocation store unavailable; requests are allowed without a verified revocation
state ...`). Local revocations are always enforced.

* Keep `false` for availability; the deployment is single-instance, so the residual window is
  limited to a `revoked_tokens` outage across a restart.
* Set `true` to fail closed: auth requests answer **503 + Retry-After** during such an outage.
  Correct for a security-first posture, but it means a Supabase blip logs everyone out
  temporarily. Decide, do not leave it implicit.

### 4.3 Rotate `JWT_SECRET`

Rotating signs everyone out (all existing tokens become invalid). Do it in a quiet window.

1. Generate locally: `openssl rand -hex 32` (32 bytes = 64 hex characters). Never paste it
   into chat, a ticket, or this repository.
2. Set it in Render, restart.
3. Verify: an existing session now gets `401`; a fresh login works; `/api/health` is `ok`.
4. Expect a one-time spike of 401s and of "session expired" UI as clients re-authenticate.

### 4.4 Rotate `TOTP_ENCRYPTION_KEY` - read this first

**Rotating this key makes existing TOTP secrets undecryptable.** Users enrolled in
authenticator-app 2FA would be unable to produce a valid code.

Check first whether TOTP is even in use:

```sql
select key, value from public.feature_flags where key = '2fa_type';
```

* `email` (the default) or no row: no TOTP secrets exist; rotation is safe.
* `totp`: users may be enrolled. Do **not** rotate until you have a re-enrolment plan
  (force re-enrolment for those accounts, or reset their 2FA), then rotate.
* Unknown/absent but you cannot rule out past TOTP use: treat it as `totp`.

If rotation is needed for strength only (the guard warned it is short), the safe order is:
announce, reset 2FA for affected accounts, rotate, ask users to re-enrol.

### 4.5 Neutralise the provisioning variables

If you used `ADMIN_PROVISION_EMAIL` / `ADMIN_PROVISION_PASSWORD` to create an administrator,
**remove both** from Render once the account exists. An existing account is never modified by
the provisioning path, so leaving them set is not a takeover risk - but they are live
credentials in the environment for no benefit. The startup log prints the outcome without the
password (`[AdminProvisioning] ...`).

### 4.6 Retire the legacy administrator (step 1.2)

If `admin@arbitrix.ai` exists with the old published password:

1. Sign in as that account and change the password to a unique, generated one, **or** create a
   replacement administrator explicitly (4.5) and demote the legacy row.
2. Demotion is now effective within 60 seconds: `#201` re-checks `users.is_admin` in the
   database (`adminMiddleware`) instead of trusting the 7-day JWT claim. Before #201, the
   claim alone was authoritative, so a demotion changed nothing until the token expired.

```sql
-- demote (takes effect within 60 s; the cache is bounded)
update public.users set is_admin = false where lower(email) = 'admin@arbitrix.ai';
```

Keep at least one administrator: verify a replacement can reach `/api/admin/*` before
demoting the last one. A demoted or deleted administrator gets `403`; an unreadable user
store gets `503` (retryable), never a silent allow.

---

## 5. Post-integration smoke tests

Run after the last change; all read-only, no credentials needed.

```bash
H=https://<host>
curl -fsS $H/api/health                                   # {"status":"ok"}
curl -s -o /dev/null -w 'landing %{http_code}\n' $H/
curl -s -o /dev/null -w 'partners %{http_code}\n' $H/partners
curl -s -o /dev/null -w 'how-it-works %{http_code}\n' $H/how-it-works
curl -s -o /dev/null -w 'tutorials %{http_code}\n' $H/deposit-tutorials
curl -s -o /dev/null -w 'unknown api %{http_code}\n' $H/api/does-not-exist    # 404 JSON, not HTML
curl -s -o /dev/null -w 'bad login %{http_code}\n' -X POST $H/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"x"}'   # 401
curl -s -o /dev/null -w 'webhook %{http_code}\n' -X POST $H/api/telegram/webhook \
  -H 'Content-Type: application/json' -d '{}'                                # 401 (fails closed)
```

Then, as a real user (not from this audit):

* log in, log out, log in again - the second login must succeed (revocation is per-token);
* open the deposit dialog from the Available card and close it;
* open Profile, then the subscription entry, then Support - all open, none blocked;
* if you rotate a secret, confirm an old session is rejected and a new login works.

---

## 6. Monitoring and rollback

### Watch for the first 24 hours

| Signal | Why | Threshold |
|---|---|---|
| 401 rate on `/api/auth/*` | `JWT_SECRET` rotation, revocation working | a spike right after rotation is expected, then back to baseline |
| 429 rate | per-IP limits now attributable (or still shared) | a sustained 429 across different customers means the IP budget is wrong or proxy trust is misconfigured |
| 503 on auth | `AUTH_REVOCATION_REQUIRE_STORE=true` during a store outage | should be zero if strictness is off |
| 500 on `/api/auth/register` | `056` absent or a uniqueness race | should be zero: duplicates answer 409 |
| `[proxy]`, `[rate-limit]`, `[auth] revocation` log lines | configuration drift | investigate any line that appears after the deploy, then stops | 
| Admin `403`/"not authorised" reports | `adminMiddleware` now re-checks the database | a demoted admin is refused; an unchanged admin must keep working |

### Rollback matrix

| Symptom | Revert | Database |
|---|---|---|
| Boot loop / 500s on every request | redeploy the previous `main` commit (Render: "Deploy previous commit") | none |
| Login broken after a secret rotation | restore the previous secret value | none |
| Admins locked out | restore `users.is_admin = true` for the affected row | none |
| Per-IP limits too aggressive | unset the explicit per-IP variables, or fix `TRUST_PROXY*` | none |
| `056` caused an unexpected collision | `drop index users_email_lower_unique` | index only; no rows touched |
| `#202` copy regression | redeploy the pre-#202 commit | none |

Nothing in this change set writes rows, so every database rollback is an index drop at most.

---

## 7. Known limitations carried into production

* **Revocation across instances.** Local revocations are enforced immediately; a token
  revoked elsewhere during a `revoked_tokens` outage is allowed until the store recovers
  (fail-open, logged). `AUTH_REVOCATION_REQUIRE_STORE=true` changes that to 503.
* **Rate limiting is per process.** In-memory buckets mean concurrent instances each get their
  own budget. Fine for a single Render instance; revisit before scaling out.
* **Proxy hops are a deployment assumption.** `TRUST_PROXY_HOPS=2` is only correct while the
  app cannot be reached around the proxy chain. CIDRs avoid the assumption.
* **`056` is the only database change** in this integration. It is additive, refuses
  duplicates, and is reversible with a single `DROP INDEX`.
* **#200 is superseded**, not merged: its commits live in #201's history. Close it after #201.
