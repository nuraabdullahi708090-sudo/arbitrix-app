# Payhip Live Mode activation — production release sequence and rollback

Status: **NOTHING below has been executed.** Branch `relaunch/rebrand-payment-commercial`,
no migration applied, no environment variable set, checkout disabled.

Read section 0 before anything. The order matters more than the individual steps.

---

## 0. Preconditions that are not technical

| # | Gate | Why it blocks the release |
|---|---|---|
| 1 | **Written Payhip confirmation** (see `11-PAYHIP-ELIGIBILITY-INQUIRY.md`) | Their AUP governs. Selling an entitlement to a crypto trading platform's customers is the question, and a "no" cannot be coded around. |
| 2 | **A Payhip product with licence keys enabled** | Without it there is no key to verify, so `redeemUsable` is false and activation can never be granted. |
| 3 | **A tested licence against the live API** | The verification code has never talked to payhip.com from this environment (the sandbox cannot reach it). One manual `curl` in 4.2 proves it before a customer sees it. |
| 4 | **A decision on charging** | If the activation product is free, this whole layer is unnecessary. Confirm the price is intended. |

## 1. What the feature can and cannot do

It **unlocks permission** to enter Live Mode. It cannot:

- credit a wallet, a bonus balance or a trading balance (no money code exists in the module),
- create a deposit, a trade, a subscription or a referral,
- bypass the deposit minimum, the withdrawal minimum, the completed-trade rule or KYC.

Live Mode requires **activation AND a funded balance**. Funding is still a Q8Pay deposit.

## 2. Configuration

All variables are documented in `.env.example` under "PAYHIP LIVE MODE ACTIVATION".
Set them in this order; each row is independently safe.

| Order | Variable | Value | Effect when set alone |
|---|---|---|---|
| 1 | `PAYHIP_API_KEY` | store API key (Settings > Developer) | Nothing. Enables signature *verification*, not activation. |
| 2 | `PAYHIP_PRODUCTS` | the product **link code** (`mVT0` style) | Nothing on its own. |
| 3 | `PAYHIP_PRODUCT_SECRET` | product secret from the edit page | Nothing on its own. |
| 4 | `PAYHIP_STORE_URL` | `https://payhip.com/b/<code>` | Nothing until the flag below; the buy button needs it. |
| 5 | `PAYHIP_ENABLED=true` | switch | Webhook and redemption stop returning 503. **Live Mode is still not gated.** |
| 6 | `PAYHIP_ACTIVATION_REQUIRED=true` | the gate | THIS is the behaviour change. Funded accounts are grandfathered; sandbox is exempt. |

Optional hardening: `PAYHIP_WEBHOOK_TOKEN` (add `?token=` to the webhook URL),
`PAYHIP_RETURN_URL`, `PAYHIP_LICENSE_TIMEOUT_MS`.

**Never** set `PAYHIP_PRODUCT_SECRET` in a frontend build, a public config route or a log.
`describePayhipConfig()` is the only safe way to inspect configuration: it reports
booleans and counts, never a secret.

## 3. Migration sequence

Both are additive. **Neither changes behaviour without the flags in section 2.**

### 3.1 `050_payhip_live_activation.sql` (required)

Creates `payhip_products`, `payhip_purchases`, `payhip_entitlements`, `payhip_events`
plus four service-role-only functions. RLS enabled, no anon/authenticated policy.
Self-checking: a `DO` block raises (and rolls back) if any object, constraint or
policy is missing.

```sql
-- Supabase SQL editor, one file, in one transaction (the file has its own BEGIN/COMMIT)
\i supabase/migrations/050_payhip_live_activation.sql
```

Verify afterwards:

```sql
SELECT count(*) FROM information_schema.tables
 WHERE table_schema='public'
   AND table_name IN ('payhip_products','payhip_purchases','payhip_entitlements','payhip_events');
-- expect 4

SELECT proname FROM pg_proc
 WHERE proname IN ('record_payhip_purchase_safe','redeem_payhip_entitlement_safe',
                   'revoke_payhip_entitlement_safe','payhip_has_live_activation');
-- expect 4

SELECT tablename, policyname, roles FROM pg_policies WHERE tablename LIKE 'payhip_%';
-- every row must be service_role only. Any anon/authenticated row is a defect.
```

