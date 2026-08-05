/**
 * Email 2FA Service
 * Generates, stores, and verifies email-based verification codes
 * 
 * Features:
 * - Secure random 6-digit code generation
 * - SHA256 hashing for code storage
 * - Database-backed rate limiting (survives restarts and multi-instance deployments)
 * - 10-minute code expiry
 * - One-time use codes
 * - Verification attempt logging
 * - Future TOTP compatibility via feature flag
 * 
 * Rate Limiting:
 * - Resend cooldown: 60 seconds (tracked via email_2fa_attempts table)
 * - Verification attempts: 5 failures per 5-minute rolling window
 */

const crypto = require('crypto');

// Email 2FA Configuration
const CONFIG = {
    CODE_LENGTH: 6,
    CODE_EXPIRY_MS: 10 * 60 * 1000, // 10 minutes
    RESEND_COOLDOWN_MS: 60 * 1000, // 60 seconds
    MAX_VERIFY_ATTEMPTS: 5,
    VERIFY_RATE_LIMIT_WINDOW_MS: 5 * 60 * 1000 // 5 minutes
};

/**
 * Generate a cryptographically secure 6-digit code
 * @returns {string} 6-digit numeric code
 */
function generateCode() {
    // Generate 6 random bytes for better randomness than 6 random digits
    const randomBytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < CONFIG.CODE_LENGTH; i++) {
        code += randomBytes[i] % 10;
    }
    return code;
}

/**
 * Hash a verification code for secure storage
 * @param {string} code - The plain code
 * @returns {string} SHA256 hash of the code
 */
function hashCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Extract user ID from identifier string (e.g., "login:123" -> "123")
 * @param {string} identifier - Format: "login:{userId}"
 * @returns {string} The user ID portion
 */
function extractUserId(identifier) {
    const parts = identifier.split(':');
    return parts.length > 1 ? parts[1] : identifier;
}

/**
 * Check if resend is allowed for a user (database-backed rate limiting)
 * 
 * Queries the email_2fa_attempts table for the most recent attempt.
 * Blocks if the last attempt was within RESEND_COOLDOWN_MS (60 seconds).
 * 
 * @param {object} supabase - Supabase client instance
 * @param {string} identifier - Format: "login:{userId}"
 * @returns {Promise<object>} { allowed: boolean, remainingSeconds: number }
 */
async function checkResendRateLimit(supabase, identifier) {
    const userId = extractUserId(identifier);
    const cooldownStart = new Date(Date.now() - CONFIG.RESEND_COOLDOWN_MS).toISOString();
    
    // Query for the most recent attempt within the cooldown window
    const { data, error } = await supabase
        .from('email_2fa_attempts')
        .select('attempted_at')
        .eq('user_id', userId)
        .gte('attempted_at', cooldownStart)
        .order('attempted_at', { ascending: false })
        .limit(1);
    
    if (error) {
        console.error('[Email2FAService] Error checking resend rate limit:', error);
        // Fail open - allow the request if database is unavailable
        return { allowed: true, remainingSeconds: 0 };
    }
    
    if (!data || data.length === 0) {
        // No recent attempts - allow
        return { allowed: true, remainingSeconds: 0 };
    }
    
    // Calculate remaining cooldown time
    const lastAttempt = new Date(data[0].attempted_at);
    const elapsed = Date.now() - lastAttempt.getTime();
    const remainingMs = CONFIG.RESEND_COOLDOWN_MS - elapsed;
    
    if (remainingMs <= 0) {
        return { allowed: true, remainingSeconds: 0 };
    }
    
    return {
        allowed: false,
        remainingSeconds: Math.ceil(remainingMs / 1000)
    };
}

/**
 * Check if verification is allowed (database-backed rate limiting)
 * 
 * Queries the email_2fa_attempts table for failed attempts in the rolling window.
 * Blocks if MAX_VERIFY_ATTEMPTS (5) failures occurred within VERIFY_RATE_LIMIT_WINDOW_MS (5 minutes).
 * 
 * @param {object} supabase - Supabase client instance
 * @param {string} identifier - Format: "login:{userId}"
 * @returns {Promise<object>} { allowed: boolean, remainingAttempts: number, retryAfterSeconds: number }
 */
async function checkVerifyRateLimit(supabase, identifier) {
    const userId = extractUserId(identifier);
    const windowStart = new Date(Date.now() - CONFIG.VERIFY_RATE_LIMIT_WINDOW_MS).toISOString();
    
    // Count failed attempts in the current window
    const { data, error } = await supabase
        .from('email_2fa_attempts')
        .select('id', { count: 'exact' })
        .eq('user_id', userId)
        .eq('success', false)
        .gte('attempted_at', windowStart);
    
    if (error) {
        console.error('[Email2FAService] Error checking verify rate limit:', error);
        // Fail open - allow the request if database is unavailable
        return { 
            allowed: true, 
            remainingAttempts: CONFIG.MAX_VERIFY_ATTEMPTS,
            retryAfterSeconds: 0
        };
    }
    
    const failedAttempts = data?.length || 0;
    
    if (failedAttempts >= CONFIG.MAX_VERIFY_ATTEMPTS) {
        // Find when the oldest attempt in this window was
        const { data: oldestAttempt } = await supabase
            .from('email_2fa_attempts')
            .select('attempted_at')
            .eq('user_id', userId)
            .eq('success', false)
            .gte('attempted_at', windowStart)
            .order('attempted_at', { ascending: true })
            .limit(1);
        
        let retryAfterSeconds = Math.ceil(CONFIG.VERIFY_RATE_LIMIT_WINDOW_MS / 1000);
        
        if (oldestAttempt && oldestAttempt.length > 0) {
            const oldestTime = new Date(oldestAttempt[0].attempted_at).getTime();
            const windowEnd = oldestTime + CONFIG.VERIFY_RATE_LIMIT_WINDOW_MS;
            const remainingMs = windowEnd - Date.now();
            retryAfterSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
        }
        
        return {
            allowed: false,
            remainingAttempts: 0,
            retryAfterSeconds
        };
    }
    
    return {
        allowed: true,
        remainingAttempts: CONFIG.MAX_VERIFY_ATTEMPTS - failedAttempts,
        retryAfterSeconds: 0
    };
}

/**
 * Get code expiry timestamp
 * @param {Date|string} createdAt - When the code was created
 * @returns {Date} Expiry date
 */
function getCodeExpiry(createdAt) {
    const created = new Date(createdAt);
    return new Date(created.getTime() + CONFIG.CODE_EXPIRY_MS);
}

/**
 * Check if a code is expired
 * @param {Date|string} createdAt - When the code was created
 * @returns {boolean} True if expired
 */
function isCodeExpired(createdAt) {
    return new Date() > getCodeExpiry(createdAt);
}

module.exports = {
    CONFIG,
    generateCode,
    hashCode,
    checkResendRateLimit,
    checkVerifyRateLimit,
    getCodeExpiry,
    isCodeExpired
};
