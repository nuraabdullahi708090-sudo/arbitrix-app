# Workstreams D, E, F - Payment rails

Date: 2026-11-16
Status: research + code audit complete. **No provider was contacted, no account was
opened, no terms were accepted, no routing was changed.**

Summary of the three verdicts:

| Provider | Verdict |
|---|---|
| **Q8Pay** (in production) | **Keep.** Genuinely non-custodial USDT-TRC20, correctly implemented. One real UX defect to fix: the decimal payment discriminator. |
| **Trunkay** | **Does not exist.** No such service could be found on any TLD. Need the correct name/URL. |
| **Card2Crypto** | **Do not use.** The published model is transaction laundering with an anonymous operator. |

---

# D. Q8Pay - the deposit experience

## D.1 Yes, decimal amount perturbation is the live discriminator

This is confirmed in code, not inferred.

- At invoice creation the platform sends a fixed `amountUsdt` (the user's round
  number).
- Q8Pay returns `amountUsdtExact`. When the same payout address already has a
  pending invoice, Q8Pay raises `amountUsdtExact` by a few ten-thousandths
  (observed: 50.0020, 50.0037, 50.0051, 50.0045, and one outlier 51.0015). That
  is **address-reuse disambiguation**, not a fee - the deltas do not match
  Q8Pay's documented 0.5% merchant fee and vary per invoice.
- The platform stores that value as `invoice.amount_crypto` and the customer is
  shown it as "the exact amount to pay".
- The webhook compares the confirmed `amountUsdtExact` against
  `invoice.amount_crypto` to four decimals
  (`server.js` ~4766-4780) and **credits `invoice.amount_usd`** (the round
  number the customer asked for). So the customer pays 100.0037 and receives
  $100; the 0.0037 is absorbed by the platform.

## D.2 Why this confuses customers, and the real risk

The customer is asked to send a non-round amount ("100.0037 USDT") while every
other wallet, exchange and human habit sends round numbers. The failure mode is
silent and expensive:

- A customer who sends 100.0000 instead of 100.0037 fails the four-decimal
  comparison. The webhook responds **HTTP 200 with `{error:'Amount mismatch'}`**
  and credits nothing. Q8Pay sees an accepted delivery, so there is no retry,
  and the customer's money is on-chain in the platform's payout address with no
  automatic reconciliation path.
- The same applies to a small overpayment.
- This is the single most likely cause of a "I paid and got nothing" support
  ticket, which is exactly the friction the relaunch is trying to remove.

Precision is also worth stating plainly: at 4 decimal places USDT has 0.0001
granularity, so the discriminator only supports a few hundred distinct pending
amounts per address before collisions.

## D.3 Recommendation - replace the discriminator, do not remove it

You asked not to remove payment identification without an alternative. Two
options, in order of preference:

**Option 1 (preferred): one unique payout address per invoice.**
Ask Q8Pay for per-invoice address allocation (most non-custodial gateways issue
a fresh address per invoice; address reuse is the reason they perturb amounts).
With a unique address, the amount can stay round, the customer experience becomes
"send 100 USDT to this address", and the discriminator is the address - which is
what a blockchain identifies anyway. Implementation on our side is trivial: the
webhook already validates that `verifyResult.payoutAddress` matches the stored
`invoice.wallet_address`, so no crediting logic needs to change.
**Action: ask Q8Pay support one question - "can we receive a unique deposit
address per invoice instead of a reused one?"** That is the whole decision.

**Option 2 (if addresses must be reused): make the exact amount impossible to
get wrong, and stop silently dropping mismatches.**
- Show the exact amount as the primary number with a one-tap **copy** button, and
  the USD figure as secondary: "Send exactly 100.0037 USDT (about $100.00)".
- Keep the QR payload on the exact amount (already does).
- Add a persistent warning: "Do not round this amount - a different amount cannot
  be credited automatically."
- Handle a mismatch instead of rejecting it: record the payment against the
  invoice, credit the **correct proportion** (paid amount, floored to cents),
  and raise an admin reconciliation item for any difference above a small
  tolerance. Never credit more than was received.
