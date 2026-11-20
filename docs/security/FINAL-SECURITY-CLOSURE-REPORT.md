# Final security closure - PR #171

Date: 2026-11-16
Repository: `nuraabdullahi708090-sudo/arbitrix-app`
Branch: `relaunch/rebrand-payment-commercial` (PR #171, DRAFT)
Head before this session: `71c5ea8`
Companion documents: `docs/security/PRODUCTION-M2-SECURITY-AUDIT.md`,
`docs/security/hotfix-charge-subscription-safe.sql`,
`docs/security/verify-charge-subscription-safe.sql`

**Nothing was merged, promoted, deployed, applied or sent to production by this work.**
The only production facts in this report are the ones the operator supplied, and they
are labelled as such.

---

## 1. Verified production M2 correction

`public.charge_subscription_safe` was `SECURITY DEFINER`, took `p_user_id` and
`p_price` from the caller, had no pinned `search_path`, and had never been included in
migration 014's EXECUTE lockdown. An authorised operator applied the correction
directly in the production SQL Editor and reported:

| Fact | Value | Status |
|---|---|---|
| BEFORE, `anon` / `authenticated` / `PUBLIC` EXECUTE | all granted | **VERIFIED** (operator) |
| BEFORE, `search_path` | null | **VERIFIED** (operator) |
| AFTER, `anon` / `authenticated` / `PUBLIC` EXECUTE | all **false** | **VERIFIED** (operator) |
| AFTER, `service_role` EXECUTE | **true** | **VERIFIED** (operator) |
| AFTER, `search_path` | `public, pg_temp` | **VERIFIED** (operator) |
| Signature / owner | unchanged / `postgres` | **VERIFIED** (operator) |
| How | production SQL Editor, direct | **VERIFIED** (operator) |
| Migration applied for this | none | **VERIFIED** (operator) |
| 051 applied before the correction | no (its definition pins `search_path`) | **INFERRED** |
| 052 / 053 in migration history | no | **INFERRED** |
| Historical exploitation | **unknown - no logs available; no claim either way** | **UNKNOWN** |

Correction to the earlier audit text (accuracy fix, made this session): the earlier
draft said the publishable `anon` key "ships in the browser bundle". It does not - this
application authenticates with its own JWT, `public/` contains no Supabase key, and
`server.js` records that the frontend never talks to Supabase directly. The RPC was
therefore reachable by anyone holding the project's `anon` key or a Supabase-issued
JWT, not by every visitor to the site. That narrows the population; it does not change
the conclusion, and the correction closes both paths.

**Verdict: the M2 exposure is CLOSED in production.** The historical window remains
unquantified and is not claimed to have been clean.

---

## 2. Migration 051 / 052 reconciliation

| Migration | What it does | Touches `charge_subscription_safe`? | Recommended |
|---|---|---|---|
| `011_subscription_pro.sql` | creates the function (ACL default, no `search_path`) | yes (defines it) | **do not re-run** |
| `014_financial_rpc_privilege_lockdown.sql` | locks `record_trade_safe`, `credit_payment_safe`, `paymento_credit_user_safe` | no | already applied |
| `051_rebrand_subscription_detail.sql` | rebrands the transaction detail to "Kalderix Pro Subscription" **and** pins `search_path` + revokes/grants | yes (recreates the body) | apply with the relaunch, separately |
| `052_charge_subscription_safe_privileges.sql` | privileges + `search_path` only, body untouched | yes (ACL only) | **apply after rehearsal** |
| `053_financial_rpc_privilege_lockdown.sql` | locks the 10 remaining money-adjacent RPCs (section 3) | no | apply with 052 |

### Recommendation: **Apply 052, after rehearsal.**

Why not "no further migration required": the production fix exists only in the live
catalog. A fresh environment, a restored dump taken before the fix, or a future
`supabase db push` that replays from 011 would recreate the vulnerable function, because
**no migration in the chain carries the correction**. 052 is that migration: it
recreates nothing, changes no body, and its postcondition is exactly the state the
operator verified.

Why it is safe against the already-corrected database: rehearsed on PostgreSQL 16.16 -
against the corrected state it is a no-op (notices only, no change), against an
uncorrected 011 state it converges, and applying 051 then 052 or 052 then 051 both end
at `anon=false auth=false svc=true search_path=public, pg_temp`. A 052 failure rolls the
whole transaction back.

Why not apply 051 now: 051 changes customer-visible transaction text
("Arbitrix Pro Subscription" -> "Kalderix Pro Subscription"). That belongs to the
rebrand release decision, not to security closure, and 051 does not undo 052 in either
order. Applying 052 alone leaves production's ledger text unchanged.

**Migration history could not be read from this environment** (the management API
token is rejected and the database host does not resolve - see the M2 audit, section B),
so "which versions are recorded" is UNVERIFIED here, and the two inferences above come
from the operator's before-state rather than from the history table. The recommendation
does not depend on it: whatever the history says, 052 is the only committed file that
recreates the correction in a fresh environment, and applying it is idempotent.

**Migration-history reconciliation: not needed.** No manual history surgery is
required - applying 052 records it normally. Do not re-run 011, and do not hand-edit
`supabase_migrations.schema_migrations`.

---

## 3. Financial SECURITY DEFINER audit

Scope: functions that can affect wallet balances, deposits, withdrawals, subscription
charges, payment credits, trading transactions, referral rewards or Payhip
entitlements. KYC, marketing, Telegram, conversion/outbox and housekeeping functions
were reviewed only far enough to exclude them.

### 3.1 Real money movers - already locked, no action

| Function | Defined in | Locked by | `search_path` | Caller-controlled target | Verdict |
|---|---|---|---|---|---|
| `record_trade_safe` | 009 | 014 | none | `p_user_id` | service_role only - unchanged |
| `credit_payment_safe` | 008/021 | 014/021 | none | `p_user_id` + invoice | service_role only - unchanged |
| `paymento_credit_user_safe` (5-arg, 8-arg) | 006/007/021 | 014/021 | none | `p_user_id` | service_role only - unchanged |
| `charge_subscription_safe` | 011/051 | 051/052 + hotfix | **pinned** | `p_user_id`, `p_price` | **fixed in production** (section 1) |
| `confirm_payment_with_credit` | 002/021/042 | 042 | none | invoice id | service_role only - unchanged |
| `confirm_legacy_deposit_safe` | 041 | 041 | pinned | deposit id | service_role only - unchanged |
| `award_referral_qualification_safe` | 021 | 021 | none | `p_user_id` | service_role only - unchanged |
| `convert_referral_earnings_safe` | 023 | 023 | none | `p_user_id` | service_role only - unchanged |
| `request_referral_payout_safe` | 034/035 | 035 | none | `p_user_id` | service_role only - unchanged |
| `update_referral_payout_safe` | 034/037 | 037 | none | payout id | service_role only - unchanged |
| `record_payhip_purchase_safe` | 050 | 050 (dynamic loop) | pinned | sale payload | service_role only - unchanged |
| `redeem_payhip_entitlement_safe` | 050 | 050 | pinned | `p_user_id` | service_role only - unchanged |
| `revoke_payhip_entitlement_safe` | 050 | 050 | pinned | key | service_role only - unchanged |
| `payhip_has_live_activation` | 050 | 050 | pinned | `p_user_id` | service_role only - unchanged (read-only) |
| `sandbox_award_referral_qualification`, `sandbox_request_referral_payout_safe`, `sandbox_update_referral_payout_safe`, `sandbox_referral_config`, `sandbox_reset_account` | 022/036 | 022/036 | mixed | sandbox users | locked - unchanged |

`credit_referral_commission_safe` does not exist: the commission model was retired and
migration 020/024 assert its absence.

### 3.2 Finding F-053-1 (CONFIRMED, low severity, fixed by migration 053)

`public.paymento_check_duplicate_webhook(p_paymento_token text, p_provider_payment_id bigint)`

- `SECURITY DEFINER`, owner `postgres`, **no** `search_path`, **no** ACL statement in
  006 or 007, and migration 014 never listed it.
- Read-only, but it returns `invoice_id`, `status`, `credited`, `amount_usd`,
  `user_id`, `settlement_address`, `provider_tx_hash` and `provider_confirmations` for
  a caller-supplied token **or** a caller-supplied `provider_payment_id`.
- `provider_payment_id` is a provider-side integer, i.e. enumerable, so the disclosure
  does not require guessing a secret.
- No application caller exists (checked across `server.js`, `worker.js`,
  `conversion-worker.js`, `marketing-worker.js`), so revoking it breaks nothing.

**Rehearsed on PostgreSQL 16.16** (throwaway container, removed):

```
set role anon;
select paymento_check_duplicate_webhook(null, 4242);
-> {"found": true, "status": "pending", "user_id": 1, "credited": false,
    "amount_usd": 250.00, "invoice_id": 1, "provider_tx_hash": "0xabc123",
    "settlement_address": "TVictimSettlementAddress000000000000",
    "provider_confirmations": 3}
```

Severity: **low** - deposit metadata disclosure (user id, amount, settlement address,
transaction hash) for another customer. No money moves, no write is possible. Exploit
requires the project's `anon` key.

### 3.3 Finding F-053-2 (benign, hardened for defence in depth)

`public.mark_expired_invoices()` - `SECURITY DEFINER`, no `search_path`, no ACL, no
application caller. It sets `status='expired'` only `WHERE status='pending' AND
expires_at < NOW()`, so an anonymous caller can perform at most what the passage of
time would perform anyway. **Not a vulnerability.** Locked because it should not be
callable by anonymous clients and because the unpinned `search_path` lets an unqualified
`payment_invoices` resolve outside `public`.

### 3.4 Finding F-053-3 (no production impact, hardened)

The eight MARKETING_SANDBOX money functions from 013 (`sandbox_ensure_wallet`,
`sandbox_set_balance`, `sandbox_credit_deposit`, `sandbox_record_trade`,
`sandbox_charge_subscription`, `sandbox_request_withdrawal`,
`sandbox_set_withdrawal_status`, `sandbox_reset_account`) are `SECURITY DEFINER`, have
**no** `search_path` and **no** ACL. **Every one calls `assert_sandbox_user()`**, which
raises for a production account:

```
set role service_role; select sandbox_set_balance(1, 1000);
-> ERROR: User 1 is not a MARKETING_SANDBOX account
```

So no production balance is reachable. They are locked anyway (simulated wallet
balances, and the shadowed-`users` variant of the `search_path` class would otherwise be
able to defeat the guard).

### 3.5 Not changed, recorded as residual hardening

The ten real-money RPCs in 3.1 that still have an unpinned `search_path` (`record_trade_safe`,
`credit_payment_safe`, `paymento_credit_user_safe` x2, `confirm_payment_with_credit`,
`award_referral_qualification_safe`, `convert_referral_earnings_safe`,
`request_referral_payout_safe`, `update_referral_payout_safe`) are **service_role-only**.
Exploiting object resolution there requires the service_role credential, which already
implies total control, so there is **no demonstrated exploit path** and no correction is
proposed here. Recommended follow-up (not in 053, to keep it small and reviewable): a
later migration that adds `SET search_path = public, pg_temp` to those ten.

---

## 4. Subscription billing compatibility

- The billing path calls `charge_subscription_safe` exclusively through
  `supabaseAdmin`, which is constructed from `SUPABASE_SERVICE_KEY`
  (`server.js:303`), and **production refuses to start without it**
  (`process.exit(1)` at the guard) - so billing can never silently run as `anon` once
  `anon` loses EXECUTE.
- Rehearsed after the ACL change: `service_role` retains EXECUTE and the call succeeds;
  `anon` and `authenticated` are denied. The function's `prosrc` is byte-identical
  before and after (asserted by the hotfix/052 postcondition).
- `service_role` keeps its grant under every ordering tested (011 -> 014 -> 051 -> 052,
  052 -> 051, and 053 on a database with or without 013).
- No charge was made against a real customer. The subscription suites run with mocked
  billing: `subscription.test.js` + `subscription_eligibility.test.js` +
  `subscription_nav.test.js` = **54/54 pass**.

---

## 5. Remaining genuine security blockers

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | M2 - `charge_subscription_safe` exposed to anon/authenticated/PUBLIC | **critical** | **CLOSED in production** (operator-verified) |
| 2 | F-053-1 - `paymento_check_duplicate_webhook` deposit-data disclosure to anon | low | **PREPARED** - migration 053, not applied |
| 3 | F-053-2/3 - unpinned, unlocked housekeeping and sandbox RPCs | none / informational | **PREPARED** - same migration |
| 4 | Historical exploitation of M2 unknown | unknown | cannot be resolved without logs; read-only forensic queries are provided in the M2 audit (section E) |

No other financial blocker was found: every function that moves real money is
service_role-only, and the two remediation items above are covered by one narrow,
rehearsed migration.

Non-security items still open on PR #171 (outside this report's remit, listed so they
are not mistaken for closure): Payhip merchant eligibility for the activation-funding
model, and the commercial decision on the $50 activation package.

