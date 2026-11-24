# Kalderix UI/UX redesign - blueprint

Scope: the authenticated product (`public/index.html`, 29,866 lines, one vanilla-JS page with a
4,300-line stylesheet). Landing, auth and the standalone marketing pages are out of scope for
this pass; they were inspected only to keep the product visually continuous.

Everything below comes from reading the markup, the stylesheet and the section-switching code.
Where a finding is structural rather than visual, the code reference is given.

---

## 1. Existing UX problems

**Architecture**

1. **The "pages" are anchors on one endless scroll.** Sidebar links use `data-section` and call
   `el.scrollIntoView()` (`index.html` ~26,763). Dashboard, Markets, Transaction Log and Referral
   are stacked in one ~3,000 px column; Deposit, Withdraw, Support, Subscription, Profile and 2FA
   are modals. There is no page concept, so browser back, deep links and "where am I" are
   undefined.
2. **No active-section feedback while scrolling.** `.active` is set only on click, so scrolling
   to Markets leaves Dashboard highlighted.
3. **Two unrelated modal systems.** `.modal-overlay` (z-index 9999: profile, subscription, 2FA,
   email, KYC, install) and `.deposit-modal` (3000/10000: deposit, withdraw, onboarding,
   verification, support) differ in scrim, padding, header and close affordance - it reads as two
   products.
4. **Deposit / Withdraw live in a number cell.** `#availableDepositBtn` / `#availableWithdrawBtn`
   are small chips inside the "Available" KPI card (`index.html` 7859), competing with the balance
   for the same 220 px. They are the two most important actions in the product.
5. **Duplicate entry points with different weights.** Deposit appears in the sidebar, the
   Available card, the Live Wallet card and the promo/activation cards; Withdraw in the sidebar
   and the Available card. Nothing distinguishes primary from secondary, and on mobile the
   sidebar is behind a hamburger.

**Dashboard**

6. **Four equal KPI cards** (Equity / Available / P&L / Bot) give a stopped bot the same weight as
   the user's money and force numbers into 220 px cells where they wrap.
7. **Seven stacked blocks of similar weight** before the first trading control: ticker, promo
   banner, Start Here, KPI grid, live-mode card, chart, trading stats. Nothing leads.
8. **Repeated information:** the Live balance appears in Equity, Available and the wallet card;
   the promo credit in the banner, the promo card and the wallet; bot state in a KPI, a pill and
   a status line.
9. **Chart and bot control are separated** by Trading Statistics, although they are the two
   halves of one decision (watch, then start/stop).

**Wallet**

10. Live and Bonus are hard-coded tabs whose containers are stacked, so switching changes page
    height by ~600 px.
11. The Live Wallet card mixes balance, a marketing line, four quick-amount buttons, a deposit
    button and withdrawal readiness in a 220 px column.

**States, density, motion**

12. Empty states are a bare icon + sentence; loading is the word "Loading" in a cell; errors are
    three different red boxes.
13. Type sizes are ad hoc: 9 px, 10 px, 11 px and 12 px labels inside one card, with no scale.
14. Admin tables scroll horizontally on phones; the mobile treatment is a scroll region, not a
    card list.

## 2. Proposed platform architecture

A persistent shell plus a small number of real views:

| View | Content |
|---|---|
| **Overview** | account hero (mode, equity, available, P&L, primary actions), trading cockpit (chart + bot), wallet summary, recent activity, notices |
| **Markets** | the TradingView chart as a full view, not a 400 px strip under the dashboard |
| **Activity** | transaction log with range switch and filters |
| **Referral** | partner program, referral link, pending referrals, payouts |
| **Account** | profile, security (2FA), subscription, install - modal-hosted as today |

The shell never changes with the view; only the content column does. Every existing element id
and handler stays alive, so the JS keeps working while the product gains a sense of place.

**Implementation note:** the anchor mechanism (`data-section` + `scrollIntoView`) becomes a view
router that shows one `[data-view]` container at a time. The links keep `data-section` for
compatibility with existing handlers and tests.

## 3. Navigation

**Desktop (>= 1024 px)**: 240 px sidebar, grouped:

```
[brand]
 OVERVIEW   Overview
 MONEY      Deposit   Withdraw      (Deposit is the only filled sidebar action)
 TRADING    Markets   Activity
 GROW       Referral  Subscription
 ACCOUNT    Support   2FA   Profile   Install   Logout
[account chip: mode, equity, verification status]
```

