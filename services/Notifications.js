'use strict';
/**
 * services/Notifications.js - the in-app notification feed.
 *
 * DESIGN
 *   The feed is a server-side record of BUSINESS EVENTS. Every notification is
 *   identified by a stable `event_key`
 *   (`welcome`, `first_trade`, `deposit_confirmed:invoice:123`, ...) and the
 *   database enforces UNIQUE(user_id, event_key). All writers go through
 *   notification_emit() (migration 058), which is INSERT ... ON CONFLICT DO
 *   NOTHING, so:
 *     * a retried request, a duplicate webhook or two concurrent requests can
 *       never create a second notification for the same event;
 *     * a page load can never re-create an event that already happened;
 *     * Clear sets cleared_at (it never deletes), so a cleared event cannot be
 *       resurrected by the same key.
 *   Titles/bodies are stored as i18n KEYS + interpolation values, so the feed
 *   renders in the reader's current language.
 *
 * This module never touches money: it only inserts/reads notification rows.
 */

const TABLE = 'notifications';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * The catalogue is the single source of truth for what each event looks like.
 * `type` drives the icon/colour; `title`/`body` are i18n keys resolved by the
 * client (all six locales carry them).
 */
const EVENTS = {
    welcome: {
        type: 'success',
        title: 'notifications.welcome',
        body: 'notifications.welcomeDesc',
    },
    readyToTrade: {
        type: 'info',
        title: 'notifications.events.readyToTrade.title',
        body: 'notifications.events.readyToTrade.body',
    },
    promoFirstTrade: {
        type: 'info',
        title: 'notifications.events.promoDeposit.title',
        body: 'notifications.events.promoDeposit.body',
    },
    promoDepositReminder: {
        type: 'info',
        title: 'notifications.events.promoDeposit.title',
        body: 'notifications.events.promoDeposit.body',
    },
    depositPending: {
        type: 'info',
        title: 'notifications.events.depositPending.title',
        body: 'notifications.events.depositPending.body',
    },
    depositConfirmed: {
        type: 'success',
        title: 'notifications.events.depositConfirmed.title',
        body: 'notifications.events.depositConfirmed.body',
    },
    firstTrade: {
        type: 'success',
        title: 'notifications.events.firstTrade.title',
        body: 'notifications.events.firstTrade.body',
    },
    referral: {
        type: 'success',
        title: 'notifications.events.referral.title',
        body: 'notifications.events.referral.body',
    },
    // Native in-app support (services/NativeSupport.js). `supportReply` goes to
    // the CUSTOMER when an agent answers; `supportMessage` alerts the admins.
    supportReply: {
        type: 'info',
        title: 'notifications.events.supportReply.title',
        body: 'notifications.events.supportReply.body',
    },
    supportMessage: {
        type: 'info',
        title: 'notifications.events.supportMessage.title',
        body: 'notifications.events.supportMessage.body',
    },
};

/** Hour-glass of the day used by the reminder cooldown key (UTC). */
function dailyBucket(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    if (Number.isNaN(d.getTime())) return '1970-01-01';
    return d.toISOString().slice(0, 10);
}

/** Only primitives survive into `vars`: no objects, no PII beyond an amount. */
function sanitizeVars(vars) {
    const out = {};
    if (!vars || typeof vars !== 'object') return out;
    Object.keys(vars).slice(0, 8).forEach(function (k) {
        const v = vars[k];
        if (v == null) return;
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (typeof v === 'string') out[k] = v.slice(0, 64);
        else if (typeof v === 'boolean') out[k] = v;
    });
    return out;
}

/**
 * Journey reminder decisions - PURE.
 *
 * @param {object} state
 *   hasConfirmedDeposit  boolean  a confirmed qualifying deposit exists
 *   hasTradingActivity   boolean  at least one completed trade exists
 *   promoCreditFunded    boolean  the account trades promotional credit
 *   hasPendingDeposit    boolean  a deposit is awaiting confirmation
 *   accountAgeHours      number   hours since registration
 *   now                  Date
 * @returns {Array<{eventKey, event, vars}>} events to record (idempotent)
 *
 * Rules (deliberately conservative):
 *   * nothing is emitted while a deposit is pending - the customer was already
 *     told "Deposit processing" and must not be nagged while it clears;
 *   * nothing is emitted once a qualifying deposit is confirmed;
 *   * the promotional-credit nudge fires ONCE (`promo_first_trade`) and then at
 *     most once per UTC day (`promo_deposit_reminder:<day>`);
 *   * the "start trading" nudge is one-time and only after 24h, so a brand new
 *     account is not greeted by two notifications at once.
 */
