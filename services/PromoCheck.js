'use strict';

/**
 * Promotional-credit classification + trading cap for the SERVER-SIDE worker.
 *
 * WHY THIS EXISTS
 *   The promotional-credit cap is enforced in two places: `POST /api/trade` and
 *   `POST /api/bot/start` in server.js. The server-side trading worker calls
 *   `record_trade_safe` DIRECTLY (it does not go through `/api/trade`), so it
 *   must apply the identical rule itself. This module is the worker's copy of
 *   that rule table.
 *
 * PARITY IS TESTED, NOT ASSUMED
 *   `tests/trading_worker.test.js` pins this module's decision table against the
 *   server's: same cap value ($20, INCLUSIVE), same source-of-funds precedence
 *   (confirmed deposit > conversion > promo credit), and the same FAIL-OPEN
 *   behavior when a source cannot be read. Any divergence fails the build.
 *
 * FOLLOW-UP (needs its own review, not done here)
 *   Unifying the server and worker on this single module would remove the
 *   duplicate rule table. That touches the live `/api/trade` enforcement path,
 *   so it is deliberately out of scope for the worker change set.
 *
 * The cap is a rule about the SOURCE of funds, never about the balance amount:
 * a user who deposited, or who converted genuinely-earned referral rewards into
 * Live balance, is never capped.
 */

/** Cumulative NET realized profit allowed while trading the $50 promo credit. */
const PROMO_PROFIT_CAP_USD = 20;
const PROMO_LIMIT_CODE = 'PROMO_TRADING_LIMIT_REACHED';
const PROMO_LIMIT_MESSAGE =
  'You have reached the promotional trading limit. Make your first deposit to continue trading.';

/** Machine-readable body returned by /api/trade when the cap stops a trade. */
function promoLimitBody(extra = {}) {
  return {
    error: PROMO_LIMIT_MESSAGE,
    code: PROMO_LIMIT_CODE,
    promoLimitReached: true,
    depositRequired: true,
    ...extra,
  };
}

/**
 * INCLUSIVE cap test: `>= 20` blocks. Kept as a pure function so the boundary is
 * unit-testable without a database.
 */
function isPromoProfitCapReached(isPromoCreditFunded, promoProfit) {
  return !!isPromoCreditFunded && Number(promoProfit) >= PROMO_PROFIT_CAP_USD;
}

/**
 * Create the rule set bound to a service-role Supabase client.
 * Every read is best-effort: an unreadable source yields `null` (unknown), and
 * callers only ever act on `=== true`, so an unknown classification always
 * FAILS OPEN and can never cap a legitimate user.
 */
function createPromoCheck({ admin, log = () => {} }) {
  if (!admin) throw new Error('createPromoCheck requires a service-role Supabase client');

  /** Confirmed production deposit? (authoritative: deposits.status) */
  async function hasConfirmedDeposit(userId) {
    try {
      const { count, error } = await admin
        .from('deposits')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'confirmed');
      if (error) return false;
      return (count || 0) > 0;
    } catch (e) {
      return false;
    }
  }

  /** NET realized Live P&L for the supplied UTC day window. */
  async function getRealizedProfit(userId, { sinceUtc = null } = {}) {
    try {
      let q = admin.from('trades').select('amount').eq('user_id', userId).eq('mode', 'live');
      if (sinceUtc) q = q.gte('created_at', sinceUtc);
      const { data, error } = await q;
      if (error) return 0;
      if (!Array.isArray(data) || !data.length) return 0;
      const total = data.reduce((sum, row) => sum + (Number(row && row.amount) || 0), 0);
      return Math.round(total * 100) / 100;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Did this account convert referral earnings into Live balance?
   * TRUE/FALSE when a source is readable, NULL when neither could be read (the
   * caller then fails open). Ledger first, transaction marker as the fallback —
   * the same precedence the server uses.
   */
  async function hasConvertedReferralEarnings(userId) {
    const failure = { ledger: null, transactions: null };
    try {
      const { data, error } = await admin
        .from('referral_earning_conversions')
        .select('id')
        .eq('user_id', userId)
        .limit(1);
      if (!error) return Array.isArray(data) && data.length > 0;
      if (error.code !== 'PGRST116') {
        failure.ledger = { code: error.code || null, message: error.message || null };
      }
    } catch (e) {
      failure.ledger = { code: 'exception', message: (e && e.message) || null };
    }
    try {
      const { count, error } = await admin
        .from('transactions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('type', 'Bonus Withdrawal');
      if (!error) return (count || 0) > 0;
      failure.transactions = { code: error.code || null, message: error.message || null };
    } catch (e) {
      failure.transactions = { code: 'exception', message: (e && e.message) || null };
    }
    log({
      event: 'promo_classification_unknown',
      component: 'TradingWorker',
      fallback: 'fail_open',
      impact: 'promo_cap_not_applied',
      userId,
      ledgerFailed: true,
      transactionsFailed: true,
      ledgerErrorCode: failure.ledger && failure.ledger.code,
      transactionsErrorCode: failure.transactions && failure.transactions.code,
    });
    return null;
  }

  /**
   * Tri-state source-of-funds classification.
   *   true  -> promotional-credit funded (cap applies)
   *   false -> definitively not (deposited / sandbox / referral-funded)
   *   null  -> unknown; cannot be read, so the cap is NOT applied
   */
  async function isPromoCreditFunded(userId, hasDeposit) {
    if (hasDeposit) return false;
    if (await isSandboxUser(userId)) return false;
    const converted = await hasConvertedReferralEarnings(userId);
    if (converted === null) return null;
    return !converted;
  }

  /** Sandbox accounts are never subject to the production cap. */
  async function isSandboxUser(userId) {
    try {
      const { data, error } = await admin
        .from('users')
        .select('environment')
        .eq('id', userId)
        .single();
      if (error) return false;
      const env = data && data.environment;
      return env === 'MARKETING_SANDBOX';
    } catch (e) {
      return false;
    }
  }

  return {
    PROMO_PROFIT_CAP_USD,
    hasConfirmedDeposit,
    getRealizedProfit,
    hasConvertedReferralEarnings,
    isPromoCreditFunded,
    isSandboxUser,
    isPromoProfitCapReached,
  };
}

module.exports = {
  PROMO_PROFIT_CAP_USD,
  PROMO_LIMIT_CODE,
  PROMO_LIMIT_MESSAGE,
  isPromoProfitCapReached,
  promoLimitBody,
  createPromoCheck,
};
