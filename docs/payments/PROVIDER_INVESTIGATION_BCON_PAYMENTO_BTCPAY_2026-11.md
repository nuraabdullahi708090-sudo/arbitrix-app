# Deposit provider investigation - Bcon Global, Paymento, BTCPay Server

Investigated 2026-11-24 for the Kalderix relaunch ($50 minimum deposit).
Companion to `docs/payments/PROVIDER_RESEARCH_2026-11.md`, which recommended
keeping Q8Pay.

**Question that decides everything:** can the provider give a *genuinely
different* USDT-TRC20 receiving address to every invoice, so that two customers
can each send **exactly 50.00 USDT** at the same time and both are attributed
correctly - without relying on altered decimal amounts?

## Verdict

| | Bcon Global | Paymento | BTCPay Server + USDt plugin |
|---|---|---|---|
| USDT-TRC20 supported | **Yes** (live, verified) | **Yes**, but only via wallet-connect | **Yes**, via community plugin |
| Unique address per invoice on TRC20 | **No** - one wallet, amounts differ; a wallet pool defers it | n/a - attribution is by payment token, not address | **Yes**, but only up to the configured address pool |
| Two customers, exactly 50 USDT each, different addresses | **Only up to the pool size**, then 50.00 / 50.01 | Yes (no address shown at all) | **Yes up to the pool**, then invoice creation fails |
| Plain address + QR checkout for TRC20 | **Yes** | **No** - customer must connect a wallet | **Yes** |
| Callback authentication | Shared secret in the URL | HMAC-SHA256 over the raw body | HMAC-SHA256 (`BTCPay-Sig`) |
| Cost | 1% prepaid | 0.5% (+$0.20 if Embedded Wallet) | 0% to the software; infrastructure + network fees |
| Operations | Account, wallet(s), prepay | Account, xpub/address | Self-host BTCPay, TRON RPC, N addresses + keys, sweeping |
| Verdict | **Fails the decisive test** | **Fails the TRC20 checkout test** | **Passes the decisive test, at an infrastructure cost** |

Nothing here is a drop-in replacement for Q8Pay today, and no provider is
recommended for immediate cutover.

---

## 1. Method, and what could not be done

- Documentation was read from the providers' own sites on 2026-11-24. Every quote
  below is verbatim.
- Two endpoints were probed **unauthenticated** (no credentials, no money):
  - `POST https://external-api.bcon.global/api/v2/address` -> `401
    {"errorMessage":"Store or user api key is undefined"}` - the endpoint exists
    and is key-gated.
  - `GET https://external-api.bcon.global/api/v1/currencies` -> `200`, public, and
    lists `{"name":"USDT","chain":"tron","network":"trc-20"}` (id 19), plus USDC
    and TUSD on trc-20. TRC20 support is real, not marketing.
