'use strict';

/**
 * Reply retrieval: a Telegram or dashboard agent reply must reach the customer's
 * widget, survive a page refresh and never duplicate.
 *
 * WHAT MAKES THIS TEST DIFFERENT
 *   It runs the REAL module chain end to end:
 *
 *     HTTP  ->  services/nativeSupportRoutes.js
 *           ->  services/NativeSupport.js
 *           ->  tests/helpers/fake-postgrest.js   (projection + constraints, like PostgREST)
 *
 *     Telegram webhook -> createTelegramSupportBot -> services/SupportInboxBridge.js
 *                      -> createTelegramTransport (real, fake fetch)
 *                      -> services/NativeSupport.js (same conversation)
 *
 *   The previous suites used a fake that returned WHOLE rows whatever the code
 *   selected and a transport fake that returned `{ ok, messageId }` - a shape the
 *   real transport never produces. Both hid production defects:
 *     * support_messages.via was never selected, so the widget could not render
 *       message origin;
 *     * the bridge read `out.messageId`, got `undefined`, never tracked the
 *       notification, and therefore silently DROPPED every Telegram reply that was
 *       sent by replying to the notification.
 *   Here the database double enforces the projection and the transport is the real
 *   one over a fake `fetch`, so those two mistakes cannot pass again.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const NS = require('../services/NativeSupport');
const { registerNativeSupportRoutes } = require('../services/nativeSupportRoutes');
const { createSupportInboxBridge } = require('../services/SupportInboxBridge');
const { createTelegramSupportBot, createTelegramTransport } = require('../services/TelegramSupportService');
const { createFakeSupabase } = require('./helpers/fake-postgrest');

const TOKEN = '123456789:TEST-TOKEN-NOT-A-CREDENTIAL';
const ADMIN_TG_ID = '6054625818';
const CUSTOMER = 7;
const OTHER_CUSTOMER = 8;
const ADMIN_USER = 900;

// --------------------------------------------------------------------- database

/**
 * The shipped schema for the support tables (migrations 059 + 061).
 * `includeViaColumn: false` models a deployment where 061 has not been applied.
 */
function supportSchema(options) {
    const o = options || {};
    const includeVia = o.includeViaColumn !== false;
    const messageColumns = [
        'id', 'conversation_id', 'sender_type', 'sender_user_id', 'body',
        'client_message_id', 'created_at'
    ];
    if (includeVia) messageColumns.push('via');

    return {
        support_conversations: {
            columns: [
                'id', 'user_id', 'category', 'status', 'language', 'subject', 'ai_paused',
                'assigned_admin_id', 'context', 'last_message_at', 'last_message_preview',
                'unread_for_customer', 'unread_for_admin', 'created_at', 'updated_at',
                'resolved_at', 'context_version', 'acknowledged_at'
            ],
            defaults: { status: 'open', ai_paused: false, context_version: 0 }
        },
        support_messages: {
            columns: messageColumns,
            unique: [['conversation_id', 'client_message_id']],
            // Migration 061's BEFORE INSERT trigger derives `via` from the sender,
            // which is what makes the RPC path (which does not know `via`) correct.
            beforeInsert: function (row, spec) {
                if (spec.columns.indexOf('via') === -1) return null;
                if (row.via) return null;
                return { via: row.sender_type === 'customer' ? 'customer' : (row.sender_type === 'agent' ? 'admin' : 'system') };
            }
        },
        support_actions: {
            columns: ['id', 'conversation_id', 'actor_user_id', 'action', 'detail', 'created_at']
        },
        users: {
            columns: ['id', 'name', 'email', 'environment', 'is_admin']
        }
    };
}