function journeyReminders(state) {
    const s = state && typeof state === 'object' ? state : {};
    const out = [];
    if (s.hasConfirmedDeposit === true) return out;
    if (s.hasPendingDeposit === true) return out;

    const now = s.now instanceof Date ? s.now : new Date(s.now || Date.now());
    const traded = s.hasTradingActivity === true;

    if (s.promoCreditFunded === true && traded) {
        out.push({ eventKey: 'promo_first_trade', event: 'promoFirstTrade', vars: {} });
        out.push({
            eventKey: 'promo_deposit_reminder:' + dailyBucket(now),
            event: 'promoDepositReminder',
            vars: {},
        });
        return out;
    }

    const ageHours = Number(s.accountAgeHours);
    if (!traded && Number.isFinite(ageHours) && ageHours >= 24) {
        out.push({ eventKey: 'ready_to_trade', event: 'readyToTrade', vars: {} });
    }

    return out;
}

function createNotificationsService(options) {
    const opts = options || {};
    const supabase = opts.supabase;
    const now = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };

    function unavailable(reason) {
        return { ok: false, reason: reason || 'unavailable' };
    }

    /**
     * Record one business event. Idempotent: returns created:false when the key
     * was already used. NEVER throws - callers are usually money paths.
     */
    async function emit(userId, eventKey, eventName, vars, occurredAt) {
        const def = EVENTS[eventName];
        if (!def) return unavailable('unknown-event');
        if (!userId || !eventKey) return unavailable('missing-input');
        if (!supabase) return unavailable('no-client');

        try {
            const { data, error } = await supabase.rpc('notification_emit', {
                p_user_id: Number(userId),
                p_event_key: String(eventKey).slice(0, 160),
                p_type: def.type,
                p_title_key: def.title,
                p_body_key: def.body,
                p_vars: sanitizeVars(vars),
                p_occurred_at: (occurredAt instanceof Date ? occurredAt : now()).toISOString(),
            });
            if (error) {
                // Migration not applied / transient DB problem: the feed simply
                // misses this entry. It must never fail the caller.
                return { ok: false, created: false, reason: 'db-error', error: error.message || String(error) };
            }
            return { ok: true, created: data === true };
        } catch (e) {
            return { ok: false, created: false, reason: 'exception', error: e && e.message ? e.message : String(e) };
        }
    }

    /** Convenience: the event key is derived from the event name + a suffix. */
    async function emitEvent(userId, eventName, suffix, vars, occurredAt) {
        const key = suffix ? eventName + ':' + suffix : eventName;
        return emit(userId, key, eventName, vars, occurredAt);
    }

    /** Fire-and-forget variant for hot paths (trades, session reads). */
    function emitDetached(userId, eventKey, eventName, vars) {
        emit(userId, eventKey, eventName, vars).catch(function () {});
    }

    async function list(userId, limit) {
        if (!supabase) return { ok: false, reason: 'no-client', notifications: [], unread: 0 };
        const take = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
        try {
            const { data, error } = await supabase
                .from(TABLE)
                .select('id,event_key,type,title_key,body_key,vars,occurred_at,read_at')
                .eq('user_id', Number(userId))
                .is('cleared_at', null)
                .order('occurred_at', { ascending: false })
                .limit(take);
            if (error) return { ok: false, reason: 'db-error', error: error.message, notifications: [], unread: 0 };
            const rows = Array.isArray(data) ? data : [];
            const unread = rows.filter(function (r) { return !r.read_at; }).length;
            return { ok: true, notifications: rows, unread: unread };
        } catch (e) {
            return { ok: false, reason: 'exception', error: e && e.message, notifications: [], unread: 0 };
        }
    }

    async function markAllRead(userId) {
        if (!supabase) return unavailable('no-client');
        try {
            const { error } = await supabase
                .from(TABLE)
                .update({ read_at: now().toISOString() })
                .eq('user_id', Number(userId))
                .is('read_at', null)
                .is('cleared_at', null);
            if (error) return { ok: false, error: error.message };
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e && e.message };
        }
    }

    async function markRead(userId, id) {
        if (!supabase) return unavailable('no-client');
        const numericId = Number(id);
        if (!Number.isFinite(numericId)) return unavailable('bad-id');
        try {
            const { error } = await supabase
                .from(TABLE)
                .update({ read_at: now().toISOString() })
                .eq('user_id', Number(userId))
                .eq('id', numericId)
                .is('read_at', null);
            if (error) return { ok: false, error: error.message };
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e && e.message };
        }
    }

    /**
     * Soft clear: the rows stay (event keys claimed) but leave the feed.
     * Returns { ok, cleared } where cleared is the number of rows affected when
     * the driver reports it.
     */
    async function clearAll(userId) {
        if (!supabase) return unavailable('no-client');
        try {
            const q = supabase
                .from(TABLE)
                .update({ cleared_at: now().toISOString() })
                .eq('user_id', Number(userId))
                .is('cleared_at', null)
                .select('id');
            const { data, error } = await q;
            if (error) return { ok: false, error: error.message };
            return { ok: true, cleared: Array.isArray(data) ? data.length : undefined };
        } catch (e) {
            return { ok: false, error: e && e.message };
        }
    }

    return {
        EVENTS,
        emit,
        emitEvent,
        emitDetached,
        list,
        markAllRead,
        markRead,
        clearAll,
    };
}

module.exports = {
    EVENTS,
    TABLE,
    dailyBucket,
    sanitizeVars,
    journeyReminders,
    createNotificationsService,
};
