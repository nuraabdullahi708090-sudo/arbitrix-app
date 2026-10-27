'use strict';

/**
 * Phase 2 - conversion events + Telegram outbox.
 *
 * Two layers are covered:
 *
 *  1. THE SQL (supabase/migrations/040_conversion_events.sql) is asserted at the
 *     source level here (tables, columns, constraints, RLS, trigger guards, RPC
 *     semantics). It was ALSO executed against a real PostgreSQL 16 instance
 *     during development - see the AGENTS.md note for the 20 behavioural checks
 *     that ran there (this suite cannot run Postgres).
 *
 *  2. THE WORKER is executed for real (services/ConversionWorker.js) against an
 *     in-memory store that mirrors the RPC contract, and a recording transport.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '040_conversion_events.sql'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'services', 'ConversionWorker.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'services', 'ConversionStore.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'services', 'conversion-i18n.js'), 'utf8');
const ENTRY_SRC = fs.readFileSync(path.join(ROOT, 'conversion-worker.js'), 'utf8');
const SUPPORT_SRC = fs.readFileSync(path.join(ROOT, 'services', 'TelegramSupportService.js'), 'utf8');

const {
  CONVERSION_STRINGS,
  renderConversionMessage,
  formatAmount,
  MESSAGE_KEYS_BY_EVENT
} = require('../services/conversion-i18n');
const {
  createConversionWorker,
  resolveConversionConfig,
  describeConversionConfig,
  isPrivateChatId,
  classifySendFailure,
  DEFAULT_CONFIG
} = require('../services/ConversionWorker');
const { normalizeLanguage } = require('../services/telegram-i18n');

const USER_ID = 42;
const CHAT_ID = '777000111';
const GROUP_CHAT_ID = '-1001234567890';

// ---------------------------------------------------------------------------
// In-memory store mirroring conversion_* RPC semantics
// ---------------------------------------------------------------------------

function createFakeStore(options) {
  const opts = options || {};
  const state = {
    events: [],
    notifications: [],
    links: {},           // userId -> chatId
    subscriptions: {},   // chatId -> { subscribed, locale }
    conversations: {},   // chatId -> language
    invoices: {},
    deposits: {},
    referrals: {},
    seq: 1,
    calls: { claim: 0, complete: [], enqueue: 0, purge: 0 }
  };
  const fail = opts.fail || {};
  let now = opts.startMs || Date.now();
  const clock = () => now;

  function addEvent(row) {
    const event = Object.assign({
      id: state.seq++,
      event_type: 'deposit_confirmed',
      user_id: USER_ID,
      amount: 100,
      source: 'payment_invoice',
      payload: {},
      created_at: new Date(clock()).toISOString()
    }, row);
    state.events.push(event);
    return event;
  }

  function addNotification(event, overrides) {
    const row = Object.assign({
      id: state.seq++,
      event_id: event.id,
      event_type: event.event_type,
      category: 'transactional',
      user_id: event.user_id,
      idempotency_key: 'key:' + event.id,
      status: 'pending',
      attempts: 0,
      max_attempts: 5,
      next_attempt_at: new Date(clock()).toISOString(),
      lease_expires_at: null,
      claimed_by: null,
      created_at: new Date(clock()).toISOString(),
      updated_at: new Date(clock()).toISOString()
    }, overrides || {});
    state.notifications.push(row);
    return row;
  }

  return {
    state,
    clock,
    advance(ms) { now += ms; },
    addEvent,
    addNotification,
    async probe() { return fail.probe ? { ok: false, reason: 'outbox_unreadable' } : { ok: true }; },
    async claimNotifications(workerId, limit) {
      state.calls.claim += 1;
      if (fail.claim) return { ok: false, reason: 'claim_failed' };
      const due = state.notifications.filter((n) => (
        (n.status === 'pending' && Date.parse(n.next_attempt_at) <= clock())
        || (n.status === 'failed' && Date.parse(n.next_attempt_at) <= clock() && n.attempts < n.max_attempts)
        || (n.status === 'sending' && n.lease_expires_at && Date.parse(n.lease_expires_at) < clock())
      )).slice(0, limit);
      for (const row of due) {
        row.status = 'sending';
        row.attempts += 1;
        row.claimed_by = workerId;
        row.lease_expires_at = new Date(clock() + 180000).toISOString();
      }
      return { ok: true, data: due.map((r) => Object.assign({}, r)) };
    },
    async completeNotification(id, status, reason, retrySeconds) {
      state.calls.complete.push({ id, status, reason, retrySeconds });
      if (fail.complete) return { ok: false, reason: 'complete_failed' };
      const row = state.notifications.find((n) => n.id === id);
      if (!row || row.status !== 'sending') return { ok: true, data: false };
      if (status === 'sent') {
        row.status = 'sent';
        row.sent_at = new Date(clock()).toISOString();
      } else if (status === 'skipped') {
        row.status = 'skipped';
        row.skip_reason = reason || 'skipped';
      } else if (row.attempts >= row.max_attempts) {
        row.status = 'failed';
        row.last_error = reason || 'failed';
      } else {
        row.status = 'pending';
        row.next_attempt_at = new Date(clock() + (retrySeconds ? retrySeconds * 1000 : 60000)).toISOString();
        row.last_error = reason || 'failed';
      }
      row.lease_expires_at = null;
      row.claimed_by = null;
      return { ok: true, data: true };
    },
    async getEvent(eventId) {
      if (fail.event) return { ok: false, reason: 'event_unreadable' };
      return { ok: true, data: state.events.find((e) => e.id === eventId) || null };
    },
    async getLinkedChat(userId) {
      if (fail.link) return { ok: false, reason: 'link_unreadable' };
      const chatId = state.links[userId];
      return { ok: true, data: chatId ? { chatId: String(chatId), linkedAt: null } : null };
    },
    async getSubscription(chatId) {
      if (fail.subscription) return { ok: false, reason: 'subscription_unreadable' };
      const row = state.subscriptions[chatId];
      return { ok: true, data: row ? { subscribed: row.subscribed === true, locale: row.locale || null } : { subscribed: false, locale: null } };
    },
    async getConversationLanguage(chatId) {
      return { ok: true, data: state.conversations[chatId] || null };
    },
    async getInvoice(id) {
      if (fail.invoice) return { ok: false, reason: 'invoice_unreadable' };
      return { ok: true, data: state.invoices[id] || null };
    },
    async getLegacyDeposit(id) {
      return { ok: true, data: state.deposits[id] || null };
    },
    async getReferral(id) {
      return { ok: true, data: state.referrals[id] || null };
    },
    async enqueuePendingReminders() {
      state.calls.enqueue += 1;
      return { ok: true, data: 0 };
    },
    async purge() {
      state.calls.purge += 1;
      return { ok: true, data: { notificationsDeleted: 0, eventsDeleted: 0 } };
    }
  };
}

function createFakeTransport(options) {
  const opts = options || {};
  const calls = [];
  let last = null;
  return {
    calls,
    async sendMessage(chatId, text, options2) {
      calls.push({ chatId: String(chatId), text, options: options2 || null });
      if (opts.failWith) {
        last = Object.assign({ method: 'sendMessage', ok: false, at: new Date().toISOString() }, opts.failWith);
        const error = new Error('Telegram sendMessage failed: ' + (last.description || 'simulated'));
        throw error;
      }
      last = { method: 'sendMessage', httpStatus: 200, ok: true, errorCode: null, description: null, at: new Date().toISOString() };
      return { message_id: 1000 + calls.length };
    },
    getLastCall() { return last; }
  };
}

function makeWorker(overrides) {
  const o = overrides || {};
  const store = o.store || createFakeStore(o.storeOptions);
  const transport = o.transport || createFakeTransport(o.transportOptions);
  const logs = [];
  const logger = o.logger || {
    log: (line) => logs.push(String(line)),
    warn: (line) => logs.push(String(line)),
    error: (line) => logs.push(String(line))
  };
  const worker = createConversionWorker({
    store,
    transport,
    config: Object.assign({}, o.config || {}),
    logger,
    clock: store.clock,
    sleep: async () => {},
    workerId: o.workerId || 'test-worker'
  });
  return { store, transport, worker, logs };
}

/** A deposit_confirmed notification that is eligible by default. */
function seedDeposit(store, overrides) {
  const o = overrides || {};
  const event = store.addEvent({
    event_type: 'deposit_confirmed',
    user_id: o.userId || USER_ID,
    amount: o.amount === undefined ? 150 : o.amount,
    source: 'payment_invoice',
    payload: { invoiceId: 1 }
  });
  store.state.invoices[1] = Object.assign({
    id: 1, user_id: USER_ID, amount_usd: 150, status: 'confirmed', credited: true, expires_at: null
  }, o.invoice || {});
  if (o.link !== false) store.state.links[o.userId || USER_ID] = o.chatId || CHAT_ID;
  const notification = store.addNotification(event, o.notification || {});
  return { event, notification };
}

