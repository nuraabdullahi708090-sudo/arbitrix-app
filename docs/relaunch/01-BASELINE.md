# Arbitrix relaunch - baseline architecture report

Date: 2026-11-16
Branch: `relaunch/rebrand-payment-commercial` (created from `main` @ 7910db6)
Baseline test run before any change: **3170 tests, 3170 pass, 0 fail**.

---

## 1. What the platform actually is

| Layer | Reality |
|---|---|
| Runtime | Node.js 24 + Express 5, single process (`server.js`, ~13.5k lines) |
| Frontend | One 1.7 MB `public/index.html` (vanilla JS, hand-rolled i18n, 6 locales) |
| Persistence | Supabase/Postgres via `@supabase/supabase-js` (service-role client for money paths) |
| Hosting | Render web service (auto-deploy on push to `main`), Cloudflare in front |
| Public domain | `https://arbitrix.pro` |
| Legal entity | Arbitrix Trading, KVK 72923513 (Netherlands, eenmanszaak) - a company registration, **not a financial-services licence** |
| Money paths | Deposits (Q8Pay / Paymento / NOWPayments), withdrawals, internal $7 subscription, referral rewards, promotional credit |
| Background processes | `worker.js` (trading, DISABLED), `conversion-worker.js` (Telegram outbox), `marketing-worker.js` (Telegram publishing, disabled) |

## 2. CRITICAL FINDING: there is no trading engine and no market data

This is the single most important fact in the whole relaunch and it governs every
other workstream. It was verified, not inferred.

**No market data exists anywhere in the server.** A repository-wide scan for
exchange/oracle/price connectivity finds only payment providers, Telegram, the
Supabase REST endpoint, and an external QR-image service. `server.js` contains
**zero** `fetch()` calls. `services/tradingAssets.js` names venues
("Binance -> Bybit", "OANDA -> FXCM") purely as **display labels**.

**The P&L is a random number.** `public/index.html:executeBotTrade()` and
`services/TradingWorker.js:computeTradeAmount()` compute, identically:

```
profit = balance * 0.5 * (Math.random() * 2.4/100) * (Math.random() > 0.35 ? 1 : -0.5)
```

- the asset label is drawn at random from 47 display names;
- the size is a random percentage of the user's own balance;
- the **sign** is a coin biased to win 65% of the time (loses 35%, at half size).

So the "trade" is not a trade. It is a simulated outcome, and the outcome is
*positively biased by construction*:

| Quantity | Value |
|---|---|
| Mean absolute trade size | 0.60% of balance |
| Win probability | 65% |
| Expected value per trade | **+0.285% of balance** |
| Cadence | every 8 s = 450 trades/hour |
| Compounded result from a $100 balance | **~$303 after 1 hour, ~$1,103 after 2 hours** |
| Promo $20 cap | applies only to the $50 promotional credit, not to deposited funds |
| $400 profit pause | caps cumulative realized profit per deposit cycle |

**Why this is the relaunch blocker, not a detail**

1. It is not sustainable. Every funded account is engineered to grow, and
   growth is withdrawable once the $700 minimum is met. A user who deposits
   $400 can reach ~$800 and withdraw it; the platform has paid out $400 that no
   market ever produced. Scaling marketing scales that liability linearly.
2. It is a misrepresentation. The product, the landing page, the support bot
   and the Telegram content all describe "automated arbitrage across multiple
   markets". In substance the customer's balance moves on a random draw.
3. It changes the regulatory classification. Selling a "software licence" that
   funds a balance whose value moves by chance, and allowing withdrawals, is in
   most jurisdictions closer to an unlicensed investment product or gambling
   than to software. That is exactly what a payment provider will assess.
4. It makes several relaunch questions unanswerable as posed. "Can $50 support
   real trading?" presumes real trading; "show real verified arbitrage
   opportunities" presumes an opportunity feed; "which assets are executable?"
   presumes execution.

Nothing in the platform's *plumbing* is broken - the ledger is atomic, idempotent
and well tested. The problem is that the product's core claim has no
implementation behind it.

## 3. Financial integrity of the existing plumbing (this part is solid)

Reviewed and confirmed:

- **Atomic crediting** in Postgres SECURITY DEFINER functions
  (`credit_payment_safe`, `paymento_credit_user_safe`,
  `confirm_payment_with_credit`, `confirm_legacy_deposit_safe`,
  `record_trade_safe`, `charge_subscription_safe`,
  `convert_referral_earnings_safe`, referral award helpers). Pattern is
  consistent: validate -> idempotency check -> `FOR UPDATE` row lock ->
  re-check after lock -> mutate -> ledger row -> transaction record.
- **Idempotency** is anchored on UNIQUE keys (`payment_invoices.credited`,
  `trades.idempotency_key`, `subscription_charges.idempotency_key`), so replays
  cannot double-credit.
