#!/usr/bin/env node
/**
 * KYC Storage Deployment Script
 * 
 * This script creates the KYC documents storage bucket and policies in Supabase.
 * Run this after the main database migration to set up document storage.
 * 
 * Usage:
 *   node scripts/deploy-kyc-storage.js
 * 
 * Environment Variables Required:
 *   SUPABASE_URL - Your Supabase project URL
 *   SERVICE_ROLE_KEY - Supabase service role key (for storage operations)
 * 
 * Or pass them as arguments:
 *   node scripts/deploy-kyc-storage.js <SUPABASE_URL> <SERVICE_ROLE_KEY>
 */

const https = require('https');
const http = require('http');

// Configuration
const BUCKET_ID = 'kyc-documents';
const BUCKET_NAME = 'kyc-documents';
const FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
};

function log(message, type = 'info') {
    const prefix = {
        success: `${colors.green}✓${colors.reset}`,
        warning: `${colors.yellow}⚠${colors.reset}`,
        error: `${colors.red}✗${colors.reset}`,
        info: `${colors.cyan}ℹ${colors.reset}`
    };
    console.log(`${prefix[type] || prefix.info} ${message}`);
}

// Make HTTP request to Supabase REST API
function makeRequest(supabaseUrl, path, method, body, serviceRoleKey) {
    return new Promise((resolve, reject) => {
        const url = new URL(supabaseUrl + path);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;
        
        const reqOptions = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: method,
            headers: {
                'apikey': serviceRoleKey,
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json'
            }
        };

        const req = client.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', reject);
        
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// Make request with custom headers
function makeRequestWithHeaders(supabaseUrl, path, method, body, headers, serviceRoleKey) {
    return new Promise((resolve, reject) => {
        const url = new URL(supabaseUrl + path);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;
        
        const reqOptions = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: method,
            headers: {
                'apikey': serviceRoleKey,
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json',
                ...headers
            }
        };

        const req = client.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', reject);
        
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

// Check if bucket exists
async function bucketExists(supabaseUrl, serviceRoleKey) {
    const response = await makeRequest(
        supabaseUrl,
        `/rest/v1/storage/bucket?id=eq.${BUCKET_ID}&select=id`,
        'GET',
        null,
        serviceRoleKey
    );
    return response.status === 200 && response.data && response.data.length > 0;
}

// Create bucket
async function createBucket(supabaseUrl, serviceRoleKey) {
    return await makeRequest(
        supabaseUrl,
        '/rest/v1/storage/bucket',
        'POST',
        {
            id: BUCKET_ID,
            name: BUCKET_NAME,
            public: false,
            file_size_limit: FILE_SIZE_LIMIT,
            allowed_mime_types: ALLOWED_MIME_TYPES
        },
        serviceRoleKey
    );
}

// Update bucket settings
async function updateBucket(supabaseUrl, serviceRoleKey) {
    return await makeRequestWithHeaders(
        supabaseUrl,
        `/rest/v1/storage/bucket?id=eq.${BUCKET_ID}`,
        'PATCH',
        {
            public: false,
            file_size_limit: FILE_SIZE_LIMIT,
            allowed_mime_types: ALLOWED_MIME_TYPES
        },
        { 'Prefer': 'return=minimal' },
        serviceRoleKey
    );
}

// Verify bucket configuration
async function verifyBucket(supabaseUrl, serviceRoleKey) {
    const response = await makeRequest(
        supabaseUrl,
        `/rest/v1/storage/bucket?id=eq.${BUCKET_ID}`,
        'GET',
        null,
        serviceRoleKey
    );
    if (response.status === 200 && response.data && response.data.length > 0) {
        const bucket = response.data[0];
        log(`Bucket verified: ${bucket.name}`, 'success');
        log(`  - Public: ${bucket.public}`, 'info');
        log(`  - File size limit: ${bucket.file_size_limit} bytes`, 'info');
        log(`  - Allowed MIME types: ${bucket.allowed_mime_types?.join(', ') || 'All'}`, 'info');
        return true;
    }
    return false;
}

// Upload test file to verify bucket is working
async function verifyBucketAccess(supabaseUrl, serviceRoleKey) {
    log('Verifying bucket upload access...', 'info');
    
    // Create a minimal test image (1x1 transparent PNG)
    const testPng = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
        0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
    
    const testPath = `test-deployment/${Date.now()}-test.png`;
    
    const response = await makeRequestWithHeaders(
        supabaseUrl,
        `/storage/v1/object/${BUCKET_ID}/${testPath}`,
        'POST',
        testPng,
        { 'Content-Type': 'image/png', 'x-upsert': 'true' },
        serviceRoleKey
    );
    
    if (response.status === 200 || response.status === 201) {
        log('✓ Bucket upload test successful', 'success');
        
        // Clean up test file
        await makeRequestWithHeaders(
            supabaseUrl,
            `/storage/v1/object/${BUCKET_ID}/${testPath}`,
            'DELETE',
            null,
            {},
            serviceRoleKey
        );
        
        return true;
    } else {
        log(`✗ Bucket upload test failed (${response.status})`, 'error');
        if (response.data) {
            console.log('  Response:', JSON.stringify(response.data));
        }
        return false;
    }
}

// Main deployment function
async function deploy() {
    console.log('\n' + '='.repeat(60));
    console.log(`${colors.bold}KYC Storage Deployment Script${colors.reset}`);
    console.log('='.repeat(60) + '\n');
    
    // Get credentials from environment or arguments
    const supabaseUrl = process.env.SUPABASE_URL || process.argv[2];
    const serviceRoleKey = process.env.SERVICE_ROLE_KEY || process.argv[3];
    
    if (!supabaseUrl || !serviceRoleKey) {
        console.log(`
${colors.bold}Usage:${colors.reset}
  node scripts/deploy-kyc-storage.js [SUPABASE_URL] [SERVICE_ROLE_KEY]

  Or set environment variables:
  - SUPABASE_URL
  - SERVICE_ROLE_KEY

${colors.bold}Example:${colors.reset}
  SUPABASE_URL=https://xxxx.supabase.co \\
  SERVICE_ROLE_KEY=eyJ... \\
  node scripts/deploy-kyc-storage.js
`);
        process.exit(1);
    }
    
    log(`Target: ${supabaseUrl}`);
    log(`Bucket: ${BUCKET_ID}\n`);
    
    try {
        // Step 1: Check if bucket exists
        log('Step 1: Checking bucket status...', 'info');
        const exists = await bucketExists(supabaseUrl, serviceRoleKey);
        
        if (exists) {
            log('Bucket already exists - updating settings...', 'warning');
            await updateBucket(supabaseUrl, serviceRoleKey);
        } else {
            // Step 2: Create bucket
            log('Step 2: Creating bucket...', 'info');
            const createResult = await createBucket(supabaseUrl, serviceRoleKey);
            
            if (createResult.status === 201 || createResult.status === 200) {
                log('Bucket created successfully', 'success');
            } else if (createResult.data?.message?.includes('already exists')) {
                log('Bucket already exists', 'warning');
            } else {
                log(`Failed to create bucket: ${JSON.stringify(createResult.data)}`, 'error');
            }
        }
        
        // Step 3: Verify bucket configuration
        log('\nStep 3: Verifying bucket configuration...', 'info');
        const verified = await verifyBucket(supabaseUrl, serviceRoleKey);
        
        if (!verified) {
            log('Bucket verification failed', 'error');
            process.exit(1);
        }
        
        // Step 4: Verify bucket access
        log('\nStep 4: Verifying bucket access...', 'info');
        const accessOk = await verifyBucketAccess(supabaseUrl, serviceRoleKey);
        
        if (!accessOk) {
            log('Bucket access test failed', 'error');
            process.exit(1);
        }
        
        // Step 5: Note about storage policies
        log('\nStep 5: Storage Policies', 'info');
        console.log(`
The storage policies for the bucket are defined in the migration file:
  supabase/migrations/003_kyc_verification.sql

These policies are created when the migration is applied with 
service_role privileges. Ensure the migration has been run:

  supabase db push
  
Or manually run the SQL from the migration file.
`);
        
        console.log('\n' + '='.repeat(60));
        log('Deployment completed successfully!', 'success');
        console.log('='.repeat(60) + '\n');
        
    } catch (err) {
        log(`Deployment failed: ${err.message}`, 'error');
        console.log(`
${colors.bold}Troubleshooting:${colors.reset}
1. Verify SUPABASE_URL is correct
2. Verify SERVICE_ROLE_KEY is valid and has not expired
3. Ensure the service role has storage admin permissions
4. Check Supabase project status at your dashboard
`);
        process.exit(1);
    }
}

// Run deployment
deploy();
