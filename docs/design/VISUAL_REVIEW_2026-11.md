# Kalderix redesign - visual review and refinement (2026-11-23)

Scope: PR #204 (`design/kalderix-ui-redesign`). This is a design pass, not an audit:
the interface was rendered, measured, judged and corrected.

## How the interface was inspected

Screenshots were **not available**: this environment's model adapter drops image content,
so no pixel-level review by the agent was possible. Everything below therefore comes from
the real rendered DOM in headless Chromium (puppeteer-core) with realistic data:

* geometry (`getBoundingClientRect`) of every card, control and label;
* computed styles (colour, font size/weight, radius, spacing, sticky/overflow);
* WCAG contrast computed by compositing each text colour over its true background chain;
* overflow, clipping and tap-target sizes;
* a functional pass over every view, dialog and the deposit/withdraw flows.

A throwaway preview server (`/tmp/preview/server.js`, never committed and never deployed)
served `public/` and answered the dashboard's API calls with a realistic account
($2,480.55 equity, +$36.20 today, 8 ledger rows, 3 active referrals) so the components
render with content instead of empty states.

## What was judged, and what changed

### Hierarchy
* The account summary now leads the page. The "Getting started" card used to sit above
  the money - on a funded account it read "You're ready for Live Mode" in the prime slot.
  It moved below the hero and its padding was tightened.
* Hero proportions: `1.22fr / 1fr / .92fr` read as three equal cards. Now
  `1.5fr / 1.05fr / .85fr`: equity 418px, available 293px, P&L/bot rail 237px at 1280.
* Phones: P&L and bot state share a row (`eq eq / av av / pnl bot`). Hero 468 -> 385px at
  390, 524 -> 455px at 320 - the wallet cards arrive about a screen earlier.

### Legibility
* Low-contrast text: **1 -> 0** (measured over `#mainContent` and the sidebar). The
  "worst trade" figure was 3.99:1 in the alarm red (`#E5484D`); it now uses the soft
  danger tone (`#F58C90`).
* Secondary numbers: `.stat-sub` 9px -> 10.5px, chart labels 10px -> 10.5px, both in the
  secondary text colour. Both were losing to legacy descendant selectors, so the new
  rules are scoped (`.kx-cockpit .trading-stat-item .stat-sub`).

### Contrast on tinted panels
* The deposit "Currently Supported" panel put `#5EA0FF` text on a green tint: 4.35:1 at
  11-12px. The heading and both chips now use `#9CC4FF` (6.4-8.3:1); the decorative
  shield icon keeps the brand blue.

### Touch ergonomics
* Sidebar rows 40 -> 44px; hamburger fixed at 44px; header icons square 40px (44 on
  touch); dialog close buttons 36 -> 40/44px; deposit presets 34 -> 38px (42 on touch)
  with 12px labels. Remaining 34-38px controls are secondary (wallet tabs, quick
  amounts, help links) - see "needs a human eye".

### Craft
* The equity chart was 2.45:1 wide at 1440 (292px tall in a 716px card). Heights are now
  300 / 330 (>=1280) / 230 (<=640): ratio 2.22 at 1440, 1.9 at 1280, 1.57 on phones.
* The account-status card in the sidebar is `position:sticky` at the bottom, so it stays
  visible while the navigation scrolls on a 700-900px viewport.

## Measured result

| surface | h-overflow | doc height | hero | chart | low-contrast | <44px controls |
|---|---|---|---|---|---|---|
| overview 1440 | 0 | 1389 | 204 | 716x322 | 0 | 19 |
| overview 1280 | 0 | 1389 | 204 | 611x322 | 0 | 19 |
| overview 768 | 0 | 2030 | 316 | 506x292 | 0 | 19 |
| overview 390 | 0 | 2326 | 385 | 348x222 | 0 | 15 |
| overview 320 | 0 | 2486 | 455 | 278x222 | 0 | 15 |
| markets 1280 / 390 | 0 | 900 | - | iframe | 0 | 14 / 10 |
| activity 1280 / 390 | 0 | 900 | - | - | 0 | 15 / 11 |
| referral 1280 / 390 | 0 | 1271 / 1674 | - | - | 0 | 20 / 16 |

