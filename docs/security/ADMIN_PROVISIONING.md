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
| Wallet | Created explicitly at `0 / 0 / 0` so the new-user promotional seed is not applied. |
| Logging | Status and account id only. Never the email, never the password. |

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
   `[AdminProvisioning] administrator created (id=<id>)`.
   If it says `left unchanged`, the account already existed - verify it is the
   one you expect before using it.
4. Sign in and confirm `is_admin` is effective in the admin area.
5. Remove both environment variables and restart again. Provisioning is
   idempotent, so leaving them set is not dangerous, but the password should
   not live in the runtime environment longer than necessary.

## Rollback

The change is code-only and additive; no migration is involved. Reverting the
commit restores the previous startup behaviour, which would re-create the
default account **if it is missing** - do not revert as a way to regain access.
Use Procedure C instead.

## What this procedure deliberately does not do

- It does not reset, disable, delete or modify any existing account.
- It does not read or write production data.
- It does not change wallet balances.