- **No sandbox end-to-end test was possible.** Creating a real invoice needs a
  merchant API key for each provider and this environment has none. Bcon does
  publish a test facility (`POST /api/v1/test` - "test the flow of receiving a
  transaction without spending real money"), which is the right way to close that
  gap once an account exists.
- The API keys printed in Bcon's documentation were **not** used. They belong to
  someone's account; using them would be unauthorised access.
- `bconglobal.com` is an unrelated asset-management firm. `bcon.global` is the
  gateway. The name collides - do not confuse the two in due diligence.

---

## 2. Bcon Global

Non-custodial gateway: the customer pays **straight into a wallet you control**,
Bcon only watches the chain and calls back. Site: `https://bcon.global`,
API base `https://external-api.bcon.global`.

### 2.1 The API

`POST /api/v2/address`, `Authorization: Bearer <store api key>`:

```json
{ "payment_currency": "USDT", "origin_amount": "50", "origin_currency": "USD",
  "payment_amount": "50", "external_id": "A1001", "chain": "tron" }
```

Response: `{"status":"Ok","data":{"address":"...","payment_amount":"15.00403608","payment_currency":"usdc"}}`.

- `payment_amount` is optional and, when given, **overrides the fiat conversion**
  - the docs' own example is `"payment_amount" => "50", "chain" => "tron"`
  ("Invoice will be EXACTLY 0.01 BTC" in their BTC variant).
- `external_id` is the tracking reference returned in the callback, and it is
  constrained: **"Must be unique per store. Max length 8 characters."** Our
  current deposit refs are longer; a Bcon integration would need an 8-character
  reference (or a mapping table).
- `chain` is one of `bitcoin | ethereum | binance | solana | tron`, each with its
  own API key.
- Other endpoints: `GET /api/v1/currencies` (public), `/api/v1/currencies/{coin}?currency=usd`
  (rate), `/api/v1/stores`, `/api/v1/user/history`, `/api/v1/transactions/{txid}`,
  `POST /api/v1/test`.

### 2.2 The decisive answer: no unique TRC20 address

From Bcon's own integration guide ("How to Start Accepting Crypto Payments with
the Bcon 'New Address' API"):

> **"Ethereum, BSC (EVM chains) and Tron, Solana - EVM chains and tron, solana do
> NOT use xpub."**

> **Option 1 - One Wallet for Multiple Invoices** - "All customers send payments
> to the same wallet address. If multiple invoices with the same amount are
> created at the same time, the system cannot determine which invoice the payment
> belongs to. [...] The system automatically adjusts the amount for additional
> invoices by adding small decimal values. Example: Invoice #101 -> 100.00 USDT,
> Invoice #102 -> 100.01 USDT, Invoice #103 -> 100.02 USDT [...] The customer must
> send the exact amount shown in the invoice. If the customer sends less, more, or
> a rounded amount, the system may not be able to immediately determine which
> invoice was paid."

> **Option 2 - Multiple Wallets (Recommended)** - "Each new invoice is assigned to
> the next available wallet in rotation. [...] What happens if there are more
> invoices than wallets [...] Once all wallets are occupied, the system starts
> reusing addresses. At that point, the unique decimal amount mechanism from
> Option 1 is automatically enabled for invoices sharing the same wallet."

> **Example 3 - Two EVM Invoices Same Amount** - "Invoice 1 -> 50.00 USDT, Invoice
> 2 -> 50.01 USDT. Customer must send exact value."

> **Summary** - Bitcoin: "uses xpub [...] Generates unique address per invoice [...]
> Perfect identification". EVM: **"One wallet address / Amount differentiation
> used / Exact payment required."**

So Bcon's `POST /api/v2/address` returns a *tracking address* from the configured
wallet set, not a freshly derived address. On TRC20 the uniqueness comes from the
amount, exactly as with Q8Pay.

**Two customers, 50 USDT each, different addresses:**

- With **one** wallet configured (the simplest setup): impossible. The second
  invoice becomes 50.01 USDT, and the wallet page must show a different total.
- With **N** wallets configured: possible for up to N *simultaneously open*
  invoices; the (N+1)-th gets a reused address with an adjusted amount.

That is not a fix for the attribution problem - it is the same mechanism with a
pool in front of it. Anyone sending a rounded 50.00 to a wallet that already has
another live 50.00 invoice lands in "may not be able to immediately determine".

### 2.3 Conversion, expiry, under/overpayment, confirmations

- **Conversion**: `origin_amount` + `origin_currency` -> provider rate (they name
  coingecko). `payment_amount` pins the crypto amount and disables conversion.
- **Expiry**: not documented. The guide only mentions "the payment time expires"
  and that the system then releases the wallet. There is no expiry parameter and
  no expiry field in the callback - an integration would have to expire invoices
  on its own clock and stop trusting the invoice after that.
- **Under/overpayment**: no tolerance, no partial state. One `value` in the
  callback; if it differs from what was asked, attribution "may not" work. The
  merchant must decide.
- **Confirmations**: `status` - `0 unconfirmed`, `1 partially_confirmed`,
  `2 confirmed` ("confirmed (2 confirmations)"). Two confirmations, fixed.
- **Callback**: HTTP POST (their guide shows JSON `{status, addr, value, txid,
  external_id}`; the older v1 doc shows query parameters `?status=&addr=&value=&txid=&external_id=`).
  `value` is in the chain's smallest unit - "For EVM chains (Ethereum, BSC,
  Tron), the value follows the blockchain's native smallest unit rules" (6
  decimals for USDT).
