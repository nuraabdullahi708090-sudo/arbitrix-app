'use strict';

/**
 * Supabase access for the Telegram marketing publisher.
 *
 * All four tables are RLS-locked to service_role (migration 038), so this store
 * MUST be built with the service-role client.
 *
 * Every method returns a plain object instead of throwing:
 *   { ok: true, data }        - succeeded
 *   { ok: false, reason, error } - failed, with a scrubbed message
 *
 * The worker needs to distinguish "the queue is empty" from "the database is
 * unavailable" so it can fail CLOSED (never send) on the latter.
 *
 * No secret, token or customer message is ever stored here beyond the rendered
 * marketing text itself.
 */

const POSTS = 'telegram_marketing_posts';
const SUBS = 'telegram_marketing_subscriptions';
const CONTROL = 'telegram_marketing_control';
const SENDS = 'telegram_marketing_sends';

function scrub(message) {
  return String(message === null || message === undefined ? '' : message).slice(0, 300);
}

function createMarketingStore(options) {
  const opts = options || {};
  const admin = opts.admin;
  const log = opts.logger || console;
  if (!admin) throw new Error('createMarketingStore requires a Supabase client');

  const fail = (reason, error) => ({
    ok: false,
    reason,
    error: scrub(error && error.message ? error.message : error)
  });

  return {
    /** Publisher control row. Missing/unreadable => the worker must not send. */
    async getControl() {
      const { data, error } = await admin.from(CONTROL).select('*').eq('id', 1).maybeSingle();
      if (error) return fail('control-unreadable', error);
      if (!data) return { ok: false, reason: 'control-missing', error: 'control row 1 not found' };
      return { ok: true, data };
    },

    /**
     * Record worker liveness. Best effort by design: a heartbeat failure must
     * never stop a publisher from publishing, so the caller treats `ok: false`
     * as a warning. It never touches paused/dry_run, so a live worker can never
     * resume publishing by writing a heartbeat.
     */
    async heartbeat({ workerId, version } = {}) {
      const { data, error } = await admin
        .from(CONTROL)
        .update({
          worker_heartbeat_at: new Date().toISOString(),
          worker_id: workerId ? String(workerId).slice(0, 100) : null,
          worker_version: version ? String(version).slice(0, 60) : null
        })
        .eq('id', 1)
        .select('worker_heartbeat_at, worker_id, worker_version')
        .maybeSingle();
      if (error) return fail('heartbeat-failed', error);
      if (!data) return { ok: false, reason: 'control-missing', error: 'control row 1 not found' };
      return { ok: true, data };
    },

    async setControl({ paused, dryRun, updatedBy }) {
      const patch = { updated_at: new Date().toISOString(), updated_by: updatedBy || null };
      if (typeof paused === 'boolean') patch.paused = paused;
      if (typeof dryRun === 'boolean') patch.dry_run = dryRun;
      const { data, error } = await admin.from(CONTROL).update(patch).eq('id', 1).select().maybeSingle();
      if (error) return fail('control-update-failed', error);
      if (!data) return { ok: false, reason: 'control-missing', error: 'control row 1 not found' };
      return { ok: true, data };
    },

    /**
     * Atomically claim due posts. The RPC uses FOR UPDATE SKIP LOCKED, so two
     * workers can never claim (and therefore never send) the same post.
     */
    async claimDue({ now, limit, workerId, leaseSeconds } = {}) {
      const { data, error } = await admin.rpc('claim_marketing_posts', {
        p_now: now || new Date().toISOString(),
        p_limit: Math.min(Math.max(Number(limit) || 5, 1), 25),
        // Migration 043: the claimant + lease that make a crashed claim
        // recoverable. A NULL lease falls back to the SQL default (180s).
        p_worker_id: workerId || null,
        p_lease_seconds: Number.isFinite(Number(leaseSeconds)) ? Number(leaseSeconds) : null
      });
      if (error) {
        // A missing table/function means migration 038 has not been applied.
        const code = error.code || null;
        return fail(code === '42P01' || code === '42883' ? 'schema-not-migrated' : 'claim-failed', error);
      }
      return { ok: true, data: data || [] };
    },

    async finish({ id, ok, messageId, error, retryAt, workerId }) {
      const { data, error: rpcError } = await admin.rpc('finish_marketing_post', {
        p_id: id,
        p_ok: Boolean(ok),
        p_message_id: messageId || null,
        p_error: error ? scrub(error) : null,
        p_retry_at: retryAt || null,
        // Fenced on the current claimant: a worker whose lease was reclaimed
        // gets null back instead of overwriting the new owner's outcome.
        p_worker_id: workerId || null
      });
      if (rpcError) return fail('finish-failed', rpcError);
      return { ok: true, data: Array.isArray(data) ? data[0] : data };
    },

    async block(id, reason, workerId) {
      const { data, error } = await admin.rpc('block_marketing_post', {
        p_id: id,
        p_reason: reason ? scrub(reason) : null,
        p_worker_id: workerId || null
      });
      if (error) return fail('block-failed', error);
      return { ok: true, data: Array.isArray(data) ? data[0] : data };
    },

    /**
     * Has this post already been delivered? A reclaimed post may have been sent
     * by the worker that died, so the next owner reconciles instead of posting
     * a duplicate. Unreadable audit => { ok: false } and the caller must NOT
     * send (fail closed: a duplicate channel post is worse than a delay).
     */
    async hasSentRecord({ postId } = {}) {
      if (!postId) return { ok: true, sent: false, messageId: null };
      const { data, error } = await admin
        .from(SENDS)
        .select('telegram_message_id')
        .eq('post_id', postId)
        .eq('status', 'sent')
        .limit(1);
      if (error) return fail('send-audit-unreadable', error);
      const row = Array.isArray(data) ? data[0] : null;
      return { ok: true, sent: Boolean(row), messageId: row ? row.telegram_message_id : null };
    },

    /** Counts per queue status for the admin status view. */
    async countByStatus() {
      const statuses = ['draft', 'awaiting_approval', 'approved', 'scheduled',
        'sending', 'published', 'failed', 'blocked', 'cancelled'];
      const results = await Promise.all(statuses.map(async (status) => {
        const { count, error } = await admin
          .from(POSTS)
          .select('id', { count: 'exact', head: true })
          .eq('status', status);
        return {
          status,
          count: error ? null : (count || 0),
          errored: Boolean(error),
          message: error ? String(error.message || error.code || 'error') : null
        };
      }));
      // An unreadable queue must be reported as unreadable, not as zero posts:
      // a misleading "0 scheduled" is worse than no number at all.
      const failed = results.filter((r) => r.errored);
      if (failed.length) return fail('count-by-status-failed', failed.map((r) => r.message).join('; '));
      const counts = {};
      for (const row of results) counts[row.status] = row.count;
      return { ok: true, data: counts };
    },

    /** Count of posts that are due right now (used by dry-run reporting). */
    async countDue({ now } = {}) {
      const at = now || new Date().toISOString();
      const { count, error } = await admin
        .from(POSTS)
        .select('id', { count: 'exact', head: true })
        .eq('status', 'scheduled')
        .lte('scheduled_for', at);
      if (error) return fail('count-failed', error);
      return { ok: true, count: count || 0 };
    },

    /**
     * Insert a post. `idempotency_key` is UNIQUE, so a repeated enqueue returns
     * the existing row instead of creating a duplicate.
     */
    async insertPost(row) {
      const payload = Object.assign({}, row);
      const { data, error } = await admin
        .from(POSTS)
        .insert(payload)
        .select()
        .maybeSingle();

      if (!error) return { ok: true, data, duplicate: false };

      if (String(error.code || '') === '23505') {
        const { data: existing, error: readError } = await admin
          .from(POSTS)
          .select('*')
          .eq('idempotency_key', payload.idempotency_key)
          .maybeSingle();
        if (readError) return fail('duplicate-read-failed', readError);
        return { ok: true, data: existing, duplicate: true };
      }

      return fail('insert-failed', error);
    },

    async getPost(id) {
      const { data, error } = await admin.from(POSTS).select('*').eq('id', id).maybeSingle();
      if (error) return fail('read-failed', error);
      return { ok: true, data };
    },

    async listPosts({ status, limit } = {}) {
      let query = admin.from(POSTS).select('*').order('created_at', { ascending: false });
      if (status) query = query.eq('status', status);
      query = query.limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
      const { data, error } = await query;
      if (error) return fail('list-failed', error);
      return { ok: true, data: data || [] };
    },

    async updatePost(id, patch) {
      const run = (payload) => admin
        .from(POSTS)
        .update(Object.assign({ updated_at: new Date().toISOString() }, payload))
        .eq('id', id)
        .select()
        .maybeSingle();

      const { data, error } = await run(patch);
      if (!error) return { ok: true, data };

      // Migration 043 adds claimed_by / lease_expires_at. If an admin action
      // passes them on a deployment that has not applied 043, drop only those
      // keys and retry instead of failing the whole transition.
      const text = String(error.message || '');
      const missingLeaseColumns = (error.code === '42703' || error.code === 'PGRST204') &&
        /claimed_by|lease_expires_at/.test(text + ' ' + JSON.stringify(patch));
      if (missingLeaseColumns) {
        const fallback = Object.assign({}, patch);
        delete fallback.claimed_by;
        delete fallback.lease_expires_at;
        const retried = await run(fallback);
        if (!retried.error) return { ok: true, data: retried.data };
        return fail('update-failed', retried.error);
      }
      return fail('update-failed', error);
    },

    async recordSend(row) {
      const { error } = await admin.from(SENDS).insert({
        post_id: row.postId || null,
        audience: row.audience || null,
        chat_id: row.chatId || null,
        status: row.status,
        attempt: row.attempt || null,
        telegram_message_id: row.messageId || null,
        error: row.error ? scrub(row.error) : null
      });
      if (error) {
        // The audit trail must never break a send that already happened.
        log.warn('[Marketing] send audit write failed: ' + scrub(error.message));
        return fail('send-audit-failed', error);
      }
      return { ok: true };
    },

    async listSends({ postId, limit } = {}) {
      let query = admin.from(SENDS).select('*').order('created_at', { ascending: false });
      if (postId) query = query.eq('post_id', postId);
      query = query.limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
      const { data, error } = await query;
      if (error) return fail('sends-list-failed', error);
      return { ok: true, data: data || [] };
    },

    // ---- subscriptions (opt-in only) ---------------------------------------

    async subscribe({ chatId, userId, locale, source }) {
      const payload = {
        telegram_chat_id: String(chatId),
        telegram_user_id: userId ? String(userId) : null,
        locale: locale || 'en',
        subscribed: true,
        consent_source: source || 'telegram-command',
        updated_at: new Date().toISOString(),
        unsubscribed_at: null
      };
      const { data, error } = await admin
        .from(SUBS)
        .upsert(payload, { onConflict: 'telegram_chat_id' })
        .select()
        .maybeSingle();
      if (error) return fail('subscribe-failed', error);
      return { ok: true, data };
    },

    async unsubscribe(chatId) {
      const { data, error } = await admin
        .from(SUBS)
        .update({
          subscribed: false,
          unsubscribed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('telegram_chat_id', String(chatId))
        .select()
        .maybeSingle();
      if (error) return fail('unsubscribe-failed', error);
      return { ok: true, data };
    },

    async getSubscription(chatId) {
      const { data, error } = await admin
        .from(SUBS)
        .select('*')
        .eq('telegram_chat_id', String(chatId))
        .maybeSingle();
      if (error) return fail('subscription-read-failed', error);
      return { ok: true, data };
    },

    async listSubscribers({ limit } = {}) {
      const { data, error } = await admin
        .from(SUBS)
        .select('telegram_chat_id, locale, subscribed')
        .eq('subscribed', true)
        .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
      if (error) return fail('subscribers-read-failed', error);
      return { ok: true, data: data || [] };
    }
  };
}

module.exports = {
  POSTS,
  SUBS,
  CONTROL,
  SENDS,
  createMarketingStore
};