- Keep exact-match as the *fast* path so the normal case never needs review.

Either option removes the confusion. Option 1 also removes the "why is this
number weird" question from the product entirely.

## D.4 What is already correct and should not be touched

Asset locked to `USDT_TRC20`; HMAC-SHA256 over the raw body in
`x-webhook-signature`; server-side re-verification of the invoice through the
Q8Pay API before crediting (the webhook is a trigger, not evidence); payout
address comparison; unique tx-hash idempotency key; a `live_`/`test_` key guard
that makes a fake tx hash impossible for a live payment; crediting only through
`credit_payment_safe` (idempotent, row-locked); expiry and cancellation handled;
a `Q8QPAY_SANDBOX` mode that cannot touch production balances.

Fees: Q8Pay's documented model is a flat 0.5% deducted from the merchant
prepaid balance on confirmation. The customer pays the on-chain network fee
separately. That is cheap and it is the reason to keep this rail.

---

# E. Trunkay - cannot be verified because it does not appear to exist

I probed the obvious hosts. **Every one returned NXDOMAIN:**

`trunkay.com`, `trunkay.io`, `trunkay.co`, `trunkay.net`, `trunkay.app`,
`trunkay.pay`, `trunkay.finance`, `trunkay.co.uk`, and the near-miss
`trunkpay.com`.

There is therefore no website, no API documentation, no published country or
currency coverage, no fee schedule, no webhook contract, and no merchant
eligibility policy to assess. I will not invent an assessment, and I will not
claim a provider is available when its domain does not resolve.

**What I need from the founder:** the exact URL, or a screenshot/email where the
name appeared. The likeliest explanations are (a) a different spelling
(Tru*k*pay? Trus*ty*pay? Trunk*ai*?), (b) an invite-only or Telegram-only
reseller, or (c) a name from a sales conversation whose website is not yet up.

**Why I would be cautious even once identified:** a payment provider whose
public footprint is absent is, by definition, one whose licensing, settlement
currency and dispute process cannot be reviewed. For a platform that intends to
hold customer funds and accept card payments, that is disqualifying until
verified. If it turns out to be a card-to-crypto reseller, everything in section
F applies to it as well.

---

# F. Card2Crypto (card2crypto.org) - do not use

## F.1 What the site actually says (quoted from card2crypto.org, fetched today)

- "Accept credit and debit cards, Apple Pay and Google Pay. Receive instant
  settlement directly to your Crypto wallet."
- "**No KYB. No chargebacks. No fund freezes.**"
- "Our instant approval payment gateway accepts bank cards such as Visa and
  Mastercard, **regardless of what you are selling**. We cater to **all
  high-risk business models**."
- "Experience the freedom of Web 3.0 with Card2Crypto - **no borders or local
  regulations to worry about**."
- "**Be Anonymous** - No sign-up (instant access) or KYB needed, **Be 100%
  anonymous** with Blockchain Technology."
- From the About page, the mechanism: "When a customer pays you, **they don't pay
  you directly for the product or service; instead, they purchase USDC on your
  behalf**  therefore No chargeback or KYC Regulations."
- Pricing: a provider fee that "varies by the country and transaction amount"
  plus a Card2Crypto fee "capped at 3%".
- Settlement: USDC on Polygon (with an EVM/Ethereum option mentioned).

## F.2 The operator is not identified

The Terms of Use name no company, no registration number and no address. The
governing-law clause reads: "These Terms are governed by the laws of the country
where **our organization is based**" - the organisation is never identified. The
site is a WordPress installation first published 2024-10-29.

A merchant cannot assess, contract with, or pursue an unnamed counterparty.
There is no one to serve notice on, no jurisdiction to complain in, and no
regulator to appeal to.

## F.3 Why this is disqualifying, in plain terms

1. **It is transaction laundering.** The About page states the card charge is
   booked as the cardholder *buying USDC*, not as payment for your product. That
   is the textbook definition of miscoding a merchant's transactions under a
   different business category. It is prohibited by Visa and Mastercard rules and
   is a criminal offence in most jurisdictions. The **merchant** carries that
   liability, not the gateway.
