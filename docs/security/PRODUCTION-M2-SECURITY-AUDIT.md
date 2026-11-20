# Production security audit - `public.charge_subscription_safe` (M2)

Date: 2026-11-16
Repository: `nuraabdullahi708090-sudo/arbitrix-app`
Branch: `relaunch/rebrand-payment-commercial` (PR #171, still DRAFT)
Head at the start of this audit: `30722c8`
Production project: `jmhgreazilmmvuqnghgt` (Supabase, PostgreSQL)

**Status (updated 2026-11-16, later the same day).** This audit was produced WITHOUT
production access. An authorised operator has since applied the correction directly in
the production SQL Editor and supplied the verification results recorded in section
A.1. The agent that authored this document executed **no** production SQL, applied no
migration, changed no privilege, balance or transaction, deployed nothing and did not
merge or promote PR #171.

---

## A. Executive verdict

### A.1 Production status: `CLOSED - CORRECTION VERIFIED` (operator-supplied)

The operator ran the correction through the production SQL Editor and reported the
before/after states below. This is the authoritative record of the production change.

| Fact | Value | Status |
|---|---|---|
| BEFORE, `anon` could EXECUTE | yes | **VERIFIED** (operator) |
| BEFORE, `authenticated` could EXECUTE | yes | **VERIFIED** (operator) |
| BEFORE, `PUBLIC` could EXECUTE | yes | **VERIFIED** (operator) |
| BEFORE, `search_path` | null (unpinned) | **VERIFIED** (operator) |
| AFTER, `anon` can EXECUTE | **false** | **VERIFIED** (operator) |
| AFTER, `authenticated` can EXECUTE | **false** | **VERIFIED** (operator) |
| AFTER, `PUBLIC` can EXECUTE | **false** | **VERIFIED** (operator) |
| AFTER, `service_role` can EXECUTE | **true** | **VERIFIED** (operator) |
| AFTER, `search_path` | `public, pg_temp` | **VERIFIED** (operator) |
| Function signature unchanged | `charge_subscription_safe(bigint,numeric,text,text,text)` | **VERIFIED** (operator) |
| Function owner unchanged | `postgres` | **VERIFIED** (operator) |
| How it was applied | production SQL Editor, direct | **VERIFIED** (operator) |
| Migration applied as part of the correction | none | **VERIFIED** (operator) |
| Was migration 051 already applied before the correction? | no - the pre-fix state showed `search_path` null, and 051 sets it in the definition | **INFERRED** (from the operator's before-state; not separately queried) |
| Is 052/053 recorded in the migration history? | no - the correction was manual | **INFERRED** (no migration was applied) |
| Was the exposure ever exploited? | unknown - no API/database logs were available | **UNKNOWN** |
| Which script produced the after-state? | consistent with `docs/security/hotfix-charge-subscription-safe.sql` (its postcondition is exactly this state), but not proven | **INFERRED** |

What this establishes: the vulnerability described in this document **is no longer
reachable in production** - the three roles that could invoke the debit RPC no longer
can, the pinned `search_path` removes the object-resolution half, and the only
legitimate caller (`service_role`) retained its grant.

What it does not establish: whether the exposure was exercised between the moment
migration 011 was applied and the moment of the correction. No log or table was
available to this audit, and **no claim is made either way** (section E).

### A.2 Historical assessment (the state this audit was originally asked to verify)

### `INCONCLUSIVE - ACCESS OR EVIDENCE UNAVAILABLE`

The defect was **confirmed in the code** and **confirmed exploitable** on a
reproduction of the production schema, but **whether it was live in production could
not be verified** at audit time because no production read-only access was available
from this environment (section B). That was a statement about the evidence, not about
the risk: with migration 011 applied and the function not locked down, the exposure was
real and severe - which section A.1 now confirms it was.

| Question | Answer | Basis |
|---|---|---|
| Does the function exist with caller-controlled `p_user_id` / `p_price`? | YES (in the repository definition) | `supabase/migrations/011_subscription_pro.sql` |
| Did migration 014 lock it down? | NO | 014 lists only `record_trade_safe`, `credit_payment_safe`, `paymento_credit_user_safe` (x2 signatures) |
| Can `anon` execute it on a fresh 011 database? | YES, confirmed by execution | section G, TEST 2 |
| Can that debit another user's balance? | YES, confirmed by execution | section G, TEST 2 ($500.00 -> $399.98) |
| Was it exposed in PRODUCTION? | YES, until the operator applied the correction | section A.1 (verified before/after) |
| Is it exposed in PRODUCTION today? | NO - anon/authenticated/PUBLIC revoked, search_path pinned | section A.1 (verified) |
| Has it been exploited in production? | UNKNOWN - no logs available | section E |

Nothing in this document asserts that the historical window was clean, and nothing
asserts that it was abused.

---

## B. Production migration state

### B.1 What was attempted (all read-only; no SQL was sent)

| Attempt | Command (credentials omitted) | Result |
|---|---|---|
| Supabase Management API | `GET https://api.supabase.com/v1/projects` with `SUPABASE_ACCESS_TOKEN` | **HTTP 401** `{"message":"Invalid access token"}` - the stored token is not valid |
| Direct database host | DNS lookup of `db.jmhgreazilmmvuqnghgt.supabase.co` | **does not resolve** from this sandbox |
| PostgREST host | `GET https://<project-ref>.supabase.co/rest/v1/` with the service-role JWT | **curl exit 000** (no connection: DNS does not resolve from this sandbox) |
| Direct `psql` | `psql` is not installed on the host; the only Postgres image available is a local container with no route to the project | not possible |
| Database password | `SUPABASE_SERVICE_ROLE_KEY` is a 219-character **JWT API key**, not a database password | not a credential for `psql` |
| Other DATABASE_URL in the environment | belongs to a **different** project (`nhzdildbfgkwafxvjogy`) | deliberately **NOT** used - a credential issued for one tenant must never be pointed at another |

The service-role JWT was used for exactly one metadata request (the PostgREST root
above); it was never used to call an RPC, and it was never printed.

### B.2 Migration status

| Migration | Content | Production status |
|---|---|---|
| `011_subscription_pro.sql` | creates `charge_subscription_safe` (SECURITY DEFINER, no ACL, no `search_path`) | **UNKNOWN** |
| `014_financial_rpc_privilege_lockdown.sql` | locks `record_trade_safe`, `credit_payment_safe`, `paymento_credit_user_safe`; **does not mention** `charge_subscription_safe` | **UNKNOWN** |
| `051_rebrand_subscription_detail.sql` | replaces the function body (rebranded transaction detail) and now also revokes/grants and pins `search_path` | **UNKNOWN** |
| `052_charge_subscription_safe_privileges.sql` (new, this audit) | the versioned twin of the hotfix | **NOT APPLIED** (new file) |

Migration history alone would not settle this anyway: 051 revokes privileges *only when
it is applied*, and 014 was never intended to cover this function. The authoritative
check is the catalog, which is what section C's SQL reads.

### B.3 Read-only SQL for an authorised operator (fills this gap)

Run in the Supabase SQL editor. It answers "which migrations are recorded" and "what do
the catalogs actually say" in one pass. It is read-only.

```sql
-- (1) migration history, if the project records it. Only `version` is selected
--     because the other columns differ between Supabase CLI versions. If this
--     raises "relation does not exist", the project does not record migrations -
--     use query (2) alone, it is the ground truth.
select version
from supabase_migrations.schema_migrations
where version in ('011', '014', '051', '052')
order by version;

-- (2) the authoritative state of the function (see also docs/security/verify-charge-subscription-safe.sql)
select p.oid::regprocedure::text                            as signature,
       pg_get_userbyid(p.proowner)                          as owner,
       p.prosecdef                                          as security_definer,
       coalesce(array_to_string(p.proconfig, ','), '(none)') as search_path,
       coalesce(array_to_string(p.proacl, ' | '), '(null = default ACL)') as acl,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'charge_subscription_safe';
```

Interpretation:

| `anon_execute` | `search_path` | Reading |
|---|---|---|
| `true` | `(none)` | **exposed** - run the hotfix in an approved window |
| `true` | pinned | partially fixed - EXECUTE still open, run the hotfix |
| `false` | pinned | fixed (051 or 052 applied) |
| function missing | - | migration 011 was never applied; no exposure from this function |

If `supabase_migrations` is not readable with the operator's role, use the catalog
result alone - it is the ground truth.

---

## C. Function inspection

### C.1 Production
**Not available** (section B). No claim is made about the production definition,
owner, security mode, `search_path` or ACL.

### C.2 What the repository says the definition must be (011)

```
public.charge_subscription_safe(
    p_user_id BIGINT,
    p_price DECIMAL,
    p_idempotency_key TEXT,
    p_period_label TEXT DEFAULT NULL,
    p_billing_kind TEXT DEFAULT 'monthly'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER          <-- runs as the owner (postgres), bypasses RLS
                          <-- no SET search_path
```

There is exactly **one** overload: the defaults do not create additional signatures
(`p_period_label` / `p_billing_kind` are DEFAULTs on the same 5-argument function).

The body:

* takes `p_user_id` and `p_price` **from the caller** and never compares them with the
  authenticated identity (there is no `auth.uid()`, no `current_user` check);
* `ROUND(COALESCE(p_price,0),2)`, rejects only negative prices;
* reads `subscriptions`, `wallets`, then `UPDATE wallets SET live_balance = ...`, inserts
  `subscription_charges` and `transactions`, and advances billing dates;
* uses **unqualified** object names (`wallets`, `subscriptions`, `subscription_charges`,
  `transactions`) plus `wallets%ROWTYPE`;
* idempotency is keyed on the **caller-supplied** `p_idempotency_key`, so a new key means
  a new charge.

### C.3 Reproduced catalog state on a fresh 011 database (PostgreSQL 16.16)

```
signature                 | charge_subscription_safe(bigint,numeric,text,text,text)
owner                     | postgres
security                  | SECURITY DEFINER
proconfig                 | (none)                     <-- search_path not pinned
acl                       | (default: owner only + PUBLIC EXECUTE)
anon_can_execute          | t
authenticated_can_execute | t
service_role_can_execute  | t
definition_md5            | ec96cacfdce6ce3b7a8367f45406e434
```

`proacl IS NULL` means PostgreSQL's **default** ACL: the owner plus `PUBLIC` with
EXECUTE. That is the exposure - it is implicit, so a `REVOKE ... FROM anon` that never
runs, or that runs against the wrong signature, changes nothing.

### C.4 Reachability through the API

Supabase exposes the `public` schema through PostgREST and grants `anon`/`authenticated`
USAGE on it. `anon` needs no table privilege at all, because a SECURITY DEFINER function
runs with the owner's rights and bypasses RLS - **EXECUTE is the only requirement**.

WHO COULD ACTUALLY REACH IT (checked against this repository, not assumed): this
application does NOT ship a Supabase key in `public/` - it authenticates with its own
JWT and every database call is made server-side (`server.js` comments that the frontend
"never talks to Supabase directly", and `supabaseAdmin` is the only data client).
Reaching the RPC therefore required possession of the project's publishable `anon` key
or of a Supabase-issued JWT. That narrows the population but does not remove the risk:
the anon key is, by Supabase's design, a shareable credential, and the `authenticated`
role is reachable by anyone the project issues a Supabase JWT to. The correction in
section A.1 closes both paths regardless:

```
POST https://<project>.supabase.co/rest/v1/rpc/charge_subscription_safe
apikey: <publishable anon key>
{"p_user_id": <victim id>, "p_price": 0.01, "p_idempotency_key": "<fresh random>"}
```

That is the same code path the rehearsal exercised with `SET ROLE anon` (section G).

---

## D. Exploitability assessment

### D.1 Anonymous callers
Confirmed on the reproduction (section G, TEST 2): with the pre-fix catalog state,
`SET ROLE anon; select charge_subscription_safe(1, 0.01, 'attacker-1');` returned
`{"success": true, ...}` and debited the victim's `live_balance`.

### D.2 Authenticated callers
Identical in effect (the function never looks at the caller), but the reach differs: this
application issues its own JWTs and does not hand out Supabase ones, so the
`authenticated` role was relevant only for a caller holding a Supabase JWT (for example
a leaked service or anon key used with PostgREST). Both roles are now revoked
(section A.1), so the distinction is historical.

### D.3 Caller-controlled parameters
* `p_user_id` chooses the victim - no ownership check exists.
* `p_price` chooses the amount. The only limits are "non-negative" and the
  `live_balance >= price` gate, so the practical maximum per call is the victim's whole
  Live balance (a price above the balance returns `insufficient_balance` without
  debiting - it does not fail loudly, it simply returns success:false).
* `p_idempotency_key` defeats the duplicate protection: replaying the SAME key is
  deduplicated, but a fresh key is a fresh charge. An attacker simply picks a new key
  per call, as the rehearsal did (three calls, $100.02).

### D.4 What an attacker can and cannot do
| Capability | Confirmed |
|---|---|
| Debit any user's `live_balance` (to zero, in increments) | yes (rehearsal) |
| Create matching `subscription_charges` + `transactions` rows (visible, attributable to the victim) | yes |
| Advance / rewrite `subscriptions` (status, billing dates, price) | yes - the same update runs on a successful charge |
| Flip a victim's subscription to `payment_due` (denial of service) by calling with any price when the balance is lower | yes - by code path |
| Touch `demo_balance` / `bonus_balance` | no - the body only reads/writes `live_balance` |
| Debit a user with no subscription row | no - returns `Subscription not found` |
| Escape the transaction | no - every call is one PL/pgSQL transaction |

### D.5 `search_path` half
Confirmed: with `search_path = evil, public` the function read and debited
`evil.wallets` instead of `public.wallets` (5000 -> 4990, public untouched). Reaching
that in production requires the attacker to own a schema that appears in the request's
`search_path`; PostgREST pins its own `search_path`, so this is the *secondary* issue -
but it is exactly why a SECURITY DEFINER function must never depend on the caller's
`search_path`, and it is fixed by the same statement that fixes the ACL.

### D.6 Preconditions for live exposure
1. `011_subscription_pro.sql` applied (creates the function);
2. neither `051` nor `052` applied (or 051 applied without its ACL block);
3. PostgREST exposing `public` (Supabase default).

Any one missing removes the exposure. Section B's SQL checks all three.

---

## E. Historical activity assessment

### E.1 Classification

| Category | Finding |
|---|---|
| **1. Confirmed vulnerability** | **YES** - proven by code inspection and by reproduction on PostgreSQL 16.16 |
| **2. Confirmed exploitation** | **NO EVIDENCE OBTAINED** - not because none exists, but because no production log or table was readable |
| **3. Suspicious activity requiring investigation** | **CANNOT BE ASSESSED** - needs the queries below |
| **4. No evidence found** | **NOT CLAIMED** - no search was possible |
| **5. Insufficient logging** | **YES** - API/PostgREST logs, database logs and `pg_stat_statements` were not reachable from this environment |

The absence of evidence here is an access limitation. It must not be read as "nothing
happened".

### E.2 What logs would prove it
* PostgREST/Supabase API logs: `POST /rest/v1/rpc/charge_subscription_safe` requests with
  the `anon` key and a non-service-role JWT (the server always calls with service_role).
* Database logs: `statement`/`log_min_duration_statement` entries showing the function
  under a non-owner role (`SET ROLE anon` shows up as `role=anon`).
* `pg_stat_statements`: one row per normalised statement, including the calling `userid`
  (`pg_stat_statements.userid` = the role OID). `anon`'s OID is stable per cluster.

### E.3 What the data can prove without logs (read-only, run as operator)

The function's effects are persisted, so abuse leaves a financial trail even if the logs
have expired. These queries are read-only and do not call the function.

```sql
-- (a) charges outside the configured Pro price, or a price that is not the config value
select c.user_id, c.price, count(*) as charges, min(c.created_at) as first_seen, max(c.created_at) as last_seen
from public.subscription_charges c
group by c.user_id, c.price
order by c.price asc, charges desc;

-- (b) suspicious bursts: more than the normal one charge per billing period
select user_id, date_trunc('day', created_at) as day, count(*) as charges, sum(price) as total
from public.subscription_charges
group by 1, 2
having count(*) > 1
order by day desc, charges desc;

-- (c) subscriptions marked payment_due without a corresponding customer action
select s.user_id, s.status, s.updated_at, w.live_balance
from public.subscriptions s
left join public.wallets w on w.user_id = s.user_id
where s.status = 'payment_due'
order by s.updated_at desc;

-- (d) ledger rows whose detail is not the normal (optionally period-suffixed) label.
--     The function writes 'Arbitrix Pro Subscription' (011) or 'Kalderix Pro Subscription'
--     (051), optionally followed by ' - <YYYY-MM>', so match by PREFIX.
select user_id, created_at, amount, detail
from public.transactions
where type = 'Subscription'
  and detail not like 'Arbitrix Pro Subscription%'
  and detail not like 'Kalderix Pro Subscription%'
order by created_at desc
limit 200;

-- (e) charges that do not line up with the server's billing key namespace.
--     server.js: subscriptionBillingKey() -> `sub_<userId>_<kind>_<YYYY-MM>` where
--     kind is exactly one of: monthly (recurring), activate (first charge),
--     demo (admin sandbox). Anything else was NOT produced by the application.
select user_id, idempotency_key, price, created_at
from public.subscription_charges
where idempotency_key !~ '^sub_[0-9]+_(monthly|activate|demo)_[0-9]{4}-[0-9]{2}$'
order by created_at desc
limit 200;

-- (f) role-level evidence, if the extension is installed
select r.rolname, s.calls, s.rows, s.first_call, s.last_call
from pg_stat_statements s
join pg_roles r on r.oid = s.userid
where s.query ilike '%charge_subscription_safe%';
```

Reading (e) is the most decisive: the application always builds an internal
`sub_<userId>_<kind>_<YYYY-MM>` key, with `kind` in `{monthly, activate, demo}`
(`subscriptionBillingKey()` in `server.js`). **Any other key is either a manual admin
action or a third-party call** and should be traced. Keys written by migration 011's own
test/rehearsal data or by an operator running the RPC by hand will also appear here, so
correlate before concluding misuse. In the reproduction, the attacker's keys
(`attacker-1`, `attacker-2`, `attacker-3`, `search-path-hijack`) would appear there
immediately.

Recommended triage order: (e) -> (a) -> (b) -> the API logs for the affected users.
Do not label any row malicious without correlating it with the API/log evidence.

---

## F. Proposed correction

Two artefacts, both prepared and rehearsed, neither applied:

| File | Role |
|---|---|
| `docs/security/hotfix-charge-subscription-safe.sql` | the emergency, single-object script an operator runs in an approved window |
| `supabase/migrations/052_charge_subscription_safe_privileges.sql` | the same correction as a numbered migration, so database and repository history cannot drift |

### F.1 Statement by statement (hotfix)

| Statement | Why |
|---|---|
| `begin;` ... `commit;` | all-or-nothing: a failure in any later step rolls the whole change back |
| `do $pre$ ... to_regprocedure('public.charge_subscription_safe(bigint,numeric,text,text,text)') ... $pre$` | refuses to run against a different (or missing) signature, and refuses if the function is not SECURITY DEFINER; nothing is changed on abort |
| `create temporary table _m2_hotfix_state ... md5(prosrc) ...` | records the body hash, signature, security mode and return type so the postcondition can prove the business logic was not touched (`ON COMMIT DROP`, so it vanishes) |
| `alter function ... set search_path = public, pg_temp;` | pins object resolution. This is runtime configuration only - the body is NOT recreated, so there is no chance of a behavioural difference or a typo |
| `revoke all ... from public;` | removes the explicit PUBLIC grant if one exists |
| `revoke all ... from anon;` | closes the anonymous path (the actual exposure) |
| `revoke all ... from authenticated;` | closes the logged-in-customer path |
| `grant execute ... to service_role;` | keeps the only legitimate caller working: `server.js` calls `supabaseAdmin.rpc('charge_subscription_safe', ...)` at both the activation and the billing paths. No browser code references the function (asserted by test) |
| `do $overloads$ ... $overloads$` | if any other overload of the same name exists it is revoked and pinned too (fail closed) but **not** granted to service_role, and a NOTICE names it for manual review - an unknown overload must never be silently left exposed, nor silently granted |
| `do $post$ ... $post$` | fails the transaction unless: the body hash is unchanged, the signature/security mode are unchanged, anon and authenticated are denied, PUBLIC holds no explicit EXECUTE, service_role still works, and `search_path` is pinned |

### F.2 What the hotfix deliberately does NOT do
* It does not recreate the function (no `CREATE OR REPLACE`), so the *rebrand* change of
  transaction detail that 051 performs is not smuggled in.
* It does not touch any table, row, role, policy, index or other function.
* It does not change the price, the balance gate, the idempotency key derivation or the
  billing dates - all business logic is out of scope for a privilege hotfix.
* It does not revoke from the owner (`postgres` keeps EXECUTE, which is unavoidable and
  harmless: the owner can already do anything).

### F.3 Verification companion
`docs/security/verify-charge-subscription-safe.sql` prints a 10-row PASS/FAIL/INFO report
(function existence, owner/security mode/language, body hash, ACL, `search_path`, anon,
authenticated, PUBLIC, service_role, unexpected overloads) plus a raw catalog view. It is
SELECT-only and never calls the function. Run it **before** (expect FAIL on rows 5-7 when
exposed) and **after** (expect all PASS).

---

## G. Rehearsal results

**Server:** PostgreSQL **16.16** (x86_64-pc-linux-musl, image `postgres:16-alpine`).
**Isolation:** a throwaway Docker container created for this rehearsal and **removed
afterwards**. No staging or production database was contacted. All data in it was
synthetic (`victim@example.test`, id 1).

**Setup (reproduces the production pre-fix state):** roles `anon`, `authenticated`,
`service_role` (all `NOLOGIN`, as in Supabase); minimal `users` / `wallets` /
`transactions` / `payment_config`; stubs for `credit_payment_safe` and
`record_trade_safe` so migration 011's "other systems untouched" verification block can
pass; then `psql -v ON_ERROR_STOP=1 -f 011_subscription_pro.sql`, which ended with
`NOTICE: Arbitrix Pro subscription migration completed (deposit/trade/payment systems untouched)`.

### TEST 1 - the vulnerable catalog state
```
signature                 | charge_subscription_safe(bigint,numeric,text,text,text)
owner                     | postgres
security                  | SECURITY DEFINER
proconfig                 | (none)
acl                       | (default: owner only + PUBLIC EXECUTE)
anon_can_execute          | t
authenticated_can_execute | t
service_role_can_execute  | t
```

### TEST 2 - exploitation as `anon` (victim balance 500.00)
```
set role anon;
select charge_subscription_safe(1, 0.01, 'attacker-1');
select charge_subscription_safe(1, 0.01, 'attacker-2');
select charge_subscription_safe(1, 100.00, 'attacker-3');

{"price":0.01,  "success":true, "user_id":1, "charge_id":1, "new_balance":499.99, ...}
{"price":0.01,  "success":true, "user_id":1, "charge_id":2, "new_balance":499.98, ...}
{"price":100.00,"success":true, "user_id":1, "charge_id":3, "new_balance":399.98, ...}

balance_before 500.00 -> balance_after 399.98
charge_rows 3, charged 100.02 | tx_rows 3, tx_total -100.02
```
The attacking role had **no table privileges at all**; EXECUTE was the only thing needed.

### TEST 3 - unpinned `search_path` (before the fix)
```
create schema evil; create table evil.wallets (like public.wallets including all);
insert into evil.wallets values (1, 5000.00, ...);
set search_path = evil, public; set role anon;
select charge_subscription_safe(1, 10.00, 'search-path-hijack');

public_wallet_before 399.98 -> after 399.98   (untouched)
evil_wallet_before   5000.00 -> after 4990.00 (debited)
```

### TEST 4 - verification SQL against the vulnerable state
```
  5 | search_path pinned on the function             | (none)   | search_path=public, pg_temp | FAIL
  6 | anon can EXECUTE                               | true     | false                       | FAIL
  7 | authenticated can EXECUTE                      | true     | false                       | FAIL
  (rows 1-4, 8-10 reported as expected)
```

### TEST 5 - the hotfix
```
ALTER FUNCTION / REVOKE x3 / GRANT / DO ...
NOTICE:  HOTFIX OK: charge_subscription_safe(hotfix) - anon/authenticated/PUBLIC revoked,
         service_role kept, search_path=public, pg_temp, body md5 5b9384eba7d78eae4fa343190cd5f089 unchanged
COMMIT
```
The body hash is the **pre-fix** value, i.e. `ALTER FUNCTION ... SET search_path` did not
recreate the function and the business logic is byte-identical.

### TEST 6 - verification SQL after the hotfix
```
  1 | function exists            | present                                | present                        | PASS
  2 | owner/security/language    | postgres / SECURITY DEFINER / plpgsql  | postgres / SECURITY DEFINER / plpgsql | PASS
  3 | body hash                  | 5b9384eba7d78eae4fa343190cd5f089       | compare before/after           | INFO
  4 | effective ACL              | postgres:EXECUTE, service_role:EXECUTE | postgres + service_role only   | INFO
  5 | search_path pinned         | search_path=public, pg_temp            | search_path=public, pg_temp    | PASS
  6 | anon can EXECUTE           | false                                  | false                          | PASS
  7 | authenticated can EXECUTE  | false                                  | false                          | PASS
  8 | PUBLIC explicit grant      | false                                  | false                          | PASS
  9 | service_role can EXECUTE   | true                                   | true                           | PASS
 10 | unexpected overloads       | (none) [count=0]                       | (none)                         | PASS
```

### TEST 7 - idempotency
Running the hotfix a second time completed with the same `HOTFIX OK` notice; no error,
no drift.

### TEST 8 - runtime enforcement
```
set role service_role; select charge_subscription_safe(1, 7.00, 'legit-billing-1');
  -> {"success": true, ...}            wallet 100.00 -> 93.00    (legitimate path works)

set role anon;          select charge_subscription_safe(1, 0.01, 'attacker-after-fix');
  -> ERROR: permission denied for function charge_subscription_safe
set role authenticated; select charge_subscription_safe(1, 0.01, 'attacker-auth');
  -> ERROR: permission denied for function charge_subscription_safe
```

### TEST 9 - the pinning defeats the hijack
With the caller keeping `search_path = evil, public` and calling as `service_role`:
```
public.wallets 93.00 -> 86.00   (debited - correct)
evil.wallets   7777.00 -> 7777.00 (untouched - the function no longer resolves from the caller)
```

### TEST 10 - nothing else changed (fresh database, 011 applied)
```
BEFORE: credit_payment_safe:anon=true, fn_count_public=3, record_trade_safe:anon=true, tx_grants=7, wallets_grants=7
AFTER : credit_payment_safe:anon=true, fn_count_public=3, record_trade_safe:anon=true, tx_grants=7, wallets_grants=7
unrelated privileges: IDENTICAL
BEFORE data: balances=250.00 rows=1 tx_rows=0
AFTER  data: balances=250.00 rows=1 tx_rows=0
customer data: IDENTICAL (the hotfix wrote nothing)
```

### TEST 11 - safe failure paths
```
(a) only a DIFFERENT signature exists:  charge_subscription_safe(integer,numeric)
    -> psql exit 3
    -> ERROR: HOTFIX ABORTED: public.charge_subscription_safe(bigint,numeric,text,text,text)
       does not exist. Nothing was changed.
    -> the unrelated overload kept its default ACL and its (none) proconfig: no change

(b) no function at all
    -> psql exit 3, same clear message

(c) correct signature PLUS an unexpected overload
    -> NOTICE: HOTFIX NOTE: unexpected overload charge_subscription_safe(integer) was also
       locked down but NOT granted to service_role - review it manually.
    AFTER: charge_subscription_safe(integer)              anon=false service_role=false cfg=pinned
           charge_subscription_safe(bigint,numeric,...)  anon=false service_role=true  cfg=pinned
```

### TEST 12 - migration 052 standalone (fresh 011 database)
```
before: anon=true  cfg=none
052   : NOTICE 052 OK: ... privileges corrected (body md5 5b9384... unchanged)  COMMIT
after : anon=false auth=false svc=true cfg=search_path=public, pg_temp
re-run: NOTICE 052 OK ... (idempotent)
```

### TEST 13 - convergence with migration 051 (both orders)
```
052 -> 051 : 051 exit 0; after: anon=false auth=false svc=true pinned kalderix=true
011 -> 051 -> 052 : all exit 0; after: anon=false auth=false svc=true pinned kalderix=true
```
So the hotfix does not block the rebrand migration, and 051 does not re-open the hole.

---

## H. Migration recommendation

### Recommendation: **B - narrowly scoped hotfix first, then record 052 in the migration history**

| Option | Verdict |
|---|---|
| **A. Apply full migration 051** | Acceptable *if* 011 is present: 051 also revokes/grants and pins `search_path`, and it was rehearsed here. But it **recreates the function body** (rebranded transaction detail). In an emergency that is unnecessary blast radius: it changes what is written into `transactions.detail` at the same moment as a security fix, and it does not sweep unexpected overloads. |
| **B. Hotfix now, then 052 through the normal migration path** | **Recommended.** Smallest possible change (one ACL + one ALTER on one function), body provably untouched, immediate risk reduction, and 052 makes the repository history match the database. |
| **C. New corrective migration only** | This is 052. Doing *only* C means waiting for a migration deployment cycle before the hole closes; B gets the protection now and the same file provides the durable record. |

### Why the two artefacts are equivalent, and why that matters
`052_charge_subscription_safe_privileges.sql` is the hotfix's statements in migration
form (same precondition, same ALTER, same REVOKE/GRANT set, same overload sweep, same
postcondition). `tests/charge_subscription_safe_hotfix.test.js` compares them statement by
statement, so they cannot drift. Applying the hotfix and then 052 is a no-op the second
time; applying 052 alone has the identical end state.

### How to record it without creating history drift
1. **Preferred:** let the migration tool apply it. `supabase db push` runs
   `051_rebrand_subscription_detail.sql` and then `052_charge_subscription_safe_privileges.sql`
   and writes both versions into `supabase_migrations.schema_migrations`. Both are
   idempotent and order-independent (TEST 13), so even if the hotfix was already run by
   hand the second application is a no-op.
2. **If the hotfix is run by hand in the SQL editor** (the fastest path), either:
   * apply `052_charge_subscription_safe_privileges.sql` itself in the same window (it is
     what the hotfix is), and let the tooling record the version later; or
   * record the version explicitly once the change is confirmed:
     `insert into supabase_migrations.schema_migrations (version) values ('052');`
     This is a metadata write and must be part of the approved action, not an
     afterthought - recording a migration that was not applied is exactly the drift this
     audit is trying to avoid.
3. **Do not retro-edit 051.** If 051 is already recorded/applied in production, changing
   the file makes the repository disagree with history. 052 is additive and converges.
4. If the operator finds that 051 was **already applied** (verify SQL all PASS), no
   hotfix is needed; record 052 as already-satisfied only if the tooling requires it, or
   skip it with a note in the change record.

---

## I. Production execution checklist (for an authorised operator)

Preconditions: approval for a production privilege change; access to the Supabase SQL
editor (or `psql`) as a role that owns the function (`postgres`); a change window.

| # | Step | Expected result |
|---|---|---|
| 1 | Announce the window. No downtime is expected: the change is one `ALTER FUNCTION` + 4 ACL statements on one function. | - |
| 2 | Take a database backup/snapshot (Supabase dashboard). | backup id recorded |
| 3 | Run `docs/security/verify-charge-subscription-safe.sql`. **Save the output.** | if row 1 is `MISSING` -> stop, 011 is not applied, no exposure, close the ticket |
| 4 | Run the forensic queries in section E.3 and save the output (needed for the incident record). | results archived |
| 5 | Run `docs/security/hotfix-charge-subscription-safe.sql` in the SQL editor. | `NOTICE: HOTFIX OK ...` and `COMMIT` |
| 6 | Run `docs/security/verify-charge-subscription-safe.sql` again. | rows 5-10 all `PASS`; row 3 body hash identical to step 3 |
| 7 | Smoke test the legitimate path: activate/reactivate a subscription for an internal test account and confirm a charge appears (balance debited, `subscription_charges` + `transactions` row). | charge succeeds via the server |
| 8 | Negative check (optional, safe): `POST /rest/v1/rpc/charge_subscription_safe` with the anon key must now return `permission denied for function charge_subscription_safe`. | denied |
| 9 | Record the migration: apply `052` through the pipeline or insert its version (section H). | `schema_migrations` contains 052 |
| 10 | Monitor for 15 minutes: `/api/subscription`, `/api/subscription/activate`, 5xx rate, activation failures. | unchanged |
| 11 | Attach the step 3/4/6 outputs to the change record and, if the forensics found anything, open an incident. | - |

**Rollback:** the SQL file carries a commented rollback that restores the pre-fix
privileges. Using it re-opens the vulnerability, so it is only appropriate to undo a
*false alarm* (e.g. the smoke test in step 7 fails). A functional failure caused by the
ACL should be fixed forward (the only legitimate caller is `service_role`, which the
hotfix grants).

---

## J. Remaining risks and open items

1. **Production state is unverified.** Everything here is conditional on section B's SQL.
   Until it is run, the correct status of this finding is "unknown, potentially critical".
2. **The grant to `service_role` is correct but not verified against production code.**
   It is based on the repository (`server.js` calls the RPC only through `supabaseAdmin`).
   If production runs an older/newer build that calls it with a different client, step 7
   of the checklist catches it immediately.
3. **Other SECURITY DEFINER functions remain unlocked.** The previous review identified
   `sandbox_*`, `mark_expired_invoices`, `paymento_check_duplicate_webhook`,
   `payhip_has_live_activation`, `check_verification_status` and `cleanup_*` as having no
   explicit EXECUTE revoke. None of them moves money the way this one does, but they
   should get the same treatment in a dedicated pass (with the same rehearsal discipline).
4. **Defence in depth is missing.** Even after the ACL fix, the function trusts its
   `p_user_id`. A non-privileged caller can no longer reach it, but a caller-identity
   check inside the function (or moving it to a non-exposed schema) would make the
   exposure impossible rather than unreachable. That is a design change: this app uses
   custom JWT auth (no `auth.uid()`), so it needs its own decision.
5. **No evidence of exploitation could be gathered.** If the forensic queries in E.3
   return rows with unexpected idempotency keys, treat them as a security incident and
   reconcile the affected wallets before closing.
6. **051's own guards are weaker than the hotfix's** (it checks the function *name*, not
   the signature, and does not sweep overloads). That is acceptable for 051's purpose
   (rebrand) because 052 now provides the strict check, but do not rely on 051 alone as
   the security control.
7. **Nothing in this audit authorises a production change.** The hotfix, 052 and the
   verification script are prepared; applying them is a separate, approved action.