Group labels are 10 px, muted, uppercase - the only decorative element in the nav. Icons stay
Font Awesome (already loaded).

**Mobile (< 640 px)**: the existing drawer becomes a full-height sheet with the same groups and
the account chip pinned at the bottom. Deposit/Withdraw also sit in the dashboard hero, so they
are reachable without opening the drawer.

**Active state** is driven by the current view (set on load, on history navigation and on
language switch), not by click.

## 4. Dashboard layout

```
+-----------------------------------------------------------------------+
| hero: [LIVE chip]  Total equity $1,234.56      [ Deposit ] [Withdraw ] |
|        Available $1,234.56   Today's P&L +$12.40   Bot: Running        |
+-----------------------------------------------------------------------+
| notices (promo credit / start here) - slim, dismissible, one line each |
+-----------------------------------------------------------------------+
| cockpit: Equity performance (2/3)            | Bot control (1/3)      |
|          period tabs + 4 inline stats        | pill, toggle, start/stop|
+-----------------------------------------------------------------------+
| wallet summary (Live / Bonus)     | recent activity (last 5)           |
+-----------------------------------------------------------------------+
```

- **One hero, not four cards**: equity is the primary number (36-40 px), available and P&L are
  secondary, mode and bot state are chips. Deposit is the single filled button, Withdraw outlined
  beside it.
- **Notices** keep their ids (`startHereCard`, `promoCreditBanner`, `liveModeCard`) but become
  compact strips: icon, one line, dismiss.
- **Cockpit** places chart and bot control side by side at >= 1024 px, stacked below.
- **Wallet summary** shows both wallets as rows with a switch, so tab switching no longer changes
  page height.
- **Recent activity** is the last five rows of the existing log plus a link to Activity.

## 5. Deposit and withdrawal placement

- **Primary**: dashboard hero, right side, in both Demo and Live (Demo still explains the mode
  before opening the flow, as today).
- **Secondary**: sidebar under MONEY (text links; the hero owns the emphasis).
- **Tertiary**: wallet summary row actions ("Add funds" / "Withdraw").
- **Mobile**: the hero actions become a two-up row under the balance; the drawer keeps the same
  entries.
- No new financial action is invented: Live and Bonus are separate ledgers in this product, so no
  "Transfer" button is added.

## 6. Wallet design

- One wallet card with a Live / Bonus segmented switch and two rows, instead of two hard-coded
  containers stacked in the same column.
- Balance is the primary number; the descriptive line becomes muted secondary text beneath it.
- Quick amount buttons stay in the deposit dialog (where they already exist); the wallet card
  keeps Deposit/Withdraw plus the readiness checklist.
- The Live vs Bonus difference (withdrawable vs convertible) is stated once per row.

## 7. Trading interface

- Chart fills the cockpit on Overview and the whole view in Markets; period tabs become a
  segmented control; the four numeric stats become inline deltas under the title.
- Trading statistics become one compact strip (win-rate ring + five numbers) instead of six
  equally weighted tiles.
- Bot control: one card with state pill, scanner toggle, one primary Start/Stop button and the
  engine disclosure. Same ids (`botToggleLive`, `startStopBtnLive`, `botStatusMsgLive`,
  `botStatePillLive`) and handler (`toggleBot()`); no logic change and no performance claim added.

## 8. Mobile layout strategy

- Single column, 16 px gutters, 12 px rhythm.
- Hero stacks: mode chip, equity, then the two actions full width (>= 44 px each).
- Admin tables keep `.table-wrap`; customer-facing history rows become cards via `data-label`.
- Modals become full-screen sheets below 640 px (already true for the deposit dialog; extended to
  overlay modals).
- Sticky header keeps hamburger, brand and notifications; the ticker collapses to one line.
- Type floor: 11 px labels, 13 px body, 15-16 px primary numbers - no 9 px text.

## 9. Design system

Tokens extend the existing `:root`; the palette is unchanged.

| Group | Values |
|---|---|
| Surface | `--kx-bg` #0E141C, `--kx-surface` #161E29, `--kx-surface-2` #1C2634, `--kx-elevated` #232F3F |
| Border | `--kx-line` rgba(233,239,247,.08), `--kx-line-strong` rgba(233,239,247,.14) |
| Text | primary #E9EFF7, secondary #A9B7C7, muted #8B98A9 |
| Brand | unchanged: `--brand` #5EA0FF, `--brand-weak` .10, `--brand-border` .34, `--on-brand` #06121F |
| Semantic | success #2EBD85, danger #E5484D, warning #E8973B, info #5EA0FF |
| Radius | 6 / 10 / 14 / 20 px |
| Spacing | 4 / 8 / 12 / 16 / 24 / 32 / 48 |
| Type | 11 / 12 / 13 / 14 / 16 / 20 / 28 / 36 px, weights 400-700, tabular numerals for money |
| Elevation | flat cards + 3 shadow levels (raised, popover, modal) |

