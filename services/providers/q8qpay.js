/**
 * Q8QPay Provider Implementation
 *
 * Q8QPay is a non-custodial USDT payment gateway that supports white-label
 * (hosted-by-merchant) checkouts. We use the white-label flow so the customer
 * never leaves the Kalderix UI: we display the payoutAddress (TRC20), the exact
 * amount (amountUsdtExact), a QR code, and an expiry countdown.
 *
 * Documentation: https://q8qpay.com/docs  |  Developers: https://q8qpay.com/developers
 *
 * Features:
 * - White-label invoices (no redirect to q8qpay hosted checkout)
 * - USDT on TRC20 / ERC20 / BSC (we only use USDT_TRC20)
 * - Exact-match confirmation (network + address + amount + before expiry)
 * - HMAC-SHA256 signed webhooks (X-Webhook-Signature header)
 * - Sandbox mode with simulate-payment endpoint for E2E testing
 *
 * SECURITY:
 * - API key in Authorization: Bearer header (test_ or live_ prefix)
 * - Webhook signature verified over the RAW body bytes (hex HMAC-SHA256)
 * - Server-side re-verification via GET /api/v1/invoices/:id before crediting
 * - Idempotent fulfillment is delegated to the shared atomic DB function
 */

const { ProviderInterface } = require('./base/ProviderInterface');
const crypto = require('crypto');
const {
    PaymentError,
    PAYMENT_ERROR_CODES,
    classifyProviderResponse,
    classifyProviderThrow,
    classifyUnusableResponse
} = require('../PaymentError');

const API_BASE = 'https://q8qpay.com';

/**
 * Normalise a signature header value.
 *
 * Providers differ on presentation: some send `sha256=<hex>`, some uppercase hex,
 * some add whitespace from a header rewrite. None of that changes the digest, so
 * the value is trimmed, a scheme prefix is removed and hex is lower-cased before
 * comparison. Anything that is not hex is returned as-is so it simply fails to
 * match instead of throwing.
 */
function normalizeSignature(signature) {
    let value = String(signature == null ? '' : signature).trim();
    if (!value) return '';
    value = value.replace(/^sha256=/i, '').trim();
    if (/^[0-9a-fA-F]+$/.test(value)) return value.toLowerCase();
    return value;
}

// q8qpay webhook `type` / `status` values we care about
const Q8QPAY_STATUS = {
    PENDING: 'pending',
    CONFIRMED: 'confirmed',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled'
};

// Map q8qpay status -> internal normalized status (matches payment_invoices CHECK)
const STATUS_MAP = {
    pending: 'pending',
    confirmed: 'confirmed',
    expired: 'expired',
    cancelled: 'cancelled'
};

// Only USDT_TRC20 is used for Kalderix deposits (per integration requirements)
const SUPPORTED_ASSETS = [
    { code: 'USDT_TRC20', currency: 'USDT', network: 'TRC20', networkLabel: 'Tron (TRC20)' },
    { code: 'USDT_ERC20', currency: 'USDT', network: 'ERC20', networkLabel: 'Ethereum (ERC20)' },
    { code: 'USDT_BSC', currency: 'USDT', network: 'BSC', networkLabel: 'BNB Smart Chain (BEP20)' }
];

class Q8QPayProvider extends ProviderInterface {
    constructor() {
        super();
        this.name = 'q8qpay';
        this.version = '1.0.0';

        this.initialize({
            apiKey: process.env.Q8QPAY_API_KEY,
            webhookSecret: process.env.Q8QPAY_WEBHOOK_SECRET,
            sandbox: process.env.Q8QPAY_SANDBOX === 'true',
            returnUrl: process.env.Q8QPAY_RETURN_URL,
            callbackUrl: process.env.Q8QPAY_CALLBACK_URL
        });
    }