---

## 6. Test and CI results

| Check | Result |
|---|---|
| `npm test` (full suite, current tree) | **3422 tests, 3422 pass, 0 fail** (exit 0) |
| Baseline on the same tree minus this session's changes | 3409 pass / 0 fail |
| Net change | +13 tests (12 in `tests/financial_rpc_privileges_053.test.js`, 1 billing-path test) |
| `node scripts/verify-rebrand.js --expect Kalderix` | **ALL CHECKS PASSED** |
| `node --check server.js` (+ worker entrypoints and `services/TradingWorker.js`) | OK |
| C1 / Payhip behavioural suites (`live_mode_eligibility`, `live_activation_entitlement`, `live_account_activated`, `payhip_http`) | **101/101 pass** |
| `tests/financial_rpc_lockdown.test.js` (migration 014 suite) | 27/27 pass - unchanged |
| `tests/charge_subscription_safe_hotfix.test.js` | 12/12 pass |
| Migration 053 rehearsal (PostgreSQL 16.16, throwaway container) | before/after, idempotency, skip path, abort path, unrelated-function control - all pass |

INCORRECT FILE HANDLING, CAUGHT AND CORRECTED: the new 053 test suite was first written
to `tests/financial_rpc_lockdown.test.js`, which **already existed** for migration 014,
so 27 existing tests were silently replaced. Detected by comparing the suite total
against the baseline (3395 vs 3409 instead of 3422), the original file was restored from
HEAD and the new suite renamed to `tests/financial_rpc_privileges_053.test.js`. The
final run above is after that correction; the 014 suite is intact.

