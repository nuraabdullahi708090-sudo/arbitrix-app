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
 *   Payhip documents two independent things, and they are NOT equivalent:
 *
 *   1. WEBHOOK AUTHENTICITY. The `signature` field is compared against
 *      `hash('sha256', $apiKey)` (Payhip's Webhooks article). Note what this
 *      actually proves: the value is a CONSTANT digest of the store's API key,
 *      identical for every payload. It authenticates the SENDER but it does not
 *      bind the body, so it cannot detect a modified amount or product. Treat the
 *      webhook as a TRIGGER, never as proof of payment.
 *
 *   2. LICENCE STATE. `GET https://payhip.com/api/v2/license/verify` with the
 *      product-specific `product-secret-key` header returns the licence's own
 *      authoritative record: enabled, product_link, buyer_email, uses, date.
 *      Payhip disables a licence automatically when its transaction is refunded.
 *      This is the evidence we act on, and it is read server-side only.
 *
 *   Therefore:
 *    - the webhook is accepted only with a valid signature (and, optionally, the
 *      URL token as a second layer);
 *    - REDEMPTION verifies the licence against Payhip before granting anything,
 *      so a forged webhook cannot mint access;
 *    - a licence that is disabled or refunded is refused;
 *    - the claim is one account / one time, enforced by a row lock in the
 *      database function;
 *    - nothing here moves money: there is no wallet, ledger or balance code.
 *
 * NOTHING here moves money. There is deliberately no wallet, ledger or balance
 * code in this file.
 */

const crypto = require('crypto');

const DEFAULT_PRODUCT_KIND = 'live_activation';

/**
 * Minimum length of PAYHIP_WEBHOOK_TOKEN.
 *
 * The token is the URL secret that gates the public webhook endpoint, so a
 * guessable value is a real admission risk. Payhip documents it as an optional
 * second factor ON TOP of the sha256(apiKey) signature; this platform requires
 * both (see resolvePayhipConfig) because a webhook we cannot authenticate must
 * not be able to record a purchase we would later honour.
 */
const WEBHOOK_TOKEN_MIN_LENGTH = 16;

/** A token is usable when it is long enough and contains no whitespace. */
function isValidWebhookToken(token) {
  const t = String(token || '');
  return t.length >= WEBHOOK_TOKEN_MIN_LENGTH && !/\s/.test(t);
}

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
    // Kept separate from `webhookToken.length > 0` so the reason can distinguish
    // "not configured" from "configured but too weak".
    webhookTokenValid: isValidWebhookToken(get('PAYHIP_WEBHOOK_TOKEN', '')),
    verifyUrlTemplate: get('PAYHIP_VERIFY_URL', ''),
    // The store API key whose SHA-256 is the documented webhook signature.
    apiKey: get('PAYHIP_API_KEY', ''),
    storeUrl: get('PAYHIP_STORE_URL', ''),
    checkoutReturnUrl: get('PAYHIP_RETURN_URL', ''),
    // Licence API (v2). Overridable only so tests never touch the network.
    licenseApiBase: get('PAYHIP_LICENSE_API_BASE', 'https://payhip.com/api/v2'),
    licenseTimeoutMs: Math.min(Math.max(Number(get('PAYHIP_LICENSE_TIMEOUT_MS', '8000')) || 8000, 1000), 20000),
    products,
    // Product-specific secrets for the licence API. The secret is per product, so
    // several may be configured; verification tries each (bounded by the list).
    productSecrets: resolveProductSecrets(env, products)
  };

  // Why the WEBHOOK is not usable. Never includes a secret.
  //
  // A webhook is only usable when ALL of the following hold, because each one is
  // required to authenticate a delivery:
  //   1. the feature is enabled;
  //   2. at least one product is allow-listed;
  //   3. PAYHIP_API_KEY exists - its sha256 is the documented signature;
  //   4. PAYHIP_WEBHOOK_TOKEN exists, is >= 16 chars and has no whitespace.
  //
  // Requiring the token (previously optional) closes a contradiction that could
  // take money without granting access: the status surface said "usable" while
  // the route rejected every delivery with 401.
  if (!config.enabled) config.reason = 'disabled';
  else if (config.products.size === 0) config.reason = 'no-products-configured';
  else if (!config.apiKey) config.reason = 'missing-api-key';
  else if (!config.webhookToken) config.reason = 'missing-webhook-token';
  else if (!config.webhookTokenValid) config.reason = 'weak-webhook-token';
  else config.reason = null;

  config.usable = config.reason === null;
  // Explicit alias: the ROUTE gates on this, the dashboard gates on `usable`.
  // One definition, two names for readability at the call sites.
  config.webhookUsable = config.usable;

  // Redemption additionally needs a product secret, because it must verify the
  // licence against Payhip before granting anything.
  config.redeemUsable = config.enabled && config.products.size > 0 && config.productSecrets.size > 0;
  return config;
}