Dialogs at 1440 and 390: deposit, withdraw, profile, subscription, support and
verification all open, fit the viewport, keep a close affordance and show no
low-contrast text. The deposit sheet is full-screen on phones by design.

## What still needs a human eye (subjective)

1. **Whether the hero feels balanced** at 1280-1600px. The proportions are deliberate, but
   "does equity at 36px next to a 20px P&L feel premium" is a taste call.
2. **Header composition** on tablet (768px): it wraps to ~132px. Options are hiding the
   account-status chip below 1024px, or moving it into the sidebar block.
3. **Secondary control density**: 34-38px wallet tabs / quick amounts / help links are
   conventional for desktop but below the 44px touch guideline. Raising them changes
   rhythm across every surface, so it needs a decision, not a reflex.
4. **The chart**: heights and ratio are now consistent, but the visual weight of the
   line/fill (brand blue on near-black) was not re-drawn - that is a Chart.js config
   change and a separate judgement.
5. **Profile / verification dialogs** are long (828px at 900px viewport). They scroll
   correctly; whether they should be split into steps is a product decision.

## Limitations

* No screenshot-based review was possible (adapter limitation). Contrast is computed, not
  perceived; anti-aliasing, blur and shadow quality are unverified.
* The preview harness stubs every API, so the app's auth/redirect behaviour was not part
  of this pass (it is covered by the repo test suite).

## Reproducing the preview

Serve `public/` over HTTP and stub `/api/auth/me` (user + `wallet.live_balance` +
`hasRealDeposit` + `todayRealizedPnl` + `minDeposit`), `/api/transactions`,
`/api/bot/status`, `/api/referral/stats`, `/api/subscription`, `/api/kyc/can-withdraw`,
`/api/deposit/options` and `/api/market/opportunities`; inject
`localStorage.jwt_token` + `localStorage.arbi_user` into `index.html` **in `<head>`**
(the startup routing reads localStorage while the first script blocks parse). Nothing in
this document requires a database, credentials or a deploy.

---

# Phase 2 - refinement after the owner's mobile review

The owner reviewed the rendered mobile UI and returned a verdict of *good foundation,
not approved*, with a list of concrete defects. This section records what was measured,
what changed, and what the numbers are now. Scope: `public/index.html` only (markup,
CSS, presentation JS, copy). No server, schema, money path or engine change.

## Environment limitation (stated plainly)

**No screenshot or image-based review was possible in this session.** The model adapter
drops image content before the request is sent, so every claim below comes from DOM
measurement (`getBoundingClientRect`, computed styles), real interaction through
headless Chromium, and the test suite - not from looking at a picture. Structural and
layout defects are fully verifiable this way; subjective quality (shading, motion feel,
shadow softness) is NOT verified and should be confirmed visually by the owner.

## What was actually wrong (measured, not guessed)

| Symptom reported | Root cause found |
|---|---|
| Header too tall; content sliding under it | The toolbar reserved `padding-top:44px` for a **position:fixed** hamburger that had since become a grid item, so the clearance was dead space. On top of that the grid declared two rows (`"burger brand right" / "sub sub sub"`), and at 641-1023px the flex layout wrapped the controls onto a second line. |
| The same balance repeated in four cards | `kxHero` was four equal KPI cards (equity / available / P&L / bot) that each re-printed the account value; total 385px of the 844px first screen. |
| Checklist card stays huge when finished | `#startHereStepsLiveReady` was a sibling block under a hidden header, so "ready" still rendered as a card with a full-width Dismiss button. |
| Bot says "ready to trade" while stopped | `updateUI()` overwrote `#botStatusMsgLive` with `bot.readyToTrade` unconditionally whenever the promo cap was not reached, i.e. it claimed readiness the state did not have. The pill separately computed `running | idle` from a different expression. |
| Wallet section 663px | Tabs wrapper + funding card + bot card, each with its own vertical rhythm, stacked with no shared header. |
| Empty space where activity should be | The transaction log is the **Activity view host** (`KX_VIEW_HOSTS.activity = 'history'`), so the dashboard showed trading statistics with nothing to read. |
| Preview data contradicted itself | Harness-side: `APP.liveData` was empty (so 0 trades) while `/api/transactions` served six rows, and the chart series was random. Fixed in the harness, not by faking numbers in the app. |

## Measurements (390x844 unless stated)

