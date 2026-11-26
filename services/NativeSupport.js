'use strict';

/**
 * Native (in-app) customer support.
 *
 * WHY THIS EXISTS
 *   The platform already had a complete, tested SUPPORT BRAIN for Telegram:
 *   `services/support/ConversationEngine.js` (dialogue planning),
 *   `services/support/SupportAIService.js` (approved knowledge + guardrails),
 *   `services/support/SupportKnowledge.js` and `services/telegram-i18n.js`
 *   (localized customer copy). None of that is duplicated here: this module is
 *   the TRANSPORT, exactly as the Telegram bot is. It persists a thread, asks the
 *   same engine for a plan, asks the same AI service for a grounded answer, and
 *   writes the reply back. There is exactly one support brain.
 *
 * WHAT IT IS NOT
 *   It never reads or writes money: no wallet, deposit, withdrawal, trade,
 *   referral or subscription access, and no code path here can move a balance.
 *   Financial questions are answered by the AI service, which is grounded in the
 *   approved knowledge base and refuses to invent figures or statuses.
 *
 * SAFETY MODEL
 *   * Every CUSTOMER method takes `userId` and filters by it server-side; an id
 *     supplied by the browser is never trusted.
 *   * ADMIN methods are only reachable behind `adminMiddleware`; this module
 *     additionally records who did what in `support_actions` (append-only).
 *   * `ai_paused = TRUE` means a human owns the thread: no AI reply is produced,
 *     so a customer never sees a machine answer over a human one.
 *   * Every Supabase result is inspected for `error` (supabase-js RESOLVES on a
 *     failed query) instead of assuming success.
 *   * A send is idempotent through `client_message_id` (UNIQUE per conversation)
 *     and the duplicate-key path is handled explicitly, so a retried request
 *     cannot duplicate a message.
 *
 * The module is dependency-injected (`supabase`, `ai`, `engine`, `i18n`,
 * `notify`) precisely so it can be executed in tests without a database.
 */

// The shared support brain's validation helper, so a translated answer is held to
// exactly the same checks the Telegram transport applies (`hasExpectedScript`).
const SupportGuidelines = require('./support/SupportGuidelines');

const ENV_FLAG = 'NATIVE_SUPPORT_ENABLED';

const CATEGORIES = ['deposit', 'withdrawal', 'trading', 'account', 'general'];
const LANGUAGES = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];
const STATUS = { OPEN: 'open', ASSIGNED: 'assigned', WAITING: 'waiting', RESOLVED: 'resolved' };
const STATUSES = [STATUS.OPEN, STATUS.ASSIGNED, STATUS.WAITING, STATUS.RESOLVED];
const SENDER = { CUSTOMER: 'customer', AI: 'ai', AGENT: 'agent', SYSTEM: 'system' };

const LIMITS = {
    messageMaxChars: 2000,
    messagesPerMinute: 20,
    conversationsPerHour: 5,
    historyLimit: 200,
    inboxLimit: 100,
};