/**
 * Parse the product-secret configuration.
 *
 * Accepted forms:
 *   PAYHIP_PRODUCT_SECRET=abc                 (single product)
 *   PAYHIP_PRODUCT_SECRETS="mVT0=abc,RGsF=def" (one per allow-listed link)
 *   PAYHIP_PRODUCT_SECRETS="abc,def"          (order-less list, tried in turn)
 *
 * The secret is NEVER logged, returned by describe() or exposed to the client.
 */
function resolveProductSecrets(env = process.env, products = new Set()) {
  const out = new Map();
  const single = env.PAYHIP_PRODUCT_SECRET;
  if (typeof single === 'string' && single.trim() !== '') {
    out.set('*', single.trim());
  }
  const many = env.PAYHIP_PRODUCT_SECRETS;
  if (typeof many === 'string' && many.trim() !== '') {
    for (const entry of many.split(',')) {
      const part = entry.trim();
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq > 0) {
        const link = part.slice(0, eq).trim().toLowerCase();
        const secret = part.slice(eq + 1).trim();
        if (secret) out.set(link || '*', secret);
      } else {
        out.set('*' + out.size, part);
      }
    }
  }
  // A configured product-specific secret takes precedence; keep insertion order.
  void products;
  return out;
}

/**
 * The documented webhook signature: sha256(apiKey) as lowercase hex.
 * Returns null when no API key is configured, which callers treat as
 * "cannot authenticate" rather than "authenticated".
 */
function expectedWebhookSignature(apiKey) {
  if (!apiKey) return null;
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex');
}

/**
 * Verify a webhook signature. Fails CLOSED: an unconfigured key, a missing
 * signature or a mismatch all return false. The comparison is constant time.
 */
