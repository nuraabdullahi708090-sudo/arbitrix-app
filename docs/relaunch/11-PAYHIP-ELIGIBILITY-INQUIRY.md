# Payhip merchant eligibility — request for written confirmation

**Do not send this until the founder approves the wording**, and do not create the
product or take payment before the answer arrives. The answer decides whether the
activation layer can be switched on at all.

Two notes on tone, because they matter:

- The business is described **accurately**. Calling a trading-account activation a
  "software licence" would be a false statement to a payment provider, and any
  approval obtained that way is worthless the moment a chargeback is reviewed.
- The question is asked **before** applying. A declined application is recoverable;
  a terminated merchant account mid-launch is not.

Fill the bracketed placeholders before sending.

---

## Email draft

**To:** contact@payhip.com
**Subject:** Pre-application question — digital product for an automated trading
platform (activation entitlement only)

Hello,

I am preparing to sell a digital product through Payhip and would like written
confirmation that it is permitted before I create the product or take any payment.

**Who we are**

[Trading name], operated by [legal entity as registered] (company number [KVK
number]), registered in [country]. We operate a self-hosted, browser-based platform
for automated multi-asset arbitrage. Customers can use a fully simulated demo
environment without paying anything.

**What we would like to sell on Payhip**

A single digital product: a **one-time software activation entitlement** for the
Live Mode of our platform. The customer buys a licence key, enters it in our
account area, and the key unlocks the Live interface for their own account,
permanently, once.

Three points that I want to be explicit about, because they define whether this is
acceptable:

1. **The purchase does not fund a trading account.** It credits no balance, no
   wallet and no funds of any kind. It is a permission, not money.
2. **Trading capital arrives separately**, through a crypto deposit processed by a
   different provider (USDT, TRC20) that the customer sends from their own wallet to
   an address our platform generates. Payhip is never in the flow of those funds,
   never holds them and never settles them.
3. **The purchased key is a real software licence** in the ordinary sense: Payhip's
   licence-key system (verify/enable/disable/usage endpoints) is what we integrate
   with, and a refunded purchase disables the key automatically, which removes the
   customer's access to Live Mode.

The product itself is a digital entitlement delivered instantly, with no shipping and
no physical fulfilment.

**What I am asking**

1. Is selling a software activation entitlement for a trading platform within your
   Acceptable Use Policy?
2. Is there any restriction that applies because the platform is crypto-related,
   even though no crypto is bought, sold, held or transferred through Payhip?
3. Are there jurisdictions you cannot sell this to, or that require additional
   information from me?
4. Is there anything about the product wording or the customer journey you would
   like changed before I create the product?

I would rather ask now than discover a problem after launch. If the answer is that
this is outside your policy, I will not proceed, and I would appreciate knowing that
plainly so I can plan differently.

Thank you,
[Name]
[Role], [Trading name]
[Email] · [Phone, optional]

---

## What each answer means for the build

| Answer | Consequence |
|---|---|
| **Permitted** | Set `PAYHIP_ENABLED=true`, run `10-RELEASE-CHECKLIST.md` sections 3-4, then enable the gate. Keep the written reply on file for chargeback evidence. |
| **Permitted with conditions** (e.g. wording changes, excluded countries) | Implement the conditions in the product description and the activation copy before enabling. Re-read the conditions against `liveActivation.*` in all six locales. |
| **Not permitted** | Do **not** enable. The entitlement layer is isolated behind `services/PayhipEntitlements.js` and two config flags; it can be repointed at another entitlement vendor (Lemon Squeezy, Gumroad, Paddle) without touching trading code. Nothing in the feature is Payhip-specific except the licence API call and the signature formula. |
| **No answer** | Treat as not permitted. Do not enable a live-money-adjacent product on silence. |

## Related question worth asking at the same time

If Payhip declines, the same inquiry should go to **Paddle** and **Lemon Squeezy**,
which are merchant-of-record: they take on the sales-tax and payment risk, but their
restricted-business lists are stricter for crypto-adjacent products. Budget for the
possibility that the answer is "no" everywhere, in which case activation has to be
charged through the same crypto rail as deposits (which reintroduces the fee problem
the Option A split exists to avoid).

## Why the split matters commercially (context for the founder, not for Payhip)

A $50 Payhip sale does not settle $50: Payhip's fee plus the processor's fee come out
of settlement. Crediting $50 of trading balance from a $50 sale would therefore mean
paying out real trading capital on money we never received. The Option A split keeps
customer price and platform liability independent, which is why it is the only
structure that survives a fee schedule change.
