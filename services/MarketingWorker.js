'use strict';

/**
 * Durable Telegram marketing publisher.
 *
 * SAFETY CONTRACT
 *   - Inert unless TELEGRAM_MARKETING_ENABLED=true AND the database control row
 *     says paused = FALSE AND dry_run = FALSE. Three independent gates.
 *   - Ignores any chat_id stored on the post: the destination is resolved from
 *     configuration at send time (validateDestination).
 *   - Fails CLOSED: an unreadable control row, an unreadable queue, a missing
 *     chat id or a guard failure all mean "send nothing".
 *   - Re-checks the content guard on the RENDERED text immediately before
 *     sending, so a post queued earlier can still be blocked if the rules or
 *     the business facts changed.
 *   - Never deletes or rewrites a post to make a send succeed.
 *
 * LOGGING
 * Structured, one line per event, with counts and reasons only - no token, no
 * secret, no chat member data, no message body.
 */

const { checkContent } = require('./ContentGuard');
const {
  chatIdForAudience,
  validateDestination,
  createRateLimiter,
  backoffMs,
  retryAfterMs
} = require('./TelegramBroadcast');

function scrub(message) {
  return String(message === null || message === undefined ? '' : message).slice(0, 300);
}

function createMarketingWorker(options) {
  const opts = options || {};
  const store = opts.store;
  const transport = opts.transport;
  const config = opts.config || {};
  const log = opts.logger || console;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  if (!store) throw new Error('createMarketingWorker requires a store');
  if (!transport) throw new Error('createMarketingWorker requires a transport');

  const limiter = opts.rateLimiter || createRateLimiter({ maxPerMinute: 15 });
  const stats = {
    ticks: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    lastTickAt: null,
    lastResult: null,
    lastError: null
  };

  const facts = config.facts || {};
  const guardOptions = {
    minDeposit: facts.minDeposit,
    referralPercent: facts.referralPercent
  };

  function report(event, extra) {
    try {
      log.log(JSON.stringify(Object.assign({ event, component: 'marketing-worker', at: new Date().toISOString() }, extra || {})));
    } catch (error) {
      /* logging must never break a tick */
    }
  }

  async function sendOne(post, chatId) {
    const guard = checkContent(post.content, Object.assign({ locale: post.locale }, guardOptions));
    if (guard.blocked) {
      await store.block(post.id, guard.violations.map((v) => v.code).join(','));
      await store.recordSend({
        postId: post.id,
        audience: post.audience,
        chatId,
        status: 'blocked',
        attempt: post.attempts,
        error: 'content guard: ' + guard.violations.map((v) => v.code).join(',')
      });
      stats.blocked += 1;
      report('post_blocked', { postId: post.id, codes: guard.violations.map((v) => v.code) });
      return 'blocked';
    }

    const slot = limiter.take(chatId);
    if (!slot.ok) {
      await store.finish({
        id: post.id,
        ok: false,
        error: 'rate-limited',
        retryAt: new Date(clock() + slot.waitMs).toISOString()
      });
      stats.skipped += 1;
      return 'rate-limited';
    }

    const replyMarkup = post.buttons && post.buttons.length
      ? { inline_keyboard: post.buttons.map((b) => [{ text: b.text, url: b.url }]) }
      : undefined;

    try {
      const message = await transport.sendMessage(chatId, post.content, replyMarkup ? { reply_markup: replyMarkup } : undefined);
      const messageId = message && message.message_id ? message.message_id : null;
      await store.finish({ id: post.id, ok: true, messageId });
      await store.recordSend({
        postId: post.id,
        audience: post.audience,
        chatId,
        status: 'sent',
        attempt: post.attempts,
        messageId
      });
      stats.sent += 1;
      report('post_published', { postId: post.id, audience: post.audience, messageId });
      return 'sent';
    } catch (error) {
      const retryMs = retryAfterMs(error) || backoffMs(post.attempts, { baseMs: 60000, maxMs: 3600000 });
      const messageText = scrub(error && error.message ? error.message : error);
      await store.finish({
        id: post.id,
        ok: false,
        error: messageText,
        retryAt: new Date(clock() + retryMs).toISOString()
      });
      await store.recordSend({
        postId: post.id,
        audience: post.audience,
        chatId,
        status: 'failed',
        attempt: post.attempts,
        error: messageText
      });
      stats.failed += 1;
      report('post_failed', { postId: post.id, attempt: post.attempts, retryInMs: retryMs, error: messageText });
      return 'failed';
    }
  }

  async function sendToSubscribers(post) {
    const guard = checkContent(post.content, Object.assign({ locale: post.locale }, guardOptions));
    if (guard.blocked) {
      await store.block(post.id, guard.violations.map((v) => v.code).join(','));
      stats.blocked += 1;
      report('post_blocked', { postId: post.id, codes: guard.violations.map((v) => v.code) });
      return 'blocked';
    }

    const subscribers = await store.listSubscribers({ limit: 500 });
    if (!subscribers.ok) {
      await store.finish({ id: post.id, ok: false, error: 'subscribers-unreadable' });
      stats.failed += 1;
      return 'failed';
    }
    if (!subscribers.data.length) {
      // Nothing to send to. Publish the queue item with a skipped audit row so
      // it does not retry forever.
      await store.finish({ id: post.id, ok: true });
      await store.recordSend({
        postId: post.id,
        audience: 'subscribers',
        status: 'skipped',
        error: 'no-subscribers'
      });
      stats.skipped += 1;
      return 'skipped';
    }

    let delivered = 0;
    for (const subscriber of subscribers.data) {
      const chatId = String(subscriber.telegram_chat_id || '');
      // A subscriber chat is a PRIVATE chat, so the -100 channel format does not
      // apply. It is still validated as a positive Telegram user id.
      if (!/^\d{4,20}$/.test(chatId)) continue;
      const slot = limiter.take(chatId);
      if (!slot.ok) continue;
      try {
        const message = await transport.sendMessage(chatId, post.content);
        await store.recordSend({
          postId: post.id,
          audience: 'subscribers',
          chatId,
          status: 'sent',
          attempt: post.attempts,
          messageId: message && message.message_id ? message.message_id : null
        });
        delivered += 1;
      } catch (error) {
        await store.recordSend({
          postId: post.id,
          audience: 'subscribers',
          chatId,
          status: 'failed',
          attempt: post.attempts,
          error: scrub(error && error.message ? error.message : error)
        });
      }
    }
    await store.finish({ id: post.id, ok: true });
    stats.sent += delivered;
    report('post_delivered_to_subscribers', { postId: post.id, delivered });
    return 'sent';
  }

  /** One publishing pass. Never throws. */
  async function tick() {
    stats.ticks += 1;
    stats.lastTickAt = new Date().toISOString();

    if (!config.enabled) {
      stats.lastResult = 'disabled';
      return { skipped: 'disabled' };
    }

    const control = await store.getControl();
    if (!control.ok) {
      stats.lastResult = 'control-unavailable';
      stats.lastError = control.reason;
      report('tick_skipped', { reason: control.reason, detail: control.error });
      return { skipped: 'control-unavailable', reason: control.reason };
    }

    if (control.data.paused) {
      stats.lastResult = 'paused';
      return { skipped: 'paused' };
    }

    const dryRun = Boolean(config.dryRun) || Boolean(control.data.dry_run);
    if (dryRun) {
      const due = await store.countDue({ now: new Date(clock()).toISOString() });
      stats.lastResult = 'dry-run';
      report('tick_dry_run', { due: due.ok ? due.count : null });
      return { skipped: 'dry-run', due: due.ok ? due.count : null };
    }

    const claimed = await store.claimDue({ now: new Date(clock()).toISOString(), limit: 5 });
    if (!claimed.ok) {
      stats.lastResult = 'claim-failed';
      stats.lastError = claimed.reason;
      report('tick_failed', { reason: claimed.reason, detail: claimed.error });
      return { skipped: 'claim-failed', reason: claimed.reason };
    }

    const posts = claimed.data || [];
    stats.claimed += posts.length;
    if (!posts.length) {
      stats.lastResult = 'idle';
      return { claimed: 0, sent: 0 };
    }

    const results = [];
    for (const post of posts) {
      if (post.audience === 'subscribers') {
        results.push({ id: post.id, result: await sendToSubscribers(post) });
        continue;
      }

      const target = chatIdForAudience(post.audience, config);
      // Use the audience-specific reason when the chat id is simply absent, so
      // an operator is told WHICH env var to set.
      const valid = target.chatId
        ? validateDestination(target.chatId, config)
        : { ok: false, chatId: '', reason: target.reason || 'missing-chat-id' };
      if (!valid.ok) {
        // A configuration problem is retryable (an operator may fix the env
        // var), but it is never a reason to pick a different chat.
        await store.finish({
          id: post.id,
          ok: false,
          error: 'destination: ' + valid.reason,
          retryAt: new Date(clock() + backoffMs(post.attempts)).toISOString()
        });
        await store.recordSend({
          postId: post.id,
          audience: post.audience,
          chatId: valid.chatId,
          status: 'skipped',
          attempt: post.attempts,
          error: 'destination: ' + valid.reason
        });
        stats.skipped += 1;
        report('post_skipped_destination', { postId: post.id, reason: valid.reason });
        results.push({ id: post.id, result: 'destination-invalid', reason: valid.reason });
        continue;
      }

      results.push({ id: post.id, result: await sendOne(post, valid.chatId) });
    }

    stats.lastResult = 'processed';
    report('tick_processed', {
      claimed: posts.length,
      sent: stats.sent,
      failed: stats.failed,
      blocked: stats.blocked,
      skipped: stats.skipped
    });
    return { claimed: posts.length, results };
  }

  /** Interval loop with graceful shutdown. */
  function run(runOptions) {
    const o = runOptions || {};
    const intervalMs = Math.max(Number(config.tickMs) || 60000, 15000);
    let stopped = false;
    let timer = null;

    const loop = async () => {
      if (stopped) return;
      try {
        await tick();
      } catch (error) {
        stats.lastError = scrub(error && error.message ? error.message : error);
        report('tick_error', { error: stats.lastError });
      }
    };

    loop();
    timer = setInterval(loop, intervalMs);
    // Deliberately NOT unref'd: a standalone publisher must keep the event loop
    // alive so it can tick. (The trading worker shipped an unref'd timer once and
    // exited immediately after start-up.)

    return {
      stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
      },
      intervalMs
    };
  }

  return {
    tick,
    run,
    stats: () => Object.assign({}, stats),
    config: () => ({
      enabled: Boolean(config.enabled),
      dryRun: Boolean(config.dryRun),
      tickMs: Number(config.tickMs) || 60000
    })
  };
}

module.exports = { createMarketingWorker };
