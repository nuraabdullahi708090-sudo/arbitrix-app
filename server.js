const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = 'mySecret123';
const RESET_TOKEN_EXPIRY = 3600000; // 1 hour in milliseconds
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
// ------------------------------------------------------------

const supabase = createClient(supabaseUrl, supabaseKey);

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
    // Try to insert a test record to check if table exists
    const testEmail = 'test-' + Date.now() + '@placeholder.com';
    const testToken = hashToken('test');
    const testExpiry = new Date(Date.now() - 1000).toISOString();
    
    const { error } = await supabase
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
      await supabase.from('password_reset_tokens')
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
      
      // Invalidate any existing reset tokens for this email
      await supabase
        .from('password_reset_tokens')
        .update({ used: true })
        .eq('email', normalizedEmail)
        .eq('used', false);
      
      // Store the hashed token with expiration and IP for auditing
      const { error: insertError } = await supabase
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
    
    // Find the reset token record
    const { data: resetRecord, error: findError } = await supabase
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
    
    // Mark the token as used (single use)
    await supabase
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
    
    const { data: resetRecord, error } = await supabase
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

// ---------- Withdraw ----------
app.post('/api/withdraw/request', authMiddleware, async (req, res) => {
  const { amount, address } = req.body;
  const userId = req.user.id;
  const wallet = await getWallet(userId);
  if (!amount || amount < 700) return res.status(400).json({ error: 'Min $700' });
  if (amount > wallet.live_balance) return res.status(400).json({ error: 'Insufficient balance' });
  if (!address || address.length < 10) return res.status(400).json({ error: 'Valid address required' });
  const { count } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('type', 'Trade Executed');
  if (count < 1) return res.status(400).json({ error: 'Complete at least 1 trade first' });
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

// ---------- 2FA mock ----------
app.post('/api/2fa/enable', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/2fa/verify', authMiddleware, (req, res) => {
  const { code } = req.body;
  if (!code || code.length < 6) return res.status(400).json({ error: 'Invalid code' });
  res.json({ success: true });
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
