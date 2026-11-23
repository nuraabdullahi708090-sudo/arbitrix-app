# Kalderix UX / onboarding / activation audit

Date: 2026-11-23. Method: source reading plus DOM/computed-style measurement in headless
Chromium (`puppeteer-core`, real page, API stubbed). **No screenshot review was possible** in
this environment - the model adapter discards image content - so every finding below is either
code- or geometry-verified. Subjective visual judgement is explicitly out of scope.

Scope: the authenticated product (`public/index.html`), its onboarding entry, the Live
activation surface and the modal system. Landing/auth/marketing pages were inspected only for
continuity.

---

## 1. Shell measurements after the redesign

| viewport | header | hero | cockpit | document |
|---|---|---|---|---|
| 320 | 134 px | 529 px | 829 px | 2,466 px |
| 390 | 90 px | 473 px | 876 px | 2,394 px |
| 768 | 132 px | 319 px | 799 px | 2,003 px |
| 1024 | 54 px | 267 px | 839 px | 1,868 px |
| 1280 | 54 px | 207 px | 428 px | 1,378 px |

Reading: the dashboard no longer runs to ~3,000 px. The document is 1.1 screens shorter at
1280 px than before the router existed (the hidden views are not laid out), and the hero is the
first thing after the toolbar. Horizontal overflow is 0 at every width (all 6 locales).

Fixed during this audit: the mobile override used the `padding` shorthand, which cancelled the
44 px `padding-top` that reserves space for the fixed hamburger. It now sets only the three
sides, so the header clears the menu button again (this was a real regression introduced by the
first redesign commit and is now pinned by the mobile-nav suite).

## 2. Navigation / "where am I"

* Sidebar links no longer scroll, so the previous defect - the "Dashboard" link staying
  highlighted while the user scrolled to Markets - cannot occur: the router owns the active
  state.
* Every view now sets a toolbar title (`#kxViewTitle`), the `#view` hash and `data-kx-view`.
  Deep links work: `/#markets`, `/#activity`, `/#referral` (verified).
* Leaving Admin restores the dashboard. Before the audit, `navigateToAdmin()` hid every card in
  `#mainContent` with inline styles and never restored them, so the dashboard stayed blank
  until a manual reload - a bug a customer could hit after visiting the admin panel once.

## 3. Modals

Verified at 390 px: onboarding, profile, support, subscription, deposit and withdrawal all open,
fit the viewport, keep a close affordance and cause no horizontal overflow.

* **Two modal systems remain**: `.modal-overlay` (z-index 9999: profile, 2FA, KYC, email,
  install) and `.deposit-modal` (3000/10000: deposit, withdraw, onboarding, verification,
  support). The redesign unified what the eye reads - scrim, radius, border, header rhythm,
  shadow - but not the behaviour. `body:has(#depositModal.open)` locks scrolling for the deposit
  sheet only; overlays rely on their own handlers.
* **Deposit is a full-screen sheet on phones** (0 border radius, by design, so the amount field
  stays above the keyboard). The other modals stay centred cards. That asymmetry is intentional
  and pinned; it is not a styling miss.
* **Escaping**: `.modal-overlay` handles Escape per modal; the deposit sheet does too. No modal
  traps focus - a real (pre-existing) accessibility gap, listed in section 6.

## 4. Onboarding

* Entry: `showOnboarding(user)` (index.html ~25,133) writing a per-account marker
  `arbi_onboarding_<id>`; the modal is `#onboardingModal` (class `.deposit-modal`). Shown at most
  once per account, never for `MARKETING_SANDBOX`, never for funded accounts.
* The primary choice is the safe one ("Explore Demo"); "Review Live" only switches mode and
  starts no deposit or invoice.
* After the redesign the modal inherits the shared sheet styling; it is unaffected by the router
  because it renders over the app rather than inside a view.
* **Gap found (not fixed):** onboarding copy is explained inline but there is no "what happens
  next" step outside the deposit dialog. The deposit modal carries the activation/funding split;
  the onboarding screen itself does not. Low risk, but a candidate for a copy pass.

## 5. Live activation

* States live in `APP.liveMode` (server-authoritative) and render in `#liveModeCard`; the
  dashboard card is the only place a customer learns that activation is a separate $50 step
  from funding.
* After the redesign the card keeps its own surface and remains inside the overview view, so it
  no longer competes with three equal-weight KPI cards for attention.
* **Confirmed pre-existing behaviour:** with `PAYHIP_ACTIVATION_REQUIRED` unset everything is
  eligible; the card is informational. When the flag is on and activation is missing, the
  purchase CTA offers an explicit "unavailable" explanation plus a support route instead of a
  dead button.

## 6. Remaining issues, prioritised

1. **Focus management in modals** (a11y, medium): focus is not moved into an opened modal and
   not restored on close; background focus is reachable with Tab. Fix is local
   (`showModal`/`closeModal` helpers) but touches every modal, so it needs its own pass.
2. **Tablet header height** (visual, low): 132 px at 768 px. It is inside the tested budget and
   the content wraps legitimately, but it is the tallest header in the product. Options: hide
   the account-status chip below 1024 px, or move it into the sidebar status block.
3. **Landing-side tokens** (consistency, low): the landing still uses its own palette
   variables. Migrating it to `--kx-*` would make the funnel match the app, but it is the
   conversion surface and pinned by funnel tests - separate, deliberate change.
4. **Two modal systems** (maintainability, low): unifying their *behaviour* (scroll lock, Escape,
   focus) would remove the second implementation without changing what customers see.
5. **Onboarding "next step" copy** (content, low): see section 4.

None of items 1-5 is a functional regression; each is a scoped follow-up.

## 7. What was verified, and how

* `npm test`: 3,952 tests, 3,951 pass, 1 pre-existing browser-only skip.
* DOM sweep: 338 checks across en/es/ar/zh x 320/390/768/1280 (overflow, hero/actions, nav
  labels, view exclusivity, cockpit breakpoints incl. RTL, drawer open/close/scroll-lock, view
  switching, admin restore, deep links, dialog geometry).
* Second increment: 33 checks (markets chart host, referral metric grid 3/2 columns, metric type
  scale, rendered transaction rows with the new density, overflow sweep).
* Modal audit: 25 checks (six modals at 390 px).
* Encoding: 0 U+FFFD, no pre-existing non-ASCII code point lost.
