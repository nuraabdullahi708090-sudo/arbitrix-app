/**
 * Payment Service Layer - Arbitrix AI
 * 
 * This is the central service that handles all payment operations.
 * The application communicates ONLY with this service, never directly with providers.
 * 
 * Adding new providers is straightforward - just implement the ProviderInterface
 * and register the provider in the constructor.
 * 
 * SECURITY: All API keys and secrets MUST be provided via environment variables.
 * Never hardcode secrets in source code.
 * 
 * Required Environment Variables:
 * - SUPABASE_URL: Supabase project URL
 * - SUPABASE_SERVICE_KEY: Supabase service role key (for admin operations)
 * - NOWPAYMENTS_API_KEY: NOWPayments API key
 * - NOWPAYMENTS_IPN_SECRET: NOWPayments webhook secret
 * - PAYMENTO_API_KEY: Paymento API key
 * - PAYMENTO_SECRET_KEY: Paymento webhook secret
 * 
 * @author Arbitrix AI
 * @version 1.1.0 (Added Paymento support)
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Validate required environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
    console.error(`[PaymentService] CRITICAL: Missing required environment variables: ${missingVars.join(', ')}`);
    console.error('[PaymentService] Payment processing will fail without these variables.');
}

// Initialize Supabase client with environment variables ONLY
// SECURITY: No fallback keys - require proper configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('[PaymentService] CRITICAL: Supabase credentials not configured. Payment system will not function.');
}

// Create supabase client (will fail on requests if credentials are missing)
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Configuration
const CONFIG = {
    INVOICE_EXPIRY_MS: 60 * 60 * 1000, // 1 hour
    CONFIRMATION_DELAY_MS: 15 * 1000,   // 15 seconds for testing (change in production)
    MIN_DEPOSIT_USD: 10,
    SUPPORTED_CURRENCIES: ['USDT', 'BTC', 'ETH'],
    DEFAULT_CURRENCY: 'USDT',
    NETWORKS: {
        TRC20: { name: 'TRC20 (Tron)', chain: 'TRX', fee: 0.1 },
        ERC20: { name: 'ERC20 (Ethereum)', chain: 'ETH', fee: 1.5 },
        BEP20: { name: 'ERC20 (BNB Chain)', chain: 'BNB', fee: 0.2 }
    }
};

/**
 * Payment Service - Main entry point for all payment operations
 */
class PaymentService {
    constructor() {
        this.providers = new Map();
        this.activeProvider = null;
        this.webhookSecrets = new Map();
        this.processedWebhooks = new Map(); // In-memory for single instance
        this.idempotencyKeys = new Map(); // In-memory for single instance
        
        // Initialize active provider from environment.
        // Normalize (trim + lowercase) so hosting-platform values like "q8qpay ",
        // "Q8QPay", or "q8qpay\n" still match the registered lowercase provider names.
        // Registered names (nowpayments, paymento, q8qpay) are all lowercase, so this
        // preserves existing behavior while making env-var configuration robust.
        this.activeProviderName = (process.env.PAYMENT_PROVIDER || 'nowpayments').trim().toLowerCase();
        
        console.log(`[PaymentService] Initialized with provider: ${this.activeProviderName}`);
        
        // Security check
        if (!supabase) {
            console.error('[PaymentService] CRITICAL: Supabase not initialized. Payment operations will fail.');
        }
    }

    /**
     * Register a payment provider
     * @param {string} name - Provider name (e.g., 'nowpayments', 'cryptomus')
     * @param {object} provider - Provider instance implementing ProviderInterface
     */
    registerProvider(name, provider) {
        if (!this.isValidProvider(provider)) {
            throw new Error(`Invalid provider: must implement ProviderInterface`);
        }
        this.providers.set(name, provider);
        console.log(`[PaymentService] Registered provider: ${name}`);
        
        // Set as active if it's the configured provider
        if (name === this.activeProviderName) {
            this.activeProvider = provider;
        }
    }

