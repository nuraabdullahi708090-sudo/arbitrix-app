# Authentication and session hardening - remaining follow-ups

Status: implemented in code, **not deployed**. Migration 056 is **not applied**.
No production database, account, balance or environment variable was touched.

Continues `docs/security/ADMIN_PROVISIONING.md` (provisioning, proxy trust and the
rate-limit policy all live there). This document covers the three items that were
listed there as open.

## 1. Password reset: the response time no longer reveals whether an account exists

### The defect

`POST /api/auth/forgot-password` always answered with the same body ("If an account
with that email exists, we have sent a password reset link."), but it did the work
**before** answering:

```
existing address : lookup -> invalidate old tokens -> insert token -> send email -> 200
unknown address  : lookup -----------------------------------------------------> 200
```

Measured against the real handler with the token-table writes stalled by 600 ms:
**1,533 ms for an existing address versus roughly 30 ms for an unknown one**. The
uniform body was therefore not enough - the duration alone answered the question
"does this person have an account here?".

### The fix

The route answers first and runs the address-dependent work detached
(`setImmediate`), so the response no longer contains any information about the
address:

```
any address : 200 (uniform body)   ->   [detached] lookup -> writes -> email
```

Measured after the change with the same 600 ms stall: the response returns in
**under 300 ms** while the background work still completes (both are asserted by
`tests/session_abuse_hardening.test.js`).

Details that matter:

- `processPasswordResetRequest()` catches **and logs** every failure. The caller has
  already answered, so an error can never become an oracle either.
- The rate limiter still runs **before** the response, so a throttled request is
  rejected exactly as before, for existing and unknown addresses alike.
- Both the per-IP and the per-address counters are keyed on the **submitted**
  string, so neither creates an existence signal.

### Deliberate trade-off

If the process stops in the few hundred milliseconds between the response and the
email being queued, that email is not sent; the customer simply requests another
one. This is the standard trade-off for a non-enumerable reset endpoint, and it is
why the work is small (one lookup, two writes, one provider call).

## 2. Revocation records are now pruned

`POST /api/auth/logout` inserts the token's `jti` into `public.revoked_tokens`
(migration 025). The lookup ignores expired rows (`expires_at > now()`), but nothing
ever deleted them, so the table could only grow - one row per logout, forever.

- `TokenRevocation.pruneExpired(store)` deletes them. It never throws: a missing RPC
  or a transient database error returns `{ ok: false, reason }`.
- The Supabase store delegates to `public.prune_revoked_tokens()` (already defined
  in migration 025, `service_role` only). The in-memory store (tests) prunes its own
  map.
- `server.js` runs it once shortly after boot (60 s, so startup is never blocked) and
  then daily. Both timers are `unref()`ed, so they can never hold the process open.
- A failure is logged **once** (`[auth] revocation prune unavailable (...)`) rather
  than on every attempt. Rows remain harmless while unpruned - they are ignored at
  lookup time - so this is housekeeping, not correctness.

Operators can run it manually at any time:

```sql
select public.prune_revoked_tokens();
```

## 3. One account per email address is now enforced by the database

Registration, admin provisioning and password reset all assume one row per address.
No tracked migration declared that, so the assumption was enforced only by
application code - which a concurrent registration, or two cold-start provisioning
attempts, could defeat.

`supabase/migrations/056_users_email_unique.sql` adds one thing:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique
    ON public.users (lower(email));
```

- **Guarded pre-flight.** If two or more rows already share an address
  (case-insensitively) the migration raises with the number of duplicated addresses
  and changes **nothing**. It never deletes, merges or rewrites an account - that is
  a support decision.
- **Idempotent.** `IF NOT EXISTS`; a second run is a no-op.
- **NULL/blank emails are unaffected** (standard unique-index semantics), so accounts
  without an address keep working.
- **Self-checking.** A trailing block asserts the index exists, is unique and is the
  `lower(email)` expression index.
- On a large table, run the equivalent `CREATE UNIQUE INDEX CONCURRENTLY` outside a
  transaction instead (noted in the file).

### What "duplicate" means here (scope, fixed after review)

The index is keyed on `lower(email)` for **every row**. A unique B-tree treats `NULL`
as distinct, so any number of rows with `email IS NULL` coexist. Everything else is an
ordinary non-`NULL` key:

| Value in `users.email` | Two rows with it | Why |
|---|---|---|
| `NULL` | allowed | `lower(NULL)` is NULL; NULLs never conflict |
| `''` (empty string) | **refused** | an ordinary non-NULL key; two identical ones collide |
| `'   '` (whitespace) | **refused** if identical | same rule |
| `''` and `'   '` together | allowed | they are different strings |
| `A@x.test` and `a@x.test` | **refused** | the index is on the lowercased value |
| `A@x.test` and `' A@x.test '` | allowed | padding makes a different key |

The first revision of the migration filtered the duplicate check with
`btrim(email) <> ''`, so two empty or two identical whitespace-only addresses slipped
past the guard and `CREATE UNIQUE INDEX` failed with a raw `could not create unique
index` error instead of the migration's own explanation. The check now covers exactly
the index's scope (every non-`NULL` row), counts blank duplicates separately so the
message is legible, and reports how many `NULL`, checked and blank values it saw.

The migration never normalises, merges or deletes anything: a duplicated blank value is
**refused**, not repaired. Resolving it is an operator decision.

### Operator procedure

1. Read-only pre-flight (safe at any time). It uses the same scope as the migration,
   so a duplicate blank address is visible here too:

   ```sql
   select case
            when btrim(lower(email)) = '' then '<blank or whitespace>'
            else lower(email)
          end as address,
          count(*)
   from public.users
   where email is not null
   group by lower(email)
   having count(*) > 1
   order by count(*) desc;
   ```

2. If it returns rows, resolve those accounts first (support decision; do not delete).
   Blank or whitespace-only duplicates are almost always data-entry junk - correct
   them through the normal account process, never by hand-editing balances.
3. Apply `056_users_email_unique.sql`. Re-running it is safe.
4. The application needs no change: registration already rejects an existing address,
   and provisioning already reports `exists` when a concurrent insert wins.

### Verifying the migration without a database server

`scripts/verify-migration-056.js` executes the **real migration file** against
PostgreSQL compiled to WebAssembly (PGlite) and checks 14 cases: no rows, idempotent
re-apply, distinct addresses, two/three empty strings, identical whitespace, identical
padded values, case-only duplicates, a mixed blank + address duplicate, plus the
allowed coexistences (`NULL`s, `''` vs `'   '`, padded vs plain, a single blank).

```bash
npm install --no-save @electric-sql/pglite   # out of tree; no manifest change
node scripts/verify-migration-056.js          # exit 0 = all cases behave
```

It is deliberately **not** a CI dependency: adding a WASM database engine to the
project for one migration guard would be a supply-chain change with no runtime value.
Against the pre-fix revision it reports **6 of 14 cases failed** (the blank/whitespace
duplicates reached the raw index error, and a mixed case under-counted); against the
current file it reports all 14 passing.

## 4. Correcting the record: logout was already authenticated

An earlier summary listed "`/api/auth/logout` is unauthenticated" as an open item.
That is **not** the case: the route has been declared as
`app.post('/api/auth/logout', authMiddleware, ...)` since the revocation work landed.
An unauthenticated caller cannot insert revocation rows, and a token that is already
revoked receives `401` from `authMiddleware` by design (documented in the route
comment, and the client clears its local session regardless).

## 5. Out of scope by design: moving the JWT out of localStorage

The session token is kept in `localStorage` (`jwt_token`), so any script executing in
the page can read it. That is a real exposure, but fixing it properly is an
architectural change, not a patch, and it would touch every surface at once:

- the server must set an `HttpOnly`, `Secure`, `SameSite` cookie and parse it as an
  alternative to `Authorization`;
- a CSRF strategy is required for cookie-authenticated writes (double-submit token
  or per-request header - the current API is header-authenticated, which is CSRF-safe
  today);
- the worker/Telegram/sandbox harnesses that call the API with a bearer token need a
  supported path;
- `localStorage` tokens would have to be migrated and then removed, with a rollback
  plan.

That is a planned project, not a follow-up commit. Until it happens, the mitigations
in place are: a strict referrer policy, a CSP that forbids inline script from
third-party origins, `nosniff`, `X-Frame-Options: DENY`, server-side `jti`
revocation on logout, and a 7-day token lifetime.

## Verification

- `tests/session_abuse_hardening.test.js` (11 tests): the timing fix (asserted with
  an artificial 600 ms stall on the token writes - 4 of the 11 tests fail against the
  pre-fix code, the timing one at 1,533 ms), identical bodies for existing and unknown
  addresses, background work still running, a failing lookup unable to change the
  answer or crash the process, the prune helper against both stores (success, missing
  store, unsupported store, database error), the schedule's `unref()`, the route
  ordering, and migration 056's guards.
- Full suite and static checks are reported in the pull request.

## Not done here

- No migration was applied, nothing was deployed, no environment variable was set.
- No customer record, balance or withdrawal/deposit path was touched.
- No password was reset and no credential was rotated.
