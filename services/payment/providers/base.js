/**
 * Base Payment Provider Interface
 * 
 * This abstract class defines the interface that all payment providers must implement.
 * Each provider handles communication with a specific payment gateway (NOWPayments, Cryptomus, etc.)
 * 
 * To add a new provider:
 * 1. Create a new file in providers/ directory
 * 2. Extend PaymentProvider class
 * 3. Implement all required methods
 * 4. Register the provider in PaymentService
 */

class PaymentProvider {
  constructor(config = {}) {
    if (new.target === PaymentProvider) {
      throw new Error('PaymentProvider is abstract and cannot be instantiated directly');
    }
    this.config = config;
    this.name = 'base';
  }

  /**
   * Get provider name
   * @returns {string} Provider identifier
   */
  getName() {
    return this.name;
  }

  /**
   * Get supported networks/currencies
   * @returns {string[]} Array of supported network codes
   */
  getSupportedNetworks() {
    throw new Error('Method getSupportedNetworks() must be implemented');
  }

  /**
   * Create a payment invoice
   * @param {Object} params - Invoice parameters
   * @param {string} params.userId - User ID
   * @param {number} params.amount - Amount in USD
   * @param {string} params.network - Network (e.g., 'TRC20', 'ERC20')
   * @param {string} params.orderId - Internal order ID
   * @returns {Promise<Object>} Invoice data
   */
  async createInvoice(params) {
    throw new Error('Method createInvoice() must be implemented');
  }

  /**
   * Get invoice status from provider
   * @param {string} invoiceId - Provider's invoice ID
   * @returns {Promise<Object>} Invoice status
   */
  async getInvoiceStatus(invoiceId) {
    throw new Error('Method getInvoiceStatus() must be implemented');
  }

  /**
   * Verify webhook signature
   * @param {Object} headers - Request headers
   * @param {string|Object} body - Request body (raw or parsed)
   * @returns {boolean} True if signature is valid
   */
  async verifyWebhook(headers, body) {
    throw new Error('Method verifyWebhook() must be implemented');
  }

  /**
   * Parse webhook payload
   * @param {Object} payload - Raw webhook payload
   * @returns {Object} Normalized payment event
   */
  async parseWebhook(payload) {
    throw new Error('Method parseWebhook() must be implemented');
  }

  /**
   * Cancel an invoice
   * @param {string} invoiceId - Provider's invoice ID
   * @returns {Promise<boolean>} Success status
   */
  async cancelInvoice(invoiceId) {
    throw new Error('Method cancelInvoice() must be implemented');
  }

  /**
   * Get minimum payment amount for a network
   * @param {string} network - Network code
   * @returns {number} Minimum amount in USD
   */
  getMinimumAmount(network = 'TRC20') {
    return 10; // Default minimum
  }

  /**
   * Get payment address for a network
   * @param {string} network - Network code
   * @returns {string} Wallet address
   */
  getPaymentAddress(network) {
    const addresses = {
      TRC20: this.config.addresses?.TRC20 || 'TDQ2Ymmejp2MXxawBdbYkxqjZ7tTkMyMJR',
      ERC20: this.config.addresses?.ERC20 || '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      BEP20: this.config.addresses?.BEP20 || '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
    };
    return addresses[network] || addresses.TRC20;
  }

  /**
   * Calculate crypto amount from USD
   * @param {number} usdAmount - Amount in USD
   * @param {string} network - Network code
   * @returns {number} Crypto amount
   */
  calculateCryptoAmount(usdAmount, network) {
    // Simple conversion with fee simulation
    const feeRate = 0.0018; // 0.18% fee
    return (usdAmount / (1 + feeRate)).toFixed(6);
  }
}

module.exports = PaymentProvider;
