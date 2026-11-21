-- ============================================================================
-- promo_cap_055_readiness.sql
--
-- READ-ONLY pre-flight and post-check for supabase/migrations/055_promo_trading_cap_30.sql.
--
-- Every statement here is a SELECT over the catalogues. Nothing is created,
-- altered, granted or written, so this file is safe to run at any time,
-- including against production.
--
-- WHAT THIS ANSWERS (without guessing):
--   1. Is a promotional-cap function installed at all, and under which name?
--      (026 named it enforce_promo_trade_cap(); an older straggler under another
--       name would mean two triggers fire and the LOWER one wins.)
--   2. What threshold does the ACTIVE function body actually compare against?
--      The value is EXTRACTED FROM pg_proc.prosrc, not assumed, so a stale 026
--      install cannot be mistaken for 055.
--   3. Is the trigger attached to public.trades, and how many are attached?
--   4. What is the NEXT ACTION: nothing, apply 055, or inspect by hand.
--
-- THE RULE:  a PRODUCTION user whose non-deposited Live capital is the $50
-- promotional credit may realize at most $30.00 net profit. The comparison is
-- INCLUSIVE (>= 30.00 locks). A confirmed deposit or a referral-earnings
-- conversion exempts the account, and MARKETING_SANDBOX is always exempt.
-- server.js / services/PromoCheck.js enforce $30 in the application; the
-- trigger is defence-in-depth against concurrent inserts.
--
-- USAGE
--   1. Run "SNAPSHOT" below and record the four numbers.
--   2. Run section A. Read the NEXT ACTION row.
--   3. If it says APPLY 055, apply supabase/migrations/055_promo_trading_cap_30.sql
--      in the Supabase SQL Editor (single statement batch, as with 026).
--   4. Re-run section A and then section B. All rows must say OK.
--   5. Re-run "SNAPSHOT" and confirm the numbers are IDENTICAL. A migration that
--      changes a balance or a ledger row is a defect, not a side effect.
-- ============================================================================


-- ============================================================================
-- SNAPSHOT - run before and after. The numbers must not change.
-- ============================================================================
select 'SNAPSHOT wallets' as metric,
       count(*)::text as rows,
       coalesce(sum(live_balance), 0)::text as live_total,
       coalesce(sum(demo_balance), 0)::text as demo_total,
       coalesce(sum(bonus_balance), 0)::text as bonus_total
  from public.wallets
union all
select 'SNAPSHOT trades',
       count(*)::text,
       coalesce(sum(amount), 0)::text,
       count(*) filter (where mode = 'live')::text,
       count(*) filter (where mode <> 'live')::text
  from public.trades;


-- ============================================================================
-- A. CAP STATE
-- ============================================================================
with
-- every candidate function whose name mentions the cap, whatever it is called
candidates as (
  select p.oid,
         p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         coalesce(p.prosrc, '') as body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname ilike '%promo%' or p.proname ilike '%trade_cap%')
),
-- the threshold(s) the live body compares against
thresholds as (
  select c.proname,
         coalesce(string_agg(distinct m[1], ',' order by m[1]), '(none found)') as values
    from candidates c
    left join lateral regexp_matches(c.body, '>=[[:space:]]*([0-9]+(?:\.[0-9]+)?)', 'g') m on true
   group by c.proname
),
triggers_on_trades as (
  select t.tgname,
         p.proname as fn,
         t.tgenabled
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
   where n.nspname = 'public'
     and c.relname = 'trades'
     and not t.tgisinternal
),
verdict as (
  select
    (select count(*) from candidates) as fn_count,
    (select count(*) from triggers_on_trades) as trigger_count,
    (select string_agg(proname || '(' || args || ') -> ' || values, ' | ' order by proname)
       from thresholds) as fn_thresholds,
    (select string_agg(tgname || ' -> ' || fn || ' [enabled=' || tgenabled || ']', ', ')
       from triggers_on_trades) as trigger_list,
    exists (
      select 1 from thresholds where values = '30'
    ) as has_30,
    exists (
      select 1 from thresholds where values like '%20%' and values not like '%30%'
    ) as has_20_only
)
select 'A1 cap function installed' as item,
       case when fn_count > 0 then 'OK' else 'ABSENT' end as result,
       coalesce(fn_thresholds, '(no promotional-cap function)') as detail
  from verdict
