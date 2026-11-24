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
