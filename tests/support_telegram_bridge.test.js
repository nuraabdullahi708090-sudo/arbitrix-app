'use strict';

/**
 * Telegram <-> in-app support bridge (human-only support).
 *
 * The REAL services/SupportInboxBridge.js runs against a fake transport and a fake
 * inbox service, so the assertions pin the shipped code: authorisation, the
 * notification contents, command parsing, dedupe keys, failure isolation and the
 * fact that a Telegram reply lands in the SAME conversation the widget and the
 * dashboard use.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGE = require('../services/SupportInboxBridge');
const { createSupportInboxBridge, parseInboxCommand, formatCustomerNotification } = BRIDGE;
const { routeUpdate } = require('../services/TelegramSupportService');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const BOT = fs.readFileSync(path.join(ROOT, 'services/TelegramSupportService.js'), 'utf8');

function makeTransport(outcomes) {
    const sent = [];
    return {
        sent,
        async sendMessage(chatId, text, options) {
            const next = outcomes && outcomes.length ? outcomes.shift() : { ok: true, messageId: 500 + sent.length };
            sent.push({ chatId: String(chatId), text, options });
            if (next instanceof Error) throw next;
            return next;
        }
    };
}

function makeService(overrides) {
    const calls = [];
    const base = {
        async sendChannelReply(input) { calls.push({ kind: 'reply', input }); return { ok: true, conversationId: input.conversationId }; },
        async resolve(id) { calls.push({ kind: 'resolve', id }); return { ok: true, conversationId: id }; },
        async assign(id, adminId, assignee) { calls.push({ kind: 'assign', id, adminId, assignee }); return { ok: true, conversationId: id }; }
    };
    return { service: Object.assign(base, overrides || {}), calls };
}

function bridgeWith(opts) {
    const o = opts || {};
    return createSupportInboxBridge({
        getService: o.getService || (() => o.service),
        transport: o.transport === undefined ? makeTransport() : o.transport,
        config: o.config || { adminIds: ['42'], supportChatId: null },
        lookupCustomer: o.lookupCustomer || (async () => ({ id: 7, name: 'Jane Doe', email: 'jane@example.com' })),
        logger: { warn() {}, info() {} },
        now: () => new Date('2026-11-26T10:00:00Z')
    });
}

function route(overrides) {
    return Object.assign({
        kind: 'group', chatId: '-1001234567890', chatType: 'supergroup', fromId: '42',
        isAdmin: true, messageId: '77', replyToMessageId: null, text: '', command: null
    }, overrides || {});
}

const conversation = { id: 12, user_id: 7, category: 'general', language: 'en', status: 'open' };
const message = { id: 900, body: 'I sent USDT 30 minutes ago and it is still not credited.', created_at: '2026-11-26T09:59:00Z' };

// ------------------------------------------------------------------ parsing

test('1. agent commands parse, and everything else is left to the existing bot', () => {
    assert.deepStrictEqual(parseInboxCommand('/kxreply 12 hello there'),
        { action: 'reply', conversationId: 12, body: 'hello there' });
    assert.deepStrictEqual(parseInboxCommand('/kxreply #12 hi'), { action: 'reply', conversationId: 12, body: 'hi' });
    assert.deepStrictEqual(parseInboxCommand('/kxreply@ArbitrixSupportBot 12 hi'),
        { action: 'reply', conversationId: 12, body: 'hi' });
    assert.deepStrictEqual(parseInboxCommand('/kxresolve 12'), { action: 'resolve', conversationId: 12 });
    assert.deepStrictEqual(parseInboxCommand('/kxassign 12 7'), { action: 'assign', conversationId: 12, assigneeId: 7 });
    ['/reply 12 hi', '/kxreply', '/kxreply abc hi', 'kxreply 12 hi', '/start', '', null].forEach((text) => {
        assert.strictEqual(parseInboxCommand(text), null, JSON.stringify(text) + ' is not an inbox command');
    });
});

// ------------------------------------------------------------- notification

test('2. the notification identifies the customer and the conversation, and nothing else', () => {
    const text = formatCustomerNotification({ conversation, message, customer: { name: 'Jane Doe', email: 'jane@example.com' } });
    assert.match(text, /New support message #12/);
    assert.match(text, /Jane Doe/);
    assert.match(text, /jane@example\.com/);
    assert.match(text, /account #7/);
    assert.match(text, /still not credited/);
    assert.match(text, /\/kxreply 12 <your reply>/);
    // Nothing financial or secret may travel: no balances, addresses, tokens.
    assert.doesNotMatch(text, /jwt|bearer|password|secret|private key|live_balance|wallet address|0x[0-9a-f]{20}/i);
});

test('3. a very long message is clipped, never forwarded whole', () => {
    const text = formatCustomerNotification({ conversation, message: { body: 'x'.repeat(2000) }, customer: {} });
    assert.ok(text.length < 700, 'the notification stays within one Telegram message');
    assert.match(text, /\u2026/);
});

test('4. notifications go to the configured support chat, else to the admins', async () => {
    const chatTransport = makeTransport();
    const chatBridge = bridgeWith({ transport: chatTransport, config: { adminIds: ['42', '43'], supportChatId: '-100999' } });
    const one = await chatBridge.notifyConversation(conversation, message);
    assert.strictEqual(one.sent, true);
    assert.deepStrictEqual(chatTransport.sent.map((m) => m.chatId), ['-100999'], 'one configured destination');

    const adminTransport = makeTransport();
    const adminBridge = bridgeWith({ transport: adminTransport, config: { adminIds: ['42', '43'], supportChatId: null } });
    await adminBridge.notifyConversation(conversation, message);
    assert.deepStrictEqual(adminTransport.sent.map((m) => m.chatId), ['42', '43'], 'one per admin');
});

test('5. one failing recipient never stops the others, and a failure never throws', async () => {
    const transport = makeTransport([new Error('telegram 502'), { ok: true, messageId: 9 }]);
    const bridge = bridgeWith({ transport, config: { adminIds: ['42', '43'] } });
    const out = await bridge.notifyConversation(conversation, message);
    assert.strictEqual(out.sent, true);
    assert.strictEqual(out.sentCount, 1);
    assert.deepStrictEqual(out.messageIds, [9]);

    const dead = bridgeWith({ transport: { sendMessage: async () => { throw new Error('down'); } } });
    const failed = await dead.notifyConversation(conversation, message);
    assert.strictEqual(failed.sent, false, 'reported, not thrown');
});

test('6. with no transport or no recipients the bridge is inert (no crash, no send)', async () => {
    assert.strictEqual((await bridgeWith({ transport: null }).notifyConversation(conversation, message)).reason, 'not-configured');
    assert.strictEqual((await bridgeWith({ config: { adminIds: [] } }).notifyConversation(conversation, message)).reason, 'no-recipients');
});

// ------------------------------------------------------------- agent replies

test('7. an authorised agent reply reaches the service with a deterministic key', async () => {
    const { service, calls } = makeService();
    const transport = makeTransport();
    const bridge = bridgeWith({ service, transport });

    const out = await bridge.tryHandle(route({ text: '/kxreply 12 Here is what happened.' }), {});
    assert.strictEqual(out.handled, true);
    assert.strictEqual(out.action, 'kxreply');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].input.conversationId, 12);
    assert.strictEqual(calls[0].input.body, 'Here is what happened.');
    assert.strictEqual(calls[0].input.clientMessageId, 'tg:-1001234567890:77',
        'a redelivered webhook maps to the same key, so no duplicate reply');
    assert.match(transport.sent[transport.sent.length - 1].text, /Reply delivered to conversation #12/);
});

test('8. replying to a notification answers the right conversation without a command', async () => {
    const { service, calls } = makeService();
    const transport = makeTransport();
    const bridge = bridgeWith({ service, transport });

    const notified = await bridge.notifyConversation(conversation, message);
    assert.strictEqual(notified.sent, true);
    const notificationId = notified.messageIds[0];

    const out = await bridge.tryHandle(route({
        text: 'Thanks, checking with the payment team now.',
        replyToMessageId: String(notificationId)
    }), {});
    assert.strictEqual(out.handled, true);
    assert.strictEqual(calls[0].input.conversationId, 12);
    assert.match(calls[0].input.body, /checking with the payment team/);
});

test('9. /kxresolve and /kxassign drive the same conversation controls as the dashboard', async () => {
    const { service, calls } = makeService();
    const bridge = bridgeWith({ service, transport: makeTransport() });
    await bridge.tryHandle(route({ text: '/kxresolve 12' }), {});
    await bridge.tryHandle(route({ text: '/kxassign 12 7' }), {});
    assert.deepStrictEqual(calls.map((c) => c.kind), ['resolve', 'assign']);
    assert.strictEqual(calls[1].assignee, 7);
});

test('10. UNAUTHORISED Telegram users cannot reply, and nothing is written', async () => {
    const { service, calls } = makeService();
    const transport = makeTransport();
    const bridge = bridgeWith({ service, transport, config: { adminIds: ['42'] } });
    for (const fromId of ['999', null, undefined]) {
        const out = await bridge.tryHandle(route({ fromId, text: '/kxreply 12 I am not an agent' }), {});
        assert.strictEqual(out, null, 'not handled');
        assert.strictEqual(calls.length, 0, 'the service is never called');
        assert.strictEqual(transport.sent.length, 0, 'nothing is sent');
    }
});

test('11. a customer message that merely looks like a command is not executed', async () => {
    const { service, calls } = makeService();
    const bridge = bridgeWith({ service, transport: makeTransport() });
    // A customer route (no admin id) never reaches the bridge's service call.
    const out = await bridge.tryHandle(route({ fromId: '31337', isAdmin: false, text: '/kxreply 12 hi' }), {});
    assert.strictEqual(out, null);
    assert.strictEqual(calls.length, 0);
});

test('12. a duplicate webhook delivery is reported, not re-sent', async () => {
    const { service, calls } = makeService({
        async sendChannelReply(input) {
            calls.push({ kind: 'reply', input });
            return { ok: true, duplicate: true, conversationId: input.conversationId };
        }
    });
    const transport = makeTransport();
    const bridge = bridgeWith({ service, transport });
    const out = await bridge.tryHandle(route({ text: '/kxreply 12 once' }), {});
    assert.strictEqual(out.duplicate, true);
    assert.match(transport.sent[transport.sent.length - 1].text, /Already delivered/);
});

test('13. a service failure tells the agent the customer received nothing', async () => {
    const { service } = makeService({ async sendChannelReply() { return { ok: false, reason: 'unavailable' }; } });
    const transport = makeTransport();
    const bridge = bridgeWith({ service, transport });
    const out = await bridge.tryHandle(route({ text: '/kxreply 12 hello' }), {});
    assert.strictEqual(out.ok, false);
    assert.match(transport.sent[transport.sent.length - 1].text, /Could not deliver/);
});

test('14. an unavailable inbox, an empty reply and a throwing service are all handled', async () => {
    const noService = bridgeWith({ getService: () => null });
    const t1 = makeTransport();
    const b1 = createSupportInboxBridge({ getService: () => null, transport: t1, config: { adminIds: ['42'] } });
    assert.strictEqual((await b1.tryHandle(route({ text: '/kxreply 12 hi' }), {})).handled, true);
    assert.match(t1.sent[0].text, /not available/);

    const t2 = makeTransport();
    const b2 = createSupportInboxBridge({ getService: () => ({ sendChannelReply: async () => ({ ok: true }) }), transport: t2, config: { adminIds: ['42'] } });
    await b2.tryHandle(route({ text: '/kxreply 12   ' }), {});
    assert.match(t2.sent[0].text, /Nothing to send/);

    const t3 = makeTransport();
    const b3 = createSupportInboxBridge({
        getService: () => ({ sendChannelReply: async () => { throw new Error('boom'); } }),
        transport: t3,
        config: { adminIds: ['42'] }
    });
    assert.strictEqual((await b3.tryHandle(route({ text: '/kxreply 12 hi' }), {})).ok, false);
    assert.match(t3.sent[0].text, /has not received anything/);
    assert.ok(noService);
});

test('15. the bridge never logs or returns customer content or credentials', async () => {
    const logs = [];
    const bridge = createSupportInboxBridge({
        getService: () => null,
        transport: makeTransport(),
        config: { adminIds: ['42'] },
        lookupCustomer: async () => ({ name: 'Jane', email: 'j@example.com' }),
        logger: { warn: (...a) => logs.push(a.join(' ')), info() {} }
    });
    await bridge.notifyConversation(conversation, message);
    assert.deepStrictEqual(logs, [], 'nothing is logged on the happy path');
    const described = JSON.stringify(bridge.describe());
    assert.doesNotMatch(described, /j@example\.com|still not credited|jwt/i);
});

// ------------------------------------------------------- bot + server wiring

test('16. the bot routes operator messages through the bridge before its own handlers', () => {
    assert.match(BOT, /inbox \}\) \{/, 'the bot accepts the collaborator');
    assert.ok(BOT.indexOf('trySupportInbox(route, update)') !== -1, 'the bridge is consulted');
    assert.ok(BOT.indexOf('trySupportInbox(route, update)) || await handleGroupUpdate') !== -1,
        'the bridge gets first refusal on operator messages');
    assert.match(BOT, /replyToMessageId/, 'routeUpdate exposes the replied-to message id');
});

test('17. routeUpdate carries the replied-to message id and the admin flag', () => {
    const update = {
        message: {
            message_id: 77,
            chat: { id: -1001234567890, type: 'supergroup' },
            from: { id: 42, is_bot: false },
            text: 'hello',
            reply_to_message: { message_id: 55 }
        }
    };
    const r = routeUpdate(update, { adminIds: ['42'], supportChatId: '-1001234567890' });
    assert.strictEqual(r.kind, 'group');
    assert.strictEqual(r.replyToMessageId, '55');
    assert.strictEqual(r.isAdmin, true);
});

test('18. server.js notifies Telegram on every customer message and hands the service to the bridge', () => {
    assert.match(SERVER, /supportInboxBridge\.notifyConversation\(conversation, message\)/);
    assert.match(SERVER, /inbox: supportInboxBridge/);
    assert.match(SERVER, /getService: \(\) => nativeSupport/);
    // The customer's message is stored first; the alert is wrapped so it cannot fail the send.
    const hook = SERVER.slice(SERVER.indexOf('notifyAdmins: async'), SERVER.indexOf('notifyAdmins: async') + 1200);
    assert.match(hook, /try \{/);
    assert.match(hook, /catch/);
});

test('19. no AI is involved in the bridge or the notification path', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services/SupportInboxBridge.js'), 'utf8');
    assert.doesNotMatch(src, /composeAiReply|SupportAIService|supportAI|openai|anthropic|deepseek|fetch\(/i);
});
