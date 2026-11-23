'use strict';

/**
 * Scenario-driven Supabase substitute for the authentication entry-point tests.
 *
 * It answers only what the login / registration / 2FA-selection path reads, so
 * the tests can boot the REAL server and exercise REAL HTTP without a database.
 *
 *   AUTH_SCENARIO_FILE  path to the current scenario document
 *
 * Scenario keys:
 *   user           - the single account the store knows about (or null)
 *   twofaType      - value returned for the `2fa_type` feature flag
 *   twofaEnabled   - whether twofa_profiles reports an enabled TOTP profile
 *   usersError     - force a 500 on the users lookup
 *
 * Everything is re-read on each request, so a test can flip `twofaEnabled`
 * between calls while the server keeps running.
 */

const fs = require('fs');

const SCENARIO_FILE = process.env.AUTH_SCENARIO_FILE || '';

function scenario() {
  try { return JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function log(line) { process.stderr.write('[fake-supabase-auth] ' + line + '\n'); }

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function noRows() {
  return json(406, {
    code: 'PGRST116',
    details: 'The result contains 0 rows',
    hint: null,
    message: 'JSON object requested, multiple (or no) rows returned'
  });
}

function wantsSingle(init) {
  const headers = init && init.headers;
  if (!headers) return false;
  const accept = typeof headers.get === 'function' ? headers.get('accept') : (headers.Accept || headers.accept);
  return String(accept || '').indexOf('pgrst.object') !== -1;
}

function param(parsed, name) {
  const raw = parsed.searchParams.get(name);
  return raw == null ? null : decodeURIComponent(raw);
}

globalThis.fetch = async function fakeAuthFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const parsed = new URL(url);
  const method = ((init && init.method) || 'GET').toUpperCase();
  const sc = scenario();

  if (!/\/rest\/v1\//.test(parsed.pathname)) {
    log('BLOCKED ' + parsed.hostname);
    throw new Error('offline auth harness blocked ' + parsed.hostname);
  }

  const table = parsed.pathname.replace('/rest/v1/', '');
  const single = wantsSingle(init);
  log(method + ' ' + table + (parsed.search || ''));

  // Optional artificial latency, used to prove that a route does NOT wait for
  // background database work before answering (scenario.delays = { table: ms }).
  const delayMs = sc.delays && Number(sc.delays[table]);
  if (delayMs > 0) {
    await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
  }

  if (table === 'users') {
    if (method === 'GET') {
      if (sc.usersError) return json(500, { code: 'XX000', message: 'users store unavailable' });
      // `users` (array) models several accounts, e.g. the pre-index ambiguity of
      // two addresses that differ only in case; `user` stays the single-account
      // shorthand every existing scenario uses.
      const accounts = Array.isArray(sc.users) ? sc.users : (sc.user ? [sc.user] : []);
      // PostgREST puts the operator INSIDE the value: email=eq.x@y / email=ilike.x@y.
      const filter = param(parsed, 'email');
      const pattern = filter;
      if (filter && filter.indexOf('eq.') === 0) {
        const wanted = filter.slice(3);
        const hit = accounts.filter(function (u) { return u && u.email === wanted; });
        // PostgREST answers 200 [] for an array request with no rows; 406 is only
        // for a `.single()` request. The helper layer relies on that distinction.
        if (hit.length === 0) return single ? noRows() : json(200, []);
        return json(200, single ? hit[0] : hit);
      }
      if (pattern && pattern.indexOf('ilike.') === 0) {
        // The caller escapes SQL wildcards with a backslash; the tests use plain
        // addresses, so a literal, case-insensitive comparison is faithful enough.
        const wanted = pattern.slice(6).replace(/\\(.)/g, '$1').toLowerCase();
        const hits = accounts.filter(function (u) {
          return u && String(u.email).toLowerCase() === wanted;
        });
        return json(200, hits);
      }
      // Unknown referral code, or a listing query.
      if (filter || param(parsed, 'referral_code')) return single ? noRows() : json(200, []);
      return json(200, accounts);
    }
    if (method === 'POST') {
      if (sc.insertError) {
        return json(409, { code: sc.insertError.code || '23505', message: sc.insertError.message || 'duplicate key value' });
      }
      let body = {};
      try { body = JSON.parse(init.body || '{}'); } catch (e) { body = {}; }
      const row = Object.assign({ id: 9001, environment: 'PRODUCTION' }, body);
      return json(201, single ? row : [row]);
    }
    return json(200, []);
  }

  if (table === 'feature_flags') {
    if (sc.twofaType) {
      return json(200, single ? { flag_value: sc.twofaType } : [{ flag_value: sc.twofaType }]);
    }
    return noRows();
  }

  if (table === 'twofa_profiles') {
    if (sc.twofaEnabled) {
      const row = { id: 1, user_id: sc.user ? sc.user.id : 1, is_enabled: true, is_verified: true };
      return json(200, single ? row : [row]);
    }
    return noRows();
  }

  if (table === 'wallets') {
    if (method === 'GET') {
      const row = {
        user_id: sc.user ? sc.user.id : 1,
        live_balance: 0,
        demo_balance: 0,
        bonus_balance: 0
      };
      return json(200, single ? row : [row]);
    }
    return json(201, []);
  }

  if (table === 'revoked_tokens' || table === 'email_verification_codes') {
    return json(200, method === 'GET' ? [] : []);
  }

  // Everything else: no rows, which is what the unrelated startup reads expect.
  return json(200, single ? {} : []);
};