Commercial invariants verified unchanged:

| Invariant | Value | Source |
|---|---|---|
| Payhip activation package | $50 (a Payhip-side product price; never invented server-side) | `GET /api/live/activation` returns only catalogue state |
| Minimum deposit | $100 | `PLATFORM_MIN_DEPOSIT_USD = 100` (server.js:951) |
| Referral qualifying deposit | $100 | `referral_config.minimum_qualifying_deposit` |
| Referral reward | 20% one-time | `REFERRAL_REWARD_PERCENT_DEFAULT = 20` (server.js:2049) |
| Withdrawal minimum | $700 | `MIN_WITHDRAWAL_USD = 700` (server.js:1046) |
| Grandfathering | none - C1 requires activation **and** a qualifying deposit | `getLiveModeEligibility` + `live_mode_eligibility.test.js` |
| Payhip activation credits a wallet | **no** - it grants an entitlement only | `/api/live/activate` (C1 suite) |
| A deposit activates Live Mode | **no** - activation is the separate first step | C1 suite |

---

## 7. Exact production actions still required

1. **Apply `supabase/migrations/052_charge_subscription_safe_privileges.sql`** (records
   the security fix in migration history; idempotent against the corrected database).
2. **Apply `supabase/migrations/053_financial_rpc_privilege_lockdown.sql`** (closes
   F-053-1). Expect `053: locked 10 function(s)` or `locked 2, skipped 8` if migration
   013 is not applied; both are success.
