# Onboarding, activation and deposit-flow audit — November 2026

Companion to PR `fix/min50-payhip` ($50 minimum deposit, paid activation removed
from the normal journey). Everything below was executed against the real page.

## Method and its limitation

- Tooling: `puppeteer-core` + `/usr/bin/chromium`, **DOM assertions only**
  (element visibility, text content, computed values, request payloads,
  request counts).
- **No screenshot or vision inspection was possible**: the model adapter
  discards image content, so screenshots cannot be read in this environment.
  Consequences: geometry is measured numerically (element boxes, viewport, tap
  target sizes), behaviour is verified by real clicks and real network
  interception, but **subjective visual quality (shading, motion, spacing
  aesthetics) is NOT verified** and needs a human eye.
- The API was stubbed, so **no invoice was ever created and no balance moved**.

## Journeys audited

| # | Journey | Result |
|---|---|---|
| 1 | New account, no deposit → onboarding | Modal appears; two paths (promotional credit / deposit); no purchase step; `$50` floor stated |
| 2 | Onboarding → "I'm ready to deposit" | Opens the real deposit dialog, modal closes behind it, no invoice created |
| 3 | Deposit dialog, Demo mode | Explains the split balance and asks to switch to Live; generate button hidden |
| 4 | Deposit dialog, Live mode | `$50` notice, `$50` preset, amount input, TRC20 warning, three funding routes |
| 5 | Below-minimum amount ($49) | Refused client-side with **zero** network requests |
| 6 | Valid amount ($50) | Exactly one `create-invoice` request `{amount:50, currency:USDT, network:TRC20}` |
| 7 | Payment section | Address, exact amount, network label, QR surface, "Waiting for payment…" |
| 8 | Live Mode, activation flag **off** | No activation notice, no activation guide step, no "Activate" action; Live card explains funding |
| 9 | Live Mode, activation flag **on** | Notice, guide step and Activate action all reappear (integration retained) |
| 10 | Onboarding copy with the flag **on** | States activation + `$50` deposit instead of promising credit-only trading |

Totals: deposit UX **23/23**, onboarding/activation **20/20**, plus the
flag-on onboarding copy check.

## Findings

### Fixed in this PR

1. **Mandatory paid activation in three landing surfaces.** `landing.hero.promo`,
   `landing.faq.a10` and `landing.howItWorks.step2.desc` claimed Live trading
   required a one-time activation. With the flag off that is false. Rewritten in
   all six locales to describe the deposit + promotional credit. (The activation
   UI, routes and migrations are retained and still appear when an operator turns
   the flag on.)
2. **Stale `$100` factual copy.** The platform floor is now `$50`, but the
   support knowledge base answered "$100" in seven answers, and the Telegram
   platform guidance repeated it in en/pt/ar. A customer talking to support would
   have been told a figure the product does not enforce. All updated.
3. **Stale `$100` in the deposit surfaces.** Minimum notice, first preset, error
   mapping and the referral block now derive `$50` from the single server value;
   the dialog contains no `$100` at all.
4. **Referral qualifying amount would have silently drifted.** The SQL award
   helper reads `referral_config.minimum_qualifying_deposit`, not the server
   constant. Migration 057 syncs it; without it a `$50` deposit credits but its
   referral never qualifies.

### Reviewed, no change needed

- **Onboarding primary path is the promotional credit.** It is the lowest-friction
  first value (no payment, no card) and the cap (`$30` realized profit until a
  deposit) is disclosed in the same button. Judged correct.
- **Demo Mode entry.** Still available from onboarding and the sidebar; it never
  demands a payment.
- **Deposit dialog density.** The dialog carries five things the mission asks for
  (amount, network warning, exact amount, address, status) without a second
  screen. No further reduction is possible without dropping a safety message.

### Deferred

- **Subjective visual review** (needs screenshots/vision — unavailable here).
- **Provider migration** (`docs/payments/PROVIDER_RESEARCH_2026-11.md`): the
  recommendation is to keep Q8Pay; external provider documentation could not be
  verified from this environment.
- **Onboarding personalisation** (e.g. skip the modal for users who arrived from a
  deposit deep link) would be a behaviour change beyond this mission.

## Reproduce

- `npm test` — 4026 tests, 0 failures.
- Deposit DOM harness: stubs `/api/auth/me`, `/api/deposit/options`,
  `/api/payment/create-invoice`, `/api/payment/status`; asserts the 23 points
  above. Run against a local `node server.js` on port 12000.
- Onboarding harness: same stubs plus `arbi_user` in localStorage (what a real
  login writes), and a second run with `activationRequired: true`.