function seedReferral(store, overrides) {
  const o = overrides || {};
  const event = store.addEvent({
    event_type: 'referral_qualified',
    user_id: o.referrerId || USER_ID,
    amount: 20,
    source: 'referrals',
    payload: { referralId: 7 }
  });
  store.state.referrals[7] = Object.assign({
    id: 7, referrer_id: o.referrerId || USER_ID, referred_id: 99, status: 'active', bonus_earned: 20
  }, o.referral || {});
  if (o.link !== false) store.state.links[o.referrerId || USER_ID] = CHAT_ID;
  const notification = store.addNotification(event, o.notification || {});
  return { event, notification };
}

function seedReminder(store, overrides) {
  const o = overrides || {};
  const event = store.addEvent({
    event_type: 'deposit_pending_reminder',
    user_id: USER_ID,
    amount: 100,
    source: 'payment_invoice',
    payload: { invoiceId: 2 }
  });
  store.state.invoices[2] = Object.assign({
    id: 2, user_id: USER_ID, amount_usd: 100, status: 'pending', credited: false,
    expires_at: new Date(store.clock() + 3600000).toISOString()
  }, o.invoice || {});
  if (o.link !== false) store.state.links[USER_ID] = CHAT_ID;
  if (o.subscribed !== false) store.state.subscriptions[CHAT_ID] = { subscribed: true, locale: o.locale || null };
  const notification = store.addNotification(event, Object.assign({ category: 'promotional' }, o.notification || {}));
  return { event, notification };
}

// ===========================================================================
// A. Configuration
// ===========================================================================

