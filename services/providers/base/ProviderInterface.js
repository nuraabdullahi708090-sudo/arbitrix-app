/**
 * Provider Interface - Base class for all payment providers
 * 
 * All payment providers MUST implement this interface.
 * This ensures consistent API across all providers and easy switching.
 * 
 * To add a new provider:
 * 1. Create a new file in services/providers/{provider-name}.js
 * 2. Extend this ProviderInterface class
 * 3. Implement all required methods
 * 4. Register the provider in PaymentService constructor
 * 
 * @abstract
 */
class ProviderInterface {
    constructor() {
        if (this.constructor === ProviderInterface) {
            throw new Error('ProviderInterface is abstract and cannot be instantiated directly');
        }
        
        this.name = 'base';
        this.config = {};
    }

    // ==================== REQUIRED METHODS ====================
    // These MUST be implemented by all providers

    /**
     * Create a payment invoice
     * @param {object} params - Invoice parameters
     * @param {string} params.currency - Cryptocurrency code (USDT, BTC, ETH)
     * @param {string} params.network - Network (TRC20, ERC20, BEP20)
     * @param {string} params.amount - Amount to receive
     * @param {string} params.orderId - Internal order/invoice ID
     * @param {string} params.ipCallback - IP for callback verification
     * @returns {Promise<object>} Invoice details with address
     * 
     * @example
     * {
     *   invoiceId: 'provider_invoice_123',
     *   address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
     *   amount: '50.00',
     *   currency: 'USDT',
     *   expiresAt: '2024-01-01T12:00:00Z'
     * }
     */
    async createInvoice(params) {
        throw new Error('Method createInvoice() must be implemented by provider');
    }

    /**
     * Get the status of an existing invoice
     * @param {string} invoiceId - Provider's invoice ID
     * @returns {Promise<object>} Invoice status
     * 
     * @example
     * {
     *   invoiceId: 'provider_invoice_123',
     *   status: 'paid', // pending, paid, partial, expired, cancelled
     *   amountPaid: '50.00',
     *   currency: 'USDT',
     *   paymentStatus: 'confirmed'
     * }
     */
    async getInvoiceStatus(invoiceId) {
        throw new Error('Method getInvoiceStatus() must be implemented by provider');
    }

    /**
     * Verify webhook signature
     * @param {object} payload - Raw webhook payload
     * @param {string} signature - Signature from header
     * @param {string} secret - Webhook secret
     * @returns {Promise<boolean>} True if signature is valid
     */
    async verifyWebhook(payload, signature, secret) {
        throw new Error('Method verifyWebhook() must be implemented by provider');
    }

    /**
     * Get list of supported currencies
     * @returns {Promise<Array>} List of supported currency objects
     * 
     * @example
     * [
     *   { code: 'USDT', name: 'Tether', networks: ['TRC20', 'ERC20', 'BEP20'] },
     *   { code: 'BTC', name: 'Bitcoin', networks: ['BTC'] },
     *   { code: 'ETH', name: 'Ethereum', networks: ['ETH'] }
     * ]
     */
    async getSupportedCurrencies() {
        throw new Error('Method getSupportedCurrencies() must be implemented by provider');
    }

    /**
     * Get wallet address for deposits
     * @param {object} params - Address parameters
     * @param {string} params.currency - Cryptocurrency
     * @param {string} params.network - Network
     * @param {string} params.invoiceId - Related invoice ID
     * @returns {Promise<object>} Wallet address details
     * 
     * @example
     * {
     *   address: 'TDQ2Ymmejp2MXxawBdbYkxqjZ7tTkMyMJR',
     *   currency: 'USDT',
     *   network: 'TRC20'
     * }
     */
    async getWalletAddress(params) {
        throw new Error('Method getWalletAddress() must be implemented by provider');
    }

    // ==================== OPTIONAL METHODS ====================
    // These have default implementations but can be overridden

    /**
     * Parse webhook event type from payload
     * @param {object} payload - Webhook payload
     * @returns {string} Event type
     */
    parseWebhookEvent(payload) {
        // Default implementation - override per provider
        return payload.status || payload.type || 'unknown';
    }

    /**
     * Parse payment data from webhook payload
     * @param {object} payload - Webhook payload
     * @returns {object} Normalized payment data
     * 
     * @example
     * {
     *   invoiceId: 'provider_invoice_123',
     *   walletAddress: '0x742d...',
     *   amount: '50.00',
     *   currency: 'USDT',
     *   transactionHash: '0xabc...',
     *   status: 'confirmed'
     * }
     */
    parsePaymentData(payload) {
        // Default implementation - override per provider
        return {
            invoiceId: payload.invoice_id || payload.order_id,
            walletAddress: payload.address || payload.wallet_address,
            amount: payload.actual_amount || payload.amount,
            currency: payload.currency || 'USDT',
            transactionHash: payload.transaction_hash || payload.txid,
            status: payload.status
        };
    }

    /**
     * Validate address format for a currency
     * @param {string} address - Wallet address
     * @param {string} currency - Currency code
     * @param {string} network - Network
     * @returns {boolean} True if address is valid
     */
    validateAddress(address, currency, network) {
        if (!address || typeof address !== 'string') return false;
        
        // Basic length check (most crypto addresses are between 20-50 chars)
        if (address.length < 20 || address.length > 64) return false;
        
        // Basic format check (alphanumeric)
        return /^[a-zA-Z0-9]+$/.test(address);
    }

    /**
     * Initialize provider with configuration
     * @param {object} config - Provider configuration
     */
    initialize(config) {
        this.config = {
            apiKey: config.apiKey,
            apiSecret: config.apiSecret,
            merchantId: config.merchantId,
            webhookSecret: config.webhookSecret,
            sandbox: config.sandbox || false,
            ...config
        };
    }

    /**
     * Get provider metadata
     * @returns {object} Provider info
     */
    getMetadata() {
        return {
            name: this.name,
            version: '1.0.0',
            supportedCurrencies: this.getSupportedCurrenciesSync?.() || [],
            features: this.getSupportedFeatures?.() || []
        };
    }

    /**
     * Get supported features for this provider
     * @returns {Array<string>} List of supported features
     */
    getSupportedFeatures() {
        return [
            'create_invoice',
            'webhooks',
            'address_generation',
            'payment_status'
        ];
    }

    /**
     * Health check for the provider API
     * @returns {Promise<object>} Health status
     */
    async healthCheck() {
        return {
            provider: this.name,
            status: 'healthy',
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = { ProviderInterface };
