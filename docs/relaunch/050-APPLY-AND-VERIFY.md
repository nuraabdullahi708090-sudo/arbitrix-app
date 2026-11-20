# Applying and verifying migration 050 (Payhip Live Mode activation)

Status: **NOT APPLIED.** This document is the exact procedure, written so it can be
run by an operator with database access and nothing else in front of them.

Why it is not applied already: **this environment has no route to production.**
Verified, not assumed:

| Check | Result |
|---|---|
| `getent hosts db.jmhgreazilmmvuqnghgt.supabase.co` | no DNS answer (the project host does not resolve here) |
| `api.supabase.com/v1/projects` with `SUPABASE_ACCESS_TOKEN` | `HTTP 401` |
| any Postgres client credential | none provided - `SUPABASE_SERVICE_ROLE_KEY` is an API key, not a database password |
| `psql` / `pg_dump` | not installed (Docker is, which is how the rehearsal below was run) |

So the migration was **rehearsed against a real PostgreSQL 16.16** with a
production-shaped base (`public.users` with a `BIGINT` identity key and the
`anon` / `authenticated` / `service_role` roles) and is delivered here as an exact
procedure instead of being guessed at remotely.

---

## 1. What 050 does, and what it does not do

Creates four tables (`payhip_products`, `payhip_purchases`, `payhip_entitlements`,
`payhip_events`), three sequences, and four `SECURITY DEFINER` functions:

| Function | Purpose |
|---|---|
| `record_payhip_purchase_safe(...)` | records a verified sale once (`payhip_sale_id` is the idempotency anchor) and creates the entitlement; never credits anything |
| `redeem_payhip_entitlement_safe(user, hash)` | claims a licence for ONE account, once, under a row lock |
| `revoke_payhip_entitlement_safe(sale, status, ...)` | refund/chargeback revocation; touches no balance |
| `payhip_has_live_activation(user)` | the read used by the Live Mode gate |

It does **not** credit a wallet, create a deposit, write the ledger, change a
minimum, or touch trading. Every function pins `search_path = public, pg_temp`
(the rule migration 053 applies to the other financial RPCs) and is executable by
`service_role` only.

`MARKETING_SANDBOX` behaviour is unchanged: the sandbox never needs an activation.

---

## 2. Pre-flight (read-only)

Paste `docs/sql/payhip_050_readiness.sql` into the Supabase SQL editor.

Green light:

```
1 public.users exists                  OK     found
2 users.id is BIGINT                   OK     bigint - FK-compatible ...
3 role anon exists                     OK     found
4 role authenticated exists            OK     found
5 role service_role exists             OK     found
6 payhip objects present               OK     (none - a fresh apply will create all 11)
7 sequence names available             OK     all names are free
8 NEXT ACTION                          INFO   READY - apply ... then run payhip_050_postcheck.sql
```

Stop and investigate if you see:

| Row | Value | Meaning |
|---|---|---|
| 2 | `BLOCKER` / anything but `bigint` | 050 declares `user_id BIGINT REFERENCES public.users(id)`; a UUID key aborts it |
| 3-5 | `BLOCKER` | the role does not exist and the `GRANT`/`REVOKE` statements would fail |
| 6 | `REVIEW` | a partial apply exists. `CREATE TABLE IF NOT EXISTS` keeps a partial table AS-IS and never adds missing columns - inspect by hand |
| 8 | `PARTIAL APPLY` | same as above |

---

## 3. Apply

Paste the **whole** of `supabase/migrations/050_payhip_live_activation.sql` into the
SQL editor and run it. It is one transaction (`BEGIN` ... `COMMIT`) and it is
idempotent: a second run is a no-op, which the rehearsal confirmed.

No environment variable is needed for this step, and nothing changes for a
customer while `PAYHIP_ENABLED` is unset.

---

## 4. Post-apply verification (read-only)

Paste `docs/sql/payhip_050_postcheck.sql`. Every row must read `OK`:

```
1  four payhip tables exist                        OK
2  RLS enabled on every table                      OK
3  one service_role policy per table               OK
4  no anon/authenticated policy                    OK
5  four functions present                          OK
6  every body pins search_path = public, pg_temp    OK
7  anon/authenticated cannot EXECUTE               OK
8  no function touches a wallet or the ledger      OK
9  three sequences exist                           OK
10 idempotency keys are unique constraints         OK
11 product dlxuu in the catalogue                  OK / ACTION
12 product dlxuu is ON SALE                        OK / ACTION
13 NEXT ACTION                                     INFO
```

If any row is `FAIL`, do **not** enable `PAYHIP_ENABLED`; roll back (section 7).

---

## 5. Put the product on sale

The catalogue row is deliberately created `is_active = FALSE`. `productsOnSale()`
only counts `is_active = TRUE`, so the buy button stays hidden until this runs:

```sql
INSERT INTO public.payhip_products (product_key, name, price_cents, is_active)
VALUES ('dlxuu', 'Kalderix Live Mode activation', 5000, TRUE)
ON CONFLICT (product_key) DO UPDATE SET is_active = TRUE;
```

