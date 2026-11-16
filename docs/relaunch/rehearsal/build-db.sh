#!/usr/bin/env bash
# Rebuilds the disposable rehearsal database with the release chain, in order,
# and proves the dual-schema and idempotency claims of migration 049.
#   usage: ./build-db.sh            (expect every line to end in rc=0)
set -u
CT=${SMOKE_CONTAINER:-kalderix-smoke}
DB=${SMOKE_DB:-smoke}
HERE=$(cd "$(dirname "$0")" && pwd)          # docs/relaunch/rehearsal
REPO=$(cd "$HERE/../../.." && pwd)           # repository root
LOG_DIR=${SMOKE_LOG_DIR:-$HERE/logs}
mkdir -p "$LOG_DIR"
DOCKER="docker"; docker version >/dev/null 2>&1 || DOCKER="sudo -n docker"
$DOCKER rm -f "$CT" >/dev/null 2>&1
$DOCKER run -d --name "$CT" -e POSTGRES_PASSWORD=t -e POSTGRES_DB="$DB" postgres:16-alpine >/dev/null
# Wait for a REAL query: pg_isready can succeed while the server is still
# starting up, which aborts the first migration for the wrong reason.
for i in $(seq 1 60); do
  $DOCKER exec "$CT" psql -U postgres -d "$DB" -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
run() { # run <path-on-host> <label>
  base=$(basename "$1")
  $DOCKER cp "$1" "$CT:/tmp/$base" >/dev/null 2>&1
  $DOCKER exec "$CT" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 -f "/tmp/$base" > "$LOG_DIR/log-$2.log" 2>&1 </dev/null
  printf "%-46s rc=%s\n" "$2" "$?"
}
run "$HERE/00_bootstrap.sql" "00 bootstrap + prerequisite stubs"
for m in 008_q8qpay_support 011_subscription_pro 049_min_deposit_50 050_payhip_live_activation 051_rebrand_subscription_detail; do
  run "$REPO/supabase/migrations/$m.sql" "$m"
done
echo "--- 049 against the alternative (key,value) schema"
$DOCKER exec "$CT" psql -U postgres -d "$DB" -q -c "create table public.rc_alt (key text primary key, value text); insert into public.rc_alt values ('minimum_qualifying_deposit','100');" >/dev/null 2>&1
$DOCKER exec "$CT" psql -U postgres -d "$DB" -q -c "alter table public.referral_config rename to referral_config_prod; alter table public.rc_alt rename to referral_config;" >/dev/null 2>&1
run "$REPO/supabase/migrations/049_min_deposit_50.sql" "049 on (key,value)"
$DOCKER exec "$CT" psql -U postgres -d "$DB" -q -c "alter table public.referral_config rename to rc_alt; alter table public.referral_config_prod rename to referral_config;" >/dev/null 2>&1
echo "--- idempotency (second apply of the release migrations)"
for m in 049_min_deposit_50 050_payhip_live_activation 051_rebrand_subscription_detail; do
  run "$REPO/supabase/migrations/$m.sql" "$m (re-apply)"
done
