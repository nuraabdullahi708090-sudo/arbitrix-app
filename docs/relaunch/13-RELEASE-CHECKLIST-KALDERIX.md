# 13 - KALDERIX RELAUNCH: MASTER RELEASE CHECKLIST

Status: **NOTHING IN THIS DOCUMENT HAS BEEN EXECUTED.** No push, no deploy, no
migration, no environment variable, no customer-balance change. This is the
sequence to run after the final production approval.

Companion documents: `10-RELEASE-CHECKLIST.md` (Payhip detail and its walkthrough),
`03-MIN-DEPOSIT-50.md` (the $50 analysis), `12-KALDERIX-IDENTITY.md` (the identity).

---

## 0. Decisions of record

| # | Decision | Where it lands |
|---|---|---|
| D1 | Kalderix is the customer-facing brand; legal operator stays **Arbitrix Trading, KVK 72923513** (trading name) | step 5 |
| D2 | Minimum deposit moves to **$50**, environment variable and referral config applied **together** | step 4 |
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
npm test                                                 # expect 3311 pass, 0 fail
```

The identity is ALREADY APPLIED on this branch, so the verifier runs against the
real tree rather than a rehearsal copy - it is read-only and takes a second. Do
NOT run `scripts/relaunch-brand.js --write` again on `main`: it would only rewrite
what is already rewritten. Last run on this branch: **ALL CHECKS PASSED** and
**3311/3311**; keep the transcript, it is the evidence that step 5 is mechanical.

---

## 2. The order, and why it is this order

```
step 1  backup                     <- nothing is reversible without this
step 2  readiness probe            <- know what is already applied
step 3  (optional) commit + push   <- code only; the app runs unchanged
step 4  $50: migration 049 + env   <- coordinated, one minute apart at most
step 5  rebrand: already in code   <- verify, deploy, expose
step 6  Payhip: 050, flags, gate   <- last, because it is the only gate that
                                       can lock a customer out of Live Mode
```

Steps 4, 5 and 6 are independent. If one goes wrong, stop and roll it back
(section 7); the others can wait. Do **not** run two of them and then debug.

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

`docs/sql/telegram_db_readiness.sql` covers the Telegram/marketing backlog
(038-046) and is SELECT-only. **It does not know about 045, 047, 049, 050 or 051** -
they were written after it - so run the short probe below for the three migrations
this release actually needs. Also SELECT-only; paste both into the SQL editor.

```sql
-- READ-ONLY. Production's referral_config is (config_key, config_value,
-- description, ...), while some environments use (key, value). A literal
-- "WHERE key = ..." therefore FAILS on production, so this probe discovers the
-- column names first and prints one NOTICE per migration.
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
  raise notice '049 min deposit 50          : %',
    case when v = '50' then 'APPLIED (50)'
         else 'NOT APPLIED (currently ' || coalesce(v, 'no row') || ')' end;

  select to_regclass('public.payhip_purchases') is not null
     and to_regclass('public.payhip_entitlements') is not null
     and to_regclass('public.payhip_products') is not null into ok;
  raise notice '050 payhip live activation  : %',
    case when ok then 'APPLIED' else 'NOT APPLIED' end;

  select exists (select 1 from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname = 'charge_subscription_safe'
                    and p.prosrc like '%Pro Subscription%'
                    and p.prosrc not like '%' || 'Arbitrix' || ' Pro Subscription%') into ok;
  raise notice '051 rebrand sub. detail     : %',
    case when ok then 'APPLIED'
         else 'NOT APPLIED (or still writes the pre-rename literal)' end;
