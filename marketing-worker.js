#!/usr/bin/env node
'use strict';

/**
 * Telegram marketing publisher entrypoint.
 *
 * RUN AS A SEPARATE PROCESS (e.g. a Render Background Worker):
 *
 *     node marketing-worker.js
 *
 * INERT UNTIL EXPLICITLY ENABLED. It requires ALL of:
 *   * TELEGRAM_MARKETING_ENABLED=true          (feature switch, default OFF)
 *   * SUPABASE_URL + SUPABASE_SERVICE_KEY       (queue access)
 *   * a readable `telegram_marketing_control` row (migration 038 applied)
 *   * control.paused = FALSE and control.dry_run = FALSE
 *
 * If any of those is missing it sends NOTHING and exits (or idles without
 * sending), so shipping this file cannot publish a single message on its own.
 *
 * It never listens on a port, never imports server.js, and never touches money:
 * deposits, withdrawals, trading, subscriptions, referrals and the sandbox are
 * out of scope by construction.
 *
 * EXIT CODES
 *   0  disabled by configuration, or clean shutdown
 *   1  enabled but misconfigured (missing service key / unreadable control row)
 *   2  unexpected fatal error
 */

const { createTelegramTransport } = require('./services/TelegramSupportService');
const { resolveMarketingConfig, describeMarketingConfig } = require('./services/TelegramBroadcast');
const { createMarketingStore } = require('./services/MarketingStore');
const { createMarketingWorker } = require('./services/MarketingWorker');

const WORKER_VERSION = 'marketing-worker/1';

function logEvent(event, extra) {
  try {
    console.log(JSON.stringify(Object.assign(
      { event, component: 'marketing-worker', version: WORKER_VERSION, at: new Date().toISOString() },
      extra || {}
    )));
  } catch (error) {
    console.log('[Marketing] ' + event);
  }
}

async function main() {
  const config = resolveMarketingConfig(process.env);

  if (!config.enabled) {
    logEvent('worker_disabled', { reason: 'TELEGRAM_MARKETING_ENABLED is not true' });
    return 0;
  }

  const url = String(process.env.SUPABASE_URL || '').trim();
  // The project standard name is SUPABASE_SERVICE_KEY; the Supabase dashboard
  // calls the same value SUPABASE_SERVICE_ROLE_KEY. Accept either so a
  // background worker created from the dashboard template is not silently
  // misconfigured. Both are the same service-role credential.
  const serviceKey = String(
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  ).trim();
  if (!url || !serviceKey) {
    logEvent('worker_misconfigured', {
      reason: 'SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required',
      urlPresent: Boolean(url),
      serviceKeyPresent: Boolean(serviceKey)
    });
    return 1;
  }

  // A value that was supplied but is not a numeric chat id is NOT "unset": it
  // resolves to no destination, so without this line the channel would silently
  // never publish while the group kept working.
  for (const [variable, reason] of [
    ['TELEGRAM_MARKETING_CHAT_ID', config.groupChatIdInvalid],
    ['TELEGRAM_ANNOUNCEMENT_CHAT_ID', config.channelChatIdInvalid]
  ]) {
    if (!reason) continue;
    logEvent('worker_config_warning', {
      variable,
      reason,
      hint: 'the publisher addresses chats by numeric id (-100...); a @username or a t.me link cannot be used'
    });
  }

  if (!config.groupChatId && !config.channelChatId) {
    const invalid = config.groupChatIdInvalid
      ? 'TELEGRAM_MARKETING_CHAT_ID=' + config.groupChatIdInvalid
      : (config.channelChatIdInvalid ? 'TELEGRAM_ANNOUNCEMENT_CHAT_ID=' + config.channelChatIdInvalid : '');
    logEvent('worker_misconfigured', {
      reason: invalid
        ? 'no usable destination: ' + invalid
        : 'neither TELEGRAM_MARKETING_CHAT_ID nor TELEGRAM_ANNOUNCEMENT_CHAT_ID is set',
      config: describeMarketingConfig(config)
    });
    return 1;
  }

  // Required lazily so the disabled path works even in an environment where
  // dependencies are not installed.
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const store = createMarketingStore({ admin });
  const transport = createTelegramTransport({ token: process.env.TELEGRAM_BOT_TOKEN });

  // Facts come from the SAME constants the application uses. They are injected
  // here rather than duplicated in a template so marketing copy can never drift.
  const facts = {
    minDeposit: Number(process.env.MARKETING_FACT_MIN_DEPOSIT || 100),
    referralPercent: Number(process.env.MARKETING_FACT_REFERRAL_PERCENT || 20),
    promoCredit: Number(process.env.MARKETING_FACT_PROMO_CREDIT || 50)
  };

  const worker = createMarketingWorker({
    store,
    transport,
    // Migration 043: the claimant identity and lease that make a crashed claim
    // recoverable by another worker instead of stranded in 'sending'.
    workerId: config.workerId,
    workerVersion: WORKER_VERSION,
    leaseSeconds: config.leaseSeconds,
    config: Object.assign({}, config, { facts })
  });

  const control = await store.getControl();
  if (!control.ok) {
    logEvent('worker_misconfigured', {
      reason: 'publisher control is unreadable - is migration 038 applied?',
      detail: control.reason,
      error: control.error
    });
    return 1;
  }

  logEvent('worker_started', {
    config: describeMarketingConfig(config),
    paused: Boolean(control.data.paused),
    dryRun: Boolean(control.data.dry_run),
    tickMs: config.tickMs,
    workerId: config.workerId,
    workerVersion: WORKER_VERSION,
    leaseSeconds: config.leaseSeconds,
    tokenPresent: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    heartbeat: 'telegram_marketing_control.worker_heartbeat_at (migration 044)'
  });

  const runner = worker.run();

  const shutdown = (signal) => {
    logEvent('worker_stopping', { signal, stats: worker.stats() });
    runner.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logEvent('unhandled_rejection', {
      error: String(reason && reason.message ? reason.message : reason).slice(0, 200)
    });
  });

  // Keep the process alive; the interval does that, but an explicit promise makes
  // the intent obvious and avoids an accidental early exit.
  return new Promise(() => {});
}

main()
  .then((code) => process.exit(Number.isFinite(code) ? code : 0))
  .catch((error) => {
    logEvent('worker_fatal', { error: String(error && error.message ? error.message : error).slice(0, 300) });
    process.exit(2);
  });
