# Q8QPay settlement audit — why a paid deposit was not credited

Status: code change prepared, **not deployed**. No production data or configuration was
touched by this work. Everything below distinguishes what is *proven from the code* from
what *requires production data* to confirm.

---

## 1. How a deposit is supposed to settle

1. The customer presses **Generate Payment**. `POST /api/payment/create-invoice` asks
   q8qpay for an invoice and stores a row in `payment_invoices`
   (`invoice_id` = our reference, `provider_invoice_ref` = q8qpay's id,
   `amount_crypto` = the exact USDT amount quoted, `wallet_address` = the payout address,
   `status='pending'`, `credited=false`).
2. The customer sends USDT on TRON (TRC20) to that address, for exactly that amount.
   q8qpay attributes the transfer by `(address, amount)`.
3. q8qpay confirms and POSTs to `Q8QPAY_CALLBACK_URL`, signed with
   `X-Webhook-Signature` (HMAC-SHA256).
4. `POST /api/webhook/q8qpay` verifies the signature, re-reads the invoice **from
   q8qpay**, compares amount / asset / address / reference, and credits through
   `credit_payment_safe()` (idempotent, row-locked) exactly once.
5. The dashboard polls `POST /api/payment/check/:invoiceId` and shows "credited".

## 2. Where it can break — enumerated, not guessed

| # | Failure | Before this change | Customer saw | Evidence available |
|---|---------|--------------------|--------------|--------------------|
| 1 | Webhook URL is not the one registered in the q8qpay dashboard | nothing happened, nothing written | "waiting for payment" for ever | **none** — no row anywhere |
| 2 | Signature verified but the payload used field names our parser did not read | lookup by `undefined` → "no invoice" | same | none |
| 3 | Amount comparison used `amount_usd` (50) instead of `amount_crypto` (50.0051) | settlement refused as a mismatch | same | none |
| 4 | Transient failure (DB, provider 5xx) | answered **200** | same | none |
| 5 | Customer closed the tab before the invoice confirmed | polling stopped; webhook still worked | "pending" | none |

Common trait of rows 1–4: **the money moved, and the platform kept no record of having
tried**. That is what made the incident unexplainable from inside the app.

## 3. What changed

* **Every delivery is now recorded.** `recordQ8qpayWebhookEvent()` writes
  `public.webhook_logs` (provider `q8qpay`) in **every** branch — invalid signature is
  the single exception, because an unauthenticated request must not be able to grow the
  table. Rows carry the parsed payload, the HMAC hash (never the signature), the derived
  idempotency key, the outcome, the reason, the expected vs confirmed amount, the
  provider status, the tx hash and the invoice/user ids.
* **One settlement path.** `services/q8qpaySettlement.js` is called by the webhook *and*
  by the customer's "Refresh status". It re-reads the invoice from q8qpay and returns a
  named outcome (`credited`, `already_credited`, `duplicate`, `unknown_invoice`,
  `reference_mismatch`, `asset_mismatch`, `amount_mismatch`, `address_mismatch`,
  `missing_stored_amount`, `missing_tx_hash`, `provider_not_confirmed`, `verify_failed`,
  `credit_failed`, `unverifiable`).
* **Honest HTTP semantics.** `credited`/`duplicate`/`already_credited` and every
  permanent validation failure answer `200` (a retry could not change the outcome);
  `provider_not_confirmed`, `verify_failed`, `missing_tx_hash` and `credit_failed`
  answer `500` so q8qpay retries — `credit_payment_safe` is idempotent, so a retry
  cannot double-credit.
* **Parser tolerance.** `parsePaymentData()` now reads the documented snake_case fields
  *and* camelCase aliases, and falls back to our own `metadata.arbitrixDepositRef`, so a
  payload shape change cannot silently become "unknown invoice".
* **Customer recovery.** `POST /api/payment/check/:invoiceId` asks q8qpay directly when
  the stored invoice is still unsettled. A payment whose webhook never arrived is
  therefore credited the moment the customer presses Refresh — no support ticket.
