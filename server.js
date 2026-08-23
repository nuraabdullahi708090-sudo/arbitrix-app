const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

// Production configuration startup guard (pure, dependency-free)
const { validateProductionConfig } = require('./productionGuard');

// Payment Service Layer
const { paymentService, PaymentService } = require('./services/PaymentService');
const { nowPaymentsProvider } = require('./services/providers/nowpayments');
const { paymentoProvider, PAYMENTO_STATUS } = require('./services/providers/paymento');
const { q8qpayProvider, Q8QPAY_STATUS } = require('./services/providers/q8qpay');

// KYC Verification Service
const { KYCService, VERIFICATION_STATUS, VERIFICATION_LEVELS } = require('./services/KYCService');

// TOTP 2FA Service (RFC 6238 compliant)
// NOTE: TOTP is currently DISABLED in favor of Email 2FA
// Set feature flag '2fa_type' to 'totp' in feature_flags table to re-enable
const TOTPService = require('./services/TOTPService');

// Email 2FA Service (Primary 2FA method)
const Email2FAService = require('./services/Email2FAService');

// Feature flag cache (refreshes every 5 minutes)
let featureFlagCache = {
    '2fa_type': 'email' // Default to email 2FA
};
let featureFlagCacheTime = 0;
const FEATURE_FLAG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Encryption key for TOTP secrets (in production, use secure key management)
const TOTP_ENCRYPTION_KEY = process.env.TOTP_ENCRYPTION_KEY || 'default-kyc-encryption-key-change-in-prod';

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-in-production';
const RESET_TOKEN_EXPIRY = 3600000; // 1 hour in milliseconds
// Base URL for password reset links and other absolute URLs
// Production: Set BASE_URL=https://arbitrix.pro in environment
// Development: Defaults to localhost:8080
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

// Email configuration (use environment variables in production)
const EMAIL_CONFIG = {
  apiKey: process.env.RESEND_API_KEY || '',
  from: process.env.EMAIL_FROM || 'Arbitrix AI <noreply@arbitrix.ai>'
};

// ---------- PRODUCTION STARTUP GUARD ----------
// Fail fast (before any service init / port binding) if production is missing
// required configuration or is using a known development default. Secret values
// are NEVER printed — only which variable is missing/default. In non-production
// environments this always passes, preserving existing local-dev fallbacks.
const _prodConfig = validateProductionConfig(process.env);
if (!_prodConfig.ok) {
  console.error('🛑 Production configuration invalid. Refusing to start:');
  _prodConfig.errors.forEach(function (msg) { console.error('  - ' + msg); });
  process.exit(1);
}

// Rate limiting configuration
// Limits explain:
// - IP rate limit: 5 requests per 15 minutes per IP
//   Prevents distributed attacks from the same source
// - Email rate limit: 3 requests per hour per email
//   Prevents targeting a specific user from multiple IPs
//   A legitimate user won't need more than 3 resets in an hour
const RATE_LIMIT_CONFIG = {
  ip: {
    maxRequests: parseInt(process.env.RATE_LIMIT_IP_MAX) || 5,
    windowMs: (parseInt(process.env.RATE_LIMIT_IP_WINDOW) || 15) * 60 * 1000 // 15 minutes
  },
  email: {
    maxRequests: parseInt(process.env.RATE_LIMIT_EMAIL_MAX) || 3,
    windowMs: (parseInt(process.env.RATE_LIMIT_EMAIL_WINDOW) || 60) * 60 * 1000 // 1 hour
  }
};

// In-memory rate limit store
// In production, use Redis for distributed rate limiting
const rateLimitStore = {
  ip: new Map(),
  email: new Map()
};

// Cleanup old entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  
  // Clean IP store
  for (const [key, data] of rateLimitStore.ip.entries()) {
    if (now - data.windowStart > RATE_LIMIT_CONFIG.ip.windowMs) {
      rateLimitStore.ip.delete(key);
    }
  }
  
  // Clean email store
  for (const [key, data] of rateLimitStore.email.entries()) {
    if (now - data.windowStart > RATE_LIMIT_CONFIG.email.windowMs) {
      rateLimitStore.email.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Check rate limit for forgot password endpoint
 * @param {string} ip - Client IP address
 * @param {string} email - Email address being reset
 * @returns {object} - { allowed: boolean, remaining: number, resetIn: number }
 */
function checkForgotPasswordRateLimit(ip, email) {
  const now = Date.now();
  
  // Check IP rate limit
  let ipData = rateLimitStore.ip.get(ip);
  if (!ipData || now - ipData.windowStart > RATE_LIMIT_CONFIG.ip.windowMs) {
    // Start new window
    ipData = { count: 0, windowStart: now };
    rateLimitStore.ip.set(ip, ipData);
  }
  
  if (ipData.count >= RATE_LIMIT_CONFIG.ip.maxRequests) {
    const resetIn = Math.ceil((ipData.windowStart + RATE_LIMIT_CONFIG.ip.windowMs - now) / 1000);
    return {
      allowed: false,
      type: 'ip',
      remaining: 0,
      resetIn: resetIn
    };
  }
  
  // Check email rate limit
  let emailData = rateLimitStore.email.get(email);
  if (!emailData || now - emailData.windowStart > RATE_LIMIT_CONFIG.email.windowMs) {
    // Start new window
    emailData = { count: 0, windowStart: now };
    rateLimitStore.email.set(email, emailData);
  }
  
  if (emailData.count >= RATE_LIMIT_CONFIG.email.maxRequests) {
    const resetIn = Math.ceil((emailData.windowStart + RATE_LIMIT_CONFIG.email.windowMs - now) / 1000);
    return {
      allowed: false,
      type: 'email',
      remaining: 0,
      resetIn: resetIn
    };
  }
  
  // Increment counts
  ipData.count++;
  emailData.count++;
  
  return {
    allowed: true,
    remaining: Math.min(
      RATE_LIMIT_CONFIG.ip.maxRequests - ipData.count,
      RATE_LIMIT_CONFIG.email.maxRequests - emailData.count
    ),
    resetIn: 0
  };
}

// Create Resend client
let resendClient = null;

function getResendClient() {
  if (!resendClient && EMAIL_CONFIG.apiKey) {
    resendClient = new Resend(EMAIL_CONFIG.apiKey);
  }
  return resendClient;
}

// ---------- REPLACE WITH YOUR SUPABASE CREDENTIALS ----------
const supabaseUrl = 'https://gabqgewycepcyyzqkvvt.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhYnFnZXd5Y2VwY3l5enFrdnZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mjk2ODAsImV4cCI6MjA5ODMwNTY4MH0.xTEZ2-5S9I1deTEJ0xWYk-_diSveYQSYFWHuvod7HWs';
// Service role key bypasses RLS - needed for password_reset_tokens table and
// for KYC operations once RLS is enabled on the KYC tables (migration 010).
// PRODUCTION: SUPABASE_SERVICE_KEY is required; if it is missing we refuse to
// start so the admin client never silently degrades to the anon key (which
// would bypass none of the RLS policies and would expose KYC ops to failure).
// NON-PRODUCTION: preserve the existing local-dev fallback to the anon key so
// development keeps working without extra setup (productionGuard also allows
// this). Note: with RLS enabled on KYC tables, KYC DB/Storage operations in dev
// additionally require SUPABASE_SERVICE_KEY to function; non-KYC admin ops are
// unaffected because their tables keep their USING(true) anon policies.
let supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseServiceKey || supabaseServiceKey.trim() === '') {
  if (process.env.NODE_ENV === 'production') {
    console.error('🛑 SUPABASE_SERVICE_KEY is required in production. The admin Supabase client cannot fall back to the anon key in production (RLS-protected tables such as KYC would be inaccessible). Set SUPABASE_SERVICE_KEY and restart.');
    process.exit(1);
  }
  console.warn('[Server] SUPABASE_SERVICE_KEY not set; falling back to anon key for local development. KYC operations require the service key once RLS is enabled.');
  supabaseServiceKey = supabaseKey;
}
// ------------------------------------------------------------

const supabase = createClient(supabaseUrl, supabaseKey);
// Separate client with service role for RLS-protected operations
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// ============================================
// PAYMENT SERVICE INITIALIZATION
// ============================================
// Register payment providers and set up webhook secrets

// Register NOWPayments provider
paymentService.registerProvider('nowpayments', nowPaymentsProvider);

// Register Paymento provider
paymentService.registerProvider('paymento', paymentoProvider);

// Register Q8QPay provider (white-label USDT TRC20; additive, does not affect Paymento)
paymentService.registerProvider('q8qpay', q8qpayProvider);

// Set webhook secrets for providers
paymentService.setWebhookSecret('nowpayments', process.env.NOWPAYMENTS_IPN_SECRET || 'your-webhook-secret');
paymentService.setWebhookSecret('paymento', process.env.PAYMENTO_SECRET_KEY || '');
paymentService.setWebhookSecret('q8qpay', process.env.Q8QPAY_WEBHOOK_SECRET || '');

// Initialize providers with config if available
if (process.env.NOWPAYMENTS_API_KEY) {
    nowPaymentsProvider.initialize({
        apiKey: process.env.NOWPAYMENTS_API_KEY,
        ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET,
        sandbox: process.env.NOWPAYMENTS_SANDBOX === 'true'
    });
}

if (process.env.PAYMENTO_API_KEY && process.env.PAYMENTO_SECRET_KEY) {
    paymentoProvider.initialize({
        apiKey: process.env.PAYMENTO_API_KEY,
        secretKey: process.env.PAYMENTO_SECRET_KEY,
        sandbox: process.env.PAYMENTO_SANDBOX === 'true',
        returnUrl: `${BASE_URL}/api/paymento/return`,
        ipnUrl: `${BASE_URL}/api/webhook/paymento`
    });
    console.log('[Server] Paymento provider initialized');
} else {
    console.log('[Server] Paymento provider not initialized (missing API_KEY or SECRET_KEY)');
}

// Initialize Q8QPay provider if configured (additive; only active when PAYMENT_PROVIDER=q8qpay)
if (process.env.Q8QPAY_API_KEY) {
    q8qpayProvider.initialize({
        apiKey: process.env.Q8QPAY_API_KEY,
        webhookSecret: process.env.Q8QPAY_WEBHOOK_SECRET,
        sandbox: process.env.Q8QPAY_SANDBOX === 'true',
        returnUrl: process.env.Q8QPAY_RETURN_URL,
        callbackUrl: process.env.Q8QPAY_CALLBACK_URL || `${BASE_URL}/api/webhook/q8qpay`
    });
    console.log(`[Server] Q8QPay provider initialized (${process.env.Q8QPAY_SANDBOX === 'true' ? 'sandbox' : 'production'})`);
} else {
    console.log('[Server] Q8QPay provider not initialized (missing Q8QPAY_API_KEY)');
}

console.log('[Server] Payment Service initialized');

// ============================================
// KYC SERVICE INITIALIZATION
// ============================================
// KYC uses the service-role (admin) Supabase client for BOTH database and
// Storage operations. The KYC tables have RLS enabled with service_role-only
// policies (migration 010), so the anon client cannot read/write them. The
// kyc-documents Storage bucket is private and service-role-only, so upload /
// createSignedUrl / remove must also go through the admin client's storage.
const kycService = new KYCService(supabaseAdmin, supabaseAdmin.storage);
console.log('[Server] KYC Service initialized with Supabase Storage (service-role client)');

// CORS configuration - restrict origins in production
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : process.env.NODE_ENV === 'production' 
    ? ['https://arbitrix.pro'] // Default production origin
    : true; // Allow all in development

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Parse JSON bodies for all routes. The `verify` hook stashes the RAW body bytes
// on req.rawBody so webhook routes (q8qpay) can compute HMAC-SHA256 signatures
// over the exact bytes received. This is additive: req.body behaves exactly as
// before; existing routes (including Paymento) are unaffected.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- HELPERS ----------
// `environment` is additive and read-only here; the MARKETING_SANDBOX
// classification is enforced server-side via getUserEnvironment() branches.
async function getUser(id) {
  const { data, error } = await supabase.from('users').select('id, name, email, referral_code, is_admin, created_at, environment').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function getUserByEmail(email) {
  const { data, error } = await supabase.from('users').select('id, name, email, password_hash, referral_code, is_admin, environment').eq('email', email).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

// ---------- REFERRAL CODE HELPERS ----------

/**
 * Generate a cryptographically secure referral code
 * Format: ARBI-{6 random alphanumeric characters}
 * Uses crypto.randomBytes for secure randomness
 * @returns {string} A unique referral code
 */
function generateSecureReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluded confusing chars: 0, O, I, 1
  const randomBytes = crypto.randomBytes(6);
  let code = 'ARBI-';
  for (let i = 0; i < 6; i++) {
    code += chars[randomBytes[i] % chars.length];
  }
  return code;
}

/**
 * Generate a unique referral code with collision retry
 * Guarantees uniqueness by checking database and retrying if collision occurs
 * @returns {Promise<string>} A unique referral code
 */
async function generateUniqueReferralCode() {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateSecureReferralCode();
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('referral_code', code)
      .single();
    
    if (error && error.code === 'PGRST116') {
      // No match found - code is unique
      return code;
    }
    if (error) {
      throw error;
    }
    // Code already exists, try again (rare)
  }
  // Fallback: build a 6-char code from the SAME allowed alphabet as the
  // normal generator (so it always conforms to isValidReferralCodeFormat),
  // salted with a timestamp to break persistent collisions.
  const allowed = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seed = Date.now();
  const rb = crypto.randomBytes(6);
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += allowed[(rb[i] ^ ((seed >> (i * 5)) & 0x1f)) % allowed.length];
  }
  return `ARBI-${suffix}`;
}

/**
 * Validate referral code format
 * Bounded shape: ARBI- prefix + 4-8 alphanumeric chars. Accepts the normal
 * 6-char codes plus legitimate legacy/seed codes (e.g. ARBI-ADMIN). Actual
 * validity is determined by the DB lookup, self-referral check, and duplicate
 * check — this gate only rejects clearly malformed input.
 * @param {string} code - The referral code to validate
 * @returns {boolean} True if format is valid
 */
function isValidReferralCodeFormat(code) {
  if (!code || typeof code !== 'string') return false;
  const pattern = /^ARBI-[A-Z0-9]{4,8}$/;
  return pattern.test(code.toUpperCase());
}

/**
 * Assign a unique referral code to users who don't have one
 * This ensures all existing users get a proper unique code
 */
async function assignReferralCodesToExistingUsers() {
  try {
    // Find users without a valid referral code
    const { data: users, error } = await supabase
      .from('users')
      .select('id, referral_code')
      .or('referral_code.is.null,referral_code.eq.');
    
    if (error) {
      console.log('Error finding users without referral codes:', error.message);
      return;
    }
    
    // Filter out users with valid codes
    const usersNeedingCode = (users || []).filter(u => !u.referral_code || !isValidReferralCodeFormat(u.referral_code));
    
    for (const user of usersNeedingCode) {
      const newCode = await generateUniqueReferralCode();
      const { error: updateError } = await supabase
        .from('users')
        .update({ referral_code: newCode })
        .eq('id', user.id);
      
      if (updateError) {
        console.log(`Failed to assign referral code to user ${user.id}:`, updateError.message);
      }
    }
    
    if (usersNeedingCode.length > 0) {
      console.log(`✅ Assigned unique referral codes to ${usersNeedingCode.length} users`);
    }
  } catch (e) {
    console.log('Referral code assignment error:', e.message);
  }
}

async function getWallet(userId) {
  let { data, error } = await supabase.from('wallets').select('*').eq('user_id', userId).single();
  if (error && error.code === 'PGRST116') {
    const { data: newWallet, error: insertError } = await supabase.from('wallets').insert({ user_id: userId, demo_balance: 1000, live_balance: 50, bonus_balance: 0 }).select().single();
    if (insertError) throw insertError;
    return newWallet;
  }
  if (error) throw error;
  return data;
}

async function updateWallet(userId, field, amount) {
  const current = await getWallet(userId);
  const newVal = (current[field] || 0) + amount;
  await supabase.from('wallets').update({ [field]: newVal }).eq('user_id', userId);
}

async function addTransaction(userId, type, amount, detail) {
  await supabase.from('transactions').insert({ user_id: userId, type, amount, detail: detail || '' });
}

// ---------- MARKETING SANDBOX (environment classification + isolation) ----------
// A MARKETING_SANDBOX account is a marketing/demo account whose ENTIRE financial
// lifecycle is simulated. Isolation is enforced server-side and at the DB level
// (migration 013): every financial route below branches on the account's
// users.environment BEFORE touching production tables/RPCs, and DB backstop
// triggers reject sandbox writes to production financial tables. The frontend
// never has to be trusted for this.
const ENV_PRODUCTION = 'PRODUCTION';
const ENV_MARKETING_SANDBOX = 'MARKETING_SANDBOX';

// Minimum Trading Amount (MTA): the live-style trading balance required to
// START the bot. Server-authoritative; applies identically to production live
// trading and MARKETING_SANDBOX live-style trading (the sandbox demonstrates
// the real customer experience, so it must not bypass the MTA). Separate from
// the $7 Arbitrix Pro subscription. Demo mode is intentionally not gated.
const BOT_MIN_TRADING_BALANCE = 143;

// Simulated Demo balance seed for MARKETING_SANDBOX accounts, matching the
// production new-user demo seed (getWallet inserts demo_balance: 1000). Purely
// a read-time response value: sandbox_wallets has no demo column by design
// (demo trading has no server ledger - demo trades are client-side only), so
// this is NOT a stored balance, NOT a deposit, and never feeds live_balance.
const SANDBOX_DEMO_BALANCE = 1000;

// users.environment is immutable once set, so a short TTL cache is safe.
const _environmentCache = new Map(); // userId -> { env, at }
const ENV_CACHE_TTL_MS = 60 * 1000;

async function getUserEnvironment(userId) {
  const cached = _environmentCache.get(userId);
  if (cached && (Date.now() - cached.at) < ENV_CACHE_TTL_MS) return cached.env;
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('environment')
    .eq('id', userId)
    .single();
  if (error) return ENV_PRODUCTION; // fail closed toward production behavior
  const env = data && data.environment === ENV_MARKETING_SANDBOX ? ENV_MARKETING_SANDBOX : ENV_PRODUCTION;
  _environmentCache.set(userId, { env, at: Date.now() });
  return env;
}

async function isMarketingSandboxUser(userId) {
  return (await getUserEnvironment(userId)) === ENV_MARKETING_SANDBOX;
}

/**
 * Branch helper used at the TOP of every financial route. If the caller is a
 * MARKETING_SANDBOX account, runs the sandbox handler and returns true (the
 * production path is never executed). Otherwise returns false and the existing
 * production logic runs byte-for-byte unchanged.
 */
async function sandboxHandled(req, res, handler) {
  if (await isMarketingSandboxUser(req.user.id)) {
    await handler(req, res);
    return true;
  }
  return false;
}

// Simulated wallet read (mirrors getWallet's auto-create). Returned in the
// production wallet SHAPE ({live_balance: ...}) so read-only consumers (e.g.
// /api/auth/me) work unchanged for sandbox accounts. Never touches `wallets`.
async function getSandboxWallet(userId) {
  let { data, error } = await supabaseAdmin
    .from('sandbox_wallets')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error && error.code === 'PGRST116') {
    const { data: created, error: insertError } = await supabaseAdmin
      .from('sandbox_wallets')
      .insert({ user_id: userId })
      .select()
      .single();
    if (insertError) throw insertError;
    data = created;
  } else if (error) {
    throw error;
  }
  return {
    user_id: userId,
    // Simulated demo seed (see SANDBOX_DEMO_BALANCE). Read-time constant; the
    // stored sandbox `balance` is the simulated LIVE balance only.
    demo_balance: SANDBOX_DEMO_BALANCE,
    live_balance: Number(data.balance) || 0,
    bonus_balance: 0,
    intro_day: data.intro_day,
    badge_hidden: !!data.badge_hidden,
    is_simulated: true,
  };
}

// Simulated "Today's P&L": signed sum of sandbox_trades for the current UTC day
// (mirrors getTodayRealizedPnl but on the simulated ledger).
async function getSandboxTodayRealizedPnl(userId) {
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startOfNextDay = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const { data, error } = await supabaseAdmin
    .from('sandbox_trades')
    .select('amount')
    .eq('user_id', userId)
    .gte('created_at', startOfToday.toISOString())
    .lt('created_at', startOfNextDay.toISOString());
  if (error) return 0;
  return (data || []).reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
}

async function hasSandboxConfirmedDeposit(userId) {
  const { count, error } = await supabaseAdmin
    .from('sandbox_deposits')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'confirmed');
  if (error) return false;
  return (count || 0) > 0;
}

// Fictional sandbox deposit address. It LOOKS like a real USDT TRC20 address
// (34-char base58, T-prefixed) for marketing screenshots, but its Base58Check
// checksum is deliberately invalid, so no wallet will accept it as a send
// destination — no funds can ever be sent to it by accident.
const SANDBOX_DEPOSIT_ADDRESS = 'TRJdD9x53p6jHGBSb8hUi5yu9xVPkCxicb';

// Lazily confirm a pending simulated deposit after a short delay (mirrors the
// legacy deposit auto-confirm UX; no blockchain/payment network involved).
const SANDBOX_DEPOSIT_CONFIRM_MS = 8 * 1000;
async function advanceSandboxDeposit(userId, invoiceId) {
  const { data: deposit } = await supabaseAdmin
    .from('sandbox_deposits')
    .select('*')
    .eq('invoice_id', invoiceId)
    .eq('user_id', userId)
    .single();
  if (!deposit) return null;
  const elapsed = Date.now() - new Date(deposit.created_at).getTime();
  if (deposit.status === 'pending' && elapsed > SANDBOX_DEPOSIT_CONFIRM_MS) {
    const { data: result } = await supabaseAdmin.rpc('sandbox_credit_deposit', {
      p_user_id: userId,
      p_invoice_id: invoiceId,
    });
    if (result && result.success) deposit.status = 'confirmed';
  }
  if (deposit.status === 'pending' && elapsed > 3600000) {
    await supabaseAdmin.from('sandbox_deposits').update({ status: 'expired' }).eq('id', deposit.id);
    deposit.status = 'expired';
  }
  return deposit;
}

// Lazily advance simulated withdrawals so the demo flow completes "within a
// few minutes" without any real transfer: pending -> processing after ~20s,
// -> completed after ~75s. Marketing controls can also set states explicitly.
async function advanceSandboxWithdrawals(userId) {
  const now = Date.now();
  const { data: rows } = await supabaseAdmin
    .from('sandbox_withdrawals')
    .select('id, status, created_at')
    .eq('user_id', userId)
    .in('status', ['pending', 'processing']);
  for (const row of rows || []) {
    const elapsed = now - new Date(row.created_at).getTime();
    if (row.status === 'pending' && elapsed > 20 * 1000) {
      await supabaseAdmin.from('sandbox_withdrawals').update({ status: 'processing' }).eq('id', row.id);
      row.status = 'processing';
    }
    if (row.status === 'processing' && elapsed > 75 * 1000) {
      await supabaseAdmin.from('sandbox_withdrawals').update({ status: 'completed' }).eq('id', row.id);
      row.status = 'completed';
    }
  }
}

// ---------- MARKETING SANDBOX ROUTE HANDLERS (simulated only) ----------

async function handleSandboxDepositRequest(req, res) {
  const { amount, network } = req.body;
  const userId = req.user.id;
  const amt = Number(amount);
  if (!amt || amt < 10) return res.status(400).json({ error: 'Min $10' });
  const net = network || 'TRC20';
  const invoiceId = 'sbx_inv_' + Date.now() + '_' + userId;
  const { error } = await supabaseAdmin.from('sandbox_deposits').insert({
    user_id: userId,
    amount: Math.round(amt * 100) / 100,
    network: net,
    address: SANDBOX_DEPOSIT_ADDRESS,
    invoice_id: invoiceId,
    status: 'pending',
  });
  if (error) throw error;
  res.json({
    id: invoiceId,
    address: SANDBOX_DEPOSIT_ADDRESS,
    cryptoAmount: amt.toFixed(6),
    usdValue: amt,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    network: net,
  });
}

async function handleSandboxInvoiceCreate(req, res) {
  const { amount, network } = req.body || {};
  const userId = req.user.id;
  const amt = Number(amount);
  if (!amt || amt < 10) {
    return res.status(400).json({ success: false, error: 'Min $10' });
  }
  const net = network || 'TRC20';
  const invoiceId = 'sbx_inv_' + Date.now() + '_' + userId;
  const { error } = await supabaseAdmin.from('sandbox_deposits').insert({
    user_id: userId,
    amount: Math.round(amt * 100) / 100,
    network: net,
    address: SANDBOX_DEPOSIT_ADDRESS,
    invoice_id: invoiceId,
    status: 'pending',
  });
  if (error) throw error;
  res.json({
    success: true,
    invoice: {
      id: invoiceId,
      address: SANDBOX_DEPOSIT_ADDRESS,
      network: net,
      amountUsd: amt,
      amount_usd: amt,
      usdValue: amt,
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  });
}

async function handleSandboxDepositStatus(req, res) {
  const userId = req.user.id;
  const deposit = await advanceSandboxDeposit(userId, req.params.invoiceId);
  if (!deposit) return res.status(404).json({ error: 'Invoice not found' });
  const wallet = await getSandboxWallet(userId);
  res.json({
    status: deposit.status,
    newBalance: wallet.live_balance,
    creditedAmount: deposit.status === 'confirmed' ? Number(deposit.amount) : 0,
    network: deposit.network,
    referralActivated: null,
  });
}

async function handleSandboxInvoiceGet(req, res) {
  const userId = req.user.id;
  const deposit = await advanceSandboxDeposit(userId, req.params.invoiceId);
  if (!deposit) return res.status(404).json({ success: false, error: 'Invoice not found' });
  // Frontend confirmation reads `result.amountUsd || result.creditedAmount` —
  // camelCase mirrors production PaymentService.getInvoiceStatus; amount_usd
  // (snake_case) kept for backwards compatibility.
  const credited = deposit.status === 'confirmed' ? Number(deposit.amount) : 0;
  res.json({
    success: true,
    invoice: {
      id: deposit.invoice_id,
      status: deposit.status,
      amountUsd: Number(deposit.amount),
      amount_usd: Number(deposit.amount),
      creditedAmount: credited,
      credited: deposit.status === 'confirmed',
      network: deposit.network,
      address: deposit.address,
    },
  });
}

async function handleSandboxInvoiceCancel(req, res) {
  const userId = req.user.id;
  await supabaseAdmin
    .from('sandbox_deposits')
    .update({ status: 'expired' })
    .eq('invoice_id', req.params.invoiceId)
    .eq('user_id', userId)
    .eq('status', 'pending');
  res.json({ success: true, status: 'expired' });
}

async function handleSandboxPaymentHistory(req, res) {
  const { data } = await supabaseAdmin
    .from('sandbox_deposits')
    .select('invoice_id, amount, network, status, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  res.json({
    success: true,
    payments: (data || []).map((d) => ({
      id: d.invoice_id,
      amount_usd: Number(d.amount),
      currency: 'USDT',
      network: d.network,
      status: d.status,
      created_at: d.created_at,
    })),
  });
}

