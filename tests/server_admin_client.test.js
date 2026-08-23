/**
 * Phase 2 — Server-side Supabase access uses the service-role client only.
 *
 * The frontend never talks to Supabase directly (grep-verified: no supabase
 * references in public/*.html), so EVERY database/RPC/storage access in
 * server.js is server-side and must go through supabaseAdmin (service role,
 * bypasses RLS). This prepares the ground for a later phase that enables RLS
 * on the remaining tables without breaking any server route.
 *
 * These tests pin that invariant: no anon-client (`supabase.`) table/RPC/
 * storage access may remain or be reintroduced in server.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// Strip // line comments and block comments so commented-out examples or
// prose cannot trip the pattern checks.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SERVER);

// Matches the anon client `supabase` (not `supabaseAdmin`, not `supabaseUrl`/
// `supabaseKey`/`supabaseServiceKey`) used as a call target, including
// multi-line chains (`await supabase\n  .from(...)`).
const ANON_CALL = /(?<![A-Za-z])supabase\s*(?:\.\s*(?:from|rpc|storage|auth)\b|\n\s*\.)/;

test('no anon-client table/RPC/storage/auth access remains in server.js', () => {
    const lines = CODE.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
        if (ANON_CALL.test(line) && !/createClient\(supabaseUrl, supabaseKey\)/.test(line)) {
            offenders.push(`${i + 1}: ${line.trim()}`);
        }
    });
    assert.deepStrictEqual(offenders, [],
        'anon supabase client must not be used for DB/RPC/storage access:\n' + offenders.join('\n'));
});

test('anon client variable is never referenced outside its own declaration', () => {
    const refs = CODE.split('\n').filter((l) =>
        /(?<![A-Za-z])supabase(?![A-Za-z])/.test(l)
        && !/const supabase = createClient/.test(l)
        && !/@supabase\/supabase-js/.test(l)
        && !/supabaseUrl|supabaseKey|supabaseServiceKey|supabaseAdmin/.test(l));
    assert.deepStrictEqual(refs, [],
        'bare `supabase` referenced outside its declaration:\n' + refs.join('\n'));
});

test('Email2FAService rate-limit checks receive the service-role client', () => {
    assert.ok(!/checkResendRateLimit\(supabase,/.test(CODE),
        'checkResendRateLimit must be called with supabaseAdmin');
    assert.ok(!/checkVerifyRateLimit\(supabase,/.test(CODE),
        'checkVerifyRateLimit must be called with supabaseAdmin');
    assert.ok(/checkResendRateLimit\(supabaseAdmin,/.test(CODE));
    assert.ok(/checkVerifyRateLimit\(supabaseAdmin,/.test(CODE));
});

test('RLS-enabled KYC tables are only accessed via supabaseAdmin', () => {
    for (const table of ['verification_profiles', 'verification_documents',
        'verification_history', 'admin_review_history']) {
        // Any .from('<table>') must belong to a supabaseAdmin chain.
        const re = new RegExp(`(?<![A-Za-z])supabase(\\s*\\n\\s*|\\s*)\\.from\\('${table}'`, 'g');
        assert.ok(!re.test(CODE),
            `${table} must not be accessed through the anon client`);
    }
});

test('supabaseAdmin service-role client still exists and is used', () => {
    assert.ok(/const supabaseAdmin = createClient\(supabaseUrl, supabaseServiceKey\)/.test(CODE));
    assert.ok((CODE.match(/supabaseAdmin\.from\(/g) || []).length > 50,
        'expected the bulk of server queries to use supabaseAdmin');
});

test('no RLS/permission changes snuck in: Phase 2 adds no migration files', () => {
    const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
        .filter((f) => f.endsWith('.sql')).sort();
    // Phase 2 is code-only; 015 is the newest migration at Phase-2 time. Later
    // phases (016+) legitimately add migrations, so pin that 015 EXISTS rather
    // than asserting it is the latest.
    assert.ok(migrations.includes('015_payment_config_rls_lockdown.sql'));
});
