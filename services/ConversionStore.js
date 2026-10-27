'use strict';

/**
 * Supabase access for the Phase 2 conversion automation.
 *
 * Every method returns `{ ok, reason, error, data }` and NEVER throws, so the
 * worker can decide what to do with a failure instead of crashing a tick.
 *
 * The store is a thin wrapper on purpose: all the delivery-relevant state lives
 * in Postgres (migration 040), and the two RPCs
 * (`conversion_claim_notifications` / `conversion_complete_notification`) own the
 * concurrency guarantees. Nothing here re-implements them in JavaScript.
 *
 * PRIVACY: this layer reads chat ids only to hand them to the transport. It
 * never logs them, and nothing it returns is ever written into an outbox row.
 */

const EVENTS_TABLE = 'conversion_events';
const NOTIFICATIONS_TABLE = 'conversion_notifications';
const LINKS_TABLE = 'telegram_account_links';
const SUBSCRIPTIONS_TABLE = 'telegram_marketing_subscriptions';
const CONVERSATIONS_TABLE = 'telegram_support_conversations';
const INVOICES_TABLE = 'payment_invoices';
const DEPOSITS_TABLE = 'deposits';
const REFERRALS_TABLE = 'referrals';

function scrub(message, limit) {
  return String(message === null || message === undefined ? '' : message).slice(0, limit || 300);
}

