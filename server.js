const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

// Payment Service Layer
const { paymentService, PaymentService } = require('./services/PaymentService');
const { nowPaymentsProvider } = require('./services/providers/nowpayments');

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
const JWT_SECRET = 'mySecret123';
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
// Service role key bypasses RLS - needed for password_reset_tokens table
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || supabaseKey;
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

// Set webhook secrets for providers
paymentService.setWebhookSecret('nowpayments', process.env.NOWPAYMENTS_IPN_SECRET || 'your-webhook-secret');

// Initialize provider with config if available
if (process.env.NOWPAYMENTS_API_KEY) {
    nowPaymentsProvider.initialize({
        apiKey: process.env.NOWPAYMENTS_API_KEY,
        ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET,
        sandbox: process.env.NOWPAYMENTS_SANDBOX === 'true'
    });
}

console.log('[Server] Payment Service initialized');

// ============================================
// KYC SERVICE INITIALIZATION
// ============================================
const kycService = new KYCService(supabase, supabase.storage);
console.log('[Server] KYC Service initialized with Supabase Storage');

// CORS configuration - allow all origins for flexibility
// In production, you may want to restrict this to specific domains
app.use(cors({
  origin: true, // Allow all origins
  credentials: true, // Allow credentials (cookies, authorization headers)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- HELPERS ----------
async function getUser(id) {
  const { data, error } = await supabase.from('users').select('id, name, email, referral_code, is_admin, created_at').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function getUserByEmail(email) {
  const { data, error } = await supabase.from('users').select('id, name, email, password_hash, referral_code, is_admin').eq('email', email).single();
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
  // Fallback: append timestamp suffix if all attempts fail (extremely rare)
  const timestamp = Date.now().toString(36).toUpperCase().slice(-4);
  return `ARBI-${timestamp}`;
}

/**
 * Validate referral code format
 * @param {string} code - The referral code to validate
 * @returns {boolean} True if format is valid
 */
function isValidReferralCodeFormat(code) {
  if (!code || typeof code !== 'string') return false;
  // Format: ARBI-{6 alphanumeric chars}
  const pattern = /^ARBI-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
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
      // Look up the referrer
      const { data: referrer } = await supabase
        .from('users')
        .select('id, email')
        .eq('referral_code', normalizedRefCode)
        .single();
      
      if (referrer) {
        // Check for duplicate referral relationship (regardless of status)
        const { data: existingReferral } = await supabase
          .from('referrals')
          .select('id, status')
          .eq('referrer_id', referrer.id)
          .eq('referred_id', user.id)
          .single();
        
        if (!existingReferral) {
          // Create PENDING referral relationship (no bonus yet)
          // Bonus will be awarded when referred user makes their first deposit
          await supabase.from('referrals').insert({ 
            referrer_id: referrer.id, 
            referred_id: user.id, 
            bonus_earned: 0,
            status: 'pending',
            qualified_at: null,
            qualification_type: null
          });
          console.log(`Referral pending: ${referrer.email} -> ${email} (awaiting first deposit)`);
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
  res.json({ token, user });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await getUserByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, email: user.email, isAdmin: user.is_admin===1 }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, referralCode: user.referral_code, isAdmin: user.is_admin===1 } });
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

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await getUser(req.user.id);
  const wallet = await getWallet(user.id);
  res.json({ user, wallet });
});

// ---------- Deposit ----------
app.post('/api/deposit/request', authMiddleware, async (req, res) => {
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

    // SECURITY: Don't expose internal IDs to client
    res.json({
      success: true,
      invoice: {
        id: invoice.id,
        address: invoice.address,
        amountCrypto: invoice.amountCrypto,
        amountUsd: invoice.amountUsd,
        currency: invoice.currency,
        network: invoice.network,
        expiresAt: invoice.expiresAt,
        status: invoice.status
      }
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
 */
app.post('/api/webhook/:provider', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const { provider } = req.params;
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
  const { amount, address } = req.body;
  const userId = req.user.id;
  
  // PRESERVED: All existing withdrawal business logic
  const wallet = await getWallet(userId);
  if (!amount || amount < 700) return res.status(400).json({ error: 'Min $700' });
  if (amount > wallet.live_balance) return res.status(400).json({ error: 'Insufficient balance' });
  if (!address || address.length < 10) return res.status(400).json({ error: 'Valid address required' });
  const { count } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('type', 'Trade Executed');
  if (count < 1) return res.status(400).json({ error: 'Complete at least 1 trade first' });
  
  // NEW: Identity Verification requirement (KYC)
  const verificationStatus = await kycService.getVerificationStatus(userId);
  if (verificationStatus !== VERIFICATION_STATUS.APPROVED) {
    return res.status(400).json({ 
      error: 'Identity verification required',
      verificationRequired: true,
      status: verificationStatus,
      redirectTo: '/#/verification'
    });
  }
  
  // All existing withdrawal logic continues unchanged
  await updateWallet(userId, 'live_balance', -amount);
  await addTransaction(userId, 'Withdraw', -amount, 'To ' + address.slice(0,6) + '...');
  const { data, error } = await supabase.from('withdrawals').insert({ user_id: userId, amount, address, status: 'pending' }).select().single();
  if (error) throw error;
  res.json({ id: data.id, amount, address, status: 'pending', message: 'Withdrawal submitted.' });
});

app.get('/api/withdraw/history', authMiddleware, async (req, res) => {
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
app.post('/api/kyc/personal-info', authMiddleware, async (req, res) => {
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
  const userId = req.user.id;
  const { mode } = req.body;
  const wallet = await getWallet(userId);
  if (mode === 'live' && wallet.live_balance < 143) return res.status(400).json({ error: 'MTA not reached' });
  await supabase.from('bot_sessions').upsert({ user_id: userId, is_running: 1, mode, started_at: new Date().toISOString() }, { onConflict: 'user_id' });
  res.json({ status: 'started', mode });
});

app.post('/api/bot/stop', authMiddleware, async (req, res) => {
  await supabase.from('bot_sessions').update({ is_running: 0 }).eq('user_id', req.user.id);
  res.json({ status: 'stopped' });
});

app.get('/api/bot/status', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('bot_sessions').select('*').eq('user_id', req.user.id).single();
  if (error && error.code !== 'PGRST116') throw error;
  res.json({ isRunning: data ? data.is_running===1 : false, mode: data ? data.mode : 'demo', startedAt: data ? data.started_at : null });
});

// ---------- Transactions ----------
app.get('/api/transactions', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('transactions').select('id, type, amount, detail, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  res.json(data);
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
                    is_admin: !!user.is_admin,
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
                    is_admin: !!user.is_admin,
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
            { id: user.id, email: user.email, is_admin: !!user.is_admin },
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
                referral_code: user.referral_code,
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
        
        // Generate full token
        const token = jwt.sign(
            { id: userId, email: decoded.email, is_admin: decoded.is_admin },
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
                referral_code: user.referral_code,
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
    
    // KYC Stats
    const { count: verifiedUsers } = await supabase.from('verification_profiles').select('*', { count: 'exact', head: true }).eq('status', 'approved');
    const { count: pendingKyc } = await supabase.from('verification_profiles').select('*', { count: 'exact', head: true }).eq('status', 'pending_review');
    const { count: kycApprovedToday } = await supabase.from('verification_profiles').select('*', { count: 'exact', head: true }).eq('status', 'approved').gte('updated_at', todayStart);
    const { count: kycRejectedToday } = await supabase.from('verification_profiles').select('*', { count: 'exact', head: true }).eq('status', 'rejected').gte('updated_at', todayStart);
    
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
    supabaseQueryTest: null,
    serviceRoleKeyConfigured: !!process.env.SUPABASE_SERVICE_KEY,
    passwordResetTokensTest: null
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
  
  // Test password_reset_tokens table with service role
  try {
    const testEmail = 'diagnostic-test-' + Date.now() + '@test.com';
    const testHash = crypto.createHash('sha256').update('test-token-' + Date.now()).digest('hex');
    
    // Try INSERT
    const insertResult = await supabaseAdmin.from('password_reset_tokens').insert({
      email: testEmail,
      token_hash: testHash,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      used: false
    });
    
    if (insertResult.error) {
      diagnostics.passwordResetTokensTest = {
        success: false,
        insertSuccess: false,
        insertError: insertResult.error.message,
        insertCode: insertResult.error.code
      };
    } else {
      // Try SELECT to verify
      const selectResult = await supabaseAdmin.from('password_reset_tokens')
        .select('*')
        .eq('token_hash', testHash)
        .single();
      
      // Clean up
      await supabaseAdmin.from('password_reset_tokens').delete().eq('email', testEmail);
      
      diagnostics.passwordResetTokensTest = {
        success: !!selectResult.data,
        insertSuccess: !insertResult.error,
        insertData: insertResult.data,
        selectSuccess: !!selectResult.data,
        foundRecord: selectResult.data ? {
          email: selectResult.data.email,
          expires_at: selectResult.data.expires_at
        } : null
      };
    }
  } catch (e) {
    diagnostics.passwordResetTokensTest = {
      success: false,
      error: e.message
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
