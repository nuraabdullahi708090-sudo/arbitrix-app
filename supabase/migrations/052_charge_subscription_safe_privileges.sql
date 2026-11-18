-- ============================================================================
-- 052 - EXECUTE privileges for public.charge_subscription_safe
-- ============================================================================
-- This migration is the VERSIONED TWIN of
-- docs/security/hotfix-charge-subscription-safe.sql. That script is the
-- emergency, single-object form an operator runs by hand in an approved change
-- window; this file records the same correction in the migration history so the
-- repository and the database cannot drift apart.
--
-- The two must stay equivalent. tests/charge_subscription_safe_hotfix.test.js
-- compares them statement by statement.
--
-- DEFECT
--   Migration 011 created charge_subscription_safe as SECURITY DEFINER with no
--   pinned search_path and no ACL. Migration 014 locked down record_trade_safe,
--   credit_payment_safe and paymento_credit_user_safe but NOT this one, and
--   PostgreSQL grants EXECUTE on a new function to PUBLIC by default. The body
--   takes p_user_id and p_price from the CALLER, so `anon` and `authenticated`
--   (anyone with the publishable key, which ships in the browser bundle) could
--   call POST /rest/v1/rpc/charge_subscription_safe and debit any user's
--   wallets.live_balance, choosing the amount and a fresh idempotency key each
--   time. SECURITY DEFINER also bypasses RLS and needs no table privileges, so
--   EXECUTE alone was sufficient.
--
-- FIX
--   * pin search_path (ALTER FUNCTION - the body is NOT recreated);
--   * revoke ALL from PUBLIC, anon and authenticated;
--   * grant EXECUTE to service_role, the only caller (server.js uses
--     supabaseAdmin.rpc('charge_subscription_safe', ...));
--   * close any unexpected overload of the same name, without granting it to
--     service_role, because no application code calls it.
--
-- SAFE TO RE-RUN: every statement is idempotent.
-- SAFE IF 051 IS LATER APPLIED: 051 re-creates the body (rebranded transaction
--   detail) and re-asserts the same ACL block, so the end state is identical.
--   Order 051 -> 052 or 052 -> 051 both converge.
-- ============================================================================

begin;

do $pre$
declare
    v_oid oid := to_regprocedure('public.charge_subscription_safe(bigint,numeric,text,text,text)');
begin
    if v_oid is null then
        raise exception
            '052 ABORTED: public.charge_subscription_safe(bigint,numeric,text,text,text) does not exist. Migration 011 must be applied first. Nothing was changed.';
    end if;
    if not (select prosecdef from pg_proc where oid = v_oid) then
        raise exception
            '052 ABORTED: charge_subscription_safe is SECURITY INVOKER - investigate before changing privileges. Nothing was changed.';
    end if;
end
$pre$;

create temporary table _m2_migration_state on commit drop as
select p.oid                       as fn_oid,
       md5(p.prosrc)               as body_md5,
       p.prosecdef                 as security_definer,
       p.prorettype::regtype::text as return_type,
       pg_get_function_identity_arguments(p.oid) as identity_args
from pg_proc p
where p.oid = to_regprocedure('public.charge_subscription_safe(bigint,numeric,text,text,text)');

alter function public.charge_subscription_safe(bigint, numeric, text, text, text)
    set search_path = public, pg_temp;

revoke all on function public.charge_subscription_safe(bigint, numeric, text, text, text) from public;
revoke all on function public.charge_subscription_safe(bigint, numeric, text, text, text) from anon;
revoke all on function public.charge_subscription_safe(bigint, numeric, text, text, text) from authenticated;
grant execute on function public.charge_subscription_safe(bigint, numeric, text, text, text) to service_role;

do $overloads$
declare
    r record;
    v_expected oid := to_regprocedure('public.charge_subscription_safe(bigint,numeric,text,text,text)');
begin
    for r in
        select p.oid, p.oid::regprocedure::text as sig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'charge_subscription_safe'
          and p.oid <> v_expected
    loop
        execute format('revoke all on function %s from public', r.sig);
        execute format('revoke all on function %s from anon', r.sig);
        execute format('revoke all on function %s from authenticated', r.sig);
        execute format('alter function %s set search_path = public, pg_temp', r.sig);
        raise notice '052 NOTE: unexpected overload % locked down but NOT granted to service_role - review manually.', r.sig;
    end loop;
end
$overloads$;

do $post$
declare
    v_oid       oid := to_regprocedure('public.charge_subscription_safe(bigint,numeric,text,text,text)');
    v_state     _m2_migration_state;
    v_proconfig text;
    v_public    boolean;
begin
    select * into v_state from _m2_migration_state;

    if md5((select prosrc from pg_proc where oid = v_oid)) <> v_state.body_md5 then
        raise exception '052 FAILED: the function body changed';
    end if;
    if pg_get_function_identity_arguments(v_oid) <> v_state.identity_args
       or (select prosecdef from pg_proc where oid = v_oid) is distinct from v_state.security_definer then
        raise exception '052 FAILED: the signature or security mode changed';
    end if;

    if has_function_privilege('anon', v_oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_oid, 'EXECUTE') then
        raise exception '052 FAILED: anonymous or authenticated EXECUTE survived';
    end if;

    select exists (
        select 1 from pg_proc p,
             aclexplode(case when p.proacl is null or cardinality(p.proacl) = 0
                             then null else p.proacl end) a
        where p.oid = v_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) into v_public;
    if v_public then
        raise exception '052 FAILED: PUBLIC still holds an explicit EXECUTE grant';
    end if;

    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
        raise exception '052 FAILED: service_role lost EXECUTE - subscription billing would break';
    end if;

    select coalesce(array_to_string(proconfig, ','), '') into v_proconfig from pg_proc where oid = v_oid;
    if v_proconfig !~ 'search_path=public, ?pg_temp' then
        raise exception '052 FAILED: search_path is not pinned (proconfig=%)', v_proconfig;
    end if;

    raise notice '052 OK: charge_subscription_safe privileges corrected (body md5 % unchanged)', v_state.body_md5;
end
$post$;

commit;

-- ROLLBACK (restores the pre-fix exposure - do NOT use except to undo the fix)
--   alter function public.charge_subscription_safe(bigint, numeric, text, text, text)
--       reset search_path;
--   grant execute on function public.charge_subscription_safe(bigint, numeric, text, text, text)
--       to anon, authenticated;
