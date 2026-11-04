'use strict';

/**
 * Offline Zernio + Supabase substitute for a spawned server in tests.
 *
 * `server.js` builds the Zernio client from the environment, so the only way to
 * exercise the real Express route, the real body parser (req.rawBody), the real
 * signature check and the real automation without network traffic is to
 * intercept globalThis.fetch inside the child process.
 *
 * Every Zernio request is appended to ZERNIO_FAKE_LOG as one JSON object per
 * line, so the parent test can assert exactly what was sent. Supabase REST
 * requests answer "no rows" (what authMiddleware treats as a valid session).
 * Any other host is blocked rather than silently reaching the internet.
 */

const fs = require('fs');

const LOG = process.env.ZERNIO_FAKE_LOG || '';
const contacts = new Map();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function record(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  } catch (error) {
    // The test will fail on the missing entry; never throw from the stub.
  }
}

function contact(id) {
  if (!contacts.has(id)) {
    contacts.set(id, {
      id,
      name: 'Ana',
      isSubscribed: true,
      customFields: {}
    });
  }
  return contacts.get(id);
}

globalThis.fetch = async function fakeFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const parsed = new URL(url);
  const method = (init && init.method) || 'GET';
  let body = null;
  if (init && init.body) {
    try {
      body = JSON.parse(init.body);
    } catch (error) {
      body = null;
    }
  }

  if (parsed.host !== 'zernio.com') {
    if (/\/rest\/v1\//.test(parsed.pathname)) return json(200, []);
    throw new Error('offline test harness blocked a request to ' + parsed.host);
  }

  record({ type: 'request', method, path: parsed.pathname, body });

  const contactMatch = parsed.pathname.match(/^\/api\/v1\/contacts\/([^/]+)$/);
  if (contactMatch && method === 'GET') {
    return json(200, { success: true, contact: contact(decodeURIComponent(contactMatch[1])) });
  }
  if (contactMatch && method === 'PATCH') {
    Object.assign(contact(decodeURIComponent(contactMatch[1])), body || {});
    return json(200, { success: true });
  }

  const fieldMatch = parsed.pathname.match(/^\/api\/v1\/contacts\/([^/]+)\/fields\/([^/]+)$/);
  if (fieldMatch && method === 'PUT') {
    const id = decodeURIComponent(fieldMatch[1]);
    const slug = decodeURIComponent(fieldMatch[2]);
    contact(id).customFields[slug] = body ? body.value : undefined;
    return json(200, { success: true });
  }

  const sendMatch = parsed.pathname.match(/^\/api\/v1\/inbox\/conversations\/([^/]+)\/messages$/);
  if (sendMatch && method === 'POST') {
    record({
      type: 'sendText',
      conversationId: decodeURIComponent(sendMatch[1]),
      accountId: body && body.accountId,
      message: body && body.message,
      idempotencyKey: init && init.headers && init.headers['Idempotency-Key']
    });
    return json(200, { success: true, data: { messageId: 'wamid.test' } });
  }

  if (parsed.pathname === '/api/v1/custom-fields' && method === 'GET') {
    return json(200, { success: true, fields: [] });
  }

  const enrollMatch = parsed.pathname.match(/^\/api\/v1\/sequences\/([^/]+)\/enroll$/);
  if (enrollMatch && method === 'POST') {
    record({ type: 'enroll', sequenceId: decodeURIComponent(enrollMatch[1]), body });
    return json(200, { success: true });
  }

  const unenrollMatch = parsed.pathname.match(/^\/api\/v1\/sequences\/([^/]+)\/enroll\/([^/]+)$/);
  if (unenrollMatch && method === 'DELETE') {
    record({
      type: 'unenroll',
      sequenceId: decodeURIComponent(unenrollMatch[1]),
      contactId: decodeURIComponent(unenrollMatch[2])
    });
    return json(200, { success: true });
  }

  return json(200, { success: true });
};
