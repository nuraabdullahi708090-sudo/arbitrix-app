'use strict';

/**
 * Production configuration startup guard.
 *
 * Pure and dependency-free on purpose so it can be unit-tested in isolation
 * without booting the Express application (server.js binds a port on require).
 * It never reads `process.env` directly — callers pass in an env-shaped object
 * — and it never logs or returns secret values, only whether each required
 * variable is present and not a known development default.
 *
 * Contract:
 *   - In production (NODE_ENV === 'production'), the following MUST be set to a
 *     non-empty value that is not a known development default, otherwise
 *     startup must fail: JWT_SECRET, TOTP_ENCRYPTION_KEY, SUPABASE_SERVICE_KEY,
 *     BASE_URL.
 *   - In non-production environments, validation always passes so local
 *     development keeps using the existing fallbacks unchanged.
 *   - Known development defaults are matched exactly (never logged).
 */

const DEFAULT_SECRETS = {
    JWT_SECRET: 'dev-only-secret-change-in-production',
    TOTP_ENCRYPTION_KEY: 'default-kyc-encryption-key-change-in-prod'
};

function isProduction(env) {
    return !!(env && env.NODE_ENV === 'production');
}

// Returns 'missing' | 'default' | 'ok' for a single env value.
function classify(env, key) {
    const v = env ? env[key] : undefined;
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
        return 'missing';
    }
    if (DEFAULT_SECRETS[key] && v === DEFAULT_SECRETS[key]) {
        return 'default';
    }
    return 'ok';
}

/**
 * Validate an env-shaped object.
 * @param {object} env - object shaped like process.env
 * @returns {{ ok: boolean, errors: string[] }} errors is empty when ok
 */
function validateProductionConfig(env) {
    const errors = [];
    if (!isProduction(env)) {
        return { ok: true, errors };
    }
    const required = ['JWT_SECRET', 'TOTP_ENCRYPTION_KEY', 'SUPABASE_SERVICE_KEY', 'BASE_URL'];
    for (const key of required) {
        const status = classify(env, key);
        if (status === 'missing') {
            errors.push(key + ' is required in production but was not set.');
        } else if (status === 'default') {
            errors.push(key + ' is set to a known development default and cannot be used in production.');
        }
    }
    return { ok: errors.length === 0, errors };
}

module.exports = {
    validateProductionConfig,
    isProduction,
    classify,
    DEFAULT_SECRETS
};
