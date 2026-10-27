'use strict';

/**
 * Phase 1 - secure Telegram <-> Arbitrix account linking.
 *
 * These tests exercise the REAL service (services/TelegramAccountLinks.js) and
 * the REAL bot (services/TelegramSupportService.js) against:
 *   - an in-memory Supabase stand-in that models migration 039's table and the
 *     consume_telegram_link_token() semantics (row lock, expiry, one-to-one),
 *   - a recording transport (no network).
 *
 * The migration itself is asserted at the SQL level (RLS, unique indexes,
 * SECURITY DEFINER, FOR UPDATE, service_role-only grants), because no database
 * is available in this environment.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '039_telegram_account_links.sql'), 'utf8');

const {
  TABLE,
  RPC_CONSUME,
  TOKEN_PREFIX,
  TOKEN_BYTES,
  TOKEN_TTL_MS,
  generateLinkToken,
  hashLinkToken,
  isValidLinkPayload,
  buildDeepLink,
  createWindowLimiter,
  createTelegramAccountLinks
} = require('../services/TelegramAccountLinks');

const {
  createTelegramSupportBot,
  USER_HELP_TEXT,
  FIRST_CONTACT_TEXT,
  resolveTelegramConfig
} = require('../services/TelegramSupportService');

const { t: tCustomer } = require('../services/telegram-i18n');

const CHAT_ID = '777000111';
const OTHER_CHAT_ID = '777000222';
const USER_ID = 42;

// ---------------------------------------------------------------------------
// In-memory stand-in for migration 039
// ---------------------------------------------------------------------------

/**
 * Models `telegram_account_links` + `consume_telegram_link_token()`.
 * The RPC body is synchronous end-to-end, which is the JS equivalent of the
 * SQL row lock: two calls in the same tick cannot both win.
 */
function createFakeAdmin({ failRpc = false, failInsert = false, clock = null } = {}) {
  const state = { rows: [], seq: 1, rpcCalls: [], inserts: [], deletes: [] };
  const nowIso = () => new Date(clock ? clock.now() : Date.now()).toISOString();

  const match = (row, filters) => filters.every((f) => {
    if (f.op === 'eq') return row[f.col] === f.val;
    if (f.op === 'is') return (row[f.col] === undefined ? null : row[f.col]) === f.val;
    if (f.op === 'notNull') return row[f.col] !== null && row[f.col] !== undefined;
    if (f.op === 'gt') return row[f.col] !== null && String(row[f.col]) > String(f.val);
    return true;
  });

  function from(table) {
    assert.strictEqual(table, TABLE, 'the service must only touch ' + TABLE);
    const filters = [];
    let mode = null;
    let payload = null;
    let columns = '*';
    let wantSingle = false;

    const result = () => {
      let rows = state.rows.filter((r) => match(r, filters));
      if (mode === 'delete') {
        state.rows = state.rows.filter((r) => !match(r, filters));
        state.deletes.push({ filters: filters.slice(), removed: rows.length });
        return { data: rows.map((r) => ({ id: r.id, user_id: r.user_id })), error: null };
      }
      if (mode === 'insert') {
        if (failInsert) return { error: { message: 'insert failed' } };
        const row = Object.assign({ id: state.seq++, used: false, created_at: nowIso() }, payload);
        // token_hash uniqueness
        if (row.token_hash && state.rows.some((r) => r.token_hash === row.token_hash)) {
          return { error: { code: '23505', message: 'duplicate token_hash' } };
        }
        state.rows.push(row);
        state.inserts.push(row);
        return { data: [row], error: null };
      }
      if (wantSingle) {
        // supabase-js `.maybeSingle()` resolves with data null and no error.
        if (rows.length === 0) return { data: null, error: null };
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null };
    };

    const builder = {
      select(cols) { columns = cols || '*'; if (mode === null) mode = 'select'; return builder; },
      insert(obj) { mode = 'insert'; payload = obj; return builder; },
      delete() { mode = 'delete'; return builder; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
      not(col, op, val) { if (op === 'is' && val === null) filters.push({ op: 'notNull', col }); return builder; },
      gt(col, val) { filters.push({ op: 'gt', col, val }); return builder; },
      maybeSingle() { wantSingle = true; return Promise.resolve(result()); },
      single() { wantSingle = true; return Promise.resolve(result()); },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
    };
    return builder;
  }

  function rpc(name, args) {
    state.rpcCalls.push({ name, args });
    if (failRpc) return Promise.resolve({ data: null, error: { message: 'function does not exist' } });
    if (name !== RPC_CONSUME) return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });

    const hash = args && args.p_token_hash;
    const chatId = args && args.p_chat_id != null ? String(args.p_chat_id) : null;
    if (!hash || !chatId) {
      return Promise.resolve({ data: { success: false, reason: 'invalid' }, error: null });
    }

    const token = state.rows.find((r) => r.token_hash === hash);
    if (!token) return Promise.resolve({ data: { success: false, reason: 'invalid' }, error: null });

    if (token.used) {
      if (token.telegram_chat_id === chatId) {
        return Promise.resolve({ data: { success: true, already: true, user_id: String(token.user_id) }, error: null });
      }
      return Promise.resolve({ data: { success: false, reason: 'used' }, error: null });
    }
    if (!token.expires_at || String(token.expires_at) <= nowIso()) {
      return Promise.resolve({ data: { success: false, reason: 'expired' }, error: null });
    }

    const chatLink = state.rows.find((r) => r.telegram_chat_id === chatId);
    if (chatLink) {
      // burned tokens are destroyed, like the SQL function does
      state.rows = state.rows.filter((r) => r.id !== token.id);
      if (chatLink.user_id === token.user_id) {
        return Promise.resolve({ data: { success: true, already: true, user_id: String(token.user_id) }, error: null });
      }
      return Promise.resolve({ data: { success: false, reason: 'chat_linked_elsewhere' }, error: null });
    }

    const userLink = state.rows.find((r) => r.user_id === token.user_id && r.telegram_chat_id);
    if (userLink) {
      state.rows = state.rows.filter((r) => r.id !== token.id);
      return Promise.resolve({ data: { success: false, reason: 'account_linked_elsewhere' }, error: null });
    }

    token.used = true;
    token.used_at = nowIso();
    token.telegram_chat_id = chatId;
    token.telegram_user_id = args.p_telegram_user_id != null ? String(args.p_telegram_user_id) : null;
    token.linked_at = nowIso();
    return Promise.resolve({ data: { success: true, already: false, user_id: String(token.user_id) }, error: null });
  }

  return { state, client: { from, rpc } };
}

