/**
 * NOWPayments Provider Implementation
 * 
 * NOWPayments is a cryptocurrency payment processor that supports
 * 50+ cryptocurrencies across multiple networks.
 * 
 * Documentation: https://documenter.getpostman.com/view/7907941/SzS8uypm
 * 
 * Features:
 * - Multi-currency support (50+ cryptocurrencies)
 * - Multiple networks (TRC20, ERC20, BEP20, etc.)
 * - Webhook notifications
 * - Invoice management
 * - Fiat conversion
 */

const { ProviderInterface } = require('./base/ProviderInterface');
const crypto = require('crypto');

// NOWPayments API endpoints
const API_BASE = {
    production: 'https://api.nowpayments.io/v1',
    sandbox: 'https://api-sandbox.nowpayments.io/v1'
};

class NOWPaymentsProvider extends ProviderInterface {
    constructor() {
        super();
        this.name = 'nowpayments';
        this.version = '1.0.0';
        
        // Default wallet addresses (in production, these come from provider or are generated)
        this.walletAddresses = {
            USDT: {
                TRC20: process.env.NOWPAYMENTS_USDT_TRC20 || 'TDQ2Ymmejp2MXxawBdbYkxqjZ7tTkMyMJR',
                ERC20: process.env.NOWPAYMENTS_USDT_ERC20 || '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
                BEP20: process.env.NOWPAYMENTS_USDT_BEP20 || '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
            },
            BTC: {
                BTC: process.env.NOWPAYMENTS_BTC_ADDRESS || 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
            },
            ETH: {
                ETH: process.env.NOWPAYMENTS_ETH_ADDRESS || '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
            }
        };
    }

    /**
     * Initialize the provider with configuration
     * @param {object} config - Configuration object
     */
    initialize(config) {
        super.initialize(config);
        
        this.apiKey = config.apiKey || process.env.NOWPAYMENTS_API_KEY;
        this.ipnSecret = config.ipnSecret || process.env.NOWPAYMENTS_IPN_SECRET;
        this.baseUrl = config.sandbox ? API_BASE.sandbox : API_BASE.production;
        this.isSandbox = config.sandbox || false;
        
        if (!this.apiKey && !this.isSandbox) {
            console.warn('[NOWPayments] No API key configured - using mock mode');
        }
    }

    /**
     * Create a payment invoice
     * @param {object} params - Invoice parameters
     * @returns {Promise<object>} Invoice details
     */
    async createInvoice(params) {
        const { currency = 'USDT', network = 'TRC20', amount, orderId, ipCallback } = params;
        
        // If we have API key, use real API
        if (this.apiKey) {
            return await this.createInvoiceViaAPI(params);
        }
        
        // Mock mode - return local wallet address
        return await this.createInvoiceMock(params);
    }

