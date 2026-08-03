# Payment System Architecture

## Overview

The Payment System for Arbitrix AI is designed with a modular, provider-based architecture that allows for easy integration of multiple cryptocurrency payment providers without modifying the core application code.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (index.html)                     │
│   - Deposit Modal                                                │
│   - QR Code Display                                              │
│   - Real-time Status Updates                                     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                │ HTTP API
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      server.js (Express)                        │
│   - Authentication Middleware                                   │
│   - API Routes                                                  │
│   - Webhook Endpoints                                           │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   PaymentService (services/)                    │
│   - createInvoice()                                             │
│   - getInvoiceStatus()                                          │
│   - processWebhook()                                             │
│   - cancelInvoice()                                             │
│   - verifyWebhook()                                             │
│   - getSupportedCurrencies()                                    │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Provider Interface                            │
│              (services/providers/base/)                          │
│   - Abstract methods all providers must implement               │
└───────────────────────────────┬─────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│  NOWPayments  │     │   Cryptomus   │     │    OxaPay     │
│   Provider    │     │    Provider   │     │    Provider   │
└───────────────┘     └───────────────┘     └───────────────┘
```

## File Structure

```
arbitrix-app/
├── services/
│   ├── PaymentService.js           # Main payment service
│   └── providers/
│       ├── base/
│       │   └── ProviderInterface.js # Abstract base class
│       ├── nowpayments.js          # NOWPayments implementation
│       ├── cryptomus.js           # Cryptomus (to implement)
│       └── oxapay.js              # OxaPay (to implement)
├── supabase/
│   └── migrations/
│       ├── 001_create_password_reset_tokens.sql
│       └── 002_payment_system.sql  # Payment tables
└── server.js                       # Express server with API routes
```

## How to Add a New Payment Provider

### Step 1: Create the Provider File

Create a new file at `services/providers/{provider-name}.js`:

```javascript
const { ProviderInterface } = require('./base/ProviderInterface');

class NewProvider extends ProviderInterface {
    constructor() {
        super();
        this.name = 'newprovider';
    }

    // Implement all required methods from ProviderInterface
}

module.exports = { NewProvider };
```

### Step 2: Register the Provider

In `server.js`, add the provider registration:

```javascript
const { NewProvider } = require('./services/providers/newprovider');
const { paymentService } = require('./services/PaymentService');

// Create and initialize provider
const newProvider = new NewProvider();
paymentService.registerProvider('newprovider', newProvider);
paymentService.setWebhookSecret('newprovider', process.env.NEWPROVIDER_WEBHOOK_SECRET);
```

### Step 3: Set Environment Variables

```bash
PAYMENT_PROVIDER=newprovider
NEWPROVIDER_API_KEY=your_key
NEWPROVIDER_WEBHOOK_SECRET=your_secret
```

## Security Features

### 1. Webhook Security
- **Signature Verification**: All webhooks require valid HMAC-SHA256 signatures
- **Reject Without Secret**: Webhooks are rejected if webhook secret is not configured
- **Timing-Safe Comparison**: Prevents timing attacks using `crypto.timingSafeEqual`
- **Idempotency**: Duplicate webhooks detected via unique idempotency keys
- **Replay Protection**: Processed webhook keys expire after 24 hours

### 2. Wallet Credit Protection
- **Transaction Hash Uniqueness**: UNIQUE constraint prevents double-crediting
- **Row Locking**: `FOR UPDATE` locks prevent race conditions
- **Atomic Transactions**: Single database function handles entire credit operation
- **Double-Check Validation**: Pre-confirmation status check before credit

### 3. Invoice Security
- **User Ownership**: Users can only access their own invoices
- **Immutable Amounts**: Invoice amounts cannot be modified after creation
- **Status Enforcement**: Only pending invoices can be confirmed
- **Expiration Handling**: Expired invoices cannot be paid

### 4. API Security
- **Authentication**: All payment endpoints require JWT authentication
- **Authorization**: Users can only access their own resources
- **Rate Limiting**: 10 requests per minute per IP
- **Input Validation**: Strict type checking and sanitization
- **Error Handling**: Generic error messages prevent information leakage

## Database Tables

### payment_invoices
| Column | Type | Security |
|--------|------|----------|
| invoice_id | TEXT UNIQUE | Prevents duplicate invoices |
| user_id | UUID FK | Enforces user ownership |
| amount_usd | DECIMAL CHECK | Prevents invalid amounts |
| status | TEXT CHECK | Prevents invalid states |
| transaction_hash | TEXT UNIQUE | Prevents double-crediting |
| ip_address | INET | Audit trail |

### webhook_logs
| Column | Type | Security |
|--------|------|----------|
| idempotency_key | TEXT | Duplicate detection |
| signature_hash | TEXT | Signature audit (not raw) |
| status | TEXT | Processing state |

## Environment Variables

```bash
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Provider-specific
NOWPAYMENTS_API_KEY=your-api-key
NOWPAYMENTS_IPN_SECRET=your-webhook-secret

# Optional
PAYMENT_PROVIDER=nowpayments
```