async function handleSandboxTrade(req, res) {
  try {
    const userId = req.user.id;
    const { amount, asset, detail, idempotencyKey } = req.body;
    if (typeof amount !== 'number' || !isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'Invalid trade amount' });
    }
    const wallet = await getSandboxWallet(userId);
    const currentBalance = Number(wallet.live_balance) || 0;
    if (Math.abs(amount) > Math.max(currentBalance, 1)) {
      return res.status(400).json({ error: 'Trade amount exceeds balance' });
    }
    const amount2dp = Math.round(amount * 100) / 100;
    const key = (idempotencyKey && String(idempotencyKey).trim()) ||
      `sbx_trade_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const { data, error } = await supabaseAdmin.rpc('sandbox_record_trade', {
      p_user_id: userId,
      p_amount: amount2dp,
      p_idempotency_key: key,
      p_asset: asset || null,
      p_detail: detail || null,
    });
    if (error) throw error;
    const result = (data && typeof data === 'object') ? data : { success: false, error: 'Invalid response from sandbox_record_trade' };
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Trade recording failed' });
    }
    const todayRealizedPnl = await getSandboxTodayRealizedPnl(userId).catch(() => 0);
    res.json({
      success: true,
      duplicate: !!result.duplicate,
      tradeId: result.trade_id,
      appliedAmount: Number(result.applied_amount),
      newBalance: Number(result.new_balance),
      todayRealizedPnl: Number(todayRealizedPnl) || 0,
    });
  } catch (err) {
    console.error('[sandbox /api/trade]', err);
    res.status(500).json({ error: 'Server error recording trade' });
  }
}

async function handleSandboxTransactions(req, res) {
  const { data, error } = await supabaseAdmin
    .from('sandbox_transactions')
    .select('id, type, amount, detail, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  res.json(data);
}

async function handleSandboxBotStart(req, res) {
  const userId = req.user.id;
  const mode = 'live';
  // The sandbox mirrors the real customer experience, so the $143 MTA applies
  // here too: read the simulated wallet server-side and block below the MTA
  // BEFORE any session is created (no session, no trades, no debit).
  const wallet = await getSandboxWallet(userId);
  if (Number(wallet.live_balance) < BOT_MIN_TRADING_BALANCE) {
    return res.status(400).json({ error: 'MTA not reached' });
  }
  await supabaseAdmin.from('sandbox_bot_sessions').upsert(
    { user_id: userId, is_running: 1, mode, started_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  res.json({ status: 'started', mode });
}

async function handleSandboxBotStop(req, res) {
  await supabaseAdmin.from('sandbox_bot_sessions').update({ is_running: 0 }).eq('user_id', req.user.id);
  res.json({ status: 'stopped' });
}

async function handleSandboxBotStatus(req, res) {
  const { data, error } = await supabaseAdmin
    .from('sandbox_bot_sessions')
    .select('*')
    .eq('user_id', req.user.id)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  res.json({
    isRunning: data ? data.is_running === 1 : false,
    mode: data ? data.mode : 'live',
    startedAt: data ? data.started_at : null,
  });
}

async function handleSandboxWithdrawRequest(req, res) {
  const { amount, address } = req.body;
  const userId = req.user.id;
  const { data, error } = await supabaseAdmin.rpc('sandbox_request_withdrawal', {
    p_user_id: userId,
    p_amount: Number(amount),
    p_address: address || '',
  });
  if (error) throw error;
  const result = (data && typeof data === 'object') ? data : { success: false, error: 'Invalid response' };
  if (!result.success) return res.status(400).json({ error: result.error || 'Withdrawal failed' });
  res.json({
    id: result.id,
    amount: Number(result.amount),
    address,
    status: 'pending',
    newBalance: Number(result.new_balance),
    message: 'Withdrawal submitted.',
  });
}

async function handleSandboxWithdrawHistory(req, res) {
  const userId = req.user.id;
  await advanceSandboxWithdrawals(userId);
  const { data, error } = await supabaseAdmin
    .from('sandbox_withdrawals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  res.json(data);
}

async function getSandboxSubscription(userId) {
  const { data, error } = await supabaseAdmin
    .from('sandbox_subscriptions')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) return null;
  return data;
}

// Simulated due-billing: mirrors processDueSubscription's decision logic but
// charges via sandbox_charge_subscription (sandbox tables only).
async function processDueSandboxSubscription(userId) {
  const price = await getSubscriptionPrice();
  const sub = await getSandboxSubscription(userId);
  if (!sub) return { price, subscription: null, result: { success: false, error: 'No subscription' } };
  if (sub.status !== 'active' && sub.status !== 'payment_due') {
    return { price, subscription: sub, result: { success: false, reason: 'not_billable', status: sub.status } };
  }
  const now = new Date();
  let due = false;
  let anchor = now;
  if (sub.status === 'active') {
    if (sub.next_billing_date && new Date(sub.next_billing_date) <= now) {
      due = true;
      anchor = new Date(sub.next_billing_date);
    }
  } else if (sub.status === 'payment_due') {
    due = true;
    anchor = sub.next_billing_date ? new Date(sub.next_billing_date) : now;
    if (anchor > now) anchor = now;
  }
  if (!due) {
    return { price, subscription: sub, result: { success: false, reason: 'not_due', status: sub.status } };
  }
  const { periodLabel, idempotencyKey } = subscriptionBillingKey(userId, anchor, 'monthly');
  const { data, error } = await supabaseAdmin.rpc('sandbox_charge_subscription', {
    p_user_id: userId,
    p_price: price,
    p_idempotency_key: idempotencyKey,
    p_period_label: periodLabel,
    p_billing_kind: 'monthly',
  });
  if (error) throw error;
  const result = (data && typeof data === 'object') ? data : { success: false, error: 'Invalid response from sandbox_charge_subscription' };
  const updated = await getSandboxSubscription(userId);
  return { price, subscription: updated, result };
}

async function handleSandboxSubscriptionGet(req, res) {
  const userId = req.user.id;
  const price = await getSubscriptionPrice();
  await processDueSandboxSubscription(userId).catch((e) => {
    console.log('[sandbox GET /api/subscription] billing check error:', e.message);
  });
  const sub = await getSandboxSubscription(userId);
  const wallet = await getSandboxWallet(userId);
  res.json({
    plan: sub ? sub.plan : 'pro',
    price: Number(price),
    status: sub ? sub.status : 'inactive',
    startedAt: sub ? sub.started_at : null,
    nextBillingDate: sub ? sub.next_billing_date : null,
    lastBillingDate: sub ? sub.last_billing_date : null,
    lastChargeAmount: sub && sub.last_charge_amount != null ? Number(sub.last_charge_amount) : null,
    introDay: wallet.intro_day,
    introActive: wallet.intro_day <= 14,
    simulated: true,
  });
}

async function handleSandboxSubscriptionActivate(req, res) {
  const userId = req.user.id;
  const price = await getSubscriptionPrice();
  let sub = await getSandboxSubscription(userId);
  if (sub && sub.status === 'active') {
    return res.json({
      success: true,
      duplicate: true,
      message: 'Subscription already active',
      price: Number(price),
      status: 'active',
      nextBillingDate: sub.next_billing_date,
      simulated: true,
    });
  }
  if (sub && sub.status === 'cancelled') {
    await supabaseAdmin.from('sandbox_subscriptions')
      .update({ status: 'payment_due', updated_at: new Date().toISOString() })
      .eq('user_id', userId);
  }
  const { periodLabel, idempotencyKey } = subscriptionBillingKey(userId, new Date(), 'activate');
  const { data, error } = await supabaseAdmin.rpc('sandbox_charge_subscription', {
    p_user_id: userId,
    p_price: price,
    p_idempotency_key: idempotencyKey,
    p_period_label: periodLabel,
    p_billing_kind: 'activate',
  });
  if (error) throw error;
  const result = (data && typeof data === 'object') ? data : { success: false, error: 'Invalid response from sandbox_charge_subscription' };
  const updated = await getSandboxSubscription(userId);
  res.json({
    success: !!result.success,
    duplicate: !!result.duplicate,
    reason: result.reason || null,
    message: result.message || null,
    price: Number(price),
    charged: !!result.success && !result.duplicate ? Number(result.price) : 0,
    newBalance: (result.new_balance != null) ? Number(result.new_balance) : null,
    status: updated ? updated.status : (result.success ? 'active' : 'payment_due'),
    nextBillingDate: updated ? updated.next_billing_date : null,
    simulated: true,
  });
}

async function handleSandboxSubscriptionCancel(req, res) {
  const userId = req.user.id;
  const sub = await getSandboxSubscription(userId);
  if (!sub) return res.status(404).json({ error: 'No subscription' });
  await supabaseAdmin.from('sandbox_subscriptions')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  res.json({ success: true, status: 'cancelled', simulated: true });
}

// ---------- MARKETING SANDBOX: self-service + admin control helpers ----------

// Self-service middleware: only MARKETING_SANDBOX accounts may call /api/sandbox/*.
async function sandboxOnlyMiddleware(req, res, next) {
  if (!(await isMarketingSandboxUser(req.user.id))) {
    return res.status(403).json({ error: 'Marketing sandbox account required' });
  }
  next();
}

// Marketing-admin guard: the TARGET user must be a MARKETING_SANDBOX account
// (checked server-side from the DB every time). Returns the target id or null
// (after sending the error response).
async function requireSandboxTargetUser(req, res) {
  const targetId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    res.status(400).json({ error: 'Invalid user id' });
    return null;
  }
  if (!(await isMarketingSandboxUser(targetId))) {
    res.status(403).json({ error: 'Target is not a MARKETING_SANDBOX account' });
    return null;
  }
  return targetId;
}


// ---------- REFERRAL ACTIVATION HELPERS ----------

/**
 * Get referral configuration value by key
 * @param {string} key - Configuration key
 * @param {*} defaultValue - Default value if key not found
 * @returns {Promise<*>} Configuration value or default
 */
async function getReferralConfig(key, defaultValue = null) {
  try {
    const { data, error } = await supabase
      .from('referral_config')
      .select('config_value')
      .eq('config_key', key)
      .single();
    
    if (error && error.code !== 'PGRST116') {
      console.log('Error fetching referral config:', error.message);
      return defaultValue;
    }
    
    return data ? data.config_value : defaultValue;
  } catch (e) {
    console.log('Referral config error:', e.message);
    return defaultValue;
  }
}

/**
 * Get all referral configuration as an object
 * @returns {Promise<object>} Configuration object
 */
async function getReferralConfigAll() {
  try {
    const { data, error } = await supabase
      .from('referral_config')
      .select('config_key, config_value, description, updated_at');
    
    if (error) {
      console.log('Error fetching referral config:', error.message);
      return getDefaultReferralConfig();
    }
    
    // Convert array to object
    const config = {};
    data.forEach(row => {
      config[row.config_key] = {
        value: row.config_value,
        description: row.description,
        updatedAt: row.updated_at
      };
    });
    
    return config;
  } catch (e) {
    console.log('Referral config error:', e.message);
    return getDefaultReferralConfig();
  }
}

/**
 * Get default referral configuration
 * @returns {object} Default configuration values
 */
function getDefaultReferralConfig() {
  return {
    rewards_enabled: { value: 'true', description: 'Enable or disable referral rewards system-wide' },
    minimum_qualifying_deposit: { value: '50', description: 'Minimum deposit amount required (USD)' },
    referral_reward_amount: { value: '10', description: 'Amount awarded to referrer (USD)' },
    first_deposit_required: { value: 'true', description: 'Whether referral requires first deposit to qualify' },
    max_rewards_per_user: { value: '0', description: 'Maximum rewards per user (0 = unlimited)' }
  };
}

// ---------- Arbitrix Pro Subscription ----------
// The subscription is an INTERNAL server-side debit of the user's genuinely
// available Live balance (wallets.live_balance). It is NOT a deposit/payment
// method; the deposit/q8qpay/NOWPayments/Paymento/webhook/crediting systems
// are untouched. Price is server-controlled (payment_config key
// 'subscription.pro_price', default 7) and is NEVER trusted from the client.

// Default Pro price (USD). Used only as a fallback if payment_config is unset.
const SUBSCRIPTION_PRO_DEFAULT_PRICE = 7;

/**
 * Read the server-controlled Pro price (USD) from payment_config. The frontend
 * never supplies the price; the server is the sole authority. Falls back to
 * SUBSCRIPTION_PRO_DEFAULT_PRICE if the config row is missing/invalid.
 * @returns {Promise<number>} Price as a Number.
 */
async function getSubscriptionPrice() {
  try {
    // service_role: payment_config is RLS-locked to server-only (migration 015);
    // the anon client would be denied once the lockdown is applied.
    const { data, error } = await supabaseAdmin
      .from('payment_config')
      .select('value')
      .eq('key', 'subscription.pro_price')
      .single();
    if (error && error.code !== 'PGRST116') {
      console.log('[getSubscriptionPrice] error:', error.message);
      return SUBSCRIPTION_PRO_DEFAULT_PRICE;
    }
    if (data && data.value != null && data.value !== '') {
      const n = Number(data.value);
      if (isFinite(n) && n >= 0) return Math.round(n * 100) / 100;
    }
    return SUBSCRIPTION_PRO_DEFAULT_PRICE;
  } catch (e) {
    console.log('[getSubscriptionPrice] error:', e.message);
    return SUBSCRIPTION_PRO_DEFAULT_PRICE;
  }
}

/**
 * Get the authenticated user's subscription row (or null). Read-only.
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getSubscription(userId) {
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) {
    console.log('[getSubscription] error:', error.message);
    return null;
  }
  return data;
}

/**
 * Subscription funding eligibility: the user's $50 Live promotional credit
 * (seeded into wallets.live_balance at wallet creation) must NOT count toward
 * subscription funding. Eligibility is established ONLY via a confirmed real
 * deposit record (hasConfirmedDeposit), never via the live_balance value,
 * which commingles promo and deposited funds. Server-side only; the client
 * never supplies balance/deposit/status.
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
async function hasSubscriptionFundingEligibility(userId) {
  return hasConfirmedDeposit(userId);
}

/**
 * Compute a server-authoritative billing-period label + idempotency key for a
 * billing attempt. The key is derived ONLY from the user id and the target
 * billing month (UTC), so a user can never be charged twice for the same
 * billing period regardless of retries / concurrency / scheduled re-runs. The
 * client NEVER supplies this key.
 * @param {number} userId
 * @param {Date|string} anchorDate - the date the period starts/billed-from
 * @returns {{periodLabel: string, idempotencyKey: string}}
 */
function subscriptionBillingKey(userId, anchorDate, billingKind = 'monthly') {
  const d = anchorDate ? new Date(anchorDate) : new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const periodLabel = `${yyyy}-${mm}`;
  // billingKind namespace keeps activation vs recurring distinct, though the
  // period label already disambiguates monthly periods.
  const idempotencyKey = `sub_${userId}_${billingKind}_${periodLabel}`;
  return { periodLabel, idempotencyKey };
}

/**
 * Attempt to bill a due subscription. Idempotent: if a charge for the target
 * billing period already exists (UNIQUE idempotency_key), no second charge is
 * made and the existing result is returned. The server decides whether the
 * subscription is due; the client never controls billing.
 *
 * On insufficient available balance: charges $0, never creates debt / negative
 * balance, and marks the subscription 'payment_due' (existing balance preserved).
 *
 * @param {number} userId
 * @returns {Promise<object>} { price, result, subscription }
 */
async function processDueSubscription(userId) {
  const price = await getSubscriptionPrice();
  const sub = await getSubscription(userId);
  if (!sub) return { price, subscription: null, result: { success: false, error: 'No subscription' } };

  // Only 'active' or 'payment_due' subscriptions are eligible for recurring
  // billing. 'inactive' (never activated) and 'cancelled' are never billed.
  if (sub.status !== 'active' && sub.status !== 'payment_due') {
    return { price, subscription: sub, result: { success: false, reason: 'not_billable', status: sub.status } };
  }

  // Determine if billing is due: next_billing_date must exist and be <= now.
  // A 'payment_due' subscription whose next_billing_date is in the future (e.g.
  // already billed this period but still due from a prior failed attempt) is
  // NOT re-billed for the current period — its period key already exists.
  const now = new Date();
  let due = false;
  let anchor = now;
  if (sub.status === 'active') {
    if (sub.next_billing_date && new Date(sub.next_billing_date) <= now) {
      due = true;
      anchor = new Date(sub.next_billing_date);
    }
  } else if (sub.status === 'payment_due') {
    // Retry collection for the currently-due period if its key is not yet
    // charged. The idempotency key guards against double-charging even if this
    // runs many times.
    due = true;
    anchor = sub.next_billing_date ? new Date(sub.next_billing_date) : now;
    if (anchor > now) anchor = now;
  }

  if (!due) {
    return { price, subscription: sub, result: { success: false, reason: 'not_due', status: sub.status } };
  }

  // ELIGIBILITY GATE (recurring): a due subscription must NOT be collected
  // solely from the $50 Live promotional credit. If the user has no confirmed
  // real deposit, do not charge; mark payment_due (the application's existing
  // failed-collection state) and preserve the existing balance. No debt, no
  // ledger entry. A user WITH a confirmed deposit bills normally regardless of
  // any remaining promo credit (that residual limitation is inherent to the
  // commingled wallets.live_balance and is unchanged by this gate).
  if (!(await hasSubscriptionFundingEligibility(userId))) {
    await supabaseAdmin.from('subscriptions')
      .update({ status: 'payment_due', updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    return {
      price,
      subscription: { ...sub, status: 'payment_due' },
      result: { success: false, reason: 'deposit_required', status: 'payment_due' },
    };
  }

  const { periodLabel, idempotencyKey } = subscriptionBillingKey(userId, anchor, 'monthly');
  const { data, error } = await supabaseAdmin.rpc('charge_subscription_safe', {
    p_user_id: userId,
    p_price: price,
    p_idempotency_key: idempotencyKey,
    p_period_label: periodLabel,
    p_billing_kind: 'monthly',
  });
  if (error) throw error;
  const result = (data && typeof data === 'object') ? data : { success: false, error: 'Invalid response from charge_subscription_safe' };

  // Re-read the (possibly updated) subscription state to return to the caller.
  const updated = await getSubscription(userId);
  return { price, subscription: updated, result };
}

/**
 * Update referral configuration
 * @param {string} key - Configuration key
 * @param {string} value - New value
 * @returns {Promise<boolean>} Success status
 */
async function setReferralConfig(key, value) {
  try {
    const { data, error } = await supabase.rpc('update_referral_config', {
      p_key: key,
      p_value: String(value)
    });
    
    if (error) {
      // Fallback to direct update
      const { error: updateError } = await supabase
        .from('referral_config')
        .update({ config_value: String(value), updated_at: new Date().toISOString() })
        .eq('config_key', key);
      
      if (updateError) {
        console.log('Error updating referral config:', updateError.message);
        return false;
      }
    }
    
    return true;
  } catch (e) {
    console.log('Set referral config error:', e.message);
    return false;
  }
}

/**
 * Parse configuration value to appropriate type
 * @param {string} value - String value from config
 * @returns {*} Parsed value
 */
function parseConfigValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (!isNaN(value) && value !== '') return Number(value);
  return value;
}

/**
 * Activate a pending referral when the referred user completes a qualifying action
 * This is called when a user makes their first successful deposit
 * 
 * Referral Lifecycle:
 * 1. PENDING - User registers with referral code, no bonus yet
 * 2. ACTIVE - Referred user completes qualification, bonus awarded to referrer
 * 
 * @param {string} userId - The user who completed the qualifying action (referred user)
 * @param {string} qualificationType - The type of action that qualified (e.g., 'first_deposit')
 * @param {object} depositInfo - Information about the deposit (amount, etc.)
 * @returns {Promise<object>} - Result of activation attempt
 */
async function activateReferralOnQualification(userId, qualificationType = 'first_deposit', depositInfo = {}) {
  try {
    // Get referral configuration
    const config = {
      rewardsEnabled: parseConfigValue(await getReferralConfig('rewards_enabled', 'true')),
      rewardAmount: parseConfigValue(await getReferralConfig('referral_reward_amount', '10')),
      minDeposit: parseConfigValue(await getReferralConfig('minimum_qualifying_deposit', '50')),
      firstDepositRequired: parseConfigValue(await getReferralConfig('first_deposit_required', 'true')),
      maxRewardsPerUser: parseConfigValue(await getReferralConfig('max_rewards_per_user', '0'))
    };
    
    // Check if rewards are enabled
    if (!config.rewardsEnabled) {
      console.log('Referral rewards are disabled');
      return { success: false, reason: 'rewards_disabled' };
    }
    
    // Check if first deposit is required and if this is the first deposit
    if (config.firstDepositRequired) {
      const isFirst = await isFirstConfirmedDeposit(userId);
      if (!isFirst) {
        console.log('Not the first deposit, skipping referral activation');
        return { success: false, reason: 'not_first_deposit' };
      }
    }
    
    // Check minimum deposit requirement
    if (depositInfo.amount && depositInfo.amount < config.minDeposit) {
      console.log(`Deposit amount ${depositInfo.amount} is below minimum ${config.minDeposit}`);
      return { success: false, reason: 'below_minimum_deposit', minimumRequired: config.minDeposit };
    }
    
    // Find pending referral for this user
    const { data: referral, error: findError } = await supabase
      .from('referrals')
      .select(`
        id,
        referrer_id,
        referred_id,
        status,
        bonus_earned,
        referrer:users!referrer_id(id, email, name)
      `)
      .eq('referred_id', userId)
      .eq('status', 'pending')
      .single();
    
    if (findError && findError.code !== 'PGRST116') {
      console.log('Error finding pending referral:', findError.message);
      return { success: false, reason: 'database_error' };
    }
    
    if (!referral) {
      // No pending referral found - user wasn't referred or already activated
      return { success: false, reason: 'no_pending_referral' };
    }
    
    // Double-check: ensure bonus hasn't been awarded yet (abuse prevention)
    if (referral.bonus_earned > 0) {
      console.log('Referral already has bonus awarded, ignoring duplicate activation attempt');
      return { success: false, reason: 'already_activated' };
    }
    
    // Check max rewards per user
    if (config.maxRewardsPerUser > 0) {
      const { count } = await supabase
        .from('referrals')
        .select('*', { count: 'exact', head: true })
        .eq('referrer_id', referral.referrer_id)
        .eq('status', 'active');
      
      if (count >= config.maxRewardsPerUser) {
        console.log(`Referrer has reached maximum rewards limit: ${config.maxRewardsPerUser}`);
        return { success: false, reason: 'max_rewards_reached', maxRewards: config.maxRewardsPerUser };
      }
    }
    
    // Get referrer details
    const referrer = referral.referrer;
    const rewardAmount = config.rewardAmount;
    
    // Activate the referral
    const { error: updateError } = await supabase
      .from('referrals')
      .update({
        status: 'active',
        bonus_earned: rewardAmount,
        qualified_at: new Date().toISOString(),
        qualification_type: qualificationType
      })
      .eq('id', referral.id);
    
    if (updateError) {
      console.log('Error activating referral:', updateError.message);
      return { success: false, reason: 'activation_failed' };
    }
    
    // Award bonus to referrer
    await updateWallet(referrer.id, 'bonus_balance', rewardAmount);
    await addTransaction(
      referrer.id, 
      'Referral Bonus', 
      rewardAmount, 
      `Referral bonus for ${referral.referred_id} (${qualificationType})`
    );
    
    console.log(`✅ Referral activated: Referrer ${referrer.email} earned $${rewardAmount} bonus`);
    
    return {
      success: true,
      referrerId: referrer.id,
      referrerName: referrer.name,
      bonusAmount: rewardAmount,
      config: config
    };
    
  } catch (e) {
    console.log('Referral activation error:', e.message);
    return { success: false, reason: 'exception' };
  }
}

/**
 * Check if a user has made their first deposit (for referral qualification)
 * This prevents duplicate bonus awards
 * @param {string} userId - The user to check
 * @returns {Promise<boolean>} - True if this is their first confirmed deposit
 */
async function isFirstConfirmedDeposit(userId) {
  const { count, error } = await supabase
    .from('deposits')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'confirmed');
  
  if (error) {
    console.log('Error checking deposit count:', error.message);
    return false;
  }
  
  return count === 0;
}

/**
 * Authoritative "is this a funded account" check: true iff the user has at
 * least one confirmed deposit. Used to initialize the dashboard in LIVE mode
 * for real funded accounts (not merely balance > 50, which is unreliable).
 * Uses the service-role client to bypass any RLS.
 */
async function hasConfirmedDeposit(userId) {
  const { count, error } = await supabaseAdmin
    .from('deposits')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'confirmed');
  if (error) {
    console.log('[hasConfirmedDeposit] error:', error.message);
    return false;
  }
  return (count || 0) > 0;
}

/**
 * Sum of realized trading P&L actually persisted via record_trade_safe() for
 * the current UTC day. Reads the append-only `trades` ledger (signed amounts),
 * so this can NEVER include deposits, withdrawals, referral bonuses, or other
 * transaction types, and can never report a profit that was not persisted
 * server-side. Returns a Number (USD).
 */
async function getTodayRealizedPnl(userId) {
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const endOfDayUtc = new Date(startOfDayUtc);
  endOfDayUtc.setUTCDate(startOfDayUtc.getUTCDate() + 1);
  const { data, error } = await supabaseAdmin
    .from('trades')
    .select('amount')
    .eq('user_id', userId)
    .gte('created_at', startOfDayUtc.toISOString())
    .lt('created_at', endOfDayUtc.toISOString());
  if (error) {
    console.log('[getTodayRealizedPnl] error:', error.message);
    return 0;
  }
  if (!Array.isArray(data) || !data.length) return 0;
  return data.reduce((sum, row) => sum + (Number(row && row.amount) || 0), 0);
}


// ---------- PASSWORD RESET HELPERS ----------

/**
 * Generate a cryptographically secure random token
 * @returns {string} A secure random token
 */
function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a reset token for storage (never store plain tokens)
 * @param {string} token - The plain token
 * @returns {string} The hashed token
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Ensure the password_reset_tokens table exists
 */
async function ensureResetTokensTable() {
  try {
    // Try to insert a test record to check if table exists (use admin client for RLS)
    const testEmail = 'test-' + Date.now() + '@placeholder.com';
    const testToken = hashToken('test');
    const testExpiry = new Date(Date.now() - 1000).toISOString();
    
    const { error } = await supabaseAdmin
      .from('password_reset_tokens')
      .insert({ 
        email: testEmail, 
        token_hash: testToken, 
        expires_at: testExpiry, 
        used: true 
      });
    
    if (error && error.code === '42P01') {
      // Table doesn't exist, create it
      console.log('Creating password_reset_tokens table...');
      await createResetTokensTable();
      return true;
    } else if (!error) {
      // Clean up test record
      await supabaseAdmin.from('password_reset_tokens')
        .delete()
        .eq('email', testEmail);
    }
    return true;
  } catch (e) {
    console.log('⚠️ Could not verify password_reset_tokens table:', e.message);
    return false;
  }
}

/**
 * Create the password_reset_tokens table using raw SQL
 */
async function createResetTokensTable() {
  try {
    // Use raw SQL to create the table
    // Note: This requires the service_role key with elevated permissions
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email 
        ON public.password_reset_tokens(email);
      
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash 
        ON public.password_reset_tokens(token_hash);
    `;
    
    // Try to execute via a workaround - insert a record with specific structure
    // This won't work with Supabase REST API, so we'll use a workaround
    
    // Alternative: Check if we can use the pg_catalog
    const { error } = await supabase.rpc('exec', { sql: createTableSQL });
    
    if (error) {
      console.log('Could not create table via RPC. Please create manually:');
      console.log('See migrations/001_create_password_reset_tokens.sql');
      return false;
    }
    return true;
  } catch (e) {
    console.log('Table creation failed:', e.message);
    console.log('Please create the table manually using:');
    console.log('migrations/001_create_password_reset_tokens.sql');
    return false;
  }
}

// Setup endpoint to create tables (for development)
app.post('/api/setup/reset-tokens-table', async (req, res) => {
  // Use Supabase REST API to create table with service role permissions
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    res.status(500).json({
      success: false,
      message: 'SUPABASE_SERVICE_KEY environment variable not set',
      sql: `CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`
    });
    return;
  }
  
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/create_password_reset_tokens_table`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      }
    });
    
    if (response.ok) {
      res.json({ success: true, message: 'Table created successfully' });
    } else {
      const errorText = await response.text();
      res.status(response.status).json({
        success: false,
        message: 'Failed to create table. Create it manually in Supabase dashboard.',
        sql: `CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          used BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );`,
        error: errorText
      });
    }
  } catch (e) {
    res.status(500).json({
      success: false,
      message: 'Error creating table: ' + e.message,
      sql: `CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`
    });
  }
});

// Debug endpoint to create table using direct SQL (bypasses RLS)
app.post('/api/debug/create-table', async (req, res) => {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    res.status(500).json({ 
      success: false, 
      message: 'SUPABASE_SERVICE_KEY not configured. Create table manually in Supabase dashboard.'
    });
    return;
  }
  
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email ON public.password_reset_tokens(email);
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash ON public.password_reset_tokens(token_hash);
    `;
    
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({ query: sql })
    });
    
    if (response.ok) {
      res.json({ success: true, message: 'Table created successfully' });
    } else {
      res.status(response.status).json({ 
        success: false, 
        message: 'Failed to create table. Please create manually in Supabase dashboard.',
        sql: `CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          used BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );`
      });
    }
  } catch (e) {
    res.status(500).json({ 
      success: false, 
      message: 'Error: ' + e.message,
      note: 'Create table manually in Supabase dashboard SQL Editor'
    });
  }
});

// Test endpoint to verify email sending works (without database)
app.post('/api/test/send-test-email', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  
  const testToken = 'test-token-' + Date.now();
  const sent = await sendResetEmail(email, testToken);
  
  res.json({ 
    success: sent,
    message: sent ? 'Email function executed (check server logs)' : 'Failed to send email',
    note: 'Configure RESEND_API_KEY in .env for real email delivery'
  });
});

/**
 * Send password reset email
 * Uses Resend SDK to send actual emails via REST API
 * Falls back to console logging if API key is not configured
 */
async function sendResetEmail(email, token) {
  const resetLink = `${BASE_URL}/reset-password.html?token=${token}&email=${encodeURIComponent(email)}`;
  const resend = getResendClient();
  
  // If no API key configured, log to console (development mode)
  if (!resend) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📧 PASSWORD RESET EMAIL (Development Mode - No API Key Configured)');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`To: ${email}`);
    console.log(`Subject: Password Reset Request - Arbitrix AI`);
    console.log(`Reset Link: ${resetLink}`);
    console.log(`Token (for debugging): ${token}`);
    console.log(`Expires in: 1 hour`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('To enable real emails, configure RESEND_API_KEY in environment variables');
    console.log('═══════════════════════════════════════════════════════════');
    return true;
  }
  
  // Send actual email using Resend SDK
  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_CONFIG.from,
      to: email,
      subject: 'Password Reset Request - Arbitrix AI',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Password Reset - Arbitrix AI</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <tr>
              <td style="background: linear-gradient(135deg, #0d1117 0%, #1a2332 100%); border-radius: 16px 16px 0 0; padding: 40px 30px; text-align: center;">
                <h1 style="margin: 0; color: #ffd700; font-size: 28px; font-weight: 700;">Arbitrix AI</h1>
                <p style="margin: 8px 0 0; color: #8b949e; font-size: 14px;">Multi-Asset Arbitrage Platform</p>
              </td>
            </tr>
            <tr>
              <td style="background-color: #ffffff; padding: 40px 30px;">
                <h2 style="margin: 0 0 20px; color: #1f2937; font-size: 24px;">Password Reset Request</h2>
                <p style="margin: 0 0 20px; color: #4b5563; font-size: 16px; line-height: 1.6;">
                  You requested a password reset for your Arbitrix AI account. Click the button below to reset your password:
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="text-align: center; padding: 30px 0;">
                      <a href="${resetLink}" style="display: inline-block; background: linear-gradient(135deg, #ffd700 0%, #ffb700 100%); color: #0d1117; text-decoration: none; font-weight: 600; font-size: 16px; padding: 16px 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(255, 215, 0, 0.3);">
                        Reset Password
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin: 20px 0; color: #4b5563; font-size: 14px; line-height: 1.6;">
                  Or copy and paste this link into your browser:
                </p>
                <p style="margin: 0; word-break: break-all; font-size: 13px;">
                  <a href="${resetLink}" style="color: #2563eb;">${resetLink}</a>
                </p>
                <div style="margin-top: 30px; padding: 20px; background-color: #fef3c7; border-radius: 8px; border-left: 4px solid #f59e0b;">
                  <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.6;">
                    <strong>⚠️ Security Notice:</strong><br>
                    This link will expire in <strong>1 hour</strong>.<br>
                    If you didn't request this password reset, please ignore this email.
                  </p>
                </div>
              </td>
            </tr>
            <tr>
              <td style="background-color: #f9fafb; border-radius: 0 0 16px 16px; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb;">
                <p style="margin: 0; color: #6b7280; font-size: 12px;">
                  This is an automated message from Arbitrix AI.<br>
                  Please do not reply to this email.
                </p>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      text: `Password Reset Request - Arbitrix AI

You requested a password reset for your Arbitrix AI account.

Click the link below to reset your password:
${resetLink}

This link will expire in 1 hour.

If you didn't request this password reset, please ignore this email.

---
This is an automated message from Arbitrix AI.`
    });
    
    if (error) {
      console.error('═══════════════════════════════════════════════════════════');
      console.error('❌ FAILED TO SEND PASSWORD RESET EMAIL');
      console.error('═══════════════════════════════════════════════════════════');
      console.error(`To: ${email}`);
      console.error(`Error: ${error.message}`);
      console.error('═══════════════════════════════════════════════════════════');
      return false;
    }
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📧 PASSWORD RESET EMAIL SENT SUCCESSFULLY');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`To: ${email}`);
    console.log(`Email ID: ${data?.id}`);
    console.log('═══════════════════════════════════════════════════════════');
    return true;
  } catch (err) {
    console.error('═══════════════════════════════════════════════════════════');
    console.error('❌ FAILED TO SEND PASSWORD RESET EMAIL');
    console.error('═══════════════════════════════════════════════════════════');
    console.error(`To: ${email}`);
    console.error(`Error: ${err.message}`);
    console.error('═══════════════════════════════════════════════════════════');
    return false;
  }
}

// ---------- AUTH MIDDLEWARE ----------
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}

function adminMiddleware(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  next();
}