test('config: the worker and the reminders are both OFF by default', () => {
  const config = resolveConversionConfig({});
  assert.strictEqual(config.enabled, false);
  assert.strictEqual(config.pendingRemindersEnabled, false);
  assert.strictEqual(config.purgeEnabled, false);
  assert.strictEqual(config.batchSize, DEFAULT_CONFIG.batchSize);
  assert.strictEqual(config.maxAgeMinutes, DEFAULT_CONFIG.maxAgeMinutes);
  const described = describeConversionConfig(config);
  assert.strictEqual(described.pendingRemindersEnabled, false);
  assert.ok(!('token' in described), 'the boot line must not carry secrets');
});

test('config: only the literal string "true" enables a switch', () => {
  assert.strictEqual(resolveConversionConfig({ CONVERSION_WORKER_ENABLED: 'TRUE' }).enabled, true);
  assert.strictEqual(resolveConversionConfig({ CONVERSION_WORKER_ENABLED: '1' }).enabled, false);
  assert.strictEqual(resolveConversionConfig({ CONVERSION_WORKER_ENABLED: 'yes' }).enabled, false);
  assert.strictEqual(resolveConversionConfig({ CONVERSION_WORKER_ENABLED: 'true' }).enabled, true);
  assert.strictEqual(resolveConversionConfig({ CONVERSION_PENDING_REMINDERS_ENABLED: 'true' }).pendingRemindersEnabled, true);
});

test('config: numeric knobs are clamped, never trusted', () => {
  assert.strictEqual(resolveConversionConfig({ CONVERSION_BATCH_SIZE: '9999' }).batchSize, 100);
  assert.strictEqual(resolveConversionConfig({ CONVERSION_BATCH_SIZE: '0' }).batchSize, 1);
  assert.strictEqual(resolveConversionConfig({ CONVERSION_BATCH_SIZE: 'abc' }).batchSize, DEFAULT_CONFIG.batchSize);
  assert.strictEqual(resolveConversionConfig({ CONVERSION_TICK_MS: '10' }).tickMs, 5000);
  assert.strictEqual(resolveConversionConfig({ CONVERSION_REMINDER_MAX_PER_DEPOSIT: '99' }).reminderMaxPerDeposit, 5);
  assert.strictEqual(resolveConversionConfig({ CONVERSION_MAX_AGE_MINUTES: '-5' }).maxAgeMinutes, 5);
});

// ===========================================================================
// B. Copy and localization
// ===========================================================================

test('copy: all three locales define the same, non-empty key set', () => {
  const langs = Object.keys(CONVERSION_STRINGS);
  assert.deepStrictEqual(langs.sort(), ['ar', 'en', 'pt']);
  const baseKeys = Object.keys(CONVERSION_STRINGS.en).sort();
  assert.deepStrictEqual(baseKeys, [
    'depositConfirmed', 'depositConfirmedNoAmount', 'pendingReminder',
    'pendingReminderNoAmount', 'referralQualified'
  ]);
  for (const lang of langs) {
    assert.deepStrictEqual(Object.keys(CONVERSION_STRINGS[lang]).sort(), baseKeys, lang + ' key set');
    for (const key of baseKeys) {
      assert.ok(String(CONVERSION_STRINGS[lang][key]).trim().length > 0, lang + '/' + key + ' empty');
    }
  }
});

test('copy: the deposit message interpolates the amount in every locale', () => {
  for (const lang of ['en', 'pt', 'ar']) {
    const text = renderConversionMessage('deposit_confirmed', lang, 150);
    assert.ok(text.includes('$150.00'), lang + ' amount missing');
    assert.ok(!text.includes('{{'), lang + ' left an uninterpolated placeholder');
  }
  assert.strictEqual(formatAmount(150), '$150.00');
  assert.strictEqual(formatAmount(0), null);
  assert.strictEqual(formatAmount('nope'), null);
});

test('copy: an amount-less event uses the no-amount variant, never "null"', () => {
  const text = renderConversionMessage('deposit_confirmed', 'en', null);
  assert.ok(!/null|undefined|\$0\.00/.test(text));
  assert.ok(text.includes('We received your deposit'));
});

test('copy: the referral message quotes NO amount and makes no payment claim', () => {
  for (const lang of ['en', 'pt', 'ar']) {
    const text = renderConversionMessage('referral_qualified', lang, 20);
    assert.ok(!/\$\s?\d/.test(text), lang + ' quotes a figure: ' + text);
    assert.ok(!/paid|payout|pago|pagamento/i.test(text), lang + ' claims a payment');
    assert.ok(/referral|indica|إحال/i.test(text), lang + ' should mention the Referral section');
  }
});

test('copy: no message ever contains credentials, payment data or profit promises', () => {
  const forbidden = [
    /guarantee|guaranteed|risk[- ]free|profit|returns?\b|earn (?:up to|\d)/i,
    /0x[a-f0-9]{8,}/i, /T[A-Za-z0-9]{20,}/, /tx(?:hash|_hash)/i, /private key|seed phrase|password|otp/i,
    /@[a-z0-9.-]+\.[a-z]{2,}/i
  ];
  for (const lang of ['en', 'pt', 'ar']) {
    for (const key of Object.keys(CONVERSION_STRINGS[lang])) {
      const text = CONVERSION_STRINGS[lang][key];
      for (const re of forbidden) {
        assert.ok(!re.test(text), lang + '/' + key + ' violates ' + re + ': ' + text);
      }
    }
  }
});

