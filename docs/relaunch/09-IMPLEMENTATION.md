# Relaunch implementation (branch `relaunch/rebrand-payment-commercial`)

Companion to `00-CONSOLIDATED-REPORT.md`. That document is the research record;
this one records what was **built**, why, and what is still waiting on the
founder.

Nothing here is deployed, no migration is applied, no environment variable is
set and no customer balance was touched.

---

## 1. Brand: one switch, no drift

**Problem.** The product name was written ~800 times across 12 files. A rename
would need a mechanical sweep, and any half-applied sweep leaves a platform that
names itself two different things.

**Fix.** A single `BRAND` constant owns the name; `t()` swaps the stored literal
for `BRAND.name` **at render time**.

```js
BRAND = { name: 'Arbitrix', candidate: 'Kalderix', isCandidate: false,
          legalName: 'Arbitrix Trading', kvk: '72923513',
          mailDomain: 'arbitrix.ai', source: 'Arbitrix' }
```

The dictionaries keep the literal today. That is deliberate:

- every existing copy pin in the test suite stays valid (no silent text drift),
- the hard-coded markup defaults can never disagree with the translated string,
- a rename is one edit, not a 333-value migration,
- reverting a rename is the same one edit.

`t()` is self-contained (guards on `typeof BRAND`), so the many unit harnesses
that evaluate it in isolation still render real copy instead of silently
falling back to the key.

**What must never rename** (`services/brand.js` deny-list, pinned by tests):
`arbitrix.pro`, `arbitrix.ai`, `@ArbitrixSupportBot`, `@Arbitrix_CSA1`, the
announcements channel, the partner group invite, the legal entity name and
KVK 72923513. A trading name is not a new legal entity, and the mail domain
carries the verified SPF/DKIM records.

**Selector.** `scripts/rebrand.js --to <Name>` is a **dry run** by default and
reports 802 hits across 12 files for `Kalderix`. It refuses names that do not
start with a capital or fall outside 3–24 characters, and it will not rewrite a
protected identifier. `--write` applies it; it has not been run.

**Status.** KALDERIX is recorded as `candidate` only. It is **not applied**. No
domain, DNS, trademark or deployment action was taken.

---

## 2. Minimum deposit: $100, server-authoritative

**Problem.** The minimum was a literal `100` repeated in the server, the
frontend, six locales of copy and several tests. Changing it meant editing
places that could disagree.

**Fix.** One runtime value.

- `PLATFORM_MIN_DEPOSIT_USD` (default **100**) is read through
  `resolvePlatformMinDeposit()`, which honours `PLATFORM_MIN_DEPOSIT_USD`.
- The frontend adopts `minDeposit` from `/api/auth/me` into `APP.MIN_DEPOSIT`.
- Deposits below the value are refused server-side; the frontend only displays.
- `live.withdrawStatus.notDeposited` and `deposit.min100` now interpolate
  `${{min}}` in all six locales, so no copy states an amount of its own.
- `supabase/migrations/049_min_deposit_50.sql` syncs
  `referral_config.minimum_qualifying_deposit` so the referral rule and the
  deposit rule cannot diverge.

**Setting it to $50 is one environment variable:** `PLATFORM_MIN_DEPOSIT_USD=50`.

**Feasibility note.** The requirement was not to "just change a constant". The
$50 trading case is the platform's own $50 promotional credit: such accounts
already trade through the existing engine and reach the $700 withdrawal floor
through normal trading. Nothing was relaxed — position sizing, the daily loss
limit, the $20 promotional cap and the $400 profit pause are unchanged. The $50
minimum therefore changes only *when* a customer may fund, not the risk
controls. Recorded as an operational follow-up: watch the loss-to-deposit ratio
for the first cohort funded at $50.

Migration `049` alone changes **no** production behaviour until the variable is
set, so it is safe to apply ahead of the decision.

---

## 3. Payhip: activation, not capital (Option A)

**Problem.** The business wants one purchase to activate Live Mode *and* fund
it. Payhip's terms describe digital products and prohibit investment and
money-transmission activity; a purchase that credits a traded balance is not a
software license, and describing it as one would be a false statement to a
payment provider — which the standing directive forbids.

**Decision.** Split the two, at zero friction cost to the customer:

- The **Payhip purchase buys a one-time Live Mode activation entitlement.** It
  credits **no** capital, so the customer price never has to cover
  processor fees.
- **Funding stays a deposit** through the existing Q8Pay route, at the platform
  minimum.

The customer journey is unchanged in shape: pick a package → Payhip checkout →
return → Live Mode is open → make the deposit (now $50 instead of $100, a lower
barrier than before).

**Why this also fixes reconciliation.** Crediting the advertised amount was
arithmetically impossible to sustain: Payhip and the processor take their fees
from settlement, so a $50 sale does not deliver $50 of usable balance. The
service records the real numbers (`price_cents`, `stripe_fee_cents`,
`payhip_fee_cents`, `net_settled_cents`) instead of assuming, and no balance is
ever credited from a purchase.

