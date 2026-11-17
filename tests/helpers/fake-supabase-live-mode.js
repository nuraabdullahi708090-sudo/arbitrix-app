'use strict';

/**
 * Scenario-driven Supabase substitute for the Live Mode eligibility tests.
 *
 * The real gate reads two facts - the Payhip entitlement and the confirmed
 * deposit total - from the database, and the redeem route calls Payhip's licence
 * API. This harness answers both from a JSON file that the test rewrites between
 * scenarios, so one booted server can exercise every combination over real HTTP
 * (no source-string assertions, no production traffic).
 *
 *   LM_SCENARIO_FILE  path to the current scenario document
 *
 * Scenario keys: activation ('true'|false|'error'), deposits, invoices,
 * depositsError, balance, environment, verifyHttp, verifyBody, rpcResult,
 * session. Everything is read fresh on each request.
 */

const fs = require('fs');

const SCENARIO_FILE = process.env.LM_SCENARIO_FILE || '';

function scenario() {
  try { return JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function log(line) { process.stderr.write('[fake-supabase] ' + line + '\n'); }

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function wantsSingle(init) {
  const h = init && init.headers;
  if (!h) return false;
  const accept = typeof h.get === 'function' ? h.get('accept') : (h.Accept || h.accept);
  return String(accept || '').indexOf('pgrst.object') !== -1;
}

globalThis.fetch = async function fakeFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const parsed = new URL(url);
  const method = ((init && init.method) || 'GET').toUpperCase();
  log(method + ' ' + parsed.pathname + (parsed.search || ''));
  const sc = scenario();

  // Payhip licence API.
  if (/(^|\.)payhip\.com$/.test(parsed.hostname)) {
    if (sc.verifyHttp && Number(sc.verifyHttp) !== 200) {
      return json(Number(sc.verifyHttp), { error: 'upstream unavailable' });
    }
    // Payhip answers { data: {...} }; the client reads body.data.
    return json(200, { data: sc.verifyBody || {} });
  }

  if (!/\/rest\/v1\//.test(parsed.pathname)) {
    log('BLOCKED ' + parsed.hostname);
    throw new Error('offline test harness blocked ' + parsed.hostname);
  }

  const table = parsed.pathname.replace('/rest/v1/', '');
  const single = wantsSingle(init);

  if (table === 'rpc/payhip_has_live_activation') {
    if (sc.activation === 'error') return json(500, { code: 'XX000', message: 'entitlement store unavailable' });
    return json(200, sc.activation === true);
  }
  if (table.indexOf('rpc/') === 0) {
    return json(200, sc.rpcResult || { success: false, reason: 'invalid_licence' });
  }

  if (table === 'users') {
    const row = {
      id: 7, name: 'Live Mode Test', email: 'live@example.test', referral_code: 'TEST01',
      is_admin: false, environment: sc.environment || 'PRODUCTION',
      created_at: '2026-01-01T00:00:00.000Z'
    };
    return json(200, single ? row : [row]);
  }
  if (table === 'wallets') {
    const row = {
      user_id: 7,
      live_balance: Number(sc.balance || 0),
      demo_balance: 1000,
      bonus_balance: 0
    };
    return json(200, single ? row : [row]);
  }
  if (table === 'deposits' || table === 'payment_invoices') {
    if (sc.depositsError) return json(500, { code: 'XX000', message: 'deposit store unavailable' });
    if (method !== 'GET') return json(201, []);
    return json(200, (table === 'deposits' ? sc.deposits : sc.invoices) || []);
  }
  if (table === 'bot_worker_control') {
    return json(200, single ? { id: 1, emergency_stop: false } : [{ id: 1, emergency_stop: false }]);
  }
  if (table === 'bot_sessions') {
    if (single) {
      return json(200, sc.session || {
        id: 1, user_id: 7, is_running: false, mode: 'live', generation: 1,
        heartbeat_at: null, claimed_by: null, lease_expires_at: null
      });
    }
    return json(200, method === 'GET' ? [] : [{ id: 1, user_id: 7 }]);
  }

  // Everything else: no rows, which is what the auth/revocation reads expect.
  return json(200, single ? {} : []);
};