3. **Verify afterwards** with `docs/security/verify-charge-subscription-safe.sql` and,
   for 053, this read-only query:

   ```sql
   select p.proname,
          has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
          has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role,
          coalesce(array_to_string(p.proconfig, ','), '(none)')     as search_path
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('mark_expired_invoices','paymento_check_duplicate_webhook',
                       'sandbox_ensure_wallet','sandbox_set_balance','sandbox_credit_deposit',
                       'sandbox_record_trade','sandbox_charge_subscription',
                       'sandbox_request_withdrawal','sandbox_set_withdrawal_status',
                       'sandbox_reset_account')
   order by 1;
   -- expect anon=false, auth=false, service_role=true, search_path=public, pg_temp
   ```

4. **Smoke-test the subscription panel once** after 052 (one real or test-account
   activation) to confirm billing still charges through `service_role`.
5. **Optional, non-security:** apply 051 with the rebrand release, and run the
   read-only forensic queries in the M2 audit (section E) if the historical window is to
   be investigated.
6. **Do not** rotate or hand-edit migration history, and do not re-run 011.

---

## 8. PR readiness

**Ready for final human review.** Code, migrations and documentation are complete and
self-verifying; the suite is green; no production action was taken; PR #171 remains a
draft.

Blocking conditions before merge/deploy remain as before and are all human decisions:
the Payhip merchant-eligibility assessment, approval to apply 052/053, and approval of
the commercial package. Nothing in this report authorises a merge, a deploy or a
migration.

Recommended merge order once approved:
1. Merge PR #171 (code only - migrations are inert until applied).
2. Apply 052, then 053, through the approved pipeline (not the SQL editor).
3. Run the verification queries and the single billing smoke test.
4. Enable any remaining Payhip/checkout configuration only after the merchant
   assessment is signed off.