function createClock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance(ms) { now += ms; } };
}

/** One clock for both the service and the fake table, so expiry is comparable. */
function setup(opts) {
  const clock = createClock();
  const fake = createFakeAdmin(Object.assign({ clock }, opts || {}));
  const service = createTelegramAccountLinks({ admin: fake.client, clock: () => clock.now() });
  return { fake, service, clock };
}

// ---------------------------------------------------------------------------
// Bot harness
// ---------------------------------------------------------------------------

function createFakeStore() {
  const conversations = [];
  let seq = 1;
  return {
    conversations,
    async getConversationByChatId(chatId) {
      return conversations.find((c) => c.telegram_chat_id === String(chatId)) || null;
    },
    async getConversationById(id) {
      return conversations.find((c) => c.id === id) || null;
    },
    async upsertConversation(data) {
      const existing = conversations.find((c) => c.telegram_chat_id === String(data.telegram_chat_id));
      if (existing) return { conversation: existing, created: false };
      const row = Object.assign({ id: seq++, language: 'en' }, data, { telegram_chat_id: String(data.telegram_chat_id) });
      conversations.push(row);
      return { conversation: row, created: true };
    },
    async setConversationLanguage(chatId, language) {
      const row = conversations.find((c) => c.telegram_chat_id === String(chatId));
      if (row) row.language = language;
      return true;
    },
    async insertMessage() { return { id: seq++ }; },
    async getLatestMessageByConversation() { return null; },
    async createEscalation() { return { id: seq++ }; },
    async probeColumns() { return {}; }
  };
}

function createFakeTransport() {
  const calls = [];
  let id = 90000;
  return {
    calls,
    async sendMessage(chatId, text, options) {
      calls.push({ chatId: String(chatId), text, options: options || null });
      return { message_id: id++ };
    },
    toCustomer() { return calls.slice(); }
  };
}

function makeBot({ linkAccount, unlinkAccount } = {}) {
  const store = createFakeStore();
  const transport = createFakeTransport();
  const bot = createTelegramSupportBot({
    config: resolveTelegramConfig({
      TELEGRAM_BOT_TOKEN: '123456:TEST',
      TELEGRAM_SUPPORT_CHAT_ID: '-1001234567890',
      TELEGRAM_ADMIN_IDS: '6054625818',
      TELEGRAM_NOTIFY_TARGET: 'group'
    }),
    store,
    transport,
    logger: { log() {}, warn() {}, error() {} },
    linkAccount,
    unlinkAccount
  });
  return { bot, transport, store };
}

function privateUpdate({ text, chatId = CHAT_ID, updateId = 1, fromId = chatId }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1700000000,
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(fromId), is_bot: false, first_name: 'Test' },
      text
    }
  };
}

function groupUpdate({ text, updateId = 2, chatId = '-1009999999999' }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1700000000,
      chat: { id: Number(chatId), type: 'group', title: 'Partners' },
      from: { id: 999999, is_bot: false, first_name: 'Member' },
      text
    }
  };
}

// ===========================================================================
// 1. Token generation, entropy, format, TTL
// ===========================================================================

test('token: 32 cryptographically secure bytes, url-safe, unique', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const token = generateLinkToken();
    assert.ok(token.startsWith(TOKEN_PREFIX));
    assert.strictEqual(Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url').length, TOKEN_BYTES);
    assert.match(token, /^lk_[A-Za-z0-9_-]+$/);
    assert.ok(!seen.has(token), 'tokens must never repeat');
    seen.add(token);
  }
  assert.strictEqual(TOKEN_BYTES, 32);
});

test('token: format validation accepts real tokens and rejects junk', () => {
  assert.strictEqual(isValidLinkPayload(generateLinkToken()), true);
  for (const bad of ['', 'lk_', 'lk_short', 'nope', 'lk_' + 'a'.repeat(200), 'lk_ with space', 'LK_' + 'a'.repeat(43), null, 42]) {
    assert.strictEqual(isValidLinkPayload(bad), false, 'should reject ' + String(bad));
  }
});

