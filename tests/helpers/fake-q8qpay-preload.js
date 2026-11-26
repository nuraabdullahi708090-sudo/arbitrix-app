'use strict';

/**
 * Offline substitute for Supabase AND the q8qpay API, for tests that boot the
 * REAL server.js (spawned with `NODE_OPTIONS=--require <this file>`).
 *
 * WHY: the q8qpay webhook used to be tested against a COPY of the handler inside
 * the test file. A copy proves that the copy works - it cannot catch a defect in
 * the route that actually runs. This helper makes the real route testable: the
 * real Express app, the real raw-body capture, the real signature check, the real
 * settlement pipeline and the real credit RPC call all execute; only the network
 * boundary is replaced.
 *
 * STATE IS READ FROM A FILE ON EVERY REQUEST, so one spawned server can be driven
 * through many scenarios without restarting (each restart costs seconds).
 *
 *   Q8_STATE_FILE   JSON: {
 *     invoice:   payment_invoices row or null      (null => "no rows" from PostgREST)
 *     invoiceError: {message, code} | null         (a database failure, not "missing")
 *     provider:  {status, amountUsdtExact, payoutAddress, assetCode, tx_hash,
 *                 isTest, reference, id} | { __error: 'timeout' }
 *     credit:    {success:true, new_balance, is_first_deposit} | {duplicate:true}
 *              | {success:false, error:'...'} | {__rpcError:'...'}
 *     creditOnce: true  => the fake RPC behaves like the real one: the first call
 *                          credits, any later call for the same invoice reports
 *                          duplicate (models credit_payment_safe's idempotency)
 *   }
 *   Q8_EVENTS_FILE  JSONL of everything the server tried to do:
 *     {"kind":"rest","method":..,"path":..,"query":..}
 *     {"kind":"rpc","fn":..,"params":{..}}
 *     {"kind":"insert","table":"webhook_logs","row":{..}}
 *     {"kind":"update","table":"payment_invoices","data":{..},"query":..}
 *     {"kind":"provider_get","id":".."}
 *
 * Nothing here touches the network: a non-Supabase, non-q8qpay host is refused.
 */

const fs = require('node:fs');

const STATE_FILE = process.env.Q8_STATE_FILE || '';
const EVENTS_FILE = process.env.Q8_EVENTS_FILE || '';

function readState() {
  try {
    if (!STATE_FILE) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function emit(event) {
  try {
    if (EVENTS_FILE) fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n');
  } catch (e) { /* a lost log line must never break the test server */ }
}

function respond(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {})
  });
}

/**
 * supabase-js asks for a single object with
 * `Accept: application/vnd.pgrst.object+json` on `.single()`.
 *
 * The headers arrive in three shapes depending on the client version and the
 * transport (a plain object, a `Headers` instance, or an array of pairs). A missed
 * match makes the fake answer an ARRAY, which `.single()` hands back as `data`, so
 * every column reads as undefined and the settlement refuses a good invoice.
 */
function acceptHeader(headers) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get('accept') || '');
  if (Array.isArray(headers)) {
    const pair = headers.find((h) => Array.isArray(h) && String(h[0]).toLowerCase() === 'accept');
    return pair ? String(pair[1]) : '';
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'accept') return String(headers[key]);
  }
  return '';
}

function wantsObject(headers) {
  return acceptHeader(headers).indexOf('vnd.pgrst.object+json') !== -1;
}

/** The fake q8qpay invoice GET (server-side re-verification). */
function providerResponse(provider) {
  const p = provider || {};
  if (p.__error) {
    // A thrown error is what a timeout/5xx looks like to the provider class.
    emit({ kind: 'provider_get', id: p.id || null, error: p.__error });
    return respond(500, { message: p.__error });
  }
  emit({ kind: 'provider_get', id: p.id || null, status: p.status || null });
  return respond(200, {
    id: p.id !== undefined ? p.id : 'q8q-uuid',
    reference: p.reference !== undefined ? p.reference : 'ARB_REF',
    status: p.status || 'pending',
    assetCode: p.assetCode !== undefined ? p.assetCode : 'USDT_TRC20',
    payoutAddress: p.payoutAddress !== undefined ? p.payoutAddress : 'TXyzPayout',
    amountUsdtExact: p.amountUsdtExact !== undefined ? p.amountUsdtExact : '50.0000',
    tx_hash: p.tx_hash === undefined ? null : p.tx_hash,
    expiresAt: '2026-12-31T00:00:00Z',
    createdAt: '2026-11-01T00:00:00Z',
    isTest: p.isTest === true
  });
}

// Credit bookkeeping for `creditOnce` (models credit_payment_safe's atomicity
// closely enough to test concurrency: one invoice, one credit).
const credited = new Set();

