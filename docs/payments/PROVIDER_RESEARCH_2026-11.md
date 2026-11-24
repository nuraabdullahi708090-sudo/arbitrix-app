# Deposit provider research — November 2026

Scope: USDT (TRC20) deposits for the Kalderix relaunch at a $50 minimum.
This document answers one question: **should the deposit rail change now?**

Short answer: **no.** Keep Q8Pay. The current rail already satisfies every
security property the mission asks for, and switching or adding a provider cannot
be done safely without merchant credentials that this work does not have.

---

## 1. What the platform already does (verified in the repository)

| Property | Where | Evidence |
|---|---|---|
| One invoice per deposit, unique reference | `services/providers/q8qpay.js`, `/api/payment/create-invoice` | `createInvoice()` sends `reference` = our unique deposit ref, plus the q8qpay `invoice_id` in `metadata` |
| Exact-amount attribution | webhook handler in `server.js` | compares `invoice.amount_usd` with the re-read `amountUsdtExact`; a mismatch refuses to credit |
| Signed webhook | `services/providers/q8qpay.js` | HMAC-SHA256 of the **raw** body (`X-Webhook-Signature`), enabled by the `req.rawBody` hook |
| Re-read from the provider before crediting | webhook handler | the provider API is called again; asset / amount / address / tx are validated |
| Exactly-once credit | `credit_payment_safe()` (migration 008) | idempotency key, `FOR UPDATE` row lock, double check after the lock, `credited` marker |
| Reconciliation | `/api/admin/deposits/reconciliation` | lists stale pending invoices with the exact on-chain amount expected |
| Minimum deposit | `PLATFORM_MIN_DEPOSIT_USD` (now 50) | invoice validation, sandbox floor, `/api/auth/me` |

A second provider would add a second webhook surface, a second signature scheme
and a second reconciliation path. That is more risk, not less, for a $50 floor.

## 2. Candidates

> Superseded in part by `PROVIDER_INVESTIGATION_BCON_PAYMENTO_BTCPAY_2026-11.md`
> (Bcon Global, Paymento and BTCPay Server were read from source documentation on
> 2026-11-24; the BTCPay row below reflects that).

Everything in the "verified" column was checked from this environment on
2026-11-24; a dash means the claim could **not** be verified here and must not be
treated as true.

| Provider | Code in repo | USDT-TRC20 | Unique address / invoice | Signed webhook | Merchant onboarding | Verified here |
|---|---|---|---|---|---|---|
| **Q8Pay** (current) | Yes (white-label, default) | Yes | Per-invoice `payoutAddress` + exact amount | HMAC-SHA256 | Already onboarded | Repository + production traffic |
| NOWPayments | Yes (`services/providers/nowpayments.js`, inactive) | Yes (`USDT.TRC20`) | Per-invoice address from the API | IPN secret | Requires account + API key | Public site reachable; it lists USDT TRC20 among supported coins |
| Cryptomus | No | Documented as supported at large | Yes | Yes | Requires KYB | **Not verifiable** — docs host did not resolve |
| OxaPay | No | Documented as supported | Yes | Yes | Requires account | **Not verifiable** — doc path returned 404 |
| Plisio | No | Documented as supported | Yes | Yes | Requires account | **Not verifiable** — host did not resolve |
| BTCPay Server (self-hosted) | No | Yes, via the community USDt plugin | Yes - address pool, unique up to the pool size | HMAC-SHA256 (`BTCPay-Sig`) | Self-hosted operations | Verified 2026-11-24 - see `PROVIDER_INVESTIGATION_BCON_PAYMENTO_BTCPAY_2026-11.md` |

Consequences of the unverified column:

- No custody, fee, settlement or KYB claim about Cryptomus / OxaPay / Plisio may
  go into customer-facing copy or into a plan until someone with network access
  reads their current documentation.
- A "cheaper fee" argument cannot be made from here.

## 3. Recommendation

1. **Do not migrate the rail before launch.** Q8Pay is the only provider in this
   repository with a complete, tested path (invoice, address, polling, webhook,
   idempotent credit, reconciliation).
2. **NOWPayments is the only realistic fallback**, because its provider class is
   already registered in `PaymentService` and selected by `PAYMENT_PROVIDER`.
   Using it needs an account, `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, and
   one end-to-end test invoice in its sandbox. That is an operator task, not a
   code change.
3. **If a second rail is added later,** add it as a *failover*, never as a
   simultaneous default: the decimal-attribution mechanism (`amountUsdtExact`)
   exists to disambiguate a shared address, and running two rails doubles the
   reconciliation surface.
4. **Customer-facing copy stays provider-neutral.** The deposit dialog names
   USDT/TRC20 and the exact amount; it does not promise a provider, a fee or a
   settlement time.

## 4. What this mission did change about payments

Nothing in the money path. The only payment-adjacent changes are:

- `PLATFORM_MIN_DEPOSIT_USD`: 100 → 50 (single constant, every consumer reads it).
- `supabase/migrations/057_min_deposit_and_referral_50.sql`: syncs
  `referral_config.minimum_qualifying_deposit` to 50 so a $50 deposit also
  qualifies its referral (the SQL award helper reads that row, not the constant).
- Customer copy: the $100 figure and the mandatory-activation wording are gone
  from the landing page and the deposit dialog.

## 5. Open items for an operator

- Apply migration 057 with this deploy (otherwise a $50 deposit credits but its
  referral waits for a $100 deposit).
- If `PLATFORM_MIN_DEPOSIT_USD` is set in the host environment, it must also be
  50, or the two halves disagree (`checkMinDepositSync()` logs the mismatch at
  boot).
- Payhip activation is off unless `PAYHIP_ACTIVATION_REQUIRED=true`; the
  integration and its migrations stay in place.
