# Administrator provisioning and transition procedure

Status: implemented in code, **not executed**. This document is the operator
procedure. Nothing here has been run against production, and no account,
password, wallet or database row was read or changed while writing it.

## Why this exists

The application used to run `seedAdmin()` on **every** startup. If an account
`admin@arbitrix.ai` did not exist, it created one with:

- a hard-coded password (`admin123`),
- `is_admin = 1`,
- a wallet funded with `live_balance = 5000`,
- a log line that printed the email and the password.

That is a published credential with administrative rights, created silently in
any environment. It has been removed.

## What the code does now

`services/AuthEntry.js` + `server.js` (`initAdminProvisioning`):

| Rule | Behaviour |
|---|---|
| No configuration | Nothing happens. Startup is silent. No account is created. |
| Only one of the two values set | Warning, nothing created. |
| Invalid email | Warning, nothing created. |
| Weak password | Warning, nothing created. |
| Both valid | Creates the account **only if the email is absent**. |
| Email already exists | **Completely untouched** - no password reset, no role change, no wallet change. |
| Wallet | Created explicitly at `0 / 0 / 0` so the new-user promotional seed is not applied. One retry on a transient error. |
| Wallet still failing | Reported as **`partial`** - the account exists but is NOT fully provisioned, and a loud warning is logged. |
| Email case | The lookup tries an exact match first, then a case-insensitive match confirmed on the normalised address, so `Admin@...` is found for `admin@...`. |
| Concurrent starts | Two instances cannot both create the account when `users.email` is unique; the loser reports `exists`. See "Known limitations". |
| Logging | Status and account id only. Never the email, never the password. |

### Provisioning result states

| `status` | Meaning | Action |
|---|---|---|
| `disabled` | Neither variable is set. | None. |
| `incomplete` | Only one of the two variables is set. | Set both or neither. |
| `invalid-email` / `weak-password` | Rejected before any database call. | Fix the value. |
| `exists` | An account already uses that address; nothing was changed. | Verify it is the account you expect. |
| `created` | Account and zeroed wallet both exist. | Use it. |
| **`partial`** | The account was created but its wallet was NOT (after a retry). | **Not usable as provisioned.** Create the wallet row with `demo_balance = 0, live_balance = 0, bonus_balance = 0` before signing in; otherwise the first wallet read would seed the promotional balance. |
| `error` | Nothing was created. `reason` names the step. | Read the warning line. |

The `partial` state exists because an account without a wallet is not the thing
the operator asked for: reporting "created" would hide a half-finished change.

