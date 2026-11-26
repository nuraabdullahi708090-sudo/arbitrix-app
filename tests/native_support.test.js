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
