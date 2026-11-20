# Workstream B - Reducing the minimum deposit from $100 to $50

Date: 2026-11-16
Status: **SUPERSEDED - the $50 minimum was NOT adopted. Management kept the $100
floor, so nothing in this document is live.** It is retained as the feasibility
record only: `PLATFORM_MIN_DEPOSIT_USD` stays unset (default 100), migration 049
asserts 100, and the decision is recorded in `00-CONSOLIDATED-REPORT.md` section 19
and `13-RELEASE-CHECKLIST-KALDERIX.md` section 2.1.

---

## 1. Every place the $100 minimum lives (the full audit you asked for)

### Server (authoritative)

| Location | What it does | Now reads |
|---|---|---|
| `server.js` `PLATFORM_MIN_DEPOSIT_USD = 100` | built-in default | the default |
| `server.js` `resolvePlatformMinDeposit()` | **new** - resolves the effective value from env `PLATFORM_MIN_DEPOSIT_USD`, integer 10..10000, invalid -> default + warning | - |
| `server.js` `PLATFORM_MIN_DEPOSIT` | **new** - the effective value, resolved once at boot | every consumer below |
| `POST /api/payment/create-invoice` | `amount < MIN_DEPOSIT_AMOUNT` -> 400 | `PLATFORM_MIN_DEPOSIT` |
| `handleSandboxDepositRequest` | simulated deposit floor | `PLATFORM_MIN_DEPOSIT` |
| `handleSandboxInvoiceCreate` | simulated invoice floor | `PLATFORM_MIN_DEPOSIT` |
| `SANDBOX_REFERRAL_MIN_DEPOSIT` | sandbox referral qualifying deposit | `PLATFORM_MIN_DEPOSIT` |
| `CONFIG_VALIDATION.minimum_qualifying_deposit` | default offered in the admin config form | `String(PLATFORM_MIN_DEPOSIT)` |
| `getReferralConfig('minimum_qualifying_deposit', ...)` x3 call sites | fallback when the config row is absent | `String(PLATFORM_MIN_DEPOSIT)` |
| `MARKETING_FACTS.minDeposit` | substituted into Telegram marketing copy | `PLATFORM_MIN_DEPOSIT` |
| `GET /api/auth/me` (production **and** sandbox branch) | **new** `minDeposit` field | `PLATFORM_MIN_DEPOSIT` |
| `GET /api/deposit/options`, `GET /api/referral/config`, `GET /api/referral/stats` | `minDeposit` / `minimumDeposit` | `PLATFORM_MIN_DEPOSIT` |

### Database

| Location | Value | Note |
|---|---|---|
| `referral_config.minimum_qualifying_deposit` | `'100'` | **This is the one the env knob cannot reach.** It is a stored row; changing the env var alone leaves referral qualification at $100. |
| migration 023 (`..._final_min_deposit_and_referral_earnings.sql`) | bumps `'50'` -> `'100'` | historical |
| migrations 020/021/022 SQL helpers | `v_min DECIMAL := 100;` hardcoded fallbacks inside PL/pgSQL | only used when the config row is missing |

### Environment

| Variable | Status |
|---|---|
| `PLATFORM_MIN_DEPOSIT_USD` | **new**, optional, default 100 |

### Frontend

| Location | Value |
|---|---|
| `APP.MIN_DEPOSIT` | `100`, now **overwritten** by `meData.minDeposit` on sync |
| `MIN_DEPOSIT_AMOUNT = APP.MIN_DEPOSIT` | used by the deposit modal validation |
| `deposit.minDeposit` i18n (6 locales) | `{{min}}` placeholder -> follows automatically |
| `startHere.live.step1` (6 locales) | `{{min}}` placeholder -> follows automatically |
| ~46 **literal** `$100` strings across 6 locales | do NOT follow - see section 4 |

### Tests

~20 suites assert the exact value or the exact symbol
(`const PLATFORM_MIN_DEPOSIT_USD = 100;`, `amt < PLATFORM_MIN_DEPOSIT`,
`String(PLATFORM_MIN_DEPOSIT)`, `SANDBOX_REFERRAL_MIN_DEPOSIT = ...`). These are
intentionally contract tests: a value change must surface here.

### Docs / admin UI

`docs/relaunch/*`, `AGENTS.md`, the admin "Referral configuration" form
(validation + default description), the withdrawal-eligibility copy that says
"minimum deposit of $100".

## 2. Trading feasibility of a $50 balance - the honest answer

You asked for this to be established before changing a constant, and not to
invent opportunities to make $50 look viable. Here it is.

**A $50 balance cannot support real arbitrage trading, and neither can $100,
$1,000 or $100,000 - because the platform executes no trades at all.**

- There is no exchange connector, no order router, no API key to any venue, and
  no market-data feed in the codebase (`01-BASELINE.md` section 2).
- "Assets" and "venues" are display strings; the P&L is
  `balance * 0.5 * rand(0..2.4%) * (win ? +1 : -0.5)`, a +0.285%-per-trade
  expected value running every 8 seconds.
