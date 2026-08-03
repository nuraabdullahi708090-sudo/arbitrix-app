/**
 * TOTP Service - RFC 6238 compliant Time-based One-Time Password
 * Compatible with Google Authenticator, Microsoft Authenticator, Authy, etc.
 */

const crypto = require('crypto');

// TOTP Configuration
const CONFIG = {
    ISSUER: 'Arbitrix',
    ALGORITHM: 'SHA1',
    DIGITS: 6,
    PERIOD: 30, // seconds
    SECRET_LENGTH: 20, // bytes
    WINDOW: 1, // allow 1 step before/after for clock skew
    RECOVERY_CODES_COUNT: 10,
    RECOVERY_CODE_LENGTH: 10,
    RATE_LIMIT_WINDOW: 300, // 5 minutes
    RATE_LIMIT_MAX_ATTEMPTS: 5
};

// Rate limiting store (in-memory, reset on restart)
const rateLimitStore = new Map();

/**
 * Generate a random secret for TOTP
 * @returns {Buffer} Random secret bytes
 */
function generateSecret() {
    return crypto.randomBytes(CONFIG.SECRET_LENGTH);
}

/**
 * Encode secret to base32 for display/storage
 * @param {Buffer} secret 
 * @returns {string} Base32 encoded secret
 */
function base32Encode(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let result = '';
    let buffer = 0;
    let bitsLeft = 0;
    
    for (let i = 0; i < secret.length; i++) {
        buffer = (buffer << 8) | secret[i];
        bitsLeft += 8;
        while (bitsLeft >= 5) {
            bitsLeft -= 5;
            result += alphabet[(buffer >> bitsLeft) & 31];
        }
    }
    
    if (bitsLeft > 0) {
        buffer <<= (5 - bitsLeft);
        result += alphabet[buffer & 31];
    }
    
    return result;
}

/**
 * Decode base32 secret back to bytes
 * @param {string} base32 
 * @returns {Buffer} Decoded secret
 */
function base32Decode(base32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleanBase32 = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
    
    let bits = '';
    for (const char of cleanBase32) {
        const val = alphabet.indexOf(char);
        if (val === -1) continue;
        bits += val.toString(2).padStart(5, '0');
    }
    
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.substr(i, 8), 2));
    }
    
    return Buffer.from(bytes);
}

/**
 * Generate TOTP code from secret and timestamp
 * @param {Buffer|string} secret - TOTP secret
 * @param {number} timestamp - Unix timestamp (optional, defaults to now)
 * @returns {string} 6-digit TOTP code
 */
function generateTOTP(secret, timestamp = Date.now()) {
    if (typeof secret === 'string') {
        secret = base32Decode(secret);
    }
    
    // Calculate time counter
    const counter = Math.floor(timestamp / 1000 / CONFIG.PERIOD);
    
    // Convert counter to 8-byte buffer (big-endian)
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigInt64BE(BigInt(counter), 0);
    
    // Generate HMAC-SHA1
    const hmac = crypto.createHmac(CONFIG.ALGORITHM.toLowerCase(), secret);
    hmac.update(counterBuffer);
    const hash = hmac.digest();
    
    // Dynamic truncation
    const offset = hash[hash.length - 1] & 0x0F;
    const binary = 
        ((hash[offset] & 0x7F) << 24) |
        ((hash[offset + 1] & 0xFF) << 16) |
        ((hash[offset + 2] & 0xFF) << 8) |
        (hash[offset + 3] & 0xFF);
    
    const otp = binary % Math.pow(10, CONFIG.DIGITS);
    return otp.toString().padStart(CONFIG.DIGITS, '0');
}

/**
 * Verify TOTP code with time window tolerance
 * @param {string} code - 6-digit code to verify
 * @param {string} secret - TOTP secret (base32 encoded)
 * @param {number} timestamp - Current timestamp (optional)
 * @returns {boolean} Whether code is valid
 */
function verifyTOTP(code, secret, timestamp = Date.now()) {
    if (!code || code.length !== CONFIG.DIGITS || !/^\d+$/.test(code)) {
        return false;
    }
    
    // Check multiple time windows (±1 period)
    for (let i = -CONFIG.WINDOW; i <= CONFIG.WINDOW; i++) {
        const testTime = timestamp + (i * CONFIG.PERIOD * 1000);
        const expectedCode = generateTOTP(secret, testTime);
        if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expectedCode))) {
            return true;
        }
    }
    
    return false;
}

