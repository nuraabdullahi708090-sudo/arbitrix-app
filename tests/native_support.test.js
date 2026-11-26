'use strict';

/**
 * Native in-app support - HUMAN-ONLY.
 *
 * The customer writes; an agent replies from the dashboard or from Telegram. No
 * code path in this service can generate an answer, so the assertions below pin
 * the static acknowledgement, the durable message store, account isolation, the
 * agent controls and the deliberate ABSENCE of any AI layer.
 *
 * The REAL services/NativeSupport.js runs against an in-memory PostgREST-shaped
 * client, so every assertion exercises the shipped code path (the module under
 * test is never mocked). The route module is checked for its security wiring and
 * the migration / translations for their structural contracts.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NS = require('../services/NativeSupport');
const { createSupportInboxBridge } = require('../services/SupportInboxBridge');
const { routeUpdate } = require('../services/TelegramSupportService');
require('../services/nativeSupportRoutes');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase/migrations/059_native_support.sql'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(ROOT, 'services/nativeSupportRoutes.js'), 'utf8');

// ---------------------------------------------------------------- fake Supabase

function makeDb(seed) {
    const tables = { support_conversations: [], support_messages: [], support_actions: [], users: [] };
    Object.keys(seed || {}).forEach((t) => { tables[t] = (seed[t] || []).map((r) => Object.assign({}, r)); });
    const seq = { support_conversations: 100, support_messages: 1000, support_actions: 5000 };

    function matches(row, conds) {
        return conds.every((c) => {
            if (c.op === 'eq') return row[c.col] === c.val;
            if (c.op === 'neq') return row[c.col] !== c.val;
            if (c.op === 'gt') return Number(row[c.col]) > Number(c.val);
            if (c.op === 'in') return c.val.indexOf(row[c.col]) !== -1;
            if (c.op === 'is') return c.val === null ? row[c.col] == null : row[c.col] === c.val;
            return true;
        });
    }

    function builder(table) {
        const state = { conds: [], order: null, limit: null, op: 'select', payload: null, single: false };
        const api = {
            select() { if (state.op !== 'insert' && state.op !== 'update') state.op = 'select'; return api; },
            insert(rows) { state.op = 'insert'; state.payload = Array.isArray(rows) ? rows : [rows]; return api; },
            update(patch) { state.op = 'update'; state.payload = patch; return api; },
            eq(col, val) { state.conds.push({ op: 'eq', col, val }); return api; },
            neq(col, val) { state.conds.push({ op: 'neq', col, val }); return api; },
            gt(col, val) { state.conds.push({ op: 'gt', col, val }); return api; },
            in(col, val) { state.conds.push({ op: 'in', col, val }); return api; },
            // PostgREST's IS NULL filter (used by the acknowledgement claim).
            is(col, val) { state.conds.push({ op: 'is', col, val }); return api; },
            order(col, opts) { state.order = { col, ascending: !opts || opts.ascending !== false }; return api; },
            limit(n) { state.limit = n; return api; },
            maybeSingle() { state.single = true; return api; },
            single() { state.single = true; return api; },
            then(resolve, reject) {
                try { resolve({ data: run(), error: null }); } catch (e) { reject(e); }
            }
        };

        function run() {
            const rows = tables[table] || [];
            if (state.op === 'insert') {
                const out = [];
                state.payload.forEach((row) => {
                    if (table === 'support_messages' && row.client_message_id) {
                        const dup = rows.some((r) => r.conversation_id === row.conversation_id
                            && r.client_message_id === row.client_message_id);
                        if (dup) {
                            const err = new Error('duplicate key value violates unique constraint');
                            err.code = '23505';
                            throw err;
                        }
                    }
                    if (table === 'support_conversations' && row.status !== 'resolved') {
                        const active = rows.some((r) => r.user_id === row.user_id && r.status !== 'resolved');
                        if (active) {
                            const err = new Error('duplicate key value violates unique constraint "support_conversations_one_active"');
                            err.code = '23505';
                            throw err;
                        }
                    }
                    const copy = Object.assign({}, row);
                    if (table === 'support_conversations' && copy.context_version == null) copy.context_version = 0;
                    if (copy.id == null) copy.id = seq[table] = (seq[table] || 1) + 1;
                    rows.push(copy);
                    out.push(copy);
                });
                return state.single ? out[0] : out;
            }
            let found = rows.filter((r) => matches(r, state.conds));
            if (state.op === 'update') {
                found.forEach((r) => Object.assign(r, state.payload));
                return state.single ? found[0] : found;
            }
            if (state.order) {
                found.sort((a, b) => {
                    const av = a[state.order.col], bv = b[state.order.col];
                    if (av === bv) return 0;
                    if (av == null) return 1;
                    if (bv == null) return -1;
                    return (av < bv ? -1 : 1) * (state.order.ascending ? 1 : -1);
                });
            }
            if (state.limit) found = found.slice(0, state.limit);
            return state.single ? found[0] : found;
        }
        return api;
    }

    // Emulates the two locked SECURITY DEFINER functions from migration 059.
    // JavaScript is single-threaded, so each handler runs to completion = the
    // same guarantee `SELECT ... FOR UPDATE` gives in Postgres.
    function nowIso() { return new Date().toISOString(); }
    function preview(body) {
        const flat = String(body || '').replace(/\s+/g, ' ').trim();
        return flat.length > 160 ? flat.slice(0, 159) + '\u2026' : flat;
    }
    const commits = [];
    const rpcHandlers = {
        support_post_customer_message: function (p) {
            const conv = tables.support_conversations.find((c) => c.id === p.p_conversation_id);
            if (!conv) return { ok: false, reason: 'not-found' };
            if (p.p_client_message_id) {
                const dup = tables.support_messages.find((m) => m.conversation_id === conv.id
                    && m.client_message_id === p.p_client_message_id);
                if (dup) return { ok: true, duplicate: true, message: dup, conversation: Object.assign({}, conv) };
            }
            const msg = { id: seq.support_messages = (seq.support_messages || 1) + 1, conversation_id: conv.id,
                sender_type: 'customer', sender_user_id: null, body: p.p_body,
                client_message_id: p.p_client_message_id || null, created_at: nowIso() };
            tables.support_messages.push(msg);
            conv.unread_for_admin = Number(conv.unread_for_admin || 0) + 1;
            conv.last_message_at = nowIso();
            conv.last_message_preview = preview(p.p_body);
            if (conv.status === 'resolved') { conv.status = 'open'; conv.resolved_at = null; }
            conv.updated_at = nowIso();
            return { ok: true, duplicate: false, message: msg, conversation: Object.assign({}, conv) };
        },
        support_commit_ai_turn: function (p) {
            if (p.p_sender_type !== 'ai' && p.p_sender_type !== 'system') {
                return { committed: false, reason: 'invalid-sender' };
            }
            const conv = tables.support_conversations.find((c) => c.id === p.p_conversation_id);
            if (!conv) return { committed: false, reason: 'not-found' };
            if (conv.status === 'resolved') return { committed: false, reason: 'resolved', conversation: Object.assign({}, conv) };
            if (conv.ai_paused === true) return { committed: false, reason: 'ai-paused', conversation: Object.assign({}, conv) };
            // Optimistic concurrency: refuse a turn that composed from an older
            // dialogue state (mirrors the FOR UPDATE check in migration 059).
            if (p.p_expected_version != null && Number(conv.context_version || 0) !== Number(p.p_expected_version)) {
                return { committed: false, reason: 'stale-context', context_version: Number(conv.context_version || 0),
                    conversation: Object.assign({}, conv) };
            }
            commits.push(p);
            const msg = { id: seq.support_messages = (seq.support_messages || 1) + 1, conversation_id: conv.id,
                sender_type: p.p_sender_type, sender_user_id: null, body: p.p_body,
                client_message_id: null, created_at: nowIso() };
            tables.support_messages.push(msg);
            if (p.p_context) conv.context = p.p_context;
            conv.unread_for_customer = Number(conv.unread_for_customer || 0) + 1;
            conv.last_message_at = nowIso();
            conv.last_message_preview = p.p_preview || preview(p.p_body);
            if (p.p_needs_human === true) { conv.status = 'waiting'; conv.ai_paused = true; }
            conv.context_version = Number(conv.context_version || 0) + 1;
            conv.updated_at = nowIso();
            return { committed: true, message: msg, conversation: Object.assign({}, conv),
                context_version: conv.context_version };
        }
    };

    return { from: (t) => builder(t), _tables: tables, _commits: commits,
        rpc: async function (name, params) {
            const handler = rpcHandlers[name];
            if (!handler) return { data: null, error: { code: '42883', message: 'function public.' + name + ' does not exist' } };
            try { return { data: handler(params || {}), error: null }; }
            catch (e) { return { data: null, error: { code: e.code || 'P0001', message: e.message } }; }
        } };
}

// A database WITHOUT migration 061: `support_messages.via` and
// `support_conversations.acknowledged_at` do not exist yet, so PostgREST rejects
// any write that names them with 42703 - exactly what Postgres returns. This is
// the shape production has until 061 is applied, so the behaviour must be known.
function makePreMigrationDb() {
    const inner = makeDb();
    function reject(column, relation) {
        const error = new Error('column "' + column + '" of relation "' + relation + '" does not exist');
        error.code = '42703';
        throw error;
    }
    return {
        _tables: inner._tables,
        rpc: (...args) => inner.rpc(...args),
        from(table) {
            const builder = inner.from(table);
            const insert = builder.insert;
            const update = builder.update;
            builder.insert = (rows) => {
                const list = Array.isArray(rows) ? rows : [rows];
                if (table === 'support_messages'
                    && list.some((r) => Object.prototype.hasOwnProperty.call(r, 'via'))) {
                    reject('via', 'support_messages');
                }
                return insert(rows);
            };
            builder.update = (patch) => {
                if (table === 'support_conversations'
                    && Object.prototype.hasOwnProperty.call(patch, 'acknowledged_at')) {
                    reject('acknowledged_at', 'support_conversations');
                }
                return update(patch);
            };
            return builder;
        }
    };
}

function makeService(overrides) {
    const opts = overrides || {};
    const db = opts.db || makeDb();
    const events = [];
    const service = NS.createNativeSupportService(Object.assign({
        supabase: db,
        notify: async (userId, conv, msg) => { events.push({ kind: 'customer', userId, conversationId: conv && conv.id, messageId: msg && msg.id }); },
        notifyAdmins: async (conv, msg) => { events.push({ kind: 'admins', conversationId: conv && conv.id, messageId: msg && msg.id }); }
    }, opts.options || {}));
    return { service, db, events };
}

// ------------------------------------------------------------------- behaviour
// Scenario numbering matches the brief for the human-only support system.

test('1. a customer message is stored and gets ONE static acknowledgement', async () => {
    const { service, db, events } = makeService();
    const out = await service.sendCustomerMessage({ userId: 7, body: 'How do I deposit?', clientMessageId: 'c1' });
    assert.strictEqual(out.ok, true);
    const rows = db._tables.support_messages.filter((m) => m.conversation_id === out.conversationId);
    assert.strictEqual(rows.length, 2, 'the customer message + one notice');
    assert.deepStrictEqual(rows.map((r) => r.sender_type), ['customer', 'system']);
    assert.strictEqual(rows[0].body, 'How do I deposit?');
    assert.match(rows[1].body, /We've received your message/, 'the approved acknowledgement');
    assert.strictEqual(rows[1].via, 'system', 'the notice is labelled as a system message');
    assert.strictEqual(out.reply.id, rows[1].id, 'the acknowledgement is returned to the widget');
    assert.strictEqual(out.humanOnly, true);
    assert.ok(events.some((e) => e.kind === 'admins'), 'the agents are told');
    assert.strictEqual(events.filter((e) => e.kind === 'customer').length, 1, 'the customer is told once');
});

test('2. no automated answer is generated anywhere (no ai rows, no composeAiReply)', async () => {
    const { service, db } = makeService();
    await service.sendCustomerMessage({ userId: 8, body: 'What is Kalderix?' });
    await service.sendCustomerMessage({ userId: 8, body: 'And how does it work?' });
    assert.strictEqual(db._tables.support_messages.filter((m) => m.sender_type === 'ai').length, 0);
    assert.strictEqual(service.composeAiReply, undefined, 'the AI entry point is gone');
    assert.strictEqual(typeof service.sendChannelReply, 'function');
});

test('3. the acknowledgement is posted once per conversation, never per message', async () => {
    const { service, db } = makeService();
    const first = await service.sendCustomerMessage({ userId: 9, body: 'first' });
    const second = await service.sendCustomerMessage({ userId: 9, conversationId: first.conversationId, body: 'second' });
    const notices = db._tables.support_messages.filter((m) => m.sender_type === 'system');
    assert.strictEqual(notices.length, 1, 'one notice for the whole conversation');
    assert.strictEqual(second.reply, null, 'the second message adds no notice');
});

test('4. a retried send cannot duplicate a message (client_message_id idempotency)', async () => {
    const { service, db } = makeService();
    const first = await service.sendCustomerMessage({ userId: 10, body: 'Hello', clientMessageId: 'same' });
    const again = await service.sendCustomerMessage({ userId: 10, body: 'Hello', clientMessageId: 'same' });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.duplicate, true);
    assert.strictEqual(again.message.id, first.message.id);
    assert.strictEqual(db._tables.support_messages.filter((m) => m.sender_type === 'customer').length, 1);
    assert.strictEqual(db._tables.support_messages.filter((m) => m.sender_type === 'system').length, 1,
        'a duplicate send does not re-acknowledge');
});

test('5. account isolation: another user cannot read or write the thread', async () => {
    const { service } = makeService();
    const a = await service.sendCustomerMessage({ userId: 11, body: 'mine' });
    assert.strictEqual((await service.listMessages(12, a.conversationId)).reason, 'not-found');
    assert.strictEqual((await service.sendCustomerMessage({ userId: 12, conversationId: a.conversationId, body: 'intrude' })).reason, 'not-found');
    assert.strictEqual((await service.markCustomerRead(12, a.conversationId)).ok, false);
    assert.deepStrictEqual((await service.listConversations(12)).conversations, []);
});

test('6. the transcript keeps insertion order and survives a reopen', async () => {
    const { service } = makeService();
    const a = await service.sendCustomerMessage({ userId: 13, body: 'one' });
    await service.sendCustomerMessage({ userId: 13, conversationId: a.conversationId, body: 'two' });
    const read = await service.listMessages(13, a.conversationId);
    const bodies = read.messages.map((m) => m.body);
    assert.deepStrictEqual(bodies.map((b) => (b.length > 40 ? 'notice' : b)), ['one', 'notice', 'two'],
        'insertion order is preserved around the static notice');
    const again = await service.listMessages(13, a.conversationId);
    assert.strictEqual(again.messages.length, 3, 'history is durable, not a buffer');
});

test('7. an agent reply is stored with its provenance and reaches the customer', async () => {
    const { service, db, events } = makeService();
    const a = await service.sendCustomerMessage({ userId: 14, body: 'help' });
    const reply = await service.sendAgentMessage({ adminId: 900, conversationId: a.conversationId, body: 'Here is the answer.' });
    assert.strictEqual(reply.ok, true);
    const row = db._tables.support_messages.find((m) => m.body === 'Here is the answer.');
    assert.strictEqual(row.sender_type, 'agent');
    assert.strictEqual(row.via, 'admin', 'the dashboard is recorded as the source');
    assert.strictEqual(row.sender_user_id, 900);
    const conv = db._tables.support_conversations.find((c) => c.id === a.conversationId);
    assert.strictEqual(conv.assigned_admin_id, 900);
    assert.ok(['assigned', 'waiting'].includes(conv.status));
    assert.ok(events.some((e) => e.kind === 'customer' && e.messageId === row.id), 'the customer is notified');
});

test('8. a Telegram reply needs no platform admin but is tagged as Telegram', async () => {
    const { service, db } = makeService();
    const a = await service.sendCustomerMessage({ userId: 15, body: 'help' });
    const out = await service.sendChannelReply({ conversationId: a.conversationId, body: 'Answer from Telegram.', clientMessageId: 'tg:1:2' });
    assert.strictEqual(out.ok, true);
    const row = db._tables.support_messages.find((m) => m.body === 'Answer from Telegram.');
    assert.strictEqual(row.via, 'telegram');
    assert.strictEqual(row.sender_user_id, null, 'no platform user is invented');
    assert.strictEqual(out.via, 'telegram');
});

test('9. a dashboard reply still requires an authenticated agent', async () => {
    const { service } = makeService();
    const a = await service.sendCustomerMessage({ userId: 16, body: 'help' });
    const out = await service.sendAgentMessage({ conversationId: a.conversationId, body: 'no identity' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'unauthenticated');
});

test('10. a repeated Telegram delivery cannot duplicate the agent reply', async () => {
    const { service, db } = makeService();
    const a = await service.sendCustomerMessage({ userId: 17, body: 'help' });
    await service.sendChannelReply({ conversationId: a.conversationId, body: 'once', clientMessageId: 'tg:9:9' });
    const again = await service.sendChannelReply({ conversationId: a.conversationId, body: 'once', clientMessageId: 'tg:9:9' });
    assert.strictEqual(again.duplicate, true);
    assert.strictEqual(db._tables.support_messages.filter((m) => m.body === 'once').length, 1);
});

test('11. resolve closes the thread and a new customer message reopens it', async () => {
    const { service, db } = makeService();
    const a = await service.sendCustomerMessage({ userId: 18, body: 'first' });
    const done = await service.resolve(a.conversationId, 900);
    assert.strictEqual(done.ok, true);
    assert.strictEqual(db._tables.support_conversations.find((c) => c.id === a.conversationId).status, 'resolved');
    const reopened = await service.sendCustomerMessage({ userId: 18, conversationId: a.conversationId, body: 'again' });
    assert.strictEqual(reopened.ok, true);
    assert.strictEqual(db._tables.support_conversations.find((c) => c.id === a.conversationId).status, 'open');
});

test('12. takeover marks the thread human-owned and still writes no answer', async () => {
    const { service, db } = makeService();
    const a = await service.sendCustomerMessage({ userId: 19, body: 'first' });
    await service.takeover(a.conversationId, 900);
    const before = db._tables.support_messages.length;
    const after = await service.sendCustomerMessage({ userId: 19, conversationId: a.conversationId, body: 'second' });
    assert.strictEqual(after.ok, true);
    assert.strictEqual(db._tables.support_messages.length, before + 1, 'only the customer message is added');
    assert.strictEqual(db._tables.support_conversations.find((c) => c.id === a.conversationId).ai_paused, true);
});

test('13. an explicit human request notifies the agents and records it', async () => {
    const { service, db, events } = makeService();
    const a = await service.sendCustomerMessage({ userId: 20, body: 'I need a person' });
    const out = await service.requestHuman(20, a.conversationId);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.status, 'waiting');
    assert.ok(db._tables.support_actions.some((x) => x.action === 'escalate'));
    assert.ok(events.some((e) => e.kind === 'admins'));
});

test('14. the acknowledgement is localized in all six supported languages', () => {
    ['en', 'es', 'pt', 'fr', 'ar', 'zh'].forEach((lang) => {
        const text = NS.copyFor(lang, 'received');
        assert.ok(text && text.length > 20, lang + ' has an acknowledgement');
        if (lang !== 'en') {
            assert.notStrictEqual(text, NS.copyFor('en', 'received'), lang + ' is translated');
        }
    });
    assert.match(NS.copyFor('en', 'received'), /support team will respond/);
});

test('15. a failing notification never loses the customer message', async () => {
    const db = makeDb();
    const service = NS.createNativeSupportService({
        supabase: db,
        logger: { warn() {} },
        notifyAdmins: async () => { throw new Error('telegram down'); },
        notify: async () => { throw new Error('feed down'); }
    });
    const out = await service.sendCustomerMessage({ userId: 22, body: 'still stored?' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(db._tables.support_messages.filter((m) => m.sender_type === 'customer').length, 1);
});

test('16. invalid input is refused without writing anything', async () => {
    const { service, db } = makeService();
    assert.strictEqual((await service.sendCustomerMessage({ userId: 23, body: '' })).ok, false);
    assert.strictEqual((await service.sendCustomerMessage({ userId: 23, body: 'x'.repeat(5000) })).ok, false);
    assert.strictEqual((await service.sendCustomerMessage({ userId: 23, conversationId: 999999, body: 'hi' })).reason, 'not-found');
    assert.strictEqual(db._tables.support_messages.length, 0);
});

test('17. the admin view lists conversations with unread counts and customer identity', async () => {
    const { service } = makeService();
    const a = await service.sendCustomerMessage({ userId: 24, body: 'hello' });
    const list = await service.listForAdmin({});
    const row = list.conversations.find((c) => c.id === a.conversationId);
    assert.ok(row, 'the conversation is in the inbox');
    assert.strictEqual(row.user_id, 24);
    assert.ok(Number(row.unread_for_admin) >= 1, 'a new customer message is unread for the agent');
    const counts = await service.countsForAdmin();
    assert.ok(Number(counts.counts.unread) >= 1);
});

test('18. the customer route surface is authenticated and the admin surface is admin-gated', () => {
    const routes = fs.readFileSync(path.join(ROOT, 'services/nativeSupportRoutes.js'), 'utf8');
    ['/api/support/conversations', '/api/support/conversations/:id/messages'].forEach((p) => {
        const line = routes.split('\n').find((l) => l.includes("'" + p + "'"));
        assert.ok(line && /authMiddleware/.test(line), p + ' requires a session');
    });
    ['/api/admin/support/conversations', '/api/admin/support/conversations/:id/messages'].forEach((p) => {
        const line = routes.split('\n').find((l) => l.includes("'" + p + "'"));
        assert.ok(line && /authMiddleware, adminMiddleware/.test(line), p + ' requires an admin');
    });
});

test('19. the in-app messenger is constructed without any AI collaborator', () => {
    const block = SERVER.slice(SERVER.indexOf('nativeSupport = nativeSupportEnabled'), SERVER.indexOf('if (nativeSupport) {'));
    assert.doesNotMatch(block, /\\bai:/, 'no AI service is passed to the in-app messenger');
    assert.doesNotMatch(block, /composeAiReply|SupportConversationEngine/);
    assert.match(block, /notifyAdmins: async/, 'the agents are still notified');
});

test('20. migration 060 is additive, idempotent and cannot delete history', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/061_human_only_support.sql'), 'utf8');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS via TEXT/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS support_messages_thread_idx/);
    assert.match(sql, /support_messages_default_via_trg/);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE/i, 'no destructive statement');
    assert.match(sql, /RAISE EXCEPTION '061_human_only_support incomplete/, 'self-checking');
});

// ------------------------------------------- migration 061 deployment contract

test('21. before migration 061 the customer message still survives, but agent replies are refused', async () => {
    const db = makePreMigrationDb();
    const service = NS.createNativeSupportService({ supabase: db, logger: { warn() {} } });

    const sent = await service.sendCustomerMessage({ userId: 30, body: 'Where is my deposit?' });
    assert.strictEqual(sent.ok, true, 'the customer message is persisted regardless of the schema');
    assert.strictEqual(sent.reply, null, 'the acknowledgement is skipped, not invented');
    assert.strictEqual(db._tables.support_messages.filter((m) => m.sender_type === 'customer').length, 1);

    // 061 is REQUIRED for the reply path: `via` is written on every agent message.
    // Merging the code before applying 061 would leave agents unable to reply.
    assert.strictEqual((await service.sendAgentMessage({ adminId: 900, conversationId: sent.conversationId, body: 'Dashboard reply' })).reason, 'unavailable');
    assert.strictEqual((await service.sendChannelReply({ conversationId: sent.conversationId, body: 'Telegram reply' })).reason, 'unavailable');
    assert.strictEqual(db._tables.support_messages.filter((m) => m.sender_type === 'agent').length, 0,
        'nothing partial is stored when the write is rejected');
});

// --------------------------------------- single-administrator end-to-end flow
// The REAL service and the REAL bridge over one database, wired exactly as
// server.js wires them: one administrator, notifications to that administrator's
// personal chat (no TELEGRAM_SUPPORT_CHAT_ID).

const CUSTOMER_ID = 4242;
const ADMIN_TELEGRAM_ID = '424242';

function singleAdminHarness(opts) {
    const o = opts || {};
    const db = o.db || makeDb();
    let nextTelegramId = 700;
    const sent = [];
    const state = { lastMessageId: null };
    const transport = {
        sent,
        async sendMessage(chatId, text) {
            if (o.transportFails) throw new Error('telegram is down');
            sent.push({ chatId: String(chatId), text });
            state.lastMessageId = nextTelegramId++;
            return { ok: true, messageId: state.lastMessageId };
        }
    };
    const service = NS.createNativeSupportService({
        supabase: db,
        logger: { warn() {} },
        notify: async () => {},
        notifyAdmins: async (conversation, message) => {
            // Same contract as server.js: the alert can never fail the send.
            try { await bridge.notifyConversation(conversation, message); } catch (err) { /* wrapped */ }
        }
    });
    const bridge = createSupportInboxBridge({
        getService: () => service,
        transport,
        config: { adminIds: [ADMIN_TELEGRAM_ID], supportChatId: null },
        lookupCustomer: async (id) => ({ id, name: 'Jane Doe', email: 'jane@example.com' }),
        logger: { warn() {} }
    });
    return {
        db, service, bridge, transport, sent,
        // The Telegram message id the bridge will have recorded for the last send,
        // i.e. the message an operator would swipe-reply to.
        get lastMessageId() { return state.lastMessageId; }
    };
}