* **Admin visibility.** `GET /api/admin/deposits/reconciliation` lists stale invoices,
  invoices we marked confirmed but never credited, and recorded webhook failures; with
  `?verify=1` it also asks q8qpay for the live status of each unsettled q8qpay invoice
  and diagnoses `paid_but_uncredited`, `confirmed_amount_mismatch`, `provider_pending`,
  … The endpoint stays strictly read-only, and the admin panel now renders these rows.

## 4. What only production data can tell us

This environment cannot reach the production database (the Supabase host does not
resolve and no DB credential exists here), so the specific cause of the reported
incident is **not** claimed. These are the queries that answer it. All are read-only.

```sql
-- A. Did q8qpay ever call us for anything?
SELECT status, result->>'outcome' AS outcome, count(*)
FROM public.webhook_logs WHERE provider = 'q8qpay'
GROUP BY 1, 2 ORDER BY 3 DESC;
-- Zero rows for the incident date, and no row in B, means we were never called
-- (failure class 1: URL/registration). That is a q8qpay-dashboard problem.

-- B. The invoice itself.
SELECT id, invoice_id, user_id, amount_usd, amount_crypto, status, credited,
       provider_invoice_ref, provider_tx_hash, wallet_address, created_at, updated_at
FROM public.payment_invoices
WHERE invoice_id = '<the ARB_ reference from the customer''s confirmation>';

-- C. Was the money credited at all?
SELECT * FROM public.transactions
WHERE transaction_hash = '<tx hash from the customer>';

-- D. Registered callback URL (ask q8qpay support / dashboard, or compare with
--    the value your deployment sends):
--    echo "$Q8QPAY_CALLBACK_URL"   (in the Render shell)
```

Interpretation:

* **B shows `credited=false`, A shows no row, C shows nothing** → we were never called.
  Check the registered callback URL and the webhook secret in the q8qpay dashboard.
* **B shows `credited=false`, A shows a row with `amount_mismatch`** → the address-reuse
  discriminator bit us: the payment amount differs from `amount_crypto`. Recoverable
  through the normal path once q8qpay confirms.
* **B shows `credited=true`, C shows a `Deposit` row** → the money was credited and the
  customer was looking at the wrong wallet view.
* **B shows `status='confirmed'`, `credited=false`** → the settlement ran but the credit
  did not. Press "Verify with provider" in Admin → Deposits, then settle through the
  normal path.

## 5. Is auto-settlement reliable now?

The failure *classes* that made it unreliable are closed:

* a silent 200 on a transient failure → now 500 (provider retries);
* an unparseable payload → now tolerant, and the raw body is recorded;
* a wrong amount basis → compared against `amount_crypto`, which is what q8qpay quotes;
* no trace of a failed settlement → every outcome is durable;
* a lost webhook → the customer's own Refresh recovers it, and the admin view names it.

What remains outside our control: q8qpay delivering to the URL configured in **their**
dashboard. Nothing in this codebase can verify that value — it has to be compared by
hand (the checklist is in §4 D and in `.env.example`).

Residual risk worth stating plainly: the address-reuse discriminator means the amount a
customer must send is not always a round number and is not identical to the amount they
typed. The payment screen already displays the exact `amountUsdtExact` and copies that
exact string, which is why the mismatch class has not been frequent — but a customer who
rounds the number manually will produce a mismatch that needs manual review.

## 6. Operational checklist

1. Confirm `Q8QPAY_CALLBACK_URL` equals the URL registered in the q8qpay dashboard
   (scheme, host, path — no trailing slash difference).
2. Confirm `BASE_URL` is the public origin, so the fallback callback is reachable.
3. After deploy, check `GET /api/admin/payments/webhook-logs` after the next real
   payment: there must be a row per delivery attempt.
4. For any reported "not credited" payment, run §4 A–C before touching anything.
5. Do **not** manually credit without the tx hash: `credit_payment_safe` is keyed on it,
   and a manual credit outside the provider path can double-pay.

No migration is required by this change. It uses `payment_invoices` (existing),
`webhook_logs` (existing) and `credit_payment_safe` (existing, migration 008).
