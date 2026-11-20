-- ============================================================================
-- SECURITY HOTFIX - public.charge_subscription_safe
-- ============================================================================
-- Purpose : remove anonymous/authenticated EXECUTE and pin search_path on the
--           subscription debit RPC, WITHOUT touching its business logic.
--
-- Why     : the function is SECURITY DEFINER and its body trusts the CALLER for
--           both p_user_id and p_price. Migration 011 created it; migration 014
--           locked down record_trade_safe / credit_payment_safe /
--           paymento_credit_user_safe but NOT this function. PostgreSQL grants
--           EXECUTE on a new function to PUBLIC by default, so `anon` and
--           `authenticated` (i.e. anyone holding the publishable key, which is
--           shipped in the browser bundle) can invoke it through PostgREST and
--           debit ANY user's wallets.live_balance, repeatedly, choosing the
--           amount themselves. The function also ran with no pinned
--           search_path, so its unqualified references (wallets, subscriptions,
--           subscription_charges, transactions) resolve from the CALLER's
--           search_path.
--
-- Scope   : ONE function. No table, role, policy, data or other function is
--           modified. The body is NOT recreated - ALTER FUNCTION ... SET
--           search_path changes only the function's runtime configuration, so
--           the business logic is provably preserved (verified below by
--           comparing md5(prosrc) before and after).
--
-- Legitimate caller: the application server only, through the service-role
--   client (server.js: supabaseAdmin.rpc('charge_subscription_safe', ...) at
--   the subscription activation and billing paths). No browser, no anon key,
--   no end-user JWT ever needs EXECUTE. Granting service_role is therefore
--   evidence-based, not speculative.
--
-- Idempotent: re-running is a no-op (REVOKE/GRANT/ALTER are idempotent).
-- Fails safe: if the expected signature is absent, nothing is changed and the
--   transaction aborts with a clear message.
--
-- DO NOT RUN THIS FILE WITHOUT AN APPROVED CHANGE WINDOW. It is prepared for an
-- authorised operator; it is not applied by the application and not by CI.
-- ============================================================================

begin;

-- Refuse to proceed unless the exact production signature is present.
do $pre$
declare
    v_oid oid;
begin
    v_oid := to_regprocedure('public.charge_subscription_safe(bigint,numeric,text,text,text)');
    if v_oid is null then
        raise exception
            'HOTFIX ABORTED: public.charge_subscription_safe(bigint,numeric,text,text,text) does not exist. Nothing was changed. Verify the production signature with docs/security/verify-charge-subscription-safe.sql before retrying.';
    end if;

    if not (select prosecdef from pg_proc where oid = v_oid) then
        raise exception
            'HOTFIX ABORTED: the function is SECURITY INVOKER. That is an unexpected state - stop and investigate before changing privileges. Nothing was changed.';
    end if;
end
$pre$;

-- Snapshot the parts of the identity that the hotfix must not alter.
create temporary table _m2_hotfix_state on commit drop as
select p.oid                                              as fn_oid,
       md5(p.prosrc)                                      as body_md5,
       md5(pg_get_functiondef(p.oid))                     as definition_md5,
       p.prosecdef                                        as security_definer,
       p.prorettype::regtype::text                        as return_type,
       pg_get_function_identity_arguments(p.oid)          as identity_args,
       l.lanname                                          as language,
       p.provolatile                                      as volatility,
       p.proisstrict                                      as is_strict,
       coalesce(array_to_string(p.proconfig, ','), '')    as proconfig_before
from pg_proc p
join pg_language l on l.oid = p.prolang
where p.oid = to_regprocedure('public.charge_subscription_safe(bigint,numeric,text,text,text)');

-- 1. Pin search_path. This is the only change to the function itself and it
--    does not touch the body: ALTER FUNCTION ... SET is runtime configuration.
alter function public.charge_subscription_safe(bigint, numeric, text, text, text)
    set search_path = public, pg_temp;