function adminRoute(overrides) {
    return Object.assign({
        kind: 'admin', chatId: ADMIN_TELEGRAM_ID, chatType: 'private',
        fromId: ADMIN_TELEGRAM_ID, isAdmin: true, messageId: '9001',
        replyToMessageId: null, text: ''
    }, overrides || {});
}

test('22. one administrator is notified in their personal chat, after the message is stored', async () => {
    const h = singleAdminHarness();
    const sent = await h.service.sendCustomerMessage({ userId: CUSTOMER_ID, body: 'My deposit is missing.' });
    assert.strictEqual(sent.ok, true);

    assert.strictEqual(h.sent.length, 1, 'exactly one notification for one administrator');
    assert.strictEqual(h.sent[0].chatId, ADMIN_TELEGRAM_ID, 'delivered to the personal chat (chat id == user id)');
    assert.match(h.sent[0].text, new RegExp('New support message #' + sent.conversationId));
    assert.match(h.sent[0].text, /jane@example\.com/);
    assert.match(h.sent[0].text, /My deposit is missing\./);

    const rows = h.db._tables.support_messages.filter((m) => m.conversation_id === sent.conversationId);
    assert.deepStrictEqual(rows.map((r) => r.sender_type), ['customer', 'system'], 'stored, then acknowledged');
    assert.ok(h.db._tables.support_messages[0].id < 1e9, 'the customer row exists before any notification outcome matters');
});