    initialize(config) {
        super.initialize(config);

        this.apiKey = config.apiKey || process.env.Q8QPAY_API_KEY;
        this.webhookSecret = config.webhookSecret || process.env.Q8QPAY_WEBHOOK_SECRET;
        this.isSandbox = config.sandbox || false;
        this.returnUrl = config.returnUrl || process.env.Q8QPAY_RETURN_URL;
        // Per-invoice callback URL; can be overridden per-invoice via params.callbackUrl
        this.callbackUrl = config.callbackUrl || process.env.Q8QPAY_CALLBACK_URL;
        this.baseUrl = API_BASE;
        // A hung create-invoice call used to block the customer's request until the
        // platform gave up, with no timeout of our own. Bounded here so a stalled
        // provider surfaces as a retryable 503 instead of a spinner.
        const configuredTimeout = Number(process.env.Q8QPAY_TIMEOUT_MS);
        this.timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 2000 && configuredTimeout <= 60000
            ? configuredTimeout
            : 20000;

        if (!this.apiKey) {
            console.warn('[Q8QPay] No API key configured - provider will not function');
        }
        if (!this.webhookSecret) {
            console.warn('[Q8QPay] WARNING: Webhook secret not configured - webhook verification will fail!');
        }
    }

    /**
     * Create a white-label invoice via POST /api/v1/invoices.
     *
     * The Kalderix invoice_id (orderId) is passed as the q8qpay `reference`
     * (unique deposit reference). Kalderix user/deposit identifiers are passed
     * through `metadata` and echoed back in the webhook.
     *
     * @param {object} params
     * @param {string} params.orderId - Kalderix invoice_id (unique deposit reference)
     * @param {number} params.amount - Amount in USD (== USDT at 1:1)
     * @param {string} [params.currency] - Ignored; always USDT
     * @param {string} [params.network] - Ignored; always TRC20 (assetCode USDT_TRC20)
     * @param {string} [params.userId] - Kalderix user id (stored in metadata)
     * @param {string} [params.callbackUrl] - Per-invoice override webhook URL
     * @param {number} [params.expirySeconds] - Invoice validity (300-7200)
     * @returns {Promise<object>} Normalized invoice with payoutAddress + amountUsdtExact
     */
    async createInvoice(params) {
        const {
            orderId,
            amount,
            userId,
            ipAddress,
            callbackUrl,
            expirySeconds
        } = params;

        if (!this.apiKey) {
            throw new Error('Q8QPay API key not configured');
        }
        if (!orderId) {
            throw new Error('orderId (Kalderix deposit reference) is required');
        }
        if (!amount || amount <= 0) {
            throw new Error('amount is required and must be > 0');
        }

        // q8qpay requires max 4 decimals; USDT == USD at 1:1
        const amountUsdt = Number(Number(amount).toFixed(4));

        const callback = callbackUrl || this.callbackUrl;
        if (!callback) {
            throw new Error('Q8QPay callbackUrl not configured (set Q8QPAY_CALLBACK_URL or pass callbackUrl)');
        }

        // Kalderix user/deposit identifiers carried through metadata to the webhook
        const metadata = {
            arbitrixUserId: String(userId || ''),
            arbitrixDepositRef: orderId,
            arbitrixInvoiceId: orderId,
            arbitrixIp: ipAddress || 'unknown'
        };

        const requestBody = {
            amountUsdt,
            assetCode: 'USDT_TRC20',
            reference: orderId,          // unique Kalderix deposit reference
            callbackUrl: callback,       // per-invoice webhook URL
            useWhiteLabel: true,         // white-label: we render our own UI
            metadata
        };

        if (expirySeconds && expirySeconds >= 300 && expirySeconds <= 7200) {
            requestBody.expirySeconds = expirySeconds;
        }
        if (this.returnUrl) {
            requestBody.returnUrl = this.returnUrl;
        }
        // The provider shows this on its own hosted page and receipts, so it
        // follows the identity rather than a literal.
        requestBody.title = require('../brand').BRAND.name + ' Deposit';
        requestBody.description = `USDT (TRC20) deposit ${orderId}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            let response;
            try {
                response = await fetch(`${this.baseUrl}/api/v1/invoices`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
            } catch (transportError) {
                // Network failure, DNS, reset or our own timeout. The provider MAY
                // have created the invoice, so this is classified ambiguous and the
                // local row is left recoverable.
                const classified = classifyProviderThrow(transportError, 'q8qpay');
                console.error('[Q8QPay] createInvoice transport failure:', JSON.stringify({
                    event: 'q8qpay_create_transport_failure',
                    code: classified.code,
                    reference: orderId,
                    detail: classified.providerMessage
                }));
                throw classified;
            }

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                const classified = classifyProviderResponse(response.status, errText, 'q8qpay');
                console.error('[Q8QPay] createInvoice rejected:', JSON.stringify({
                    event: 'q8qpay_create_rejected',
                    providerStatus: response.status,
                    code: classified.code,
                    reference: orderId,
                    body: classified.providerMessage
                }));
                throw classified;
            }

            const data = await response.json();

            // Validate the fields we depend on for the white-label UI. A 2xx with an
            // unusable body still means the provider created the invoice, so the
            // classification is marked ambiguous.
            if (!data.payoutAddress || !data.amountUsdtExact || !data.expiresAt) {
                console.error('[Q8QPay] Unexpected invoice response:', JSON.stringify({
                    event: 'q8qpay_create_unusable_body',
                    reference: orderId,
                    keys: Object.keys(data || {}).slice(0, 12)
                }));
                throw classifyUnusableResponse('q8qpay', 'missing payoutAddress/amountUsdtExact/expiresAt');
            }

            console.log(`[Q8QPay] Invoice created: ref=${orderId}, q8qid=${data.id}, payout=${data.payoutAddress.substring(0, 10)}...`);

            return {
                // Our reference / id
                invoiceId: orderId,
                providerInvoiceId: data.id,        // q8qpay UUID
                // White-label payment details
                payoutAddress: data.payoutAddress, // customer TRC20 destination
                amountUsdtExact: data.amountUsdtExact,
                amount: data.amountUsdtExact,
                currency: 'USDT',
                network: 'TRC20',
                assetCode: data.assetCode || 'USDT_TRC20',
                expiresAt: data.expiresAt,
                createdAt: data.createdAt,
                paymentUrl: data.paymentUrl,       // hosted page (we do NOT redirect)
                status: data.status || 'pending',
                // whiteLabel object (qrData, networkLabel, etc.)
                whiteLabel: data.whiteLabel || null,
                qrData: data.whiteLabel?.qrData || data.payoutAddress,
                networkLabel: data.whiteLabel?.networkLabel || 'Tron (TRC20)',
                metadata: data.metadata || metadata,
                isTest: data.isTest === true
            };
        } catch (error) {
            // Already classified (and already logged) above. Anything else is an
            // unexpected failure in our own code: keep it visible, wrap it so the
            // caller never sees raw text, and mark it ambiguous so nothing is
            // marked failed on a signal we do not understand.
            if (error instanceof PaymentError) throw error;
            console.error('[Q8QPay] createInvoice unexpected error:', error && error.message);
            throw new PaymentError(PAYMENT_ERROR_CODES.INTERNAL, {
                httpStatus: 500,
                retryable: true,
                ambiguous: true,
                provider: 'q8qpay',
                providerMessage: error && error.message ? error.message : 'unknown'
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Get invoice status from q8qpay (GET /api/v1/invoices/:id).
     * Used for polling and for server-side re-verification before crediting.
     *
     * @param {string} providerInvoiceId - q8qpay invoice UUID
     * @returns {Promise<object>} Normalized status
     */
    async getInvoiceStatus(providerInvoiceId) {
        if (!this.apiKey) {
            throw new Error('Q8QPay API key not configured');
        }
        if (!providerInvoiceId) {
            throw new Error('providerInvoiceId (q8qpay invoice UUID) is required');
        }

        try {
            const response = await fetch(`${this.baseUrl}/api/v1/invoices/${encodeURIComponent(providerInvoiceId)}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                console.error('[Q8QPay] getInvoiceStatus error:', response.status, errText);
                throw new Error(`Q8QPay status lookup failed: ${response.status}`);
            }