| Metric | Before | After |
|---|---|---|
| Header height | 98px (150px at 320) | **58px** (58px at 320) |
| Header at 768 / 1280 | 100px / 58px | **58px / 58px** |
| Account card | 385px (4 cards) | **259px** (1 card) |
| Deposit/withdraw actions, y | 463 | **239** |
| Start-Here card (complete) | 103px | **54px** |
| Trading statistics card | 249px, no rows | 323px incl. **3 real trades** |
| Document height | 2245px | **1790px** (-20%) |
| Document height, 1280px | 1489px | **1261px** |
| Horizontal overflow, 320-1440 x 6 locales | 0 | 0 |

## The fixes

1. **One account card.** Equity leads; "Available" carries the Deposit/Withdraw actions
   it enables; P&L and bot state are compact metrics. Each figure is rendered once, each
   keeps its id (`totalEquity`, `balanceValue`, `pnlValue`, `botStatus`,
   `availableStatCard`) and each keeps a plain-language hint. At >=1200px the same
   figures become a three-column band (131px instead of 249px).
2. **One bot state machine.** `botUiState()` derives `offline | ready | running | paused |
   error` only from real flags (`APP.botRunning`, `APP.botPaused`,
   `liveData.promoLimitReached`, `APP.botError`, `APP.mode`); `renderBotState()` paints
   the pill, the account metric and the card message from that single answer. The
   stopped state uses `bot.clickToStart`, never "ready to trade". A refused start sets
   `botPaused`/`botError`, so the pill cannot keep claiming a healthy idle state.
   All labels are translated and are re-rendered on a language switch.
3. **Honest engine disclosure.** The notice used to claim the tab-bound bot "keeps
   trading even when you're offline", which is false - the loop dies with the tab. It now
   says "Runs in this browser tab. Trading pauses if you close or refresh the page." The
   worker variant keeps the background claim (that engine really does keep running).
4. **Compact toolbar.** The 44px clearance and the two-row grid are gone; the hamburger
   is a grid item, so the bar is 58px at every width. At <=360px the view title yields
   before the controls do; at 641-1023px the row is forced to a single line.
5. **Wallet grouping.** `#kxWallets` now owns the `Wallet / Bonus / History` control, so
   the tabs read as the header of the section they switch instead of floating above the
   next card.
6. **Trading activity on the dashboard.** A `Recent trades` footer lists the three most
   recent executed trades from the wallet ledger, coloured by sign, with an "All activity"
   link into the existing Activity view. It hides itself when there is nothing to show.
7. **Drawer and support coordination.** The drawer close control is a 36px target, the
   body scroll lock is unchanged, and the compact overrides are scoped to `#sidebar` so
   the pinned base contract stays authoritative. The support launcher hides while its
   panel or a deposit dialog is open; panel buttons and the toast close meet the 32-36px
   tap minimum.
8. **A completed checklist is one line** (54px), with Dismiss in the same row.

## Deliberately NOT done

* **No fake numbers anywhere.** The account card shows the server-synced wallet; the
  recent list shows the app's own ledger. The consistency complaints were a *harness*
  fixture defect (empty `APP.liveData`, random chart), fixed in the harness.
* **No auto-scroll on mode switch.** Real owners switch modes deliberately; hijacking
  scroll is disorienting. The header is compact now, which is what the complaint was
  actually about.
* **No financial, bot, deposit or withdrawal logic touched** - the diff is markup, CSS,
  three presentation functions and one copy fix; pinned by
  `tests/dashboard_phase2.test.js`.

## Verification

* `npm test` - full suite green (see the PR for the exact count).
* Headless Chromium harness (`/tmp/preview/phase2.js`, outside the repo): **75/75**
  checks across 320/390/768/1280/1440 - header height, zero horizontal overflow, the
  account card above the fold, actions usable, chart canvas present, no sub-28px tap
  targets, one-line checklist, 6 trades in the statistics, 3 rows in the recent list,
  P&L and the 30-minute chart change both +$36.20, drawer open/width/lock/close,
  support panel hidden-launcher/inside-viewport/restore, all five bot states, deposit
  and withdraw dialogs opening from the card, es/ar rendering with 0 overflow, and no
  page errors.
* Screenshots were NOT taken (see the limitation above).

## Onboarding / activation audit (same pass)

