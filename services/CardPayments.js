/**
 * Card-to-crypto deposit configuration - DISABLED BY DEFAULT.
 *
 * This module contains NO provider integration. It answers one question for the
 * deposit page: may we show "Buy Crypto with Card" as an available option?
 *
 * It may only answer yes when ALL of the following hold:
 *   1. CARD_PAYMENTS_ENABLED === 'true'
 *   2. CARD_PAYMENT_PROVIDER names a provider in APPROVED_CARD_PROVIDERS
 *   3. the requested asset/network is supported (USDT on TRC20 only)
 *
 * APPROVED_CARD_PROVIDERS is empty on purpose: no provider has completed KYB /
 * merchant onboarding for Arbitrix, so no provider may be offered to customers.
 * Adding a provider here is a deliberate, reviewed code change made only AFTER
 * the provider has approved the Arbitrix account and the integration has been
 * implemented and tested. Setting an environment variable alone can never
 * enable card payments.
 *
 * SECURITY: this module never reads, returns or logs an API key, secret or
 * provider base URL. Nothing here is safe to expose beyond {enabled, provider,
 * reason}, and the deposit-page response only ever exposes that shape.
 */

// Intentionally empty. A provider is added only after written approval of the
// Arbitrix merchant account plus a completed, tested integration.
const APPROVED_CARD_PROVIDERS = Object.freeze([]);

const SUPPORTED_CARD_ASSET = 'USDT';
const SUPPORTED_CARD_NETWORK = 'TRC20';

/**
 * @param {object} [env] - defaults to process.env (injectable for tests)
 * @returns {{enabled: boolean, provider: string|null, asset: string, network: string, reason: string}}
 */
function resolveCardPaymentConfig(env) {
  const source = env || process.env || {};
  const enabledFlag = String(source.CARD_PAYMENTS_ENABLED || '').trim().toLowerCase() === 'true';
  const provider = String(source.CARD_PAYMENT_PROVIDER || '').trim().toLowerCase();

  const base = {
    enabled: false,
    provider: null,
    asset: SUPPORTED_CARD_ASSET,
    network: SUPPORTED_CARD_NETWORK,
    reason: 'not-configured'
  };

  if (!enabledFlag) return base;
  if (!provider) return Object.assign({}, base, { reason: 'no-provider' });
  if (!APPROVED_CARD_PROVIDERS.includes(provider)) {
    // Fail closed: an unapproved provider can never be advertised, even if the
    // environment was configured optimistically.
    return Object.assign({}, base, { reason: 'provider-not-approved' });
  }

  return {
    enabled: true,
    provider,
    asset: SUPPORTED_CARD_ASSET,
    network: SUPPORTED_CARD_NETWORK,
    reason: null
  };
}

/**
 * Whether a specific asset/network pair may be offered for card purchase.
 * Arbitrix has approved USDT/TRC20 only; adding another network is a business
 * decision that must be reviewed, not a query parameter.
 *
 * @param {string} asset
 * @param {string} network
 * @returns {boolean}
 */
function isSupportedCardAsset(asset, network) {
  return String(asset || '').toUpperCase() === SUPPORTED_CARD_ASSET &&
    String(network || '').toUpperCase() === SUPPORTED_CARD_NETWORK;
}

module.exports = {
  APPROVED_CARD_PROVIDERS,
  SUPPORTED_CARD_ASSET,
  SUPPORTED_CARD_NETWORK,
  resolveCardPaymentConfig,
  isSupportedCardAsset
};
