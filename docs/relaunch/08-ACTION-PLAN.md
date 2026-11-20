# Arbitrix relaunch - ordered action plan

Date: 2026-11-16

---

## 1. What is blocked, and why

| Blocked item | Blocked on |
|---|---|
| Rebrand implementation | brand approval + the product-claim decision (doing it first is the wrong order) |
| ~~$50 minimum going live~~ | **not proceeding** - management kept the $100 floor; this row is history |
| Payhip rail | eligibility (likely refused) + the unit economics in `04-PAYHIP.md` §3 |
| Card rails | acquirer approval of the product; Card2Crypto is disqualified |
| Trunkay assessment | the correct URL (the name does not exist on any TLD) |
| Google Ads / paid acquisition | a licensed entity + Google financial-services certification |
| Brazil/Mexico spend | the product-claim decision (marketing an engine-grown withdrawable balance is the risky version of this launch) |
| Spanish / legal localization | brand decision (write the strings once) |
| Any worker activation | approval + migrations 038-047 |

## 2. The decision that unblocks everything

Option A and Option B below are the only two shapes that survive every other
assessment in this folder. Both are honest; only one keeps the current marketing.

### Option A - "Simulation / strategy tool" (fastest, lowest risk)

- The balance becomes explicitly non-redeemable usage credit. Profits buy
  additional access time or a higher simulated limit; they are **not withdrawable
  for cash**.
- Removing "withdraw your profits" from the promise makes the credit-and-withdraw
  economics coherent, makes the Payhip package defensible, and makes the RNG
  honest as a *simulated* strategy rather than a return.
- What must change: the withdrawal route stops accepting engine-grown funds (or
  withdrawals are limited strictly to the customer's own confirmed deposits);
  the copy stops implying returns; the $400 profit pause becomes redundant.
- Time: days, and mostly copy + one withdrawal rule.
- Cost: the product loses the "make money" hook, which is what currently sells it.

### Option B - real execution (correct, slow, expensive)

- Two exchange accounts, real market data, a real order router, per-asset
  capability flags, best-execution and custody obligations, and a licensed
  entity for retail.
- Time: months. Cost: licensing, capital pre-positioned on two venues, and
  engineering.
- Real arbitrage margins (0.1-0.4% gross, before four fee events) would not
  support the current marketing either.

**Either way, the immediate action is the same:** stop advertising returns, and
make the withdrawal rule match what the balance actually is.

## 3. Ordered plan

**Phase 0 - do now, no approval needed (done on this branch)**

1. Landing opportunity card labelled as illustrative, in 6 locales.
2. Minimum deposit reduced to one switchable value, default $100 unchanged.
3. This documentation set.

**Phase 1 - decision (founder, days)**

4. Choose Option A or B in §2.
5. Choose a brand (`Kalderix` recommended) and the trading-name wording.

**Phase 2 - product integrity (days to weeks, depends on 4)**

6. Align the withdrawal rule with the chosen model.
7. Rewrite the landing page and the Telegram marketing copy to match: no return
   projections, no signal framing, fees and the business address visible.
8. Fix the Q8Pay discriminator (ask for a unique address per invoice), and add the
   reconciliation queue before any acquisition spend.

**Phase 3 - market entry (after 6-8)**

9. Ship the disclosure and integrity changes alone. Low risk, no financial change.
10. Brazil organic/community launch - zero localisation work required.
11. Add Spanish to the support bot, then Mexico.
12. Localize transactional emails and legal pages.

**Phase 4 - commercial rails (only if 4 = Option A)**

13. Apply the $50 bundle (env var + referral sync + copy sweep) if approved.
14. If a checkout experience is wanted, sell **software access** on Payhip and
    keep funding on Q8Pay.

## 4. Approval gates (from the brief)

I stopped before each of these. None has been performed.

| # | Gate | Status |
|---|---|---|
| 1 | Purchase domains or trademarks | not done |
| 2 | Change DNS / domain ownership | not done |
| 3 | Apply migrations that change financial logic | not done (no migration written that would; the $50 config sync is prepared as text only) |
| 4 | Change production deposit requirements | not done - the knob defaults to $100 |
| 5 | Credit or modify real balances | not done |
| 6 | Change live payment routing | not done - Q8Pay unchanged |
| 7 | Submit merchant applications / accept legal terms | not done - no provider contacted |
| 8 | Launch advertising / spend money | not done |
| 9 | Change operator identity or legal disclosures | not done |
| 10 | Deploy financial changes to production | not done - no push, no deploy |

## 5. What I would do next without asking

If the founder is unavailable, these are safe and add value now:

- Add the reconciliation queue for stale `pending` invoices and webhook errors
  (read-only reporting, no routing change).
- Add the `execution` capability flag to the asset registry (metadata only).
- Add Spanish to the Telegram support bot (a new locale object; the pattern is
  already there and the fallback is English per key).
- Author the $50 copy sweep as a scripted patch that can be applied in one
  command after approval.

These are the only remaining items that do not depend on a commercial decision.