end $$;
```

Read every row before proceeding. If 049 already returns `APPLIED (50)`, skip 4a.

**Scope note:** this release needs **049, 050 and 051** only. The 038-047 backlog
(marketing publisher, conversion outbox, conversation state) is independent and
disabled by its own flags; it can ship later without touching this release. Do not
apply it here "because it is on the list" - each of those has its own prerequisites.

---

## 5. Step 3 - ship the code (no behaviour change)

```bash
git push origin relaunch/rebrand-payment-commercial:main
```

Render rebuilds. Expected effect on customers: **none**. Every knob is off:
`PAYHIP_*` unset (feature inert), `PLATFORM_MIN_DEPOSIT_USD` unset (floor $100),
identity not applied (the candidate is data, `applyBrandAssets()` returns early).

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://arbitrix.pro/api/health   # 200
curl -s https://arbitrix.pro/api/market/opportunities | head -c 120        # unchanged
curl -s -o /dev/null -w '%{http_code}\n' https://arbitrix.pro/partners     # 200
```

Rollback: `git revert <merge>` and push. Nothing external has changed yet.

---

## 6. Step 4 - the $50 minimum deposit

**These two are one step. Run them back to back.**

| Order | Action | Verification |
|---|---|---|
| 4a | Apply `supabase/migrations/049_min_deposit_50.sql` | re-run the step-2 probe → `049 min deposit 50 : APPLIED (50)` (the probe is schema-agnostic; a literal `WHERE key = ...` fails on production, whose columns are `config_key`/`config_value`) |
| 4b | Render → Environment → add `PLATFORM_MIN_DEPOSIT_USD=50` → save (restart) | `/api/health` 200; the deposit modal shows a $50 floor |

Why together: the environment variable governs invoice validation and the sandbox
floor; the migration governs referral qualification. Split them and a $50 deposit
succeeds while the referrer is still short of the $100 threshold - the referrer is
then told a qualified referral did not qualify.

Post-checks, in a real account (no money moves until you actually pay):

- the deposit modal's floor text and the minimum error both say $50;
- `/api/deposit/options` reports `minDeposit: 50`;
- a $50 invoice is created; a $49.99 one is refused with the coded error;
- referral qualification notes the new threshold on the Referral card.

**Expected business effect:** an existing referrer who was qualified at $100 is
unaffected (rows are historical). New referrals qualify at $50. If the referral
reward is 20%, a $50 deposit now pays $10 - confirm that is intended.

Rollback (under a minute, no deploy): clear `PLATFORM_MIN_DEPOSIT_USD`, then

```sql
UPDATE public.referral_config SET value = '100'
 WHERE key = 'minimum_qualifying_deposit' AND value = '50';
```

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

1. Apply `050_payhip_live_activation.sql` (additive; inert without the flags).
2. Set configuration in the order listed in doc 10 section 2. Each row alone is
   safe; the behaviour change is the **last** row, `PAYHIP_ACTIVATION_REQUIRED=true`.
3. Before flipping that last row, run doc 10 section 4: prove the licence API
   answers with one real key, and walk one test account through purchase →
   redeem → Live Mode entry.
4. Flip the gate. **Funded accounts are grandfathered; the sandbox is exempt** -
   verify both before announcing anything.

What Option A explicitly does **not** do: credit a wallet, bonus balance or
trading balance; create a deposit; bypass the $50 minimum, the withdrawal minimum,
the completed-trade rule or KYC. Funding is still a Q8Pay deposit.

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
* The Payhip gate, the $50 minimum deposit, the $700 withdrawal minimum, the
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
| `PLATFORM_MIN_DEPOSIT_USD` | `50` (step 4, **with** 049) | floor $50; referral still $100 → **inconsistent** | unset |
| `PAYHIP_ENABLED` | `true` (step 6) | endpoints stop returning 503; still no gate | unset |
| `PAYHIP_API_KEY` | store API key | enables signature verification only | unset |
| `PAYHIP_PRODUCTS` | product link code(s) | nothing alone | unset |
| `PAYHIP_PRODUCT_SECRET` | product secret | nothing alone; **never** in a frontend or a log | unset |
| `PAYHIP_STORE_URL` | `https://payhip.com/b/<code>` | shows the buy button | unset |
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