Password requirements (validated before any database call): at least 12
characters, at least 3 of the 4 character classes (lower, upper, digit,
symbol), not in a small common-password list, not containing the email name,
at most 72 bytes (bcrypt's limit).

## Configuration

```text
ADMIN_PROVISION_EMAIL=operator@your-domain.example
ADMIN_PROVISION_PASSWORD=<generated, stored in your secret manager>
```

Generate the password yourself, for example with `openssl rand -base64 24`,
and put it in the secret manager before you paste it into the host environment.
Do not commit it, do not put it in shell history on a shared machine, and remove
both variables once the account exists.

## Procedure A - check whether the legacy seeded account exists

Read-only. Run in the Supabase SQL editor (or any read-only SQL console).

```sql
-- 1. Does the legacy account exist?
select id, email, is_admin, created_at
from public.users
where lower(email) = 'admin@arbitrix.ai';

-- 2. List every administrator, so an unexpected one is visible.
select id, email, is_admin, created_at
from public.users
where is_admin = 1
order by created_at;

-- 3. Check what that account holds. Read-only; change nothing here.
select w.user_id, w.live_balance, w.bonus_balance, w.demo_balance
from public.wallets w
join public.users u on u.id = w.user_id
where lower(u.email) = 'admin@arbitrix.ai';
```

Interpretation:

- **No row in (1)** - the legacy account does not exist in this environment.
  Nothing to rotate. Go to Procedure C if you need an administrator.
- **A row in (1)** - treat the credential as compromised (it was published in
  the source repository for the whole period it existed). Go to Procedure B.
- **Any administrator in (2) you do not recognise** - escalate before making
  changes; do not delete it as part of this procedure.

## Procedure B - transition an existing seeded account

Do not delete the account: it may own audit history, KYC review records or
support conversations. Do not run an `UPDATE users SET password_hash = ...`
statement from this document.

1. Have the legitimate owner of the account use the normal **Forgot password**
   flow (or an administrators' password manager entry) to set a new, strong
   password. This writes a new hash through the application, which is the
   supported path.
2. Ask them to complete 2FA enrolment if it is not already enabled.
3. If the account must not be used any more, demote it deliberately
   (`is_admin = 0`) and create a named administrator instead - that is an
   approved operational change, not part of this fix.
4. Read `public.audit_logs` for activity by that account around and after the
   deployment. The route names and timestamps are enough to spot unexpected
   admin actions.
5. Check the wallet figures from Procedure A step 3. The old seeder granted
   `5000`; that is not customer money and should be reviewed by finance before
   any adjustment. Do not change balances from this procedure.

## Procedure C - provision a new administrator

1. Generate a strong password and store it in the secret manager.
2. Set `ADMIN_PROVISION_EMAIL` and `ADMIN_PROVISION_PASSWORD` in the host
   environment and restart the service.
3. Confirm the log line:
   `[AdminProvisioning] administrator created (id=<id>) with a zeroed wallet`.
   If it says `left unchanged`, the account already existed - verify it is the
   one you expect before using it. If it says `PARTIAL`, the account exists but
   its wallet does not: finish the wallet row before using the account (see
   "Provisioning result states").
4. Sign in and confirm `is_admin` is effective in the admin area.
5. Remove both environment variables and restart again. Provisioning is
   idempotent, so leaving them set is not dangerous, but the password should
   not live in the runtime environment longer than necessary.

## Rollback

The change is code-only and additive; no migration is involved. Reverting the
commit restores the previous startup behaviour, which would re-create the
default account **if it is missing** - do not revert as a way to regain access.
Use Procedure C instead.

## Client IP trust (proxy configuration)

Several controls key on the caller's address: the login and registration rate
limits, the forgot-password rate limit, the email-change and 2FA audit records,
and the referral-config audit trail. That address now comes from Express
`req.ip`, never from a raw `X-Forwarded-For` header (`services/ClientIp.js`).

`req.ip` is only meaningful if the proxies in front of the app are declared:

| Setting | Effect |
|---|---|
| (neither set) | **Trust nothing.** `req.ip` is the direct peer. Safe against spoofing, but behind a proxy every request shares the proxy's address, so the per-IP limits become a coarse shared limit. |
| `TRUST_PROXY=loopback,10.0.0.0/8,...` | Express trusts the listed ranges. Preferred when the ranges are known: it does not depend on counting hops. |
| `TRUST_PROXY_HOPS=2` | Express trusts that many proxies immediately in front of the app. Correct only if the app cannot be reached directly (see below). |
| `TRUST_PROXY=true` / `*` / `all` | **Refused.** The setting is ignored with a warning, because it would accept a client-supplied chain. |

How to verify the deployed behaviour (one request, no data change):

1. Send a request to an endpoint that echoes nothing but is rate limited - for
   example a deliberately wrong login - carrying a distinctive header:
   `X-Forwarded-For: 203.0.113.77`.
2. Check which address the server recorded (the startup log line
   `[proxy] client IP trust: ...` shows the mode; the 2FA/email-change audit rows
   and the forgot-password log show the address).
   - Not `203.0.113.77` -> the header is ignored. Expected when no proxy is
     trusted.
   - Exactly the address your edge appends -> trusted chain working.
   - The attacker-supplied value -> the hop count is too high for the real
     topology; lower it or switch to `TRUST_PROXY` CIDRs.

The repository contains no recorded topology (no `render.yaml`, no edge
configuration), so the correct hop count is **not** proven by source. The safe
default is "trust nothing"; set the value for your actual deployment and verify
it as above. If the app is reachable directly as well as through the proxy (for
example a public `*.onrender.com` hostname next to the proxied domain), a numeric
hop count can be spoofed by using the direct route - use `TRUST_PROXY` CIDRs, or
restrict direct access.

## Rate limiting architecture

| Bucket | Default | Counts |
|---|---|---|
| Login per IP | 60 per 15 min | every attempt |
| Login per account | 10 failures per 15 min, then cooldowns | failed passwords only, cleared on success |
| Registration per IP | 20 per hour | every attempt |
| Forgot password | 5 per IP per 15 min, 3 per email per hour | pre-existing, unchanged |

Characteristics to keep in mind:

- **In-process memory.** Counters live in the Node process. A restart (deploy,
  crash, host recycle) clears them. With several instances the effective limit is
  multiplied by the instance count, and a user may be counted separately on each.
  The current deployment is a single web service; this is acceptable there but
  must be revisited before horizontal scaling. A shared store (Redis/Postgres)
  would be required for a platform-wide limit.
- **Bounded memory.** Each bucket keeps at most 20,000 keys. Cleanup is
  amortised: an individual record is always judged by its own window, a full
  sweep runs at most once a minute, and an over-capacity bucket evicts a batch
  down to 90% of the cap rather than one key per request. Key churn can
  therefore neither grow memory without limit nor turn each request into a full
  scan. Eviction may forget the oldest counters first; that is the deliberate
  trade-off for a bounded cost.
- **Fixed windows** for the IP and registration buckets: a client can burst at a
  window boundary (up to twice the budget within a few seconds). The account
  bucket uses a rolling window instead.
- **Per-account lockout is bounded, not permanent.** The 10th failure inside the
  rolling 15-minute window starts a 15-second cooldown; each further failure
  doubles it (30s, 60s, capped at `AUTH_RATE_LIMIT_LOGIN_COOLDOWN_MAX_SEC`,
  default 120s). A successful login clears the record. Failures age out of the
  window, so an account recovers on its own. A targeted attacker can delay a
  sign-in by at most the cap, never lock it out permanently; total attempts per
  window remain in the same range as a hard 10-per-15-minute block.
- **Enumeration.** Throttle responses are identical whether or not the account
  exists.

## Known limitations

- `users.email` had no uniqueness guarantee in the migrations tracked by this
  repository (the table predates them), so two concurrent cold starts in an
  environment where the account is missing could create two rows. Provisioning
  handles the violation gracefully, and `supabase/migrations/056_users_email_unique.sql`
  now adds a guarded, case-insensitive unique index - **not applied yet**; follow
  its operator procedure. See `docs/security/AUTH_SESSION_HARDENING.md`.
- Without a configured proxy trust, per-IP limits degrade to a shared limit. That
  is a availability/config decision, not a spoofing hole: an unconfigured proxy
  makes the limit stricter, never weaker.

## What this procedure deliberately does not do

- It does not reset, disable, delete or modify any existing account.
- It does not read or write production data.
- It does not change wallet balances.
