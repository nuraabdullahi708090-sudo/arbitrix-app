# Q8QPay invoice-creation errors — classification and the 409 case

Companion to `services/PaymentError.js`. Explains what each provider outcome means,
what we answer, and — specifically — why HTTP **409 Conflict** is the one 4xx that must
*not* be treated as "no invoice was created".

Evidence base: Q8QPay's public documentation (`https://q8qpay.com/docs` — Create Invoice,
Error Codes, Best Practices; read 2026-11-26) plus this repository's code. No production
invoice was created, cancelled or queried for this document; no Q8QPay credential exists
in the environment where it was written, so the 409 case could **not** be induced live.
The classification therefore rests on the documented semantic, read conservatively.

---

## 1. Client errors vs upstream failures

`POST /api/payment/create-invoice` used to answer **400** for every failure, so the
browser showed *"That amount could not be processed"* for a provider refusal, an
exhausted fee balance, a suspended key, a rate limit, a 5xx or a timeout alike.

| outcome | code | we answer | retryable | ambiguous |
|---|---|---|---|---|
| customer input (amount / currency / network) | `PAYMENT_INVALID_*` | 400 | per field | no |
| provider 400, 422, other 4xx | `PAYMENT_PROVIDER_REJECTED` | 502 | no | no |
| **provider 409** | **`PAYMENT_PROVIDER_REJECTED`** | **502** | **no** | **yes** |
| provider 401 / 403 | `PAYMENT_PROVIDER_ACCOUNT` | 503 | no | no |
| provider 429 | `PAYMENT_PROVIDER_UNAVAILABLE` | 503 | yes | no |
| provider 408 / our timeout | `PAYMENT_PROVIDER_TIMEOUT` | 503 | yes | yes |
| provider 5xx | `PAYMENT_PROVIDER_UNAVAILABLE` | 503 | yes | yes |
| network failure | `PAYMENT_PROVIDER_UNAVAILABLE` | 503 | yes | yes |
| 2xx with an unusable body | `PAYMENT_PROVIDER_INVALID_RESPONSE` | 502 | yes | yes |
| anything else | `PAYMENT_INTERNAL_ERROR` | 500 | yes | yes |

`ambiguous: true` means *an invoice may exist at the provider*. Only `ambiguous: false`
lets `PaymentService.handleProviderCreateFailure()` mark the local `payment_invoices`
row `failed`.

## 2. What 409 means at Q8QPay

Verbatim from the docs' error-code table:

> **409** — Conflict — Duplicate reference

and, from Best Practices:

> **Use Idempotent References** — Use unique, meaningful references (like order IDs) to
> prevent duplicate invoices and enable easy reconciliation.

and the Create Invoice parameter:

> **`reference`** (optional) — Unique order reference (max 50 chars). Auto-generated if
> not provided.

So a 409 says *"an invoice with this reference already exists"*. It does **not** say
"nothing exists". The two statements are opposite:

* 400 / 422 → the provider examined the parameters and refused them; no invoice exists
  under our reference. Marking the row `failed` is truthful and safe.
* 409 → **an invoice exists under our reference**; only *this* call created nothing.

### Q: can a repeated POST with the same `orderId` create or return an existing invoice?

Documented behaviour: a duplicate `reference` does **not** create a second invoice — it is
refused with 409. Whether the 409 response body carries the existing invoice's details is
**not documented** (the docs describe only "Conflict — Duplicate reference"), and our
provider discards non-2xx bodies, so we cannot read them today. What we do know is that
an invoice for that reference exists.

### Q: could 409 arrive after a successful creation?

Within a single call, no: 409 means *this* call did not create anything. But it means a
**previous** attempt with the same reference did — the classic "the first request
succeeded, we never saw the answer, the retry was refused" sequence. Today our code
generates a fresh reference per call (`PaymentService.generateInvoiceId()` =
`ARB_<base36 timestamp>_<16 hex random>`), and never retries with the same one, so a 409
is improbable *right now*. It becomes real the moment a retry, queue, replay or
re-drive reuses the reference — which is precisely what the provider recommends doing.

### Q: would marking the row `failed` prevent a legitimate payment from settling?

Partly, and the part that survives is the part that matters. A **confirmed webhook still
settles** a `failed` row: `services/q8qpaySettlement.js` gates on `credited` and on the
provider invoice id, not on our status, and the webhook handler takes the provider UUID
from the payload. But every *recovery* path refuses the row:

| path | behaviour with a `failed` row |
|---|---|
| confirmed webhook (arrives) | settles — the only path that still works |
| confirmed webhook **lost** → admin confirm (`POST /api/admin/payments/:invoiceId/confirm`) | `400 Already failed` (`server.js` — `if (invoice.status !== 'pending')`) |
| customer "refresh status" (`POST /api/payment/check/:invoiceId`) | needs `provider_invoice_ref`, which is **NULL** after a 409 (we never got the id) → settlement returns `UNVERIFIABLE` |
| admin reconciliation view | `isUnsettled()` = `pending` or `expired` → a `failed` row is **invisible** |

So a lost webhook on a 409 invoice would be unrecoverable through any in-app tool, while
the provider holds a real, payable invoice under our reference. That is the concrete
reason 409 is classified `ambiguous: true` and never marks the row failed.

### Why `retryable: false`

The customer sees the honest "payment service temporarily unavailable" message with the
Support Center, but **no "Try again"** button. A retry would generate a *new* reference
and therefore a **second** payable invoice, while the first one stays invisible to the
customer and to us (no address was ever displayed). One unseen invoice is recoverable
with support; two is a split payment.

## 3. Not implemented (possible follow-ups, each needs approval)

1. **Recover the existing invoice on 409.** If the provider's 409 body (or a `GET
   /api/v1/invoices` lookup by reference) exposes the duplicate's id and payout address,
   we could adopt it: store `provider_invoice_ref` + address on the existing row and show
   the payment screen instead of an error. Requires knowing the exact 409 body — only
   obtainable with a Q8Pay credential.
2. **Ask Q8Pay support** whether the 409 body carries the existing invoice, and whether a
   duplicate reference can ever be returned for a reference the merchant did not use.
3. **Reconciliation visibility.** Consider including `failed` rows that still have a
   provider reference in the operator view (display only).

## 4. Bookkeeping must never mask the provider error

`handleProviderCreateFailure()` performs one write (mark the row `failed`). supabase-js
normally *resolves* with `{ error }`, but it can also **throw** (no client configured, a
transport failure inside the library). That write is bookkeeping: both outcomes are
logged (`invoice_mark_failed_error`, with `dbThrown: true|false`) and swallowed, so the
caller still reports the provider error. Without this, a database hiccup during cleanup
would turn a provider refusal into an internal 500 and undo the classification.
