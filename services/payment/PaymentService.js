/**
 * Payment Service
 * 
 * Central service for handling all payment operations.
 * Supports multiple payment providers and ensures transaction integrity.
 * 
 * Usage:
 *   const paymentService = new PaymentService(supabase);
 *   await paymentService.createDeposit(userId, amount, network);
 *   await paymentService.processWebhook(payload, provider);
 * 
 * To add a new provider:
 *   const MyProvider = require('./providers/myprovider');
 *   paymentService.registerProvider('myprovider', new MyProvider(config));
 */

const crypto = require('crypto');

// Import providers
const DemoProvider = require('./providers/demo');

class PaymentService {
  constructor(supabase, config = {}) {
    this.supabase = supabase;
    this.providers = new Map();
    this.activeProvider = null;
    this.config = config;
    
    // Register default providers
    this.registerDefaultProviders();
    
    // Load active provider from config
    this.setActiveProvider(config.activeProvider || 'demo');
  }

  /**
   * Register default providers
   */
  registerDefaultProviders() {
    // Demo provider (always available)
    this.registerProvider('demo', new DemoProvider({
      addresses: this.config.addresses || {}
    }));
  }

  /**
   * Register a payment provider
   * @param {string} name - Provider identifier
   * @param {PaymentProvider} provider - Provider instance
   */
  registerProvider(name, provider) {
    this.providers.set(name, provider);
    console.log(`[PaymentService] Registered provider: ${name}`);
  }

  /**
   * Set the active payment provider
   * @param {string} name - Provider identifier
   */
  setActiveProvider(name) {
    if (!this.providers.has(name)) {
      throw new Error(`Provider '${name}' is not registered`);
    }
    this.activeProvider = name;
    console.log(`[PaymentService] Active provider: ${name}`);
  }

  /**
   * Get the active provider
   * @returns {PaymentProvider}
   */
  getProvider() {
    return this.providers.get(this.activeProvider);
  }

  /**
   * Get provider by name
   * @param {string} name - Provider identifier
   * @returns {PaymentProvider}
   */
  getProviderByName(name) {
    return this.providers.get(name);
  }

  /**
   * Get all registered providers
   * @returns {Map<string, PaymentProvider>}
   */
  getAllProviders() {
    return this.providers;
  }

  /**
   * Get supported networks from active provider
   * @returns {string[]}
   */
  getSupportedNetworks() {
    return this.getProvider().getSupportedNetworks();
  }

  /**
   * Create a new deposit/invoice
   * @param {string} userId - User ID
   * @param {number} amount - Amount in USD
   * @param {string} network - Network (TRC20, ERC20, etc.)
   * @returns {Promise<Object>} Deposit data
   */
  async createDeposit(userId, amount, network = 'TRC20') {
    const provider = this.getProvider();
    
    // Validate network
    const supportedNetworks = provider.getSupportedNetworks();
    if (!supportedNetworks.includes(network)) {
      throw new Error(`Network '${network}' is not supported. Supported: ${supportedNetworks.join(', ')}`);
    }

    // Validate minimum amount
    const minAmount = provider.getMinimumAmount(network);
    if (amount < minAmount) {
      throw new Error(`Minimum deposit is $${minAmount}`);
    }

    // Generate internal order ID
    const orderId = `order_${Date.now()}_${userId}_${crypto.randomBytes(4).toString('hex')}`;

    try {
      // Create invoice with provider
      const invoice = await provider.createInvoice({
        userId,
        amount,
        network,
        orderId
      });

      // Store deposit record in database
      const { data: deposit, error } = await this.supabase
        .from('deposits')
        .insert({
          user_id: userId,
          amount: amount,
          network: network,
          address: invoice.paymentAddress,
          invoice_id: invoice.invoiceId,
          order_id: orderId,
          crypto_amount: invoice.cryptoAmount,
          status: 'pending',
          provider: this.activeProvider,
          expires_at: invoice.expiresAt,
          qr_code_url: invoice.qrCodeUrl
        })
        .select()
        .single();

      if (error) {
        console.error('[PaymentService] Database error creating deposit:', error);
        throw new Error('Failed to create deposit record');
      }

      console.log(`[PaymentService] Created deposit ${deposit.id} for user ${userId}: $${amount} ${network}`);

      return {
        success: true,
        depositId: deposit.id,
        invoiceId: invoice.invoiceId,
        orderId,
        amount,
        network,
        cryptoAmount: invoice.cryptoAmount,
        paymentAddress: invoice.paymentAddress,
        expiresAt: invoice.expiresAt,
        qrCodeUrl: invoice.qrCodeUrl,
        status: 'pending'
      };

    } catch (error) {
      console.error('[PaymentService] Error creating deposit:', error);
      throw error;
    }
  }