test('23. replying to that notification answers the right customer conversation', async () => {
    const h = singleAdminHarness();
    const first = await h.service.sendCustomerMessage({ userId: CUSTOMER_ID, body: 'Question one' });
    const firstNotification = String(h.lastMessageId);
    const second = await h.service.sendCustomerMessage({ userId: 9999, body: 'Other customer' });
    const secondNotification = String(h.lastMessageId);
    assert.notStrictEqual(firstNotification, secondNotification, 'each notification has its own message id');

    // The operator replies to the FIRST notification, with another one on screen.
    const out = await h.bridge.tryHandle(adminRoute({
        text: 'I can see your deposit, it is being confirmed.',
        replyToMessageId: firstNotification
    }), {});
    assert.strictEqual(out.handled, true);
    assert.strictEqual(out.conversationId, first.conversationId, 'routed to the notifying conversation');

    const agentRows = h.db._tables.support_messages.filter((m) => m.sender_type === 'agent');
    assert.strictEqual(agentRows.length, 1);
    assert.strictEqual(agentRows[0].via, 'telegram');
    assert.strictEqual(agentRows[0].conversation_id, first.conversationId, 'not the other customer');
    assert.strictEqual(
        h.db._tables.support_messages.filter((m) => m.conversation_id === second.conversationId && m.sender_type === 'agent').length,
        0,
        'the other customer received nothing'
    );

    // ...and the dashboard sees the very same message.
    const dashboard = await h.service.getConversationForAdmin(first.conversationId);
    assert.ok(dashboard.messages.some((m) => m.id === agentRows[0].id), 'one shared thread');
});

