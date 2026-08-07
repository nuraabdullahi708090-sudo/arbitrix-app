/**
 * Paymento Provider Implementation
 * 
 * Paymento is a non-custodial cryptocurrency payment gateway that supports
 * wallet-to-wallet transfers with real-time payment notifications.
 * 
 * Documentation: https://docs.paymento.io/
 * 
 * Features:
 * - Direct wallet-to-wallet (non-custodial)
 * - Multiple cryptocurrencies (BTC, ETH, USDT, etc.)
 * - Real-time IPN (Instant Payment Notification)
 * - HMAC-SHA256 webhook verification
 * - Fiat-to-crypto conversion
 * 
 * SECURITY:
 * - HMAC-SHA256 signature verification using raw body bytes
 * - API key in header: Api-Key
 * - Never trust frontend - always verify with Verify API
 * - Idempotent fulfillment - check status before credit
 */

const { ProviderInterface } = require('./base/ProviderInterface');
const crypto = require('crypto');

// Paymento API endpoints
const API_BASE = {
    production: 'https://api.paymento.io',
    sandbox: 'https://api-sandbox.paymento.io'
};

// Paymento Order Status Codes
const PAYMENTO_STATUS = {
    INITIALIZE: 0,       // Payment request accepted by API
    PENDING: 1,          // Customer chose coin and chain
    PARTIAL_PAID: 2,     // Customer paid less than required
    WAITING_TO_CONFIRM: 3, // Transaction on blockchain (mempool or block)
    TIMEOUT: 4,          // Payment deadline expired
    USER_CANCELED: 5,    // Customer clicked cancel
    PAID: 7,             // Transaction confirmed on blockchain (FULFILL TRIGGER)
    APPROVE: 8,         // Payment verified by store
    REJECT: 9           // Address no longer monitored or payment rejected
};

// Internal status mapping from Paymento status codes
const STATUS_MAP = {
    0: 'pending',        // Initialize -> pending
    1: 'pending',        // Pending -> pending
    2: 'partial',        // PartialPaid -> partial
    3: 'confirming',    // WaitingToConfirm -> confirming
    4: 'expired',        // Timeout -> expired
    5: 'cancelled',      // UserCanceled -> cancelled
    7: 'confirmed',      // Paid -> confirmed (FULFILL THIS)
    8: 'confirmed',      // Approve -> confirmed
    9: 'failed'         // Reject -> failed
};

class PaymentoProvider extends ProviderInterface {
    constructor() {
        super();
        this.name = 'paymento';
        this.version = '1.0.0';
        
        // Initialize config from environment
        this.initialize({
            apiKey: process.env.PAYMENTO_API_KEY,
            secretKey: process.env.PAYMENTO_SECRET_KEY,
            sandbox: process.env.PAYMENTO_SANDBOX === 'true',
            returnUrl: process.env.PAYMENTO_RETURN_URL,
            ipnUrl: process.env.PAYMENTO_IPN_URL
        });
    }

    /**
     * Initialize the provider with configuration
     * @param {object} config - Configuration object
     */
    initialize(config) {
        super.initialize(config);
        
        this.apiKey = config.apiKey || process.env.PAYMENTO_API_KEY;
        this.secretKey = config.secretKey || process.env.PAYMENTO_SECRET_KEY;
        this.baseUrl = config.sandbox ? API_BASE.sandbox : API_BASE.production;
        this.isSandbox = config.sandbox || false;
        this.returnUrl = config.returnUrl || process.env.PAYMENTO_RETURN_URL;
        this.ipnUrl = config.ipnUrl || process.env.PAYMENTO_IPN_URL;
        
        if (!this.apiKey && !this.isSandbox) {
            console.warn('[Paymento] No API key configured - running in limited mode');
        }
        
        if (!this.secretKey) {
            console.warn('[Paymento] WARNING: Secret key not configured - webhook verification will fail!');
        }
    }

