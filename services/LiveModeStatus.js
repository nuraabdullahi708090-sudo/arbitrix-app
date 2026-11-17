'use strict';
/**
 * Live Mode DISPLAY state (read-only).
 *
 * The dashboard needs to tell a customer, truthfully, three things:
 *   - how much of their Live balance is the promotional credit,
 *   - whether Live Mode is unlocked for them,
 *   - and if not, why (activation, or nothing funded yet).
 *
 * This module only DERIVES that label from facts the server already computed.
 * It never decides access, never writes a row and never credits anything: the
 * real gates are `/api/bot/start` and `/api/trade` (activation) plus
 * `/api/withdraw/request` (the first-deposit rule). Keeping the derivation pure
 * means the label can be unit-tested against every combination without a
 * database, and it cannot drift from the rules by touching them.
 */

const LIVE_MODE_STATUS = Object.freeze({
  /** Live Mode is refused until a Payhip activation entitlement exists. */
  ACTIVATION_REQUIRED: 'activation_required',
  /** Activated, but the Live balance is zero: there is nothing to trade with. */
  FUNDING_REQUIRED: 'funding_required',
  /** Activated and funded: Live Mode is usable now. */
  AVAILABLE: 'available'
});

/**
 * How much of the Live balance is promotional credit?
 *
 * ONLY a definitive promotional classification counts. `promoFunding` is the
 * tri-state from isPromoCreditFunded(): true = promotional-credit funded,
 * false = definitively not (deposit / referral conversion / sandbox),
 * null = unknown. Unknown must never be displayed as promotional credit, so it
 * reports 0 and the caller exposes the uncertainty separately.
 */
function promoCreditFromBalance(liveBalance, promoFunding) {
  if (promoFunding !== true) return 0;
  const balance = Number(liveBalance);
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  return Math.round(balance * 100) / 100;
}

/**
 * Derive the dashboard status. Order matters: an activation gate outranks an
 * empty balance, because "activation required" is the actionable message.
 *
 * Truthfulness note: a promotional-credit account that has NOT yet deposited can
 * still trade (that is the approved $50-credit model, capped at $20 realised
 * profit). It therefore reports `available` once activated - claiming otherwise
 * would describe a restriction the platform does not apply. The separate
 * first-deposit requirement governs WITHDRAWALS and is reported by
 * `withdrawalFundingRequired`, not by the Live Mode label.
 */
function deriveLiveModeStatus(options) {
  const opts = options || {};
  const activated = opts.activated === true;
  const balance = Number(opts.liveBalance);
  const liveBalance = Number.isFinite(balance) && balance > 0 ? balance : 0;
  if (!activated) return LIVE_MODE_STATUS.ACTIVATION_REQUIRED;
  if (liveBalance <= 0) return LIVE_MODE_STATUS.FUNDING_REQUIRED;
  return LIVE_MODE_STATUS.AVAILABLE;
}

/**
 * Assemble the payload `/api/auth/me` and `/api/live/activation` return.
 *
 * @param {object} facts
 * @param {object} facts.activation   result of getLiveActivationState()
 * @param {number} facts.liveBalance  wallets.live_balance (server value)
 * @param {boolean} facts.hasConfirmedDeposit
 * @param {boolean|null} facts.promoFunding  isPromoCreditFunded() tri-state
 */
function buildLiveModeStatus(facts) {
  const f = facts || {};
  const activation = f.activation || {};
  const balance = Number(f.liveBalance);
  const liveBalance = Number.isFinite(balance) && balance > 0 ? Math.round(balance * 100) / 100 : 0;
  const promoFunding = typeof f.promoFunding === 'boolean' ? f.promoFunding : null;
  const promoCredit = promoCreditFromBalance(liveBalance, promoFunding);
  const funded = f.hasConfirmedDeposit === true;
  return {
    status: deriveLiveModeStatus({ activated: activation.activated, liveBalance }),
    activationRequired: activation.activationRequired === true,
    activated: activation.activated === true,
    reason: activation.reason || null,
    exempt: activation.exempt === true,
    retryable: activation.retryable === true,
    liveBalance,
    promoCredit,
    promoCreditFunded: promoFunding === true,
    promoClassificationUnknown: promoFunding === null,
    hasConfirmedDeposit: funded,
    // Promotional credit can be traded but never withdrawn, and it does not
    // count as a deposit: a promo-funded account still needs a qualifying first
    // deposit before a withdrawal is allowed.
    withdrawalFundingRequired: promoCredit > 0 && !funded
  };
}

module.exports = {
  LIVE_MODE_STATUS,
  promoCreditFromBalance,
  deriveLiveModeStatus,
  buildLiveModeStatus
};
