# Arbitrix AI — Repository Notes

## Stack
- Node.js + Express 5 (`server.js`, single-file app ~2k lines).
- Supabase (Postgres) for persistence. `supabaseAdmin` (service-role) bypasses RLS.
- Frontend is a single `public/index.html` (vanilla JS).

## Payments architecture
- `services/PaymentService.js` — central service; providers implement
  `services/providers/base/ProviderInterface.js` and register via
  `paymentService.registerProvider(name, instance)`.
- Active provider = `process.env.PAYMENT_PROVIDER` (default `nowpayments`).
- Providers: `nowpayments`, `paymento`, `q8qpay` (added; white-label USDT TRC20).
- Atomic crediting is done in Postgres (SECURITY DEFINER funcs), NOT in JS:
  - `paymento_credit_user_safe()` — Paymento-specific (untouched).
  - `credit_payment_safe()` — shared/provider-agnostic (used by q8qpay).
  Both use the same pattern: idempotency check → `FOR UPDATE` row lock →
  double-check after lock → wallet credit → transaction record → referral bonus.
- Migrations live in `supabase/migrations/` (001–008). 008 = q8qpay support.

## Webhooks (IMPORTANT gotchas)
- Global `app.use(express.json({ verify: ... }))` stashes raw bytes on
  `req.rawBody` so webhook routes can HMAC-verify the exact bytes received.
  `req.body` is the parsed object (unchanged behavior).
- Route ordering bug: the generic `app.post('/api/webhook/:provider', ...)` is
  registered BEFORE dedicated `paymento`/`q8qpay` routes, so it shadows them.
  The generic handler calls `next()` for `q8qpay` so it reaches the dedicated
  handler. Paymento webhooks currently flow through the generic handler (do not
  change this until Paymento is removed).
- q8qpay webhook: `POST /api/webhook/q8qpay`, signature in `X-Webhook-Signature`
  (HMAC-SHA256 hex of raw body). Verify → re-check via q8qpay API → validate
  asset/amount/address/tx → credit via `credit_payment_safe`.

## q8qpay specifics
- API base: `https://q8qpay.com`, create invoice `POST /api/v1/invoices`.
- Always `assetCode: USDT_TRC20`, `useWhiteLabel: true`. Pass our `invoice_id`
  as `reference` (unique deposit ref) and `{arbitrixUserId, arbitrixDepositRef,
  arbitrixInvoiceId}` in `metadata`.
- Use returned `payoutAddress` (TRC20 destination) + `amountUsdtExact` + `expiresAt`.
- Sandbox: `test_` API key + `POST /api/v1/sandbox/simulate-payment {invoiceId}`.

## Env vars (q8qpay)
`Q8QPAY_API_KEY`, `Q8QPAY_WEBHOOK_SECRET`, `Q8QPAY_SANDBOX`,
`Q8QPAY_CALLBACK_URL` (full webhook URL, public-reachable), `Q8QPAY_RETURN_URL`.
Set `PAYMENT_PROVIDER=q8qpay` to switch the active provider.

## Conventions
- Do NOT remove/break Paymento until q8qpay passes E2E testing.
- Reuse the existing atomic crediting mechanism; do not build a second one.
- No docs files committed unless explicitly requested.

## Deposit UI (public/index.html)
- The q8qpay white-label deposit flow is rendered entirely client-side in
  `public/index.html` via `showPaymentSection()` (q8qpay branch ~line 7676),
  `startPollingForPayment()`, `updatePaymentProgress()`, `updateCurrentStatus()`,
  `startDepositTimer()`, and `resetDepositModal()`.
- The 4-stage progress indicator steps are `created → detected → confirming →
  credited` (data-step attrs). `updatePaymentProgress(step)` colors circles,
  labels, and `.step-desc` descriptions for each stage.
