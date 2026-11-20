# C1 - Live Mode activation enforcement

Branch: `relaunch/rebrand-payment-commercial` (PR #171)
Base head when this work started: `fef1273`
Status: implementation complete, tests green, **not merged, not deployed, no
migration applied, no production environment variable changed**.

---

## 1. Approved commercial rules applied

| Requirement | Amount |
|---|---:|
| Payhip one-time activation | $50 |
| Minimum qualifying deposit | $100 |
| Minimum platform deposit | $100 |
| Referral qualifying deposit | $100 |

Live Mode requires **both**, independently:

* the $50 buys permission to use Live Mode; it credits no wallet, is not a
  deposit and does not satisfy the $100 funding requirement;
* the $100 must be deposited through the existing Q8Pay flow and confirmed by
  the existing crediting rules; it never grants or satisfies activation.

Demo Mode remains free. There is no grandfathering, no cutoff date and no
deposit-based exception anywhere in the resolver.

---

## 2. Root cause

`getLiveActivationState()` returned "activated" for any account with a confirmed
deposit, before it ever looked at the entitlement:

```js
const deposited = await hasConfirmedDeposit(userId).catch(() => null);
if (deposited === true) {
  return { activated: true, reason: 'grandfathered-deposit', activationRequired: true, exempt: true };
}
```

`hasConfirmedDeposit()` is a `count > 0` predicate over `deposits` /
`payment_invoices` with no date bound, so the exemption applied to **new**
customers as well as pre-existing ones. With `PAYHIP_ACTIVATION_REQUIRED=true`, a
first deposit of $100 made the account eligible without a purchase, and the $50
rail could only ever charge customers who bought before depositing.

Secondary cause: the deposit requirement did not exist at all. The resolver
answered one question (activation), and `/api/bot/start` added a *balance
presence* check, which promotional credit satisfies. So even after removing the
exemption, "activation OR funded" would have remained the effective model.

---

## 3. Corrected logic

One resolver owns the decision, and both gates use it:

```js
async function getLiveModeEligibility(userId) {
  const activation = await getLiveActivationState(userId);   // entitlement ONLY
  ...
  const read = await getConfirmedDepositTotal(userId);       // sum, fail closed
  if (activation.activated !== true) return { eligible: false, reason: activation.reason, ... };
  if (!read.ok)                      return { eligible: false, reason: 'deposit-check-unavailable', retryable: true };
  if (read.total < minDeposit)       return { eligible: false, reason: 'deposit-required', depositRequired: true };
  return { eligible: true, reason: 'eligible' };
}
```

* `getLiveActivationState()` now answers activation only. The deposit branch is
  deleted (no date comparison replaced it).
* `getConfirmedDepositTotal()` sums confirmed `deposits.amount` and
  `payment_invoices.amount_usd`. A provider invoice also writes a legacy
  `deposits` row keyed by `invoice_id`, so the same payment appears in both
  tables; the function takes the **maximum** of the two totals rather than the
  sum, which cannot double count and never overstates funding.
* The threshold is `PLATFORM_MIN_DEPOSIT` (the existing effective constant:
  default 100, env-overridable), so the Live Mode floor and the deposit floor
  cannot drift apart.
* Refusals are machine-readable: `LIVE_ACTIVATION_REQUIRED` (403),
  `LIVE_DEPOSIT_REQUIRED` (403, carries `minDeposit` and `depositTotal`),
  `ACTIVATION_UNAVAILABLE` (503, retryable), `LIVE_DEPOSIT_CHECK_UNAVAILABLE`
  (503, retryable).
* Display: `services/LiveModeStatus.js` gained `deposit_required` (activation
  done, deposit missing) between `activation_required` and `funding_required`,
  and the dashboard card shows a "Make your deposit" action for it.

### Inert by default, as before

With `PAYHIP_ACTIVATION_REQUIRED` unset (the default), eligibility is `true` and
the deposit facts are still reported. Shipping this code changes access for
nobody until the switch is turned on; the switch is an operator decision and was
not changed here.

---

## 4. Live Mode entry points inspected

| Surface | Gate | Result |
|---|---|---|
| `POST /api/bot/start` (`mode: 'live'`) | `getLiveModeEligibility()` first, then the balance-presence check, then the promo cap, the profit pause and the emergency stop | enforced |
| `POST /api/bot/start` (`mode: 'demo'`) | none | Demo stays free |
| `POST /api/trade` | `getLiveModeEligibility()` before any wallet read or ledger write | enforced (direct API calls cannot skip the bot screen) |
| `POST /api/bot/start` MARKETING_SANDBOX | `sandboxHandled()` runs first | sandbox unaffected |
| `POST /api/trade` MARKETING_SANDBOX | `sandboxHandled()` runs first | sandbox unaffected |
| `GET /api/live/activation` | read-only; returns `activated`, `eligible`, `depositRequired`, `depositSatisfied`, `depositTotal`, `minDeposit` | display |
| `POST /api/live/activate` | licence verification unchanged; success now reports both halves | display |
| `GET /api/auth/me` | `liveEligible`, `liveDepositSatisfied`, `liveMinDeposit`, `liveMode.status` | display |
| `POST /api/bot/stop`, `GET /api/bot/status` | not access decisions (stop must never be gated) | unchanged |
| `/api/withdraw/*`, `/api/deposit/*`, `/api/subscription/*` | **not** activation-gated | unchanged by design (see limitations) |

Audit greps: `getLiveActivationState(` has two remaining callers - the
`getLiveModeStatus()` display fallback and the redeem response (now via
eligibility). `hasActivation(` has one caller (the resolver). No code path
compares a deposit to activation, and the string `grandfathered-deposit` no
longer exists.

---

## 5. Files changed

| File | Change |
|---|---|
| `server.js` | resolver rewritten (no grandfather); `getConfirmedDepositTotal()`; `getLiveModeEligibility()`; `sendLiveModeRefusal()`; both gates; both payloads; redeem response |
| `services/LiveModeStatus.js` | `deposit_required` status + deposit fields on the payload |
| `public/index.html` | status view entry, card explainer branch, "Make your deposit" action, 3 new keys x 6 locales (dictionary 1631 -> 1634) |
| `tests/live_mode_eligibility.test.js` | **new** - 22 HTTP-level tests |
| `tests/helpers/fake-supabase-live-mode.js` | **new** - scenario-driven database + Payhip stub |
| `tests/live_activation_entitlement.test.js` | tests 21/22 rewritten (no grandfather; outage fails closed), test 34 follows the new gate |
| `tests/bot_mta.test.js` | gate-order pin now names the eligibility gate |
| `tests/promo_credit_display.test.js` | payload-reuse pins follow `_liveEligibility` |
| `tests/deposit_discoverability.test.js` | deposit entry points 3 -> 4 (the new Live Mode prompt opens the same dialog) |
| 13 dictionary-count pins | 1631 -> 1633 -> 1634 as the keys landed |

No migration was added: the rule needs no schema. Migration 049 remains
unapplied and was not touched; `referral_config.minimum_qualifying_deposit`
was not modified.

---

## 6. Behavioural test results

`tests/live_mode_eligibility.test.js` boots the real server and calls the real
routes; only the database and Payhip's licence API are substituted. No assertion
in that file is a source-string match.

| # | Case | Result |
|---|---|---|
| 1 | registered, no activation, no deposit -> Live Mode denied | 403 `LIVE_ACTIVATION_REQUIRED` |
| 2 | $100 confirmed deposit, no activation -> denied | 403 `LIVE_ACTIVATION_REQUIRED` |
| 3 | activation, no deposit -> denied | 403 `LIVE_DEPOSIT_REQUIRED`, `minDeposit: 100` |
| 4 | activation + $50 deposit -> denied | 403 `LIVE_DEPOSIT_REQUIRED`, `depositTotal: 50` |
| 5 | activation + $100 deposit -> allowed | 200 `{status: 'started', mode: 'live'}` |
| 5b, 13, 13b | `/api/trade` enforces the same two facts | 403 with the matching code |
| 6, 6b | refunded/disabled activation denied (entitlement + redeem) | 403 / 409 `licence-disabled` |
| 7 | another account's licence | 409 `claimed_by_other_account` |
| 8 | licence whose purchase is no longer active | 409 `purchase_not_active` |
| 9, 9b | Payhip verification outage | 503 `ACTIVATION_FAILED` / 503 `ACTIVATION_UNAVAILABLE` |
| 10, 10b | entitlement store down / deposit store down | 503 fail closed, status reports `activation-unavailable` / `LIVE_DEPOSIT_CHECK_UNAVAILABLE` |
| 11 | Demo Mode without activation or deposit | 200 |
| 12 | MARKETING_SANDBOX | no Live Mode refusal |
| 14 | deposit never writes an entitlement | no `payhip_*` write; `activated: false`, `depositSatisfied: true`, `eligible: false` |
| 15 | redeeming never moves money | no wallet write, no money RPC |
| payload | `/api/live/activation` and `/api/auth/me` report both halves | `liveMode.status` = `deposit_required` / `available` |

Full suite: **3349 tests, 3349 pass, 0 fail, 0 skipped** (`npm test`), up from
3327 (22 new). `node --check` clean on `server.js` and
`services/LiveModeStatus.js`; all 8 inline `public/index.html` script blocks
parse; 0 U+FFFD.

---

## 7. Confirmations requested

* **Deposits cannot grant activation.** The deposit branch is deleted; tests 2
  and 14 prove a funded account with no entitlement is refused and that no
  entitlement row is written by a deposit. `grandfathered-deposit` no longer
  exists in the codebase.
* **Activation cannot credit wallet funds.** Test 15 asserts no wallet write and
  no money-moving RPC during redemption; `services/PayhipEntitlements.js`
  contains no reference to `live_balance`/`wallets`/`transactions` (pinned by
  the existing module test).
* **The $100 thresholds are unchanged.** `PLATFORM_MIN_DEPOSIT_USD = 100`,
  `PLATFORM_MIN_DEPOSIT` (effective default 100) and the referral row are
  untouched; no migration was applied or edited.
* **Both gates are server-side.** The browser receives a state to render; every
  refusal above is produced by the server.

---

## 8. Outstanding limitations (flagged, not silently resolved)

1. **Pre-existing running bot sessions are not retroactively stopped.** The
   gates protect new starts and every trade request, but a session already
   running at deploy time keeps its `is_running` row; the server-side worker (if
   enabled) would continue executing for it. Recommendation: before enabling
   `PAYHIP_ACTIVATION_REQUIRED`, list running sessions and stop those whose
   owner is not eligible. Changing the worker is out of scope here.
2. **The $50 promotional credit can no longer be traded without activation and
   a $100 deposit.** This follows directly from the required matrix (case 3:
   activation + no deposit -> denied). If promotional credit is meant to stay
   tradable, that is a separate, explicit exemption decision - it was not added
   silently.
3. **`hasConfirmedDeposit()` is still count-based** and remains the funding
   signal for withdrawals, the promo cap and login defaults. Live Mode uses the
   new sum-based check, so a legacy sub-$100 deposit can read "deposited" for
   withdrawal purposes while not satisfying the Live Mode floor. Aligning both
   callers is a separate change.
4. **Withdrawals and subscriptions are not activation-gated.** Withdrawing
   requires the existing KYC/eligibility rules, and the subscription debits the
   Live balance; gating either on activation would trap funds or break billing,
   so neither was changed. Flagged for a product decision, not implemented.
5. **The rule is inert until the operator sets `PAYHIP_ACTIVATION_REQUIRED=true`.**
   That is deliberate (deploy safety) and means the acceptance criterion is
   enforced from the moment the flag is set, not from the moment this code
   merges. The flag was not changed here.
6. **No production verification was possible** from this environment: no
   PostgreSQL, no Payhip credentials, no deploy. The migrations were not
   executed; the tests substitute the database and the licence API.

---

## 9. Repository verification log

* Commit `aee5a90` on `relaunch/rebrand-payment-commercial` (PR #171, still a
  draft; base `main` = `7910db6`).
* GitHub Actions for `aee5a90`: **static checks passed, `npm test` passed (both
  matrix legs)**.
* Local: `npm test` = 3349 pass / 0 fail / 0 skipped; `node --check` clean;
  8/8 inline `index.html` script blocks parse; 0 U+FFFD.
* `docs/relaunch/FINAL-INDEPENDENT-REVIEW.md` is deliberately left untracked
  (review artefact, not part of this change).
