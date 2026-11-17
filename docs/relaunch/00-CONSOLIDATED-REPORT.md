# Arbitrix relaunch - consolidated report

Date: 2026-11-16
Branch: `relaunch/rebrand-payment-commercial` (from `main` @ 7910db6)
Test status: **3198 pass / 0 fail** (`npm test`)

Detailed evidence lives in the numbered documents in this folder:

| Doc | Workstreams |
|---|---|
| `01-BASELINE.md` | project inspection, architecture, the critical finding |
| `02-BRAND.md` | A - brand replacement |
| `03-MIN-DEPOSIT-50.md` | B - $100 -> $50 |
| `04-PAYHIP.md` | C - Payhip activation + funding |
| `05-PAYMENTS.md` | D, E, F - Q8Pay, Trunkay, Card2Crypto |
| `06-MARKETS.md` | G - Brazil / Mexico / Argentina, Google Ads |
| `07-LOCALIZATION-ASSETS.md` | H, J - localization, asset universe |
| `08-ACTION-PLAN.md` | the ordered plan and the approval gates |

---

## The one thing that matters

Before anything else in this report: **the platform has no trading engine and no
market data.**

`services/tradingAssets.js` is a catalogue of 47 display labels. `server.js`
contains no `fetch()` at all. The P&L is
`balance * 0.5 * rand(0..2.4%) * (win ? +1 : -0.5)` - a coin biased to win 65% of
the time - executed every 8 seconds, with an expected value of **+0.285% of
balance per trade**. From a $100 balance that compounds to roughly **$303 in one
hour**.

Because the resulting balance is withdrawable once the $700 minimum is met, every
funded account is a liability that grows by construction. This is not a bug in
the plumbing (the ledger is genuinely well built - atomic, idempotent,
row-locked); it is the product's core claim having no implementation behind it.

Every other workstream inherits from this:

- **$50 vs $100** is not a trading question, because there is no trading.
- **Payhip funding packages** lose 8-9.5% at credit *and* pay out an
  engine-grown balance, so each sale has negative lifetime value.
- **Google Ads** is closed to unlicensed providers and prohibits crypto trading
  promotion - and the landing page's "arbitrage opportunity" card is exactly the
  "trading signals" pattern the policy names.
- **Card2Crypto** is unusable regardless.
- **Rebranding** the name changes none of the above, and doing it first looks
  like leaving a previous model behind.

**Recommendation: settle the product claim before spending money on the relaunch.**
Two honest options are laid out in `08-ACTION-PLAN.md` §2.

---

## 1. Recommended new brand and evidence

- 20 constructed names screened; 8 have no A record on `.com`/`.io`/`.app`.
- **Recommended: Kalderix** (`kalderix.com`). No dictionary meaning, no
  investment or licence implication, clean on all three TLDs, three syllables,
  spelling-safe.
- Alternatives: **Vantallis** (softer/higher-ticket), **Aequoris** (most
  conceptually apt, worst spelling).
- 32 stronger-sounding candidates are already in use by other parties (listed in
  `02-BRAND.md`).
- **Not verified and not claimed:** registrar availability, trademark clearance,
  social handles. DNS is a signal, not a registration check. Trademark risk needs
  a lawyer.
- Scope measured: `Arbitrix` appears **1741 times** (479 in `index.html`, 151 in
  `AGENTS.md`, 100 in `telegram-i18n.js`, 84 in `partners.html`, 79 in
  `deposit-tutorials.html`, 60 in `MarketingContent.js`, 46 in `server.js`, ~400
  in tests).

## 2. Rebranding implementation status

**Applied on the release branch.** Kalderix is approved, so the identity is no
longer a candidate: `services/brand.js` and the mirror in `public/index.html`
carry `name: 'Kalderix'`, monogram `K`, app name `Kalderix` and the violet
accent, and every static surface follows (all six locale dictionaries, page
title and social card, PWA manifest and icons, the standalone pages, the support
bot, marketing copy, transactional notifications, the TOTP issuer, the Q8Pay
invoice title and the asset registry).