test('token: hash is sha256 hex and is not the token', () => {
  const token = generateLinkToken();
  const digest = hashLinkToken(token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.strictEqual(digest, crypto.createHash('sha256').update(token, 'utf8').digest('hex'));
  assert.ok(!digest.includes(token.slice(3)));
});

test('token: expires after exactly 10 minutes', async () => {
  const { service, clock } = setup();
  const created = await service.createToken(USER_ID);
  assert.strictEqual(TOKEN_TTL_MS, 10 * 60 * 1000);
  assert.strictEqual(new Date(created.expiresAt).getTime(), clock.now() + TOKEN_TTL_MS);
});

test('token: deep link targets the official bot with the start payload', () => {
  const token = generateLinkToken();
  assert.strictEqual(buildDeepLink('ArbitrixSupportBot', token),
    'https://t.me/ArbitrixSupportBot?start=' + token);
  assert.ok(buildDeepLink('@ArbitrixSupportBot', token).includes('t.me/ArbitrixSupportBot'));
});

// ===========================================================================
// 2. Storage: hash only, supersede, no raw token
// ===========================================================================

test('storage: only the SHA-256 hash is persisted (never the raw token)', async () => {
  const { fake, service } = setup();
  const created = await service.createToken(USER_ID);
  const raw = created.url.split('start=')[1];

  const row = fake.state.rows[0];
  assert.ok(row.token_hash, 'a hash must be stored');
  assert.strictEqual(row.token_hash, hashLinkToken(raw));
  const serialized = JSON.stringify(fake.state.rows);
  assert.ok(!serialized.includes(raw), 'the raw token must never be stored');
  assert.ok(!serialized.includes('lk_'));
});

test('storage: minting supersedes any earlier pending token', async () => {
  const { fake, service, clock } = setup();
  await service.createToken(USER_ID);
  const firstToken = fake.state.rows[0].token_hash;
  clock.advance(3000);
  const second = await service.createToken(USER_ID);
  const live = fake.state.rows.filter((r) => r.used === false);
  assert.strictEqual(live.length, 1, 'only one pending token may exist per account');
  assert.notStrictEqual(live[0].token_hash, firstToken);
  assert.ok(second.ok);
});

test('storage: an insert failure fails closed (no token handed out)', async () => {
  const { fake, service } = setup({ failInsert: true });
  const result = await service.createToken(USER_ID);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'store_error');
  assert.strictEqual(result.url, undefined);
});

// ===========================================================================
// 3. Rate limits
// ===========================================================================

test('limits: minting is rate limited per account and has a cooldown', async () => {
  const { service, clock } = setup();
  const first = await service.createToken(USER_ID);
  assert.strictEqual(first.ok, true);
  const tooSoon = await service.createToken(USER_ID);
  assert.strictEqual(tooSoon.ok, false);
  assert.strictEqual(tooSoon.reason, 'cooldown');

  let allowed = 0;
  for (let i = 0; i < 6; i += 1) {
    clock.advance(3000);
    const res = await service.createToken(USER_ID);
    if (res.ok) allowed += 1;
    else assert.ok(['cooldown', 'rate_limited'].includes(res.reason));
  }
  assert.ok(allowed <= 4, 'the 10-minute window must cap minting (got ' + allowed + ')');
});

test('limits: repeated bad tokens are throttled without touching the database', async () => {
  const { fake, service } = setup();
  for (let i = 0; i < 8; i += 1) {
    const res = await service.consumeToken({ payload: 'lk_' + 'a'.repeat(43), chatId: 'chat-0', telegramUserId: 'chat-0' });
    assert.strictEqual(res.ok, false);
  }
  const before = fake.state.rpcCalls.length;
  const blocked = await service.consumeToken({ payload: 'lk_' + 'a'.repeat(43), chatId: 'chat-0', telegramUserId: 'chat-0' });
  assert.strictEqual(blocked.reason, 'rate_limited');
  assert.strictEqual(fake.state.rpcCalls.length, before, 'a throttled attempt must not reach the RPC');
});

test('limits: limiter is a bounded sliding window', () => {
  let now = 0;
  const limiter = createWindowLimiter({ limit: 2, windowMs: 1000 });
  assert.strictEqual(limiter.check('k', now).allowed, true);
  assert.strictEqual(limiter.check('k', now).allowed, true);
  assert.strictEqual(limiter.check('k', now).allowed, false);
  now = 1001;
  assert.strictEqual(limiter.check('k', now).allowed, true);
});

// ===========================================================================
// 4. Consumption
// ===========================================================================

async function mint(fake, service) {
  const created = await service.createToken(USER_ID);
  return created.url.split('start=')[1];
}

test('consume: a valid token links the chat to the account', async () => {
  const { fake, service } = setup();
  const payload = await mint(fake, service);

  const res = await service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });
  assert.deepStrictEqual(res, { ok: true, already: false, userId: String(USER_ID) });

  const row = fake.state.rows.find((r) => r.token_hash === hashLinkToken(payload));
  assert.strictEqual(row.used, true);
  assert.strictEqual(row.telegram_chat_id, CHAT_ID);
  assert.strictEqual(row.telegram_user_id, CHAT_ID);
  assert.ok(row.linked_at);
});

test('consume: a replay from the same chat is idempotent, not a second link', async () => {
  const { fake, service } = setup();
  const payload = await mint(fake, service);
  await service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });
  const again = await service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.already, true);
  assert.strictEqual(fake.state.rows.filter((r) => r.telegram_chat_id).length, 1);
});

test('consume: reusing the token from a different chat is refused as used', async () => {
  const { fake, service } = setup();
  const payload = await mint(fake, service);
  await service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });
  const stolen = await service.consumeToken({ payload, chatId: OTHER_CHAT_ID, telegramUserId: OTHER_CHAT_ID });
  assert.deepStrictEqual(stolen, { ok: false, reason: 'used' });
  assert.strictEqual(fake.state.rows.filter((r) => r.telegram_chat_id).length, 1);
});

test('consume: an expired token is refused', async () => {
  const { fake, service, clock } = setup();
  const payload = await mint(fake, service);
  clock.advance(TOKEN_TTL_MS + 1000);
  const res = await service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });
  assert.deepStrictEqual(res, { ok: false, reason: 'expired' });
  assert.ok(!fake.state.rows[0].telegram_chat_id);
});

test('consume: a token is still valid one second before expiry', async () => {
  const { fake, service, clock } = setup();
  const payload = await mint(fake, service);
  clock.advance(TOKEN_TTL_MS - 1000);
  const res = await service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });
  assert.strictEqual(res.ok, true);
});

test('consume: an unknown token is refused as invalid', async () => {
  const { fake, service } = setup();
  const res = await service.consumeToken({ payload: 'lk_' + 'z'.repeat(43), chatId: CHAT_ID });
  assert.deepStrictEqual(res, { ok: false, reason: 'invalid' });
});

