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

```
A  docs/relaunch/01-BASELINE.md
A  docs/relaunch/02-BRAND.md
A  docs/relaunch/03-MIN-DEPOSIT-50.md
A  docs/relaunch/04-PAYHIP.md
A  docs/relaunch/05-PAYMENTS.md
A  docs/relaunch/06-MARKETS.md
A  docs/relaunch/07-LOCALIZATION-ASSETS.md
A  docs/relaunch/08-ACTION-PLAN.md
A  docs/relaunch/README.md
A  tests/landing_opportunity_disclosure.test.js
A  tests/min_deposit_config.test.js
M  public/index.html                         (disclosure markup/CSS + 12 locale
                                              strings; minDeposit adoption)
M  server.js                                  (min-deposit resolver; minDeposit
                                              in both /api/auth/me branches)
M  tests/*.test.js  (23 files)                (dictionary pins 1603->1605,
                                              symbol pins -> resolved value,
                                              homepage hash re-pin)
M  AGENTS.md                                  (session note)
```

## 16. Git commits

```
964c755  fix: disclose illustrative landing data and unify the minimum-deposit knob
         (public/index.html, server.js, 23 test files, 2 new test files)
<this>   docs: relaunch research, audits and the ordered action plan
```

## 17. Tests

- **Baseline before any change:** 3170 pass / 0 fail.
- **Now:** **3198 pass / 0 fail** (two new suites, 13 + 15 tests).
- No test was suppressed, skipped or weakened. 23 existing files were updated
  because the changes intentionally moved a symbol or a dictionary size; each
  update preserves the original intent (verified case by case) and
  `tests/partners_page.test.js` was re-pinned per its own documented rule for
  approved homepage edits.
- **Latest (promotional-credit visibility step):** 3288 pass / 0 fail; the
  dictionary is 1625 keys x 6 locales with identical key sets and 0 empty values.
- Earlier verifications: all 8 inline `<script>` blocks parse
  (`vm.Script`); the dictionary is verified by evaluating the real `TRANSLATIONS`
  object (1605 keys x 6 locales, identical key sets, 0 empty, 0 duplicate keys);
  0 U+FFFD in `index.html`; `node --check server.js` clean.

## 18. Production changes awaiting approval

Nothing on this branch changes production behaviour. Specifically gated:

1. Set `PLATFORM_MIN_DEPOSIT_USD=50` (+ referral-config migration + copy sweep)
   -> **changes a production deposit requirement**.
2. Any new payment rail (Payhip / card) -> **changes live payment routing**.
3. Rebrancing and any domain/DNS change -> **operator identity**.
4. Applying the referral-config migration.
5. Enabling any of the three background workers (trading, conversion, marketing)
   - all still disabled by env.

The disclosure change is safe to deploy on its own at any time.

## 19. Remaining founder decisions

1. **The product model** (highest priority - see `08-ACTION-PLAN.md` §2): keep the
   current claim and stop withdrawals, or restate the product as a simulation /
   strategy tool. Everything else follows from this.
2. Approve a brand (Kalderix recommended) and the trading-name wording.
3. Approve the $50 minimum bundle, or keep $100.
4. Approve or reject the Payhip rail (recommendation: reject as designed).
5. Supply the real Trunkay URL.
6. Accept that paid search is closed; endorse the organic/community plan.
7. Approve Brazil-first, and whether to fund the Spanish bot for Mexico.