test('copy: the promotional reminder is opt-out-able and never claims payment', () => {
  for (const lang of ['en', 'pt', 'ar']) {
    const text = renderConversionMessage('deposit_pending_reminder', lang, 100);
    assert.ok(text.includes('/unsubscribe'), lang + ' has no opt-out instruction');
    assert.ok(!/confirmed|confirmado|مؤكد/.test(text), lang + ' describes a pending deposit as confirmed');
  }
  const en = renderConversionMessage('deposit_pending_reminder', 'en', 100);
  assert.ok(/still pending|not yet received/i.test(en));
});

test('copy: an unknown event type or language falls back safely', () => {
  assert.strictEqual(renderConversionMessage('registration', 'en', null), null);
  assert.strictEqual(renderConversionMessage('nonsense', 'en', 10), null);
  const fallback = renderConversionMessage('deposit_confirmed', 'zz', 10);
  assert.strictEqual(fallback, CONVERSION_STRINGS.en.depositConfirmed.replace('{{amount}}', '$10.00'));
  assert.deepStrictEqual(Object.keys(MESSAGE_KEYS_BY_EVENT).sort(), [
    'deposit_confirmed', 'deposit_pending_reminder', 'referral_qualified'
  ]);
});

// ===========================================================================
// C. Happy paths
// ===========================================================================

test('worker: a confirmed deposit is delivered once to the linked private chat', async () => {
  const { store, transport, worker } = makeWorker();
  const { notification } = seedDeposit(store);

  await worker.tick();

  assert.strictEqual(transport.calls.length, 1);
  assert.strictEqual(transport.calls[0].chatId, CHAT_ID);
  assert.ok(transport.calls[0].text.includes('Deposit confirmed'));
  assert.ok(transport.calls[0].text.includes('$150.00'));
  assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).status, 'sent');
  assert.strictEqual(worker.stats().sent, 1);
});

test('worker: a second tick does not resend an already-sent notification', async () => {
  const { store, transport, worker } = makeWorker();
  seedDeposit(store);
  await worker.tick();
  await worker.tick();
  assert.strictEqual(transport.calls.length, 1);
});

test('worker: transactional messages need no marketing consent', async () => {
  const { store, transport, worker } = makeWorker();
  seedDeposit(store);                       // no subscription row at all
  await worker.tick();
  assert.strictEqual(transport.calls.length, 1);
  assert.strictEqual(store.state.calls.enqueue, 0, 'the worker must not enqueue anything');
});

test('worker: the referral notification goes to the referrer', async () => {
  const { store, transport, worker } = makeWorker();
  seedReferral(store, { referrerId: USER_ID });
  await worker.tick();
  assert.strictEqual(transport.calls.length, 1);
  assert.strictEqual(transport.calls[0].chatId, CHAT_ID);
  assert.ok(transport.calls[0].text.includes('Referral qualified'));
  assert.ok(!/\$\d/.test(transport.calls[0].text), 'the reward amount must not be quoted');
});

test('worker: language comes from the conversation, then the subscription, then English', async () => {
  const a = makeWorker();
  seedDeposit(a.store);
  a.store.state.conversations[CHAT_ID] = 'pt';
  await a.worker.tick();
  assert.ok(a.transport.calls[0].text.includes('Depósito confirmado'));

  const b = makeWorker({ config: { pendingRemindersEnabled: true } });
  seedReminder(b.store, { locale: 'ar', subscribed: true });
  await b.worker.tick();
  assert.ok(/تم تأكيد|تم/.test(b.transport.calls[0].text) || b.transport.calls[0].text.includes('معلق'),
    'the subscription locale must be used: ' + b.transport.calls[0].text);

  const c = makeWorker();
  seedDeposit(c.store);
  c.store.state.conversations[CHAT_ID] = 'zz';
  await c.worker.tick();
  assert.ok(c.transport.calls[0].text.includes('Deposit confirmed'), 'unsupported language -> English');
  assert.strictEqual(normalizeLanguage('zz'), 'en');
});

// ===========================================================================
// D. Eligibility re-checks (immediately before dispatch)
// ===========================================================================

test('eligibility: an unlinked account is never messaged', async () => {
  const { store, transport, worker } = makeWorker();
  const { notification } = seedDeposit(store, { link: false });
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0);
  assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).skip_reason, 'not_linked');
});

test('eligibility: unlinking AFTER the row was queued stops the message', async () => {
  const { store, transport, worker } = makeWorker();
  const { notification } = seedDeposit(store);
  assert.strictEqual(store.state.links[USER_ID], CHAT_ID);
  delete store.state.links[USER_ID];          // the user pressed /unlink in the meantime
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0);
  assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).status, 'skipped');
});

test('eligibility: a group chat id is refused even if it somehow got stored', async () => {
  const { store, transport, worker } = makeWorker();
  seedDeposit(store, { chatId: GROUP_CHAT_ID });
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0, 'financial messages must never reach a group');
  assert.strictEqual(store.state.notifications[0].skip_reason, 'not_private');
});

test('eligibility: promotional rows are refused while the switch is off', async () => {
  const { store, transport, worker } = makeWorker();
  const { notification } = seedReminder(store, { subscribed: true });
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0);
  assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).skip_reason, 'promotional_disabled');
});

