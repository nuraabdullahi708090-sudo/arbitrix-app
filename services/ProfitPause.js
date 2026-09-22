'use strict';

/**
 * TEMPORARY MANAGEMENT TEST - "BOT PROFIT PAUSE".
 *
 * Business rule (all PRODUCTION users, both promotional-credit and funded):
 *   once an account's cumulative NET realized Live profit reaches the threshold
 *   (default $400), the bot is paused and further trading is refused until the
 *   account receives a NEW confirmed deposit made AFTER the pause triggered.
 *
 * This is an EXPERIMENT that management expects to change, so the whole rule is
 * isolated in this ONE module plus a single env var:
 *   BOT_PROFIT_PAUSE_USD   default 400;  <=0 or invalid => rule DISABLED
 * Nothing else in the codebase hard-codes the threshold, and turning the rule
 * off (BOT_PROFIT_PAUSE_USD=0) restores normal behaviour with no other change.
 *
 * DELIBERATELY NOT USER-VISIBLE COPY: the threshold, the condition and this rule
 * are NOT written anywhere in the landing page, the app, or the Telegram bot
 * knowledge base. The ONLY user-facing surface is the popup the app shows when
 * the server reports the pause (see public/index.html).
 *
 * RELATIONSHIP TO THE EXISTING $20 PROMO CAP: unchanged and independent. The
 * promo cap targets the same population only when it is funded by promotional
 * credit; this rule applies to every production user and is evaluated AFTER it.
 *
 * SAFETY: every read is best-effort and the module FAILS OPEN - an unreadable
 * source (e.g. migration 033 not applied, a transient DB error) yields "not
 * paused", so this experiment can never strand a trader.
 */

/** Cumulative realized Live profit at which the bot pauses. */
const DEFAULT_PROFIT_PAUSE_USD = 400;
/** Env var that overrides the threshold (0 disables the rule entirely). */
const PROFIT_PAUSE_ENV = 'BOT_PROFIT_PAUSE_USD';
/** Machine-readable code so the client can react without parsing a sentence. */
const PROFIT_PAUSE_CODE = 'PROFIT_PAUSE_DEPOSIT_REQUIRED';
const PROFIT_PAUSE_MESSAGE = 'Add funds to keep the bot trading.';

/**
 * Resolve the threshold. Missing/blank => default (400). A finite value > 0 is
 * used as-is. Anything else (0, negative, NaN, junk) => 0, i.e. rule disabled.
 * Pure + injectable so the behaviour is unit-testable without touching env.
 */
