/**
 * Q8QPay Provider Implementation
 *
 * Q8QPay is a non-custodial USDT payment gateway that supports white-label
 * (hosted-by-merchant) checkouts. We use the white-label flow so the customer
 * never leaves the Arbitrix UI: we display the payoutAddress (TRC20), the exact
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

const API_BASE = 'https://q8qpay.com';

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

// Only USDT_TRC20 is used for Arbitrix deposits (per integration requirements)
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
     * The Arbitrix invoice_id (orderId) is passed as the q8qpay `reference`
     * (unique deposit reference). Arbitrix user/deposit identifiers are passed
     * through `metadata` and echoed back in the webhook.
     *
     * @param {object} params
     * @param {string} params.orderId - Arbitrix invoice_id (unique deposit reference)
     * @param {number} params.amount - Amount in USD (== USDT at 1:1)
     * @param {string} [params.currency] - Ignored; always USDT
     * @param {string} [params.network] - Ignored; always TRC20 (assetCode USDT_TRC20)
     * @param {string} [params.userId] - Arbitrix user id (stored in metadata)
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
            throw new Error('orderId (Arbitrix deposit reference) is required');
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

        // Arbitrix user/deposit identifiers carried through metadata to the webhook
        const metadata = {
            arbitrixUserId: String(userId || ''),
            arbitrixDepositRef: orderId,
            arbitrixInvoiceId: orderId,
            arbitrixIp: ipAddress || 'unknown'
        };

        const requestBody = {
            amountUsdt,
            assetCode: 'USDT_TRC20',
            reference: orderId,          // unique Arbitrix deposit reference
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
        requestBody.title = 'Arbitrix Deposit';
        requestBody.description = `USDT (TRC20) deposit ${orderId}`;

        try {
            const response = await fetch(`${this.baseUrl}/api/v1/invoices`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                console.error('[Q8QPay] createInvoice error:', response.status, errText);
                throw new Error(`Q8QPay API error: ${response.status} ${errText.substring(0, 200)}`);
            }

            const data = await response.json();

            // Validate the fields we depend on for the white-label UI
            if (!data.payoutAddress || !data.amountUsdtExact || !data.expiresAt) {
                console.error('[Q8QPay] Unexpected invoice response:', JSON.stringify(data).substring(0, 300));
                throw new Error('Q8QPay invoice response missing required white-label fields');
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
            console.error('[Q8QPay] createInvoice error:', error);
            throw error;
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
    async verifyWebhook(rawBody, signature) {
        if (!this.webhookSecret) {
            console.error('[Q8QPay] CRITICAL: Webhook secret not configured! Rejecting webhook.');
            return false;
        }
        if (!signature) {
            console.warn('[Q8QPay] Webhook received without signature - REJECTED');
            return false;
        }

        try {
            const bodyBuffer = Buffer.isBuffer(rawBody)
                ? rawBody
                : Buffer.from(String(rawBody), 'utf8');

            const calculated = crypto
                .createHmac('sha256', this.webhookSecret)
                .update(bodyBuffer)
                .digest('hex');

            const a = Buffer.from(calculated, 'utf8');
            const b = Buffer.from(String(signature), 'utf8');

            if (a.length !== b.length) {
                console.warn('[Q8QPay] HMAC signature length mismatch');
                return false;
            }

            return crypto.timingSafeEqual(a, b);
        } catch (error) {
            console.error('[Q8QPay] verifyWebhook error:', error);
            return false;
        }
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
        return {
            invoiceId: payload.invoice_reference,     // our Arbitrix reference
            providerInvoiceId: payload.invoice_id,    // q8qpay UUID
            walletAddress: payload.payout_address,    // customer TRC20 destination
            amount: payload.amount_usdt_exact,        // exact amount paid
            currency: 'USDT',
            network: 'TRC20',
            assetCode: payload.asset_code,
            transactionHash: payload.tx_hash || payload.txHash,
            status: payload.status,
            paidAt: payload.paid_at,
            type: payload.type,
            metadata: payload.metadata || {}
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
