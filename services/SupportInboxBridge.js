'use strict';

/**
 * Telegram bridge for the HUMAN-ONLY in-app support inbox.
 *
 * It connects the SAME conversation backend the customer widget and the admin
 * dashboard use (support_conversations / support_messages) to Telegram, in both
 * directions:
 *
 *   customer message  ->  one Telegram notification to the configured destination
 *   agent reply (TG)  ->  service.sendChannelReply(...) -> stored with via='telegram'
 *
 * Design rules, each one deliberate:
 *
 *  * ONE backend. Nothing here owns a table or a conversation; every write goes
 *    through services/NativeSupport.js, which is the same code the dashboard and
 *    the widget use. There is no second messaging store.
 *  * AUTHORISATION IS THE ADMIN LIST. A reply is accepted only from a Telegram
 *    user id in TELEGRAM_ADMIN_IDS, checked here even though the router already
 *    classified the update, so a future routing change cannot widen access.
 *  * NO SECRETS. Notifications carry the customer's name/e-mail/account id, the
 *    conversation id and the message text. Never a JWT, a balance, a payment
 *    address or a credential - and the formatter is the single place that decides.
 *  * DEDUPE. Every Telegram message maps to a deterministic client_message_id
 *    ('tg:<chatId>:<messageId>'), so a redelivered webhook cannot insert a second
 *    copy; the message table's unique index is the backstop.
 *  * ORDERING. Messages are appended and read by ascending id, so a reply can
 *    never be reordered within a conversation.
 *  * FAILURE ISOLATION. A Telegram outage only loses the NOTIFICATION: the
 *    customer's message is already committed, and notifyConversation never throws.
 */

const COMMAND_PATTERN = /^\/(kxreply|kxresolve|kxassign)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i;
const MAX_NOTIFICATION_BODY = 300;
const MAX_TRACKED = 500;

