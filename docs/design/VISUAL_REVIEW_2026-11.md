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