The evidence is the repository's own release gate, not a grep:

```
node scripts/verify-rebrand.js --expect Kalderix   ->  ALL CHECKS PASSED
npm test                                           ->  3311 pass, 0 fail
```

What the rename does **not** touch, by design: the public domain
(`arbitrix.pro`), the mail domain (`arbitrix.ai`), the three Telegram handles,
the seeded admin login, `localStorage` keys, database identifiers and applied
migrations. Above all it does not change the legal operator: `Arbitrix Trading`
(KVK 72923513) remains the contracting party and stays visible on
`/business-registration`.

Three defects were found while applying it, and fixed:

1. The rebrand tool's ESCAPED-BOUNDARY rule bypassed the suffix guards, so an
   Arabic fixture briefly read "Kalderix Trading" (the legal entity) and an
   escaped "Arbitrix AI" kept its old descriptor. The guards are now repeated for
   escaped forms (`scripts/rebrand.js`) and pinned by cases in
   `tests/brand_token.test.js`.
2. Applying the tool rewrote the page mirror's `source` literal, which collapsed
   the two subscription-detail eras into one - every pre-rename charge would have
   rendered raw English instead of the localized label. `source` is now
   re-asserted by the tool and pinned by `tests/kalderix_identity.test.js` (which
   now evaluates the PAGE's mirror rather than the server module's copy).
3. After the rename the support bot answered "who is Kalderix" but NOT
   "who is Arbitrix", even though customers still type the domain name and the
   legal entity carries it. Both the knowledge base and the dialogue engine now
   fold the legacy name onto the current one for MATCHING only, derived from
   `BRAND` - so a future rename keeps both spellings working
   (`tests/legacy_brand_alias.test.js`).

The remaining external steps are the founder's, not code: trademark clearance,
and - only if production overrides it - the `EMAIL_FROM` display name in the
Render environment. Migration 051 (the subscription detail written by SQL) is
still applied AFTER the code is live, per section 7.4 of the release checklist.

### 2b. Promotional credit visibility (implemented)

A new account is seeded with a $50 promotional Live balance, but it used to be
invisible on first login - and a Payhip-gated account saw only "Activation
required". The dashboard now carries one card that shows the amount, a Live Mode
status and one approved explanatory sentence, in all six locales:

| Situation | Card |
|---|---|
| Registered, not activated | `$50.00 - Promotional Credit` + `Activation required` + Activate |
| Activated, nothing funded | `Activated - funding required` |
| Activated with the credit intact | `$50.00 - Promotional Credit` + `Live Mode available` |
| Funded existing customer | hidden - their dashboard is unchanged |
| MARKETING_SANDBOX | hidden - simulated accounts have no credit |

`services/LiveModeStatus.js` derives the label from facts `server.js` already
computes and the values are published as `liveMode` on `/api/auth/me`,
`/api/live/activation` and `/api/live/activate`. Nothing else moved: no wallet
write, no second credit, the credit is still **not** a qualifying deposit (the
first-deposit rule before a withdrawal is untouched), and the Payhip gate, the
minimum deposit, the withdrawal minimum and the $20 promotional profit cap are
unchanged. 17 regression tests pin exactly those properties.

## 3. $50 deposit feasibility

- Full inventory of every location the $100 appears (server 17 reads, 1 DB config
  row, 1 env var, frontend, ~46 literal strings across 6 locales, ~20 tests) is
  in `03-MIN-DEPOSIT-50.md` §1.
- **Implemented and shipped:** `resolvePlatformMinDeposit()` +
  `PLATFORM_MIN_DEPOSIT_USD` env knob, every consumer reads the resolved value,
  `/api/auth/me` publishes `minDeposit`, frontend adopts it into
  `APP.MIN_DEPOSIT`. **With the variable unset the effective minimum is exactly
  $100 and behaviour is byte-identical.**