test('24. /kxreply delivers to the named conversation, and a bad id is refused', async () => {
    const h = singleAdminHarness();
    const conv = await h.service.sendCustomerMessage({ userId: CUSTOMER_ID, body: 'Question' });
    await h.bridge.tryHandle(adminRoute({ text: '/kxreply ' + conv.conversationId + ' Here is the answer.' }), {});
    const agent = h.db._tables.support_messages.filter((m) => m.sender_type === 'agent');
    assert.strictEqual(agent.length, 1);
    assert.strictEqual(agent[0].body, 'Here is the answer.');

    const before = h.db._tables.support_messages.length;
    const bad = await h.bridge.tryHandle(adminRoute({ messageId: '9002', text: '/kxreply 999999 nowhere' }), {});
    assert.strictEqual(bad.ok, false);
    assert.match(h.transport.sent[h.transport.sent.length - 1].text, /Could not deliver/);
    assert.strictEqual(h.db._tables.support_messages.length, before, 'nothing is written for an unknown conversation');
});

test('25. a duplicate Telegram delivery cannot duplicate the support message', async () => {
    const h = singleAdminHarness();
    const conv = await h.service.sendCustomerMessage({ userId: CUSTOMER_ID, body: 'Question' });
    const route = adminRoute({ messageId: '9100', text: '/kxreply ' + conv.conversationId + ' Only once.' });

    const first = await h.bridge.tryHandle(route, {});
    const second = await h.bridge.tryHandle(route, {});   // the same update redelivered
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.duplicate, true);
    assert.strictEqual(h.db._tables.support_messages.filter((m) => m.sender_type === 'agent').length, 1);
    assert.match(h.transport.sent[h.transport.sent.length - 1].text, /Already delivered/);
});

