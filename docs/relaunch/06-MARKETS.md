# Workstream G - Brazil vs Mexico vs Argentina, and Google Ads eligibility

Date: 2026-11-16
Status: research complete. **No ad account was created, no campaign was launched,
nothing was spent.** All policy quotes below were fetched today from
support.google.com/adspolicy.

---

## 1. The Google Ads answer comes first, because it decides the country question

You asked me to check the current policies from official sources and not to
assume an ordinary ad account can promote this. The rules are unusually clear.

**Google defines the category broadly.** "Financial products and services are
defined as products and services related to the **management or investment of
money and cryptocurrencies**, including personalized advice." Arbitrix is inside
that definition.

**Complex speculative products require a licence.** For CFDs, financial spread
betting and rolling spot forex, Google "only allows them to be advertised in
limited circumstances... in select locations and **only if they meet all of the
following criteria: The advertiser is a licensed provider or aggregator**; the
products and ads comply with local laws; the targeted location is eligible to be
targeted and **the account is certified by Google**."

**Crypto trading is prohibited outright.** Under "Prohibited content": "Ads
promoting initial coin offerings, **DeFi trading protocols, or the purchase, sale,
or trade of cryptocurrencies or related products are not allowed**."

**And so is the landing page's own pattern.** "Ad destinations that aggregate or
compare issuers of cryptocurrencies or related products are not allowed.
Examples: **Cryptocurrency trading signals**; cryptocurrency investment advice;
aggregators or affiliate sites containing related content or broker reviews."
Separately, for speculative products: "The following scenarios would lead to
disapproval... **Ad destinations that provide signals** for the trading of
complex speculative financial products. Examples: **trading signals, tips, or
speculative trading information**."

**This is why the "arbitrage opportunity" notifications matter beyond honesty.**
A card that announces "Arbitrage Opportunity Found - GOLD - observed spread
0.35%" is, in Google's vocabulary, a trading signal. Even after the disclosure I
added on this branch (which makes it defensible as an educational example), it is
the exact pattern the policy names. For paid acquisition it should be removed or
replaced with a non-signal presentation.

**Mandatory disclosures.** If financial products are promoted at all, Google
requires, clearly visible without hover or click: **the physical address of the
business**, **all associated fees**, and any third-party accreditation claimed.
Arbitrix currently publishes a KVK registration and a registered address on an
*unlisted* page; fees are scattered. A paid landing page would need a dedicated
disclosure block.

### Verdict on Google Ads

**Not eligible today**, for reasons that no country choice fixes:

1. Arbitrix is not a licensed financial-services provider, and both the
   speculative-products and crypto paths require a licensed advertiser.
2. Crypto trading promotion is prohibited regardless of location.
3. The landing page currently contains the two patterns Google names explicitly
   (trading signals / spread announcements).
4. A campaign run on an ordinary account would end in disapproval and, on
   repeat, suspension. **I will not recommend disguising the business model to
   get past review** - that is the one thing the brief rules out and it is what
   gets accounts permanently banned and payment processing pulled.

**What would change this:** becoming a licensed/authorised provider in a target
jurisdiction and applying for Google's financial-services certification, with a
compliant landing page (no signalling, full fee and address disclosure). That is
a legal/commercial project measured in months, not an ad-ops task.

## 2. Country comparison

Since paid search is not the available channel, the comparison is framed around
*organic/community* acquisition plus payment feasibility, which is what is
actually actionable now.

| Criterion | Brazil | Mexico | Argentina |
|---|---|---|---|
| Crypto familiarity | Very high; large retail base | High; growing | Very high (inflation-driven) |
| Existing localisation | **pt-BR already shipped** (one of 6 app locales) | Spanish already shipped, but **es-419/MX variants not reviewed** | Same as Mexico (es) |
| Language cost to launch | **Zero** (app, partners page, deposit tutorials, support bot all in pt) | Low (copy review only) | Low |
| Support bot | **pt supported** (en/pt/ar) | Spanish **not** supported by the Telegram bot | Spanish not supported |
| Local fiat funding | Not available - USDT/TRC20 only | Not available | Not available |
| Customer must already hold crypto | Yes | Yes | Yes |
| FX friction | Customer buys USDT themselves (their cost) | Same | Same, plus capital controls |
| Payment provider constraint | Q8Pay only; card rails not eligible (see `05-PAYMENTS.md`) | Same | Same |
| Regulatory posture on retail trading platforms | Active regulator (CVM) with a clear position that unlicensed investment offerings are illegal; "crypto as payment" is regulated | CNBV/condusef active; fintech law exists | Severe FX/capital controls; card FX at official rate creates arbitrage the platform would absorb |
| Refund/chargeback exposure | Crypto rail: none | None | None |
| Effective CAC via paid search | **Unavailable** (see §1) | Unavailable | Unavailable |
| Effective CAC via organic | Cheapest of the three: existing pt content, existing pt bot | Needs es bot work first | Needs es bot work + FX handling |

### Argentina - disqualifying operational issue

Argentina's dual exchange rate and card FX rules mean a customer paying in ARS can
be settled at an official rate materially different from the market rate. For a
platform whose product is literally an arbitrage claim, absorbing that FX spread
on every deposit is both a financial loss and a compliance problem. **Not a first
market.**

### Mexico - viable second, but not first

Spanish copy already exists, but the **support bot does not speak Spanish** (it is
en/pt/ar). Launching into Mexico without support coverage recreates the exact
problem the relaunch is trying to solve, and the bot's localisation layer was
built to be extended - adding `es` is one locale object plus a migration CHECK
update. Reasonable as market #2 once Spanish support exists.

### Brazil - recommended first market

It is the only one of the three where the product is already in the customer's
language end to end: the web app (pt-BR), the partner landing page, the deposit
tutorials, and the Telegram support bot. That is the whole cost difference. It
also has the deepest retail crypto familiarity of the three, which matters because
the only funding rail is USDT-TRC20 - the customer must already be able to buy
USDT somewhere, and in Brazil that is common.

**Important caveat that must not be glossed over:** "recommended first market" here
means *the cheapest place to acquire organically with the assets that exist*, not
"a market where this product is lawful to offer without analysis". Brazil's CVM
takes an active view on unlicensed investment offerings and on platforms that
promise returns. Before spending on acquisition in Brazil, the product claim has
to survive that review - which returns to `01-BASELINE.md` §2. Marketing into
Brazil with a balance that compounds by design would be the highest-risk version
of this launch.

## 3. What the founder actually needs to decide

1. **Accept that paid search is not available** for the current product, in any
   of the three countries, unless the platform becomes a licensed provider and
   passes Google's certification. Budget should move to community/Telegram and
   partnership channels, which the platform already has tooling for.
2. **Brazil first**, because the localisation and support already exist. Requires
   no new engineering.
3. **Mexico second**, gated on adding Spanish to the Telegram support bot.
4. **Argentina last**, because of FX/capital controls.

## 4. If the founder still wants to test paid acquisition

The only compliant shape I can recommend, and only after the product claim is
fixed:

- Advertise **the software** (a dashboard that automates a described strategy),
  not investment returns, and not signals.
- Remove the spread notifications from any landing page used for paid traffic.
- Publish the physical business address and all fees above the fold.
- Target **only** keywords about trading software/automation, not
  "make money"/"profit"/coin names.
- Separate ad account, small budget, and expect manual review.

That is still likely to be refused while the balance is withdrawable and the
strategy is unlicensed advice. I would not spend the budget until that is settled.