Components: `.kx-card`, `.kx-card-head`, `.kx-kpi`, `.kx-btn`, `.kx-field`, `.kx-seg`,
`.kx-badge`, `.kx-table`, `.kx-empty`, `.kx-skeleton`, `.kx-notice`, `.kx-modal`, `.kx-nav-group`.

Rules: one accent colour; semantic colour only for P&L and state; borders before shadows; no
gradients except the hero's existing subtle brand wash; 44 px minimum touch target.

## 10. Existing components to reuse

`.card` markup and all ids, `.icon-bg`, `.status-badge`, `.btn`, `.mode-tabs`, `.toggle-switch`,
`.tx-*` rows, `.table-wrap`, the notification panel, ticker, language dropdown, support widget,
the `t()` dictionary (1,600 keys x 6 locales), the brand SVG mark, Font Awesome and the existing
Chart.js instance.

## 11. Components to redesign

Sidebar, top bar, KPI cards (into one hero), chart header, trading statistics, wallet tabs (into a
switch), bot card, transaction rows, start-here / promo notices, all modals (one visual language),
form controls, empty states, loading states, error notices, admin tables.

## 12. Components to replace

- `data-section` scroll router -> view router (attributes kept).
- Two modal systems -> one shell (both class names kept for JS compatibility).
- Wallet tabs -> segmented switch.
- 4-up KPI grid -> hero + status chips.

## 13. Open-source design resources selected

Live web research was unavailable in this environment (search quota exhausted), so this selection
comes from the systems' published documentation and public guidance. Nothing was installed.

| Resource | How it is used |
|---|---|
| **shadcn/ui + Radix** (MIT) | Reference for control heights (32/36/40), focus rings, 1 px subtle borders, radii and muted palettes. React-only, so not imported. |
| **IBM Carbon 2 px grid / type scale** (Apache-2.0) | Spacing and type-scale discipline for data-dense screens. |
| **Shopify Polaris** (MIT) | Tables -> cards on mobile, empty states, skeleton loading, destructive confirmations. |
| **Open Props** (MIT) | Motion/easing token names; values implemented locally, no dependency. |
| **Tremor** (Apache-2.0) | KPI + chart composition patterns. Reference only (React). |
| **Penpot** (MPL-2.0) | Optional future source for component specs; not needed here (no binary assets). |
| **Onlook** (Apache-2.0) | **Rejected**: it edits React/Tailwind component trees; this app is one vanilla HTML file. |

No runtime dependency is added: no CSS framework, no icon set, no component library.

## 14. Implementation sequence

1. Design tokens + component layer appended to the stylesheet (cascade override, no deletions).
2. App shell: sidebar groups, top bar, content container.
3. View router (Overview / Markets / Activity / Referral) with hash support and active state.
4. Dashboard: hero, notices, cockpit, wallet summary, recent activity.
5. Deposit/withdraw placement + modal unification.
6. Wallet and trading statistics.
7. Activity, Markets, Referral views.
8. Admin tables and shared states.
9. Mobile pass (<= 640 px) and RTL.
10. Test suite, browser DOM verification (6 locales x 3 widths), fix and push.

Each step keeps element ids and handlers unchanged; the suite runs after every step.

---

# Implementation record (2026-11-23)

What shipped in this pass, and what was deliberately deferred.

## Shipped

**1. Design-system layer (append-only).** A ~330-line block at the end of the stylesheet
declares the token set (`--kx-bg/surface/elevated/line/text`, radii, a 4 px spacing ramp, an
11-36 px type ramp, elevation, easing, `--kx-nav-w`, `--kx-content`, `--kx-tap`) and restyles
the existing components through them: cards, buttons, inputs-adjacent controls, segmented
controls, tables, empty states, skeletons, modals, header and sidebar. Nothing above it was
deleted, so every legacy selector still resolves and the override is reviewable in one place.
The accent is untouched (`--brand: #5EA0FF`); no second brand colour was introduced.