### 3.2 `049_min_deposit_50.sql` (only with the $50 decision)

**Couple it to the environment variable.** Applying 049 alone sets the referral
qualifying amount to 50 while deposits still require 100 — inconsistent, not
dangerous. Setting `PLATFORM_MIN_DEPOSIT_USD=50` alone leaves referrals requiring
100 — a $50 deposit would fund the account but never qualify its referrer.

```sql
\i supabase/migrations/049_min_deposit_50.sql
```

Then set `PLATFORM_MIN_DEPOSIT_USD=50` in the same window. The server now checks the
two values on every boot and in `GET /api/admin/stats` (`minDepositSync`); a mismatch logs:

```
[Config] MISMATCH: referral_config.minimum_qualifying_deposit=100 but the platform minimum deposit is 50 ...
```

Confirm `minDepositSync.ok === true` after restarting.

## 4. Activation walkthrough (do this before flipping the gate)

### 4.1 Staging or a production test account

1. Register a **new** account (not your admin).
2. Confirm Demo Mode works (it always must).
3. `GET /api/live/activation` returns `activationRequired:false` while the flag is off.

### 4.2 Prove the licence API answers (the one thing this repo could not test)

From the server shell, with a key you bought yourself:

```bash
curl -s "https://payhip.com/api/v2/license/verify?license_key=<KEY>" \
     -H "product-secret-key: $PAYHIP_PRODUCT_SECRET" | head -c 400
```

- `{"data":{"enabled":true,"product_link":"<code>",...}}` — good. `<code>` must match
  `PAYHIP_PRODUCTS`.
- Empty body — the key or the secret is wrong.
- HTTP 4xx/5xx — the endpoint moved; stop and re-read the docs before proceeding.

### 4.3 End-to-end with the gate ON for one account

1. Set `PAYHIP_ACTIVATION_REQUIRED=true`, restart.
2. As the test account: start the bot in Live — expect `403 LIVE_ACTIVATION_REQUIRED`.
3. POST `/api/live/activate {licenceKey}` — expect `{success:true, activated:true}`.
4. Start the bot in Live with a $0 balance — expect `403 LIVE_FUNDING_REQUIRED`
   (activation is not funding).
5. Deposit the platform minimum through Q8Pay, start the bot — expect a session.
6. Try the same licence from a **second** account — expect
   `409 claimed_by_other_account`.
7. Refund the purchase in Payhip, wait for the webhook, retry activation from a third
   account — expect `licence-disabled` (Payhip disables the key on refund).

### 4.4 Regression sweep

```bash
npm test        # currently 3250 pass / 0 fail
```

Then spot-check as a funded existing customer: they must enter Live Mode with no
licence at all (grandfathered), including while Payhip is unreachable.

## 5. Rollback

Each step is independently reversible, cheapest first.

### 5.1 Stop gating (10 seconds, no deploy)

```
PAYHIP_ACTIVATION_REQUIRED=false
```

Every account returns to the pre-release behaviour immediately. Existing purchases and
entitlements are untouched and remain valid for a later re-enable. **This is the
rollback to use unless something is actually broken.**

### 5.2 Stop accepting purchases (no deploy)

```
PAYHIP_ENABLED=false
```

Webhook and redemption return 503. Nothing is recorded, nothing is granted. Customers
who already redeemed keep access (the entitlement lives in the database, not in the flag).

### 5.3 Remove the feature entirely (code)

```bash
git checkout <previous-release-commit> -- server.js public/index.html .env.example
# redeploy; the Payhip tables can stay - unreferenced tables cost nothing
```

### 5.4 Drop the schema (only if you want it gone)

Safe: these tables hold **no money**. They record purchases and entitlements only.

```sql
DROP FUNCTION IF EXISTS public.redeem_payhip_entitlement_safe(bigint, text);
DROP FUNCTION IF EXISTS public.record_payhip_purchase_safe(text, text, text, integer, text, integer, integer, text, jsonb);
DROP FUNCTION IF EXISTS public.revoke_payhip_entitlement_safe(text, text, integer, text);
DROP FUNCTION IF EXISTS public.payhip_has_live_activation(bigint);
DROP TABLE IF EXISTS public.payhip_events;
DROP TABLE IF EXISTS public.payhip_entitlements;
DROP TABLE IF EXISTS public.payhip_purchases;
DROP TABLE IF EXISTS public.payhip_products;
```

