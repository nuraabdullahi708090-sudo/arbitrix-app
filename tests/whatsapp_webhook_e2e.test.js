'use strict';

/**
 * End-to-end wiring for the Zernio WhatsApp webhook.
 *
 * Boots the REAL server with the offline Zernio/Supabase stub, so this covers
 * what the unit suite cannot: Express route registration order, req.rawBody
 * capture, the HMAC check against the exact bytes, the status codes Zernio acts
 * on, and the admin-gated status route.
 *
 * No network call leaves the process and no customer is contacted.
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-zernio-preload.js');
const JWT_SECRET = 'whatsapp-webhook-e2e-secret';
const WEBHOOK_SECRET = 'whsec_e2e_test';

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

let app;
let logPath;

async function startApp() {
  const port = await freePort();
  logPath = path.join(os.tmpdir(), `zernio-e2e-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(logPath, '');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_ENV: 'test',
      PORT: String(port),
      JWT_SECRET,
      BASE_URL: 'http://127.0.0.1:' + port,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_SUPPORT_CHAT_ID: '',
      TELEGRAM_ADMIN_IDS: '',
      ZERNIO_API_KEY: 'fake-zernio-key',
      ZERNIO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ZERNIO_WHATSAPP_ACCOUNT_ID: 'acc-1',
      ZERNIO_PROFILE_ID: 'prof-1',
      ZERNIO_SEQUENCE_EN: 'seq-en',
      ZERNIO_SEQUENCE_PT_BR: 'seq-pt',
      WHATSAPP_AUTOMATION_ENABLED: 'true',
      WHATSAPP_LANGUAGE_CONFIDENCE_THRESHOLD: '0.6',
      ZERNIO_FAKE_LOG: logPath,
      NODE_OPTIONS: '--require ' + JSON.stringify(PRELOAD)
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });

  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error('server exited during boot: ' + output.slice(-1500));
    }
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) break;
    } catch (error) {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error('server did not become healthy: ' + output.slice(-1500));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return {
    base,
    output: () => output,
    stop() {
      try {
        child.kill('SIGTERM');
      } catch (error) {
        // already gone
      }
    }
  };
}

function readLog() {
  const text = fs.readFileSync(logPath, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sends() {
  return readLog().filter((entry) => entry.type === 'sendText');
}

function sign(body) {
  return crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(Buffer.from(JSON.stringify(body), 'utf8'))
    .digest('hex');
}

let counter = 0;
function buildEvent(overrides) {
  counter += 1;
  const opts = overrides || {};
  const eventId = opts.id || `e2e-evt-${counter}`;
  return {
    id: eventId,
    event: 'message.received',
    message: {
      id: `e2e-msg-${counter}`,
      conversationId: 'conv-e2e',
      platform: 'whatsapp',
      platformMessageId: `wamid.e2e.${counter}`,
      direction: 'incoming',
      text: opts.text || '',
      attachments: [],
      sender: { id: '5511999999999', contactId: 'contact-e2e', name: 'Ana' },
      sentAt: new Date().toISOString(),
      isRead: false
    },
    conversation: { id: 'conv-e2e', contactId: 'contact-e2e', participantId: '5511999999999' },
    account: { accountId: 'acc-1' }
  };
}

async function postWebhook(body, signature) {
  return fetch(app.base + '/api/zernio/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Zernio-Event': body.event,
      'X-Zernio-Event-Id': body.id,
      'X-Zernio-Signature': signature === undefined ? sign(body) : signature
    },
    body: JSON.stringify(body)
  });
}

test.before(async () => { app = await startApp(); });
test.after(() => {
  if (app) app.stop();
  try {
    fs.unlinkSync(logPath);
  } catch (error) {
    // best effort
  }
});

test('a signed Portuguese first message gets a Portuguese welcome through the real route', async () => {
  const before = sends().length;
  const response = await postWebhook(buildEvent({ text: 'Olá, preciso de ajuda com o meu depósito' }));
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.action, 'welcomed');
  assert.strictEqual(body.language, 'pt-BR');

  const all = sends();
  assert.strictEqual(all.length, before + 1);
  const reply = all[all.length - 1];
  assert.strictEqual(reply.conversationId, 'conv-e2e');
  assert.match(reply.message, /Boas-vindas à Arbitrix/);
  assert.ok(reply.idempotencyKey, 'reply must carry an idempotency key');
});

test('an invalid signature is rejected and nothing is sent', async () => {
  const before = sends().length;
  const response = await postWebhook(
    buildEvent({ text: 'Hello, I need help with my account' }),
    'f'.repeat(64)
  );
  assert.strictEqual(response.status, 401);
  const body = await response.json();
  assert.strictEqual(body.error, 'invalid_signature');
  assert.strictEqual(sends().length, before);
});

test('a duplicate event id is acknowledged without a second message', async () => {
  const event = buildEvent({ text: 'How do I make a deposit?', id: 'e2e-duplicate-1' });
  const first = await postWebhook(event);
  assert.strictEqual(first.status, 200);
  const afterFirst = sends().length;

  const second = await postWebhook(event);
  assert.strictEqual(second.status, 200);
  const body = await second.json();
  assert.strictEqual(body.duplicate, true);
  assert.strictEqual(sends().length, afterFirst);
});

test('the admin status route exists but is not public', async () => {
  const response = await fetch(app.base + '/api/whatsapp/status');
  assert.strictEqual(response.status, 401);
  const body = await response.json();
  assert.strictEqual(body.error, 'Unauthorized');
});

test('unknown whatsapp API paths answer a JSON 404, not the SPA shell', async () => {
  const response = await fetch(app.base + '/api/whatsapp/not-a-route');
  assert.strictEqual(response.status, 404);
  const body = await response.json();
  assert.strictEqual(body.success, false);
});

test('the webhook path is not shadowed by the generic payment webhook route', async () => {
  const response = await postWebhook(buildEvent({ text: 'How do I make a deposit?' }));
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.ok(['welcomed', 'answered'].includes(body.action), JSON.stringify(body));
});

test('a contact who opted out with PARAR is unsubscribed through the real route', async () => {
  const before = sends().length;
  const response = await postWebhook(buildEvent({ text: 'PARAR' }));
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.action, 'opt_out');
  assert.strictEqual(body.language, 'pt-BR');
  assert.strictEqual(sends().length, before + 1);

  const unenrolled = readLog().filter((entry) => entry.type === 'unenroll');
  assert.ok(unenrolled.length >= 1);
  assert.ok(unenrolled.some((entry) => entry.sequenceId === 'seq-pt'));
});
