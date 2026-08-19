# Arbitrix AI ŌĆö Repository Notes

## Stack
- Node.js + Express 5 (`server.js`, single-file app ~2k lines).
- Supabase (Postgres) for persistence. `supabaseAdmin` (service-role) bypasses RLS.
- Frontend is a single `public/index.html` (vanilla JS).

## Payments architecture
- `services/PaymentService.js` ŌĆö central service; providers implement
  `services/providers/base/ProviderInterface.js` and register via
  `paymentService.registerProvider(name, instance)`.
- Active provider = `process.env.PAYMENT_PROVIDER` (default `nowpayments`).
- Providers: `nowpayments`, `paymento`, `q8qpay` (added; white-label USDT TRC20).
- Atomic crediting is done in Postgres (SECURITY DEFINER funcs), NOT in JS:
  - `paymento_credit_user_safe()` ŌĆö Paymento-specific (untouched).
  - `credit_payment_safe()` ŌĆö shared/provider-agnostic (used by q8qpay).
  Both use the same pattern: idempotency check ŌåÆ `FOR UPDATE` row lock ŌåÆ
  double-check after lock ŌåÆ wallet credit ŌåÆ transaction record ŌåÆ referral bonus.
- Migrations live in `supabase/migrations/` (001ŌĆō008). 008 = q8qpay support.

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
  (HMAC-SHA256 hex of raw body). Verify ŌåÆ re-check via q8qpay API ŌåÆ validate
  asset/amount/address/tx ŌåÆ credit via `credit_payment_safe`.

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
- The 4-stage progress indicator steps are `created ŌåÆ detected ŌåÆ confirming ŌåÆ
  credited` (data-step attrs). `updatePaymentProgress(step)` colors circles,
  labels, and `.step-desc` descriptions for each stage.
- Status text strings are passed to `updateCurrentStatus(message, color)`.
  Display wording may be polished freely, but the underlying status values
  (`confirmed`/`credited`, `confirming`/`pending`, `detected`, `expired`) and
  polling logic MUST stay unchanged.
- Exact amount = `invoice.amountUsdtExact`; payout address =
  `invoice.payoutAddress`. QR encodes `tron:<addr>?amount=<exact>&token=USDT
  &network=TRC20`. Do NOT hard-code amounts ŌĆö keep them dynamic.
- A UI-only polish pass was done (2026-08): headings/labels/status wording
  refined; no payment logic, API, webhook, crediting, or provider code touched.

- Status mapping fix (2026-08): q8qpay only emits `pending | confirmed |
  expired | cancelled` (NO `detected`/`confirming` intermediate). A fresh
  unpaid invoice is `pending`. The frontend polling in
  `startPollingForPayment()` must map `pending` ŌåÆ "Waiting for payment..." +
  progress `created` (only Created active), NOT to `confirming`/"Payment
  detected". `detected`/`confirming` branches are kept only for providers that
  actually report those states. `cancelled` is also handled (q8qpay has it).