Six account states were driven through the real page with `/api/auth/me` stubbed per
scenario, at 390px: activation required (purchasable), activation required (purchase
unavailable), deposit required, funding required (no promotional credit), eligible/funded,
and MARKETING_SANDBOX. Result: 52/52 checks, after one real fix.

| Assertion | Result |
|---|---|
| Live Mode card visible exactly when the account has an outstanding step | pass (hidden for funded and sandbox) |
| Status chip + explanation match the state (never "activate" once activated) | pass |
| Activation dialog opens from the card; buy link only when `purchasable && https storeUrl` | pass |
| "Purchase unavailable" notice + licence-key entry + Contact support always reachable | pass |
| Deposit dialog opens from the card in the deposit states | pass (after the fix) |
| No raw i18n keys, no `{{placeholder}}` text, no dead inline handlers, no page errors | pass |
| No horizontal overflow | pass |

**The one defect found**: `funding_required` (activated, no promotional credit, no
deposit) rendered "Make a deposit to fund your Live balance and start trading." while the
deposit button was toggled only for `deposit_required`. A message with no action is a dead
end, so the button now follows `deposit_required || funding_required`
(`renderLiveModeCard`, pinned by `tests/dashboard_phase2.test.js`).

Two copy dependencies recorded, deliberately not changed here:

1. The landing FAQ says the promotional credit lets you "run the bot with it immediately".
   That is true while `PAYHIP_ACTIVATION_REQUIRED` is unset (the shipped default). If an
   operator enables the activation gate, that sentence and `onboardingPrimaryDesc` need a
   matching edit - enabling the gate is a copy+config change, not a config-only change.
2. With purchasing unavailable (no licence key configured), the activation card's forward
   route is "Contact support". That is honest but depends on the official support link
   being configured (`arbitrix-support-telegram` meta); with it unset the Support Center
   shows its own unconfigured notice. Worth checking before a paid-ad campaign.

## Final polish pass (2026-11-23) - four defects found in the owner's review

Scope: `public/index.html` only (plus test pins). No brand, layout-architecture,
financial, auth or backend change. The design direction is unchanged.

### 1. The dark plate over the equity chart

Source: `#walletSyncLoader`, the first-paint sync scrim (`position:fixed; inset:0`,
`rgba(7,11,20,0.9)`, a spinner and "Loading wallet...", z-index 9999). It is shown at
the top of `initApp()` and dismissed only when `/api/auth/me` settles, so a slow or
stalled session (mobile networks) leaves a spinner over the dashboard - and on a
phone screenshot the chart sits under it. Measured: dismissed at ~1.4s on a healthy
link; unbounded on a stalled one.

Fixes:
- one `dismissWalletSyncLoader(reason)` used by the sync `finally`, by a **1.2s hard
  cap** and by a `window.error` failsafe - no path can leave it up;
- it fades (`opacity -> 0`, `pointer-events:none`, removed from the layer tree after
  200ms) instead of disappearing instantly, and the scrim is lighter (0.82);
- no `pagehide` hook (the activity rotator deliberately has none).

Verified: with `/api/auth/me` delayed 5s the scrim is gone by 1.5s and the dashboard
is interactive; with Chart.js blocked there is no overlay and no page error.

### 2. The floating support launcher

It was a fixed 48px circle at `bottom:16px; right:16px`, so on a phone it sat on the
chart's lower edge or on the bottom-right controls of whatever card was behind it.

Fixes:
- 44px on <=640px, `bottom:12px` + `env(safe-area-inset-bottom)`;
- **content-aware**: on scroll/resize a rAF-throttled hit test (`elementsFromPoint`,
  skipping its own subtree) adds `.kx-fab-away` (fade + `pointer-events:none`) when
  the spot beneath it is the chart canvas, a chart/wallet tab, a `.btn`, or a
  financial figure (`#pnlChart, .chart-period-tab, .wallet-tab, .btn, .kx-kpi-value,
  .chart-stat-value`) - i.e. it yields to controls and numbers, not to whole cards;
- every open dialog hides it (`#depositModal`, `.deposit-modal`, `.modal-overlay`,
  `#supportModal`), so it never floats over a modal;
- `.main-content` keeps a bottom gutter (88px, 76px on phones) so no row ends
  permanently underneath it.