    /**
     * Create invoice using NOWPayments API
     */
    async createInvoiceViaAPI(params) {
        const { currency, network, amount, orderId, ipCallback } = params;
        
        try {
            const response = await fetch(`${this.baseUrl}/payment`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey
                },
                body: JSON.stringify({
                    price_amount: amount,
                    price_currency: 'usd',
                    pay_currency: currency,
                    ipn_callback_url: ipCallback,
                    order_id: orderId,
                    // Fixed addresses mode
                    is_fixed_rate: true,
                    order_description: `Arbitrix AI Deposit - Order ${orderId}`
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(`NOWPayments API error: ${error.message}`);
            }

            const data = await response.json();
            
            return {
                invoiceId: data.id.toString(),
                address: data.pay_address,
                amount: data.pay_amount,
                currency: data.pay_currency,
                network: this.mapCurrencyToNetwork(currency),
                expiresAt: new Date(data.valid_until).toISOString(),
                status: data.payment_status,
                payUrl: data.pay_url
            };

        } catch (error) {
            console.error('[NOWPayments] createInvoiceViaAPI error:', error);
            throw error;
        }
    }

    /**
     * Mock invoice creation (for testing without API key)
     */
    async createInvoiceMock(params) {
        const { currency = 'USDT', network = 'TRC20', amount, orderId } = params;
        
        const address = this.walletAddresses[currency]?.[network] 
            || this.walletAddresses.USDT.TRC20;
        
        // Calculate crypto amount (mock rate)
        const cryptoAmount = this.calculateCryptoAmount(amount, currency);
        
        return {
            invoiceId: orderId,
            address: address,
            amount: cryptoAmount,
            currency: currency,
            network: network,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            status: 'waiting'
        };
    }

    /**
     * Get invoice status from NOWPayments
     * @param {string} invoiceId - Provider's invoice ID
     * @returns {Promise<object>} Invoice status
     */
    async getInvoiceStatus(invoiceId) {
        if (!this.apiKey) {
            // Mock mode - return pending
            return {
                invoiceId: invoiceId,
                status: 'waiting',
                paymentStatus: 'waiting'
            };
        }

        try {
            const response = await fetch(`${this.baseUrl}/payment/${invoiceId}`, {
                headers: {
                    'x-api-key': this.apiKey
                }
            });

            if (!response.ok) {
                throw new Error(`NOWPayments API error: ${response.statusText}`);
            }

            const data = await response.json();
            
            return {
                invoiceId: data.id.toString(),
                status: this.mapPaymentStatus(data.payment_status),
                amountPaid: data.pay_amount,
                amountReceived: data.actually_paid || data.pay_amount,
                currency: data.pay_currency,
                network: this.mapCurrencyToNetwork(data.pay_currency),
                paymentStatus: data.payment_status,
                transactionHash: data.tx_hash,
                createdAt: data.created_at,
                updatedAt: data.updated_at
            };

        } catch (error) {
            console.error('[NOWPayments] getInvoiceStatus error:', error);
            throw error;
        }
    }

    /**
     * Verify webhook signature from NOWPayments
     * @param {object} payload - Webhook payload
     * @param {string} signature - Signature from header
     * @param {string} secret - IPN secret
     * @returns {Promise<boolean>} True if valid
     */
    async verifyWebhook(payload, signature, secret) {
        // SECURITY: Reject webhooks without signature or secret in production
        // The secret MUST be configured for webhook verification
        if (!secret) {
            console.error('[NOWPayments] CRITICAL: Webhook secret not configured! Rejecting webhook.');
            return false;
        }
        
        if (!signature) {
            console.warn('[NOWPayments] Webhook received without signature - REJECTED');
            return false;
        }

        // NOWPayments uses HMAC-SHA256 for webhook verification
        // The signature is sent in the header: "X-Signature: sha256=..."
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(JSON.stringify(payload));
        const expectedSignature = `sha256=${hmac.digest('base64')}`;
        
        // Use timing-safe comparison to prevent timing attacks
        try {
            return crypto.timingSafeEqual(
                Buffer.from(signature),
                Buffer.from(expectedSignature)
            );
        } catch (error) {
            // Signatures don't match
            console.warn('[NOWPayments] Signature mismatch:', error.message);
            return false;
        }
    }

    /**
     * Get list of supported currencies from NOWPayments
     * @returns {Promise<Array>} Supported currencies
     */
    async getSupportedCurrencies() {
        if (!this.apiKey) {
            // Return default supported currencies
            return [
                { code: 'USDT', name: 'Tether USD', networks: ['TRC20', 'ERC20', 'BEP20'] },
                { code: 'BTC', name: 'Bitcoin', networks: ['BTC'] },
                { code: 'ETH', name: 'Ethereum', networks: ['ETH'] },
                { code: 'BNB', name: 'BNB', networks: ['BNB'] },
                { code: 'USDC', name: 'USD Coin', networks: ['TRC20', 'ERC20', 'BEP20'] }
            ];
        }

        try {
            const response = await fetch(`${this.baseUrl}/currency`, {
                headers: {
                    'x-api-key': this.apiKey
                }
            });

            if (!response.ok) {
                throw new Error(`NOWPayments API error: ${response.statusText}`);
            }

            const currencies = await response.json();
            
            // Filter and format supported currencies
            return currencies
                .filter(c => c.enabled && !c.is_fiat)
                .map(c => ({
                    code: c.id.toUpperCase(),
                    name: c.name,
                    networks: this.getNetworksForCurrency(c.id)
                }));

        } catch (error) {
            console.error('[NOWPayments] getSupportedCurrencies error:', error);
            // Fallback to default currencies
            return [
                { code: 'USDT', name: 'Tether USD', networks: ['TRC20', 'ERC20', 'BEP20'] },
                { code: 'BTC', name: 'Bitcoin', networks: ['BTC'] },
                { code: 'ETH', name: 'Ethereum', networks: ['ETH'] }
            ];
        }
    }

    /**
     * Get wallet address for a specific currency and network
     * @param {object} params - Address parameters
     * @returns {Promise<object>} Wallet address
     */
    async getWalletAddress(params) {
        const { currency = 'USDT', network = 'TRC20', invoiceId } = params;
        
        const address = this.walletAddresses[currency]?.[network];
        
        if (!address) {
            throw new Error(`No address configured for ${currency} on ${network}`);
        }
        
        return {
            address: address,
            currency: currency,
            network: network,
            invoiceId: invoiceId
        };
    }

    /**
     * Parse webhook event type
     * @param {object} payload - Webhook payload
     * @returns {string} Event type
     */
    parseWebhookEvent(payload) {
        const status = payload.payment_status || payload.status;
        
        switch (status) {
            case 'finished':
                return 'payment_confirmed';
            case 'partially_paid':
                return 'payment_partial';
            case 'expired':
                return 'invoice_expired';
            case 'failed':
                return 'payment_failed';
            case 'created':
                return 'invoice_created';
            default:
                return status;
        }
    }

    /**
     * Parse payment data from webhook
     * @param {object} payload - Webhook payload
     * @returns {object} Normalized payment data
     */
    parsePaymentData(payload) {
        return {
            invoiceId: payload.order_id?.toString(),
            providerInvoiceId: payload.payment_id?.toString(),
            walletAddress: payload.pay_address,
            amount: payload.actually_paid || payload.pay_amount,
            currency: payload.pay_currency,
            network: this.mapCurrencyToNetwork(payload.pay_currency),
            transactionHash: payload.tx_hash,
            status: this.mapPaymentStatus(payload.payment_status),
            createdAt: payload.created_at,
            updatedAt: payload.updated_at
        };
    }

    // ==================== HELPER METHODS ====================

    /**
     * Map payment status to internal status
     */
    mapPaymentStatus(status) {
        const statusMap = {
            'waiting': 'pending',
            'created': 'pending',
            'confirming': 'confirming',
            'finished': 'confirmed',
            'partially_paid': 'partial',
            'expired': 'expired',
            'failed': 'failed',
            'cancelled': 'cancelled'
        };
        return statusMap[status] || status;
    }

    /**
     * Map currency to network
     */
    mapCurrencyToNetwork(currency) {
        const networkMap = {
            'USDT': 'TRC20',
            'BTC': 'BTC',
            'ETH': 'ETH',
            'BNB': 'BNB',
            'USDC': 'ERC20'
        };
        return networkMap[currency] || 'TRC20';
    }

    /**
     * Get networks for a currency
     */
    getNetworksForCurrency(currencyId) {
        const currency = currencyId.toUpperCase();
        
        if (currency === 'USDT' || currency === 'USDC') {
            return ['TRC20', 'ERC20', 'BEP20'];
        }
        if (currency === 'BTC') {
            return ['BTC'];
        }
        if (currency === 'ETH') {
            return ['ETH'];
        }
        if (currency === 'BNB') {
            return ['BNB'];
        }
        
        return [currency];
    }

    /**
     * Calculate crypto amount (mock implementation)
     */
    calculateCryptoAmount(amountUsd, currency) {
        const rates = {
            USDT: 1.0001,
            BTC: 0.000010,  // ~$50,000 per BTC
            ETH: 0.005,     // ~$2,000 per ETH
            BNB: 0.01,      // ~$300 per BNB
            USDC: 1.0001
        };
        
        const rate = rates[currency] || 1;
        return (amountUsd / rate).toFixed(6);
    }

    /**
     * Health check
     */
    async healthCheck() {
        if (!this.apiKey) {
            return {
                provider: this.name,
                status: 'healthy',
                mode: 'mock',
                timestamp: new Date().toISOString()
            };
        }

        try {
            const response = await fetch(`${this.baseUrl}/user/me`, {
                headers: {
                    'x-api-key': this.apiKey
                }
            });

            return {
                provider: this.name,
                status: response.ok ? 'healthy' : 'degraded',
                mode: 'live',
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
}

// Export provider
const nowPaymentsProvider = new NOWPaymentsProvider();

// Auto-initialize if config is available
if (process.env.NOWPAYMENTS_API_KEY) {
    nowPaymentsProvider.initialize({
        apiKey: process.env.NOWPAYMENTS_API_KEY,
        ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET,
        sandbox: process.env.NOWPAYMENTS_SANDBOX === 'true'
    });
}

module.exports = {
    NOWPaymentsProvider,
    nowPaymentsProvider
};