-- 2. Close the ACL. REVOKE ALL also removes any grant that was inherited from
--    PUBLIC's default EXECUTE, which is the actual exposure.
revoke all on function public.charge_subscription_safe(bigint, numeric, text, text, text) from public;
revoke all on function public.charge_subscription_safe(bigint, numeric, text, text, text) from anon;
revoke all on function public.charge_subscription_safe(bigint, numeric, text, text, text) from authenticated;

-- 3. Keep the only legitimate caller working. The server uses the service-role
--    client (supabaseAdmin) for both the activation and the billing charge.
grant execute on function public.charge_subscription_safe(bigint, numeric, text, text, text) to service_role;

-- 4. Any OTHER overload of the same name is not expected in this schema. If one
--    exists it is closed too (fail closed) but deliberately NOT granted to
--    service_role, because no application code calls it - an operator must
--    review it. This cannot silently leave a vulnerable overload exposed.
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
        raise notice
            'HOTFIX NOTE: unexpected overload % was also locked down but NOT granted to service_role - review it manually.',
            r.sig;
    end loop;
end
$overloads$;

-- 5. Postconditions. Any failure aborts the whole transaction, so a partial
--    state cannot survive.
do $post$
declare
    v_oid        oid := to_regprocedure('public.charge_subscription_safe(bigint,numeric,text,text,text)');
    v_state      _m2_hotfix_state;
    v_proconfig  text;
    v_public_exec boolean;
begin
    select * into v_state from _m2_hotfix_state;

    if v_oid is null then
        raise exception 'HOTFIX FAILED: the function disappeared during the hotfix';
    end if;

    -- Business logic untouched: the body source must be byte-identical.
    if md5((select prosrc from pg_proc where oid = v_oid)) <> v_state.body_md5 then
        raise exception 'HOTFIX FAILED: the function BODY changed - roll back and investigate';
    end if;
    if (select prosecdef from pg_proc where oid = v_oid) is distinct from v_state.security_definer
       or (select prorettype::regtype::text from pg_proc where oid = v_oid) <> v_state.return_type
       or pg_get_function_identity_arguments(v_oid) <> v_state.identity_args then
        raise exception 'HOTFIX FAILED: the function signature or security mode changed';
    end if;

    -- Exposure closed.
    if has_function_privilege('anon', v_oid, 'EXECUTE') then
        raise exception 'HOTFIX FAILED: anon can still EXECUTE charge_subscription_safe';
    end if;
    if has_function_privilege('authenticated', v_oid, 'EXECUTE') then
        raise exception 'HOTFIX FAILED: authenticated can still EXECUTE charge_subscription_safe';
    end if;
    -- aclexplode() rejects an EMPTY array, so a NULL/default ACL is passed
    -- through as NULL (which yields no rows) instead of '{}'.
    select exists (
        select 1
        from pg_proc p,
             aclexplode(case when p.proacl is null or cardinality(p.proacl) = 0
                             then null else p.proacl end) a
        where p.oid = v_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) into v_public_exec;
    if v_public_exec then
        raise exception 'HOTFIX FAILED: PUBLIC still holds an explicit EXECUTE grant';
    end if;

    -- Legitimate caller preserved.
    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
        raise exception 'HOTFIX FAILED: service_role lost EXECUTE - subscription billing would break';
    end if;

    -- search_path pinned.
    select coalesce(array_to_string(proconfig, ','), '') into v_proconfig from pg_proc where oid = v_oid;
    if v_proconfig !~ 'search_path=public, ?pg_temp' then
        raise exception 'HOTFIX FAILED: search_path is not pinned (proconfig=%)', v_proconfig;
    end if;

    raise notice
        'HOTFIX OK: charge_subscription_safe(hotfix) - anon/authenticated/PUBLIC revoked, service_role kept, search_path=public, pg_temp, body md5 % unchanged',
        v_state.body_md5;
end
$post$;

commit;