- **Callback authentication**: **a static secret embedded in your callback URL**
  (`https://yourstore.com/callback&secret=...`), per the v1 sample code
  (`if ($_GET['secret'] != $secret) return;`). There is **no HMAC signature over
  the body**. Anyone who learns the URL can post a fake "confirmed" callback, so
  the receiver must **re-query `/api/v1/transactions/{txid}` and verify on-chain
  independently** before crediting. That is a build cost, not a blocker, but it
  is strictly weaker than what Q8Pay gives us today.

### 2.4 Fees, eligibility, settlement

- **1% per processed transaction**, charged from a **prepaid balance** you fund
  separately; the balance may go negative and access is limited after that. First
  5 transactions are free.
- **Signup is an email address**; the site markets "no KYC or KYB". See section 6 - that
  is a statement about *their* onboarding, not about our obligations.
- **Settlement**: there is none, by design. Funds arrive in your wallet; Bcon never
  holds them.
- **Restricted**: "We do not serve customers from russia. If your business is
  located in russia or your server has a russian IP address, all traffic to our
  API will be automatically blocked."

### 2.5 What a Bcon integration would require

1. Merchant account + prepaid balance.
2. Commitment to a **wallet pool** (N TRON addresses) if we want a real chance of
   distinct addresses - the same key-management and sweeping work as BTCPay,
   plus a provider in the middle.
3. An 8-character `external_id` scheme.
4. Our own expiry clock, our own underpayment policy.
5. Independent on-chain verification of every callback (`/api/v1/transactions/{txid}`)
   because the callback is not signed.

---

## 3. Paymento

Docs: `https://docs.paymento.io` (GitBook; markdown at `.md`, index at `llms.txt`).
The repo already contains a Paymento provider (`services/providers/paymento.js`,
HMAC webhook, hosted-checkout redirect) from an earlier phase.

### 3.1 The TRC20 blocker

From "Supported Networks and Assets":

> "| Tron and TRC-20 tokens | Connected wallet required | Connected wallet currently required |"

> "**Tron and TRC-20 payments, including USDT-TRC20, currently require a connected
> wallet under both wallet methods.**"

> "Plain address-and-QR checkout is not currently available for Embedded Wallet
> payments on Tron. This is a limitation of Tron blockchain for settlement
> implementation in an efficient way, not a merchant-configurable setting."

> "USDT-ERC20 | Ethereum | Address and QR code ... USDT-TRC20 | Tron | Connected
> wallet currently required"

Our customers pay from an exchange or an ordinary wallet; asking them to connect
a wallet to a checkout page is a different product, and it breaks the current
deposit UX (address + QR + "send exactly X"). On the one network we need,
Paymento is **worse** than Q8Pay.

### 3.2 What Paymento does well

- `POST /v1/payment/request` -> `{success, message, body:<token>}` -> hosted
  checkout. Attribution is by **token**, so no address ambiguity and no decimal
  dust in principle.
- Statuses: `PartialPaid (2)`, `WaitingToConfirm (3)`, `Timeout (4)`, `Paid (7)`,
  plus `Initialize/Pending/Approve`. Underpayment is a first-class state, and
  per-store tolerance is configurable.
- `X-HMAC-SHA256-Signature`: "Uppercase hex HMAC-SHA256 of the raw body [...]
  constant-time comparison. Reject the callback (401) if the header is missing or
  does not match." Plus a `payment/verify` endpoint and per-asset
  `requiredConfirmations` ("Never hardcode a number").
- Fees: 0.5% per successful payment, no monthly fee, no settlement (BYOW);
  Embedded Wallet adds $0.20/payment and requires settlement.
- Token expiry: configurable, default 24 h.
- Merchant onboarding: account + email verification, BYOW needs an xpub (UTXO) or
  a public address (account chains). No KYC/KYB is documented for merchants -
  same caveat as section 6.