test('consume: a malformed payload never reaches the database', async () => {
  const { fake, service } = setup();
  for (const payload of ['lk_', 'token', 'lk_' + 'a'.repeat(300), '', null]) {
    const res = await service.consumeToken({ payload, chatId: CHAT_ID });
    assert.strictEqual(res.ok, false);
  }
  assert.strictEqual(fake.state.rpcCalls.length, 0);
});

test('consume: a chat already linked to another account is refused, not transferred', async () => {
  const { fake, service, clock } = setup();
  // account 42 links chat A
  const first = await mint(fake, service);
  await service.consumeToken({ payload: first, chatId: CHAT_ID, telegramUserId: CHAT_ID });

  // account 99 (another logged-in user) mints a token and tries the same chat
  const other = createTelegramAccountLinks({ admin: fake.client, clock: () => clock.now() });
  const secondUrl = await other.createToken(99);
  const payload = secondUrl.url.split('start=')[1];
  const res = await other.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });

  assert.deepStrictEqual(res, { ok: false, reason: 'chat_linked_elsewhere' });
  const links = fake.state.rows.filter((r) => r.telegram_chat_id === CHAT_ID);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].user_id, USER_ID, 'ownership must not move to the new account');
});

test('consume: an account already linked to another chat is refused', async () => {
  const { fake, service, clock } = setup();
  const first = await mint(fake, service);
  await service.consumeToken({ payload: first, chatId: CHAT_ID, telegramUserId: CHAT_ID });

  // Same account, a second device/chat (after the mint cooldown).
  clock.advance(3000);
  const secondUrl = await service.createToken(USER_ID);
  const payload = secondUrl.url.split('start=')[1];
  const res = await service.consumeToken({ payload, chatId: OTHER_CHAT_ID, telegramUserId: OTHER_CHAT_ID });

  assert.deepStrictEqual(res, { ok: false, reason: 'account_linked_elsewhere' });
  assert.strictEqual(fake.state.rows.filter((r) => r.telegram_chat_id === CHAT_ID).length, 1);
  assert.strictEqual(fake.state.rows.filter((r) => r.telegram_chat_id === OTHER_CHAT_ID).length, 0);
});

test('consume: concurrent attempts on the same token produce exactly one link', async () => {
  const { fake, service } = setup();
  const payload = await mint(fake, service);

  const [a, b] = await Promise.all([
    service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID }),
    service.consumeToken({ payload, chatId: OTHER_CHAT_ID, telegramUserId: OTHER_CHAT_ID })
  ]);

  const winners = [a, b].filter((r) => r.ok === true && r.already !== true);
  assert.strictEqual(winners.length, 1, 'exactly one consumer may create the link');
  assert.strictEqual(fake.state.rows.filter((r) => r.telegram_chat_id).length, 1);
  const loser = [a, b].find((r) => !(r.ok === true && r.already !== true));
  assert.ok(['used', 'chat_linked_elsewhere'].includes(loser.reason), 'loser reason: ' + loser.reason);
});

test('consume: concurrent attempts from the same chat stay idempotent', async () => {
  const { fake, service } = setup();
  const payload = await mint(fake, service);
  const [a, b] = await Promise.all([
    service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID }),
    service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID })
  ]);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(fake.state.rows.filter((r) => r.telegram_chat_id).length, 1);
});

test('consume: a database/RPC failure fails closed without throwing', async () => {
  const { fake, service } = setup({ failRpc: true });
  const payload = await mint(fake, service);
  const res = await service.consumeToken({ payload, chatId: CHAT_ID });
  assert.deepStrictEqual(res, { ok: false, reason: 'unavailable' });
});

// ===========================================================================
// 5. Status and revocation
// ===========================================================================

test('status: reports the connection without leaking identifiers', async () => {
  const { fake, service } = setup();
  const payload = await mint(fake, service);
  const before = await service.getStatus(USER_ID);
  assert.strictEqual(before.connected, false);
  assert.ok(before.pending && before.pending.expiresAt);

  await service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });
  const after = await service.getStatus(USER_ID);
  assert.strictEqual(after.connected, true);
  assert.ok(after.linkedAt);
  assert.strictEqual(after.pending, null);
  assert.deepStrictEqual(Object.keys(after).sort(), ['connected', 'linkedAt', 'ok', 'pending'],
    'no chat id, telegram user id, email or balance may be exposed');
  assert.ok(!JSON.stringify(after).includes(CHAT_ID));
});

test('revoke: removes the link and kills any pending token', async () => {
  const { fake, service, clock } = setup();
  const payload = await mint(fake, service);
  await service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });
  clock.advance(3000);
  assert.strictEqual((await service.createToken(USER_ID)).ok, true);

  const revoked = await service.revoke(USER_ID);
  assert.deepStrictEqual(revoked, { ok: true, disconnected: true });

  const status = await service.getStatus(USER_ID);
  assert.strictEqual(status.connected, false);
  assert.strictEqual(fake.state.rows.filter((r) => r.telegram_chat_id).length, 0);
  assert.strictEqual(fake.state.rows.filter((r) => r.used === false).length, 0);

  // A revoked association cannot be used to address the chat again.
  const replay = await service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });
  assert.strictEqual(replay.ok, false);
});

test('revoke: is idempotent for an unlinked account', async () => {
  const { fake, service } = setup();
  const revoked = await service.revoke(USER_ID);
  assert.deepStrictEqual(revoked, { ok: true, disconnected: false });
});