- Amount consistency fix (2026-08): the customer-facing amount (display, copy,
  QR, instruction) is derived from the user's entered USD amount
  (`amountUSD.toFixed(2)`), NOT from q8qpay's `amountUsdtExact`. q8qpay may
  return an `amountUsdtExact` that differs from the requested `amountUsdt`
  (e.g. 50.0020 vs 50.00) when the q8qpay merchant account applies a fee. The
  webhook amount verification (server.js, compares `invoice.amount_usd` to
  `verifyResult.amountUsdtExact`) will REJECT crediting if those differ ŌĆö that
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
  deducted from the merchant PREPAID BALANCE on confirmation ŌĆö NOT added to
  the customer amount ŌĆö and network/gas fees are paid by the customer on-chain,
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
  DISAMBIGUATION ŌĆö when multiple active invoices share one payoutAddress,
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
    ŌĆö no double-count); on failure/non-ok/throw it rolls back the optimistic
    balance+pnl to the pre-trade snapshots captured in `executeBotTrade`, so a
    failed `/api/trade` can never leave Today's P&L showing an unpersisted profit.
  - Mode init: after sync, `if (syncResult.funded && APP.mode==='demo')
    setMode('live')` ŌĆö funded = authoritative confirmed deposit (NOT balance>50,
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
  1. No `appinstalled` listener existed ŌåÆ successful install never set the
     `pwa_installed` flag (read but never written = dead check). FIXED.
  2. `PWA.isStandalone` only true from home-screen launch, false in a browser
     tab even if installed ŌåÆ installed-in-tab users treated as not-installed.
     FIXED via `pwaIsInstalled()` + `getInstalledRelatedApps()`.
  3. `dismissPWA` used sessionStorage ŌåÆ dismissal cleared on tab close.
     FIXED ŌåÆ localStorage (persists across browser restarts).
- State semantics after fix:
  - not installed & not dismissed ŌåÆ may show prompt (unchanged behavior).
  - dismissed ŌåÆ stays dismissed (localStorage; not auto-cleared on
    beforeinstallprompt).
  - successfully installed ŌåÆ never show again (`appinstalled` + accepted
    `userChoice` both set `pwa_installed`).
  - opened from home screen ŌåÆ never show (`display-mode: standalone` /
    `navigator.standalone`).
- Manifest unchanged: runtime Blob URL (~6452), `display:'standalone'`,
  SVG data-URI icons. Apple meta tags present (lines 7-9).
- Service worker: `./sw.js` registered (~6491) but `public/sw.js` DOES NOT
  EXIST ŌåÆ registration silently fails. NOT touched by this fix (missing SW
  to be investigated separately; it does not cause the repeat prompt).
- Logout (lines ~9560) does NOT touch pwa_* keys (by design: install state is
  device-level, not per-login; should persist across logins).
- Verification: `node --check` on all 5 inline `<script>` blocks = OK.
  `npm test` = 36 pass / 1 fail, where the 1 fail is
  `tests/q8qpay.webhook.test.js` failing with `Cannot find module 'express'`
  (deps not installed in this env) ŌĆö IDENTICAL on the unmodified baseline,
  so no regression introduced by this frontend-only change.

## Localization Phase 1 (2026-08, frontend-only in public/index.html)
- A hand-rolled i18n system already existed: `TRANSLATIONS` dict (~262 EN keys
  after this phase) at `public/index.html:~6068`, `t(key, vars)` with
  `{{var}}` interpolation + EN fallback, `applyTranslations()`/`setLanguage()`,
  a header globe dropdown + Profile language row (en/es/fr/ar/zh/pt), and
  RTL/font CSS scaffolding for `ar`/`zh`. Non-EN locales are still English
  placeholders (auto-filled from EN) ŌĆö NOT translated in Phase 1.
- Phase 1 added automatic browser-language detection. `detectBrowserLanguage()`
  (~line 6346) inspects `navigator.languages` first, then `navigator.language`,
  matches by lowercased language prefix against
  `['es','pt','fr','ar','zh','en']`, else falls back to `en`. It runs ONLY when
  `localStorage['arbi_lang']` is absent; the detected lang is persisted via the
  existing `arbi_lang` mechanism. An existing `arbi_lang` is NEVER overwritten
  by detection, so the manual selector stays the user's override.
- Fixed 4 EN keys that were referenced by `data-i18n` but missing from the dict:
  `admin.title`, `auth.backToLogin`, `sidebar.admin`, `sidebar.verification`.
- `t()` fallback behavior unchanged: `TRANSLATIONS[currentLang]?.[key] ||
  TRANSLATIONS.en[key] || key`. RTL for `ar` unchanged
  (`document.documentElement.dir = currentLang==='ar'?'rtl':'ltr'`).
- The duplicate early fallback `t()` at `~line 2128` (`window.t = window.t || ŌĆ”`)
  was investigated and LEFT UNTOUCHED. No `t()` call executes before the main
  i18n block loads at load time (the only pre-6068 `t()` reference is inside a
  class method body `SoundManager.toggleMute` at ~line 6038, invoked only at
  runtime after `TRANSLATIONS`/`t()` exist). Removal is very likely safe but
  not provably risk-free across all inline event handlers, so per the smallest-
  change rule it was not removed.
- No DB/server/auth/wallet/trading/referral/payment/2FA/PWA/migration changes.
  `npm test` = 36 pass / 1 fail (same pre-existing `q8qpay.webhook.test.js`
  `Cannot find module 'express'` env failure; no regression).

## Localization Phase 2A (2026-08, frontend-only in public/index.html)
- Replaced the placeholder line `es: {}, fr: {}, ar: {}, zh: {}, pt: {}` with
  FULL dictionaries for all 5 locales (es, pt, fr, ar, zh) - 262 keys each,
  covering the core user-facing UI: auth/login/signup, sidebar/nav, dashboard
  stats (Total Equity, Available, Today's P&L), Live/Demo modes, bot/trading
  controls, trade results, deposits, withdrawals, transactions, referral,
  profile/account settings, 2FA, PWA/install, notifications, badges/milestones.
- The EN dictionary was NOT changed (verified byte-identical, 0 changed keys).
  EN remains the fallback; the Phase 1 `detectBrowserLanguage()` +
  `arbi_lang` guard, the `['es',...]` copy-loop (fills any future-missing key
  with EN), the `t()` fallback (`TRANSLATIONS[currentLang]?.[key] ||
  TRANSLATIONS.en[key] || key`), and Arabic RTL
  (`dir = currentLang==='ar'?'rtl':'ltr'`) are all unchanged.
- All `{{var}}` placeholders (`{{amount}}`, `{{min}}`, `{{needed}}`,
  `{{network}}`, `{{current}}`, `{{balance}}`) preserved per-key per-locale
  (12 placeholder-bearing keys ├Ś 5 locales verified). HTML `<strong>` tags in
  `ios.step1`ŌĆō`ios.step4` preserved; `ios.step1` mirrors EN's pre-existing
  `<strong>ŌĆ”</button>` typo on purpose (do NOT "fix" it inconsistently across
  locales ŌĆö that would change rendering parity; it is an EN-side bug to fix
  separately if ever).
- Untranslated terms kept as-is by design: MTA, USDT, TRC20, "Google
  Authenticator", "Arbitrix AI", "DEMO"/"LIVE" badges, "P&L" label, $ amounts.
- Backend error strings, email templates, privacy/terms/legal pages, and
  reset-password.html NOT translated in this phase (frontend UI only).
- NOT translated/dynamic-yet (still hardcoded English, future phase): ~101
  `showToast()` literals, 6 `updateCurrentStatus()` deposit-status strings
  (display wording only ŌĆö underlying `pending`/`confirmed`/`expired`/
  `cancelled` status VALUES + polling/crediting logic untouched), ~7 support
  bot reply templates, and backend `data.error` passthroughs in auth.
- Verification: `node --check` on all 4 inline `<script>` blocks = OK;
  standalone functional check (real extracted TRANSLATIONS + t()) confirms
  5 locales parse, resolve, interpolate, RTL for `ar`, EN fallback for
  unknown keys, placeholder parity. `npm test` = 36 pass / 1 fail (same
  pre-existing `q8qpay.webhook.test.js` `Cannot find module 'express'` env
  failure; no regression).

## Localization Phase 2A-Landing (2026-08, frontend-only in public/index.html)
- Wires the static landing + auth HTML to the existing i18n system using
  `data-i18n` / `data-i18n-placeholder` attributes. No JS logic, no backend,
  no DB, no PWA/auth/wallet/trading/referral/payment changes.
- Dictionary grew to 433 keys/locale (171 new landing/auth keys added per
  locale over the 262 Phase-2A base). EN dictionary values are byte-identical
  to the prior 262-key baseline (verified: 0 changed old keys); only new keys
  were added. The 6 stale `landing.*` keys from earlier were replaced/repurposed.
- HTML wired sections (all under `data-i18n`): landing nav (features/how-it-
  works/security/faq + Launch App, incl. mobile-menu duplicates), hero (badge,
  title `<br><span>`, subtitle, 2 CTA buttons, 3 trust badges), stats (4 labels;
  numeric values $2.5B+/150K+/99.9%/50+ left as static text), trust (4 items
  title+desc), 6 feature cards (title+desc+3 list items each), how-it-works
  (header + 4 steps title+desc), testimonials (header + 3 cards text/name/role),
  FAQ (header + 6 Q&A pairs), final CTA (title/subtitle/button/note), footer
  (tagline + 3 column headings + link rows + copyright + disclaimer). Auth
  brand panel (title/subtitle/3 features/3 stat labels), auth tabs, login form
  (header/labels/placeholders/remember-me/forgot link/submit/switch),
  2FA section (title/hint/codeLabel/codeExpiry `{{time}}`/submit/resendPrefix/
  resend/back), signup form (header/labels/placeholders/passwordStrength/
  referralLabel+referralOptional/submit/terms HTML/switch), security badge,
  forgot-password modal (title/description/emailLabel/emailPlaceholder/submit/
  success.title/body/hint/gotIt/backToSignIn), wallet-sync loader (loading/
  slowTitle/slowBody/refresh).
- Key reuse: reused pre-existing Phase-2A dict keys where a value already
  existed rather than creating duplicates ŌĆö e.g. `auth.brand.security.title`,
  `auth.brand.execution.title`, `auth.brand.analytics.title`,
  `auth.brand.volumeTraded/activeUsers/uptime`, `auth.2fa.resendPrefix`,
  `forgot.success.title/body/hint`, `auth.login.emailLabel/passwordLabel`
  (shared by login + signup forms). 283 distinct data-i18n keys referenced by
  HTML, all present in all 6 locales (0 missing/empty).
- Preserved EXACTLY across all locales (validated token parity per locale
  vs EN for each token): financial/marketing figures `$2.5B+`, `150K+`, `$10`,
  `$50`, `23%`, `99.9%`, `50+`, `150,000+`, `15-30`, `24/7`; technical/proper
  terms `256-bit`, `SSL`, `TRC20`, `USDT`, `DeFi`, `PWA`, `stop-loss`,
  `Arbitrix AI`, `KYC`, `LIVE`, `Bonus/Live Wallet`. NOTE: localized forms
  were normalized to use the literal EN token (e.g. FR "Chiffrement 256-bit"
  not "256 bits", FR "24/7" not "24h/24 et 7j/7", AR "$10"/"$50" not
  "10 ž»┘ł┘äž¦ž▒ž¦ž¬"/"50 ž»┘ł┘äž¦ž▒┘ŗž¦", ES/PT/FR/AR/ZH "stop-loss" lowercase, ZH
  "256-bit SSL" not "256 õĮŹ SSL") so the exact token survives translation.
- HTML-markup keys preserved markup across all locales: `landing.hero.title`
  (`<br><span class="landing-gradient-text">ŌĆ”</span>`), `auth.signup.terms`
  and the Phase-1 `ios.step1-4` (`<a>`, `<strong>`), all with 0 tag-parity
  issues. Placeholder parity (`{{time}}` in `auth.2fa.codeExpiry`,
  `{{amount}}/{{min}}/{{needed}}/{{network}}/{{current}}/{{balance}}`) = 0 issues.
- Verification: `node --check`-equivalent parse on all 5 inline `<script>`
  blocks = OK. Standalone extracted-TRANSLATIONS render check across all 6
  locales: 433 keys/locale, identical key sets, 0 empty, 0 placeholder issues,
  0 HTML-tag issues, 0 token-parity issues, EN dictionary unchanged (all 262
  prior values preserved). `npm test` = 36 pass / 1 fail (the single fail is
  the pre-existing `tests/q8qpay.webhook.test.js` `Cannot find module
  'express'` env failure ŌĆö identical on the unmodified baseline; no regression).
- DELIBERATELY LEFT FOR PHASE 2B (not translated, still hardcoded English):
  ~101 `showToast()` literals, 6 `updateCurrentStatus()` deposit-status
  display strings (underlying `pending`/`confirmed`/`expired`/`cancelled`
  status VALUES + polling/crediting logic untouched), ~7 support-bot reply
  templates, and backend `data.error` passthroughs in auth handlers. Dynamic
  JS-set text (e.g. `landingUserName` greeting, OTP input, password-strength
  label value, countdown timer text) is runtime/data-driven and out of scope
  for this static-HTML phase.

## Localization Phase 2B-1 ŌĆö Dynamic Frontend Localization (2026-08, public/index.html only)
- Converted hardcoded DYNAMIC display strings to `t()` calls across all inline
  JS. Frontend-only: NO changes to server.js, DB/schema/migrations, auth, 2FA,
  wallet calc/persistence, trading calc/execution, referral qualification/bonus,
  payment/deposit/withdraw logic, API request/response structures, or status
  VALUES (pending/confirmed/expired/cancelled/approved/pending_review/rejected/
  resubmission_required).
- Dictionaries: 613 -> 652 keys/locale (219 new vs the 433 Phase-2A base). EN
  values for pre-existing keys unchanged; only NEW keys added. All 6 locales
  have identical key sets, 0 empty, 0 {{placeholder}} parity, 0 HTML-tag/attr
  parity issues.
- DUPLICATE-KEY FIX: a prior session's batch + this session's batch both
  inserted the same keys, creating 82 duplicate keys/locale. Removed 492 dup
  lines (82/locale x 6), keeping FIRST occurrence. The re.findall-based verifier
  silently overwrites dups in its parsed dict (masks them); detect with a
  Counter on raw keys. ALWAYS re-check for dups after scripted insertions.
- Tier 1 done: all 127 showToast() bare-string literals converted (0 remain);
  all 5 native confirm() use t() (referral.resetConfirm, deposit.cancelConfirm,
  demo.confirmRemove, logout.confirm, admin.confirmPayment); updateCurrentStatus()
  display strings (prior session); KYC validation/status labels (kyc.*:
  legalName/dob/country/address, personalSaved, fileTooLarge, invalidFileType,
  docUploaded/docRemoved, missingDocs/{{missing}}, missingIdentity/missingSelfie,
  submitted, status.* verified/pendingReview/rejected/resubmission/notStarted/
  required/new, level.*, summary.*, noData/noDocuments/noHistory); admin
  action-result toasts + empty states (admin.kyc.approve/reject/resubmission +
  loadDetailsFailed, admin.withdraw.approve/reject + errors, admin.payment.
  confirm*, admin.confirmPayment, admin.empty.noVerifications/loadActivityFailed/
  loadHealthFailed/noActivity, admin.health.lastChecked/serverUptime,
  admin.loginRequired, admin.export.*, admin.doc.*, admin.invoice.*,
  admin.webhook.retry*, admin.searchFailed); support-chat replies (support.reply.
  *: default/bot/deposit/withdraw/bonus/sound/language/hello ŌĆö keyword MATCHING
  left in English intentionally); ticker template prose (ticker.earned/deposited/
  referred/arbitrage/newTrader/badgeUnlocked as COMPLETE SENTENCES preserving
  `<span class="ticker-user">`/`<span class="ticker-amount green|gold">` markup
  + {{user}}/{{amount}}/{{asset}}/{{spread}}/{{country}}/{{badge}} placeholders).
- Tier 2 done: interpolated toasts (referral.simulatedToast/Desc {{amount}},
  support.reply.bot {{mta}}, milestone.winsSuffix {{n}}, referral.configError
  {{error}}, kyc.missingDocs {{missing}}, admin.health.lastChecked {{time}},
  uptime.hoursMinutes {{hours}}/{{minutes}}, uptime.minutes {{minutes}}); 2FA
  (2fa.loadStatusFailed, generateQRFirst, nowEnabled, newCodesGenerated;
  attempts/cooldown reuse existing 2fa.attemptsRemaining/resendIn/waitSeconds);
  deposit/payment dynamic (deposit.confirmedSuccess/confirmFailed/confirmError,
  withdraw.failed); bonus/referral dynamic (bonus.withdrawnTitle,
  bonus.withdrawHistory {{amount}}, referral.simulated*/resetConfirm/resetDone/
  welcomeReferred/codeLoading/configSaved/configError); notification
  descriptions (all Notifications.add calls use t() for title+desc; milestone
  profit/streak); formatTime/getTimeAgo (common.justNow/minutesAgo/hoursAgo/
  daysAgo, already present).
- Tier 3 done: TRANSACTION/HISTORY RENDER-ONLY mapping. Added TX_TYPE_LABELS +
  TX_DETAIL_LABELS maps and txTypeLabel(rawType)/txDetailLabel(rawDetail)
  helpers near `// ============ TRANSACTION LOG ============` (~line 10554).
  Applied at the SINGLE render site in updateTransactionLog() (.tx-type/
  .tx-detail divs). Rules:
    * TRANSLATE AT RENDER TIME ONLY. Stored type/detail values NEVER modified ŌĆö
      every history.unshift({type:'...',detail:'...'}) still writes the original
      English raw values (Deposit/Withdraw/Trade Executed/Bot/Reset/Bonus
      Withdrawal/Referral Bonus/Withdrawal to Live + Demo Funds/All funds
      removed/From Bonus Wallet/Bonus withdrawn to Live Wallet/Started/Paused).
    * All comparison/dedup/filter logic UNCHANGED: h.type === 'Deposit' (3
      sites: deposit-credited dedup ~12409, depositTxs filter ~13378,
      bonus-withdraw dedup ~13401) still compare RAW values, NOT translated.
    * Unknown type/detail -> falls back to original English VERBATIM (dynamic/
      compound details like asset.symbol+' '+asset.detail, 'To '+address.
      slice(0,6)+'...', '+$10 bonus earned (simulated)' display unchanged).
      Empty/undefined -> ''.
  Admin KYC review modal renderKYCDetails() history list (server-supplied
  h.previousStatus/h.newStatus/d.type) left as raw server values (backend data
  passthrough ŌĆö deferred); only its static empty-state labels (kyc.noDocuments/
  noHistory) + loadDetailsFailed toast translated.
- Reuse-first: reused existing keys wherever a value already existed
  (2fa.loadStatusFailed/generateQRFirst/nowEnabled/newCodesGenerated,
  common.justNow/minutesAgo/hoursAgo/daysAgo/you, deposit.cancelConfirm,
  referral.simulatedTitle/Desc, bonus.withdrawnTitle/withdrawHistory,
  milestone.*, withdraw.submitted/processing, notifications.welcome*,
  badge.unlocked/allUnlocked, demo.confirmRemove, logout.confirm). Only
  genuinely-new keys added.
- HTML-bearing messages: <strong>/<br>/<span> markup preserved across all
  locales (referral.simulatedToast keeps <strong>...</strong><br><span>;
  ticker.* keep <span class="ticker-user|ticker-amount green|gold">). 0
  tag-parity + 0 class-attr-parity issues.
- Arabic RTL ticker intact: html[dir="rtl"] .ticker-amount{unicode-bidi:isolate;
  direction:ltr;} (line 150), .ticker-user/.ticker-amount classes (1137-1140),
  dir = currentLang==='ar'?'rtl':'ltr' (10044). Ticker keys are complete
  sentences (not word-by-word), preserving bidi isolation.
- Console/debug messages (192 console.* calls) and backend data.error/
  error.message passthroughs (e.g. showToast(data.error || t('...'))) UNTOUCHED
  ŌĆö deferred to the later backend-error localization phase.
- Verification: node --check on all 5 inline <script> blocks = OK. verify_i18n.py
  = 652 keys/locale x 6, 219 new vs 433 base, 0 problems. Full parity check =
  identical key sets, 0 empty, 0 placeholder-parity, 0 HTML/attr-parity.
  Isolated sandbox test (temp, removed) for TX_TYPE_LABELS mapping +
  {{placeholder}} interpolation = ALL PASS (known type->localized label per
  locale, unknown->verbatim fallback, empty->'', placeholder interpolation, EN
  fallback for unknown locale, ticker markup preserved). Stored transaction
  type/detail values verified UNCHANGED at every history.unshift site;
  === 'Deposit' comparison logic verified UNCHANGED. npm test = 36 pass / 1
  fail (the single fail is the pre-existing tests/q8qpay.webhook.test.js
  `Cannot find module 'express'` env failure ŌĆö identical to baseline; no
  regression).
- DEFERRED to Phase 2B-2 (NOT done here): remaining ~handful of admin-view
  hardcoded strings (badge lock tooltips, KYC list row labels built from server
  data, admin activity-timeline activity.title/activity.description ~13470-13488
  which come from the server data.activities ŌĆö backend passthroughs), and the
  full backend-error localization pass (server.js data.error strings, email
  templates, privacy/terms/legal pages, reset-password.html).
- NOT committed/pushed/deployed (checkpoint pending user confirmation, as with
  the landing-page work).

## Localization Phase 2B-2A ŌĆö Frontend Error Mapping + Reset-Password i18n (2026-08, public/index.html + public/reset-password.html only)
- LOWEST-RISK slice from the completed read-only Phase 2B-2 backend audit.
  Frontend-only; server.js, DB/schema/migrations, auth/2FA, wallet, trading,
  referral, payment, withdraw, PWA, API behavior, and stored status values
  UNTOUCHED. No backend error strings were modified ŌĆö only how the frontend
  DISPLAYS them.
- `translateBackendMessage(message, fallbackKey)` helper (index.html, after
  `t()` ~line 10378): exact-match map (`BACKEND_MESSAGE_MAP`) of known
  user-facing English backend error sentences ŌåÆ translation keys. Unknown /
  dynamic / provider-specific messages are returned VERBATIM (English) so
  nothing machine-consumed is ever altered. Empty/falsy message ŌåÆ
  `t(fallbackKey)`. A small `BACKEND_DYNAMIC_MESSAGE_RULES` set handles
  parameterized sentences (e.g. `Already <status>` ŌåÆ `admin.alreadyStatus`
  with `{{status}}`).
- Wired into ~20 frontend error-display sites (auth login, 2FA
  resend/verify/setup/enable/regenerate/disable throws, deposit generate-
  address throw, withdraw toast, KYC save/upload/remove/submit toasts, admin
  KYC approve/reject/resubmission toasts, admin payment confirm, admin webhook
  retry, admin config update throw). Pattern at each site:
  `throw new Error(translateBackendMessage(data.error, '<fallbackKey>'))` or
  `showToast(translateBackendMessage(data.error, '<fallbackKey>'), ...)`.
- Dictionaries: 652 ŌåÆ 705 keys/locale (53 NEW keys; EN values for the 652
  pre-existing keys byte-identical ŌĆö 0 changed). All 6 locales (en, es, pt, fr,
  ar, zh) have identical key sets, 0 empty, 0 duplicate keys (re-checked after
  scripted insertion per the Phase-2B-1 lesson), 0 `{{placeholder}}` parity
  issues (`{{status}}` in `admin.alreadyStatus`). New key groups:
  `auth.errors.emailExists/validEmailRequired`, `reset.*` (fieldsRequired/
  emailTokenRequired/invalidOrExpired/expired/invalid/updateFailed/errorOccurred),
  `2fa.*` (alreadyEnabled/notEnabled/notSetup/notConfigured/verifyFirst/
  alreadyVerified/invalidCodeFormat/emailNotFound/tooManyAttempts/noRecoveryCodes/
  codeAlreadyUsed/pleaseWait/invalidSession/missingPartialToken/codeRequired/
  invalidOrExpiredCode/setupFailed/verifyFailed/enableFailed/regenerateFailed/
  disableFailed), `deposit.*` (min10/invoiceNotFound/createInvoiceFailed/notFound),
  `withdraw.*` (min700/validAddressRequired/identityRequired/notFound),
  `trade.*` (mtaNotReached/invalidAmount/exceedsBalance), `kyc.*`
  (legalNameRequired/dobRequired/countryRequired/addressRequired/minAge/
  invalidDocumentType/invalidFileEncoding/missingUploadFields/
  rejectionReasonRequired/resubmissionReasonRequired), `admin.config.updateFailed`,
  `admin.alreadyStatus` ({{status}}).
- CRITICAL safety property: strings the frontend/tests/server compare on or that
  are persisted/machine-consumed were NOT added to BACKEND_MESSAGE_MAP. Verified
  NOT mapped (pass through verbatim): q8qpay webhook internals
  (`Already processed`, `Verification mismatch`, `Duplicate payment (not re-
  credited)`, `Missing signature`, `Invalid signature`, etc. ŌĆö these are
  q8qpay.webhook.test.js-asserted AND res.json status values), provider API
  passthroughs, and any `data.error` from un-audited endpoints. The map only
  contains display-only user-facing sentences confirmed to have NO exact-string
  consumer in the repo (grep-verified: no `error ===`, no `data.error.includes`,
  no status-value usage for any mapped sentence).
- `public/reset-password.html`: added a SELF-CONTAINED i18n system (does NOT
  import from index.html ŌĆö it's a separate page loaded outside the app shell).
  Mirrors the main app: `TRANSLATIONS` (44 keys ├Ś 6 locales), `t(key)`,
  `translateBackendMessage(msg, fallbackKey)` with its own `BACKEND_MESSAGE_MAP`
  (reset/auth subset: `Email and token are required`, `Invalid reset token`,
  `This reset link has expired`, `An error occurred`, `Email, token, and new
  password are required`, `Password must be at least 6 characters`, the reset-
  password endpoint sentences), `detectBrowserLanguage()` (navigator.languages
  ŌåÆ language ŌåÆ prefix match against `['es','pt','fr','ar','zh','en']`, else en),
  `applyTranslations()` (data-i18n ŌåÆ innerHTML, data-i18n-placeholder ŌåÆ
  placeholder, sets `document.documentElement.lang`/`dir`, `document.title`),
  RTL for `ar` (`dir='rtl'` + Arabic font stack). Reuses the shared
  `localStorage['arbi_lang']` key so a user's language choice carries over
  from the main app; detection runs only when `arbi_lang` is absent (never
  overwrites a manual override). All static HTML wired with `data-i18n` /
  `data-i18n-placeholder`; all dynamic JS strings (strength labels, validation
  messages, verify/reset error text, invalid-state message) routed through
  `t()` / `translateBackendMessage()`. Backend `data.error` from
  /api/auth/verify-reset-token and /api/auth/reset-password is mapped, not
  shown raw.
- Architecture note (from Phase 2B-2 audit, NOT implemented): the preferred
  long-term fix is stable machine-readable `errorCode` codes in server
  responses with frontend translation, instead of exact-matching English
  sentences. `translateBackendMessage` is the safe bridge: it localizes known
  display sentences today without touching server.js, and can be retired
  piece-by-piece as endpoints gain `errorCode`. Do NOT add `errorCode` in this
  phase.
- Verification: `node --check`-equivalent (vm.Script) on all 5 index.html
  inline `<script>` blocks + 1 reset-password block = OK.
  index.html: 705 keys/locale ├Ś 6, 53 new vs 652 base, 0 problems, 0 dups, EN
  baseline 652 values unchanged. reset-password.html: 44 keys/locale ├Ś 6, 0
  problems, 0 dups. Isolated functional tests (`/tmp/test_i18n.js`,
  `/tmp/test_reset_i18n.js`, temp, removed): known errors translate per locale;
  unknown/webhook/provider strings pass through verbatim; emptyŌåÆfallback;
  dynamic `Already <status>` rule; EN fallback for unsupported locale; static
  `t()` keys resolve across all locales; unknown key returns the key. ALL PASS.
  `npm test` = 36 pass / 1 fail (the single fail is the pre-existing
  tests/q8qpay.webhook.test.js `Cannot find module 'express'` env failure ŌĆö
  identical to baseline; no regression).
- NOT committed/pushed/deployed (checkpoint pending user confirmation, as with
  prior phases).



## Localization Phase 3B ŌĆö Activity/Alerts/Audit Render-Time Localization (2026-08, public/index.html only)
- Frontend-only render-time localization of backend-generated activity/alert/audit
  text in `public/index.html`. NO changes to server.js, DB/schema/migrations,
  auth/2FA, wallet, trading, referral, payment/withdraw, webhook behavior, API
  response shapes, or stored transaction/status values.
- Follows the proven Phase-2B-1 `TX_TYPE_LABELS`/`txTypeLabel` render-only
  pattern: a stable structured identifier (enum/code/raw-value) -> i18n key map,
  translated ONLY at render time. The raw backend value is NEVER modified and
  NEVER used differently for filtering, comparisons, deduplication, or
  authorization. Unknown identifiers fall back to the original backend string
  VERBATIM (no guessing/parsing).
- New mapping helpers added right after `txDetailLabel()` (~line 11253):
  - `ACTIVITY_TITLE_LABELS` + `activityTitleLabel(activity)`: maps the backend
    English `activity.title` text (New User Registered / Deposit Confirmed /
    Withdrawal Approved / KYC Submitted / KYC Approved / KYC Rejected / Referral
    Reward) -> `activity.title.*` keys. Exact-match map; unknown title -> raw.
  - `ALERT_TITLE_LABELS`/`ALERT_MESSAGE_LABELS` + `alertTitleLabel(alert)`/
    `alertMessageLabel(alert)`: map the stable `alert.id` enum
    (failed_payments/large_withdrawals/kyc_backlog/suspicious_referrals/
    webhook_failures) -> `alert.title.*`/`alert.message.*` keys. `message` is
    templated with the structured `alert.count` field via {{count}} (fully
    localizable). Unknown id -> raw `alert.title`/`alert.message`.
  - `alertCountSuffixLabel(alert)`: "errors"/"items" badge suffix keyed off
    `alert.severity` (`alert.count.errors`/`alert.count.items`).
  - `AUDIT_ACTION_LABELS` + `auditActionLabel(rawAction)`: maps `log.action`
    codes (login/logout/deposit/withdrawal/kyc_approved/kyc_rejected/
    config_change/2fa_enabled/2fa_disabled/email_failed/job_failed) ->
    `audit.action.*` keys. DISPLAY-ONLY: `log.action` is ALSO the server-side
    filter value (the `auditActionFilter` dropdown sends its RAW `value` attr as
    `?action=`), so the dropdown `<option value>` attributes stay raw English
    codes and only the visible label is localized via `data-i18n`. Unknown code
    -> raw code verbatim.
  - `DEPOSIT_STATUS_LABELS`/`WITHDRAWAL_STATUS_LABELS` + `depositStatusLabel()`/
    `withdrawalStatusLabel()`: map raw stored status values
    (confirmed/pending/expired/cancelled and approved/pending/rejected) ->
    `admin.status.*`/`status.pending`. Reuses existing `status.pending`. All
    comparisons (`d.status === 'confirmed'`, `w.status === 'pending'`, etc.) stay
    on the RAW value; only the rendered badge text is localized. Unknown -> raw.
  - `KYC_STATUS_LABELS` + `kycStatusLabel(rawStatus)`: maps
    verification_profiles.status + verification_history previous/new status
    (not_started/pending_review/approved/rejected/resubmission_required) ->
    existing `kyc.status.*` keys (REUSE, no new keys). `null`/falsy ->
    `kyc.status.new` (matches the prior `(h.previousStatus || 'new')` fallback).
    Unknown -> raw verbatim. DISPLAY-ONLY; status comparisons unaffected.
- Render sites wired (render-only; raw backend fields unchanged):
  - `loadActivityPreview()` (~14248): empty state -> `admin.empty.noRecentActivity`;
    error -> `admin.empty.loadActivityFailed`; title -> `activityTitleLabel(activity)`.
    `activity.description` LEFT RAW VERBATIM (see DELIBERATELY DEFERRED below).
  - `loadActivityTimeline()` (~14305): title -> `activityTitleLabel(activity)`;
    empty/error already used `t()`. description left raw.
  - `loadAlerts()` (~14416): summary labels Critical/Warnings/Info -> reuse
    `admin.status.critical/warnings/info`; empty -> reuse `admin.empty.noAlerts`;
    title -> `alertTitleLabel(alert)`; message -> `alertMessageLabel(alert)`;
    count badge suffix -> `alertCountSuffixLabel(alert)`.
  - `loadAuditLogs()` (~14495): empty -> `admin.empty.noAuditLogs`; error ->
    `admin.empty.loadAuditLogsFailed`; table headers -> `audit.col.*`;
    `log.action` -> `auditActionLabel(log.action)`; `performedByName` fallback
    'System' -> `audit.performedBySystem`; footer "Showing X of Y" ->
    `audit.showing` with {{shown}}/{{total}}. `log.details` LEFT RAW VERBATIM
    (free-form DB text, no stable identifier).
  - `renderAdminDeposits()`/`renderAdminWithdrawals()` (~15562/15588): status
    badge -> `depositStatusLabel(d.status)`/`withdrawalStatusLabel(w.status)`;
    buttons Confirm/Approve/Reject -> `admin.confirm`/`admin.approve`/
    `admin.reject` (latter two REUSE existing); "N/A" -> `common.na`; empty
    states -> `admin.empty.noDeposits`/`admin.empty.noWithdrawals`. Status
    comparisons UNCHANGED (raw).
  - `renderKYCDetails()` history (~15019): `(h.previousStatus || 'new') + ' -> '
    + h.newStatus` -> `kycStatusLabel(h.previousStatus) + ' -> ' +
    kycStatusLabel(h.newStatus)`. The arrow and `h.rejectionReason` (raw
    user-entered text) left as-is.
  - Dropdowns: `activityFilter` and `auditActionFilter` `<option>` labels
    localized via `data-i18n` (`activity.filter.*`, `audit.action.*`); `value`
    attributes kept RAW (sent to server as `?type=`/`?action=`). Audit date
    inputs placeholders -> `audit.date.start`/`audit.date.end`.
- Dictionaries: 705 -> 763 keys/locale (58 NEW keys; EN values for the 705
  pre-existing keys byte-identical - 0 changed). All 6 locales (en, es, pt, fr,
  ar, zh) identical key sets, 0 empty, 0 duplicate keys (re-checked after
  scripted insertion per the Phase-2B-1 lesson), 0 `{{placeholder}}` parity
  issues (`{{count}}` in 5 alert.message.* keys, `{{shown}}`/`{{total}}` in
  audit.showing - all 6 locales match EN's placeholder set).
- DELIBERATELY DEFERRED (left raw English, NOT translated - needs a future
  backend/API phase, do NOT guess/parse in frontend):
  - `activity.description`: backend bakes the USERNAME into the templated
    description string (e.g. "$50.00 deposited by John",
    "Identity verification pending_review for Jane") but the activity API
    response does NOT expose the username as a structured field (only `userId`,
    `amount`, `type`, `icon`, `color`). Faithfully interpolating the username is
    impossible without parsing free-form English (forbidden). Kept raw verbatim.
    Future fix: backend should expose `userName`/`userEmail` as a structured
    field on each activity item so the description template can be localized
    with {{name}}/{{amount}}. Until then titles are localized; descriptions stay
    authoritative English.
  - `log.details` (audit_logs.details): free-form English persisted in DB, no
    stable identifier. Kept raw verbatim.
  - `h.rejectionReason` (verification_history): user/admin-entered free text.
    Kept raw verbatim (cannot be machine-translated).
  - Executive dashboard dynamic suffixes ("today"/"this week"/"pending"/
    "verified"/"%") in `loadExecutiveDashboard()` and the static stat-card
    labels in HTML (~4780-4820): these are static-HTML / dynamic-label work,
    NOT backend-generated activity text. Out of Phase 3B scope; belong to a
    future static-HTML i18n pass.
- Verification: `node --check`-equivalent (vm.Script) on all 8 inline `<script>`
  blocks = OK. Dict parity = 763 keys/locale x 6, 58 new vs 705 base, 0 problems,
  0 dups, 0 missing data-i18n refs (299 refs all defined). Isolated functional
  test (temp, removed) of all 8 mapping helpers across en/es/pt/fr/ar/zh = 32/32
  PASS (known id -> localized per locale; unknown -> raw verbatim; empty ->
    fallback; {{count}}/{{shown}}/{{total}} interpolation; EN fallback for
    unsupported locale; raw status comparisons preserved). `npm test` = 36 pass /
  1 fail (the single fail is the pre-existing `tests/q8qpay.webhook.test.js`
  `Cannot find module 'express'` env failure - identical to baseline; no
  regression).
- NOT committed/pushed/deployed (checkpoint pending user confirmation, as with
  prior phases).

## Localization Phase 3E ŌĆö Admin Static + Dynamic Localization (2026-08, public/index.html only)
- Frontend-only admin UI localization (the implementation slice following the
  Phase 3D read-only audit). NO changes to server.js, DB/schema/migrations,
  auth/2FA, wallet, trading, referral qualification/bonus, payment/deposit/
  withdraw logic, webhook behavior, API request/response shapes, or stored
  status/action/enum values. No commit/push/deploy.
- Dictionaries: 847 -> 972 keys/locale (125 NEW keys; EN values for the 847
  pre-existing keys byte-identical - 0 changed). All 6 locales (en, es, pt, fr,
  ar, zh) have identical key sets, 0 empty, 0 duplicate keys (re-checked after
  scripted insertion per the Phase-2B-1 lesson), 0 `{{placeholder}}` parity
  issues, 0 HTML-tag/attr parity issues. 477 data-i18n refs, all defined.
- New key groups (125): `admin.tab.*` (operations/users/deposits/withdrawals/
  referral/kyc), `admin.stat.*` (totalUsers/totalDeposits/totalWithdrawals/
  activeBots), `admin.ops.*` (overview/activity/health/alerts/audit/reports),
  `admin.refresh/viewActivity/checkHealth/recentActivity/viewAll/activityTimeline/
  systemHealth/auditLogsTitle`, `admin.today/thisWeek/usersThisWeek/pendingCount/
  verifiedCount/successCount/failedCount/percentSuffix`, `admin.health.status.*`
  (healthy/degraded/unhealthy/unknown), `admin.health.failed1h/buckets/
  lastChecked`, `admin.referral.cfg.*` (rewardsEnabled/rewardAmount/minDeposit/
  requireFirstDeposit/maxRewards + matching `*Desc`), `admin.referral.configTab/
  auditHistoryTab/configHelp/auditHelp/lastUpdated/none/enabled/disabled/showing/
  col.*` (dateTime/administrator/setting/oldValue/newValue/ipAddress),
  `admin.export.reportsTitle`, `admin.report.*` (users/deposits/withdrawals/
  referrals/kyc/audit + `*Desc`), `admin.downloadCsv`, `admin.field.*`
  (all/name/email/referralCode/userId), `admin.search/reset/sort/sort.newest/
  sort.oldest`, `admin.col.*` (demoBalance/liveBalance/bonus/actions/id/amount/
  network/status/date/action/address/user/country/docs/submitted), `admin.empty.*`
  (noConfigChanges/loadConfigFailed/loadReferralAuditFailed/noUsers), `admin.status.*`
  (pending/approved/rejected/resubmission - reuses where possible),
  `admin.kyc.*` (allStatus/searchPlaceholder/reviewTitle/personalInfo/dob/review/
  docSize/reason/reasonPlaceholder/requestResubmission), `admin.approve/reject/
  unknownUser/view`. Many reused existing keys (admin.confirm/approve/reject,
  common.na/loading, status.pending, admin.empty.* from 3B, audit.* from 3B).
- Render-only pattern reused from Phase 3B/2B-1: stable raw enum/value -> i18n key
  map, translated ONLY at render time. Raw stored values NEVER modified and NEVER
  used differently for filtering/comparisons/dedup/authorization. Unknown enum ->
  raw verbatim fallback.
- New mapping helpers + status maps (raw enum keys -> i18n keys, comparisons
  remain RAW):
  - `healthStatusLabel(status)`: maps health status (healthy/degraded/unhealthy/
    unknown) -> `admin.health.status.*`. Empty -> ''. Unknown -> raw.
  - `DEPOSIT_STATUS_LABELS`/`WITHDRAWAL_STATUS_LABELS`/`KYC_STATUS_LABELS` +
    `depositStatusLabel()`/`withdrawalStatusLabel()`/`kycStatusLabel()`: map raw
    stored status values (confirmed/pending/expired/cancelled and
    approved/pending/rejected and not_started/pending_review/approved/rejected/
    resubmission_required) -> existing `admin.status.*`/`status.pending`/
    `kyc.status.*` keys (REUSE). All `=== 'confirmed'`/`=== 'pending'` etc.
    comparisons stay on the RAW value; only the rendered badge text localized.
  - `REFERRAL_CONFIG_LABELS` shared map + `referralConfigLabel()`/
    `referralConfigDesc()`: map raw config keys (rewards_enabled/
    referral_reward_amount/minimum_qualifying_deposit/first_deposit_required/
    max_rewards_per_user) -> `admin.referral.cfg.*`. Unknown key -> raw verbatim.
    `renderReferralConfig` and `formatConfigKey` consolidated to use this shared
    map (removes per-call duplication). `formatConfigValue` localizes
    Enabled/Disabled/none via `admin.referral.enabled/disabled/none`.
- Dynamic JS strings wired to `t()` across ~10 admin functions: `loadSystemHealth`
  (status labels, last-checked, buckets), `loadReferralConfig` (error + last-updated
  + none), `loadReferralAuditHistory` (loading/showing/error/ip-display), `renderAdminUsers`
  (empty/noKYC/N/A + `escapeHtml` on user-provided fields), `renderKYCVerifications`
  (status badges/Review/View/Unknown), `renderKYCDetails` (doc size KB/View button),
  `renderReferralConfig` (labels/descs/values), reports section headers + download,
  users/deposits/withdrawals/KYC table headers + search/filter controls.
- Admin dropdown `<option>` labels localized via `data-i18n`; `value` attributes
  kept RAW (sent to server as `?type=`/`?action=`/`?status=`). API filter
  parameters, DB values, status/action enums, IDs, usernames/emails, free-form
  admin/user-entered text, and webhook/provider messages NOT translated
  (deferred/passthrough), per the Phase 3D audit classification.
- CRITICAL BUG FIXED (the "stray };" lesson): the scripted key-insertion placed
  the 125 new ZH keys at line ~12063 INSIDE the fetch-interceptor IIFE in block 5
  (between `return realFetch(url, options);` and the `};` that closes
  `window.fetch = function(...)`), instead of inside the `zh:` dictionary in
  block 4. This caused `SyntaxError: Unexpected token ':'` in block 5. Fix:
  (1) moved the 125 zh keys into the zh dict (before its closing `    }`);
  (2) RESTORED the `    };` + `})();` that close the `window.fetch` override and
  its IIFE - these were the lines the buggy inserter had wedged the keys between,
  and must remain. After fix the fetch interceptor is byte-identical to baseline
  (`return realFetch(url, options);` / `    };` / `})();`).
  LESSON: when relocating a misplaced key block that was inserted between two
  structural lines, do NOT delete the structural closing brace - only delete the
  key lines themselves. Always re-run `node --check` on every script block after
  scripted edits, and brace-match the fetch interceptor (it is a common
  insertion-target because it sits at the block-5 head).
- Verification: `node --check`-equivalent (vm.Script) on all 8 inline `<script>`
  blocks = OK. Robust i18n verify (vm-eval of the real TRANSLATIONS object):
  972 keys/locale x 6, identical key sets, 0 empty, 0 dups (raw Counter recheck),
  0 placeholder-parity, 0 HTML/attr-parity, 477 data-i18n refs all defined.
  Isolated sandbox test of all mapping helpers (healthStatusLabel,
  referralConfigLabel/Desc, formatConfigValue, depositStatusLabel/
  withdrawalStatusLabel/kycStatusLabel) across en/es/pt/fr/ar/zh = ALL PASS
  (known enum -> localized per locale; unknown -> raw verbatim; empty -> '';
  `{{n}}` interpolation; EN fallback). `npm test` = 36 pass / 1 fail (the single
  fail is the pre-existing `tests/q8qpay.webhook.test.js` `Cannot find module
  'express'` env failure - identical to baseline; no regression).
- NOT committed/pushed/deployed (checkpoint pending user confirmation, as with
  prior phases).


## Localization Phase 3F ŌĆö 2FA panel + dead-key JS + language-switch re-render + date locale (2026-08, public/index.html only)
- Frontend-only implementation slice following the read-only Phase 3F audit.
  NO changes to server.js, DB/schema/migrations, auth/2FA LOGIC, wallet/trading/
  referral/payment/withdraw logic, webhook behavior, API request/response shapes,
  or stored status/enum/API/raw values. Only DISPLAY labels were translated.
- Dictionary: 1001 -> 1002 keys/locale (30 NEW keys total: the 29 audit keys
  + `deposit.qrAlt`). EN values for the 1001 pre-existing keys byte-identical -
  0 changed. All 6 locales (en, es, pt, fr, ar, zh) identical key sets, 0 empty,
  0 duplicate keys, 0 `{{placeholder}}` parity issues. NOTE: `referral.defaultUser`
  was listed in the audit plan but is UNUSED (the referral "User" fallback uses
  `common.user` instead), so it was intentionally NOT added.
- 2FA settings panel (twofaStatusView + setup/recovery/disable views,
  L5770-5902): wired ~22 previously-hardcoded English strings to `data-i18n`.
  Strings inside icon-bearing buttons/paragraphs were wrapped in
  `<span data-i18n=...>` so applyTranslations() (which sets innerHTML) only
  replaces the text span and leaves the sibling `<i>` icon intact. Panel keys:
  2fa.statusTitle/statusDesc/verificationMethod/emailCode/codeExpiry/tenMinutes/
  noSetupNeeded/emailVerification/emailProtectionDesc/howItWorks/step1/step2/
  step3/secureAutomatic/secureAutomaticDesc/totpDisabled/verifySetupPrompt/
  verificationCode/btnSaveCodes/storeCodesSafely/btnSaveMyCodes/cannotDisable
  + buttons reuse 2fa.btn.verifyEnable / common.close. FIXED a pre-existing
  label mismatch: the 2FA modal Close button was data-i18n="common.cancel"
  (showed "Cancel") -> corrected to data-i18n="common.close" ("Close").
- Dead-key JS call sites rewired to t() (hardcoded English -> localized):
  - 2FA setup/verify/disable button states: "Generating..." (2 sites) ->
    2fa.btn.generating; "Generate New QR Code" -> 2fa.btn.generateNew;
    "Verify & Enable" (restore) -> 2fa.btn.verifyEnable; "New Codes" (restore)
    -> 2fa.btn.newCodes; "Disabling..." -> 2fa.btn.disabling.
  - 2FA toasts/status: "2FA enabled successfully!" (2 sites) -> 2fa.nowEnabled;
    "2FA has been disabled" -> 2fa.disabled; countdown "Expired" -> 2fa.expired;
    "Code expired. Please request a new one." -> 2fa.codeExpired;
    backup "N remaining" -> 2fa.codesRemaining {{count}}.
  - setButtonLoading "Processing..." -> common.processing; generic button
    loading fallback "Loading..." -> common.loading (kept btn.dataset.loadingText
    override intact).
  - Withdraw-status info text: "$50 to enable withdrawals" ->
    live.withdrawStatus.notDeposited; "$143 MTA..." -> live.withdrawStatus.mtaNotReached;
    "25% Complete - Identity Required" -> withdraw.percentComplete {{percent}} +
    ' - ' + withdraw.identityRequired (display-only; raw status/progress logic
    untouched).
  - Bonus "available to withdraw" -> bonus.availableToWithdraw {{amount}}.
  - Auth "Please enter a valid email address" -> auth.errors.validEmailRequired.
  - Referral pending list: `${r.name || 'User'}` -> common.user;
    "Awaiting deposit" -> referral.awaitingDeposit.
  - Display-name "Trader" fallback: localized the 6 pure-DISPLAY textContent
    fallbacks (displayName/userName/landingUserName) -> common.trader. The 2
    `.value` INPUT prefill sites (profile load) and the saveProfile save path
    (L15200) were LEFT as raw 'Trader' deliberately: that path PERSISTS the
    fallback as user.name in localStorage, so localizing it would store a
    locale-specific word as the user's name. Input default value="Trader"
    (L5720) left raw (overwritten on profile load; no value-attribute i18n
    mechanism).
  - QR code `<img alt="...">` (4 sites) -> consolidated to t('deposit.qrAlt')
    (screen-reader text).
  - KYC country `<option value="OTHER">Other</option>` -> added
    data-i18n="kyc.country.other" (value="OTHER" preserved; raw value sent to
    server unchanged).
- DATE LOCALE (display-only): added appLocale() helper near formatCurrency
  mapping currentLang -> BCP-47 tag (en->en-US, es->es, pt->pt-BR, fr->fr,
  ar->ar, zh->zh-CN). Applied to render-time DISPLAY date formatting ONLY:
  activity timeline formattedTime, audit log created_at, KYC submittedAt,
  2FA enabledAt, time-ago >7days fallback, getTimeAgo fallback, admin
  deposits/withdrawals created_at, deposit-history + KYC-history createdAt,
  health lastChecked. Used ONLY for toLocaleString/toLocaleDateString/
  toLocaleTimeString DISPLAY of server timestamps. NOT applied to: stored
  transaction time: fields (persisted in localStorage history), API date
  parameters (?startDate/&endDate/&action sent raw), timestamps, sorting, or
  comparisons. Number/currency formatting (formatCurrency, ticker amounts)
  LEFT UNTOUCHED to avoid locale decimal/grouping confusion for financial
  values.
- LANGUAGE-SWITCH RE-RENDER (the core 3F feature): previously, render-time-
  localized surfaces (admin tables, activity, alerts, audit, KYC list, ticker,
  transaction log) stayed in the OLD language until a refresh/refetch. Added:
  - I18N_RERENDER_CACHE module-scope object caching the last successfully-
    loaded datasets (activityPreview/activityTimeline/alerts/auditLogs/
    adminUsers/adminDeposits/adminWithdrawals/kycVerifications).
  - rerenderDynamicSurfaces(): pure, guarded re-render. Calls
    updateTransactionLog() (reads in-memory wallet history), then each pure
    render fn with its cached data (only if cache non-null + fn exists + target
    container exists), then refreshTicker(). NO fetch, NO filter/pagination/
    modal/form reset, NO raw-value changes, NO duplicate rows (each render
    rebuilds container innerHTML). Wrapped in try/catch.
  - Refactored 4 inline-rendering load fns into pure render fns + cache writes:
    renderActivityPreview(activities), renderActivityTimeline(activities),
    renderAlerts(data), renderAuditLogs(data) (each extracted from its load*
    fn; load* now does fetch -> cache = data -> render(data)). Admin render fns
    (renderAdminUsers/Deposits/Withdrawals/renderKYCVerifications) already took
    data; added cache writes at their 5 call sites.
  - setLanguage() now calls rerenderDynamicSurfaces() after applyTranslations()
    -> language change immediately re-translates all already-loaded dynamic
    surfaces WITHOUT refetching (no extra API calls).
  - Safety: caches are null until first successful load; on fetch error the
    cache for that surface is reset to null so a stale partial isn't re-rendered.
- CONSERVATIVE NON-CHANGES (deliberately left raw, documented per audit "if
  risk, leave it"): "Loading..."/"Waiting for payment..." INITIAL text on
  dynamically-populated elements (referralCodeDisplay, referralLinkDisplay,
  depositStatusText, withdrawKycProgressText "25% Complete"). These are
  transient pre-load flashes, immediately overwritten by JS, and adding
  data-i18n to them would cause applyTranslations() to CLOBBER the real dynamic
  content (e.g. the actual referral code) on every language switch. The static
  admin "Loading..." rows DO keep data-i18n="common.loading" (they are replaced
  wholesale by table render, never clobbered).
- Verification: node --check on all 4 inline `<script>` blocks = OK. Dict
  parity = 1002 keys/locale x 6, 0 missing, 0 empty, 0 dups, 0 placeholder
  parity. Functional smoke test (real TRANSLATIONS + t() interpolation) =
  all pass (new keys resolve/interpolate per locale; EN fallback for unknown
  locale; unknown key returns key; FR "{{percent}}% termine" interpolates
  correctly). Raw-value invariants verified intact: transaction type/detail
  stored values + `=== 'Deposit'` comparisons unchanged; `<option value>`
  attributes raw; API filter params raw. npm test = 48/48 pass (no regression).
- Checkpoint commit created this session (frontend-only, public/index.html +
  AGENTS.md) AFTER all verification passed. Not pushed/deployed.

## Localization Phase 3H ŌĆö Critical Multilingual UX Fixes (2026-08, public/index.html only)
- Frontend-only fixes for the two confirmed CRIT issues from the Phase 3G audit.
  NO changes to server.js, DB/schema/migrations, auth/2FA LOGIC, wallet/trading/
  referral-business/payment/withdraw logic, webhook behavior, API shapes, or
  stored status/enum/raw values. No new translation keys (1002/locale unchanged);
  only 6 values of `referral.invite` edited (the $10 removed ŌĆö see CRIT-2).
- CRIT-1 ŌĆö 2FA code-expiry countdown clobbering fix:
  - ROOT CAUSE: the expiry `<span>` had `data-i18n="auth.2fa.codeExpiry"` and
    wrapped the WHOLE line including the live `<span id="twofaCountdown">`.
    `applyTranslations()` sets `el.innerHTML = t(key)` WITHOUT passing
    `data-i18n-vars`, so the `{{time}}` placeholder was shown LITERALLY to the
    user, AND the `#twofaCountdown` child was destroyed on every language
    switch. Worse, `start2FACountdown()` captures `countdownEl` ONCE
    (`const countdownEl = document.getElementById('twofaCountdown')`) into the
    interval closure; recreating the element left the interval updating a
    DETACHED node ŌåÆ the visible countdown froze at whatever HTML default
    remained. So language switching during countdown broke it.
  - FIX (smallest safe DOM/i18n change ŌĆö preserves translations & element
    identity): restructured the expiry line into THREE stable sibling spans:
    `<span id="twofaCodeExpiryPrefix">` + `<span id="twofaCountdown">` +
    `<span id="twofaCodeExpirySuffix">`, wrapped by
    `<span id="twofaCodeExpiryWrap">` (NO data-i18n on the wrapper ŌĆö removed
    `data-i18n` AND the dead `data-i18n-vars` attribute, which applyTranslations
    never read anyway). Added `update2FACodeExpiryLabels()` (called from
    `updateDynamicTranslations()` ŌåÆ runs on every `applyTranslations()` incl.
    `setLanguage()`): reads `t('auth.2fa.codeExpiry')` (still contains
    `{{time}}`), splits on `{{time}}`, and sets ONLY the prefix/suffix spans'
    `textContent`. `#twofaCountdown` is NEVER recreated ŌåÆ the interval's cached
    reference stays valid ŌåÆ countdown keeps ticking across language switches.
    No literal `{{time}}` is ever shown. Handles locales where the time sits in
    the MIDDLE of the sentence (zh "ķ¬īĶ»üńĀüÕ░åÕ£© {{time}} ÕÉÄĶ┐ćµ£¤" ŌåÆ prefix
    "ķ¬īĶ»üńĀüÕ░åÕ£© " + countdown + suffix " ÕÉÄĶ┐ćµ£¤"); en/es/pt/fr/ar have empty
    suffix. The `auth.2fa.codeExpiry` translation VALUES were NOT changed
    (0 edits) ŌĆö the placeholder is consumed by the helper, never rendered raw.
  - NOT touched: timer interval, expiration timestamp, OTP validation, API
    calls, 2FA security logic, the numeric countdown value itself.
- CRIT-2 ŌĆö referral.invite reward-amount clobbering fix:
  - ROOT CAUSE: `<h4 data-i18n="referral.invite">Invite Friends, Earn
    <span id="refRewardAmount">$10</span></h4>`. `applyTranslations()` set the
    h4's `innerHTML = t('referral.invite')` = "Invite Friends, Earn $10" (the
    $10 was HARDCODED in the translation), destroying the `#refRewardAmount`
    span. `updateReferralUI()` sets `#refRewardAmount.textContent = '$' +
    rewardAmount` dynamically from `APP.referralStats.config.rewardAmount`
    (line ~12912), so after a language switch the dynamic amount was gone and
    the hardcoded $10 showed instead.
  - FIX (safe span structure ŌĆö the audit's preferred alternative to
    interpolation): moved `data-i18n="referral.invite"` onto an inner
    `<span>` wrapping ONLY the static prefix text, with `#refRewardAmount` as a
    STABLE sibling span after it:
    `<h4 ...><span data-i18n="referral.invite">Invite Friends, Earn</span>
    <span id="refRewardAmount">$10</span></h4>`.
    `applyTranslations()` now localizes only the prefix span; `#refRewardAmount`
    is never recreated ŌåÆ its dynamic value survives language switches and keeps
    receiving the real configured amount. Edited `referral.invite` values in
    ALL 6 locales to remove the hardcoded `$10` (en/es/pt/fr/ar/zh all had $10
    at the END, so prefix-only works for every locale; placeholder parity
    unaffected ŌĆö no {{amount}} placeholder used). The amount is NOT hardcoded
    in any translation anymore. Referral config/business logic, reward calc,
    and API data UNTOUCHED.
- Medium issues (3 static-English leakage / 4 stale surfaces / 5 RTL): NOT
  addressed in this phase. The full Phase 3G audit findings list was not
  available, so per the smallest-change / no-scope-creep rule no speculative
  medium fixes were made. A broad scan for the CRIT-2 clobbering class
  (`data-i18n` element wrapping an id-bearing child) found ZERO other
  instances ŌĆö CRIT-2 was the only one. `referral.step3Text` was verified
  ALREADY safe (its data-i18n wraps only "You earn"; `#refRewardAmount2` is a
  separate sibling). The `I18N_RERENDER_CACHE`/`rerenderDynamicSurfaces()`
  architecture (activity/alerts/audit/admin tables/KYC/ticker) is intact.
- Verification: node --check-equivalent (vm.Script) on all 5 inline `<script>`
  blocks = OK. Full i18n verify (vm-eval of real TRANSLATIONS): 1002
  keys/locale ├Ś 6, identical key sets, 0 empty, 0 duplicate keys (raw Counter
  recheck), 0 placeholder-parity issues, 0 HTML-tag/attr parity issues, 486
  data-i18n refs all defined (was 486 before ŌĆö the 2 CRIT edits net 0: CRIT-1
  removed the wrapper's data-i18n, CRIT-2 moved data-i18n onto a child span).
  Isolated functional test (real TRANSLATIONS + t() + the actual
  update2FACodeExpiryLabels logic + simulated countdown interval closure):
  27/27 PASS ŌĆö countdown default/decrement, no literal {{time}} in any locale,
  countdown element identity preserved across enŌåÆzhŌåÆarŌåÆen switches (keeps
  ticking, never frozen), zh suffix ÕÉÄĶ┐ćµ£¤ present, ar RTL prefix present;
  referral heading localized across all 6 locales, dynamic reward $15 survives
  roundtrip enŌåÆesŌåÆfrŌåÆarŌåÆzhŌåÆen, no duplicate/stale amount, no raw key shown.
  Raw-value safety: transaction type/detail stored values, `=== 'Deposit'`
  comparisons, status values, referral config keys, API filter params, payment
  states, 2FA state/API logic all UNCHANGED. `npm test` = 36 pass / 1 fail
  (the single fail is the pre-existing tests/q8qpay.webhook.test.js
  `Cannot find module 'express'` env failure ŌĆö identical to baseline; no
  regression). NOTE: this env's baseline is 36/1 (express not installed), not
  the 48/48 cited in earlier phases' AGENTS.md notes.
- Checkpoint commit created this session (frontend-only, public/index.html +
  AGENTS.md) AFTER all verification passed. NOT pushed. NOT deployed.

## Phase 5B ŌĆö Verification UX State & Accurate Withdrawal Copy (2026-08, public/index.html only)
- Follows the Phase 5A read-only audit. Frontend-only; NO changes to server.js,
  DB/schema/migrations, auth/2FA, wallet, trading, referral, payment/deposit,
  withdraw ELIGIBILITY logic, webhook behavior, API request/response shapes, or
  raw KYC status values (not_started/pending_review/approved/rejected/
  resubmission_required). Display copy + a render-time header mapper only.
- Audit facts preserved in the UX (do NOT re-introduce a KYC "threshold"): KYC
  is NOT required for demo/live trading or deposits; KYC IS required for EVERY
  withdrawal (unconditional, first withdrawal onward); only `approved` allows
  withdrawal; `rejected`/`resubmission_required` block but allow resubmission.
- Verification modal header made status-dynamic (render-time, raw status):
  - Added `id="kycModalTitle"` to the title `<span>` and `id="kycModalSubtitle"`
    to the subtitle `<p>` (kept their data-i18n as the generic default/fallback
    so applyTranslations() still sets a sane base before override).
  - New helper `updateVerificationModalHeader()` (~line 14923): maps RAW
    `KYC_DATA.profile.status` (null -> 'not_started') via `KYC_TITLE_KEY`/
    `KYC_SUBTITLE_KEY` maps to `kyc.title.*`/`kyc.subtitle.*` keys; unknown
    status falls back to `kyc.modalTitle`/`kyc.modalSubtitle`. Display-only:
    READS raw status, never mutates it; no comparisons changed.
  - Called from `populateVerificationUI()` (modal open, after the status banner)
    AND from `updateDynamicTranslations()` (runs on every applyTranslations() /
    setLanguage()) so the header re-renders on language switch without refetch.
  - `KYC_TITLE_KEY`/`KYC_SUBTITLE_KEY` are module-scope `const`s (initialized at
    parse; only read at runtime from updateDynamicTranslations -> safe despite
    being declared after the caller, since the caller runs post-parse).
- Implemented status states (title / supporting text):
  - not_started (or no profile): "Verification" / "Not required for trading or deposits"
  - pending_review: "Verification" / "Under review"
  - approved: "Verification Ō£ō" / "Verified ŌĆö withdrawals enabled"
  - rejected: "Verification" / "Verification rejected ŌĆö action required"
  - resubmission_required: "Verification" / "Update your information to resubmit"
- Withdrawal-triggered KYC messaging (display copy only; the
  `verificationRequired` flag, /api/kyc/can-withdraw, server gate, and the
  openWithdrawModal fail-open behavior are UNCHANGED per Phase 5A ┬¦6):
  - `withdraw.kycRequiredTitle`: "Identity Verification Required" -> "Verification Required"
  - `withdraw.kycRequiredBody`: long body -> "Verify your account to withdraw."
  - Updated in all 6 locales (faithful translations).
- Withdrawal minimum display fix (display only; APP.MIN_WITHDRAWAL stays 700,
  server.js `amount < 700` untouched):
  - `withdraw.info`: "$50" -> "$700" in all 6 locales (only the amount token
    changed; the rest of each locale's string preserved). Now consistent with
    APP.MIN_WITHDRAWAL=700, server Min $700, and live.withdrawStatus.ready
    "min $700". The $50 figure was an existing display defect.
- Dictionaries: 1002 -> 1012 keys/locale (10 NEW keys: kyc.title.{notStarted,
  pendingReview,approved,rejected,resubmission} + kyc.subtitle.{...same 5}).
  EN values for the 1002 pre-existing keys byte-identical - 0 changed EXCEPT
  the 2 withdraw.kycRequired* values + the 6 withdraw.info $50->$700 tokens
  (intentional display-copy fixes). All 6 locales identical key sets, 0 empty,
  0 duplicate keys (raw Counter recheck), 0 placeholder-parity issues, 0
  HTML-tag/attr parity issues. 503 data-i18n refs all defined.
- NOT changed (deliberately, per Phase 5A ┬¦6 - separate audit/decision):
  frontend fail-open behavior of /api/kyc/can-withdraw; frontend MTA withdrawal
  pre-check (openWithdrawModal still gates balance<APP.MTA); server withdrawal
  requirements; KYC backend enforcement (server.js:2916); withdrawal amount
  calcs; KYC submission/review logic. landing.faq.6.a ("may be required for
  higher withdrawal limits") left untouched (separate copy decision).
- Verification: node --check (vm.Script) on all 8 inline <script> blocks = OK.
  Dict parity via node-eval of real TRANSLATIONS = 1012 keys/locale x 6, 0
  problems across all checks. Isolated functional test of
  updateVerificationModalHeader (7/7 PASS): each raw status -> correct
  title/subtitle per locale; null profile -> not_started mapping; unknown
  status -> generic fallback; raw status verified NOT mutated. Raw KYC status
  comparisons in populateVerificationUI (`=== 'approved'` etc.) verified
  unchanged. APP.MIN_WITHDRAWAL=700 verified. git status confirms ONLY
  public/index.html modified (server.js/services/migrations/supabase untouched).
  `npm test` = 55 pass / 1 fail (the single fail is the pre-existing
  tests/q8qpay.webhook.test.js `Cannot find module 'express'` env failure -
  deps not installed in this env; identical to baseline; no regression).
- NOT committed/pushed/deployed (checkpoint pending user confirmation, as with
  prior phases).

## Phase 6D ŌĆö KYC Security & Storage Repair (2026-08, server.js + new migration 010 + AGENTS.md + .env.example)
- Goal: enable RLS on the four KYC tables, add least-privilege policies, remove
  the silent production SUPABASE_SERVICE_KEYŌåÆanon fallback, route server-side
  KYC Storage + DB ops through the service-role client, keep the kyc-documents
  bucket private. NO changes to withdrawal logic, KYC status VALUES, KYC
  frontend/modal behavior, trading, deposits, payments, referrals, 2FA,
  localization, webhook logic, API response shapes, or admin workflow.
  services/KYCService.js was NOT modified (the wiring change in server.js
  suffices). productionGuard.js was NOT modified (already enforces
  SUPABASE_SERVICE_KEY in production).
- Auth context (drives the design): the app uses CUSTOM JWT auth (Express +
  JWT_SECRET), NOT Supabase Auth. There is no auth.uid() and the Supabase
  clients are shared singletons that never carry a per-request user JWT; also
  users.id is BIGINT vs Supabase Auth UUID. So true auth.uid()-based "ownership"
  RLS policies are NOT possible. The least-privilege model that works: ENABLE
  RLS on the KYC tables and grant access ONLY to service_role (the server, via
  supabaseAdmin, which bypasses RLS); anon/authenticated get NO policy ŌåÆ DENY
  by default ŌåÆ KYC data is a hard lock against anon-key leakage. Ownership +
  admin authorization continues to be enforced in app code (authMiddleware /
  adminMiddleware + user_id-scoped queries), unchanged.
- NEW migration supabase/migrations/010_kyc_rls_security.sql (idempotent,
  additive):
  - `ALTER TABLE ŌĆ” ENABLE ROW LEVEL SECURITY` on verification_profiles,
    verification_documents, verification_history, admin_review_history.
  - `DROP POLICY IF EXISTS` then `CREATE POLICY "kyc_*_service_all" FOR ALL
    TO service_role USING (true) WITH CHECK (true)` on each of the 4 tables.
    NO anon/authenticated policy is created (deny by default).
  - Storage: reassert kyc-documents bucket `public=false`, 10MB limit,
    image-only MIME (INSERT ŌĆ” ON CONFLICT DO UPDATE). Defensively DROP any
    stray anon/authenticated storage policies (none existed). Re-create the
    single `svc_kyc_manage` `service_role`-only policy. No anon storage policy.
  - DO $$ verify block: asserts RLS enabled on all 4 tables and bucket
    public=false; RAISES EXCEPTION otherwise.
- server.js changes (3 KYC-scoped edits):
  1. Removed the production silent fallback. Was:
     `const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || supabaseKey;`
     Now: read SUPABASE_SERVICE_KEY; if missing/empty AND NODE_ENV==='production'
     ŌåÆ console.error + process.exit(1) (defense-in-depth on top of
     productionGuard, which already enforces this). If missing AND non-production
     ŌåÆ preserve the existing dev fallback to supabaseKey with a console.warn
     (keeps local dev + the productionGuard test "dev: missing
     SUPABASE_SERVICE_KEY does not break startup (fallback preserved)" green).
     supabaseAdmin is then createClient(supabaseUrl, supabaseServiceKey).
  2. KYCService wiring: `new KYCService(supabase, supabase.storage)` ŌåÆ
     `new KYCService(supabaseAdmin, supabaseAdmin.storage)`. This routes ALL KYC
     DB queries AND all Storage upload/createSignedUrl/remove through the
     service-role client. KYCService.js constructor already accepts
     (supabase, storageClient) and initializeStorage() derives from the passed
     client, so NO KYCService code change was needed.
  3. Executive-dashboard: the 4 verification_profiles count queries
     (verifiedUsers/pendingKyc/kycApprovedToday/kycRejectedToday) switched from
     `supabase` ŌåÆ `supabaseAdmin` so they survive RLS. The surrounding
     users/deposits/withdrawals/referrals counts in the same handler STAY on the
     anon `supabase` client (out of scope; they keep working via their existing
     USING(true) anon policies).
- DEV REQUIREMENT (by design, no escape hatch per user direction): with RLS now
  denying the anon role on KYC tables, KYC DB/Storage operations require
  SUPABASE_SERVICE_KEY (so supabaseAdmin is the service-role client). In dev
  without a service key, supabaseAdmin falls back to anon and KYC ops will be
  blocked by these RLS policies by design; set SUPABASE_SERVICE_KEY for local KYC
  testing. Non-KYC admin ops are unaffected (their tables keep USING(true) anon
  policies).
- Preserved EXACTLY: stored KYC status values (not_started/pending_review/
  approved/rejected/resubmission_required); withdrawal enforcement
  (server.js /api/kyc/can-withdraw + the withdraw-route KYC gate at ~2935,
  both call kycService.getVerificationStatus which now uses supabaseAdmin but
  returns the same status); API response shapes; admin review workflow;
  frontend modal behavior (public/index.html untouched).
- Verification: `node --check server.js` = OK. SQL sanity: migration idempotent
  (DROP IF EXISTS before CREATE), ENABLE RLS on 4 tables, bucket public=false,
  no anon storage policy. Grep confirms: 0 remaining `supabase.from(
  'verification_profiles'|'verification_documents'|'verification_history'|
  'admin_review_history')` (anon) reads; all KYC DB now via supabaseAdmin (incl.
  KYCService via the admin client) + the 4 exec queries; no anon/authenticated
  policy exists on any KYC table (only service_role); `|| supabaseKey` fallback
  removed. `npm test` results below. NOT committed/pushed/deployed.

## Phase 7A ŌĆö Verification & Withdrawal UX/Gating (2026-08, server.js + public/index.html + tests/withdraw_gating.test.js)
- Three narrowly-scoped changes; an ORDERING change only on the backend, a
  gate-reorder + a new demo info modal on the frontend. NO changes to deposits,
  trading/bot logic, referral logic, payment/webhooks, 2FA, KYC storage/security
  (KYCService.js + migration 010 untouched), admin review workflow, financial
  calculations, withdrawal business constants (APP.MIN_WITHDRAWAL=700, APP.MTA=143,
  server `amount < 700`), or API response shapes except reusing the existing
  verification-required response verbatim. Raw KYC status values
  (not_started/pending_review/approved/rejected/resubmission_required) are
  referenced verbatim and never localized/mutated in API/DB/comparisons.
- 1) Backend `/api/withdraw/request` (server.js:2925): MOVED the KYC check to be
  Gate 1 (FIRST), before getWallet/min-$700/balance/address/trade-count. An
  unapproved user now receives the existing
  `{ error:'Identity verification required', verificationRequired:true,
  status:<raw>, redirectTo:'/#/verification' }` (HTTP 400) response REGARDLESS
  of the requested amount (below $700), balance, address, or trade history. The
  existing $700/balance/address/trade requirements keep their exact meaning and
  order and are still enforced after KYC approval. Exactly one
  `getVerificationStatus(userId)` call remains (no duplicate). This is an
  ordering change only ŌĆö no requirement removed or weakened. Pinned by
  tests/withdraw_gating.test.js (12 tests, pure-logic mirror of the gate order,
  no express/server import).
- 2) Frontend `openWithdrawModal()` (public/index.html): reordered the gates so
  KYC is Gate 1 (after the unchanged demo-mode prerequisite). Flow: demo?ŌåÆtoast
  switchToLive (unchanged); Gate 1 KYC via /api/kyc/can-withdraw ŌĆö if
  !canWithdraw show the EXISTING `#withdrawKycRequired` experience (progress +
  "Start Verification" button) and return BEFORE any other gate; Gate 2 min-
  withdrawal (balance < MIN_WITHDRAWAL); Gate 3 balance/deposit
  (!hasRealDeposit); Gate 4 completed-trade (!hasTradingActivity || balance <
  MTA, grouped as before); then show `#withdrawForm` (Gates 5 address + 6
  submission unchanged in submitWithdraw/submitWithdrawAPI). The existing
  fail-open behavior (show the form when the KYC status CHECK itself fails /
  throws) is PRESERVED per Phase 5A ┬¦6 ŌĆö the server hard-enforces KYC-first
  regardless, so a frontend fail-open is still rejected on submit with
  verificationRequired. No requirement removed/weakened; only KYC moved first
  and min-withdrawal ordered before balance/trade per spec.
- 3) Demo Verification info modal: `openVerificationModal()` now short-circuits
  in demo mode ŌĆö it opens a NEW lightweight `#verificationDemoInfoModal`
  (reuses .deposit-modal/.btn classes; no new CSS) and RETURNS WITHOUT opening
  the KYC form (`#verificationModal`) or calling loadVerificationStatus(). The
  modal shows a localized "Verification Not Required" title + body explaining
  deposit & trading do not require verification (only LIVE withdrawals do) + a
  "Switch to LIVE Mode" button (calls switchToLiveFromDemoInfo ŌåÆ setMode('live'))
  + a Close button (reuses common.close). Demo trading behavior is unchanged
  (setMode is only invoked if the user clicks the button). The existing LIVE-mode
  path (unverified LIVE user clicks "Start Verification" from the withdraw KYC
  screen ŌåÆ openVerificationModal ŌåÆ APP.mode==='live' ŌåÆ real KYC form) is intact.
- Localization: 3 NEW keys added to ALL 6 locales (en/es/pt/fr/ar/zh) after
  `kyc.modalSubtitle` in each: `kyc.demoInfo.title`, `kyc.demoInfo.body`,
  `kyc.demoInfo.switchToLive`. Dictionary grew 1012 ŌåÆ 1015 keys/locale; EN
  values for pre-existing keys byte-identical (0 changed); identical key sets
  across all 6 locales; 0 empty; 0 duplicate keys (raw Counter recheck); 0
  placeholder parity issues. Arabic RTL preserved (modal uses data-i18n handled
  by applyTranslations which sets `dir='rtl'` for ar; `text-align:center` is
  bidi-safe; the switch button's data-i18n is on an inner <span> so the <i>
  icon survives applyTranslations' innerHTML set ŌĆö the Phase 3H clobber-safe
  pattern). "LIVE" kept as a literal token per prior-phase convention.
- Verification: `node --check server.js` = OK. `vm.Script` parse on all 5
  non-empty inline <script> blocks = OK. Custom verifier (vm-eval of the real
  TRANSLATIONS object): 1015 keys/locale ├Ś 6, identical key sets, 3 new keys
  present + non-empty everywhere, 0 dups, modal+helpers present,
  openVerificationModal gates on demo, backend KYC precedes min/balance/address/
  trade (kyc@646 < min@1128), exactly 1 getVerificationStatus call,
  verificationRequired:true preserved. `npm test` = 67 pass / 1 fail, where the
  1 fail is the PRE-EXISTING `tests/q8qpay.webhook.test.js`
  `Cannot find module 'express'` (deps not installed in this env ŌĆö identical to
  the 55/1 baseline; the +12 are the new passing withdraw_gating tests). No
  regression.
- NOT committed/pushed/deployed (checkpoint pending user review, as with prior
  phases). Working tree: M public/index.html, M server.js, ?? tests/withdraw_gating.test.js.

## Phase 8 Ś Arbitrix Pro Subscription ($7/month) (2026-08, server.js + public/index.html + .env.example + new migration 011 + tests/subscription.test.js + AGENTS.md)
- A MINIMAL, self-contained internal subscription. The Pro subscription is a
  $7/month INTERNAL SERVER-SIDE DEBIT of the user's genuinely available Live
  balance (wallets.live_balance). It is NOT a payment method, NOT a deposit, and
  NOT routed through any payment provider / webhook / invoice / crediting code.
- SCOPE GUARDRAILS (verified untouched): NO changes to deposit request/invoice
  creation, q8qpay, NOWPayments, Paymento, payment webhooks, credit_payment_safe,
  deposit polling, deposit statuses, wallet-crediting logic, payment DB
  structures, trading/bot logic (record_trade_safe), referral logic, KYC/storage
  logic (migration 010 / KYCService), 2FA/auth, withdrawal eligibility/gating
  (Phase 7A gates unchanged Ś subscription is NOT a withdrawal gate), existing
  transaction status/type values (a NEW 'Subscription' type was ADDED; existing
  type meanings unchanged), or existing API response shapes except the additive
  new subscription endpoints. server.js diff is PURE-ADDITION (0 removed lines);
  index.html diff removes exactly 1 line (the prior TX_TYPE_LABELS
  'Withdrawal to Live' entry, rewritten to add a trailing comma + the new
  'Subscription' entry Ś value preserved).
- AVAILABLE-BALANCE MODEL (critical, from the migration doc): this app has NO
  locked/committed/open-position funds Ś trades are REALIZED immediately via
  record_trade_safe() (live_balance += signed P&L, clamped at 0). Therefore the
  genuinely available balance IS wallets.live_balance. An atomic debit of
  live_balance CANNOT consume committed funds (none exist). Demo balance
  (wallets.demo_balance) and bonus balance (wallets.bonus_balance) are NEVER
  touched by subscription billing (the charge function reads/UPDATEs only
  live_balance; grep-verified + test #4/#4b/#15).
- SUBSCRIPTION MODEL: one plan, "Arbitrix Pro", $7/month. Price is
  SERVER-CONTROLLED: read from payment_config key `subscription.pro_price`
  (default 7, seeded by migration 011; fallback const
  SUBSCRIPTION_PRO_DEFAULT_PRICE=7 in server.js). NO multiple tiers, annual
  plans, coupons, Stripe/PayPal/card, or crypto invoices. NO card/bank form.
  Stored subscription fields: user_id (UNIQUE FK users), plan='pro', price,
  status (active|payment_due|inactive|cancelled, CHECK-constrained),
  started_at, next_billing_date, last_billing_date, last_charge_amount,
  created_at, updated_at.
- ATOMICITY / IDEMPOTENCY / DOUBLE-CHARGE PROTECTION (the core): implemented as a
  Postgres SECURITY DEFINER plpgsql function `charge_subscription_safe(p_user_id,
  p_price, p_idempotency_key, p_period_label, p_billing_kind)` that mirrors the
  existing credit_payment_safe / record_trade_safe guarantees:
    1. Input validation (user_id, idempotency_key, non-negative 2-dp price).
    2. Idempotency check #1 (before lock): SELECT idempotency_key FROM
       subscription_charges WHERE idempotency_key = p_idempotency_key. If present
       -> return {success:true, duplicate:true, existing balance/price} (NO
       second charge). subscription_charges.idempotency_key is UNIQUE.
    3. SELECT ... FOR UPDATE on subscriptions (row lock).
    4. SELECT ... FOR UPDATE on wallets (row lock).
    5. Idempotency check #2 (AFTER lock): race-condition protection Ś a
       concurrent tx could have inserted the same key between checks #1 and #2.
       If present -> return duplicate, no second charge.
    6. SUFFICIENT-BALANCE GATE: IF wallets.live_balance < price -> NO balance
       mutation, NO debt, NO negative balance, mark subscriptions.status=
       'payment_due', return {success:false, reason:'insufficient_balance',
       status:'payment_due', available_balance, price}. (Tests #3/#8/#9.)
    7. Atomic debit: v_new_balance := live_balance - price (provably >= 0);
       UPDATE wallets SET live_balance = v_new_balance (ONLY live_balance).
    8. INSERT subscription_charges (idempotency anchor, balance_after).
    9. INSERT transactions (type='Subscription', amount=-price,
       detail='Arbitrix Pro Subscription' [+ ' - ' period_label]).
   10. UPDATE subscriptions SET status='active', last_billing_date=NOW(),
       last_charge_amount=price, next_billing_date=NOW()+1 month, started_at=
       COALESCE(started_at,NOW()).
   11. EXCEPTION WHEN OTHERS -> return JSON error; no partial state.
  Billing idempotency key is SERVER-DERIVED ONLY from (user_id, target UTC
  month, billing_kind) via `subscriptionBillingKey()`:
  `sub_<userId>_<kind>_<YYYY-MM>`. The client NEVER supplies this key or the
  price. A user can therefore never be charged twice for the same billing
  period regardless of double-clicks, retries, concurrency, refreshes, or
  repeated scheduled billing. (Tests #5/#6/#7 + bonus billing-key test.)
- BILLING DECISION (server-side, `processDueSubscription(userId)`): only
  'active' or 'payment_due' subs are billable; 'inactive'/'cancelled' never
  billed. 'active' is due when next_billing_date <= now (anchor = next_billing
  date). 'payment_due' retries the due period (anchor = next_billing_date or
  now), guarded by the idempotency key. The due check runs server-side on
  GET /api/subscription (non-fatal if it errors) Ś the client never triggers a
  charge. (Bonus isBillableDue test.)
- INSUFFICIENT BALANCE: charges $0, never creates debt / negative balance,
  never withdraws locked funds, never interferes with deposits/withdrawals/
  trading; marks status='payment_due' and preserves every cent. An unpaid
  subscription does NOT prevent access/withdrawal of eligible funds (withdrawal
  gates unchanged). The UI shows a localized "Your subscription is due. Add at
  least $7..." message (subscription.dueTitle/dueDesc).
- API ENDPOINTS (all behind authMiddleware; admin also behind adminMiddleware;
  userId always derived from req.user.id, NEVER from the client body):
  - GET /api/subscription Ś server price + current state + idempotent due-billing
    check. Read-only from the client's perspective.
  - POST /api/subscription/activate Ś explicit user action to START Pro. Does
    NOT auto-charge on registration. Sends NO authoritative body (an empty {}
    body; any client-supplied price/userId is IGNORED). On sufficient balance the
    first month is charged immediately and status->active; on insufficient
    balance the sub is created/updated to 'payment_due' with $0 charged. A
    'cancelled' sub is re-activatable. An 'active' sub returns {duplicate:true}.
  - POST /api/subscription/cancel Ś user cancels; status->'cancelled'; no refund;
    never billed again until re-activated. Retains Pro until the paid period ends.
  - GET /api/admin/subscriptions Ś minimal read-only admin visibility
    (user_id, plan, price, status, next/last billing date). NO balance alteration
    is possible through this surface (it's a SELECT).
- FRONTEND (public/index.html, frontend-only additive): a "Arbitrix Pro"
  subscription panel inside the existing Profile modal (#subscriptionPanel),
  shown via `loadSubscriptionStatus()` called from `openProfileModal()`. Shows
  plan + server price ($7/month via #subscriptionPriceLabel populated from the
  GET response, never client-hardcoded), a localized status badge
  (#subscriptionStatusBadge via SUBSCRIPTION_STATUS_KEYS render-only map), a
  dynamic details area (#subscriptionDetails: active->"Next payment: <date>",
  payment_due->"Your subscription is due. Add at least $7...", cancelled->re-
  activate copy, inactive->activate copy), and Activate/Cancel buttons that send
  no authoritative body. The UI never claims $7 was paid unless the server
  confirms it (toast subscription.activated only on status==='active').
  `activateSubscription()` reconciles APP.liveData.balance from the server-
  returned newBalance (live mode only). Admin: a new read-only "Subscriptions"
  tab (adminTabSubscriptions) + loadAdminSubscriptions()/renderAdminSubscriptions
  (raw status mapped to localized labels; no balance editing).
  NEW transactions.type 'Subscription' added to TX_TYPE_LABELS ('Subscription' ->
  'tx.type.subscription') following the existing render-only mapping pattern;
  existing type entries/values unchanged (the 'Withdrawal to Live' line was
  rewritten with a trailing comma + the new entry; its value is preserved).
- LOCALIZATION: dictionaries grew 1015 -> 1042 keys/locale (27 NEW keys across
  all 6 locales en/es/pt/fr/ar/zh). EN values for the 1015 pre-existing keys
  byte-identical (0 changed). Identical key sets across all 6 locales, 0 empty,
  0 duplicate keys (raw Counter recheck per the Phase-2B-1 lesson), 0
  placeholder-parity issues ({{date}} in subscription.nextPayment). Arabic RTL
  preserved (applyTranslations sets dir='rtl' for ar; subscription panel uses
  data-i18n spans so icons survive innerHTML sets Ś the Phase 3H clobber-safe
  pattern). New key groups: subscription.* (month/activate/cancel/disclaimer/
  inactiveDesc/activeDesc/nextPayment{{date}}/dueTitle/dueDesc/cancelledDesc/
  status.active/status.paymentDue/status.inactive/status.cancelled/activated/
  paymentDue/cancelled/activateFailed/cancelFailed/plan/price/nextBilling/
  lastBilling), admin.tab.subscriptions, admin.empty.noSubscriptions,
  tx.type.subscription.
- SECURITY: subscription endpoints use the existing authMiddleware (and
  adminMiddleware for admin). The server derives userId from req.user.id (JWT);
  the charge RPC always passes p_user_id=userId; the price is read from
  payment_config; the idempotency key is server-derived. The client NEVER
  supplies userId/price/balance/billing-date/status. supabaseAdmin (service-
  role) is used for all user-facing subscription reads/writes + the charge RPC.
  The admin listing uses the anon supabase client (RLS is DISABLED on the
  subscription tables in migration 011 so the anon read works). No
  service-role/Supabase secrets are exposed.
- VERIFICATION:
  - `node --check server.js` = OK. `vm.Script` parse on all 5 inline <script>
    blocks = OK.
  - i18n parity (vm-eval of real TRANSLATIONS): 1042 keys/locale x 6, identical
    key sets, 0 empty, 0 dups (raw Counter), 0 placeholder-parity, all 27 new
    subscription keys present + non-empty everywhere.
  - `npm test` = 85 pass / 1 fail. The +18 over the 67 Phase-7A baseline are the
    new tests/subscription.test.js (18/18 pass). The single fail is the
    PRE-EXISTING tests/q8qpay.webhook.test.js `Cannot find module 'express'`
    (node_modules NOT installed in this env Ś confirmed: no node_modules dir;
    identical to the documented baseline; explicitly out of scope per the Phase
    8 spec). No regression. withdraw_gating.test.js (12/12) + trades_pnl.test.js
    still pass.
  - server.js diff is PURE-ADDITION (0 removed lines). index.html removes
    exactly 1 line (the rewritten TX_TYPE_LABELS entry). No deposit/payment/
    withdrawal/trade/KYC/2FA/referral code modified.
- NOT committed/pushed/deployed (checkpoint pending user confirmation, as with
  prior phases). Working tree: M .env.example, M public/index.html, M server.js,
  ?? supabase/migrations/011_subscription_pro.sql, ?? tests/subscription.test.js.
  HEAD unchanged at the Phase-7A merge commit 07d2ce1.


## Phase 8B ŌĆö Secure Profile Email Change (USER_CONTEXT task)
GOAL: The Profile email field must NOT be directly editable/savable. Email
changes go through a verification-based flow (reusing existing 2FA/password-reset
patterns). Users cannot arbitrarily change their account email by editing the
field.

WHAT SHIPPED (smallest production-safe surface):
- migration 012_email_change.sql (ADDITIVE, idempotent, RLS DISABLED):
  table public.email_change_requests(id BIGINT PK, user_id BIGINT FK->users(id),
  new_email TEXT, code_hash TEXT, expires_at TIMESTAMPTZ, used BOOL, attempts INT,
  ip_address TEXT, user_agent TEXT, created_at, used_at). Indexes on user_id and
  (user_id, used). No ALTER to any financial/KYC/auth table.
- server.js: three routes (all behind authMiddleware, identity from req.user.id):
  POST /api/auth/email-change/request, GET /api/auth/email-change/status,
  POST /api/auth/email-change/verify. Helpers: EMAIL_CHANGE_CONFIG,
  isValidEmailFormat, hashEmailChangeCode (SHA256), generateEmailChangeCode
  (crypto.randomBytes), sendEmailChangeCodeEmail (Resend to NEW email only),
  generateEmailChangeTemplate.
- public/index.html: profileEmail input is now readonly; a "Change Email" button
  opens a 2-step modal (enter new email -> enter 6-digit code). Added
  openChangeEmailModal, requestEmailChange, verifyEmailChange, backToEmailStep1,
  loadEmailChangeStatus, refreshProfileEmailFromServer. saveProfile() no longer
  overwrites user.email from the readonly field. All 6 languages got
  emailChange.* + common.back keys.

SECURITY MODEL (pinned by tests/email_change.test.js):
- Identity is JWT-only (req.user.id). No client-supplied userId anywhere -> no IDOR.
- users.email updates ONLY in the verify handler, ONLY the email column, keyed by
  JWT userId. The user's internal id never changes.
- The old email keeps working for login until the new one is verified.
- Code: cryptographically random 6-digit, stored ONLY as SHA256 hash, single-use
  (used=true before mutating user), 10-min expiry, never returned/logged in
  plaintext (dev-mode log explicitly avoids it).
- Per-user request cooldown (60s), per-request attempt throttle (5 fails ->
  invalidate). New request replaces prior pending request.
- Uniqueness checked at BOTH request and verify time (race guard).
- Financial/KYC/trading/payment/subscription/2FA/referral systems untouched.
- supabaseAdmin (service-role) used for all email-change reads/writes.

VERIFICATION:
- node --check server.js = OK. Translations object evals cleanly; emailChange.*
  + common.back present + non-empty in all 6 locales.
- tests/email_change.test.js: 23/23 pass (contract grep + pure-JS logic mirror:
  normal request, invalid format, duplicate-email rejection, IDOR guard, wrong
  code, expired code, code reuse/replay, only-email-updated, id-unchanged,
  old-email-still-logs-in, pending replacement, rate limiting, attempt lockout,
  race guard, existing auth intact, financial paths byte-unchanged, UI readonly,
  saveProfile no longer persists email, 6-lang parity).
- npm test = 120/120 pass (was 97: +23 email_change). subscription 18/18,
  withdraw_gating 12/12 unchanged. No regressions.

NOT committed/pushed/deployed pending user confirmation. Working tree:
M server.js, M public/index.html, ?? supabase/migrations/012_email_change.sql,
?? tests/email_change.test.js.


## LANDING PAGE (public/index.html) - added 2026-08
- First-time visitors see the auth page (#authPage, display:flex); marketing landing (#landingPage, display:none) shows post-login. goToApp() hides landing and shows mainApp.
- Landing rewritten to accurate product truth: Automated Arbitrage. Made Simple. Sections: hero, What is Arbitrix, arbitrage explainer, 5-step How It Works, Demo Mode, Live Mode, one-click bot, bot-running/session, Live experience, 7USD/month pricing, supported markets, withdrawals, security, who-it's-for, FAQ (24 Q&A), risk disclosure, final CTA, footer.
- Removed unverified marketing claims: fake stats (2.5B+/150K+/99.9%), Bank-Level Security, cold storage, non-custodial, 50+ exchanges, 256-bit SSL (softened to secure HTTPS connection). Auth brand panel + auth.securityBadge neutralized across all locales.
- Analytics: trackLandingEvent(name,data) pushes to window.dataLayer (+console). No external calls unless window.ANALYTICS_ENDPOINT set. goToApp(source) emits hero_cta_click/demo_cta_click/signup_start for demo CTAs.
- SEO: title/description/OG/twitter meta + inline SVG favicon and social image. canonical /.
- i18n: single TRANSLATIONS object (en/es/pt/fr/ar/zh), RTL for ar. Verifier script at /tmp/verify_i18n.js (parses via vm sandbox). Now 1229 keys x6, full parity.
- PRODUCT TRUTH GAPS (FLAGGED, do NOT assert until confirmed):
  - NO 14-day free trial/introductory Live period exists in code. Subscription is explicit opt-in activation (activateSubscription); 7USD debited server-side from live_balance. Wording avoids claiming a free 14-day period.
  - NO fixed session limit (e.g. 2h) in code. Bot runs via setInterval(8s) while app open; stops on close/refresh. Did not state a duration.
  - Withdrawal 15-30 min processing time NOT found in code (withdrawals insert as status:pending). Stated per brief but flagged for confirmation.
  - Insufficient-balance subscription behavior documented as actual (no debt, retried next billing check) - verify against server.js subscription section (~line 519).

## PHASE 8C — LANDING UX/MOBILE REFINEMENT (2026-08)
- Content density reduced: concise hero ("Automated Arbitrage. Made Simple." + one-line subtitle + "Demo → Live → 14 Days → $7/month" trust line), visual vertical flow diagram (Market prices → Price discrepancy → Arbitrix identifies opportunity → Automated execution → Trade recorded), Demo vs Live comparison card, compact 14-day/pricing/withdrawal/security sections.
- FAQ reduced from 24 → 9 high-value questions (q1..q9): What is Arbitrix / What is arbitrage / How does Demo Mode work (notes Demo uses same live market data as Live account, result matches, but Demo perf ≠ Live perf) / Does Demo use real money / How does Live Mode work / Do I need to subscribe before trading Live / How does the 14-day Live period work / How much is Arbitrix Pro / How do withdrawals work. Old q3..q26 keys removed.
- Footer: 3 compact columns (Product/Legal/Contact) + copyright + risk disclaimer. Placeholder social links removed (none were configured).
- Support FAB unchanged (48px circle, bottom-right; RTL → bottom-left). No layout regressions.
- i18n: ALL 6 languages (en/es/pt/fr/ar/zh) rebuilt with identical section structure, 9-question FAQ, same pricing/14-day/risk disclosures. RTL confirmed for ar (dir=rtl). Early-duplicate hero.subtitle/footer.* keys (defined before the per-lang landing block) were also shortened so they don't override the new concise copy.
- OVERFLOW FIX: grid items had default min-width:auto → long localized strings overflowed viewport at ~430px. Added `min-width:0` + `overflow-wrap:anywhere; word-break:break-word` to .landing-trust-grid/.landing-trust-item/.landing-trust-text, .landing-compare(+card), .landing-split-cards(+card), .landing-feature-grid-2>*, .landing-asset-grid(+card), .landing-capital-box, .landing-risk-disclosure, .landing-risk-box. Verified: no horizontal overflow at 320/360/375/390/412/430px x6 langs (puppeteer-core + /usr/bin/chromium).
- TESTING: /tmp/overflow_test.js (mobile widths x6 langs), /tmp/rtl_test.js (ar RTL), /tmp/desktop_test.js (1280px content/FAQ check). node --check on extracted inline JS = OK.
- NOTE: The 14-day introductory Live period is communicated per the Phase 8C brief. AGENTS.md previously flagged this as NOT implemented in code (subscription is explicit opt-in via activateSubscription). Confirm with user that 14-day-free-period behavior is intended/implemented before relying on this wording — content was added per explicit user instruction in this phase.


## PHASE 8D — HOW IT WORKS / 5-STEP MOBILE TIMELINE (2026-08)
- Root cause: on mobile `.landing-steps` was `flex-direction:column` but kept `align-items:flex-start` (desktop), so `.landing-step` items shrank to content width (~240px at 390px viewport) instead of stretching — text centered in a narrow column, excessive wrapping + 14px body text.
- Redesign: mobile-first vertical timeline using CSS grid (grid-template-columns: auto 1fr) per step — 52px numbered circle on the left, content fills remaining width to the right edge. Body text 16px, step headings 20px. Connector is an absolutely-positioned 2px vertical rail at left:46px (center of circle) running from below each circle to the next.
- Desktop (>=900px): horizontal 5-step row with centered cards + horizontal connector segments; mobile layout is independent.
- HTML: moved each `.landing-step-connector` from a sibling of `.landing-step` to a child (before the step closing div) so the absolute-positioned left rail resolves against the relative `.landing-step`. 4 connectors for 5 steps (last step hides its connector).
- Page-wide mobile readability pass: added `@media (max-width:768px)` block bumping important body text to >=15-16px (hero subtitle, section subtitles, prose, compare note, intro/split-card/withdraw points, FAQ answers 16px, risk/pricing-capital/security-desc 14.5-15px). Desktop sizes preserved. Did NOT shrink text to fit — increased width/reduced padding instead.
- Verified (puppeteer-core + chromium): no horizontal overflow at 320/360/375/390/412/430px x6 langs; all important body text >=15px; step content uses full container width (e.g. 350/350 at 390px); desktop row layout intact; Arabic RTL ok.

## PHASE 9 — MARKETING SANDBOX / MARKETING DEMO ENVIRONMENT (2026-08, server.js + public/index.html + new migration 013 + tests/marketing_sandbox.test.js)
- A dedicated, fully server-side-isolated MARKETING_SANDBOX account environment
  for marketing/content/screenshots/demos/training. It mirrors the real
  customer UX (deposit -> invoice/QR/polling -> confirmed; bot -> trades -> P&L;
  withdraw; subscription panel; transactions) with EVERY financial operation
  simulated. It can NEVER move real money: it never reaches PaymentService /
  payment providers / webhooks / blockchain or exchange execution / production
  wallets / production deposits / the production withdrawal queue /
  charge_subscription_safe / record_trade_safe / KYC / admin analytics.
- CLASSIFICATION: `users.environment` (migration 013), `'PRODUCTION'` (default) |
  `'MARKETING_SANDBOX'`, CHECK-constrained and IMMUTABLE (BEFORE UPDATE trigger
  users_environment_immutable). Never derived from demo/live flags. The column
  is set ONLY by public registration (always PRODUCTION; client-supplied
  `environment` in the register body is explicitly stripped and NEVER copied)
  or by the admin-only POST /api/admin/sandbox/accounts. There is NO UI/API
  path that converts sandbox<->production. Every sandbox table row also has
  `is_simulated=true` (CHECK-locked).
- SERVER-SIDE ISOLATION (defense in depth, NEVER frontend-trusted):
  1. `users.environment` is the single source of truth (JWT embeds it but the
     server re-reads it from the DB per request; any tampered/missing value is
     treated as PRODUCTION - fail-safe).
  2. Every production financial route (deposit request/status, payment
     create/invoice/cancel/check/history, withdraw request/history, /api/trade,
     /api/transactions, /api/bot/*, /api/subscription*) has a FIRST-statement
     branch: `if (await sandboxHandled(req,res,handleSandboxX)) return;`.
     Production code continues unchanged for normal users (server.js diff is
     additive; production statements byte-unchanged - pinned by tests).
  3. All sandbox handlers (server.js ~line 446-1750) use supabaseAdmin and
     touch ONLY sandbox_* tables / sandbox_* RPCs. KYC writes are 403-blocked
     for sandbox (blockSandboxKyc); can-withdraw special-cases sandbox to
     `canWithdraw:true` WITHOUT weakening the production KYC gate.
  4. DB backstop: BEFORE INSERT OR UPDATE triggers on ALL production financial
     tables (wallets, trades, deposits, withdrawals, transactions, subscriptions,
     subscription_charges, payment_invoices) plus referrals (custom guard checks
     BOTH referrer_id and referred_id). UPDATE coverage makes user_id pivots
     impossible; the wallet guard validates whenever live_balance changes OR
     user_id pivots. RAISE if the row's user is MARKETING_SANDBOX. So even a
     hypothetical future route that forgets to branch fails loudly in the DB.
  5. Migration 013's trailing DO $$ self-check block asserts the immutability
     trigger + all 9 backstop triggers exist (raises EXCEPTION otherwise).
- Withdrawal lifecycle (simulated): pending (debited at request) -> processing
  (~20s) -> completed (~75s) via lazy advance; admin can force any state.
  'rejected' is a TERMINAL fourth state that refunds the debit-at-request
  amount EXACTLY ONCE (row-locked, mirrors production admin reject refund);
  completed cannot be rejected; rejected cannot flow back. Failed withdrawals
  can therefore never permanently debit the sandbox.
- SANDBOX TABLES (migration 013, RLS disabled + service-role-only access, same
  model as Phase 8 subscriptions): sandbox_wallets (balance, intro_day 1..15,
  badge_hidden), sandbox_deposits (pending/confirmed/expired/cancelled + unique
  idempotency), sandbox_withdrawals (pending/processing/completed/rejected,
  debit-at-request, rejected refunds once), sandbox_trades, sandbox_transactions,
  sandbox_subscriptions (active|payment_due|inactive|cancelled),
  sandbox_subscription_charges (UNIQUE idempotency anchor), sandbox_bot_sessions.
- SANDBOX RPCs (SECURITY DEFINER, mirror the production patterns: idempotency
  check -> FOR UPDATE -> double-check -> mutate -> ledger; each FIRST calls
  assert_sandbox_user(p_user_id)): sandbox_ensure_wallet, sandbox_set_balance,
  sandbox_credit_deposit, sandbox_record_trade, sandbox_charge_subscription
  (insufficient -> payment_due, $0 charged, no debt), sandbox_request_withdrawal
  (debit-at-request, like production), sandbox_set_withdrawal_status,
  sandbox_reset_account (one-click reset: balance=0, intro_day=1, badge_hidden=
  false, bot stopped, all sandbox rows deleted).
- SIMULATED UX (mirrors production response shapes 1:1): deposit -> creates a
  sandbox invoice (FAKE `T`-prefixed TRC20 address, no blockchain) with both
  legacy-deposit AND new-invoice response shapes; lazy state advancement
  (pending ~8s -> confirmed, credit once; ~3 min -> expired) so the normal
  deposit modal + progress indicator + polling + "success" UX work unmodified.
  Withdraw: no KYC / no $700 min / no trade-count gates (skipped only inside
  the sandbox branch + frontend display gates), balance-only; submitted ->
  pending ~20s -> processing ~2 min -> completed (lazy), admin-overridable.
  Subscription: 14-day intro model (intro_day 1..15; >14 = ended) + $7/month
  simulated deduction on GET/activate (period-keyed idempotency, server-derived
  key only); payment_due on insufficient; next billing date; cancel/reactivate.
- MARKETING CONTROLS: /api/sandbox/* (self: state/reset/balance/intro-day/badge,
  all behind sandboxOnlyMiddleware) and /api/admin/sandbox/* (list/create
  accounts, reset, set balance $0/$1k/$5k/$10k/$50k/custom, generate N demo
  trades w/ avgPnl+jitter+asset, bot start/stop, intro-day, subscription
  due/charge, withdrawal status control, badge show/hide). EVERY admin control
  re-verifies server-side `target.environment === MARKETING_SANDBOX`
  (requireSandboxTargetUser) -> 403 otherwise. Admin "Sandbox" tab in
  public/index.html (loadSandboxAccounts, createSandboxAccount w/ one-time
  credentials display, sandboxSetBalance, sandboxResetAccount,
  sandboxGenerateTrades, sandboxBotAction, sandboxSetIntroDay, sandboxSubDue,
  sandboxSubCharge, sandboxWithdrawalStatus + loadSandboxWithdrawals,
  sandboxBadge). Frontend shows a "MARKETING DEMO" badge (#sandboxBadge) +
  intro-day chip (#sandboxIntroChip); badge hidable for clean recordings, but
  the DB classification can NEVER be removed from the UI.
- FRONTEND: APP.environment/sandboxIntroDay/sandboxBadgeHidden adopted from
  /api/auth/me in syncWalletFromServer (display only). trackLandingEvent()
  payloads now carry `environment` so sandbox demos never contaminate real
  customer analytics (reuses existing dataLayer/ANALYTICS_ENDPOINT infra).
  Withdraw modal + startBot MTA gates skip for sandbox (display only).
  61 new i18n keys x6 locales (1226 -> 1227 keys/locale; EN pre-existing values
  unchanged; parity/dup/placeholder verified via vm-eval).
- PRE-EXISTING GAPS CONFIRMED (reported, not invented): the 14-day intro Live
  period and a fixed bot session limit exist ONLY as marketing copy, NOT in
  production code - so the sandbox reproduces them as demo-only state
  (intro_day counter; bot start/stop = "session ending"). Production
  subscription IS backend-implemented (Phase 8). Withdrawal 15-30 min is copy-
  only (production withdrawals stay 'pending'); sandbox simulates
  pending->processing->completed within ~3 minutes. Deposit "Select funding
  method/asset" is a fixed USDT-TRC20 label in production - mirrored.
- VERIFICATION: node --check server.js OK; vm.Script parse of all 5 inline
  <script> blocks OK; i18n vm-eval parity 1227 keys x6, 0 problems (61 new
  sandbox keys present, 0 dups, 0 placeholder mismatches, all data-i18n refs
  defined; the only 6 flagged "problems" are PRE-EXISTING landing.howItWorks.*
  duplicate keys identical to baseline). tests/marketing_sandbox.test.js 58/58
  (classification/immutability/is_simulated, backstop triggers, sandbox RPC
  env-assert + no production-table access, route-branch ordering BEFORE any
  production code on all 17 branched routes, KYC block, sandbox handlers touch
  no production tables/RPCs/PaymentService, self/admin controls verify env
  server-side, register cannot create sandbox accounts, reverse-regression:
  production /api/trade/withdraw/deposit-status/subscription byte-unchanged,
  pure-JS mirrors for charge/trade/withdraw/reset, frontend wiring, analytics).
  npm test = 166 pass / 1 fail (the single fail is the PRE-EXISTING
  tests/q8qpay.webhook.test.js `Cannot find module 'express'` env failure -
  identical to baseline; no regression). 167 tests total.
- NOT committed/pushed/deployed. Migration 013 NOT applied to production
  (awaiting approval, per spec section 27). Working tree: M AGENTS.md,
  M public/index.html, M server.js, ?? supabase/migrations/013_marketing_sandbox.sql,
  ?? tests/marketing_sandbox.test.js.
