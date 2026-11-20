# Payhip Live Mode activation - grandfathering proposal

**Status: PROPOSAL ONLY. Nothing in this document is implemented.**
No customer record, wallet, purchase or entitlement has been created, changed or
deleted. Enabling `PAYHIP_ACTIVATION_REQUIRED` remains a separate, founder-approved
step.

## 1. What enabling the flag actually does today (C1, no grandfathering)

`getLiveModeEligibility()` (server.js) requires **both** halves, with no cutoff date
and no deposit-based exception:

* a claimed, unrevoked entitlement on a `paid` purchase (`payhip_has_live_activation`), and
* a confirmed deposit of at least the platform minimum ($100).

If the flag is switched on as-is, **every** production account that has not bought an
activation loses Live Mode at the same second - including customers who have been
funded and trading for months. Demo Mode, deposits, withdrawals and referral earnings
are unaffected. The server-side trading worker is covered by the gate added alongside
this document.

## 2. Who would be affected

| Cohort | Definition | Impact of enabling |
|---|---|---|
| A | `live_balance > 0` but no entitlement | bot refuses to start, trades refused |
| B | confirmed deposit >= $100 but live balance spent to 0 | same, plus an "activation required" prompt |
| C | no deposit, no entitlement (demo-only, promo untouched) | Demo unaffected; Live never opened |

MARKETING_SANDBOX accounts are exempt by design. Accounts holding a licence are
unaffected.

Read-only sizing query (run in the Supabase SQL editor; changes nothing):

```sql
with licensed as (
  select distinct user_id from public.payhip_entitlements
   where user_id is not null and claimed_at is not null and revoked_at is null
)
select count(*)                                                    as production_accounts,
       count(*) filter (where coalesce(w.live_balance,0) > 0)       as cohort_a_live_balance,
       count(*) filter (where d.confirmed > 0)                      as cohort_b_deposited,
       count(*) filter (where u.id in (select user_id from licensed)) as already_licensed
  from public.users u
  left join public.wallets w on w.user_id = u.id
  left join (select user_id, count(*) confirmed from public.deposits
              where status = 'confirmed' group by 1) d on d.user_id = u.id
 where coalesce(u.environment,'PRODUCTION') <> 'MARKETING_SANDBOX';
```

## 3. Options

### A. No grandfathering (current C1)
Everyone buys. Simplest, most consistent with "activation is the product", and the
rehearsal already pins it. **Risk:** a funded trader is locked out mid-session; that is
a support and reputational event, and the first thing a long-standing customer will
call about. Acceptable only if the affected cohort is tiny.

### B. Grandfather every funded account as of a cutover timestamp
Grant a complimentary entitlement to accounts that, **at the cutover instant**, had a
confirmed deposit >= $100 or `live_balance > 0`.

* **Mechanic:** one synthetic purchase per account (`payhip_sale_id =
  'grandfather:<user_id>'`, `product_key = 'grandfather'`, `price_cents = 0`,
  `status = 'paid'`) plus one entitlement row. A `grandfather` catalogue row
  (`price_cents = 0`, `is_active = FALSE`) satisfies the FK and can never render a buy
  button because it is not on sale.
* **Why this shape:** it reuses `payhip_has_live_activation` unchanged - no resolver
  edit, no second gate - and `revoke_payhip_entitlement_safe` already turns it off if a
  gift is ever withdrawn.
* **Risk:** zero-price rows sit in `payhip_purchases`, so any revenue report must
  exclude `product_key = 'grandfather'` (otherwise it inflates sale counts at $0). It
  also looks like a purchase in the admin list unless labelled.

### C. Grandfather only ACTIVE traders (>= 1 live trade in the last 90 days)
Narrower: rewards customers actually using the product. **Risk:** silent, hard to
explain ("why did my neighbour keep access?"), and it needs an arbitrary window that
will be relitigated later.

### D. Grandfather only accounts with a confirmed deposit >= $100
Aligns with the funding half of the rule and is the easiest to justify in writing.
**Risk:** excludes a funded trader who withdrew down to a balance funded by profit but
whose deposit record is older than the retention window on `deposits` (if any).

### E. Time-limited grace
Everyone keeps Live Mode until date X, then must activate. **Risk:** moves the problem,
does not remove it; and it needs a scheduler or a date check in the resolver (a new
runtime rule) plus its own monitoring.

### F. Exempt anyone with a qualifying deposit
Rejected: this is exactly the behaviour C1 removed. A new customer could deposit $100
and never buy the activation.

## 4. Recommendation

**Option B, with a hard cutover snapshot**, if the cohort is material; otherwise
**Option A**. Concretely:

1. Freeze the rule to a timestamp: `users.created_at <= :cutover` **or** an immutable
   flag written at cutover time. Never derive eligibility from current balance or
   deposit history at request time - those change, and a rule that reads them would
   silently grandfather people who fund later.
2. Insert one synthetic purchase + entitlement per qualifying account, inside a single
   transaction, with `payhip_events` audit rows (`event_type = 'grandfather'`).
3. Keep the cohort query (`section 2`) as the authoritative record of who was granted
   access, stored before the change for later reconciliation.
4. Label the cohort in the admin surface ("grandfathered", not "paid").
5. Exclude the synthetic product from revenue and conversion reporting.

### Immutability rule (the part that matters most)

The snapshot must be taken **once**, before the flag is enabled. A recomputed rule
("anyone funded at any time") would be re-evaluated forever and would let a customer
deposit after the launch to avoid buying the activation - reintroducing the C1 hole
through the back door.

## 5. What must be true before this is implemented

* A written decision naming the cohort, the cutover timestamp and the exclusion from
  revenue reporting.
* Tests pinning: a grandfathered account is eligible; a new account created after the
  cutover is not; the synthetic rows never appear as revenue; revoking a grandfathered
  entitlement returns the account to the gate; the worker honours the same rule (it
  already calls `payhip_has_live_activation`, so a synthetic entitlement works with no
  worker change).
* A rollback: `revoke_payhip_entitlement_safe` per account, or deleting the synthetic
  rows by `payhip_sale_id LIKE 'grandfather:%'`.

## 6. What this document does NOT do

It does not create entitlements, touch balances, change the resolver, enable the flag
or alter customer records. Option B remains a decision plus a migration of its own.