test('unlink by chat: removes exactly that chat and reports whether anything was removed', async () => {
  const { fake, service } = setup();
  const payload = await mint(fake, service);
  await service.consumeToken({ payload, chatId: CHAT_ID, telegramUserId: CHAT_ID });

  const none = await service.unlinkByChat(OTHER_CHAT_ID);
  assert.strictEqual(none.removed, false);

  const removed = await service.unlinkByChat(CHAT_ID);
  assert.strictEqual(removed.removed, true);
  assert.strictEqual(removed.userId, USER_ID);
  assert.strictEqual((await service.getStatus(USER_ID)).connected, false);
});

// ===========================================================================
// 6. Bot integration: /start lk_... and /unlink
// ===========================================================================

function linkedBot(extra) {
  const seen = { links: [], unlinks: [] };
  const built = makeBot(Object.assign({
    linkAccount: async (input) => { seen.links.push(input); return { ok: true, already: false, userId: '42' }; },
    unlinkAccount: async (input) => { seen.unlinks.push(input); return { ok: true, removed: true }; }
  }, extra || {}));
  return Object.assign(built, { seen });
}

test('bot: /start without a payload is completely unchanged', async () => {
  const { bot, transport } = makeBot({ linkAccount: async () => { throw new Error('must not be called'); } });
  await bot.handleUpdate(privateUpdate({ text: '/start', updateId: 10 }));
  assert.deepStrictEqual(transport.toCustomer().map((c) => c.text), [FIRST_CONTACT_TEXT]);

  // A returning conversation gets the help text, exactly as before.
  await bot.handleUpdate(privateUpdate({ text: '/start', updateId: 11 }));
  assert.strictEqual(transport.toCustomer().pop().text, USER_HELP_TEXT);
  assert.ok(USER_HELP_TEXT.includes('/subscribe'));
});

test('bot: /start lk_<token> consumes the payload and confirms generically', async () => {
  const { bot, transport, seen } = linkedBot();
  const payload = 'lk_' + 'A'.repeat(43);
  const result = await bot.handleUpdate(privateUpdate({ text: '/start ' + payload, updateId: 12 }));

  assert.strictEqual(result.action, 'link-success');
  assert.strictEqual(seen.links.length, 1);
  assert.strictEqual(seen.links[0].payload, payload);
  assert.strictEqual(seen.links[0].chatId, CHAT_ID);
  assert.strictEqual(seen.links[0].telegramUserId, CHAT_ID);

  const reply = transport.toCustomer().pop().text;
  assert.strictEqual(reply, tCustomer('en', 'linkSuccess'));
  assert.ok(!reply.includes(payload), 'the token must never be echoed back');
  assert.ok(!reply.includes('@'), 'no email address may appear in the reply');
  assert.ok(!/balance|deposit|withdraw/i.test(reply));
});

test('bot: linking twice is handled idempotently', async () => {
  const { bot, transport } = linkedBot({
    linkAccount: async () => ({ ok: true, already: true, userId: '42' })
  });
  await bot.handleUpdate(privateUpdate({ text: '/start lk_' + 'B'.repeat(43), updateId: 13 }));
  assert.strictEqual(transport.toCustomer().pop().text, tCustomer('en', 'linkAlready'));
});

test('bot: invalid, expired and unknown tokens all get the same generic message', async () => {
  for (const reason of ['invalid', 'expired', 'used']) {
    const { bot, transport } = linkedBot({ linkAccount: async () => ({ ok: false, reason }) });
    await bot.handleUpdate(privateUpdate({ text: '/start lk_' + 'C'.repeat(43), updateId: 14 }));
    const reply = transport.toCustomer().pop().text;
    assert.strictEqual(reply, tCustomer('en', 'linkInvalid'), reason);
  }
});

test('bot: a chat bound to another account is told plainly, without account details', async () => {
  const { bot, transport } = linkedBot({
    linkAccount: async () => ({ ok: false, reason: 'chat_linked_elsewhere' })
  });
  await bot.handleUpdate(privateUpdate({ text: '/start lk_' + 'D'.repeat(43), updateId: 15 }));
  const reply = transport.toCustomer().pop().text;
  assert.strictEqual(reply, tCustomer('en', 'linkChatTaken'));
  assert.ok(!/balance|deposit|@/i.test(reply));
});

test('bot: an account already bound to another chat is told to disconnect first', async () => {
  const { bot, transport } = linkedBot({
    linkAccount: async () => ({ ok: false, reason: 'account_linked_elsewhere' })
  });
  await bot.handleUpdate(privateUpdate({ text: '/start lk_' + 'E'.repeat(43), updateId: 16 }));
  assert.strictEqual(transport.toCustomer().pop().text, tCustomer('en', 'linkAccountBusy'));
});

test('bot: a malformed payload is rejected before any database work', async () => {
  const { bot, transport, seen } = linkedBot();
  await bot.handleUpdate(privateUpdate({ text: '/start lk_', updateId: 17 }));
  assert.strictEqual(seen.links.length, 0, 'the service must not be called');
  assert.strictEqual(transport.toCustomer().pop().text, tCustomer('en', 'linkInvalid'));
});

test('bot: a linking payload in a group is ignored (no bound identity)', async () => {
  const { bot, transport, seen } = linkedBot();
  await bot.handleUpdate(groupUpdate({ text: '/start lk_' + 'F'.repeat(43), updateId: 18 }));
  assert.strictEqual(seen.links.length, 0);
  assert.strictEqual(transport.calls.length, 0, 'a group must never be answered with a link result');
});

test('bot: /unlink disconnects and confirms', async () => {
  const { bot, transport, seen } = linkedBot();
  const result = await bot.handleUpdate(privateUpdate({ text: '/unlink', updateId: 19 }));
  assert.strictEqual(result.action, 'unlink-removed');
  assert.strictEqual(seen.unlinks.length, 1);
  assert.strictEqual(seen.unlinks[0].chatId, CHAT_ID);
  assert.strictEqual(transport.toCustomer().pop().text, tCustomer('en', 'unlinkRemoved'));
});