/** migration 059's locked RPC, modelled on the fake's tables. */
function supportPostCustomerMessage(params, tables) {
    const conversationId = Number(params.p_conversation_id);
    const conversation = tables.support_conversations.find((c) => Number(c.id) === conversationId);
    if (!conversation) return { ok: false, reason: 'not-found' };
    const clientId = params.p_client_message_id || null;
    if (clientId) {
        const existing = tables.support_messages.find((m) => Number(m.conversation_id) === conversationId
            && m.client_message_id === clientId);
        if (existing) return { ok: true, duplicate: true, message: existing, conversation: conversation };
    }
    const message = {
        id: tables.support_messages.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0) + 1,
        conversation_id: conversationId,
        sender_type: 'customer',
        sender_user_id: null,
        body: params.p_body,
        client_message_id: clientId,
        created_at: new Date().toISOString(),
        // The RPC does not know `via`; migration 061's trigger fills it. The fake's
        // beforeInsert hook cannot run on a direct push, so it is applied here.
        via: 'customer'
    };
    tables.support_messages.push(message);
    conversation.unread_for_admin = Number(conversation.unread_for_admin || 0) + 1;
    conversation.last_message_at = message.created_at;
    conversation.last_message_preview = String(params.p_body).slice(0, 160);
    return { ok: true, duplicate: false, message: message, conversation: conversation };
}

// ---------------------------------------------------------------------- harness

function createStack(options) {
    const o = options || {};
    const client = createFakeSupabase({
        schema: supportSchema({ includeViaColumn: o.includeViaColumn }),
        rpc: { support_post_customer_message: supportPostCustomerMessage },
        rows: {
            users: [
                { id: CUSTOMER, name: 'Ana Customer', email: 'ana@example.com', environment: 'PRODUCTION', is_admin: 0 },
                { id: OTHER_CUSTOMER, name: 'Bob Other', email: 'bob@example.com', environment: 'PRODUCTION', is_admin: 0 },
                { id: ADMIN_USER, name: 'Agent Smith', email: 'agent@example.com', environment: 'PRODUCTION', is_admin: 1 }
            ]
        }
    });

    const telegram = { calls: [], nextId: 5000 };
    let failNextTelegram = false;
    const fetchImpl = async (url, init) => {
        const payload = JSON.parse((init && init.body) || '{}');
        if (failNextTelegram) {
            failNextTelegram = false;
            return { ok: false, status: 502, json: async () => ({ ok: false, error_code: 502, description: 'Bad Gateway' }) };
        }
        const messageId = ++telegram.nextId;
        telegram.calls.push({ method: String(url).split('/').pop(), chatId: String(payload.chat_id), text: payload.text, messageId });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: messageId } }) };
    };
    const transport = createTelegramTransport({ token: TOKEN, fetchImpl });

    let service = null;
    const bridge = createSupportInboxBridge({
        getService: () => service,
        transport,
        config: { adminIds: [ADMIN_TG_ID], supportChatId: null, notifyTarget: 'admins' },
        lookupCustomer: async (userId) => {
            const row = client._tables.users.find((u) => Number(u.id) === Number(userId));
            return row ? { id: row.id, name: row.name, email: row.email } : null;
        },
        logger: { warn: () => {}, info: () => {} }
    });

    service = NS.createNativeSupportService({
        supabase: client,
        // Mirror server.js: the "notify the agents" hook is what posts the Telegram
        // notification whose message id the bridge must remember.
        notifyAdmins: async (conversation, message) => {
            await bridge.notifyConversation(conversation, message);
        },
        notify: async () => {},
        logger: { warn: () => {}, info: () => {} }
    });

    // The Telegram SUPPORT store (the legacy support bot's own tables) must not be
    // touched by an inbox reply: every method would throw. That is the assertion -
    // a reply lands in the in-app conversation, not in the old store.
    const untouchableStore = new Proxy({}, {
        get(_, name) {
            if (name === 'then') return undefined;
            return async () => { throw new Error('the legacy telegram store must not be used: ' + String(name)); };
        }
    });

    const bot = createTelegramSupportBot({
        config: { token: TOKEN, adminIds: [ADMIN_TG_ID], webhookSecret: 'test-secret', baseUrl: 'https://arbitrix.pro' },
        store: untouchableStore,
        transport,
        inbox: bridge,
        logger: { log: () => {}, warn: () => {}, error: () => {} }
    });

    return {
        client,
        service,
        bridge,
        transport,
        bot,
        telegram,
        failNextTelegram: () => { failNextTelegram = true; },
        rows: (table) => client._tables[table]
    };
}