**2. Account summary hero.** The four equal KPI cards became a composed hero
(`#kxHero` > `.kx-hero-eq/av/pnl/bot`) with a 20/28/36 px type scale, tabular numerals,
plain-language hints, and the Deposit/Withdraw pair promoted to 44 px actions inside the
Available card. Grid areas: one column on phones, 2x2 on tablets, a two-row asymmetric
desktop composition where Equity spans both rows.

**3. Cockpit.** The chart card (`#chartCard`) and the trading statistics
(`#tradingStatsCard`) are wrapped in `#kxCockpit`: stacked below 1100 px, 1.9fr/1fr side by
side above it. The two decision surfaces (what happened, how it happened) share one row.

**4. Grouped sidebar.** Thirteen links became five labelled groups (Overview, Money,
Trading, Grow, Account) with 10 px uppercase labels, rounded 40 px rows, an inset active
indicator, and both Deposit and Withdraw promoted into the Money group. Five new i18n keys
(`nav.*`) were added to all six locales.

**5. View router (the structural change).** `showView(name, opts)` replaces the
scroll-into-view model:

* **Overview** is a real container (`#kxViewOverview`, `hidden` attribute) holding banner,
  welcome card, hero, live-mode card, cockpit and both wallet sections.
* **Markets**, **Activity** (the transaction log) and **Referral** keep their existing cards
  and are shown/hidden by the router; **Admin** is a view too.
* The router sets the nav active state, the toolbar view title (`#kxViewTitle`), a
  `data-kx-view` body attribute, the `#view` hash and scroll position; `hashchange` and a
  first-load hash are honoured.
* `navigateToAdmin()` delegates to the router. **Bug fixed:** it used to hide every
  `.card, .wallet-section` in `#mainContent` with inline styles and never restore them,
  leaving a blank dashboard after visiting Admin until a reload. Nothing is hidden now; the
  overview is hidden as one container.

**6. Accessibility + motion.** A `:focus-visible` ring on every interactive element, an
opt-out for `prefers-reduced-motion`, themed scrollbars, and no `!important` display
toggles in the new layer.

## Deliberately not done

* **Landing, auth and marketing pages** were left alone (out of scope for this pass; they
  already had their own polish rounds and are pinned by funnel tests).
* **Landing-side token migration** (`.landing-*` to `--kx-*`) is a follow-up; doing it here
  would have put the conversion funnel at risk for no user-visible gain inside the product.
* **Component extraction** into separate files, a build step, or a CSS framework: none
  added - the page stays a single shipping artefact.
* **Deposit/withdraw modal unification** is only visual (shared radius/scrim/header). The
  two modal systems remain separate in behaviour because their z-index contracts and
  scroll-locking differ and are covered by existing tests.

## Verification

* `npm test`: **3952 tests, 3951 pass, 1 skipped (pre-existing browser-only skip)**.
  New suite `tests/redesign_shell.test.js` (14 tests) pins tokens, hero ids/order, cockpit
  grouping, the five localized nav groups, router placement + behaviour (run in a vm),
  the admin delegation, the breakpoints, focus/reduced-motion, "no `!important` hiding",
  and that money rules and pre-existing ids were preserved.
* DOM verification (`puppeteer-core`, real page, API stubbed, no screenshots):
  **338/338** checks across `en/es/ar/zh` x 320/390/768/1280 - zero horizontal overflow,
  hero and both actions visible and >= 44 px with no overlap, localized nav labels, only the
  overview view shown, view title present, header height within budget, cockpit side-by-side
  at 1280 and stacked at <= 640 (RTL-aware), accent unchanged, KPI scale >= 16 px, focus
  ring present, dialog opens/closes and fits a 390 px viewport, the drawer starts
  off-canvas, opens grouped (5 groups / 12 links), locks background scroll and unlocks on
  close, navigation switches views/title/hash/active state, admin leaves the dashboard
  intact, and the `#markets` deep link works.
* Encoding: 0 U+FFFD, no pre-existing non-ASCII code point lost, 47 added (the new
  localized nav labels).

## Known limitations

* **No screenshot/browser-vision verification** was possible in this environment (the model
  adapter drops image content), so all visual verification is DOM/computed-style based:
  geometry, computed colours, type sizes, overflow and visibility. Subjective judgement
  (does it *look* premium) has not been machine-checked.
* The header is sticky and wraps on narrow screens; at 768 px it measures ~132 px. That is
  inside the tested budget but is taller than the desktop 58-70 px.
* The mobile drawer keeps its 260 px / 78 vw width; the grouped labels add two extra rows
  of vertical rhythm on small phones (the drawer scrolls).

