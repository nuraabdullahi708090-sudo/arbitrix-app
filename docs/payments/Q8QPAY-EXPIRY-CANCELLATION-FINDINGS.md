# Q8QPay invoice expiry & cancellation — findings and recommendations

Status: **investigation only.** Nothing described in "Recommendations" is implemented.
No production invoice was created, cancelled or queried for this document; the
provider behaviour below is taken from Q8QPay's public documentation (q8qpay.com/docs,
/pricing, /faq, read 2026-11-26) and from this repository's code.

---

## 1. What the provider documents

| Question | Documented answer |
|---|---|
| Which invoices can be cancelled? | "Cancel a pending invoice. **Only invoices with `pending` status can be cancelled.**" (`POST /api/v1/invoices/:id/cancel`) |
| Does a cancellation notify us? | "Cancelling an invoice will trigger a webhook notification with `status cancelled` if a callback URL is configured." |
| Does expiry exist? | Yes. `expirySeconds` is a create-invoice parameter, **300–7200 s, default 1800 s**. After expiry the invoice is `expired` and "No payment before expiry". |
| Does an amount stay reserved after expire/cancel? | Yes: "When an invoice expires or is cancelled, its amount stays reserved for **24 hours**, so a customer who pays late cannot confirm a newer invoice by mistake." |
| Does a cancel/expire release the prepaid fee reserve? | Yes, stated on the pricing page: "When you create an invoice, the estimated fee is reserved from your balance… **If the invoice expires or is cancelled, the reserved fee is released** back to your available balance." |
| What if money arrives that matches no open invoice? | "If a payment arrives that matches no invoice exactly but is close to one of yours, we **email you** the closest invoices. Nothing is confirmed automatically; you check the transaction and confirm it from the invoice page." |

Two of those answers matter for design:

* **Fee reserve.** The 0.5 % fee is reserved at creation and released on expiry or
  cancellation. Abandoned invoices therefore hold balance for up to 30 minutes by
  default — the same balance whose exhaustion produces the "cannot create invoices"
  refusal investigated earlier. Cancelling early gives that balance back sooner.
* **24-hour amount reservation.** Even after a cancel, the amount stays reserved at the
  provider. A customer who pays the old exact amount an hour later cannot confirm a
  newer invoice by accident, but the newest invoice will have a *different* exact
  amount (the provider's unique-amount adjustment), so a stale page can only ever pay
  the stale invoice.

## 2. Can an invoice be cancelled after a payment has been initiated?

**No documented protection, so: do not do it.** The provider's only gate is the invoice
status (`pending`). A TRC20 transfer that has been broadcast but is not yet confirmed
leaves the invoice `pending` at Q8QPay, so a cancel request would be accepted while the
money is in flight. The documentation does not say what happens to that transfer: the
safest reading is that it becomes an unmatched payment — the invoice amount is reserved
for 24 h, so it may still match, and otherwise the merchant is emailed for manual
reconciliation. Either outcome is worse than leaving the invoice alone.

**Recommendation:** never cancel an invoice that has *any* sign of activity — a webhook
of any status received for it, a non-`pending` provider status, or a confirmed payment.
Check the provider status immediately before cancelling, not just the local row.

## 3. What this repository does today

Two cancellation endpoints exist and they behave differently:

| Endpoint | Used by the UI? | Ownership check | Provider called? | Status guard |
|---|---|---|---|---|
| `POST /api/payment/cancel/:invoiceId` (server.js:5256 → `PaymentService.cancelInvoice`) | **Yes** — the deposit modal's Cancel button | Yes (`invoice_id` **and** `user_id`) | **No** | local `status === 'pending'` |
| `POST /api/q8qpay/cancel/:invoiceId` (server.js:7343) | No callers in the app | Yes (`invoice_id` **and** `user_id`) | Yes, best-effort (`q8qpayProvider.cancelInvoice`, failure only logged) | local `status === 'pending'` |

So the customer-facing Cancel marks **our** row cancelled and leaves the Q8Pay invoice
running: its fee reserve and its amount reservation stay held until the provider's own
expiry, and the invoice can still be paid.

### What happens if a locally cancelled invoice is paid anyway?

`services/q8qpaySettlement.js` has **no `cancelled` guard**: `settle()` refuses only
already-credited rows and rows without a provider reference, then trusts the provider's
`confirmed` status plus the amount/address/tx-hash checks. If Q8Pay still confirms the
payment, the customer is credited normally (money in, money credited — correct). If the
provider refuses after a cancel, the transfer needs manual reconciliation — and the
reconciliation view (`isUnsettled` = `pending` **or** `expired`) does not list
`cancelled` rows, so it would be invisible to an operator.

### Can the frontend tell "abandon" from "close the modal"?

**No.** Closing the deposit modal calls `resetDepositModal()`, which drops
`currentInvoiceId`; the invoice is then orphaned locally and simply expires at the
provider. The only cancel path is the explicit Cancel button, behind a confirmation
dialog. There is no inactivity or navigation signal, and no "I won't pay this" action.

## 4. Can an explicit expiry be supplied?

Yes, safely. `expirySeconds` accepts 300–7200 s (default 1800). We currently send **no**
expiry and then overwrite our own `expires_at` with the provider's `expiresAt` from the
response, so the row and the countdown always agree with the provider. Sending
`expirySeconds` explicitly would not change correctness (the response still governs);
it would make the window a documented, configurable decision instead of a provider
default that could change.

## 5. Recommendations (for approval; NOT implemented)

Ordered by risk. Each is independent.

**P1 — Make the UI's Cancel actually cancel (low risk).**
Route `/api/payment/cancel/:invoiceId` through the same provider-aware path as
`/api/q8qpay/cancel/:invoiceId` (one implementation, provider called best-effort, local
row updated afterwards), keeping the ownership check, the `pending`-only guard and the
`cancelled_at` write. Effect: the fee reserve is released when the customer cancels, and
the invoice cannot be paid. Risk: a cancel racing an in-flight transfer (see §2) — so
gate it on "no provider activity" (P4).

**P2 — Send `expirySeconds` explicitly (low risk).**
Pick a value in 300–7200 (1800 preserves today's behaviour), configurable via env, and
keep overwriting `expires_at` from the response. No behaviour change beyond making the
window explicit.

**P3 — Offer an explicit "I won't pay this" action (medium).**
Only an explicit user action may cancel — never modal close, never `beforeunload`,
never a timer alone. Closing the modal must stay a no-op: a customer may close it to
open their wallet and come back.

**P4 — Never cancel with activity (required for P1/P3).**
Before cancelling: re-read the provider invoice; refuse if its status is not `pending`,
if any webhook was recorded for it, or if the local row is not `pending`.

**P5 — Make cancelled payments visible (low risk, display only).**
Add cancelled-but-uncredited invoices to the admin reconciliation query so an operator
sees the ones that could still be paid. No crediting logic changes.

**P6 — Do not auto-cancel on modal close (decision).**
The balance pressure that motivates cancellation is bounded (fee reserve is 0.5 % of the
amount, released within 30 min by default), while the cost of cancelling a live invoice
is a manual reconciliation. The trade is not worth automating.

## 6. Open questions for Q8QPay (support)

1. After a cancel, what happens to a transfer already broadcast for that invoice — is it
   matched, and is the merchant notified?
2. Is the fee reserve released immediately on cancel, or on the next balance sweep?
3. Can a `pending` invoice be cancelled while a matching transfer is unconfirmed, and is
   there an API field exposing "payment seen, unconfirmed"?

Until (1) and (3) are answered, P3 stays unimplemented and cancellation remains an
explicit, provider-checked, user-initiated action only.