            const data = await response.json();

            return {
                success: true,
                providerInvoiceId: data.id,
                reference: data.reference,
                status: data.status, // pending | confirmed | expired | cancelled
                assetCode: data.assetCode,
                payoutAddress: data.payoutAddress,
                amountUsdtExact: data.amountUsdtExact,
                tx_hash: data.tx_hash || data.txHash,
                expiresAt: data.expiresAt,
                createdAt: data.createdAt,
                isTest: data.isTest === true
            };
        } catch (error) {
            console.error('[Q8QPay] getInvoiceStatus error:', error);
            throw error;
        }
    }

    /**
     * Verify the q8qpay webhook signature.
     *
     * SECURITY: HMAC-SHA256 of the RAW body bytes using the webhook secret,
     * hex digest, compared with timing-safe equality.
     *
     * @param {Buffer|string} rawBody - Raw request body bytes
     * @param {string} signature - Value of X-Webhook-Signature header (hex)
     * @returns {Promise<boolean>}
     */
    async verifyWebhook(rawBody, signature, parsedBody) {
        if (!this.webhookSecret) {
            console.error('[Q8QPay] CRITICAL: Webhook secret not configured! Rejecting webhook.');
            return false;
        }
        const provided = normalizeSignature(signature);
        if (!provided) {
            console.warn('[Q8QPay] Webhook received without signature - REJECTED');
            return false;
        }

        try {
            // q8qpay's own documentation signs `JSON.stringify(body)` - the parsed
            // object re-serialised - not the wire bytes:
            //
            //   crypto.createHmac('sha256', secret).update(JSON.stringify(body))
            //
            // Verifying ONLY the raw bytes therefore rejects a legitimate delivery
            // whenever their serialisation differs from what we received (key
            // spacing, escaping, an upstream proxy). Both forms are keyed with the
            // same secret, so accepting either is exactly as strong: an attacker
            // still needs the secret to produce a matching digest. The raw-byte
            // form stays first because it is the stricter reading of "the exact
            // bytes received".
            const candidates = [];

            if (rawBody != null) {
                const bodyBuffer = Buffer.isBuffer(rawBody)
                    ? rawBody
                    : Buffer.from(String(rawBody), 'utf8');
                if (bodyBuffer.length > 0) candidates.push(bodyBuffer);
            }

            if (parsedBody && typeof parsedBody === 'object') {
                try {
                    candidates.push(Buffer.from(JSON.stringify(parsedBody), 'utf8'));
                } catch (e) { /* unparsable object: nothing to hash */ }
            }

            if (!candidates.length) {
                console.warn('[Q8QPay] Webhook body was empty - cannot verify signature');
                return false;
            }

            const providedBuf = Buffer.from(provided, 'utf8');
            let matched = false;
            for (const candidate of candidates) {
                const expected = Buffer.from(
                    crypto.createHmac('sha256', this.webhookSecret).update(candidate).digest('hex'),
                    'utf8'
                );
                // Length check first: timingSafeEqual throws on a length mismatch.
                if (expected.length === providedBuf.length
                    && crypto.timingSafeEqual(expected, providedBuf)) {
                    matched = true;
                }
            }

            if (!matched) console.warn('[Q8QPay] HMAC signature did not match any accepted body form');
            return matched;
        } catch (error) {
            console.error('[Q8QPay] verifyWebhook error:', error);
            return false;
        }
    }

    /**
     * Resolve the blockchain transaction hash for a CONFIRMED q8qpay payment.
     *
     * Sources, in priority order:
     *   1. verifyTxHash   - hash from q8qpay's authenticated `GET /invoices/:id`
     *                       (getInvoiceStatus: data.tx_hash || data.txHash). This is
     *                       the provider's OWN record of which transaction settled
     *                       the invoice, so it always wins: the hash written to the
     *                       ledger must be the one the provider vouches for.
     *   2. webhookTxHash  - hash parsed from the webhook body
     *                       (parsePaymentData: payload.tx_hash || payload.txHash).
     *                       Accepted ONLY when the caller passes
     *                       `webhookAttested: true`, i.e. the request's HMAC was
     *                       verified before this call. The signature covers the
     *                       whole body, so such a hash is a provider-authored
     *                       statement - but it is still second-hand, which is why
     *                       the pipeline refuses it when the provider's own record
     *                       carries a DIFFERENT hash (TX_HASH_MISMATCH).
     *   3. SANDBOX-ONLY deterministic fallback `q8qpay_sandbox_<providerInvoiceId>`
     *
     * A webhook hash that nobody vouches for is never returned: without
     * `webhookAttested === true` an unsigned value cannot become an idempotency key.
     *
     * SECURITY (production safety of the fallback):
     *   The fallback (#3) fires ONLY when ALL of the following hold:
     *     (a) Q8QPAY_SANDBOX === 'true' (our own config explicitly enables sandbox), AND
     *     (b) the configured API key is a `test_` key (q8qpay only issues test_ keys
     *         for sandbox; a test_ key can never confirm a real on-chain payment), AND
     *     (c) q8qpay's own re-verification flags the invoice as a test invoice.
     *   A `live_` API key can never satisfy (b), so a fake/test hash can NEVER be
     *   produced for a production (live) payment. A hashless live confirmed webhook
     *   returns `null` here and MUST be rejected by the caller.
     *
     * The returned hash (real or sandbox) flows through credit_payment_safe's
     * UNIQUE(transaction_hash) idempotency check, so duplicate webhooks are deduped.
     *
     * @param {object} opts
     * @param {string} [opts.webhookTxHash]  - tx hash from the webhook payload
     * @param {boolean} [opts.webhookAttested] - true only when that payload's HMAC was verified
     * @param {string} [opts.verifyTxHash]   - tx hash from q8qpay re-verification
     * @param {boolean} [opts.verifyIsTest]  - whether q8qpay flagged the invoice as test
     * @param {string} [opts.providerInvoiceId] - q8qpay invoice UUID (for sandbox fallback)
     * @returns {string|null} Resolved tx hash, or null if none available (caller rejects)
     */
    resolveTransactionHash({ webhookTxHash, webhookAttested, verifyTxHash, verifyIsTest, providerInvoiceId } = {}) {
        // The provider's own record is authoritative and takes precedence.
        if (verifyTxHash) return verifyTxHash;
        // Second-hand but provider-signed: only after an HMAC-verified delivery.
        if (webhookTxHash && webhookAttested === true) return webhookTxHash;

        const sandboxConfigured =
            this.isSandbox === true &&
            String(this.apiKey || '').startsWith('test_');

        if (sandboxConfigured && verifyIsTest === true && providerInvoiceId) {
            return `q8qpay_sandbox_${providerInvoiceId}`;
        }

        return null;
    }

    /**
     * Parse webhook event type from payload.
     * q8qpay sends `status` (confirmed/expired/cancelled) and `type`
     * (e.g. invoice.confirmed). We key off `status` for reliability.
     *
     * @param {object} payload
     * @returns {string} Internal event type
     */
    parseWebhookEvent(payload) {
        const status = payload.status;
        switch (status) {
            case Q8QPAY_STATUS.CONFIRMED:
                return 'payment_confirmed';
            case Q8QPAY_STATUS.EXPIRED:
                return 'invoice_expired';
            case Q8QPAY_STATUS.CANCELLED:
                return 'payment_cancelled';
            case Q8QPAY_STATUS.PENDING:
                return 'payment_pending';
            default:
                return `unknown_status_${status}`;
        }
    }

    /**
     * Parse normalized payment data from webhook payload.
     *
     * q8qpay webhook payload fields:
     *   invoice_id, invoice_reference, status, asset_code, payout_address,
     *   amount_usdt_exact, amount_fiat, fiat_currency, tx_hash, metadata,
     *   paid_at, timestamp, type
     *
     * @param {object} payload
     * @returns {object}
     */
    parsePaymentData(payload) {
        const body = payload || {};
        const metadata = (body.metadata && typeof body.metadata === 'object') ? body.metadata : {};

        // The documented payload (q8qpay.com/docs) uses snake_case and
        // `invoice_reference`. Every field is read through the documented name
        // FIRST and the camelCase alias second, and our own identifiers are
        // accepted from `metadata` as a last resort: we put them there at invoice
        // creation, so a webhook that omits or renames the reference field still
        // resolves to the right invoice instead of being dropped as "unknown".
        //
        // Nothing here is trusted for money: the status, amount, address and hash
        // that decide a credit come from the authenticated GET /invoices/:id
        // re-verification (see services/q8qpaySettlement.js).
        const invoiceId = body.invoice_reference
            || body.invoiceReference
            || body.reference
            || metadata.arbitrixDepositRef
            || metadata.arbitrixInvoiceId
            || metadata.orderId
            || null;

        return {
            invoiceId,                                          // our Kalderix reference
            providerInvoiceId: body.invoice_id || body.invoiceId || body.id || null,
            walletAddress: body.payout_address || body.payoutAddress || null,
            amount: body.amount_usdt_exact != null ? body.amount_usdt_exact
                : (body.amountUsdtExact != null ? body.amountUsdtExact : body.amount),
            currency: 'USDT',
            network: 'TRC20',
            assetCode: body.asset_code || body.assetCode || null,
            transactionHash: body.tx_hash || body.txHash || null,
            status: body.status || null,
            paidAt: body.paid_at || body.paidAt || null,
            type: body.type || null,
            amountFiat: body.amount_fiat != null ? body.amount_fiat : body.amountFiat,
            fiatCurrency: body.fiat_currency || body.fiatCurrency || null,
            metadata
        };
    }

    async getSupportedCurrencies() {
        return [
            { code: 'USDT', name: 'Tether USD', networks: ['TRC20', 'ERC20', 'BSC'] }
        ];
    }

    /**
     * For q8qpay the payout address is created per-invoice (not requested
     * separately). This satisfies the interface; createInvoice is the source
     * of the payoutAddress used by the UI.
     */
    async getWalletAddress(params) {
        return {
            address: null,
            currency: params.currency || 'USDT',
            network: params.network || 'TRC20',
            invoiceId: params.invoiceId,
            note: 'Q8QPay returns payoutAddress from createInvoice (white-label flow)'
        };
    }

    /**
     * Cancel a pending invoice (POST /api/v1/invoices/:id/cancel).
     * @param {string} providerInvoiceId - q8qpay invoice UUID
     */
    async cancelInvoice(providerInvoiceId) {
        if (!this.apiKey) {
            throw new Error('Q8QPay API key not configured');
        }
        if (!providerInvoiceId) {
            throw new Error('providerInvoiceId is required to cancel');
        }

        const response = await fetch(`${this.baseUrl}/api/v1/invoices/${encodeURIComponent(providerInvoiceId)}/cancel`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.error('[Q8QPay] cancelInvoice error:', response.status, errText);
            throw new Error(`Q8QPay cancel failed: ${response.status}`);
        }

        return await response.json().catch(() => ({ success: true }));
    }

    /**
     * Sandbox-only: simulate a successful payment for an invoice.
     * Requires a test_ API key. Used for E2E testing.
     *
     * @param {string} providerInvoiceId - q8qpay invoice UUID
     * @param {number} [delaySeconds=0]
     * @returns {Promise<object>}
     */
    async simulatePayment(providerInvoiceId, delaySeconds = 0) {
        if (!this.apiKey) {
            throw new Error('Q8QPay API key not configured');
        }
        if (!this.isSandbox && !String(this.apiKey).startsWith('test_')) {
            throw new Error('simulatePayment is only available with a test_ API key (sandbox mode)');
        }

        const response = await fetch(`${this.baseUrl}/api/v1/sandbox/simulate-payment`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ invoiceId: providerInvoiceId, delaySeconds })
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.error('[Q8QPay] simulatePayment error:', response.status, errText);
            throw new Error(`Q8QPay simulate failed: ${response.status} ${errText.substring(0, 200)}`);
        }

        return await response.json();
    }

    async healthCheck() {
        if (!this.apiKey) {
            return { provider: this.name, status: 'degraded', mode: 'no_api_key', timestamp: new Date().toISOString() };
        }
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/account`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Accept': 'application/json' }
            });
            return {
                provider: this.name,
                status: response.ok ? 'healthy' : 'degraded',
                mode: String(this.apiKey).startsWith('test_') ? 'sandbox' : 'production',
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return { provider: this.name, status: 'unhealthy', error: error.message, timestamp: new Date().toISOString() };
        }
    }

    getSupportedFeatures() {
        return [
            'create_invoice',
            'webhooks',
            'hmac_verification',
            'white_label',
            'non_custodial',
            'sandbox_simulation'
        ];
    }
}

const q8qpayProvider = new Q8QPayProvider();

if (process.env.Q8QPAY_API_KEY) {
    q8qpayProvider.initialize({
        apiKey: process.env.Q8QPAY_API_KEY,
        webhookSecret: process.env.Q8QPAY_WEBHOOK_SECRET,
        sandbox: process.env.Q8QPAY_SANDBOX === 'true',
        returnUrl: process.env.Q8QPAY_RETURN_URL,
        callbackUrl: process.env.Q8QPAY_CALLBACK_URL
    });
    console.log('[Q8QPay] Provider initialized');
} else {
    console.log('[Q8QPay] Provider created but not initialized (missing Q8QPAY_API_KEY)');
}

module.exports = {
    Q8QPayProvider,
    q8qpayProvider,
    Q8QPAY_STATUS,
    STATUS_MAP,
    SUPPORTED_ASSETS
};