// ---------- ROUTES ----------
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Register
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, referralCode } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
  if (await getUserByEmail(email)) return res.status(400).json({ error: 'Email already registered' });
  
  const hash = bcrypt.hashSync(password, 10);
  
  // Generate unique, cryptographically secure referral code
  const userReferralCode = await generateUniqueReferralCode();
  
  const { data: user, error } = await supabase.from('users').insert({ 
    name, 
    email, 
    password_hash: hash, 
    referral_code: userReferralCode, 
    is_admin: 0 
  }).select('id, name, email, referral_code, is_admin').single();
  
  if (error) throw error;
  await getWallet(user.id);
  
  // Process referral if provided
  // Referral lifecycle: pending -> active (after first deposit)
  if (referralCode) {
    const normalizedRefCode = referralCode.trim().toUpperCase();
    
    // Validate referral code format
    if (!isValidReferralCodeFormat(normalizedRefCode)) {
      // Invalid format - silently ignore (don't reveal whether code exists)
      console.log('Invalid referral code format:', normalizedRefCode);
    } else if (normalizedRefCode === userReferralCode) {
      // Self-referral prevention
      console.log('Self-referral attempt blocked for user:', email);
    } else {
      // Look up the referrer (admin client: bypasses RLS, service-role read)
      const { data: referrer, error: referrerError } = await supabaseAdmin
        .from('users')
        .select('id, email')
        .eq('referral_code', normalizedRefCode)
        .single();

      if (referrerError) {
        // PGRST116 = no matching row (code not found); not a hard failure.
        // Multi-row (also surfaced as PGRST116 under .single()) is logged but non-fatal.
        if (referrerError.code !== 'PGRST116') {
          console.error('Referral referrer lookup error:', {
            code: referrerError.code,
            message: referrerError.message,
            details: referrerError.details,
            hint: referrerError.hint
          });
        }
      }

      if (referrer) {
        // Check for duplicate referral relationship (regardless of status)
        const { data: existingReferral, error: existingError } = await supabaseAdmin
          .from('referrals')
          .select('id, status')
          .eq('referrer_id', referrer.id)
          .eq('referred_id', user.id)
          .single();

        if (existingError && existingError.code !== 'PGRST116') {
          console.error('Referral duplicate-check error:', {
            code: existingError.code,
            message: existingError.message,
            details: existingError.details,
            hint: existingError.hint
          });
        }

        if (!existingReferral) {
          // Create PENDING referral relationship (no bonus yet)
          // Bonus will be awarded when referred user makes their first deposit
          const { error: insertError } = await supabaseAdmin.from('referrals').insert({
            referrer_id: referrer.id,
            referred_id: user.id,
            bonus_earned: 0,
            status: 'pending',
            qualified_at: null,
            qualification_type: null
          });

          if (insertError) {
            // Do NOT fail registration over an optional referral insert.
            // Log a safe diagnostic (Supabase error code/message/details/hint only;
            // never credentials, JWTs, service keys, or user secrets).
            console.error('Referral INSERT failed:', {
              code: insertError.code,
              message: insertError.message,
              details: insertError.details,
              hint: insertError.hint
            });
          } else {
            console.log(`Referral pending: ${referrer.email} -> ${email} (awaiting first deposit)`);
          }
        } else if (existingReferral.status === 'pending') {
          // Already has pending referral, no action needed
          console.log('Pending referral already exists');
        } else {
          // Already activated, ignore
          console.log('Referral already activated');
        }
      }
    }
  }
  
  const token = jwt.sign({ id: user.id, email: user.email, isAdmin: user.is_admin===1 }, JWT_SECRET, { expiresIn: '7d' });
  // Public registration always creates a PRODUCTION account. MARKETING_SANDBOX
  // accounts can only be created via POST /api/admin/sandbox/accounts (admin).
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, referralCode: user.referral_code, isAdmin: user.is_admin===1, environment: ENV_PRODUCTION } });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await getUserByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, email: user.email, isAdmin: user.is_admin===1 }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, referralCode: user.referral_code, isAdmin: user.is_admin===1, environment: user.environment || ENV_PRODUCTION } });
});

// ---------- FORGOT PASSWORD ----------
/**
 * POST /api/auth/forgot-password
 * Request a password reset token
 * 
 * Security: 
 * - Rate limited to prevent abuse (5 requests/IP/15min, 3 requests/email/hour)
 * - Does NOT reveal whether an account exists with that email
 *   to prevent email enumeration attacks.
 */
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  
  // Get client IP for rate limiting and security auditing
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
    || req.socket?.remoteAddress 
    || 'unknown';
  
  // Validate email format
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email address is required' });
  }
  
  // Normalize email for consistent rate limiting
  const normalizedEmail = email.toLowerCase().trim();
  
  // Check rate limit BEFORE any database operations
  const rateLimitResult = checkForgotPasswordRateLimit(clientIP, normalizedEmail);
  
  if (!rateLimitResult.allowed) {
    // Log rate limit hit for monitoring (but don't reveal which limit was hit)
    console.log(`⚠️ Rate limit exceeded for IP: ${clientIP}, Email: ${normalizedEmail}`);
    
    // Return generic message - don't reveal which limit was hit
    // This prevents attackers from knowing if they've hit the IP or email limit
    return res.status(429).json({
      success: false,
      message: 'Too many password reset attempts. Please try again later.'
    });
  }
  
  try {
    // Check if user exists (but don't reveal this information)
    const user = await getUserByEmail(normalizedEmail);
    
    if (user) {
      // Generate a cryptographically secure token
      const resetToken = generateResetToken();
      const tokenHash = hashToken(resetToken);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY).toISOString();
      
      // Invalidate any existing reset tokens for this email (use admin client for RLS)
      await supabaseAdmin
        .from('password_reset_tokens')
        .update({ used: true })
        .eq('email', normalizedEmail)
        .eq('used', false);
      
      // Store the hashed token with expiration and IP for auditing (use admin client for RLS)
      const { error: insertError } = await supabaseAdmin
        .from('password_reset_tokens')
        .insert({
          email: normalizedEmail,
          token_hash: tokenHash,
          expires_at: expiresAt,
          used: false,
          ip_address: clientIP
        });
      
      if (insertError) {
        console.error('Failed to insert reset token:', insertError);
        // Don't reveal the error to the user
      } else {
        // Send the reset email
        await sendResetEmail(normalizedEmail, resetToken);
      }
    }
    
    // Always return success, even if email doesn't exist
    // This prevents email enumeration attacks
    res.json({ 
      success: true, 
      message: 'If an account with that email exists, we have sent a password reset link.'
    });
    
  } catch (e) {
    console.error('Forgot password error:', e.message);
    // Always return success to prevent email enumeration
    res.json({ 
      success: true, 
      message: 'If an account with that email exists, we have sent a password reset link.'
    });
  }
});

/**
 * POST /api/auth/reset-password
 * Reset password using a valid token
 */
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, token, newPassword } = req.body;
  
  // Validate all required fields
  if (!email || !token || !newPassword) {
    return res.status(400).json({ 
      error: 'Email, token, and new password are required' 
    });
  }
  
  // Validate password strength
  if (newPassword.length < 6) {
    return res.status(400).json({ 
      error: 'Password must be at least 6 characters' 
    });
  }
  
  try {
    // Hash the provided token to compare with stored hash
    const tokenHash = hashToken(token);
    
    // Find the reset token record (use admin client for RLS)
    const { data: resetRecord, error: findError } = await supabaseAdmin
      .from('password_reset_tokens')
      .select('*')
      .eq('email', email)
      .eq('token_hash', tokenHash)
      .eq('used', false)
      .single();
    
    if (findError || !resetRecord) {
      return res.status(400).json({ 
        error: 'Invalid or expired reset token. Please request a new password reset.' 
      });
    }
    
    // Check if token is expired
    const expiresAt = new Date(resetRecord.expires_at);
    if (expiresAt < new Date()) {
      return res.status(400).json({ 
        error: 'This reset link has expired. Please request a new password reset.' 
      });
    }
    
    // Get the user to update password
    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(400).json({ 
        error: 'Invalid reset token. Please request a new password reset.' 
      });
    }
    
    // Hash the new password
    const newPasswordHash = bcrypt.hashSync(newPassword, 10);
    
    // Update the user's password
    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: newPasswordHash })
      .eq('id', user.id);
    
    if (updateError) {
      console.error('Failed to update password:', updateError);
      return res.status(500).json({ 
        error: 'Failed to update password. Please try again.' 
      });
    }
    
    // Mark the token as used (single use) (use admin client for RLS)
    await supabaseAdmin
      .from('password_reset_tokens')
      .update({ used: true })
      .eq('id', resetRecord.id);
    
    console.log(`✅ Password reset successful for user: ${email}`);
    
    res.json({ 
      success: true, 
      message: 'Your password has been reset successfully. You can now login with your new password.' 
    });
    
  } catch (e) {
    console.error('Reset password error:', e.message);
    res.status(500).json({ 
      error: 'An error occurred while resetting your password. Please try again.' 
    });
  }
});

/**
 * GET /api/auth/verify-reset-token
 * Verify if a reset token is valid (for frontend validation)
 */
app.get('/api/auth/verify-reset-token', async (req, res) => {
  const { email, token } = req.query;
  
  if (!email || !token) {
    return res.status(400).json({ 
      valid: false, 
      error: 'Email and token are required' 
    });
  }
  
  try {
    const tokenHash = hashToken(token);
    
    // Use admin client for RLS-protected table
    const { data: resetRecord, error } = await supabaseAdmin
      .from('password_reset_tokens')
      .select('*')
      .eq('email', email)
      .eq('token_hash', tokenHash)
      .eq('used', false)
      .single();
    
    if (error || !resetRecord) {
      return res.json({ 
        valid: false, 
        error: 'Invalid reset token' 
      });
    }
    
    // Check expiration
    const expiresAt = new Date(resetRecord.expires_at);
    if (expiresAt < new Date()) {
      return res.json({ 
        valid: false, 
        error: 'This reset link has expired' 
      });
    }
    
    res.json({ valid: true });
    
  } catch (e) {
    console.error('Verify token error:', e.message);
    res.json({ 
      valid: false, 
      error: 'An error occurred' 
    });
  }
});

// ---------- SECURE EMAIL CHANGE (Phase 8B) ----------
// SECURITY MODEL:
//  - Identity comes ONLY from the authenticated JWT (req.user.id). A client
//    can NEVER supply another user's id to change that user's email (no IDOR).
//  - The user's existing internal id is NEVER changed; only users.email is.
//  - users.email is NOT updated until the verification code for the NEW email
//    is successfully verified. Until then the OLD email keeps working for login.
//  - The verification code is cryptographically random, time-limited
//    (EMAIL_CHANGE_CONFIG.codeExpiryMs), single-use (used=true on success),
//    and stored ONLY as a SHA256 hash (never plaintext, never returned, never
//    logged). The plaintext is sent only to the NEW email via Resend.
//  - A new request replaces any prior pending request for the same user.
//  - Per-user rate limiting / cooldown on requests, and per-request attempt
//    throttling on verification, prevent brute force / abuse.
//  - Financial/KYC/trading/payment/subscription/2FA/referral systems are not
//    touched — only users.email + the email_change_requests table are involved.
const EMAIL_CHANGE_CONFIG = {
  codeLength: 6,
  codeExpiryMs: 10 * 60 * 1000,     // 10 minutes
  resendCooldownMs: 60 * 1000,     // 60s between request attempts per user
  maxVerifyAttempts: 5             // per pending request
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmailFormat(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

function hashEmailChangeCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

// Cryptographically secure 6-digit code (same algorithm as Email2FAService).
function generateEmailChangeCode() {
  const randomBytes = crypto.randomBytes(EMAIL_CHANGE_CONFIG.codeLength);
  let code = '';
  for (let i = 0; i < EMAIL_CHANGE_CONFIG.codeLength; i++) {
    code += randomBytes[i] % 10;
  }
  return code;
}

// Send the email-change verification code to the NEW email. The plaintext code
// is NEVER logged (even in dev mode) and NEVER returned to the caller.
async function sendEmailChangeCodeEmail(newEmail, code) {
  const resend = getResendClient();
  if (resend) {
    try {
      await resend.emails.send({
        from: EMAIL_CONFIG.from,
        to: newEmail,
        subject: 'Confirm your new email - Arbitrix AI',
        html: generateEmailChangeTemplate(code)
      });
    } catch (e) {
      // Log only that sending failed (no code, no credentials).
      console.error('[EMAIL CHANGE] Failed to send verification email:', e?.message || 'unknown error');
    }
    return;
  }
  // Dev mode (no API key): a code was "sent" but the plaintext is never logged
  // to satisfy the no-code-disclosure requirement (unlike the 2FA dev log).
  console.log('[EMAIL CHANGE] Verification email queued (dev mode, no API key). Code intentionally not logged.');
}

function generateEmailChangeTemplate(code) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm your new email - Arbitrix AI</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <tr><td style="background:linear-gradient(135deg,#0d1117 0%,#1a2332 100%);border-radius:16px 16px 0 0;padding:40px 30px;text-align:center;">
      <h1 style="margin:0;color:#ffd700;font-size:28px;font-weight:700;">Arbitrix AI</h1>
      <p style="margin:8px 0 0;color:#8b949e;font-size:14px;">Multi-Asset Arbitrage Platform</p>
    </td></tr>
    <tr><td style="background-color:#ffffff;padding:40px 30px;">
      <h2 style="margin:0 0 20px;color:#1f2937;font-size:24px;">Confirm Your New Email</h2>
      <p style="margin:0 0 20px;color:#4b5563;font-size:16px;line-height:1.6;">You requested an email change for your Arbitrix AI account. Use the verification code below to confirm your new email address. This code expires in 10 minutes.</p>
      <div style="text-align:center;margin:30px 0;">
        <div style="display:inline-block;background:#0d1117;color:#ffd700;font-size:32px;font-weight:700;letter-spacing:8px;padding:16px 32px;border-radius:8px;">${code}</div>
      </div>
      <p style="margin:20px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">If you did not request this change, you can safely ignore this email. Your account email will not change until you complete verification.</p>
    </td></tr>
    <tr><td style="background-color:#f9fafb;padding:24px 30px;border-radius:0 0 16px 16px;text-align:center;">
      <p style="margin:0;color:#9ca3af;font-size:12px;">&copy; Arbitrix AI. All rights reserved.</p>
    </td></tr>
  </table>
</body>
</html>`;
}

// POST /api/auth/email-change/request
// Body: { newEmail }. Identity from JWT (req.user.id). Sends a verification
// code to the NEW email. Does NOT change users.email. Never returns the code.
app.post('/api/auth/email-change/request', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const newEmail = (req.body && req.body.newEmail) ? String(req.body.newEmail).trim().toLowerCase() : '';

  if (!isValidEmailFormat(newEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  // The new email must differ from the current one.
  const currentUser = await getUser(userId);
  if (!currentUser) return res.status(404).json({ error: 'User not found' });
  if (newEmail === String(currentUser.email).toLowerCase()) {
    return res.status(400).json({ error: 'New email must be different from your current email' });
  }

  // Per-user request cooldown (rate limiting). Fail closed on DB error for this
  // auth-critical path.
  const cooldownSince = new Date(Date.now() - EMAIL_CHANGE_CONFIG.resendCooldownMs).toISOString();
  const { data: recent, error: rlError } = await supabaseAdmin
    .from('email_change_requests')
    .select('created_at')
    .eq('user_id', userId)
    .gte('created_at', cooldownSince)
    .order('created_at', { ascending: false })
    .limit(1);
  if (rlError) {
    console.error('[EMAIL CHANGE] Rate-limit check failed:', rlError.code, rlError.message);
    return res.status(500).json({ error: 'Could not process request' });
  }
  if (recent && recent.length > 0) {
    const elapsed = Date.now() - new Date(recent[0].created_at).getTime();
    const remainingMs = EMAIL_CHANGE_CONFIG.resendCooldownMs - elapsed;
    if (remainingMs > 0) {
      return res.status(429).json({ error: 'Too many requests. Please wait before requesting another email change.', retryAfterSeconds: Math.ceil(remainingMs / 1000) });
    }
  }

  // Ensure the new email is not already associated with ANOTHER account.
  // Enumeration note: this rejects with a clear message when the email is taken,
  // matching the existing registration behavior (`Email already registered`).
  // We do not reveal WHICH account owns it, only that the email is unavailable.
  const existing = await getUserByEmail(newEmail);
  if (existing && String(existing.id) !== String(userId)) {
    return res.status(409).json({ error: 'This email is already associated with another account' });
  }

  // Replace any prior pending (unused) request for this user so only one
  // pending verification is active at a time.
  const { error: invErr } = await supabaseAdmin
    .from('email_change_requests')
    .delete()
    .eq('user_id', userId)
    .eq('used', false);
  if (invErr) {
    console.error('[EMAIL CHANGE] Could not invalidate prior pending request:', invErr.code, invErr.message);
    return res.status(500).json({ error: 'Could not process request' });
  }

  // Generate, hash, and store a single-use, time-limited verification code.
  const code = generateEmailChangeCode();
  const codeHash = hashEmailChangeCode(code);
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_CONFIG.codeExpiryMs).toISOString();
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;

  const { error: insertErr } = await supabaseAdmin.from('email_change_requests').insert({
    user_id: userId,
    new_email: newEmail,
    code_hash: codeHash,
    expires_at: expiresAt,
    used: false,
    attempts: 0,
    ip_address: clientIP,
    user_agent: req.headers['user-agent'] || null
  });
  if (insertErr) {
    console.error('[EMAIL CHANGE] Insert failed:', insertErr.code, insertErr.message);
    return res.status(500).json({ error: 'Could not process request' });
  }

  // Send the code to the NEW email only. Never return/log the code.
  await sendEmailChangeCodeEmail(newEmail, code);

  return res.json({ message: 'A verification code has been sent to your new email address.' });
});

// GET /api/auth/email-change/status
// Returns whether a pending (unused, unexpired) request exists for the user, so
// the UI can reflect the pending-verification state. Never reveals the code.
app.get('/api/auth/email-change/status', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { data, error } = await supabaseAdmin
    .from('email_change_requests')
    .select('new_email, expires_at, attempts')
    .eq('user_id', userId)
    .eq('used', false)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return res.status(500).json({ error: 'Could not check status' });
  if (!data || data.length === 0) return res.json({ pending: false });
  const row = data[0];
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  if (expired) return res.json({ pending: false });
  return res.json({ pending: true, newEmail: row.new_email, expiresAt: row.expires_at });
});

// POST /api/auth/email-change/verify
// Body: { code }. Identity from JWT. On success updates users.email only
// (never the id). Single-use, time-limited. Never returns the code.
app.post('/api/auth/email-change/verify', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const code = req.body && req.body.code ? String(req.body.code).trim() : '';
  if (!code) return res.status(400).json({ error: 'Verification code is required' });

  // Find the user's most recent pending request.
  const { data: rows, error } = await supabaseAdmin
    .from('email_change_requests')
    .select('id, new_email, code_hash, expires_at, used, attempts')
    .eq('user_id', userId)
    .eq('used', false)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return res.status(500).json({ error: 'Could not verify' });
  if (!rows || rows.length === 0) {
    return res.status(400).json({ error: 'No pending email change request. Please request a new code.' });
  }

  const request = rows[0];

  // Expired -> invalidate and reject.
  if (new Date(request.expires_at).getTime() <= Date.now()) {
    await supabaseAdmin.from('email_change_requests').update({ used: true, used_at: new Date().toISOString() }).eq('id', request.id);
    return res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
  }

  // Constant-time compare of the hashed code.
  const providedHash = hashEmailChangeCode(code);
  let match = false;
  try {
    const a = Buffer.from(providedHash, 'hex');
    const b = Buffer.from(request.code_hash, 'hex');
    if (a.length === b.length) match = crypto.timingSafeEqual(a, b);
  } catch (e) {
    match = false;
  }

  if (!match) {
    const newAttempts = (request.attempts || 0) + 1;
    if (newAttempts >= EMAIL_CHANGE_CONFIG.maxVerifyAttempts) {
      // Too many failed attempts -> invalidate the pending request.
      await supabaseAdmin.from('email_change_requests').update({ used: true, attempts: newAttempts, used_at: new Date().toISOString() }).eq('id', request.id);
      return res.status(429).json({ error: 'Too many failed attempts. Please request a new code.' });
    }
    await supabaseAdmin.from('email_change_requests').update({ attempts: newAttempts }).eq('id', request.id);
    return res.status(400).json({ error: 'Invalid verification code' });
  }

  // Code is correct. Mark single-use BEFORE mutating the user, so a replay
  // can never update the email twice.
  const { error: useErr } = await supabaseAdmin.from('email_change_requests').update({ used: true, used_at: new Date().toISOString() }).eq('id', request.id);
  if (useErr) return res.status(500).json({ error: 'Could not complete verification' });

  // Re-check uniqueness at verify time (race guard): if another account took
  // the email between request and verify, do NOT change anything.
  const existing = await getUserByEmail(request.new_email);
  if (existing && String(existing.id) !== String(userId)) {
    return res.status(409).json({ error: 'This email is already associated with another account' });
  }

  // Update ONLY users.email; the id (and everything else) is untouched.
  const { data: updatedUser, error: updErr } = await supabaseAdmin
    .from('users')
    .update({ email: request.new_email })
    .eq('id', userId)
    .select('id, name, email, referral_code, is_admin, created_at')
    .single();
  if (updErr) {
    console.error('[EMAIL CHANGE] users.email update failed:', updErr.code, updErr.message);
    return res.status(500).json({ error: 'Could not update email' });
  }

  return res.json({ success: true, message: 'Email updated successfully', user: updatedUser });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX accounts read from the sandbox tables only; the wallet
  // shape matches the production wallet so the frontend renders identically.
  if (await isMarketingSandboxUser(req.user.id)) {
    const [user, wallet] = await Promise.all([
      getUser(req.user.id),
      getSandboxWallet(req.user.id),
    ]);
    const [funded, todayPnl] = await Promise.all([
      hasSandboxConfirmedDeposit(user.id).catch(() => false),
      getSandboxTodayRealizedPnl(user.id).catch(() => 0),
    ]);
    return res.json({
      user,
      wallet,
      hasRealDeposit: !!funded,
      todayRealizedPnl: Number(todayPnl) || 0,
      environment: ENV_MARKETING_SANDBOX,
      introDay: wallet.intro_day,
      badgeHidden: wallet.badge_hidden,
    });
  }
  // getUser and getWallet are independent (both keyed by the same user id),
  // so run them concurrently to cut this endpoint's latency by one DB round trip.
  const [user, wallet] = await Promise.all([
    getUser(req.user.id),
    getWallet(req.user.id),
  ]);
  // Authoritative signals computed from server state (not localStorage):
  //  - hasRealDeposit: at least one confirmed deposit -> funds the LIVE wallet
  //    and is used to initialize the dashboard in LIVE mode for funded accounts.
  //  - todayRealizedPnl: signed sum of trades persisted via record_trade_safe()
  //    for the current UTC day. Authoritative source for "Today's P&L" so the
  //    figure can never show a profit that was not recorded server-side.
  const [funded, todayPnl] = await Promise.all([
    hasConfirmedDeposit(user.id).catch(() => false),
    getTodayRealizedPnl(user.id).catch(() => 0),
  ]);
  res.json({
    user,
    wallet,
    hasRealDeposit: !!funded,
    todayRealizedPnl: Number(todayPnl) || 0,
    environment: ENV_PRODUCTION,
  });
});

// ---------- Deposit ----------
app.post('/api/deposit/request', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: simulated deposit only (no real invoice/address write).
  if (await sandboxHandled(req, res, handleSandboxDepositRequest)) return;
  const { amount, network } = req.body;
  if (!amount || amount < 10) return res.status(400).json({ error: 'Min $10' });
  const userId = req.user.id;
  const net = network || 'TRC20';
  const invoiceId = 'inv_' + Date.now() + '_' + userId;
  const addresses = { TRC20: 'TDQ2Ymmejp2MXxawBdbYkxqjZ7tTkMyMJR', ERC20: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', BEP20: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e' };
  const address = addresses[net] || addresses.TRC20;
  await supabase.from('deposits').insert({ user_id: userId, amount, network: net, address, invoice_id: invoiceId, status: 'pending' });
  res.json({ id: invoiceId, address, cryptoAmount: (amount/1.0018).toFixed(6), usdValue: amount, expiresAt: new Date(Date.now()+3600000).toISOString(), network: net });
});

app.get('/api/deposit/status/:invoiceId', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: reads/confirms simulated deposits only.
  if (await sandboxHandled(req, res, handleSandboxDepositStatus)) return;
  const { invoiceId } = req.params;
  const { data: deposit, error } = await supabase.from('deposits').select('*').eq('invoice_id', invoiceId).eq('user_id', req.user.id).single();
  if (error || !deposit) return res.status(404).json({ error: 'Invoice not found' });
  const elapsed = Date.now() - new Date(deposit.created_at).getTime();
  
  let referralActivated = null;
  
  if (elapsed > 15000 && deposit.status === 'pending') {
    // Check if this is the user's first deposit (for referral qualification)
    const isFirst = await isFirstConfirmedDeposit(req.user.id);
    
    await supabase.from('deposits').update({ status: 'confirmed' }).eq('id', deposit.id);
    await updateWallet(req.user.id, 'live_balance', deposit.amount);
    await addTransaction(req.user.id, 'Deposit', deposit.amount, 'USDT (' + deposit.network + ')');
    deposit.status = 'confirmed';
    
    // Activate referral with deposit info (amount for minimum check)
    if (isFirst) {
      referralActivated = await activateReferralOnQualification(req.user.id, 'first_deposit', {
        amount: deposit.amount,
        network: deposit.network
      });
    }
  }
  if (elapsed > 3600000 && deposit.status === 'pending') {
    await supabase.from('deposits').update({ status: 'expired' }).eq('id', deposit.id);
    deposit.status = 'expired';
  }
  const wallet = await getWallet(req.user.id);
  res.json({ 
    status: deposit.status, 
    newBalance: wallet.live_balance, 
    creditedAmount: deposit.status==='confirmed' ? deposit.amount : 0, 
    network: deposit.network,
    referralActivated
  });
});

// ---------- NEW PAYMENT SERVICE ENDPOINTS ----------

// Rate limiting for payment endpoints (simple in-memory implementation)
// In production, use Redis for distributed rate limiting
const paymentRateLimitStore = new Map();
const PAYMENT_RATE_LIMIT = {
  maxRequests: 10,      // Max 10 requests
  windowMs: 60 * 1000  // Per minute
};

function checkPaymentRateLimit(ip) {
  const now = Date.now();
  let record = paymentRateLimitStore.get(ip);
  
  if (!record || now - record.windowStart > PAYMENT_RATE_LIMIT.windowMs) {
    record = { count: 0, windowStart: now };
    paymentRateLimitStore.set(ip, record);
  }
  
  record.count++;
  
  if (record.count > PAYMENT_RATE_LIMIT.maxRequests) {
    const retryAfter = Math.ceil((PAYMENT_RATE_LIMIT.windowMs - (now - record.windowStart)) / 1000);
    return { allowed: false, retryAfter };
  }
  
  return { allowed: true, remaining: PAYMENT_RATE_LIMIT.maxRequests - record.count };
}

/**
 * Create a new payment invoice using PaymentService
 * SECURITY: Rate limited, authenticated, input validated
 */
app.post('/api/payment/create-invoice', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: simulated invoice only - never reaches PaymentService /
  // any payment provider (nowpayments/paymento/q8qpay).
  if (await sandboxHandled(req, res, handleSandboxInvoiceCreate)) return;
  // Rate limiting
  const ip = req.ip || req.connection.remoteAddress;
  const rateLimit = checkPaymentRateLimit(ip);
  
  if (!rateLimit.allowed) {
    return res.status(429).json({ 
      success: false, 
      error: 'Too many requests',
      retryAfter: rateLimit.retryAfter
    });
  }
  
  try {
    // SECURITY: Strict input validation
    const { amount, currency, network } = req.body;
    const MIN_DEPOSIT_AMOUNT = 50;
    
    if (!amount || typeof amount !== 'number' || amount < MIN_DEPOSIT_AMOUNT) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid amount: minimum deposit is $${MIN_DEPOSIT_AMOUNT}` 
      });
    }
    
    // Sanitize and validate currency/network
    const sanitizedCurrency = String(currency || 'USDT').toUpperCase().trim();
    const sanitizedNetwork = String(network || 'TRC20').toUpperCase().trim();
    
    if (!['USDT', 'BTC', 'ETH'].includes(sanitizedCurrency)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Unsupported currency' 
      });
    }
    
    if (!['TRC20', 'ERC20', 'BEP20', 'BTC', 'ETH'].includes(sanitizedNetwork)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Unsupported network' 
      });
    }
    
    const userId = req.user.id;
    const ipAddress = req.ip || req.connection.remoteAddress;

    const invoice = await paymentService.createInvoice({
      userId,
      amount,
      currency: sanitizedCurrency,
      network: sanitizedNetwork,
      ipAddress
    });

    // Build response based on provider type
    const invoiceResponse = {
      id: invoice.id,
      amountUsd: invoice.amountUsd,
      currency: invoice.currency,
      network: invoice.network,
      expiresAt: invoice.expiresAt,
      status: invoice.status
    };

    // Add provider-specific fields
    if (invoice.provider === 'paymento') {
      // Paymento: Return gateway URL for redirection
      invoiceResponse.provider = 'paymento';
      invoiceResponse.gatewayUrl = invoice.gatewayUrl;
      invoiceResponse.token = invoice.token;
      invoiceResponse.redirectToGateway = true;
    } else if (invoice.provider === 'q8qpay') {
      // Q8QPay: white-label. Return the TRC20 payout address + exact amount.
      // The frontend renders its own UI (QR, copy, countdown). No redirect.
      invoiceResponse.provider = 'q8qpay';
      invoiceResponse.address = invoice.address;             // customer TRC20 destination
      invoiceResponse.payoutAddress = invoice.payoutAddress;
      invoiceResponse.amountCrypto = invoice.amountCrypto;
      invoiceResponse.amountUsdtExact = invoice.amountUsdtExact;
      invoiceResponse.networkLabel = invoice.networkLabel || 'Tron (TRC20)';
      invoiceResponse.qrCodeUrl = invoice.qrCodeUrl;
      invoiceResponse.qrData = invoice.qrData;
      invoiceResponse.providerInvoiceId = invoice.providerInvoiceId;
      invoiceResponse.redirectToGateway = false;
    } else {
      // NOWPayments: Return wallet address
      invoiceResponse.address = invoice.address;
      invoiceResponse.amountCrypto = invoice.amountCrypto;
      invoiceResponse.qrCodeUrl = invoice.qrCodeUrl;
    }

    // SECURITY: Don't expose internal IDs to client
    res.json({
      success: true,
      invoice: invoiceResponse
    });
  } catch (error) {
    console.error('[API] Create invoice error:', error.message);
    res.status(400).json({ 
      success: false, 
      error: 'Failed to create invoice' 
    });
  }
});

/**
 * Get payment invoice status using PaymentService
 * SECURITY: User can only access their own invoices
 */
app.get('/api/payment/invoice/:invoiceId', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: simulated invoice status only.
  if (await sandboxHandled(req, res, handleSandboxInvoiceGet)) return;
  try {
    // SECURITY: Validate invoice ID format
    const { invoiceId } = req.params;
    if (!invoiceId || typeof invoiceId !== 'string' || invoiceId.length > 100) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid invoice ID' 
      });
    }
    
    const userId = req.user.id;

    const status = await paymentService.getInvoiceStatus(invoiceId, userId);

    res.json({
      success: true,
      invoice: status
    });
  } catch (error) {
    console.error('[API] Get invoice status error:', error.message);
    res.status(404).json({ 
      success: false, 
      error: 'Invoice not found' 
    });
  }
});

/**
 * Cancel a pending invoice
 */
app.post('/api/payment/cancel/:invoiceId', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: cancels a simulated invoice only.
  if (await sandboxHandled(req, res, handleSandboxInvoiceCancel)) return;
  try {
    const { invoiceId } = req.params;
    const userId = req.user.id;

    const result = await paymentService.cancelInvoice(invoiceId, userId);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[API] Cancel invoice error:', error);
    res.status(400).json({ 
      success: false, 
      error: error.message || 'Failed to cancel invoice' 
    });
  }
});

/**
 * Get supported payment currencies/networks
 */