test('26. /kxresolve closes only the intended conversation', async () => {
    const h = singleAdminHarness();
    const one = await h.service.sendCustomerMessage({ userId: CUSTOMER_ID, body: 'First' });
    const two = await h.service.sendCustomerMessage({ userId: 5555, body: 'Second' });

    const out = await h.bridge.tryHandle(adminRoute({ text: '/kxresolve ' + one.conversationId }), {});
    assert.strictEqual(out.ok, true);
    const statuses = h.db._tables.support_conversations.map((c) => [c.id, c.status]);
    assert.strictEqual(statuses.find(([id]) => id === one.conversationId)[1], 'resolved');
    assert.notStrictEqual(statuses.find(([id]) => id === two.conversationId)[1], 'resolved');
});

test('27. a Telegram outage never loses the customer message', async () => {
    const h = singleAdminHarness({ transportFails: true });
    const sent = await h.service.sendCustomerMessage({ userId: CUSTOMER_ID, body: 'Anyone there?' });
    assert.strictEqual(sent.ok, true);
    const rows = h.db._tables.support_messages.filter((m) => m.conversation_id === sent.conversationId);
    assert.strictEqual(rows.filter((m) => m.sender_type === 'customer').length, 1, 'the question is stored');
    assert.strictEqual(rows.filter((m) => m.sender_type === 'system').length, 1, 'the customer is still acknowledged');
});