**Security model** (`services/PayhipEntitlements.js`, migration `050`):

| Requirement | Implementation |
|---|---|
| Authenticated webhook | `?token=` compared in constant time; Payhip documents no shared secret for its `signature` field, so the URL token *is* the credential and is treated as one |
| Inert by default | `PAYHIP_ENABLED` plus a non-empty product allow-list, otherwise 503 and nothing is recorded |
| Product allow-list | an unknown product is recorded as rejected and grants nothing |
| No raw licence key stored | SHA-256 only; the reconciliation payload is **redacted** before it is persisted |
| One-time claim | `redeem_payhip_entitlement_safe` row-locks, refuses a second account (`claimed_by_other_account`) and is idempotent for the same account |
| Exactly-once purchase | `payhip_sale_id` UNIQUE; a replayed webhook cannot create a second entitlement |
| Refund / chargeback | `revoked`; activation never held money, so nothing to reverse and no negative balance can be created |
| Independent re-verification | optional `PAYHIP_VERIFY_URL`/`PAYHIP_API_KEY`; a tampered amount is rejected before anything is recorded |
| Fail open on a broken store | `hasActivation` returns `null`, never `false`, so a database blip cannot lock a funded customer out |
| Sandbox separation | `MARKETING_SANDBOX` reports `liveActivated: true`; no purchase is ever needed or credited |

**Gates.** `POST /api/bot/start` (live only) and `POST /api/trade` both refuse
with `403 { code: 'LIVE_ACTIVATION_REQUIRED' }` before any session or ledger
write.

**Grandfathering.** `PAYHIP_ACTIVATION_REQUIRED` defaults to `false`. When it is
turned on, any account with a confirmed deposit is treated as activated, so
enabling it can never lock an existing funded customer out of trading.

**Frontend.** A lock notice in the Live card, an activation modal with the
checkout link and a licence-key field, and a language-switch re-render. The UI
only *reports* server state; it never decides access.

**Not done, deliberately.** No Payhip merchant application, no terms accepted,
no product created, no webhook registered, nothing enabled. Applying for a
merchant account under a description that conceals the trading-balance link
would be exactly the misrepresentation the brief prohibits.

**Open question for Payhip in writing.** Does their AUP permit selling a
software activation entitlement to customers of a crypto trading platform, where
funding is a separate deposit with a payment provider? The answer determines
whether this route can be switched on at all.

---

## 4. Q8Pay: keep the exact amount, remove the blind spot

The decimal discriminator stays. It is not decoration: it makes each payment
attributable to one invoice, and the webhook refuses to credit on any amount
mismatch. Removing it without a per-invoice reference would risk crediting the
wrong account, which is a worse outcome than an ugly number.

What was missing was **visibility**. A mismatch returned a 200, so the transfer
sat in the payout address and appeared only in a log line.

`GET /api/admin/deposits/reconciliation` (admin-only, read-only) lists:

- invoices still `pending` past a bounded window, with the exact crypto amount
  the customer was asked to send,
- deposits marked `confirmed` but never `credited` (the historical legacy path).

It writes nothing and credits nothing. Reconciliation stays a human act, but the
"they paid and got nothing" case now has a queue instead of silence.

---

## 5. Tests

| Suite | Tests | What it pins |
|---|---:|---|
| `brand_token.test.js` | 8 | one-line rename, all six locales follow, deny-list holds, `t()` works without `BRAND` |
| `live_activation_entitlement.test.js` | 25 | inert default, allow-list, constant-time token, no raw key stored, one-time claim, refund revoke, fail-open, gate ordering, no money path in the module, migration `050` shape |
| `deposit_reconciliation.test.js` | 5 | admin-gated, read-only, bounds, both silent failure modes |

**Full suite: 3236 tests, 3236 pass, 0 fail** (baseline 3198 → +38).

Six existing pins were updated for intentional changes, each keeping its intent:

- dictionary size 1605 → 1616 (11 new `liveActivation.*` keys),
- migration count 47 → 49,
- the `noreply@` sender assertion now reads the module that owns it,
- `049` is whitelisted in the "no migration reintroduces $50" guard,
- the deposit-minimum keys are exempt from the *withdrawal*-minimum leak check,
- the homepage hash re-pin (`partners_page` documents this as expected).

Rendering was verified in headless Chromium against the real page: all three
activation elements present, **zero** syntax or reference errors, no raw
placeholder in rendered markup. No headless *driver* (puppeteer) is installed in
this sandbox, so interactive click-through is not claimed.

---

## 6. Files changed