app.get('/api/payment/supported-currencies', async (req, res) => {
  try {
    const currencies = await paymentService.getSupportedCurrencies();

    res.json({
      success: true,
      currencies
    });
  } catch (error) {
    console.error('[API] Get supported currencies error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get supported currencies' 
    });
  }
});

/**
 * Manual payment check (fallback)
 */
app.post('/api/payment/check/:invoiceId', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: advances/reads the simulated invoice only.
  if (await sandboxHandled(req, res, async (req2, res2) => {
    const deposit = await advanceSandboxDeposit(req2.user.id, req2.params.invoiceId);
    if (!deposit) return res2.status(404).json({ success: false, error: 'Invoice not found' });
    res2.json({ success: true, status: deposit.status, invoice: { id: deposit.invoice_id, status: deposit.status, amount_usd: Number(deposit.amount) } });
  })) return;
  try {
    const { invoiceId } = req.params;
    const userId = req.user.id;

    const result = await paymentService.checkAndConfirmPayment(invoiceId, userId);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[API] Check payment error:', error);
    res.status(400).json({ 
      success: false, 
      error: error.message || 'Failed to check payment' 
    });
  }
});

/**
 * Get user's payment history
 */
app.get('/api/payment/history', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: reads simulated deposit history only.
  if (await sandboxHandled(req, res, handleSandboxPaymentHistory)) return;
  try {
    const userId = req.user.id;
    const { limit = 50, offset = 0 } = req.query;

    const { data: invoices, error } = await supabase
      .from('payment_invoices')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    res.json({
      success: true,
      invoices
    });
  } catch (error) {
    console.error('[API] Get payment history error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get payment history' 
    });
  }
});

/**
 * Get payment service health status
 */
app.get('/api/payment/health', async (req, res) => {
  try {
    const providerHealth = await paymentService.getActiveProvider().healthCheck();
    
    res.json({
      success: true,
      provider: providerHealth,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Payment service unhealthy',
      details: error.message
    });
  }
});

// ---------- WEBHOOK ENDPOINTS ----------

/**
 * NOWPayments Webhook Handler
 * Handles payment confirmations and status updates
 * 
 * Security features:
 * - Signature verification (HMAC-SHA256)
 * - Idempotency via unique key tracking
 * - Replay attack protection
 * - Input validation
 */
app.post('/api/webhook/nowpayments', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-signature'];
    const payload = JSON.parse(req.body);
    
    console.log('[Webhook] NOWPayments received:', JSON.stringify(payload).substring(0, 200));

    // Process webhook through PaymentService
    const result = await paymentService.processWebhook(
      payload, 
      signature, 
      'nowpayments'
    );

    // Log the webhook source IP
    const sourceIp = req.ip || req.connection.remoteAddress;
    console.log(`[Webhook] Source IP: ${sourceIp}`);

    res.json({
      success: true,
      message: 'Webhook processed',
      result
    });
  } catch (error) {
    console.error('[Webhook] NOWPayments error:', error);
    
    // Return 200 even on error to prevent retries for non-retryable errors
    // Log the error but don't fail the webhook
    if (error.message.includes('Invalid webhook signature')) {
      res.status(401).json({ 
        success: false, 
        error: 'Invalid signature' 
      });
    } else {
      res.status(200).json({ 
        success: false, 
        error: error.message 
      });
    }
  }
});

/**
 * Generic webhook endpoint for future providers
 *
 * NOTE: Dedicated routes for 'q8qpay' are registered below and MUST take
 * precedence (q8qpay uses a different signature header + dedicated verification).
 * We call next() for q8qpay so it falls through to its dedicated handler.
 * Paymento and other providers continue to be handled here (unchanged).
 */
