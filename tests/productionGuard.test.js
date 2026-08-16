'use strict';

/**
 * Production configuration startup-guard tests.
 *
 * Tests the PURE validation function in productionGuard.js — it does not boot
 * the Express server (server.js binds a port on require) and does not need any
 * real credentials or the `express` dependency. Secret values are never
 * required or asserted; only presence/absence/default classification.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const { validateProductionConfig, isProduction, classify, DEFAULT_SECRETS } = require('../productionGuard');

const DEV_JWT = DEFAULT_SECRETS.JWT_SECRET;
const DEV_TOTP = DEFAULT_SECRETS.TOTP_ENCRYPTION_KEY;

// A fully-valid production env (uses throwaway non-default values; never real
// secrets — the guard only checks presence + non-default).
function validProdEnv() {
    return {
        NODE_ENV: 'production',
        JWT_SECRET: 'a-real-production-jwt-secret-value',
        TOTP_ENCRYPTION_KEY: 'a-real-production-totp-encryption-key',
        SUPABASE_SERVICE_KEY: 'a-real-supabase-service-role-key',
        BASE_URL: 'https://arbitrix.pro'
    };
}

// ============ Development / non-production ============

test('dev: missing JWT_SECRET does not break startup', () => {
    const r = validateProductionConfig({ NODE_ENV: 'development' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.errors, []);
});

test('dev: missing TOTP_ENCRYPTION_KEY does not break startup', () => {
    const r = validateProductionConfig({ NODE_ENV: 'development' });
    assert.strictEqual(r.ok, true);
});

test('dev: missing SUPABASE_SERVICE_KEY does not break startup (fallback preserved)', () => {
    const r = validateProductionConfig({ NODE_ENV: 'development' });
    assert.strictEqual(r.ok, true);
});

test('dev: missing BASE_URL retains development fallback (validation passes)', () => {
    const r = validateProductionConfig({ NODE_ENV: 'development' });
    assert.strictEqual(r.ok, true);
});

test('dev: default secrets are allowed in non-production', () => {
    const r = validateProductionConfig({
        NODE_ENV: 'development',
        JWT_SECRET: DEV_JWT,
        TOTP_ENCRYPTION_KEY: DEV_TOTP
    });
    assert.strictEqual(r.ok, true);
});

test('dev: no NODE_ENV at all is treated as non-production (passes)', () => {
    const r = validateProductionConfig({});
    assert.strictEqual(r.ok, true);
});

// ============ Production failures ============

test('prod: missing JWT_SECRET -> startup failure', () => {
    const env = validProdEnv();
    delete env.JWT_SECRET;
    const r = validateProductionConfig(env);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('JWT_SECRET')));
});

test('prod: default JWT_SECRET -> startup failure', () => {
    const env = validProdEnv();
    env.JWT_SECRET = DEV_JWT;
    const r = validateProductionConfig(env);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('JWT_SECRET') && m.includes('default')));
});

test('prod: missing TOTP_ENCRYPTION_KEY -> startup failure', () => {
    const env = validProdEnv();
    delete env.TOTP_ENCRYPTION_KEY;
    const r = validateProductionConfig(env);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('TOTP_ENCRYPTION_KEY')));
});

test('prod: default TOTP_ENCRYPTION_KEY -> startup failure', () => {
    const env = validProdEnv();
    env.TOTP_ENCRYPTION_KEY = DEV_TOTP;
    const r = validateProductionConfig(env);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('TOTP_ENCRYPTION_KEY') && m.includes('default')));
});

test('prod: missing SUPABASE_SERVICE_KEY -> startup failure (no silent anon fallback)', () => {
    const env = validProdEnv();
    delete env.SUPABASE_SERVICE_KEY;
    const r = validateProductionConfig(env);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('SUPABASE_SERVICE_KEY')));
});

test('prod: missing BASE_URL -> startup failure (no silent localhost)', () => {
    const env = validProdEnv();
    delete env.BASE_URL;
    const r = validateProductionConfig(env);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('BASE_URL')));
});

test('prod: localhost BASE_URL is rejected only if it equals the dev default', () => {
    // A non-empty BASE_URL that is not a "default secret" is accepted; the guard
    // does not hardcode a production URL. localhost is allowed if explicitly set
    // (operator's choice) — the guard only forbids MISSING BASE_URL in prod.
    const env = validProdEnv();
    env.BASE_URL = 'http://localhost:8080';
    const r = validateProductionConfig(env);
    assert.strictEqual(r.ok, true);
});

test('prod: empty-string values treated as missing', () => {
    const env = validProdEnv();
    env.JWT_SECRET = '   ';
    const r = validateProductionConfig(env);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(m => m.includes('JWT_SECRET')));
});

test('prod: valid full configuration -> validation passes', () => {
    const r = validateProductionConfig(validProdEnv());
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.errors, []);
});

test('prod: multiple missing vars each reported', () => {
    const r = validateProductionConfig({ NODE_ENV: 'production' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.length >= 4);
    ['JWT_SECRET', 'TOTP_ENCRYPTION_KEY', 'SUPABASE_SERVICE_KEY', 'BASE_URL'].forEach(k => {
        assert.ok(r.errors.some(m => m.includes(k)), k + ' should be reported');
    });
});

// ============ Helpers ============

test('isProduction: only true when NODE_ENV === production', () => {
    assert.strictEqual(isProduction({ NODE_ENV: 'production' }), true);
    assert.strictEqual(isProduction({ NODE_ENV: 'development' }), false);
    assert.strictEqual(isProduction({}), false);
    assert.strictEqual(isProduction(undefined), false);
});

test('classify: missing/default/ok classification', () => {
    assert.strictEqual(classify({}, 'JWT_SECRET'), 'missing');
    assert.strictEqual(classify({ JWT_SECRET: '' }, 'JWT_SECRET'), 'missing');
    assert.strictEqual(classify({ JWT_SECRET: DEV_JWT }, 'JWT_SECRET'), 'default');
    assert.strictEqual(classify({ JWT_SECRET: 'real-value' }, 'JWT_SECRET'), 'ok');
    // SUPABASE_SERVICE_KEY / BASE_URL have no known default -> only missing/ok
    assert.strictEqual(classify({ SUPABASE_SERVICE_KEY: 'anything' }, 'SUPABASE_SERVICE_KEY'), 'ok');
});

test('secrets are never returned by the validator', () => {
    const env = validProdEnv();
    const r = validateProductionConfig(env);
    assert.strictEqual(r.ok, true);
    // Even on failure, error messages must not contain the secret value.
    env.JWT_SECRET = 'SUPER-SECRET-VALUE-X';
    env.NODE_ENV = 'production';
    env.SUPABASE_SERVICE_KEY = ''; // force a failure
    const r2 = validateProductionConfig(env);
    assert.strictEqual(r2.ok, false);
    assert.ok(!JSON.stringify(r2.errors).includes('SUPER-SECRET-VALUE-X'));
});