test('bot: /unlink on an unlinked chat says so', async () => {
  const { bot, transport } = linkedBot({ unlinkAccount: async () => ({ ok: true, removed: false }) });
  await bot.handleUpdate(privateUpdate({ text: '/unlink', updateId: 20 }));
  assert.strictEqual(transport.toCustomer().pop().text, tCustomer('en', 'unlinkNotLinked'));
});

test('bot: /unlink failures are reported safely', async () => {
  const { bot, transport } = linkedBot({
    unlinkAccount: async () => { throw new Error('database exploded with secret detail'); }
  });
  await bot.handleUpdate(privateUpdate({ text: '/unlink', updateId: 21 }));
  const reply = transport.toCustomer().pop().text;
  assert.strictEqual(reply, tCustomer('en', 'unlinkUnavailable'));
  assert.ok(!reply.includes('secret detail'));
});

test('bot: an error message can never log the linking token', async () => {
  const logs = [];
  const transport = createFakeTransport();
  const bot = createTelegramSupportBot({
    config: resolveTelegramConfig({
      TELEGRAM_BOT_TOKEN: '123456:TEST',
      TELEGRAM_SUPPORT_CHAT_ID: '-1001234567890',
      TELEGRAM_ADMIN_IDS: '6054625818',
      TELEGRAM_NOTIFY_TARGET: 'group'
    }),
    store: createFakeStore(),
    transport,
    logger: { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    linkAccount: async () => { throw new Error('db said no for lk_' + 'Z'.repeat(43)); }
  });
  await bot.handleUpdate(privateUpdate({ text: '/start lk_' + 'Z'.repeat(43), updateId: 30 }));
  const joined = logs.join('\n');
  assert.ok(joined.includes('account link failed'), 'the failure is logged');
  assert.ok(!joined.includes('Z'.repeat(43)), 'the token must be scrubbed from the log');
  assert.strictEqual(transport.toCustomer().pop().text, tCustomer('en', 'linkUnavailable'));
});

test('bot: /unlink in a group is not treated as an account action', async () => {
  const { bot, transport, seen } = linkedBot();
  await bot.handleUpdate(groupUpdate({ text: '/unlink', updateId: 22 }));
  assert.strictEqual(seen.unlinks.length, 0);
  assert.strictEqual(transport.calls.length, 0);
});

test('bot: linking answers "unavailable" when the feature is not wired', async () => {
  const { bot, transport } = makeBot({});
  await bot.handleUpdate(privateUpdate({ text: '/start lk_' + 'G'.repeat(43), updateId: 23 }));
  assert.strictEqual(transport.toCustomer().pop().text, tCustomer('en', 'linkUnavailable'));

  await bot.handleUpdate(privateUpdate({ text: '/unlink', updateId: 24 }));
  assert.strictEqual(transport.toCustomer().pop().text, tCustomer('en', 'unlinkUnavailable'));
});

test('bot: linking replies use the conversation language (pt and ar)', async () => {
  for (const lang of ['pt', 'ar']) {
    const { bot, transport, store } = linkedBot();
    store.conversations.push({ id: 1, telegram_chat_id: CHAT_ID, language: lang });
    await bot.handleUpdate(privateUpdate({ text: '/start lk_' + 'H'.repeat(43), updateId: 25 }));
    assert.strictEqual(transport.toCustomer().pop().text, tCustomer(lang, 'linkSuccess'), lang);
  }
});

test('bot: linking never touches marketing consent', async () => {
  const subscribeCalls = [];
  const store = createFakeStore();
  const transport = createFakeTransport();
  const bot = createTelegramSupportBot({
    config: resolveTelegramConfig({
      TELEGRAM_BOT_TOKEN: '123456:TEST',
      TELEGRAM_SUPPORT_CHAT_ID: '-1001234567890',
      TELEGRAM_ADMIN_IDS: '6054625818',
      TELEGRAM_NOTIFY_TARGET: 'group'
    }),
    store,
    transport,
    logger: { log() {}, warn() {}, error() {} },
    marketing: {
      subscribe: async (x) => { subscribeCalls.push(x); return { ok: true }; },
      unsubscribe: async (x) => { subscribeCalls.push(x); return { ok: true }; }
    },
    linkAccount: async () => ({ ok: true, already: false, userId: '42' }),
    unlinkAccount: async () => ({ ok: true, removed: true })
  });

  await bot.handleUpdate(privateUpdate({ text: '/start lk_' + 'I'.repeat(43), updateId: 26 }));
  await bot.handleUpdate(privateUpdate({ text: '/unlink', updateId: 27 }));
  assert.deepStrictEqual(subscribeCalls, [], 'linking/unlinking must never change consent');
  assert.ok(tCustomer('en', 'linkSuccess').includes('/subscribe'),
    'the confirmation must tell the user marketing stays opt-in');
});

test('bot: /subscribe still works and is unaffected by linking', async () => {
  const subscribeCalls = [];
  const store = createFakeStore();
  const transport = createFakeTransport();
  const bot = createTelegramSupportBot({
    config: resolveTelegramConfig({
      TELEGRAM_BOT_TOKEN: '123456:TEST',
      TELEGRAM_SUPPORT_CHAT_ID: '-1001234567890',
      TELEGRAM_ADMIN_IDS: '6054625818',
      TELEGRAM_NOTIFY_TARGET: 'group'
    }),
    store,
    transport,
    logger: { log() {}, warn() {}, error() {} },
    marketing: {
      subscribe: async (x) => { subscribeCalls.push(x); return { ok: true }; },
      unsubscribe: async (x) => { subscribeCalls.push(x); return { ok: true }; }
    }
  });
  await bot.handleUpdate(privateUpdate({ text: '/subscribe', updateId: 28 }));
  assert.strictEqual(subscribeCalls.length, 1);
  assert.strictEqual(subscribeCalls[0].chatId, CHAT_ID);
});

test('bot: help advertises /unlink in all three supported languages', () => {
  for (const lang of ['en', 'pt', 'ar']) {
    assert.ok(tCustomer(lang, 'help').includes('/unlink'), lang);
  }
});

// ===========================================================================
// 7. Migration: constraints, RLS, atomicity
// ===========================================================================

test('migration: additive and idempotent, and it never alters business tables', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.telegram_account_links/);
  assert.match(MIGRATION, /DROP POLICY IF EXISTS telegram_account_links_service_all/);
  assert.match(MIGRATION, /ADD CONSTRAINT telegram_account_links_shape_check/);
  assert.ok(!/ALTER TABLE public\.(users|wallets|trades|deposits|withdrawals|payments|payment_invoices|referrals|subscriptions)/.test(MIGRATION));
  assert.ok(!/DROP TABLE/i.test(MIGRATION));
});