`dlxuu` is the **link code** (`dLXuU`) lowercased - the same value the
`PAYHIP_PRODUCTS` allow-list and Payhip's licence API use. Do not use Payhip's
numeric product id here unless the webhook actually sends it (see section 6.4).

Re-run the postcheck: rows 11-13 must become `OK`, ending with
`PASS - 050 is applied and the product is on sale; checkout may be enabled`.

---

## 6. Functional verification (no real money is credited at any point)

### 6.1 Env, in this order (each row alone is safe)

```
PAYHIP_ENABLED=true
PAYHIP_API_KEY=<store API key from Payhip > Settings > Developer>
PAYHIP_PRODUCTS=dLXuU
PAYHIP_PRODUCT_SECRET=<the product secret for dLXuU>
PAYHIP_STORE_URL=https://payhip.com/b/dLXuU
PAYHIP_WEBHOOK_TOKEN=<32+ random characters>
PAYHIP_ACTIVATION_REQUIRED=true        <- the only behaviour change, set LAST
```

Then in Payhip's dashboard point the webhook at
`https://arbitrix.pro/api/payhip/webhook?token=<PAYHIP_WEBHOOK_TOKEN>`.

### 6.2 The endpoints answer - one command

```bash
node scripts/check-payhip-readiness.js --base https://arbitrix.pro
```

It prints which `PAYHIP_*` variables are present (booleans only - never a value),
the health + activation status, and one verdict line with the single next action.
Exit codes: `0` ready, `2` not deployed, `3` configured but not usable, `4` the
probe failed.

How to read the webhook probe, which is an empty `POST` with **no** token (a
refused delivery - it can never record a purchase):

| Answer | Meaning | Action |
|---|---|---|
| `404` | the route is not in the running build | deploy the branch; Payhip deliveries fail until then |
| `503 payhip-not-configured` | deployed, but configuration is incomplete; `reason` names it (`disabled`, `no-products-configured`, `missing-api-key`, `missing-webhook-token`, `weak-webhook-token`) | set the named variable |
| `401 invalid_token` | deployed and configured; the probe was correctly refused | register `https://<host>/api/payhip/webhook?token=<PAYHIP_WEBHOOK_TOKEN>` in Payhip |
| `200` | an unauthenticated delivery was accepted | stop - investigate before enabling anything |

Manual equivalent:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://arbitrix.pro/api/live/activation   # 401 without a session
curl -s -X POST https://arbitrix.pro/api/payhip/webhook \
     -H 'content-type: application/json' -d '{}' | head -c 160                     # 503 + reason, or 401 invalid_token
```

**Measured on 2026-11-18, before the deploy:** `/api/health` 200,
`/api/live/activation` **404** and `POST /api/payhip/webhook` **404** - the
relaunch build is not deployed, so any webhook registered in Payhip today points
at a missing route. That is safe (nothing is recorded) but it means the dashboard
entry must be re-checked after the deploy, and the URL must include `?token=`.

### 6.3 Prove the licence API answers (the one thing the repo cannot test)

In Payhip: **Settings > License keys**, paste one real key and call:

```bash
curl -s -X POST 'https://payhip.com/api/v2/license/verify' \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     --data-urlencode 'product_secret=<PAYHIP_PRODUCT_SECRET>' \
     --data-urlencode 'license_key=<a real key>' | head -c 400
