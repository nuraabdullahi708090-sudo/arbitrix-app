'use strict';

/**
 * Scenario-driven Supabase + Payhip substitute for the Payhip HTTP tests.
 *
 * The Payhip routes read/write: payhip_products, payhip_purchases, payhip_events,
 * the redeem/record/revoke/has-activation RPCs, plus the licence API. This harness
 * answers all of them from a JSON scenario file the test rewrites between cases,
 * so one booted server exercises every path over real HTTP.
 *
 * Scenario keys:
 *   activation      true | false | 'error'        (rpc payhip_has_live_activation)
 *   verifyHttp      200 | 404 | 500              (licence API status)
 *   verifyBody      { enabled, product_link, uses, buyer_email }
 *   rpcResult       object returned by redeem/record/revoke RPCs
 *   rpcError        true -> every RPC answers 500 (database outage)
 *   products        [{ product_key, is_active }] (payhip_products select)
 *   productsError   true -> payhip_products select answers 500
 *   isAdmin         true -> the users row reports is_admin
 *   environment     'PRODUCTION' | 'MARKETING_SANDBOX'
 */

const fs = require('fs');

const SCENARIO_FILE = process.env.PAYHIP_SCENARIO_FILE || '';
const RPC_LOG = process.env.PAYHIP_RPC_LOG || '';

function scenario() {
  try { return JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function log(line) { process.stderr.write('[fake-payhip] ' + line + '\n'); }

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

  // ---- Payhip licence API
  if (/(^|\.)payhip\.com$/.test(parsed.hostname)) {
    const status = Number(sc.verifyHttp || 200);
    if (status !== 200) return json(status, { error: 'payhip says no' });
    return json(200, { data: sc.verifyBody || {} });
  }

  if (!/\/rest\/v1\//.test(parsed.pathname)) {
    log('BLOCKED ' + parsed.hostname);
    throw new Error('offline harness blocked ' + parsed.hostname);
  }

  const table = parsed.pathname.replace('/rest/v1/', '');
  const single = wantsSingle(init);

  // ---- RPCs
  if (table === 'rpc/payhip_has_live_activation') {
    if (sc.activation === 'error' || sc.rpcError) return json(500, { code: 'XX000', message: 'db down' });
    return json(200, sc.activation === true);
  }
  if (table.indexOf('rpc/') === 0) {
    // Record the exact payload so a test can prove what the server sent (e.g.
    // that a client-supplied userId never reaches the RPC).
    if (RPC_LOG) {
      try {
        let payload = null;
        try { payload = init && init.body ? JSON.parse(init.body) : null; } catch (e) { payload = String(init && init.body); }
        fs.appendFileSync(RPC_LOG, JSON.stringify({ rpc: table.replace('rpc/', ''), payload }) + '\n');
      } catch (e) { /* logging must never break the fake */ }
    }
    if (sc.rpcError) return json(500, { code: 'XX000', message: 'db down' });
    return json(200, sc.rpcResult || { success: false, reason: 'invalid_licence' });
  }

  // ---- tables
  if (table === 'users') {
    const row = {
      id: 7, name: 'Payhip Tester', email: 'buyer@example.test', referral_code: 'PAYHIP1',
      is_admin: sc.isAdmin === true, environment: sc.environment || 'PRODUCTION',
      created_at: '2026-01-01T00:00:00.000Z'
    };
    return json(200, single ? row : [row]);
  }
  if (table === 'wallets') {
    const row = { user_id: 7, live_balance: Number(sc.balance || 0), demo_balance: 1000, bonus_balance: 0 };
    return json(200, single ? row : [row]);
  }
  if (table === 'payhip_products') {
    if (sc.productsError) return json(500, { code: 'XX000', message: 'catalogue down' });
    if (method !== 'GET') return json(201, []);
    return json(200, sc.products || []);
  }
  if (table === 'payhip_purchases') {
    if (method !== 'GET') return json(201, []);
    return json(200, sc.purchases || []);
  }
  if (table === 'payhip_events') {
    return json(201, []);
  }
  if (table === 'deposits' || table === 'payment_invoices') {
    if (method !== 'GET') return json(201, []);
    return json(200, sc.deposits || []);
  }
  if (table === 'bot_worker_control') {
    return json(200, single ? { id: 1, emergency_stop: false } : [{ id: 1, emergency_stop: false }]);
  }
  if (table === 'bot_sessions') {
    if (single) return json(200, { id: 1, user_id: 7, is_running: false, mode: 'live', generation: 1, heartbeat_at: null, claimed_by: null, lease_expires_at: null });
    return json(200, method === 'GET' ? [] : [{ id: 1, user_id: 7 }]);
  }

  return json(200, single ? {} : []);
};
