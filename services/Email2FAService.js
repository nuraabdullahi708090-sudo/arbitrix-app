/**
 * Email 2FA Service
 * Generates, stores, and verifies email-based verification codes
 * 
 * Features:
 * - Secure random 6-digit code generation
 * - SHA256 hashing for code storage
 * - Rate limiting (60 second cooldown on resend)
 * - 10-minute code expiry
 * - One-time use codes
 * - Verification attempt logging
 * - Future TOTP compatibility via feature flag
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

// In-memory rate limiting store (resets on server restart)
// In production, use Redis for distributed rate limiting
const rateLimitStore = {
    resend: new Map(), // Track resend requests per user
    verify: new Map()  // Track verification attempts per user
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
 * Check if resend is allowed for a user (rate limiting)
 * @param {string} identifier - User ID or session identifier
 * @returns {object} { allowed: boolean, remainingMs: number }
 */
function checkResendRateLimit(identifier) {
    const key = `resend:${identifier}`;
    const now = Date.now();
    
    const record = rateLimitStore.resend.get(key);
    
    if (!record || now - record.timestamp > CONFIG.RESEND_COOLDOWN_MS) {
        rateLimitStore.resend.set(key, { timestamp: now });
        return { allowed: true, remainingMs: 0 };
    }
    
    const remainingMs = CONFIG.RESEND_COOLDOWN_MS - (now - record.timestamp);
    return { 
        allowed: false, 
        remainingMs,
        remainingSeconds: Math.ceil(remainingMs / 1000)
    };
}

/**
 * Check if verification is allowed (rate limiting + attempt limit)
 * @param {string} identifier - User ID or session identifier
 * @returns {object} { allowed: boolean, remainingAttempts: number, retryAfterMs: number }
 */
function checkVerifyRateLimit(identifier) {
    const key = `verify:${identifier}`;
    const now = Date.now();
    
    let record = rateLimitStore.verify.get(key);
    
    // Check if we need to reset the window
    if (!record || now - record.windowStart > CONFIG.VERIFY_RATE_LIMIT_WINDOW_MS) {
        rateLimitStore.verify.set(key, {
            windowStart: now,
            attempts: 1
        });
        return { 
            allowed: true, 
            remainingAttempts: CONFIG.MAX_VERIFY_ATTEMPTS - 1,
            retryAfterMs: 0
        };
    }
    
    // Check if max attempts reached
    if (record.attempts >= CONFIG.MAX_VERIFY_ATTEMPTS) {
        const retryAfterMs = CONFIG.VERIFY_RATE_LIMIT_WINDOW_MS - (now - record.windowStart);
        return { 
            allowed: false, 
            remainingAttempts: 0,
            retryAfterMs,
            retryAfterSeconds: Math.ceil(retryAfterMs / 1000)
        };
    }
    
    // Increment attempts
    record.attempts++;
    return { 
        allowed: true, 
        remainingAttempts: CONFIG.MAX_VERIFY_ATTEMPTS - record.attempts,
        retryAfterMs: 0
    };
}

/**
 * Clear verification attempts for a user (after successful verification)
 * @param {string} identifier - User ID or session identifier
 */
function clearVerifyAttempts(identifier) {
    rateLimitStore.verify.delete(`verify:${identifier}`);
}

/**
 * Clean up expired rate limit records (call periodically)
 * Should be called by a scheduled cleanup in server.js
 */
function cleanupRateLimits() {
    const now = Date.now();
    
    for (const [key, record] of rateLimitStore.resend.entries()) {
        if (now - record.timestamp > CONFIG.RESEND_COOLDOWN_MS * 2) {
            rateLimitStore.resend.delete(key);
        }
    }
    
    for (const [key, record] of rateLimitStore.verify.entries()) {
        if (now - record.windowStart > CONFIG.VERIFY_RATE_LIMIT_WINDOW_MS * 2) {
            rateLimitStore.verify.delete(key);
        }
    }
}

// Start periodic cleanup (every 5 minutes)
setInterval(cleanupRateLimits, 5 * 60 * 1000);

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
    clearVerifyAttempts,
    getCodeExpiry,
    isCodeExpired,
    cleanupRateLimits
};