Verified at 320/390/768/1280/1440: away **iff** it covers a control or figure, and
visible at at least one scroll position at every width.

### 3. Bot status wording

`botUiState()` returned `'ready'` only under `APP.mode === 'live'`, and nothing in
this single-mode build assigns `APP.mode`, so a stopped bot reported **"Offline"**
while Start worked - the reachability bug the owner spotted. The metric hint also
described the control ("Running or stopped") rather than the state.

Fixes: `ready` is the stop state (Live is the only wallet); every state has its own
sentence (`bot.readyMsg / runningMsg / pausedMsg / errorMsg / offlineMsg`) and its own
metric hint (`hint.botStatus.ready|running|paused|error`), all eight keys in six
locales. The paused sentence names the notice instead of assuming the promo cap; the
error sentence gives the retry path. Engine and lifecycle untouched.

### 4. Spacing

`.kx-hero` and `.kx-cockpit` on one 10px rhythm, Getting Started one step quieter
(12px, 12px padding, 6px step gaps), chart section gap 10px on phones, plus the
launcher gutter above. Document height: 1790 -> 1812 at 390px (+1.2%), 1292 -> 1296
at 1280px.

### Payment partner contacts (verified, unchanged)

`https://wa.me/17828027841` (Olivia) returns 302 to `api.whatsapp.com/send/?phone=17828027841`;
`https://t.me/AlexArbitrix` returns 200 ("Telegram: Contact @AlexArbitrix"). The
deposit dialog renders exactly those two hrefs with `target="_blank"
rel="noopener noreferrer"`; the values come from `PARTNER_PRIMARY_WHATSAPP_URL` and
the `arbitrix-partner-support-telegram` meta - nothing invented or replaced.

### Verification

- `npm test`: 3989 tests, 3988 pass, 0 fail, 1 skipped.
- `tests/final_polish_ui.test.js` (9) pins the scrim helper/cap/failsafe, the five bot
  states and their copy, the launcher contract, the rhythm block and scope safety.
- Browser audit (puppeteer-core + `/usr/bin/chromium`, stubbed API): 79 checks across
  320/390/768/1280/1440 - chart painted and unobstructed, launcher invariant,
  Start->running->ready, deposit/withdraw dialogs, no page errors; plus a delayed
  session, a blocked Chart.js and es/ar/zh locale runs.

## Return-to-dashboard navigation (2026-11-23)

Reported: from Markets, the Transaction Log, Referral or Admin the only way back to
the dashboard was the hamburger menu. Two one-tap entry points now exist, and the
browser's Back button finally behaves like Back.

### What changed

- **The brand is a link home.** `.app-header-brand` became `<a id="kxToolbarBrand"
  href="#overview">` with the same inside (mark + wordmark) and the same look
  (`text-decoration:none;color:inherit`), plus a visible focus ring and a localized
  tooltip. It works from every view, from the dashboard (a no-op) and from a dialog
  if the bar is somehow reachable.
- **A contextual `← Dashboard` control** (`#kxBackToDashboard`) sits between the
  brand and the view title. It is a real `<a href="#overview">` (so Enter, middle
  click and deep links behave), an arrow - never a close "X" - and it is `hidden`
  unless the view is not `overview`. It reuses the existing `sidebar.dashboard`
  wording for its label and one new key (`nav.backToDashboard`) for its accessible
  name and tooltip (6 locales).
- **One helper for both**: `goToDashboard()` closes whatever is on top (support
  panel, drawer, language/notification dropdowns, any open dialog via its own close
  control), then `showView('overview')`. So the dashboard is never "opened" behind a
  dialog.
- **Back works**: user-initiated navigation now `pushState`s its hash instead of
  `replaceState`. The boot render and the `hashchange` reconciliation stay silent, so
  loading `/#referral` adds no entry, a repeated render of the same view adds no
  duplicate entry, and Back from `#referral` returns to `#markets` (the hashchange
  listener drives the view) rather than leaving the app.
- Router discipline is unchanged: `showView()` still owns host visibility, the
  toolbar title and the active sidebar link, and now also syncs the control.

### Measurements (secondary view, one row, no horizontal overflow)