app.post('/api/webhook/:provider', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const { provider } = req.params;

    // Let the dedicated q8qpay route handle q8qpay webhooks
    if (provider === 'q8qpay') {
      return next();
    }

    const signature = req.headers['x-signature'] || req.headers['x-signature-256'];
    const payload = JSON.parse(req.body);

    console.log(`[Webhook] ${provider} received`);

    const result = await paymentService.processWebhook(
      payload,
      signature,
      provider
    );

    res.json({
      success: true,
      message: 'Webhook processed',
      result
    });
  } catch (error) {
    console.error(`[Webhook] ${req.params.provider} error:`, error);
    res.status(200).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================
// PAYMENTO WEBHOOK ENDPOINTS
// ============================================

/**
 * Paymento IPN (Instant Payment Notification) Webhook Endpoint
 * 
 * SECURITY REQUIREMENTS:
 * 1. Verify HMAC-SHA256 signature from X-HMAC-SHA256-SIGNATURE header
 * 2. Verify payment with Paymento Verify API before crediting
 * 3. Only credit on status 7 (Paid) - never on status 3 (WaitingToConfirm)
 * 4. Prevent duplicate credits using idempotency checks
 * 5. Return 200 to acknowledge receipt (prevents retries)
 */
app.post('/api/webhook/paymento', express.raw({ type: 'application/json' }), async (req, res) => {
  const sourceIp = req.ip || req.connection.remoteAddress;
  console.log(`[Paymento Webhook] Received from IP: ${sourceIp}`);

  try {
    // Get raw body for HMAC verification
    const rawBody = req.body;
    const signature = req.headers['x-hmac-sha256-signature'];

    if (!signature) {
      console.error('[Paymento Webhook] CRITICAL: Missing HMAC signature header');
      return res.status(401).json({ error: 'Missing signature' });
    }

    // Verify HMAC signature using raw body bytes
    const isValidSignature = await paymentoProvider.verifyWebhook(rawBody, signature);
    
    if (!isValidSignature) {
      console.error('[Paymento Webhook] CRITICAL: Invalid HMAC signature - possible spoofed callback!');
      console.error('[Paymento Webhook] Received signature:', signature);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    console.log('[Paymento Webhook] HMAC signature verified');

    // Parse payload AFTER verification
    const payload = JSON.parse(rawBody);
    console.log('[Paymento Webhook] Payload:', JSON.stringify(payload));

    // Parse payment data
    const paymentData = paymentoProvider.parsePaymentData(payload);
    const { token, orderId, status, statusCode, providerPaymentId } = paymentData;

    console.log(`[Paymento Webhook] Token: ${token?.substring(0, 8) || 'N/A'}..., Order: ${orderId}, Status: ${statusCode} (${status})`);

    // Find the invoice in our database
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('payment_invoices')
      .select('*')
      .eq('invoice_id', orderId)
      .single();

    if (invoiceError || !invoice) {
      console.error(`[Paymento Webhook] Invoice not found: ${orderId}`);
      // Return 200 to prevent retries for unknown invoices
      return res.status(200).json({ error: 'Invoice not found' });
    }

    // Check if already credited (idempotency)
    if (invoice.credited) {
      console.log(`[Paymento Webhook] Invoice ${orderId} already credited, skipping`);
      return res.status(200).json({ success: true, message: 'Already processed' });
    }

    // Check if status is Paid (7) - this is the ONLY status we credit on
    if (statusCode !== PAYMENTO_STATUS.PAID) {
      console.log(`[Paymento Webhook] Invoice ${orderId} not in Paid status (${statusCode}), updating status only`);

      // Update status but don't credit
      await supabaseAdmin
        .from('payment_invoices')
        .update({
          status: status,
          provider_status_code: statusCode,
          provider_payment_id: providerPaymentId,
          updated_at: new Date().toISOString()
        })
        .eq('id', invoice.id);

      return res.status(200).json({ success: true, message: `Status updated to ${status}` });
    }

    // CRITICAL: Verify with Paymento API before crediting
    console.log(`[Paymento Webhook] Verifying payment with Paymento API...`);
    const verifyResult = await paymentoProvider.getInvoiceStatus(token);

    if (!verifyResult.success) {
      console.error(`[Paymento Webhook] Payment verification failed for ${orderId}`);
      return res.status(200).json({ error: 'Verification failed' });
    }

    // Double-check verified status is Paid (7)
    if (verifyResult.statusCode !== PAYMENTO_STATUS.PAID) {
      console.error(`[Paymento Webhook] Verified status is ${verifyResult.statusCode}, not Paid (7)`);
      return res.status(200).json({ error: 'Verification mismatch' });
    }

    console.log(`[Paymento Webhook] Payment verified! Crediting user ${invoice.user_id}...`);

    // Credit user balance using atomic function
    const creditResult = await supabaseAdmin.rpc('paymento_credit_user_safe', {
      p_invoice_id: invoice.id,
      p_user_id: invoice.user_id,
      p_amount_usd: invoice.amount_usd,
      p_provider_payment_id: providerPaymentId,
      p_provider_status_code: statusCode
    });

    if (creditResult.error) {
      console.error('[Paymento Webhook] Credit failed:', creditResult.error.message);
      return res.status(200).json({ error: 'Credit failed' });
    }

    const creditData = creditResult.data;

    if (creditData.duplicate) {
      console.log(`[Paymento Webhook] Duplicate payment detected for ${orderId}`);
      return res.status(200).json({ success: true, message: 'Duplicate payment' });
    }

    console.log(`[Paymento Webhook] SUCCESS! User ${invoice.user_id} credited $${invoice.amount_usd}`);
    console.log(`[Paymento Webhook] New balance: $${creditData.new_balance}, First deposit: ${creditData.is_first_deposit}`);

    res.status(200).json({
      success: true,
      message: 'Payment processed',
      credited: true,
      newBalance: creditData.new_balance,
      isFirstDeposit: creditData.is_first_deposit
    });

  } catch (error) {
    console.error('[Paymento Webhook] Error:', error);
    // Return 200 to prevent Paymento from retrying
    // Log the error for investigation
    res.status(200).json({ error: 'Processing error' });
  }
});

// ============================================
// Q8QPay WEBHOOK + STATUS ENDPOINTS
// ============================================

/**
 * Q8QPay Webhook Endpoint
 *
 * SECURITY REQUIREMENTS:
 * 1. Verify HMAC-SHA256 signature from X-Webhook-Signature header (raw body)
 * 2. Re-verify the invoice via GET /api/v1/invoices/:id before crediting
 * 3. Only credit on status === 'confirmed' (never on pending/expired/cancelled)
 * 4. Validate invoice reference, asset (USDT_TRC20), exact amount, and tx hash
 * 5. Idempotent: the shared atomic credit_payment_safe() prevents double-credit
 * 6. Return 200 within 30s to acknowledge receipt (q8qpay retries on non-2xx)
 */
app.post('/api/webhook/q8qpay', async (req, res) => {
  const sourceIp = req.ip || req.connection.remoteAddress;
  console.log(`[Q8QPay Webhook] Received from IP: ${sourceIp}`);

  try {
    // req.rawBody is captured by the global express.json() verify hook (raw bytes).
    // req.body is the parsed object.
    const rawBody = req.rawBody;
    const signature = req.headers['x-webhook-signature'];

    if (!signature) {
      console.error('[Q8QPay Webhook] CRITICAL: Missing X-Webhook-Signature header');
      return res.status(401).json({ error: 'Missing signature' });
    }

    // Verify HMAC-SHA256 signature over the raw body bytes
    const isValidSignature = await q8qpayProvider.verifyWebhook(rawBody, signature);
    if (!isValidSignature) {
      console.error('[Q8QPay Webhook] CRITICAL: Invalid HMAC signature - possible spoofed callback!');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    console.log('[Q8QPay Webhook] HMAC signature verified');

    // Use the already-parsed body (parsed by express.json from the same raw bytes)
    const payload = req.body || JSON.parse(rawBody);
    console.log('[Q8QPay Webhook] Payload:', JSON.stringify(payload));

    const paymentData = q8qpayProvider.parsePaymentData(payload);
    const {
      invoiceId,             // our Arbitrix reference (invoice_reference)
      providerInvoiceId,     // q8qpay UUID
      walletAddress,
      amount,
      transactionHash,
      status,
      assetCode,
      type
    } = paymentData;

    console.log(`[Q8QPay Webhook] Ref: ${invoiceId}, Q8QId: ${providerInvoiceId}, Status: ${status}, Type: ${type}`);

    // Find our invoice by the Arbitrix reference we passed as `reference`
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('payment_invoices')
      .select('*')
      .eq('invoice_id', invoiceId)
      .single();

    if (invoiceError || !invoice) {
      console.error(`[Q8QPay Webhook] Invoice not found for reference: ${invoiceId}`);
      // Return 200 to stop retries for unknown invoices
      return res.status(200).json({ error: 'Invoice not found' });
    }

    // Idempotency: already credited -> ack and stop
    if (invoice.credited) {
      console.log(`[Q8QPay Webhook] Invoice ${invoiceId} already credited, skipping`);
      return res.status(200).json({ success: true, message: 'Already processed' });
    }

    // Non-confirmed statuses: update DB status only, do NOT credit
    if (status !== Q8QPAY_STATUS.CONFIRMED) {
      console.log(`[Q8QPay Webhook] Invoice ${invoiceId} status ${status} - updating status only (no credit)`);
      await supabaseAdmin
        .from('payment_invoices')
        .update({
          status: status === 'expired' ? 'expired' : (status === 'cancelled' ? 'cancelled' : invoice.status),
          updated_at: new Date().toISOString()
        })
        .eq('id', invoice.id);
      return res.status(200).json({ success: true, message: `Status updated to ${status}` });
    }

    // CRITICAL: server-side re-verification via q8qpay API before crediting
    console.log(`[Q8QPay Webhook] Re-verifying invoice ${providerInvoiceId} with q8qpay API...`);
    const verifyResult = await q8qpayProvider.getInvoiceStatus(providerInvoiceId);

    if (!verifyResult || verifyResult.status !== Q8QPAY_STATUS.CONFIRMED) {
      console.error(`[Q8QPay Webhook] Re-verification: status is ${verifyResult?.status}, not confirmed`);
      return res.status(200).json({ error: 'Verification mismatch' });
    }

    // === Validate invoice reference, asset, amount, and transaction info ===

    // 1. Reference must match (the q8qpay UUID we stored == the one in the webhook/verify)
    if (invoice.provider_invoice_ref && invoice.provider_invoice_ref !== verifyResult.providerInvoiceId) {
      console.error(`[Q8QPay Webhook] Invoice ref mismatch: db=${invoice.provider_invoice_ref} vs q8q=${verifyResult.providerInvoiceId}`);
      return res.status(200).json({ error: 'Reference mismatch' });
    }

    // 2. Asset must be USDT_TRC20
    if (verifyResult.assetCode !== 'USDT_TRC20') {
      console.error(`[Q8QPay Webhook] Asset mismatch: ${verifyResult.assetCode} (expected USDT_TRC20)`);
      return res.status(200).json({ error: 'Asset mismatch' });
    }

    // 3. Amount must match exactly. Q8QPay may adjust amountUsdtExact upward
    //    when the requested amount is already pending on the same wallet
    //    (address-reuse disambiguation, NOT a fee). The customer must pay
    //    amountUsdtExact exactly, so we compare the confirmed q8qpay amount
    //    against the authoritative amount_crypto we stored at invoice creation
    //    (== q8qpay amountUsdtExact), NOT amount_usd (the user's requested USD,
    //    which is what gets credited to the Arbitrix balance).
    if (invoice.amount_crypto == null) {
      console.error(`[Q8QPay Webhook] Missing amount_crypto on invoice ${invoiceId} - cannot verify paid amount (fail-closed)`);
      return res.status(200).json({ error: 'Missing stored amount' });
    }
    const expectedAmount = Number(Number(invoice.amount_crypto).toFixed(4));
    const paidAmount = Number(Number(verifyResult.amountUsdtExact).toFixed(4));
    if (paidAmount !== expectedAmount) {
      console.error(`[Q8QPay Webhook] Amount mismatch: expected ${expectedAmount}, paid ${paidAmount}`);
      return res.status(200).json({ error: 'Amount mismatch' });
    }

    // 4. Payout address must match the one we displayed to the customer
    if (invoice.wallet_address && verifyResult.payoutAddress &&
        invoice.wallet_address !== verifyResult.payoutAddress) {
      console.error(`[Q8QPay Webhook] Payout address mismatch`);
      return res.status(200).json({ error: 'Address mismatch' });
    }

    // 5. Transaction hash (audit + cross-invoice idempotency key).
    //    Resolved via the provider helper (see Q8QPayProvider.resolveTransactionHash)
    //    so the security invariant — a fake/test hash can NEVER be produced for a
    //    live payment — lives in one auditable, unit-tested place.
    //
    //    Sources, in priority order:
    //      (1) tx hash from the webhook payload (payload.tx_hash || payload.txHash)
    //      (2) tx hash from q8qpay server-side re-verification (data.tx_hash || data.txHash)
    //      (3) SANDBOX-ONLY fallback `q8qpay_sandbox_<providerInvoiceId>`, fired ONLY
    //          when Q8QPAY_SANDBOX==='true' AND the API key is a `test_` key AND q8qpay
    //          re-verification flags the invoice as a test invoice. A `live_` key can
    //          never satisfy the test_ condition, so a hashless live confirmed webhook
    //          resolves to null and is rejected below.
    const txHash = q8qpayProvider.resolveTransactionHash({
      webhookTxHash: transactionHash,
      verifyTxHash: verifyResult.tx_hash,
      verifyIsTest: verifyResult && verifyResult.isTest === true,
      providerInvoiceId
    });
    if (!txHash) {
      console.error(`[Q8QPay Webhook] No transaction hash provided for confirmed payment`);
      return res.status(200).json({ error: 'Missing transaction hash' });
    }

    console.log(`[Q8QPay Webhook] All checks passed. Crediting user ${invoice.user_id} $${invoice.amount_usd} (tx: ${txHash.substring(0, 16)}...)`);

    // Store audit fields (tx hash, q8q invoice id) BEFORE crediting so they are
    // preserved even if a concurrent webhook wins the credit race.
    await supabaseAdmin
      .from('payment_invoices')
      .update({
        provider_tx_hash: txHash,
        provider_invoice_ref: providerInvoiceId,
        updated_at: new Date().toISOString()
      })
      .eq('id', invoice.id);

    // Credit atomically via the SHARED secure function (same mechanism as Paymento)
    const creditResult = await supabaseAdmin.rpc('credit_payment_safe', {
      p_invoice_id: invoice.id,
      p_user_id: invoice.user_id,
      p_amount_usd: invoice.amount_usd,
      p_transaction_hash: txHash,
      p_provider_invoice_id: providerInvoiceId,
      p_provider_name: 'q8qpay'
    });

    if (creditResult.error) {
      console.error('[Q8QPay Webhook] Credit failed:', creditResult.error.message);
      return res.status(200).json({ error: 'Credit failed' });
    }

    const creditData = creditResult.data;
    if (creditData.duplicate) {
      console.log(`[Q8QPay Webhook] Duplicate payment detected for ${invoiceId} - no double credit`);
      return res.status(200).json({ success: true, message: 'Duplicate payment (not re-credited)' });
    }

    if (!creditData.success) {
      console.error(`[Q8QPay Webhook] Credit function returned error: ${creditData.error}`);
      return res.status(200).json({ error: 'Credit failed' });
    }

    console.log(`[Q8QPay Webhook] SUCCESS! User ${invoice.user_id} credited $${invoice.amount_usd}`);
    console.log(`[Q8QPay Webhook] New balance: $${creditData.new_balance}, First deposit: ${creditData.is_first_deposit}`);

    res.status(200).json({
      success: true,
      message: 'Payment processed',
      credited: true,
      newBalance: creditData.new_balance,
      isFirstDeposit: creditData.is_first_deposit
    });

  } catch (error) {
    console.error('[Q8QPay Webhook] Error:', error);
    // Return 200 to prevent q8qpay from retrying; log for investigation
    res.status(200).json({ error: 'Processing error' });
  }
});

/**
 * Q8QPay invoice status (for frontend polling / manual check).
 * Re-verifies with q8qpay API and mirrors the local DB status.
 */
app.get('/api/q8qpay/status/:invoiceId', authMiddleware, async (req, res) => {
  try {
    const { invoiceId } = req.params;
    if (!invoiceId || typeof invoiceId !== 'string' || invoiceId.length > 100) {
      return res.status(400).json({ success: false, error: 'Invalid invoice ID' });
    }

    const userId = req.user.id;

    // Get our invoice (authorization: user can only see their own)
    const { data: invoice, error } = await supabaseAdmin
      .from('payment_invoices')
      .select('*')
      .eq('invoice_id', invoiceId)
      .eq('user_id', userId)
      .single();

    if (error || !invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    // Local DB status is source of truth for credited/confirmed (set by webhook)
    let remoteStatus = invoice.status;
    if (invoice.provider_invoice_ref && invoice.status === 'pending') {
      try {
        const v = await q8qpayProvider.getInvoiceStatus(invoice.provider_invoice_ref);
        remoteStatus = v.status;
        // Reflect non-terminal remote status locally (do NOT credit here)
        if (remoteStatus && remoteStatus !== invoice.status &&
            ['expired', 'cancelled'].includes(remoteStatus)) {
          await supabaseAdmin
            .from('payment_invoices')
            .update({ status: remoteStatus, updated_at: new Date().toISOString() })
            .eq('id', invoice.id);
        }
      } catch (e) {
        console.warn('[Q8QPay Status] remote lookup failed:', e.message);
      }
    }

    res.json({
      success: true,
      invoice: {
        id: invoice.invoice_id,
        providerInvoiceId: invoice.provider_invoice_ref,
        status: invoice.credited ? 'confirmed' : remoteStatus,
        amountUsd: invoice.amount_usd,
        amountUsdtExact: invoice.amount_crypto,
        currency: invoice.currency,
        network: invoice.network,
        payoutAddress: invoice.wallet_address,
        expiresAt: invoice.expires_at,
        credited: invoice.credited,
        confirmedAt: invoice.confirmed_at
      }
    });
  } catch (error) {
    console.error('[Q8QPay Status] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to get status' });
  }
});

/**
 * Cancel a pending Q8QPay invoice (calls q8qpay cancel API + updates DB).
 */
app.post('/api/q8qpay/cancel/:invoiceId', authMiddleware, async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const userId = req.user.id;

    const { data: invoice, error } = await supabaseAdmin
      .from('payment_invoices')
      .select('*')
      .eq('invoice_id', invoiceId)
      .eq('user_id', userId)
      .single();

    if (error || !invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    if (invoice.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Cannot cancel invoice with status: ${invoice.status}` });
    }

    // Best-effort remote cancel
    if (invoice.provider_invoice_ref) {
      try {
        await q8qpayProvider.cancelInvoice(invoice.provider_invoice_ref);
      } catch (e) {
        console.warn('[Q8QPay Cancel] remote cancel failed:', e.message);
      }
    }

    await supabaseAdmin
      .from('payment_invoices')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', invoice.id);

    console.log(`[Q8QPay Cancel] Invoice cancelled: ${invoiceId}`);
    res.json({ success: true, invoiceId });
  } catch (error) {
    console.error('[Q8QPay Cancel] Error:', error);
    res.status(400).json({ success: false, error: 'Failed to cancel invoice' });
  }
});

/**
 * Paymento Return URL Handler
 * 
 * This is where the user is redirected after completing or canceling payment.
 * IMPORTANT: This is advisory only - do NOT fulfill orders based on this.
 * Order fulfillment is handled exclusively by the webhook/IPN endpoint.
 */
app.get('/api/paymento/return', async (req, res) => {
  const { token, OrderId, OrderStatus } = req.query;
  
  console.log(`[Paymento Return] Token: ${token?.substring(0, 8) || 'N/A'}..., Status: ${OrderStatus}`);

  // Redirect to frontend with status
  // The frontend will poll the status or wait for webhook confirmation
  if (OrderStatus == 7) {
    // Payment completed
    res.redirect(`${BASE_URL}/?payment=success&order=${OrderId}`);
  } else if (OrderStatus == 5) {
    // User canceled
    res.redirect(`${BASE_URL}/?payment=cancelled&order=${OrderId}`);
  } else if (OrderStatus == 4) {
    // Timeout
    res.redirect(`${BASE_URL}/?payment=timeout&order=${OrderId}`);
  } else {
    // Other status - redirect to deposits page
    res.redirect(`${BASE_URL}/deposits?order=${OrderId}`);
  }
});

/**
 * Check Paymento payment status (for frontend polling)
 * SECURITY: Requires authentication - only user can check their own invoice
 */
app.get('/api/paymento/status/:token', authMiddleware, async (req, res) => {
  try {
    const { token } = req.params;
    
    // Verify with Paymento API
    const verifyResult = await paymentoProvider.getInvoiceStatus(token);

    if (!verifyResult.success) {
      return res.status(400).json({ error: 'Could not verify payment' });
    }

    // Find our invoice
    const { data: invoice, error: invoiceError } = await supabase
      .from('payment_invoices')
      .select('*')
      .eq('invoice_id', verifyResult.orderId)
      .single();

    if (invoiceError || !invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Verify the user owns this invoice
    if (invoice.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    res.json({
      success: true,
      status: verifyResult.status,
      statusCode: verifyResult.statusCode,
      credited: invoice.credited,
      amountUsd: invoice.amount_usd,
      orderId: verifyResult.orderId
    });

  } catch (error) {
    console.error('[Paymento Status] Error:', error);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ---------- ADMIN PAYMENT ENDPOINTS ----------

/**
 * Admin: Get all invoices with filtering
 */
app.get('/api/admin/payments/invoices', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { 
      status, 
      userId, 
      provider,
      startDate, 
      endDate, 
      search,
      limit = 100, 
      offset = 0 
    } = req.query;

    let query = supabase
      .from('payment_invoices')
      .select('*, users(name, email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status) {
      query = query.eq('status', status);
    }
    if (userId) {
      query = query.eq('user_id', userId);
    }
    if (provider) {
      query = query.eq('provider', provider);
    }
    if (startDate) {
      query = query.gte('created_at', startDate);
    }
    if (endDate) {
      query = query.lte('created_at', endDate);
    }
    if (search) {
      query = query.or(`invoice_id.ilike.%${search}%,wallet_address.ilike.%${search}%,provider_invoice_id.ilike.%${search}%`);
    }

    const { data: invoices, error, count } = await query;

    if (error) throw error;

    // Format response
    const formattedInvoices = invoices.map(inv => ({
      id: inv.id,
      invoiceId: inv.invoice_id,
      userId: inv.user_id,
      userName: inv.users?.name,
      userEmail: inv.users?.email,
      amountUsd: inv.amount_usd,
      amountCrypto: inv.amount_crypto,
      currency: inv.currency,
      network: inv.network,
      walletAddress: inv.wallet_address,
      provider: inv.provider,
      status: inv.status,
      transactionHash: inv.transaction_hash,
      createdAt: inv.created_at,
      confirmedAt: inv.confirmed_at,
      expiresAt: inv.expires_at
    }));

    res.json({
      success: true,
      invoices: formattedInvoices,
      total: count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('[Admin] Get invoices error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get invoices' 
    });
  }
});

/**
 * Admin: Get webhook logs
 */
app.get('/api/admin/payments/webhook-logs', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { provider, status, limit = 100, offset = 0 } = req.query;

    let query = supabase
      .from('webhook_logs')
      .select('*', { count: 'exact' })
      .order('received_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (provider) {
      query = query.eq('provider', provider);
    }
    if (status) {
      query = query.eq('status', status);
    }

    const { data: logs, error, count } = await query;

    if (error) throw error;

    res.json({
      success: true,
      logs,
      total: count
    });
  } catch (error) {
    console.error('[Admin] Get webhook logs error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get webhook logs' 
    });
  }
});

/**
 * Admin: Retry a failed webhook
 */
app.post('/api/admin/payments/webhook/:id/retry', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the webhook log
    const { data: webhook, error: findError } = await supabase
      .from('webhook_logs')
      .select('*')
      .eq('id', id)
      .single();

    if (findError || !webhook) {
      return res.status(404).json({ 
        success: false, 
        error: 'Webhook not found' 
      });
    }

    if (webhook.status !== 'failed') {
      return res.status(400).json({ 
        success: false, 
        error: 'Can only retry failed webhooks' 
      });
    }

    // Update status to processing
    await supabase
      .from('webhook_logs')
      .update({ status: 'processing' })
      .eq('id', id);

    // Reprocess the webhook
    const result = await paymentService.processWebhook(
      webhook.payload,
      null, // No signature for retry
      webhook.provider
    );

    res.json({
      success: true,
      message: 'Webhook reprocessed',
      result
    });
  } catch (error) {
    console.error('[Admin] Retry webhook error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to retry webhook' 
    });
  }
});

/**
 * Admin: Export invoices to CSV
 */
app.get('/api/admin/payments/export', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { startDate, endDate, status } = req.query;

    let query = supabase
      .from('payment_invoices')
      .select('*, users(name, email, referral_code)')
      .order('created_at', { ascending: false });

    if (startDate) {
      query = query.gte('created_at', startDate);
    }
    if (endDate) {
      query = query.lte('created_at', endDate);
    }
    if (status) {
      query = query.eq('status', status);
    }

    const { data: invoices, error } = await query;

    if (error) throw error;

    // Generate CSV
    const csvHeader = 'ID,Invoice ID,User ID,User Name,User Email,Amount USD,Amount Crypto,Currency,Network,Wallet Address,Provider,Status,Transaction Hash,Created At,Confirmed At\n';
    
    const csvRows = invoices.map(inv => [
      inv.id,
      inv.invoice_id,
      inv.user_id,
      inv.users?.name || '',
      inv.users?.email || '',
      inv.amount_usd,
      inv.amount_crypto || '',
      inv.currency,
      inv.network,
      inv.wallet_address || '',
      inv.provider,
      inv.status,
      inv.transaction_hash || '',
      inv.created_at,
      inv.confirmed_at || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

    const csv = csvHeader + csvRows;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payments_${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('[Admin] Export error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to export payments' 
    });
  }
});

/**
 * Admin: Get payment statistics
 */
app.get('/api/admin/payments/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    let invoiceQuery = supabase
      .from('payment_invoices')
      .select('amount_usd, status, currency');

    let webhookQuery = supabase
      .from('webhook_logs')
      .select('status, provider');

    if (startDate) {
      invoiceQuery = invoiceQuery.gte('created_at', startDate);
      webhookQuery = webhookQuery.gte('received_at', startDate);
    }
    if (endDate) {
      invoiceQuery = invoiceQuery.lte('created_at', endDate);
      webhookQuery = webhookQuery.lte('received_at', endDate);
    }

    const [invoices, webhooks] = await Promise.all([
      invoiceQuery,
      webhookQuery
    ]);

    // Calculate stats
    const confirmed = invoices.data.filter(i => i.status === 'confirmed');
    const pending = invoices.data.filter(i => i.status === 'pending');
    const expired = invoices.data.filter(i => i.status === 'expired');

    const stats = {
      totalInvoices: invoices.count || invoices.data.length,
      confirmedCount: confirmed.length,
      pendingCount: pending.length,
      expiredCount: expired.length,
      totalDepositedUsd: confirmed.reduce((sum, i) => sum + parseFloat(i.amount_usd || 0), 0),
      averageDepositUsd: confirmed.length > 0 
        ? confirmed.reduce((sum, i) => sum + parseFloat(i.amount_usd || 0), 0) / confirmed.length 
        : 0,
      currencyBreakdown: confirmed.reduce((acc, i) => {
        acc[i.currency] = (acc[i.currency] || 0) + parseFloat(i.amount_usd || 0);
        return acc;
      }, {}),
      webhookStats: {
        total: webhooks.count || webhooks.data.length,
        processed: webhooks.data.filter(w => w.status === 'processed').length,
        failed: webhooks.data.filter(w => w.status === 'failed').length,
        duplicate: webhooks.data.filter(w => w.status === 'duplicate').length
      }
    };

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[Admin] Get stats error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get statistics' 
    });
  }
});

/**
 * Admin: Manual payment confirmation (for deposits via old table)
 */
app.post('/api/admin/payments/:invoiceId/confirm', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const { transactionHash } = req.body;

    // Try new payment_invoices table first
    let { data: invoice, error } = await supabase
      .from('payment_invoices')
      .select('*')
      .eq('invoice_id', invoiceId)
      .single();

    // Fall back to old deposits table
    if (error || !invoice) {
      const { data: oldDeposit, error: oldError } = await supabase
        .from('deposits')
        .select('*')
        .eq('invoice_id', invoiceId)
        .single();

      if (oldError || !oldDeposit) {
        return res.status(404).json({ 
          success: false, 
          error: 'Invoice not found' 
        });
      }

      // Process old deposit confirmation
      if (oldDeposit.status !== 'pending') {
        return res.status(400).json({ 
          success: false, 
          error: `Already ${oldDeposit.status}` 
        });
      }

      // Confirm the deposit
      const isFirst = await isFirstConfirmedDeposit(oldDeposit.user_id);

      await supabase.from('deposits').update({ status: 'confirmed' }).eq('id', oldDeposit.id);
      await updateWallet(oldDeposit.user_id, 'live_balance', oldDeposit.amount);
      await addTransaction(oldDeposit.user_id, 'Deposit', oldDeposit.amount, 'USDT (' + oldDeposit.network + ')');

      if (isFirst) {
        await activateReferralOnQualification(oldDeposit.user_id, 'first_deposit', {
          amount: oldDeposit.amount,
          network: oldDeposit.network
        });
      }

      return res.json({
        success: true,
        message: 'Old deposit confirmed',
        amount: oldDeposit.amount
      });
    }

    // Confirm new payment invoice
    if (invoice.status !== 'pending') {
      return res.status(400).json({ 
        success: false, 
        error: `Already ${invoice.status}` 
      });
    }

    // Use atomic function for confirmation
    const result = await paymentService.confirmPaymentFallback(
      invoice.id,
      invoice.user_id,
      invoice.amount_usd,
      transactionHash || `admin_${req.user.id}_${Date.now()}`
    );

    res.json({
      success: true,
      message: 'Payment confirmed',
      result
    });
  } catch (error) {
    console.error('[Admin] Confirm payment error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to confirm payment' 
    });
  }
});

// ---------- Withdraw ----------
app.post('/api/withdraw/request', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: simulated withdrawal only - never debits a real wallet,
  // never enters the production withdrawals queue/table.
  if (await sandboxHandled(req, res, handleSandboxWithdrawRequest)) return;
  const { amount, address } = req.body;
  const userId = req.user.id;

  // Gate 1 — Identity Verification (KYC) MUST be satisfied BEFORE any other
  // withdrawal eligibility check. An unapproved user receives the existing
  // verificationRequired:true response regardless of the requested amount,
  // balance, address, or trade history. This is an ordering change only; the
  // existing $700 minimum, balance, trade-count, and address requirements
  // below are unchanged in meaning and still enforced after KYC approval.
  const verificationStatus = await kycService.getVerificationStatus(userId);
  if (verificationStatus !== VERIFICATION_STATUS.APPROVED) {
    return res.status(400).json({
      error: 'Identity verification required',
      verificationRequired: true,
      status: verificationStatus,
      redirectTo: '/#/verification'
    });
  }

  // PRESERVED: All existing withdrawal business logic (unchanged order/meaning)
  const wallet = await getWallet(userId);
  if (!amount || amount < 700) return res.status(400).json({ error: 'Min $700' });
  if (amount > wallet.live_balance) return res.status(400).json({ error: 'Insufficient balance' });
  if (!address || address.length < 10) return res.status(400).json({ error: 'Valid address required' });
  const { count } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('type', 'Trade Executed');
  if (count < 1) return res.status(400).json({ error: 'Complete at least 1 trade first' });

  // All existing withdrawal logic continues unchanged
  await updateWallet(userId, 'live_balance', -amount);
  await addTransaction(userId, 'Withdraw', -amount, 'To ' + address.slice(0,6) + '...');
  const { data, error } = await supabase.from('withdrawals').insert({ user_id: userId, amount, address, status: 'pending' }).select().single();
  if (error) throw error;
  res.json({ id: data.id, amount, address, status: 'pending', message: 'Withdrawal submitted.' });
});

app.get('/api/withdraw/history', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: reads simulated withdrawals only.
  if (await sandboxHandled(req, res, handleSandboxWithdrawHistory)) return;
  const { data, error } = await supabase.from('withdrawals').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  res.json(data);
});

// ---------- KYC Verification ----------
// Get user's verification status with levels
app.get('/api/kyc/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await kycService.getVerificationProfile(userId);
    const documents = await kycService.getUserDocuments(userId);
    const completion = await kycService.checkDocumentCompletion(userId);
    const history = await kycService.getVerificationHistory(userId);
    const level = await kycService.getVerificationLevel(userId);
    
    res.json({
      profile: profile ? {
        id: profile.id,
        fullLegalName: profile.full_legal_name,
        dateOfBirth: profile.date_of_birth,
        country: profile.country,
        residentialAddress: profile.residential_address,
        status: profile.status,
        submittedAt: profile.submitted_at,
        reviewedAt: profile.reviewed_at,
        rejectionReason: profile.rejection_reason,
        createdAt: profile.created_at,
        updatedAt: profile.updated_at
      } : null,
      documents: documents.map(d => ({
        id: d.id,
        type: d.document_type,
        originalFilename: d.original_filename,
        fileSize: d.file_size,
        mimeType: d.mime_type,
        uploadedAt: d.upload_completed_at,
        createdAt: d.created_at
      })),
      completion,
      history: history.map(h => ({
        id: h.id,
        previousStatus: h.previous_status,
        newStatus: h.new_status,
        changeSummary: h.change_summary,
        rejectionReason: h.rejection_reason,
        createdAt: h.created_at
      })),
      // Verification levels for progress display
      levels: {
        current: level.current,
        next: level.next,
        progress: level.progress,
        status: level.status,
        message: level.message || null
      }
    });
  } catch (error) {
    console.error('[KYC] Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save/update personal information
// Sandbox accounts must never create real KYC records (screen-recording safety).
async function blockSandboxKyc(req, res) {
  if (await isMarketingSandboxUser(req.user.id)) {
    res.status(403).json({ error: 'Identity verification is not available for marketing sandbox accounts' });
    return true;
  }
  return false;
}

app.post('/api/kyc/personal-info', authMiddleware, async (req, res) => {
  if (await blockSandboxKyc(req, res)) return;
  try {
    const userId = req.user.id;
    const { fullLegalName, dateOfBirth, country, residentialAddress } = req.body;
    
    // Validation
    if (!fullLegalName || fullLegalName.length < 2) {
      return res.status(400).json({ error: 'Full legal name is required (min 2 characters)' });
    }
    if (!dateOfBirth) {
      return res.status(400).json({ error: 'Date of birth is required' });
    }
    if (!country) {
      return res.status(400).json({ error: 'Country is required' });
    }
    if (!residentialAddress || residentialAddress.length < 5) {
      return res.status(400).json({ error: 'Residential address is required (min 5 characters)' });
    }
    
    // Check age (must be 18+)
    const dob = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    if (age < 18) {
      return res.status(400).json({ error: 'You must be at least 18 years old to verify' });
    }
    
    const profile = await kycService.upsertVerificationProfile(userId, {
      fullLegalName,
      dateOfBirth,
      country,
      residentialAddress
    });
    
    res.json({ 
      success: true, 
      message: 'Personal information saved',
      status: profile.status
    });
  } catch (error) {
    console.error('[KYC] Personal info error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload document
app.post('/api/kyc/upload', authMiddleware, async (req, res) => {
  if (await blockSandboxKyc(req, res)) return;
  try {
    const userId = req.user.id;
    
    // Parse multipart form data manually (or use multer in production)
    const contentType = req.headers['content-type'] || '';
    
    // For now, accept base64 encoded files in JSON format
    const { documentType, fileData, fileName, mimeType } = req.body;
    
    if (!documentType || !fileData || !fileName || !mimeType) {
      return res.status(400).json({ error: 'Missing required fields: documentType, fileData, fileName, mimeType' });
    }
    
    // Validate document type
    const validTypes = ['national_id_front', 'national_id_back', 'passport', 'drivers_license_front', 'drivers_license_back', 'selfie_with_id'];
    if (!validTypes.includes(documentType)) {
      return res.status(400).json({ error: 'Invalid document type' });
    }
    
    // Decode base64 file
    let buffer;
    try {
      buffer = Buffer.from(fileData, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid file data encoding' });
    }
    
    const file = {
      originalname: fileName,
      mimetype: mimeType,
      buffer: buffer
    };
    
    const document = await kycService.uploadDocument(userId, documentType, file);
    
    res.json({
      success: true,
      message: 'Document uploaded successfully',
      document: {
        id: document.id,
        type: document.document_type,
        originalFilename: document.original_filename,
        fileSize: document.file_size
      }
    });
  } catch (error) {
    console.error('[KYC] Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete document
app.delete('/api/kyc/document/:documentId', authMiddleware, async (req, res) => {
  if (await blockSandboxKyc(req, res)) return;
  try {
    const userId = req.user.id;
    const { documentId } = req.params;
    
    await kycService.deleteDocument(userId, documentId);
    
    res.json({ success: true, message: 'Document deleted' });
  } catch (error) {
    console.error('[KYC] Delete document error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Submit for review
app.post('/api/kyc/submit', authMiddleware, async (req, res) => {
  if (await blockSandboxKyc(req, res)) return;
  try {
    const userId = req.user.id;
    
    const profile = await kycService.submitForReview(userId);
    
    // Send notification email
    const user = await getUser(userId);
    if (user && getResendClient()) {
      try {
        await getResendClient().emails.send({
          from: EMAIL_CONFIG.from,
          to: user.email,
          subject: 'KYC Verification Submitted - Arbitrix AI',
          html: `
            <h2>Verification Submitted</h2>
            <p>Dear ${user.name || 'User'},</p>
            <p>Your identity verification has been submitted and is now pending review.</p>
            <p>Our team will review your documents within 24-48 hours. You'll receive an email notification once the review is complete.</p>
            <p>Best regards,<br>Arbitrix AI Team</p>
          `
        });
      } catch (emailError) {
        console.error('[KYC] Email error:', emailError);
      }
    }
    
    res.json({
      success: true,
      message: 'Verification submitted for review',
      status: profile.status
    });
  } catch (error) {
    console.error('[KYC] Submit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get document for viewing (returns base64)
app.get('/api/kyc/document/:documentId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { documentId } = req.params;
    const isAdmin = req.user.is_admin;
    
    // SECURITY: Returns signed URL with expiration instead of direct file access
    const document = await kycService.getDocument(userId, documentId, isAdmin);
    
    res.json({
      id: document.id,
      type: document.document_type,
      originalFilename: document.original_filename,
      mimeType: document.mime_type,
      // Return signed URL instead of file buffer
      signedUrl: document.signed_url,
      signedUrlExpiresIn: document.signed_url_expires_in
    });
  } catch (error) {
    console.error('[KYC] Get document error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check if user can withdraw (combined check)
app.get('/api/kyc/can-withdraw', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    // MARKETING_SANDBOX: withdrawals are simulated and skip KYC by design.
    // The sandbox withdraw route enforces its own (balance-only) rules; this
    // read-only capability check just lets the UI proceed for demos. It does
    // NOT grant any production withdrawal capability (that path still branches
    // to the simulated handler server-side).
    if (await isMarketingSandboxUser(userId)) {
      return res.json({ canWithdraw: true, verificationStatus: 'sandbox', message: 'Sandbox withdrawal (simulated)' });
    }
    const status = await kycService.getVerificationStatus(userId);
    const isVerified = status === VERIFICATION_STATUS.APPROVED;
    
    res.json({
      canWithdraw: isVerified,
      verificationStatus: status,
      message: isVerified 
        ? 'Identity verified' 
        : status === 'pending_review' 
          ? 'Verification pending review' 
          : 'Identity verification required'
    });
  } catch (error) {
    console.error('[KYC] Can withdraw error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------- Admin KYC Management ----------
// Get KYC verification list
app.get('/api/admin/kyc/verifications', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query;
    
    const filters = {};
    if (status) filters.status = status;
    if (search) filters.search = search;
    filters.limit = parseInt(limit);
    filters.offset = parseInt(offset);
    
    const verifications = await kycService.searchVerifications(filters);
    
    // Get document counts for each verification
    const enrichedVerifications = await Promise.all(verifications.map(async (v) => {
      const docs = await kycService.getDocumentsByVerificationId(v.id);
      return {
        id: v.id,
        userId: v.user_id,
        userName: v.users?.name,
        userEmail: v.users?.email,
        fullLegalName: v.full_legal_name,
        country: v.country,
        status: v.status,
        submittedAt: v.submitted_at,
        createdAt: v.created_at,
        updatedAt: v.updated_at,
        documentCount: docs.length,
        documents: docs.map(d => ({
          id: d.id,
          type: d.document_type,
          originalFilename: d.original_filename,
          fileSize: d.file_size
        }))
      };
    }));
    
    res.json(enrichedVerifications);
  } catch (error) {
    console.error('[Admin KYC] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get KYC verification details
app.get('/api/admin/kyc/verification/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const details = await kycService.getVerificationDetails(id);
    
    res.json({
      id: details.id,
      userId: details.user_id,
      userName: details.users?.name,
      userEmail: details.users?.email,
      fullLegalName: details.full_legal_name,
      dateOfBirth: details.date_of_birth,
      country: details.country,
      residentialAddress: details.residential_address,
      status: details.status,
      submittedAt: details.submitted_at,
      reviewedAt: details.reviewed_at,
      rejectionReason: details.rejection_reason,
      documents: details.documents.map(d => ({
        id: d.id,
        type: d.document_type,
        originalFilename: d.original_filename,
        fileSize: d.file_size,
        mimeType: d.mime_type
      })),
      history: details.history.map(h => ({
        id: h.id,
        previousStatus: h.previous_status,
        newStatus: h.new_status,
        changeSummary: h.change_summary,
        rejectionReason: h.rejection_reason,
        createdAt: h.created_at
      }))
    });
  } catch (error) {
    console.error('[Admin KYC] Details error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get document for admin (returns signed URL)
app.get('/api/admin/kyc/document/:documentId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { documentId } = req.params;
    const adminId = req.user.id;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    // SECURITY: Log admin access for audit trail
    await kycService.logDocumentAccess(adminId, documentId, ipAddress, userAgent);
    
    // Get document with signed URL (admin bypass)
    const document = await kycService.getDocument(null, documentId, true);
    
    res.json({
      id: document.id,
      type: document.document_type,
      originalFilename: document.original_filename,
      mimeType: document.mime_type,
      // Return signed URL instead of file buffer
      signedUrl: document.signed_url,
      signedUrlExpiresIn: document.signed_url_expires_in
    });
  } catch (error) {
    console.error('[Admin KYC] Get document error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Approve verification
app.post('/api/admin/kyc/verification/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    const result = await kycService.adminReview(adminId, id, 'approved', '', ipAddress, userAgent);
    
    // Send notification email
    const details = await kycService.getVerificationDetails(id);
    const user = await getUser(details.user_id);
    if (user && getResendClient()) {
      try {
        await getResendClient().emails.send({
          from: EMAIL_CONFIG.from,
          to: user.email,
          subject: 'KYC Verification Approved - Arbitrix AI',
          html: `
            <h2>Verification Approved</h2>
            <p>Dear ${user.name || 'User'},</p>
            <p>Great news! Your identity verification has been approved.</p>
            <p>You can now proceed with your withdrawals and access all platform features.</p>
            <p>Thank you for completing the verification process.</p>
            <p>Best regards,<br>Arbitrix AI Team</p>
          `
        });
      } catch (emailError) {
        console.error('[Admin KYC] Email error:', emailError);
      }
    }
    
    res.json({ success: true, message: 'Verification approved', status: result.status });
  } catch (error) {
    console.error('[Admin KYC] Approve error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reject verification
app.post('/api/admin/kyc/verification/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user.id;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }
    
    const result = await kycService.adminReview(adminId, id, 'rejected', reason, ipAddress, userAgent);
    
    // Send notification email
    const details = await kycService.getVerificationDetails(id);
    const user = await getUser(details.user_id);
    if (user && getResendClient()) {
      try {
        await getResendClient().emails.send({
          from: EMAIL_CONFIG.from,
          to: user.email,
          subject: 'KYC Verification Rejected - Arbitrix AI',
          html: `
            <h2>Verification Rejected</h2>
            <p>Dear ${user.name || 'User'},</p>
            <p>Unfortunately, your identity verification has been rejected.</p>
            <p><strong>Reason:</strong> ${reason}</p>
            <p>You can resubmit your verification with corrected documents. Please ensure:</p>
            <ul>
              <li>Documents are clear and readable</li>
              <li>All information matches your submitted details</li>
              <li>Selfie clearly shows your face holding the ID</li>
            </ul>
            <p>Best regards,<br>Arbitrix AI Team</p>
          `
        });
      } catch (emailError) {
        console.error('[Admin KYC] Email error:', emailError);
      }
    }
    
    res.json({ success: true, message: 'Verification rejected', status: result.status });
  } catch (error) {
    console.error('[Admin KYC] Reject error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Request resubmission
app.post('/api/admin/kyc/verification/:id/resubmission', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user.id;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Reason for resubmission is required' });
    }
    
    const result = await kycService.adminReview(adminId, id, 'requested_resubmission', reason, ipAddress, userAgent);
    
    // Send notification email
    const details = await kycService.getVerificationDetails(id);
    const user = await getUser(details.user_id);
    if (user && getResendClient()) {
      try {
        await getResendClient().emails.send({
          from: EMAIL_CONFIG.from,
          to: user.email,
          subject: 'KYC Resubmission Required - Arbitrix AI',
          html: `
            <h2>Additional Information Required</h2>
            <p>Dear ${user.name || 'User'},</p>
            <p>We need additional information to complete your identity verification.</p>
            <p><strong>Details:</strong> ${reason}</p>
            <p>Please log in to the Verification Center to submit the requested documents.</p>
            <p>Best regards,<br>Arbitrix AI Team</p>
          `
        });
      } catch (emailError) {
        console.error('[Admin KYC] Email error:', emailError);
      }
    }
    
    res.json({ success: true, message: 'Resubmission requested', status: result.status });
  } catch (error) {
    console.error('[Admin KYC] Resubmission error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get KYC statistics
app.get('/api/admin/kyc/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const stats = await kycService.getAdminStats();
    res.json(stats);
  } catch (error) {
    console.error('[Admin KYC] Stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get KYC configuration
app.get('/api/kyc/config', async (req, res) => {
  res.json({
    maxFileSizeMB: 10,
    allowedFormats: ['image/jpeg', 'image/png', 'image/webp'],
    documentTypes: {
      national_id_front: { label: 'National ID (Front)', required: true, category: 'identity' },
      national_id_back: { label: 'National ID (Back)', required: false, category: 'identity' },
      passport: { label: 'Passport', required: true, category: 'identity' },
      drivers_license_front: { label: "Driver's License (Front)", required: true, category: 'identity' },
      drivers_license_back: { label: "Driver's License (Back)", required: false, category: 'identity' },
      selfie_with_id: { label: 'Selfie with ID', required: true, category: 'selfie' }
    }
  });
});

// ---------- Bot ----------
app.post('/api/bot/start', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: simulated bot session only.
  if (await sandboxHandled(req, res, handleSandboxBotStart)) return;
  const userId = req.user.id;
  // Server-authoritative: only an explicit 'demo' request gets demo behavior;
  // a missing/unexpected client mode is treated as live-style trading so the
  // client can never bypass the MTA gate via the mode field. The balance is
  // read from the server wallet, never from the request.
  const mode = req.body && req.body.mode === 'demo' ? 'demo' : 'live';
  const wallet = await getWallet(userId);
  if (mode === 'live' && Number(wallet.live_balance) < BOT_MIN_TRADING_BALANCE) {
    return res.status(400).json({ error: 'MTA not reached' });
  }
  await supabase.from('bot_sessions').upsert({ user_id: userId, is_running: 1, mode, started_at: new Date().toISOString() }, { onConflict: 'user_id' });
  res.json({ status: 'started', mode });
});

app.post('/api/bot/stop', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: simulated bot session only.
  if (await sandboxHandled(req, res, handleSandboxBotStop)) return;
  await supabase.from('bot_sessions').update({ is_running: 0 }).eq('user_id', req.user.id);
  res.json({ status: 'stopped' });
});

app.get('/api/bot/status', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: simulated bot session only.
  if (await sandboxHandled(req, res, handleSandboxBotStatus)) return;
  const { data, error } = await supabase.from('bot_sessions').select('*').eq('user_id', req.user.id).single();
  if (error && error.code !== 'PGRST116') throw error;
  res.json({ isRunning: data ? data.is_running===1 : false, mode: data ? data.mode : 'demo', startedAt: data ? data.started_at : null });
});

// ---------- Trade (server-authoritative realized P&L) ----------
// Records a realized trade atomically via the record_trade_safe() SECURITY
// DEFINER function (idempotency key -> FOR UPDATE wallet lock -> double-check
// -> live_balance += amount (clamped at 0) -> trades ledger + transactions
// row of type='Trade Executed'). The returned newBalance is the authoritative
// balance; clients reconcile to it. Mirrors the credit_payment_safe pattern
// used for deposits. Demo/bonus modes stay client-side (no server wallet).
app.post('/api/trade', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: simulated trade recording only (sandbox_record_trade;
  // record_trade_safe and the production trades/wallets tables are untouched).
  if (await sandboxHandled(req, res, handleSandboxTrade)) return;
  try {
    const userId = req.user.id;
    const { amount, asset, detail, idempotencyKey } = req.body;

    if (typeof amount !== 'number' || !isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'Invalid trade amount' });
    }
    // Bound the magnitude: a single trade cannot move the balance by more than
    // the current balance (protects against absurd client-supplied losses).
    const wallet = await getWallet(userId);
    const currentBalance = Number(wallet.live_balance) || 0;
    if (Math.abs(amount) > Math.max(currentBalance, 1)) {
      return res.status(400).json({ error: 'Trade amount exceeds balance' });
    }
    // 2-dp precision to match DECIMAL(18,2).
    const amount2dp = Math.round(amount * 100) / 100;
    const key = (idempotencyKey && String(idempotencyKey).trim()) ||
      `trade_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const { data, error } = await supabaseAdmin.rpc('record_trade_safe', {
      p_user_id: userId,
      p_amount: amount2dp,
      p_idempotency_key: key,
      p_mode: 'live',
      p_asset: asset || null,
      p_detail: detail || null,
    });
    if (error) throw error;

    const result = (data && typeof data === 'object') ? data : { success: false, error: 'Invalid response from record_trade_safe' };
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Trade recording failed' });
    }
    // Re-read today's realized P&L from the ledger after the (idempotent) write
    // so the client can reconcile "Today's P&L" to the exact server-persisted
    // total. record_trade_safe() itself is unchanged; this is a read-only sum.
    const todayRealizedPnl = await getTodayRealizedPnl(userId).catch(() => 0);
    res.json({
      success: true,
      duplicate: !!result.duplicate,
      tradeId: result.trade_id,
      appliedAmount: Number(result.applied_amount),
      newBalance: Number(result.new_balance),
      todayRealizedPnl: Number(todayRealizedPnl) || 0,
    });
  } catch (err) {
    console.error('[POST /api/trade]', err);
    res.status(500).json({ error: 'Server error recording trade' });
  }
});

// ---------- Transactions ----------
app.get('/api/transactions', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: reads the simulated transaction log only.
  if (await sandboxHandled(req, res, handleSandboxTransactions)) return;
  const { data, error } = await supabase.from('transactions').select('id, type, amount, detail, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  res.json(data);
});

// ---------- Arbitrix Pro Subscription ----------
// All subscription endpoints derive the user id from the authenticated request
// (authMiddleware sets req.user from the verified JWT). The client NEVER
// supplies userId, price, balance, billing date, or subscription status. The
// subscription is an internal debit of wallets.live_balance only; deposit /
// payment / webhook / withdrawal / KYC / 2FA / trading / referral logic is
// untouched. Subscription status is NOT a withdrawal gate (Phase 7A gates are
// unchanged).

// GET /api/subscription — current subscription state + server price. Also
// performs an idempotent due-billing check server-side so a due subscription
// is collected (or marked payment_due) when the user views the panel. The
// response is read-only from the client's perspective.
app.get('/api/subscription', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: reads/bills the simulated subscription only.
  if (await sandboxHandled(req, res, handleSandboxSubscriptionGet)) return;
  try {
    const userId = req.user.id;
    const price = await getSubscriptionPrice();

    // Idempotent due-billing (server decides; client never triggers a charge).
    // If billing is not due this is a no-op; if due it charges once or marks
    // payment_due. Any error here is non-fatal to reading status.
    await processDueSubscription(userId).catch((e) => {
      console.log('[GET /api/subscription] billing check error:', e.message);
    });

    const sub = await getSubscription(userId);
    res.json({
      plan: sub ? sub.plan : 'pro',
      price: Number(price),
      status: sub ? sub.status : 'inactive',
      startedAt: sub ? sub.started_at : null,
      nextBillingDate: sub ? sub.next_billing_date : null,
      lastBillingDate: sub ? sub.last_billing_date : null,
      lastChargeAmount: sub && sub.last_charge_amount != null ? Number(sub.last_charge_amount) : null,
    });
  } catch (err) {
    console.error('[GET /api/subscription]', err);
    res.status(500).json({ error: 'Server error fetching subscription' });
  }
});

// POST /api/subscription/activate — explicit user action to start Pro. Does NOT
// auto-charge on registration. The user understands $7/month is deducted from
// available Live balance. Server computes price + idempotency key; client
// supplies nothing authoritative. On sufficient balance the first month is
// charged immediately and the subscription becomes 'active'; on insufficient
// balance the subscription is created as 'payment_due' with $0 charged (no debt,
// no negative balance, existing funds preserved). Any body the client sends
// (e.g. a fake price) is ignored.
app.post('/api/subscription/activate', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: simulated $7 deduction only (sandbox_charge_subscription;
  // charge_subscription_safe and the production wallet are never invoked).
  if (await sandboxHandled(req, res, handleSandboxSubscriptionActivate)) return;
  try {
    const userId = req.user.id;
    const price = await getSubscriptionPrice();

    // Ensure a subscription row exists for this user (idempotent upsert). If one
    // already exists and is active/cancelled, honor that state below.
    let sub = await getSubscription(userId);
    if (!sub) {
      const { data: created, error: createErr } = await supabaseAdmin
        .from('subscriptions')
        .insert({
          user_id: userId,
          plan: 'pro',
          price,
          status: 'inactive',
        })
        .select()
        .single();
      if (createErr) throw createErr;
      sub = created;
    }

    if (sub.status === 'active') {
      return res.json({
        success: true,
        duplicate: true,
        message: 'Subscription already active',
        price: Number(price),
        status: 'active',
        nextBillingDate: sub.next_billing_date,
      });
    }
    // ELIGIBILITY GATE: a confirmed real deposit is required before any charge.
    // The $50 Live promotional credit (seeded into wallets.live_balance) does
    // NOT qualify. Runs BEFORE any status mutation or RPC so a promo-only user
    // can never activate. Server-side only (hasConfirmedDeposit); the client
    // cannot influence balance/deposit/status. No charge, no ledger entry, no
    // status change when ineligible — the promo balance is untouched.
    if (!(await hasSubscriptionFundingEligibility(userId))) {
      return res.json({
        success: false,
        reason: 'deposit_required',
        message: 'Make a deposit to activate your subscription.',
        price: Number(price),
        charged: 0,
        newBalance: null,
        status: sub.status,
        nextBillingDate: sub.next_billing_date,
      });
    }
    if (sub.status === 'cancelled') {
      // Re-activate: clear cancelled so billing can proceed.
      await supabaseAdmin.from('subscriptions')
        .update({ status: 'payment_due', updated_at: new Date().toISOString() })
        .eq('user_id', userId);
    }

    // Charge the first month immediately (or mark payment_due). The idempotency
    // key is derived from the current UTC month so activation is charged at most
    // once per period even on duplicate/retried requests.
    const { periodLabel, idempotencyKey } = subscriptionBillingKey(userId, new Date(), 'activate');
    const { data, error } = await supabaseAdmin.rpc('charge_subscription_safe', {
      p_user_id: userId,
      p_price: price,
      p_idempotency_key: idempotencyKey,
      p_period_label: periodLabel,
      p_billing_kind: 'activate',
    });
    if (error) throw error;
    const result = (data && typeof data === 'object') ? data : { success: false, error: 'Invalid response from charge_subscription_safe' };

    const updated = await getSubscription(userId);
    res.json({
      success: !!result.success,
      duplicate: !!result.duplicate,
      reason: result.reason || null,
      message: result.message || null,
      price: Number(price),
      charged: !!result.success && !result.duplicate ? Number(result.price) : 0,
      newBalance: (result.new_balance != null) ? Number(result.new_balance) : null,
      status: updated ? updated.status : (result.success ? 'active' : 'payment_due'),
      nextBillingDate: updated ? updated.next_billing_date : null,
    });
  } catch (err) {
    console.error('[POST /api/subscription/activate]', err);
    res.status(500).json({ error: 'Server error activating subscription' });
  }
});

// POST /api/subscription/cancel — user cancels Pro. No refund; status becomes
// 'cancelled' and the user retains Pro until the already-paid period ends.
// A cancelled subscription is never billed again until re-activated.
app.post('/api/subscription/cancel', authMiddleware, async (req, res) => {
  // MARKETING_SANDBOX: cancels the simulated subscription only.
  if (await sandboxHandled(req, res, handleSandboxSubscriptionCancel)) return;
  try {
    const userId = req.user.id;
    const sub = await getSubscription(userId);
    if (!sub) return res.status(404).json({ error: 'No subscription' });
    if (sub.status === 'cancelled') {
      return res.json({ success: true, duplicate: true, status: 'cancelled' });
    }
    const { error } = await supabaseAdmin.from('subscriptions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) throw error;
    res.json({ success: true, status: 'cancelled', nextBillingDate: sub.next_billing_date });
  } catch (err) {
    console.error('[POST /api/subscription/cancel]', err);
    res.status(500).json({ error: 'Server error cancelling subscription' });
  }
});

// ---------- MARKETING SANDBOX: self-service routes ----------
// All routes require auth AND the caller being a MARKETING_SANDBOX account
// (sandboxOnlyMiddleware re-checks users.environment server-side on every call).

app.get('/api/sandbox/state', authMiddleware, sandboxOnlyMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const wallet = await getSandboxWallet(userId);
    const sub = await getSandboxSubscription(userId);
    const { data: bot } = await supabaseAdmin
      .from('sandbox_bot_sessions')
      .select('is_running, mode, started_at')
      .eq('user_id', userId)
      .single();
    const todayRealizedPnl = await getSandboxTodayRealizedPnl(userId).catch(() => 0);
    const price = await getSubscriptionPrice();
    res.json({
      environment: ENV_MARKETING_SANDBOX,
      simulated: true,
      balance: wallet.live_balance,
      introDay: wallet.intro_day,
      introActive: wallet.intro_day <= 14,
      badgeHidden: wallet.badge_hidden,
      todayRealizedPnl: Number(todayRealizedPnl) || 0,
      bot: {
        isRunning: bot ? bot.is_running === 1 : false,
        mode: bot ? bot.mode : 'live',
        startedAt: bot ? bot.started_at : null,
      },
      subscription: {
        plan: sub ? sub.plan : 'pro',
        price: Number(price),
        status: sub ? sub.status : 'inactive',
        nextBillingDate: sub ? sub.next_billing_date : null,
        lastBillingDate: sub ? sub.last_billing_date : null,
      },
    });
  } catch (err) {
    console.error('[GET /api/sandbox/state]', err);
    res.status(500).json({ error: 'Server error fetching sandbox state' });
  }
});