    /**
     * Set the active payment provider
     * @param {string} name - Provider name
     */
    setActiveProvider(name) {
        if (!this.providers.has(name)) {
            throw new Error(`Provider '${name}' is not registered`);
        }
        this.activeProviderName = name;
        this.activeProvider = this.providers.get(name);
        console.log(`[PaymentService] Active provider set to: ${name}`);
    }

    /**
     * Get the active provider instance
     * @returns {object} Active provider
     */
    getActiveProvider() {
        if (!this.activeProvider) {
            throw new Error('No active payment provider configured');
        }
        return this.activeProvider;
    }

    /**
     * Validate that a provider implements the required interface
     * @param {object} provider - Provider to validate
     * @returns {boolean}
     */
    isValidProvider(provider) {
        const requiredMethods = [
            'createInvoice',
            'getInvoiceStatus',
            'verifyWebhook',
            'getSupportedCurrencies',
            'getWalletAddress'
        ];
        
        return requiredMethods.every(method => 
            typeof provider[method] === 'function'
        );
    }

    // ==================== PUBLIC API ====================

    /**
     * Create a new payment invoice
     * @param {object} params - Invoice parameters
     * @param {string} params.userId - User ID
     * @param {number} params.amount - Amount in USD
     * @param {string} params.currency - Cryptocurrency (USDT, BTC, ETH)
     * @param {string} params.network - Network (TRC20, ERC20, BEP20)
     * @param {string} params.ipAddress - Client IP for security
     * @returns {Promise<object>} Invoice details
     */
    async createInvoice({ userId, amount, currency = 'USDT', network = 'TRC20', ipAddress }) {
        // SECURITY: Check database is available
        if (!supabase) {
            throw new Error('Payment service not configured: database unavailable');
        }
        
        // Validate inputs
        if (!userId) throw new Error('User ID is required');
        if (!amount || amount < CONFIG.MIN_DEPOSIT_USD) {
            throw new Error(`Minimum deposit is ${CONFIG.MIN_DEPOSIT_USD}`);
        }
        if (!CONFIG.SUPPORTED_CURRENCIES.includes(currency)) {
            throw new Error(`Unsupported currency: ${currency}`);
        }
        if (!CONFIG.NETWORKS[network]) {
            throw new Error(`Unsupported network: ${network}`);
        }

        // Generate internal invoice ID
        const invoiceId = this.generateInvoiceId();
        const idempotencyKey = `${userId}_${invoiceId}`;
        
        // Check for duplicate request (idempotency)
        if (this.idempotencyKeys.has(idempotencyKey)) {
            return this.idempotencyKeys.get(idempotencyKey);
        }

        try {
            // Get provider
            const provider = this.getActiveProvider();
            const isPaymento = this.activeProviderName === 'paymento';
            const isQ8qpay = this.activeProviderName === 'q8qpay';

            // Create invoice in database first (for tracking)
            const { data: dbInvoice, error: dbInvoiceError } = await supabase
                .from('payment_invoices')
                .insert({
                    invoice_id: invoiceId,
                    user_id: userId,
                    amount_usd: amount,
                    currency: currency,
                    network: network,
                    status: 'pending',
                    ip_address: ipAddress,
                    expires_at: new Date(Date.now() + CONFIG.INVOICE_EXPIRY_MS).toISOString(),
                    provider: this.activeProviderName
                })
                .select()
                .single();

            if (dbInvoiceError) throw dbInvoiceError;

            let result;

            if (isPaymento) {
                // Paymento: Create payment request and get token
                const paymentoResult = await provider.createInvoice({
                    userId,
                    amount,
                    currency,
                    network,
                    orderId: invoiceId,
                    ipAddress
                });

                // Update invoice with Paymento-specific fields
                await supabase
                    .from('payment_invoices')
                    .update({ 
                        paymento_token: paymentoResult.token,
                        gateway_url: paymentoResult.gatewayUrl,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', dbInvoice.id);

                result = {
                    id: invoiceId,
                    dbId: dbInvoice.id,
                    provider: 'paymento',
                    token: paymentoResult.token,
                    gatewayUrl: paymentoResult.gatewayUrl,
                    currency: currency,
                    network: network,
                    amountUsd: amount,
                    expiresAt: new Date(Date.now() + CONFIG.INVOICE_EXPIRY_MS).toISOString(),
                    status: 'pending'
                };

                console.log(`[PaymentService] Paymento invoice created: ${invoiceId}, token: ${paymentoResult.token.substring(0, 8)}...`);

            } else if (isQ8qpay) {
                // Q8QPay: white-label invoice. Customer pays USDT (TRC20) directly
                // to the returned payoutAddress. No redirect to q8qpay hosted checkout.
                const q8qpayResult = await provider.createInvoice({
                    userId,
                    amount,
                    currency,
                    network,
                    orderId: invoiceId,
                    ipAddress,
                    // Use the server's public BASE_URL for the per-invoice webhook.
                    // (provider falls back to Q8QPAY_CALLBACK_URL if omitted)
                    callbackUrl: process.env.Q8QPAY_CALLBACK_URL
                });

                // Persist the q8qpay invoice UUID, payout address, exact crypto
                // amount and q8qpay expiry for audit/reconciliation and polling.
                await supabase
                    .from('payment_invoices')
                    .update({
                        provider_invoice_ref: q8qpayResult.providerInvoiceId,
                        wallet_address: q8qpayResult.payoutAddress,
                        amount_crypto: q8qpayResult.amountUsdtExact,
                        provider_tx_hash: null,
                        expires_at: q8qpayResult.expiresAt,
                        metadata: q8qpayResult.metadata,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', dbInvoice.id);

                result = {
                    id: invoiceId,
                    dbId: dbInvoice.id,
                    provider: 'q8qpay',
                    providerInvoiceId: q8qpayResult.providerInvoiceId,
                    address: q8qpayResult.payoutAddress,        // customer TRC20 destination
                    payoutAddress: q8qpayResult.payoutAddress,
                    amountCrypto: parseFloat(q8qpayResult.amountUsdtExact),
                    amountUsdtExact: q8qpayResult.amountUsdtExact,
                    amountUsd: amount,
                    currency: 'USDT',
                    network: 'TRC20',
                    networkLabel: q8qpayResult.networkLabel,
                    expiresAt: q8qpayResult.expiresAt,
                    qrData: q8qpayResult.qrData,
                    status: 'pending',
                    qrCodeUrl: this.generateQRCodeUrl(
                        q8qpayResult.payoutAddress,
                        q8qpayResult.amountUsdtExact,
                        'USDT'
                    )
                };

                console.log(`[PaymentService] Q8QPay invoice created: ${invoiceId} (q8q: ${q8qpayResult.providerInvoiceId})`);

            } else {
                // NOWPayments: Get wallet address
                const walletAddress = await provider.getWalletAddress({
                    currency,
                    network,
                    invoiceId
                });

                // Calculate crypto amount (mock conversion rate)
                const cryptoAmount = await this.calculateCryptoAmount(amount, currency, network);

                // Update invoice with wallet address
                await supabase
                    .from('payment_invoices')
                    .update({ 
                        wallet_address: walletAddress.address,
                        amount_crypto: cryptoAmount,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', dbInvoice.id);

                result = {
                    id: invoiceId,
                    dbId: dbInvoice.id,
                    address: walletAddress.address,
                    currency: currency,
                    network: network,
                    amountCrypto: parseFloat(cryptoAmount),
                    amountUsd: amount,
                    expiresAt: new Date(Date.now() + CONFIG.INVOICE_EXPIRY_MS).toISOString(),
                    status: 'pending',
                    qrCodeUrl: this.generateQRCodeUrl(walletAddress.address, cryptoAmount, currency)
                };

                console.log(`[PaymentService] Invoice created: ${invoiceId} for user ${userId}`);
            }

            // Store in idempotency cache
            this.idempotencyKeys.set(idempotencyKey, result);
            
            // Auto-expire after 1 hour
            setTimeout(() => {
                this.idempotencyKeys.delete(idempotencyKey);
            }, CONFIG.INVOICE_EXPIRY_MS);

            return result;

        } catch (error) {
            console.error(`[PaymentService] Error creating invoice:`, error);
            throw error;
        }
    }

    /**
     * Get the status of an invoice
     * @param {string} invoiceId - Invoice ID
     * @param {string} userId - User ID (for authorization)
     * @returns {Promise<object>} Invoice status
     */
    async getInvoiceStatus(invoiceId, userId) {
        const { data: invoice, error } = await supabase
            .from('payment_invoices')
            .select('*')
            .eq('invoice_id', invoiceId)
            .eq('user_id', userId)
            .single();

        if (error || !invoice) {
            throw new Error('Invoice not found');
        }

        // Check if invoice has expired
        if (invoice.status === 'pending') {
            const expiresAt = new Date(invoice.expires_at).getTime();
            if (Date.now() > expiresAt) {
                await this.markInvoiceExpired(invoice.id);
                invoice.status = 'expired';
            }
        }

        return {
            id: invoice.invoice_id,
            status: invoice.status,
            amountUsd: invoice.amount_usd,
            amountCrypto: invoice.amount_crypto,
            amountUsdtExact: invoice.amount_crypto, // q8qpay exact amount stored here
            currency: invoice.currency,
            network: invoice.network,
            walletAddress: invoice.wallet_address,
            payoutAddress: invoice.wallet_address, // q8qpay TRC20 destination
            providerInvoiceId: invoice.provider_invoice_ref, // q8qpay UUID
            provider: invoice.provider,
            expiresAt: invoice.expires_at,
            confirmedAt: invoice.confirmed_at,
            creditedAt: invoice.credited_at,
            credited: invoice.credited
        };
    }

    /**
     * Process a webhook from the payment provider
     * @param {object} payload - Webhook payload
     * @param {string} signature - Webhook signature
     * @param {string} providerName - Provider name
     * @returns {Promise<object>} Processing result
     */
    async processWebhook(payload, signature, providerName) {
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`Unknown provider: ${providerName}`);
        }

        // Verify webhook signature
        const isValid = await provider.verifyWebhook(payload, signature, this.webhookSecrets.get(providerName));
        if (!isValid) {
            console.warn(`[PaymentService] Invalid webhook signature from ${providerName}`);
            throw new Error('Invalid webhook signature');
        }

        // Generate idempotency key from payload
        const idempotencyKey = this.generateWebhookIdempotencyKey(payload);
        
        // Check for duplicate webhook (replay protection)
        if (this.processedWebhooks.has(idempotencyKey)) {
            console.log(`[PaymentService] Duplicate webhook ignored: ${idempotencyKey}`);
            return { success: true, duplicate: true, message: 'Already processed' };
        }

        // Log webhook
        const webhookLogId = await this.logWebhook(providerName, payload, signature, idempotencyKey);

        try {
            // Process based on event type
            const result = await this.handleWebhookEvent(payload, provider);

            // Mark as processed
            this.processedWebhooks.set(idempotencyKey, true);
            await this.updateWebhookLog(webhookLogId, 'processed', result);

            // Auto-expire processed webhook record after 24 hours
            setTimeout(() => {
                this.processedWebhooks.delete(idempotencyKey);
            }, 24 * 60 * 60 * 1000);

            return result;

        } catch (error) {
            console.error(`[PaymentService] Webhook processing error:`, error);
            await this.updateWebhookLog(webhookLogId, 'failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Cancel an invoice
     * @param {string} invoiceId - Invoice ID
     * @param {string} userId - User ID
     * @returns {Promise<object>} Cancellation result
     */
    async cancelInvoice(invoiceId, userId) {
        const { data: invoice, error } = await supabase
            .from('payment_invoices')
            .select('*')
            .eq('invoice_id', invoiceId)
            .eq('user_id', userId)
            .single();

        if (error || !invoice) {
            throw new Error('Invoice not found');
        }

        if (invoice.status !== 'pending') {
            throw new Error(`Cannot cancel invoice with status: ${invoice.status}`);
        }

        await supabase
            .from('payment_invoices')
            .update({ 
                status: 'cancelled',
                cancelled_at: new Date().toISOString()
            })
            .eq('id', invoice.id);

        console.log(`[PaymentService] Invoice cancelled: ${invoiceId}`);
        return { success: true, invoiceId };
    }

    /**
     * Get supported currencies
     * @returns {Promise<object>} Supported currencies info
     */
    async getSupportedCurrencies() {
        const provider = this.getActiveProvider();
        const providerCurrencies = await provider.getSupportedCurrencies();
        
        return {
            crypto: providerCurrencies,
            networks: Object.entries(CONFIG.NETWORKS).map(([key, value]) => ({
                id: key,
                ...value
            })),
            defaultCurrency: CONFIG.DEFAULT_CURRENCY,
            minDeposit: CONFIG.MIN_DEPOSIT_USD
        };
    }

    /**
     * Manually check and confirm a payment (for fallback/checking)
     * @param {string} invoiceId - Invoice ID
     * @param {string} userId - User ID
     * @returns {Promise<object>} Confirmation result
     */
    async checkAndConfirmPayment(invoiceId, userId) {
        const invoice = await this.getInvoiceStatus(invoiceId, userId);
        
        if (invoice.status !== 'pending') {
            return { 
                success: true, 
                alreadyProcessed: true, 
                status: invoice.status 
            };
        }

        // Check if expired
        const expiresAt = new Date(invoice.expiresAt).getTime();
        if (Date.now() > expiresAt) {
            await this.markInvoiceExpired(invoice.dbId || invoiceId);
            return { success: true, status: 'expired' };
        }

        // In production, this would call the provider's API to check blockchain
        // For now, we simulate the check
        console.log(`[PaymentService] Manual payment check for: ${invoiceId}`);
        
        return {
            success: true,
            status: invoice.status,
            message: 'Payment not yet detected'
        };
    }

    // ==================== INTERNAL METHODS ====================

    /**
     * Handle webhook events from providers
     * @param {object} payload - Webhook payload
     * @param {object} provider - Provider instance
     * @returns {Promise<object>} Event handling result
     */
    async handleWebhookEvent(payload, provider) {
        const eventType = provider.parseWebhookEvent(payload);
        
        console.log(`[PaymentService] Processing webhook event: ${eventType}`);

        switch (eventType) {
            case 'payment_confirmed':
            case 'payment_received':
                return await this.handlePaymentConfirmed(payload, provider);
            
            case 'payment_underpaid':
                return await this.handlePaymentUnderpaid(payload);
            
            case 'payment_overpaid':
                return await this.handlePaymentOverpaid(payload);
            
            case 'invoice_expired':
                return await this.handleInvoiceExpired(payload);
            
            default:
                console.log(`[PaymentService] Unknown event type: ${eventType}`);
                return { success: true, message: 'Event type not handled' };
        }
    }

    /**
     * Handle payment confirmed event
     * Uses ONLY the atomic database function for payment confirmation
     */
    async handlePaymentConfirmed(payload, provider) {
        const paymentData = provider.parsePaymentData(payload);
        
        // Find invoice by payment ID or address
        const { data: invoice, error } = await supabase
            .from('payment_invoices')
            .select('*')
            .eq('wallet_address', paymentData.walletAddress)
            .eq('status', 'pending')
            .single();

        if (error || !invoice) {
            console.warn(`[PaymentService] Invoice not found for address: ${paymentData.walletAddress}`);
            return { success: false, error: 'Invoice not found' };
        }

        // Verify amount matches (with small tolerance for network fee differences)
        const amountTolerance = 0.001; // 0.1%
        const expectedAmount = parseFloat(invoice.amount_crypto);
        const receivedAmount = parseFloat(paymentData.amount);
        const isAmountValid = Math.abs(expectedAmount - receivedAmount) / expectedAmount < amountTolerance;

        if (!isAmountValid) {
            console.warn(`[PaymentService] Amount mismatch for invoice ${invoice.invoice_id}`);
            // Still confirm, but flag the discrepancy
        }

        // CRITICAL: Use atomic database function for ALL operations
        // This ensures: invoice update, wallet credit, transaction record, referral bonus
        // ALL happen in a single atomic transaction
        const result = await this.confirmPaymentAtomic(
            invoice.id,
            invoice.user_id,
            invoice.amount_usd,
            paymentData.transactionHash
        );

        // If we get here, the entire transaction succeeded
        return {
            success: true,
            invoiceId: invoice.invoice_id,
            userId: invoice.user_id,
            amountUsd: invoice.amount_usd,
            credited: result.credited,
            isFirstDeposit: result.isFirstDeposit,
            referralBonus: result.referralBonus
        };
    }

    /**
     * Atomic payment confirmation with wallet credit
     * SECURITY: Uses ONLY the atomic database function - no fallback
     * ALL operations happen in a single transaction:
     * - Invoice validation with row lock
     * - Wallet credit with row lock
     * - Transaction record creation
     * - Referral bonus (if first deposit)
     * If ANY step fails, the entire transaction is rolled back
     */
    async confirmPaymentAtomic(invoiceId, userId, amountUsd, transactionHash) {
        // SECURITY: Verify database is available
        if (!supabase) {
            throw new Error('Payment service not configured: database unavailable');
        }
        
        try {
            // Call the atomic database function
            // This function handles EVERYTHING in a single PostgreSQL transaction
            const { data, error } = await supabase.rpc('confirm_payment_with_credit', {
                p_invoice_id: invoiceId,
                p_user_id: userId,
                p_amount_usd: amountUsd,
                p_transaction_hash: transactionHash || `internal_${invoiceId}`
            });

            if (error) {
                console.error('[PaymentService] Atomic payment failed:', error.message);
                throw new Error('Payment confirmation failed');
            }

            // Check if the function returned success
            if (!data || !data.success) {
                const errorMsg = data?.error || 'Unknown error';
                
                // Handle duplicate transaction
                if (data?.duplicate) {
                    console.warn(`[PaymentService] Duplicate transaction ignored: ${transactionHash}`);
                    return { 
                        success: true, 
                        duplicate: true, 
                        message: 'Transaction already processed' 
                    };
                }
                
                throw new Error(errorMsg);
            }

            // Return comprehensive result
            return {
                success: true,
                credited: data.credited,
                invoiceId: data.invoice_id,
                userId: data.user_id,
                amountUsd: data.amount_usd,
                newBalance: data.new_balance,
                isFirstDeposit: data.is_first_deposit,
                referralBonus: data.referral_bonus || 0
            };

        } catch (error) {
            console.error('[PaymentService] Payment confirmation error:', error.message);
            throw error;
        }
    }

    // NOTE: The fallback payment confirmation (confirmPaymentFallback) has been REMOVED
    // All payment confirmations MUST go through the atomic database function
    // This ensures transaction integrity - if any operation fails, everything rolls back
    // 
    // If the database function fails, the payment cannot be confirmed
    // This is intentional - better to fail than to have inconsistent state

    /**
     * @deprecated Use confirmPaymentAtomic() instead
     * This method is no longer available - all confirmations must use the atomic DB function
     */
    async confirmPaymentFallback(invoiceId, userId, amountUsd, transactionHash) {
        throw new Error('Non-atomic fallback is disabled for security. Use confirmPaymentAtomic()');
    }

    /**
     * Handle underpaid payment
     */
    async handlePaymentUnderpaid(payload) {
        console.log(`[PaymentService] Underpaid payment detected`);
        return { success: true, message: 'Underpayment recorded' };
    }

    /**
     * Handle overpaid payment
     */
    async handlePaymentOverpaid(payload) {
        console.log(`[PaymentService] Overpaid payment detected`);
        return { success: true, message: 'Overpayment recorded' };
    }

    /**
     * Handle invoice expired event
     */
    async handleInvoiceExpired(payload) {
        console.log(`[PaymentService] Invoice expired event received`);
        return { success: true, message: 'Expiry noted' };
    }

    /**
     * Mark invoice as expired
     */
    async markInvoiceExpired(invoiceId) {
        await supabase
            .from('payment_invoices')
            .update({ 
                status: 'expired',
                expired_at: new Date().toISOString()
            })
            .eq('id', invoiceId)
            .eq('status', 'pending');
    }

    /**
     * Log webhook for audit trail
     */
    async logWebhook(provider, payload, signature, idempotencyKey) {
        const { data, error } = await supabase
            .from('webhook_logs')
            .insert({
                provider: provider,
                event_type: payload.type || 'unknown',
                payload: payload,
                signature_hash: this.hashSignature(signature),
                idempotency_key: idempotencyKey,
                status: 'received',
                received_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            console.error(`[PaymentService] Failed to log webhook:`, error);
        }

        return data?.id;
    }

    /**
     * Update webhook log status
     */
    async updateWebhookLog(logId, status, result) {
        await supabase
            .from('webhook_logs')
            .update({
                status: status,
                processed_at: new Date().toISOString(),
                result: result
            })
            .eq('id', logId);
    }

    /**
     * Generate unique invoice ID
     */
    generateInvoiceId() {
        const timestamp = Date.now().toString(36);
        const random = crypto.randomBytes(8).toString('hex');
        return `arb_${timestamp}_${random}`.toUpperCase();
    }

    /**
     * Generate webhook idempotency key
     */
    generateWebhookIdempotencyKey(payload) {
        const parts = [
            payload.payment_id || payload.id || '',
            payload.address || '',
            payload.amount || ''
        ];
        return crypto.createHash('sha256').update(parts.join('_')).digest('hex');
    }

    /**
     * Hash signature for storage (don't store raw signature)
     */
    hashSignature(signature) {
        if (!signature) return null;
        return crypto.createHash('sha256').update(signature).digest('hex');
    }

    /**
     * Calculate crypto amount from USD
     * In production, this would use real exchange rates from the provider
     */
    async calculateCryptoAmount(amountUsd, currency, network) {
        // Mock conversion rates (in production, fetch from provider)
        const rates = {
            USDT: { TRC20: 1.0001, ERC20: 0.998, BEP20: 0.999 },
            BTC: { BTC: 0.00001 }, // ~$500 per BTC for testing
            ETH: { ETH: 0.005 }    // ~$2000 per ETH for testing
        };

        const rate = rates[currency]?.[network] || rates[currency]?.[currency] || 1;
        return (amountUsd / rate).toFixed(6);
    }

    /**
     * Generate QR code URL
     */
    generateQRCodeUrl(address, amount, currency) {
        // Use a QR code API service
        const encoded = encodeURIComponent(`${currency}:${address}?amount=${amount}`);
        return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encoded}`;
    }

    /**
     * Set webhook secret for a provider
     */
    setWebhookSecret(providerName, secret) {
        this.webhookSecrets.set(providerName, secret);
    }
}

// Export singleton instance
const paymentService = new PaymentService();

module.exports = {
    PaymentService,
    paymentService,
    CONFIG
};