- **Feasibility verdict:** a $50 balance cannot support real arbitrage - nor can
  any balance, because no execution exists. Real arbitrage on $50 is unviable
  anyway once a venue's minimum notional and four fee events are considered.
- The $50 decision is a conversion/unit-economics decision, not a trading one.
  Fee analysis: a $50 package nets ~$47.75-48.25 and a $100 package ~$96.30-96.80.
- **Approval bundle to go live:** env var + `referral_config` sync migration +
  the ~46 string sweep. Prepared as steps, not applied.

## 4. Payhip activation-and-funding architecture

- **Zero Payhip code exists** in the repo - no product keys, no licence table, no
  webhook, no redemption. Only the atomic-credit *pattern* is reusable.
- Full design written and ready in `04-PAYHIP.md` §5: tables
  (`payhip_products` / `payhip_purchases` / `payhip_entitlements`), webhook
  ordering (raw bytes -> HMAC -> **re-verify against Payhip's API** -> insert ->
  entitlement, never credit from the webhook), redemption with hashed single-use
  keys and an ownership check, credit through a new
  `credit_payhip_entitlement_safe` RPC following the existing lock pattern,
  refund/chargeback matrix (never negative balance, always a ledger row, freeze
  instead of debt), daily reconciliation, sandbox isolation, and a 12-item
  deployment checklist.
- Preferred binding to the account: passthrough user id at checkout, then
  email match, then manual key entry - all still passing the one-time claim check.

## 5. Payhip merchant eligibility

**Not eligible as designed.** Three reasons, in order of severity:

1. The transaction is not a software sale - the licence delivers a withdrawable
   balance. Describing it as software would be the misrepresentation the brief
   forbids.
2. Payhip settles through Stripe/PayPal, whose policies restrict investment
   schemes and unlicensed financial services; Payhip's own restricted-products
   guidance names get-rich-quick schemes.
3. Written clarification would be required and is very likely to be refused.

Separately, the fees make it unviable even if allowed: **9.5% loss on a $50
package** the moment it is credited.

**Eligible alternative:** sell genuine software access on Payhip (instant
licence) and keep balance funding on the existing crypto rail.

## 6. Q8Pay findings and recommended changes

- **The decimal discriminator is real and live.** Q8Pay perturbs
  `amountUsdtExact` per invoice (address-reuse disambiguation, not a fee), the
  platform stores it as `invoice.amount_crypto`, displays it to the customer, and
  the webhook compares it to four decimals. Crediting uses the round
  `amount_usd`.
- **This is a genuine confusion and a revenue-loss cause:** a customer who sends
  100.0000 instead of 100.0037 gets `{error:'Amount mismatch'}`, HTTP 200, no
  credit, no retry, money on-chain.
- **Recommendation:** ask Q8Pay for a **unique deposit address per invoice** - then
  the amount can be round and the address is the discriminator, with no crediting
  change needed (the address is already validated). If addresses must be reused:
  exact amount as the primary number with a copy button, keep the QR on the exact
  amount, and replace silent rejection with proportional crediting plus an admin
  reconciliation queue.
- Everything else in the Q8Pay implementation is correct and should stay: asset
  lock, HMAC over raw bytes, server-side re-verification, address check, tx-hash
  idempotency, `live_`/`test_` guard, `credit_payment_safe`.
- Keep Q8Pay. It is the cheapest rail (~0.5%) and the only one with no new
  eligibility exposure.

## 7. Trunkay assessment

**It could not be found: `trunkay.com`, `.io`, `.co`, `.net`, `.app`, `.pay`,
`.finance`, `.co.uk` and `trunkpay.com` all return NXDOMAIN.** No site, no API
docs, no fee schedule, no country coverage, no webhook contract, no eligibility
policy. I will not fabricate an assessment. **Need the exact URL or where the
name came from.** (Likely a spelling variant, an invite-only reseller, or a name
from a sales conversation.) A provider with no public footprint cannot be
reviewed for licensing, settlement or disputes - disqualifying until verified.