// One real Express app per test, on an ephemeral port, with the real middleware
// contract (a bearer token identifies the caller; no route reads an id from the
// body or the query).
function createApp(stack) {
    const app = express();
    app.use(express.json());
    function authMiddleware(req, res, next) {
        const header = String(req.headers.authorization || '');
        const match = /^Bearer (?:user|admin):(\d+)$/.exec(header);
        if (!match) return res.status(401).json({ error: 'Unauthorized' });
        req.user = { id: Number(match[1]) };
        next();
    }
    function adminMiddleware(req, res, next) {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer admin:')) return res.status(403).json({ error: 'Forbidden' });
        next();
    }
    registerNativeSupportRoutes(app, {
        support: stack.service,
        authMiddleware,
        adminMiddleware,
        supabaseAdmin: stack.client,
        isEnabled: () => true
    });
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({
                server,
                base: 'http://127.0.0.1:' + port,
                customer: (path, init) => call('http://127.0.0.1:' + port, path, 'user:' + CUSTOMER, init),
                other: (path, init) => call('http://127.0.0.1:' + port, path, 'user:' + OTHER_CUSTOMER, init),
                admin: (path, init) => call('http://127.0.0.1:' + port, path, 'admin:' + ADMIN_USER, init),
                anonymous: (path, init) => call('http://127.0.0.1:' + port, path, null, init)
            });
        });
    });
}

async function call(base, path, identity, init) {
    const o = init || {};
    const headers = { 'Content-Type': 'application/json' };
    if (identity) headers.Authorization = 'Bearer ' + identity;
    const res = await fetch(base + path, {
        method: o.method || 'GET',
        headers: headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body)
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text }; }
    return { status: res.status, ok: res.ok, body: body, headers: res.headers };
}

/** An agent reply typed in the admin's Telegram chat as a REPLY to a notification. */
function telegramReplyUpdate(text, replyToMessageId, updateId) {
    return {
        update_id: updateId,
        message: {
            message_id: 900000 + updateId,
            from: { id: Number(ADMIN_TG_ID), is_bot: false, first_name: 'Agent' },
            chat: { id: Number(ADMIN_TG_ID), type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: text,
            reply_to_message: { message_id: Number(replyToMessageId), chat: { id: Number(ADMIN_TG_ID) } }
        }
    };
}

async function firstConversation(stack) {
    const row = stack.rows('support_conversations')[0];
    assert.ok(row, 'a conversation exists');
    return row;
}

// ------------------------------------------------------------------------ tests

test('1. a Telegram reply sent BY REPLYING to the notification reaches the customer', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const sent = await app.customer('/api/support/conversations', { method: 'POST', body: { category: 'general', language: 'en' } });
    assert.strictEqual(sent.status, 201);
    const conversationId = sent.body.conversation.id;

    const posted = await app.customer('/api/support/conversations/' + conversationId + '/messages', {
        method: 'POST', body: { body: 'My deposit is missing', clientMessageId: 'c-1' }
    });
    assert.strictEqual(posted.status, 201, JSON.stringify(posted.body));

    // The customer's message is what the agents are told about.
    assert.strictEqual(stack.telegram.calls.length, 1, 'exactly one Telegram notification');
    const notificationId = stack.telegram.calls[0].messageId;
    assert.match(stack.telegram.calls[0].text, /New support message/);

    // The agent replies INSIDE Telegram, using the reply affordance.
    const handled = await stack.bot.handleUpdate(telegramReplyUpdate('We are checking your deposit now.', notificationId, 1));
    assert.ok(handled, 'the bot handled the update');

    const stored = stack.rows('support_messages').filter((m) => Number(m.conversation_id) === conversationId);
    const reply = stored.find((m) => m.sender_type === 'agent');
    assert.ok(reply, 'the agent reply was persisted');
    assert.strictEqual(reply.body, 'We are checking your deposit now.');
    assert.strictEqual(reply.via, 'telegram', 'the origin is recorded');

    // ... and the customer's widget receives it on the next poll.
    const history = await app.customer('/api/support/conversations/' + conversationId + '/messages?after=0');
    assert.strictEqual(history.status, 200);
    const timeline = history.body.messages.map((m) => m.sender_type + ':' + m.body);
    assert.deepStrictEqual(timeline, [
        'customer:My deposit is missing',
        'system:' + NS.copyFor('en', 'received'),
        'agent:We are checking your deposit now.'
    ]);
    const agentRow = history.body.messages.find((m) => m.sender_type === 'agent');
    assert.strictEqual(agentRow.via, 'telegram', 'the customer payload carries the origin');
});