    /**
     * Create a payment invoice (Paymento: Payment Request)
     * 
     * @param {object} params - Invoice parameters
     * @param {string} params.userId - Internal user ID
     * @param {string} params.amount - Amount in USD
     * @param {string} params.currency - Cryptocurrency (USDT, BTC, ETH)
     * @param {string} params.network - Network (TRC20, ERC20, etc.)
     * @param {string} params.orderId - Internal order/invoice ID
     * @param {string} params.ipAddress - Client IP
     * @param {string} params.email - Customer email
     * @returns {Promise<object>} Payment details with token
     */
    async createInvoice(params) {
        const { 
            amount, 
            orderId, 
            currency = 'USDT',
            network = 'TRC20',
            ipAddress,
            email 
        } = params;

        try {
            // Paymento request body
            const requestBody = {
                fiatAmount: amount.toString(),
                fiatCurrency: 'USD',
                orderId: orderId,
                Speed: 1, // Low speed - wait for block confirmation (safer)
                additionalData: [
                    { key: 'currency', value: currency },
                    { key: 'network', value: network },
                    { key: 'ip_address', value: ipAddress || 'unknown' }
                ]
            };

            // Add optional fields
            if (this.returnUrl) {
                requestBody.ReturnUrl = this.returnUrl;
            }
            
            if (email) {
                requestBody.EmailAddress = email;
            }

            const response = await fetch(`${this.baseUrl}/v1/payment/request`, {
                method: 'POST',
                headers: {
                    'Api-Key': this.apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'text/plain'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('[Paymento] createInvoice error:', response.status, error);
                throw new Error(`Paymento API error: ${response.status}`);
            }

            const data = await response.json();
            
            if (!data.success) {
                throw new Error(`Paymento request failed: ${data.message}`);
            }

            // Token is in the body field
            const token = data.body;
            
            // Generate gateway URL
            const gatewayUrl = `https://app.paymento.io/gateway?token=${token}`;

            console.log(`[Paymento] Invoice created: ${orderId}, token: ${token.substring(0, 8)}...`);

            return {
                invoiceId: orderId,
                providerInvoiceId: null, // Will be in callback
                token: token,
                gatewayUrl: gatewayUrl,
                amount: amount,
                currency: currency,
                network: network,
                status: 'pending',
                expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour
            };

        } catch (error) {
            console.error('[Paymento] createInvoice error:', error);
            throw error;
        }
    }

    /**
     * Verify payment status via Paymento Verify API
     * SECURITY: This is MANDATORY before crediting any user
     * 
     * @param {string} token - Payment token from Paymento
     * @returns {Promise<object>} Verified payment status
     */
    async getInvoiceStatus(token) {
        if (!token) {
            throw new Error('Token is required for verification');
        }

        try {
            const response = await fetch(`${this.baseUrl}/v1/payment/verify`, {
                method: 'POST',
                headers: {
                    'Api-Key': this.apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'text/plain'
                },
                body: JSON.stringify({ token })
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('[Paymento] verify error:', response.status, error);
                throw new Error(`Paymento verify failed: ${response.status}`);
            }

            const data = await response.json();
            
            if (!data.success) {
                console.warn('[Paymento] Verify returned success=false:', data.message);
                return {
                    success: false,
                    status: 'unknown',
                    message: data.message
                };
            }

            const body = data.body;
            
            // Parse additional data
            const additionalData = {};
            if (body.additionalData && Array.isArray(body.additionalData)) {
                body.additionalData.forEach(item => {
                    additionalData[item.key] = item.value;
                });
            }

            return {
                success: true,
                token: body.token,
                orderId: body.orderId,
                status: STATUS_MAP[body.orderStatus] || 'unknown',
                statusCode: body.orderStatus,
                currency: additionalData.currency || 'USDT',
                network: additionalData.network || 'TRC20',
                additionalData: additionalData
            };

        } catch (error) {
            console.error('[Paymento] getInvoiceStatus error:', error);
            throw error;
        }
    }

    /**
     * Verify webhook signature from Paymento
     * 
     * SECURITY: This is CRITICAL for security
     * - Must use raw body bytes, NOT parsed JSON
     * - HMAC-SHA256 with uppercase hex output
     * 
     * @param {Buffer|string} rawBody - Raw request body (bytes)
     * @param {string} signature - Signature from X-HMAC-SHA256-SIGNATURE header
     * @returns {Promise<boolean>} True if signature is valid
     */
    async verifyWebhook(rawBody, signature) {
        // SECURITY: Reject if no secret configured
        if (!this.secretKey) {
            console.error('[Paymento] CRITICAL: Secret key not configured! Rejecting webhook.');
            return false;
        }
        
        // SECURITY: Reject if no signature provided
        if (!signature) {
            console.warn('[Paymento] Webhook received without signature - REJECTED');
            return false;
        }

        try {
            // Convert to string if Buffer
            const bodyString = Buffer.isBuffer(rawBody) 
                ? rawBody.toString('utf8') 
                : rawBody;

            // Calculate HMAC-SHA256
            const calculatedSignature = crypto
                .createHmac('sha256', this.secretKey)
                .update(bodyString, 'utf8')
                .digest('hex')
                .toUpperCase();

            // Timing-safe comparison
            const isValid = crypto.timingSafeEqual(
                Buffer.from(calculatedSignature, 'utf8'),
                Buffer.from(signature.toUpperCase(), 'utf8')
            );

            if (!isValid) {
                console.warn('[Paymento] HMAC signature mismatch');
                console.warn('[Paymento] Expected:', calculatedSignature.substring(0, 16) + '...');
                console.warn('[Paymento] Received:', signature.substring(0, 16) + '...');
            }

            return isValid;

        } catch (error) {
            console.error('[Paymento] verifyWebhook error:', error);
            return false;
        }
    }

    /**
     * Parse webhook event type from Paymento payload
     * 
     * @param {object} payload - Webhook payload
     * @returns {string} Event type
     */
    parseWebhookEvent(payload) {
        const statusCode = payload.OrderStatus;
        
        switch (statusCode) {
            case PAYMENTO_STATUS.PAID:
                return 'payment_confirmed';
            case PAYMENTO_STATUS.PARTIAL_PAID:
                return 'payment_partial';
            case PAYMENTO_STATUS.WAITING_TO_CONFIRM:
                return 'payment_confirming';
            case PAYMENTO_STATUS.TIMEOUT:
                return 'payment_timeout';
            case PAYMENTO_STATUS.USER_CANCELED:
                return 'payment_cancelled';
            case PAYMENTO_STATUS.INITIALIZE:
                return 'payment_initialized';
            case PAYMENTO_STATUS.PENDING:
                return 'payment_pending';
            case PAYMENTO_STATUS.APPROVE:
                return 'payment_approved';
            case PAYMENTO_STATUS.REJECT:
                return 'payment_rejected';
            default:
                return `unknown_status_${statusCode}`;
        }
    }

    /**
     * Parse payment data from webhook payload
     * 
     * @param {object} payload - Webhook payload
     * @returns {object} Normalized payment data
     */
    parsePaymentData(payload) {
        // Parse additional data
        const additionalData = {};
        if (payload.AdditionalData && Array.isArray(payload.AdditionalData)) {
            payload.AdditionalData.forEach(item => {
                additionalData[item.key] = item.value;
            });
        }

        return {
            token: payload.Token,
            providerPaymentId: payload.PaymentId ? payload.PaymentId.toString() : null,
            orderId: payload.OrderId,
            status: STATUS_MAP[payload.OrderStatus] || 'unknown',
            statusCode: payload.OrderStatus,
            currency: additionalData.currency || 'USDT',
            network: additionalData.network || 'TRC20',
            ipAddress: additionalData.ip_address,
            additionalData: additionalData,
            isPaid: payload.OrderStatus === PAYMENTO_STATUS.PAID,
            isConfirming: payload.OrderStatus === PAYMENTO_STATUS.WAITING_TO_CONFIRM,
            isPartial: payload.OrderStatus === PAYMENTO_STATUS.PARTIAL_PAID,
            isExpired: payload.OrderStatus === PAYMENTO_STATUS.TIMEOUT,
            isCancelled: payload.OrderStatus === PAYMENTO_STATUS.USER_CANCELED
        };
    }

    /**
     * Get list of supported currencies
     * 
     * @returns {Promise<Array>} Supported currencies
     */
    async getSupportedCurrencies() {
        // Paymento supports a wide range of cryptocurrencies
        // Return common ones for now
        return [
            { code: 'USDT', name: 'Tether USD', networks: ['TRC20', 'ERC20', 'BEP20'] },
            { code: 'BTC', name: 'Bitcoin', networks: ['BTC'] },
            { code: 'ETH', name: 'Ethereum', networks: ['ETH'] },
            { code: 'USDC', name: 'USD Coin', networks: ['TRC20', 'ERC20', 'BEP20'] },
            { code: 'BNB', name: 'BNB', networks: ['BNB'] },
            { code: 'XRP', name: 'Ripple', networks: ['XRP'] },
            { code: 'ADA', name: 'Cardano', networks: ['ADA'] },
            { code: 'DOGE', name: 'Dogecoin', networks: ['DOGE'] },
            { code: 'LTC', name: 'Litecoin', networks: ['LTC'] },
            { code: 'MATIC', name: 'Polygon', networks: ['MATIC'] }
        ];
    }

    /**
     * Get wallet address for deposits
     * NOTE: Paymento is non-custodial - customer pays to Paymento's address
     * We receive the callback, not the funds directly
     * 
     * @param {object} params - Address parameters
     * @returns {Promise<object>} Wallet address (not applicable for Paymento)
     */
    async getWalletAddress(params) {
        // Paymento is non-custodial - merchant doesn't provide an address
        // Customer pays to Paymento's address, Paymento notifies us via webhook
        // We return a placeholder indicating this is handled by Paymento gateway
        return {
            address: null,
            currency: params.currency || 'USDT',
            network: params.network || 'TRC20',
            invoiceId: params.invoiceId,
            isNonCustodial: true,
            note: 'Paymento handles wallet addresses - funds go directly to merchant wallet'
        };
    }

    /**
     * Health check for Paymento API
     * 
     * @returns {Promise<object>} Health status
     */
    async healthCheck() {
        if (!this.apiKey) {
            return {
                provider: this.name,
                status: 'degraded',
                mode: 'no_api_key',
                timestamp: new Date().toISOString()
            };
        }

        try {
            const response = await fetch(`${this.baseUrl}/v1/ping`, {
                headers: {
                    'Api-Key': this.apiKey
                }
            });

            return {
                provider: this.name,
                status: response.ok ? 'healthy' : 'degraded',
                mode: this.isSandbox ? 'sandbox' : 'production',
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            return {
                provider: this.name,
                status: 'unhealthy',
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    /**
     * Get supported features
     * 
     * @returns {Array<string>} Supported features
     */
    getSupportedFeatures() {
        return [
            'create_invoice',
            'webhooks',
            'hmac_verification',
            'non_custodial',
            'fiat_conversion',
            'multiple_cryptocurrencies'
        ];
    }

    /**
     * Get status code name
     * 
     * @param {number} statusCode - Paymento status code
     * @returns {string} Status name
     */
    getStatusName(statusCode) {
        const names = {
            0: 'Initialize',
            1: 'Pending',
            2: 'PartialPaid',
            3: 'WaitingToConfirm',
            4: 'Timeout',
            5: 'UserCanceled',
            7: 'Paid',
            8: 'Approve',
            9: 'Reject'
        };
        return names[statusCode] || `Unknown(${statusCode})`;
    }
}

// Export provider instance
const paymentoProvider = new PaymentoProvider();

// Auto-initialize if config is available
if (process.env.PAYMENTO_API_KEY && process.env.PAYMENTO_SECRET_KEY) {
    paymentoProvider.initialize({
        apiKey: process.env.PAYMENTO_API_KEY,
        secretKey: process.env.PAYMENTO_SECRET_KEY,
        sandbox: process.env.PAYMENTO_SANDBOX === 'true',
        returnUrl: process.env.PAYMENTO_RETURN_URL,
        ipnUrl: process.env.PAYMENTO_IPN_URL
    });
    console.log('[Paymento] Provider initialized');
} else {
    console.log('[Paymento] Provider created but not initialized (missing API_KEY or SECRET_KEY)');
}

module.exports = {
    PaymentoProvider,
    paymentoProvider,
    PAYMENTO_STATUS,
    STATUS_MAP
};
