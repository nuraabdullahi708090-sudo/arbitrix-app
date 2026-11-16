# Relaunch rehearsal kit

Reproduces the evidence in `../14-PRODUCTION-SMOKE-REHEARSAL.md`: the release
migrations against a real PostgreSQL, and 45 behavioural checks that drive the
real server over HTTP.

Nothing here touches production. The server copy is pointed at a **local** URL and
refuses any other host, Payhip's licence API is a local stub, and the database is a
throwaway container.

## What each file is

| File | Role |
|---|---|
| `00_bootstrap.sql` | the schema fixture the release migrations expect (users, wallets, deposits, referrals, bot sessions, …). Not a product migration. |
| `build-db.sh` | starts the container and applies `008 -> 011 -> 049 -> 050 -> 051`, then re-applies 049/050/051 and applies 049 again against the alternative `(key,value)` schema. Every line must end `rc=0`. |
| `shim.js` | a **PostgREST-shaped adapter** over psql, so the unmodified server can talk to a plain PostgreSQL. See the fidelity note below. |
| `payhip-stub.js` | a local Payhip licence API with a valid / disabled / wrong-product matrix. |
| `harness.js` | the 45 checks (brand, existing customer, activation, $50, subscription detail, withdrawal, collateral damage). |
| `server.env.example` | the environment the rehearsal server ran with. |

## Run it

```bash
# 1. database
./build-db.sh

# 2. Supabase adapter + Payhip stub
SHIM_KEYS=smoke-anon-key,smoke-service-key node shim.js &   # :5431
node payhip-stub.js &                                       # :5432

# 3. a disposable copy of the tree (apply the rebrand if you are rehearsing step 5)
mkdir -p /tmp/rehearsal && (cd ../.. && tar -cf - --exclude=node_modules --exclude=.git .) | tar -xf - -C /tmp/rehearsal
ln -s "$PWD/node_modules" /tmp/rehearsal/node_modules
(cd /tmp/rehearsal && node scripts/relaunch-brand.js --to kalderix --with-tests --write \
                 && node scripts/verify-rebrand.js --expect Kalderix)

# 4. the server, from the copy
(cd /tmp/rehearsal && env $(grep -v '^#' docs/relaunch/rehearsal/server.env.example | xargs) \
   node server.js > /tmp/rehearsal-server.log 2>&1 &)

# 5. the checks
node harness.js           # expect: 45/45 checks passed
```

Two negative controls prove the harness can fail. Run either, then restore:

```bash
PAYHIP_ACTIVATION_REQUIRED=false  node harness.js   # expect 6 failures, incl. C1
PLATFORM_MIN_DEPOSIT_USD=100      node harness.js   # expect 3 failures, incl. minDepositSync ok:false
```

## Fidelity note (read before trusting a green run)

`shim.js` is an approximation of PostgREST, written to exercise the real RPCs. It
is faithful for: SELECT/INSERT/UPDATE/DELETE with filters, `select` projections,
resource embedding (`alias:table!fk(cols)`), `on_conflict` upserts, `Prefer:
return=representation`, boolean coercion and `single()` semantics. It does **not**
implement RLS, `or=` filters, range pagination, storage, auth, or real latency.
Four defects in the shim were found and fixed while building this kit (derived-table
INSERT/UPDATE must be a CTE; PATCH must honour `return=representation`; boolean
columns need `TRUE/FALSE`; embedding needs expansion). If a check fails in a way
that looks like a database error, suspect the shim before the product.

The rehearsal therefore proves **application behaviour and SQL logic**. It does not
prove Supabase RLS enforcement, network behaviour, or a real Payhip response — see
section 7 of the report.
