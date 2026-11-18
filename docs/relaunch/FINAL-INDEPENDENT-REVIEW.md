# FINAL INDEPENDENT REVIEW - PR #171 (Kalderix relaunch)

> **ARCHIVED - THIS REVIEW IS SUPERSEDED. Read this box before anything below.**
>
> Reviewed head: `fef1273`. The branch has moved on and every blocking finding
> below has been closed. The current state of the release lives in
> `13-RELEASE-CHECKLIST-KALDERIX.md` (sections 2.1 and 4) and in
> `docs/security/FINAL-SECURITY-CLOSURE-REPORT.md`.
>
> | Finding | Status | Where it was fixed |
> |---|---|---|
> | **C1** - a deposit grandfathered activation, so the paid rail could be bypassed | **CLOSED** | activation is required AND a deposit is required, with no grandfather branch; pinned by `tests/live_activation_entitlement.test.js` (19/20/20b/21) and `tests/live_mode_eligibility.test.js` |
> | **H1** - the webhook token was documented as optional but enforced unconditionally | **CLOSED** | `PAYHIP_CONFIG.webhookUsable` + the 503/401 split in `POST /api/payhip/webhook`; pinned by `tests/payhip_http.test.js` |
> | **H2** - migration 049 moved the referral qualifying deposit to $50 | **CLOSED** | `049_min_deposit_50.sql` is gone; `049_min_deposit_100.sql` asserts the $100 floor, and production reports 100. The $50 idea is withdrawn |
> | **H3** - customer-visible branding defects | **CLOSED** | identity corrected in the transaction labels, TOTP issuer and support surfaces; `node scripts/verify-rebrand.js --expect Kalderix` passes |
> | **H4** - no behavioural test for the Payhip HTTP surface | **CLOSED** | `tests/payhip_http.test.js` (26 tests) + `tests/payhip_production_wiring.test.js` (22) |
>
> What this review could not have known, and what is still OPEN:
> `052` and `053` were applied to production afterwards (security only);
> `050_payhip_live_activation.sql` and `051_rebrand_subscription_detail.sql` are
> still NOT applied; the `payhip_*` tables did not exist at the time of writing;
> and the Payhip merchant-eligibility answer is still outstanding.
>
> The review body below is retained verbatim as the record of what was found.

Review date: 2026-11-17. Reviewer: independent agent session (OpenHands), review-only.
Repository: `nuraabdullahi708090-sudo/arbitrix-app`
Branch: `relaunch/rebrand-payment-commercial` -> `main`
Head reviewed: `fef1273dc973ed84fec2f877b34f24071ac7229a` (`fef1273`)

Everything below was executed or read in THIS session. Nothing was merged,
pushed, deployed, migrated or applied, and no production setting was touched.

**Distribution: internal engineering document.** Written for the repository owner
and the merge decision. It is not customer-facing copy and is not intended for
publication.

---

## A. Executive verdict

**NOT APPROVED - FIXES REQUIRED.**

The engineering is careful and the test suite is genuinely green (3327/3327, in
CI and locally), but the branch cannot be approved as it stands, for three
independent reasons:

1. **The paid activation rail - the commercial centrepiece - can be bypassed by
   simply depositing.** `getLiveActivationState()` grandfathers *any* account
   with a confirmed deposit, with no time bound, so with
   `PAYHIP_ACTIVATION_REQUIRED=true` every *new* customer who deposits is
   activated without ever buying the $50 entitlement. (**C1**)
2. **The webhook is dead on arrival under the documented configuration.** The
   token is documented as optional but is enforced unconditionally, so an
   operator who follows `.env.example` gets `401` on every Payhip webhook and no
   purchase is ever recorded. (**H1**)
3. **The branch ships a migration that contradicts the approved commercial
   decision.** Migration 049 moves the referral qualifying deposit to $50 while
   the approved model keeps $100. (**H2**)

Two customer-visible branding defects (**H3**) and the absence of any behavioural
test for the Payhip HTTP surface (**H4**) must also be fixed first. All five are
small, well-scoped fixes; on current evidence this could reasonably become
APPROVED WITH CONDITIONS once they land.

---

## B. Verification summary

### B.1 PR and repository state (independently established)