  /**
   * Get deposit status
   * @param {string} invoiceId - Invoice ID
   * @param {string} userId - User ID (for authorization)
   * @returns {Promise<Object>}
   */
  async getDepositStatus(invoiceId, userId) {
    // Fetch deposit from database
    const { data: deposit, error } = await this.supabase
      .from('deposits')
      .select('*')
      .eq('invoice_id', invoiceId)
      .eq('user_id', userId)
      .single();

    if (error || !deposit) {
      return { success: false, error: 'Deposit not found' };
    }

    // Check expiration
    if (deposit.status === 'pending' && new Date(deposit.expires_at) < new Date()) {
      // Update status to expired
      await this.updateDepositStatus(deposit.id, 'expired');
      deposit.status = 'expired';
    }

    return {
      success: true,
      depositId: deposit.id,
      invoiceId: deposit.invoice_id,
      status: deposit.status,
      amount: deposit.amount,
      network: deposit.network,
      creditedAmount: deposit.status === 'confirmed' ? deposit.amount : 0,
      confirmedAt: deposit.confirmed_at,
      expiresAt: deposit.expires_at
    };
  }

  /**
   * Update deposit status
   * @param {string} depositId - Deposit ID
   * @param {string} status - New status
   * @param {Object} metadata - Additional metadata
   */
  async updateDepositStatus(depositId, status, metadata = {}) {
    const updates = {
      status,
      ...metadata
    };

    if (status === 'confirmed') {
      updates.confirmed_at = new Date().toISOString();
    }

    const { error } = await this.supabase
      .from('deposits')
      .update(updates)
      .eq('id', depositId);

    if (error) {
      console.error('[PaymentService] Error updating deposit status:', error);
      throw error;
    }

    console.log(`[PaymentService] Updated deposit ${depositId} status to ${status}`);
  }

  /**
   * Get deposit by ID
   * @param {string} depositId - Deposit ID
   */
  async getDeposit(depositId) {
    const { data, error } = await this.supabase
      .from('deposits')
      .select('*')
      .eq('id', depositId)
      .single();

    return { data, error: error || null };
  }

