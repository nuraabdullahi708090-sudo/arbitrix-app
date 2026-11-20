# Workstream C - Payhip: one purchase that activates AND funds Live Mode

Date: 2026-11-16
Status: **research + architecture complete. No code written, nothing activated.**
Verdict: **do not build this as specified.** Reasons below - two of them are
fatal to the commercial model, independent of any provider policy.

---

## 1. What already exists in the repo

**Nothing.** A full scan finds **zero** references to Payhip anywhere - not in
`server.js`, not in `services/`, not in `public/`, not in tests, not in docs, not
in `.env.example`. There is no licence-key table, no product-key mapping, no
Payhip webhook route, no redemption endpoint, and no "activation" concept
distinct from "deposit".

The existing provider abstraction is `services/PaymentService.js` with
registered providers `nowpayments`, `paymento`, `q8qpay`, each implementing
`services/providers/base/ProviderInterface.js`
(`createInvoice / getInvoiceStatus / verifyWebhook / cancelInvoice`). Payhip is
a *product-commerce* platform, not a crypto invoice provider: it emits
`paid / refunded / subscription.created / subscription.deleted` webhooks and its
API is product/licence oriented. It therefore does not fit that interface - it
needs its own module, not a new provider entry.

What genuinely could be reused: the atomic-crediting pattern
(`idempotency check -> FOR UPDATE -> re-check -> mutate -> ledger row ->
transaction row`) and the `payment_invoices.credited` marker. A Payhip credit
should be written the same way, in a new SECURITY DEFINER function.

## 2. Merchant eligibility - the assessment

I could reach `help.payhip.com` (their documented webhook events, restricted
products guidance) but `payhip.com` itself returned 403/Cloudflare from this
environment, so this is based on their published help pages, not on a signed
agreement. **Nothing here is legal advice and nothing has been confirmed in
writing with Payhip.**

What matters, in order of severity:

1. **The transaction is not a software sale.** As specified, the customer pays
   $50 and receives a $50 trading balance that can be traded and eventually
   withdrawn. The licence key is a delivery mechanism for value, not the product
   being sold. Presenting it to a processor as "software" is the definition of
   misdescribing the business, which the brief explicitly forbids.
2. **Payhip routes payments through Stripe and/or PayPal.** Those are the
   processors whose acceptable-use policies a merchant actually has to satisfy,
   and both restrict investment schemes, get-rich-quick products and unlicensed
   financial services. A product whose marketing shows a balance compounding
   from $100 to $300 in an hour will be classified there, not in "digital
   downloads".
3. **Payhip's restricted-products guidance names get-rich-quick schemes.** A
   package that funds a trading balance and is promoted on projected returns is
   in that category on its face.
4. **Written clarification would be required before launch** - and, given points
   1-3, the honest clarification ("we are selling funded trading balances") is
   very likely to be declined. Applying while describing it as software would
   expose the account to termination and clawback of settled funds.

**Assessment: not eligible as designed.** Also worth noting: an application
that is declined is recorded. Re-applying for a different (legitimate)
product later becomes harder.

## 3. The two commercial problems (independent of Payhip)

These are the real reason I am recommending against the build.

### 3.1 Fees make every package a loss the moment it is credited

Published Payhip pricing is a per-transaction fee (5% + $0.50) on top of the
underlying card processor (about 2.9% + $0.30). Combined, on the proposed
packages:

| Package | Price | Payhip 5% + $0.50 | Card ~2.9% + $0.30 | **Net received** | Balance credited | **Loss at credit** |
|---|---:|---:|---:|---:|---:|---:|
| Starter | $50 | $3.00 | $1.75 | **$45.25** | $50 | **-$4.75 (-9.5%)** |
| Standard | $100 | $5.50 | $3.20 | **$91.30** | $100 | **-$8.70 (-8.7%)** |
| Advanced | $250 | $13.00 | $7.55 | **$229.45** | $250 | **-$20.55 (-8.2%)** |
| Premium | $500 | $25.50 | $14.80 | **$459.70** | $500 | **-$40.30 (-8.1%)** |

You asked me not to assume a $50 purchase produces $50 of settlement. It does
not: it produces about **$45**. Crediting the full advertised $50 is therefore a
deliberate 9.5% subsidy per sale, forever, on every package.

### 3.2 Combined with a withdrawable, positively-biased balance it is unbounded

From `01-BASELINE.md`: the P&L generator has a **+0.285% expected value per
trade** at 450 trades/hour, and the resulting balance is withdrawable (subject to
the $700 minimum and one completed trade). So:

- The customer pays **$45.25** in cash.
- The platform credits **$50** of tradable balance.
- The engine grows that balance on a schedule until the $400 profit pause.
- The customer withdraws, and the platform pays out of pocket.

Each package therefore has a **negative-lifetime-value** of at least 9.5% plus
whatever the engine manufactures before the pause. A $50 Starter package can
cost the platform hundreds of dollars. Selling more packages makes it worse, not
better. **No pricing fix rescues this: the balance must not be both
inflated-by-design and withdrawable.**

