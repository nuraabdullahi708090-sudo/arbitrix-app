/**
 * Demo Payment Provider
 * 
 * This provider simulates payment processing for development/testing.
 * It uses internal invoice IDs and simulates payment confirmation.
 * 
 * In production, replace with a real provider like NOWPayments, Cryptomus, or OxaPay.
 */

const PaymentProvider = require('./base');

class DemoProvider extends PaymentProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'demo';
    this.invoices = new Map(); // In-memory invoice storage (use database in production)
  }

  getSupportedNetworks() {
    return ['TRC20', 'ERC20', 'BEP20'];
  }

  async createInvoice(params) {
    const {
      userId,
      amount,
      network = 'TRC20',
      orderId
    } = params;

    // Validate amount
    const minAmount = this.getMinimumAmount(network);
    if (amount < minAmount) {
      throw new Error(`Minimum deposit is $${minAmount}`);
    }

    // Generate invoice ID
    const invoiceId = `inv_${Date.now()}_${userId}_${Math.random().toString(36).substr(2, 9)}`;
    const paymentAddress = this.getPaymentAddress(network);
    const cryptoAmount = this.calculateCryptoAmount(amount, network);

    // Invoice expires in 1 hour
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const invoice = {
      id: invoiceId,
      orderId: orderId || invoiceId,
      userId,
      amount,
      network,
      cryptoAmount,
      paymentAddress,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      provider: this.name,
      paymentReceived: false,
      paymentConfirmedAt: null
    };

    // Store invoice (in production, store in database)
    this.invoices.set(invoiceId, invoice);

    return {
      success: true,
      invoiceId,
      orderId: invoice.orderId,
      amount,
      network,
      cryptoAmount,
      paymentAddress,
      expiresAt: invoice.expiresAt,
      qrCodeUrl: this.generateQrCodeUrl(paymentAddress, cryptoAmount, network),
      status: 'pending'
    };
  }

  async getInvoiceStatus(invoiceId) {
    const invoice = this.invoices.get(invoiceId);
    
    if (!invoice) {
      return {
        success: false,
        error: 'Invoice not found'
      };
    }

    return {
      success: true,
      invoiceId,
      orderId: invoice.orderId,
      status: invoice.status,
      amount: invoice.amount,
      network: invoice.network,
      paymentReceived: invoice.paymentReceived,
      confirmedAt: invoice.paymentConfirmedAt,
      expiresAt: invoice.expiresAt
    };
  }

  async verifyWebhook(headers, body) {
    // In demo mode, we accept all webhooks
    // In production, implement proper signature verification
    return true;
  }

  async parseWebhook(payload) {
    // Demo provider doesn't receive real webhooks
    // This is a placeholder for webhook processing
    return {
      provider: this.name,
      eventType: payload.eventType || 'payment_received',
      invoiceId: payload.invoiceId,
      orderId: payload.orderId,
      status: payload.status,
      amount: payload.amount
    };
  }

  async cancelInvoice(invoiceId) {
    const invoice = this.invoices.get(invoiceId);
    
    if (!invoice) {
      return { success: false, error: 'Invoice not found' };
    }

    if (invoice.status !== 'pending') {
      return { success: false, error: 'Cannot cancel non-pending invoice' };
    }

    invoice.status = 'cancelled';
    this.invoices.set(invoiceId, invoice);

    return { success: true, invoiceId, status: 'cancelled' };
  }

  /**
   * Simulate payment receipt (for demo/testing)
   * In production, this would be called by webhook handler
   */
  async simulatePaymentReceived(invoiceId) {
    const invoice = this.invoices.get(invoiceId);
    
    if (!invoice) {
      return { success: false, error: 'Invoice not found' };
    }

    if (invoice.status !== 'pending') {
      return { success: false, error: 'Invoice is not pending' };
    }

    // Check if expired
    if (new Date() > new Date(invoice.expiresAt)) {
      invoice.status = 'expired';
      this.invoices.set(invoiceId, invoice);
      return { success: false, error: 'Invoice has expired' };
    }

    invoice.status = 'confirmed';
    invoice.paymentReceived = true;
    invoice.paymentConfirmedAt = new Date().toISOString();
    this.invoices.set(invoiceId, invoice);

    return {
      success: true,
      invoiceId,
      status: 'confirmed',
      amount: invoice.amount,
      confirmedAt: invoice.paymentConfirmedAt
    };
  }

  /**
   * Check and expire old invoices
   */
  async expireInvoices() {
    const now = new Date();
    let expiredCount = 0;

    for (const [invoiceId, invoice] of this.invoices) {
      if (invoice.status === 'pending' && new Date(invoice.expiresAt) < now) {
        invoice.status = 'expired';
        this.invoices.set(invoiceId, invoice);
        expiredCount++;
      }
    }

    return { expiredCount };
  }

  /**
   * Get invoice by ID
   */
  getInvoice(invoiceId) {
    return this.invoices.get(invoiceId);
  }

  /**
   * Update invoice status
   */
  updateInvoice(invoiceId, updates) {
    const invoice = this.invoices.get(invoiceId);
    if (invoice) {
      Object.assign(invoice, updates);
      this.invoices.set(invoiceId, invoice);
    }
    return invoice;
  }

  /**
   * Generate QR code URL
   */
  generateQrCodeUrl(address, amount, network) {
    // In production, use a real QR code service
    const uri = `tron:${address}?amount=${amount}`;
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}`;
  }

  getMinimumAmount(network = 'TRC20') {
    return 10; // $10 minimum for demo
  }
}

module.exports = DemoProvider;