test('migration: one-to-one uniqueness in both directions', () => {
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS telegram_account_links_chat_key[\s\S]*?\(telegram_chat_id\)[\s\S]*?WHERE telegram_chat_id IS NOT NULL/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS telegram_account_links_user_key[\s\S]*?\(user_id\)[\s\S]*?WHERE telegram_chat_id IS NOT NULL/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS telegram_account_links_token_hash_key/);
});

test('migration: RLS enabled with a single service_role-only policy', () => {
  assert.match(MIGRATION, /ALTER TABLE public\.telegram_account_links ENABLE ROW LEVEL SECURITY/);
  assert.match(MIGRATION, /CREATE POLICY telegram_account_links_service_all[\s\S]*?FOR ALL TO service_role/);
  assert.ok(!/TO anon/.test(MIGRATION), 'no anon policy may exist');
  assert.ok(!/TO authenticated/.test(MIGRATION), 'no authenticated policy may exist');
  assert.match(MIGRATION, /REVOKE ALL ON public\.telegram_account_links FROM PUBLIC, anon, authenticated/);
});

test('migration: consumption is atomic (SECURITY DEFINER + FOR UPDATE + unique backstop)', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.consume_telegram_link_token'));
  assert.match(fn, /SECURITY DEFINER/);
  assert.match(fn, /WHERE token_hash = p_token_hash\s*\n\s*FOR UPDATE/);
  assert.match(fn, /WHEN unique_violation THEN/);
  assert.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.consume_telegram_link_token\(TEXT, TEXT, TEXT\) TO service_role/);
  assert.match(MIGRATION, /REVOKE ALL ON FUNCTION public\.consume_telegram_link_token\(TEXT, TEXT, TEXT\) FROM PUBLIC, anon, authenticated/);
});

test('migration: refuses ownership transfer and never raises for expected outcomes', () => {
  const start = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.consume_telegram_link_token');
  const fn = MIGRATION.slice(start, MIGRATION.indexOf('$$;', start) + 3);
  assert.match(fn, /chat_linked_elsewhere/);
  assert.match(fn, /account_linked_elsewhere/);
  assert.ok(!/UPDATE public\.telegram_account_links\s+SET user_id/.test(fn), 'ownership is never reassigned');
  assert.ok(!/RAISE EXCEPTION/.test(fn), 'expected outcomes must not raise');
});

test('migration: has a self-check block', () => {
  assert.match(MIGRATION, /5\. Self-check/);
  assert.match(MIGRATION, /RAISE EXCEPTION 'telegram_account_links: RLS is not enabled'/);
});

// ===========================================================================
// 8. Server endpoints
// ===========================================================================

test('server: the three linking routes are authenticated', () => {
  for (const route of [
    "app.post('/api/telegram/link/start', authMiddleware",
    "app.get('/api/telegram/link', authMiddleware",
    "app.delete('/api/telegram/link', authMiddleware"
  ]) {
    assert.ok(SERVER.includes(route), 'missing or unauthenticated: ' + route);
  }
});

test('server: the account is always req.user.id (no IDOR surface)', () => {
  const start = SERVER.indexOf("app.post('/api/telegram/link/start'");
  const end = SERVER.indexOf('TELEGRAM ', start) === -1 ? start + 4000 : start + 4000;
  const block = SERVER.slice(start, end);
  assert.ok(block.includes('createToken(req.user.id)'));
  assert.ok(block.includes('getStatus(req.user.id)'));
  assert.ok(block.includes('revoke(req.user.id)'));
  assert.ok(!/req\.body\.(userId|user_id|chatId|telegram_chat_id)/.test(block));
  assert.ok(!/req\.query\.(userId|user_id)/.test(block));
});