| width | bar height | control | notes |
|---|---|---|---|
| 320 | 58 | 30x28 icon | 1px short of fitting the labelled pill, so the pill and the brand gap give back a few px |
| 390 / 430 / 479 | 58 | 32x30 icon | icon-only below 480px - the labelled pill wrapped the bar to 102px at 431px |
| 480 - 1023 | 58 | 101x32 labelled | |
| 1280 / 1440 | 58 | 101x32 labelled | |

The dashboard bar is unchanged at every width (control `display:none`, no extra
element height). A secondary view adds the control, so below 640px the bar is held to
one row and the view title ellipsises instead of wrapping - measured "Transaction Log"
clipping only at 390 / 480 / 640 and shown in full at 430 / 479 / 600.

RTL: the arrow mirrors (`html[dir="rtl"] .kx-back-dash i{transform:scaleX(-1)}`).

### Dialogs

Profile, Subscription, Support and 2FA are dialogs, not views: the toolbar is behind
them, so the control cannot be tapped while they are open. Their existing close
control returns to the view underneath, where the new control is available - two
taps from a secondary view, one from the dashboard. `goToDashboard()` (used by the
brand and the control) also closes any open dialog, so neither entry point can land
on a hidden dashboard.

### Verification

- `npm test`: 4001 tests, 4000 pass, 0 fail, 1 skipped. New
  `tests/dashboard_return_nav.test.js` (12) runs the real router in a vm for every
  secondary view (control offered/hidden, title, active sidebar, return, brand,
  dialog cleanup, push semantics, deep links, i18n, scope).
- Browser audit (`/tmp/preview/nav_check.js`, puppeteer + chromium, DOM assertions
  only): **282/282** across 320/390/430/480/768/1280/1440 - both entry points from
  Markets / Transaction Log / Referral, hidden on the dashboard, no toolbar growth or
  overlap with the hamburger, brand, language, notification or profile controls, Back
  behaviour, `/#referral` deep link, es/ar/zh labels, RTL arrow, admin view, and a
  dialog opened over a secondary view.

## Onboarding / activation / UX audit (2026-11-23, text-only)

The vision adapter is unavailable in this environment, so this audit used DOM
assertions and source inspection only - **no screenshots were taken or analysed**.

### What was executed

- **Dead-control scan.** Every inline handler attribute in the served DOM
  (`onclick`, `onchange`, `oninput`, `onsubmit`, `onkeydown` - including hidden
  subtrees) was parsed, method calls excluded, and each referenced function
  resolved against the page's global scope: **132 handler names referenced, 0
  unresolvable.** No button on the page is wired to a missing function.
- **Onboarding choices.** `#onboardingModal` offers "Start with my $50 credit"
  (`chooseOnboarding('credit')`) and "I'm ready to deposit"
  (`chooseOnboarding('deposit')`). Both are handled: `credit` enters the app and
  stores the per-account choice, `deposit` opens the deposit dialog (or defers to
  `initApp`). No dead end, no invoice created by either choice.
- **Activation state matrix.** `renderLiveModeCard()` was driven through
  `activation_required` / `deposit_required` / `available`: the card is visible in
  the first two and hidden in `available`, and the two CTAs ("Activate Live Mode",
  "Make your deposit") stay reachable. Copy is state-driven and never claims
  activation without a purchase.
- **Deposit dialog.** Opens from the Available-card action, minimum shown as
  "$100", the three funding options present, and `#depositActivationNote` present
  in the DOM ("This deposit is trading capital. Live trading also needs a separate
  one-time $50 activation - a deposit does not activate your account."). It is
  only *displayed* when activation is actually outstanding, which is correct.
- **Start Here card.** Always describes the Live requirements only; the subtitle
  switches between "one step" and "two steps" depending on whether activation is
  required, and a completed checklist collapses to one line. No balance or trading
  rule is touched.
- **Page errors:** none on any run.

### Findings that need the owner, not code

1. The onboarding copy leads with the **$50 promotional credit** rather than Demo
   Mode. That is a positioning decision (an earlier phase had demo-first); the
   mechanics are fine either way.
2. Profile, Subscription, Support and 2FA are **dialogs**, so the toolbar (and
   therefore the new return control) sits behind them. Their own close control
   returns to the underlying view. A Dashboard action inside each dialog header
   would be a separate, deliberate change.
3. `setMode()` is reachable from inline handlers but is not a `window` property,
   so any future code that calls `window.setMode()` would fail. The mode tabs
   themselves work.