function toId(value) {
    const n = Number(String(value === undefined || value === null ? '' : value).replace(/^#/, ''));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Parse an agent command. Returns null when the text is not one of ours, so the
 * caller can leave every other Telegram message to the existing handlers.
 *   /kxreply 12 hello       -> { action:'reply', conversationId:12, body:'hello' }
 *   /kxreply #12 hello      -> same
 *   /kxresolve 12           -> { action:'resolve', conversationId:12 }
 *   /kxassign 12 7          -> { action:'assign', conversationId:12, assigneeId:7 }
 */
function parseInboxCommand(text) {
    const raw = String(text === undefined || text === null ? '' : text).trim();
    const match = COMMAND_PATTERN.exec(raw);
    if (!match) return null;
    const action = match[1].toLowerCase() === 'kxreply'
        ? 'reply'
        : (match[1].toLowerCase() === 'kxresolve' ? 'resolve' : 'assign');
    const rest = String(match[2] || '').trim();
    const firstSpace = rest.search(/\s/);
    const idToken = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
    const tail = firstSpace === -1 ? '' : rest.slice(firstSpace).trim();
    const conversationId = toId(idToken);
    if (!conversationId) return null;
    if (action === 'reply') return { action, conversationId, body: tail };
    if (action === 'assign') return { action, conversationId, assigneeId: toId(tail) };
    return { action, conversationId };
}

/**
 * The id of the message a transport just delivered.
 *
 * WHY THIS EXISTS (production defect): `createTelegramTransport.sendMessage()`
 * resolves with the Bot API's `result` object - `{ message_id, date, chat, text }`
 * - because every failure is a thrown error. This module used to read
 * `out.messageId` only, so the id was always `undefined`, `track()` was never
 * called, and an agent replying to a notification could not be mapped back to a
 * conversation. The reply was then dropped (the pass-through below returned null)
 * and the customer saw nothing. Accept every shape so the mapping cannot be lost
 * again: `{ messageId }`, the raw Telegram row `{ message_id }`, or a wrapper
 * `{ result: { message_id } }`.
 */
function deliveredMessageId(out) {
    if (!out || typeof out !== 'object') return null;
    const candidates = [out.messageId, out.message_id, out.result && out.result.message_id];
    for (const value of candidates) {
        if (value === undefined || value === null || value === '') continue;
        return value;
    }
    return null;
}

/**
 * Whether a resolved transport result means "Telegram accepted it". The real
 * transport throws on every non-2xx answer, so a resolved value is a success;
 * an explicit `ok: false` from another transport still counts as a failure.
 */
function deliverySucceeded(out) {
    if (!out || typeof out !== 'object') return false;
    return out.ok !== false;
}

function clip(text, max) {
    const flat = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
    const limit = Number(max) || MAX_NOTIFICATION_BODY;
    return flat.length > limit ? flat.slice(0, limit - 1) + '\u2026' : flat;
}

function stamp(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    if (Number.isNaN(d.getTime())) return 'unknown';
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * The ONE place that decides what a notification may contain. Keep it free of
 * anything financial or secret: name, e-mail and account id are what an agent
 * needs to identify the customer, and nothing more.
 */
function formatCustomerNotification(input) {
    const o = input || {};
    const conversation = o.conversation || {};
    const message = o.message || {};
    const customer = o.customer || {};
    const who = customer.name || '(no name)';
    const email = customer.email || '(no email)';
    const accountId = conversation.user_id || customer.id || '?';
    const lines = [
        '\uD83D\uDCE8 New support message #' + (conversation.id || '?'),
        'From: ' + who + ' \u00B7 ' + email + ' \u00B7 account #' + accountId,
        'Category: ' + (conversation.category || 'general')
            + ' \u00B7 Language: ' + (conversation.language || 'en')
            + ' \u00B7 Time: ' + stamp(message.created_at || o.now)
    ];
    if (conversation.status) lines.push('Status: ' + conversation.status);
    lines.push('');
    lines.push('"' + clip(message.body) + '"');
    lines.push('');
    lines.push('Reply to this message, or use:');
    lines.push('/kxreply ' + (conversation.id || '<id>') + ' <your reply>');
    lines.push('/kxresolve ' + (conversation.id || '<id>'));
    return lines.join('\n');
}

function createSupportInboxBridge(options) {
    const opts = options || {};
    const getService = typeof opts.getService === 'function' ? opts.getService : () => null;
    const transport = opts.transport || null;
    const config = opts.config || {};
    const adminIds = (Array.isArray(config.adminIds) ? config.adminIds : []).map(String);
    const supportChatId = config.supportChatId ? String(config.supportChatId) : null;
    const lookupCustomer = typeof opts.lookupCustomer === 'function' ? opts.lookupCustomer : null;
    const logger = opts.logger || { warn() {}, info() {} };
    const now = typeof opts.now === 'function' ? opts.now : () => new Date();

    // Telegram message id -> conversation id, so an agent can simply REPLY to a
    // notification. Bounded: a long-running process must not grow without limit.
    const tracked = new Map();
    let warnedMissingId = false;
    function track(messageId, conversationId) {
        if (messageId === undefined || messageId === null) return;
        tracked.set(String(messageId), conversationId);
        while (tracked.size > MAX_TRACKED) {
            const oldest = tracked.keys().next();
            if (oldest.done) break;
            tracked.delete(oldest.value);
        }
    }

    function isAuthorized(route) {
        if (!route || route.fromId === undefined || route.fromId === null) return false;
        return adminIds.indexOf(String(route.fromId)) !== -1;
    }

    function recipients() {
        if (supportChatId) return [supportChatId];
        return adminIds.slice();
    }

    async function customerFor(userId) {
        if (!lookupCustomer || !userId) return null;
        try {
            return (await lookupCustomer(userId)) || null;
        } catch (error) {
            logger.warn('[SupportBridge] customer lookup failed: ' + (error && error.message));
            return null;
        }
    }

    /**
     * Tell the agents. Never throws: the customer's message is already stored, and
     * losing a notification must not turn into a failed customer request.
     */
    async function notifyConversation(conversation, message) {
        try {
            if (!transport || typeof transport.sendMessage !== 'function') {
                return { sent: false, reason: 'not-configured' };
            }
            const to = recipients();
            if (!to.length) return { sent: false, reason: 'no-recipients' };
            const customer = await customerFor(conversation && conversation.user_id);
            const text = formatCustomerNotification({ conversation, message, customer, now: now() });
            let sentCount = 0;
            const messageIds = [];
            for (const chatId of to) {
                try {
                    const out = await transport.sendMessage(chatId, text, { disable_notification: true });
                    if (deliverySucceeded(out)) {
                        sentCount += 1;
                        const messageId = deliveredMessageId(out);
                        if (messageId !== null) {
                            messageIds.push(messageId);
                            track(messageId, conversation && conversation.id);
                        } else if (!warnedMissingId) {
                            warnedMissingId = true;
                            logger.warn('[SupportBridge] notification delivered without a message id; '
                                + 'replies to it cannot be routed (use /kxreply <conversation id> <text>)');
                        }
                    }
                } catch (error) {
                    logger.warn('[SupportBridge] notify failed: ' + (error && error.message));
                }
            }
            return { sent: sentCount > 0, sentCount, messageIds };
        } catch (error) {
            logger.warn('[SupportBridge] notify error: ' + (error && error.message));
            return { sent: false, reason: 'error' };
        }
    }

    async function advise(route, text) {
        try {
            if (transport && typeof transport.sendMessage === 'function' && route && route.chatId) {
                await transport.sendMessage(String(route.chatId), text, { disable_notification: true });
            }
        } catch (error) {
            logger.warn('[SupportBridge] advisory send failed: ' + (error && error.message));
        }
    }

    /**
     * Handle an agent's Telegram message. Returns null when the update is not an
     * inbox action (the bot's normal routing then applies), or a result object
     * when it was handled - success or a refusal the agent must see.
     */
    async function tryHandle(route, update) {
        if (!route || !isAuthorized(route)) return null;

        const command = parseInboxCommand(route.text);
        const repliedTo = route.replyToMessageId ? tracked.get(String(route.replyToMessageId)) : undefined;
        const conversationId = command ? command.conversationId : (repliedTo || null);
        if (!conversationId) return null;

        const action = command ? command.action : 'reply';
        const body = command ? command.body : String(route.text || '').trim();

        const service = getService();
        if (!service) {
            await advise(route, 'The support inbox is not available right now. Nothing was sent to the customer.');
            return { handled: true, action: 'kxunavailable', ok: false };
        }

        try {
            if (action === 'reply') {
                if (!body) {
                    await advise(route, 'Nothing to send. Use: /kxreply ' + conversationId + ' <your reply>');
                    return { handled: true, action: 'kxreply', ok: false, reason: 'empty' };
                }
                const result = await service.sendChannelReply({
                    conversationId,
                    body,
                    // Deterministic per Telegram message: a redelivery is a duplicate,
                    // not a second reply.
                    clientMessageId: route.messageId ? ('tg:' + route.chatId + ':' + route.messageId) : null,
                    detail: { telegramUserId: route.fromId || null, telegramChatId: route.chatId || null },
                });
                if (!result || result.ok !== true) {
                    await advise(route, 'Could not deliver that reply (#'
                        + conversationId + '): ' + ((result && result.reason) || 'unknown') + '. Please retry.');
                    return { handled: true, action: 'kxreply', ok: false, reason: (result && result.reason) || 'unknown' };
                }
                if (result.duplicate) {
                    await advise(route, 'Already delivered to conversation #' + conversationId + '.');
                    return { handled: true, action: 'kxreply', ok: true, duplicate: true };
                }
                await advise(route, '\u2705 Reply delivered to conversation #' + conversationId + '.');
                return { handled: true, action: 'kxreply', ok: true, conversationId };
            }

            if (action === 'resolve') {
                const result = await service.resolve(conversationId, null);
                if (!result || result.ok !== true) {
                    await advise(route, 'Could not resolve #' + conversationId + '.');
                    return { handled: true, action: 'kxresolve', ok: false };
                }
                await advise(route, '\u2705 Conversation #' + conversationId + ' marked resolved.');
                return { handled: true, action: 'kxresolve', ok: true, conversationId };
            }

            if (action === 'assign') {
                if (!command.assigneeId) {
                    await advise(route, 'Use: /kxassign ' + conversationId + ' <admin user id>');
                    return { handled: true, action: 'kxassign', ok: false, reason: 'no-assignee' };
                }
                const result = await service.assign(conversationId, null, command.assigneeId);
                if (!result || result.ok !== true) {
                    await advise(route, 'Could not assign #' + conversationId + '.');
                    return { handled: true, action: 'kxassign', ok: false };
                }
                await advise(route, '\u2705 Conversation #' + conversationId + ' assigned.');
                return { handled: true, action: 'kxassign', ok: true, conversationId };
            }
            return null;
        } catch (error) {
            logger.warn('[SupportBridge] command failed: ' + (error && error.message));
            await advise(route, 'That action failed. The customer has not received anything; please retry.');
            return { handled: true, action: 'kxerror', ok: false };
        }
    }

    return {
        notifyConversation,
        tryHandle,
        // Exposed for diagnostics and tests only; never printed with content.
        describe() {
            return {
                authorizedAgents: adminIds.length,
                destination: supportChatId ? 'support-chat' : (adminIds.length ? 'admins' : 'none'),
                transport: !!(transport && typeof transport.sendMessage === 'function'),
                trackedNotifications: tracked.size,
            };
        },
    };
}

module.exports = {
    COMMAND_PATTERN,
    MAX_NOTIFICATION_BODY,
    parseInboxCommand,
    formatCustomerNotification,
    deliveredMessageId,
    deliverySucceeded,
    createSupportInboxBridge,
};