test('2. a dashboard reply is stored as via=admin and reaches the same conversation', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'Hello?' } });

    const replied = await app.admin('/api/admin/support/conversations/' + conversationId + '/messages', {
        method: 'POST', body: { body: 'Answer from the dashboard' }
    });
    assert.strictEqual(replied.status, 201, JSON.stringify(replied.body));
    assert.strictEqual(replied.body.via, 'admin');

    const history = await app.customer('/api/support/conversations/' + conversationId + '/messages');
    const agent = history.body.messages.filter((m) => m.sender_type === 'agent');
    assert.strictEqual(agent.length, 1);
    assert.strictEqual(agent[0].via, 'admin');
    assert.strictEqual(agent[0].body, 'Answer from the dashboard');
});

test('3. the customer payload exposes id, sender, body, created_at, client id AND via', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    await app.customer('/api/support/conversations/' + conversationId + '/messages', {
        method: 'POST', body: { body: 'payload check', clientMessageId: 'c-payload' }
    });

    const history = await app.customer('/api/support/conversations/' + conversationId + '/messages');
    const row = history.body.messages[0];
    ['id', 'conversation_id', 'sender_type', 'body', 'created_at', 'client_message_id', 'via']
        .forEach((column) => {
            assert.ok(Object.prototype.hasOwnProperty.call(row, column), 'the projection includes ' + column);
        });
    assert.strictEqual(row.via, 'customer');
    assert.strictEqual(row.client_message_id, 'c-payload');
});

test('4. a fresh page restores the WHOLE conversation in chronological order', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'one' } });
    await app.admin('/api/admin/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'two' } });
    await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'three' } });
    await app.admin('/api/admin/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'four' } });

    const history = await app.customer('/api/support/conversations/' + conversationId + '/messages');
    const ids = history.body.messages.map((m) => Number(m.id));
    assert.deepStrictEqual(ids, ids.slice().sort((a, b) => a - b), 'ascending ids');
    // The thread: customer/system-ack/agent/customer/agent. The acknowledgement is
    // a SYSTEM row (it never pretends to be a person) and is NOT duplicated.
    const system = history.body.messages.filter((m) => m.sender_type === 'system');
    assert.strictEqual(system.length, 1, 'exactly one acknowledgement');
    assert.strictEqual(system[0].body, NS.copyFor('en', 'received'));
    assert.deepStrictEqual(history.body.messages.filter((m) => m.sender_type !== 'system').map((m) => m.body),
        ['one', 'two', 'three', 'four']);
    assert.deepStrictEqual(history.body.messages.filter((m) => m.sender_type !== 'system').map((m) => m.sender_type),
        ['customer', 'agent', 'customer', 'agent']);
});