app.post('/api/sandbox/reset', authMiddleware, sandboxOnlyMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('sandbox_reset_account', { p_user_id: req.user.id });
    if (error) throw error;
    res.json({ success: true, result: data });
  } catch (err) {
    console.error('[POST /api/sandbox/reset]', err);
    res.status(500).json({ error: 'Server error resetting sandbox account' });
  }
});

app.post('/api/sandbox/balance', authMiddleware, sandboxOnlyMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('sandbox_set_balance', {
      p_user_id: req.user.id,
      p_amount: Number(req.body && req.body.amount),
    });
    if (error) throw error;
    if (!data || !data.success) return res.status(400).json({ error: (data && data.error) || 'Invalid amount' });
    res.json({ success: true, balance: Number(data.balance) });
  } catch (err) {
    console.error('[POST /api/sandbox/balance]', err);
    res.status(500).json({ error: 'Server error setting simulated balance' });
  }
});

app.post('/api/sandbox/intro-day', authMiddleware, sandboxOnlyMiddleware, async (req, res) => {
  try {
    const day = parseInt(req.body && req.body.day, 10);
    if (!Number.isInteger(day) || day < 1 || day > 15) {
      return res.status(400).json({ error: 'day must be an integer between 1 and 15' });
    }
    await supabaseAdmin.from('sandbox_wallets')
      .update({ intro_day: day, updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id);
    res.json({ success: true, introDay: day });
  } catch (err) {
    console.error('[POST /api/sandbox/intro-day]', err);
    res.status(500).json({ error: 'Server error setting introductory day' });
  }
});

app.post('/api/sandbox/badge', authMiddleware, sandboxOnlyMiddleware, async (req, res) => {
  try {
    const hidden = !!(req.body && req.body.hidden);
    await supabaseAdmin.from('sandbox_wallets')
      .update({ badge_hidden: hidden, updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id);
    res.json({ success: true, badgeHidden: hidden });
  } catch (err) {
    console.error('[POST /api/sandbox/badge]', err);
    res.status(500).json({ error: 'Server error updating badge' });
  }
});

// ---------- MARKETING SANDBOX: marketing admin controls ----------
// Every control: (1) requires auth + admin, and (2) verifies server-side that
// the TARGET user's environment === MARKETING_SANDBOX (requireSandboxTargetUser).
// If that check fails the request is rejected with an authorization error and
// NOTHING is written. A sandbox account can never be converted to/from a
// production account (DB immutability trigger), and these controls can only
// touch sandbox_* tables.

app.get('/api/admin/sandbox/accounts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, name, email, created_at, environment, sandbox_wallets(balance, intro_day, badge_hidden)')
      .eq('environment', ENV_MARKETING_SANDBOX)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ accounts: data || [] });
  } catch (err) {
    console.error('[GET /api/admin/sandbox/accounts]', err);
    res.status(500).json({ error: 'Server error listing sandbox accounts' });
  }
});

// Create a new dedicated MARKETING_SANDBOX account with a fictional identity.
// environment is set ONCE here and is immutable (DB trigger). No production
// wallet row is created - only the sandbox wallet.
app.post('/api/admin/sandbox/accounts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const name = (req.body && req.body.name) || 'Marketing Demo';
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const email = ((req.body && req.body.email) || `marketing-demo+${stamp}@sandbox.arbitrix.invalid`).trim().toLowerCase();
    const password = (req.body && req.body.password) || (crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) + 'Sx1!');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const existing = await getUserByEmail(email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hash = bcrypt.hashSync(password, 10);
    const referralCode = await generateUniqueReferralCode();
    const { data: user, error } = await supabaseAdmin.from('users').insert({
      name,
      email,
      password_hash: hash,
      referral_code: referralCode,
      is_admin: 0,
      environment: ENV_MARKETING_SANDBOX,
    }).select('id, name, email, environment').single();
    if (error) throw error;
    // Simulated wallet only (NO production wallets row).
    await supabaseAdmin.from('sandbox_wallets').insert({ user_id: user.id });
    res.json({
      success: true,
      account: { id: user.id, name: user.name, email: user.email, environment: user.environment },
      // One-time credential display for the marketing operator.
      credentials: { email, password },
    });
  } catch (err) {
    console.error('[POST /api/admin/sandbox/accounts]', err);
    res.status(500).json({ error: 'Server error creating sandbox account' });
  }
});

app.post('/api/admin/sandbox/:userId/reset', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const targetId = await requireSandboxTargetUser(req, res);
    if (targetId === null) return;
    const { data, error } = await supabaseAdmin.rpc('sandbox_reset_account', { p_user_id: targetId });
    if (error) throw error;
    res.json({ success: true, result: data });
  } catch (err) {
    console.error('[POST /api/admin/sandbox/reset]', err);
    res.status(500).json({ error: 'Server error resetting sandbox account' });
  }
});

app.post('/api/admin/sandbox/:userId/balance', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const targetId = await requireSandboxTargetUser(req, res);
    if (targetId === null) return;
    const { data, error } = await supabaseAdmin.rpc('sandbox_set_balance', {
      p_user_id: targetId,
      p_amount: Number(req.body && req.body.amount),
    });
    if (error) throw error;
    if (!data || !data.success) return res.status(400).json({ error: (data && data.error) || 'Invalid amount' });
    res.json({ success: true, balance: Number(data.balance) });
  } catch (err) {
    console.error('[POST /api/admin/sandbox/balance]', err);
    res.status(500).json({ error: 'Server error setting simulated balance' });
  }
});

app.post('/api/admin/sandbox/:userId/intro-day', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const targetId = await requireSandboxTargetUser(req, res);
    if (targetId === null) return;
    const day = parseInt(req.body && req.body.day, 10);
    if (!Number.isInteger(day) || day < 1 || day > 15) {
      return res.status(400).json({ error: 'day must be an integer between 1 and 15' });
    }
    await supabaseAdmin.from('sandbox_wallets')
      .update({ intro_day: day, updated_at: new Date().toISOString() })
      .eq('user_id', targetId);
    res.json({ success: true, introDay: day });
  } catch (err) {
    console.error('[POST /api/admin/sandbox/intro-day]', err);
    res.status(500).json({ error: 'Server error setting introductory day' });
  }
});

app.post('/api/admin/sandbox/:userId/badge', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const targetId = await requireSandboxTargetUser(req, res);
    if (targetId === null) return;
    const hidden = !!(req.body && req.body.hidden);
    await supabaseAdmin.from('sandbox_wallets')
      .update({ badge_hidden: hidden, updated_at: new Date().toISOString() })
      .eq('user_id', targetId);
    res.json({ success: true, badgeHidden: hidden });
  } catch (err) {
    console.error('[POST /api/admin/sandbox/badge]', err);
    res.status(500).json({ error: 'Server error updating badge' });
  }
});