2. **"No chargebacks" is false.** Disputes are handled by the issuing bank under
   the card network's rules; no gateway can remove that right. A platform that
   believes it has no chargeback exposure will not build the reversal machinery
   it actually needs.
3. **"No local regulations to worry about" is not a legal position.** Card
   acquiring for a financial product requires licensed acquiring. A claim to the
   contrary describes an unlicensed acquirer.
4. **"Regardless of what you are selling" + "all high-risk business models"** is
   an explicit invitation to businesses that mainstream acquirers refuse. For a
   platform that sells an investment-like product, that is the strongest possible
   signal that no legitimate acquirer has reviewed it.
5. **Settlement in USDC on Polygon** removes the one thing that makes card
   payments useful - reversibility and a paper trail tied to a named merchant.
6. **The absence of merchant custody is not the test.** You were right to flag
   this: not holding the cardholder's card data does not reduce the platform's
   own obligations (KYB, AML, consumer disclosure, disputes, tax). The site's
   framing ("no KYC") transfers risk to the merchant rather than removing it.

## F.4 Underlying on-ramps (Ramp, MoonPay, Transak, Coinbase Pay, Banxa)

These are legitimate, licensed on-ramps and are a different proposition: the
customer buys crypto **in their own account at that provider** and then sends it
to the merchant's address. The platform never sees the card, never holds custody,
and is not the merchant of record - which is honest, and is exactly what the
existing USDT/TRC20 rail already achieves.

From earlier research in this repo (`docs/relaunch` sibling notes in AGENTS.md):
Trust Wallet's USDT page documents card/bank purchases through MoonPay, Simplex,
Banxa, Mercuryo, Ramp and Transak with a ~$10 minimum; MoonPay documents USDT on
Tron; Transak documents per-chain USDT purchase. **None of them publish that they
permit using their on-ramp to fund a third-party trading platform's customer
balance**, and their merchant terms restrict use of their services to buying
crypto for oneself. Using them as a front-end for "buy this package and we credit
your trading balance" is the same eligibility question as Payhip.

**Country availability for Nigeria and South Africa is unverified for all of
them** and must not be claimed in copy.

## F.5 Effective cost comparison

| Rail | Customer pays | Fees | Net to platform | Reversible? | Eligibility for this product |
|---|---|---|---|---|---|
| **Q8Pay (live)** | ~$1 + on-chain gas | ~0.5% merchant | ~99.4% | No (crypto) | Already onboarding-passed |
| Card2Crypto | $1 + 3% + provider fee | 3%+ | ~95-96% | No | Unlicensed; laundering model |
| Payhip | $1 + 5% + $0.50 + card | ~8-9.5% | ~91% | Yes | Likely refused |
| On-ramp direct (MoonPay/Transak) | customer pays on-ramp fee | customer-side | 100% of USDT sent | No | Customer buys for themselves; not a merchant product |

Q8Pay is both the cheapest and the only rail with no new eligibility exposure.

---

# G. Recommended payment architecture

1. **Keep Q8Pay as the only funding rail.** It is live, cheap, non-custodial and
   already correctly implemented. Do not add a second rail until the product
   model is settled (see `01-BASELINE.md` §2).
2. **Fix the decimal discriminator** (D.3 Option 1) - the highest-value change in
   this workstream, and a support-ticket reducer.
3. **Add reconciliation visibility** before adding providers: a daily
   invoice-vs-chain check with an admin list of `pending` invoices older than 24h
   and any webhook that returned an error. Today a mismatch is logged and
   dropped; it should become a queue.
4. **Do not add card payments for the current product.** Every card route requires
   an acquirer to approve an investment-like, withdrawable, engine-grown balance.
   That approval is the blocker, not the integration.
5. **If card payments become necessary**, the eligible shape is: a real software
   subscription (the existing $7/month product, sold through a legitimate
   processor) with funding remaining on Q8Pay. That is a business decision, not a
   technical one.