test('5. incremental polling returns only what the client has not seen', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'first' } });

    const initial = await app.customer('/api/support/conversations/' + conversationId + '/messages');
    const cursor = Math.max.apply(null, initial.body.messages.map((m) => Number(m.id)));

    await app.admin('/api/admin/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'agent one' } });
    const firstPoll = await app.customer('/api/support/conversations/' + conversationId + '/messages?after=' + cursor);
    assert.deepStrictEqual(firstPoll.body.messages.map((m) => m.body), ['agent one']);

    const nextCursor = Number(firstPoll.body.messages[0].id);
    await app.admin('/api/admin/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'agent two' } });
    const secondPoll = await app.customer('/api/support/conversations/' + conversationId + '/messages?after=' + nextCursor);
    assert.deepStrictEqual(secondPoll.body.messages.map((m) => m.body), ['agent two']);

    // Polling again with no new rows must not re-send anything.
    const idle = await app.customer('/api/support/conversations/' + conversationId + '/messages?after=' + Number(secondPoll.body.messages[0].id));
    assert.deepStrictEqual(idle.body.messages, []);
});

test('6. consecutive agent replies are all stored once and never duplicated', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'question' } });
    const notificationId = stack.telegram.calls[0].messageId;

    await stack.bot.handleUpdate(telegramReplyUpdate('reply 1', notificationId, 2));
    await stack.bot.handleUpdate(telegramReplyUpdate('reply 2', notificationId, 3));
    await stack.bot.handleUpdate(telegramReplyUpdate('reply 3', notificationId, 4));

    const agents = stack.rows('support_messages').filter((m) => m.sender_type === 'agent');
    assert.deepStrictEqual(agents.map((m) => m.body), ['reply 1', 'reply 2', 'reply 3']);

    // A redelivered webhook (same update) must not create a fourth copy.
    await stack.bot.handleUpdate(telegramReplyUpdate('reply 3', notificationId, 4));
    assert.strictEqual(stack.rows('support_messages').filter((m) => m.sender_type === 'agent').length, 3);

    // Two identical reads must return the same three rows.
    const a = await app.customer('/api/support/conversations/' + conversationId + '/messages');
    const b = await app.customer('/api/support/conversations/' + conversationId + '/messages');
    assert.deepStrictEqual(a.body.messages.map((m) => m.id), b.body.messages.map((m) => m.id));
    assert.strictEqual(a.body.messages.filter((m) => m.sender_type === 'agent').length, 3);
});

test('7. a long thread returns the NEWEST messages on a full read', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    for (let i = 1; i <= 8; i += 1) {
        await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'm' + i } });
    }
    await app.admin('/api/admin/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'final answer' } });

    // limit=5 emulates a thread longer than the read window: an ascending+limit
    // read would return m1..m5 and the agent's answer would be unreachable.
    const history = await app.customer('/api/support/conversations/' + conversationId + '/messages?limit=5');
    const bodies = history.body.messages.map((m) => m.body);
    assert.deepStrictEqual(bodies, ['m5', 'm6', 'm7', 'm8', 'final answer']);
});

test('8. a failed read is a clean 503 and the history is intact afterwards', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'after the failure' } });

    // Break the read the way a database outage does: the query resolves with an
    // error (supabase-js never throws), so the service must map it to 503.
    const original = stack.client.from;
    stack.client.from = function (table) {
        if (table === 'support_messages') {
            const broken = {
                select() { return broken; },
                eq() { return broken; },
                gt() { return broken; },
                order() { return broken; },
                limit() { return broken; },
                then(resolve) { return Promise.resolve({ data: null, error: { code: '57P01', message: 'connection lost' } }).then(resolve); }
            };
            return broken;
        }
        return original(table);
    };
    const failed = await app.customer('/api/support/conversations/' + conversationId + '/messages');
    assert.strictEqual(failed.status, 503);
    assert.strictEqual(failed.body.ok, false);
    assert.strictEqual(failed.body.error, 'unavailable');

    stack.client.from = original;
    const recovered = await app.customer('/api/support/conversations/' + conversationId + '/messages');
    assert.strictEqual(recovered.status, 200);
    assert.ok(recovered.body.messages.some((m) => m.body === 'after the failure'));
});

