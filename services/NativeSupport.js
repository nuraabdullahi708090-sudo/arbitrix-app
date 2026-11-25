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
const FALLBACK_COPY = {
    en: {
        aiUnavailable: 'Thanks for your message. A support agent will reply here shortly.',
        humanRequested: 'A support agent has been notified and will reply here.',
        agentJoined: 'A support agent has joined this conversation.',
        aiResumed: 'The automated assistant has resumed. A support agent can step in at any time.',
        resolved: 'This conversation was marked as resolved.',
    },
    es: {
        aiUnavailable: 'Gracias por tu mensaje. Un agente de soporte te responder\u00e1 aqu\u00ed en breve.',
        humanRequested: 'Se ha notificado a un agente de soporte y responder\u00e1 aqu\u00ed.',
        agentJoined: 'Un agente de soporte se ha unido a esta conversaci\u00f3n.',
        aiResumed: 'El asistente autom\u00e1tico se ha reanudado. Un agente puede intervenir en cualquier momento.',
        resolved: 'Esta conversaci\u00f3n se marc\u00f3 como resuelta.',
    },
    pt: {
        aiUnavailable: 'Obrigado pela sua mensagem. Um agente de suporte responder\u00e1 aqui em breve.',
        humanRequested: 'Um agente de suporte foi notificado e responder\u00e1 aqui.',
        agentJoined: 'Um agente de suporte entrou nesta conversa.',
        aiResumed: 'O assistente autom\u00e1tico foi retomado. Um agente pode intervir a qualquer momento.',
        resolved: 'Esta conversa foi marcada como resolvida.',
    },
    fr: {
        aiUnavailable: 'Merci pour votre message. Un agent du support vous r\u00e9pondra ici sous peu.',
        humanRequested: 'Un agent du support a \u00e9t\u00e9 pr\u00e9venu et vous r\u00e9pondra ici.',
        agentJoined: 'Un agent du support a rejoint cette conversation.',
        aiResumed: "L'assistant automatique a repris. Un agent peut intervenir \u00e0 tout moment.",
        resolved: 'Cette conversation a \u00e9t\u00e9 marqu\u00e9e comme r\u00e9solue.',
    },
    ar: {
        aiUnavailable: '\u0634\u0643\u0631\u0627\u064b \u0644\u0631\u0633\u0627\u0644\u062a\u0643. \u0633\u064a\u0631\u062f \u0639\u0644\u064a\u0643 \u0623\u062d\u062f \u0645\u0648\u0638\u0641\u064a \u0627\u0644\u062f\u0639\u0645 \u0647\u0646\u0627 \u0642\u0631\u064a\u0628\u0627\u064b.',
        humanRequested: '\u062a\u0645 \u0625\u0634\u0639\u0627\u0631 \u0623\u062d\u062f \u0645\u0648\u0638\u0641\u064a \u0627\u0644\u062f\u0639\u0645 \u0648\u0633\u064a\u0631\u062f \u0639\u0644\u064a\u0643 \u0647\u0646\u0627.',
        agentJoined: '\u0627\u0646\u0636\u0645 \u0623\u062d\u062f \u0645\u0648\u0638\u0641\u064a \u0627\u0644\u062f\u0639\u0645 \u0625\u0644\u0649 \u0647\u0630\u0647 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629.',
        aiResumed: '\u0627\u0633\u062a\u0623\u0646\u0641 \u0627\u0644\u0645\u0633\u0627\u0639\u062f \u0627\u0644\u0622\u0644\u064a \u0639\u0645\u0644\u0647. \u064a\u0645\u0643\u0646 \u0644\u0645\u0648\u0638\u0641 \u0627\u0644\u062f\u0639\u0645 \u0627\u0644\u062a\u062f\u062e\u0644 \u0641\u064a \u0623\u064a \u0648\u0642\u062a.',
        resolved: '\u062a\u0645 \u0648\u0636\u0639 \u0647\u0630\u0647 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629 \u0643\u0645\u0646\u062a\u0647\u064a\u0629.',
    },
    zh: {
        aiUnavailable: '\u611f\u8c22\u60a8\u7684\u7559\u8a00\u3002\u5ba2\u670d\u4eba\u5458\u5c06\u5f88\u5feb\u5728\u8fd9\u91cc\u56de\u590d\u60a8\u3002',
        humanRequested: '\u5df2\u901a\u77e5\u5ba2\u670d\u4eba\u5458\uff0c\u4ed6\u4eec\u5c06\u5728\u8fd9\u91cc\u56de\u590d\u60a8\u3002',
        agentJoined: '\u5ba2\u670d\u4eba\u5458\u5df2\u52a0\u5165\u672c\u6b21\u5bf9\u8bdd\u3002',
        aiResumed: '\u81ea\u52a8\u52a9\u624b\u5df2\u6062\u590d\u3002\u5ba2\u670d\u4eba\u5458\u53ef\u968f\u65f6\u4ecb\u5165\u3002',
        resolved: '\u6b64\u5bf9\u8bdd\u5df2\u6807\u8bb0\u4e3a\u5df2\u89e3\u51b3\u3002',
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
    return (FALLBACK_COPY[lang] && FALLBACK_COPY[lang][key]) || FALLBACK_COPY.en[key];
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
    const ai = opts.ai || null;
    const engine = opts.engine || null;
    const i18n = opts.i18n || null;
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

    function lineText(language, line) {
        if (!line) return '';
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(normalizeLanguage(language), line.key, line.vars || {});
            if (value && value !== line.key) return value;
        }
        return '';
    }

    /**
     * The AI turn. Reuses the Telegram brain:
     *   1. ConversationEngine.planTurn() decides whether this is procedural
     *      dialogue (greeting, how-to, tutorial selection, handoff request).
     *   2. Anything factual goes to SupportAIService, which is grounded in the
     *      approved knowledge base and refuses to invent amounts or statuses.
     *   3. Any failure degrades to an honest "a human will reply" message -
     *      never to an invented status.
     */
    async function composeAiReply(conversation, text) {
        const language = normalizeLanguage(conversation.language);
        let plan = null;
        if (engine && typeof engine.planTurn === 'function') {
            try {
                plan = engine.planTurn({ text: text, state: conversation.context || {} });
            } catch (err) {
                logOnce('engine-failed', err && err.message);
            }
        }
        if (plan && plan.handled) {
            const body = (plan.lines || []).map(function (line) { return lineText(language, line); })
                .filter(Boolean).join('\n\n').trim();
            if (body) {
                return {
                    text: body,
                    needsHuman: plan.humanRequested === true,
                    confident: plan.confident !== false,
                    context: plan.nextState || conversation.context || {},
                };
            }
        }
        if (ai && typeof ai.ask === 'function') {
            try {
                const question = (plan && plan.knowledge) ? plan.knowledge : text;
                const outcome = await ai.ask(question, { language: language });
                if (outcome && outcome.answer && (outcome.modelGenerated === true || language === 'en')) {
                    return {
                        text: outcome.answer,
                        needsHuman: outcome.needsHuman === true,
                        confident: outcome.needsHuman !== true,
                        context: (plan && plan.nextState) || conversation.context || {},
                    };
                }
            } catch (err) {
                logOnce('ai-failed', err && err.message);
            }
        }
        return {
            text: copyFor(language, 'aiUnavailable'),
            needsHuman: true,
            confident: false,
            context: conversation.context || {},
        };
    }

    // ---------------------------------------------------------- locked writes
    // Migration 059 exposes two SECURITY DEFINER functions that take the
    // conversation row lock (SELECT ... FOR UPDATE) before validating and
    // writing. They are what makes "an admin takes over while the AI is
    // generating" safe: the loser of the race writes nothing.
    //
    // When the migration has not been applied yet the RPCs do not exist, so the
    // service degrades to the previous path (and warns once) - a missing
    // function must never make customer messages fail. The fallback still
    // claims the turn with a CONDITIONAL update, so it cannot undo a takeover
    // either; only the atomicity of the two writes is lost.
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
        const inserted = await insertMessage(conversation.id, SENDER.CUSTOMER, body, { clientMessageId: clientMessageId });
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

    // -------------------------------------------------- serialised AI turns
    // Row locking serialises the writes; it does NOT serialise generation. Two
    // customer messages posted a few hundred milliseconds apart can both compose
    // from the same conversation context, and without a guard the second commit
    // would overwrite the dialogue progress of the first. Two layers prevent it:
    //
    //   1. withConversationLock() serialises compose+commit per conversation
    //      inside this process (the deployment is one web instance), and the turn
    //      re-reads the row AFTER taking the lock, so it always composes from the
    //      latest committed state;
    //   2. every turn carries the context_version it composed from and the locked
    //      RPC refuses a commit whose version has moved on (stale-context). The
    //      turn then re-reads and REGENERATES from the committed state, so a turn
    //      started in another process can never overwrite newer progress.
    const conversationLocks = new Map();

    function withConversationLock(conversationId, fn) {
        const key = String(conversationId);
        const previous = conversationLocks.get(key) || Promise.resolve();
        const next = previous.then(function () { return fn(); }, function () { return fn(); });
        const tail = next.then(function () {}, function () {});
        conversationLocks.set(key, tail);
        tail.then(function () {
            if (conversationLocks.get(key) === tail) conversationLocks.delete(key);
        });
        return next;
    }

    async function runAiTurn(afterPost, text) {
        let row = afterPost;
        try {
            row = (await readConversation(afterPost.id)) || afterPost;
        } catch (err) {
            return { committed: false, reason: 'unavailable', conversation: afterPost };
        }
        if (row.ai_paused) return { committed: false, reason: 'ai-paused', conversation: row };
        if (row.status === STATUS.RESOLVED) return { committed: false, reason: 'resolved', conversation: row };

        let expected = Number(row.context_version) || 0;
        let composed = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            composed = await composeAiReply(row, text);
            if (!composed.text) return { committed: true, message: null, conversation: row, composed: composed };
            const result = await commitAiTurn(row.id, composed, expected);
            if (result.committed === true) return Object.assign({}, result, { composed: composed });
            if (result.reason !== 'stale-context') return Object.assign({}, result, { composed: composed });
            try {
                row = (await readConversation(afterPost.id)) || row;
            } catch (err) {
                return { committed: false, reason: 'unavailable', conversation: row, composed: composed };
            }
            if (row.ai_paused) return { committed: false, reason: 'ai-paused', conversation: row, composed: composed };
            if (row.status === STATUS.RESOLVED) return { committed: false, reason: 'resolved', conversation: row, composed: composed };
            expected = Number(row.context_version) || 0;
        }
        logOnce('stale-context', 'AI turn abandoned after two stale compositions (conversation ' + afterPost.id + ')');
        return { committed: false, reason: 'stale-context', conversation: row, composed: composed };
    }

    async function commitAiTurn(conversationId, composed, expectedVersion) {
        const senderType = composed.needsHuman ? SENDER.SYSTEM : SENDER.AI;
        const preview = previewOf(composed.text);
        const version = Number(expectedVersion);
        if (!rpcWrites) return aiUnavailableFallback(conversationId, composed);
        try {
            const out = await callRpc('support_commit_ai_turn', {
                p_conversation_id: conversationId,
                p_sender_type: senderType,
                p_body: composed.text,
                p_context: composed.context || {},
                p_needs_human: composed.needsHuman === true,
                p_preview: preview,
                p_expected_version: Number.isFinite(version) ? version : null,
            });
            if (!out || typeof out.committed !== 'boolean') {
                throw Object.assign(new Error('commit-contract'), { code: 'rpc-contract' });
            }
            return out;
        } catch (err) {
            if (!rpcMissing(err)) throw err;
            rpcWrites = false;
            logOnce('rpc-missing:commit', err && err.message);
            return aiUnavailableFallback(conversationId, composed);
        }
    }

    // The locked RPC is the ONLY way an AI answer may be committed. Without it
    // the answer is not written at all: a claim followed by separate inserts can
    // be interleaved by a takeover, which is exactly the defect this replaced.
    // The thread is parked for a human with ONE conditional statement (it can only
    // SET the paused state, so it cannot undo a takeover) and the customer gets
    // the localized hand-off notice instead of an AI answer.
    async function aiUnavailableFallback(conversationId, composed) {
        try {
            const claim = await supabase.from('support_conversations')
                .update({ ai_paused: true, status: STATUS.WAITING, updated_at: now().toISOString() })
                .eq('id', conversationId).eq('ai_paused', false).neq('status', STATUS.RESOLVED).select();
            if (claim && claim.error) throw new Error(claim.error.message || 'claim-failed');
            const claimed = (claim && claim.data && claim.data[0]) || null;
            const row = claimed || (await readConversation(conversationId));
            const notice = await insertMessage(conversationId, SENDER.SYSTEM,
                copyFor((row && row.language) || 'en', 'aiUnavailable'), {});
            return {
                committed: false,
                reason: 'ai-unavailable',
                supportUnavailable: true,
                notice: notice.message,
                conversation: row,
                composed: composed,
            };
        } catch (err) {
            logOnce('ai-fallback-failed', err && err.message);
            return { committed: false, reason: 'ai-unavailable', supportUnavailable: true, notice: null };
        }
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

            // 2. ONE AI turn at a time per conversation, composed from the LATEST
            //    committed context. Row locking alone serialises the WRITES, not
            //    the generation: two messages posted moments apart would both
            //    compose from the same state and the later commit would overwrite
            //    the earlier turn's progress. The lock serialises generation in
            //    this process; the context version below protects against another
            //    process (or a turn that started earlier) committing first.
            const turn = await withConversationLock(afterPost.id, function () {
                return runAiTurn(afterPost, cleaned.body);
            });

            if (turn.committed !== true) {
                return {
                    ok: true,
                    conversationId: afterPost.id,
                    status: (turn.conversation && turn.conversation.status) || afterPost.status,
                    aiPaused: true,
                    message: posted.message,
                    reply: turn.notice || null,
                    supportUnavailable: turn.supportUnavailable === true,
                    discarded: turn.reason || 'ai-turn-discarded',
                };
            }

            const finalRow = turn.conversation || afterPost;
            const replyMessage = turn.message || null;
            const composed = turn.composed || { needsHuman: false };

            if (replyMessage && notify) {
                try {
                    await notify(afterPost.user_id, finalRow, replyMessage);
                } catch (err) {
                    logOnce('customer-notify-failed', err && err.message);
                }
            }
            if (composed.needsHuman && notifyAdmins) {
                try {
                    await notifyAdmins(finalRow, replyMessage || posted.message);
                } catch (err) {
                    logOnce('admin-notify-failed', err && err.message);
                }
            }

            return {
                ok: true,
                conversationId: finalRow.id,
                status: finalRow.status,
                aiPaused: finalRow.ai_paused === true,
                message: posted.message,
                reply: replyMessage,
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
                copyFor(conversation.language, 'humanRequested'), {});
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

    async function sendAgentMessage(input) {
        const adminId = input && input.adminId;
        if (!adminId) return fail('unauthenticated');
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
            });
            if (inserted.duplicate) {
                return { ok: true, duplicate: true, conversationId: conversation.id, message: inserted.message };
            }
            const updated = await touchConversation(conversation.id, {
                ai_paused: true,
                status: STATUS.ASSIGNED,
                assigned_admin_id: conversation.assigned_admin_id || adminId,
                last_message_at: now().toISOString(),
                last_message_preview: previewOf(cleaned.body),
            }, { unreadForCustomer: 1 });
            await recordAction(conversation.id, adminId, 'message', { sender: 'agent' });
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
            };
        } catch (err) {
            return fail('unavailable');
        }
    }

    async function setControl(conversationId, adminId, action, patch, noticeKey, detail) {
        try {
            const conversation = await readConversation(conversationId);
            if (!conversation) return fail('not-found');
            let message = null;
            if (noticeKey) {
                const notice = await insertMessage(conversation.id, SENDER.SYSTEM,
                    copyFor(conversation.language, noticeKey), { senderUserId: adminId });
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
        }, 'aiResumed', { ai_paused: false });
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
        composeAiReply: composeAiReply,
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
    FALLBACK_COPY,
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
