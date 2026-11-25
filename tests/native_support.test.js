'use strict';

/**
 * Native in-app support: behaviour, isolation and contracts.
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

    return { from: (t) => builder(t), _tables: tables };
}

function makeService(overrides) {
    const opts = overrides || {};
    const db = opts.db || makeDb();
    const events = [];
    const service = NS.createNativeSupportService(Object.assign({
        supabase: db,
        ai: { ask: async () => ({ answer: 'Approved answer about deposits.', modelGenerated: false, needsHuman: false }) },
        engine: null,
        i18n: null,
        notify: async (userId, conv, msg) => { events.push({ kind: 'customer', userId, conversationId: conv && conv.id, messageId: msg && msg.id }); },
        notifyAdmins: async (conv, msg) => { events.push({ kind: 'admins', conversationId: conv && conv.id, messageId: msg && msg.id }); }
    }, opts.options || {}));
    return { service, db, events };
}

// ------------------------------------------------------------------- behaviour

test('1. a customer message is persisted and answered by the AI layer', async () => {
    const { service, db, events } = makeService();
    const out = await service.sendCustomerMessage({ userId: 7, body: 'How do I deposit?', category: 'deposit', clientMessageId: 'c1' });
    assert.strictEqual(out.ok, true);
    assert.ok(out.conversationId > 0);
    const rows = db._tables.support_messages.filter((m) => m.conversation_id === out.conversationId);
    assert.strictEqual(rows.length, 2, 'customer message + AI reply');
    assert.deepStrictEqual(rows.map((r) => r.sender_type), ['customer', 'ai']);
    assert.strictEqual(rows[0].body, 'How do I deposit?');
    assert.strictEqual(out.message.client_message_id, 'c1');
    assert.ok(events.some((e) => e.kind === 'customer' && e.userId === 7), 'customer notified of the reply');
});

test('2. a retried send cannot duplicate a message (client_message_id idempotency)', async () => {
    const { service, db } = makeService();
    const first = await service.sendCustomerMessage({ userId: 8, body: 'Hello', clientMessageId: 'same' });
    const again = await service.sendCustomerMessage({ userId: 8, body: 'Hello', clientMessageId: 'same' });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.duplicate, true);
    assert.strictEqual(again.message.id, first.message.id);
    assert.strictEqual(db._tables.support_messages.filter((m) => m.sender_type === 'customer').length, 1);
});

test('3. customer isolation: another account cannot read or write the thread', async () => {
    const { service } = makeService();
    const a = await service.sendCustomerMessage({ userId: 11, body: 'mine' });
    const read = await service.listMessages(12, a.conversationId);
    assert.strictEqual(read.ok, false);
    assert.strictEqual(read.reason, 'not-found');
    assert.strictEqual((await service.sendCustomerMessage({ userId: 12, conversationId: a.conversationId, body: 'intrude' })).reason, 'not-found');
    assert.strictEqual((await service.markCustomerRead(12, a.conversationId)).ok, false);
    assert.deepStrictEqual((await service.listConversations(12)).conversations, []);
});

test('4. human request pauses the AI and notifies the operators', async () => {
    const { service, db, events } = makeService();
    const out = await service.sendCustomerMessage({ userId: 21, body: 'I need help' });
    const paused = await service.requestHuman(21, out.conversationId);
    assert.strictEqual(paused.ok, true);
    assert.strictEqual(paused.aiPaused, true);
    assert.strictEqual(paused.status, 'waiting');
    const conv = db._tables.support_conversations.find((c) => c.id === out.conversationId);
    assert.strictEqual(conv.ai_paused, true);
    assert.ok(db._tables.support_actions.some((a) => a.action === 'escalate'));
    assert.ok(events.some((e) => e.kind === 'admins'));
});

test('5. while a human owns the thread the AI stays silent', async () => {
    const { service, db } = makeService();
    const out = await service.sendCustomerMessage({ userId: 31, body: 'first' });
    await service.takeover(out.conversationId, 900);
    const before = db._tables.support_messages.length;
    const next = await service.sendCustomerMessage({ userId: 31, conversationId: out.conversationId, body: 'second' });
    assert.strictEqual(next.ok, true);
    assert.strictEqual(next.aiPaused, true);
    assert.strictEqual(next.reply, null, 'no AI reply while a human owns the thread');
    assert.strictEqual(db._tables.support_messages.length, before + 1, 'only the customer message was added');
});

test('6. takeover, resume and resolve are recorded and reversible', async () => {
    const { service, db } = makeService();
    const out = await service.sendCustomerMessage({ userId: 41, body: 'hi' });
    const conv = () => db._tables.support_conversations.find((c) => c.id === out.conversationId);
    await service.takeover(out.conversationId, 900);
    assert.strictEqual(conv().ai_paused, true);
    assert.strictEqual(conv().assigned_admin_id, 900);
    assert.strictEqual(conv().status, 'assigned');
    await service.resume(out.conversationId, 900);
    assert.strictEqual(conv().ai_paused, false, 'AI resumes');
    await service.resolve(out.conversationId, 900);
    assert.strictEqual(conv().status, 'resolved');
    assert.ok(conv().resolved_at);
    const actions = db._tables.support_actions.map((a) => a.action);
    assert.ok(actions.indexOf('takeover') !== -1 && actions.indexOf('resume') !== -1 && actions.indexOf('resolve') !== -1);
});

test('7. an administrator can initiate a conversation and the customer is notified', async () => {
    const { service, db, events } = makeService();
    const out = await service.initiate({ adminId: 900, userId: 55, body: 'We reviewed your deposit.' });
    assert.strictEqual(out.ok, true);
    const conv = db._tables.support_conversations[0];
    assert.strictEqual(conv.user_id, 55);
    assert.strictEqual(conv.status, 'assigned');
    const msg = db._tables.support_messages.filter((m) => m.conversation_id === out.conversationId);
    assert.strictEqual(msg.length, 1);
    assert.strictEqual(msg[0].sender_type, 'agent');
    assert.ok(db._tables.support_actions.some((a) => a.action === 'initiate'));
    assert.ok(events.some((e) => e.kind === 'customer' && e.userId === 55));
});

test('8. unread counters move with each side', async () => {
    const { service, db } = makeService();
    const out = await service.sendCustomerMessage({ userId: 61, body: 'question' });
    const conv = () => db._tables.support_conversations.find((c) => c.id === out.conversationId);
    assert.strictEqual(conv().unread_for_admin, 1, 'customer message raises the admin counter');
    assert.strictEqual(conv().unread_for_customer, 1, 'AI reply raises the customer counter');
    await service.markCustomerRead(61, out.conversationId);
    assert.strictEqual(conv().unread_for_customer, 0);
    await service.sendAgentMessage({ adminId: 900, conversationId: out.conversationId, body: 'answer' });
    assert.strictEqual(conv().unread_for_customer, 1, 'agent reply raises the customer counter again');
});

test('9. AI failure degrades to an honest human-handoff message', async () => {
    const { service, db } = makeService({ options: { ai: { ask: async () => { throw new Error('provider down'); } } } });
    const out = await service.sendCustomerMessage({ userId: 71, body: 'What is my balance?', language: 'en' });
    assert.strictEqual(out.ok, true);
    assert.match(out.reply.body, /support agent will reply/i);
    assert.strictEqual(out.status, 'waiting');
    assert.strictEqual(db._tables.support_conversations[0].ai_paused, true);
});

test('10. validation: empty, oversized and missing-user requests are refused', async () => {
    const { service } = makeService();
    assert.strictEqual((await service.sendCustomerMessage({ userId: 0, body: 'x' })).reason, 'unauthenticated');
    assert.strictEqual((await service.sendCustomerMessage({ userId: 81, body: '   ' })).reason, 'empty-body');
    const res = await service.sendCustomerMessage({ userId: 81, body: 'x'.repeat(NS.LIMITS.messageMaxChars + 1) });
    assert.strictEqual(res.reason, 'body-too-long');
    assert.strictEqual(res.max, NS.LIMITS.messageMaxChars);
});

test('11. rate limiting stops a flood', async () => {
    const { service } = makeService({ options: { limits: { messagesPerMinute: 2 } } });
    await service.sendCustomerMessage({ userId: 91, body: 'one' });
    await service.sendCustomerMessage({ userId: 91, body: 'two' });
    const third = await service.sendCustomerMessage({ userId: 91, body: 'three' });
    assert.strictEqual(third.ok, false);
    assert.strictEqual(third.reason, 'rate-limited');
});

test('12. admin counts and search cover the inbox needs', async () => {
    const { service } = makeService();
    const first = await service.sendCustomerMessage({ userId: 101, body: 'deposit stuck', category: 'deposit' });
    const second = await service.sendCustomerMessage({ userId: 102, body: 'withdraw pending', category: 'withdrawal' });
    assert.notStrictEqual(first.conversationId, second.conversationId, 'one thread per customer');
    await service.takeover(second.conversationId, 900);
    const counts = await service.countsForAdmin();
    assert.strictEqual(counts.counts.total, 2);
    assert.ok(counts.counts.assigned >= 1);
    assert.ok(counts.counts.unread >= 1);
    const bySearch = await service.listForAdmin({ search: 'withdraw' });
    assert.strictEqual(bySearch.conversations.length, 1);
});

test('13. the flag is off unless NATIVE_SUPPORT_ENABLED is exactly true', () => {
    assert.strictEqual(NS.isNativeSupportEnabled({}), false);
    assert.strictEqual(NS.isNativeSupportEnabled({ NATIVE_SUPPORT_ENABLED: 'false' }), false);
    assert.strictEqual(NS.isNativeSupportEnabled({ NATIVE_SUPPORT_ENABLED: '1' }), false);
    assert.strictEqual(NS.isNativeSupportEnabled({ NATIVE_SUPPORT_ENABLED: 'TRUE' }), true);
});

test('14. routes: flag guard, auth on every customer route, admin on every inbox route', () => {
    const customer = ROUTES.match(/app\.(get|post)\('\/api\/support\/[^']+', guard, authMiddleware/g) || [];
    assert.ok(customer.length >= 6, 'customer routes: ' + customer.length);
    const admin = ROUTES.match(/'\/api\/admin\/support\/[^']+', guard, authMiddleware, adminMiddleware/g) || [];
    assert.ok(admin.length >= 10, 'admin routes: ' + admin.length);
    const gated = ROUTES.match(/app\.(get|post|put|delete)\('\/api\/(admin\/)?support/g) || [];
    assert.strictEqual(gated.length, customer.length + admin.length, 'every support route carries the gate');
    assert.match(ROUTES, /if \(!isEnabled\(\)\) return res\.status\(404\)/);
});

test('15. the customer surface never takes a user id from the client', () => {
    const start = ROUTES.indexOf('customer API');
    const end = ROUTES.indexOf('admin API');
    const customerBlock = ROUTES.slice(start, end);
    assert.ok(customerBlock.indexOf('req.user.id') !== -1);
    assert.ok(!/userId:\s*req\.(body|query)/.test(customerBlock), 'no client user id');
    assert.ok(!/body\.userId/.test(customerBlock), 'no client-supplied userId on the customer surface');
    assert.match(ROUTES, /intParam\(body\.userId/);
});

test('16. route paths are Express 5 safe (no parameter regex)', () => {
    assert.ok(!/:id\(/.test(ROUTES), 'Express 5 rejects :id(\\d+)');
    assert.match(ROUTES, /'\/api\/support\/conversations\/:id\/messages'/);
    assert.match(ROUTES, /'\/api\/admin\/support\/conversations\/:id\/takeover'/);
});

// ------------------------------------------------------------------ migration

test('17. migration 059 creates the three tables with RLS and service_role-only access', () => {
    ['support_conversations', 'support_messages', 'support_actions'].forEach((t) => {
        assert.match(MIGRATION, new RegExp('CREATE TABLE IF NOT EXISTS public\\.' + t));
        assert.match(MIGRATION, new RegExp('ALTER TABLE public\\.' + t + '\\s+ENABLE ROW LEVEL SECURITY'));
        assert.match(MIGRATION, new RegExp('ON public\\.' + t + '\\s+FOR ALL TO service_role'));
        assert.match(MIGRATION, new RegExp('REVOKE ALL ON public\\.' + t + '\\s+FROM PUBLIC, anon, authenticated'));
    });
    assert.ok(!/CREATE POLICY[^;]+TO anon/i.test(MIGRATION), 'no anon policy');
    assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS support_conversations_one_active/);
    assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS support_messages_client_dedupe/);
    assert.match(MIGRATION, /CHECK \(sender_type IN \('customer', 'ai', 'agent', 'system'\)\)/);
    assert.match(MIGRATION, /CHECK \(status IN \('open', 'assigned', 'waiting', 'resolved'\)\)/);
    assert.match(MIGRATION, /RAISE EXCEPTION '059_native_support\.sql incomplete/);
});

test('18. migration 059 touches no financial table and replaces no function', () => {
    const forbidden = /(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)\s+public\.(wallets|deposits|withdrawals|trades|transactions|referrals|subscriptions)/i;
    assert.ok(!forbidden.test(MIGRATION), 'no financial table may be written');
    assert.ok(!/CREATE OR REPLACE FUNCTION/i.test(MIGRATION));
});

test('19. the two support notification events exist with localized keys', () => {
    const source = fs.readFileSync(path.join(ROOT, 'services/Notifications.js'), 'utf8');
    assert.match(source, /supportReply:\s*\{/);
    assert.match(source, /supportMessage:\s*\{/);
    assert.match(source, /'notifications\.events\.supportReply\.title'/);
    assert.match(source, /'notifications\.events\.supportMessage\.title'/);
});

// ------------------------------------------------------------------- frontend

test('20. widget + inbox are flag-gated and rendered from the JS layer', () => {
    assert.match(INDEX, /const NS_TRANSLATIONS = /);
    assert.match(INDEX, /Object\.keys\(NS_TRANSLATIONS\)\.forEach/);
    assert.match(INDEX, /APP\.nativeSupport = data\.nativeSupport === true/);
    assert.match(INDEX, /<script src="\/native-support\.js" defer><\/script>/);
    const clientBundle = fs.readFileSync(path.join(ROOT, 'public/native-support.js'), 'utf8');
    assert.match(clientBundle, /CUSTOMER widget/);
    assert.match(clientBundle, /ADMIN Support Inbox/);
    assert.match(INDEX, /id="adminTabContentSupport"/);
    const bundle = fs.readFileSync(path.join(ROOT, 'public/native-support.js'), 'utf8');
    assert.match(bundle, /window\.NativeSupport = NativeSupport/);
    assert.match(bundle, /window\.NativeSupportInbox = Inbox/);
    assert.match(bundle, /if \(!enabled\(\)\) return;/);
});

test('21. every native string exists in all six locales with matching placeholders', () => {
    const start = INDEX.indexOf('const NS_TRANSLATIONS = ');
    const end = INDEX.indexOf('};', start) + 1;
    const NS_T = JSON.parse(INDEX.slice(INDEX.indexOf('=', start) + 1, end));
    const langs = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
    const enKeys = Object.keys(NS_T.en).sort();
    assert.ok(enKeys.length >= 45, 'keys: ' + enKeys.length);
    langs.forEach((l) => {
        assert.deepStrictEqual(Object.keys(NS_T[l]).sort(), enKeys, l + ' key set');
        enKeys.forEach((k) => {
            assert.ok(String(NS_T[l][k]).trim().length > 0, l + ' ' + k + ' is empty');
            const want = (NS_T.en[k].match(/\{\{\w+\}\}/g) || []).sort();
            const got = (String(NS_T[l][k]).match(/\{\{\w+\}\}/g) || []).sort();
            assert.deepStrictEqual(got, want, l + ' ' + k + ' placeholders');
        });
    });
    ['ns.title', 'admin.supp.inbox', 'notifications.events.supportReply.title'].forEach((k) => {
        assert.ok(NS_T.en[k], k + ' present');
    });
});

test('22. the base dictionary is unchanged and the language switch re-renders the widget', () => {
    const i = INDEX.indexOf('const TRANSLATIONS = {');
    let d = 0, e = -1;
    for (let k = INDEX.indexOf('{', i); k < INDEX.length; k++) {
        if (INDEX[k] === '{') d++;
        else if (INDEX[k] === '}') { d--; if (!d) { e = k; break; } }
    }
    const sb = {};
    vm.createContext(sb);
    vm.runInContext('globalThis.T=' + INDEX.slice(INDEX.indexOf('{', i), e + 1), sb);
    assert.strictEqual(Object.keys(sb.T.en).length, 1586, 'the pinned dictionary is untouched');
    assert.match(INDEX, /NativeSupport\.reloadLabels/);
});

test('23. no money, credentials or innerHTML in the messenger service', () => {
    const service = fs.readFileSync(path.join(ROOT, 'services/NativeSupport.js'), 'utf8');
    const forbidden = /(live_balance|demo_balance|bonus_balance|credit_payment_safe|record_trade_safe|request_withdrawal|convert_referral)/;
    assert.ok(!forbidden.test(service), 'the messenger must not touch money');
    assert.ok(!/password|seed phrase|private key/i.test(service), 'never asks for credentials');
    assert.ok(!/innerHTML/.test(service));
});