- Status text strings are passed to `updateCurrentStatus(message, color)`.
  Display wording may be polished freely, but the underlying status values
  (`confirmed`/`credited`, `confirming`/`pending`, `detected`, `expired`) and
  polling logic MUST stay unchanged.
- Exact amount = `invoice.amountUsdtExact`; payout address =
  `invoice.payoutAddress`. QR encodes `tron:<addr>?amount=<exact>&token=USDT
  &network=TRC20`. Do NOT hard-code amounts — keep them dynamic.
- A UI-only polish pass was done (2026-08): headings/labels/status wording
  refined; no payment logic, API, webhook, crediting, or provider code touched.

- Status mapping fix (2026-08): q8qpay only emits `pending | confirmed |
  expired | cancelled` (NO `detected`/`confirming` intermediate). A fresh
  unpaid invoice is `pending`. The frontend polling in
  `startPollingForPayment()` must map `pending` → "Waiting for payment..." +
  progress `created` (only Created active), NOT to `confirming`/"Payment
  detected". `detected`/`confirming` branches are kept only for providers that
  actually report those states. `cancelled` is also handled (q8qpay has it).

- Amount consistency fix (2026-08): the customer-facing amount (display, copy,
  QR, instruction) is derived from the user's entered USD amount
  (`amountUSD.toFixed(2)`), NOT from q8qpay's `amountUsdtExact`. q8qpay may
  return an `amountUsdtExact` that differs from the requested `amountUsdt`
  (e.g. 50.0020 vs 50.00) when the q8qpay merchant account applies a fee. The
  webhook amount verification (server.js, compares `invoice.amount_usd` to
  `verifyResult.amountUsdtExact`) will REJECT crediting if those differ — that
  is payment-verification logic and was intentionally NOT modified here. If
  q8qpay adds a fee, disable it in the q8qpay dashboard so `amountUsdtExact`
  echoes the requested amount; otherwise crediting will not succeed.

- q8qpay amountUsdtExact variance investigation (2026-08): our code sends a
  FIXED `amountUsdt: Number(Number(amount).toFixed(4))` (e.g. 50) and applies
  NO fee/markup/rate/randomization (the mock `calculateCryptoAmount` rate
  USDT.TRC20=1.0001 is only used by the NOWPayments branch, never q8qpay).
  q8qpay nonetheless returns a varying `amountUsdtExact` per invoice
  (50.0020, 50.0037, 50.0051, 50.0045, 51.0015). Per q8qpay docs,
  `amountUsdtExact` should ECHO the requested `amountUsdt` (150 -> 150.0000)
  and is "the exact amount to pay" (strict exact-match: a customer off by
  0.0001 USDT will not match). q8qpay's documented fee model is a flat 0.5%
  deducted from the merchant PREPAID BALANCE on confirmation — NOT added to
  the customer amount — and network/gas fees are paid by the customer on-chain,
  separate from `amountUsdtExact`. The observed deltas (0.0020-0.0051, plus an
  outlier +1.0015) do NOT equal 0.5% of 50 (0.25) and vary per invoice, so they
  are NOT the documented merchant fee. q8qpay's create-invoice response has NO
  documented fee/adjustment/required-amount field (only `amountUsdtExact`,
  `amount_fiat`, `fiat_currency` in the webhook). The variance is therefore
  undocumented q8qpay-side behavior (likely sandbox/test-mode invoice
  adjustment or account-specific configuration). Root cause must be confirmed
  with q8qpay support/dashboard before any change to amount validation or
  crediting. Until then, do NOT change webhook amount verification or crediting.