function resolveProfitPauseUsd(env = process.env) {
  const raw = env ? env[PROFIT_PAUSE_ENV] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PROFIT_PAUSE_USD;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Create the rule bound to a service-role Supabase client.
 * `threshold` of 0/NaN disables the rule (every method is then a no-op).
 */
function createProfitPauseCheck({ admin, threshold, log = () => {} }) {
  if (!admin) throw new Error('createProfitPauseCheck requires a service-role Supabase client');
  const limit = Number(threshold);
  const enabled = Number.isFinite(limit) && limit > 0;

  /** MARKETING_SANDBOX is never subject to this production rule. */
  async function isSandboxUser(userId) {
    try {
      const { data, error } = await admin.from('users').select('environment').eq('id', userId).single();
      if (error) return false;
      return !!(data && data.environment === 'MARKETING_SANDBOX');
    } catch (e) {
      return false;
    }
  }

  /** Cumulative NET realized Live profit = SUM(trades.amount WHERE mode='live'). */
  async function getCumulativeProfit(userId) {
    try {
      const { data, error } = await admin.from('trades').select('amount').eq('user_id', userId).eq('mode', 'live');
      if (error) return 0;
      if (!Array.isArray(data) || !data.length) return 0;
      const total = data.reduce((sum, row) => sum + (Number(row && row.amount) || 0), 0);
      return Math.round(total * 100) / 100;
    } catch (e) {
      return 0;
    }
  }

  /** The pause row for this account, or null when it does not exist / is unreadable. */
  async function getState(userId) {
    try {
      const { data, error } = await admin
        .from('bot_profit_pauses')
        .select('triggered_at, cleared_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) return null; // fails open (table missing / read error)
      return data || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Was a confirmed deposit CREATED after the given instant?
   * true/false when a source is readable, null when neither could be read (the
   * caller then fails open). Mirrors the server's confirmed-deposit check: the
   * legacy `deposits` table OR the provider `payment_invoices` table.
   */
  async function hasDepositAfter(userId, iso) {
    if (!iso) return null;
    let legacy = null;
    let provider = null;
    try {
      const r = await admin
        .from('deposits')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'confirmed')
        .gt('created_at', iso)
        .limit(1);
      if (!r.error) legacy = Array.isArray(r.data) && r.data.length > 0;
    } catch (e) { /* unknown */ }
    try {
      const r = await admin
        .from('payment_invoices')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'confirmed')
        .gt('created_at', iso)
        .limit(1);
      if (!r.error) provider = Array.isArray(r.data) && r.data.length > 0;
    } catch (e) { /* unknown */ }
    if (legacy === null && provider === null) return null;
    return legacy === true || provider === true;
  }

  /** Record the pause the first time the threshold is reached. Fail-open. */
  async function trigger(userId, profit) {
    const nowIso = new Date().toISOString();
    try {
      const { error } = await admin
        .from('bot_profit_pauses')
        .upsert({ user_id: userId, triggered_at: nowIso, cleared_at: null, updated_at: nowIso }, { onConflict: 'user_id' });
      if (error) return null;
      log({ event: 'profit_pause_triggered', component: 'ProfitPause', userId, profit, threshold: limit });
      return { triggered_at: nowIso, cleared_at: null };
    } catch (e) {
      return null;
    }
  }

  /** Mark the pause cleared (a qualifying deposit arrived). Fail-open. */
  async function clear(userId) {
    try {
      await admin
        .from('bot_profit_pauses')
        .update({ cleared_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('user_id', userId);
    } catch (e) { /* best effort */ }
  }

  /**
   * Create the pause row when the threshold has been reached and no row exists
   * yet. Safe to call on every evaluation. Returns the state (or null).
   */
  async function ensureTriggered(userId) {
    if (!enabled) return null;
    const existing = await getState(userId);
    if (existing) return existing;
    const profit = await getCumulativeProfit(userId);
    if (!(profit >= limit)) return null;
    return trigger(userId, profit);
  }

  /**
   * Is the bot currently paused for this account?
   * True only once the threshold has been reached AND no qualifying deposit was
   * made after the trigger. Fails OPEN (false) on any unreadable input.
   */
  async function isPaused(userId) {
    if (!enabled) return false;
    if (await isSandboxUser(userId)) return false;
    await ensureTriggered(userId);
    const state = await getState(userId);
    if (!state || !state.triggered_at) return false;
    if (state.cleared_at) return false;
    const cleared = await hasDepositAfter(userId, state.triggered_at);
    if (cleared === null) return false; // unknown -> fail open
    if (cleared) {
      await clear(userId);
      log({ event: 'profit_pause_cleared', component: 'ProfitPause', userId });
      return false;
    }
    return true;
  }

  return {
    enabled,
    threshold: enabled ? limit : 0,
    isSandboxUser,
    getCumulativeProfit,
    getState,
    hasDepositAfter,
    ensureTriggered,
    isPaused,
  };
}

module.exports = {
  DEFAULT_PROFIT_PAUSE_USD,
  PROFIT_PAUSE_ENV,
  PROFIT_PAUSE_CODE,
  PROFIT_PAUSE_MESSAGE,
  resolveProfitPauseUsd,
  createProfitPauseCheck,
};