test('eligibility: an unsubscribed user gets no promotional message', async () => {
  const { store, transport, worker } = makeWorker({ config: { pendingRemindersEnabled: true } });
  const { notification } = seedReminder(store, { subscribed: false });
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0);
  assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).skip_reason, 'not_subscribed');
});

test('eligibility: unsubscribing after enqueue suppresses the queued reminder', async () => {
  const { store, transport, worker } = makeWorker({ config: { pendingRemindersEnabled: true } });
  seedReminder(store, { subscribed: true });
  store.state.subscriptions[CHAT_ID] = { subscribed: false, locale: 'en' };
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0);
});

test('eligibility: a subscribed user DOES get the reminder when it is enabled', async () => {
  const { store, transport, worker } = makeWorker({ config: { pendingRemindersEnabled: true } });
  seedReminder(store, { subscribed: true });
  await worker.tick();
  assert.strictEqual(transport.calls.length, 1);
  assert.ok(transport.calls[0].text.includes('/unsubscribe'));
});

test('eligibility: stale events are skipped, not delivered late', async () => {
  const { store, transport, worker } = makeWorker({ config: { maxAgeMinutes: 60 } });
  const { notification } = seedDeposit(store);
  store.advance(61 * 60 * 1000);              // one hour later
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0);
  assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).skip_reason, 'stale');
});

test('eligibility: a deposit that is no longer confirmed is not announced', async () => {
  for (const invoice of [{ status: 'pending', credited: false }, { status: 'confirmed', credited: false }, { status: 'expired', credited: true }]) {
    const { store, transport, worker } = makeWorker();
    const { notification } = seedDeposit(store, { invoice });
    await worker.tick();
    assert.strictEqual(transport.calls.length, 0, JSON.stringify(invoice));
    assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).skip_reason, 'not_confirmed');
  }
});

test('eligibility: a legacy deposit is verified against the deposits table', async () => {
  const good = makeWorker();
  const event = good.store.addEvent({
    event_type: 'deposit_confirmed', source: 'legacy_deposit', payload: { depositId: 5 }, amount: 120
  });
  good.store.state.deposits[5] = { id: 5, status: 'confirmed' };
  good.store.state.links[USER_ID] = CHAT_ID;
  good.store.addNotification(event);
  await good.worker.tick();
  assert.strictEqual(good.transport.calls.length, 1);

  const bad = makeWorker();
  const event2 = bad.store.addEvent({
    event_type: 'deposit_confirmed', source: 'legacy_deposit', payload: { depositId: 6 }, amount: 120
  });
  bad.store.state.deposits[6] = { id: 6, status: 'pending' };
  bad.store.state.links[USER_ID] = CHAT_ID;
  bad.store.addNotification(event2);
  await bad.worker.tick();
  assert.strictEqual(bad.transport.calls.length, 0);
});

test('eligibility: a pending reminder is dropped once the deposit is confirmed', async () => {
  const { store, transport, worker } = makeWorker({ config: { pendingRemindersEnabled: true } });
  const { notification } = seedReminder(store, { subscribed: true });
  store.state.invoices[2] = Object.assign({}, store.state.invoices[2], { status: 'confirmed', credited: true });
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0);
  assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).skip_reason, 'no_longer_pending');
});

test('eligibility: an expired deposit is never reminded about', async () => {
  const { store, transport, worker } = makeWorker({ config: { pendingRemindersEnabled: true } });
  seedReminder(store, {
    subscribed: true,
    invoice: { expires_at: new Date(Date.now() - 60000).toISOString() }
  });
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0);
  assert.strictEqual(store.state.notifications[0].skip_reason, 'no_longer_pending');
});

test('eligibility: a referral that is no longer active is not announced', async () => {
  for (const referral of [{ status: 'pending', bonus_earned: 20 }, { status: 'active', bonus_earned: 0 }, { status: 'active', bonus_earned: 20, referrer_id: 999 }]) {
    const { store, transport, worker } = makeWorker();
    const { notification } = seedReferral(store, { referral });
    await worker.tick();
    assert.strictEqual(transport.calls.length, 0, JSON.stringify(referral));
    assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).skip_reason, 'not_qualified');
  }
});

test('eligibility: a missing event or payload id fails closed', async () => {
  const noEvent = makeWorker();
  noEvent.store.state.notifications.push({
    id: 99, event_id: 12345, event_type: 'deposit_confirmed', category: 'transactional',
    user_id: USER_ID, status: 'pending', attempts: 0, max_attempts: 5,
    next_attempt_at: new Date().toISOString(), created_at: new Date().toISOString()
  });
  noEvent.store.state.links[USER_ID] = CHAT_ID;
  await noEvent.worker.tick();
  assert.strictEqual(noEvent.transport.calls.length, 0);
  assert.strictEqual(noEvent.store.state.notifications[0].skip_reason, 'event_missing');

  const noPayload = makeWorker();
  const event = noPayload.store.addEvent({ event_type: 'deposit_confirmed', payload: {} });
  noPayload.store.state.links[USER_ID] = CHAT_ID;
  noPayload.store.addNotification(event);
  await noPayload.worker.tick();
  assert.strictEqual(noPayload.transport.calls.length, 0);
  assert.strictEqual(noPayload.store.state.notifications[0].skip_reason, 'unverifiable');
});

