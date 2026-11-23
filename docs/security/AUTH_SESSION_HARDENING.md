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

- `tests/session_abuse_hardening.test.js` (15 tests). Against the two baselines this
  fix replaces, **4 fail against the pre-hardening `server.js`** (the timing one at
  1,530 ms) **and 2 fail against the previous migration revision** (the scope and the
  blank/NULL reporting).
  Covered: the timing fix (asserted with an artificial 600 ms stall on the token
  writes), identical bodies for existing and unknown addresses, background work still
  running, a failing lookup unable to change the answer or crash the process, the
  prune helper against both stores (success, missing store, unsupported store,
  database error), the schedule's `unref()`, the route ordering, the pre-flight's exact
  scope, the NULL/blank reporting, the duplicate-rule matrix, the non-destructiveness
  of the migration, and the verification tool's coverage without a new dependency.
- Full suite and static checks are reported in the pull request.

## Not done here

- No migration was applied, nothing was deployed, no environment variable was set.
- No customer record, balance or withdrawal/deposit path was touched.
- No password was reset and no credential was rotated.

## Account identity is case-insensitive (migration 056 + the application half)

Migration 056 adds a unique index on `lower(email)` because account identity is the
address, not its capitalisation. That constraint is necessary but not sufficient: the
application also has to *resolve* a case variant, otherwise the same customer is told
their password is wrong (or, worse, can never reset it).

What was wrong before:

| Path | Behaviour | Consequence |
|---|---|---|
| `POST /api/auth/login` | exact `eq('email')` | `Foo@Bar.com` registered, `foo@bar.com` typed → "Invalid credentials" |
| `POST /api/auth/register` | exact duplicate check, no `23505` handling | with the index applied, a case-variant signup answered **500** instead of "Email already registered" |
| `POST /api/auth/forgot-password` | lower-cased the address, then exact `eq()` | a mixed-case account was NEVER found → no email was ever sent, so the password could not be reset |
| `POST /api/auth/email-change/verify` | exact check, raw update | a race with the index surfaced as a 500 |

Now:

* `AuthEntry.findAccountByEmail(admin, email, {columns})` is the single look-up. It tries
  the indexed exact match first (fast path, unchanged behaviour for every existing
  account), then ONE case-insensitive query, and finally compares normalised addresses in
  JS because a LIKE pattern cannot prove equality.
* `ambiguous: true` is returned when two or more rows differ only in case (possible only
  before the index is applied). Callers treat that as "no account" — signing a customer in
  with an arbitrary one of them would be worse than refusing — and log
  `ambiguous email lookup refused` for the operator.
* `getUserByEmail()` delegates to it, so login, registration, password reset, email change
  and the sandbox/admin creation paths all became case-insensitive at once.
* `23505` (unique violation) is mapped to the documented duplicate answers
  (`400 Email already registered`, `409 This email is already associated with another
  account`) instead of a 500 — that is the concurrent-registration race the pre-check
  cannot see.
* Password-reset records are looked up by token HASH (the actual secret) with the address
  compared case-insensitively, so a customer who types their address with different
  capitalisation at reset time is not stranded.

Tests: `tests/auth_email_identity.test.js` (13) — the helper's contract (exact fast path,
case variant, near-miss rejection, ambiguity, store error, empty input) and the routes over
real HTTP (case-variant login, unknown address still 401, ambiguous login refused + logged,
case-variant registration refused, `23505` race mapped to 400, reset request finds a
mixed-case account and writes a token, unknown address writes nothing).


## 4. Session revocation survives a store outage (and stops failing open silently)

### The defect

`authMiddleware` consulted `revoked_tokens` on every authenticated request and, on
a store error, logged one line and let the request through. Two consequences,
both real:

1. A token that had been revoked (logout) was **accepted again** for as long as the
   store was unreachable - signature and `exp` still valid, denylist unreadable.
2. A logout issued during the outage **failed to persist at all**
   (`POST /api/auth/logout` answered 500 and wrote nothing), so the session stayed
   valid even after the database recovered. Reproduced against the real server with
   a Supabase double whose `revoked_tokens` table always fails: pre-fix, logout
   returned 500 and the replayed token returned 200 on `/api/auth/me`.

Failing closed instead was not acceptable either: every authenticated request would
fail platform-wide during a Supabase blip, including the dashboard of customers
whose sessions were perfectly valid.

### The fix (services/TokenRevocationService.js -> createResilientStore)

The durable store is now wrapped, and `authMiddleware` keeps calling the same
`isTokenRevoked(...)`:

| Mechanism | Effect |
|---|---|
| **Local revocation is authoritative** | `revokeToken` records the jti in-process *before* attempting the durable write, so a replay is rejected by the instance that handled the logout even while the database is down (now 401, was 200). |
| **Bounded retry queue** | An unpersisted revocation is queued (max 500) and flushed on the next successful store call, so a transient outage no longer loses it. |
| **Short "not revoked" cache** | A verified answer is trusted for `AUTH_REVOCATION_CACHE_MS` (default 10 s, bounded to 20 000 entries) - the store is no longer read on every request, and a burst is survived without a per-request timeout. |
| **Circuit breaker** | After 3 consecutive failures the store is skipped for a 10 s cooldown, so a request cannot stall for the full timeout each time. Recovery is logged once. |
| **Per-call timeout** | `AUTH_REVOCATION_TIMEOUT_MS` (default 2 000 ms, clamped to 10 000). A hung store can never hang a request. |
| **Opt-in strict mode** | `AUTH_REVOCATION_REQUIRE_STORE=true` answers **503 + Retry-After** (never 401, which would make clients discard a valid token) when the state cannot be verified. Off by default. |