```
services/brand.js                     BRAND.source, mailDomain, emailSender
services/PayhipEntitlements.js        + redactPayload(), source swap safety
server.js                             activation gates, /api/live/*, Payhip webhook,
                                      reconciliation queue, auth/me fields
public/index.html                     BRAND block, render-time rename, activation UI,
                                      11 i18n keys x 6 locales
.env.example                          PAYHIP_* + brand notes
tests/brand_token.test.js             new
tests/live_activation_entitlement.test.js  new
tests/deposit_reconciliation.test.js  new
+ 8 existing test files (pins)
```

---

## 7. Awaiting the founder

1. **The brand name.** KALDERIX is provisional. Approving it also approves the
   domain purchase, the trademark search and the production rename — none of
   which has been started.
2. **`PLATFORM_MIN_DEPOSIT_USD=50`.** Code and migration are ready; the value is
   a business decision.
3. **Payhip merchant eligibility.** Needs a written answer from Payhip before any
   application. If the answer is no, the activation layer is already isolated and
   can be pointed at another entitlement vendor without touching trading code.
4. **Applying migrations 049 and 050.** Both are additive and change no
   behaviour on their own.

---

# Addendum — Payhip activation finalized against the documented API (2026-11-16)

Founder approved: Kalderix **as a provisional candidate only**, Payhip **Option A**
(entitlement only, never credits capital), Trunkay removed from scope, Card2Crypto
rejected, Q8Pay retained as the deposit rail. The **$50 minimum was later rejected**:
the live floor stays $100 (see `03-MIN-DEPOSIT-50.md`, now marked superseded).

## Two corrections to the previous design

**1. The webhook CAN be authenticated, and the earlier note saying otherwise was wrong.**
Payhip's Webhooks article documents the signature as `hash('sha256', $apiKey)`. The
previous implementation used only a URL token because I believed no signature existed.
That comment is gone; the signature is now mandatory and the token is optional.

The important nuance, which is why nothing is granted from a webhook: that digest is a
**constant for every payload**. It proves the sender knows the store API key. It does
not bind the body, so it cannot detect a modified amount or product.

**2. Redemption was trusting a recorded sale; it now verifies the licence itself.**
`GET https://payhip.com/api/v2/license/verify` with the product-specific
`product-secret-key` header returns the licence's own record — `enabled`,
`product_link`, `buyer_email`, `uses`, `date`. Payhip disables a key automatically on
refund, so this single call covers disabled and refunded licences too. A forged
webhook can no longer mint access because the claim is gated on that answer.

Third, smaller: an **unprovable entitlement now fails closed**. `hasActivation()`
returning `null` used to mean "activated" — a database blip would have unlocked Live
Mode for every account. It now refuses with `503 ACTIVATION_UNAVAILABLE` (retryable),
and the funded-customer guarantee is provided by ordering instead: the confirmed-deposit
branch runs first and never touches Payhip, so a Payhip outage cannot lock out a funded
account, while an unproven account is never granted.

## Access-control matrix (executed, not asserted)

`tests/live_activation_entitlement.test.js` extracts the **real**
`getLiveActivationState` from `server.js` and runs it in a VM with injected
dependencies, so the matrix is behaviour:

| Scenario | Result |
|---|---|
| New user, no activation | `403 LIVE_ACTIVATION_REQUIRED` |
| Activation, no funding | `403 LIVE_FUNDING_REQUIRED` (activation is not funding) |
| Activation + funded | allowed |
| Funded, no activation | allowed (`grandfathered-deposit`) |
| Funded + Payhip unavailable | allowed (Payhip never consulted) |
| Unfunded + entitlement store unreadable | **denied**, `503`, retryable |
| Invalid licence | denied, nothing claimed |
| Reused licence | denied by the DB row lock |
| Disabled/refunded licence | denied (`licence-disabled`) |
| Licence for another product | denied (`wrong-product`) |
| Payhip outage at redemption | denied, retryable, nothing claimed |
| Sandbox account | exempt |

`npm test` → **3250 pass / 0 fail**.

## Deliberate additions and their reasons

- **Funding presence gate** on `/api/bot/start` (live only): `live_balance > 0`. This is
  a presence check, not a reinstated minimum — the MTA removal stands, and the $50
  promotional credit still qualifies. A captured cost model for the first $50 cohort
  says to watch loss-to-deposit, not to gate it.
- **Per-account verification throttle** (10/min). A licence key is a bearer secret; the
  server must not become an enumeration oracle.
- **`license/usage` on a fresh claim**, best-effort, so the seller sees the redemption.
  The database remains authoritative for one-time use.
- **`liveActivation.retryLater`** in six locales, selected by `data.reason`, so an
  outage is never reported as "your key is invalid".

## Verification boundary, stated honestly

`payhip.com` refuses connections from this sandbox (`ERR_BLOCKED_BY_RESPONSE`), so the
licence API has **never been exercised against the live service**. Everything up to the
network boundary is tested (request shape, headers, response parsing, every failure
mode). The first real call must be made by hand before the gate is switched on —
`10-RELEASE-CHECKLIST.md` §4.2 gives the exact `curl`.