// ===========================================================================
// E. Failures, retries, restart and concurrency
// ===========================================================================

test('failure: a 500 is retried with backoff, not marked sent', async () => {
  const { store, transport, worker } = makeWorker({
    transportOptions: { failWith: { httpStatus: 500, errorCode: 500, description: 'Internal Server Error' } }
  });
  const { notification } = seedDeposit(store);
  await worker.tick();
  const row = store.state.notifications.find((n) => n.id === notification.id);
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.last_error, 'send_failed');
  assert.ok(Date.parse(row.next_attempt_at) > store.clock());
  assert.strictEqual(transport.calls.length, 1);
  assert.strictEqual(worker.stats().retried, 1);
});

test('failure: a 403 (blocked bot) is terminal, never retried forever', async () => {
  const { store, transport, worker } = makeWorker({
    transportOptions: { failWith: { httpStatus: 403, errorCode: 403, description: 'Forbidden: bot was blocked by the user' } }
  });
  const { notification } = seedDeposit(store);
  await worker.tick();
  assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).status, 'skipped');
  assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).skip_reason, 'unreachable');
  assert.strictEqual(transport.calls.length, 1);
});

test('failure: a 429 honours Telegram retry_after', async () => {
  const { store, worker } = makeWorker({
    transportOptions: { failWith: { httpStatus: 429, errorCode: 429, retryAfter: 42, description: 'Too Many Requests: retry after 42' } }
  });
  seedDeposit(store);
  await worker.tick();
  const completions = store.state.calls.complete;
  assert.strictEqual(completions[completions.length - 1].retrySeconds, 42);
});

test('failure: retries stop at max_attempts', async () => {
  const { store, worker } = makeWorker({
    transportOptions: { failWith: { httpStatus: 500, errorCode: 500, description: 'boom' } }
  });
  const { notification } = seedDeposit(store, { notification: { max_attempts: 2 } });
  await worker.tick();                       // attempt 1 -> retry
  store.advance(10 * 60 * 1000);
  await worker.tick();                       // attempt 2 -> terminal failure
  const row = store.state.notifications.find((n) => n.id === notification.id);
  assert.strictEqual(row.attempts, 2);
  assert.strictEqual(row.status, 'failed');
  store.advance(10 * 60 * 1000);
  await worker.tick();
  assert.strictEqual(row.attempts, 2, 'no further attempts after max');
});

test('failure: a claim error is reported and does not throw', async () => {
  const { worker, transport } = makeWorker({ storeOptions: { fail: { claim: true } } });
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0);
  assert.strictEqual(worker.stats().claimFailures, 1);
});

test('restart: an expired lease is picked up by the next worker', async () => {
  const store = createFakeStore();
  const { notification } = seedDeposit(store);
  const crashed = makeWorker({ store });
  // Simulate a worker that claimed the row and died mid-send.
  await store.claimNotifications('crashed-worker', 10);
  assert.strictEqual(store.state.notifications[0].status, 'sending');
  store.advance(5 * 60 * 1000);              // lease expires

  const fresh = makeWorker({ store });
  await fresh.worker.tick();
  assert.strictEqual(fresh.transport.calls.length, 1, 'the restarted worker delivers it');
  assert.strictEqual(store.state.notifications.find((n) => n.id === notification.id).status, 'sent');
  assert.ok(!crashed.transport.calls.length);
});

test('concurrency: two workers on the same queue send exactly one message', async () => {
  const shared = createFakeStore();
  seedDeposit(shared);
  const a = makeWorker({ store: shared, workerId: 'a' });
  const b = makeWorker({ store: shared, workerId: 'b' });
  await Promise.all([a.worker.tick(), b.worker.tick()]);
  const total = a.transport.calls.length + b.transport.calls.length;
  assert.strictEqual(total, 1, 'exactly one delivery');
  assert.strictEqual(shared.state.notifications[0].status, 'sent');
});

test('stop(): no further dispatch after stop() is called', async () => {
  const { store, transport, worker } = makeWorker();
  seedDeposit(store);
  seedDeposit(store);
  worker.stop();
  await worker.tick();
  assert.strictEqual(transport.calls.length, 0);
});

test('ops: reminders and purge stay off unless enabled', async () => {
  const off = makeWorker();
  seedDeposit(off.store);
  await off.worker.tick();
  assert.strictEqual(off.store.state.calls.enqueue, 0);
  assert.strictEqual(off.store.state.calls.purge, 0);

  const on = makeWorker({ config: { pendingRemindersEnabled: true, purgeEnabled: true } });
  await on.worker.tick();
  assert.strictEqual(on.store.state.calls.enqueue, 1);
  assert.strictEqual(on.store.state.calls.purge, 1);
});

test('privacy: no chat id, amount or token is written to the logs', async () => {
  const { store, worker, logs } = makeWorker();
  seedDeposit(store, { amount: 987.65 });
  await worker.tick();
  const joined = logs.join('\n');
  assert.ok(joined.includes('notification_sent'));
  assert.ok(!joined.includes(CHAT_ID), 'chat id leaked into the log');
  assert.ok(!joined.includes('987.65'), 'amount leaked into the log');
  assert.ok(!/bot\d+:/i.test(joined), 'token leaked into the log');
});