test('28. only the configured administrator id can issue support commands', async () => {
    const h = singleAdminHarness();
    const conv = await h.service.sendCustomerMessage({ userId: CUSTOMER_ID, body: 'Question' });
    for (const fromId of ['111', '222', null]) {
        const out = await h.bridge.tryHandle(adminRoute({ fromId, text: '/kxreply ' + conv.conversationId + ' intruder' }), {});
        assert.strictEqual(out, null, 'not handled');
    }
    assert.strictEqual(h.db._tables.support_messages.filter((m) => m.sender_type === 'agent').length, 0,
        'nothing is delivered for an unauthorised sender');
});

test('29. the whole single-administrator flow is human-only', async () => {
    const h = singleAdminHarness();
    const conv = await h.service.sendCustomerMessage({ userId: CUSTOMER_ID, body: 'Do you answer automatically?' });
    await h.bridge.tryHandle(adminRoute({ text: '/kxreply ' + conv.conversationId + ' A human is here.' }), {});
    const kinds = h.db._tables.support_messages.map((m) => m.sender_type);
    assert.strictEqual(kinds.includes('ai'), false, 'no automated participant anywhere');
    assert.deepStrictEqual(kinds, ['customer', 'system', 'agent']);
});

// ------------------------------------------------- single-administrator config

test('30. a private message from the administrator is classified as an operator by default', () => {
    const update = {
        message: {
            message_id: 1,
            chat: { id: Number(ADMIN_TELEGRAM_ID), type: 'private' },
            from: { id: Number(ADMIN_TELEGRAM_ID), is_bot: false },
            text: 'hello'
        }
    };
    const withDefault = routeUpdate(update, { adminIds: [ADMIN_TELEGRAM_ID], supportChatId: null });
    assert.strictEqual(withDefault.kind, 'admin', 'the single administrator gets the operator handler');
    assert.strictEqual(withDefault.isAdmin, true);
});