| Item | Observed |
|---|---|
| PR state | **open, `draft: true`** (cannot be merged until marked ready) |
| Head | `fef1273` - matches the previous report exactly |
| Base / merge base | `main` = `7910db6f...` = the merge base (branch is current with main) |
| Local vs remote branch | identical (`fef1273`); working tree clean |
| Commits | **20** (the previous report said 19 - two docs commits are on top) |
| Files | 159 changed, +13296 / -1324 |
| Mergeability | GitHub reports `mergeable: true`, `mergeable_state: clean` |
| New commits since the report | none |

### B.2 CI (GitHub Actions, inspected via API and job logs)

- Two runs on `fef1273` (push + pull_request), **both `success`**.
- Jobs: `npm test` (26.3 s) and `static checks` (8 s).
- The CI log itself reports **`tests 3327 / pass 3327 / fail 0 / skipped 0 /
  todo 0`** - the full suite, not a subset.
- The workflow is test-only: `permissions: contents: read`,
  `persist-credentials: false`, no secrets, no deploy step.

### B.3 Local test runs (this session)

| Check | Result |
|---|---|
| `npm test` | **3327 pass / 0 fail**, 0 skipped, 0 todo (matches CI) |
| `node scripts/verify-rebrand.js --expect Kalderix` | **ALL CHECKS PASSED** (with the blind spots in H3/L2) |
| Locale dictionaries (own `vm` evaluation) | 6 locales, **1631 keys each**, identical key sets, 0 empty |
| Brand inside dictionaries | 58 `Kalderix` per locale (ar 56), **0 `Arbitrix`** |
| Security headers | verified against a locally booted server (B.4) |
| `node --check` / inline script parsing | clean (suite + CI `static checks`) |

### B.4 Security headers (independent live probe, not the tests)

Booted the real server on `:4317` with the offline Supabase stub:

```
/                    200  nosniff; CSP frame-ancestors 'none'; X-Frame-Options DENY;
                          Referrer-Policy strict-origin-when-cross-origin
/api/health          200  same
/partners            200  same
/deposit-tutorials   200  same
/api/health + x-forwarded-proto: https
                          Strict-Transport-Security: max-age=31536000; includeSubDomains
/api/health (plain http)   NO HSTS  (correct: no pinning over cleartext)
/api/nope            404  application/json
```