test('server: link responses are not cacheable and never carry a chat id', () => {
  const block = SERVER.slice(SERVER.indexOf("app.post('/api/telegram/link/start'"), SERVER.indexOf("app.post('/api/telegram/link/start'") + 4000);
  assert.ok((block.match(/Cache-Control', 'no-store'/g) || []).length >= 3);
  assert.ok(!/chatId:|telegram_chat_id:|email:/.test(block), 'no identifier may be echoed');
});

test('server: rate limiting answers 429 with Retry-After', () => {
  const block = SERVER.slice(SERVER.indexOf("app.post('/api/telegram/link/start'"), SERVER.indexOf("app.post('/api/telegram/link/start'") + 1600);
  assert.match(block, /status\(429\)/);
  assert.match(block, /Retry-After/);
});

test('server: the bot receives the Telegram-authenticated ids, not client input', () => {
  assert.match(SERVER, /linkAccount: \(input\) => telegramAccountLinks\.consumeToken\(input\)/);
  assert.match(SERVER, /unlinkAccount: \(input\) => telegramAccountLinks\.unlinkByChat\(input && input\.chatId\)/);
});

test('server: linking code never touches marketing subscriptions or financial tables', () => {
  const start = SERVER.indexOf("app.post('/api/telegram/link/start'");
  const block = SERVER.slice(start, start + 4000);
  assert.ok(!/telegram_marketing_subscriptions/.test(block));
  assert.ok(!/wallets|deposits|withdrawals|trades|referrals/.test(block));
});

test('server: no raw token is ever logged', () => {
  const start = SERVER.indexOf("app.post('/api/telegram/link/start'");
  const block = SERVER.slice(start, start + 4000);
  assert.ok(!/console\.(log|error|warn)\([^)]*result\.url/.test(block));
  assert.ok(!/console\.(log|error|warn)\([^)]*\.token\b/.test(block));
  const svc = fs.readFileSync(path.join(ROOT, 'services', 'TelegramAccountLinks.js'), 'utf8');
  assert.ok(!/console\./.test(svc), 'the service must not log at all');
});

// ===========================================================================
// 9. Dashboard UI
// ===========================================================================

function dict() {
  const start = INDEX.indexOf('const TRANSLATIONS');
  const open = INDEX.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < INDEX.length; i += 1) {
    if (INDEX[i] === '{') depth += 1;
    else if (INDEX[i] === '}') { depth -= 1; if (!depth) { end = i; break; } }
  }
  return vm.runInNewContext('(' + INDEX.slice(open, end + 1) + ')');
}

test('ui: the profile dashboard has a Connect Telegram section', () => {
  assert.ok(INDEX.includes('id="telegramLinkCard"'));
  assert.ok(INDEX.includes('id="telegramLinkStatus"'));
  assert.ok(INDEX.includes('id="telegramLinkConnectBtn"'));
  assert.ok(INDEX.includes('id="telegramLinkOpenBtn"'));
  assert.ok(INDEX.includes('id="telegramLinkDisconnectBtn"'));
  // It lives inside the existing profile modal, not a new page.
  const profile = INDEX.indexOf('id="profileModal"');
  const card = INDEX.indexOf('id="telegramLinkCard"');
  assert.ok(profile > 0 && card > profile, 'the card must be inside the profile modal');
});

test('ui: the dashboard calls the authenticated endpoints and confirms before disconnecting', () => {
  assert.ok(INDEX.includes("fetch('/api/telegram/link/start'"));
  assert.ok(INDEX.includes("fetch('/api/telegram/link'"));
  assert.match(INDEX, /method: 'DELETE'/);
  assert.ok(INDEX.includes("confirm(t('telegramLink.confirmDisconnect'))"));
  assert.ok(INDEX.includes('loadTelegramLinkStatus()'), 'status is loaded when the modal opens');
  // The JWT is read from the existing session key; the token is never persisted.
  const block = INDEX.slice(INDEX.indexOf('// ============ TELEGRAM ACCOUNT LINKING'), INDEX.indexOf('function renderSubscriptionPanel'));
  assert.ok(block.includes("localStorage.getItem('jwt_token')"));
  assert.ok(!/localStorage\.setItem/.test(block), 'nothing may be written to localStorage');
});

test('ui: the consent note explains that linking is not a marketing opt-in', () => {
  const d = dict();
  for (const lang of ['en', 'es', 'pt', 'fr', 'ar', 'zh']) {
    const note = d[lang]['telegramLink.consentNote'];
    assert.ok(note && note.includes('/subscribe'), lang + ' must mention the separate /subscribe opt-in');
  }
});

test('ui: all 15 linking keys exist and are non-empty in all 6 locales', () => {
  const d = dict();
  const keys = Object.keys(d.en).filter((k) => k.startsWith('telegramLink.'));
  assert.strictEqual(keys.length, 15);
  for (const lang of ['en', 'es', 'pt', 'fr', 'ar', 'zh']) {
    for (const key of keys) {
      assert.ok(String(d[lang][key] || '').trim().length > 0, lang + ' missing ' + key);
    }
    assert.strictEqual(Object.keys(d[lang]).length, Object.keys(d.en).length, lang + ' key count');
  }
});

test('ui: the section does not disturb the existing profile features', () => {
  for (const id of ['subscriptionProfileCard', 'profileAchievements', 'profileDisplayName', 'profileEmail']) {
    assert.ok(INDEX.includes('id="' + id + '"'), 'missing ' + id);
  }
});

// ===========================================================================
// 10. Privacy / no sensitive data
// ===========================================================================

test('privacy: bot replies contain no account data in any language', () => {
  const keys = ['linkSuccess', 'linkAlready', 'linkInvalid', 'linkChatTaken', 'linkAccountBusy',
    'linkRateLimited', 'linkUnavailable', 'unlinkRemoved', 'unlinkNotLinked', 'unlinkUnavailable'];
  for (const lang of ['en', 'pt', 'ar']) {
    for (const key of keys) {
      const text = tCustomer(lang, key);
      assert.ok(text && text !== key);
      assert.ok(!/@|balance|deposit|\$[0-9]/i.test(text), lang + '/' + key + ' leaks account data: ' + text);
      assert.ok(!/lk_[A-Za-z0-9_-]{10,}/.test(text), 'no token may be echoed');
    }
  }
});

test('privacy: the linking table stores no PII beyond the Telegram ids', () => {
  const create = MIGRATION.slice(MIGRATION.indexOf('CREATE TABLE'), MIGRATION.indexOf('-- 2. Uniqueness'));
  for (const forbidden of ['email', 'phone', 'first_name', 'username', 'password']) {
    assert.ok(!new RegExp('\\b' + forbidden + '\\b', 'i').test(create), 'unexpected column: ' + forbidden);
  }
  assert.match(create, /telegram_chat_id/);
  assert.match(create, /telegram_user_id/);
  assert.match(create, /token_hash/);
});
