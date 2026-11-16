# Workstreams H and J - Localization readiness, and the multi-asset universe

Date: 2026-11-16
Status: audit complete; no localization or asset changes made beyond the
disclosure strings added on this branch.

---

# H. Localization readiness

## H.1 What already exists (this is more complete than expected)

| Surface | Languages | Mechanism |
|---|---|---|
| Main app (`public/index.html`) | en, es, pt-BR, fr, ar, zh | hand-rolled dictionary, **1605 keys/locale**, `t(key, vars)` with `{{var}}` interpolation, EN fallback |
| `/partners` landing | same 6 | self-contained 84-key dictionary |
| `/deposit-tutorials` | same 6 | self-contained 27-key dictionary |
| `/reset-password` | same 6 | self-contained 44-key dictionary |
| Telegram support bot | **en, pt, ar only** | `services/telegram-i18n.js` |
| Telegram marketing copy | en, pt, ar | `services/MarketingContent.js` |
| Emails | **English only** | templates in `server.js` |
| Backend error strings | English, mapped at the edge | `BACKEND_MESSAGE_MAP` in the frontend |

Detection: `detectBrowserLanguage()` runs only when no `localStorage.arbi_lang`
exists, so a manual choice always wins. Arabic sets `dir="rtl"`, with bidi
isolation already applied to the ticker and the venue route.

## H.2 Readiness by target market

| Requirement | Brazil (pt-BR) | Mexico (es-419) | Notes |
|---|---|---|---|
| Landing / app | **Ready** | Ready | es exists but was written as generic Spanish; "es-419" review is a copy pass, not engineering |
| Registration / login / dashboard | Ready | Ready | same dictionary |
| Deposit pages | Ready | Ready | amounts use `{{min}}` placeholders |
| Payhip / activation messaging | n/a | n/a | no such flow exists (see `04-PAYHIP.md`) |
| Withdrawal instructions | Ready | Ready | |
| Referral pages | Ready | Ready | |
| **Emails** | **Not ready** | **Not ready** | English-only; password reset, email 2FA and change-email codes are the customer's first impression |
| **Notifications** | Partly | Partly | in-app notifications are localized; Telegram conversion messages are en/pt/ar |
| **Support bot** | **Ready (pt)** | **Not ready** | es missing - a locale object plus a migration CHECK update |
| Legal disclosures | **Not ready** | **Not ready** | privacy/terms/registration pages are English-only |
| Currency formatting | Needs review | Needs review | amounts are formatted as USD (`$`) everywhere; `appLocale()` already localizes **dates** but deliberately not numbers, to avoid decimal-separator confusion on financial values. **Keep `$` and USD** - the balance genuinely is USD-denominated; do not translate it to R$ or MXN, which would misstate the amount |

## H.3 The one structural rule to preserve

`localStorage.arbi_lang` is shared across the app pages, and each standalone page
has its own dictionary that mirrors the app's key names. Any new locale must be
added to **all** dictionaries in the same change, or a user switching language
will see a partly-translated product. The contract tests enforce identical key
sets per locale, which makes this failure loud rather than silent.

## H.4 Recommended sequence

1. **Spanish for the Telegram support bot** (smallest work, unblocks Mexico).
2. **Localized transactional emails** (the highest-trust gap: a Spanish customer
   gets an English password reset).
3. **Localized legal pages** for the launch markets - this needs a translator or
   lawyer, not a dictionary.
4. **es-419 copy review** of the existing Spanish.
5. pt-BR needs nothing: it is already complete.

Do all of this **after** the brand decision, so the strings are written once.

---

# J. Multi-asset expansion audit

## J.1 The honest classification

The brief asks me to distinguish (1) fully supported and executable, (2)
market-data-only, and (3) unsupported. The measurement:

| Class | Count | Which |
|---|---|---|
| **Fully supported and executable** | **0** | none - there is no execution layer |
| **Market-data-only** | **0** | there is no market-data feed either |
| **Display-label only** | **47** | everything in `services/tradingAssets.js` |

`services/tradingAssets.js` holds 47 instruments across 5 categories
(4 precious metals, 10 FX pairs, 13 equities/indices, 12 digital, 8 energy). Each
entry is `{ symbol, name, detail, category }` where `detail` is a **venue-pair
label** such as "Binance -> Bybit" or "OANDA -> FXCM". Nothing connects those
labels to a venue. A repository-wide scan for exchange or broker connectivity
(`api.binance`, `api.bybit`, `oanda`, `fxcm`, order-router style helpers) returns
**zero** hits. `server.js` contains no `fetch()` at all.

So all 47 assets are equally supported, in the sense that all 47 are equally
cosmetic. The engine draws one label at random and applies the same random
percentage to the user's balance regardless of which label it drew.

## J.2 What real support would require, per class

| Class | Data source needed | Execution needed | Realistic? |
|---|---|---|---|
| Digital assets (BTC/ETH/SOL/...) | Exchange WS/REST (Binance, Kraken, Bybit) | Exchange API with trading permission | Technically feasible; requires licensed entity for retail, plus custody and best-execution obligations |
| FX pairs | Broker/liquidity provider feed | Broker API (MT4/MT5/FIX) | Requires an introducing-broker or white-label relationship; CFDs are the most restricted category for advertising |
| Equities | Licensed market data (SIP/licensed vendor), expensive | Broker-dealer | Not realistic for this entity |
| Indices | Index futures data | Futures broker | Not realistic |
| Precious metals | Spot metals feed | LBMA/OTC or futures | Spot metals via a broker is plausible; physical delivery is not |
| Energy & commodities | Futures/OTC feed | Futures broker | Not realistic at this size |

Two conclusions:

1. **Cross-venue arbitrage needs two executable legs per instrument.** For crypto
   that is two exchange accounts with funds pre-positioned on both sides - the
   standard reason real crypto arbitrage is a capital-intensive operation and why
   a $50 account cannot do it.
2. **Sequential classes**: crypto spot (two exchanges) is the only class a small
   platform can realistically attempt. FX/metals require a broker relationship;
   equities/indices/energy are out of reach.

## J.3 Recommendation on the registry

The registry itself is good and should be kept - as a **catalogue**, with a
capability flag it currently lacks. The change I recommend (not made, because it
is a product decision):

```js
{
  symbol: 'BTC/USDT',
  name: 'Bitcoin',
  detail: 'Binance -> Bybit',   // display
  category: 'digital_assets',
  execution: 'none',            // NEW: 'live' | 'market_data' | 'none'
  dataSource: null              // NEW: provider id when one exists
}
```

Then the UI can only promise what the flag allows: names render everywhere, but a
"trade" affordance appears only for `execution === 'live'`. That single flag
prevents the recurrence of exactly the problem found in the baseline: a
47-instrument catalogue implying capability that does not exist.

**Do not add more instruments as labels.** The catalogue is already broader than
anything the platform can execute; adding a 48th label adds no capability and
increases the gap between claim and substance.