Logout no longer fails because of the store: the session is ended either way, and a
non-durable revocation is logged (`revocation is not durable yet; it is enforced
locally and queued for retry`).

### Residual risk (documented, not hidden)

With strict mode off, during an outage a token revoked by a **different** instance -
and not yet observed by this one - can still be used until the store recovers. Local
revocations and anything already seen as revoked are always enforced. The deployment
is a single web instance, so this window requires a multi-instance topology, and
strict mode is the answer for one.

### Verification

`tests/auth_revocation_resilience.test.js` (17): local enforcement with a failing
store, retry-queue flush after recovery (observed through a second instance), cache
TTL and `0`-disables, revocation invalidating a cached opinion, circuit open/half-open
/recovery, a hanging store resolving inside the timeout, strict mode (typed error,
503 over HTTP), bounded queues/caches, environment parsing, and the real HTTP proof
that **logout still revokes while the store is down** and that strict mode answers
503. Both HTTP cases **fail on the pre-fix code** (verified by reverting the two
server files in place).

## 5. Rate-limit buckets: a flood cannot buy a bypass, and nothing grows unbounded

### The defect (two, both reachable unauthenticated)

1. **Eviction was oldest-first**, and the account bucket is keyed by a
   caller-supplied address. Anyone can mint unlimited distinct keys; filling the
   bucket (20 000) pushed a **victim's live lockout** out of it and the password
   guessing could continue. The flood itself is throttled by the per-IP budget
   (60/15 min per address, 5 000/15 min shared), but 20 000 keys is ~334 addresses
   - or four in shared-address mode.
2. **The per-entry failure history was unbounded** inside the window: every failed
   attempt appended a timestamp and every later attempt re-filtered the array, so a
   single targeted account could accumulate thousands of samples (memory plus O(n)
   work per attempt).
3. `rateLimitStore` (forgot-password IP and per-address buckets) had **no ceiling
   at all**; its 5-minute sweep was the only bound, so a burst of distinct
   addresses inside one window grew the map freely.

### The fix

- Eviction now ranks entries: `2` = a live lockout, `1` = counting failures,
  `0` = inert. Inert entries go first (oldest first), so a flood spends its budget
  on the attacker's own keys. Sorting happens only while over capacity, and the
  arrival rate of new keys is itself limited by the per-IP bucket.
- The failure history is capped at `loginAccountMax + 4` samples. The cooldown
  doubles per failure but is clamped at `loginCooldownMaxMs`, so the cap changes no
  behaviour while bounding memory and per-attempt work.
- Buckets are trimmed **immediately after an insert** that crosses the ceiling, so
  `stats()` can never exceed `maxEntries`.
- `checkForgotPasswordRateLimit` enforces `RATE_LIMIT_MAX_ENTRIES` (20 000) on
  insert, and the 5-minute timer sweeps with **each bucket's own window** (a
  regression pin exists for the zero-window mistake that would have wiped the map
  every tick).
- `stats()` exposes `maxEntries` next to the live sizes.

### Verification

`tests/auth_rate_limit_resilience.test.js` (13): the flood-vs-lockout case and the
history cap **both fail on the pre-fix limiter**; plus eviction ordering, long-flood
bounds, legitimate burst, cooldown expiry, IP-vs-account independence, the reset-map
ceiling and sweep windows (executed from the real `server.js` in a vm), the normalised
bucket key, and two real-HTTP cases (case variants share one budget; an unthrottled
account still signs in).

## 6. Proxy trust: invalid values can no longer crash the app

`services/ClientIp.js` validated `TRUST_PROXY` with regexes, so `999.1.1.1`,
`1.2.3.4/99` and `::::` passed the validator and then threw inside
`app.set('trust proxy', ...)` while `server.js` was loading - an operator typo
became a boot crash loop. Validation now uses `net.isIP` plus a per-family prefix
range (32 / 128), and `app.set` is guarded: anything Express still rejects falls
back to "trust nothing" with a loud warning, which is the safe direction.

An unusually broad range (IPv4 shorter than /8, IPv6 shorter than /16) is honoured
but reported at every boot, because a caller inside it can choose its own address.

The Cloudflare -> Render chain was re-verified by execution (not assumed): with two
trusted hops, `X-Forwarded-For: <spoofed>, <customer>, <cf-edge>` resolves to the
customer, so rotating the client-controlled prefix does not create new identities.
`tests/trusted_proxy_ip.test.js` (18) pins it, together with the invalid-value
matrix and the broad-range warning.


## 7. Login response time no longer reveals whether an account exists

Same class as the reset-timing defect in section 1, found during the pre-merge
audit of the login handler.

`/api/auth/login` (and `/api/2fa/login-initiate`) answered one 401 for both cases,
but a KNOWN account ran `bcrypt.compare` (cost 10, ~75 ms) while an UNKNOWN address
answered after a single failed lookup. Measured against the real server: **3.7 ms
for an unknown address versus ~75 ms for a wrong password** - the duration alone
answered "is this person a customer here?" for anyone willing to time the request.

The unknown branch now compares the submitted password against a throwaway bcrypt
hash (`LOGIN_TIMING_EQUALISER_HASH`) and ignores the result, so both branches do the
same work. The constant is not a secret and grants nothing: it is only ever compared
against input, and the branch returns before any token is issued.

Pinned by `tests/auth_login_timing.test.js` (2 tests). The timing assertion **fails
on the pre-fix handler** (measured 3.7 ms).
