# 14 - PRODUCTION SMOKE REHEARSAL: KALDERIX RELAUNCH

Status: **REHEARSAL COMPLETE, GREEN. NOTHING WAS RELEASED.** No production
migration, no environment variable, no deploy, no push, no customer balance
touched. This document is the evidence for release steps 4, 5 and 6 of
`13-RELEASE-CHECKLIST-KALDERIX.md`; the approval gates in section 9 are still the
founder's to open.

Reproduce with `docs/relaunch/rehearsal/README.md`. The scenario harness is
`docs/relaunch/rehearsal/harness.js` (45 checks).

---

## 1. What "rehearsal" means here

The release is three independent changes, and the question that matters for each
is not "does the code look right" but "what happens to a customer who is already
here". So the rehearsal ran the **real server**, against a **real PostgreSQL 16**
with the release migrations applied, with a **simulated Supabase REST endpoint**,
and drove it over HTTP exactly as a browser would.

Deliberately not a preview deploy: a preview would have needed production
credentials, and the first interesting assertion (`a grandfathered customer is not
asked to buy a licence`) must never be tested against real money.

| Piece | What ran |
|---|---|
| Application | the repository's own `server.js` and `services/` (unmodified logic) |
| Database | PostgreSQL 16.15 in a throwaway container, migrations `008`, `011`, `049`, `050`, `051` applied in release order, then re-applied |
| Supabase | `rehearsal/shim.js`, a PostgREST-shaped adapter (see section 7 for what it does not prove) |
| Payhip | `rehearsal/payhip-stub.js`, a local licence API with a valid / disabled / wrong-product matrix |
| Brand | the rebrand applied with the release tool `scripts/relaunch-brand.js --to kalderix --with-tests --write`, then verified with `scripts/verify-rebrand.js --expect Kalderix` |

The server copy refuses any non-local Supabase host, so no request in this
exercise could have reached production.

---

## 2. Result

```
45/45 checks passed        (0 server errors in the log)
```

Section by section:

| Group | Checks | What it proves |
|---|---|---|
| A. Brand / identity | 3 | the served page is Kalderix, "Arbitrix AI" is gone, and the legal operator page still names **Arbitrix Trading, KVK 72923513** |
| B. Existing funded customer | 5 | a pre-release customer is grandfathered, trades Live, keeps Demo, and keeps their balance - even while Payhip is unreachable |
| C. Payhip activation | 21 | the whole activation contract: gate before purchase, refusal codes, webhook signature, idempotency, one-time claim, no capital credited, refund revocation, sandbox exemption |
| D. $100 minimum deposit | 8 | the floor is $100 at runtime, the referral config agrees with it, a $99.99 invoice is refused, and a $100 deposit qualifies a referral and pays 20% exactly once |
| E. Subscription detail | 4 | a new charge writes `Kalderix Pro Subscription`, a pre-rebrand row is preserved, and both map to one label |
| F. Withdrawal rules | 1 | the internal $700 minimum is untouched by the relaunch |
| G. Collateral damage | 3 | balances, Live access and real-deposit reporting are unchanged at the end |

The harness is not self-congratulatory: two negative controls were run and it
caught both.

| Control | Expected | Observed |
|---|---|---|
| `PAYHIP_ACTIVATION_REQUIRED=false` | the gate disappears | 6 failures, including "a new unfunded customer cannot start Live Mode before activation" returning 200 |
| `PLATFORM_MIN_DEPOSIT_USD=100` | the floor regresses | 3 failures, including `minDepositSync: {ok:false, effective:100, configured:50}` - the exact half-applied state the release warns about |

---

## 3. The customer-access answers, in one place

These are the four questions the release actually hinges on.

**A customer who funded before this release keeps everything.** The activation
gate reads `hasConfirmedDeposit` first and returns
`{activated: true, reason: 'grandfathered-deposit'}`. No purchase, no licence, no
prompt. Their Live start returns 200, their Demo start returns 200, and their
balance is byte-identical afterwards. This also holds while Payhip is down: the
check never reaches the licence API for them, so an outage cannot lock a paying
customer out.

**A new customer cannot reach Live Mode by accident, and is not asked for money
twice.** Before activation, `POST /api/bot/start {mode:'live'}` returns
`403 LIVE_ACTIVATION_REQUIRED`; Demo Mode still returns 200. The refusal happens
before any session row is written, so a locked account cannot leave a "running"
bot behind.

**Activation is permission, not capital.** Redeeming a licence moved the
customer's balance by **$0.00** (checked before and after). Funding stays the
separate Q8Pay deposit, which is what "activation credits no balance" has to mean
in practice.

**A licence cannot be abused.** An unsigned webhook records nothing; a replayed
webhook is idempotent (1 purchase, 1 entitlement); the raw key is never stored
(only its SHA-256); a second account claiming the same key gets
`claimed_by_other_account` and stays unactivated; a refund webhook revokes the
entitlement, and the next Live start is refused with **no balance change**.

---

## 4. $50: the two halves move together, and the server now says so

The floor lives in two places by necessity - `PLATFORM_MIN_DEPOSIT_USD` in the
server and `referral_config.minimum_qualifying_deposit` in SQL - and a half-applied
state is silent: a $50 deposit succeeds while the referral that should qualify on
it does not. The release therefore carries a runtime self-check
(`checkMinDepositSync`, surfaced on `/api/admin/stats`) and the rehearsal asserts
it:

```
minDeposit: 100
minDepositSync: { ok: true, effective: 100, configured: 100 }
```

The behavioural half was proven end to end, not by reading constants: a $99.99
invoice is refused with "minimum deposit is $100"; a $100 deposit confirmed through
the real admin path flips the referral `pending -> active`, credits the referrer
**$20** (20% of $100 exactly) and writes exactly one `Referral Bonus` transaction;
re-confirming the same deposit awards nothing.