- Therefore the questions in the brief - minimum executable order size,
  provider minimum notional, taker fees, slippage, liquidity, partial fills,
  minimum remaining balance - have **no answer in this system**, because none of
  them are modelled. The only real "fees" in the platform are payment-provider
  fees and the 0.5% Q8Pay merchant fee.

If and when real execution is introduced, the binding constraints on a small
account would be, in order: the venue's minimum notional (typically $5-$10 for
crypto pairs, $1,000+ notional for some CFD/FX brokers), taker fees on BOTH
legs (two round trips = four fee events), and the fact that a 0.15-0.40% gross
spread is usually consumed entirely by fees plus slippage below roughly $5,000
of notional. That is why real arbitrage is a capital-intensive, low-margin
business - and why a $50 account is not a commercially meaningful unit for it.

**Consequence for the decision:** $50 vs $100 is not a trading question. It is
a conversion/friction question (lower first-payment barrier) combined with a
unit-economics question (can the platform service the account profitably).

## 3. Unit economics of the $50 decision

| Item | $50 package | $100 package |
|---|---|---|
| Card/PSP fee at 2.9% + $0.30 | $1.75 | $3.20 |
| Q8Pay merchant fee at 0.5% (USDT) | $0.25 | $0.50 |
| Net settlement (approx.) | **$47.75 - $48.25** | **$96.30 - $96.80** |
| Promised trading balance | $50 | $100 |
| Shortfall the platform absorbs | **~$2-2.25 (4-4.5%)** | **~$3.2-3.7 (3.2-3.7%)** |

So a $50 minimum does not make the business *worse* per dollar - the percentage
shortfall is slightly higher but the absolute exposure per customer is lower.
The real reason to consider $50 is the $20 promotional-credit cap: at a $50
deposit the promotional credit is worth 40% of the customer's own money, which
makes the "buy the licence, get the balance" offer easier to understand.

**However**: the same table shows the platform credits $50 for $47.75. That 4.5%
gap is fine if the customer's balance only ever pays for a service (i.e. it is a
software licence with a usage allowance). It is fatal if the balance is
withdrawable, because then every package pays out more than it took in.

## 4. What an actual $50 move requires (the prepared change set)

Not applied. When approved, it is these steps in this order:

1. **Set the server knob**: `PLATFORM_MIN_DEPOSIT_USD=50` on the Render service.
   Validated, logged, reversible by deleting the variable. No code deploy.
2. **Sync the referral config** (otherwise referral qualification stays at
   $100 while deposits succeed at $50 - the exact half-applied state the knob
   exists to prevent). One statement:
   ```sql
   UPDATE public.referral_config
      SET value = '50'
    WHERE key = 'minimum_qualifying_deposit' AND value = '100';
   ```
   Ship as `supabase/migrations/049_min_deposit_50.sql` with an idempotent guard
   and a self-check. Deliberately **not** created yet, so nobody applies a
   config change that contradicts the code default.
3. **Copy sweep**: ~46 literal `$100` strings in `public/index.html` across 6
   locales. The two most important are already placeholder-driven
   (`deposit.minDeposit`, `startHere.live.step1`) and need no edit. The rest are
   landing/FAQ/referral/badge strings that state "$100" as text. They must be
   rewritten to "$50" per locale, and the dictionary-size pins stay unchanged
   (values change, keys do not).
4. **Tests**: update the ~20 contract assertions from 100 to 50.
5. **Verify**: `npm test`, then a browser pass of the deposit modal in 6 locales
   confirming the prompt, the validation error and the onboarding step all read
   $50, and that a $49 deposit is rejected while a $50 deposit succeeds.

Steps 1-2 are reversible in minutes. Steps 3-4 are a contained code change.

## 5. What I did implement (safe, and shipping already)

`resolvePlatformMinDeposit()` + `PLATFORM_MIN_DEPOSIT`, `/api/auth/me`
publishing `minDeposit`, and frontend adoption into `APP.MIN_DEPOSIT`.

**With the env var unset the effective minimum is exactly $100 and the behaviour
is byte-identical to before.** The value of this change is that the eventual
decision is one environment variable plus the copy sweep, instead of 17
scattered reads of a constant that would silently drift apart.

Tests: `tests/min_deposit_config.test.js` (15) executes the real resolver
against an environment matrix (unset, valid, whitespace, `50.5`, `abc`, `0`,
`5`, `9`, `10001`, `1e6`) and asserts every consumer and both `/api/auth/me`
branches use the resolved value.

## 6. Recommendation

- Do the **$50 minimum** - it lowers the first-payment barrier and the
  promotional-credit ratio becomes easier to explain. Low risk, reversible.
- Do **not** present $50 as "enough to trade real arbitrage". At $50, any real
  venue's minimum notional plus fees make genuine arbitrage unviable. Describe
  what the $50 actually buys (software access plus a starting balance for the
  configured strategy) rather than implying a market-capable trading account.
- Do it **together with** the referral-config sync, not before.