This is the same conclusion as the baseline report, reached from a second
direction. It is the reason the *product model* has to be settled before any
payment rail (Payhip, Card2Crypto, or a new Q8Pay flow) is worth building.

## 4. If the model is fixed first, the eligible shape is

Choose one of these; each is a different product and only the first is close to
what was proposed.

**Option 1 - sell software, credit nothing (compliant, simplest).**
The Payhip product is a genuine software licence: a fixed term of access to the
Arbitrix strategy dashboard. The trading balance is funded **separately** through
the existing crypto deposit flow (Q8Pay), where the user's own money arrives and
is credited. This keeps "one purchase" friction down (the licence is instant) and
keeps the money leg with a provider that has already been onboarded.
- Fees: licence revenue is genuinely fee-bearing, which is fine because no balance
  is credited against it.
- The licence key activates the *software*, and deposits stay deposits.

**Option 2 - sell a subscription, not a balance.**
$X/month for access; the balance remains the customer's own deposits. This is the
existing $7 subscription model extended, and it is what most retail trading
software actually sells.

**Option 3 - sell a credit with a disclosed net amount (only if 3.2 is fixed).**
Price the package so the credited amount equals what settles: e.g. a $55 package
credits $50. That is honest, but it makes the price look arbitrary and it still
does not fix the withdrawable-RNG problem.

**Option 4 - non-withdrawable usage credit.**
The purchased balance is explicitly a *simulated/strategy* allowance: it can be
traded by the strategy and its P&L can buy additional access time, but it is not
redeemable for cash. This is the only version where crediting 100% of a fee-laden
purchase is economically coherent - and it must be disclosed in those words, and
requires removing the "withdraw the profit" promise entirely.

## 5. If it is approved anyway: the technical design (ready to implement)

Written so the engineering is not blocked once the commercial questions are
settled. All of it is server-side; the browser is never trusted.

### 5.1 Tables (migration `049_payhip_entitlements.sql`, NOT written yet)

```sql
create table public.payhip_products (
  product_key      text primary key,          -- Payhip product id / permalink
  name             text not null,
  price_cents      integer not null check (price_cents > 0),
  credit_cents     integer not null check (credit_cents >= 0),
  is_active        boolean not null default false,
  created_at       timestamptz not null default now()
);

create table public.payhip_purchases (
  id               bigint generated always as identity primary key,
  payhip_sale_id   text not null unique,       -- provider's own id: the anchor
  product_key      text not null references public.payhip_products(product_key),
  email            text,
  amount_cents     integer not null,
  currency         text not null,
  status           text not null check (status in ('paid','refunded','chargedback','voided')),
  raw_payload      jsonb not null,
  received_at      timestamptz not null default now(),
  refunded_at      timestamptz,
  refund_reason    text
);

create table public.payhip_entitlements (
  id               bigint generated always as identity primary key,
  purchase_id      bigint not null references public.payhip_purchases(id),
  licence_key_hash text not null,              -- sha256; the raw key is never stored
  user_id          bigint references public.users(id),
  claimed_at       timestamptz,
  credit_cents     integer not null default 0,
  credited_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (purchase_id)                          -- one entitlement per sale
);
```

Plus a partial unique index on `payhip_entitlements(user_id)` only if the model
allows one active entitlement per account, and REVOKE/GRANT locked to
`service_role` with RLS on (same pattern as migrations 039/045).

### 5.2 Webhook (`POST /api/webhook/payhip`)

Order of operations, non-negotiable:

1. Read the **raw bytes** (`req.rawBody` already exists for this purpose).
2. Verify the HMAC signature over those exact bytes. Reject on mismatch with
   401 - before parsing, before any DB read.
3. Resolve the product key from the payload against `payhip_products`. An unknown
   product is stored as `voided` and logged, never credited.
4. **Do not trust the webhook body for the amount or the product.** Call Payhip's
   API back for the sale and compare `amount`, `currency`, `product`, `status`.
   The webhook is a *trigger*, the API is the *evidence*.
5. Insert `payhip_purchases` with `on conflict (payhip_sale_id) do nothing`.
   If no row was inserted, it is a replay: return 200 and stop.
6. Create the entitlement row with the **hashed** licence key. Do not credit yet.
7. Return 200. Crediting happens on redemption (§5.3), never from the webhook.

`refunded` / `chargedback` / `voided` events update `payhip_purchases.status` and
flow into §5.5.

### 5.3 Redemption (`POST /api/payhip/redeem`)

- `authMiddleware`; the user id comes from the JWT, never from the body.
- Body: the licence key only.
- Hash the key, look up the entitlement. Refuse if:
  - no entitlement (unknown key) - one generic message, so keys cannot be probed;
  - `claimed_at is not null` and `user_id` is a different account - refuse
    (`entitlement_already_claimed`), which is the anti-transfer control;
  - the purchase status is not `paid`;
  - the purchase email does not match the account email, **if** email binding is
    the chosen control (see §5.4).