---

## 5. Two real defects found and fixed during this rehearsal

Both were in the release material, not in the product, and both would have
surfaced on release day.

**1. Migration 049 assumed a `(key, value)` table.** Production's
`referral_config` is `(config_key, config_value, description, ...)`, so the
original migration errored before touching a row. Rewritten to introspect the
shape, prefer `config_key/config_value`, fall back to `key/value`, print what it
found, and preserve a deliberately customised operator value (left at 75 when
pre-set, rather than forcing 50). Proven against **both** shapes.

**2. The release checklist's readiness probe had the same assumption.** Its
`SELECT value FROM referral_config WHERE key = ...` fails on production for the
same reason, and it is the first thing an operator runs. Replaced with a
schema-agnostic `DO` block that discovers the column names and prints one NOTICE
per migration. Executed here against both shapes:

```
production shape      -> 049: APPLIED (50) | 050: APPLIED | 051: APPLIED
alternative shape     -> 049: NOT APPLIED (currently 100) | 050: APPLIED | 051: APPLIED
```

---

## 6. The test suite, both ways

| Tree | Result |
|---|---|
| `relaunch/rebrand-payment-commercial` as-is | **3271 tests, 3271 pass, 0 fail** |
| the same tree with the rebrand applied (`--write --with-tests`) | **3271 tests, 3271 pass, 0 fail** |

`scripts/verify-rebrand.js --expect Kalderix` also reports
**ALL CHECKS PASSED** on the rebranded tree, and "every customer-facing reference
follows the new identity".

An earlier run of the rebranded copy reported 15 failures in
`api_404_contract` and `deposit_partners_degradation`. They were caused by **this
rehearsal's own credential guard** in the server copy (it refused the dummy
`https://example.supabase.co` URL those tests boot with), not by the rebrand: on a
pristine copy of the same tree the same 15 pass. Recorded because a green report
that hides a red intermediate run is not evidence.

---

## 7. What this rehearsal does NOT prove

Stated plainly, because the release decision depends on knowing the edges.

- **Supabase is simulated.** `rehearsal/shim.js` translates PostgREST calls into
  SQL. It is faithful enough to have exercised the real RPCs, row locks and
  triggers, but it is not PostgREST: RLS enforcement, real network latency and
  Supabase's own auth layer are outside it. RLS on the Payhip tables was inspected
  in the migration (service_role-only policy, no anon policy) and proven earlier
  on real PostgreSQL; it was not exercised through the shim.
- **Payhip is stubbed.** The signature check, payload normalisation, product
  allow-list, idempotency, refund handling and the licence-verification *client
  path* all ran, but against a local stub API. The real Payhip API's field names
  and error shapes are asserted from `docs/relaunch/05`/`06`, not observed live.
  **One live purchase in test mode is still required** before switching
  `PAYHIP_ACTIVATION_REQUIRED` on.
- **Q8Pay is not called.** The deposit floor was proven at the validation layer
  (a $99.99 invoice is refused, a $100 invoice is accepted) but no provider invoice
  was created and no blockchain payment was made. The decimal-amount
  identification behaviour is unchanged by this release and untested here.
- **The trading worker was not enabled.** It is inert in this configuration.
- **Email, Telegram and marketing sends were not exercised** - none of them
  changed in this release.
- **No real browser was driven for the deposit modal.** The deposit UI copy and
  the $50 preset come from the same server value and are covered by the existing
  suite, not by this harness.

---

## 8. Residual risks and their mitigations

| Risk | Mitigation in place |
|---|---|
| An operator applies 049 without the env var (or the reverse) | `/api/admin/stats` reports `minDepositSync.ok=false` and the server logs an explicit MISMATCH line naming migration 049 |
| A funded customer is prompted to buy a licence | grandfather branch is checked before the licence read, and proven during a Payhip outage |
| A customer buys twice, or a licence is shared | unique sale id + unique licence hash + `FOR UPDATE` claim + `claimed_by_other_account`; all pinned |
| A refund is honoured but the account stays unlocked | refund webhook revokes the entitlement and the gate refuses the next Live start |
| A webhook is spoofed | token + sha256(API key) signature; unsigned payloads record nothing and answer 401 |
| The activation gate locks everyone out if Payhip is misconfigured | `PAYHIP_ACTIVATION_REQUIRED` is unset by default (gate inert), and an unreadable entitlement answers 503 "retry", never "buy again" |

---

## 9. What still needs the founder's approval

Nothing in this document was executed against production. The remaining gates:

1. **T10 - apply `049`, `050`, `051`** (`008`/`011` are already applied) and set
   `PLATFORM_MIN_DEPOSIT_USD=50` **in the same window** (step 4: 4a and 4b back to
   back, then re-run the step-2 probe).
2. **Step 5 - apply the rebrand** (`node scripts/relaunch-brand.js --to kalderix --with-tests --write`
   on the release tree) and deploy. Reversible by `git revert`.
3. **Step 6 - Payhip**: apply `050`, configure `PAYHIP_*`, run one live test-mode
   purchase, and only then set `PAYHIP_ACTIVATION_REQUIRED=true`.
4. **T1 - trademark clearance** for KALDERIX before public advertising. The code
   change is reversible; a name that has to change twice is not free.
5. **Merchant eligibility** for the activation product (Payhip's acceptable-use
   terms) - section `09` of the research. Not a code question.

Backup before any of it: `13-RELEASE-CHECKLIST-KALDERIX.md` section 3. Supabase
Free has no point-in-time recovery, so the dump is the only restore point.