/** Copy for the states the AI layer cannot cover on its own. */
/** Human-only support: the ONLY automated messages are the static ones below. */
/** No answer text lives here, and nothing in this file reads a model. */
/** Human-only support: the ONLY automated messages are the static ones below. */
/** No answer text lives here, and nothing in this file reads a model. */
const SERVICE_COPY = {
    en: {
        received: 'Thank you for contacting Kalderix. We\'ve received your message and our support team will respond as soon as possible.',
        humanRequested: 'A support agent has been notified and will reply here.',
        agentJoined: 'A support agent has joined this conversation.',
        released: 'This conversation is back in the support queue.',
        resolved: 'This conversation was marked as resolved. Send a new message any time.',
    },
    es: {
        received: 'Gracias por contactar con Kalderix. Hemos recibido tu mensaje y nuestro equipo de soporte responder\u00e1 lo antes posible.',
        humanRequested: 'Se ha notificado a un agente de soporte y responder\u00e1 aqu\u00ed.',
        agentJoined: 'Un agente de soporte se ha unido a esta conversaci\u00f3n.',
        released: 'Esta conversaci\u00f3n vuelve a la cola de soporte.',
        resolved: 'Esta conversaci\u00f3n se marc\u00f3 como resuelta. Puedes enviar un nuevo mensaje cuando quieras.',
    },
    pt: {
        received: 'Obrigado por contactar a Kalderix. Recebemos a sua mensagem e a nossa equipa de suporte responder\u00e1 o mais breve poss\u00edvel.',
        humanRequested: 'Um agente de suporte foi notificado e responder\u00e1 aqui.',
        agentJoined: 'Um agente de suporte entrou nesta conversa.',
        released: 'Esta conversa voltou para a fila de suporte.',
        resolved: 'Esta conversa foi marcada como resolvida. Pode enviar uma nova mensagem a qualquer momento.',
    },
    fr: {
        received: 'Merci d\'avoir contact\u00e9 Kalderix. Nous avons bien re\u00e7u votre message et notre \u00e9quipe d\'assistance vous r\u00e9pondra d\u00e8s que possible.',
        humanRequested: 'Un agent du support a \u00e9t\u00e9 pr\u00e9venu et vous r\u00e9pondra ici.',
        agentJoined: 'Un agent du support a rejoint cette conversation.',
        released: 'Cette conversation est de retour dans la file d\'assistance.',
        resolved: 'Cette conversation a \u00e9t\u00e9 marqu\u00e9e comme r\u00e9solue. Vous pouvez envoyer un nouveau message \u00e0 tout moment.',
    },
    ar: {
        received: '\u0634\u0643\u0631\u0627\u064b \u0644\u062a\u0648\u0627\u0635\u0644\u0643 \u0645\u0639 Kalderix. \u0644\u0642\u062f \u0627\u0633\u062a\u0644\u0645\u0646\u0627 \u0631\u0633\u0627\u0644\u062a\u0643 \u0648\u0633\u064a\u0631\u062f \u0639\u0644\u064a\u0643 \u0641\u0631\u064a\u0642 \u0627\u0644\u062f\u0639\u0645 \u0644\u062f\u064a\u0646\u0627 \u0641\u064a \u0623\u0642\u0631\u0628 \u0648\u0642\u062a \u0645\u0645\u0643\u0646.',
        humanRequested: '\u062a\u0645 \u0625\u0634\u0639\u0627\u0631 \u0623\u062d\u062f \u0645\u0648\u0638\u0641\u064a \u0627\u0644\u062f\u0639\u0645 \u0648\u0633\u064a\u0631\u062f \u0639\u0644\u064a\u0643 \u0647\u0646\u0627.',
        agentJoined: '\u0627\u0646\u0636\u0645 \u0623\u062d\u062f \u0645\u0648\u0638\u0641\u064a \u0627\u0644\u062f\u0639\u0645 \u0625\u0644\u0649 \u0647\u0630\u0647 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629.',
        released: '\u0639\u0627\u062f\u062a \u0647\u0630\u0647 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629 \u0625\u0644\u0649 \u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u062f\u0639\u0645.',
        resolved: '\u062a\u0645 \u0648\u0636\u0639 \u0647\u0630\u0647 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629 \u0643\u0645\u062d\u0644\u0648\u0644\u0629. \u064a\u0645\u0643\u0646\u0643 \u0625\u0631\u0633\u0627\u0644 \u0631\u0633\u0627\u0644\u0629 \u062c\u062f\u064a\u062f\u0629 \u0641\u064a \u0623\u064a \u0648\u0642\u062a.',
    },
    zh: {
        received: '\u611f\u8c22\u60a8\u8054\u7cfb Kalderix\u3002\u6211\u4eec\u5df2\u6536\u5230\u60a8\u7684\u6d88\u606f\uff0c\u5ba2\u670d\u56e2\u961f\u4f1a\u5c3d\u5feb\u56de\u590d\u60a8\u3002',
        humanRequested: '\u5df2\u901a\u77e5\u5ba2\u670d\u4eba\u5458\uff0c\u4ed6\u4eec\u4f1a\u5728\u8fd9\u91cc\u56de\u590d\u60a8\u3002',
        agentJoined: '\u5ba2\u670d\u4eba\u5458\u5df2\u52a0\u5165\u672c\u6b21\u4f1a\u8bdd\u3002',
        released: '\u672c\u6b21\u4f1a\u8bdd\u5df2\u56de\u5230\u5ba2\u670d\u961f\u5217\u3002',
        resolved: '\u672c\u6b21\u4f1a\u8bdd\u5df2\u6807\u8bb0\u4e3a\u5df2\u89e3\u51b3\u3002\u60a8\u53ef\u4ee5\u968f\u65f6\u53d1\u9001\u65b0\u6d88\u606f\u3002',
    },
};

function isNativeSupportEnabled(env) {
    return String((env || process.env || {})[ENV_FLAG] || '').trim().toLowerCase() === 'true';
}

function normalizeLanguage(value) {
    const lang = String(value || '').trim().toLowerCase().slice(0, 2);
    return LANGUAGES.indexOf(lang) === -1 ? 'en' : lang;
}

function normalizeCategory(value) {
    const c = String(value || '').trim().toLowerCase();
    return CATEGORIES.indexOf(c) === -1 ? 'general' : c;
}

function normalizeStatus(value) {
    const s = String(value || '').trim().toLowerCase();
    return STATUSES.indexOf(s) === -1 ? null : s;
}

