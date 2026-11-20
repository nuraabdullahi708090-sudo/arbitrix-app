# 15 - Release execution log (Kalderix relaunch)

Everything below was executed or measured against production, not planned.
"Not executed" is stated explicitly where a credential is missing.

## 1. Merge

| | |
|---|---|
| PR | #171 `relaunch/rebrand-payment-commercial` -> `main` |
| Reviewed head | `3b4e03e` (CI green twice) |
| Merge commit | `3ee2c667` |
| Strategy | merge commit (the repository permits it) |
| Tests at merge | 3464 pass / 0 fail |

## 2. Deployment

| | |
|---|---|
| Host | Render (push to `main` auto-deploys) |
| Old build served | 14:54:43 UTC (`Arbitrix AI | ...`) |
| New build served | 14:55:14 UTC (`Kalderix | Automated Arbitrage Trading Platform`) |
| Time to live | ~45 s |

## 3. Production verification

| Probe | Result | Meaning |
|---|---|---|
| `GET /api/health` | `200 {"status":"ok"}` | alive |
| `GET /api/live/activation` | `401 {"error":"Unauthorized"}` | route now EXISTS (was 404), auth-gated |
| `POST /api/payhip/webhook` (no token) | `503 {"ok":false,"error":"payhip-not-configured","reason":"disabled"}` | route EXISTS and fails closed until configured |
| `GET /api/admin/payhip/status` | `401` | admin route exists, gated |
| `/`, `/partners`, `/deposit-tutorials`, `/how-it-works`, `/reset-password.html`, `/business-registration` | `200` | pages serve |

### Branding (served bytes, not assumptions)

`https://arbitrix.pro/` is **byte-identical** to `public/index.html` (1,839,688 bytes).

| Page | Kalderix | "Arbitrix AI" | "Arbitrix Trading" | KVK 72923513 |
|---|---:|---:|---:|---:|
| `/` | 450 | **0** | 3 | 2 |
| `/partners` | 56 | 0 | 0 | 0 |
| `/deposit-tutorials` | 67 | 0 | 0 | 0 |
| `/how-it-works` | 7 | 0 | 0 | 0 |
| `/reset-password.html` | 7 | 0 | 0 | 0 |
| `/business-registration` | 6 | 0 | **6** | 4 |

"The retired brand survives only where it must": the legal operator
**Arbitrix Trading, KVK 72923513** (unchanged by design) and the historical
subscription-detail prefix, which the frontend maps through
`SUBSCRIPTION_DETAIL_PREFIXES` (the page contains the mapping, never the old
string). The old marketing name "Arbitrix AI" appears **nowhere**.

## 4. Readiness probe against production

```
$ node scripts/check-payhip-readiness.js --base https://arbitrix.pro
  /api/health                 HTTP 200
  /api/live/activation        HTTP 401 (auth-gated, correct)
  POST /api/payhip/webhook    HTTP 503 -> deployed-not-configured
     next: set PAYHIP_ENABLED=true
== Verdict: NOT ENABLED - set PAYHIP_ENABLED=true when the smoke test passes
```

That is the expected state: the code is live and refuses to grant anything until
the Payhip variables exist.

## 5. Database migrations - NOT APPLIED (no database credential here)

| Migration | State | Why |
|---|---|---|
| 049 | satisfied | production reports `minimumDeposit: 100`, `rewardPercent: 20` (`GET /api/referral/config`) |
| 050 | **pending** | `jmhgreazilmmvuqnghgt.supabase.co` does not resolve from the build sandbox; management API answers 401; no `psql`/`pg_dump`; the service-role key is an API key, not a database password - it was not used as a substitute |
| 051 | **pending** | same access gap; its precondition (the Kalderix build live) is now met |
| 052 / 053 | applied earlier | not re-run |

Operator sequence (Supabase SQL editor, role with DDL rights):

1. `docs/sql/payhip_050_readiness.sql` - every row must be OK or INFO.
2. Paste `supabase/migrations/050_payhip_live_activation.sql`; verify
   `sha256sum` equals `3cbadfdc2dc55b628ebb1163c7d0a54c2069c75d30226c8f4f5d93a76a252e5c` before running it (this revision adds the
   `owner_detached_at` column and the detach trigger to the rehearsed design).
3. `docs/sql/payhip_050_postcheck.sql` - 14 rows; row 11 proves the account-deletion
   marker, the last row must read `PASS - 050 is applied and the product is on sale`.
4. `supabase/migrations/051_rebrand_subscription_detail.sql` (single transaction;
   re-asserts 052's ACL).
5. `node scripts/check-payhip-readiness.js --base https://arbitrix.pro` after the
   variables below are set.

## 6. Payhip configuration - NOT SET (no hosting credentials here)

Set on Render (names only; never paste values into a document):

| Variable | Value |
|---|---|
| `PAYHIP_ENABLED` | `true` |
| `PAYHIP_PRODUCTS` | `dLXuU` (normalises to `dlxuu`) |
| `PAYHIP_API_KEY` | the Payhip store API key (its SHA-256 is the webhook signature) |
| `PAYHIP_WEBHOOK_TOKEN` | >= 16 chars, no whitespace - **required**, the route 503s without it |
| `PAYHIP_PRODUCT_SECRET` | the product's licence-verification secret (needed for redemption) |
| `PAYHIP_STORE_URL` | `https://payhip.com/b/dLXuU` |
| `PAYHIP_ACTIVATION_REQUIRED` | **set last**, only after the purchase smoke test |

Webhook URL to register in Payhip (replace the token):

```
https://arbitrix.pro/api/payhip/webhook?token=<PAYHIP_WEBHOOK_TOKEN>
```

A URL without `?token=` answers `401 invalid_token` even when everything else is
correct. The existing Veridossier webhook was not touched - it lives in a
different integration and was neither read nor modified.

## 7. Remaining external blockers

1. **Database credential** -> migrations 050 and 051.
2. **Render environment access** -> the seven Payhip variables.
3. **Payhip account access** -> webhook registration + one real purchase and refund.
4. **Payhip written eligibility confirmation** for the activation/funding model -
   not obtained; nothing in this repository claims approval.