/**
 * Generate a URI for QR code (otpauth:// format)
 * @param {string} secret - Base32 encoded secret
 * @param {string} accountName - User email or username
 * @returns {string} otpauth:// URI
 */
function generateOTPAuthURI(secret, accountName) {
    const encodedAccount = encodeURIComponent(accountName);
    const encodedIssuer = encodeURIComponent(CONFIG.ISSUER);
    return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=${CONFIG.ALGORITHM}&digits=${CONFIG.DIGITS}&period=${CONFIG.PERIOD}`;
}

/**
 * Generate recovery codes
 * @returns {string[]} Array of recovery codes
 */
function generateRecoveryCodes() {
    const codes = [];
    for (let i = 0; i < CONFIG.RECOVERY_CODES_COUNT; i++) {
        const code = crypto.randomBytes(CONFIG.RECOVERY_CODES_COUNT)
            .toString('hex')
            .match(/.{1,5}/g)
            .slice(0, 2)
            .join('-')
            .toUpperCase();
        codes.push(code);
    }
    return codes;
}

/**
 * Hash a recovery code for storage (single hash)
 * @param {string} code - Recovery code
 * @returns {string} SHA256 hash of the code
 */
function hashRecoveryCode(code) {
    return crypto.createHash('sha256').update(code.toUpperCase().replace(/-/g, '')).digest('hex');
}

/**
 * Check rate limit for 2FA attempts
 * @param {string} identifier - User ID or session ID
 * @returns {object} { allowed: boolean, remaining: number, retryAfter: number }
 */
function checkRateLimit(identifier) {
    const now = Date.now();
    const key = `2fa:${identifier}`;
    
    const record = rateLimitStore.get(key);
    
    if (!record || now - record.windowStart > CONFIG.RATE_LIMIT_WINDOW * 1000) {
        // New window
        rateLimitStore.set(key, {
            windowStart: now,
            attempts: 1
        });
        return { 
            allowed: true, 
            remaining: CONFIG.RATE_LIMIT_MAX_ATTEMPTS - 1,
            retryAfter: 0
        };
    }
    
    if (record.attempts >= CONFIG.RATE_LIMIT_MAX_ATTEMPTS) {
        const retryAfter = Math.ceil(
            (CONFIG.RATE_LIMIT_WINDOW * 1000 - (now - record.windowStart)) / 1000
        );
        return { 
            allowed: false, 
            remaining: 0,
            retryAfter
        };
    }
    
    record.attempts++;
    return { 
        allowed: true, 
        remaining: CONFIG.RATE_LIMIT_MAX_ATTEMPTS - record.attempts,
        retryAfter: 0
    };
}

/**
 * Clear rate limit for identifier
 * @param {string} identifier 
 */
function clearRateLimit(identifier) {
    rateLimitStore.delete(`2fa:${identifier}`);
}

/**
 * Encrypt secret for storage
 * @param {Buffer} secret - Raw secret bytes
 * @param {string} encryptionKey - Encryption key
 * @returns {string} Encrypted secret (hex)
 */
function encryptSecret(secret, encryptionKey) {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(encryptionKey, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    return Buffer.concat([iv, authTag, encrypted]).toString('hex');
}

/**
 * Decrypt secret from storage
 * @param {string} encryptedHex - Encrypted secret (hex)
 * @param {string} encryptionKey - Decryption key
 * @returns {Buffer} Decrypted secret
 */
function decryptSecret(encryptedHex, encryptionKey) {
    const buffer = Buffer.from(encryptedHex, 'hex');
    const iv = buffer.subarray(0, 16);
    const authTag = buffer.subarray(16, 32);
    const encrypted = buffer.subarray(32);
    
    const key = crypto.scryptSync(encryptionKey, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

module.exports = {
    CONFIG,
    generateSecret,
    base32Encode,
    base32Decode,
    generateTOTP,
    verifyTOTP,
    generateOTPAuthURI,
    generateRecoveryCodes,
    hashRecoveryCode,
    checkRateLimit,
    clearRateLimit,
    encryptSecret,
    decryptSecret
};