function createConversionStore(options) {
  const opts = options || {};
  const admin = opts.admin;
  if (!admin) throw new Error('createConversionStore requires a Supabase client');

  const fail = (reason, error) => ({
    ok: false,
    reason,
    error: scrub(error && error.message ? error.message : error)
  });

  /** True when the outbox exists and is readable (migration 040 applied). */
  async function probe() {
    try {
      const { error } = await admin
        .from(NOTIFICATIONS_TABLE)
        .select('id', { head: true, count: 'exact' })
        .limit(1);
      if (error) return fail('outbox_unreadable', error);
      return { ok: true };
    } catch (error) {
      return fail('outbox_unreadable', error);
    }
  }

  async function claimNotifications(workerId, limit, leaseSeconds) {
    try {
      const { data, error } = await admin.rpc('conversion_claim_notifications', {
        p_worker_id: workerId,
        p_limit: limit,
        p_lease_seconds: leaseSeconds
      });
      if (error) return fail('claim_failed', error);
      return { ok: true, data: Array.isArray(data) ? data : [] };
    } catch (error) {
      return fail('claim_failed', error);
    }
  }

  async function completeNotification(id, status, reason, retrySeconds) {
    try {
      const { data, error } = await admin.rpc('conversion_complete_notification', {
        p_id: id,
        p_status: status,
        p_reason: reason === undefined ? null : reason,
        p_retry_seconds: retrySeconds === undefined ? null : retrySeconds
      });
      if (error) return fail('complete_failed', error);
      return { ok: true, data: data === true };
    } catch (error) {
      return fail('complete_failed', error);
    }
  }

  async function getEvent(eventId) {
    try {
      const { data, error } = await admin
        .from(EVENTS_TABLE)
        .select('id, event_type, user_id, amount, source, payload, created_at')
        .eq('id', eventId)
        .maybeSingle();
      if (error) return fail('event_unreadable', error);
      return { ok: true, data: data || null };
    } catch (error) {
      return fail('event_unreadable', error);
    }
  }

  /** The linked private chat for an account, or null. Migration 039. */
  async function getLinkedChat(userId) {
    if (userId === null || userId === undefined) return { ok: true, data: null };
    try {
      const { data, error } = await admin
        .from(LINKS_TABLE)
        .select('telegram_chat_id, linked_at')
        .eq('user_id', userId)
        .not('telegram_chat_id', 'is', null)
        .maybeSingle();
      if (error && error.code !== 'PGRST116') return fail('link_unreadable', error);
      const chatId = data && data.telegram_chat_id ? String(data.telegram_chat_id) : null;
      return { ok: true, data: chatId ? { chatId, linkedAt: data.linked_at || null } : null };
    } catch (error) {
      return fail('link_unreadable', error);
    }
  }

  /** Marketing consent for a chat. Migration 038. */
  async function getSubscription(chatId) {
    try {
      const { data, error } = await admin
        .from(SUBSCRIPTIONS_TABLE)
        .select('telegram_chat_id, subscribed, locale')
        .eq('telegram_chat_id', String(chatId))
        .maybeSingle();
      if (error && error.code !== 'PGRST116') return fail('subscription_unreadable', error);
      if (!data) return { ok: true, data: { subscribed: false, locale: null } };
      return { ok: true, data: { subscribed: data.subscribed === true, locale: data.locale || null } };
    } catch (error) {
      return fail('subscription_unreadable', error);
    }
  }

  /** The support-bot conversation language, when one exists (migration 027). */
  async function getConversationLanguage(chatId) {
    try {
      const { data, error } = await admin
        .from(CONVERSATIONS_TABLE)
        .select('language')
        .eq('telegram_chat_id', String(chatId))
        .maybeSingle();
      if (error && error.code !== 'PGRST116') return { ok: false, data: null };
      return { ok: true, data: data && data.language ? data.language : null };
    } catch (error) {
      return { ok: false, data: null };
    }
  }

  async function getInvoice(invoiceId) {
    try {
      const { data, error } = await admin
        .from(INVOICES_TABLE)
        .select('id, user_id, amount_usd, status, credited, expires_at, created_at')
        .eq('id', invoiceId)
        .maybeSingle();
      if (error) return fail('invoice_unreadable', error);
      return { ok: true, data: data || null };
    } catch (error) {
      return fail('invoice_unreadable', error);
    }
  }

  async function getLegacyDeposit(depositId) {
    try {
      const { data, error } = await admin
        .from(DEPOSITS_TABLE)
        .select('id, user_id, amount, status, created_at')
        .eq('id', depositId)
        .maybeSingle();
      if (error) return fail('deposit_unreadable', error);
      return { ok: true, data: data || null };
    } catch (error) {
      return fail('deposit_unreadable', error);
    }
  }

  async function getReferral(referralId) {
    try {
      const { data, error } = await admin
        .from(REFERRALS_TABLE)
        .select('id, referrer_id, referred_id, status, bonus_earned')
        .eq('id', referralId)
        .maybeSingle();
      if (error) return fail('referral_unreadable', error);
      return { ok: true, data: data || null };
    } catch (error) {
      return fail('referral_unreadable', error);
    }
  }

  async function enqueuePendingReminders(opts) {
    const o = opts || {};
    try {
      const { data, error } = await admin.rpc('conversion_enqueue_pending_reminders', {
        p_delay_minutes: o.delayMinutes,
        p_max_per_deposit: o.maxPerDeposit,
        p_limit: o.limit
      });
      if (error) return fail('enqueue_failed', error);
      return { ok: true, data: Number(data) || 0 };
    } catch (error) {
      return fail('enqueue_failed', error);
    }
  }

  async function purge(opts) {
    const o = opts || {};
    try {
      const { data, error } = await admin.rpc('conversion_purge', {
        p_notification_days: o.notificationDays,
        p_event_days: o.eventDays
      });
      if (error) return fail('purge_failed', error);
      return { ok: true, data: data || null };
    } catch (error) {
      return fail('purge_failed', error);
    }
  }

  return {
    probe,
    claimNotifications,
    completeNotification,
    getEvent,
    getLinkedChat,
    getSubscription,
    getConversationLanguage,
    getInvoice,
    getLegacyDeposit,
    getReferral,
    enqueuePendingReminders,
    purge
  };
}

module.exports = {
  createConversionStore,
  EVENTS_TABLE,
  NOTIFICATIONS_TABLE,
  LINKS_TABLE,
  SUBSCRIPTIONS_TABLE,
  CONVERSATIONS_TABLE,
  INVOICES_TABLE,
  DEPOSITS_TABLE,
  REFERRALS_TABLE
};