`Content-Type` sanity: `/video/*.mp4` -> `video/mp4`; html -> `text/html`, so
`nosniff` cannot break the media. The resource CSP is deliberately absent, and
that is correct: `public/index.html` loads TradingView (`s3.tradingview.com`),
`cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `cdn.tailwindcss.com` and Google
Fonts, so a strict policy would break the chart, the icons and the fonts.

### B.5 Migration review (static only - see the limitation)

050 and 051 were read line by line (details in section C). **No migration was
executed**: this environment has no PostgreSQL server and no Docker (`docker` is
absent; `pgserver` / `postgresql-wheel` / `pg_embed` are not installable from the
index). All three migrations are **NOT TESTED against a database** in this
review. Static inspection is not a substitute for applying them in the rehearsal
database.

### B.6 What could not be tested at all

- Any database behaviour (claim, revoke, RLS, locking) - no PostgreSQL.
- Any Payhip API interaction - no Payhip credentials, and this sandbox must not
  call a live provider.
- The Telegram bot against Telegram - no bot token.
- Production behaviour of the deployed build - nothing was deployed.

---

## C. Findings

### C1 - CRITICAL - Activation is bypassable by depositing (commercial model defeated)

- **File:** `server.js:329` `getLiveActivationState()`, branch at **345-348**;
  `server.js:2467` `hasConfirmedDeposit()`.
- **Evidence:**

  ```js
  const deposited = await hasConfirmedDeposit(userId).catch(() => null);
  if (deposited === true) {
    return { activated: true, reason: 'grandfathered-deposit', ... };
  }
  ```

  `hasConfirmedDeposit()` is a plain `count > 0` over `deposits` /
  `payment_invoices` with **no date bound**, and the branch runs *before* the
  entitlement lookup.
- **Impact:** with `PAYHIP_ACTIVATION_REQUIRED=true`, a brand-new account that
  makes one $100 deposit is reported `activated: true, reason:
  'grandfathered-deposit'`. The $50 activation fee is therefore optional for
  every customer, not only for the pre-existing funded base it was written for.
  The rail would collect revenue only from people who buy before depositing.
- **Required corrective action:** decide the policy, then implement it:
  (a) make activation mandatory - bound the grandfather to a rollout cutoff
  (a timestamp/env constant, comparing `created_at`), so only genuinely
  pre-existing funded accounts are exempt; or
  (b) make activation optional and stop describing it as required. The current
  code silently implements (b) while the UI and the release docs implement (a).
  A test must pin whichever is chosen.

### H1 - HIGH - `PAYHIP_WEBHOOK_TOKEN` is documented optional but enforced unconditionally

- **Files:** `services/PayhipEntitlements.js:192` `tokenMatches()`;
  `server.js:11509` webhook route; `.env.example:596`.
- **Evidence (executed):**

  ```
  resolvePayhipConfig({PAYHIP_ENABLED:'true', PAYHIP_PRODUCTS:'mVT0', PAYHIP_API_KEY:'...'})
    -> usable: true | reason: null | webhookToken: ""
  tokenMatches("", "anything") -> false
  ```

  `.env.example`: "`PAYHIP_WEBHOOK_TOKEN=...` (OPTIONAL second layer) ...
  Optional, but it stops junk traffic from reaching the parser."
- **Impact:** following the documentation (leaving the "optional" token unset)
  makes every Payhip webhook answer **401**, so no purchase row is ever created
  and every buyer who pays can only redeem into `not-recorded`. `config.usable`
  still reports `true`, so an admin status page looks healthy. This is a silent
  total failure of the only paid rail.
- **Required corrective action:** either add `missing-webhook-token` to
  `resolvePayhipConfig()`'s `reason` chain (so the rail is reported unusable and
  the route 503s instead of 401ing), or treat an empty token as "signature-only"
  in `tokenMatches()`. Document whichever is chosen, and add a test for the
  unset-token configuration, which today no test exercises (see H4).

### H2 - HIGH - Migration 049 contradicts the approved commercial configuration

- **File:** `supabase/migrations/049_min_deposit_50.sql`.
- **Evidence:** the file rewrites `referral_config.minimum_qualifying_deposit`
  `'100'` -> `'50'` (lines 84-89) and then **raises** if the value is still
  `'100'` (lines 118-120). It is labelled "COORDINATED RELEASE STEP 2 of 3 for
  the $50 minimum deposit", the PR **title** says "$50 floor", and the release
  checklist instructs operators to apply it.
- **Impact:** the approved decision for this review is Payhip $50 **activation**,
  minimum **deposit $100**, referral qualification **$100**. Applying 049 as
  instructed would cut the referral qualifying deposit in half (paying $20 on a
  $50 deposit) and, with `PLATFORM_MIN_DEPOSIT_USD=50`, halve the deposit floor.
  The code default is correct today (`server.js:826`
  `const PLATFORM_MIN_DEPOSIT_USD = 100;`), so nothing is broken *until* someone
  follows the instructions - which is exactly the risk.
- **Required corrective action:** remove 049 from this PR (keep it in a separate
  change gated on a future decision), and correct the PR title, the release
  checklist and the `checkMinDepositSync()` warning (`server.js:892`, which
  currently says "Apply migration 049_min_deposit_50.sql, or set ...") so the
  remediation text matches the approved $100/$100 model.

### H3 - HIGH - Customer-visible branding defects the release gate misses

Two classes, both live on customer surfaces:

1. **Wrong indefinite article: "an Kalderix".**
   - `public/partners.html:7` - `<title>Become an Kalderix Referral Partner | Kalderix</title>` (browser tab + OG title)
   - `public/partners.html:15` - `og:title` "Become an Kalderix Referral Partner"
   - `public/index.html`, key `auth.login.subtitle` (en) - "Already have **an Kalderix** account? Sign in." (login screen)
   - `services/telegram-i18n.js:261,262` - "no longer linked to **an Kalderix** account." (support bot)
   - Plus two code comments (`server.js:11444`, `services/TelegramSupportService.js:3356`).
   - Cause: mechanical substitution of "an Arbitrix" without the article rule.

2. **The old brand is still rendered in Arabic on the login and signup screens.**

   The keys `auth.login.subtitle` and `auth.signup.subtitle` in the `ar` locale
   still contain the Arabic-script spelling of the previous brand
   (`أربيتريكس`), e.g.:

   ```
   ar auth.signup.subtitle -> "... أربيتريكس ..."   (2 occurrences in public/index.html)
   ```

   The ASCII word is gone, so the release gate passes; the Arabic transliteration
   was never scanned for.

- **Impact:** the first thing a new visitor reads is grammatically wrong, and an
  Arabic-speaking customer is shown the previous brand on sign-in and sign-up.
- **Required corrective action:** fix the four English strings and the two
  Arabic strings, then extend the gate (see L2) so this class cannot return.

### H4 - HIGH - The Payhip HTTP surface has no behavioural test

- **File:** `tests/live_activation_entitlement.test.js` (50 tests).
- **Evidence:** 13 assertions are `SERVER.includes(...)` / `SERVICE.includes(...)`
  source-string checks; **zero** tests make an HTTP request (`grep` for `fetch(`
  / `http.request` in that file returns only unrelated line hits). The webhook
  401/503/200 contract, the `/api/live/activate` status mapping
  (400/404/409/429/503) and `/api/live/activation` are pinned only by the
  presence of source text.
- **Impact:** this is why H1 shipped green. A source-string test cannot detect
  that a correctly written branch is unreachable at runtime.
- **Required corrective action:** at least one live test per Payhip route (boot
  the server exactly as `tests/security_headers.test.js` does), covering: webhook
  with no token configured, wrong token, bad signature, unknown product, replay;
  redeem invalid / disabled / wrong product / duplicate / rate-limited.

### M1 - MEDIUM - `/api/bot/start` now refuses a zero Live balance (active on deploy)

- **File:** `server.js:~7351` (`code: 'LIVE_FUNDING_REQUIRED'`).
- **Evidence:** new in this branch; not env-gated; runs after the activation gate
  for live mode.
- **Impact:** a newly depositing customer whose credit has not landed yet gets
  "Add funds to your Live balance before starting Live trading" instead of a
  session. Reasonable, but it is a real behaviour change on merge and is not
  mentioned in the release checklist. Confirm it is intended and add it to the
  release notes and the smoke rehearsal.

### M2 - MEDIUM - Migration 051 hardening and revert risk

- **File:** `supabase/migrations/051_rebrand_subscription_detail.sql`.
- **Evidence:** it re-creates `charge_subscription_safe()` from the migration-011
  body without `SET search_path` (0 occurrences, versus 050 which pins it on
  every function), and its self-check only asserts that two tokens
  (`idempotency_key`, `live_balance <`) and the new string survive. No other
  migration redefines the function (`013` mentions it only in comments), so the
  replacement is currently safe.
- **Impact:** (i) a `SECURITY DEFINER` function without a pinned `search_path` is
  the standard hardening gap; (ii) if production's body ever diverged from the
  file (manual patch), 051 would silently revert it - the two-token self-check
  would not notice.
- **Required corrective action:** add `SET search_path = public` in the next
  revision, and consider comparing against `pg_get_functiondef()` before
  replacing.

### M3 - MEDIUM - `payhip_products.is_active` looks like a kill switch but is never read

- **File:** `supabase/migrations/050_payhip_live_activation.sql:30-46`;
  `services/PayhipEntitlements.js` `productAllowed()`.
- **Evidence:** allow-listing is decided by the `PAYHIP_PRODUCTS` env list; no
  code path reads `is_active` (which defaults to `FALSE`, documented as "until
  the founder enables checkout").
- **Impact:** an operator who "activates" a product row changes nothing; the real
  switch is an environment variable. Confusing during an incident.
- **Required corrective action:** either consult `is_active` in
  `productAllowed()` / redemption, or drop the column and document the env list
  as the only switch.

### M4 - MEDIUM - `wrong-product` distinguishes a valid licence from an invalid one

- **File:** `services/PayhipEntitlements.js` (`reason: 'wrong-product'`).
- **Impact:** a caller learns that a guessed key is a *real* Payhip licence
  belonging to another product. No money moves and keys are long, so the risk is
  low, but it is a needless oracle on a public authenticated endpoint.
- **Required corrective action:** return `invalid-licence` for the wrong-product
  case to the client (keep the specific reason in `payhip_events`).

### L1 - LOW - Report accuracy items

- The consolidated report names the third migration
  `051_subscription_detail_rebrand.sql`; the file is
  `051_rebrand_subscription_detail.sql`.
- It states 19 commits; there are 20.
- The PR body says "Nothing here changes production behaviour by itself"; that is
  true of the financial gates, but the security headers and M1 deploy active.
  Worth one clarifying sentence.

### L2 - LOW - `verify-rebrand.js` blind spots (cause of H3)

- **File:** `scripts/verify-rebrand.js:52-62, 168-200`.
- It matches only the ASCII string `Arbitrix`, so the Arabic-script old name
  passes the "no old-brand copy" check.
- It has no grammar check, so "an Kalderix" passes.
- Section 6's allow-list (`[/data-brand|brand-|source:/, ...]` over a +/-40
  character window) is context-based and loose: any old-brand token within 40
  characters of `source:` or `brand-` is excused, in prose as well as in config.
- **Required corrective action:** add the non-Latin transliterations to the
  scanner, add an article check for `an? + BRAND`, and narrow the allow-list to
  actual attribute/identifier positions.

### L3 - LOW - Pre-existing: unpinned third-party CDNs

`public/index.html` loads TradingView, cdnjs, jsdelivr and the Tailwind CDN with
no `integrity` attribute and no pinning. Pre-existing, not introduced here, and
it is the reason a strict CSP is impossible today - but on a financial page it is
a supply-chain exposure worth scheduling.

### L4 - LOW - Profile email placeholder on a real mailbox domain

`public/index.html` shows `trader@arbitrix.ai` as the read-only profile email
placeholder. Harmless, but a user may believe that is their address. Consider a
neutral placeholder or the user's own value only.

---

## D. Migration and deployment sequence

Keep the approved configuration: **activation $50 (one-time, no capital),
minimum deposit $100, referral qualifying deposit $100, Q8Pay unchanged.**

### D.1 Do not apply migration 049 in this release

049 lowers the referral threshold to $50 and, with the env var, the deposit floor
to $50. It contradicts the approved decision and must be pulled from this PR.
Keep `PLATFORM_MIN_DEPOSIT_USD` unset (effective $100) and
`referral_config.minimum_qualifying_deposit = '100'`. `checkMinDepositSync()` will
then report `ok: true` on `/api/admin/stats` - the correct end state, worth
verifying after deploy as a one-line check.

### D.2 Order (dependency-aware)

1. **Pre-flight (read-only):** confirm `charge_subscription_safe` exists and its
   `pg_get_functiondef()` still contains `'Arbitrix Pro Subscription'` (051's
   precondition); confirm no `payhip_*` table already exists.
2. **Apply 050** (`payhip_live_activation.sql`). Additive, idempotent, no money
   path, no dependency on deployed code. Safe on its own: nothing in the running
   build references these tables (all Payhip code is env-gated), and the
   self-check rolls back on failure.
3. **Merge + deploy the code.** Active changes on deploy: the Kalderix identity,
   the security headers, the read-only reconciliation route, M1's funding gate.
   The Payhip routes exist but are inert (`PAYHIP_ENABLED` unset -> `usable:
   false` -> webhook 503; `activationRequired: false` -> everyone `activated:
   true`).
4. **Apply 051** only *after* the Kalderix build is live (it writes the new charge
   detail; historical rows are untouched and both eras render correctly).
5. **Configure Payhip (still off):** `PAYHIP_STORE_URL`, `PAYHIP_PRODUCTS`,
   `PAYHIP_API_KEY`, **`PAYHIP_WEBHOOK_TOKEN` (mandatory in practice - see H1)**,
   `PAYHIP_PRODUCT_SECRET`, `PAYHIP_RETURN_URL`. Restart.
6. **Prove it end to end with `PAYHIP_ENABLED=true` but
   `PAYHIP_ACTIVATION_REQUIRED=false`:** buy the cheapest product with a real
   card, confirm the webhook records the purchase
   (`GET /api/admin/payhip/purchases`), redeem the licence on a test account,
   confirm `payhip_entitlements.claimed_at` is set exactly once and
   `wallets.live_balance` is **unchanged**.
7. **Only then** decide about `PAYHIP_ACTIVATION_REQUIRED=true` - and only once
   **C1** is fixed. As the code stands, enabling it changes nothing for any
   customer who deposits.

### D.3 Rollback

- Feature off: unset `PAYHIP_ENABLED` (and `PAYHIP_ACTIVATION_REQUIRED`), restart
  - the rail disappears, no data migration needed.
- Code: revert the merge commit; Render redeploys `main`.
- 051 revert: re-apply the 011 body (keeps the old string for *new* rows only).
- 050 revert: the documented `DROP` block in the file's footer. It removes only
  Payhip tables; no customer money is in them.

---

## E. Production readiness checklist (separate approvals)

| Decision | Status | Why |
|---|---|---|
| **Safe to merge** | **NO** - until H1, H2, H3, H4 (+ the C1 decision) | C1 defeats the revenue model; H3 ships visible defects |
| **Safe to deploy** (code only, Payhip off) | Yes, with caveats | Headers and M1 change behaviour; the brand change is visible; no financial gate moves |
| **Safe to apply 050** | Yes | Additive, RLS on, service-role only, no money path, inert without config |
| **Safe to apply 051** | Yes, after deploy | One string inside a money function; body otherwise identical; self-checked |
| **Safe to apply 049** | **NO** | Contradicts the approved $100/$100 model |
| **Safe to enable Payhip** | **NO** | H1 (webhook dead), C1 (bypassable), H4 (untested routes) |
| **Safe to accept deposits** | Unchanged from today | Q8Pay path untouched; the reconciliation queue is now visible (improvement) |
| **Safe to enable trading** | Separate approval | This PR does not modify the trading engine; trading readiness is tracked and verified on its own |
| **Safe to enable background workers** | Not part of this PR | All three remain disabled by env |

---

## F. Outstanding blockers

1. **C1** - fix or make explicit the activation grandfathering policy (founder
   decision + a small code change + a test).
2. **H1** - make the webhook token's requirement honest (code or docs) and test
   the unset case.
3. **H2** - remove migration 049, correct the PR title, the release checklist and
   the `checkMinDepositSync()` remediation text.
4. **H3** - fix "an Kalderix" (four customer strings) and the two Arabic strings;
   extend `verify-rebrand.js` (L2).
5. **H4** - add live HTTP tests for the four Payhip routes.
6. **Commercial positioning** - management confirmation that the Live Mode
   description used in the app, the Payhip listing and any advertising matches
   what the product actually does, before the paid rail is enabled.
7. **Database rehearsal** - apply 050 and 051 (and only if approved, 049) to a
   disposable PostgreSQL and exercise claim/revoke/RLS. Not possible in the
   review environment; must happen before production.
8. **Human/external** - Kalderix trademark clearance; Payhip merchant eligibility
   confirmation for this business model (still unanswered); `PAYHIP_PRODUCT_SECRET`
   per product; a real card test purchase.

## G. Final recommendation

**Do not merge PR #171 now.** Keep it open, mark it ready for review only after
the fixes below, and treat it as two separable deliveries.

**Minimum to merge (small, mechanical):**
- H1 (webhook token), H2 (drop 049 + correct the docs and title), H3 (six strings
  + gate), H4 (route tests), L1/L2 (report and gate).

**Then, before enabling anything commercial:**
- C1 decision implemented and tested (otherwise the $50 activation collects
  nothing);
- commercial positioning confirmed (Live Mode description matches the product);
- migrations applied in a rehearsal database;
- one real end-to-end purchase with `PAYHIP_ENABLED=true` and
  `PAYHIP_ACTIVATION_REQUIRED=false`.

The Kalderix identity work, the security headers, the reconciliation panel and the
entitlement data model are good, reviewable work. The blockers are not in those
parts - they are in the commercial logic around them.

---

### Evidence index (for the next reviewer)

```
server.js:329-373        getLiveActivationState (grandfather at 345-348)
server.js:826            PLATFORM_MIN_DEPOSIT_USD = 100 (default)
server.js:878-899        checkMinDepositSync (read-only; warning names 049)
server.js:2467           hasConfirmedDeposit (no date bound)
server.js:6747           withdrawals inserted as status 'pending'
server.js:7351           LIVE_FUNDING_REQUIRED (new gate, active on deploy)
server.js:7615           activation gate on /api/trade
server.js:11509          POST /api/payhip/webhook
server.js:11537/11565    GET /api/live/activation, POST /api/live/activate
server.js:11633          GET /api/admin/deposits/reconciliation
server.js:540-558        security headers middleware
services/PayhipEntitlements.js:73-111     resolvePayhipConfig (usable ignores the token)
services/PayhipEntitlements.js:192        tokenMatches (empty expected -> false)
services/PayhipEntitlements.js:562-640    redeem (fail-closed chain; not-recorded)
supabase/migrations/049_min_deposit_50.sql             100 -> 50 (contradicts decision)
supabase/migrations/050_payhip_live_activation.sql     tables, RLS, claim/revoke
supabase/migrations/051_rebrand_subscription_detail.sql  one string, no search_path
public/index.html        keys auth.login.subtitle / auth.signup.subtitle (en, ar)
public/partners.html:7,15  "an Kalderix"
services/telegram-i18n.js:261,262  "an Kalderix"
scripts/verify-rebrand.js:52-62,168-200  gate scope and blind spots
```