function verifyWebhookSignature(apiKey, provided) {
  const expected = expectedWebhookSignature(apiKey);
  if (!expected || typeof provided !== 'string' || !provided) return false;
  return tokenMatches(expected, provided.trim().toLowerCase());
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
    webhookTokenValid: config.webhookTokenValid === true,
    webhookUsable: config.webhookUsable === true,
    // The documented sha256(apiKey) signature. "not-configured" means the
    // webhook is refused outright, never that it is accepted unverified.
    signatureVerification: config.apiKey ? 'configured' : 'not-configured',
    apiKeyConfigured: config.apiKey.length > 0,
    productSecretCount: config.productSecrets ? config.productSecrets.size : 0,
    redeemUsable: !!config.redeemUsable,
    licenseApi: config.licenseApiBase || null,
    independentVerification: config.verifyUrlTemplate ? 'configured' : 'not-configured',
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

/** Extract the permalink code ("RGsF") from a Payhip item. */
function productLinkOf(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.product_key) return String(item.product_key);
  const permalink = item.product_permalink ? String(item.product_permalink) : '';
  const tail = permalink.split('/').filter(Boolean).pop();
  return tail ? tail : null;
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
    // Two identifiers, deliberately: `productKey` is Payhip's numeric product id
    // and `productLink` is the permalink code (e.g. "RGsF"). The licence API
    // reports product_link, so the allow-list must understand both.
    productKey: first.product_id ? String(first.product_id) : null,
    productLink: productLinkOf(first),
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

  // ---------------------------------------------------------------- licence API
  // Per-account throttle on verification attempts. A licence key is a bearer
  // secret; without this an authenticated account could enumerate keys through
  // our server and use the latency/outcome as an oracle.
  const attemptWindowMs = 60 * 1000;
  const maxAttemptsPerWindow = 10;
  const attempts = new Map();
  function throttle(userId) {
    const now = Date.now();
    const key = String(userId);
    const entry = attempts.get(key);
    if (!entry || now - entry.start > attemptWindowMs) {
      attempts.set(key, { start: now, count: 1 });
      if (attempts.size > 5000) attempts.clear();
      return { allowed: true };
    }
    entry.count += 1;
    if (entry.count > maxAttemptsPerWindow) {
      return { allowed: false, retryAfterMs: Math.max(1000, attemptWindowMs - (now - entry.start)) };
    }
    return { allowed: true };
  }

  /**
   * One authenticated call to Payhip's licence API.
   * Returns {kind:'ok', data} | {kind:'empty'} | {kind:'unavailable', reason}.
   * 'empty' is Payhip's documented "verification failed" response, which means
   * the key is not a real licence - it is NOT the same as an outage.
   */
  async function callLicenceApi(path, secret) {
    if (!doFetch) return { kind: 'unavailable', reason: 'no-fetch-available' };
    const base = String(cfg.licenseApiBase || '').replace(/\/+$/, '');
    if (!base) return { kind: 'unavailable', reason: 'no-api-base' };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), cfg.licenseTimeoutMs) : null;
    try {
      const res = await doFetch(base + path, {
        method: 'GET',
        headers: { 'product-secret-key': secret, Accept: 'application/json' },
        signal: controller ? controller.signal : undefined
      });
      if (!res) return { kind: 'unavailable', reason: 'no-response' };
      if (res.status === 404) return { kind: 'empty' };
      if (!res.ok) return { kind: 'unavailable', reason: 'http-' + res.status };
      const body = await res.json().catch(() => null);
      const data = body && typeof body === 'object' ? body.data : null;
      if (!data || typeof data !== 'object') return { kind: 'empty' };
      return { kind: 'ok', data };
    } catch (e) {
      // Abort (timeout) and network failures are indistinguishable here, and both
      // must be treated as "we do not know" rather than "invalid".
      return { kind: 'unavailable', reason: 'network' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** True when a licence's product_record matches the operator allow-list. */
  function productAllowed(link) {
    if (!link) return false;
    return cfg.products.has(String(link).toLowerCase());
  }

  /**
   * Verify a licence key server-side against Payhip.
   *
   * @returns {{status:'valid'|'invalid'|'unavailable', enabled?:boolean,
   *            productLink?:string|null, buyerEmail?:string|null, uses?:number,
   *            reason?:string}}
   *
   * 'unavailable' means we could not obtain an answer. Callers MUST NOT treat it
   * as valid: for a new account that is a refusal, not a grant.
   */
  async function verifyLicence(licenceKey) {
    const key = String(licenceKey || '').trim();
    if (!key) return { status: 'invalid', reason: 'empty' };
    if (!cfg.productSecrets || cfg.productSecrets.size === 0) {
      return { status: 'unavailable', reason: 'no-product-secret-configured' };
    }
    let sawUnavailable = null;
    for (const secret of cfg.productSecrets.values()) {
      const r = await callLicenceApi('/license/verify?license_key=' + encodeURIComponent(key), secret);
      if (r.kind === 'unavailable') { sawUnavailable = r.reason || 'unavailable'; continue; }
      if (r.kind === 'empty') continue;
      return {
        status: 'valid',
        enabled: r.data.enabled === true,
        productLink: r.data.product_link ? String(r.data.product_link) : null,
        buyerEmail: r.data.buyer_email ? String(r.data.buyer_email).toLowerCase() : null,
        uses: Number.isFinite(Number(r.data.uses)) ? Number(r.data.uses) : null,
        issuedAt: r.data.date || null
      };
    }
    if (sawUnavailable) return { status: 'unavailable', reason: sawUnavailable };
    return { status: 'invalid', reason: 'not-found' };
  }

  /**
   * Best-effort usage increment so the seller can see a key was redeemed.
   * The DATABASE remains authoritative for one-time redemption; a failure here
   * never fails the redemption and never grants anything.
   */
  async function recordLicenceUsage(licenceKey) {
    if (!cfg.productSecrets || cfg.productSecrets.size === 0) return false;
    for (const secret of cfg.productSecrets.values()) {
      const r = await callLicenceApi('/license/usage?license_key=' + encodeURIComponent(licenceKey), secret);
      if (r.kind === 'ok') return true;
      if (r.kind === 'empty') continue;
    }
    return false;
  }

  /**
   * Create the catalogue row if a verified sale names a product we allow.
   *
   * The PERMALINK code is preferred over the numeric id: the allow-list, and the
   * licence API's `product_link`, both use the permalink, so storing the numeric
   * id here would leave the catalogue unable to match the product the operator
   * actually configured (and `productsOnSale` would then hide the buy button).
   */
  async function ensureProduct(productKey, name) {
    if (!productKey) return;
    const key = String(productKey).toLowerCase();
    try {
      await admin
        .from('payhip_products')
        .upsert(
          { product_key: key, name: name || key, kind: DEFAULT_PRODUCT_KIND },
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
    // Payhip's documented signature: sha256(store API key). It authenticates the
    // sender only (the digest is the same for every payload), so it is checked
    // here and the LICENCE is verified separately at redemption.
    if (!verifyWebhookSignature(cfg.apiKey, payload && payload.signature)) {
      const probe = payload && typeof payload === 'object' ? parseSale(payload) : null;
      await recordEvent(probe ? probe.type : null, probe ? probe.saleId : null, 'signature-invalid');
      return {
        handled: false,
        outcome: 'signature-invalid',
        saleId: probe ? probe.saleId : null
      };
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

    const saleAllowed =
      (sale.productKey && cfg.products.has(sale.productKey.toLowerCase())) ||
      (sale.productLink && cfg.products.has(sale.productLink.toLowerCase()));
    if (!saleAllowed) {
      // The identifiers are recorded (never a secret): an operator bringing a new
      // product up can read which key Payhip actually sent and complete the
      // allow-list without guessing between the permalink and the numeric id.
      await recordEvent('paid', sale.saleId, 'product-not-allowed', {
        productKey: sale.productKey,
        productLink: sale.productLink
      });
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

    // The permalink code is what the allow-list and the licence API use, so it is
    // the better catalogue key when Payhip sends both identifiers. The SAME key is
    // passed to the RPC: record_payhip_purchase_safe rejects a product_key that is
    // not in the catalogue, so the two must not diverge.
    const catalogueKey = sale.productLink || sale.productKey;
    await ensureProduct(catalogueKey, sale.productName);

    const { data, error } = await admin.rpc('record_payhip_purchase_safe', {
      p_sale_id: sale.saleId,
      p_product_key: catalogueKey ? String(catalogueKey).toLowerCase() : null,
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

  /**
   * Claim an entitlement for an account. Never throws.
   *
   * The licence is verified SERVER-SIDE against Payhip before the claim, so a
   * forged or replayed webhook can never grant access, and a refunded/disabled
   * licence is refused. 'unavailable' is reported as retryable and never grants.
   */
  async function redeem(userId, licenceKey) {
    if (!userId) return { success: false, reason: 'not-authenticated' };
    const key = String(licenceKey || '').trim();
    if (!key) return { success: false, reason: 'invalid-licence' };

    const gate = throttle(userId);
    if (!gate.allowed) {
      return { success: false, reason: 'too-many-attempts', retryAfterMs: gate.retryAfterMs };
    }
    if (!cfg.redeemUsable) {
      // No product secret configured => we cannot verify => we cannot grant.
      return { success: false, reason: 'unavailable', retryable: true, detail: 'not-configured' };
    }

    const verification = await verifyLicence(key);
    if (verification.status === 'unavailable') {
      await recordEvent('redeem', null, 'licence-api-unavailable', { reason: verification.reason });
      return {
        success: false,
        reason: 'unavailable',
        retryable: true,
        detail: verification.reason || 'licence-api-unavailable'
      };
    }
    if (verification.status === 'invalid') {
      await recordEvent('redeem', null, 'invalid-licence');
      return { success: false, reason: 'invalid-licence' };
    }
    if (verification.enabled !== true) {
      // Payhip disables a licence automatically when its sale is refunded.
      await recordEvent('redeem', null, 'licence-disabled');
      return { success: false, reason: 'licence-disabled' };
    }
    if (!productAllowed(verification.productLink)) {
      // M4: the provider told US this licence is real but belongs to another
      // product. Telling the caller that would confirm the key exists and leak
      // which catalogue it belongs to, so the public answer is identical to an
      // invalid key. The distinction is kept where it belongs - the audit event.
      await recordEvent('redeem', null, 'wrong-product');
      return { success: false, reason: 'invalid-licence' };
    }

    const { data, error } = await admin.rpc('redeem_payhip_entitlement_safe', {
      p_user_id: userId,
      p_licence_hash: hashLicenceKey(key)
    });
    if (error) {
      return { success: false, reason: 'unavailable', retryable: true };
    }
    const out = data || { success: false, reason: 'unavailable' };

    // The provider already said this licence is real, enabled and allow-listed, so
    // reaching here means Payhip knows a sale we have no record of: its webhook
    // never landed (Payhip retries for 3 hours) or the database was down when it
    // did. That is NOT an invalid key, and telling the buyer so sends them to
    // support with the wrong question. Nothing is granted - the row lock simply
    // has nothing to lock - the outcome is just named honestly and retryable.
    if (!out.success && out.reason === 'invalid_licence') {
      await recordEvent('redeem', null, 'not-recorded');
      return { success: false, reason: 'not-recorded', retryable: true, detail: 'no-recorded-sale' };
    }

    await recordEvent('redeem', null, out.success ? (out.duplicate ? 'already-claimed' : 'claimed') : out.reason);

    // Best effort, and never part of the decision: the seller's `uses` counter.
    if (out.success && !out.duplicate) {
      recordLicenceUsage(key).catch(() => {});
    }
    return out;
  }

  /**
   * Which configured products are OFFERED FOR SALE (payhip_products.is_active).
   *
   * `is_active` is a catalogue flag: migration 050 creates it FALSE with the
   * comment "FALSE until the founder enables checkout", and nothing read it
   * before this method existed, so flipping it did nothing. It now gates the
   * customer-facing purchase button (see /api/live/activation). It deliberately
   * does NOT invalidate an entitlement that was already paid for, and it does
   * not refuse a completed sale: a customer who has paid is honoured, and the
   * anomaly is recorded instead.
   *
   * Fails CLOSED for the OFFER (an unreadable catalogue must not advertise a
   * product we cannot confirm is on sale) while never affecting redemption.
   */
  async function productsOnSale() {
    const keys = Array.from(cfg.products);
    if (keys.length === 0) return { ok: true, configured: 0, active: 0, onSale: false, reason: 'no-products-configured' };
    try {
      // No `.in(...)` filter: PostgreSQL compares those case-sensitively, so a
      // catalogue row stored as 'dLXuU' would never match an allow-list entry
      // normalised to 'dlxuu' and the buy button would stay hidden. The catalogue
      // is a handful of rows, so filtering here is the robust choice.
      const { data, error } = await admin
        .from('payhip_products')
        .select('product_key, is_active');
      if (error) return { ok: false, configured: keys.length, active: 0, onSale: false, reason: 'catalogue-unreadable' };
      const allowed = new Set(keys);
      const rows = (data || []).filter((r) => r && allowed.has(String(r.product_key || '').toLowerCase()));
      const active = rows.filter((r) => r.is_active === true).length;
      return { ok: true, configured: keys.length, active, onSale: active > 0 };
    } catch (e) {
      return { ok: false, configured: keys.length, active: 0, onSale: false, reason: 'catalogue-unreadable' };
    }
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
    verifyWebhookSignature: (provided) => verifyWebhookSignature(cfg.apiKey, provided),
    verifyLicence,
    productAllowed,
    productsOnSale,
    handleWebhook,
    redeem,
    hasActivation,
    listPurchases,
    recordEvent
  };
}

module.exports = {
  redactPayload,
  productLinkOf,
  resolveProductSecrets,
  expectedWebhookSignature,
  verifyWebhookSignature,
  isValidWebhookToken,
  WEBHOOK_TOKEN_MIN_LENGTH,
  resolvePayhipConfig,
  describePayhipConfig,
  createPayhipEntitlements,
  parseSale,
  netSettledCents,
  hashLicenceKey,
  tokenMatches,
  parseList
};