test('9. another customer cannot read the thread, and anonymous callers get 401', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'private' } });

    const other = await app.other('/api/support/conversations/' + conversationId + '/messages');
    assert.strictEqual(other.status, 404, 'a foreign conversation does not exist for another customer');

    const anonymous = await app.anonymous('/api/support/conversations/' + conversationId + '/messages');
    assert.strictEqual(anonymous.status, 401);
});

test('10. the transcript is never cacheable', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'cache' } });

    const history = await app.customer('/api/support/conversations/' + conversationId + '/messages');
    assert.match(String(history.headers.get('cache-control') || ''), /no-store/);
});

test('11. a database without migration 061 still stores and serves agent replies', async (t) => {
    // Deployments are migration-gated. A missing `via` column must degrade the
    // METADATA only - never the message, which is the product.
    const stack = createStack({ includeViaColumn: false });
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'question' } });

    const replied = await app.admin('/api/admin/support/conversations/' + conversationId + '/messages', {
        method: 'POST', body: { body: 'reply without the via column' }
    });
    assert.strictEqual(replied.status, 201, JSON.stringify(replied.body));

    const history = await app.customer('/api/support/conversations/' + conversationId + '/messages');
    assert.strictEqual(history.status, 200);
    const agent = history.body.messages.find((m) => m.sender_type === 'agent');
    assert.ok(agent, 'the agent reply is visible');
    assert.strictEqual(agent.body, 'reply without the via column');
    assert.strictEqual(agent.via, undefined, 'no fabricated origin when the column is absent');
});

test('12. a Telegram notification failure never loses the customer message', async (t) => {
    const stack = createStack();
    const app = await createApp(stack);
    t.after(() => app.server.close());

    const created = await app.customer('/api/support/conversations', { method: 'POST', body: {} });
    const conversationId = created.body.conversation.id;
    stack.failNextTelegram();
    const posted = await app.customer('/api/support/conversations/' + conversationId + '/messages', {
        method: 'POST', body: { body: 'still stored' }
    });
    assert.strictEqual(posted.status, 201);
    assert.ok(stack.rows('support_messages').some((m) => m.body === 'still stored'));

    // The next message notifies normally, and ITS reply routes correctly.
    await app.customer('/api/support/conversations/' + conversationId + '/messages', { method: 'POST', body: { body: 'second' } });
    const notificationId = stack.telegram.calls[stack.telegram.calls.length - 1].messageId;
    await stack.bot.handleUpdate(telegramReplyUpdate('routed reply', notificationId, 5));
    assert.ok(stack.rows('support_messages').some((m) => m.body === 'routed reply'));
});

test('13. the bridge tracks the REAL transport result shape', () => {
    const { deliveredMessageId, deliverySucceeded } = require('../services/SupportInboxBridge');
    // The transport's own value is preserved (numbers stay numbers); `track()`
    // normalises to a string key.
    assert.strictEqual(deliveredMessageId({ message_id: 501, date: 1, chat: { id: 1 }, text: 'x' }), 501);
    assert.strictEqual(deliveredMessageId({ messageId: 7 }), 7);
    assert.strictEqual(deliveredMessageId({ result: { message_id: 9 } }), 9);
    assert.strictEqual(deliveredMessageId({}), null);
    assert.strictEqual(deliveredMessageId(null), null);
    assert.strictEqual(deliverySucceeded({ message_id: 501 }), true);
    assert.strictEqual(deliverySucceeded({ ok: false }), false);
    assert.strictEqual(deliverySucceeded(null), false);
    // The real transport's body: no `ok`, no `messageId` - the shape that used to
    // be read as a failure and silently dropped every reply.
    const realShape = { message_id: 501, date: 1, chat: { id: 111 }, text: 'hello' };
    assert.strictEqual(deliverySucceeded(realShape), true);
    assert.strictEqual(deliveredMessageId(realShape), 501);
});