test('31. every route is gated: customers by auth, administrators by auth + admin, all by the flag', () => {
    const { registerNativeSupportRoutes } = require('../services/nativeSupportRoutes');
    const routes = [];
    const app = {
        get(path, ...mw) { routes.push({ method: 'GET', path, mw }); },
        post(path, ...mw) { routes.push({ method: 'POST', path, mw }); },
        delete(path, ...mw) { routes.push({ method: 'DELETE', path, mw }); }
    };
    function authMw() {}
    function adminMw() {}
    registerNativeSupportRoutes(app, {
        support: {}, authMiddleware: authMw, adminMiddleware: adminMw,
        supabaseAdmin: {}, isEnabled: () => true
    });

    assert.ok(routes.length >= 15, 'the whole surface is registered');
    const customers = routes.filter((r) => r.path.indexOf('/api/support/') === 0);
    const admins = routes.filter((r) => r.path.indexOf('/api/admin/support/') === 0);
    assert.ok(customers.length >= 6 && admins.length >= 8, 'both surfaces exist');

    for (const r of routes) {
        assert.strictEqual(r.mw[1], authMw, r.path + ' requires an authenticated session');
    }
    for (const r of customers) {
        assert.strictEqual(r.mw.includes(adminMw), false, r.path + ' is not admin-only');
    }
    for (const r of admins) {
        assert.strictEqual(r.mw[2], adminMw, r.path + ' requires an administrator');
    }
    // No route trusts a client-supplied customer id: none of them read req.query/body
    // for the actor. Pinned at the source level (the route bodies are one-liners).
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'nativeSupportRoutes.js'), 'utf8');
    assert.strictEqual(/userId:\s*(req\.query|req\.body)/.test(src), false, 'the customer id comes from the JWT only');
    assert.match(src, /userId: req\.user\.id/, 'customer reads use the verified JWT');
});

test('32. /kxassign is optional in the single-administrator setup and never blocks a reply', async () => {
    const h = singleAdminHarness();
    const conv = await h.service.sendCustomerMessage({ userId: CUSTOMER_ID, body: 'Question' });

    // Without an assignee the operator is told the usage and nothing changes.
    const noTarget = await h.bridge.tryHandle(adminRoute({ messageId: '9200', text: '/kxassign ' + conv.conversationId }), {});
    assert.strictEqual(noTarget.ok, false);
    assert.match(h.transport.sent[h.transport.sent.length - 1].text, /Use: \/kxassign/);
    assert.ok(h.db._tables.support_conversations[0].assigned_admin_id == null, 'still unassigned');

    // With one it records the assignee. `assigned_admin_id` is a display/filter
    // column only - no route authorises on it - so an id that is not an
    // administrator cannot grant access to anything.
    const assigned = await h.bridge.tryHandle(adminRoute({ messageId: '9201', text: '/kxassign ' + conv.conversationId + ' 7' }), {});
    assert.strictEqual(assigned.ok, true);
    assert.strictEqual(h.db._tables.support_conversations[0].assigned_admin_id, 7);

    // A reply still works and is not blocked by the assignment.
    const reply = await h.bridge.tryHandle(adminRoute({ messageId: '9202', text: '/kxreply ' + conv.conversationId + ' still here' }), {});
    assert.strictEqual(reply.ok, true);
    assert.strictEqual(h.db._tables.support_messages.filter((m) => m.sender_type === 'agent').length, 1);
});

// ---------------------------------------------------------------------------
// HUMAN REPLY PERSISTENCE (production regression)
//
// Symptom reported: the agent replied from Telegram, the customer got the
// "New support reply" notification, and reopening the messenger showed only the
// welcome text. The reply was NOT lost - the customer was looking at the legacy
// assistant, which has no history - but these tests pin the storage facts the
// messenger depends on, so a future regression cannot hide behind a notification.
// ---------------------------------------------------------------------------

test('33. a Telegram reply is stored in the SAME conversation and readable after a fresh request', async () => {
    const h = makeService();
    const sent = await h.service.sendCustomerMessage({ userId: 41, body: 'Hello, I need help with my account.' });
    assert.strictEqual(sent.ok, true, 'the customer message is accepted');
    const convId = sent.conversationId;

    const reply = await h.service.sendChannelReply({
        conversationId: convId,
        body: 'Hi, this is Kalderix support. I can help with that.',
        adminId: null,
    });
    assert.strictEqual(reply.ok, true, 'the Telegram reply is accepted');
    assert.strictEqual(reply.via, 'telegram', 'the channel of origin is recorded');
    assert.strictEqual(reply.conversationId, convId, 'the reply lands in the same conversation');

    // The stored row itself - not the response - is what the customer reads later.
    const rows = h.db._tables.support_messages.filter((m) => Number(m.conversation_id) === Number(convId));
    const agent = rows.filter((m) => m.sender_type === 'agent');
    assert.strictEqual(agent.length, 1, 'exactly one agent message is persisted');
    assert.strictEqual(agent[0].via, 'telegram', "via='telegram' is persisted on the row");
    assert.strictEqual(agent[0].body, 'Hi, this is Kalderix support. I can help with that.');

    // A FRESH request (what the widget issues when it opens) returns everything,
    // in chronological order, including the customer's own message.
    const history = await h.service.listMessages(41, convId, { afterId: null });
    assert.strictEqual(history.ok, true);
    const bodies = history.messages.map((m) => m.body);
    assert.strictEqual(bodies[0], 'Hello, I need help with my account.', 'the original message is first');
    assert.strictEqual(bodies[bodies.length - 1], 'Hi, this is Kalderix support. I can help with that.', 'the human reply is last');
    const ids = history.messages.map((m) => Number(m.id));
    assert.deepStrictEqual(ids, ids.slice().sort((a, b) => a - b), 'ordered by id (chronological)');
    assert.ok(history.messages.some((m) => m.sender_type === 'agent'), 'the agent row is returned to the customer');
    assert.ok(history.messages.some((m) => m.sender_type === 'customer'), 'the customer row is returned too');
});