/** Collapse whitespace, strip control characters, enforce the length window. */
function cleanBody(raw, max) {
    const limit = Number(max) || LIMITS.messageMaxChars;
    if (typeof raw !== 'string') return { ok: false, reason: 'invalid-body' };
    const collapsed = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (!collapsed) return { ok: false, reason: 'empty-body' };
    if (collapsed.length > limit) return { ok: false, reason: 'body-too-long', max: limit };
    return { ok: true, body: collapsed };
}

function previewOf(text, max) {
    const limit = Number(max) || 120;
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > limit ? flat.slice(0, limit - 1) + '\u2026' : flat;
}

function copyFor(language, key) {
    const lang = normalizeLanguage(language);
    return (SERVICE_COPY[lang] && SERVICE_COPY[lang][key]) || SERVICE_COPY.en[key];
}

/** Sliding-window limiter, bounded so a flood cannot grow memory. */
function createRateLimiter(opts) {
    const o = opts || {};
    const limit = Number(o.limit) || 20;
    const windowMs = Number(o.windowMs) || 60000;
    const maxKeys = Number(o.maxKeys) || 5000;
    const now = typeof o.now === 'function' ? o.now : function () { return new Date(); };
    const hits = new Map();
    return function allow(key) {
        const t = now().getTime();
        const list = (hits.get(key) || []).filter(function (ts) { return t - ts < windowMs; });
        if (list.length >= limit) {
            hits.set(key, list);
            return false;
        }
        list.push(t);
        hits.set(key, list);
        if (hits.size > maxKeys) {
            for (const entry of hits) {
                if (!entry[1].length || t - entry[1][entry[1].length - 1] > windowMs) hits.delete(entry[0]);
                if (hits.size <= maxKeys) break;
            }
        }
        return true;
    };
}