- **41 migrations** in `supabase/migrations/` (001-047) plus 5 legacy files in
  `migrations/`. 13 application tables (`users`, `wallets`, `transactions`,
  `deposits`, `withdrawals`, `referrals`, ...) are **not declared in any
  migration** - the schema cannot be rebuilt by replaying migrations, so a
  database dump is the only real inventory. (Recorded in
  `docs/BACKUP_BEFORE_038_043.md`.)
- **Sandbox isolation** is real: `users.environment = 'MARKETING_SANDBOX'` is
  immutable, every production financial route branches to a sandbox handler
  first, and DB backstop triggers reject sandbox writes to production tables.
- **Secrets** are env-only; no credential is in the repo. `.env.example` is
  documented.

## 4. Current business constants (single sources of truth)

| Constant | Value | Where |
|---|---|---|
| Minimum deposit | **$100** | `server.js` `PLATFORM_MIN_DEPOSIT_USD` (+ new env knob) |
| Minimum withdrawal | **$700** | `server.js` `MIN_WITHDRAWAL_USD`, `APP.MIN_WITHDRAWAL` |
| Withdrawal verification | **not required** at present | `WITHDRAWAL_REQUIRES_VERIFICATION` (default false) |
| Promotional credit | $50 on signup | `wallets.live_balance` seed |
| Promo trading cap | $20 realized profit | `PROMO_PROFIT_CAP_USD` |
| Profit pause | $400 realized profit | `BOT_PROFIT_PAUSE_USD` (env-overridable) |
| Subscription | $7/month | `payment_config.subscription.pro_price` |
| Referral reward | 20% of first qualifying deposit, once | `referral_config.referral_reward_percent` |
| Minimum trading balance (MTA) | **removed** | - |
| Active payment provider | `q8qpay` | `PAYMENT_PROVIDER` |

Residual inconsistency already documented in the repo: the support-bot knowledge
base says "no minimum withdrawal" while the server enforces $700 (disclosure
policy: the amount appears only in the withdrawal pop-up).

## 5. Subsystems relevant to the relaunch

**Authentication** - custom JWT (not Supabase Auth), bcrypt hashes, TOTP and
email 2FA, hashed reset tokens, session revocation list, production config guard
that refuses to boot on dev defaults.

**Payments** - provider abstraction (`services/PaymentService.js` +
`services/providers/{base,nowpayments,paymento,q8qpay}.js`) with
`createInvoice / getInvoiceStatus / verifyWebhook / cancelInvoice`. Q8Pay is the
active provider: white-label USDT-TRC20, HMAC-SHA256 webhook over raw bytes,
server-side re-verification of the invoice before crediting, plus exact
amount/asset/address/tx-hash validation.

**Referrals** - attribution at registration, qualification only on a confirmed
deposit at/above the platform minimum, one-time 20% reward to
`wallets.bonus_balance`, plus a separate server-authoritative conversion of
genuine referral earnings into tradable Live balance.

**Sandbox** - full simulated financial lifecycle (deposit -> invoice ->
confirmed, bot, trades, withdrawals with a terminal `rejected` that refunds
exactly once, subscription, referral programme).

**Telegram** - support bot with a deterministic conversation engine, 3 locales
(en/pt/ar), account linking, conversion outbox, and a marketing publisher that
is inert by default.

## 6. Tests and known failures

- `npm test` (node:test, `tests/*.test.js`): **3170 pass / 0 fail** on a clean
  checkout with `node_modules` installed. No pre-existing failures.
- Several suites are *contract* tests: they assert the exact current value of a
  business constant (e.g. `const PLATFORM_MIN_DEPOSIT_USD = 100;`) and the exact
  dictionary key count (1603 -> now 1605 after the disclosure keys). Changing a
  business value therefore surfaces every place that must be updated - useful,
  but it means a value change is a cross-cutting edit, not a one-liner.
- No test talks to a real payment provider, a real database, or a real
  exchange. Database-touching logic is exercised through fakes and through
  SQL-level assertions; the money functions have been verified against real
  PostgreSQL in earlier sessions (documented in AGENTS.md).

## 7. What was changed on this branch (so far)

| Change | Why | Risk |
|---|---|---|
| Landing opportunity card now carries an "Illustrative" tag + localized disclosure | The card presented RNG-generated spreads as real market observations | Display only |
| `resolvePlatformMinDeposit()` + `PLATFORM_MIN_DEPOSIT_USD` env knob; `/api/auth/me` publishes `minDeposit`; frontend adopts it | Makes the minimum deposit one switchable value instead of 17 scattered reads | None while the env var is unset (effective value stays $100) |

Everything else in this branch is documentation and analysis.