**Before dropping, export the entitlements.** Every paying customer's activation lives
there; after the drop the only record is Payhip's own.

```sql
COPY (SELECT * FROM public.payhip_entitlements) TO STDOUT WITH CSV HEADER;
```

### 5.5 Revert the deposit minimum

```sql
UPDATE public.referral_config
   SET value = '100', updated_at = NOW()
 WHERE key = 'minimum_qualifying_deposit';
```

and unset `PLATFORM_MIN_DEPOSIT_USD` (the built-in default is 100).

## 6. Post-release monitoring (first 72 hours)

| Signal | Where | Healthy |
|---|---|---|
| Webhook rejections | `[Payhip] webhook: {"outcome":"signature-invalid"}` | zero. Non-zero means the dashboard API key and Render's `PAYHIP_API_KEY` disagree. |
| Redemption refusals | `payhip_events` | `invalid-licence` should be rare; a burst means the allow-list is wrong. |
| `licence-api-unavailable` | `payhip_events` | Non-zero means Payhip latency: customers see "try again". Funded customers are unaffected. |
| Minimum deposit mismatch | `GET /api/admin/stats` then `minDepositSync` | `ok:true` |
| Funded customers blocked | support reports | none. Any report is a P1: the grandfather branch should make this impossible. |

Reconciliation: `payhip_purchases` rows carry `price_cents`, `stripe_fee_cents`,
`payhip_fee_cents`, status and timestamps. Net settlement was reconciled, never
assumed, and no part of it was ever credited to a balance — which is why a refund
needs no clawback.

## 7. Manual Payhip dashboard steps (exact)

1. **Product** — create a digital product ("Live Mode Activation"). Name it so the
   customer knows it is an activation, not a deposit.
2. **Advanced Options** — tick **"Generate unique license keys for each sale"**.
3. Scroll back to that section — copy the **product secret key**. This is
   `PAYHIP_PRODUCT_SECRET`. It appears only after the product exists.
4. Copy the product **permalink code** (e.g. `mVT0` from `payhip.com/b/mVT0`) into
   `PAYHIP_PRODUCTS`, and the full link into `PAYHIP_STORE_URL`.
5. **Settings > Developer** — copy the **API key** into `PAYHIP_API_KEY`.
6. Same page — **webhook URL**
   `https://arbitrix.pro/api/payhip/webhook` (optionally `?token=<PAYHIP_WEBHOOK_TOKEN>`),
   events: **paid** and **refunded**. Subscription events are ignored by design.
7. Send one test purchase to yourself, then run the 4.2 curl with that licence.
8. Only then set `PAYHIP_ENABLED=true`, and `PAYHIP_ACTIVATION_REQUIRED=true` last.

## 8. Known limitations, stated plainly

- **The webhook signature is sender authentication, not body integrity.** Payhip
  documents `hash('sha256', $apiKey)`, a constant for every payload. That is why
  nothing is granted from a webhook: the licence is verified against the licence API
  at redemption, and the claim itself is row-locked in Postgres.
- **A missed webhook blocks redemption for that sale.** Payhip retries hourly for 3
  hours; after that the purchase row is absent. The refusal is reported as
  `not-recorded`, NOT as an invalid key: the provider already confirmed the licence is
  real, enabled and allow-listed, so the customer is told the purchase is still being
  confirmed and can retry, and the operator sees `not-recorded` in `payhip_events`.
  Recovery remains a manual replay from Payhip's dashboard. (A self-healing path that
  creates the purchase row from the licence API's own record is deliberately NOT
  implemented: that row would carry no price or fee data and would pollute
  reconciliation. It is listed as a founder decision in the consolidated report.)
- **`uses` is informational.** One-time redemption is enforced by our unique
  `licence_key_hash` and the row lock, not by Payhip's counter.
- **A full database outage refuses everyone**, including funded customers. Correct:
  with the wallet table unreadable they could not trade anyway.
- **Refunds do not claw back.** Activation never held funds, so there is nothing to
  reverse; revoking only removes the permission. Capital already deposited stays
  governed by the normal withdrawal rules.