## 8. Card2Crypto assessment

**Do not use.** Verdict is based on the site's own words, fetched today:

- "**No KYB. No chargebacks. No fund freezes.**"
- "accepts bank cards such as Visa and Mastercard, **regardless of what you are
  selling**. We cater to **all high-risk business models**."
- "**no borders or local regulations to worry about**" / "**Be 100% anonymous**".
- Mechanism, from their About page: "When a customer pays you, **they don't pay
  you directly for the product or service; instead, they purchase USDC on your
  behalf**".

That last sentence is **transaction laundering**: the card charge is booked as the
cardholder buying crypto rather than paying for your product. It is prohibited by
Visa/Mastercard rules and is a criminal offence in most jurisdictions, and the
**merchant** carries the liability. "No chargebacks" is also simply false -
disputes are handled by the issuing bank.

The operator is **unnamed**: the Terms say disputes are resolved under "the laws
of the country where our organization is based" and never identify the
organisation. There is no counterparty to contract with or pursue.

Underlying on-ramps (MoonPay, Transak, Banxa, Ramp, Coinbase Pay) are legitimate
but are a different proposition: the customer buys crypto **for themselves** and
sends it. None of them publish that they permit funding a third-party platform's
trading balance, and **country availability for Nigeria/South Africa is
unverified** and must not be claimed.

## 9. Recommended payment architecture

1. **Q8Pay as the only funding rail.** Live, cheap, non-custodial, correct.
2. **Fix the discriminator** (unique address per invoice) - the highest-value
   single change in the relaunch for support load.
3. **Add reconciliation visibility** before adding providers: a daily
   invoice-vs-chain check and an admin queue for stale `pending` invoices and
   webhook errors. Today a mismatch is logged and dropped.
4. **No card rail for the current product.** The blocker is acquirer approval of
   a withdrawable, engine-grown balance - not integration work.
5. If card is required: sell the **$7/month software subscription** through a
   legitimate processor and keep funding on Q8Pay.

## 10. Brazil / Mexico / Argentina comparison

| | Brazil | Mexico | Argentina |
|---|---|---|---|
| Localisation | **complete** (app, partners, tutorials, bot) | app yes, **bot no** | app yes, **bot no** |
| Funding rail | USDT only | USDT only | USDT only (+ FX/capital controls) |
| Support coverage | **yes (pt)** | no | no |
| Ad channel | organic/community | organic/community | organic/community |
| Verdict | **first market** | second, gated on Spanish bot | last |

Argentina is disqualified from first position by dual exchange rates: a platform
whose product is an arbitrage claim would absorb the FX spread on every deposit.

## 11. Google Ads eligibility

**Not eligible today, in none of the three countries.** From the official policy
pages fetched today:

- Financial products are defined as "products and services related to the
  management or investment of money and cryptocurrencies".
- Complex speculative products require: "**The advertiser is a licensed provider
  or aggregator**", local compliance, an eligible target location and Google
  certification.
- "Ads promoting ... **DeFi trading protocols, or the purchase, sale, or trade of
  cryptocurrencies** or related products are **not allowed**."
- "Ad destinations that aggregate or compare issuers ... **Cryptocurrency trading
  signals** ... are not allowed", and for speculative products "**ad
  destinations that provide signals** ... trading signals, tips, or speculative
  trading information" lead to disapproval.
- Mandatory disclosures: the **physical business address**, **all fees**, and any
  accreditation claimed - visible without a click or hover.

Two consequences: (a) the country question is moot for paid search; (b) the
landing page's "Arbitrage Opportunity Found - observed spread 0.35%" card **is**
the prohibited "trading signals" pattern - which is why the disclosure added on
this branch matters, and why that card should not be used on a paid landing page
at all. I will not recommend disguising the model to pass review.

## 12. Localization readiness

- 6 locales already fully wired in the app (1605 keys each), on `/partners`
  (84), `/deposit-tutorials` (27) and `/reset-password` (44), with browser
  detection that never overrides a manual choice, and RTL for Arabic.