test('entrypoint: the worker process is inert without CONVERSION_WORKER_ENABLED', () => {
  const output = execFileSync(process.execPath, [path.join(ROOT, 'conversion-worker.js')], {
    env: { PATH: process.env.PATH, CONVERSION_WORKER_ENABLED: '' },
    encoding: 'utf8',
    timeout: 20000
  });
  assert.ok(output.includes('worker_disabled'), 'expected worker_disabled, got: ' + output);
});

test('entrypoint: enabled without credentials fails closed (exit 1)', () => {
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'conversion-worker.js')], {
      env: { PATH: process.env.PATH, CONVERSION_WORKER_ENABLED: 'true' },
      encoding: 'utf8',
      timeout: 20000
    });
  } catch (error) {
    code = error.status;
    out = String(error.stdout || '') + String(error.stderr || '');
  }
  assert.strictEqual(code, 1);
  assert.ok(out.includes('worker_misconfigured'));
});

// ===========================================================================
// F. Migration source contract
// ===========================================================================

test('migration: additive, idempotent and it never touches money tables', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.conversion_events/);
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.conversion_notifications/);
  assert.match(MIGRATION, /DROP CONSTRAINT IF EXISTS conversion_events_dedupe_key_key/);
  assert.match(MIGRATION, /DROP TRIGGER IF EXISTS conversion_capture_registration/);
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.(record_trade_safe|credit_payment_safe|paymento_credit_user_safe|confirm_payment_with_credit|award_referral_qualification_safe)/.test(MIGRATION),
    'existing money/referral functions must not be redefined');
  assert.ok(!/ALTER TABLE public\.(users|wallets|trades|deposits|payment_invoices|referrals|withdrawals)\b(?!.*conversion)/.test(MIGRATION),
    'no business table may be altered');
  const ddlOnly = MIGRATION.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.ok(!/DROP TABLE/i.test(ddlOnly), 'no DROP TABLE in executable SQL');
  assert.match(MIGRATION, /ROLLBACK/, 'a rollback recipe must be documented');
});

test('migration: dedupe keys and idempotency are structural', () => {
  assert.match(MIGRATION, /ADD CONSTRAINT conversion_events_dedupe_key_key UNIQUE \(dedupe_key\)/);
  assert.match(MIGRATION, /ADD CONSTRAINT conversion_notifications_key_key UNIQUE \(idempotency_key\)/);
  assert.match(MIGRATION, /ON CONFLICT \(dedupe_key\) DO NOTHING/);
  assert.match(MIGRATION, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
});

test('migration: deposit events require the authoritative credit marker', () => {
  assert.match(MIGRATION, /COALESCE\(NEW\.credited, FALSE\) = FALSE THEN[\s\S]*?RETURN NEW;/);
  assert.match(MIGRATION, /'deposit:invoice:' \|\| NEW\.id::text/);
  assert.match(MIGRATION, /'deposit:legacy:' \|\| NEW\.id::text/);
  assert.match(MIGRATION, /AFTER INSERT OR UPDATE OF status, credited ON public\.payment_invoices/);
  assert.match(MIGRATION, /AFTER INSERT OR UPDATE OF status ON public\.deposits/);
});

test('migration: referral events are for the referrer, once, and skip synthetic rows', () => {
  assert.match(MIGRATION, /'referral:' \|\| NEW\.id::text/);
  assert.match(MIGRATION, /IF COALESCE\(NEW\.referred_id, 0\) <= 0 THEN/);
  assert.match(MIGRATION, /IF COALESCE\(NEW\.bonus_earned, 0\) <= 0 THEN/);
  assert.match(MIGRATION, /NEW\.referrer_id/);
});

test('migration: registration is recorded but never notified', () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.conversion_capture_registration'),
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.conversion_capture_deposit')
  );
  assert.match(fn, /'registration:' \|\| NEW\.id::text/);
  assert.match(fn, /NULL\s+-- no notification/);
});

test('migration: sandbox users never produce production events', () => {
  assert.match(MIGRATION, /conversion_user_is_sandbox/);
  assert.match(MIGRATION, /MARKETING_SANDBOX/);
  assert.match(MIGRATION, /EXCEPTION WHEN OTHERS THEN\s*\n\s*v_is_sandbox := FALSE;/);
});

test('migration: claim is SKIP LOCKED with a lease and attempts at claim time', () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.conversion_claim_notifications'),
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.conversion_complete_notification')
  );
  assert.match(fn, /FOR UPDATE SKIP LOCKED/);
  assert.match(fn, /lease_expires_at = now\(\) \+ make_interval/);
  assert.match(fn, /attempts = n\.attempts \+ 1/);
  assert.match(fn, /status = 'sending'/);
});

test('migration: completion is status-whitelisted and only from a claimed row', () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.conversion_complete_notification'),
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.conversion_enqueue_pending_reminders')
  );
  assert.match(fn, /p_status NOT IN \('sent', 'skipped', 'failed'\)/);
  assert.match(fn, /IF v_row\.status <> 'sending' THEN/);
  assert.match(fn, /v_row\.attempts >= v_row\.max_attempts/);
  assert.match(fn, /power\(2, GREATEST\(v_row\.attempts - 1, 0\)\)/);
});