  /**
   * Process payment confirmation
   * @param {string} invoiceId - Invoice ID from provider
   * @param {string} providerName - Provider name (optional, uses active if not specified)
   */
  async processPaymentConfirmation(invoiceId, providerName = null) {
    const provider = providerName ? this.getProviderByName(providerName) : this.getProvider();
    
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`);
    }

    // Get deposit by invoice ID
    const { data: deposit, error } = await this.supabase
      .from('deposits')
      .select('*')
      .eq('invoice_id', invoiceId)
      .single();

    if (error || !deposit) {
      console.error('[PaymentService] Deposit not found for invoice:', invoiceId);
      return { success: false, error: 'Deposit not found' };
    }

    // Check if already confirmed (idempotency)
    if (deposit.status === 'confirmed') {
      console.log(`[PaymentService] Deposit ${deposit.id} already confirmed`);
      return { success: true, alreadyConfirmed: true, depositId: deposit.id };
    }

    // Check if expired
    if (new Date(deposit.expires_at) < new Date()) {
      await this.updateDepositStatus(deposit.id, 'expired');
      return { success: false, error: 'Deposit has expired' };
    }

    // Update to confirmed
    await this.updateDepositStatus(deposit.id, 'confirmed', {
      provider: providerName || this.activeProvider
    });

    // Credit user's wallet
    await this.creditUserWallet(deposit.user_id, deposit.amount);

    // Add transaction history
    await this.addTransactionHistory(deposit.user_id, 'Deposit', deposit.amount, `USDT (${deposit.network})`);

    console.log(`[PaymentService] Payment confirmed for deposit ${deposit.id}: $${deposit.amount}`);

    return {
      success: true,
      depositId: deposit.id,
      userId: deposit.user_id,
      amount: deposit.amount,
      status: 'confirmed'
    };
  }

  /**
   * Process webhook from payment provider
   * @param {Object} payload - Webhook payload
   * @param {Object} headers - Request headers
   * @param {string} providerName - Provider name
   */
  async processWebhook(payload, headers, providerName = null) {
    const provider = providerName ? this.getProviderByName(providerName) : this.getProvider();
    
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`);
    }

    // Verify webhook signature
    const isValid = await provider.verifyWebhook(headers, payload);
    if (!isValid) {
      console.error('[PaymentService] Invalid webhook signature');
      throw new Error('Invalid webhook signature');
    }

    // Parse webhook payload
    const event = await provider.parseWebhook(payload);
    
    // Handle different event types
    switch (event.eventType) {
      case 'payment_received':
      case 'payment_confirmed':
        return await this.processPaymentConfirmation(event.invoiceId, providerName);
      
      case 'payment_expired':
        return await this.handleExpiredInvoice(event.invoiceId);
      
      case 'payment_cancelled':
        return await this.handleCancelledInvoice(event.invoiceId);
      
      default:
        console.log(`[PaymentService] Unknown webhook event: ${event.eventType}`);
        return { success: true, event: 'ignored' };
    }
  }

  /**
   * Handle expired invoice
   */
  async handleExpiredInvoice(invoiceId) {
    const { data: deposit } = await this.supabase
      .from('deposits')
      .select('*')
      .eq('invoice_id', invoiceId)
      .single();

    if (deposit && deposit.status === 'pending') {
      await this.updateDepositStatus(deposit.id, 'expired');
      return { success: true, depositId: deposit.id, status: 'expired' };
    }

    return { success: false, error: 'Deposit not found or not pending' };
  }

  /**
   * Handle cancelled invoice
   */
  async handleCancelledInvoice(invoiceId) {
    const { data: deposit } = await this.supabase
      .from('deposits')
      .select('*')
      .eq('invoice_id', invoiceId)
      .single();

    if (deposit && deposit.status === 'pending') {
      await this.updateDepositStatus(deposit.id, 'cancelled');
      return { success: true, depositId: deposit.id, status: 'cancelled' };
    }

    return { success: false, error: 'Deposit not found or not pending' };
  }

  /**
   * Credit user's wallet balance
   */
  async creditUserWallet(userId, amount) {
    const { data: wallet, error } = await this.supabase
      .from('wallets')
      .select('live_balance')
      .eq('user_id', userId)
      .single();

    if (error || !wallet) {
      console.error('[PaymentService] Wallet not found for user:', userId);
      throw new Error('Wallet not found');
    }

    const newBalance = (wallet.live_balance || 0) + amount;

    await this.supabase
      .from('wallets')
      .update({ live_balance: newBalance })
      .eq('user_id', userId);

    console.log(`[PaymentService] Credited $${amount} to user ${userId} wallet. New balance: $${newBalance}`);
  }

  /**
   * Add transaction history entry
   */
  async addTransactionHistory(userId, type, amount, detail) {
    await this.supabase
      .from('transactions')
      .insert({
        user_id: userId,
        type,
        amount,
        detail: detail || ''
      });
  }

  /**
   * Get user's deposit history
   */
  async getUserDeposits(userId, limit = 50) {
    const { data, error } = await this.supabase
      .from('deposits')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    return { data, error };
  }

  /**
   * Get deposit statistics
   */
  async getDepositStats(userId = null) {
    let query = this.supabase
      .from('deposits')
      .select('status, amount', { count: 'exact' });

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;

    if (error) {
      return { success: false, error };
    }

    const stats = {
      total: data.length,
      pending: data.filter(d => d.status === 'pending').length,
      confirmed: data.filter(d => d.status === 'confirmed').length,
      expired: data.filter(d => d.status === 'expired').length,
      cancelled: data.filter(d => d.status === 'cancelled').length,
      totalDeposited: data
        .filter(d => d.status === 'confirmed')
        .reduce((sum, d) => sum + d.amount, 0)
    };

    return { success: true, stats };
  }

  /**
   * Get all deposits (admin)
   */
  async getAllDeposits(options = {}) {
    const { limit = 100, offset = 0, status, userId, network } = options;
    
    let query = this.supabase
      .from('deposits')
      .select('*, users(name, email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }
    if (userId) {
      query = query.eq('user_id', userId);
    }
    if (network) {
      query = query.eq('network', network);
    }

    const { data, error, count } = await query;

    return { data, error, total: count };
  }

  /**
   * Cancel a deposit (admin or user)
   */
  async cancelDeposit(depositId, userId = null) {
    // Get deposit
    const { data: deposit, error } = await this.supabase
      .from('deposits')
      .select('*')
      .eq('id', depositId)
      .single();

    if (error || !deposit) {
      return { success: false, error: 'Deposit not found' };
    }

    // Check ownership if userId provided
    if (userId && deposit.user_id !== userId) {
      return { success: false, error: 'Unauthorized' };
    }

    // Can only cancel pending deposits
    if (deposit.status !== 'pending') {
      return { success: false, error: 'Can only cancel pending deposits' };
    }

    // Update status
    await this.updateDepositStatus(depositId, 'cancelled');

    return { success: true, depositId, status: 'cancelled' };
  }

  /**
   * Retry failed webhook processing (admin)
   */
  async retryDeposit(depositId) {
    const { data: deposit, error } = await this.supabase
      .from('deposits')
      .select('*')
      .eq('id', depositId)
      .single();

    if (error || !deposit) {
      return { success: false, error: 'Deposit not found' };
    }

    if (deposit.status !== 'pending') {
      return { success: false, error: 'Can only retry pending deposits' };
    }

    // Check expiration
    if (new Date(deposit.expires_at) < new Date()) {
      await this.updateDepositStatus(depositId, 'expired');
      return { success: false, error: 'Deposit has expired' };
    }

    // Process as if payment was received
    return await this.processPaymentConfirmation(deposit.invoice_id);
  }
}

module.exports = PaymentService;