- Credit inside ONE Postgres function `credit_payhip_entitlement_safe`, following
  the existing pattern: idempotency check on `credited_at` ->
  `FOR UPDATE` on the wallet -> re-check -> `live_balance = live_balance +
  credit` -> ledger row -> transaction row (`type='Payhip Activation'`) ->
  `credited_at = now()`. A replay returns `duplicate: true` and credits nothing.

### 5.4 Binding the purchase to the account - preferred over manual key entry

Best option: **send the user id with the checkout** (Payhip supports pre-filled
custom fields / a passthrough parameter on the checkout URL). Then the webhook
carries the intended account and redemption can be a single click, with the
licence key as the fallback path.

Fallbacks, in order: (a) passthrough user id; (b) the purchase email must equal
the account email; (c) manual key entry. Any of them must still pass §5.3's
one-time claim check, because (a) and (b) are both client-influenced.

### 5.5 Refunds and chargebacks

This is where the brief's warning is most relevant: never silently deduct funds
and never create a negative balance without an approved policy.

| Scenario | Correct handling |
|---|---|
| Refunded **before** redemption | Mark the entitlement void. Nothing to reverse. |
| Refunded **after** credit, balance untouched | Reverse the credit from `live_balance` (down to 0, never negative), write a reversal ledger row, mark the entitlement reversed, and restrict the account to Demo until a new deposit. |
| Refunded after the balance was traded **up** | The withdrawn/realised profit was never funded by the customer. Reversing only the principal leaves the platform paying the profit. Policy needed: either treat the account as debt (requires a signed agreement, which a consumer product generally cannot enforce) or accept the loss and flag the account for review. |
| Refunded after the balance was traded **down** | `live_balance` already reflects the loss; reversing the principal is the whole point of the refund. Cap the reversal at the current balance. |
| Chargeback after trading started | Same as above plus a dispute record. Expect the processor to side with the cardholder; the platform absorbs the loss. This is precisely why a withdrawable, engine-grown balance is unviable. |
| Open positions at refund time | The platform has no positions (`record_trade_safe` realises immediately), so there is nothing to unwind. If real execution is ever added, this becomes a liquidation problem and needs its own policy. |

Non-negotiable: every reversal is a **ledger row**, never an UPDATE of history,
and the account is frozen rather than put into negative balance.

### 5.6 Reconciliation

Daily job comparing, per sale: Payhip payout report amount, `payhip_purchases`
amount, `payhip_entitlements.credit_cents`, the wallet credit and the ledger
row. Any sale that is `paid` but unclaimed for > 30 days, or claimed but not
credited, or credited without a `paid` purchase, is an alert. Store the running
`expected_net = amount - fees` so the 8-9.5% gap is visible rather than guessed.

### 5.7 Sandbox

`MARKETING_SANDBOX` users must be able to run the whole flow with no real money:
a `sandbox_payhip_purchases` table or a `is_simulated` flag, a simulated webhook
route that never verifies real signatures (and is only reachable for sandbox
accounts), and credit into `sandbox_wallets` only. The existing
`assert_sandbox_user` RPCs give the pattern. Production tables must be
unreachable from the sandbox path - already enforced by the DB backstop triggers
from migration 013.

## 6. Production deployment checklist (for the approved version only)

1. Written confirmation from Payhip AND the underlying processor, quoting the
   actual business description. Store the reply.
2. `payhip_products` seeded with `is_active = false`.
3. Webhook secret generated, stored as an env var (never in the repo), registered
   in Payhip.
4. Migration applied, function verified against real PostgreSQL, `service_role`
   only.
5. Replay test: fire the same webhook twice -> exactly one purchase row, zero
   extra credits.
6. Redemption test: two accounts, same key -> the second is refused.
7. Refund test: refund before and after credit -> correct reversal, no negative
   balance.
8. Amount-tampering test: a webhook claiming a higher amount than Payhip's API
   records -> refused.
9. Daily reconciliation job live and alerting.
10. Admin visibility: purchase list, entitlement state, credit amount, refund
    state, and a manual "reverse" that goes through §5.5.
11. Customer history: purchase date, package, amount, credited amount, status.
12. Activate `is_active` for one product only, watch the first ten sales.

## 7. Recommendation

**Do not build the Payhip activation-and-funding rail now.** Not because the
integration is hard - §5 is a day of work - but because (a) it is very likely
ineligible to be described accurately, and (b) it loses 8-9.5% at credit and then
loses again on every withdrawal, while the balance grows by design.

Sequence that actually de-risks the relaunch:

1. Fix the product claim and the P&L model (`01-BASELINE.md` §2).
2. Keep deposits on the crypto rail that is already live and already credits the
   customer's own money (Q8Pay).
3. If you want Payhip for its checkout experience, sell **software access** on
   Payhip and keep funding on Q8Pay (Option 1). That is eligible, honest, and
   needs no new licence-credit machinery.