### 3.3 Verdict

Excellent API, wrong network for our checkout. It would be the first choice if we
moved the deposit rail to **USDT-ERC20 or USDT-SPL**, where address + QR works and
the same API applies. It cannot serve the TRC20 flow we run today.

---

## 4. BTCPay Server + the USDt plugin

BTCPay is self-hosted open-source invoicing. Core supports Bitcoin/Lightning and
several altcoins; the docs' Altcoins FAQ now lists "**USDt (Tether) on Tron via
plugin**". The plugin is `btcpayserver-tether/BTCPayServer.Plugins.USDt`
(MIT, 39 stars, last push 2026-11-10) and its README says:

> "Generate invoices with blockchain addresses as payment reception."
> "Blockchain Monitoring: scan supported blockchains to detect payments in full,
> overpaid, or partial amounts."
> "USDt invoice destinations remain reserved and monitored after invoice
> expiration."

### 4.1 Address model - unique, but pool-bounded

The plugin's TRON payment-method model is an **address pool**, not derivation
(`EditTronUSDtPaymentMethodViewModel`: `Addresses[]` each with `Available` and
`Balance`; the settings chooser calls `GetOneNotReservedAddress(...)`). The
plugin's own tests pin the behaviour: while an address is used by an invoice in
`New` state it is skipped, and when every address is reserved the call returns
**null** - i.e. no invoice can be created for that payment method.

Consequences for us:

- Every invoice gets a **real, distinct TRON address** and an exact amount - no
  decimal dust, ever.
- Two customers can each pay exactly 50.00 USDT to different addresses **as long
  as the pool has a free address**.
- Beyond the pool size the system **fails closed** (no invoice) instead of
  silently reusing an address with a tweaked amount. That is the property Q8Pay
  and Bcon do not have.
- We would own the keys: N TRON addresses, a TRON RPC provider (the docs warn the
  public node is "for demonstration and testing only"), and a sweeping/consolidation
  routine (network fees), plus a BTCPay instance to operate and upgrade.

### 4.2 Callback and states

- Webhooks are signed: `BTCPay-Sig: sha256=<hex HMAC-SHA256 of the body>`
  (verified in `WebhookSender.cs`), using a per-webhook secret.
- `InvoiceStatus`: `New, Processing, Expired, Invalid, Settled`.
  `InvoiceAdditionalStatus`: `PaidLate, PaidPartial, PaidOver, Marked, Invalid`.
  Underpayment, overpayment and late payment are explicit, unlike Bcon.
- Existing BTCPay features we would inherit: invoice expiry, refunds/credit notes,
  per-store confirmation targets, Greenfield API keys with scoped permissions.

### 4.3 Cost and risk

- No processing fee. Costs are hosting, TRON RPC (e.g. TronGrid with an API key),
  energy for sweeps, and **engineering/maintenance** of the instance and the
  plugin (community-maintained, one active maintainer, 2 open issues - a real
  dependency risk for a payment path).
- It is the only option here that meets the "unique address, exact amount" bar on
  TRC20 without adding a custodian.

---

## 5. Compatibility with the existing Q8Pay integration

The app has one abstraction: `services/providers/base/ProviderInterface.js`,
registered by `paymentService.registerProvider(name, instance)` and selected by
`PAYMENT_PROVIDER`. Crediting is provider-agnostic (`credit_payment_safe()` with
an idempotency key), and the webhook route is `/api/webhook/:provider` with the
dedicated handlers registered before/after it (see AGENTS.md - the generic route
shadows later ones).

| | Fits the interface? | Notes |
|---|---|---|
| Bcon | Yes, as a new `bcon` provider | Address+amount+QR maps onto our existing UI better than Q8Pay's white-label invoice. But the provider must implement its own on-chain verification and its own expiry; and the whole point (unique address) is not delivered. |
| Paymento | Already implemented (`services/providers/paymento.js`) | Re-enabling is the cheapest code path of the three. Blocked by TRC20 wallet-connect, not by code. |
| BTCPay | Yes, as a new provider (Greenfield API) | Needs a hosting decision and key/address management outside the app. The invoice amount is exact, and attribution comes from the invoice id plus the distinct address. |

