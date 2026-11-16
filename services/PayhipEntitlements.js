'use strict';

/**
 * Payhip ONE-TIME LIVE MODE activation entitlements (Option A).
 *
 * WHAT THIS DOES
 *   A Payhip "live activation" sale is recorded from a verified webhook and
 *   produces exactly ONE entitlement. A customer claims it once with their
 *   licence key; the claim is permanently attached to their account. That
 *   unlocks Live Mode. It credits NO capital - funding stays a separate Q8Pay
 *   deposit - and it bypasses no existing gate (deposit minimum, withdrawal
 *   minimum, completed trade, KYC all still apply).
 *
 * TRUST MODEL (read this before changing anything)
 *   Payhip's webhook payload carries a `signature` field but its documentation
 *   names neither a shared secret nor a signing algorithm, so a body signature
 *   CANNOT be verified the way an HMAC over raw bytes can. This module therefore
 *   does not pretend to verify it. Instead:
 *
 *     1. The webhook URL itself carries a secret token (PAYHIP_WEBHOOK_TOKEN),
 *        compared in constant time. Without it nothing is processed. Treat the
 *        URL as a credential: anyone who knows it can post sales.
 *     2. The sale is accepted only if its product is on the operator's
 *        allow-list (PAYHIP_PRODUCTS). Nothing is credited here, so the blast
 *        radius of a forged post is a bogus entitlement, not money.
 *     3. If the operator supplies PAYHIP_VERIFY_URL (a documented Payhip
 *        endpoint template containing {sale_id}), every sale is re-fetched and
 *        compared before an entitlement is created. Recommended for production.
 *     4. A licence key alone is never enough to activate: the claim must match a
 *        recorded sale that is still `paid`, and only one account can ever claim
 *        it (enforced by a row lock inside the database function).
 *
 * NOTHING here moves money. There is deliberately no wallet, ledger or balance
 * code in this file.
 */

const crypto = require('crypto');

const DEFAULT_PRODUCT_KIND = 'live_activation';