- q8qpay amountUsdtExact "first echoes, then varies" pattern (2026-08): user
  reports first 50 USDT invoice -> 50.0000, subsequent -> 50.00xx. Our code is
  provably stateless w.r.t. the amount: `createInvoice` sends a FIXED
  `amountUsdt: Number(Number(amount).toFixed(4))` and reads NO prior invoice,
  count, reference, timestamp, wallet, or DB state before the q8qpay call
  (idempotency key = `${userId}_${uniqueInvoiceId}`, so never a cache hit; no
  walletId sent -> q8qpay default wallet). So restart/cancel/count cannot
  affect the amount via our code. Leading hypothesis: q8qpay ADDRESS-REUSE
  DISAMBIGUATION — when multiple active invoices share one payoutAddress,
  q8qpay perturbs amountUsdtExact by a few micro-USDT so each invoice has a
  unique (address, amount) pair (common non-custodial gateway pattern). The
  first invoice on a fresh/unused address can use the exact 50.0000; subsequent
  active invoices get +0.00xx. Confirm by running `/tmp/trace_q8qpay.js`
  (direct q8qpay calls, no DB) and checking whether payoutAddress is REUSED
  across the 5 invoices while amounts vary. If addresses differ but amounts
  still vary, it's sandbox/account config instead.

## Balance/Equity + Today's P&L synchronization (2026-08 fix)
- Problem: fresh login showed Equity/Available = $0 (initApp rendered before
  the async `/api/auth/me` sync resolved); Today's P&L came from a localStorage
  accumulator (`arbi_live.pnl`) that could outrun the server (showing profits
  never persisted); APP.mode defaulted to 'demo' even for funded live accounts.
- Fix (frontend-only; no DB/payment/record_trade_safe changes):
  - `initApp()` is now `async` and `await`s `syncWalletFromServer()` BEFORE the
    first meaningful `updateUI()`, so login renders authoritative state (cached
    localStorage is only a fallback if the server request fails).
  - `syncWalletFromServer()` now adopts `meData.todayRealizedPnl` into
    `APP.liveData.pnl` (server-authoritative) and returns `{ ok, funded }`.
  - `persistLiveTrade(profit, asset, key, preBalance, prePnl)`: on success
    adopts `result.newBalance` AND `result.todayRealizedPnl` (REPLACE, not add
    — no double-count); on failure/non-ok/throw it rolls back the optimistic
    balance+pnl to the pre-trade snapshots captured in `executeBotTrade`, so a
    failed `/api/trade` can never leave Today's P&L showing an unpersisted profit.
  - Mode init: after sync, `if (syncResult.funded && APP.mode==='demo')
    setMode('live')` — funded = authoritative confirmed deposit (NOT balance>50,
    NOT stale localStorage). Unfunded stays DEMO. Logout resets `APP.mode`,
    `currentWallet`, `pnl`, `hasTradingActivity` to defaults.
- Server additions (read-only; record_trade_safe untouched):
  - `hasConfirmedDeposit(userId)`: count of `deposits` status='confirmed' > 0.
  - `getTodayRealizedPnl(userId)`: signed sum of `trades.amount` for the current
    UTC day, window `[startOfTodayUtc, startOfNextDayUtc)`. Trades-only by
    construction (never deposits/withdrawals/referrals). Uses `supabaseAdmin`.
  - `/api/auth/me` now also returns `{ hasRealDeposit, todayRealizedPnl }`.
  - `/api/trade` response now also includes `todayRealizedPnl` (re-read after the
    idempotent write) so the client reconciles P&L without an extra round trip.
- State variables: `#totalEquity` & `#balanceValue` = `data.balance` (live =
  server `wallets.live_balance`); `#pnlValue` = `data.pnl` (live = server
  `todayRealizedPnl`). Demo/bonus wallets have no server ledger; their `pnl`
  stays client-side/localStorage (unchanged).
- "Today" is UTC-day. No user timezone is stored; server `trades.created_at` is
  TIMESTAMPTZ. If local-day semantics are later required, store a TZ per user.
- Tests: `tests/trades_pnl.test.js` pins the sum/window/funded/rollback
  contracts. `npm test` = 48/48.