test('migration: reminders require consent, a linked chat, a live pending invoice and a cap', () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.conversion_enqueue_pending_reminders'),
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.conversion_purge')
  );
  assert.match(fn, /JOIN public\.telegram_account_links/);
  assert.match(fn, /JOIN public\.telegram_marketing_subscriptions/);
  assert.match(fn, /s\.subscribed = TRUE/);
  assert.match(fn, /lower\(COALESCE\(i\.status, ''\)\) = 'pending'/);
  assert.match(fn, /i\.expires_at IS NULL OR i\.expires_at > now\(\)/);
  assert.match(fn, /IF v_existing >= v_max THEN/);
  assert.match(fn, /'promotional'/);
});

test('migration: RLS is service_role only for both tables', () => {
  assert.match(MIGRATION, /ALTER TABLE public\.conversion_events\s+ENABLE ROW LEVEL SECURITY/);
  assert.match(MIGRATION, /ALTER TABLE public\.conversion_notifications ENABLE ROW LEVEL SECURITY/);
  assert.match(MIGRATION, /CREATE POLICY conversion_events_service_all[\s\S]*?FOR ALL TO service_role/);
  assert.match(MIGRATION, /CREATE POLICY conversion_notifications_service_all[\s\S]*?FOR ALL TO service_role/);
  assert.ok(!/TO anon/.test(MIGRATION));
  assert.ok(!/TO authenticated/.test(MIGRATION));
  assert.match(MIGRATION, /REVOKE ALL ON public\.conversion_events FROM PUBLIC, anon, authenticated/);
  assert.match(MIGRATION, /GRANT ALL ON public\.conversion_notifications TO service_role/);
});

test('migration: trigger failures can never block a credit', () => {
  const handlers = MIGRATION.match(/EXCEPTION WHEN OTHERS THEN/g) || [];
  assert.ok(handlers.length >= 4, 'every capture function must swallow its own errors');
  assert.match(MIGRATION, /RAISE WARNING 'conversion_capture_deposit skipped/);
  assert.match(MIGRATION, /RAISE WARNING 'conversion_capture_referral skipped/);
  assert.match(MIGRATION, /RAISE WARNING 'conversion_capture_registration skipped/);
});

test('migration: self-check block is present', () => {
  assert.match(MIGRATION, /-- 6\. Self-check/);
  assert.match(MIGRATION, /RAISE EXCEPTION 'conversion_events: missing objects: %'/);
});

test('migration: no credential or token is embedded anywhere', () => {
  for (const source of [MIGRATION, WORKER_SRC, STORE_SRC, I18N_SRC, ENTRY_SRC]) {
    assert.ok(!/\d{6,}:[A-Za-z0-9_-]{20,}/.test(source), 'a bot token pattern was found');
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(source), 'a JWT pattern was found');
  }
});

// ===========================================================================
// G. Existing behaviour is preserved
// ===========================================================================

test('regression: subscription commands and account linking are untouched', () => {
  assert.ok(SUPPORT_SRC.includes("case 'subscribe'") || SUPPORT_SRC.includes("'subscribe'"));
  assert.ok(SUPPORT_SRC.includes("case 'unsubscribe'") || SUPPORT_SRC.includes("'unsubscribe'"));
  assert.ok(SUPPORT_SRC.includes("command.name === 'unlink'"));
  assert.ok(SUPPORT_SRC.includes('linkSuccess'));
  assert.ok(SUPPORT_SRC.includes('unlinkRemoved'));
});

test('regression: this feature adds no server route and no new dependency', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/conversion_(events|notifications|claim)/.test(server), 'server.js must stay untouched by this phase');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const dep of ['bullmq', 'ioredis', 'node-cron', 'amqplib', 'kafkajs']) {
    assert.ok(!(pkg.dependencies || {})[dep], 'no new queue dependency: ' + dep);
    assert.ok(!(pkg.devDependencies || {})[dep], 'no new queue dependency: ' + dep);
  }
});

test('regression: the marketing publisher stays inert and separate', () => {
  const store = fs.readFileSync(path.join(ROOT, 'services', 'MarketingStore.js'), 'utf8');
  assert.ok(!/conversion_/.test(store), 'the marketing store must not touch the conversion outbox');
  const marketingWorker = fs.readFileSync(path.join(ROOT, 'marketing-worker.js'), 'utf8');
  assert.ok(!/conversion_/.test(marketingWorker), 'the marketing worker stays independent');
});

test('regression: isPrivateChatId refuses groups and junk', () => {
  assert.strictEqual(isPrivateChatId('777000111'), true);
  assert.strictEqual(isPrivateChatId('-1001234567890'), false);
  assert.strictEqual(isPrivateChatId(''), false);
  assert.strictEqual(isPrivateChatId(null), false);
  assert.strictEqual(isPrivateChatId('12 34'), false);
});

test('regression: send-failure classification uses the transport record only', () => {
  const last = { httpStatus: 403, errorCode: 403, description: 'bot was blocked by the user' };
  assert.deepStrictEqual(classifySendFailure({ getLastCall: () => last }), { retry: false, reason: 'unreachable' });
  const throttled = { httpStatus: 429, errorCode: 429, retryAfter: 12, description: 'Too Many Requests' };
  const result = classifySendFailure({ getLastCall: () => throttled });
  assert.strictEqual(result.retry, true);
  assert.strictEqual(result.retryAfterSeconds, 12);
  assert.deepStrictEqual(classifySendFailure({ getLastCall: () => null }), { retry: true, retryAfterSeconds: null, reason: 'send_failed' });
});