```

A populated `data` object with `enabled: true` and `product_link: "dLXuU"` is the
expected shape. An empty `{}` means the key is not a valid licence; a timeout is an
outage (the customer is told to retry, and a funded account is never blocked).

### 6.4 End-to-end with ONE real purchase

Preferred, and the only variant allowed in production: buy the real $50 product
with a card you control, then:

1. Payhip redirects back to `PAYHIP_RETURN_URL`; the browser cannot prove payment -
   that is by design, the webhook does.
2. Within a minute, `GET /api/admin/payhip/purchases` (admin) shows the sale, or
   `SELECT payhip_sale_id, status, price_cents FROM payhip_purchases ORDER BY id DESC LIMIT 1;`
3. In the test account, Live Mode → "Redeem licence" → paste the key. Expected:
   the account becomes activated; `SELECT claimed_at, user_id FROM payhip_entitlements;`
   shows the claim; and **no wallet changed**:
   `SELECT live_balance FROM wallets WHERE user_id = <id>;` is exactly what it was.
4. Live Mode still requires a **$100** deposit - activation alone must not open it.
5. Refund the purchase in Payhip. The `refunded` webhook must set
   `payhip_purchases.status = 'refunded'`, set `revoked_at`, and `hasActivation`
   must return false on the next dashboard load.

If the webhook records `product-not-allowed`, read the identifiers saved in

```sql
SELECT detail FROM payhip_events ORDER BY id DESC LIMIT 5;
```

and add whichever of `productKey` / `productLink` appears there to
`PAYHIP_PRODUCTS` (Payhip omits the permalink on some payloads).

**Do not fabricate a webhook in production.** A hand-crafted `paid` payload would
create a purchase row that no payment backs; the redeem path would then grant a
free activation. If a synthetic test is unavoidable, do it on a staging database,
never on the production one.

---

## 6.5 Known behaviour worth telling support

**Deleting a user who holds a CLAIMED licence will fail.** The schema declares
`payhip_entitlements.user_id ... ON DELETE SET NULL`, but the table also requires
`claimed_at IS NOT NULL => user_id IS NOT NULL`, so PostgreSQL cannot null the
column on a claimed row: the `DELETE` aborts with a check-constraint violation.
Nothing is lost and no licence changes hands (the hash stays UNIQUE and the row
stays claimed) - it simply refuses. Two coherent designs, for a decision:

| Option | Change | Trade-off |
|---|---|---|
| keep the block (today) | none | an admin must revoke/refund first; the paid record cannot be orphaned by accident |
| retain the audit record | `ON DELETE RESTRICT` + relax the CHECK so a claimed row may keep a NULL owner | customer deletion succeeds, the purchase is preserved for reconciliation |

Until one is chosen, an operator deleting a customer with a paid activation should
expect the error and revoke the entitlement first (`/api/admin/payhip/purchases`
then revoke), which is the safe path anyway.

---

## 7. Rollback

| Goal | Action |
|---|---|
| Stop gating customers (10 seconds) | unset `PAYHIP_ACTIVATION_REQUIRED` and restart. Entitlement rows stay; nothing is refunded or deleted |
| Stop accepting purchases | set `payhip_products.is_active = FALSE` (the button disappears), or unset `PAYHIP_STORE_URL` |
| Remove the feature | revert the code, redeploy. The tables can stay - they hold no money |
| Drop the schema | the four `DROP FUNCTION` + four `DROP TABLE` statements at the end of 050 (export `payhip_entitlements` first: it is the only record of who paid) |

---

## 8. Rehearsal evidence (PostgreSQL 16.16, throwaway container)

The final bytes of 050 were applied to a production-shaped database and executed,
not merely parsed:

| Check | Result |
|---|---|
| Apply to a fresh schema (users BIGINT + 3 roles) | clean, self-check passed |
| Re-apply | no error, no data loss (2 purchases / 2 entitlements before and after) |
| 4 tables, RLS on all 4, 4 `service_role` policies, 0 anon/authenticated policies | verified from the catalogues |
| `service_role` holds SELECT/INSERT/UPDATE/DELETE + sequence USAGE; `anon`/`authenticated` hold nothing | verified |
| 4 functions, `search_path=public, pg_temp` on each, `anon`/`authenticated` denied at runtime (`permission denied for function ...`), `service_role` allowed | verified |
| `record_payhip_purchase_safe` on a paid sale | 1 purchase + 1 entitlement, licence stored only as a SHA-256 hash |
| Replayed webhook | `duplicate: true`, still 1 row each |
| `redeem` by the owner, then again | success, then `duplicate` (idempotent) |
| `redeem` by a different account | `claimed_by_other_account`, ownership not transferred |
| TWO accounts redeeming the same licence concurrently (first holds the row lock 2s) | session A `success`, session B `claimed_by_other_account`, exactly one owner |
| Refund | purchase `refunded`, `revoked_at` set, `hasActivation` false, redeem refused |
| Chargeback | same path, status `chargedback` |
| Unknown product / empty licence hash / empty sale id / unknown user | `unknown_product` / `missing_licence_hash` / `missing_sale_id` / `unknown_user` |
| Capital movement across every call | wallet sum unchanged (0), `transactions` rows 0 |
| Function bodies referencing a wallet or the ledger | none |

Reproduce it with any PostgreSQL 16 instance:

```bash
docker run -d --name k050 -e POSTGRES_PASSWORD=pg postgres:16
# create roles anon/authenticated/service_role and a users(id BIGINT) table,
# then: psql -f supabase/migrations/050_payhip_live_activation.sql
#       psql -f docs/sql/payhip_050_postcheck.sql
```

---

## 9. Still open before the paid rail can be switched on

1. **Payhip merchant eligibility** - written confirmation that selling an
   activation that also funds a trading balance is permitted
   (`11-PAYHIP-ELIGIBILITY-INQUIRY.md`). Not obtained.
2. **050 applied** (this document) - pending, no database access from here.
3. **051 applied** - only after the Kalderix build is live. It is gated on
   migration 011 and now runs in its own transaction.
4. **A real purchase exercised once** (section 6.4), then refunded.
5. **Fees** - a $50 sale settles below $50 after Payhip's and the processor's
   cuts. Option A never credits capital, so this cannot create an unfunded
   balance; it is a margin question, not a solvency one. It becomes a solvency
   question the moment a purchase is supposed to fund trading capital, which is
   why that design was rejected (`05-PAYMENTS.md`).
