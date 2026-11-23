# Onboarding / activation / withdrawal UX audit

Scope: the four customer surfaces that describe what a customer must do to trade Live, and
the withdrawal gate that depends on completed-trade history. Read-only audit plus the fixes
shipped on this branch; nothing here moves money or changes an eligibility rule.

Method: source review of `public/index.html`, `server.js` and `services/LiveModeStatus.js`,
then a DOM-assertion harness (puppeteer-core + Chromium against the real page with a stubbed
API) across the account-state matrix in section 3. **No screenshot inspection was used** -
assertions read text, computed styles, element geometry and network calls.

## 1. Truth table the copy must satisfy

| `PAYHIP_ACTIVATION_REQUIRED` | Activated | Has a confirmed deposit | What is actually required | What the UI must say |
|---|---|---|---|---|
| off | n/a | any | nothing (only the deposit rule for withdrawals) | no purchase, ever |
| on | no | any | one-time activation, then a deposit | activation, then deposit |
| on | yes | no | a deposit of at least `APP.MIN_DEPOSIT` | deposit only |
| on | yes | yes | nothing | nothing |

`activationPurchasable === false` (no approved provider or no store URL) is a fourth axis:
the activation modal must explain that purchasing is unavailable and route the customer to
support rather than showing a dead end.

## 2. Findings

| # | Surface | Before | Severity |
|---|---|---|---|
| 1 | Promotional-credit card (`promo.creditExplain`) | "Purchase a Live Mode activation ($50 one-time) to start trading" in every state | High - instructs a purchase that may not exist |
| 2 | Deposit dialog `#depositActivationNote` | Always visible, including when nothing is required | Medium |
| 3 | Start Here checklist | Always two steps, one of them "Complete the one-time $50 Live activation" | Medium |
| 4 | Onboarding modal | Offered only "make a deposit" / "explore demo"; when an activation IS required it named the wrong first step | Medium |
| 5 | `APP.liveData.hasTradingActivity` | Set only in-session when a trade executed; never hydrated from the server | **High - blocks withdrawals for returning customers** |
| 6 | Withdrawal modal gate 4 | Fed by 5, so a customer who traded in an earlier session was told "Complete at least 1 trade before withdrawing" and the form never opened | High (same defect) |

## 3. Account-state matrix used for verification

1. New, unfunded, credit-bearing, activation **required** and not purchased.
2. Same but activation **not required** (the operator default).
3. Activation purchased, no deposit yet.
4. Funded and activated (no promotional credit).

Each state is exercised at 320 px and 390 px, in `en`, `es`, `pt`, `fr`, `ar` (RTL) and `zh`.

## 4. What shipped

* `activationPending()` in `public/index.html` is the single predicate
  (`APP.activationRequired === true && APP.liveActivated !== true`). Its inputs come only
  from `/api/auth/me` and `/api/live/activation`; there is no local override, so a deployment
  without the Payhip flag cannot display activation copy at all.
* Promo card: `promo.creditExplainTradable` when no activation is outstanding or it is
  already done; `promo.creditExplain` (the activation-aware sentence) only while pending.
* `#depositActivationNote` is hidden in the markup and shown only while pending.
* Start Here: the activation step (`startHere.live.step0`) is prepended only while pending, so
  the checklist is one step or two and its subtitle follows that count
  (`startHere.live.subtitle` / `startHere.live.subtitleNext`). Completion requires every
  displayed step: an outstanding activation keeps the card open.
* Onboarding: `onboarding.explainerActivation` / `primaryDescActivation` rendered by
  `renderOnboardingActivationCopy()`. It is JS rather than `data-i18n` because it
  interpolates the server's minimum deposit; it re-runs in `updateDynamicTranslations()` and
  when the modal opens, so a language switch stays correct.
* `/api/auth/me` returns `hasTradingActivity` - the same `transactions` test the withdrawal
  route enforces (`type = 'Trade Executed'`, count >= 1) - computed inside the existing
  `Promise.all` and failing to `false`. `syncWalletFromServer()` adopts it. The withdrawal
  gate itself is unchanged; it now reads a truthful value.

## 5. Deliberately not changed

* **Withdrawal minimum disclosure.** The amount stays out of the sidebar and the landing page
  ("no minimum withdrawal" copy) and appears only in the withdrawal pop-up once the deposit
  and trade requirements are already met. That is an approved policy decision, not a defect;
  see `tests/withdrawal_minimum_disclosure.test.js`.
* **Withdrawal gate order.** Deposit -> trade -> minimum -> amount -> form. Re-ordering it
  would change which message a customer sees first, which is a product decision.
* **Payhip purchase flow.** Store URL, licence entry and the `not-recorded` retry path are
  unchanged; this branch only stops the *rest* of the UI from assuming an activation.
* **Landing-page hero copy.** It already states both steps separately (one-time activation,
  then at least $100 of trading capital) and is pinned by
  `tests/landing_referral_launch.test.js`; no change was needed.

## 6. Evidence

| Check | Result |
|---|---|
| `npm test` | 3773 tests, 3772 pass, 0 fail, 1 skipped |
| `tests/activation_copy_truthfulness.test.js` | 7/7 (markup default, three activation states through the real `updateLiveActivationUI`, promo variants, onboarding variants in EN + ES with an interpolated minimum, wiring, server/client flag contract) |
| Account-state matrix harness | 26/26 pass; the same harness on the pre-fix tree fails 13 checks (promo instruction, unconditional note, two-step checklist, the false "complete at least 1 trade" toast) |
| Locale x width matrix | 108/108 (6 locales x 2 widths: activation explained with the interpolated minimum, `ar` RTL, no horizontal overflow, no visible element rendering its own i18n key) |
| Composed with PR #201 | 3869 tests, 3868 pass, 0 fail (only `AGENTS.md` conflicts textually - both branches append to it) |

## 7. Known limitation of this audit

There was no screenshot or vision-based inspection available in this environment. Every claim
above is backed by DOM/text/style assertions, network-call counts and the test suite. Visual
polish (spacing, colour perception) therefore relies on the existing design tokens and the
CSS contracts pinned by earlier tests, not on a rendered-image review.