union all
select 'A2 trigger on public.trades',
       case when trigger_count = 1 then 'OK'
            when trigger_count = 0 then 'ABSENT'
            else 'DUPLICATE' end,
       coalesce(trigger_list, '(no trigger attached)')
  from verdict
union all
select 'A3 threshold aligns with the server ($30)',
       case when has_30 and not has_20_only then 'OK'
            when has_20_only then 'MISMATCH'
            when fn_count = 0 then 'ABSENT'
            else 'INSPECT' end,
       case when has_20_only then 'the active function still locks at $20 (migration 026 only)'
            when has_30 then 'the active function locks at $30 (migration 055)'
            when fn_count = 0 then 'application enforces $30; no database backstop'
            else 'an unexpected threshold was extracted - read A1' end
  from verdict
union all
select 'A4 duplicate cap functions',
       case when fn_count <= 1 then 'OK' else 'INSPECT' end,
       case when fn_count <= 1 then 'at most one cap function'
            else 'more than one candidate: the lower threshold would win' end
  from verdict
union all
select 'NEXT ACTION',
       case when has_30 and not has_20_only and trigger_count = 1 then 'DONE'
            when has_20_only then 'APPLY 055'
            when fn_count = 0 then 'APPLY 055 (optional backstop)'
            else 'INSPECT BY HAND' end,
       case when has_30 and not has_20_only and trigger_count = 1
              then 'database and application agree on $30 - nothing to do'
            when has_20_only
              then 'run supabase/migrations/055_promo_trading_cap_30.sql, then re-run section A and B'
            when fn_count = 0
              then 'server.js/services/PromoCheck.js already enforce $30; applying 055 adds the concurrency backstop'
            else 'unknown threshold extracted - do not apply anything until A1 is explained' end
  from verdict;


-- ============================================================================
-- B. POST-APPLY ASSERTIONS - run after section A says APPLY 055
-- ============================================================================
with
fn as (
  select coalesce(p.prosrc, '') as body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'enforce_promo_trade_cap'
   limit 1
),
trg as (
  select count(*) as n
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname = 'trades' and not t.tgisinternal
     and t.tgname ilike '%promo%'
)
select 'B1 function body locks at 30' as item,
       case when (select body from fn) ~ '>=[[:space:]]*30' then 'OK' else 'FAIL' end as result,
       'expected >= 30 in enforce_promo_trade_cap()' as detail
union all
select 'B2 no stale 20 comparison remains',
       case when (select body from fn) ~ '>=[[:space:]]*20([^0-9]|$)' then 'FAIL' else 'OK' end,
       'a remaining >= 20 would refuse a user the server allows'
union all
select 'B3 exactly one promotional trigger',
       case when (select n from trg) = 1 then 'OK' else 'FAIL' end,
       'count = ' || (select n::text from trg)
union all
select 'B4 the rule still fails open',
       case when (select body from fn) ilike '%EXCEPTION WHEN OTHERS%' then 'OK' else 'FAIL' end,
       'an exception handler keeps a catalog/RLS problem from blocking trades'
union all
select 'B5 the sandbox stays exempt',
       case when (select body from fn) ilike '%MARKETING_SANDBOX%' then 'OK' else 'FAIL' end,
       'MARKETING_SANDBOX must never be capped'
union all
select 'B6 the trigger writes no money',
       case when (select body from fn) ~* '(update|delete|insert)[[:space:]]+public\.(wallets|trades|transactions)' then 'FAIL' else 'OK' end,
       'the cap is a refusal, never a correction';