globalThis.fetch = async function fakeFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const parsed = new URL(url);
  const method = ((init && init.method) || 'GET').toUpperCase();
  const headers = (init && init.headers) || {};
  const state = readState();

  // ---- the payment provider -------------------------------------------------
  if (parsed.host === 'q8qpay.com' || parsed.host.endsWith('.q8qpay.com')) {
    if (parsed.pathname.indexOf('/api/v1/invoices/') === 0 && method === 'GET') {
      return providerResponse(state.provider);
    }
    emit({ kind: 'provider_other', method, path: parsed.pathname });
    return respond(404, { message: 'not modelled' });
  }

  if (!/\/rest\/v1\//.test(parsed.pathname)) {
    emit({ kind: 'blocked', host: parsed.host, path: parsed.pathname });
    throw new Error('offline harness blocked a request to ' + parsed.host);
  }

  const query = parsed.search ? parsed.search.slice(1) : '';
  emit({ kind: 'rest', method, path: parsed.pathname, query });

  // ---- payment_invoices -----------------------------------------------------
  if (parsed.pathname === '/rest/v1/payment_invoices') {
    if (method === 'GET') {
      if (state.invoiceError) {
        return respond(500, {
          code: state.invoiceError.code || 'XX000',
          message: state.invoiceError.message || 'database error'
        });
      }
      // A query WITHOUT an invoice_id filter is a COLLECTION read (the admin
      // reconciliation view): answer the scripted list, never the single-row shape.
      if (query.indexOf('invoice_id=eq.') === -1) {
        return respond(200, state.invoiceList || []);
      }
      if (!state.invoice) {
        return respond(406, {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
          details: 'The result contains 0 rows'
        });
      }
      // Honour the owner filter the way PostgREST does: a query for another
      // customer's invoice must come back empty (that is the authorization the
      // manual-check route relies on).
      const ownerMatch = /(?:^|&)user_id=eq\.(\d+)/.exec(query);
      if (ownerMatch && String(state.invoice.user_id) !== ownerMatch[1]) {
        return respond(406, {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
          details: 'The result contains 0 rows'
        });
      }
      return wantsObject(headers) ? respond(200, state.invoice) : respond(200, [state.invoice]);
    }
    if (method === 'PATCH') {
      const body = JSON.parse((init && init.body) || '{}');
      emit({ kind: 'update', table: 'payment_invoices', data: body, query });
      return respond(204, null);
    }
    return respond(200, []);
  }

  // ---- webhook_logs (the durable record) ------------------------------------
  if (parsed.pathname === '/rest/v1/webhook_logs') {
    if (method === 'GET') return respond(200, state.webhookLogs || []);
    if (method === 'POST') {
      const body = JSON.parse((init && init.body) || '{}');
      emit({ kind: 'insert', table: 'webhook_logs', row: body });
      const row = Object.assign({ id: 900 + Math.floor(Math.random() * 90) }, body);
      return wantsObject(headers) ? respond(201, row) : respond(201, [row]);
    }
    return respond(200, []);
  }

  // ---- the atomic credit RPC ------------------------------------------------
  if (parsed.pathname === '/rest/v1/rpc/credit_payment_safe') {
    const params = JSON.parse((init && init.body) || '{}');
    emit({ kind: 'rpc', fn: 'credit_payment_safe', params });
    const credit = state.credit || {};
    if (credit.__rpcError) return respond(500, { message: credit.__rpcError });
    if (state.creditOnce) {
      const key = String(params.p_invoice_id);
      if (credited.has(key)) {
        return respond(200, { success: true, duplicate: true, new_balance: 100, is_first_deposit: false });
      }
      credited.add(key);
      return respond(200, { success: true, new_balance: 150, is_first_deposit: true });
    }
    return respond(200, credit);
  }

  // ---- read-only admin views ------------------------------------------------
  if (parsed.pathname === '/rest/v1/deposits') {
    return respond(200, state.deposits || []);
  }

  // ---- everything else the server touches (auth, flags, ...) ---------------
  if (parsed.pathname === '/rest/v1/users') {
    // adminMiddleware verifies users.is_admin; model exactly one administrator.
    const idMatch = /(?:^|&)id=eq\.(\d+)/.exec(query);
    if (!(idMatch && idMatch[1] === '1')) return respond(200, []);
    const admin = { id: 1, is_admin: true };
    return wantsObject(headers) ? respond(200, admin) : respond(200, [admin]);
  }
  return respond(200, []);
};

// Keep the process quiet about the harness itself.
process.stderr.write('[fake-q8qpay] harness active\n');