// Controlled demonstration engine: generate N simulated trades with a target
// P&L profile. ALL records go to sandbox_trades/sandbox_transactions with
// is_simulated=true and unique idempotency keys - unmistakably demonstration
// data, never production trading results.
app.post('/api/admin/sandbox/:userId/trades', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const targetId = await requireSandboxTargetUser(req, res);
    if (targetId === null) return;
    const count = Math.min(Math.max(parseInt(req.body && req.body.count, 10) || 0, 0), 50);
    if (count < 1) return res.status(400).json({ error: 'count must be between 1 and 50' });
    // avgPnl: signed USD per trade (can be forced positive/negative for demos);
    // jitter adds variance. asset is optional (randomized if omitted).
    const avgPnl = Number(req.body && req.body.avgPnl);
    const jitter = Math.max(Number(req.body && req.body.jitter) || 0, 0);
    if (!isFinite(avgPnl)) return res.status(400).json({ error: 'avgPnl must be a number' });
    const assets = req.body && req.body.asset
      ? [{ symbol: String(req.body.asset).slice(0, 40), detail: 'Demo' }]
      : [
        { symbol: 'BTC/USDT', detail: 'Binance→Bybit' },
        { symbol: 'ETH/USDT', detail: 'Binance→Coinbase' },
        { symbol: 'SOL/USDT', detail: 'Kraken→OKX' },
        { symbol: 'XRP/USDT', detail: 'Coinbase→Bitstamp' },
      ];
    const results = [];
    for (let i = 0; i < count; i++) {
      const variance = jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0;
      const amount = Math.round((avgPnl + variance) * 100) / 100;
      if (amount === 0) continue;
      const asset = assets[Math.floor(Math.random() * assets.length)];
      const key = `sbx_demo_${targetId}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;
      const { data, error } = await supabaseAdmin.rpc('sandbox_record_trade', {
        p_user_id: targetId,
        p_amount: amount,
        p_idempotency_key: key,
        p_asset: asset.symbol,
        p_detail: asset.detail,
      });
      if (error) throw error;
      results.push({ amount, newBalance: data && data.new_balance != null ? Number(data.new_balance) : null, success: !!(data && data.success) });
    }
    res.json({ success: true, generated: results.length, trades: results });
  } catch (err) {
    console.error('[POST /api/admin/sandbox/trades]', err);
    res.status(500).json({ error: 'Server error generating demonstration trades' });
  }
});

app.post('/api/admin/sandbox/:userId/bot', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const targetId = await requireSandboxTargetUser(req, res);
    if (targetId === null) return;
    const action = req.body && req.body.action;
    if (action !== 'start' && action !== 'stop') {
      return res.status(400).json({ error: "action must be 'start' or 'stop'" });
    }
    if (action === 'start') {
      await supabaseAdmin.from('sandbox_bot_sessions').upsert(
        { user_id: targetId, is_running: 1, mode: 'live', started_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
    } else {
      await supabaseAdmin.from('sandbox_bot_sessions').update({ is_running: 0 }).eq('user_id', targetId);
    }
    res.json({ success: true, isRunning: action === 'start' });
  } catch (err) {
    console.error('[POST /api/admin/sandbox/bot]', err);
    res.status(500).json({ error: 'Server error updating bot state' });
  }
});

// List the latest simulated withdrawals for a sandbox account (admin visibility
// for picking a demonstration target). Sandbox tables only.
app.get('/api/admin/sandbox/:userId/withdrawals', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const targetId = await requireSandboxTargetUser(req, res);
    if (targetId === null) return;
    await advanceSandboxWithdrawals(targetId);
    const { data, error } = await supabaseAdmin
      .from('sandbox_withdrawals')
      .select('id, amount, address, status, created_at')
      .eq('user_id', targetId)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    res.json({ withdrawals: data || [] });
  } catch (err) {
    console.error('[GET /api/admin/sandbox/withdrawals]', err);
    res.status(500).json({ error: 'Server error listing simulated withdrawals' });
  }
});

app.post('/api/admin/sandbox/:userId/withdrawals/:withdrawalId/status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const targetId = await requireSandboxTargetUser(req, res);
    if (targetId === null) return;
    const withdrawalId = parseInt(req.params.withdrawalId, 10);
    const status = req.body && req.body.status;
    const { data, error } = await supabaseAdmin.rpc('sandbox_set_withdrawal_status', {
      p_user_id: targetId,
      p_withdrawal_id: withdrawalId,
      p_status: status,
    });
    if (error) throw error;
    if (!data || !data.success) return res.status(400).json({ error: (data && data.error) || 'Invalid status' });
    res.json({ success: true, status: data.status });
  } catch (err) {
    console.error('[POST /api/admin/sandbox/withdrawals/status]', err);
    res.status(500).json({ error: 'Server error setting withdrawal status' });
  }
});

// Subscription demonstration controls (simulated only).
app.post('/api/admin/sandbox/:userId/subscription/due', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const targetId = await requireSandboxTargetUser(req, res);
    if (targetId === null) return;
    const price = await getSubscriptionPrice();
    const existing = await getSandboxSubscription(targetId);
    if (existing) {
      await supabaseAdmin.from('sandbox_subscriptions')
        .update({ status: 'payment_due', updated_at: new Date().toISOString() })
        .eq('user_id', targetId);
    } else {
      await supabaseAdmin.from('sandbox_subscriptions')
        .insert({ user_id: targetId, plan: 'pro', price, status: 'payment_due' });
    }
    res.json({ success: true, status: 'payment_due' });
  } catch (err) {
    console.error('[POST /api/admin/sandbox/subscription/due]', err);
    res.status(500).json({ error: 'Server error marking subscription due' });
  }
});

// Trigger a simulated $7 deduction for the current billing period (uses the
// sandbox charge RPC; a real wallet can never be debited).
app.post('/api/admin/sandbox/:userId/subscription/charge', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const targetId = await requireSandboxTargetUser(req, res);
    if (targetId === null) return;
    const price = await getSubscriptionPrice();
    const { periodLabel, idempotencyKey } = subscriptionBillingKey(targetId, new Date(), 'demo');
    const { data, error } = await supabaseAdmin.rpc('sandbox_charge_subscription', {
      p_user_id: targetId,
      p_price: price,
      p_idempotency_key: idempotencyKey,
      p_period_label: periodLabel,
      p_billing_kind: 'demo',
    });
    if (error) throw error;
    const result = (data && typeof data === 'object') ? data : { success: false, error: 'Invalid response' };
    res.json({
      success: !!result.success,
      duplicate: !!result.duplicate,
      reason: result.reason || null,
      price: Number(price),
      charged: !!result.success && !result.duplicate ? Number(result.price) : 0,
      newBalance: result.new_balance != null ? Number(result.new_balance) : null,
      status: result.status || null,
    });
  } catch (err) {
    console.error('[POST /api/admin/sandbox/subscription/charge]', err);
    res.status(500).json({ error: 'Server error simulating subscription charge' });
  }
});

// ---------- Referral Configuration ----------
// Configuration validation rules
const CONFIG_VALIDATION = {
  rewards_enabled: {
    type: 'boolean',
    validValues: ['true', 'false'],
    description: 'Enable or disable referral rewards system-wide'
  },
  minimum_qualifying_deposit: {
    type: 'number',
    min: 0,
    max: 10000,
    description: 'Minimum deposit amount required for referral qualification (USD)'
  },
  referral_reward_amount: {
    type: 'number',
    min: 0,
    max: 1000,
    description: 'Amount awarded to referrer when referral qualifies (USD)'
  },
  first_deposit_required: {
    type: 'boolean',
    validValues: ['true', 'false'],
    description: 'Whether referral requires first deposit to qualify'
  },
  max_rewards_per_user: {
    type: 'number',
    min: 0,
    max: 10000,
    description: 'Maximum rewards per user (0 = unlimited)'
  }
};

// Get referral configuration (public endpoint - minimum info only)
app.get('/api/referral/config', async (req, res) => {
  try {
    const config = await getReferralConfigAll();
    
    // Return only public config values needed by frontend
    // No internal details, descriptions, or metadata exposed
    res.json({
      rewardsEnabled: config.rewards_enabled?.value === 'true',
      minimumDeposit: parseConfigValue(config.minimum_qualifying_deposit?.value || '50'),
      rewardAmount: parseConfigValue(config.referral_reward_amount?.value || '10'),
      firstDepositRequired: config.first_deposit_required?.value === 'true',
      maxRewardsPerUser: parseConfigValue(config.max_rewards_per_user?.value || '0')
    });
  } catch (e) {
    console.error('Error fetching referral config:', e.message);
    // Return defaults on error - do NOT expose internal error details
    res.json({
      rewardsEnabled: true,
      minimumDeposit: 50,
      rewardAmount: 10,
      firstDepositRequired: true,
      maxRewardsPerUser: 0
    });
  }
});

// Get detailed referral configuration (admin only)
app.get('/api/referral/config/admin', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const config = await getReferralConfigAll();
    res.json({
      config,
      validationRules: CONFIG_VALIDATION
    });
  } catch (e) {
    console.error('Admin config fetch error:', e.message);
    res.status(500).json({ 
      error: 'Failed to fetch configuration',
      code: 'CONFIG_FETCH_ERROR'
    });
  }
});

// Get referral configuration audit history (admin only)
app.get('/api/referral/config/audit', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0, sort = 'desc' } = req.query;
    
    // Validate pagination params
    const safeLimit = Math.min(parseInt(limit) || 50, 100);
    const safeOffset = Math.max(parseInt(offset) || 0, 0);
    const safeSort = sort === 'asc' ? 'asc' : 'desc';
    
    const { data, error, count } = await supabase
      .from('referral_config_audit_log')
      .select('id, admin_id, admin_email, config_key, old_value, new_value, ip_address, changed_at, reason', { 
        count: 'exact' 
      })
      .order('changed_at', { ascending: safeSort === 'asc' })
      .range(safeOffset, safeOffset + safeLimit - 1);
    
    if (error) {
      console.error('Audit log fetch error:', error.message);
      throw error;
    }
    
    res.json({
      auditLog: data,
      pagination: {
        total: count || 0,
        limit: safeLimit,
        offset: safeOffset,
        hasMore: (count || 0) > (safeOffset + safeLimit)
      }
    });
  } catch (e) {
    console.error('Audit log error:', e.message);
    res.status(500).json({ 
      error: 'Failed to fetch audit history',
      code: 'AUDIT_FETCH_ERROR'
    });
  }
});

// Update referral configuration (admin only) with audit logging
app.put('/api/referral/config/:key', authMiddleware, adminMiddleware, async (req, res) => {
  const { key } = req.params;
  const { value, reason } = req.body;
  
  // Validate key exists
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ 
      error: 'Configuration key is required',
      code: 'MISSING_KEY'
    });
  }
  
  // Validate value is provided
  if (value === undefined || value === null) {
    return res.status(400).json({ 
      error: 'Configuration value is required',
      code: 'MISSING_VALUE'
    });
  }
  
  // Validate key is in allowed list
  if (!CONFIG_VALIDATION[key]) {
    return res.status(400).json({ 
      error: 'Invalid configuration key: ' + key,
      code: 'INVALID_KEY',
      validKeys: Object.keys(CONFIG_VALIDATION)
    });
  }
  
  const validation = CONFIG_VALIDATION[key];
  const stringValue = String(value).trim();
  
  // Validate based on type
  if (validation.type === 'boolean') {
    if (!validation.validValues.includes(stringValue)) {
      return res.status(400).json({ 
        error: 'Invalid value for ' + key + '. Must be true or false.',
        code: 'INVALID_BOOLEAN',
        currentValue: stringValue,
        allowedValues: validation.validValues
      });
    }
  } else if (validation.type === 'number') {
    const numValue = parseFloat(stringValue);
    if (isNaN(numValue)) {
      return res.status(400).json({ 
        error: 'Invalid value for ' + key + '. Must be a number.',
        code: 'INVALID_NUMBER',
        currentValue: stringValue
      });
    }
    if (numValue < validation.min || numValue > validation.max) {
      return res.status(400).json({ 
        error: 'Value for ' + key + ' must be between ' + validation.min + ' and ' + validation.max,
        code: 'VALUE_OUT_OF_RANGE',
        currentValue: numValue,
        minValue: validation.min,
        maxValue: validation.max
      });
    }
  }
  
  // Get current value for audit log
  const currentConfig = await getReferralConfig(key, null);
  const oldValue = currentConfig;
  
  // Check if value actually changed
  if (oldValue === stringValue) {
    return res.status(400).json({ 
      error: 'Configuration value is unchanged',
      code: 'NO_CHANGE',
      currentValue: oldValue
    });
  }
  
  // Update the configuration
  const success = await setReferralConfig(key, stringValue);
  
  if (!success) {
    console.error('Failed to update config:', key);
    return res.status(500).json({ 
      error: 'Failed to update configuration',
      code: 'UPDATE_FAILED'
    });
  }
  
  // Log the change to audit trail
  try {
    const adminId = req.user.id;
    const adminEmail = req.user.email;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;
    
    await supabase.rpc('log_referral_config_change', {
      p_admin_id: adminId,
      p_admin_email: adminEmail,
      p_config_key: key,
      p_old_value: oldValue,
      p_new_value: stringValue,
      p_ip_address: ipAddress,
      p_user_agent: userAgent,
      p_reason: reason || null
    });
    
    console.log(`[AUDIT] Referral config updated by ${adminEmail}: ${key} = ${stringValue} (was: ${oldValue})`);
  } catch (auditError) {
    // Audit logging failure should not fail the main operation
    console.error('Audit logging failed:', auditError.message);
  }
  
  // Return success response
  const updatedConfig = await getReferralConfigAll();
  res.json({ 
    success: true, 
    config: updatedConfig,
    changes: {
      key,
      oldValue,
      newValue: stringValue
    }
  });
});

app.get('/api/referral/stats', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  
  // Get all referrals made by this user
  const { data: referrals, error } = await supabase
    .from('referrals')
    .select('bonus_earned, status')
    .eq('referrer_id', userId);
  
  if (error) throw error;
  
  // Calculate stats
  const totalReferrals = referrals ? referrals.length : 0;
  const totalEarned = referrals.reduce((sum, r) => sum + (r.bonus_earned || 0), 0);
  const activeReferrals = referrals.filter(r => r.status === 'active').length;
  const pendingReferrals = referrals.filter(r => r.status === 'pending').length;
  
  // Get config for display
  const config = {
    rewardsEnabled: parseConfigValue(await getReferralConfig('rewards_enabled', 'true')),
    rewardAmount: parseConfigValue(await getReferralConfig('referral_reward_amount', '10')),
    minimumDeposit: parseConfigValue(await getReferralConfig('minimum_qualifying_deposit', '50'))
  };
  
  res.json({ 
    totalReferrals, 
    activeReferrals,
    pendingReferrals,
    earned: totalEarned,
    config
  });
});

// Get detailed referral stats (including referral list)
app.get('/api/referral/detailed', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  
  // Get all referrals made by this user
  const { data: referrals, error } = await supabase
    .from('referrals')
    .select(`
      id,
      bonus_earned,
      status,
      created_at,
      qualified_at,
      qualification_type,
      referred:users!referred_id(id, name, email, created_at)
    `)
    .eq('referrer_id', userId)
    .order('created_at', { ascending: false });
  
  if (error) throw error;
  
  // Calculate stats
  const totalReferrals = referrals ? referrals.length : 0;
  const totalEarned = referrals.reduce((sum, r) => sum + (r.bonus_earned || 0), 0);
  const activeReferrals = referrals.filter(r => r.status === 'active').length;
  const pendingReferrals = referrals.filter(r => r.status === 'pending').length;
  
  // Get user's own referral code
  const { data: user } = await supabase
    .from('users')
    .select('referral_code')
    .eq('id', userId)
    .single();
  
  res.json({
    referralCode: user?.referral_code || null,
    totalReferrals,
    activeReferrals,
    pendingReferrals,
    totalEarned,
    referrals: referrals.map(r => ({
      id: r.id,
      bonusEarned: r.bonus_earned,
      status: r.status,
      registeredAt: r.created_at,
      qualifiedAt: r.qualified_at,
      qualificationType: r.qualification_type,
      referredUser: r.referred ? {
        id: r.referred.id,
        name: r.referred.name,
        email: r.referred.email ? r.referred.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null, // Partially mask email
        joinedAt: r.referred.created_at
      } : null
    }))
  });
});

// Validate a referral code (public endpoint)
app.get('/api/referral/validate/:code', async (req, res) => {
  const code = req.params.code?.trim().toUpperCase();
  
  if (!code || !isValidReferralCodeFormat(code)) {
    return res.json({ valid: false, message: 'Invalid referral code format' });
  }
  
  const { data: user, error } = await supabase
    .from('users')
    .select('id')
    .eq('referral_code', code)
    .single();
  
  if (error && error.code === 'PGRST116') {
    return res.json({ valid: false, message: 'Referral code not found' });
  }
  
  res.json({ valid: true, message: 'Valid referral code' });
});

app.post('/api/referral/simulate', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  await supabase.from('referrals').insert({ referrer_id: userId, referred_id: -userId, bonus_earned: 10 });
  await updateWallet(userId, 'bonus_balance', 10);
  await addTransaction(userId, 'Referral Bonus', 10, 'Simulated referral');
  const { count: invited } = await supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('referrer_id', userId);
  const { data: earnedData } = await supabase.from('referrals').select('bonus_earned').eq('referrer_id', userId);
  const earned = earnedData.reduce((s, r) => s + r.bonus_earned, 0);
  res.json({ invited, earned, bonusAdded: 10 });
});

// ============================================================
// EMAIL 2FA & FEATURE FLAGS HELPERS
// ============================================================

// Helper: Get user email by ID
async function getUserEmail(userId) {
    const { data } = await supabase
        .from('users')
        .select('email')
        .eq('id', userId)
        .single();
    return data?.email;
}

// Helper: Check if user has 2FA enabled (TOTP - for backward compatibility)
async function hasUser2FAEnabled(userId) {
    const { data } = await supabase
        .from('twofa_profiles')
        .select('id, is_enabled, is_verified')
        .eq('user_id', userId)
        .eq('is_enabled', true)
        .single();
    return !!data;
}

// Helper: Get feature flag value (with caching)
async function getFeatureFlag(flagKey, defaultValue = null) {
    const now = Date.now();
    
    // Check cache
    if (featureFlagCache[flagKey] !== undefined && now - featureFlagCacheTime < FEATURE_FLAG_CACHE_TTL) {
        return featureFlagCache[flagKey] ?? defaultValue;
    }
    
    // Fetch from database
    try {
        const { data, error } = await supabase
            .from('feature_flags')
            .select('flag_value')
            .eq('flag_key', flagKey)
            .single();
        
        if (!error && data) {
            featureFlagCache[flagKey] = data.flag_value;
            featureFlagCacheTime = now;
            return data.flag_value;
        }
    } catch (e) {
        console.error('Error fetching feature flag:', e);
    }
    
    return defaultValue;
}

// Helper: Get current 2FA type (email or totp)
async function get2FAType() {
    return await getFeatureFlag('2fa_type', 'email');
}

// Helper: Send email verification code for 2FA
async function sendEmailVerificationCode(userId, email, purpose = 'login_2fa') {
    // Generate code
    const code = Email2FAService.generateCode();
    const codeHash = Email2FAService.hashCode(code);
    const expiresAt = new Date(Date.now() + Email2FAService.CONFIG.CODE_EXPIRY_MS).toISOString();
    
    // Invalidate any existing unused codes for this user and purpose
    await supabase
        .from('email_verification_codes')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('purpose', purpose)
        .eq('used', false);
    
    // Store new code
    await supabase
        .from('email_verification_codes')
        .insert({
            user_id: userId,
            code_hash: codeHash,
            purpose: purpose,
            expires_at: expiresAt,
            used: false
        });
    
    // Get client info
    const clientIP = req => {
        return req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() 
            || req?.socket?.remoteAddress 
            || null;
    };
    
    // Send email (we'll construct the sending inline since we need the code)
    const resend = getResendClient();
    
    if (resend) {
        try {
            await resend.emails.send({
                from: EMAIL_CONFIG.from,
                to: email,
                subject: 'Your Arbitrix AI Verification Code',
                html: generateEmailVerificationTemplate(code)
            });
            console.log(`[EMAIL 2FA] Verification code sent to ${email}`);
        } catch (e) {
            console.error('[EMAIL 2FA] Failed to send email:', e);
        }
    } else {
        // Development mode - log to console
        console.log('═══════════════════════════════════════════════════════════');
        console.log('📧 EMAIL 2FA VERIFICATION CODE (Development Mode)');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`To: ${email}`);
        console.log(`Code: ${code}`);
        console.log(`Expires in: 10 minutes`);
        console.log('═══════════════════════════════════════════════════════════');
    }
    
    return code; // Return plain code for development mode logging
}

// Helper: Generate email template for verification code
function generateEmailVerificationTemplate(code) {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification Code - Arbitrix AI</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td style="background: linear-gradient(135deg, #0d1117 0%, #1a2332 100%); border-radius: 16px 16px 0 0; padding: 40px 30px; text-align: center;">
        <h1 style="margin: 0; color: #ffd700; font-size: 28px; font-weight: 700;">Arbitrix AI</h1>
        <p style="margin: 8px 0 0; color: #8b949e; font-size: 14px;">Multi-Asset Arbitrage Platform</p>
      </td>
    </tr>
    <tr>
      <td style="background-color: #ffffff; padding: 40px 30px;">
        <h2 style="margin: 0 0 20px; color: #1f2937; font-size: 24px; text-align: center;">Your Verification Code</h2>
        <p style="margin: 0 0 30px; color: #4b5563; font-size: 16px; line-height: 1.6; text-align: center;">
          Enter the following code to complete your login:
        </p>
        <div style="background: linear-gradient(135deg, #0d1117 0%, #1a2332 100%); border-radius: 12px; padding: 30px; text-align: center; margin-bottom: 30px;">
          <span style="font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 36px; font-weight: 700; color: #ffd700; letter-spacing: 8px;">${code}</span>
        </div>
        <div style="background-color: #fef3c7; border-radius: 8px; border-left: 4px solid #f59e0b; padding: 16px; margin-bottom: 20px;">
          <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.6;">
            <strong>⚠️ Security Notice:</strong><br>
            • This code expires in <strong>10 minutes</strong><br>
            • If you didn't request this code, please ignore this email<br>
            • Our team will never ask for this code
          </p>
        </div>
      </td>
    </tr>
    <tr>
      <td style="background-color: #f9fafb; border-radius: 0 0 16px 16px; padding: 20px 30px; text-align: center;">
        <p style="margin: 0; color: #6b7280; font-size: 12px;">
          © ${new Date().getFullYear()} Arbitrix AI. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ============================================================
// TOTP 2FA ENDPOINTS (RFC 6238 Compliant)
// NOTE: These endpoints are kept for backward compatibility
// but are disabled when 2fa_type feature flag is set to 'email'
// ============================================================

// GET /api/2fa/status - Get user's 2FA status
app.get('/api/2fa/status', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const { data, error } = await supabase
            .from('twofa_profiles')
            .select('is_enabled, is_verified, enabled_at, last_verified_at, backup_codes_remaining')
            .eq('user_id', userId)
            .single();
        
        if (error && error.code !== 'PGRST116') {
            throw error;
        }
        
        res.json({
            enabled: data?.is_enabled || false,
            verified: data?.is_verified || false,
            enabledAt: data?.enabled_at || null,
            lastVerifiedAt: data?.last_verified_at || null,
            backupCodesRemaining: data?.backup_codes_remaining || 0
        });
    } catch (error) {
        console.error('2FA status error:', error);
        res.status(500).json({ error: 'Failed to get 2FA status' });
    }
});

// POST /api/2fa/setup - Initiate 2FA setup, generate secret and QR code
app.post('/api/2fa/setup', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const userEmail = await getUserEmail(userId);
        
        if (!userEmail) {
            return res.status(400).json({ error: 'User email not found' });
        }
        
        // Check if 2FA is already enabled
        if (await hasUser2FAEnabled(userId)) {
            return res.status(400).json({ error: '2FA is already enabled' });
        }
        
        // Generate new TOTP secret
        const secretBuffer = TOTPService.generateSecret();
        const secretBase32 = TOTPService.base32Encode(secretBuffer);
        
        // Encrypt secret for storage
        const encryptedSecret = TOTPService.encryptSecret(secretBuffer, TOTP_ENCRYPTION_KEY);
        
        // Generate recovery codes
        const recoveryCodes = TOTPService.generateRecoveryCodes();
        const hashedCodes = recoveryCodes.map(code => TOTPService.hashRecoveryCode(code));
        
        // Create or update 2FA profile
        const { data, error } = await supabase
            .from('twofa_profiles')
            .upsert({
                user_id: userId,
                encrypted_secret: encryptedSecret,
                is_enabled: false,
                is_verified: false,
                backup_codes_hash: JSON.stringify(hashedCodes),
                backup_codes_remaining: TOTPService.CONFIG.RECOVERY_CODES_COUNT
            }, { onConflict: 'user_id' })
            .select()
            .single();
        
        if (error) {
            console.error('2FA setup error:', error);
            return res.status(500).json({ error: 'Failed to setup 2FA' });
        }
        
        // Generate QR code URI
        const otpAuthURI = TOTPService.generateOTPAuthURI(secretBase32, userEmail);
        
        res.json({
            success: true,
            secret: secretBase32, // Return plain secret for manual entry
            qrCode: otpAuthURI,
            recoveryCodes: recoveryCodes // Only returned during setup
        });
    } catch (error) {
        console.error('2FA setup error:', error);
        res.status(500).json({ error: 'Failed to setup 2FA' });
    }
});

// POST /api/2fa/verify-setup - Verify setup with a code
app.post('/api/2fa/verify-setup', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { code } = req.body;
        
        if (!code || !/^\d{6}$/.test(code)) {
            return res.status(400).json({ error: 'Invalid code format' });
        }
        
        // Get the 2FA profile
        const { data: profile, error } = await supabase
            .from('twofa_profiles')
            .select('*')
            .eq('user_id', userId)
            .single();
        
        if (error || !profile) {
            return res.status(400).json({ error: '2FA not setup' });
        }
        
        if (profile.is_verified) {
            return res.status(400).json({ error: 'Already verified' });
        }
        
        // Decrypt secret
        let secret;
        try {
            const secretBuffer = TOTPService.decryptSecret(profile.encrypted_secret, TOTP_ENCRYPTION_KEY);
            secret = TOTPService.base32Encode(secretBuffer);
        } catch (e) {
            console.error('Secret decryption error:', e);
            return res.status(500).json({ error: 'Failed to decrypt secret' });
        }
        
        // Verify the code
        if (!TOTPService.verifyTOTP(code, secret)) {
            return res.status(400).json({ error: 'Invalid code' });
        }
        
        // Update profile to verified
        const { error: updateError } = await supabase
            .from('twofa_profiles')
            .update({
                is_verified: true,
                setup_completed_at: new Date().toISOString()
            })
            .eq('user_id', userId);
        
        if (updateError) {
            console.error('2FA verify error:', updateError);
            return res.status(500).json({ error: 'Failed to verify' });
        }
        
        // Log the verification
        await supabase.from('twofa_attempts').insert({
            user_id: userId,
            code_hash: crypto.createHash('sha256').update(code).digest('hex'),
            success: true,
            ip_address: req.ip,
            user_agent: req.get('User-Agent')
        });
        
        res.json({
            success: true,
            message: '2FA setup verified successfully'
        });
    } catch (error) {
        console.error('2FA verify setup error:', error);
        res.status(500).json({ error: 'Failed to verify 2FA' });
    }
});

// POST /api/2fa/enable - Enable 2FA after verification
app.post('/api/2fa/enable', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Check if verified
        const { data: profile, error } = await supabase
            .from('twofa_profiles')
            .select('*')
            .eq('user_id', userId)
            .single();
        
        if (error || !profile) {
            return res.status(400).json({ error: '2FA not setup' });
        }
        
        if (!profile.is_verified) {
            return res.status(400).json({ error: 'Please verify with a code first' });
        }
        
        if (profile.is_enabled) {
            return res.status(400).json({ error: '2FA is already enabled' });
        }
        
        // Enable 2FA
        const { error: updateError } = await supabase
            .from('twofa_profiles')
            .update({
                is_enabled: true,
                enabled_at: new Date().toISOString()
            })
            .eq('user_id', userId);
        
        if (updateError) {
            console.error('2FA enable error:', updateError);
            return res.status(500).json({ error: 'Failed to enable 2FA' });
        }
        
        // Log admin action if this is admin enabling for user
        if (req.body.userId && req.user.is_admin) {
            await supabase.from('audit_logs').insert({
                action: '2fa_enabled',
                target_type: 'user',
                target_id: req.body.userId,
                user_id: req.body.userId,
                performed_by: userId,
                ip_address: req.ip,
                details: 'Admin enabled 2FA for user'
            });
        }
        
        res.json({ success: true, message: '2FA enabled successfully' });
    } catch (error) {
        console.error('2FA enable error:', error);
        res.status(500).json({ error: 'Failed to enable 2FA' });
    }
});

// POST /api/2fa/disable - Disable 2FA (requires current code or recovery code)
app.post('/api/2fa/disable', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { code, recoveryCode } = req.body;
        
        // Get profile
        const { data: profile, error } = await supabase
            .from('twofa_profiles')
            .select('*')
            .eq('user_id', userId)
            .single();
        
        if (error || !profile) {
            return res.status(400).json({ error: '2FA not configured' });
        }
        
        if (!profile.is_enabled) {
            return res.status(400).json({ error: '2FA is not enabled' });
        }
        
        let isValid = false;
        
        // Verify with TOTP code
        if (code) {
            const secretBuffer = TOTPService.decryptSecret(profile.encrypted_secret, TOTP_ENCRYPTION_KEY);
            const secret = TOTPService.base32Encode(secretBuffer);
            isValid = TOTPService.verifyTOTP(code, secret);
        }
        // Verify with recovery code
        else if (recoveryCode) {
            const hashedInput = TOTPService.hashRecoveryCode(recoveryCode);
            const storedHashes = JSON.parse(profile.backup_codes_hash || '[]');
            
            isValid = storedHashes.includes(hashedInput);
            
            if (isValid) {
                // Remove used recovery code
                const newHashes = storedHashes.filter(h => h !== hashedInput);
                await supabase
                    .from('twofa_profiles')
                    .update({
                        backup_codes_hash: JSON.stringify(newHashes),
                        backup_codes_remaining: newHashes.length
                    })
                    .eq('user_id', userId);
            }
        }
        
        if (!isValid) {
            return res.status(400).json({ error: 'Invalid code' });
        }
        
        // Disable 2FA
        const { error: updateError } = await supabase
            .from('twofa_profiles')
            .update({
                is_enabled: false,
                is_verified: false,
                encrypted_secret: null,
                backup_codes_hash: null,
                backup_codes_remaining: 0
            })
            .eq('user_id', userId);
        
        if (updateError) {
            console.error('2FA disable error:', updateError);
            return res.status(500).json({ error: 'Failed to disable 2FA' });
        }
        
        // Log the action
        await supabase.from('audit_logs').insert({
            action: '2fa_disabled',
            target_type: 'user',
            target_id: userId,
            user_id: userId,
            performed_by: userId,
            ip_address: req.ip,
            details: 'User disabled 2FA'
        });
        
        res.json({ success: true, message: '2FA disabled successfully' });
    } catch (error) {
        console.error('2FA disable error:', error);
        res.status(500).json({ error: 'Failed to disable 2FA' });
    }
});

// POST /api/2fa/regenerate-recovery - Regenerate recovery codes
app.post('/api/2fa/regenerate-recovery', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { code } = req.body;
        
        // Get profile
        const { data: profile, error } = await supabase
            .from('twofa_profiles')
            .select('*')
            .eq('user_id', userId)
            .single();
        
        if (error || !profile) {
            return res.status(400).json({ error: '2FA not configured' });
        }
        
        if (!profile.is_enabled) {
            return res.status(400).json({ error: '2FA is not enabled' });
        }
        
        // Verify with current TOTP code
        const secretBuffer = TOTPService.decryptSecret(profile.encrypted_secret, TOTP_ENCRYPTION_KEY);
        const secret = TOTPService.base32Encode(secretBuffer);
        
        if (!TOTPService.verifyTOTP(code, secret)) {
            return res.status(400).json({ error: 'Invalid code' });
        }
        
        // Generate new recovery codes
        const newCodes = TOTPService.generateRecoveryCodes();
        const hashedCodes = newCodes.map(c => TOTPService.hashRecoveryCode(c));
        
        await supabase
            .from('twofa_profiles')
            .update({
                backup_codes_hash: JSON.stringify(hashedCodes),
                backup_codes_remaining: TOTPService.CONFIG.RECOVERY_CODES_COUNT
            })
            .eq('user_id', userId);
        
        res.json({
            success: true,
            recoveryCodes: newCodes
        });
    } catch (error) {
        console.error('2FA regenerate recovery error:', error);
        res.status(500).json({ error: 'Failed to regenerate recovery codes' });
    }
});

// POST /api/2fa/verify - Verify code during login
app.post('/api/2fa/verify', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { code, recoveryCode } = req.body;
        
        // Check rate limit
        const rateLimit = TOTPService.checkRateLimit(userId);
        if (!rateLimit.allowed) {
            return res.status(429).json({ 
                error: 'Too many attempts',
                retryAfter: rateLimit.retryAfter
            });
        }
        
        // Get profile
        const { data: profile, error } = await supabase
            .from('twofa_profiles')
            .select('*')
            .eq('user_id', userId)
            .single();
        
        if (error || !profile || !profile.is_enabled) {
            return res.status(400).json({ error: '2FA not enabled' });
        }
        
        // Check for replay attack
        const codeHash = crypto.createHash('sha256').update(code || recoveryCode).digest('hex');
        const { data: existingAttempt } = await supabase
            .from('twofa_attempts')
            .select('id')
            .eq('user_id', userId)
            .eq('code_hash', codeHash)
            .eq('success', true)
            .gte('used_at', new Date(Date.now() - 90000).toISOString()) // Within last 1.5 periods
            .single();
        
        if (existingAttempt) {
            return res.status(400).json({ error: 'Code already used (replay attack prevention)' });
        }
        
        let isValid = false;
        let usedRecoveryCode = false;
        
        // Verify with TOTP code
        if (code) {
            const secretBuffer = TOTPService.decryptSecret(profile.encrypted_secret, TOTP_ENCRYPTION_KEY);
            const secret = TOTPService.base32Encode(secretBuffer);
            isValid = TOTPService.verifyTOTP(code, secret);
        }
        // Verify with recovery code
        else if (recoveryCode) {
            if (profile.backup_codes_remaining <= 0) {
                return res.status(400).json({ error: 'No recovery codes remaining' });
            }
            
            const hashedInput = TOTPService.hashRecoveryCode(recoveryCode);
            const storedHashes = JSON.parse(profile.backup_codes_hash || '[]');
            
            isValid = storedHashes.includes(hashedInput);
            usedRecoveryCode = isValid;
            
            if (isValid) {
                // Remove used recovery code
                const newHashes = storedHashes.filter(h => h !== hashedInput);
                await supabase
                    .from('twofa_profiles')
                    .update({
                        backup_codes_hash: JSON.stringify(newHashes),
                        backup_codes_remaining: newHashes.length
                    })
                    .eq('user_id', userId);
            }
        }
        
        // Log attempt
        await supabase.from('twofa_attempts').insert({
            user_id: userId,
            code_hash: codeHash,
            success: isValid,
            ip_address: req.ip,
            user_agent: req.get('User-Agent')
        });
        
        if (!isValid) {
            TOTPService.checkRateLimit(userId); // Increment attempt count
            return res.status(400).json({ error: 'Invalid code' });
        }
        
        // Clear rate limit on success
        TOTPService.clearRateLimit(userId);
        
        // Update last verified
        await supabase
            .from('twofa_profiles')
            .update({ last_verified_at: new Date().toISOString() })
            .eq('user_id', userId);
        
        res.json({ 
            success: true,
            usedRecoveryCode
        });
    } catch (error) {
        console.error('2FA verify error:', error);
        res.status(500).json({ error: 'Failed to verify' });
    }
});

// POST /api/2fa/login-initiate - First step of 2FA login
// Now uses Email 2FA by default (controlled by feature flag)
app.post('/api/2fa/login-initiate', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        // Verify credentials
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();
        
        if (error || !user) {
            // Use same error to prevent email enumeration
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const passwordValid = await bcrypt.compare(password, user.password_hash);
        if (!passwordValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // MARKETING_SANDBOX accounts use generated fictional emails that can
        // never receive a verification code. Skip the production email/TOTP
        // 2FA step and return the normal authenticated session (identical
        // shape to the no-2FA path below). users.environment is server-stored
        // and immutable; the client can never supply or override it.
        if (user.environment === ENV_MARKETING_SANDBOX) {
            const token = jwt.sign(
                { id: user.id, email: user.email, isAdmin: user.is_admin===1 },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            return res.json({
                success: true,
                requires2FA: false,
                token,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    referralCode: user.referral_code,
                    isAdmin: user.is_admin===1,
                    is_admin: !!user.is_admin,
                    is_verified: false // KYC verification not implemented yet
                }
            });
        }
        
        // Get current 2FA type
        const twoFactorType = await get2FAType();
        
        // Check if TOTP 2FA is enabled (for TOTP mode)
        const hasTOTP = await hasUser2FAEnabled(user.id);
        
        // Handle based on 2FA type
        if (twoFactorType === 'totp' && hasTOTP) {
            // TOTP mode - only require if user has TOTP enabled
            const partialToken = jwt.sign(
                {
                    id: user.id,
                    email: user.email,
                    isAdmin: user.is_admin===1,
                    _2fa_pending: true,
                    _2fa_type: 'totp'
                },
                JWT_SECRET,
                { expiresIn: '5m' }
            );
            
            return res.json({
                success: true,
                requires2FA: true,
                partialToken,
                twoFactorType: 'totp'
            });
        } else if (twoFactorType === 'email') {
            // Email 2FA mode - always require for all users
            // Check resend rate limit (database-backed)
            const rateLimit = await Email2FAService.checkResendRateLimit(supabase, `login:${user.id}`);
            if (!rateLimit.allowed) {
                return res.status(429).json({
                    error: 'Please wait before requesting another code',
                    retryAfter: rateLimit.remainingSeconds
                });
            }
            
            // Send verification code to email
            await sendEmailVerificationCode(user.id, user.email, 'login_2fa');
            
            // Return partial token for email verification
            const partialToken = jwt.sign(
                {
                    id: user.id,
                    email: user.email,
                    isAdmin: user.is_admin===1,
                    _2fa_pending: true,
                    _2fa_type: 'email'
                },
                JWT_SECRET,
                { expiresIn: '5m' }
            );
            
            return res.json({
                success: true,
                requires2FA: true,
                partialToken,
                twoFactorType: 'email',
                emailMasked: maskEmail(user.email),
                expiresIn: 10 * 60 // 10 minutes in seconds
            });
        }
        
        // No 2FA required - return token directly
        const token = jwt.sign(
            { id: user.id, email: user.email, isAdmin: user.is_admin===1 },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        return res.json({
            success: true,
            requires2FA: false,
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                referralCode: user.referral_code,
                isAdmin: user.is_admin===1,
                is_admin: !!user.is_admin,
                is_verified: false // KYC verification not implemented yet
            }
        });
    } catch (error) {
        console.error('2FA login initiate error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Helper: Mask email for display
function maskEmail(email) {
    const [local, domain] = email.split('@');
    if (local.length <= 2) {
        return `${local[0]}***@${domain}`;
    }
    return `${local[0]}${'*'.repeat(3)}@${domain}`;
}

// POST /api/2fa/login-verify - Second step of 2FA login
// Handles both Email and TOTP codes based on _2fa_type in partialToken
app.post('/api/2fa/login-verify', async (req, res) => {
    try {
        const { partialToken, code } = req.body;
        
        if (!partialToken) {
            return res.status(400).json({ error: 'Missing partial token' });
        }
        
        if (!code) {
            return res.status(400).json({ error: 'Verification code required' });
        }
        
        // Verify partial token
        let decoded;
        try {
            decoded = jwt.verify(partialToken, JWT_SECRET);
        } catch (e) {
            return res.status(401).json({ error: 'Session expired, please login again' });
        }
        
        if (!decoded._2fa_pending) {
            return res.status(401).json({ error: 'Invalid session' });
        }
        
        const userId = decoded.id;
        const twoFactorType = decoded._2fa_type || 'email';
        
        // Check verification rate limit (database-backed, using Email2FAService for all types)
        const rateLimit = await Email2FAService.checkVerifyRateLimit(supabase, `login:${userId}`);
        if (!rateLimit.allowed) {
            return res.status(429).json({ 
                error: 'Too many attempts. Please try again later.',
                retryAfter: rateLimit.retryAfterSeconds,
                remainingAttempts: 0
            });
        }
        
        let isValid = false;
        
        if (twoFactorType === 'email') {
            // Email 2FA verification
            isValid = await verifyEmailCode(userId, code, 'login_2fa', req);
        } else if (twoFactorType === 'totp') {
            // TOTP 2FA verification
            isValid = await verifyTOTPCode(userId, code, req);
        }
        
        if (!isValid) {
            return res.status(400).json({ 
                error: 'Invalid or expired code',
                remainingAttempts: rateLimit.remainingAttempts
            });
        }
        
        // Generate full token (isAdmin camelCase matches /api/auth/login so
        // adminMiddleware (req.user.isAdmin) and frontend checkAdminAccess work
        // for the 2FA login path too).
        const token = jwt.sign(
            { id: userId, email: decoded.email, isAdmin: !!decoded.isAdmin },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Get user data (is_verified removed - column doesn't exist in users table)
        const { data: user } = await supabase
            .from('users')
            .select('id, name, email, referral_code, is_admin')
            .eq('id', userId)
            .single();

        res.json({
            success: true,
            token,
            user: user ? {
                id: user.id,
                name: user.name,
                email: user.email,
                referralCode: user.referral_code,
                isAdmin: user.is_admin===1,
                is_admin: !!user.is_admin,
                is_verified: false // KYC verification not implemented yet
            } : null
        });
    } catch (error) {
        console.error('2FA login verify error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// Helper: Verify email code
async function verifyEmailCode(userId, code, purpose, req) {
    try {
        // Validate code format
        if (!code || !/^\d{6}$/.test(code)) {
            return false;
        }
        
        const codeHash = Email2FAService.hashCode(code);
        
        // Find valid code in database
        const { data: storedCode } = await supabase
            .from('email_verification_codes')
            .select('id, code_hash, expires_at, used')
            .eq('user_id', userId)
            .eq('purpose', purpose)
            .eq('used', false)
            .single();
        
        if (!storedCode) {
            // Log failed attempt
            await logEmail2FAAttempt(userId, null, false, 'No code found', req);
            return false;
        }
        
        // Check expiry
        if (new Date() > new Date(storedCode.expires_at)) {
            await logEmail2FAAttempt(userId, null, false, 'Code expired', req);
            return false;
        }
        
        // Verify hash matches
        if (storedCode.code_hash !== codeHash) {
            await logEmail2FAAttempt(userId, null, false, 'Invalid code', req);
            return false;
        }
        
        // Mark code as used
        await supabase
            .from('email_verification_codes')
            .update({ used: true, used_at: new Date().toISOString() })
            .eq('id', storedCode.id);
        
        // Log successful attempt
        await logEmail2FAAttempt(userId, null, true, null, req);
        
        return true;
    } catch (error) {
        console.error('Email code verification error:', error);
        return false;
    }
}

// Helper: Verify TOTP code
async function verifyTOTPCode(userId, code, req) {
    try {
        // Get profile
        const { data: profile, error } = await supabase
            .from('twofa_profiles')
            .select('*')
            .eq('user_id', userId)
            .single();
        
        if (error || !profile || !profile.is_enabled) {
            return false;
        }
        
        // Decrypt secret and verify
        const secretBuffer = TOTPService.decryptSecret(profile.encrypted_secret, TOTP_ENCRYPTION_KEY);
        const secret = TOTPService.base32Encode(secretBuffer);
        const isValid = TOTPService.verifyTOTP(code, secret);
        
        // Log attempt
        const codeHash = crypto.createHash('sha256').update(code).digest('hex');
        await supabase.from('twofa_attempts').insert({
            user_id: userId,
            code_hash: codeHash,
            success: isValid,
            ip_address: req.ip,
            user_agent: req.get('User-Agent')
        });
        
        if (isValid) {
            // Update last verified
            await supabase
                .from('twofa_profiles')
                .update({ last_verified_at: new Date().toISOString() })
                .eq('user_id', userId);
        }
        
        return isValid;
    } catch (error) {
        console.error('TOTP verification error:', error);
        return false;
    }
}

// Helper: Log email 2FA verification attempt
async function logEmail2FAAttempt(userId, email, success, failureReason, req) {
    try {
        const clientIP = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() 
            || req?.socket?.remoteAddress 
            || null;
        
        await supabase.from('email_2fa_attempts').insert({
            user_id: userId,
            email: email || 'unknown',
            success: success,
            failure_reason: failureReason,
            ip_address: clientIP,
            user_agent: req?.get('User-Agent')
        });
    } catch (e) {
        console.error('Failed to log email 2FA attempt:', e);
    }
}

// Admin: Get user's 2FA status (without secrets)
app.get('/api/admin/2fa/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const { data, error } = await supabase
            .from('twofa_profiles')
            .select('is_enabled, is_verified, enabled_at, last_verified_at, backup_codes_remaining, created_at')
            .eq('user_id', userId)
            .single();
        
        if (error && error.code !== 'PGRST116') {
            throw error;
        }
        
        res.json({
            enabled: data?.is_enabled || false,
            verified: data?.is_verified || false,
            enabledAt: data?.enabled_at || null,
            lastVerifiedAt: data?.last_verified_at || null,
            backupCodesRemaining: data?.backup_codes_remaining || 0,
            createdAt: data?.created_at || null
        });
    } catch (error) {
        console.error('Admin 2FA error:', error);
        res.status(500).json({ error: 'Failed to get 2FA status' });
    }
});

// ---------- ADMIN ----------
app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { data: deposits } = await supabase.from('deposits').select('amount').eq('status', 'confirmed');
  const totalDeposits = deposits.reduce((s, d) => s + d.amount, 0);
  const { data: withdrawals } = await supabase.from('withdrawals').select('amount').eq('status', 'approved');
  const totalWithdrawals = withdrawals.reduce((s, w) => s + w.amount, 0);
  const { data: txs } = await supabase.from('transactions').select('amount');
  const totalVolume = txs.reduce((s, t) => s + t.amount, 0);
  const { count: activeBots } = await supabase.from('bot_sessions').select('*', { count: 'exact', head: true }).eq('is_running', 1);
  const { data: wallets } = await supabase.from('wallets').select('live_balance');
  const totalLiveBalance = wallets.reduce((s, w) => s + w.live_balance, 0);
  res.json({ totalUsers: totalUsers||0, totalDeposits, totalWithdrawals, totalVolume, activeBots: activeBots||0, totalLiveBalance });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('users').select('id, name, email, referral_code, is_admin, created_at, wallets(demo_balance, live_balance, bonus_balance)').order('created_at', { ascending: false });
  if (error) throw error;
  const users = data.map(u => ({ ...u, demo_balance: u.wallets ? u.wallets.demo_balance : 0, live_balance: u.wallets ? u.wallets.live_balance : 0, bonus_balance: u.wallets ? u.wallets.bonus_balance : 0, wallets: undefined }));
  res.json(users);
});

// Admin subscription visibility (read-only). Lists each user's Arbitrix Pro
// subscription state. No balance alteration is possible through this endpoint.
app.get('/api/admin/subscriptions', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('subscriptions')
    .select('id, user_id, plan, price, status, started_at, next_billing_date, last_billing_date, last_charge_amount, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  res.json(data || []);
});

app.get('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('users').select('id, name, email, referral_code, is_admin, wallets(demo_balance, live_balance, bonus_balance)').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'User not found' });
  const user = { ...data, demo_balance: data.wallets ? data.wallets.demo_balance : 0, live_balance: data.wallets ? data.wallets.live_balance : 0, bonus_balance: data.wallets ? data.wallets.bonus_balance : 0, wallets: undefined };
  res.json(user);
});

app.put('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, email, demo_balance, live_balance, bonus_balance } = req.body;
  await supabase.from('users').update({ name, email }).eq('id', id);
  await supabase.from('wallets').update({ demo_balance, live_balance, bonus_balance }).eq('user_id', id);
  res.json({ success: true });
});

app.post('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { name, email, password, demo_balance } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (await getUserByEmail(email)) return res.status(400).json({ error: 'Email exists' });
  const hash = bcrypt.hashSync(password, 10);
  const userReferralCode = await generateUniqueReferralCode();
  const { data: user, error } = await supabase.from('users').insert({ name, email, password_hash: hash, referral_code: userReferralCode, is_admin: 0 }).select().single();
  if (error) throw error;
  await supabase.from('wallets').insert({ user_id: user.id, demo_balance: demo_balance || 1000, live_balance: 50, bonus_balance: 0 });
  res.json({ success: true, user });
});

app.get('/api/admin/deposits', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('deposits').select('*, users(name)').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  const deposits = data.map(d => ({ ...d, user_name: d.users ? d.users.name : null, users: undefined }));
  res.json(deposits);
});

app.put('/api/admin/deposits/:id/confirm', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { data: deposit, error } = await supabase.from('deposits').select('*').eq('id', id).single();
  if (error || !deposit) return res.status(404).json({ error: 'Deposit not found' });
  if (deposit.status !== 'pending') return res.status(400).json({ error: 'Already ' + deposit.status });
  
  // Check if this is the user's first deposit (for referral qualification)
  const isFirst = await isFirstConfirmedDeposit(deposit.user_id);
  
  await supabase.from('deposits').update({ status: 'confirmed' }).eq('id', id);
  await updateWallet(deposit.user_id, 'live_balance', deposit.amount);
  await addTransaction(deposit.user_id, 'Deposit', deposit.amount, 'USDT (' + deposit.network + ')');
  
  // Activate referral with deposit info (amount for minimum check)
  let referralActivated = null;
  if (isFirst) {
    referralActivated = await activateReferralOnQualification(deposit.user_id, 'first_deposit', {
      amount: deposit.amount,
      network: deposit.network
    });
  }
  
  res.json({ success: true, referralActivated });
});

app.get('/api/admin/withdrawals', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('withdrawals').select('*, users(name)').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  const withdrawals = data.map(w => ({ ...w, user_name: w.users ? w.users.name : null, users: undefined }));
  res.json(withdrawals);
});

app.put('/api/admin/withdrawals/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { data: withdrawal, error } = await supabase.from('withdrawals').select('*').eq('id', id).single();
  if (error || !withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
  if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Already ' + withdrawal.status });
  await supabase.from('withdrawals').update({ status: 'approved' }).eq('id', id);
  await addTransaction(withdrawal.user_id, 'Withdraw Approved', -withdrawal.amount, 'Approved withdrawal');
  res.json({ success: true });
});

app.put('/api/admin/withdrawals/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { data: withdrawal, error } = await supabase.from('withdrawals').select('*').eq('id', id).single();
  if (error || !withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
  if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Already ' + withdrawal.status });
  await supabase.from('withdrawals').update({ status: 'rejected' }).eq('id', id);
  await updateWallet(withdrawal.user_id, 'live_balance', withdrawal.amount);
  await addTransaction(withdrawal.user_id, 'Withdraw Rejected', withdrawal.amount, 'Rejected withdrawal refund');
  res.json({ success: true });
});

app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('transactions').select('*, users(name)').order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  const txs = data.map(t => ({ ...t, user_name: t.users ? t.users.name : null, users: undefined }));
  res.json(txs);
});

// Admin: Get all referrals with search and filtering
app.get('/api/admin/referrals', authMiddleware, adminMiddleware, async (req, res) => {
  const { search, status, limit = 100, offset = 0 } = req.query;
  
  let query = supabase
    .from('referrals')
    .select(`
      id,
      bonus_earned,
      status,
      created_at,
      referrer:users!referrer_id(id, name, email, referral_code),
      referred:users!referred_id(id, name, email, referral_code)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
  
  // Filter by status if provided
  if (status && status !== 'all') {
    query = query.eq('status', status);
  }
  
  const { data, error, count } = await query;
  
  if (error) throw error;
  
  // Map response to flatten nested objects
  const refs = data.map(r => ({
    id: r.id,
    bonusEarned: r.bonus_earned,
    status: r.status,
    createdAt: r.created_at,
    referrerId: r.referrer?.id,
    referrerName: r.referrer?.name,
    referrerEmail: r.referrer?.email,
    referrerCode: r.referrer?.referral_code,
    referredId: r.referred?.id,
    referredName: r.referred?.name,
    referredEmail: r.referred?.email,
    referredCode: r.referred?.referral_code
  }));
  
  // Apply search filter in memory (for more complex search patterns)
  let filteredRefs = refs;
  if (search) {
    const searchLower = search.toLowerCase();
    filteredRefs = refs.filter(r => 
      (r.referrerName && r.referrerName.toLowerCase().includes(searchLower)) ||
      (r.referrerEmail && r.referrerEmail.toLowerCase().includes(searchLower)) ||
      (r.referrerCode && r.referrerCode.toLowerCase().includes(searchLower)) ||
      (r.referredName && r.referredName.toLowerCase().includes(searchLower)) ||
      (r.referredEmail && r.referredEmail.toLowerCase().includes(searchLower)) ||
      (r.referredCode && r.referredCode.toLowerCase().includes(searchLower))
    );
  }
  
  res.json({ referrals: filteredRefs, total: count || refs.length });
});

// Admin: Get top referrers
app.get('/api/admin/referrals/top', authMiddleware, adminMiddleware, async (req, res) => {
  const { limit = 10 } = req.query;
  
  // Get referral counts per user
  const { data, error } = await supabase
    .from('referrals')
    .select('referrer_id, bonus_earned')
    .eq('status', 'active');
  
  if (error) throw error;
  
  // Aggregate stats by referrer
  const referrerStats = {};
  data.forEach(r => {
    if (!referrerStats[r.referrer_id]) {
      referrerStats[r.referrer_id] = { count: 0, totalEarned: 0 };
    }
    referrerStats[r.referrer_id].count++;
    referrerStats[r.referrer_id].totalEarned += r.bonus_earned || 0;
  });
  
  // Get user details for top referrers
  const referrerIds = Object.keys(referrerStats)
    .sort((a, b) => referrerStats[b].count - referrerStats[a].count)
    .slice(0, parseInt(limit));
  
  if (referrerIds.length === 0) {
    return res.json({ topReferrers: [] });
  }
  
  const { data: users } = await supabase
    .from('users')
    .select('id, name, email, referral_code, created_at')
    .in('id', referrerIds);
  
  const topReferrers = referrerIds.map(id => {
    const user = users.find(u => u.id === id);
    return {
      userId: id,
      name: user?.name,
      email: user?.email,
      referralCode: user?.referral_code,
      referralCount: referrerStats[id].count,
      totalEarned: referrerStats[id].totalEarned,
      joinedAt: user?.created_at
    };
  });
  
  res.json({ topReferrers });
});

