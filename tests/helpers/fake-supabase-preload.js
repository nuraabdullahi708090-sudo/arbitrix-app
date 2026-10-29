'use strict';

/**
 * Offline Supabase substitute for the spawned server in tests.
 *
 * WHY THIS EXISTS (and why a normal HTTP stub is not enough):
 * `server.js` hardcodes its Supabase URL and anon key instead of reading
 * SUPABASE_URL / SUPABASE_KEY, so a spawned test server dials the real project
 * no matter what the test sets in `env`. Intercepting `globalThis.fetch` inside
 * the child - via `NODE_OPTIONS=--require <this file>` - is the only way to
 * exercise the deposit-partner routes without any production traffic. Every
 * request is logged to stderr as `[fake-supabase] <METHOD> <path>` so the test
 * can assert exactly what the server tried to touch, and any non-Supabase host
 * is blocked outright rather than silently reaching the network.
 *
 * Mode is read from the environment:
 *   DP_FAKE_MODE=missing -> /rest/v1/deposit_partners answers PostgREST's
 *                           relation-does-not-exist error (an unmigrated DB);
 *   DP_FAKE_MODE=present -> it answers DP_FAKE_ROWS, filtered the way PostgREST
 *                           would apply `is_active=eq.true&is_verified=eq.true`.
 */

const MODE = process.env.DP_FAKE_MODE === 'present' ? 'present' : 'missing';
let ROWS = [];
try {
  ROWS = JSON.parse(process.env.DP_FAKE_ROWS || '[]');
} catch (e) {
  ROWS = [];
}

function log(line) {
  process.stderr.write('[fake-supabase] ' + line + '\n');
}

function respond(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

globalThis.fetch = async function fakeFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const parsed = new URL(url);
  const method = (init && init.method) || 'GET';
  log(method + ' ' + parsed.pathname + (parsed.search || ''));

  if (!/\/rest\/v1\//.test(parsed.pathname)) {
    log('BLOCKED ' + parsed.host + parsed.pathname);
    throw new Error('offline test harness blocked a non-Supabase request to ' + parsed.host);
  }

  if (parsed.pathname === '/rest/v1/deposit_partners') {
    if (MODE === 'missing') {
      return respond(404, {
        code: '42P01',
        details: null,
        hint: null,
        message: 'relation "public.deposit_partners" does not exist'
      });
    }
    const onlyVisible = parsed.search.indexOf('is_active=eq.true') !== -1;
    return respond(200, onlyVisible ? ROWS.filter((r) => r.is_active === true && r.is_verified === true) : ROWS);
  }

  // Anything else (revoked_tokens, users, ...) answers "no rows", which is what
  // authMiddleware treats as "this session is still valid".
  return respond(200, []);
};