function envStr(name, fallback = '') {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

function envBool(name, fallback = false) {
  const v = envStr(name, '');
  if (!v) return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

/** Parse a comma-separated allow-list into a Set of lowercased keys. */
function parseList(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Resolve configuration. All values are optional; the module is inert unless
 * PAYHIP_ENABLED is true AND a webhook token AND at least one product are set.
 */
function resolvePayhipConfig(env = process.env) {
  const get = (n, d = '') => {
    const v = env[n];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : d;
  };
  const enabledFlag = get('PAYHIP_ENABLED', '').toLowerCase();
  const products = parseList(get('PAYHIP_PRODUCTS', ''));

  const config = {
    enabled: enabledFlag === 'true' || enabledFlag === '1',
    activationRequired: get('PAYHIP_ACTIVATION_REQUIRED', '').toLowerCase() === 'true',
    webhookToken: get('PAYHIP_WEBHOOK_TOKEN', ''),
    verifyUrlTemplate: get('PAYHIP_VERIFY_URL', ''),
    apiKey: get('PAYHIP_API_KEY', ''),
    storeUrl: get('PAYHIP_STORE_URL', ''),
    checkoutReturnUrl: get('PAYHIP_RETURN_URL', ''),
    products
  };

  // Why the feature is not usable, if it is not. Never includes a secret.
  if (!config.enabled) config.reason = 'disabled';
  else if (!config.webhookToken) config.reason = 'missing-webhook-token';
  else if (config.products.size === 0) config.reason = 'no-products-configured';
  else config.reason = null;

  config.usable = config.reason === null;
  return config;
}

/** Secret-free description for logs, the admin status route and tests. */
function describePayhipConfig(config) {
  return {
    enabled: config.enabled,
    usable: config.usable,
    reason: config.reason,
    activationRequired: config.activationRequired,
    productCount: config.products.size,
    webhookTokenConfigured: config.webhookToken.length > 0,
    independentVerification: config.verifyUrlTemplate ? 'configured' : 'not-configured',
    apiKeyConfigured: config.apiKey.length > 0,
    storeUrlConfigured: config.storeUrl.length > 0,
    returnUrlConfigured: config.checkoutReturnUrl.length > 0
  };
}

/** Constant-time comparison so the token cannot be guessed by timing. */
function tokenMatches(expected, provided) {
  if (!expected || typeof provided !== 'string') return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/** SHA-256 hex of a licence key. The raw key is never stored or logged. */
function hashLicenceKey(key) {
  return crypto.createHash('sha256').update(String(key || '').trim()).digest('hex');
}

/**
 * Normalise a Payhip payload into the fields we persist.
 * Amounts arrive in CENTS in Payhip's payload (price, stripe_fee, payhip_fee).
 */
function parseSale(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const first = items[0] || {};
  const licenceKey =
    first.license_key || first.licence_key || payload.license_key || payload.licence_key || null;

  return {
    type: String(payload.type || '').toLowerCase(),
    saleId: payload.id ? String(payload.id) : null,
    email: payload.email ? String(payload.email).toLowerCase() : null,
    currency: payload.currency ? String(payload.currency) : null,
    priceCents: Number.isFinite(Number(payload.price)) ? Number(payload.price) : null,
    stripeFeeCents: Number.isFinite(Number(payload.stripe_fee)) ? Number(payload.stripe_fee) : null,
    payhipFeeCents: Number.isFinite(Number(payload.payhip_fee)) ? Number(payload.payhip_fee) : null,
    amountRefundedCents: Number.isFinite(Number(payload.amount_refunded))
      ? Number(payload.amount_refunded)
      : null,
    productKey: first.product_id ? String(first.product_id) : null,
    productName: first.product_name ? String(first.product_name) : null,
    licenceKey
  };
}

/**
 * Strip the licence key from a raw Payhip payload before it is persisted.
 * The entitlement stores only a SHA-256 hash, so keeping the raw key inside
 * `raw_payload` would defeat that entirely: the audit copy is for reconciliation
 * (ids, amounts, fees), never for licence material.
 */
function redactPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clone = JSON.parse(JSON.stringify(payload));
  const strip = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    delete obj.license_key;
    delete obj.licence_key;
  };
  strip(clone);
  if (Array.isArray(clone.items)) clone.items.forEach(strip);
  return clone;
}

/** Net settlement in cents, when the payload reports the fees. */
function netSettledCents(sale) {
  if (!sale || sale.priceCents == null) return null;
  const fees = (sale.stripeFeeCents || 0) + (sale.payhipFeeCents || 0);
  const net = sale.priceCents - fees;
  return net > 0 ? net : 0;
}

/**
 * Build the entitlement service.
 *
 * @param {object} deps
 * @param {object} deps.admin   Supabase service-role client (bypasses RLS)
 * @param {object} deps.config  result of resolvePayhipConfig()
 * @param {Function} [deps.fetchImpl] injectable fetch (tests never hit the network)
 * @param {Function} [deps.log]       injectable logger
 */
function createPayhipEntitlements({ admin, config, fetchImpl, log } = {}) {
  if (!admin) throw new Error('createPayhipEntitlements requires a service-role client');
  const cfg = config || resolvePayhipConfig();
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const logger = log || ((m) => console.log(m));

  async function recordEvent(eventType, saleId, outcome, detail) {
    try {
      await admin.from('payhip_events').insert({
        event_type: eventType,
        sale_id: saleId || null,
        outcome: outcome || null,
        detail: detail || null
      });
    } catch (e) {
      // Audit must never break processing; the caller logs the outcome anyway.
      logger('[Payhip] event log failed: ' + (e && e.message ? e.message : 'unknown'));
    }
  }

  /** Create the catalogue row if a verified sale names a product we allow. */
  async function ensureProduct(productKey, name) {
    if (!productKey) return;
    try {
      await admin
        .from('payhip_products')
        .upsert(
          { product_key: productKey, name: name || productKey, kind: DEFAULT_PRODUCT_KIND },
          { onConflict: 'product_key', ignoreDuplicates: true }
        );
    } catch (e) {
      logger('[Payhip] product upsert skipped: ' + (e && e.message ? e.message : 'unknown'));
    }
  }

  /**
   * Optional independent verification: re-fetch the sale from Payhip and compare
   * the amount/product. Disabled unless the operator supplies the documented
   * endpoint template, so no endpoint is invented here.
   */
  async function verifyWithProvider(sale) {
    if (!cfg.verifyUrlTemplate) return { ok: true, skipped: true };
    if (!doFetch) return { ok: false, reason: 'no-fetch-available' };
    const url = cfg.verifyUrlTemplate.replace('{sale_id}', encodeURIComponent(sale.saleId));
    try {
      const res = await doFetch(url, {
        headers: cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}
      });
      if (!res || !res.ok) return { ok: false, reason: 'provider-lookup-failed' };
      const body = await res.json();
      const remotePrice = Number(body && (body.price != null ? body.price : body.amount));
      if (Number.isFinite(remotePrice) && sale.priceCents != null && remotePrice !== sale.priceCents) {
        return { ok: false, reason: 'amount-mismatch' };
      }
      const remoteStatus = String((body && (body.status || body.type)) || '').toLowerCase();
      if (remoteStatus && remoteStatus !== 'paid' && remoteStatus !== 'completed') {
        return { ok: false, reason: 'provider-reports-not-paid' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'provider-lookup-error' };
    }
  }

  /**
   * Handle one webhook payload.
   * Returns { handled, outcome, saleId } - never throws for a bad payload.
   */
  async function handleWebhook(payload) {
    if (!cfg.usable) {
      return { handled: false, outcome: cfg.reason || 'not-configured' };
    }
    const sale = parseSale(payload);
    if (!sale || !sale.saleId) {
      return { handled: false, outcome: 'invalid-payload' };
    }

    if (sale.type === 'refunded' || sale.type === 'chargedback') {
      return revokeSale(sale, sale.type);
    }
    if (sale.type !== 'paid') {
      // subscription.* events are not part of this model.
      return { handled: true, outcome: 'ignored:' + (sale.type || 'unknown'), saleId: sale.saleId };
    }

    if (!sale.productKey || !cfg.products.has(sale.productKey.toLowerCase())) {
      await recordEvent('paid', sale.saleId, 'product-not-allowed');
      return { handled: true, outcome: 'product-not-allowed', saleId: sale.saleId };
    }
    if (!sale.licenceKey) {
      await recordEvent('paid', sale.saleId, 'no-licence-key');
      return { handled: true, outcome: 'no-licence-key', saleId: sale.saleId };
    }

    const verification = await verifyWithProvider(sale);
    if (!verification.ok) {
      await recordEvent('paid', sale.saleId, 'verification-failed', { reason: verification.reason });
      return { handled: true, outcome: 'verification-failed', saleId: sale.saleId };
    }

    await ensureProduct(sale.productKey, sale.productName);

    const { data, error } = await admin.rpc('record_payhip_purchase_safe', {
      p_sale_id: sale.saleId,
      p_product_key: sale.productKey,
      p_buyer_email: sale.email,
      p_price_cents: sale.priceCents,
      p_currency: sale.currency,
      p_stripe_fee: sale.stripeFeeCents,
      p_payhip_fee: sale.payhipFeeCents,
      p_licence_hash: hashLicenceKey(sale.licenceKey),
      p_payload: redactPayload(payload)
    });
    if (error) {
      await recordEvent('paid', sale.saleId, 'rpc-error', { message: String(error.message || '').slice(0, 200) });
      return { handled: false, outcome: 'rpc-error', saleId: sale.saleId };
    }
    const out = data || {};
    await recordEvent('paid', sale.saleId, out.success ? (out.duplicate ? 'duplicate' : 'recorded') : out.reason);
    return {
      handled: true,
      outcome: out.success ? (out.duplicate ? 'duplicate' : 'recorded') : out.reason,
      saleId: sale.saleId
    };
  }

  async function revokeSale(sale, status) {
    const { data, error } = await admin.rpc('revoke_payhip_entitlement_safe', {
      p_sale_id: sale.saleId,
      p_status: status,
      p_amount_refunded_cents: sale.amountRefundedCents,
      p_reason: status
    });
    if (error) {
      await recordEvent(status, sale.saleId, 'rpc-error');
      return { handled: false, outcome: 'rpc-error', saleId: sale.saleId };
    }
    const out = data || {};
    await recordEvent(status, sale.saleId, out.success ? 'revoked' : out.reason);
    return { handled: true, outcome: out.success ? 'revoked' : out.reason, saleId: sale.saleId };
  }

  /** Claim an entitlement for an account. Never throws. */
  async function redeem(userId, licenceKey) {
    if (!userId) return { success: false, reason: 'not-authenticated' };
    const key = String(licenceKey || '').trim();
    if (!key) return { success: false, reason: 'invalid-licence' };
    const { data, error } = await admin.rpc('redeem_payhip_entitlement_safe', {
      p_user_id: userId,
      p_licence_hash: hashLicenceKey(key)
    });
    if (error) {
      return { success: false, reason: 'unavailable' };
    }
    const out = data || { success: false, reason: 'unavailable' };
    await recordEvent('redeem', null, out.success ? (out.duplicate ? 'already-claimed' : 'claimed') : out.reason);
    return out;
  }

  /** True when the account holds an active, paid, unrevoked activation. */
  async function hasActivation(userId) {
    if (!userId) return false;
    const { data, error } = await admin.rpc('payhip_has_live_activation', { p_user_id: userId });
    if (error) return null; // UNKNOWN - callers must decide, not assume false
    return data === true;
  }

  /** Purchase + entitlement history for the admin surface. */
  async function listPurchases(limit = 100) {
    const { data, error } = await admin
      .from('payhip_purchases')
      .select('id, payhip_sale_id, product_key, buyer_email, price_cents, currency, stripe_fee_cents, payhip_fee_cents, status, received_at, refunded_at')
      .order('received_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  }

  return {
    config: cfg,
    describe: () => describePayhipConfig(cfg),
    tokenMatches: (provided) => tokenMatches(cfg.webhookToken, provided),
    handleWebhook,
    redeem,
    hasActivation,
    listPurchases,
    recordEvent
  };
}

module.exports = {
  redactPayload,
  resolvePayhipConfig,
  describePayhipConfig,
  createPayhipEntitlements,
  parseSale,
  netSettledCents,
  hashLicenceKey,
  tokenMatches,
  parseList
};