// Admin: Export referrals (CSV format)
app.get('/api/admin/referrals/export', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('referrals')
    .select(`
      id,
      bonus_earned,
      status,
      created_at,
      referrer:users!referrer_id(name, email, referral_code),
      referred:users!referred_id(name, email, referral_code)
    `)
    .order('created_at', { ascending: false });
  
  if (error) throw error;
  
  // Generate CSV header
  const csvHeader = 'ID,Referrer Name,Referrer Email,Referrer Code,Referred Name,Referred Email,Referred Code,Bonus Earned,Status,Created At\n';
  
  // Generate CSV rows
  const csvRows = data.map(r => {
    return [
      r.id,
      r.referrer?.name || '',
      r.referrer?.email || '',
      r.referrer?.referral_code || '',
      r.referred?.name || '',
      r.referred?.email || '',
      r.referred?.referral_code || '',
      r.bonus_earned || 0,
      r.status || '',
      r.created_at || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  }).join('\n');
  
  const csv = csvHeader + csvRows;
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="referrals_${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csv);
});

// Admin: Detect suspicious referral activity
app.get('/api/admin/referrals/suspicious', authMiddleware, adminMiddleware, async (req, res) => {
  // Look for suspicious patterns:
  // 1. Same IP used for multiple referrals
  // 2. Rapid-fire referrals (same referrer getting multiple referrals in short time)
  // 3. Self-referrals (should be blocked but check anyway)
  
  const { data: recentReferrals, error } = await supabase
    .from('referrals')
    .select(`
      id,
      referrer_id,
      referred_id,
      created_at,
      referrer:users!referrer_id(id, email, name)
    `)
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) // Last 24 hours
    .order('created_at', { ascending: false });
  
  if (error) throw error;
  
  const suspicious = [];
  
  // Pattern 1: Same referrer getting multiple referrals quickly
  const referrerCounts = {};
  recentReferrals.forEach(r => {
    if (!referrerCounts[r.referrer_id]) {
      referrerCounts[r.referrer_id] = [];
    }
    referrerCounts[r.referrer_id].push(r);
  });
  
  Object.entries(referrerCounts).forEach(([referrerId, referrals]) => {
    if (referrals.length > 5) {
      suspicious.push({
        type: 'rapid_referrals',
        referrerId,
        referrerName: referrals[0].referrer?.name,
        referrerEmail: referrals[0].referrer?.email,
        count: referrals.length,
        details: 'More than 5 referrals in 24 hours'
      });
    }
  });
  
  res.json({ suspicious, totalChecked: recentReferrals.length });
});

// ============================================================
// ADMIN OPERATIONS DASHBOARD API
// ============================================================

// Admin: Executive Dashboard - Comprehensive statistics
app.get('/api/admin/dashboard/executive', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.setHours(0, 0, 0, 0)).toISOString();
    const weekStart = new Date(now.setDate(now.getDate() - 7)).toISOString();
    
    // User Stats
    const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: newUsersToday } = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', todayStart);
    const { count: newUsersWeek } = await supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', weekStart);
    
    // KYC Stats (use the service-role admin client: the KYC tables have RLS
    // enabled with service_role-only policies, so the anon client cannot read
    // them — migration 010 / Phase 6D.)
    const { count: verifiedUsers } = await supabaseAdmin.from('verification_profiles').select('*', { count: 'exact', head: true }).eq('status', 'approved');
    const { count: pendingKyc } = await supabaseAdmin.from('verification_profiles').select('*', { count: 'exact', head: true }).eq('status', 'pending_review');
    const { count: kycApprovedToday } = await supabaseAdmin.from('verification_profiles').select('*', { count: 'exact', head: true }).eq('status', 'approved').gte('updated_at', todayStart);
    const { count: kycRejectedToday } = await supabaseAdmin.from('verification_profiles').select('*', { count: 'exact', head: true }).eq('status', 'rejected').gte('updated_at', todayStart);
    
    // Financial Stats
    const { data: depositsData } = await supabase.from('deposits').select('amount, status, created_at');
    const totalDeposits = depositsData.filter(d => d.status === 'confirmed').reduce((s, d) => s + d.amount, 0);
    const depositsToday = depositsData.filter(d => d.status === 'confirmed' && new Date(d.created_at) >= new Date(todayStart)).reduce((s, d) => s + d.amount, 0);
    
    const { data: withdrawalsData } = await supabase.from('withdrawals').select('amount, status, created_at');
    const totalWithdrawals = withdrawalsData.filter(w => w.status === 'approved').reduce((s, w) => s + w.amount, 0);
    const { count: pendingWithdrawals } = await supabase.from('withdrawals').select('*', { count: 'exact', head: true }).eq('status', 'pending');
    
    // Referral Stats
    const { data: referralsData } = await supabase.from('referrals').select('bonus_earned, status');
    const totalReferralRewards = referralsData.filter(r => r.status === 'active').reduce((s, r) => s + (r.bonus_earned || 0), 0);
    
    // Wallet Stats
    const { data: wallets } = await supabase.from('wallets').select('live_balance, bonus_balance');
    const totalBalances = wallets.reduce((s, w) => s + (w.live_balance || 0) + (w.bonus_balance || 0), 0);
    
    // Payment Stats
    const { data: invoicesData } = await supabase.from('payment_invoices').select('status, created_at');
    const successfulPayments = invoicesData.filter(i => i.status === 'paid').length;
    const failedPayments = invoicesData.filter(i => i.status === 'failed').length;
    const pendingInvoices = invoicesData.filter(i => i.status === 'pending' || i.status === 'expired').length;
    const webhookFailures = invoicesData.filter(i => i.status === 'webhook_failed').length;
    const totalInvoices = invoicesData.length;
    const paymentSuccessRate = totalInvoices > 0 ? ((successfulPayments / totalInvoices) * 100).toFixed(1) : 0;
    
    // Active Bots
    const { count: activeBots } = await supabase.from('bot_sessions').select('*', { count: 'exact', head: true }).eq('is_running', 1);
    
    res.json({
      users: {
        total: totalUsers || 0,
        newToday: newUsersToday || 0,
        newWeek: newUsersWeek || 0,
        verified: verifiedUsers || 0,
        pendingKyc: pendingKyc || 0
      },
      financial: {
        totalDeposits,
        depositsToday,
        totalWithdrawals,
        pendingWithdrawals: pendingWithdrawals || 0,
        totalReferralRewards,
        totalBalances
      },
      payments: {
        successful: successfulPayments,
        failed: failedPayments,
        pending: pendingInvoices,
        webhookFailures: webhookFailures || 0,
        successRate: parseFloat(paymentSuccessRate)
      },
      kyc: {
        pending: pendingKyc || 0,
        approvedToday: kycApprovedToday || 0,
        rejectedToday: kycRejectedToday || 0
      },
      bots: {
        active: activeBots || 0
      }
    });
  } catch (error) {
    console.error('Executive dashboard error:', error);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// Admin: Activity Timeline - Live feed of platform events
app.get('/api/admin/dashboard/activity', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { limit = 50, type } = req.query;
    const activities = [];
    
    // Get recent registrations
    if (!type || type === 'all' || type === 'registration') {
      const { data: newUsers } = await supabase
        .from('users')
        .select('id, name, email, created_at')
        .order('created_at', { ascending: false })
        .limit(parseInt(limit) / 4);
      
      newUsers?.forEach(u => {
        activities.push({
          type: 'registration',
          title: 'New User Registered',
          description: `${u.name || u.email} joined the platform`,
          timestamp: u.created_at,
          userId: u.id,
          icon: 'user-plus',
          color: '#10B981'
        });
      });
    }
    
    // Get recent deposits
    if (!type || type === 'all' || type === 'deposit') {
      const { data: deposits } = await supabase
        .from('deposits')
        .select('id, amount, status, created_at, users(name, email)')
        .order('created_at', { ascending: false })
        .limit(parseInt(limit) / 4);
      
      deposits?.forEach(d => {
        if (d.status === 'confirmed') {
          activities.push({
            type: 'deposit',
            title: 'Deposit Confirmed',
            description: `$${d.amount.toFixed(2)} deposited by ${d.users?.name || 'User'}`,
            timestamp: d.created_at,
            userId: d.user_id,
            amount: d.amount,
            icon: 'arrow-down',
            color: '#10B981'
          });
        }
      });
    }
    
    // Get recent withdrawals
    if (!type || type === 'all' || type === 'withdrawal') {
      const { data: withdrawals } = await supabase
        .from('withdrawals')
        .select('id, amount, status, created_at, users(name, email)')
        .order('created_at', { ascending: false })
        .limit(parseInt(limit) / 4);
      
      withdrawals?.forEach(w => {
        if (w.status === 'approved') {
          activities.push({
            type: 'withdrawal',
            title: 'Withdrawal Approved',
            description: `$${w.amount.toFixed(2)} withdrawn by ${w.users?.name || 'User'}`,
            timestamp: w.created_at,
            userId: w.user_id,
            amount: w.amount,
            icon: 'arrow-up',
            color: '#EF4444'
          });
        }
      });
    }
    
    // Get recent KYC submissions
    if (!type || type === 'all' || type === 'kyc') {
      const { data: kycSubmissions } = await supabase
        .from('verification_profiles')
        .select('user_id, status, created_at, updated_at, users(name, email)')
        .in('status', ['pending_review', 'approved', 'rejected'])
        .order('updated_at', { ascending: false })
        .limit(parseInt(limit) / 8);
      
      kycSubmissions?.forEach(k => {
        const statusLabels = {
          pending_review: { title: 'KYC Submitted', icon: 'file-upload', color: '#F59E0B' },
          approved: { title: 'KYC Approved', icon: 'check-circle', color: '#10B981' },
          rejected: { title: 'KYC Rejected', icon: 'times-circle', color: '#EF4444' }
        };
        const config = statusLabels[k.status];
        activities.push({
          type: 'kyc',
          title: config.title,
          description: `Identity verification ${k.status.replace('_', ' ')} for ${k.users?.name || 'User'}`,
          timestamp: k.updated_at,
          userId: k.user_id,
          icon: config.icon,
          color: config.color
        });
      });
    }
    
    // Get recent referral activations
    if (!type || type === 'all' || type === 'referral') {
      const { data: referrals } = await supabase
        .from('referrals')
        .select('id, status, bonus_earned, activated_at, referred:users!referred_id(name, email)')
        .eq('status', 'active')
        .order('activated_at', { ascending: false })
        .limit(parseInt(limit) / 8);
      
      referrals?.forEach(r => {
        if (r.bonus_earned > 0) {
          activities.push({
            type: 'referral',
            title: 'Referral Reward',
            description: `$${r.bonus_earned.toFixed(2)} earned from referral`,
            timestamp: r.activated_at,
            amount: r.bonus_earned,
            icon: 'gift',
            color: '#F0B90B'
          });
        }
      });
    }
    
    // Sort all activities by timestamp
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    res.json({
      activities: activities.slice(0, parseInt(limit)),
      total: activities.length
    });
  } catch (error) {
    console.error('Activity timeline error:', error);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

// Admin: System Health Check
app.get('/api/admin/dashboard/health', authMiddleware, adminMiddleware, async (req, res) => {
  const startTime = Date.now();
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {}
  };
  
  // Database Check
  try {
    const dbStart = Date.now();
    const { error: dbError } = await supabase.from('users').select('id').limit(1);
    health.checks.database = {
      status: dbError ? 'unhealthy' : 'healthy',
      latency: Date.now() - dbStart,
      error: dbError?.message || null
    };
  } catch (e) {
    health.checks.database = { status: 'unhealthy', error: e.message };
  }
  
  // Supabase Storage Check
  try {
    const storageStart = Date.now();
    const { data: buckets, error: storageError } = await supabase.storage.listBuckets();
    health.checks.storage = {
      status: storageError ? 'degraded' : 'healthy',
      latency: Date.now() - storageStart,
      bucketCount: buckets?.length || 0,
      error: storageError?.message || null
    };
  } catch (e) {
    health.checks.storage = { status: 'unhealthy', error: e.message };
  }
  
  // Email Service Check (simulated based on recent failures)
  try {
    const { data: failedEmails } = await supabase
      .from('audit_logs')
      .select('id')
      .eq('action', 'email_failed')
      .gte('created_at', new Date(Date.now() - 3600000).toISOString());
    
    health.checks.email = {
      status: (failedEmails?.length || 0) > 10 ? 'degraded' : 'healthy',
      failedInLastHour: failedEmails?.length || 0
    };
  } catch (e) {
    health.checks.email = { status: 'unknown', error: e.message };
  }
  
  // Payment Provider Check
  try {
    const { data: failedPayments } = await supabase
      .from('payment_invoices')
      .select('id')
      .eq('status', 'failed')
      .gte('created_at', new Date(Date.now() - 3600000).toISOString());
    
    health.checks.paymentProvider = {
      status: (failedPayments?.length || 0) > 20 ? 'degraded' : 'healthy',
      failedInLastHour: failedPayments?.length || 0
    };
  } catch (e) {
    health.checks.paymentProvider = { status: 'unknown', error: e.message };
  }
  
  // API Latency
  health.checks.api = {
    status: 'healthy',
    latency: Date.now() - startTime
  };
  
  // Failed Jobs Check (from audit logs)
  try {
    const { data: failedJobs } = await supabase
      .from('audit_logs')
      .select('id')
      .eq('action', 'job_failed')
      .gte('created_at', new Date(Date.now() - 3600000).toISOString());
    
    health.checks.failedJobs = {
      status: (failedJobs?.length || 0) > 5 ? 'degraded' : 'healthy',
      failedInLastHour: failedJobs?.length || 0
    };
  } catch (e) {
    health.checks.failedJobs = { status: 'unknown', error: e.message };
  }
  
  // Determine overall health
  const unhealthyChecks = Object.values(health.checks).filter(c => c.status === 'unhealthy').length;
  const degradedChecks = Object.values(health.checks).filter(c => c.status === 'degraded').length;
  
  if (unhealthyChecks > 0) health.status = 'unhealthy';
  else if (degradedChecks > 0) health.status = 'degraded';
  
  res.json(health);
});

// Admin: Alerts
app.get('/api/admin/dashboard/alerts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const alerts = [];
    
    // Check for failed payments
    const { data: failedPayments } = await supabase
      .from('payment_invoices')
      .select('id, status, created_at')
      .eq('status', 'failed')
      .gte('created_at', new Date(Date.now() - 3600000).toISOString());
    
    if (failedPayments?.length > 0) {
      alerts.push({
        id: 'failed_payments',
        severity: 'warning',
        title: 'Failed Payments',
        message: `${failedPayments.length} payment(s) failed in the last hour`,
        count: failedPayments.length,
        timestamp: new Date().toISOString()
      });
    }
    
    // Check for large withdrawals pending
    const { data: largeWithdrawals } = await supabase
      .from('withdrawals')
      .select('id, amount, created_at')
      .eq('status', 'pending')
      .gte('amount', 1000);
    
    if (largeWithdrawals?.length > 0) {
      alerts.push({
        id: 'large_withdrawals',
        severity: 'warning',
        title: 'Large Pending Withdrawals',
        message: `${largeWithdrawals.length} withdrawal(s) over $1,000 pending approval`,
        count: largeWithdrawals.length,
        total: largeWithdrawals.reduce((s, w) => s + w.amount, 0),
        timestamp: new Date().toISOString()
      });
    }
    
    // Check for pending KYC reviews
    const { count: pendingKyc } = await supabase
      .from('verification_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending_review')
      .gte('created_at', new Date(Date.now() - 86400000).toISOString());
    
    if (pendingKyc > 5) {
      alerts.push({
        id: 'kyc_backlog',
        severity: 'info',
        title: 'KYC Review Backlog',
        message: `${pendingKyc} identity verification(s) pending review`,
        count: pendingKyc,
        timestamp: new Date().toISOString()
      });
    }
    
    // Check for suspicious referral activity
    const { data: recentReferrals } = await supabase
      .from('referrals')
      .select('referrer_id, created_at')
      .gte('created_at', new Date(Date.now() - 86400000).toISOString());
    
    const referrerCounts = {};
    recentReferrals?.forEach(r => {
      referrerCounts[r.referrer_id] = (referrerCounts[r.referrer_id] || 0) + 1;
    });
    
    const suspiciousReferrers = Object.entries(referrerCounts).filter(([_, count]) => count > 5);
    if (suspiciousReferrers.length > 0) {
      alerts.push({
        id: 'suspicious_referrals',
        severity: 'warning',
        title: 'Suspicious Referral Activity',
        message: `${suspiciousReferrers.length} user(s) with rapid referral activity`,
        count: suspiciousReferrers.length,
        timestamp: new Date().toISOString()
      });
    }
    
    // Check for webhook failures
    const { data: webhookFailures } = await supabase
      .from('payment_invoices')
      .select('id')
      .eq('status', 'webhook_failed')
      .gte('created_at', new Date(Date.now() - 3600000).toISOString());
    
    if (webhookFailures?.length > 0) {
      alerts.push({
        id: 'webhook_failures',
        severity: 'error',
        title: 'Webhook Failures',
        message: `${webhookFailures.length} webhook(s) failed in the last hour`,
        count: webhookFailures.length,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      alerts,
      total: alerts.length,
      critical: alerts.filter(a => a.severity === 'error').length,
      warnings: alerts.filter(a => a.severity === 'warning').length,
      info: alerts.filter(a => a.severity === 'info').length
    });
  } catch (error) {
    console.error('Alerts error:', error);
    res.status(500).json({ error: 'Failed to load alerts' });
  }
});

// Admin: Audit Logs
app.get('/api/admin/dashboard/audit-logs', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { 
      limit = 100, 
      offset = 0, 
      action, 
      userId, 
      startDate, 
      endDate 
    } = req.query;
    
    let query = supabase
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (action) {
      query = query.eq('action', action);
    }
    if (userId) {
      query = query.eq('user_id', userId);
    }
    if (startDate) {
      query = query.gte('created_at', startDate);
    }
    if (endDate) {
      query = query.lte('created_at', endDate);
    }
    
    const { data: logs, count } = await query;
    
    // Get admin user names
    const adminIds = [...new Set(logs?.map(l => l.performed_by).filter(Boolean) || [])];
    const { data: admins } = await supabase
      .from('users')
      .select('id, name, email')
      .in('id', adminIds);
    
    const adminMap = {};
    admins?.forEach(a => { adminMap[a.id] = a; });
    
    const enrichedLogs = logs?.map(log => ({
      ...log,
      performedByName: adminMap[log.performed_by]?.name || 'System',
      performedByEmail: adminMap[log.performed_by]?.email || 'system'
    })) || [];
    
    res.json({
      logs: enrichedLogs,
      total: count || 0,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Audit logs error:', error);
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
});

// Admin: Enhanced User Search
app.get('/api/admin/users/search', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { q, field, limit = 20 } = req.query;
    
    if (!q) {
      return res.status(400).json({ error: 'Search query required' });
    }
    
    let query = supabase
      .from('users')
      .select(`
        id, name, email, referral_code, is_admin, created_at,
        wallets(demo_balance, live_balance, bonus_balance),
        verification_profiles(status)
      `);
    
    // Search by specific field or all fields
    if (field === 'email') {
      query = query.ilike('email', `%${q}%`);
    } else if (field === 'name') {
      query = query.ilike('name', `%${q}%`);
    } else if (field === 'referral_code') {
      query = query.eq('referral_code', q.toUpperCase());
    } else if (field === 'id') {
      query = query.eq('id', q);
    } else {
      // Search across multiple fields
      query = query.or(`email.ilike.%${q}%,name.ilike.%${q}%,referral_code.ilike.%${q}%`);
    }
    
    const { data: users, error } = await query.limit(parseInt(limit));
    
    if (error) throw error;
    
    const enrichedUsers = users?.map(u => ({
      ...u,
      demo_balance: u.wallets?.demo_balance || 0,
      live_balance: u.wallets?.live_balance || 0,
      bonus_balance: u.wallets?.bonus_balance || 0,
      kyc_status: u.verification_profiles?.status || 'not_started',
      is_verified: false, // KYC verification status from verification_profiles table
      wallets: undefined,
      verification_profiles: undefined
    })) || [];
    
    res.json({
      users: enrichedUsers,
      total: enrichedUsers.length
    });
  } catch (error) {
    console.error('User search error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// Admin: Export Reports (CSV)
app.get('/api/admin/reports/export', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { type = 'users', format = 'csv' } = req.query;
    
    if (format !== 'csv') {
      return res.status(400).json({ error: 'Only CSV format supported' });
    }
    
    let data, filename, headers;
    
    switch (type) {
      case 'users':
        const { data: users } = await supabase
          .from('users')
          .select('id, name, email, referral_code, is_admin, created_at, wallets(demo_balance, live_balance, bonus_balance)');
        
        data = users?.map(u => ({
          ID: u.id,
          Name: u.name,
          Email: u.email,
          'Referral Code': u.referral_code,
          'Is Admin': u.is_admin ? 'Yes' : 'No',
          'Demo Balance': u.wallets?.demo_balance || 0,
          'Live Balance': u.wallets?.live_balance || 0,
          'Bonus Balance': u.wallets?.bonus_balance || 0,
          'Created At': u.created_at
        })) || [];
        filename = 'users_export.csv';
        headers = ['ID', 'Name', 'Email', 'Referral Code', 'Is Admin', 'Demo Balance', 'Live Balance', 'Bonus Balance', 'Created At'];
        break;
        
      case 'deposits':
        const { data: deposits } = await supabase
          .from('deposits')
          .select('*, users(name, email)');
        
        data = deposits?.map(d => ({
          ID: d.id,
          'User ID': d.user_id,
          'User Name': d.users?.name,
          'User Email': d.users?.email,
          Amount: d.amount,
          Currency: d.currency || 'USDT',
          Network: d.network,
          Status: d.status,
          'TX Hash': d.tx_hash || '',
          'Created At': d.created_at
        })) || [];
        filename = 'deposits_export.csv';
        headers = ['ID', 'User ID', 'User Name', 'User Email', 'Amount', 'Currency', 'Network', 'Status', 'TX Hash', 'Created At'];
        break;
        
      case 'withdrawals':
        const { data: withdrawals } = await supabase
          .from('withdrawals')
          .select('*, users(name, email)');
        
        data = withdrawals?.map(w => ({
          ID: w.id,
          'User ID': w.user_id,
          'User Name': w.users?.name,
          'User Email': w.users?.email,
          Amount: w.amount,
          Currency: w.currency || 'USDT',
          Network: w.network,
          Address: w.address,
          Status: w.status,
          'Created At': w.created_at,
          'Processed At': w.processed_at || ''
        })) || [];
        filename = 'withdrawals_export.csv';
        headers = ['ID', 'User ID', 'User Name', 'User Email', 'Amount', 'Currency', 'Network', 'Address', 'Status', 'Created At', 'Processed At'];
        break;
        
      case 'referrals':
        const { data: referrals } = await supabase
          .from('referrals')
          .select('*, referrer:users!referrer_id(name, email), referred:users!referred_id(name, email)');
        
        data = referrals?.map(r => ({
          ID: r.id,
          'Referrer Name': r.referrer?.name,
          'Referrer Email': r.referrer?.email,
          'Referred Name': r.referred?.name,
          'Referred Email': r.referred?.email,
          Status: r.status,
          'Bonus Earned': r.bonus_earned || 0,
          'Activated At': r.activated_at || '',
          'Created At': r.created_at
        })) || [];
        filename = 'referrals_export.csv';
        headers = ['ID', 'Referrer Name', 'Referrer Email', 'Referred Name', 'Referred Email', 'Status', 'Bonus Earned', 'Activated At', 'Created At'];
        break;
        
      case 'kyc':
        const { data: kyc } = await supabase
          .from('verification_profiles')
          .select('*, users(name, email)');
        
        data = kyc?.map(k => ({
          ID: k.id,
          'User ID': k.user_id,
          'User Name': k.users?.name,
          'User Email': k.users?.email,
          'Full Name': k.fullLegalName,
          'Date of Birth': k.dateOfBirth,
          Country: k.country,
          Status: k.status,
          'Submitted At': k.submitted_at || '',
          'Reviewed At': k.reviewed_at || '',
          'Created At': k.created_at
        })) || [];
        filename = 'kyc_export.csv';
        headers = ['ID', 'User ID', 'User Name', 'User Email', 'Full Name', 'Date of Birth', 'Country', 'Status', 'Submitted At', 'Reviewed At', 'Created At'];
        break;
        
      case 'audit':
        const { data: audit } = await supabase
          .from('audit_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(10000);
        
        data = audit?.map(a => ({
          ID: a.id,
          Action: a.action,
          'Target Type': a.target_type || '',
          'Target ID': a.target_id || '',
          'User ID': a.user_id || '',
          'Performed By': a.performed_by || 'System',
          'IP Address': a.ip_address || '',
          Details: a.details || '',
          'Created At': a.created_at
        })) || [];
        filename = 'audit_logs_export.csv';
        headers = ['ID', 'Action', 'Target Type', 'Target ID', 'User ID', 'Performed By', 'IP Address', 'Details', 'Created At'];
        break;
        
      default:
        return res.status(400).json({ error: 'Invalid export type' });
    }
    
    // Generate CSV
    const csvRows = [headers.join(',')];
    data.forEach(row => {
      const values = headers.map(h => {
        const val = row[h] ?? '';
        // Escape quotes and wrap in quotes if contains comma
        const strVal = String(val).replace(/"/g, '""');
        return strVal.includes(',') ? `"${strVal}"` : strVal;
      });
      csvRows.push(values.join(','));
    });
    
    const csv = csvRows.join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// Admin: User detailed profile
app.get('/api/admin/users/:id/profile', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get user basic info
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();
    
    if (userError) return res.status(404).json({ error: 'User not found' });
    
    // Get wallet
    const { data: wallet } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', id)
      .single();
    
    // Get KYC profile
    const { data: kyc } = await supabase
      .from('verification_profiles')
      .select('*')
      .eq('user_id', id)
      .single();
    
    // Get documents count
    const { count: docsCount } = await supabase
      .from('verification_documents')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', id);
    
    // Get deposit history
    const { data: deposits } = await supabase
      .from('deposits')
      .select('*')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(10);
    
    // Get withdrawal history
    const { data: withdrawals } = await supabase
      .from('withdrawals')
      .select('*')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(10);
    
    // Get transactions
    const { data: transactions } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(20);
    
    // Get referrals (as referrer)
    const { data: referralsAsReferrer } = await supabase
      .from('referrals')
      .select('*, referred:users!referred_id(name, email)')
      .eq('referrer_id', id)
      .limit(10);
    
    // Get referred by
    const { data: referredBy } = await supabase
      .from('referrals')
      .select('*, referrer:users!referrer_id(name, email)')
      .eq('referred_id', id)
      .single();
    
    res.json({
      user,
      wallet: wallet || { demo_balance: 0, live_balance: 0, bonus_balance: 0 },
      kyc,
      documentsCount: docsCount || 0,
      recentDeposits: deposits || [],
      recentWithdrawals: withdrawals || [],
      recentTransactions: transactions || [],
      referralsAsReferrer: referralsAsReferrer || [],
      referredBy: referredBy || null
    });
  } catch (error) {
    console.error('User profile error:', error);
    res.status(500).json({ error: 'Failed to load user profile' });
  }
});

// ---------- SEED ADMIN ----------
(async function seedAdmin() {
  try {
    const existing = await supabase.from('users').select('id').eq('email', 'admin@arbitrix.ai').single();
    if (!existing.data) {
      const hash = bcrypt.hashSync('admin123', 10);
      const { data: admin, error } = await supabase.from('users').insert({
        name: 'Admin',
        email: 'admin@arbitrix.ai',
        password_hash: hash,
        referral_code: 'ARBI-ADMIN',
        is_admin: 1
      }).select().single();
      if (admin) {
        await supabase.from('wallets').insert({
          user_id: admin.id,
          demo_balance: 10000,
          live_balance: 5000,
          bonus_balance: 0
        });
        console.log('✅ Admin created: admin@arbitrix.ai / admin123');
      }
    }
  } catch (e) {
    console.log('Admin check:', e.message);
  }
})();

// Start server and assign referral codes to existing users
(async function startServer() {
  // Assign referral codes to existing users without valid codes
  await assignReferralCodesToExistingUsers();
})();

// ---------- SERVE FRONTEND (FIXED – NO * WILDCARD) ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Diagnostic endpoint to check Supabase connection (MUST be before fallback)
app.get('/api/diagnostic', async (req, res) => {
  const diagnostics = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    supabaseUrl: supabaseUrl,
    supabaseProjectRef: supabaseUrl.replace('https://', '').split('.')[0],
    supabaseUrlReachable: false,
    supabaseQueryTest: null
  };
  
  // Test Supabase query
  try {
    const { data, error, details, hint, message } = await supabase.from('users').select('id').limit(1);
    diagnostics.supabaseUrlReachable = true;
    if (error) {
      diagnostics.supabaseQueryTest = { 
        success: false, 
        error: message || error.message || 'Unknown error',
        details: details || null,
        hint: hint || null
      };
    } else {
      diagnostics.supabaseQueryTest = { success: true, data };
    }
  } catch (e) {
    diagnostics.supabaseUrlReachable = false;
    console.error('Supabase connection error:', e.message);
    console.error('Error cause:', e.cause);
    diagnostics.supabaseQueryTest = { 
      success: false, 
      error: e.message,
      cause: e.cause ? (e.cause.message || e.cause.code || String(e.cause)) : null
    };
  }
  
  res.json(diagnostics);
});

// Referral link route handler
// Redirects /ref/ARBI-XXXXX to /?ref=ARBI-XXXXX
app.get('/ref/:code', (req, res) => {
  const code = req.params.code;
  if (code && isValidReferralCodeFormat(code)) {
    res.redirect(`/?ref=${code}`);
  } else {
    res.redirect('/');
  }
});

// Fallback – uses app.use, which does NOT cause the PathError
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware - MUST be defined after all routes
// This prevents Express from rendering "[object Object]" as HTML
app.use((err, req, res, next) => {
  console.error('Server Error:', err.message || err);
  
  // Log detailed error information for debugging
  if (err.cause) {
    console.error('Error cause:', err.cause.message || err.cause);
    console.error('Error cause details:', JSON.stringify(err.cause));
  }
  
  // Determine status code
  const statusCode = err.statusCode || err.status || 500;
  
  // Build error response
  let errorMessage = err.message || 'Internal server error';
  
  // Handle "fetch failed" errors with more detail
  if (errorMessage === 'fetch failed' || errorMessage === 'TypeError: fetch failed') {
    if (err.cause) {
      errorMessage = `Supabase connection failed: ${err.cause.message || err.cause.code || 'Network error'}`;
    } else {
      errorMessage = 'Supabase connection failed: Unable to reach the database server';
    }
  }
  
  const errorResponse = {
    error: errorMessage
  };
  
  // Include stack trace in development only
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    errorResponse.stack = err.stack.split('\n').slice(0, 3).join('\n');
    if (err.cause) {
      errorResponse.cause = err.cause.message || String(err.cause);
    }
  }
  
  res.status(statusCode).json(errorResponse);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Admin panel at http://0.0.0.0:${PORT}/admin`);
});