test('34. dashboard and Telegram replies share ONE conversation and one order', async () => {
    const h = makeService();
    const sent = await h.service.sendCustomerMessage({ userId: 42, body: 'Two questions about my deposit.' });
    const convId = sent.conversationId;

    const fromDashboard = await h.service.sendAgentMessage({
        conversationId: convId, body: 'Dashboard: looking into it.', adminId: 7,
    });
    assert.strictEqual(fromDashboard.ok, true);
    assert.strictEqual(fromDashboard.via, 'admin', 'a dashboard reply is recorded as admin');

    const fromTelegram = await h.service.sendChannelReply({
        conversationId: convId, body: 'Telegram: it is credited now.', adminId: null,
    });
    assert.strictEqual(fromTelegram.ok, true);
    assert.strictEqual(fromTelegram.via, 'telegram');

    const rows = h.db._tables.support_messages.filter((m) => Number(m.conversation_id) === Number(convId));
    assert.strictEqual(rows.filter((m) => m.sender_type === 'agent').length, 2, 'both replies are in the same thread');
    const history = await h.service.listMessages(42, convId, { afterId: null });
    const agentBodies = history.messages.filter((m) => m.sender_type === 'agent').map((m) => m.body);
    assert.deepStrictEqual(agentBodies, ['Dashboard: looking into it.', 'Telegram: it is credited now.'],
        'both channels appear in the customer history, in the order they were sent');
});

test('35. the customer notification is emitted ONLY after the reply is persisted', async () => {
    const h = makeService();
    const sent = await h.service.sendCustomerMessage({ userId: 43, body: 'Is anyone there?' });
    const convId = sent.conversationId;
    const before = h.events.filter((e) => e.kind === 'customer').length;

    const ok = await h.service.sendChannelReply({ conversationId: convId, body: 'Yes, hello.', adminId: null });
    assert.strictEqual(ok.ok, true);
    const after = h.events.filter((e) => e.kind === 'customer');
    assert.strictEqual(after.length, before + 1, 'the customer is notified once');
    assert.strictEqual(after[after.length - 1].messageId, ok.message.id,
        'the notification points at the message that was actually stored');
    assert.ok(h.db._tables.support_messages.some((m) => Number(m.id) === Number(ok.message.id)),
        'and that message really is in the table');

    // Now make the insert fail: no notification may be produced.
    const failingDb = {
        from(table) {
            if (table !== 'support_messages') return h.db.from(table);
            const chain = {
                insert() { return chain; },
                select() { return chain; },
                maybeSingle() { return Promise.resolve({ data: null, error: { code: 'XX000', message: 'insert failed' } }); },
                single() { return Promise.resolve({ data: null, error: { code: 'XX000', message: 'insert failed' } }); },
                then(resolve) { resolve({ data: null, error: { code: 'XX000', message: 'insert failed' } }); },
            };
            return chain;
        },
    };
    const broken = makeService({ db: failingDb });
    const failed = await broken.service.sendChannelReply({ conversationId: convId, body: 'not stored', adminId: null });
    assert.strictEqual(failed.ok, false, 'the reply fails when it cannot be stored');
    assert.strictEqual(broken.events.filter((e) => e.kind === 'customer').length, 0,
        'a failed reply never notifies the customer');
});

test('36. conversation history stays isolated per customer', async () => {
    const h = makeService();
    const sent = await h.service.sendCustomerMessage({ userId: 44, body: 'private message' });
    const convId = sent.conversationId;
    await h.service.sendChannelReply({ conversationId: convId, body: 'private answer', adminId: null });

    const mine = await h.service.listMessages(44, convId, { afterId: null });
    assert.strictEqual(mine.ok, true);

    const theirs = await h.service.listMessages(45, convId, { afterId: null });
    assert.strictEqual(theirs.ok, false, 'another account cannot read the thread');
    assert.strictEqual(theirs.reason, 'not-found');
    assert.strictEqual(theirs.messages, undefined, 'no rows leak with the refusal');
});

test('37. the reported loop: Telegram reply -> the customer reads both rows, in order', async () => {
    const h = singleAdminHarness();
    const sent = await h.service.sendCustomerMessage({ userId: CUSTOMER_ID, body: 'Hello, I need help with my account.' });
    assert.strictEqual(sent.ok, true);
    const notification = String(h.lastMessageId);

    const out = await h.bridge.tryHandle(adminRoute({
        text: 'Hi, support here - I can help with that.',
        replyToMessageId: notification,
    }), {});
    assert.strictEqual(out.handled, true, 'the reply is routed');
    assert.strictEqual(out.conversationId, sent.conversationId, 'to the conversation the customer wrote in');

    // What the widget asks for when it reopens, after a refresh.
    const history = await h.service.listMessages(CUSTOMER_ID, sent.conversationId, { afterId: null });
    assert.strictEqual(history.ok, true, 'the customer may read their own thread');
    const agentRows = history.messages.filter((m) => m.sender_type === 'agent');
    assert.strictEqual(agentRows.length, 1, 'the human reply is returned');
    assert.match(agentRows[0].body, /support here/);
    assert.strictEqual(agentRows[0].via, 'telegram', "via='telegram' reaches the customer payload");
    const bodies = history.messages.map((m) => m.body);
    assert.strictEqual(bodies[0], 'Hello, I need help with my account.', 'the customer message is first');
    assert.strictEqual(bodies[bodies.length - 1], 'Hi, support here - I can help with that.', 'the human reply is last');
});
