#!/usr/bin/env node
'use strict';

/**
 * Conversion notification worker entrypoint.
 *
 * RUN AS A SEPARATE PROCESS (e.g. a Render Background Worker):
 *
 *     node conversion-worker.js
 *
 * INERT UNTIL EXPLICITLY ENABLED. It requires ALL of:
 *   * CONVERSION_WORKER_ENABLED=true        (feature switch, default OFF)
 *   * SUPABASE_URL + SUPABASE_SERVICE_KEY    (outbox access)
 *   * TELEGRAM_BOT_TOKEN                     (the official bot)
 *   * a readable `conversion_notifications` table (migration 040 applied)
 *
 * With any of those missing it sends NOTHING and exits non-zero (exit 0 when it
 * is simply disabled), so shipping this file cannot deliver a single message.
 *
 * PROMOTIONAL REMINDERS ARE A SEPARATE SWITCH:
 *   CONVERSION_PENDING_REMINDERS_ENABLED=true
 * Off by default - pending-deposit follow-ups stay disabled until management
 * approves them, and the worker also refuses to dispatch any promotional row it
 * finds already queued while that switch is off.
 *
 * It never listens on a port, never imports server.js and never touches money:
 * deposits, withdrawals, trading, subscriptions, referrals and the sandbox are
 * out of scope by construction (the events are produced by database triggers in
 * the credit transaction; this process only delivers messages).
 *
 * EXIT CODES
 *   0  disabled by configuration, or clean shutdown
 *   1  enabled but misconfigured (missing service key / bot token / migration)
 *   2  unexpected fatal error
 */

const { createTelegramTransport } = require('./services/TelegramSupportService');
const {
  createConversionWorker,
  describeConversionConfig,
  resolveConversionConfig
} = require('./services/ConversionWorker');
const { createConversionStore } = require('./services/ConversionStore');

const WORKER_VERSION = 'conversion-worker/1';

function logEvent(event, extra) {
  try {
    console.log(JSON.stringify(Object.assign(
      { event, component: 'conversion-worker', version: WORKER_VERSION, at: new Date().toISOString() },
      extra || {}
    )));
  } catch (error) {
    console.log('[Conversion] ' + event);
  }
}

async function main() {
  const config = resolveConversionConfig(process.env);

  if (!config.enabled) {
    logEvent('worker_disabled', { reason: 'CONVERSION_WORKER_ENABLED is not true' });
    return 0;
  }

  const url = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !serviceKey) {
    logEvent('worker_misconfigured', {
      reason: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required',
      urlPresent: Boolean(url),
      serviceKeyPresent: Boolean(serviceKey)
    });
    return 1;
  }

  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!botToken) {
    logEvent('worker_misconfigured', { reason: 'TELEGRAM_BOT_TOKEN is required to deliver notifications' });
    return 1;
  }

  // Required lazily so the disabled path works even when dependencies are absent.
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const store = createConversionStore({ admin });

  const probe = await store.probe();
  if (!probe.ok) {
    logEvent('worker_misconfigured', {
      reason: 'the conversion outbox is unreadable - is migration 040 applied?',
      detail: probe.reason,
      error: probe.error
    });
    return 1;
  }

  const transport = createTelegramTransport({ token: botToken });
  const worker = createConversionWorker({
    store,
    transport,
    config,
    workerId: process.env.CONVERSION_WORKER_ID || undefined
  });

  logEvent('worker_started', {
    config: describeConversionConfig(config),
    tokenPresent: true
  });

  const shutdown = (signal) => {
    logEvent('worker_stopping', { signal, stats: worker.stats() });
    worker.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logEvent('unhandled_rejection', {
      error: String(reason && reason.message ? reason.message : reason).slice(0, 200)
    });
  });

  await worker.start();

  // Keep the process alive; the loop schedules itself, this promise makes the
  // intent explicit and avoids an accidental early exit.
  return new Promise(() => {});
}

main()
  .then((code) => process.exit(Number.isFinite(code) ? code : 0))
  .catch((error) => {
    logEvent('worker_fatal', { error: String(error && error.message ? error.message : error).slice(0, 300) });
    process.exit(2);
  });