- **Gaps:** the Telegram bot is en/pt/ar only (**no Spanish**); transactional
  **emails are English only**; legal pages are English only.
- **Keep USD formatting.** The balance is USD-denominated; localizing `$` to
  R$ or MXN would misstate the amount. Dates are already localized; numbers
  deliberately are not.
- Sequence: Spanish bot -> localized emails -> localized legal -> es-419 copy
  review. pt-BR needs nothing. Do it after the brand decision.

## 13. Landing-page notification implementation

- **Implemented and shipped on this branch:** a visible localized **"Illustrative"**
  tag and a full disclosure under the card - "Example data only - these are not
  live market prices. Not financial advice and no profit is guaranteed." - in all
  six locales.
- Why: `services/MarketOpportunities.js` builds the figures from `Math.random()`
  bands against the display registry. There is no market feed, so the numbers are
  illustrative **by construction**, and the card previously presented them with
  no qualifier at all.
- The earlier management decision to remove a note from this card is respected:
  the removed identifiers (`arb-opp-note`, `arbOppNote`, `arbOpp.note`) and their
  copy stay gone; the new disclosure uses different names and different wording.
- **Not done, and correctly not done:** I did not fabricate a "real" feed. The
  brief's "verified prices, stale-price rejection, fee-aware net spread" are
  impossible while no data source exists. The honest options were to hide the
  card or label it - labelling keeps the feature and costs nothing.
- `GET /api/market/opportunities` is unchanged (public, no auth, no DB, no money)
  and already returns `simulated: true`.

## 14. Multi-asset expansion findings

- **0 assets are executable; 0 are market-data-only; 47 are display labels.**
  `services/tradingAssets.js` holds 47 instruments across 5 classes whose `detail`
  field is a venue-pair *label*; no exchange or broker connectivity exists
  anywhere (`server.js` has no `fetch()`).
- Real support would need: two executable legs per instrument (two funded
  exchange accounts for crypto), or a broker relationship for FX/metals; equities,
  indices and energy are out of reach for this entity.
- **Recommendation:** keep the registry as a catalogue and add a capability flag
  (`execution: 'live' | 'market_data' | 'none'`) so the UI can only promise what
  the flag allows. **Do not add more instruments as labels** - the catalogue is
  already broader than anything executable.

## 15. Files changed

The branch carries 18 commits against `main` and touches 159 files
(+13156 / -1324). The release-critical ones:

```
A  docs/relaunch/*.md                              (baseline, brand, min deposit,
                                                    Payhip, payments, markets,
                                                    localisation, action plan,
                                                    implementation, release
                                                    checklists, smoke rehearsal)
A  supabase/migrations/049_min_deposit_50.sql      ($50 minimum knob, UNAPPLIED)
A  supabase/migrations/050_payhip_live_activation.sql
                                                   (purchase + entitlement
                                                    tables and the row-locked
                                                    claim function, UNAPPLIED)
A  supabase/migrations/051_subscription_detail_rebrand.sql
                                                   (the SQL-written detail
                                                    string, UNAPPLIED)
A  services/brand.js                               (one identity source)
A  services/PayhipEntitlements.js                  (Option A: verify, redeem)
A  services/ProfitPause.js                         (the $400 pause, unchanged)
A  scripts/rebrand.js, scripts/verify-rebrand.js    (one-command rename + gate)
A  .github/workflows/ci.yml                        (test-only CI)
A  scripts/validate-workflows.js                   (structural workflow linter)
A  tests/kalderix_identity.test.js, tests/legacy_brand_alias.test.js,
   tests/brand_token.test.js, tests/payhip_*.test.js,
   tests/live_activation_entitlement.test.js,
   tests/admin_reconciliation_panel.test.js,
   tests/security_headers.test.js, tests/ci_workflow.test.js
M  public/index.html                               (brand palette/mirror, live
                                                    activation UI, deposit
                                                    funding routes, landing
                                                    notifications, reconciliation
                                                    panel, promo card)
M  server.js                                       (min-deposit resolver, Payhip
                                                    routes, security headers,
                                                    reconciliation route)
M  services/*.js, public/*.html, docs/*, tests/* (35 files)
                                                   (brand strings, guardrails)
```