function createNativeSupportService(options) {
    const opts = options || {};
    const supabase = opts.supabase;
    // HUMAN-ONLY SUPPORT. This service never talks to a model: there is no `ai`,
    // `engine`, `i18n` or `translator` collaborator any more. A customer message is
    // stored and handed to a human; every reply is written by an agent (dashboard
    // or Telegram). `notify` tells the customer, `notifyAdmins` tells the agents.
    const notify = typeof opts.notify === 'function' ? opts.notify : null;
    const notifyAdmins = typeof opts.notifyAdmins === 'function' ? opts.notifyAdmins : null;
    const now = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
    const logger = opts.logger || { warn: function () {}, info: function () {} };
    const limits = Object.assign({}, LIMITS, opts.limits || {});

    const allowSend = createRateLimiter({ limit: limits.messagesPerMinute, windowMs: 60 * 1000, now: now });
    const allowConversation = createRateLimiter({ limit: limits.conversationsPerHour, windowMs: 60 * 60 * 1000, now: now });
    const warned = {};

    function fail(reason, extra) {
        return Object.assign({ ok: false, reason: reason }, extra || {});
    }

    function logOnce(key, detail) {
        if (warned[key]) return;
        warned[key] = true;
        logger.warn('[native-support] ' + key + ': ' + String(detail || '').slice(0, 200));
    }

    // supabase-js RESOLVES with { error } instead of throwing: convert that into
    // one exception so every caller has a single failure path.
    async function run(builder) {
        const res = await builder;
        if (!res || res.error) {
            const err = new Error((res && res.error && (res.error.message || res.error.code)) || 'supabase-error');
            err.code = (res && res.error && res.error.code) || 'unknown';
            throw err;
        }
        return res;
    }

    async function loadConversation(userId, conversationId) {
        const query = supabase.from('support_conversations').select('*')
            .eq('user_id', userId).eq('id', conversationId);
        const res = await run(query.maybeSingle ? query.maybeSingle() : query);
        return (res && res.data) || null;
    }

    async function loadActiveConversation(userId) {
        const query = supabase.from('support_conversations').select('*')
            .eq('user_id', userId).neq('status', STATUS.RESOLVED)
            .order('last_message_at', { ascending: false, nullsFirst: false }).limit(1);
        const res = await run(query);
        return (res && res.data && res.data[0]) || null;
    }

    async function readConversation(conversationId) {
        const res = await run(supabase.from('support_conversations').select('*').eq('id', conversationId).limit(1));
        return (res && res.data && res.data[0]) || null;
    }

    async function insertConversation(userId, seed) {
        const payload = {
            user_id: userId,
            category: normalizeCategory(seed && seed.category),
            language: normalizeLanguage(seed && seed.language),
            status: STATUS.OPEN,
            ai_paused: false,
            context: {},
            created_at: now().toISOString(),
            updated_at: now().toISOString(),
        };
        const res = await run(supabase.from('support_conversations').insert(payload).select().single());
        return res.data;
    }

    async function getOrCreateConversation(userId, seed) {
        const existing = await loadActiveConversation(userId);
        if (existing) return { ok: true, conversation: existing, created: false };
        if (!allowConversation('conv:' + userId)) return fail('rate-limited');
        try {
            const conversation = await insertConversation(userId, seed || {});
            return { ok: true, conversation: conversation, created: true };
        } catch (err) {
            // Two first messages can race here. The partial unique index allows a
            // single ACTIVE thread per customer, so the loser re-reads instead of
            // failing the customer's message.
            if (err && (err.code === '23505' || /duplicate key/i.test(err.message || ''))) {
                const raced = await loadActiveConversation(userId);
                if (raced) return { ok: true, conversation: raced, created: false };
            }
            throw err;
        }
    }

    async function insertMessage(conversationId, senderType, body, meta) {
        const payload = {
            conversation_id: conversationId,
            sender_type: senderType,
            sender_user_id: (meta && meta.senderUserId) || null,
            body: body,
            client_message_id: (meta && meta.clientMessageId) || null,
            via: (meta && meta.via) || null,
            created_at: now().toISOString(),
        };
        try {
            const res = await run(supabase.from('support_messages').insert(payload).select().single());
            return { ok: true, message: res.data };
        } catch (err) {
            if (err && (err.code === '23505' || /duplicate key/i.test(err.message || ''))) {
                const again = await run(supabase.from('support_messages').select('*')
                    .eq('conversation_id', conversationId)
                    .eq('client_message_id', payload.client_message_id).limit(1));
                const existing = again && again.data && again.data[0];
                if (existing) return { ok: true, message: existing, duplicate: true };
            }
            throw err;
        }
    }

    async function touchConversation(conversationId, patch, counters) {
        const row = await readConversation(conversationId);
        if (!row) throw new Error('conversation-missing');
        const next = Object.assign({}, patch);
        Object.keys(next).forEach(function (k) { if (next[k] === undefined) delete next[k]; });
        next.updated_at = now().toISOString();
        if (counters && counters.unreadForAdmin) {
            next.unread_for_admin = Number(row.unread_for_admin || 0) + counters.unreadForAdmin;
        }
        if (counters && counters.resetCustomer) {
            next.unread_for_customer = 0;
        } else if (counters && counters.unreadForCustomer) {
            next.unread_for_customer = Number(row.unread_for_customer || 0) + counters.unreadForCustomer;
        }
        const res = await run(supabase.from('support_conversations').update(next).eq('id', conversationId).select().single());
        return res.data;
    }

    async function recordAction(conversationId, actorUserId, action, detail) {
        try {
            await run(supabase.from('support_actions').insert({
                conversation_id: conversationId,
                actor_user_id: actorUserId || null,
                action: action,
                detail: detail || {},
                created_at: now().toISOString(),
            }).select().single());
        } catch (err) {
            // The audit trail must never break the action it records.
            logOnce('action-write-failed', err && err.message);
        }
    }

    // The locked RPCs from migration 059 write the message AND move the conversation
    // in one statement. If they are absent (migration not applied) the service falls
    // back to the equivalent sequential writes, logged once.
    let rpcWrites = true;

    function rpcMissing(err) {
        const code = err && err.code;
        return code === '42883' || code === 'PGRST202'
            || /could not find the function|function .* does not exist/i.test(String((err && err.message) || ''));
    }

    async function callRpc(name, params) {
        if (typeof supabase.rpc !== 'function') {
            const e = new Error('rpc-unsupported');
            e.code = '42883';
            throw e;
        }
        const res = await supabase.rpc(name, params);
        if (res && res.error) {
            const e = new Error(res.error.message || res.error.code || 'rpc-error');
            e.code = res.error.code;
            throw e;
        }
        return res && res.data;
    }

    async function postCustomerMessage(conversation, body, clientMessageId) {
        if (rpcWrites) {
            try {
                const out = await callRpc('support_post_customer_message', {
                    p_conversation_id: conversation.id,
                    p_body: body,
                    p_client_message_id: clientMessageId || null,
                });
                if (!out || typeof out.ok !== 'boolean') {
                    throw Object.assign(new Error('post-contract'), { code: 'rpc-contract' });
                }
                if (out.ok !== true) {
                    if (out.reason === 'not-found') return { missing: true };
                    throw Object.assign(new Error('post-failed'), { code: 'rpc-contract' });
                }
                return out;
            } catch (err) {
                if (!rpcMissing(err)) throw err;
                rpcWrites = false;
                logOnce('rpc-missing:post', err && err.message);
            }
        }
        const inserted = await insertMessage(conversation.id, SENDER.CUSTOMER, body, { clientMessageId: clientMessageId, via: 'customer' });
        if (inserted.duplicate) {
            return { duplicate: true, message: inserted.message, conversation: conversation };
        }
        const reopened = conversation.status === STATUS.RESOLVED;
        const row = await touchConversation(conversation.id, {
            status: reopened ? STATUS.OPEN : (conversation.ai_paused ? conversation.status : STATUS.OPEN),
            last_message_at: now().toISOString(),
            last_message_preview: previewOf(body),
            resolved_at: reopened ? null : conversation.resolved_at,
        }, { unreadForAdmin: 1 });
        return { duplicate: false, message: inserted.message, conversation: row };
    }

    // -------------------------------------------------------------- customer side

    async function listConversations(userId) {
        try {
            const res = await run(supabase.from('support_conversations').select(
                'id, category, status, ai_paused, last_message_at, last_message_preview, unread_for_customer, created_at, resolved_at'
            ).eq('user_id', userId).order('last_message_at', { ascending: false, nullsFirst: false }).limit(limits.inboxLimit));
            return { ok: true, conversations: res.data || [] };
        } catch (err) {
            return fail('unavailable');
        }
    }

    async function listMessages(userId, conversationId, extra) {
        const conversation = await loadConversation(userId, conversationId).catch(function () { return null; });
        if (!conversation) return fail('not-found');
        try {
            let query = supabase.from('support_messages')
                .select('id, conversation_id, sender_type, body, created_at, client_message_id')
                .eq('conversation_id', conversation.id)
                .order('id', { ascending: true })
                .limit((extra && extra.limit) || limits.historyLimit);
            if (extra && extra.afterId) query = query.gt('id', extra.afterId);
            const res = await run(query);
            return { ok: true, conversation: conversation, messages: res.data || [] };
        } catch (err) {
            return fail('unavailable');
        }
    }

    async function markCustomerRead(userId, conversationId) {
        const conversation = await loadConversation(userId, conversationId).catch(function () { return null; });
        if (!conversation) return fail('not-found');
        try {
            await run(supabase.from('support_conversations')
                .update({ unread_for_customer: 0, updated_at: now().toISOString() })
                .eq('id', conversation.id).eq('user_id', userId).select().single());
            return { ok: true };
        } catch (err) {
            return fail('unavailable');
        }
    }

    // ONE static acknowledgement per conversation, claimed atomically so two
    // simultaneous first messages cannot post two notices. It is a SYSTEM notice:
    // it never claims to be a person and it never answers the question.
    async function acknowledgeConversation(conversation) {
        if (!conversation || !conversation.id) return null;
        const language = normalizeLanguage(conversation.language);
        let claimed = null;
        try {
            const claim = await supabase.from('support_conversations')
                .update({ acknowledged_at: now().toISOString() })
                .eq('id', conversation.id).is('acknowledged_at', null).select();
            if (claim && claim.error) throw new Error(claim.error.message || 'claim-failed');
            claimed = (claim && claim.data && claim.data[0]) || null;
        } catch (err) {
            // A missing column (migration 060 not applied yet) must not silence the
            // customer: fall back to a best-effort notice, logged once.
            if (!/acknowledged_at|column/i.test(String((err && err.message) || ''))) {
                logOnce('ack-failed', err && err.message);
                return null;
            }
            logOnce('ack-column-missing', 'support_conversations.acknowledged_at missing');
            claimed = conversation;
        }
        if (!claimed) return null;
        try {
            const notice = await insertMessage(conversation.id, SENDER.SYSTEM,
                copyFor(language, 'received'), { via: 'system' });
            await touchConversation(conversation.id, {
                last_message_at: now().toISOString(),
                last_message_preview: previewOf(notice.message && notice.message.body),
            }, { unreadForCustomer: 1 });
            return notice.message || null;
        } catch (err) {
            logOnce('ack-post-failed', err && err.message);
            return null;
        }
    }

    async function sendCustomerMessage(input) {
        const userId = input && input.userId;
        if (!userId) return fail('unauthenticated');
        const cleaned = cleanBody(input.body, limits.messageMaxChars);
        if (!cleaned.ok) return fail(cleaned.reason, { max: cleaned.max });
        if (!allowSend('msg:' + userId)) return fail('rate-limited');

        let conversation;
        try {
            if (input.conversationId) {
                conversation = await loadConversation(userId, input.conversationId);
                if (!conversation) return fail('not-found');
            } else {
                const made = await getOrCreateConversation(userId, {
                    category: input.category,
                    language: input.language,
                });
                if (!made.ok) return made;
                conversation = made.conversation;
            }
        } catch (err) {
            return fail('unavailable');
        }

        try {
            // 1. Persist the customer message under the conversation row lock.
            //    Locked + idempotent, so a concurrent replay cannot create a
            //    second row and the unread counter is never lost to a race.
            const posted = await postCustomerMessage(conversation, cleaned.body, input.clientMessageId);
            if (posted.duplicate) {
                return { ok: true, duplicate: true, conversationId: conversation.id, message: posted.message, reply: null };
            }

            const afterPost = posted.conversation || conversation;

            if (notifyAdmins) {
                try {
                    await notifyAdmins(afterPost, posted.message);
                } catch (err) {
                    logOnce('admin-notify-failed', err && err.message);
                }
            }

            // A human already owns the thread: no automated answer at all.
            if (afterPost.ai_paused) {
                return {
                    ok: true,
                    conversationId: afterPost.id,
                    status: afterPost.status,
                    aiPaused: true,
                    message: posted.message,
                    reply: null,
                };
            }

            // 2. HUMAN-ONLY. No answer is generated anywhere in this path. The
            //    customer gets ONE static acknowledgement per conversation; the
            //    question itself waits for an agent (dashboard or Telegram). The
            //    notice is best effort - the message above is already stored, so a
            //    notice failure can never lose it.
            const acknowledgement = await acknowledgeConversation(afterPost);
            if (acknowledgement && notify) {
                try {
                    await notify(afterPost.user_id, afterPost, acknowledgement);
                } catch (err) {
                    logOnce('customer-notify-failed', err && err.message);
                }
            }

            return {
                ok: true,
                conversationId: afterPost.id,
                status: afterPost.status,
                aiPaused: afterPost.ai_paused === true,
                message: posted.message,
                reply: acknowledgement,
                humanOnly: true,
            };
        } catch (err) {
            logOnce('send-failed', err && err.message);
            return fail('unavailable');
        }
    }

    async function requestHuman(userId, conversationId) {
        let conversation;
        try {
            conversation = conversationId
                ? await loadConversation(userId, conversationId)
                : await loadActiveConversation(userId);
        } catch (err) {
            return fail('unavailable');
        }
        if (!conversation) return fail('not-found');
        if (conversation.ai_paused) {
            return { ok: true, conversationId: conversation.id, status: conversation.status, aiPaused: true, already: true };
        }
        try {
            const notice = await insertMessage(conversation.id, SENDER.SYSTEM,
                copyFor(conversation.language, 'humanRequested'), { via: 'system' });
            const updated = await touchConversation(conversation.id, {
                ai_paused: true,
                status: STATUS.WAITING,
                last_message_at: now().toISOString(),
                last_message_preview: previewOf(notice.message && notice.message.body),
            }, { unreadForCustomer: 1 });
            await recordAction(conversation.id, userId, 'escalate', { by: 'customer' });
            if (notifyAdmins) {
                try {
                    await notifyAdmins(updated, notice.message);
                } catch (err) {
                    logOnce('admin-notify-failed', err && err.message);
                }
            }
            return { ok: true, conversationId: updated.id, status: updated.status, aiPaused: true, message: notice.message };
        } catch (err) {
            return fail('unavailable');
        }
    }

    // ----------------------------------------------------------------- admin side

    async function listForAdmin(filters) {
        const f = filters || {};
        try {
            let query = supabase.from('support_conversations').select('*')
                .order('last_message_at', { ascending: false, nullsFirst: false })
                .limit(f.limit || limits.inboxLimit);
            const status = normalizeStatus(f.status);
            if (status) query = query.eq('status', status);
            if (f.assignedTo) query = query.eq('assigned_admin_id', f.assignedTo);
            if (f.userId) query = query.eq('user_id', f.userId);
            const res = await run(query);
            let rows = res.data || [];
            const term = String(f.search || '').trim().toLowerCase();
            // Enrich with the customer's display identity in ONE extra query so the
            // inbox can show a name/email without an N+1 fan-out. Only the fields
            // an agent needs to identify the account are selected.
            const ids = Array.from(new Set(rows.map(function (r) { return r.user_id; }).filter(Boolean)));
            const people = {};
            if (ids.length) {
                try {
                    const users = await run(supabase.from('users').select('id, name, email, environment')
                        .in('id', ids.slice(0, 200)));
                    (users.data || []).forEach(function (u) {
                        people[u.id] = { id: u.id, name: u.name || null, email: u.email || null, environment: u.environment || 'PRODUCTION' };
                    });
                } catch (err) {
                    logOnce('customer-enrich-failed', err && err.message);
                }
            }
            rows = rows.map(function (row) {
                return Object.assign({}, row, { customer: people[row.user_id] || { id: row.user_id, name: null, email: null } });
            });
            if (term) {
                rows = rows.filter(function (row) {
                    const who = row.customer || {};
                    return String(row.id) === term
                        || String(row.user_id) === term
                        || String(who.name || '').toLowerCase().indexOf(term) !== -1
                        || String(who.email || '').toLowerCase().indexOf(term) !== -1
                        || String(row.last_message_preview || '').toLowerCase().indexOf(term) !== -1
                        || String(row.category || '').toLowerCase().indexOf(term) !== -1;
                });
            }
            return { ok: true, conversations: rows };
        } catch (err) {
            return fail('unavailable');
        }
    }

    async function countsForAdmin() {
        try {
            const res = await run(supabase.from('support_conversations')
                .select('status, unread_for_admin, assigned_admin_id'));
            const rows = (res && res.data) || [];
            const counts = { total: rows.length, open: 0, assigned: 0, waiting: 0, resolved: 0, unassigned: 0, unread: 0 };
            rows.forEach(function (row) {
                if (counts[row.status] !== undefined) counts[row.status] += 1;
                if (!row.assigned_admin_id && row.status !== STATUS.RESOLVED) counts.unassigned += 1;
                if (Number(row.unread_for_admin) > 0) counts.unread += 1;
            });
            return { ok: true, counts: counts };
        } catch (err) {
            return fail('unavailable');
        }
    }

    async function getConversationForAdmin(conversationId) {
        try {
            const conversation = await readConversation(conversationId);
            if (!conversation) return fail('not-found');
            const msgs = await run(supabase.from('support_messages')
                .select('id, conversation_id, sender_type, sender_user_id, body, created_at')
                .eq('conversation_id', conversation.id).order('id', { ascending: true }).limit(limits.historyLimit));
            let actions = { data: [] };
            try {
                actions = await run(supabase.from('support_actions')
                    .select('id, actor_user_id, action, detail, created_at')
                    .eq('conversation_id', conversation.id).order('id', { ascending: true }).limit(50));
            } catch (err) {
                actions = { data: [] };
            }
            await run(supabase.from('support_conversations')
                .update({ unread_for_admin: 0 }).eq('id', conversation.id).select().single());
            return { ok: true, conversation: conversation, messages: msgs.data || [], actions: actions.data || [] };
        } catch (err) {
            return fail('unavailable');
        }
    }

    // The single agent-reply path. `via` records WHERE the agent wrote from, so the
    // customer, the admin inbox and the audit trail can all tell a dashboard reply
    // from a Telegram one.
    async function deliverAgentReply(input) {
        const adminId = (input && input.adminId) || null;
        const via = (input && input.via) === 'telegram' ? 'telegram' : 'admin';
        if (!input || !input.conversationId) return fail('not-found');
        if (via === 'admin' && !adminId) return fail('unauthenticated');
        const cleaned = cleanBody(input.body, limits.messageMaxChars);
        if (!cleaned.ok) return fail(cleaned.reason, { max: cleaned.max });
        let conversation;
        try {
            conversation = await readConversation(input.conversationId);
        } catch (err) {
            return fail('unavailable');
        }
        if (!conversation) return fail('not-found');
        try {
            const inserted = await insertMessage(conversation.id, SENDER.AGENT, cleaned.body, {
                senderUserId: adminId,
                clientMessageId: input.clientMessageId,
                via: via,
            });
            if (inserted.duplicate) {
                return { ok: true, duplicate: true, conversationId: conversation.id, message: inserted.message };
            }
            const updated = await touchConversation(conversation.id, {
                ai_paused: true,
                status: STATUS.ASSIGNED,
                assigned_admin_id: conversation.assigned_admin_id || adminId || null,
                last_message_at: now().toISOString(),
                last_message_preview: previewOf(cleaned.body),
            }, { unreadForCustomer: 1 });
            await recordAction(conversation.id, adminId, 'message',
                Object.assign({ sender: 'agent', via: via }, (input.detail || {})));
            if (notify) {
                try {
                    await notify(conversation.user_id, updated, inserted.message);
                } catch (err) {
                    logOnce('customer-notify-failed', err && err.message);
                }
            }
            return {
                ok: true,
                conversationId: updated.id,
                status: updated.status,
                aiPaused: updated.ai_paused === true,
                message: inserted.message,
                via: via,
            };
        } catch (err) {
            return fail('unavailable');
        }
    }

    // Dashboard reply. Agent identity is REQUIRED: the route is admin-gated.
    function sendAgentMessage(input) {
        const adminId = input && input.adminId;
        if (!adminId) return Promise.resolve(fail('unauthenticated'));
        return deliverAgentReply(Object.assign({}, input, { adminId: adminId, via: 'admin' }));
    }

    // Telegram reply. Authorisation happened in the Telegram bridge (the admin id
    // allow-list), so no platform admin user is required: this platform keeps no
    // Telegram-id -> users mapping, and inventing one would attribute an agent's
    // words to whoever happened to be first in the admin list.
    function sendChannelReply(input) {
        return deliverAgentReply(Object.assign({}, input, {
            adminId: (input && input.adminId) || null,
            via: 'telegram',
        }));
    }

    async function setControl(conversationId, adminId, action, patch, noticeKey, detail) {
        try {
            const conversation = await readConversation(conversationId);
            if (!conversation) return fail('not-found');
            let message = null;
            if (noticeKey) {
                const notice = await insertMessage(conversation.id, SENDER.SYSTEM,
                    copyFor(conversation.language, noticeKey), { senderUserId: adminId, via: 'system' });
                message = notice.message;
            }
            const nextPatch = Object.assign({ last_message_at: now().toISOString() }, patch);
            if (message) nextPatch.last_message_preview = previewOf(message.body);
            const updated = await touchConversation(conversation.id, nextPatch,
                noticeKey ? { unreadForCustomer: 1 } : null);
            await recordAction(conversation.id, adminId, action, detail || {});
            if (message && notify) {
                try {
                    await notify(conversation.user_id, updated, message);
                } catch (err) {
                    logOnce('customer-notify-failed', err && err.message);
                }
            }
            return {
                ok: true,
                conversationId: updated.id,
                status: updated.status,
                aiPaused: updated.ai_paused === true,
                message: message,
            };
        } catch (err) {
            return fail('unavailable');
        }
    }

    function takeover(conversationId, adminId) {
        return setControl(conversationId, adminId, 'takeover', {
            ai_paused: true,
            status: STATUS.ASSIGNED,
            assigned_admin_id: adminId,
        }, 'agentJoined', { ai_paused: true });
    }

    function resume(conversationId, adminId) {
        return setControl(conversationId, adminId, 'resume', {
            ai_paused: false,
            status: STATUS.ASSIGNED,
        }, 'released', { ai_paused: false });
    }

    function assign(conversationId, adminId, assigneeId) {
        return setControl(conversationId, adminId, 'assign', {
            assigned_admin_id: assigneeId || adminId,
            status: STATUS.ASSIGNED,
        }, null, { assignee: assigneeId || adminId });
    }

    function resolve(conversationId, adminId) {
        return setControl(conversationId, adminId, 'resolve', {
            status: STATUS.RESOLVED,
            ai_paused: true,
            resolved_at: now().toISOString(),
        }, 'resolved', {});
    }

    /** Administrator-initiated thread: the inbox is not reply-only. */
    async function initiate(input) {
        const adminId = input && input.adminId;
        const userId = input && input.userId;
        if (!adminId) return fail('unauthenticated');
        if (!userId) return fail('missing-user');
        const cleaned = cleanBody(input.body, limits.messageMaxChars);
        if (!cleaned.ok) return fail(cleaned.reason, { max: limits.messageMaxChars });
        let conversation;
        try {
            const made = await getOrCreateConversation(userId, {
                category: input.category,
                language: input.language,
            });
            if (!made.ok) return made;
            conversation = made.conversation;
        } catch (err) {
            return fail('unavailable');
        }
        try {
            const inserted = await insertMessage(conversation.id, SENDER.AGENT, cleaned.body, {
                senderUserId: adminId,
                clientMessageId: input.clientMessageId,
            });
            const updated = await touchConversation(conversation.id, {
                ai_paused: true,
                status: STATUS.ASSIGNED,
                assigned_admin_id: conversation.assigned_admin_id || adminId,
                last_message_at: now().toISOString(),
                last_message_preview: previewOf(cleaned.body),
            }, { unreadForCustomer: 1 });
            await recordAction(conversation.id, adminId, 'initiate', { user_id: userId });
            if (notify) {
                try {
                    await notify(userId, updated, inserted.message);
                } catch (err) {
                    logOnce('customer-notify-failed', err && err.message);
                }
            }
            return {
                ok: true,
                conversationId: updated.id,
                status: updated.status,
                aiPaused: true,
                message: inserted.message,
            };
        } catch (err) {
            return fail('unavailable');
        }
    }

    return {
        getOrCreateConversation: getOrCreateConversation,
        listConversations: listConversations,
        listMessages: listMessages,
        markCustomerRead: markCustomerRead,
        sendCustomerMessage: sendCustomerMessage,
        requestHuman: requestHuman,
        listForAdmin: listForAdmin,
        countsForAdmin: countsForAdmin,
        getConversationForAdmin: getConversationForAdmin,
        sendAgentMessage: sendAgentMessage,
        takeover: takeover,
        resume: resume,
        assign: assign,
        resolve: resolve,
        initiate: initiate,
        sendChannelReply: sendChannelReply,
        limits: limits,
    };
}

module.exports = {
    ENV_FLAG,
    CATEGORIES,
    LANGUAGES,
    STATUS,
    STATUSES,
    SENDER,
    LIMITS,
    SERVICE_COPY,
    isNativeSupportEnabled,
    normalizeLanguage,
    normalizeCategory,
    normalizeStatus,
    cleanBody,
    previewOf,
    copyFor,
    createRateLimiter,
    createNativeSupportService,
};
