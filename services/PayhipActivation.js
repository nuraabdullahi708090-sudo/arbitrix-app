'use strict';
/**
 * Live Mode activation check for the SERVER-SIDE TRADING WORKER.
 *
 * WHY THIS EXISTS
 *   The browser path is covered: /api/bot/start and /api/trade both resolve
 *   getLiveModeEligibility() before any money moves. The trading worker does not
 *   go through either route - it calls record_trade_safe directly - so before
 *   this module it executed trades for ANY account with a running session, with
 *   no entitlement lookup at all. With PAYHIP_ACTIVATION_REQUIRED=true that is a
 *   bypass: a session created before the lock existed (or one whose licence was
 *   refunded mid-flight) kept trading.
 *
 * ONE SOURCE OF TRUTH
 *   The check is the SAME database function the web resolver uses
 *   (payhip_has_live_activation, migration 050): claimed AND not revoked AND the
 *   purchase still 'paid'. Nothing is re-implemented here, so the worker cannot
 *   drift from the gate the customer sees.
 *
 * TRI-STATE, DELIBERATELY
 *   true   an entitlement is held  -> trade
 *   false  definitively not held   -> do not trade, and stop the session
 *   null   the store could not be read -> do not trade, KEEP the session and try
 *          again on the next tick. Refusing to trade without proof is the safe
 *          direction; killing a legitimate customer's bot on a transient read
 *          error would not be.
 *
 * The caller decides what to do with each answer; this module never writes.
 */

/**
 * @param {object} opts
 * @param {object} opts.admin   service-role Supabase client (rpc)
 * @param {boolean} opts.required  mirror of PAYHIP_ACTIVATION_REQUIRED
 */
function createActivationCheck({ admin, required = false } = {}) {
  if (!admin) throw new Error('createActivationCheck requires a service-role Supabase client');

  return {
    // When false the worker must behave EXACTLY as it did before this module
    // existed; TradingWorker short-circuits before calling check().
    required: required === true,

    async check(userId) {
      if (!userId) return false;
      try {
        const { data, error } = await admin.rpc('payhip_has_live_activation', { p_user_id: userId });
        if (error) return null;          // unknown, never "no"
        return data === true;            // anything unexpected is not proof
      } catch (e) {
        return null;                     // thrown network/provider error
      }
    },
  };
}

/** Environment parsing, kept identical to the web service's rule. */
function resolveActivationRequired(env = process.env) {
  return String((env && env.PAYHIP_ACTIVATION_REQUIRED) || '').trim().toLowerCase() === 'true';
}

module.exports = { createActivationCheck, resolveActivationRequired };