None of them should be wired into production routing yet: Q8Pay stays the default
(`PAYMENT_PROVIDER` unchanged) until one candidate passes an end-to-end test with
real credentials in a staging environment.

---

## 6. Compliance note (explicit, per the mission)

"No KYC" / "No KYB" on Bcon's and Paymento's marketing describes **their**
onboarding of us. It does not transfer to our obligations as the merchant of
record: Kalderix is operated by Arbitrix Trading (KVK 72923513, NL). Accepting
customer crypto means **we** still have to consider, with counsel:

- source-of-funds / sanctions screening on incoming transfers (a non-custodial
  gateway performs none, and takes no responsibility for what lands in our wallet);
- record-keeping and reporting duties tied to the product we sell;
- the fact that choosing a provider with no onboarding gives us no compliance
  cover at all - if anything, it removes a control we would otherwise rely on.

This is a risk statement, not legal advice. Any provider change should be signed
off by counsel before it goes live.

---

## 7. Recommendation

1. **Bcon Global does not pass the decisive test.** On TRC20 it uses one wallet
   with amount differentials, optionally fronted by a finite wallet pool. It
   reproduces Q8Pay's weakness and adds an unsigned callback and an 8-character
   reference limit. Do **not** integrate it as the preferred alternative.
2. **Paymento cannot serve a plain-address TRC20 checkout** (wallet-connect
   required). Keep it as the leading candidate only if the deposit rail moves to
   USDT-ERC20/SPL, where its API is the strongest of the three.
3. **BTCPay + the USDt plugin is the only option that meets the bar** (unique
   address per invoice, exact 50.00 for every customer, fails closed when the
   pool is exhausted, signed webhooks, explicit partial/overpaid states). Treat
   it as an infrastructure project, not a provider swap: ~20-50 TRON addresses
   with key management, a TRON RPC account, sweeping, a BTCPay instance, and a
   new provider adapter.
4. **Keep Q8Pay running** in the meantime, unchanged.

### What would change this conclusion

- Bcon adding per-invoice TRON address derivation (they cannot without custody
  or an xpub for TRON - ask them directly).
- Paymento enabling plain address + QR on TRC20.
- A production-capable BTCPay decision plus resources for the infrastructure.

### Next steps if BTCPay is chosen

1. Provision BTCPay + the USDt plugin on staging; configure a TRON RPC key.
2. Generate 25 TRON addresses (offline key ceremony), load them into the pool.
3. Implement `services/providers/btcpay.js` against Greenfield (`POST /api/v1/stores/{id}/invoices`,
   `GET .../invoices/{id}`, webhook `InvoiceSettled`/`InvoiceExpired`/`InvoicePaymentSettled`).
4. Parallel-run: keep Q8Pay for live customers, route a staging account to BTCPay,
   compare 50.00-attribution across concurrent invoices.
5. Only then consider changing `PAYMENT_PROVIDER`.

## Sources (retrieved 2026-11-24)

- Bcon: `https://bcon.global/`, `/integrations/api/`, `/how-to-start-accepting-crypto-payments-with-the-bcon-new-address-api-function/`, `/prices/`, `/faq/`; live probes of `external-api.bcon.global`.
- Paymento: `https://docs.paymento.io/llms.txt`, `overview/supported-networks-and-assets`, `overview/how-payments-work`, `api-documentation/payment-request`, `payment-callback`, `payment-states-and-confirmations`, `company/fee-and-pricing`, `accept-crypto-payments/get-started`.
- BTCPay: `https://docs.btcpayserver.org/FAQ/Altcoin/`, `github.com/btcpayserver-tether/BTCPayServer.Plugins.USDt` (README, `AddressPoolTests.cs`, `EditTronUSDtPaymentMethodViewModel.cs`), `btcpayserver/btcpayserver` `WebhookSender.cs`, `swagger.template.invoices.json`.
