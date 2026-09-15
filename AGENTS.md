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

## Telegram support bot (@ArbitrixSupportBot)
- Code: `services/TelegramSupportService.js` (routing/formatting + webhook
  handler factory) and `services/TelegramSupportStore.js` (Supabase mapping).
  Wired in `server.js` right after the q8qpay webhook.
- Routes: `POST /api/telegram/webhook` (secret-token gated),
  `GET /api/telegram/status` and `POST /api/telegram/set-webhook` (both
  `authMiddleware` + `adminMiddleware`).
- ROUTE PATH MATTERS: the webhook is `/api/telegram/webhook`, NOT
  `/api/webhook/telegram` — the generic `app.post('/api/webhook/:provider')`
  registered earlier shadows every `/api/webhook/*` path.
- Tables (migration `027_telegram_support_bot.sql`, RLS service_role-only, so
  the store must use `supabaseAdmin`): `telegram_support_conversations`
  (keyed by `telegram_chat_id`, with `display_name`/`language`),
  `telegram_support_messages` (`conversation_id`, `direction`, `body` — NO
  message-id/update-id column), `telegram_support_escalations`
  (`conversation_id`, `created_at`).
- Because the messages table has no id columns, redelivery idempotency (bounded
  `update_id` deduper) and reply-to threading (bounded group-message-id -> chat
  id map, plus the durable `/reply <chat_id> <message>`) are per-process and
  live in the service, not the DB. The env constants
  `DIRECTION_INBOUND`/`DIRECTION_OUTBOUND` and `STATUS_*` in the service must
  match the applied CHECK literals.
- Support group chat id discovery: the bot is a group admin, so with
  `TELEGRAM_SUPPORT_CHAT_ID` empty an admin sends `/chatid` in the group and the
  bot replies with the id to paste into the env var. Until it is set the bot
  stores messages and acknowledges but cannot forward.
- Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SUPPORT_CHAT_ID`, `TELEGRAM_ADMIN_IDS`
  (comma-separated; commands are refused when empty), `TELEGRAM_WEBHOOK_SECRET`,
  plus `BASE_URL` for the webhook URL. Secrets are never logged/returned;
  webhook `401`s on a missing/mismatched `X-Telegram-Bot-Api-Secret-Token`.

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

## Phase 10 — Bot-Start MTA ($143) Enforcement (2026-08, server.js + public/index.html + tests)
- ROOT CAUSE (3 holes): (1) `handleSandboxBotStart` created a running sandbox bot
  session with NO balance/MTA check at all; (2) production `/api/bot/start`
  checked `mode === 'live' && wallet.live_balance < 143` but TRUSTED the
  client-supplied `mode`, so `mode:'demo'`/missing/garbage bypassed the gate
  while still creating a running session; (3) frontend `startBot()` explicitly
  EXEMPTED MARKETING_SANDBOX from its MTA gate
  (`&& APP.environment !== 'MARKETING_SANDBOX'`) — and the web UI never calls
  /api/bot/start (bot trading is a client-side setInterval -> /api/trade), so
  the client gate was the only gate for UI users.
- FIX (smallest safe): new module const `BOT_MIN_TRADING_BALANCE = 143` (value
  unchanged) near the ENV constants. Production route: mode is normalized
  server-side (`req.body.mode === 'demo' ? 'demo' : 'live'` — default-deny so a
  missing/unexpected mode can never bypass), balance is server-read via
  getWallet + Number()-coerced, MTA check runs BEFORE the bot_sessions upsert
  (HTTP 400 `{error:'MTA not reached'}` — same error string as before).
  Sandbox handler: reads the simulated wallet via `getSandboxWallet`
  (auto-creates a $0 wallet → blocked) and applies the SAME check BEFORE the
  sandbox_bot_sessions upsert. Frontend `startBot()`: sandbox exemption
  removed; blocked toast now uses the concise new key `bot.mtaBlocked`
  ("Minimum trading balance is $143 to start the bot.") added to all 6 locales
  after `bot.reachMTA` (dictionaries 1227 -> 1228 keys/locale).
- PRESERVED: $143 value, $50 min deposit, $50 promo Live credit (lands in
  live_balance=50 < 143 → correctly blocked), $1,000 Demo balance, $7
  subscription (fully separate — no MTA requirement added to subscription),
  Demo Mode ungated, trading strategy/execution (`/api/trade` intentionally has
  NO MTA gate so already-running sessions behave exactly as before; a restart
  goes through the same gated start path), `/api/bot/stop` never gated,
  migration 013, sandbox isolation. Admin `/api/admin/sandbox/:userId/bot`
  start/stop is a deliberate marketing staging override (left unchanged).
- Test pins UPDATED for the intentional change: marketing_sandbox.test.js
  "frontend sandbox gate skips" (bot MTA gate must NOT exempt sandbox),
  subscription_eligibility.test.js CASE 4 + "MTA remains $143" (old literal
  `wallet.live_balance < 143` → the new `BOT_MIN_TRADING_BALANCE` form; the
  semantic pin "MTA stays $143" is unchanged).
- Tests: NEW tests/bot_mta.test.js (18 tests: prod matrix 0/50/142.99/143/>
  143, sandbox matrix, fake-client-balance + fake-mode security, no-session-on-
  block ordering, demo preserved, restart blocked, i18n 6-locale parity incl.
  exact EN message, /api/trade + /api/bot/stop + subscription regression pins).
  `npm test` = 239 pass / 1 fail (the single fail is the pre-existing
  tests/q8qpay.webhook.test.js `Cannot find module 'express'` env failure —
  identical to the 221/1 baseline; no regression). node --check server.js OK;
  all 8 inline index.html script blocks parse (vm.Script).

## Phase 11 — Multilingual UI / Responsive Layout Resilience (public/index.html + tests)
- Frontend-only CSS/HTML resilience for the 6 locales (en/es/pt/fr/ar/zh). NO
  financial/backend logic (trading, deposits, withdrawals, subscriptions, MTA,
  KYC, auth, Marketing Sandbox) touched; server.js unchanged; no translation
  VALUES rewritten for length (dictionary parity preserved, 1231 keys/locale).
- ROOT CAUSES found by browser audit (puppeteer-core + chromium, stubbed fetch,
  all 6 locales x 320/375/390/430/1280px): legitimate longer translations
  overflowed inside (a) the admin tables (no horizontal-scroll wrapper), (b)
  the Ops sub-tabs container (display:flex without flex-wrap), (c) the sandbox
  custom-balance flex row (inline flex, no wrap), and components relied on
  buttons/tabs/badges never wrapping (no white-space:normal / flex-wrap /
  table-wrap). English looked fine only because its labels are shortest.
- FIX (smallest safe):
  - `.btn{min-width:0;max-width:100%;height:auto;line-height:1.35;
    white-space:normal;overflow-wrap:break-word}` — long labels wrap/grow
    vertically instead of overflowing/clipping (no fixed width, no font shrink).
  - `.mode-tabs{flex-wrap:wrap;max-width:100%}` + `.mode-tab{white-space:normal}`
    — ALL tab pills (incl. Admin Sandbox tab) stay reachable by wrapping.
  - `.table-wrap{overflow-x:auto}` + `.table-wrap table{min-width:max-content}`
    — the 6 admin tables (users/deposits/withdrawals/KYC/subscriptions/referral-
    audit) scroll horizontally INSIDE a wrapper; cells never clipped.
  - `.status-badge{white-space:normal;overflow-wrap:break-word}` — the localized
    subscription status pill wraps instead of pushing price/buttons out.
  - `@media (max-width:640px){ .sandbox-balance-row{flex-wrap:wrap} }` + a
    `sandbox-balance-row` hook on the custom-balance row — sandbox balance
    buttons wrap on phones.
  - Ops sub-tabs container given inline `flex-wrap:wrap`.
- VALIDATION: node --check-equivalent (vm.Script) on all 4 inline <script>
  blocks OK. Browser re-audit after fix: 0 real (non-table) overflow, 0 clipping,
  0 overlap across all 6 locales x 320/390/1280px on profile/subscription,
  deposit, verification, admin-ops, admin-sandbox, admin-subscriptions, MTA
  toast, referral surfaces; landing + app shells clean at 320/375/390/430/1280.
  Tables now scroll correctly inside their wrapper. Screenshots verified
  (ar RTL, es, zh at 320/390). Remaining flags in the raw audit are the
  off-canvas mobile sidebar (burger menu), a pre-existing design false positive.
- Tests: NEW tests/multilingual_layout.test.js (9 tests) pinning the CSS
  contract (buttons wrap, tabs wrap, table-wrap scroll, badge wrap, sandbox row
  mobile wrap, ops sub-tabs wrap) + i18n parity (identical key sets, no empties,
  no duplicates across all 6 locales) + all data-i18n refs defined + safety (no
  global overflow hack, no global font-size reduction). `npm test` = 248 pass /
  1 fail (the single fail is the pre-existing tests/q8qpay.webhook.test.js
  `Cannot find module 'express'` env failure — identical to baseline; no
  regression). body{overflow-x:hidden} is a PRE-EXISTING baseline rule
  (Phase 8C) that was NOT added or removed by this phase.

## Phase 12 — Mobile Navigation Drawer + Header/Dashboard Density (2026-08, public/index.html CSS-only + tests/mobile_nav_layout.test.js)
- Frontend-only UI/responsive fix. NO changes to deposits/withdrawals/trading/
  bot/MTA/subscription/promo-credit/min-deposit/auth/2FA/KYC/sandbox isolation/
  schema/migrations/payment providers. server.js untouched. No translation
  VALUES changed (dictionary parity preserved; no new keys needed).
- SHARED vs SANDBOX-SPECIFIC finding: Production Demo, Production Live, and
  MARKETING_SANDBOX all use the SAME app shell (sidebar/header/ticker/stats).
  The mobile nav issues were SHARED by all modes (NOT sandbox-specific). The
  only sandbox-specific issue was the MARKETING DEMO badge's RTL position.
- ROOT CAUSES (measured via puppeteer-core + /usr/bin/chromium, stubbed fetch):
  1. `.sidebar{width:260px}` fixed for ALL widths -> 81% of a 320px viewport,
     leaving only ~60px of dashboard visible. Fix: `max-width:78vw` on the same
     base rule (260px is unchanged at >=334px; 320px gets ~250px so ~70px of
     the dashboard + overlay remains visible/tappable).
  2. Hamburger (`#mobileMenuBtn`, z-index 1001, fixed top-left) rendered ON TOP
     of the open drawer (z-index 1000), covering the drawer's brand area.
     Background also remained scrollable while the drawer was open. Fix (CSS
     only, no JS state to go stale): `body:has(.sidebar.open){overflow:hidden}`
     and `body:has(.sidebar.open) .mobile-menu-btn{opacity:0;pointer-events:
     none}`. Graceful degradation: pre-Chrome-105 / pre-Safari-15.4 browsers
     (no :has) keep the old behavior.
  3. Header vertical stack was legitimately tall but had removable dead space:
     `.app-header` gap 12px + margin-bottom 16px, `.ticker-wrapper`
     margin-bottom 14px. Fix: a NEW `@media (max-width:640px)` block AFTER the
     base rules (cascade matters — an earlier attempt placed it before the base
     `.app-header` rule and silently did nothing): `.app-header{gap:8px;
     margin-bottom:12px}` + `.ticker-wrapper{margin-bottom:10px}`. Stat cards
     rise ~12px at every mobile width. `.app-header{padding-top:44px}` KEPT —
     it is the necessary clearance for the fixed 44px hamburger; the header has
     NO fixed height (content-driven, wraps).
  4. RTL ONLY + SANDBOX ONLY: `#sandboxBadge` is inline-styled `top:12px;
     right:12px`; in `ar` (dir=rtl) the hamburger moves to the physical RIGHT
     (`html[dir="rtl"] .mobile-menu-btn{right:12px}`) so the badge OVERLAPPED
     the hamburger (measured x-ranges intersected). Fix: `html[dir="rtl"]
     #sandboxBadge{right:auto !important;left:12px !important}` (!important
     required to beat the inline style). Badge remains visible/unambiguous in
     all locales; in LTR it stays top-right.
- NOT changed (deliberately): the drawer's 1px dark `--border-color` edge (the
  prominent GOLD edge the user saw is the `.sidebar-link.active` 3px gold
  active-item indicator — by design) ; the overlay rgba(0,0,0,0.6) (existing);
  the mode-tabs full-width row at <=379px (needed so DEMO/LIVE stay reachable);
  no drawer redesign (same off-canvas pattern, just width-capped).
- Landing page unaffected (landing CSS untouched). Desktop (>=640px: 220px
  static sidebar; >=1024px: 240px) byte-unchanged and verified at 1280px.
- Measured post-fix (all 60 scenarios: 2 environments x 6 locales x
  320/375/390/430/1280): documentElement.scrollWidth == innerWidth (0px
  horizontal overflow) with the drawer open AND closed; drawer width 250px@320
  / 260px@375 / 260px@390 / 260px@430; all 12 sidebar links inside the drawer;
  overlay click + hamburger toggle close reliably (LTR and RTL); drawer scrolls
  internally (overflow-y:auto); body scroll locked while open; MARKETING DEMO
  badge never overlaps the notification button or hamburger in any locale;
  Spanish (longest labels) wraps the header to ~222px at 320px with NO
  clipping/overlap (legitimate wrapping, per spec).
- Tests: NEW tests/mobile_nav_layout.test.js (14 tests): drawer viewport cap +
  fixed/scrollable/z-index contract, off-canvas transform (no page overflow),
  :has() scroll-lock + hamburger-hide rules, badge element/i18n wiring intact +
  sandbox.badge key non-empty in all 6 locales, RTL badge override, .app-header
  NO fixed height + compaction block placed AFTER base rules, desktop
  220px/240px rules intact, i18n parity (identical key sets, no empties; dup
  detector bounded to the TRANSLATIONS object span so it doesn't over-read into
  BACKEND_MESSAGE_MAP; whitelists ONLY the pre-existing baseline
  landing.howItWorks.*/landing.faq.tag|title dups), no global overflow hack,
  sidebar nav structure intact.
- Baseline-vs-fixed: baseline 248 pass/1 fail -> fixed 262 pass/1 fail (+14 new
  tests). The single fail is the PRE-EXISTING tests/q8qpay.webhook.test.js
  `Cannot find module 'express'` env failure (node_modules not installed) —
  identical to baseline; no regression.
- KNOWN BASELINE GAP (documented, not fixed here): pre-existing duplicate i18n
  keys landing.howItWorks.* (10 keys) + landing.faq.tag/title in all 6 locales
  (identical values; eval keeps the last). Cosmetic only; a cleanup pass should
  remove the first occurrences in a separate PR.

## Phase 13 — Spanish Demo-Mode Header Wrap Fix (2026-08, public/index.html CSS-only + tests/mobile_nav_layout.test.js)
- Follow-up investigation to PR #97 (Phase 12) for a confirmed real-world repro:
  MARKETING_SANDBOX -> Demo Mode -> runtime language switch EN -> Español ->
  mobile (~390px). Frontend-only CSS; NO financial/backend/i18n-value changes.
- VERDICT: The PR #97 mechanics (drawer cap/scroll-lock/hamburger-hide/RTL
  badge) fully held under the exact runtime repro — the switch harness
  (Chromium, stubbed fetch, EN->ES->EN->ES with drawer open/close + scroll)
  showed 0px horizontal overflow, no stuck-open drawer, no progressive drift,
  and a ROUND-TRIP-PERFECT layout in both environments and all modes. The
  screenshot's remaining complaint (tall header / content pushed down) was a
  REAL residual density bug PR #97 did not cover:
- ROOT CAUSE: `.app-header-right{display:flex;flex-wrap:wrap;gap:8px}`
  contains #accountStatus + #userName + sound + language + notifications.
  In DEMO mode the localized accountStatus is long (es "Trading demo • Fondos
  virtuales" = 155px). Status 155 + userName ~60-90 + gaps + 3x44px buttons
  EXCEEDS one row at <=390px -> the controls wrap to a SECOND line
  (headerRight 44px -> 96px), adding ~52px of header height: 185px at 390px,
  222px at 320/375. Spanish/Portuguese/French widen the status text by
  ~10-15px vs English, which is why the wrap showed most clearly after
  switching to Spanish. SHARED by Production Demo and Sandbox Demo (same
  shell); Live unaffected ("Trading en vivo..." is shorter); not
  Spanish-specific (en/fr/pt wrap too at the same widths in demo mode).
  NOTE: the language switch itself is NOT broken — the same wrap happens with
  Spanish loaded before page load (verified in the Phase 12 matrix: hdr 222px
  @320 for es/pt/fr).
- FIX (2 CSS lines inside the existing Phase 12 `@media (max-width: 640px)`
  compaction block): `.app-header-right{gap:6px;}` +
  `.app-header-right #userName{display:none;}`. The header userName is
  redundant on mobile (the sidebar status block already shows #displayName +
  the account badge). Result: header controls fit on ONE line at >=342px in
  demo mode for ALL 6 locales: 390px demo header 185 -> 133px (matches Live;
  ticker 213 -> 161, stats 265 -> 213); 375px 222 -> 170; 320px es/pt/fr
  222 -> 220 (status+controls still legitimately wrap ~2px at the extreme
  width — allowed; en/ar/zh 222 -> 170). Desktop (>=641px) UNCHANGED:
  userName visible, header 44px (verified 1280px en+es).
- Harness lessons: (a) `await initApp()` before setMode — initApp auto-switches
  funded accounts to live, so a pre-setMode gets overridden; (b) fresh browser
  context per scenario — arbi_mode persists in localStorage across pages.
- Verification: runtime-switch harness (EN->ES->drawer open/close->scroll->
  EN->ES->drawer again) at 390px x {sbx-demo, prod-demo, prod-live} + post-fix
  at 320/375/390/430/1280: 0 overflow everywhere, docH/header round-trip
  perfect (no progressive drift), drawer never stuck, badge never overlaps.
  Baseline (pre-#97, worktree 6934840) rerun of the same repro confirms the
  pre-fix state (header 189px, stats y=277, drawer full 260px, no scroll
  lock). Demo-mode matrix all 6 langs x 320/375/390/430/1280 x both
  environments: post-fix headers above; 0 hOverflow.
- Tests: tests/mobile_nav_layout.test.js 14 -> 16 tests (new: userName hidden
  only inside the mobile media block + element still in DOM; desktop base
  .app-header-right rule unchanged). npm test = 264 pass / 1 fail (same
  pre-existing q8qpay.webhook express env failure; no regression).


## Phase 14 — Subscription Discoverability & Profile UI (public/index.html + tests, frontend-only)
- PROBLEM: the Arbitrix Pro subscription UI was only reachable deep inside Profile
  Settings (below display name / email / language / sound). Users could not find
  activation, billing status, next payment, or cancellation; Profile Settings
  itself was unnecessarily long (933px scrollHeight @390px mobile).
- AUDIT (read-only, confirmed before changes): subscription logic lived at
  loadSubscriptionStatus()/renderSubscriptionPanel()/activateSubscription()/
  cancelSubscription() (~L3560-3700) + one #subscriptionPanel embedded in the
  profile modal. NO sidebar entry, NO header/menu shortcut, NO dashboard
  shortcut. server.js subscription endpoints + Phase 8 financial logic complete
  and untouched. All UI elements exist as real elements; no dead controls.
- WHAT SHIPPED (smallest safe, REUSE — no duplicated UI):
  1. New sidebar entry "Subscription" (#subscriptionSidebarLink, crown icon,
     data-i18n sidebar.subscription) between Referral and the divider ->
     openSubscriptionModal() (closes the mobile drawer + overlay, opens
     #subscriptionModal, reloads server status).
  2. The SINGLE existing #subscriptionPanel (badge, price, details, activate/
     cancel, sandbox intro chip) was MOVED into a new dedicated
     #subscriptionModal (reuses .modal-overlay/.modal-content classes; no new
     CSS). Exactly one panel instance; original activate/cancel wiring intact.
  3. Profile Settings keeps a compact summary card (#subscriptionProfileCard:
     crown + "Arbitrix Pro" + #subscriptionStatusBadgeProfile + localized
     Manage button -> openSubscriptionModal()). renderSubscriptionPanel mirrors
     the panel badge text+class onto the profile badge (single source of
     truth). Profile modal scrollHeight @390px es: 933px -> 791px.
  4. STALE-TEXT FIX (pre-existing defect, made reachable by the new entry):
     the active-state "Next payment: <date>" sentence was inserted as raw
     locale-formatted text and did NOT update on language switch until the next
     fetch. renderSubscriptionPanel now localizes details via t() directly (no
     data-i18n spans, no applyTranslations() call — recursion-safe), and
     updateDynamicTranslations() re-runs renderSubscriptionPanel(_subscriptionState)
     (guarded) so switching language re-renders details + locale-formatted date
     without a re-fetch. NOTE: applyTranslations() CALLS updateDynamicTranslations(),
     so renderSubscriptionPanel must NEVER call applyTranslations() — pinned by test.
- UNCHANGED (pinned by tests): demo-mode activation still short-circuits to the
  switch-to-Live toast BEFORE any fetch; live-without-deposit still yields the
  existing depositRequired/depositMore toasts; activate still sends an empty
  {} body (server is the sole authority on price/user/period); the frontend only
  ever calls the 3 existing endpoints (/api/subscription, /activate, /cancel) —
  server-side sandbox branching (subscription_eligibility.test.js) untouched.
  No new CSS, no new endpoints, no eligibility/financial/backend changes,
  server.js byte-identical, subscription NEXT-payment behavior unchanged,
  no auto-subscribe, no free-activation.
- i18n: 1231 -> 1233 keys/locale (NEW: sidebar.subscription, subscription.manage)
  in all 6 locales; identical key sets, 0 empty, 0 dups. Manage button uses
  margin-inline-start (RTL-safe).
- PRE-EXISTING issues observed (documented, NOT fixed, out of scope):
  `updateDynamicTranslations error: ReferenceError: updateVerificationModalHeader
  is not defined` logged once during initial page load (script-block ordering;
  caught by try/catch; identical on the pre-Phase-14 baseline).
- VERIFICATION: node --check-equivalent (vm.Script) on all 4 inline <script>
  blocks OK. Browser audit (puppeteer-core + chromium, stubbed fetch):
  2 env (PRODUCTION / MARKETING_SANDBOX) x 2 modes x 5 widths (320/375/390/430/
  1280) x 6 langs = 120 scenarios, BAD 0 — hOv=0 everywhere, modal opens from the
  sidebar link, drawer closes on click, demo gate blocks before any network call
  (fetchDelta=0) with the switch-to-Live toast, live activation fires exactly 1
  request, sandbox shows chip + simulated badge, profile card mirrors the badge,
  profile modal no longer contains the panel. Language-switch details re-render
  verified (en "Next payment: Sep 21, 2026" -> es "Próximo pago: 21 sept 2026"
  -> ar "الدفع القادم: 21 سبتمبر 2026"). Screenshots: /tmp/shots/SUB-*.png.
- Tests: NEW tests/subscription_nav.test.js (12 tests): sidebar entry wiring,
  modal open flow, single-panel uniqueness + all panel ids inside the modal,
  profile compact card (no panel, no activate btn), badge mirroring, demo gate
  order, deposit toasts, no-new-endpoints, i18n parity, recursion-safe render
  hook, RTL-safe margin. npm test = 276 pass / 1 fail (the single fail is the
  pre-existing tests/q8qpay.webhook.test.js `Cannot find module 'express'` env
  failure — identical to baseline; no regression).

## Phase 15 — MARKETING_SANDBOX Default Demo Balance $1,000 (2026-08, server.js + tests)
- PROBLEM: a newly created MARKETING_SANDBOX account started Demo Mode at $0,
  while the normal Arbitrix experience starts a new production user's Demo Mode
  at $1,000. Inconsistent demo experience for marketing screenshots/recordings.
- ROOT CAUSE (diagnosed before changing anything): `getSandboxWallet()`
  (server.js) hardcoded `demo_balance: 0` in the wallet response shape returned
  by `/api/auth/me`. Production `getWallet()` seeds new users with
  `demo_balance: 1000`. The `sandbox_wallets` table (migration 013) has NO demo
  column BY DESIGN — demo trading has no server ledger (demo-mode trades are
  client-side only; `executeBotTrade` calls `saveData()` but never POSTs
  /api/trade in demo mode), so the demo balance is a pure READ-TIME response
  value, not a stored balance. The frontend `syncWalletFromServer()` adopts
  `wallet.demo_balance` verbatim → sandbox demo showed $0. Migration 013 was
  NOT the bug and is NOT modified.
- FIX (smallest safe, server.js only): new module const
  `SANDBOX_DEMO_BALANCE = 1000` (next to BOT_MIN_TRADING_BALANCE) +
  `getSandboxWallet` returns `demo_balance: SANDBOX_DEMO_BALANCE` instead of 0.
  No DB change, no migration change, no schema change, no stored balance
  altered. The value is computed at read time, so EXISTING sandbox accounts
  automatically show $1,000 demo on next sync — nothing is silently altered in
  the DB (no reset/migration operation needed or performed).
- SAFETY (pinned by tests/sandbox_demo_balance.test.js, 12 tests): the $1,000
  is ONLY the simulated demo seed — never stored, never a deposit, never a
  ledger entry, never feeds live_balance. live_balance still derives ONLY from
  sandbox_wallets.balance (DEFAULT 0). Sandbox account creation still inserts
  ONLY into users + sandbox_wallets (no production `wallets` row, no deposit,
  no transaction). Migration 013 schema + backstop triggers
  (assert_user_not_marketing_sandbox / assert_wallet_not_marketing_sandbox)
  byte-unchanged. Production wallet init unchanged (demo 1000 / live 50 promo /
  bonus 0). $143 MTA unchanged (sandbox bot gate still on live_balance only).
  Subscription eligibility unchanged. Switching to Live does NOT convert the
  demo $1,000 into live funds (live stays $0; the simulated deposit flow is
  still required). The frontend demo display path is unchanged.
- VERIFICATION: `node --check server.js` OK. Browser audit (puppeteer-core +
  chromium, stubbed /api/auth/me returning the fixed shape): 6 languages
  (en/es/pt/fr/ar/zh) × 5 widths (320/375/390/430/1280px) = 30 scenarios, BAD 0
  — Demo shows $1000.00 everywhere, Live shows $0.00, demo→live→demo switching
  never converts the demo balance, hOv=0 (no horizontal overflow).
- TESTS: NEW tests/sandbox_demo_balance.test.js (12 tests). npm test = 288
  pass / 1 fail (the single fail is the pre-existing
  tests/q8qpay.webhook.test.js `Cannot find module 'express'` env failure —
  identical to baseline; no regression). 289 tests total.

## Phase 16 — Sandbox Badge Label "PREVIEW" (2026-08, public/index.html + tests, frontend-only)
- Label-only change: the visible MARKETING_SANDBOX badge text changed from
  "MARKETING DEMO" to "PREVIEW" (less distracting in controlled marketing
  presentations while still clearly indicating a non-customer account).
- Changed ONLY i18n VALUES: `sandbox.badge` in all 6 locales
  (en PREVIEW / es VISTA PREVIA / pt PRÉ-VISUALIZAÇÃO / fr APERÇU / ar معاينة /
  zh 预览) plus the admin-only `sandbox.admin.showBadge` labels (en "Show Preview
  Badge" + 5 locale equivalents). The badge element (#sandboxBadge), its
  styling, positioning (fixed right:12px LTR; html[dir=rtl] flip to left:12px),
  the t('sandbox.badge') render path, and the display gate
  (`APP.environment === 'MARKETING_SANDBOX'` && !badgeHidden) are all UNCHANGED.
- UNCHANGED: internal classification users.environment='MARKETING_SANDBOX'
  (frontend gate + server ENV_MARKETING_SANDBOX), all sandbox behavior,
  balances, financial/deposit/withdrawal/trading/bot/subscription/KYC/auth
  logic, and production users (production accounts never see the badge).
  Translation key parity preserved (identical key sets, 0 empties).
- VERIFICATION: 7 new tests/sandbox_badge_label.test.js (label per locale,
  i18n-key render path, MARKETING_SANDBOX gate unchanged, styling/RTL hooks
  unchanged, no stray old label, key parity). Browser audit (puppeteer-core +
  chromium, stubbed fetch): 2 environments x 5 widths (320/375/390/430/1280) x
  6 langs = 60 scenarios, BAD 0 — sandbox shows the localized PREVIEW label
  in-viewport (LTR + ar RTL), production shows NO badge, hOv=0 everywhere.
  npm test = 295 pass / 1 fail (pre-existing q8qpay.webhook express env
  failure, unchanged baseline; no regression). 296 tests total.


## Phase 17 — MARKETING_SANDBOX withdraw section: remove "$700 minimum" wording (2026-08, public/index.html + tests)
- Sandbox withdrawals are balance-only (the server sandbox route enforces
  balance-only rules; openWithdrawModal already skips the $700/deposit/trade
  gates for sandbox). The withdraw section still DISPLAYED "$700 minimum" copy,
  which was misleading for MARKETING_SANDBOX accounts. Frontend-only, display-
  only fix; NO changes to server.js, gating logic, or financial constants.
- Two NEW i18n keys added to ALL 6 locales (inserted after their production
  counterparts): `withdraw.infoSandbox` ("No minimum withdrawal | 15-30min
  processing") and `live.withdrawStatus.readySandbox` ("✅ Ready to withdraw").
  None of the 12 values contain "700". Dictionaries 1233 -> 1235 keys/locale;
  production keys `withdraw.info` / `live.withdrawStatus.ready` /
  `withdraw.min700` are byte-unchanged (production still says $700).
- `updateLiveWithdrawStatus()`: added `isSandbox = APP.environment ===
  'MARKETING_SANDBOX'`; in the ready branch renders
  `live.withdrawStatus.readySandbox` for sandbox (sidebar `#liveWithdrawStatus`)
  and `withdraw.infoSandbox` for the modal info box (`#withdrawInfoText`).
  All branch/gate logic (hasDeposit / reachedMTA / MIN_WITHDRAWAL / hasTrade)
  is UNCHANGED — only the display string is swapped.
- `updateDynamicTranslations()` now also calls `updateLiveWithdrawStatus()` so
  a language switch re-renders both texts with the correct variant AFTER
  applyTranslations() refreshes the `data-i18n="withdraw.info"` span (ordering
  verified: data-i18n pass first, dynamic override after).
- UNCHANGED: APP.MIN_WITHDRAWAL=700, Gate 2/3/4 + submitWithdraw production
  checks (still skipped ONLY for sandbox), `withdraw.min700` +
  BACKEND_MESSAGE_MAP (the production server error string; sandbox routes never
  return 'Min $700'), KYC flow, all financial/backend logic.
- Tests: NEW tests/sandbox_withdraw_wording.test.js (6 tests): variant keys
  exist/non-empty/no-"700" in all 6 locales; production $700 keys unchanged;
  vm-executed real updateLiveWithdrawStatus (sandbox -> variant, production ->
  $700, undefined env -> production, non-ready branches unchanged); gate
  constants/structure unchanged; language-switch hook present; i18n parity
  (1235 keys/locale x6, 0 empty). npm test = 301 pass / 1 fail (the single
  fail is the pre-existing tests/q8qpay.webhook.test.js `Cannot find module
  'express'` env failure — identical to baseline; no regression).
- NOT committed/pushed/deployed (checkpoint pending user confirmation).
  Working tree: M public/index.html, ?? tests/sandbox_withdraw_wording.test.js.

## Phase 5 Cleanup — Obsolete Route Removal + Legacy SQL Quarantine (2026-08)
- Removed the obsolete unauthenticated bootstrap routes `POST
  /api/setup/reset-tokens-table` and `POST /api/debug/create-table` from
  server.js, together with their dead helpers `ensureResetTokensTable()` /
  `createResetTokensTable()` (no callers; the RPCs they invoked —
  `create_password_reset_tokens_table`, `exec_sql` — do not exist). Password
  reset itself is untouched (`/api/auth/forgot-password`,
  `/api/auth/reset-password`, `generateResetToken`, `hashToken` remain).
- REMOVED `GET /api/diagnostic` entirely (it publicly exposed a real user id,
  Node version, and the Supabase project ref). Full-repo search showed no
  application/test/doc dependency, so removal (not admin-gating) was chosen.
- `supabase_rls_policies.sql` QUARANTINED with a prominent header (DO NOT APPLY
  TO PRODUCTION; historical legacy file; creates the old permissive `TO anon`
  policies that migration 018 intentionally removes; production security is
  managed by the migration history). NOTE: the audit described the file as
  also containing an outdated Paymento function definition — the current file
  does NOT contain one (grep-verified: no `paymento`, no `CREATE FUNCTION`);
  the header therefore refers to historical revisions only. SQL content below
  the header is byte-identical (sha256-pinned in tests).
- tests/phase5_cleanup.test.js (17 tests): routes gone, diagnostic gone, dead
  helpers gone, password-reset intact, no frontend/script references, header
  present + comment-only prefix, legacy body sha256 + 19 anon-policy count,
  migrations 001/014-018 sha256-pinned, no new setup/debug/diagnostic routes.
- npm test = 439 pass / 1 fail (the single fail is the pre-existing
  tests/q8qpay.webhook.test.js `Cannot find module 'express'` env failure —
  identical to baseline; no regression). 440 tests total.

## Phase 18 — Referral $20 / 10% Commission / Promo-Credit Trading / MTA Single Source (2026-08)
- Management-approved business-logic changes. Preservation mandate honored:
  deposits, minimum-deposit logic, withdrawal sequence + $700 minimum, KYC,
  security checks, trading mechanics, profit calculation, balances, account
  states, referral attribution, anti-abuse, fees, auth, onboarding, payment
  providers and webhooks are all UNCHANGED except where stated below.
- Files changed: `server.js`, `public/index.html`, `.env.example`, new
  `supabase/migrations/020_referral_reward_and_commission.sql`, new
  `tests/referral_promo_mta.test.js`, plus pin updates to
  `tests/bot_mta.test.js`, `tests/marketing_sandbox.test.js`,
  `tests/sandbox_demo_balance.test.js`, `tests/sandbox_withdraw_wording.test.js`,
  `tests/subscription_eligibility.test.js`. NO production MTA change. NOT
  committed/pushed/deployed.

### 1. Referral qualification + $20 reward
- Reward default is now $20, single definition `REFERRAL_REWARD_DEFAULT_USD='20'`
  in server.js. Effective value is still read from `referral_config`
  (`referral_reward_amount`), which migration 020 bumps 10 -> 20 (guarded; a
  deliberately admin-customised value other than the historical '10' is left
  alone and the migration verifier only asserts the value is no longer '10').
- Qualification: a referral QUALIFIES only on the platform minimum deposit
  (`minimum_qualifying_deposit`, default 50 — unchanged). The old
  `isFirstConfirmedDeposit()` gate (which could permanently disqualify a
  referral whose FIRST deposit was below the minimum) was REPLACED by the
  platform-minimum rule in `activateReferralOnQualification()`. Registration /
  onboarding never call it (only confirmed-deposit paths do).
- Anti-abuse intact: `status='pending'` lookup + `bonus_earned>0` double-check +
  `max_rewards_per_user`. Reward credits the existing `bonus_balance`
  (referral-earnings bucket) via `updateWallet`. Exactly once per referral.
- `isFirstConfirmedDeposit()` is now unused but left defined (no test pins its
  removal); `activateReferralOnQualification` is called from the same 4 deposit
  confirm paths as before.
- `/api/referral/config` + `/stats` + `/detailed` use the server default;
  `/api/referral/simulate` now uses the configured reward (no hardcoded 10).
  Frontend: `refRewardAmount`/`refRewardAmount2` defaults + `|| 20` fallbacks.

### 2. Referral earnings withdrawal
- NO new withdrawal path and NO new gate. Reward + commission credit the
  existing `bonus_balance`; moving that to Live uses the EXISTING bonus
  withdrawal flow (>= $50 bonus + >= 1 referral), then the existing withdrawal
  process (KYC, $700 min, balance, address, >= 1 trade) applies unchanged.
- INTERPRETATION FLAGGED: "referral earnings do not require a trade" is read as
  "no NEW referral-specific trading/rollover requirement was added". The
  platform-wide `>= 1 Trade Executed` withdrawal requirement is pre-existing
  and was deliberately NOT bypassed (management explicitly forbade bypassing
  existing requirements). See the final report for the clarification request.

### 3. 10% downline profit commission
- New `creditReferralProfitCommission(downlineUserId, profitAmount, sourceTradeId)`
  called from `/api/trade` right after `record_trade_safe`, ONLY when
  `!result.duplicate && Number(result.applied_amount) > 0`. Profit basis is the
  platform's existing definition (`record_trade_safe` realized P&L = the signed
  `trades.amount`); losses pay nothing and the definition is NOT reinterpreted.
  The trade response/balance/P&L of the downline is untouched; a commission
  failure can never fail the trade (`.catch(() => {})`).
- Rate `REFERRAL_PROFIT_COMMISSION_RATE=0.10`, overridable via referral_config
  `referral_profit_commission_rate` (added to `CONFIG_VALIDATION`, 0..1).
- Attribution preserved: lookup is `.eq('referred_id', userId).eq('status','active')`
  (only QUALIFIED downlines earn), self-referral rejected; sandbox users
  short-circuit.
- Atomic DB work in migration 020: table `referral_commissions` (append-only,
  RLS on, service_role-only) + `credit_referral_commission_safe(...)`
  SECURITY DEFINER mirroring `credit_payment_safe`/`record_trade_safe`
  (validate -> idempotency check #1 -> `FOR UPDATE` wallet lock -> check #2 ->
  credit referrer `bonus_balance` -> ledger row -> `transactions` row type
  `'Referral Commission'` -> EXCEPTION handler returns JSON). Idempotency key
  is server-derived `refcomm_<referralId>_<sourceTradeId>` (UNIQUE) — exactly
  once per source trade. Execute locked to service_role.
- Read-only `getReferralCommissionTotal(referrerId)` (returns 0 if the table is
  absent) feeds `commissionEarned` in `/api/referral/stats` + `/detailed`
  (plus `totalReferralEarnings`). Frontend shows a separate "Profit commission
  earned" row (`#refCommissionEarned`). New TX type mapped render-only:
  `'Referral Commission' -> tx.type.referralCommission` (all 6 locales).

### 4. $50 promotional credit is TRADABLE (not withdrawable until deposit + 1 trade)
- Server: `isPromoFundedTrading(hasConfirmedDeposit, liveBalance)` = no confirmed
  deposit AND positive live balance. `/api/bot/start` exempts promo-funded users
  from the MTA gate. Trading itself still goes through the EXISTING engine
  (`/api/trade` + `record_trade_safe`); NO separate promo trading engine/RPC.
- Frontend: `isPromoFundedTrading()` mirrors the server for UX (bot button in
  `updateUI` + `startBot` gate). New `#promoCreditNotice` disclosure in the Live
  wallet card (`promo.tradableNotice`, 6 locales) — explicitly says the $50 is
  tradable but not withdrawable until a qualifying first deposit + 1 trade.
- Withdrawal: `/api/withdraw/request` APPENDS a gate after the unchanged KYC ->
  $700 -> balance -> address -> >=1-trade sequence: if no confirmed deposit ->
  400 `{ error: 'A qualifying first deposit is required before you can withdraw
  your promotional credit or trading profits.', depositRequired: true,
  requiresFirstDeposit: true }`. The frontend already gates deposit (Gate 3)
  before trade (Gate 4) in `openWithdrawModal`, and `submitWithdrawAPI` renders
  `withdraw.needDeposit` (6 locales, rewritten to the clear eligibility message)
  when `data.depositRequired`. KYC/$700/1-trade requirements unchanged; after a
  qualifying deposit + 1 trade the normal process applies.

### 5. MTA ($143) — single source of truth, NOT changed
- `const BOT_MIN_TRADING_BALANCE = 143` is now consumed ONLY through
  `getEffectiveMta(defaultMta = BOT_MIN_TRADING_BALANCE)`, which reads the single
  optional env override `MTA_AMOUNT` (invalid/absent -> 143). Production MTA is
  STILL 143; $200/$300 are NOT hardcoded anywhere (pinned by tests).
- To select an option later: set `MTA_AMOUNT=200` or `MTA_AMOUNT=300` (documented
  in `.env.example`) — or change the single constant. Enforced server-side at
  `/api/bot/start` and `handleSandboxBotStart` (both on live_balance only; demo
  not gated). `/api/auth/me` returns `mta`; frontend adopts it into `APP.MTA`.
- Frontend MTA consumers: `updateMTAProgress()` (+ new `#mtaTargetAmount`),
  `updateUI()` bot gate + `bot.reachMTA {{mta}}`, `startBot()` + `bot.mtaBlocked
  {{mta}}`, `updateLiveWithdrawStatus()` (`live.withdrawStatus.mtaNotReached
  {{mta}}`), `openWithdrawModal()` Gate 4 (`balance < APP.MTA`), and the
  `mta_unlocked` badge condition/desc. i18n MTA keys now interpolate `{{mta}}`
  instead of hardcoding `$143` (6 locales).
- IMPORTANT side effect for management: the MTA value is ALSO the frontend
  withdrawal-eligibility gate (Gate 4). The SERVER withdrawal route has NO MTA
  check (only KYC/$700/balance/address/1-trade/deposit), so changing MTA changes
  only the client-side withdrawal gate, not server enforcement.

### Verification
- `node --check server.js` OK. `vm.Script` parse on all 6 non-empty inline
  `<script>` blocks OK.
- i18n: 1238 keys/locale x 6 (was 1235; +3 = referral.commissionEarned,
  promo.tradableNotice, tx.type.referralCommission), identical key sets, 0
  empty, 0 placeholder-parity issues.
- `npm test` = 494 pass / 1 fail. The single fail is the PRE-EXISTING
  `tests/q8qpay.webhook.test.js` `Cannot find module 'express'` env failure
  (node_modules not installed) — identical to baseline; no regression.
- Existing pins were updated for the INTENTIONAL changes (startBot promo
  exemption, `bot.mtaBlocked` `{{mta}}` token, `getEffectiveMta(...)` in the
  MTA-gate assertions, i18n key count 1235 -> 1237 -> 1238). New
  `tests/referral_promo_mta.test.js` covers the referral/commission/promo/MTA
  contracts from the brief.
- Migration 020 NOT applied (awaiting approval). The commission endpoints fail
  safe (return 0) and `/api/trade` is unaffected when the table/fn are absent.


## Phase 19 — Referral $20 / 10% Commission / Promo Tradability / MTA $200 (PRODUCTION-ONLY, 2026-08)
- Management-approved business-logic changes. **Every change is PRODUCTION-ONLY:
  MARKETING_SANDBOX keeps its existing referral reward, MTA (143),
  promotional-credit and withdrawal behavior.** No deploy, no push, no
  production migration (020 still unapplied).
- Referral qualification: a referral QUALIFIES only on the referred user's
  platform minimum deposit ($50, existing config `minimum_qualifying_deposit` /
  `MIN_DEPOSIT` — unchanged, not reinvented). Registration/onboarding never
  qualify. `activateReferralOnQualification()` is only called from confirmed
  deposit paths and keeps the pending-status + `bonus_earned` exactly-once
  guards + existing attribution/anti-abuse.
- Referral reward: `REFERRAL_REWARD_DEFAULT_USD = '20'` (was 10). Frontend
  fallback + HTML default are $20. Reward still credits the referrer's existing
  referral-earnings bucket (`wallets.bonus_balance`).
- 10% downline profit commission: `REFERRAL_PROFIT_COMMISSION_RATE = 0.10`,
  computed from the EXISTING profit definition (`record_trade_safe()
  result.applied_amount` for a fresh profitable trade), credited atomically by
  `credit_referral_commission_safe()` (migration 020: idempotency → FOR UPDATE
  → double-check → bonus_balance → ledger → transactions row). The downline's
  own profit/balance is never touched.
- Referral-earnings withdrawal: genuinely earned referral income is withdrawable
  WITHOUT a prior trade. `getGenuinelyEarnedReferralEarnings(userId)` derives the
  eligible amount SERVER-SIDE (real `referrals` rows with `status='active'` and
  `referred_id > 0` + the commission ledger), capped by the actual
  `bonus_balance`. `/api/withdraw/request` debits live first then the referral
  bucket; only referral earnings skip the trade/deposit requirement. Minimum
  withdrawal (`amount < 700`), KYC gate, address, and the existing withdrawal
  process/table are all unchanged. Frontend mirrors it via
  `getWithdrawableTotal()` (live + referral bucket) and a `canFundFromReferral`
  display gate.
- $50 promotional credit: tradable through the SAME engine (no second engine).
  New `isPromoFundedTrading()` exempts promo-funded bot starts from the MTA.
  WITHDRAWAL RULE enforced server-side: no confirmed deposit ⇒ only referral
  earnings are withdrawable; the response carries
  `depositRequired:true, requiresFirstDeposit:true` and the existing message. A
  deposit alone still cannot bypass the 1-trade requirement. After deposit + one
  trade the normal process applies.
- MTA: production is **$200** (`BOT_MIN_TRADING_BALANCE = 200`, single source of
  truth `getEffectiveMta()`, optional env `MTA_AMOUNT`; .env.example updated).
  The MTA is NOT a withdrawal requirement (removed from the withdraw modal
  gates). MARKETING_SANDBOX keeps `SANDBOX_BOT_MIN_TRADING_BALANCE = 143` and
  never reads `MTA_AMOUNT`; `/api/auth/me` returns `getEffectiveMta()` for
  production and the sandbox constant for sandbox accounts, so the frontend
  adopts the right value per environment.
- Production/sandbox isolation hardening (smallest safe): `activateReferralOnQualification`
  now short-circuits MARKETING_SANDBOX (matching `creditReferralProfitCommission`);
  `/api/referral/stats` returns a sandbox-only display (legacy $10 reward, no
  commission) for sandbox accounts; migration 020's RPC also refuses sandbox
  users on either side.
- i18n: 1231 → 1239 keys/locale (new: `referral.withdrawNote`; `promo.tradableNotice`,
  `bot.mtaBlocked`, `referral.earned`, `referral.commissionEarned`,
  `tx.type.referralCommission` etc. from the earlier slice in this phase). Parity
  verified (identical key sets, 0 empties, 0 dups).
- Tests: `tests/referral_promo_mta.test.js` (44) + `tests/bot_mta.test.js` (19,
  production $200 AND sandbox $143 matrices) + updated
  sandbox_demo_balance/subscription_eligibility/marketing_sandbox/
  sandbox_withdraw_wording. `npm test` = 510 pass / 1 fail — the single fail is
  the pre-existing `tests/q8qpay.webhook.test.js` `Cannot find module 'express'`
  env failure (node_modules not installed), identical to baseline.
- NOT committed/pushed/deployed. Migration 020 NOT applied.

## Phase 19B — Provider referral-award correctness (migration 021) + audit follow-ups (2026-08)
- DISCOVERY: the $20 referral reward was NOT effective on provider-credited
  deposits. FOUR provider credit functions hard-coded `v_referral_reward := 10;`,
  qualified on ANY first deposit, and never marked the referral `active`:
  - `confirm_payment_with_credit(BIGINT,BIGINT,DECIMAL,TEXT)` — 002
    (still used by `services/PaymentService.js:653`)
  - `credit_payment_safe(BIGINT,BIGINT,DECIMAL,TEXT,TEXT,TEXT)` — 008 (q8qpay)
  - `paymento_credit_user_safe(...)` 5-arg — 006, and 8-arg — 007
  A `referral_config` row cannot change a literal hard-coded inside a function,
  and leaving the referral `pending` also meant the 10% commission could never
  apply for provider-credited referrals (the JS path keys on `status='active'`).
- NEW `supabase/migrations/021_provider_referral_award_correctness.sql`
  (additive, idempotent, ~31 KB, NOT applied): defines ONE shared helper
  `award_referral_qualification_safe(p_user_id BIGINT, p_deposit_amount DECIMAL)`
  and `CREATE OR REPLACE`s the four provider functions with ONLY their referral
  block replaced by a single call to it. Everything outside that block is
  byte-identical to 002/006/007/008 (verified programmatically in
  `tests/referral_provider_award.test.js` — this is the safety property).
- Helper contract (mirrors the JS `activateReferralOnQualification`): returns 0
  unless the referred user's deposit ≥ the EXISTING platform minimum
  (`minimum_qualifying_deposit`, default 50 — not reinvented); reward from
  `referral_reward_amount` (default 20); honours `rewards_enabled` /
  `max_rewards_per_user`; refuses MARKETING_SANDBOX on EITHER side; tolerates a
  missing `users.environment` (fails closed to production); locks the still
  `pending` referral row `FOR UPDATE`, re-checks after the lock, activates with
  `GET DIAGNOSTICS row_count` (a losing racer awards 0); credits ONLY the
  referrer's `bonus_balance` + a `Referral Bonus` transactions row; never touches
  the referred user's money. Self-verifying DO block asserts the helper exists
  and that no provider function still hard-codes `10`. REVOKE/GRANT keeps all
  five functions service_role-only.
- `020` tweak: `credit_referral_commission_safe` now wraps its
  `users.environment` sandbox probe in BEGIN/EXCEPTION (`v_is_sandbox := FALSE`)
  so a missing column (migration 013 not applied) can no longer make every
  commission silently fail.
- `public/index.html`: top MTA milestone is now server-derived
  (`#mtaMilestoneFinal` threshold+label set from `APP.MTA` in
  `updateMTAProgress()`), removing a second hard-coded MTA value. Stale
  `$10 bonus` referral share text (X + native share) reworded — it advertised a
  bonus the platform never paid.
- VALIDATION (local Docker Postgres 16, minimal Supabase-like schema, then
  migrations 020+021 applied): behavioral SQL suites all PASS —
  below-minimum deposit awards 0 / stays pending; qualifying deposit awards $20
  once + activates + writes exactly 1 ledger row; replayed invoice and a second
  deposit award 0; self-referral 0; MARKETING_SANDBOX 0; `rewards_enabled=false`
  0; config-driven reward (25 → 25); `max_rewards_per_user=1` blocks;
  `confirm_payment_with_credit` awards $20 once; concurrent credits on two
  invoices for the same referred user award EXACTLY once (session A $20, session
  B $0, referred user still credited 100, 1 ledger row); commission RPC 10% /
  idempotent per source trade / 0 on loss / self-referral refused / sandbox
  refused / NULL-or-empty key refused.
- `tests/referral_provider_award.test.js` (16 tests) pins all of the above at the
  source level (only-the-referral-block-changed diff, helper guards, additive/
  idempotent/no-DDL, not applied by app code, 020 tolerances, server wiring).
- `npm test` = 526 pass / 1 fail (pre-existing q8qpay express env failure).
  i18n parity re-verified: 1239 keys × 6 locales, 0 problems.
- STILL NOT APPLIED / NOT DEPLOYED / NOT PUSHED. DEPLOY PREREQUISITE: migrations
  020 **and** 021 must be applied together for the $20 reward + 10% commission to
  be correct on provider-credited deposits (without 021 the provider path still
  awards $10 and can double-award against the JS path).


## Phase 20 — FINAL management model: sandbox referral-program PARITY + NO sandbox MTA (2026-08, server.js + public/index.html + migration 022 + tests)
- Supersedes, for the MARKETING SANDBOX ONLY, three earlier claims in this file:
  `SANDBOX_BOT_MIN_TRADING_BALANCE = 143`, the sandbox $10 referral reward and
  `commissionRate: 0`. The sandbox no longer has an MTA at all and now mirrors
  the production referral program. Production values are unchanged from Phase 19
  ($20 reward, $50 qualifying deposit, 10% commission, MTA $200).
- PRODUCTION (unchanged by this phase; see Phase 19/19B):
  - `BOT_MIN_TRADING_BALANCE = 200` (server.js:470) is the single MTA constant;
    `MTA_ENV_VAR = 'MTA_AMOUNT'` + `getEffectiveMta()` (server.js:478-482) is the
    only reader, so the active MTA can be moved to $200/$300 via env alone.
    `.env.example` documents `MTA_AMOUNT=200`. To switch to $300: change that one
    line (or the constant if the built-in default should move) — no other code.
  - `isPromoFundedTrading(hasConfirmedDeposit, liveBalance)` (server.js:515) =
    no confirmed deposit AND positive live balance => the $50 promo credit is
    tradable through the existing engine (record_trade_safe) and exempt from the
    MTA gate, but NON-withdrawable until a qualifying first deposit AND >= 1
    completed trade (`/api/withdraw/request`, 400 `depositRequired:true` +
    `requiresFirstDeposit:true`, message `withdraw.needDeposit` in all 6 locales;
    frontend shows a toast + notification).
- SANDBOX referral program (migration **022_sandbox_referral_program.sql**,
  additive + idempotent + sandbox-only; RLS-off like the other sandbox tables):
  - `sandbox_referrals` (status pending|active, bonus_earned, is_simulated,
    no-self CHECK, UNIQUE(referred_id) WHERE referred_id > 0 so a REAL sandbox
    user is attributable once while synthetic negative demo downlines repeat) and
    append-only `sandbox_referral_commissions` (`idempotency_key` UNIQUE =
    exactly-once anchor).
  - `sandbox_referral_config()` reads the SAME `referral_config` keys production
    uses (`minimum_qualifying_deposit` / `referral_reward_amount` /
    `referral_profit_commission_rate`) with $50/$20/10% fallbacks — the minimum
    deposit definition is reused, never reinvented.
  - `sandbox_award_referral_qualification(p_referred_id, p_deposit_amount)`:
    below-minimum -> `below_minimum_deposit`; `FOR UPDATE` + post-lock
    `status='pending' AND bonus_earned = 0` + `GET DIAGNOSTICS` => exactly-once;
    credits ONLY the referrer's `sandbox_wallets.balance` (+$20), pending->active,
    writes a `'Referral Bonus'` sandbox transaction; asserts
    `assert_sandbox_user` for the referrer (and for the referred account when it
    is real) so a production account can never be credited.
  - `sandbox_credit_referral_commission(referrer, referred, source_trade_id,
    profit, idempotency_key)`: 10% of the EXISTING realized profit basis
    (`sandbox_trades.amount`, no second profit definition), losses/zero earn
    nothing, only `status='active'` referrals earn, idempotency checked before
    AND after the wallet `FOR UPDATE`, credits only the referrer, never writes a
    trade row and never touches the referred user's balance.
  - `sandbox_reset_account()` re-created to also clear the two new sandbox
    referral tables (one-click marketing reset stays complete). Trailing DO $$
    self-check raises if any 022 object is missing.
  - Server wiring: `getSandboxReferralSummary/Rows/CommissionRows`,
    `awardSandboxReferralOnDeposit` (called from `advanceSandboxDeposit` after a
    CONFIRMED simulated credit), `creditSandboxDownlineCommission` (called from
    `handleSandboxTrade` with the recorded `applied_amount` + `trade_id`, skipped
    on `duplicate`), `simulateSandboxReferralDeposit`,
    `simulateSandboxDownlineProfit`; `/api/referral/{stats,detailed,simulate}`
    branch to `handleSandboxReferral*` BEFORE any production query; admin-only
    `POST /api/admin/sandbox/:userId/referral/{deposit,profit}` re-verify
    `requireSandboxTargetUser`. Constants `SANDBOX_REFERRAL_REWARD_DEFAULT_USD
    = '20'`, `SANDBOX_REFERRAL_MIN_DEPOSIT = 50`,
    `SANDBOX_REFERRAL_COMMISSION_RATE = 0.10`, `SANDBOX_PROMO_CREDIT = 50`
    (auto-created sandbox wallet seeds the tradable $50 simulated balance).
  - Sandbox attribution is optional (`referralCode` on admin account creation)
    and accepts ONLY another MARKETING_SANDBOX referrer; it writes
    `sandbox_referrals`, never production `referrals`.
- SANDBOX MTA: **none**. `SANDBOX_BOT_MIN_TRADING_BALANCE` is deleted,
  `handleSandboxBotStart` performs no balance read/gate and returns `mta: 0`;
  `/api/auth/me` reports `mta: 0` for sandbox accounts. Frontend: the MTA is
  adopted server-authoritatively (0 accepted), `updateMTAProgress()` hides the
  card when `Number(APP.MTA) > 0` is false, `renderBadges()` suppresses the
  `mta_unlocked` badge without an MTA, `startBot()` gates only when
  `Number(APP.MTA) > 0` (no environment special-case), and the support bot uses
  `support.reply.botNoMta` (new key, 6 locales) when `APP.MTA === 0`.
- UI: new admin Sandbox "Referral Program ($20 + 10% downline)" card
  (data-i18n `sandbox.admin.referralTitle/referralAmount/downlineProfit/
  simulateReferral/simulateProfit`) + `sandbox.admin.referralDepositDone/
  referralNotQualified/referralProfitDone/referralFailed` log lines; the card
  posts only to `/api/admin/sandbox/...`. Dictionaries 1233 -> 1249 keys/locale (final: 1252 after the follow-up fixes below)
  (10 new: the 9 sandbox.referral admin keys + `support.reply.botNoMta`),
  identical key sets across en/es/pt/fr/ar/zh, 0 empty, 0 placeholder-parity and
  0 tag-parity issues, 589 data-i18n refs all defined.
- SANDBOX WITHDRAW DISPLAY (follow-up fix): the withdraw section previously
  still fell through the PRODUCTION requirement branches for a sandbox account
  (a sandbox with no simulated deposit showed "Please make a minimum deposit of
  $50 to enable withdrawals", no trades -> "Complete at least 1 trade to
  withdraw", balance < $700 -> "Reach the $700 minimum to withdraw") even though
  the sandbox route/RPC enforces balance-only rules. `updateLiveWithdrawStatus()`
  now branches on `isSandbox` FIRST: balance > 0 -> `readySandbox`
  ("✅ Ready to withdraw") + info box `withdraw.infoSandbox` ("No minimum
  withdrawal | 15-30min processing"); balance = 0 -> new key
  `live.withdrawStatus.sandboxEmpty` (neutral, no requirement implied) +
  `withdraw.infoSandbox`. Production wording/branches are byte-unchanged and
  `APP.MIN_WITHDRAWAL` stays 700 for production. Dictionaries 1249 -> **1250**
  keys/locale. `tests/sandbox_withdraw_wording.test.js` now also pins the
  below-minimum sandbox case (balance $20 with/without deposit+trade flags ->
  `readySandbox`) and the empty case. Server-side minimum remains absent by
  design: `handleSandboxWithdrawRequest` is reached BEFORE the production
  `amount < 700` check and `sandbox_request_withdrawal()` requires only
  `amount > 0`, a valid address and `amount <= balance`.
- SANDBOX HAS NO KYC / VERIFICATION (follow-up fix): the server was already
  correct (every KYC write endpoint 403-blocks sandbox accounts via
  `blockSandboxKyc`, and `/api/kyc/can-withdraw` short-circuits to
  `{canWithdraw:true, verificationStatus:'sandbox'}` WITHOUT weakening the
  production `isVerified` requirement), but the UI still offered a KYC path:
  a sandbox account in LIVE mode with a trade opened the REAL KYC form (which
  then 403-ed on save/upload/submit), and the withdraw modal still issued a
  `/api/kyc/can-withdraw` call. Fixes (frontend-only, display-only):
  `openVerificationModal()` now checks `APP.environment === 'MARKETING_SANDBOX'`
  FIRST and opens a new informational `#verificationSandboxInfoModal`
  ("Verification Not Required" + no-KYC body, Close button, reuses the
  `.deposit-modal`/`.btn` classes) with `closeVerificationSandboxInfo()`,
  never the `#verificationModal` form and never `loadVerificationStatus()`;
  `openWithdrawModal()` short-circuits for sandbox BEFORE the KYC fetch
  (hides `#withdrawKycRequired`, shows the form, still calls
  `syncSandboxWithdrawHistory()`). Production + demo (non-sandbox) paths are
  byte-unchanged (demo info modal, live no-trade toast, live KYC form, Gate 1
  `!kycData.canWithdraw`, min/deposit/trade gates, MIN_WITHDRAWAL 700).
  Dictionaries 1250 -> **1252** keys/locale (`kyc.sandboxInfo.title` +
  `kyc.sandboxInfo.body`, 6 locales). NEW `tests/sandbox_no_kyc.test.js`
  (8 tests: server 403 guards, can-withdraw ordering + production
  `canWithdraw:isVerified` intact, all 22 sandbox handler fns free of KYC
  tables/`kycService`, sandbox-first modal branch, runtime per
  environment/mode modal matrix, markup/close helper, sandbox-first withdraw
  short-circuit + production gate intact, i18n parity + copy never claims a
  requirement).
- TESTS: NEW `tests/sandbox_referral_program.test.js` (25 tests: parity
  constants, platform-minimum reuse, promo $50, deposit-only qualification,
  exactly-once award, downline commission on the existing profit basis,
  idempotency key derivation, tradability/withdrawability through the existing
  flows, no-trade-requirement, sandbox route ordering, sandbox-only surfaces,
  env assertions on every RPC, migration 022 additivity/self-check, production
  020/021 untouched, MTA-free sandbox, admin target verification, i18n parity).
  UPDATED for the intentional change: `tests/bot_mta.test.js` (sandbox matrix ->
  never blocked; frontend gate + `mta:0` adoption), `tests/marketing_sandbox.test.js`
  (frontend bot-gate regex), `tests/sandbox_demo_balance.test.js` (no sandbox MTA
  constant; sandbox account creation inserts only sandbox tables + $50 seed),
  `tests/referral_promo_mta.test.js` (sandbox has no MTA; sandbox referral parity),
  `tests/referral_provider_award.test.js` (sandbox reward $20),
  `tests/sandbox_withdraw_wording.test.js` (expected key count 1252; sandbox
  below-minimum/empty display cases pinned).
  `npm test` = 560 pass / 1 fail (the single fail is the PRE-EXISTING
  `tests/q8qpay.webhook.test.js` `Cannot find module 'express'` env failure —
  identical to baseline; no regression). `node --check server.js` OK; all 6
  inline index.html script blocks + reset-password block parse (vm.Script).
- DB VERIFICATION (real Postgres 16 in docker; migrations 013 + 022 applied
  cleanly incl. 022's self-check): `/tmp/sbxtest/30_behavior.sql` = **23/23
  PASS** (registration pays nothing; $10/$49.99 below-minimum rejected; $50 pays
  exactly $20 once; further deposits `no_pending_referral` and no second credit;
  synthetic downline same rules; production referrer/referred refused with
  `not a MARKETING_SANDBOX account` and nothing credited; 10% commission
  (`100 -> 10`, `33.33 -> 3.33`), idempotent replay `duplicate:true`, losses/zero
  earn nothing, unqualified referral earns nothing, self-referral rejected,
  missing idempotency key rejected, production referrer earns nothing; no
  production table written and the 013 backstops still reject sandbox writes;
  config parity $50/$20/0.10; reset clears the program).
  `/tmp/sbxtest/31_race.sh` = **2/2 PASS** (two concurrent qualifying deposits
  award exactly one $20; two concurrent identical commission calls credit once).
- NOT committed / NOT pushed / NOT deployed. Migration 022 (and 020/021) are NOT
  applied to production — deploying requires the migration review/approval path.
- DEFERRED / FOR MANAGEMENT AUDIT: (1) the admin sandbox referral simulations
  accept an operator-supplied `amount`/`profit` (marketing-only, sandbox target
  re-verified, no real money) — clamp/allow-list if desired; (2) the sandbox
  `$50` promo seed is a server read-time constant for a NEW sandbox wallet only
  (existing wallets keep their stored balance) — say if existing sandbox accounts
  should also be topped up; (3) sandbox referral earnings increase the single
  simulated tradable balance (no separate earnings bucket, matching the sandbox's
  existing balance-only withdrawal model) — production keeps its separate
  referral-earnings bucket untouched.


## Phase 21 — FINAL management model closed out: platform minimum deposit $100 + referral-earnings conversion + UI verification (2026-08, server.js + public/index.html + migration 023 + tests)
- SUPERSEDES one claim in Phase 20/19: the platform **minimum qualifying
  deposit is now $100, not $50** (the reward is unchanged at $20 after Phase 19).
  Everything else in Phase 20 stays as written (sandbox referral parity, no
  sandbox MTA, MTA $200 production, $50 promo credit, $700 withdrawal minimum).
- SINGLE SOURCE OF TRUTH for the platform minimum deposit:
  - server: `PLATFORM_MIN_DEPOSIT_USD = 100` (server.js, next to
    `BOT_MIN_TRADING_BALANCE`); production invoice validation and the sandbox
    simulated-deposit floor both read it, and `SANDBOX_REFERRAL_MIN_DEPOSIT`
    derives from it.
  - database/config: `referral_config.minimum_qualifying_deposit = '100'`
    (migration 023 bumps the historical '50'; the guard only rewrites '50'/'' so
    an operator-customised value is preserved).
  - frontend: `APP.MIN_DEPOSIT = 100` + the module-level `MIN_DEPOSIT_AMOUNT = 100`
    used by the deposit modal validation; deposit presets are $100/$250/$500/$1,000
    (no $50 preset). The `$50` quick-amount buttons that remain in the DOM belong
    to the DEMO FundS card (`data-amount`) and are demo money, NOT a deposit preset.
  - Do NOT invent another amount: the $50 PROMOTIONAL CREDIT is a separate
    constant (`SANDBOX_PROMO_CREDIT` / the `live_balance: 50` new-user seed) and
    is intentionally unchanged.
- migration **023_final_min_deposit_and_referral_earnings.sql** (additive,
  idempotent, self-checking):
  - bumps `referral_config.minimum_qualifying_deposit` 50 -> 100 (guarded), and
  - creates `referral_earning_conversions` (UNIQUE `idempotency_key` anchor) +
    `convert_referral_earnings_safe(p_user_id, p_idempotency_key,
    p_min_amount DEFAULT 50)`: idempotency check -> `FOR UPDATE` wallet lock ->
    double-check -> credits `live_balance`, debits `bonus_balance`, writes the
    ledger row and a `'Bonus Withdrawal'` transaction, atomically. It creates NO
    money (the value must already exist in the referral-earnings bucket), refuses
    `below_minimum` (below the existing $50 conversion minimum) and
    `sandbox_account`, and is service_role-only.
- Referral-earnings conversion is now SERVER-AUTHORITATIVE: `withdrawBonusToLive()`
  (public/index.html) POSTs `/api/referral/earnings/convert` with ONLY an
  idempotency key and adopts the returned `liveBalance`/`bonusBalance`; the old
  client-side balance mutation is gone. THIS FIXED A REAL BUG: the new fetch first
  read `localStorage['arbi_token']` (a key that does not exist) instead of the
  app's `jwt_token`, which would have made every production conversion 401.
  Now pinned by a test that asserts the JWT key.
- UNCHANGED behaviour re-verified: the sandbox withdrawal lifecycle is still
  `pending -> processing -> completed` in ~3 minutes with a terminal `rejected`
  that refunds the debit EXACTLY ONCE; **production withdrawals stay `pending`**
  (no simulated progression) and keep the $700 minimum + KYC-first ordering. The
  sandbox simulated-deposit floor is now $100 (was $50 in migration 013) — a
  constant change only; the scan/lazy-advance mechanics are untouched.
- VERIFICATION (this session):
  - Real Postgres 16 (docker `arbtest`, disposable `arbfinal`): the chain
    `013 -> 020 -> 021 -> 022 -> 023` applied cleanly from PRE-020 defaults, so
    020 really bumps the reward $10 -> $20 AND 023 really bumps the minimum
    $50 -> $100. Re-applying 020/021/022/023 is a no-op; an operator value of
    '75' survives a 023 re-run.
  - `/tmp/final23/30_behavior.sql` = PASS A-E: production $99.99 no award / $100
    awards exactly $20 once / duplicates + replays never re-award / no referral ->
    nothing / 10% commission (idempotent, loss refused, self-referral refused,
    sandbox referrer or sandbox downline refused) / conversion moves the whole
    bucket atomically, replay is `duplicate:true`, below-minimum and promo-only
    accounts are refused with nothing moved, demo balance untouched, sandbox
    refused / sandbox $100 -> $20 exactly once with NO production row written,
    production award refuses a sandbox user, the 013 backstop trigger blocks a
    sandbox user from `wallets` / END-TO-END through the real
    `credit_payment_safe`: a $99.99 invoice credits but does NOT qualify, a $100
    invoice qualifies with exactly $20, and replaying the invoice re-awards nothing.
  - `/tmp/final23/31_race.sh` = 5/5: two concurrent qualifying deposits award
    exactly one $20 (referrer 20, one active row); two concurrent sandbox awards
    award exactly one $20; two concurrent conversions with DIFFERENT keys convert
    once (live 60, bonus 0, one ledger row — never 120); the same key returns
    `duplicate:true` with the SAME `conversion_id`; a FRESH user credited two $100
    invoices concurrently gets one award (`referral_bonus` 20 then 0) and both
    deposits (200).
  - `/tmp/final23/32_sandbox.sql` = PASS S: sandbox withdrawal has no minimum and
    no KYC (a $25 request is accepted and debited), the sequence reaches
    `completed` without re-crediting, `rejected` refunds exactly once, the $50
    promo seed trades through the existing sandbox engine (idempotent, floored at
    0), and sandbox rows never appear in production tables.
  - Browser (puppeteer-core + /usr/bin/chromium, stubbed API, `/tmp/ui_check.js`)
    = **42/42**: deposit modal default/placeholder $100 with no $50 preset;
    referral min $100 / reward $20; the promo notice shows for a non-depositor and
    hides once funded; a promo-funded withdrawal attempt is blocked with
    "A qualifying first deposit is required before you can withdraw your
    promotional credit or trading profits."; conversion fires exactly ONE request
    with `Bearer <jwt>` and only an idempotency key, then adopts the server
    balances; sandbox shows MTA 0 + the PREVIEW badge, skips the KYC capability
    call, opens the withdrawal form and starts the bot; es/ar render correctly
    (ar RTL, localized $100 prompt); 0 horizontal overflow at 390px.
  - `npm test` = **607 pass / 0 fail** (node_modules installed this session; the
    long-documented `q8qpay.webhook.test.js` "Cannot find module 'express'"
    env-failure was never a product failure and now passes too).
- NOT committed / NOT pushed / NOT deployed. Migration 023 is NOT applied to
  production. Working tree: M server.js, M public/index.html, M AGENTS.md,
  M .env.example, M 6 test files; ?? migrations 020-023 and ?? the 5 new test
  files (final_min_deposit_referral, referral_promo_mta, referral_provider_award,
  sandbox_no_kyc, sandbox_referral_program).

## Phase 22 — FINAL referral model closed out on the FRONTEND + stale-test convergence (2026-08, public/index.html + migrations/003 + tests + AGENTS.md)
- **MODEL OF RECORD (supersedes every earlier reward revision):** the referrer
  receives a ONE-TIME reward equal to **20% of the referred user's INITIAL
  QUALIFYING DEPOSIT** at the platform minimum (`PLATFORM_MIN_DEPOSIT_USD = 100`).
  There is **NO flat $20 reward and NO 10% downline profit-share commission**.
  Registration / onboarding / KYC / referral-link clicks never qualify.
  Server/admin/referral_config source of truth: `referral_reward_percent` (default
  20) + `minimum_qualifying_deposit` (100). The retired keys
  (`referral_reward_amount`, `referral_profit_commission_rate`) are deleted by
  migration 020/024; migration 021's `award_referral_qualification_safe()` returns
  JSONB and computes `ROUND(amount * percent / 100, 2)`.
- **FRONTEND (public/index.html) — brought to the final model this session:**
  - Referral heading is now config-driven: `<span data-i18n="referral.invite">`
    + `<span id="refRewardPercent">20%</span>` + new key
    `referral.ofFirstDeposit`; step 3 uses `<span id="refRewardPercent2">`.
    `updateReferralDisplay()` reads `APP.referralStats.config.rewardPercent`
    (fetched from the PUBLIC `GET /api/referral/config`) and falls back to 20%.
  - The "$20 per referral" / "Profit commission earned" UI row and
    `#refCommissionEarned` were REMOVED (the commission model is retired);
    `fetchReferralStats()` no longer reads `commissionEarned`.
  - Admin config form: raw key `referral_reward_amount` -> `referral_reward_percent`
    (label/desc `admin.referral.cfg.rewardPercent*`, value rendered as `N%`);
    `formatConfigValue` shows `%` for the percent key and `$` for the minimum.
  - Sandbox admin card: the "Simulate Downline Profit" input/button and the
    `sandboxSimulateDownlineProfit()` handler were REMOVED (plus the i18n keys
    `sandbox.admin.downlineProfit`/`simulateProfit`/`referralProfitDone`).
  - Landing/support/ticker copy updated to the percent model in all 6 locales:
    `landing.features.referral.desc`, `landing.features.referral.list1`,
    `landing.faq.5.a`, `support.reply.bonus`, `ticker.referred` (markup preserved).
  - Dictionaries: 1254 -> **1251** keys/locale (removed 4, added
    `referral.ofFirstDeposit`). Key sets identical across en/es/pt/fr/ar/zh,
    0 empty, 0 placeholder issues, 0 HTML/attr parity issues; ar RTL intact.
- **`migrations/003_referral_config.sql` (historical bootstrap):** seed aligned to
  the final model — `minimum_qualifying_deposit` '50' -> '100' and
  `referral_reward_amount` '10' -> `referral_reward_percent` '20' (verification
  block updated, header notes supabase/migrations 020/023/024 are authoritative).
  No supabase/migrations file needed changing (they were already final).
- **Tests:** the 4 referral test files that still pinned the retired interim model
  (`final_min_deposit_referral`, `referral_promo_mta`, `referral_provider_award`,
  `sandbox_referral_program`) were rewritten for the final model (they also
  referenced the pre-rename migration filename
  `020_referral_reward_and_commission.sql`, which no longer exists):
  - percent math ($100->$20, $250->$50, $300->$60 — explicitly NOT flat $20),
    deposit-only qualification, exactly-once, registration never awards;
  - commission absence (server + migrations), provider delegation to the JSONB
    helper, 020/024 convergence guards;
  - promo credit tradable through the existing engine + MTA-gate exemption +
    withdrawal requires qualifying deposit AND one trade; MTA single-source
    (env-selectable) and sandbox has none;
  - sandbox parity/isolation; migration seed scans across BOTH
    `supabase/migrations/` and the legacy `migrations/`.
  - Updated the pinned dictionary count in `sandbox_withdraw_wording.test.js`
    (1254 -> 1251).
- **VERIFICATION:** `node --check server.js` OK; all 5 inline `<script>` blocks
  parse (vm.Script). i18n vm-eval: 1251 keys x6, identical sets, 0 empty, 0
  placeholder issues. Browser harness (puppeteer-core + /usr/bin/chromium, stubbed
  fetch, real page) confirms the referral UI: default `20%` / `$100`, 0 page
  errors, no commission row, config-driven `25%`/`$150` override, es
  "Invita amigos, gana 20% de su primer depósito", ar RTL; the promo-withdrawal
  message resolves per locale. `npm test` = **552 pass / 0 fail** on THIS tree
  (the earlier "607" figure in Phase 21 was an earlier tree state; the 4 stale
  files above were contributing load-time failures here).
- **MTA (unchanged this session, needs management confirmation):** the working
  tree already carries `BOT_MIN_TRADING_BALANCE = 200` (server.js ~L491) with a
  single runtime source `getEffectiveMta()` reading env `MTA_AMOUNT` (missing /
  invalid -> 200). It is enforced ONLY in `POST /api/bot/start` (and mirrored for
  display via `GET /api/auth/me` `mta`, consumed by `APP.MTA` +
  `updateMTAProgress()`; static fallbacks `#mtaTargetAmount`/`#mtaMilestoneFinal`
  = 200). MARKETING_SANDBOX reports `mta: 0` with no gate. The original brief said
  the current MTA was $143 and that it must NOT be changed until management
  chooses $200 vs $300 — **the $200 value was already present in the tree at the
  start of this session (prior work), so it was left as-is rather than reverted.**
  To switch: set `MTA_AMOUNT=300` (no code change) or edit the single constant (and
  the two static HTML fallbacks). FLAGGED for management.
- NOT committed / NOT pushed / NOT deployed. Migration 024 NOT applied to
  production.


## Phase 23 — Final Referral Model Confirmation + Hardening (2026-08)
- Management CONFIRMED the final model (production + MARKETING SANDBOX):
  min deposit $100; ONE-TIME referral reward = 20% of the referred user's
  INITIAL qualifying deposit; no flat $20; no 10% profit share; no recurring
  commission; $50 promo credit tradable; production MTA = $200 (FINAL — do NOT
  revert to $143); sandbox has NO MTA. These are now the model of record.
- **/api/referral/simulate locked to MARKETING SANDBOX (security fix).** It was
  production-reachable and could mint `referrals` + `bonus_balance` with no
  qualifying deposit. Now: `sandboxHandled(req,res,handleSandboxReferralSimulate)`
  (server-verified `users.environment === 'MARKETING_SANDBOX'`) runs first; every
  PRODUCTION caller gets `403 { error, sandboxOnly: true }`. The route contains NO
  production `referrals` insert / wallet / ledger write. The sandbox handler
  writes only `sandbox_referrals` + `sandbox_wallets` via
  `sandbox_award_referral_qualification` (asserts the referrer is sandbox).
  Frontend `simulateReferral()` is now sandbox-only too (no client-side mint).
- **Referral-earnings conversion: NO minimum (old $50 threshold + 1-referral gate
  retired for referral earnings).** `REFERRAL_EARNINGS_MIN_CONVERT_USD` 50 -> 0;
  `/api/referral/earnings/convert` gates on `getGenuinelyEarnedReferralEarnings(userId).available > 0`
  (qualified/active referrals capped by the bucket) instead of "any referral row
  exists". Rationale: one qualifying referral at the $100 minimum earns $20, which
  management requires to be usable as tradable capital. Promo/ordinary balances
  cannot be converted (bucket = referral earnings); `convert_referral_earnings_safe`
  is unchanged and still atomic/idempotent/ledgered. Frontend `withdrawBonusToLive`
  + `updateBonusWalletUI` gate on `balance > 0`; new i18n key `bonus.noEarnings`
  replaces `bonus.minWithdraw`/`bonus.withdrawFailed` (dictionary 1251 -> 1250).
- **Legacy server activation hardened (exactly-once under concurrency).**
  `activateReferralOnQualification` now does a CONDITIONAL update
  (`.eq('id',...).eq('status','pending').select('id')`) and only credits the
  referrer when the row actually flipped, so duplicate/concurrent deposit
  confirmations cannot double-pay. Single-caller behavior unchanged. (The
  webhook path already used the row-locked `award_referral_qualification_safe`.)
- **Copy fixes (all 6 locales):** `landing.features.referral.list3`
  "Lifetime commissions" -> "One-time reward, no recurring commission";
  `landing.faq.5.a` no longer claims a "$50 + 1 referral to withdraw" rule;
  `support.reply.bonus` no longer claims a $50 conversion minimum.
  `tx.type.referralCommission` is KEPT (render-only label for historical rows).
- UNCHANGED: deposit logic/minimum, withdrawal sequence + $700 minimum, KYC,
  security, address checks, trading engine/profit calc, subscriptions,
  authentication, onboarding, fees, payment providers, promo-credit tradability,
  sandbox withdrawal behavior, MTA $200, migrations 020-024 (023's DB DEFAULT
  `p_min_amount` stays 50; the route always passes 0 explicitly — no migration
  change needed).
- TESTS: NEW `tests/final_referral_model.test.js` (18 tests: registration /
  onboarding / deposit-request never award; $99.99 vs $100; $100->$20, $250->$50,
  $500->$100; later deposits pay nothing; no commission (any form); duplicate +
  concurrent exactly-once; self-referral blocked; simulate sandbox-only; genuine
  earnings convertible + withdrawable without trading; $700 + KYC/address intact;
  MTA $200/sandbox none). Updated `final_min_deposit_referral` (conversion min 0)
  and `sandbox_withdraw_wording` (1250 keys). **`npm test` = 570 pass / 0 fail.**
  i18n vm-eval = 1250 keys x6, 0 parity/placeholder/HTML/ref problems.
- NOT committed / NOT pushed / NOT deployed. No migration applied.


## Phase 24/24B/24C - Promo-credit trading cap, source-of-funds classification (2026-09)
- PRODUCTION-ONLY. Two management rules: (A) withdrawal prompt priority - a user
  who has never made a real qualifying deposit sees the FIRST-DEPOSIT requirement
  first ("Make your first deposit to unlock withdrawals.") and never
  "Verification required" first; (B) a $20 realized-profit cap while trading the
  $50 promotional credit before a qualifying deposit (bot stopped + /api/trade
  and /api/bot/start refuse; cleared by a confirmed qualifying deposit).
- MARKETING_SANDBOX is untouched: no MTA, no promo cap, sandbox withdrawal
  behavior unchanged (server-verified env guard, not frontend hiding).
- NOTE (writing convention): keep additions to this file ASCII-only. Editing the
  legacy mojibake byte sequences in this file with a text re-encoder corrupts
  them; append in binary mode instead.

### Classification (authoritative source of funds, NOT "no deposit + balance > 0")
- `isNonDepositedTrading(hasConfirmedDeposit, liveBalance)` (renamed from
  `isPromoFundedTrading`) = `!deposit && balance > 0`. MTA-EXEMPTION classifier
  only (promo credit OR converted referral earnings). NEVER used for the cap.
- `isPromoCreditFunded(userId, hasConfirmedDeposit)` async TRI-STATE:
  `true` = promotional-credit funded; `false` = definitively not (confirmed
  deposit | MARKETING_SANDBOX | referral-earnings conversion); `null` = UNKNOWN
  (conversion state unreadable -> callers use `=== true`, so it FAILS OPEN and is
  never capped). Never inspects the balance amount.
- `hasConvertedReferralEarnings(userId)`: ledger `referral_earning_conversions`
  (migration 023) is authoritative when readable (empty result = no conversion);
  the `transactions.type = 'Bonus Withdrawal'` marker is consulted only when the
  ledger read fails. Returns true/false/null.
- DOCUMENTED BUSINESS DECISION: ANY conversion - even $0.01 - PERMANENTLY
  exempts the account from the cap while it has no confirmed deposit (no amount
  threshold, no time window, no proportional attribution; the wallet is
  commingled). Regression-tested.
- `isPromoProfitCapReached(isPromoCreditFunded, promoProfit)`: INCLUSIVE,
  `>= PROMO_PROFIT_CAP_USD (20)`; basis `SUM(trades.amount)` where `mode='live'`.
- Enforced server-side at `/api/trade` (before `record_trade_safe`; also maps the
  migration-026 trigger error to the same machine-readable body
  `{code:'PROMO_TRADING_LIMIT_REACHED', promoLimitReached:true, depositRequired:true}`)
  and `/api/bot/start` (before the `bot_sessions` upsert, so restarts cannot
  bypass). `/api/auth/me` reports `promoCreditFunded` (hard boolean),
  `promoClassificationUnknown`, `promoRealizedProfit`, `promoLimitReached`;
  sandbox reports false/0/false.
- Observability: `logPromoClassificationUnknown()` emits ONE structured JSON
  line (`event:'promo_classification_unknown'`, severity, component, fallback,
  impact, userId, per-source failure flags + error codes + 200-char-truncated
  messages) whenever both reads fail. Whitelisted fields only; never throws.
- Frontend: `APP.liveData.promoClassificationUnknown` adopted from the server;
  unknown FORCES `promoCreditFunded=false`; the promo disclosure requires
  `promoCreditFunded === true && promoClassificationUnknown !== true`; a
  confirmed deposit clears both. `bot.promoLimitReached` added to all 6 locales.
- Migration `supabase/migrations/026_promo_trading_cap.sql` (NEW, NOT APPLIED):
  fail-open, sandbox-skipping `BEFORE INSERT` row-level trigger on `public.trades`
  with the same source-of-funds rule map (R1 deposit exempt, R2 sandbox exempt,
  R3 referral marker exempt, R4 otherwise capped, R5 never reads the balance,
  R6 inclusive >= 20, R7 SUM(trades.amount) mode='live'); additive/idempotent,
  self-checking DO block. Migration 025 untouched.

### Verification
- `npm test` = 660 pass / 0 fail (7 suites). `node --check server.js` OK; all 5
  index.html inline script blocks + the reset-password block parse.
- New/updated tests: `tests/promo_trading_cap.test.js` (31),
  `tests/promo_classification_observability.test.js` (14, executes the real
  helpers in a vm sandbox with a mocked Supabase client),
  `tests/withdrawal_prompt_priority.test.js`, `tests/withdraw_gating.test.js`,
  plus renamed-helper pin updates in bot_mta / marketing_sandbox /
  final_min_deposit_referral / referral_promo_mta.
- Migration 026 EXECUTED against a real PostgreSQL 16.15 server in a temporary
  Docker container (now removed; never staging/production): applies cleanly,
  re-apply is a no-op, 14/14 behavioural checks PASS (inclusive >= $20 lock at a
  ledger of exactly 20.00; $0.01 referral conversion exempt; Bonus Withdrawal
  marker exempt; confirmed deposits/payment_invoices exempt; sandbox exempt;
  pending deposit NOT exempt; demo trades excluded; missing ledger still capped
  via the transactions fallback; both sources missing -> fail open; re-created
  trigger leaves existing rows untouched and still enforces; UPDATEs ungated;
  exact error string). Two-session concurrency check with the `wallets`
  `FOR UPDATE` lock (as `record_trade_safe` takes) -> exactly 1 trade / $20.00;
  the loser is rejected with PROMO_TRADING_LIMIT_REACHED.
- Headless Chromium smoke = 12/12 (promo / capped / referral-funded / deposited /
  UNKNOWN / sandbox).
- STATUS: NOT committed, NOT pushed, NOT deployed; migration 026 NOT applied to
  any staging/production database.


## Phase 25 - Deposit UX in Demo + Post-Registration Onboarding Funnel (2026-09, public/index.html + tests)
- Frontend-only (public/index.html). NO server.js / DB / migrations / payment-provider
  / webhook / KYC / trading / withdrawal changes. No deploy, no merge, no production data
  touched. MARKETING_SANDBOX behavior unchanged (server-verified in tests).
- A) Demo-mode deposit UX: openDepositModal() no longer blocks in Demo for PRODUCTION.
  It opens the modal, reveals #depositDemoNotice (virtual-funds explanation + a balance
  breakdown of Demo/virtual, Live/real, Deposited funds, Promotional credit), the deposit
  requirements (min from APP.MIN_DEPOSIT via {{min}}) and a prominent
  "Switch to Live & Continue" CTA (switchToLiveAndContinueDeposit) that calls setMode('live')
  and KEEPS the modal open. The generate button is hidden while in Demo and
  requestDepositAddress() has a hard guard (`if (APP.mode === 'demo') return`). A
  #depositLiveNotice clarifies LIVE = real balance. Sandbox demo keeps the OLD toast.
  Display-only: opening the modal / switching modes makes no request and credits nothing.
- B) Onboarding funnel: #onboardingModal with PRIMARY "Make My First Deposit"
  (chooseOnboarding('deposit')) and SECONDARY "Explore Demo" (chooseOnboarding('demo')).
  Shown by handleSignup (after successful registration, before the app) and by
  initApp -> maybeShowOnboardingForCurrentUser() for a returning, never-onboarded,
  unfunded, non-sandbox account. Choice is stored per account in localStorage
  ('arbi_onboarding_<userId>' = 'shown'|'demo'|'deposit'); the 'shown' marker is written
  the first time the screen appears, so it is shown at most once per account (never every
  login). 'deposit' sets pendingOnboardingDeposit, consumed by initApp after the sync to
  open the deposit modal immediately (no invoice). 'demo' enters Demo mode and shows a
  dismissible in-demo CTA (#demoFirstDepositCta / dismissDemoDepositCta), never forced.
  Funded users and MARKETING_SANDBOX are never prompted.
- i18n: 1272 -> 1287 keys/locale (15 new: onboarding.* x10, demoCta.* x4, wallet.liveReal).
  Identical key sets across en/es/pt/fr/ar/zh, 0 empty, 0 new duplicate keys, {{min}} kept
  in onboarding.primaryDesc, all data-i18n refs defined. ar RTL verified.
- Labels: demo.virtualOnly (existing) + onboarding.virtualNote; wallet.liveReal and
  onboarding.realNote label LIVE as real trading funds; onboarding.promoNote and
  demoCta.body state the $50 promotional credit / demo funds are separate and demo funds
  are not withdrawable. No earnings/guarantee claims (tested).
- Tests: NEW tests/deposit_demo_ux.test.js (9) + tests/onboarding_funnel.test.js (9);
  sandbox_withdraw_wording pinned count 1255 -> 1287. npm test = 678 pass / 0 fail.
- Browser verification (puppeteer-core + /usr/bin/chromium, real public/index.html):
  onboarding opens (min deposit rendered), demo deposit modal shows the notice + separated
  balances + hidden generate button, switch keeps the modal open and enables the form,
  in-demo CTA visible, sandbox keeps the toast/no modal, ZERO create-invoice requests
  during onboarding/open/switch, 12/12 no-horizontal-overflow at 320/390/1280 x en/es/ar/zh
  (ar dir=rtl). Screenshots: /tmp/onboarding_shots/01..05.
- UX decisions needing approval: (1) onboarding is shown once to pre-existing unfunded
  accounts on their next app entry (funded accounts and sandbox are excluded) - confirm
  this back-fill is wanted vs. new-registrations-only; (2) the per-account onboarding flag
  lives in localStorage (no DB column added; a DB flag would need a migration).


## Phase 26 - Official Customer Support + Standalone KYC/Verification UI Hidden (2026-09, public/index.html + tests)
- Frontend-only (public/index.html). NO server.js / services / DB / schema /
  migrations / KYCService / payment-provider / webhook / withdrawal changes.
  No deploy, no commit, no production data touched.
- SUPPORT (new, real customer-support experience):
  - Sidebar entry `#supportSidebarLink` (id-keyed, localized `sidebar.support`)
    -> `openSupportModal()`; opens `#supportModal`, closes the mobile drawer,
    marks the nav item active.
  - `#supportModal` sections: official Telegram CTA (`#supportTelegramBtn`),
    an unconfigured notice (`#supportNotConfigured`), a security warning, safe
    payment information, and a FAQ.
  - CONFIGURABLE official link: `getOfficialSupportTelegramUrl()` reads
    `window.ARBITRIX_SUPPORT_TELEGRAM_URL` first, then the
    `<meta name="arbitrix-support-telegram" content="">` tag. `updateSupportLinks()`
    sets the href + visibility of every `.js-official-telegram` anchor (and shows
    the notice when unset). NO personal/staff account is hardcoded - the official
    URL appears EXACTLY ONCE in the document (the meta config); the test asserts
    that single occurrence and that no anchor hardcodes a destination. The
    management-confirmed official URL is set in that meta tag (see below).
  - Security warning covers password / OTP / private key / seed phrase / recovery
    phrase / card details / recovery codes. The support modal contains NO input
    or textarea (no secret collection).
  - Safe payment information: invoice reference, amount, network, tx hash,
    screenshot only.
  - Payment-problem guidance is display-only: `#depositInvoiceRef` shows the
    current invoice id and `copyInvoiceRef()` copies it via the existing safe
    clipboard pattern. `updatePaymentSupportHelp()` maps the last observed
    payment status (pending / detected+confirming / expired+cancelled) to
    `support.paymentHelp.*`. `startPollingForPayment()` records `lastPaymentStatus`
    and refreshes the guidance; confirmation, crediting, polling and provider
    calls are unchanged.
  - Support entry points: sidebar, deposit instructions, deposit payment section,
    account/settings profile modal, withdrawal modal, and the existing support
    widget (`#supportPanel`).
- KYC/VERIFICATION UI HIDDEN (UI-only):
  - `#verificationSidebarLink` is now `class="sidebar-link hidden"` - the
    standalone verification tab is not visible.
  - NOTHING else changed: `#verificationModal` still exists, every `/api/kyc/*`
    endpoint and `KYCService` are untouched, and the WITHDRAWAL-triggered
    verification path (withdraw KYC-required screen -> Start Verification ->
    `openVerificationModal()`) still works (live users need >= 1 trade, as before).
  - Approved wording `support.verificationNotRequired` ("Verification is not
    required... additional checks may still be required...") is shown in the
    account/settings area and localized in all 6 locales.
- i18n: 1287 -> 1331 keys/locale (44 NEW support keys). Identical key sets across
  en/es/pt/fr/ar/zh, 0 empty, 0 new duplicate keys (only the pre-existing
  `landing.howItWorks.*` duplicates remain), 0 placeholder/tag parity issues, all
  655 `data-i18n` refs defined. ar RTL verified.
- Tests: NEW `tests/support_ui.test.js` (17), `tests/kyc_ui_hidden.test.js` (8),
  `tests/withdrawal_protection.test.js` (8); 1 added to
  `tests/onboarding_funnel.test.js`; pinned key count 1331 in
  onboarding_funnel / deposit_demo_ux and 1255 -> 1331 in
  sandbox_withdraw_wording.
  `npm test` = 712 pass / 0 fail.
- Browser verification (puppeteer-core + /usr/bin/chromium, real
  public/index.html, stubbed fetch): 21/21 - onboarding -> deposit flow, support
  from all 5 entry points, all 3 official Telegram anchors resolve to the ONE
  configured URL (no other t.me href on the page) with the fallback hidden, the
  unset case hides every anchor and shows the fallback, the official link is
  visible + correct at 390px and 1280px, security warning with 0 inputs, pending
  + expired guidance, zero invoices created by support, demo deposit modal +
  demo->live preserved with no invoice, standalone verification tab hidden while
  withdrawal-triggered verification still opens the KYC form, 0 horizontal
  overflow at 320/430/1280px, Arabic RTL + localized, Spanish copy.
  Screenshots /tmp/shots/support-{ar,es}-390.png.
- The two page console errors observed are PRE-EXISTING (`updateDynamicTranslations
  error: updateVerificationModalHeader is not defined`, and the missing sw.js 404);
  both are identical on the baseline and unrelated to this change.
- OFFICIAL URL CONFIGURED (management-confirmed): the single meta tag
  `<meta name="arbitrix-support-telegram" content="https://t.me/Arbitrix_Official_Support">`
  is the only place the URL is defined. `updateSupportLinks()` propagates it at
  runtime to every `.js-official-telegram` anchor (support modal button, deposit
  payment section, landing footer) - no anchor hardcodes a destination, no
  personal account, no old link, HTTPS + official t.me domain. When the meta
  content is empty the anchors stay hidden and the `support.notConfigured`
  fallback shows instead (never a broken/empty link).
- STATUS: NOT committed, NOT pushed, NOT deployed.


## Phase 27 - Beginner-Friendly First-Time-User UX Pass (2026-09, public/index.html + tests only)
- Frontend-only clarity/wording pass (public/index.html). NO server.js, services/,
  migrations, auth, wallet, trading, withdrawal-gate, KYC-enforcement, deposit
  confirmation/crediting, webhook or payment-provider changes. No commit/push.
  git status for this pass: M public/index.html, M tests/deposit_demo_ux.test.js,
  M tests/onboarding_funnel.test.js, M tests/sandbox_withdraw_wording.test.js,
  ?? tests/beginner_ux.test.js.
- i18n: dictionaries 1331 -> 1384 keys/locale (53 new keys). Identical key sets
  across en/es/pt/fr/ar/zh, 0 empty, 0 duplicate keys, 0 placeholder/tag parity
  issues; all 669 data-i18n refs + 22 data-i18n-placeholder refs resolve.
- Behavioral change (approved): the onboarding modal's PRIMARY choice is now the
  safe one - "Explore Demo Mode" (btn-primary) with a secondary "Review Live
  Mode" (btn-secondary). Live review only enters Live mode (no deposit, no
  invoice). The legacy chooseOnboarding('deposit') path still exists.
- Onboarding now explains the platform in plain language (onboarding.explainer +
  a rewritten onboarding.primaryDesc set as a data-i18n span, so the modal
  localizes instantly). Onboarding is still once-per-account, sandbox-exempt.
- Auth page: added a mobile tagline (auth.mobileTagline) and the first-screen
  explainer (auth.explainer.*).
- Registration: handleSignup() now does PER-FIELD, localized validation
  (signupName/signupEmail/signupPassword/signupConfirm get a .field-error beside
  the input via setFieldError/failField) with new keys auth.errors.nameRequired/
  emailRequired/passwordRequired + auth.signup.passwordMin; backend errors go
  through translateBackendMessage. Added a password hint, a referral hint and a
  "what happens next" note (auth.signup.passwordHint/referralHint/next/failed).
- Dashboard: new dismissible "Start Here" checklist (#startHereCard, per-account
  arbi_starthere_<id>, hidden for MARKETING_SANDBOX) plus short plain-language
  hints on Total Equity, Available, Today's P&L, bot status, bot description,
  market scanner and the transaction log (hint.* keys).
- Deposit modal (display-only clarity): newToUsdt explainer, USDT-vs-USD note,
  payment-method confirmation notice, address explanation, payment-reference
  explanation and an "after sending" note (deposit.methodNotice/newToUsdt.*/
  usdVsUsdt/addressExplain/referenceExplain/afterSending). No crediting logic
  touched.
- De-jargon: MTA is no longer exposed to users - mta.subtitle/bot.reachMTA/
  bot.mtaMet/support.reply.bot now say "minimum trading balance" (the $200 value
  and all gates are unchanged); the MTA-vs-amount line uses mta.targetLabel.
- The activity ticker is now labelled "Sample activity" (ticker.sample), its
  green live dot is neutral grey, live_amount and the LIVE badge were removed
  from the mock items, and the label stays visible down to 320px (the
  @media(max-width:379px) .ticker-label{display:none} rule was replaced with a
  compact visible variant).
- Support widget: the fake unread-count badge was removed; the header is now
  "Support assistant" + "Automated" (support.assistant.name/automated/status)
  with an official human-support section (support.human.title) and a clear
  Telegram button label (support.officialTelegram).
- Other: cookie consent localized (cookies.*), badge rarity pills localized at
  render time (badgeRarityLabel + badge.rarity.*), history statuses localized
  via depositStatusLabel/withdrawalStatusLabel (added status.processing +
  status.completed for the sandbox lifecycle), and withdrawal copy now says
  processing "usually takes 15-30 minutes" while the $700 minimum and "Requires
  1 trade completed" clauses are unchanged in all 6 locales.
- Verification: node --check-equivalent (vm.Script) on all 5 inline <script>
  blocks OK. npm test = 725 pass / 0 fail (was 712; +13 = tests/beginner_ux.test.js
  with 12 tests, plus the updated onboarding tests). Headless Chromium
  (puppeteer-core + /usr/bin/chromium, stub fetch) = 16/16 scenarios
  (en/es/ar/zh x 320/360/390/412): 0 horizontal overflow on auth + dashboard,
  explainer/tagline/start-here/ticker/hints visible, onboarding opens, ar RTL
  correct, deposit clarity copy present.
- NOT committed / NOT pushed / NOT deployed.

## Phase 27 - Beginner UX Fixes: Support From Profile, History Range, Demo Reminder (2026-09, public/index.html + tests)
- FRONTEND-ONLY. Files changed: public/index.html; new tests/support_profile_button.test.js,
  tests/tx_history_range.test.js, tests/demo_live_reminder.test.js; test pins updated in
  beginner_ux / deposit_demo_ux / onboarding_funnel / sandbox_withdraw_wording.
  NO server.js, services, migrations, .env, package or payment code touched. NOT committed,
  NOT pushed, NOT deployed (working tree only).
- (1) PROFILE SETTINGS "CONTACT SUPPORT" DID NOTHING (fixed). Root cause: the button was
  already wired to openSupportModal(), but #supportModal is a `.deposit-modal` (z-index 3000)
  while #profileModal is a `.modal-overlay` (z-index 9999), so the support modal opened BEHIND
  the still-open profile modal and was invisible. Fix: openSupportModal() now closes any
  open `.modal-overlay.open` (via document.querySelectorAll) before showing itself, so it is
  always the visible/topmost layer. It reuses the SAME existing destination as the sidebar
  Support entry (#supportModal) - no new URL, route or destination invented; the modal still
  contains the security warning and collects no input. Visible feedback on tap = the modal is
  now actually visible (profile modal visibly closes). All support entry points benefit.
- (2) TRANSACTION HISTORY FELT DELETED (fixed). getRecentHistory(history, 30) is a PURE
  read-only display filter; stored history was never trimmed (persisted per wallet in
  localStorage). The real gap was that "View More" only expanded WITHIN the 30-minute window,
  so older rows were unreachable. Fix (display-only): new "Older activity" range switch
  (#viewOlderTxBtn -> toggleTransactionRange -> APP.txShowOlder) plus
  updateTransactionRangeControls(fullHistory, recentHistory, showingAll). Default is still the
  short "Last 30 min" preview; all-activity mode renders the full stored history with
  "All activity" / hint.txLogAll labels. Existing TX_TYPE_LABELS/txTypeLabel render-only
  mapping, raw stored type/detail values, and the `=== 'Deposit'` comparisons are unchanged.
  Demo/live separation preserved (getCurrentData() still keys off the active wallet).
  An empty 30-minute window no longer hides older records. NOTE: logout still clears
  arbi_demo/arbi_live by design, so history does not survive a logout (unchanged).
- (3) DEMO -> LIVE REMINDER (restrained). The existing #demoFirstDepositCta banner is now
  gated: production-only, Demo-only, no confirmed deposit, AND >= DEMO_CTA_MIN_TRADES (3)
  meaningful demo trades; suppressed while APP.botRunning; rate limited by
  DEMO_CTA_REMINDER_INTERVAL_MS (10 min) so a hidden reminder is not re-raised after every
  trade; dismissal (dismissDemoDepositCta) is respected for the session. Added the loss-risk
  line (demoCta.risk) and a "Review Live Requirements" action (reviewLiveRequirements ->
  setMode('live') + toast) which reuses the onboarding review-only Live path, starts no
  deposit/invoice and touches no balance. The two secondary buttons share a wrapping row so
  the banner stays compact on small phones (278px tall at 320px, was 317px).
- (4) TICKER LABEL RESTORED TO "LIVE ACTIVITY" (management decision, reversing 645e67d's
  "Sample activity"). The markup points back at the pre-existing `ticker.live` key with the
  new wording and the pulsing red `.live-dot` (the inert grey inline override is gone). The
  dead `ticker.sample` key was deleted (dictionary 1392 -> 1391 keys/locale x6). Values:
  en "LIVE ACTIVITY", es "ACTIVIDAD EN VIVO", pt "ATIVIDADE AO VIVO", fr "ACTIVITE EN DIRECT"
  (accented), ar "nishat mubashir", zh "shishi huodong". tests/beginner_ux.test.js was
  updated from the old honesty pin to pin the restored label + live dot. CAVEAT (recorded;
  decision accepted): generateTickerItems() still builds the strip from TICKER_TEMPLATES +
  Math.random(), so the animated entries remain illustrative rather than a real-time feed of
  customer activity - wire the ticker to real data if that ever needs to be literal.
- i18n: 1384 -> 1392 -> 1391 keys/locale (8 NEW keys x 6 locales: history.allActivity,
  history.viewOlder, history.backToRecent, history.empty, hint.txLogAll, demoCta.risk,
  demoCta.reviewLive, demoCta.reviewLiveToast). Identical key sets, 0 empty, 0 new duplicate
  keys, 0 placeholder-parity issues, 786 data-i18n refs all defined. ar RTL intact.
- PRESERVED (verified): APP.MIN_WITHDRAWAL = 700 and server.js `amount < 700`; the cautious
  "withdrawal processing usually takes 15-30 minutes" wording; KYC / withdrawal gates
  (openWithdrawModal gate order, canWithdraw, verificationRequired) and all
  deposit/withdrawal/payment/balance/referral logic untouched (diff touches no such lines).
- VERIFICATION: npm test = 750 pass / 0 fail (was 725; +25 new). All 6 inline script blocks
  parse (vm.Script). i18n verifier (vm-eval of the real TRANSLATIONS) = 0 problems.
  Chromium harness (puppeteer-core + /usr/bin/chromium, stubbed fetch) = 92/92 checks across
  en/ar x 320/390: profile->support opens the modal ON TOP with the profile modal closed and
  zero credential inputs; history preview/older-toggle/switch-back with nothing deleted;
  demo reminder withheld at 0 trades, shown at 5, review-only (0 deposit/invoice requests),
  dismissal respected; ticker data-i18n still `ticker.sample`. Mobile matrix (en/es/ar/zh x
  320/360/390/412) = 16/16 clean: 0 horizontal overflow, CTA fits, all CTA buttons >= 30px
  and unclipped, support modal topmost, all-activity rows render.
- HARNESS NOTES (not product bugs, both baseline-identical): the stubbed init can leave
  #walletSyncLoader (z-index 9999) displayed, which would cover modals - the harness hides it
  only; and "TradingView is not defined" / "Chart is not defined" come from the blocked
  external CDN, identical on the untouched baseline.

## Phase 27 DEPLOYED TO PRODUCTION (2026-09-13)
- Deployment commit: 1bfba091a244bf49331cac5c6fbab598f1247efe
  ("fix: beginner UX - support from profile, history range, LIVE ACTIVITY ticker"),
  pushed e617cd7..1bfba09 main -> main on
  github.com/nuraabdullahi708090-sudo/arbitrix-app.
- Host: the push to main auto-deployed to https://arbitrix.pro within ~1 minute
  (observed: old build served at 22:21:17Z, new build at 22:21:47Z). NOTE the
  platform is NOT declared anywhere in the repo (no render.yaml/Procfile/
  Dockerfile/CI config), so Render is inferred from this auto-deploy behaviour
  plus management confirmation, not from a committed config file.
- Post-deploy verification: the served public/index.html is BYTE-IDENTICAL to the
  committed file (sha256 f052e81e908d1a1d671da5cb90782ace1e55bdc8f9a781790e5b1a03b6118c38).
  Live markers: "LIVE ACTIVITY" present, "Sample activity" 0, txShowOlder 5,
  reviewLiveRequirements 2, demoCta.risk 7, MIN_WITHDRAWAL: 700 preserved.
  Headless Chromium on the production URL: HTTP 200, 0 page errors, 0 failed
  requests, 0 horizontal overflow at 390px, auth page renders for a logged-out
  visitor. /reset-password.html 200, /api/health 200.
- AUTH NOTE: the credential embedded in the origin URL (ghu_...) no longer
  authenticates (it drops to a password prompt); the GITHUB_TOKEN secret does
  work. The origin URL was re-pointed at the token to complete the push.
- CHANGE SET: public/index.html + AGENTS.md + 7 test files. No server.js,
  services, migrations, DB schema or production configuration was modified.
- This deployment note is intentionally LEFT UNCOMMITTED so that recording it
  does not trigger a second production rebuild. The working tree therefore shows
  AGENTS.md as modified - it is documentation only.

## Phase 28 - Achievements Panel Moved Off the Dashboard (2026-09-13, public/index.html + tests, frontend-only)
- The Achievements panel was removed from the main dashboard and relocated into
  Profile Settings as a collapsed section, so the dashboard stays focused on
  trading. DISPLAY/LOCATION change only - the feature is preserved, not deleted
  (no JS logic, data, storage or styling was rewritten).
- WHAT CHANGED (public/index.html, 3 edits, 64 insertions / 12 deletions):
  1. The `.achievements-card` block was deleted from `#mainContent` (dashboard).
     Removed verbatim; it is now inside `#profileModal`, after the Arbitrix Pro
     summary card and before the account-help block.
  2. The panel is wrapped in `<details class="achievements-card
     profile-achievements" id="profileAchievements">` with the original
     `.achievements-header` markup as its `<summary>`. Collapsed by default.
  3. New scoped CSS (`.profile-achievements*`) for the summary/affordance, the
     adaptive columns and the break-word backstop. Every original
     `.achievements-card` / `.achievements-title` / `.achievements-counter` /
     `.achievements-progress*` / `.badges-grid` / `.badge-item` rule is
     byte-identical.
- ZERO JS CHANGES. All element ids are preserved (`badgesGrid`,
  `achievementsCounter`, `achievementsProgressFill`, `achievementsProgressText`,
  `achievementsProgressPct`), so `renderBadges()` / `checkBadges()` (called from
  `updateUI()`) keep working untouched - badge unlocking, toasts, confetti,
  ticker announcements and the `arbi_badges` per-wallet persistence are
  unaffected. The panel lives in the always-present modal markup, so
  `getElementById('badgesGrid')` still resolves on first render.
- RESPONSIVENESS FIX (real regression caught during verification): the profile
  modal is narrower than the old dashboard slot, so the inherited fixed
  3-column `.badges-grid` rule squeezed mobile cells to 85px and the
  "Unstoppable" badge name (71px) overflowed its 67px content box at 390/412px.
  Fixed with a SCOPED `.profile-achievements .badges-grid{repeat(auto-fill,
  minmax(104px,1fr))}` plus `overflow-wrap:break-word` on the name/desc. Cells
  are now 105-143px on mobile with 2 columns; 16/16 locale x width scenarios
  clean (en/es/ar/zh x 320/360/390/412).
- NO empty space: `#mainContent` is a vertical card stack, so removing the card
  leaves no gap - measured 16px (the normal card margin) between
  `.trading-stats-card` and the next visible card at every tested width.
- PRESERVED/UNTOUCHED (verified): the activity ticker banner (0 diff lines
  mentioning ticker/live-dot/LIVE ACTIVITY/sample - "SAMPLE ACTIVITY"/"LIVE
  ACTIVITY" was NOT modified by this phase), `APP.MIN_WITHDRAWAL = 700`, all
  deposit/withdrawal/payment/trading/balance/bot/chart/transaction code, and
  the i18n dictionary (still 1391 keys/locale x 6, full parity - NO new keys
  were needed because `achievements.*` already exists in all locales).
- FILES: M public/index.html, M AGENTS.md, ?? tests/achievements_panel.test.js.
  No server.js, services, migrations, DB schema, package or production
  configuration changed.
- VERIFICATION: `npm test` = 759 pass / 0 fail (750 baseline + 9 new in
  tests/achievements_panel.test.js, which pins: panel absent from the dashboard
  slice, feature preserved, panel inside the profile modal, collapsible
  wrapper + no new navigation, CSS preservation + adaptive columns, a vm-run of
  the real `renderBadges()` against the moved markup (12 badges, counter and
  progress still update), i18n parity at 1391 keys, and financial/backend
  non-involvement). Browser harness (puppeteer-core + chromium, stubbed fetch)
  = 60/60 across en/ar x 320/390: panel gone from the dashboard, present and
  collapsed in Profile, expands to 12 badges, charts/stats/transactions/bot
  still render, ticker intact, $700 intact, 0 horizontal overflow, 0 page
  errors. Screenshots: /tmp/uxverify/shots/ach-*.png.
- NOTE: this phase is NOT committed, NOT pushed and NOT deployed (the working
  tree also still carries the uncommitted Phase 27 deployment note above).

## Phase 28 DEPLOYED TO PRODUCTION (2026-09-13)
- Deployment commit: 3768fa2f82835b83c3f0dca159d13aa609932f0d
  ("refactor: move achievements to profile settings"), pushed
  1bfba09..3768fa2 main -> main to github.com/nuraabdullahi708090-sudo/arbitrix-app
  with the GITHUB_TOKEN-authenticated origin URL (the token embedded in the
  original remote URL is dead and drops to a password prompt).
- Auto-deployed to https://arbitrix.pro within ~1 minute (old build observed at
  22:39:42Z/22:40:08Z, new build at 22:40:33Z).
- Post-deploy verification: the served public/index.html is BYTE-IDENTICAL to
  the committed file (sha256 e3c5b29fa0a3051db2f855f5993097ddca20d87d4c8c24f618ab25b85123d73a).
  Live markers: id="profileAchievements" 1, adaptive grid rule 1, ticker
  "LIVE ACTIVITY" 1, ticker.sample 0, MIN_WITHDRAWAL: 700 1. Placement in the
  served HTML confirms mainContent at 278553 < profileModal at 437841 <
  achievements panel at 443351, i.e. the panel is inside the profile modal and
  absent from the dashboard slice, which still contains chart/trading-stats/MTA.
- Production smoke (headless Chromium on the live URL, en@390 / en@1280 /
  ar@390) = 36/36: panel NOT in the dashboard, panel inside the profile modal,
  collapsed by default with the 0/12 counter markup intact, expand-on-click
  works, dashboard content intact, LIVE ACTIVITY ticker intact, 0 horizontal
  overflow, 0 page errors, 0 failed requests. /reset-password.html 200,
  /api/health 200.
- HARSHESS NOTE for future production checks: an anonymous visitor never runs
  the authenticated `updateUI()`, so `#badgesGrid` is legitimately EMPTY on the
  live site until login - badge population must be verified with the local
  harness against the byte-identical file (60/60), not against the anonymous
  production page. Also use `textContent` (not `innerText`) when reading text
  inside hidden subtrees, and accept 304 for cached page loads.
- This deployment note is intentionally LEFT UNCOMMITTED so recording it does
  not trigger a second production rebuild. The working tree therefore shows
  AGENTS.md as modified - it is documentation only.

## Phase 29 - Demo CTA copy trim + support surface de-overlap (2026-09-13, public/index.html + tests, frontend-only)
- Two approved UI fixes. NO changes to server.js, services, Supabase, migrations,
  DB schema, payment processing, deposit/withdrawal/trading/bot logic, wallet
  math, production config, the LIVE ACTIVITY ticker, or the Phase 28
  achievements relocation. Not committed, not pushed, not deployed.

### 1. "Ready for real trading?" card (`#demoFirstDepositCta`) - 2nd paragraph removed
- The card now ends after the first paragraph, before the buttons:
  heading `demoCta.title` + ONE paragraph `demoCta.body` ("You're exploring with
  virtual funds. Make your first deposit to fund your Live balance. Demo funds
  stay virtual and cannot be withdrawn.") - BYTE-IDENTICAL to before.
- REMOVED ELEMENT (the only markup deletion):
  `<div style="font-size:11px;color:#8896B5;line-height:1.6;margin-top:6px;"
   data-i18n="demoCta.risk">Live Mode uses real funds and trading involves risk
   - you can lose money. Demo funds are virtual and can never be withdrawn.</div>`
  Nothing replaced it (no substitute wording was invented).
- KEPT: the heading, the first paragraph, "Make My First Deposit"
  (openDepositModal), "Review Live Requirements" (reviewLiveRequirements),
  "Maybe later" (dismissDemoDepositCta) - all handlers unchanged.
- The now-dead `demoCta.risk` key was DELETED from all 6 locales (a stale key
  would invite the paragraph back). Dictionary 1391 -> 1390 keys/locale, parity
  intact across en/es/pt/fr/ar/zh. The 5 count pins were updated
  (achievements_panel / beginner_ux / deposit_demo_ux / onboarding_funnel /
  sandbox_withdraw_wording) and `tests/demo_live_reminder.test.js` now asserts
  the paragraph is ABSENT, the `demoCta.risk` key is RETIRED in every locale,
  and the retained `demoCta.*` keys still exist.

### 2. Contact Support vs. floating assistant overlap - FIXED
- ROOT CAUSE (measured, not guessed): the floating assistant widget
  `.support-widget` is `z-index:9998` while the Support Center modal
  (`#supportModal`, class `.deposit-modal`) is `z-index:3000`. So the assistant
  panel - and even just the launcher FAB - rendered ON TOP of the Support
  Center. Reproduction with the pre-change file: `panelVisible:true,
  overlap:true, active surfaces:2` (EN and AR, 390px). Two support surfaces
  were live at once.
- FIX (3 small edits, no new destination, no new component):
  1. CSS (stale-proof, tracks the modal's own class so it holds no matter which
     of the 7 "Contact Support" buttons opened it): 
     `body:has(#supportModal.open) .support-widget{display:none;}`
  2. `openSupportModal()` also collapses the assistant
     (`#supportPanel.classList.remove('open')`), so it cannot reopen on top of
     or outlive the modal.
  3. `toggleSupport()` closes `#supportModal` when it is opening the assistant,
     so the reverse direction also keeps exactly one surface active.
  `closeSupportModal()` was NOT changed: hiding the widget is pure CSS, so
  closing the modal restores the launcher automatically (verified).
- PRESERVED: assistant quick replies (3), message input, sendSupportMessage,
  the official Telegram link/`openSupportModal` entry points, and the assistant
  itself. Duplicate-open is structurally impossible (single `#supportPanel` /
  `#supportModal` nodes; `classList.add` is idempotent) and was verified by
  tapping Contact Support 5x + the FAB 3x -> still 1 panel / 1 widget / 1 modal
  / 1 FAB and <= 1 active surface.
- VERIFICATION: dedicated harness `/tmp/uxverify/support_overlap.js`
  (puppeteer-core + chromium, stubbed fetch) at 320/360/390/412px:
  BEFORE 44 pass / 20 fail -> AFTER 64 pass / 0 fail. Covers: one active
  surface, no panel/modal competition, launcher not floating over the modal,
  duplicate taps, close dismisses + launcher returns, close button visible and
  tappable, FAB >= 44px, modal fits the viewport, no horizontal overflow, and
  the assistant still usable (quick replies + 36px-tall input) on mobile.
  Before/after screenshots: /tmp/uxverify/shots/support-{BEFORE,AFTER}-{390,ar-390}.png.
- Demo-card harness `/tmp/uxverify/demo_cta_card.js`: 169 pass / 0 fail across
  4 widths x 6 locales (heading kept, exactly one paragraph = `demoCta.body`,
  removed paragraph absent from the DOM and from the card's copy, 3 actions with
  handlers, all tappable and in-viewport, no overflow, no page errors, and the
  EN first paragraph byte-identical to the approved text).
- `npm test` = 759 pass / 0 fail. Inline script blocks parse (6/6, 0 errors).
- HARNESS LESSONS (repeated): read `textContent` (not `innerText`) inside
  hidden subtrees; `checkVisibility()` needs `{visibilityProperty:true,
  opacityProperty:true, contentVisibilityAuto:true}`; scope "is this copy gone"
  checks to the component (other surfaces legitimately use risk wording); and
  reset surface state before a step that assumes a starting condition.

## Phase 29 DEPLOYED TO PRODUCTION (2026-09-13)
- Deployment commit: d09cc192d3594a6fa4a506c9420176c97c536b01
  ("fix: clean demo CTA and prevent support modal overlap"), pushed
  3768fa2..d09cc19 main -> main to github.com/nuraabdullahi708090-sudo/arbitrix-app.
  Pre-push checks: branch main, clean tree, HEAD == approved SHA, remote still at
  the previous commit, `git merge-base --is-ancestor` confirmed a normal
  fast-forward of exactly 1 commit. No force-push/rebase/reset/amend/squash.
- HOSTING: production is RENDER, confirmed by the response header
  `x-render-origin-server: Render` (behind Cloudflare). Render auto-deployed on
  push within ~52s (old build 23:14:30Z -> new build 23:14:56Z); no manual
  trigger or alternate host was used.
- Post-deploy verification: the served public/index.html is BYTE-IDENTICAL to the
  committed file (sha256 91b33cb58a92852ae3f0f50ea1dd46b49479b1bfd48cd80fb7d14362961111d3).
  `/api/health` -> `{"status":"ok"}` HTTP 200.
- Production smoke (headless Chromium on the live URL; en@320 / en@390 /
  en@1280 / ar@390) = 80/80: the removed risk paragraph is absent from the DOM
  and the card holds exactly ONE paragraph (`demoCta.body`) byte-identical in EN;
  heading + all 3 actions intact; achievements NOT in the dashboard and present
  + collapsed in Profile Settings; LIVE ACTIVITY ticker intact; Contact Support
  opens the Support Center with the floating assistant NOT overlapping
  (1 active surface); closing restores the launcher (FAB >= 44px, in viewport);
  duplicate taps create no extra panels; opening the assistant dismisses the
  modal; 0 horizontal overflow; 0 page errors.
- IMPORTANT NUANCE for future prod checks: the string "Live Mode uses real
  funds" still appears twice on the live site, but in UNRELATED, untouched copy -
  `auth.explainer.live` (auth brand panel) and `pwa.install` (PWA install
  prompt) - both unchanged from the previous build (6 occurrences each = 1 key x
  6 locales). The demo CTA CARD contains neither `demoCta.risk` nor that phrase
  (before: both true; after: both false). Do not "fix" those other two keys.
- This deployment note is intentionally LEFT UNCOMMITTED so recording it does not
  trigger a second Render rebuild. The working tree therefore shows AGENTS.md as
  modified - documentation only.

## Phase 30 - Demo Deposit Modal UX reorder + copy trim (2026-09-13, public/index.html + tests, frontend-only)
- Approved deposit-modal UX change. Frontend-only: NO changes to server.js,
  services, Supabase, migrations, deposit/withdrawal/payment/wallet/trading
  logic, address generation or validation, the minimum deposit amount, the
  LIVE ACTIVITY ticker, or any inline JS (verified: 0 JS-ish lines in the
  public/index.html diff). Not committed, not pushed, not deployed.
- NEW ORDER inside `#depositInputSection` (verified by rect-top ordering in the
  browser at 320/360/390/412px): `#depositDemoNotice` (incl. Switch to Live &
  Continue) -> `#supportedCoinsInfo` (USDT / TRON (TRC20)) -> `#depositUsdtHelp`
  (collapsed) -> Amount (USD) label -> `#depositMinNotice` -> `#liveDepositAmount`
  input -> amount presets -> `#getAddressBtn` -> `#safetyWarning` -> help link.
- GENERATE PAYMENT MOVED: `#getAddressBtn` was lifted out of
  `#depositActionButtons` (which sits AFTER `#depositPaymentSection`) into a new
  `#generatePaymentRow` immediately under the amount presets. The element itself
  is byte-identical (same id/classes/inline style/onclick), so
  `requestDepositAddress()` and every existing show/hide call
  (showPaymentSection -> `display:none`, expiry -> `display:flex`,
  resetDepositModal -> `display:block`, demo guard -> `display:none`) still work.
  Cancel / Refresh Status / New Invoice deliberately STAY in
  `#depositActionButtons` because they must remain reachable in step 2, where
  `#depositInputSection` is hidden.
- REMOVED (approved): the `#initialInstructions` block ("Enter your deposit
  amount and click 'Generate Payment' to receive your unique USDT (TRC20)
  payment address.") plus its now-dead `deposit.initialInstructions` key in all
  6 locales. Dictionary 1390 -> 1389 keys/locale, key sets identical, 0 empty.
- "New to this payment method?" converted from an always-visible paragraph into
  a compact COLLAPSED `<details class="deposit-usdt-help">` (new CSS following
  the `.profile-achievements` pattern: `list-style:none`, hidden webkit marker,
  `::after` chevron rotating on `[open]`, `min-width:0` + `overflow-wrap` so it
  never overflows at 320px). Its body is the approved short paragraph
  ("USDT is a digital dollar. TRC20 is the network used for this deposit.
  Make sure your exchange or wallet supports USDT on TRC20.") in all 6 locales.
  It sits directly under the "Currently Supported" banner it explains - a
  judgement call, since the approved order list covers items 1-9 and this
  element is supplementary reading (collapsed, ~40px).
- WARNING SHORTENED (approved): `deposit.safetyWarningBody` is now
  "Sending through another network may result in loss of funds or delayed
  credit." in all 6 locales (was "...may result in loss of funds and may not be
  credited automatically."). The first line still renders from
  `deposit.sendUsdtOnly` + `deposit.onThe` + the TRON (TRC20) <strong> +
  `deposit.networkSuffix`, so the "Send USDT only"/network emphasis is kept and
  the full rendered sentence is exactly the approved
  "Send USDT only on the TRON (TRC20) network." + the shortened second line.
  NO network-safety information was dropped (TRC20-only requirement, "Send USDT
  only", loss-of-funds consequence all retained).
- EXTRA FIX (pre-existing locale defects in the very line this task finalised):
  the shared fragments made the first sentence read wrong in 5 of 6 locales -
  AR duplicated the word ("... على شبكة TRON (TRC20) الشبكة"), and ES/PT/FR/ZH
  put the network name between article and noun ("en la TRON (TRC20) red").
  The fragments are used ONLY by this warning. Normalised per locale:
  `deposit.onThe` es 'en la red' / pt 'na rede' / fr 'sur le réseau' /
  ar 'على شبكة' (zh/en unchanged), and `deposit.networkSuffix` en ' network.' /
  es/pt/fr/ar '.' / zh ' 网络上。'. The hard-coded space before the suffix span in
  the markup was moved INTO the fragment so punctuation attaches cleanly
  ("TRON (TRC20)." not "TRON (TRC20) ."). Rendered warning per locale now:
  EN "Send USDT only on the TRON (TRC20) network. Sending through another network
  may result in loss of funds or delayed credit."
  ES "Envía solo USDT en la red TRON (TRC20). Enviar por otra red puede provocar
  la pérdida de fondos o un abono con retraso."
  PT "Envie apenas USDT na rede TRON (TRC20). Enviar por outra rede pode resultar
  em perda de fundos ou crédito atrasado."
  FR "Envoyez uniquement de l'USDT sur le réseau TRON (TRC20). Envoyer via un
  autre réseau peut entraîner une perte de fonds ou un crédit retardé."
  AR "أرسل USDT فقط على شبكة TRON (TRC20). قد يؤدي الإرسال عبر شبكة أخرى إلى
  فقدان الأموال أو تأخر الإيداع."
  ZH "仅发送 USDT 在 TRON (TRC20) 网络上。通过其他网络发送可能导致资金损失或到账延迟。"
- BEHAVIOURAL NUANCE TO KNOW (not a regression of any rule): because
  `#getAddressBtn` now lives inside `#depositInputSection`, the invoice-EXPIRY
  handler's `getAddressBtn.style.display='flex'` becomes inert (that section is
  hidden in step 2). The same handler also reveals `newInvoiceBtn`
  ("New Invoice" -> the identical `requestDepositAddress()` call), so the user is
  never stuck; only the duplicate button is no longer shown on the expired
  screen. No JS was changed to achieve this - flagged for a decision if the
  duplicate is wanted back (it would need a one-line JS change, out of scope).
- TESTS: updated `tests/support_ui.test.js` (the deposit-support test anchored on
  `#initialInstructions`, which is gone -> now anchors on `#safetyWarning` with a
  1800-char window) and the 5 dictionary-count pins 1390 -> 1389. `npm test` =
  759 pass / 0 fail.
- VERIFICATION: new harness `/tmp/uxverify/deposit_modal.js` = 148 pass / 0 fail
  (4 widths x EN + 6 locales at 390px, all network stubbed - NO real invoice was
  ever created). Covers: requested rect-top order (Demo-mode visible order +
  LIVE-mode order incl. Generate), structural adjacency
  (presets.nextElementSibling === #generatePaymentRow), Generate no longer in
  `#depositActionButtons`, all kept items present (Switch CTA, USDT/TRON(TRC20),
  amount label, min text "$100", input, 4 presets, warning, help link ->
  openSupportModal), redundant instruction absent from the DOM, warning
  shortened with TRC20 + loss-of-funds retained, explainer collapsed by default
  with the approved text and expanding on tap, no block overlap, 0 horizontal
  overflow and 0 raw i18n keys at every width/locale, AR RTL ok, and the full
  flow: Demo -> switch to Live (modal stays open) -> Generate Payment POSTs
  /api/payment/create-invoice with the entered amount (100, USDT, TRC20) ->
  payment section shown / input section hidden / address populated.
  Screenshots: /tmp/uxverify/shots/depmodal-{en-320..412,ar-390,es-390}.png.
- NOT committed / NOT pushed / NOT deployed. Working tree also carries the
  uncommitted Phase 29 deployment note in AGENTS.md.

## Stage 19A - Mode-Aware "Start Here" Onboarding Card (2026-09-14, public/index.html + tests, frontend-only)
- Problem: the dashboard onboarding card showed demo-only instructions ("Start the demo bot",
  "Watch how demo activity is displayed", "Switch to Live Mode when ready") even while the
  account was already in LIVE Mode.
- What changed (DISPLAY ONLY) - the card content is now mode-aware:
  - DEMO Mode: UNCHANGED. The original 5-step beginner checklist and the "Start Here"
    title/subtitle are byte-identical to the previous build.
  - LIVE Mode: a Live Mode Guide header (`startHere.live.title` / `.subtitle`) plus a 4-step
    checklist built ONLY from requirements the product actually enforces:
      step1 platform minimum deposit (APP.MIN_DEPOSIT, currently $100)
      step2 minimum trading balance to start the bot (APP.MTA - server-driven via /api/auth/me
            and getEffectiveMta(); currently $200; MARKETING_SANDBOX reports 0 and needs none)
      step3 identity verification, required to withdraw
      step4 withdrawal minimum + completed-trade requirement (APP.MIN_WITHDRAWAL, $700)
    The steps are rendered through t(key, vars) because the amounts are configuration-driven,
    and updateDynamicTranslations() re-renders them on language switch. No demo wording and no
    "Switch to Live Mode when ready" is DISPLAYED in LIVE Mode (the demo rows stay in the DOM,
    hidden, so the demo checklist is preserved for DEMO Mode).
  - LIVE completion state: when APP.liveData.hasRealDeposit AND hasTradingActivity (the
    existing reliable server flags from /api/auth/me - no new or fake progress tracking), the
    checklist is replaced by the compact line `startHere.live.ready`.
- Helpers added: `startHereLiveSteps()`, `startHereLiveComplete()`, `renderStartHereLiveSteps()`;
  `updateStartHere()` is now mode-aware. Switching is already covered because
  setMode() -> updateUI() -> updateStartHere(); the language switch is covered by adding
  updateStartHere() to updateDynamicTranslations().
- Unchanged: dismissal (arbi_starthere_<id>), MARKETING_SANDBOX hiding, card styling/layout,
  the DEMO copy, and every financial/backend path (deposits, withdrawals, trading, bot, the MTA
  value, subscription, KYC, referral). server.js is untouched by this stage.
- i18n: 1391 -> 1398 keys/locale (7 new startHere.live.* keys x 6 locales; EN values for the
  1391 pre-existing keys byte-identical). Identical key sets, 0 empty, 0 placeholder-parity
  issues ({{min}}, {{mta}}, {{wmin}}).
- Tests: NEW tests/starthere_mode_aware.test.js (13 tests) + dictionary-count pins updated
  (1391 -> 1398) in 6 existing test files. npm test = 805 pass / 0 fail.
- Browser verification (puppeteer-core + /usr/bin/chromium, stubbed API): DEMO card unchanged;
  LIVE shows the guide + 4 steps with $100/$200/$700 and NO demo wording and NO "Switch to Live
  Mode when ready" (visibility-aware innerText check); completion state shows the ready line;
  DEMO<->LIVE switching updates the card both ways; dismiss hides the card in both modes; a
  MARKETING_SANDBOX account never sees the card; all 6 locales render correctly (ar RTL) with
  no raw keys; 0 horizontal overflow and 0 text clipping at 320/360/390/412/1280px.
  Screenshots: /tmp/s19a_shots/{demo,live}-390.png.
- TOOLING NOTE (important for future sessions): passing public/index.html through a
  text re-encoder corrupted the file's legacy non-ASCII (em-dashes, emoji, Arabic, Chinese)
  into CP866-style mojibake across the WHOLE file. The file was restored from HEAD and the
  change re-applied with an ASCII-only Python script that writes non-ASCII as \u escapes.
  After any scripted edit to public/index.html, diff the whole file and assert that no
  pre-existing non-ASCII code point was lost.

## Stage 19A DEPLOYED TO PRODUCTION (2026-09-14)
- Deployment commit: 80ac53a85eb5bed5404e5a82f8fcfbcaf6e17d02
  ("fix: make dashboard onboarding card mode-aware (LIVE vs DEMO)"), pushed
  e8fe74f..80ac53a main -> main to github.com/nuraabdullahi708090-sudo/arbitrix-app
  (fast-forward, verified with git merge-base --is-ancestor before the push).
  The origin URL was re-pointed at the GITHUB_TOKEN-authenticated URL for the push
  (the credential previously embedded in the remote URL no longer authenticates).
- Hosting: RENDER (response header x-render-origin-server: Render). Auto-deployed on
  push: the previous build was still served at ~t+30s and the new build at ~t+40s.
- Post-deploy verification:
  - The served public/index.html is BYTE-IDENTICAL to the committed file
    (sha256 e7ff4c1ec5984eb846a5a9260dad7eaeece660d22d2bb382c7cfd36780430d89);
    the previous deployed hash was ef69d17bf735d04743cc93daa6c596fc17d56307683c1f8794d3f08c3197a302.
  - Endpoints: / 200 (text/html), /api/health 200, /reset-password.html 200.
  - Production smoke (headless Chromium on the LIVE page, no login needed because the
    deployed JS was exercised directly against the served DOM) = all PASS:
    DEMO -> demo header + demo checklist visible, every live element hidden, no live
    steps rendered; LIVE -> demo header/steps hidden, "Live Mode Guide" + the 4
    requirement steps visible with $100 / $200 / $700, no demo wording anywhere in the
    visible card, and no "Switch to Live Mode when ready"; completion state -> ready
    line visible and the checklist hidden; demo checklist still intact; 0 horizontal
    overflow at 390px; 0 page errors (the old updateVerificationModalHeader console
    error did not appear - it was fixed in an earlier stage).
- CHANGE SET: public/index.html, AGENTS.md, tests/starthere_mode_aware.test.js (new) and
  dictionary-count pins in 6 existing test files. No server.js, services, migrations, DB
  schema, payment/deposit/withdrawal/wallet/trading/KYC/referral code or production
  configuration was modified.
- This deployment note is intentionally LEFT UNCOMMITTED so that recording it does not
  trigger a second Render rebuild. The working tree therefore shows AGENTS.md as modified
  - it is documentation only.

## Stage 19B - LIVE Card Reduced to Two Steps (2026-09-14, public/index.html + tests, frontend-only)
- Management direction: the LIVE Mode card shows exactly TWO steps; the verification and
  withdrawal steps are removed.
  - step1 (new EN): "Deposit at least ${{min}} to activate Live funding"
  - step2 (new EN): "Maintain at least ${{mta}} available balance to start the bot"
- Removed from LIVE Mode entirely: `startHere.live.step3` (identity verification before
  withdrawal) and `startHere.live.step4` (withdrawal minimum + completed trade) - deleted from
  `startHereLiveSteps()` and from all 6 dictionaries. They were used ONLY by the card; shared
  keys were NOT touched (e.g. `withdraw.info` ("Min withdrawal: $700 ...") and
  `withdraw.kycRequiredBody` ("Verify your account to withdraw.") are still present and used by
  the withdraw modal). `APP.MIN_WITHDRAWAL` is no longer referenced by the card.
- Unchanged: the LIVE header (`startHere.live.title`/`subtitle`), the completion state
  (`APP.liveData.hasRealDeposit && hasTradingActivity` -> `startHere.live.ready`), DEMO Mode
  (all five original steps and their wording), dismissal, MARKETING_SANDBOX hiding, card
  styling, mode switching, routing and every backend path. server.js untouched.
- i18n: 1398 -> 1396 keys/locale (2 keys removed per locale, 6 locales); identical key sets,
  0 empty, placeholder parity OK ({{min}} in step1, {{mta}} in step2).
- Tests: tests/starthere_mode_aware.test.js updated for the two-step model (asserts exactly two
  steps, the removed keys absent in every locale, and that the removed copy never renders);
  dictionary-count pins 1398 -> 1396 in 6 existing test files.
  Focused: 13/13 pass. Full suite: npm test = 805 pass / 0 fail.
- Browser (puppeteer-core + /usr/bin/chromium, stubbed API): DEMO shows the 5 original steps;
  LIVE shows EXACTLY two numbered steps with $100 / $200 and none of the removed withdrawal/
  verification wording and no demo wording; DEMO<->LIVE switching works both ways; completion
  line still shown; all 6 locales render with no raw keys (ar RTL); 0 horizontal overflow and
  0 text clipping at 320/360/390/412/1280px; the MARKETING_SANDBOX account still hides the card.
  Screenshots: /tmp/s19b_shots/{demo,live}-390.png.
- (The Stage 19A deployment note above is included in this commit; it was previously kept
  uncommitted only to avoid a second Render rebuild, and this push rebuilds anyway.)

## Stage 19C - Temporary Withdrawal Verification Gate (2026-09-14, server.js + .env.example + tests)
- Management decision: account verification is NOT required to withdraw at this time.
  The verification requirement is DISABLED behind ONE server-side flag (not deleted):
  `const WITHDRAWAL_REQUIRES_VERIFICATION = String(process.env.WITHDRAWAL_REQUIRES_VERIFICATION || '')
  .trim().toLowerCase() === 'true';` (server.js, next to REFERRAL_EARNINGS_MIN_CONVERT_USD).
  Default OFF. To RESTORE the previous KYC-first gate: set the env var to `true`
  (documented in .env.example as WITHDRAWAL_REQUIRES_VERIFICATION=false).
- ROOT CAUSE of the modal in the screenshot: BOTH layers still enforced the old rule -
  (a) `/api/withdraw/request` returned 400 `{error:'Identity verification required',
  verificationRequired:true,status,redirectTo:'/#/verification'}` as Gate 2, and
  (b) `/api/kyc/can-withdraw` returned `canWithdraw: isVerified`, which drove the frontend
  `openWithdrawModal()` Gate 2 to show `#withdrawKycRequired`
  ("Verification Required / Verify your account to withdraw.") and `submitWithdrawAPI()`
  rendered the same block on `data.verificationRequired`.
- FIX (smallest safe, fully reversible): the KYC block in `/api/withdraw/request` is now
  wrapped in `if (WITHDRAWAL_REQUIRES_VERIFICATION) { ... }` (code unchanged inside), and
  `/api/kyc/can-withdraw` reports `canWithdraw: requiresVerification ? isVerified : true`,
  `verificationRequired: requiresVerification && !isVerified` plus
  'Verification not required for withdrawals'. The FRONTEND needs no change: it is driven
  entirely by that response, so the UI and the API can never disagree (verified by a browser
  run in BOTH modes - with the flag off the form opens; with canWithdraw=false the old
  verification block returns).
- PRESERVED (pinned by tests): authMiddleware; first-deposit priority gate;
  `amount < 700` ("Min $700"); balance check ("Insufficient balance"); address check
  (>= 10 chars, "Valid address required"); completed-trade check ("Complete at least 1
  trade first"); the referral-earnings rules; the debit + `withdrawals` insert with
  status 'pending'; sandbox short-circuits; the whole KYC system (endpoints, service,
  review) is untouched. NOTE: the production route has NO duplicate/pending-withdrawal
  guard or withdrawal-specific rate limit today - that was true before this change and is
  unchanged (the sandbox has its own simulated protections, also untouched).
- Tests: NEW tests/withdraw_verification_flag.test.js (18) - flag single-source + default
  OFF for missing/invalid values, gate wrapped in the flag, restore path intact,
  capability response flag-driven, every preserved rule still present, frontend is
  API-driven (no client-side verification gate), KYC system intact, .env.example documented,
  and the flag used in only 2 executable places. tests/withdraw_gating.test.js mirror now
  models the flag (requireVerification=false default) and gained 10 tests proving: an
  unverified user is not rejected, proceeds to the next validation, and that minimum /
  trade / balance / address / first-deposit rules still apply, plus approved-user equality
  across both modes. tests/sandbox_no_kyc.test.js pin updated to the flag-aware
  can-withdraw form. npm test = 833 pass / 0 fail.
- Browser (puppeteer-core + chromium, stubbed API, local server): unverified + all rules
  otherwise satisfied -> modal opens with the withdrawal form and NO verification UI;
  unverified + below $700 -> the existing minimum message; unverified + no trade -> the
  existing trade message; unverified + no deposit -> the existing first-deposit message;
  server rejecting another rule -> mapped existing error, no verification UI; and with
  canWithdraw=false (flag restored) the verification block is visible again. 0 page errors.
  Screenshots: /tmp/s19c_shots/modal-unverified-ok-390.png, modal-flag-on-390.png.
- NOT committed/pushed/deployed at the time of writing (combined with Stage 19D below).

## Stage 19D - Collapsible Pending Referrals Panel (2026-09-14, public/index.html + tests)
- The Referral Program page used to render every pending referral inline. It is
  now a collapsible panel: COLLAPSED by default, a compact summary row
  ("Pending Referrals (N)" + "Awaiting first deposit" + "Tap to view" + chevron),
  expanding on tap to the existing name / registration-date / awaiting-deposit
  rows, and collapsing again on the same header tap. Presentation only - no
  referral data, eligibility, status, reward or backend change.
- WHY there was no functional bug hidden here: the previous code simply set
  `section.style.display = 'block'` and dumped the rows into the page; the list
  was always visible once loaded. The new panel keeps the same data source
  (`APP.referralStats.pendingReferralsList`) and only changes how it is shown.
- Markup (`#pendingReferralsSection`): a real `<button id="pendingReferralsToggle">`
  (large tap target, Enter/Space for free, `aria-expanded`, `aria-controls`,
  `onclick="togglePendingReferrals()"`), `#pendingReferralsList` with the native
  `hidden` attribute, and a compact `#pendingReferralsEmpty` note. The chevron is
  `aria-hidden` decoration; `#pendingRefA11yState` is a visually-hidden localized
  label ("Expand/Collapse pending referrals"). Labels are re-localized on
  language switch by a hook added to `updateDynamicTranslations()`.
- JS: `pendingReferralsOpen()` / `renderPendingReferralsList()` /
  `setPendingReferralsExpanded()` / `togglePendingReferrals()` /
  `updatePendingReferralsList()`. The open state lives in `APP.referralPendingOpen`
  (default collapsed) so a REFRESH or LANGUAGE SWITCH can never auto-expand (or
  force-collapse) the panel. `togglePendingReferrals()` is a no-op when there are
  no pending referrals, so the empty state has no expandable panel at all. The
  renderer is read-only: no referral-data writes, no API calls, no status logic.
  `appLocale()` (Phase 3F) is now also used for the registration date display.
- i18n: 1396 -> 1402 keys/locale. REMOVED `referral.pendingAwaiting` (the old
  header, exclusively used by this block) and ADDED 7 keys x 6 locales:
  `referral.pending.titleCount` ('Pending Referrals ({{count}})' - dynamic count),
  `referral.pending.subtitle`, `referral.pending.tapToView`,
  `referral.pending.tapToHide`, `referral.pending.empty`,
  `referral.pending.a11y.expand`, `referral.pending.a11y.collapse`. Identical key
  sets across en/es/pt/fr/ar/zh, 0 empty values, `{{count}}` parity on all 6.
  Dynamic strings (count, hint, a11y label) are JS-owned and deliberately NOT
  `data-i18n` targets, so `applyTranslations()` cannot clobber them.
- CSS: `.pending-ref-*` classes use existing tokens (`--border-color`,
  `--text-secondary`, and the brand gold `#F0B90B`), `min-height:56px` full-width
  tap target, `:focus-visible` outline, chevron `rotate(180deg)` driven by
  `[aria-expanded="true"]`, `overflow-wrap:anywhere` + `min-width:0` overflow
  safety and a `.pending-ref-a11y` visually-hidden utility (the app had none).
- PRESERVED: `#refActiveCount`, `#refPendingCount`, `#refTotalEarned`,
  `#referralCodeDisplay`, `#referralLinkDisplay`, `#copyReferralBtn`,
  `#copyReferralLinkBtn`, `#shareReferralBtn`, the reward/percent copy, the
  "Awaiting deposit" status chip and the whole referral data pipeline
  (`.filter(r => r.status === 'pending')` mapping unchanged).
- Tests: NEW tests/pending_referrals_collapsible.test.js (22) - markup/a11y,
  collapsed default, expand + collapse by tap, dynamic count (0/1/3), compact
  non-expandable empty state, refresh never self-expands, the user's expanded
  choice survives a refresh, language switch translates without changing state,
  all-locale rendering without raw keys, i18n parity + placeholder parity +
  removed old key, preserved referral surfaces, presentation-only proof, and the
  CSS contract. Dictionary-count pins updated 1396 -> 1402 in 6 test files.
  npm test = 855 pass / 0 fail. git diff --check clean.
- Browser (puppeteer-core + chromium, local server, stubbed API): 47/47 checks -
  0/1/2 pending referrals, collapsed on load, real tap (on the header TEXT, not
  the chevron) expands, tap again collapses, keyboard Enter/Space toggles,
  count dynamic, language switch (es + ar RTL) renders translated labels and
  keeps the collapsed state, refresh never self-expands, expanded choice
  survives a refresh, 0 horizontal overflow, no page errors. Plus a width sweep
  (320/360/390/430 x en/es/ar/zh) = 16/16: no overflow, no clipping in the
  title/hint/row. Screenshots: /tmp/s19d_shots/{collapsed,expanded}-{1,2}-390.png,
  es-collapsed-{1,2}-390.png.
- NOT committed/pushed/deployed at the time of writing (committed together with
  the Stage 19C wrap-up in the same session).

## Quick Fix - $700 Minimum Message Scoped to Eligible Accounts (2026-09-14, public/index.html + tests)
- The "$700 minimum withdrawal" wording used to appear for accounts that were
  nowhere near eligible: the modal's minimum-amount gate ran BEFORE the deposit
  and trade gates, and the sidebar/info-box catch-all branch showed
  `live.withdrawStatus.needMinimum` to ANY deposited + traded account, including
  one below the minimum trading balance.
- NEW RULE: the $700 message is shown ONLY for an account that has (a) made a
  real deposit, (b) completed a trade and (c) reached the minimum trading
  balance (MTA). Everything else shows the requirement actually missing:
    not deposited                      -> 'Please make a minimum deposit of $100 ...'
    deposited, no trade                -> 'Complete at least 1 trade to withdraw'
    deposited + traded, below the MTA  -> NEW 'Keep trading to reach the minimum withdrawal balance.'
    deposited + traded, >= MTA, < $700 -> the $700 minimum  (the ONLY case)
    >= $700                            -> 'Ready to withdraw (min $700)'
- `openWithdrawModal()` gate order is now: demo -> sandbox -> first-deposit
  priority -> KYC (flag-aware) -> deposit -> trade -> MINIMUM TRADING BALANCE
  -> minimum withdrawal amount -> form. The MTA guard is
  `totalWithdrawable < (Number(APP.MTA) || 0)`, so an unknown/zero MTA fails open
  (never blocks a valid withdrawal) and it can never hide a real $700-eligible
  account: MTA 200 < MIN_WITHDRAWAL 700, so a below-MTA balance could not fund a
  valid withdrawal anyway. Referral-earnings-funded withdrawals keep their
  deposit/trade exemption and stay ready.
- `updateLiveWithdrawStatus()` gets the same new branch ahead of the $700 branch,
  for BOTH the sidebar status and the modal info box, so an ineligible account
  never sees "$700" anywhere.
- i18n: 1402 -> 1403 keys/locale. New key `live.withdrawStatus.belowTradingBalance`
  with per-locale wording (en/es/pt/fr/ar/zh); it deliberately quotes NO threshold
  and uses NO placeholder, so the MTA is never re-framed as a withdrawal rule.
  Identical key sets, 0 empty values. The one key feeds both the sidebar/info box
  and the toast.
- DELIBERATE NON-CHANGE: server.js is untouched. `/api/withdraw/request` keeps
  its existing order/strings (including 'Min $700'), so a non-UI client can still
  receive that message; the UI can no longer reach it for an ineligible account
  because the gates above run first. Aligning the API order is a separate
  decision (offered to management, not done).
- Unchanged: MIN_WITHDRAWAL 700, production MTA 200 (sandbox has none), the
  server `amount < 700` check, KYC (flag off), the referral exemption, sandbox
  wording, and all deposit/wallet/trading/referral logic.
- Tests: NEW tests/withdraw_min_message.test.js (16) - gate ordering, the real
  `updateLiveWithdrawStatus` matrix (no deposit / no trade / below MTA / at MTA /
  $700 / ready / referral-funded / sandbox / unknown-MTA fail-open), thresholds
  and existing copy unchanged, the new key threshold-free + placeholder-free, and
  i18n parity. Updated tests/sandbox_withdraw_wording.test.js (the below-MTA case
  now expects the new key; added the balance-300 case that does show $700) and
  the 7 dictionary-size pins 1402 -> 1403. npm test = 871 pass / 0 fail;
  git diff --check clean; all 6 inline script blocks parse.
- Browser (puppeteer-core + chromium, local server, stubbed API): 61/61 - the
  7-case matrix (no deposit / no trade / below MTA / at MTA below $700 / ready /
  referral-funded / sandbox) with the exact sidebar, info-box and toast text per
  case, "the $700 message appears only in the eligible case", modal opens only
  when eligible, no verification UI, 0 page errors, 0 horizontal overflow, plus
  the new string rendered in en/es/ar(RTL)/zh at 320/390px.
- Committed and deployed in the same session on management instruction.

## Quick Fix DEPLOYED TO PRODUCTION (2026-09-14)
- Deployment commit: 10207a73c00ba2ebba5c389386ba22c6b3e3b911
  ("fix: show the $700 withdrawal minimum only to eligible accounts"), pushed
  2b6635b..10207a7 main -> main to
  github.com/nuraabdullahi708090-sudo/arbitrix-app. Normal fast-forward of one
  commit; no force-push/rebase/reset/amend.
- Render auto-deployed on push (header x-render-origin-server: Render). The
  served public/index.html is BYTE-IDENTICAL to the committed file (sha256
  3538aff8959f8f7f7d063f08080c4e9969a28157ebbb416dd11516d2bf63702d).
  /api/health ok, /reset-password.html 200.
- Live markers: 'live.withdrawStatus.belowTradingBalance' x9 (6 dictionary
  entries + 3 argument-free call sites), the new EN copy present, the previous
  'Reach the $200 minimum trading balance' copy GONE, 0 leftover {mta} arguments
  for the key, 'totalWithdrawable < (Number(APP.MTA) || 0)' x3, the $700 gate
  still present, and all 5 non-EN locale copies present.
- Production behaviour check (headless Chromium against the live site, invoking
  the DEPLOYED updateLiveWithdrawStatus()/openWithdrawModal() with a stubbed APP,
  at 390px and 1280px) = 38/38: the 5-state matrix renders the expected sidebar
  AND info-box text (no deposit / no trade / below MTA / at MTA below $700 /
  ready); a below-MTA account gets the new copy, never the $700 message, and the
  modal stays closed; a $300 account gets "Minimum withdrawal is $700. Current:
  $300.00"; an $800 account reaches the form; the shipped EN copy is the new one;
  0 horizontal overflow; 0 page errors.
- LIMITATION: an anonymous production visitor cannot log in, so the
  referral-funded and MARKETING_SANDBOX rows of the matrix are covered by the
  local browser run (61/61) plus the test suite; every path executable anonymously
  was executed against the live build.
- This deployment note is intentionally LEFT UNCOMMITTED so recording it does not
  trigger a second Render rebuild. The working tree therefore shows AGENTS.md as
  modified - documentation only.

## Stage 20A - Human-Support Fallback for Unanswered Assistant Questions (2026-09-14, public/index.html + tests)
- ROOT CAUSE: `sendSupportMessage()` initialized `reply` to `t('support.reply.default')`
  and only overwrote it when one of the English keyword groups matched. Any
  unrecognized message therefore rendered the old default copy ("Thanks for your
  message! Our team will get back to you shortly."), which reads as if a human had
  already received the message even though nothing is sent anywhere and no ticket
  exists. There is no confidence system in this app - only that keyword fallback
  path, which is what this stage reuses.
- WHAT SHIPPED (fallback path + related UI only):
  - `support.reply.default` (6 locales) is now the honest message, e.g. EN: "I'm
    not able to answer that accurately. Please contact our official support team
    through the Support Center, where a human support representative can assist
    you." No locale claims receipt, a ticket, an assignment or a reply "shortly".
  - NEW `appendSupportFallbackReply(message)` renders that message plus a REAL
    `<button class="support-human-action">` whose visible label reuses the existing
    `support.openCenter` key and whose accessible name is the NEW
    `support.fallback.actionAria` key (which contains the visible label in every
    locale, WCAG 2.5.3). Wired with addEventListener; it calls the existing
    `openSupportModal()`. No URL, email, handle, route or new destination is
    invented and nothing is embedded in the chat.
  - `sendSupportMessage()` keeps `reply=''` and routes unmatched messages to the
    fallback. Whole-word tests for the bot (`\bbots?\b`) and greeting
    (`\b(hi|hello|hey)\b`) groups: bare substring tests were matching
    "history"/"both", sending unsupported questions to the greeting/bot answer
    instead of the fallback.
  - CSS: `.support-human-action` (full width, min-height 44px, visible
    `:focus-visible` ring, overflow-wrap) and
    `.chat-message.agent .msg-bubble.support-fallback{max-width:92%;overflow-wrap:anywhere}`.
- OFFICIAL DESTINATION USED: the existing Support Center modal (`#supportModal`,
  opened by `openSupportModal()`), which carries the configured official support
  link (`<meta name="arbitrix-support-telegram">` -> `.js-official-telegram`) and
  the existing not-configured fallback. No new channel was created.
- UNCHANGED: the supported answer keys and keyword topics (bot / DEMO-LIVE /
  deposit / withdraw / referral / sound / language / greeting), the three
  quick-action buttons and their wiring, the widget's "Open Support Center"
  button, the Support Center itself, the security warning, the close button and
  the chat input. No server.js/DB/payment/wallet/trading/withdrawal/KYC/referral/
  auth change; nothing is sent anywhere and no ticket or handoff is created.
- i18n: 1403 -> 1404 keys/locale (1 new key + the replaced value). Identical key
  sets across en/es/pt/fr/ar/zh, 0 empty values.
- Tests: NEW tests/support_fallback.test.js (15) runs the REAL
  `sendSupportMessage`/`appendSupportFallbackReply` in a vm sandbox with a fake
  DOM: supported answers unchanged (incl. {{mta}} interpolation), unsupported ->
  fallback, substring misfires now reach the fallback, no false claim (per-locale
  claim patterns + the 6 old strings removed), the action is displayed/localized/
  accessible, clicking it calls openSupportModal (and no URL/route/persistence/
  ticket), all 6 locales, quick actions intact, the CSS a11y contract, and no
  financial/backend involvement. Dictionary pins 1403 -> 1404 in 7 test files.
  npm test = 886 pass / 0 fail; git diff --check clean.
- Browser (puppeteer-core + chromium, local server, stubbed API): 54/54.
  Scenario 1 (en, 390px): quick action -> bot answer; typed question -> withdraw
  answer; unsupported -> the honest fallback + action (44px, in viewport,
  unclipped, no "get back to you shortly", no raw keys); keyboard focus + Enter
  opens the Support Center whose official link is the configured one; the chat
  history survives the round trip; input and close button still work; 0 page
  errors. Scenario 2: 6 locales x 320/360/390/430/1280 = 30 checks, all clean
  (localized message/label/aria, >=44px, in viewport, no chat or page overflow,
  no raw keys).
- PRE-EXISTING FINDING (NOT fixed here - outside this stage's scope, needs a
  decision): `#metaConsentBanner` (z-index 99999) overlaps the support launcher
  `.support-toggle-btn` (z-index 9998) at 320/360/390/430/768/1280, so a first
  visit before consent is answered has the tap land on the banner's Decline
  button and the assistant does not open. Measured: banner bottom 868-872 vs
  launcher bottom 864 with overlapping x-ranges at every width; after consent the
  launcher works (verified at all six widths). Proposed minimal fix (NOT
  applied): `body:has(#metaConsentBanner) .support-widget{bottom:150px;}` - the
  banner element is removed from the DOM once consent is answered, so the offset
  auto-reverts. Left to management because it touches the consent/FAB stacking.
- NOT committed/pushed/deployed at the time of writing (deployed later in the
  same session on instruction).

## Stage 20A DEPLOYED TO PRODUCTION (2026-09-14)
- Deployment commit: b01999f10cd54db0c8b8f6540c26476bf7da99f9
  ("feat: route unanswered support questions to human support"), pushed
  10207a7..b01999f main -> main to
  github.com/nuraabdullahi708090-sudo/arbitrix-app. Normal fast-forward of one
  commit; no force-push/rebase/reset/amend.
- Render auto-deployed on push. The served public/index.html is BYTE-IDENTICAL to
  the committed file (sha256
  dda4d6c4def63b131f1e5d0dccaa9203ecf3a7ff05ba46c8e531c8f6321f96c2).
  / and /api/health both OK.
- Live markers: the six old misleading fallback strings are GONE; the new honest
  message is present in all six locales; 'support.fallback.actionAria' appears 7x
  (6 dictionary entries + 1 call site); appendSupportFallbackReply() and its call
  site are present; the whole-word keyword tests are present; the
  .support-human-action CSS and its :focus-visible rule are present; the Support
  Center modal and the official-link meta are intact; MIN_WITHDRAWAL 700 intact.
- Production smoke (headless Chromium against the live site, anonymous visitor,
  cookie banner answered, 5 scenarios: en@390, ar@390, es@390, en@320, en@1280)
  = 50/50: a supported question still returns that locale's bot answer with no
  action offered; an unsupported question returns that locale's honest fallback
  message; no "get back to you shortly"; the action is displayed with the
  localized label and aria-label (>=44px, inside the viewport); no clipping,
  overflow or raw keys; clicking the action opens the existing Support Center
  whose official link equals the configured meta content; 0 page errors.
- Still open (pre-existing, reported, NOT changed in this stage): the
  cookie-consent banner overlays the support launcher until consent is answered -
  see the Stage 20A note above for the measurements and the proposed one-line fix.
- This deployment note is intentionally LEFT UNCOMMITTED so recording it does not
  trigger a second Render rebuild. The working tree therefore shows AGENTS.md as
  modified - documentation only.

## Landing Testimonials - Four Country-Authentic Users (2026-09-14, public/index.html + tests)
- The landing had `landing.testimonials.*` copy and `.landing-testimonial*` CSS but NO
  section markup (dropped in the Phase 8C content-density pass), so nothing rendered
  and the three dictionary entries were dead (generic names Michael J./Sarah C./David
  K., including an "Up 23% in my first month" claim).
- ADDED a testimonials section (after Security, before the FAQ) with FOUR testimonials
  from the requested countries:
    Chinedu Okafor   - Small business owner - Lagos, Nigeria
    Sanne de Vries   - Software engineer    - Utrecht, Netherlands
    Lucas Almeida    - Logistics analyst    - Sao Paulo, Brazil
    Abdullah Al-Qahtani - Pharmacist        - Riyadh, Saudi Arabia
  Each card: 5 star icons, quote, avatar initials, name, and a "role . city, country"
  line.
- NAMES are authentic to each country (Igbo given + surname; Dutch tussenvoegsel
  surname "de Vries"; Portuguese given + surname; Arabic given name + Al- family
  name). Names are NEVER translated, EXCEPT the Saudi name which renders in Arabic
  script for `ar` (Abdullah Al-Qahtani in Arabic, avatar initial in Arabic) - pinned
  by tests.
- LOCALIZED: heading, subtitle, risk note, all four quotes, roles, cities and
  countries (ar uses Arabic city/country names; zh uses the country-first order).
- TERMINOLOGY: the quotes reuse the site's canonical per-locale terms instead of
  inventing new ones - the mode names are read from `landing.compare.demo.tag` /
  `landing.compare.live.tag` ("Demo Mode"/"Live Mode", "Modo Demo"/"Modo Live",
  "Mode demo"/"Mode Live", the Arabic Demo/Live mode names, the Chinese
  demonstration/real-account mode names), and the deposit / withdrawal / referral /
  bot terms match `deposit.title`, `sidebar.withdraw`, `sidebar.referral`,
  `support.botSetup` (e.g. zh deposit/withdraw/referral/bot terms; ar uses the Arabic
  robot term). A test derives the mode terms from the dictionary itself, so they can
  never drift.
- HONEST COPY: no return percentages, no guaranteed / risk-free / passive-income
  language; the only figure quoted is the published $7/month price. A localized risk
  note was added ("Individual results vary. Trading involves risk."). The old
  fabricated entries are removed.
  NOTE FOR MANAGEMENT: the four quotes are illustrative personas, not verified
  customer statements. If real, attributable reviews are required for publication,
  swap the copy - the keys are already wired.
- i18n: 1404 -> 1416 keys/locale (12 new: 4 locations, 4 initials, card 4
  text/name/role, the note; tag/title/subtitle and cards 1-3 reuse the dead keys).
  Identical key sets across en/es/pt/fr/ar/zh, 0 empty values.
- CSS: grid 3 -> 4 columns (the existing 1024px = 2 and 768px = 1 rules still stack
  it), plus `min-width:0` on the card and `overflow-wrap:anywhere` on the quote /
  name / role / note so long localized strings cannot overflow, and new
  `.landing-testimonial-meta` / `.landing-testimonials-note` rules.
- Tests: NEW tests/landing_testimonials.test.js (13): section structure and card
  count, country coverage, per-country authentic names, the no-translation rule plus
  the Arabic-script Saudi name, localized cities, honest copy (no percentages or
  guarantees, only the published price), the risk note, canonical terminology
  (dictionary-derived), i18n parity at 1416 with ONLY landing.testimonials.* keys
  added, the 4/2/1 responsive grid + overflow safety, and that the section is
  display-only. Dictionary pins 1404 -> 1416 in 8 test files.
  npm test = 899 pass / 0 fail; git diff --check clean.
- Browser (puppeteer-core + chromium, local server): 360/360 - 6 locales x 5 widths
  (320/360/390/430/1280) x 12 checks: four cards, correct grid columns (4/2/1), five
  stars per card, localized names/initials/roles/locations, quotes rendered with no
  raw keys, localized risk note, no clipping or horizontal overflow, cards inside the
  viewport, RTL for ar, 0 page errors.
- COMMITTED LOCALLY ONLY - not pushed and not deployed (a push to main auto-deploys
  on Render), pending management approval.


## Stage 21 - MTA Removed + $500 Withdrawal Minimum + Verification Rename (2026-09-15, server.js + public/index.html + .env.example + tests)
- Management-approved. Frontend + server + tests + env docs. NO change to marketing
  sandbox deposit or withdrawal logic (verified: the only sandbox-touching diff
  line is a comment, `!isSandbox && amount < APP.MIN_WITHDRAWAL` is unchanged,
  and no `handleSandbox*` function body changed).
- MTA (Minimum Trading Amount) REMOVED from production:
  - Deleted `BOT_MIN_TRADING_BALANCE`, `MTA_ENV_VAR`, `getEffectiveMta()` and the
    now-unneeded `isNonDepositedTrading()` exemption helper from server.js.
  - `/api/bot/start` no longer reads the wallet balance and no longer returns
    `MTA not reached`; the mode default-deny (`req.body.mode === 'demo' ? 'demo'
    : 'live'`) and the promotional-credit $20 cap check are preserved and the cap
    check still runs BEFORE the `bot_sessions` upsert.
  - `/api/auth/me` no longer returns `mta` for production accounts (the sandbox
    response still carries `mta: 0` for shape compatibility; the frontend no
    longer reads it).
  - Frontend: the MTA dashboard card + CSS, `updateMTAProgress()`, the MTA badge
    (`mta_unlocked`), `APP.MTA` adoption, `bot.reachMTA` / `bot.mtaMet` /
    `mta.subtitle` / `mta.targetLabel` and the MTA-vs-amount line are all gone.
    The bot now starts with any balance; the bot status line uses the new
    `bot.readyToTrade` key.
  - `.env.example`: the `MTA_AMOUNT=200` entry is replaced by a "REMOVED / do not
    set" note (the variable is obsolete and unread).
  - NO database change: no migration ever stored an MTA and `bot_sessions` keeps
    its columns (the MTA was never persisted).
  - Documentation-only MTA mentions remain in `server.js` comments and in
    migrations 022/023 comments (both describe the removal / "sandbox: none").
    Applied migration files were deliberately NOT rewritten.
- Minimum withdrawal $700 -> $500, single server source of truth
  `const MIN_WITHDRAWAL_USD = 500;` (server.js) and the matching frontend
  `MIN_WITHDRAWAL: 500`. Enforced in `/api/withdraw/request` as
  `amount < MIN_WITHDRAWAL_USD` -> 400 `{ error: 'Min $' + MIN_WITHDRAWAL_USD }`
  (the same error SHAPE/message form as before, now $500). All tests, error
  messages, the modal info box and the landing FAQ copy were updated.
- DISCLOSURE POLICY (management requirement: no misleading/hidden conditions):
  the $500 minimum is deliberately NOT advertised in the always-visible sidebar
  status. The sidebar shows a neutral, amount-free message
  (`live.withdrawStatus.belowMinimum`); the amount is disclosed only at the
  withdrawal stage (the withdraw-modal info box `live.withdrawStatus.needMinimum`
  with `{{min}}`) and surfaced in the clear toast when a request falls below it
  (`withdraw.minWithdrawal` with `{{min}}`/`{{current}}`). `landing.faq.5.a` was
  corrected in all 6 locales from "$700, identity verification" to
  "$500, withdrawal security verification when required".
- Verification flow RENAMED to an accurate, self-explaining name (it stays
  event-triggered; the sidebar entry remains hidden):
  `withdraw.kycRequiredTitle` = "Withdrawal Security Verification",
  `withdraw.kycRequiredBody` explains WHY (protect your account; one-time
  security check before withdrawing) and WHAT to submit (government-issued ID +
  a selfie holding it), progress label "Security Check Progress", CTA "Start
  Security Check", `kyc.modalTitle`/`kyc.modalSubtitle` and all
  `kyc.title.*`/`kyc.subtitle.*` status headers renamed, and
  `withdraw.identityRequired` = "Withdrawal security verification required".
  The server's machine-readable `error: 'Identity verification required'` string
  and the `verificationRequired: true` flag are UNCHANGED (they are pinned by
  tests and mapped on the frontend via BACKEND_MESSAGE_MAP; the raw string is
  never shown to the user).
- `WITHDRAWAL_REQUIRES_VERIFICATION` (default FALSE = verification not required
  to withdraw) is unchanged and still the single knob to restore the KYC-first
  gate. Withdraw gate order (production): first-deposit priority -> verification
  (when enabled) -> $500 minimum -> balance -> address -> completed-trade ->
  duplicate/pending -> auth.
- TRADING ARCHITECTURE AUDIT (read-only; NO implementation - see below):
  - Root cause of "trading stops when the browser tab closes": the trading loop
    is `APP.botInterval = setInterval(executeBotTrade, 8000)` in
    `public/index.html` (`startBot()`), i.e. it lives in the browser tab. Closing
    the tab (or navigating, or a phone sleeping) destroys the interval.
  - The server has NO trading engine: `/api/bot/start` + `/api/bot/stop` only
    write `bot_sessions.is_running`, and the web UI never even calls them
    (`grep` finds zero `/api/bot/*` fetch calls in index.html). There is no
    cron, queue, worker or scheduler in the repo; the only server timer is a
    rate-limit-store cleanup. Deployment is a single Render web service.
  - Consequence: `bot_sessions.is_running` can stay 1 after the tab closes or the
    service restarts (a "phantom running bot" that is counted by the admin
    activeBots stats), while nothing is trading.
  - Trade outcomes are generated CLIENT-SIDE (`Math.random()`), and
    `POST /api/trade` accepts a client-supplied `amount` (bounded only by
    `|amount| <= max(balance, 1)`). `record_trade_safe` DOES provide atomicity +
    idempotency-key dedup + wallet row locking, and the promo-$20 cap is
    enforced server-side - so the ledger is safe, but the PRICE/P&L source is the
    client.
  - Therefore a server-side worker is a TRUST-MODEL change (the server would own
    both the outcome and the timing), which the brief explicitly gates on tests
    and approval. Plan proposed (NOT implemented): a dedicated `worker.js`
    process (separate Render Background Worker) that (1) reconciles
    `bot_sessions` on boot (reset stale is_running=1 rows + heartbeat column),
    (2) drives each running session on a fixed tick, (3) generates the trade
    server-side and submits it through the EXISTING `record_trade_safe` RPC with
    a deterministic per-(user, tick) idempotency key (duplicate-order
    protection), (4) enforces risk limits (per-tick, per-day loss limits, max
    exposure, promo cap) BEFORE the RPC, (5) exposes structured JSON logs and an
    admin emergency stop (`POST /api/admin/bot/emergency-stop`) that flips all
    sessions off and refuses new `/api/trade` while engaged, and (6) has the
    browser only render `/api/bot/status` (+ reconnect handling) instead of
    executing trades. Requires a new migration (heartbeat/version column) and
    new tests. AWAITING APPROVAL.
- i18n: 1398 keys/locale x 6 (was 1404; the 6 `mta.*` keys were removed). Parity
  verified (identical key sets, 0 empties, 0 `$700` anywhere, no `mta.*` key).
- Tests: full suite `npm test` = 942 pass / 0 fail. Updated for the intentional
  changes: bot_mta (15, rewritten for "MTA fully removed"), referral_promo_mta
  (8, rewritten), withdraw_min_message (13), withdrawal_protection,
  withdrawal_prompt_priority, withdraw_verification_flag, promo_trading_cap,
  subscription_eligibility, final_min_deposit_referral, final_referral_model,
  achievements_panel, beginner_ux, landing_testimonials, sandbox_demo_balance,
  sandbox_no_kyc, sandbox_withdraw_wording, support_fallback, starthere_mode_aware,
  marketing_sandbox, subscription, email_change, deposit_demo_ux,
  onboarding_funnel, pending_referrals_collapsible, first_visit_landing.
  `node --check server.js` OK; all 7 inline `<script>` blocks parse (vm.Script).
- NOT committed / NOT pushed / NOT deployed. Migration state unchanged (no new
  migration needed for this stage). Telegram webhook registration NOT started
  (per instruction: it waits for these changes to be completed, tested, deployed
  and verified).


## Stage 21 - Server-Side Trading Worker + Legacy Browser Loop Disclosure (2026-09-15, NOT deployed)
- LOCAL COMMIT ONLY: committed on `main` but NOT pushed and NOT deployed, because the
  brief requires the worker implementation and tests to be reviewed before any
  live-money execution ships. Migration 027 is NOT applied anywhere.
- WHY: the production trading loop lived in the BROWSER
  (`APP.botInterval = setInterval(executeBotTrade, 8000)` in public/index.html), so
  closing the tab / sleeping the phone / refreshing silently stopped trading, and
  `bot_sessions.is_running` could stay 1 with NO executor behind it (a phantom
  "running" bot that admin stats still counted).
- NEW FILES (all inert until explicitly enabled):
  - `services/TradingWorker.js` - the durable engine. Server-side, dependency-
    injected, no HTTP/socket/browser dependency. Exports testable helpers
    (`tickBucket`, `buildTickIdempotencyKey`, `backoffDelay`, `isStaleHeartbeat`,
    `computeTradeAmount`, `evaluateRisk`, `withRetry`, `DEFAULT_LIMITS`).
    Guarantees: IDEMPOTENCY (per-user-per-tick key derived server-side from the tick
    bucket; a replayed/racing tick is deduped by record_trade_safe's unique key),
    RISK LIMITS evaluated BEFORE the write (no balance, trades/day, daily loss,
    promotional-credit $20 cap, consecutive-failure auto-stop), RECONNECT/RETRY
    (exponential backoff + jitter; retries thrown errors AND Supabase `{error}`),
    PERSISTED STATE (heartbeat_at, last_tick_at, tick_count, consecutive_failures,
    stopped_reason, worker_version), STALE-SESSION RECONCILE on start, EMERGENCY
    STOP (fail-CLOSED: an unreadable control row counts as engaged), STRUCTURED JSON
    logs with no secrets. Money moves ONLY through `record_trade_safe`; it never
    writes wallets/trades directly and never references any `sandbox_*` object.
  - `services/PromoCheck.js` - the worker's copy of the promotional-credit rule
    table ($20 INCLUSIVE cap; source-of-funds precedence deposit > conversion >
    promo; FAIL-OPEN on an unreadable source). Parity with the server's own table is
    pinned by tests. Unifying the two into one imported module is a recommended
    follow-up but touches the live `/api/trade` path, so it is out of scope here.
  - `worker.js` - process entrypoint (`node worker.js`). INERT unless
    `TRADING_WORKER_ENABLED=true`; refuses to start without SUPABASE_SERVICE_KEY
    (exit 1, presence-only logging - never the value); exits 1 and trades NOTHING if
    the control row is unreadable (migration 027 absent). Graceful SIGTERM/SIGINT.
  - `supabase/migrations/027_trading_worker.sql` - additive, idempotent, self-checking
    (DO block raises and rolls back if anything is missing): bot_sessions gains
    heartbeat_at/last_tick_at/tick_count/consecutive_failures/stopped_reason/
    worker_version/risk_limits + an (is_running, heartbeat_at) index; new singleton
    `bot_worker_control` (id=1, emergency_stop DEFAULT FALSE) with RLS service_role-
    only (no anon/authenticated policy = deny by default). It does NOT touch wallets,
    trades, deposits, withdrawals, subscriptions, referrals, KYC or sandbox tables.
  - `tests/trading_worker.test.js` - 42 tests (fake Supabase client + the REAL engine)
    covering: inert-by-default, service-key handling, fail-closed control,
    CONTINUES AFTER TAB CLOSURE (many ticks, no client), SERVICE RESTART (stale
    heartbeat reconcile + start()-reconciles-first), persisted state, idempotency
    (replay + two concurrent instances => exactly one ledger row), risk limits
    (bounded size, loss clamped to balance, veto before the write, daily loss,
    failure auto-stop, promo cap boundary/parity/fail-open), emergency stop (all
    three paths + admin routes + status truth), retry/backoff, structured logging
    without secrets, and the safety boundaries above.
- server.js CHANGES (additive):
  - `WORKER_STALE_HEARTBEAT_MS = 60000`, `getWorkerControl()` (fail-closed report,
    with `available` distinguishing "unreadable" from "really stopped"),
    `getWorkerStatus()`.
  - `POST /api/admin/bot/emergency-stop`, `POST /api/admin/bot/emergency-stop/clear`,
    `GET /api/admin/bot/worker-status` (all `authMiddleware, adminMiddleware`).
    Engaging the stop also marks every running session stopped with
    stopped_reason='emergency_stop' so no phantom "running" row survives.
  - `/api/bot/start` refuses while the stop is ENGAGED (503 `TRADING_PAUSED`) and
    clears `stopped_reason` on a fresh start. DEPLOY-SAFE BY DESIGN: it blocks only
    when the control row is READABLE and engaged, so shipping this code before
    migration 027 is applied can never pause trading platform-wide (the worker
    itself stays strictly fail-closed).
  - `/api/bot/status` now also reports heartbeatAt/heartbeatAgeMs/tickCount/
    stoppedReason plus `executedBy: 'worker' | 'browser'` and `stale` - i.e. whether
    a session REALLY has an executor behind it (the browser engine never writes a
    heartbeat).
- public/index.html: a localized disclosure (`#botEngineNotice`, `bot.engineNotice`
  x6 locales) in the LIVE bot card stating that the bot runs in this browser tab and
  stops when the tab is closed/refreshed, and that a server-side engine is in
  development. This MARKS the limitation honestly; live trading was deliberately NOT
  disabled (disabling it would stop real users' trading with no replacement, which
  is a bigger unapproved behaviour change). i18n 1398 -> 1399 keys/locale.
- UNCHANGED (verified): all 12 sandbox functions byte-identical; zero sandbox logic
  lines in the diff; no sandbox tables/RPCs referenced by the worker; marketing
  sandbox deposit/withdrawal untouched. record_trade_safe untouched. MTA stays
  removed; withdrawal minimum stays $500; Security Check wording intact.
- VERIFICATION: `npm test` = 984 pass / 0 fail (942 baseline + 42 new). `node --check`
  on server.js/worker.js/services/*.js OK; all 7 inline index.html script blocks +
  the reset-password block parse. i18n probe: 1399 keys/locale x 6, identical key
  sets, 0 empties, no duplicates, bot.engineNotice present in all 6. Encoding check
  vs the deployed HEAD: only the intended additions (rsquo +4, arabic alef +11, zh
  zhong +2, everything else 0, 0 replacement chars). Worker runtime: default = inert
  (exit 0); enabled without a key = refuse (exit 1); enabled with a key but no
  migration 027 = FAIL CLOSED, trades nothing (exit 1). Headless Chromium: 46/46 -
  the notice renders visible and localized (en/es/ar/zh) at 320/390px with 0
  horizontal overflow, ar RTL correct, and copy that never over-promises 24/7
  operation.
- NOT VERIFIED AGAINST A LIVE DATABASE: migration 027 has not been applied, so the
  RPC path (record_trade_safe via the worker) and the reconcile queries have not
  been exercised against real Postgres/Supabase in this session - the SQL is
  reviewed and the column/table/policy assertions are in its self-check block, but a
  staging apply + a shadow (no-money) run is REQUIRED before cutover.
- OPEN DECISIONS FOR MANAGEMENT: (1) approve deploying this change set (server.js +
  the frontend disclosure) with migration 027, and approve the Render Background
  Worker service for `node worker.js`; (2) whether the browser loop should now be
  DISABLED outright (one line) instead of merely marked; (3) the risk-limit defaults
  (0.5% of balance / $50 absolute / $100 daily loss / 288 trades per day); (4)
  whether to unify PromoCheck with the server's rule table in a follow-up; (5) the
  cutover window, since both engines must not trade simultaneously (enable the worker
  only after the browser loop is stopped/disabled).
- Telegram webhook registration REMAINS BLOCKED pending the above.


## Phase 31 - Staging verification of the trading worker (2026-09-15)
- Verification was done on a THROWAWAY local PostgreSQL cluster (embedded PG 18.4
  at /tmp/pgstaging, database arbitrix_staging) reached through a minimal
  PostgREST-compatible shim (/tmp/pgstaging/pgrest_shim.js), so the REAL worker.js,
  the REAL services/TradingWorker.js and the REAL record_trade_safe() RPC ran
  unmodified. No production database, credentials or money were involved, and
  nothing was applied to staging/production Supabase.
- Chain applied cleanly to a fresh database: base schema -> 009 (trades +
  record_trade_safe) -> 027 (fresh apply, self-check passed) -> 027 re-apply
  (idempotent, no-op). All 27 staging scenarios PASS (migration objects, RPC money
  path, restart reconciliation, replay + two-process idempotency, every risk limit,
  emergency stop, browser-independence).
- TWO REAL BUGS FOUND BY RUNNING IT (neither was visible to the unit tests):
  1. FATAL: services/TradingWorker.js start() called timer.unref() on the tick
     interval, so the event loop drained and the worker exited immediately after
     logging worker_started - it never ticked or traded at all. Fixed by removing
     the unref(); pinned by tests/trading_worker_process.test.js, which SPAWNS the
     real worker against a PostgREST stub and asserts it stays alive, ticks
     repeatedly, records trades with no browser, and exits 0 on SIGTERM.
  2. SILENT: stopSession() ignored the { error } that supabase-js resolves with
     (it does not throw), so it logged a FALSE "session_stopped" while the write
     had failed - a phantom running session would survive a stop/emergency stop.
     Root cause on staging: bot_sessions is not created by any migration and had no
     updated_at column, which the stop/heartbeat paths write. Fixed by routing the
     stop through withRetry, branching on the resolved result, logging
     session_stop_failed and returning false; migration 027 now adds
     bot_sessions.updated_at defensively (ADD COLUMN IF NOT EXISTS) and its
     self-check asserts the column, like every other column the worker writes.
     The admin emergency-stop route now also reports sessionsStopError instead of
     claiming sessions were stopped when that write failed.
- SINGLE-ENGINE GUARD (cutover safety, server-enforced): /api/trade refuses a
  browser-originated trade when the user's session is worker-owned (is_running=1
  AND heartbeat_at within WORKER_STALE_HEARTBEAT_MS), returning HTTP 409
  {code:'WORKER_OWNED_SESSION', executedBy:'worker'}. isWorkerOwnedSession() is
  deliberately FAIL-OPEN: any read error (including migration 027 not being
  applied, which makes every read error) returns false, so the guard can never
  itself stop trading, and with no worker running it is a no-op. This makes
  "never both engines trading" a server-side property rather than a deploy-order
  promise. Pinned by tests/trading_worker_single_engine.test.js (10 tests).
- CUTOVER CONSEQUENCE TO COMMUNICATE (by design, not a bug): when the worker is
  first enabled, every session with is_running=1 and no/stale heartbeat - i.e. all
  browser-era bot sessions - is reconciled and STOPPED with
  stopped_reason='stale_heartbeat_reconciled'. Users must start the bot again under
  the new engine. This is the fail-safe that prevents double execution, but it is a
  user-visible event and should be announced at cutover.
- Tests: npm test = 1003 pass / 0 fail (984 baseline + 19 new: 9 process-level,
  10 single-engine guard). i18n unchanged (1399 keys/locale, 0 empties).
- NOT COMMITTED/DEPLOYED pending the migration + worker-service path: production
  worker stays DISABLED (TRADING_WORKER_ENABLED unset) and migration 027 is NOT
  applied. No Supabase DDL credentials and no Render API key are available in this
  environment, so neither can be done from here.