## PWA install-prompt repeat bug (fixed 2026-08, frontend-only in public/index.html)
- All PWA install logic is frontend-only in `public/index.html`:
  - `PWA = { deferredPrompt, isStandalone, isIOS }` declared ~line 6457.
  - `beforeinstallprompt` handler ~6510: if `pwaIsInstalled()` drop event +
    return; else `e.preventDefault()` + stash `PWA.deferredPrompt` +
    `showInstallPrompt()`.
  - `pwaIsInstalled()` ~6467 (NEW): single source of truth. True if
    `PWA.isStandalone` OR `localStorage('pwa_installed')` OR
    `window.navigator.standalone===true`. iOS has no reliable in-tab API, so
    iOS relies on standalone + recorded flag (best-effort, by design).
  - `pwaCheckRelatedApps()` ~6477 (NEW): async best-effort
    `navigator.getInstalledRelatedApps()` (Chromium-only) to detect
    installed-but-in-browser-tab; sets `pwa_installed` flag on hit. Called at
    startup (~6570); on resolve hides any prompt already showing + nulls
    deferredPrompt.
  - `appinstalled` listener ~6521 (NEW): on real install, nulls
    `PWA.deferredPrompt`, sets `localStorage('pwa_installed','true')`, hides
    banner + iOS modal. (Finally makes the previously-dead `pwa_installed`
    check actually work.)
  - `showInstallPrompt()` ~6530: re-checks `pwaIsInstalled()` immediately
    before display; reads `pwa_dismissed`/`ios_install_shown` from
    localStorage (was sessionStorage); each delayed show re-checks
    `pwaIsInstalled()` inside its setTimeout.
  - `dismissPWA()` ~6562: writes `localStorage('pwa_dismissed','true')`
    (was sessionStorage). NOT auto-cleared when beforeinstallprompt fires.
  - Install button handler ~9734: prompts, awaits `userChoice`; on
    `outcome==='accepted'` sets `pwa_installed` as a defensive backup to the
    appinstalled event (which some browsers fire unreliably).
  - Sidebar Install link handler ~9634: gates on `pwaIsInstalled()` (was
    `PWA.isStandalone`) so installed-in-tab users also see "already installed".
  - `initApp()` still runs `setTimeout(showInstallPrompt, 3000)` ~9305 (kept;
    now self-suppresses when installed/dismissed).
- ROOT CAUSE that was fixed:
  1. No `appinstalled` listener existed → successful install never set the
     `pwa_installed` flag (read but never written = dead check). FIXED.
  2. `PWA.isStandalone` only true from home-screen launch, false in a browser
     tab even if installed → installed-in-tab users treated as not-installed.
     FIXED via `pwaIsInstalled()` + `getInstalledRelatedApps()`.
  3. `dismissPWA` used sessionStorage → dismissal cleared on tab close.
     FIXED → localStorage (persists across browser restarts).
- State semantics after fix:
  - not installed & not dismissed → may show prompt (unchanged behavior).
  - dismissed → stays dismissed (localStorage; not auto-cleared on
    beforeinstallprompt).
  - successfully installed → never show again (`appinstalled` + accepted
    `userChoice` both set `pwa_installed`).
  - opened from home screen → never show (`display-mode: standalone` /
    `navigator.standalone`).
- Manifest unchanged: runtime Blob URL (~6452), `display:'standalone'`,
  SVG data-URI icons. Apple meta tags present (lines 7-9).
- Service worker: `./sw.js` registered (~6491) but `public/sw.js` DOES NOT
  EXIST → registration silently fails. NOT touched by this fix (missing SW
  to be investigated separately; it does not cause the repeat prompt).
- Logout (lines ~9560) does NOT touch pwa_* keys (by design: install state is
  device-level, not per-login; should persist across logins).
- Verification: `node --check` on all 5 inline `<script>` blocks = OK.
  `npm test` = 36 pass / 1 fail, where the 1 fail is
  `tests/q8qpay.webhook.test.js` failing with `Cannot find module 'express'`
  (deps not installed in this env) — IDENTICAL on the unmodified baseline,
  so no regression introduced by this frontend-only change.