## 16. Git commits

```
964c755  fix: disclose illustrative landing data and unify the minimum-deposit knob
bdfb514  docs: relaunch research, audits and the ordered action plan
9ebe5f3  feat: single-switch brand, $50 deposit knob, Payhip Live activation
08a357d  feat(payhip): verify licences against Payhip's API and fail closed
5d94d46  docs(relaunch): the exact Payhip release sequence, rollback and inquiry
be992d8  feat(brand): centralise the identity and make the rename one command
785a5e9  feat(db): rebrand the subscription transaction detail (UNAPPLIED)
1427374  docs(relaunch): the Kalderix identity, the approval command and its limits
be3683c  fix(brand): derive the identity strings a rename would otherwise break
5b92b1d  test(relaunch): add the release verifier the rename must pass
50e7b15  docs(relaunch): master release checklist, the $50 knob, rehearsal evidence
1d6a2cd  fix(db): make the $50 release migration and probe schema-agnostic
5ea563b  test(relaunch): close the production smoke gate with 45 passing checks
10e3f04  feat: show the $50 promotional credit on the dashboard before activation
26a19ad  ci: test-only GitHub Actions workflow with a structural linter
701d4e2  feat(brand): apply the Kalderix identity across every customer surface
314fe6e  fix(payhip): name an unrecorded-but-real licence honestly, and surface
         the deposit queue
d2dc74f  feat(security): baseline security headers on every response
```

## 17. Tests

- **Baseline before any change:** 3170 pass / 0 fail.
- **Now: 3327 pass / 0 fail** (`npm test`, run locally on every commit).
- The dictionary is **1631 keys x 6 locales**, identical key sets, 0 empty
  values, placeholder parity intact; all 8 inline `index.html` script blocks
  parse (`vm.Script`); `node --check server.js` is clean; 0 U+FFFD.
- No test was suppressed, skipped or weakened. Files were updated only where a
  change intentionally moved a symbol, a dictionary size or a pinned string, and
  each was reviewed to keep its original intent.
- **CI now enforces this on GitHub**: `.github/workflows/ci.yml` runs the suite
  on every push and pull request with `contents: read` and no secrets, plus a
  structural linter that fails the build if the workflow ever gains a deploy
  step, a `push --force`, a database command or an injected secret. Both runs on
  the rebrand commit concluded **success** - the first automated verification
  this repository has had.
- `tests/partners_page.test.js` no longer hashes all of `index.html`. It pins the
  anonymous funnel slice (landing markup .. app shell), so an approved homepage
  edit elsewhere no longer forces a meaningless re-pin while a /partners change
  to the funnel still fails.

## 18. Production changes awaiting approval

Nothing on this branch changes production behaviour until an operator acts.
Specifically gated:

1. **Apply migrations 049, 050, 051** (Supabase SQL editor). 049 and 050 must be
   applied before `PAYHIP_ENABLED` is set; 051 after the new code is live.
2. **Set `PAYHIP_*`** (store, products, API key, product secret, webhook token,
   public base) and then `PAYHIP_ENABLED=true` -> turns on a new purchase rail.
3. **Set `PLATFORM_MIN_DEPOSIT_USD=50`** -> changes a production deposit
   requirement (the referral config `minimum_qualifying_deposit` should move to
   50 in the same window).
4. **Merge PR #171 to `main`** -> Render deploys it.
5. Enable any of the three background workers (trading, conversion, marketing) -
   all still disabled by env.
6. Trademark clearance for Kalderix (legal, not code) and, only if production
   overrides it, the `EMAIL_FROM` display name.

## 19. Remaining founder decisions

