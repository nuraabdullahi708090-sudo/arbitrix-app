# H1-H4 / L2 release blockers - resolution report

Branch: `relaunch/rebrand-payment-commercial` (PR #171, still DRAFT)
Base `main`: `7910db6`
Session start head: `7f0dbbf`
Implementation commit: `fb85bcf` ("fix(relaunch): clear H1-H4/L2 blockers and harden the Payhip rail")

Nothing merged, deployed, migrated or env-changed. Migrations 049, 050 and 051
remain UNAPPLIED.

---

## 1. Initial state (verified, not assumed)

| Item | Value |
|---|---|
| Branch | `relaunch/rebrand-payment-commercial` |
| Local head at start | `7f0dbbf` |
| Remote head at start | `7f0dbbf` (identical) |
| PR #171 | open, **draft**, mergeable, 22 commits, 163 changed files |
| Base | `7910db6` |
| Working tree | clean except the untracked reviewer note `docs/relaunch/FINAL-INDEPENDENT-REVIEW.md` |
| Test baseline | 3349 pass / 0 fail |

C1 (`aee5a90` + `7f0dbbf`) was treated as protected: every change below was made
around it, and the C1 scenarios still pass untouched (section 8).

---

## 2. H1 - Payhip webhook authentication contradicted its own configuration

### Root cause
`resolvePayhipConfig()` reported `usable` when the feature was enabled and
`PAYHIP_PRODUCTS` + `PAYHIP_API_KEY` were present. `PAYHIP_WEBHOOK_TOKEN` was
documented as an OPTIONAL second layer in `.env.example`. But the route did:

```js
if (!PAYHIP_CONFIG.usable) return 503;
if (!payhipEntitlements.tokenMatches(provided)) return 401;   // tokenMatches('') === false
```

`tokenMatches('', anything)` is `false` by design, so with a token unset every
delivery was rejected with 401 while the status surface, the dashboard purchase
button and `/api/live/activation` all reported the integration as usable. The
consequence is commercial, not cosmetic: Payhip takes the money, the webhook is
refused, no purchase row exists, and the customer can never redeem the licence
they paid for.

### Fix
One definition of "authenticated", used by every surface:

* `isValidWebhookToken()` - at least 16 characters and no whitespace
  (`WEBHOOK_TOKEN_MIN_LENGTH`).
* `resolvePayhipConfig()` gains `reason` values `missing-webhook-token` and
  `weak-webhook-token`; `usable` now requires a valid token, and `webhookUsable`
  is an explicit alias the route gates on.
* Webhook route: `503 {error:'payhip-not-configured', reason}` when the rail is
  not configured, `401 invalid_token` for a wrong/absent token on a CONFIGURED
  rail, `401 invalid_signature` for a bad signature. Nothing is ever accepted
  unverified.
* Boot: one secret-free `[Payhip] CONFIGURATION ERROR` line naming the reason.
  The process deliberately stays up (a payment misconfiguration must not take
  trading offline) and every Payhip surface reports itself unusable instead.
* `.env.example`: the token is REQUIRED while `PAYHIP_ENABLED=true`, with a
  generator command; the stale "confirmed-deposit accounts are grandfathered"
  sentence was replaced with the enforced C1 rule.

### Evidence
`tests/payhip_http.test.js` boots the real server twice (fully configured, and
configured WITHOUT the token) and calls the real routes.

---

## 3. H2 - migration 049 contradicted the approved $100 model

### Root cause
`049_min_deposit_50.sql` moved `referral_config.minimum_qualifying_deposit`
100 -> 50 and **raised** if it was still 100. Its own header told operators to
pair it with `PLATFORM_MIN_DEPOSIT_USD=50`. That is the opposite of the approved
rule ($100 platform minimum AND $100 referral minimum), and its self-check made
the correct state a hard failure.

### Fix
The file was renamed `049_min_deposit_100.sql` (never applied anywhere, so the
number is free and the old name was itself misleading) and rewritten to ASSERT
the approved value:

| Situation | Behaviour |
|---|---|
| row absent | inserts `'100'` |
| row is `'100'` | NOTICE, no change - success, never an error |
| row is `'50'` | repaired to `'100'` with a NOTICE (never writes 50) |
| row is an operator value (e.g. `'75'`) | left exactly as it is, with a NOTICE |
| empty / below 10 / still 50 after the run | raises and rolls back |

It keeps the dual column-shape detection (`config_key/config_value` or
`key/value`), asserts exactly one row, and adds no schema.

References updated: the boot mismatch warning in `server.js`, `.env.example`, and
the tests/docs that named the old file (`kalderix_identity`,
`final_min_deposit_referral` - whose `$50 exemption` was deleted, so NO migration
may seed 50 any more).

### Executed against real PostgreSQL 16.15 (throwaway container, removed)
```
case 1: row ABSENT        -> NOTICE: inserted 100             value=100
case 2: value 50          -> NOTICE: 50 -> 100                value=100
case 3: value 100         -> NOTICE: already 100 - no change  exit=0, value=100
case 4: operator 75       -> NOTICE: left at operator value   value=75
case 5: re-run at 75      -> NOTICE ...                       value=75 (idempotent)
```

---

## 4. H3 - customer-visible branding defects

| # | Surface | Before | After |
|---|---|---|---|
| 1 | `public/partners.html` `<title>`, `og:title`, `twitter:title`, `<h1>` | Become **an** Kalderix Referral Partner | Become **a** Kalderix Referral Partner |
| 2 | `partners.pageTitle`, `partners.heroTitle` (en dictionary) | same defect | corrected |
| 3 | `public/index.html` landing partner heading (markup default + `landing.partner.title`) | same defect | corrected |
| 4 | Login screen `auth.login.subtitle` (en) | Already have **an** Kalderix account? | Already have **a** Kalderix account? |
| 5 | Support bot `unlinkRemoved` / `unlinkNotLinked` | linked to **an** Kalderix account | linked to **a** Kalderix account |
| 6 | Arabic `auth.login.subtitle` / `auth.signup.subtitle` | the OLD brand in Arabic script | `Kalderix` |

Two code comments carrying the same defect were corrected (server.js,
TelegramSupportService.js). Nothing else was renamed: the legal entity
"Arbitrix Trading", the KVK number, the domains, the Telegram handles, the mail
addresses and the historical transaction labels were deliberately left alone
(section 11).

Verified: a repo-wide grep for the wrong article and for the Arabic spelling of
the old brand across `public/`, `services/` and `server.js` returns nothing.

---

## 5. H4 - behavioural HTTP tests for the Payhip rail

`tests/payhip_http.test.js` (26 tests) + `tests/helpers/fake-supabase-payhip.js`.
The harness substitutes ONLY the database and Payhip's licence API
(`globalThis.fetch`, preloaded via `NODE_OPTIONS`); the server, its middleware,
its routes and its validation are the real ones. No request leaves the machine.

| Area | Cases |
|---|---|
| Redemption | valid licence activates; invalid -> 404; refunded/disabled -> 409 `licence-disabled`; wrong product indistinguishable from invalid (M4); claimed by another account -> 409; replay -> `alreadyClaimed`; purchase inactive -> 409; DB outage -> 503; Payhip outage -> 503; missing key -> 400 `LICENCE_REQUIRED`; unauthenticated -> 401; account taken from the JWT (a body `userId:999` never reaches the RPC); 13 attempts -> 429 |
| Webhook | valid token+signature -> 200 `recorded`; empty token -> 401; wrong token -> 401; bad signature -> 401; refunded sale -> 200 (revoke path); **webhook alone never activates** |
| Catalogue (M3) | inactive product hides the offer; active product offers it; unreadable catalogue fails closed; `/api/auth/me` mirrors it |
| Admin | non-admin 403; admin 200 with `usable`, `webhookUsable`, `webhookTokenValid`, `products.onSale`; the token is never echoed |
| Money | no wallet write and no money RPC on any Payhip route |
| Configuration (H1) | a second boot without the token: webhook 503 `missing-webhook-token`, status `usable:false`, `purchase.available:false`; plus a pure 7-case matrix (disabled / no products / no api key / no token / weak token / valid / no product secret) |

Evidence is behavioural: HTTP status, response body, and (for the IDOR case) the
exact RPC payload the server sent, recorded by the harness.

---

## 6. L2 - the rebrand gate could not see the defects it was meant to catch

### Blind spots found
The old gate scanned only the ASCII string `Arbitrix` inside the six
dictionaries. It therefore missed: (a) the old brand in another script (Arabic);
(b) article/grammar defects, because it only required the NEW name to be present;
(c) page metadata (`<title>`, `og:*`, `twitter:*`) which is what search results
and social cards show; (d) the support bot / marketing strings, which live outside
`public/index.html`; (e) locale key-SET drift, empty translations and placeholder
mismatches (it compared key COUNTS only). Its `--expect` parsing also read
`argv[0]` when the flag was absent, so `--self-test` compared every string to the
literal brand "--self-test".

### What the gate does now
* `scripts/lib/rebrand-lint.js` - pure detectors: `detectOldBrand` (multi-script,
  context-aware allow-list), `detectArticleDefects` (wrong article, duplicated
  brand, duplicated article), `detectMetadataDefects`, `detectLocaleDefects`
  (key sets, empties, placeholder parity, per-value brand/article).
* `scripts/verify-rebrand.js` uses them for sections 2, 2b (metadata for all 8
  public pages) and 2c (service copy), and for the leftovers scan in section 6.
* `scripts/lib/rebrand-fixtures.js` replays every previously-missed defect plus
  the legitimate strings that must NOT be flagged; `--self-test` runs the
  fixtures inside the gate process and exits non-zero if any is misclassified.
* `tests/rebrand_gate.test.js` (13 tests) pins the fixtures, the live tree, and
  the gate's own behaviour as a spawned process.

Results on the corrected tree: `--expect Kalderix` -> ALL CHECKS PASSED;
`--self-test` -> 24/24 fixtures behaved as expected.

---

## 7. M1-M4

### M1 - `/api/bot/start` funding gate: confirmed intentional, now documented
For LIVE requests only, in this order, before any session write:

1. **Live Mode eligibility** (C1): activation AND a confirmed deposit >= the
   platform minimum -> 403 `LIVE_ACTIVATION_REQUIRED` / 403 `LIVE_DEPOSIT_REQUIRED`
   / 503 (retryable, undecidable).
2. **Funding gate**: `live_balance <= 0` -> 403
   `{code:'LIVE_FUNDING_REQUIRED', fundingRequired:true}`. This is a PRESENCE
   check, not a threshold - no minimum-trading-amount is reintroduced.
3. Promotional-credit $20 realized-profit cap (promo-funded accounts only).
4. $400 profit pause (management test).
5. Platform emergency stop (fail-open when the control row is missing).
6. Session write.

Consequences, stated plainly:
* the $50 promotional credit still passes the funding check (balance > 0), but a
  promo-only account can no longer start Live because step 1 requires activation
  and a $100 deposit. That is the intended C1 outcome, not a regression.
* Demo Mode is never gated (only `mode === 'live'` reaches these checks).
* existing sessions are not touched by the gate; every trade is separately gated
  in `/api/trade`.
* the UI already renders `funding_required` ("Activated - funding required").
* release implication: with `PAYHIP_ACTIVATION_REQUIRED=true`, no Live bot can
  start without both halves plus a non-zero balance. Nothing else changed.

### M2 - CRITICAL privilege defect in `charge_subscription_safe` (fixed in 051)
Migration 011 created the function; migration 014's lockdown covered
`record_trade_safe`, `credit_payment_safe` and `paymento_credit_user_safe` and
**never this one**. PostgreSQL grants EXECUTE on new functions to PUBLIC by
default, and the body has no caller-authorization check: any `anon` caller could
invoke `charge_subscription_safe(p_user_id, p_price, p_idempotency_key)` through
PostgREST and debit ANY subscriber's `wallets.live_balance` by an amount of their
choosing, repeatedly (each key is a new idempotency anchor). The function also ran
with no pinned `search_path`, so an unqualified `wallets` / `subscriptions` /
`transactions` reference could be hijacked from an earlier schema.

051 now:
* pins `SET search_path = public, pg_temp`;
* REVOKEs EXECUTE from PUBLIC, anon and authenticated, GRANTs it to service_role;
* self-checks `search_path` presence AND `has_function_privilege` for anon,
  authenticated and service_role, so a re-run cannot silently regress it;
* keeps the rebrand delta to exactly one string and preserves every money guard
  (`tests/kalderix_identity.test.js` test 10 now diffs the body line by line with
  the search_path line removed, and asserts the ACL block is the only privilege
  change).

**Executed against real PostgreSQL 16.15** (011 then 051, with roles
`anon`/`authenticated`/`service_role` created first):

```
BEFORE anon=true  authenticated=true  service_role=true  search_path=NONE
AFTER  anon=false authenticated=false service_role=true  search_path=public, pg_temp
       detail_kalderix=true  detail_arbitrix=false   051 re-run = no-op
```

Corrected audit of the other SECURITY DEFINER functions (a first grep-based pass
under-reported, because 050 revokes through a dynamic `DO` loop): the Payhip RPCs
in 050 ARE already service_role-only. Remaining functions without an explicit
revoke are lower impact and were deliberately NOT changed here (out of scope):
`sandbox_*` (simulated money only, sandbox users are admin-created),
`mark_expired_invoices`, `paymento_check_duplicate_webhook`,
`payhip_has_live_activation` (boolean oracle), `check_verification_status`,
`cleanup_*` and the two `updated_at` triggers. They are listed as a follow-up
hardening workstream, not as an approved change.

**ACTION REQUIRED AT RELEASE**: if 011 has been applied, this defect is live
today (051 is not). Applying the fixed 051 is the smallest fix; a narrower hotfix
containing only the `SET search_path` + REVOKE/GRANT would also close it. That is
a production DDL decision and was NOT taken here.

### M3 - `payhip_products.is_active` was an advertised switch that did nothing
050 creates the column `DEFAULT FALSE` with the comment "FALSE until the founder
enables checkout", but nothing read it. It is now a real, server-enforced
catalogue flag meaning "this product is offered for sale":
* `productsOnSale()` reads the configured product keys;
* `/api/live/activation` `purchase.available` and `/api/auth/me`
  `activationPurchasable` both require an on-sale product (so the modal button
  AND the dashboard button follow the flag);
* an unreadable catalogue fails CLOSED for the offer (`catalogue-unreadable`);
* a completed sale is still honoured (the flag gates the OFFER, not a payment
  already taken), and existing entitlements are never invalidated;
* `/api/admin/payhip/status` reports `products.onSale` so the operator can see
  why the button is hidden.

Documented here and in the module: it is a checkout-availability switch, NOT an
entitlement kill switch. Entitlement revocation remains
`revoke_payhip_entitlement_safe` (the refund/chargeback path).

### M4 - wrong-product information leak
`redeem()` returned `reason:'wrong-product'` and the route answered 409 with
"That licence is not for a Live Mode activation product.", confirming to any
caller that a guessed key is genuine and belongs to another catalogue. It now
returns `invalid-licence` (404, identical body to an invalid key). The distinction
is preserved in `payhip_events` (`recordEvent('redeem', null, 'wrong-product')`)
for support and audit. Deliberately unchanged: `licence-disabled` (the key holder
is the buyer and needs to know a refund blocked them), `claimed_by_other_account`
and `purchase_not_active`.

---

## 8. C1 preservation

Untouched by this work (verified by reading the diff and by the passing suite):
`getLiveActivationState()` (activation only, no deposit branch),
`getConfirmedDepositTotal()`, `getLiveModeEligibility()` (activation AND a
deposit >= the platform minimum), `sendLiveModeRefusal()`, the gates on
`/api/bot/start` and `/api/trade`, the `deposit_required` status and its three
i18n keys, and the 22 real-HTTP eligibility scenarios in
`tests/live_mode_eligibility.test.js` (all still pass, including the truth table:
no/no -> activation, deposit-only -> activation, activation-only -> deposit,
activation+$50 -> deposit, activation+$100 -> allowed).

No grandfathering, no deposit-based activation, no cutoff date was introduced.

---

## 9. Thresholds confirmed unchanged

| Rule | Value | Where |
|---|---|---|
| Payhip activation | **$50 one-time** | Payhip product price (merchant side); no server-side price constant |
| Platform minimum deposit | **$100** | `PLATFORM_MIN_DEPOSIT_USD` (server), `referral_config.minimum_qualifying_deposit` (049 asserts it) |
| Referral qualifying deposit | **$100** | the same config row; 049 never writes 50 |
| Referral reward | 20% of the first qualifying deposit | `referral_reward_percent` (unchanged) |
| Withdrawal minimum | $700 | `MIN_WITHDRAWAL_USD` (unchanged; disclosed only in the withdrawal pop-up) |

Activation is permission, never capital: no Payhip path writes a wallet, calls a
money RPC or credits a balance (asserted at HTTP level in H4).

---

## 10. Files changed (commit `fb85bcf`)

| File | Change |
|---|---|
| `server.js` | webhook gate on `webhookUsable` + 503 reason; boot configuration error; `purchase.available`/`onSale`; `/api/auth/me` `activationPurchasable` from the catalogue; admin status `products`; removed the dead `wrong-product` message; corrected the 049 name in the mismatch warning |
| `services/PayhipEntitlements.js` | `isValidWebhookToken` + `WEBHOOK_TOKEN_MIN_LENGTH`; `webhookTokenValid`/`webhookUsable`; new reasons; `productsOnSale()`; M4 generic refusal |
| `services/telegram-i18n.js` | two unlink strings: "a Kalderix account" |
| `services/TelegramSupportService.js` | comment |
| `public/index.html` | landing partner heading + en/ar auth subtitles (H3) |
| `public/partners.html` | title/OG/twitter/h1 + en dictionary (H3) |
| `.env.example` | token REQUIRED, min length, generator, no-grandfathering wording, $100 floor section |
| `supabase/migrations/049_min_deposit_50.sql` -> `049_min_deposit_100.sql` | renamed + rewritten to assert $100 (H2) |
| `supabase/migrations/051_rebrand_subscription_detail.sql` | search_path + EXECUTE lockdown + self-checks (M2) |
| `scripts/verify-rebrand.js` | shared detectors, metadata/service sections, `--self-test`, `--expect` fix |
| `scripts/lib/rebrand-lint.js` | NEW detectors |
| `scripts/lib/rebrand-fixtures.js` | NEW regression fixtures |
| `tests/payhip_http.test.js` | NEW 26 behavioural HTTP tests (H1/H4/M3/M4) |
| `tests/helpers/fake-supabase-payhip.js` | NEW scenario harness (DB + licence API + RPC payload log) |
| `tests/rebrand_gate.test.js` | NEW 13 tests (L2) |
| `tests/migration_049_051_hardening.test.js` | NEW 10 tests (H2/M2) |
| `tests/kalderix_identity.test.js` | test 10 diffs the 051 body with the search_path line removed and asserts the ACL block; test 12 asserts the $100 doc contract |
| `tests/live_activation_entitlement.test.js` | test 27 renamed/updated for M4 |
| `tests/partners_page.test.js` | `FUNNEL_SHA256` re-pinned for the approved H3 heading fix (with a comment) |
| `tests/final_min_deposit_referral.test.js` | removed the `$50` exemption - no migration may seed 50 |

---

## 11. What was deliberately NOT changed

* **C1** (section 8).
* The legal operator **`Arbitrix Trading`**, KVK **72923513**, the `arbitrix.pro`
  / `arbitrix.ai` domains, the Telegram handles (`@ArbitrixSupportBot`,
  `@AlexArbitrix`, `@OliviaArbitrix`, `@Arbitrix_CSA1`, the announcement
  channel), the seeded admin login and the historical transaction labels.
  Kalderix is a trading name only; the operator identity is unchanged.
* No production price, threshold, balance, transaction, entitlement or env var.
* No migration applied; no deploy; PR #171 remains a draft.
* Migration 050's ACL block (already correct) and the lower-impact functions
  listed in section 7 are untouched.

---

## 12. Remaining limitations and release blockers

1. **BLOCKER - apply the fixed 051 (or a hotfix) to production.** Until then any
   anon caller can invoke the subscription debit RPC. This is the only
   security-critical item in this report.
2. **BLOCKER for the Payhip rail - the webhook token must be set.** With
   `PAYHIP_ENABLED=true` and no `PAYHIP_WEBHOOK_TOKEN` the integration now fails
   loudly and refuses deliveries (previously it failed silently into 401). That is
   the intended behaviour, but the go-live checklist must include the token
   (>=16 chars) and a `getWebhookInfo` check.
3. **M2 residual (documented, not fixed)**: the other SECURITY DEFINER functions
   without an explicit EXECUTE revoke (section 7) should get the same treatment in
   a dedicated pass. Some are low risk; `mark_expired_invoices` and the
   `sandbox_*` group deserve a decision.
4. **H2 depends on operator discipline**: 049 repairs a leftover 50 but preserves
   any other operator value, and `checkMinDepositSync()` still only WARNS at boot
   when `referral_config` disagrees with `PLATFORM_MIN_DEPOSIT_USD`. A hard fail
   would be safer but changes operator behaviour.
5. **M3 semantics**: `is_active` gates the OFFER only. If management wants it to
   stop NEW activations of a product (including already-paid, unclaimed licences),
   that is a separate, explicit decision - it would strand customers who have paid.
6. **Unverifiable here**: no real Payhip account, so the live licence API and a
   real checkout were not exercised (the provider is simulated). No production
   database was reachable, so the Postgres evidence comes from a throwaway
   container running the real migration text.
7. The C1 consequence for promotional credit (no Live bot without activation + a
   $100 deposit) is unchanged and still worth an explicit management
   acknowledgement.

---

## 13. Verification log

```
node --check server.js                                     OK
node --check scripts/lib/rebrand-lint.js                   OK
node --check scripts/lib/rebrand-fixtures.js               OK
node --check scripts/verify-rebrand.js                     OK
node --check services/PayhipEntitlements.js                OK
node --check tests/payhip_http.test.js                     OK
node --check tests/helpers/fake-supabase-payhip.js         OK

node scripts/verify-rebrand.js --expect Kalderix           ALL CHECKS PASSED
node scripts/verify-rebrand.js --self-test                 24/24 fixtures OK

node --test tests/payhip_http.test.js                      26/26 pass
node --test tests/rebrand_gate.test.js                     13/13 pass
node --test tests/migration_049_051_hardening.test.js      10/10 pass
node --test tests/kalderix_identity.test.js \
           tests/live_activation_entitlement.test.js \
           tests/partners_page.test.js                     97/97 pass

npm test                                                   3398 pass / 0 fail / 0 skipped
```

Baseline was 3349 pass / 0 fail; the 49 new tests are H4 (26), L2 (13) and
migration hardening (10). No pre-existing failure was suppressed, skipped or
deleted.

### PostgreSQL 16.15 (throwaway container, removed afterwards)
* 011 -> 051 applied cleanly; a 051 re-apply is a no-op; the new self-checks pass.
* Privilege state before/after as printed in section 7.
* The five 049 cases as printed in section 3.

---

## 14. Definition of done

| Requirement | Status |
|---|---|
| H1 fixed + behavioural tests | done |
| H2 fixed, $100 preserved, no $50 rewrite | done |
| H3 fixed across customer surfaces and six locales | done |
| H4 real-HTTP suite | done (26) |
| L2 gate strengthened + regression fixtures | done |
| M1 investigated and documented | done |
| M2 reviewed and corrected | done (CRITICAL fix in 051) |
| M3 decided + enforced | done |
| M4 leak closed | done |
| C1 intact | done |
| $100 deposit + $100 referral unchanged | done |
| CI green on the updated head | see the PR check-runs for `fb85bcf` |
| No production action | done - nothing applied, deployed or env-changed |
| PR #171 remains draft | done |
