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

## Localization Phase 1 (2026-08, frontend-only in public/index.html)
- A hand-rolled i18n system already existed: `TRANSLATIONS` dict (~262 EN keys
  after this phase) at `public/index.html:~6068`, `t(key, vars)` with
  `{{var}}` interpolation + EN fallback, `applyTranslations()`/`setLanguage()`,
  a header globe dropdown + Profile language row (en/es/fr/ar/zh/pt), and
  RTL/font CSS scaffolding for `ar`/`zh`. Non-EN locales are still English
  placeholders (auto-filled from EN) — NOT translated in Phase 1.
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
- The duplicate early fallback `t()` at `~line 2128` (`window.t = window.t || …`)
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
  (12 placeholder-bearing keys × 5 locales verified). HTML `<strong>` tags in
  `ios.step1`–`ios.step4` preserved; `ios.step1` mirrors EN's pre-existing
  `<strong>…</button>` typo on purpose (do NOT "fix" it inconsistently across
  locales — that would change rendering parity; it is an EN-side bug to fix
  separately if ever).
- Untranslated terms kept as-is by design: MTA, USDT, TRC20, "Google
  Authenticator", "Arbitrix AI", "DEMO"/"LIVE" badges, "P&L" label, $ amounts.
- Backend error strings, email templates, privacy/terms/legal pages, and
  reset-password.html NOT translated in this phase (frontend UI only).
- NOT translated/dynamic-yet (still hardcoded English, future phase): ~101
  `showToast()` literals, 6 `updateCurrentStatus()` deposit-status strings
  (display wording only — underlying `pending`/`confirmed`/`expired`/
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
  existed rather than creating duplicates — e.g. `auth.brand.security.title`,
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
  "10 دولارات"/"50 دولارًا", ES/PT/FR/AR/ZH "stop-loss" lowercase, ZH
  "256-bit SSL" not "256 位 SSL") so the exact token survives translation.
- HTML-markup keys preserved markup across all locales: `landing.hero.title`
  (`<br><span class="landing-gradient-text">…</span>`), `auth.signup.terms`
  and the Phase-1 `ios.step1-4` (`<a>`, `<strong>`), all with 0 tag-parity
  issues. Placeholder parity (`{{time}}` in `auth.2fa.codeExpiry`,
  `{{amount}}/{{min}}/{{needed}}/{{network}}/{{current}}/{{balance}}`) = 0 issues.
- Verification: `node --check`-equivalent parse on all 5 inline `<script>`
  blocks = OK. Standalone extracted-TRANSLATIONS render check across all 6
  locales: 433 keys/locale, identical key sets, 0 empty, 0 placeholder issues,
  0 HTML-tag issues, 0 token-parity issues, EN dictionary unchanged (all 262
  prior values preserved). `npm test` = 36 pass / 1 fail (the single fail is
  the pre-existing `tests/q8qpay.webhook.test.js` `Cannot find module
  'express'` env failure — identical on the unmodified baseline; no regression).
- DELIBERATELY LEFT FOR PHASE 2B (not translated, still hardcoded English):
  ~101 `showToast()` literals, 6 `updateCurrentStatus()` deposit-status
  display strings (underlying `pending`/`confirmed`/`expired`/`cancelled`
  status VALUES + polling/crediting logic untouched), ~7 support-bot reply
  templates, and backend `data.error` passthroughs in auth handlers. Dynamic
  JS-set text (e.g. `landingUserName` greeting, OTP input, password-strength
  label value, countdown timer text) is runtime/data-driven and out of scope
  for this static-HTML phase.

## Localization Phase 2B-1 — Dynamic Frontend Localization (2026-08, public/index.html only)
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
  *: default/bot/deposit/withdraw/bonus/sound/language/hello — keyword MATCHING
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
    * TRANSLATE AT RENDER TIME ONLY. Stored type/detail values NEVER modified —
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
  passthrough — deferred); only its static empty-state labels (kyc.noDocuments/
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
  — deferred to the later backend-error localization phase.
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
  `Cannot find module 'express'` env failure — identical to baseline; no
  regression).
- DEFERRED to Phase 2B-2 (NOT done here): remaining ~handful of admin-view
  hardcoded strings (badge lock tooltips, KYC list row labels built from server
  data, admin activity-timeline activity.title/activity.description ~13470-13488
  which come from the server data.activities — backend passthroughs), and the
  full backend-error localization pass (server.js data.error strings, email
  templates, privacy/terms/legal pages, reset-password.html).
- NOT committed/pushed/deployed (checkpoint pending user confirmation, as with
  the landing-page work).

