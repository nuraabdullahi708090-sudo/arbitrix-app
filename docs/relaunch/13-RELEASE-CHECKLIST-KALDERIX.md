# 13 - KALDERIX RELAUNCH: MASTER RELEASE CHECKLIST

Status: **CODE MERGED AND DEPLOYED; DATABASE + PAYHIP STEPS PENDING - READ THIS FIRST.**

Deployed commit `3ee2c667` (PR #171) went live ~45 s after the merge. Branding,
routes and pages were verified against production and are recorded, with the raw
outputs, in `15-RELEASE-EXECUTION-LOG.md`. What remains: migrations `050`/`051`
(no database credential in the build environment) and the Payhip variables plus
the webhook registration.

Applied in production already (confirmed by the operator):

| Migration | State |
|---|---|
| `049_min_deposit_100.sql` | satisfied - `referral_config.minimum_qualifying_deposit` is `100` and the code's floor is `100` (nothing to run) |
| `052_charge_subscription_safe_privileges.sql` | APPLIED - security correction, verified |
| `053_financial_rpc_privilege_lockdown.sql` | APPLIED - 10 RPCs pinned to `search_path=public, pg_temp`, `anon`/`authenticated` EXECUTE revoked |

Still pending (this document): `050_payhip_live_activation.sql` and
`051_rebrand_subscription_detail.sql`, the environment variables, and the code
deploy. No further migration should be re-run without checking the table in
section 2.1 first.

The rest of the original status statement still holds for everything not listed
above: no push, no deploy, no environment variable and no customer-balance change
has been made by this repository.

Companion documents: `10-RELEASE-CHECKLIST.md` (Payhip detail and its walkthrough),
`03-MIN-DEPOSIT-50.md` (the $50 analysis), `12-KALDERIX-IDENTITY.md` (the identity).

---

## 0. Decisions of record

| # | Decision | Where it lands |
|---|---|---|
| D1 | Kalderix is the customer-facing brand; legal operator stays **Arbitrix Trading, KVK 72923513** (trading name) | step 5 |
| D2 | Minimum deposit **stays $100** (the $50 proposal was withdrawn). Nothing to change; 049 asserts the $100 floor | step 4 (verify only) |
| D3 | **Payhip Option A**: a purchase grants a one-time Live Mode activation only. **No wallet crediting.** Funding stays a separate Q8Pay deposit | step 6 |
| D4 | Q8Pay's decimal amount identification **stays** until a tested replacement exists | no change in this release |
| D5 | **Brazil** is the first target market, subject to regulatory positioning and compliant acquisition | not in this release |

Trademark clearance remains an open condition on D1 (section 8). The code changes
are reversible; a name that has to change twice is not free, so run the search
before step 5 if timing allows.

---

## 1. Pre-flight (do all of this first; it is all read-only)

```bash
git checkout main && git merge --ff-only origin/main     # confirm the base
git checkout relaunch/rebrand-payment-commercial
git status --porcelain                                   # must be empty
node scripts/verify-rebrand.js --expect Kalderix         # expect: ALL CHECKS PASSED
npm test                                                 # expect 0 failing tests (3422+ at the last run)
```

The identity is ALREADY APPLIED on this branch, so the verifier runs against the
real tree rather than a rehearsal copy - it is read-only and takes a second. Do
NOT run `scripts/relaunch-brand.js --write` again on `main`: it would only rewrite
what is already rewritten. Last run on this branch: **ALL CHECKS PASSED** with
**0 failing tests**; keep the transcript, it is the evidence that step 7 is
mechanical.

---

## 2. The order, and why it is this order

```
step 1  backup                     <- nothing is reversible without this
step 2  readiness probe            <- know what is already applied (052/053 are)
step 3  (optional) commit + push   <- code only; the app runs unchanged
step 4  $100 floor                 <- VERIFY ONLY: the value is already correct
step 5  rebrand: already in code   <- verify, deploy, expose
step 6  Payhip: 050 + 051, flags, gate <- last, because it is the only gate that
                                       can lock a customer out of Live Mode
```

Steps 4, 5 and 6 are independent. If one goes wrong, stop and roll it back
(section 7); the others can wait. Do **not** run two of them and then debug.

---

## 2.1 Migration status (checked in production, do not re-run blindly)

| File | State | Action in this release |
|---|---|---|
| `049_min_deposit_100.sql` | satisfied - `referral_config.minimum_qualifying_deposit = 100`, code floor `100` | none (verify only, step 4) |
| `050_payhip_live_activation.sql` | **NOT applied** - no `payhip_*` tables | apply (step 6) |
| `051_rebrand_subscription_detail.sql` | **NOT applied** - function still writes the pre-rename literal | apply AFTER the code deploy (step 7.4) |
| `052_charge_subscription_safe_privileges.sql` | APPLIED (operator, verified) | none |
| `053_financial_rpc_privilege_lockdown.sql` | APPLIED (operator, verified: all 10 RPCs pinned, anon/authenticated revoked) | none |

`048` is absent from the sequence and never existed in it; the numbering gap is
cosmetic and must not be "filled in". `supabase db push` is not usable (there is no
`supabase/config.toml`), so every migration is pasted into the SQL editor.

---

## 3. Step 1 - backup

**There is no backup script in this repository** (checked: no `scripts/backup*`,
no `docs/BACKUP_*` on `main` or on this branch). Do not look for one on release
day; run the dump directly. Supabase Free has **no scheduled backups and no
point-in-time recovery**, so this dump is the only restore point you will have.

```bash
# 1. credentials: Project Settings > Database > Connection string (session pooler, port 5432,
#    NOT the transaction pooler on 6543, which pg_dump cannot use).
cat > ~/.pgpass <<'EOF'
<host>:5432:postgres:<user>:<password>
EOF
chmod 600 ~/.pgpass

# 2. dump. Check pg_dump's OWN exit status - piping into another command hides it.
pg_dump -h <host> -U postgres -d postgres -Fc --no-owner \
        -f ~/backups/kalderix-$(date +%F).dump; echo "pg_dump exit=$?"

# 3. prove the file is not empty and is readable as an archive
ls -l ~/backups/kalderix-*.dump
pg_restore --list ~/backups/kalderix-$(date +%F).dump | head
sha256sum ~/backups/kalderix-$(date +%F).dump
```

`exit=0`, a non-zero size and a readable table of contents are the three checks.
A failed dump leaves a 0-byte file whose sha256 is `e3b0c442...` - if you see that
hash, nothing was dumped.

Restore test (optional but cheap if you have Docker):

```bash
docker run -d --name restore-test -e POSTGRES_PASSWORD=t postgres:16
sleep 5
docker exec restore-test psql -U postgres -c 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;'
docker exec -i restore-test pg_restore -U postgres -d postgres --no-owner < ~/backups/kalderix-$(date +%F).dump
docker exec restore-test psql -U postgres -c 'SELECT count(*) FROM users;'
docker rm -f restore-test
```

The three roles are pre-created because a Supabase dump grants to them; without
them `pg_restore` aborts on the first policy with a misleading error.

Not covered by `pg_dump`: **Storage objects**. The private `kyc-documents` bucket
holds identity documents. Export it separately (Supabase dashboard > Storage, or
the S3-compatible endpoint) if you want a complete restore point.

---

## 4. Step 2 - readiness probe (what is actually applied)

Already applied and verified by the operator: **052** and **053** (both security
only; nothing to re-run). Satisfied: **049** (the value is already `100`).
Pending: **050** and **051**.

Run these three probes, all SELECT-only, in the Supabase SQL editor.

### 4.1 050 - Payhip tables (the only blocker)

Paste **`docs/sql/payhip_050_readiness.sql`**. It prints eight rows and one
`NEXT ACTION`. Expected today, since the payhip tables were missing:

```
1 public.users exists                 OK     found
2 users.id is BIGINT                  OK     bigint - FK-compatible ...
3-5 roles anon/authenticated/service_role  OK
6 payhip objects present              OK     (none - a fresh apply will create all 11)
7 sequence names available            OK     all names are free
8 NEXT ACTION                         INFO   READY - apply ... then run payhip_050_postcheck.sql
```

`users.id is BIGINT` is not a formality: 050 declares
`payhip_entitlements.user_id BIGINT REFERENCES public.users(id)`, so a UUID key
would abort the migration on the foreign key. If that row says BLOCKER, stop.

### 4.2 049 and 051 - the $100 floor and the rebranded detail

```sql
-- READ-ONLY. Production's referral_config is (config_key, config_value, ...);
-- some environments use (key, value), so the columns are discovered first.
do $$
declare
  kcol text := case when exists (select 1 from information_schema.columns
                                  where table_schema = 'public'
                                    and table_name = 'referral_config'
                                    and column_name = 'config_key')
                    then 'config_key' else 'key' end;
  vcol text := case when exists (select 1 from information_schema.columns
                                  where table_schema = 'public'
                                    and table_name = 'referral_config'
                                    and column_name = 'config_value')
                    then 'config_value' else 'value' end;
  v text;
  ok boolean;
begin
  execute format('select %I from public.referral_config where %I = %L',
                 vcol, kcol, 'minimum_qualifying_deposit') into v;
  raise notice '049 platform minimum deposit : %',
    case when v = '100' then 'OK (100 - keep it)'
         else 'UNEXPECTED (' || coalesce(v, 'no row') || ') - see step 4' end;

  select exists (select 1 from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname = 'charge_subscription_safe'
                    and p.prosrc like '%Kalderix Pro Subscription%') into ok;
  raise notice '051 rebrand sub. detail      : %',
    case when ok then 'APPLIED' else 'NOT APPLIED (still writes the pre-rename literal)' end;
end $$;
```

### 4.3 Scope note

This release needs **050 and 051** only. 049's target state is already in place;
052 and 053 are already applied and must not be re-run. The 038-047 backlog
(marketing publisher, conversion outbox, conversation state) is independent and
disabled by its own flags; it can ship later without touching this release. Do not
apply it here "because it is on the list" - each of those has its own
prerequisites.

---

## 5. Step 3 - ship the code

```bash
git push origin relaunch/rebrand-payment-commercial:main
```

Render rebuilds. **This deploy DOES change what customers see: the product is
renamed to Kalderix** - the identity is in the code, not a release-time switch
(section 7.1). Everything financial stays inert because its knobs are off:
`PAYHIP_*` unset (activation gate and webhook inert) and
`PLATFORM_MIN_DEPOSIT_USD` unset (floor still $100 until step 4). Balances,
deposits, withdrawals, trading, referrals and the sandbox are unchanged.

Read section 7.3 straight after this deploy: it is the two-minute browser check of
the new identity (title, six locales, TOTP issuer, transaction labels, support
bot).

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://arbitrix.pro/api/health   # 200
curl -s https://arbitrix.pro/api/market/opportunities | head -c 120        # unchanged
curl -s -o /dev/null -w '%{http_code}\n' https://arbitrix.pro/partners     # 200
```

Rollback: `git revert <merge>` and push. Nothing external has changed yet.

---

## 6. Step 4 - verify the $100 minimum deposit (no change)

**The $50 proposal is withdrawn. The approved floor is $100 and it is already in
place.** Nothing is applied and no environment variable is set in this step; it is
a verification only.

| Check | Expected |
|---|---|
| probe 4.2 row 1 | `049 platform minimum deposit : OK (100 - keep it)` |
| `curl -s https://arbitrix.pro/api/deposit/options -H "Authorization: Bearer <jwt>"` | `minDeposit: 100` |
| the deposit modal's floor text | `$100` in all six locales |
| a $99.99 invoice | refused with the coded minimum error |
| a $100 invoice | created |
| the Referral card | qualifies a referral at a $100 deposit |

`PLATFORM_MIN_DEPOSIT_USD` must stay **unset**: the built-in default is 100 and
`049` asserts the referral side agrees. Setting it to 50 would reopen the exact
mismatch 049 exists to prevent (a $50 deposit funds the account while the referrer
never qualifies).

There is no rollback for this step because it changes nothing.

---

## 7. Step 5 - the Kalderix rebrand

### 7.1 What is left to DO

The code in this release commit already carries the identity (this branch was
renamed with `scripts/relaunch-brand.js --to kalderix --with-tests --write`), so
there is nothing to apply at release time:

```bash
node scripts/verify-rebrand.js --expect Kalderix     # must print ALL CHECKS PASSED
npm test                                             # must be 3311/3311
```

Then deploy as normal (step 3) and run the browser checks in 7.3. Only two things
remain outside the code:

| Item | Action | Approval |
|---|---|---|
| Transactional sender name | if production sets `EMAIL_FROM` explicitly, change its display name to `Kalderix <noreply@arbitrix.ai>`; the code default (`services/brand.js` `emailSender()`) already says Kalderix | needs the founder (env change) |
| Migration 051 | apply AFTER the code is live (7.4) | needs the founder |

Deliberately NOT part of this release: the domain (`arbitrix.pro`), the mail
domain (`arbitrix.ai`), the Telegram handles, the legal operator and the KVK
number. Kalderix is a trading name of Arbitrix Trading; changing any of the
above is a separate, founder-owned decision.

### 7.2 Assets (already generated, unchanged by the command)

`public/brand/kalderix-{mark,favicon,wordmark,social}.svg`. The app's own icons,
manifest and social card are built from `BRAND` at runtime, so nothing points at
these files - they are for e-mail, print and app-store use.

### 7.3 Verify after the deploy (two minutes, in a browser)

| Check | Expected |
|---|---|
| Browser tab title | `Kalderix | Automated Arbitrage Trading Platform` |
| 6 locales (`?lang=` / language selector) | product named Kalderix in all six; Arabic still RTL |
| TOTP setup | authenticator shows `Kalderix:you@example.com` |
| Deposit modal | no old name anywhere |
| Transaction history | the subscription row reads the localized "Pro subscription", whichever era it was written in |
| Support bot | `/start` and an unrelated question answer under the new name |
| Link preview (paste the URL in a chat) | Kalderix social card |
| Partners page, tutorial page, legal pages | new name, legal operator unchanged |

### 7.4 Migration 051 (after the code is live)

Verified on PostgreSQL 16.16 against the real migration-011 function body:

- applies cleanly and changes **exactly one** literal (`has_new = t`, `has_old = f`);
- re-applying is a byte-identical no-op (`reapply_is_noop = t`);
- its guard **refuses** a body that has lost the idempotency or `live_balance <` check.

The release-scope probe in section 4 reports `APPLIED` for it once applied.

```sql
-- after the code is live
\i supabase/migrations/051_rebrand_subscription_detail.sql
```

Only future subscription charges carry the new detail. Historical rows keep their
text by design, and the UI maps both eras. Applying it **before** the code deploy
would make new charges say Kalderix while the UI still said the old name.

### 7.5 Rollback

`git revert <rebrand commit>` and push. Migration 051 needs no rollback (it is a
string), but if you want the old detail back:

```sql
-- re-apply migration 011's function definition (it is still the authoritative body)
```

Nothing external is touched: domains, handles, mail, KVK and the legal entity are
unchanged by the rebrand, which is what makes this revert clean.

---

## 8. Step 6 - Payhip Option A (activation only)

Read `10-RELEASE-CHECKLIST.md` sections 2-4 before starting. Summary of the gate
order, because it is the part that can lock someone out:

1. Run `docs/sql/payhip_050_readiness.sql` (SELECT-only) and confirm the
   `NEXT ACTION` row says `READY`.
2. Apply `050_payhip_live_activation.sql` (additive; one transaction; inert
   without the flags). It is safe to re-run, but never re-run it blindly over a
   partial apply - `CREATE TABLE IF NOT EXISTS` keeps an existing table as-is.
3. Run `docs/sql/payhip_050_postcheck.sql`. Every row must be `OK`; the last
   `NEXT ACTION` row prints the SQL that enables the product.
4. **Enable the product** (this is what makes the buy button render - the
   catalogue row is created `is_active = FALSE` on purpose):

   ```sql
   INSERT INTO public.payhip_products (product_key, name, price_cents, is_active)
   VALUES ('dlxuu', 'Kalderix Live Mode activation', 5000, TRUE)
   ON CONFLICT (product_key) DO UPDATE SET is_active = TRUE;
   ```
5. **Before** setting anything, run
   `node scripts/check-payhip-readiness.js --base https://arbitrix.pro` after the
   deploy: it prints which variables are present and the single next action. On
   the pre-deploy build it correctly reports `NOT DEPLOYED` (the Payhip routes
   answer 404 until this branch is live), and after the deploy it distinguishes
   `503 + reason` (configuration incomplete) from `401 invalid_token` (configured;
   the URL registered in Payhip must carry `?token=`).
6. Set configuration in the order listed in doc 10 section 2. The product is
   `dLXuU` (`https://payhip.com/b/dLXuU`, one-time $50 activation):
   `PAYHIP_PRODUCTS=dLXuU`, `PAYHIP_STORE_URL=https://payhip.com/b/dLXuU`.
   Each row alone is safe; the behaviour change is the **last** row,
   `PAYHIP_ACTIVATION_REQUIRED=true`.
7. Before flipping that last row, run doc 10 section 4: prove the licence API
   answers with one real key, and walk one test account through purchase →
   redeem → Live Mode entry.
8. Flip the gate. **Funded accounts are grandfathered; the sandbox is exempt** -
   verify both before announcing anything.
9. `051_rebrand_subscription_detail.sql` belongs to the rebrand, not to Payhip:
   apply it only once the Kalderix build is live (step 7.4), so a subscription
   charge cannot write a brand the UI no longer shows.

What Option A explicitly does **not** do: credit a wallet, bonus balance or
trading balance; create a deposit; bypass the **$100** minimum, the withdrawal
minimum, the completed-trade rule or KYC. Funding is still a Q8Pay deposit.

Rollback: unset `PAYHIP_ACTIVATION_REQUIRED` (10 seconds, no deploy). Customers
keep their entitlement rows; nothing is refunded or deleted automatically.

**Blocking precondition:** written Payhip confirmation that this use is permitted
(`11-PAYHIP-ELIGIBILITY-INQUIRY.md`). Do not flip the gate before it arrives.

---

## 8b. Step 6b - the customer must SEE the promotional credit

A new account is seeded with a $50 promotional Live balance. Before this step that
money existed but was invisible until the customer worked out where to look, and a
Payhip-gated account saw only "Activation required". The dashboard now shows it
immediately, on the first screen, **without changing what the account can do**.

What a new customer sees (dashboard card, above the chart):

| Situation | Card |
|---|---|
| Registered, not activated | `$50.00 - Promotional Credit` + `Activation required` + an Activate button |
| Activated, nothing funded | no credit row + `Activated - funding required` |
| Activated with the credit intact | `$50.00 - Promotional Credit` + `Live Mode available` |
| Funded existing customer (no credit, activated) | card hidden - their dashboard is unchanged |
| MARKETING_SANDBOX | card hidden - simulated accounts have no credit |

The explanation under the amount is the approved sentence and states the two things
a customer must not learn the hard way: activation does not add trading capital, and
the promotional credit is subject to the platform's trading and withdrawal
conditions.

**Where the numbers come from.** `services/LiveModeStatus.js` derives them from facts
`server.js` already computes, and they are returned as a `liveMode` object by
`GET /api/auth/me`, `GET /api/live/activation` and `POST /api/live/activate`. The
browser renders that object verbatim (`renderLiveModeCard()`); it never derives
eligibility itself, so a tampered client can only change what the card *says*.

**What is deliberately unchanged** (pinned by `tests/promo_credit_display.test.js`):

* No wallet write, no RPC, no credit, no second entitlement: `/api/auth/me` stays a
  read-only GET, and the `$50` seed still exists only in wallet creation.
* The credit is **not** a qualifying deposit. `withdrawalFundingRequired` stays true
  for a promo-funded account, so the first-deposit rule before a withdrawal is
  untouched.
* The Payhip gate, the $100 minimum deposit, the $700 withdrawal minimum, the
  completed-trade rule and the $20 promotional profit cap are all untouched - the
  gates remain `/api/bot/start`, `/api/trade` and `/api/withdraw/request`.
* The amount displayed is the **remaining** promotional Live balance (so a customer
  who lost part of it sees the remainder, not a stale $50).

Verify after the deploy, with a fresh test account (no purchase, no deposit):

```bash
# 1. the server reports the credit and the gate
curl -s -H "Authorization: Bearer $JWT" https://arbitrix.pro/api/auth/me \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['liveMode'])"
# expect: status activation_required, promoCredit 50, withdrawalFundingRequired true

# 2. the card renders it (browser, signed in, 390px):
#    "$50.00 - Promotional Credit", chip "Activation required", Activate button,
#    and no "{{amount}}" placeholder anywhere.
```

Regression suite: `node --test tests/promo_credit_display.test.js` (17 checks).

---

## 9. Environment variables, in one table

| Variable | This release | Effect if set alone | Undo |
|---|---|---|---|
| `PLATFORM_MIN_DEPOSIT_USD` | **leave unset** (default `100`) | setting `50` funds an account the referrer never qualifies on → **inconsistent** | unset |
| `PAYHIP_ENABLED` | `true` (step 6) | endpoints stop returning 503; still no gate | unset |
| `PAYHIP_API_KEY` | store API key | enables signature verification only | unset |
| `PAYHIP_PRODUCTS` | `dLXuU` (link code) | nothing alone | unset |
| `PAYHIP_PRODUCT_SECRET` | product secret | nothing alone; **never** in a frontend or a log | unset |
| `PAYHIP_STORE_URL` | `https://payhip.com/b/dLXuU` | shows the buy button (the catalogue row must also be `is_active`) | unset |
| `PAYHIP_ACTIVATION_REQUIRED` | `true` (last) | **this is the behaviour change** | unset |

Not in this release: the marketing publisher flags, the conversion worker, the
trading worker (`TRADING_WORKER_ENABLED` stays unset) and `WITHDRAWAL_REQUIRES_VERIFICATION`.

---

## 10. Rollback matrix

| Step | Undo | Time | Customer-visible effect of the undo |
|---|---|---|---|
| 3 code | `git revert` + push | 5 min | none (all knobs were off) |
| 4a migration 049 | one `UPDATE` (section 6) | 1 min | referral threshold back to $100 |
| 4b env | unset variable | 1 min | deposit floor back to $100 |
| 5 code | `git revert` + push | 5 min | old name returns |
| 5 migration 051 | re-apply 011 body | 2 min | future charges use the old detail |
| 6 Payhip | unset `PAYHIP_ACTIVATION_REQUIRED` | 10 sec | Live Mode gate off; entitlements kept |

No step in this release touches a balance, a withdrawal rule or a trading
safeguard, so no rollback can strand money.

---

## 11. External dependencies still open

| # | Item | Blocks | Owner |
|---|---|---|---|
| 1 | Trademark search / clearance for Kalderix | final commitment to D1 (not the code) | founder + counsel |
| 2 | Domain: keep `arbitrix.pro`, or acquire and redirect | nothing in this release | founder |
| 3 | Telegram handle rename (optional) | nothing; handles stay protected | founder |
| 4 | Written Payhip eligibility confirmation | step 6 only | founder |
| 5 | Payhip product created with licence keys enabled + one live API test | step 6 only | founder |
| 6 | Q8Pay fees/limits confirmation for $50 tickets | step 4 economics | founder |
| 7 | Brazil: regulatory positioning, ad eligibility, PT-BR support cover | D5 | founder + counsel |

---

## 12. What is deliberately NOT in this release

- No trading-engine change, no risk-limit change, no wallet or balance code change.
- No withdrawal-rule change ($700 minimum, KYC flag and gate order untouched).
- No Payhip wallet crediting - Option A is activation only.
- No Q8Pay identification change (decimal amounts stay).
- No market launch, no ad spend, no merchant application.
- No migration outside 049/050/051, and no change to the 038-047 backlog.