1. **Payment rail**: Payhip as designed (activation only, funding stays Q8Pay),
   or the rejected alternative (one purchase that also credits trading capital -
   `05-PAYMENTS.md` explains why it cannot be funded safely after fees).
2. **Apply the migrations** and enable the rail, or hold.
3. **$50 minimum**: adopt it (migration 049 + `PLATFORM_MIN_DEPOSIT_USD=50`) or
   keep $100. `03-MIN-DEPOSIT-50.md` shows a $50 balance can trade under the
   current engine, but the promo cap and the $400 pause interact with it.
4. **Kalderix trademark clearance** - required before the name is promoted.
5. **Paid search**: closed for this product category (`06-MARKETS.md`); endorse
   the organic/community plan instead.
6. Whether a lost-webhook purchase should self-heal from the licence API (it
   would create a purchase row with no price or fee data and pollute
   reconciliation - currently refused, with the buyer told the truth instead).
7. Supply the real Trunkay URL if that investigation is still wanted.

## 20. Verification performed in this session (beyond the report)

### 20.1 Migration review, static (049 / 050 / 051)

Read line by line. `050` creates `payhip_purchases` and
`payhip_entitlements`, both with RLS enabled and a service-role policy only, a
UNIQUE `licence_key_hash` and a UNIQUE `payhip_sale_id`, and the claim function
`redeem_payhip_entitlement_safe` which is `SECURITY DEFINER`, takes
`FOR UPDATE` on both rows, re-checks after the lock, refuses a second account and
is granted to `service_role` only. It never writes a wallet - activation is a
permission, not money. `051` touches exactly one string in
`charge_subscription_safe` and fails loudly if either the old or the new text is
absent, so it cannot silently no-op.

**Not executed here.** No PostgreSQL server and no Docker are available in this
environment (checked: `docker` absent, `pgserver` / `postgresql-wheel` /
`pg_embed` unavailable from the index), so no migration was applied and nothing
was rehearsed against a live schema in this session. `docs/relaunch/rehearsal/`
carries the bootstrap SQL and `14-PRODUCTION-SMOKE-REHEARSAL.md` the procedure.

### 20.2 Payment friction, fixed

1. **A real licence with an unrecorded sale is no longer called invalid.** The
   licence API is the evidence, the database is the authority on redemption; when
   the provider confirms a licence the database has no sale row for (webhook lost
   or deferred), the claim function answers `invalid_licence` and the buyer used
   to be told their key was not valid. It is now `not-recorded`, retryable, logged
   to `payhip_events` and shown in the buyer's language.
2. **The deposit reconciliation queue is now visible.** The read-only admin route
   existed with no UI, so a rounded or late payment and a confirmed-but-uncredited
   deposit were invisible to an operator. Both queues now have a panel in the
   Deposits tab with the exact on-chain amount; it credits nothing (pinned).

### 20.3 Security headers

The application sent none. One middleware now adds `nosniff`, `frame-ancestors
'none'`, `X-Frame-Options: DENY` and `strict-origin-when-cross-origin` to every
response, and HSTS only when the request actually arrived over TLS. A full
resource CSP is deliberately not set: the app depends on a charting library,
Google Fonts and a QR image service, and a wrong policy breaks them silently - it
belongs in its own change with a report-only rollout. Six tests boot the real
server and assert all of it.

### 20.4 What was re-verified and left alone

`charge_subscription_safe` (011) vs 051 - money behaviour identical, only the
label moves. The Q8Pay amount comparison - the webhook compares the confirmed
amount to the stored `amount_crypto` (the provider's own `amountUsdtExact`), not
to the buyer's round USD figure, and the UI shows that exact 4-decimal amount in
the amount, the copy button and the QR. `PLATFORM_MIN_DEPOSIT_USD` (100),
`MIN_WITHDRAWAL_USD` (700), the promo credit (50), the promo profit cap (20), the
profit pause (400, env-overridable) and the referral percentage (20) are
unchanged by this branch.
