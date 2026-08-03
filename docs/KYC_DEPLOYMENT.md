# KYC Verification System - Deployment Guide

This document covers the complete deployment process for the KYC (Know Your Customer) identity verification system.

## Prerequisites

1. **Supabase Project** - A Supabase project with:
   - PostgreSQL database
   - Storage enabled
   - Service role key with appropriate permissions

2. **Environment Variables**
   ```bash
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```

## Deployment Steps

### Step 1: Run Database Migration

The migration creates all required tables, indexes, and RLS policies.

```bash
# Using Supabase CLI
supabase db push

# Or manually via SQL client
# Run: supabase/migrations/003_kyc_verification.sql
```

**What the migration creates:**
- `verification_profiles` table - User personal information and status
- `verification_documents` table - Uploaded identity documents
- `verification_history` table - Status change audit trail
- `admin_review_history` table - Admin action audit log
- RLS policies for all tables
- Storage bucket (`kyc-documents`) and storage policies

### Step 2: Create Storage Bucket (If Migration Doesn't Apply)

Some environments require bucket creation separately from the migration.

```bash
# Using the deployment script
node scripts/deploy-kyc-storage.js

# With environment variables
SUPABASE_URL=https://your-project.supabase.co \
SERVICE_ROLE_KEY=your-service-role-key \
node scripts/deploy-kyc-storage.js

# Or with arguments
node scripts/deploy-kyc-storage.js \
  "https://your-project.supabase.co" \
  "your-service-role-key"
```

### Step 3: Verify Deployment

Run the deployment script with verification:

```bash
node scripts/deploy-kyc-storage.js
```

Expected output:
```
============================================================
KYC Storage Deployment Script
============================================================

ℹ Target: https://xxxx.supabase.co
ℹ Bucket: kyc-documents

ℹ Step 1: Checking bucket status...
✓ Bucket verified successfully
  - Public: false
  - File size limit: 10485760 bytes
  - Allowed MIME types: image/jpeg, image/png, image/webp

ℹ Step 2: Verifying bucket access...
✓ Bucket upload test successful

============================================================
✓ Deployment completed successfully!
============================================================
```

## Storage Security Configuration

### Bucket Settings

| Setting | Value | Description |
|---------|-------|-------------|
| `public` | `false` | Private bucket - requires authentication |
| `file_size_limit` | `10485760` (10MB) | Maximum upload size |
| `allowed_mime_types` | `image/jpeg, image/png, image/webp` | Only image files allowed |

### Storage Policies

The following RLS policies are created for `storage.objects`:

1. **Users can upload own KYC documents**
   - Users can only upload to their own folder (`{userId}/filename`)
   - Enforced via `auth.uid() = foldername(name)[1]`

2. **Users can update own KYC documents**
   - Users can only modify/delete their own documents
   - Both USING and WITH CHECK clauses enforce ownership

3. **Admins can access KYC documents**
   - Admins can view all documents for review
   - Requires `is_admin = true` in users table

4. **Service role can manage KYC documents**
   - Full access for backend operations
   - Used by the application server

## Troubleshooting

### Migration Fails

**Error:** `permission denied for schema storage`

**Solution:** The migration requires service_role privileges. Run:
```bash
SUPABASE_DB_PASSWORD=your-password supabase db push
```

### Bucket Creation Fails

**Error:** `Bucket already exists`

**Solution:** The bucket already exists. The migration uses `ON CONFLICT DO NOTHING` so this is expected.

### Storage Policies Not Created

**Error:** `policy not found`

**Solution:** Storage policies require additional permissions. Run manually:
```sql
-- In Supabase SQL Editor with service_role
\i supabase/migrations/003_kyc_verification.sql
```

### Upload Fails Despite Correct Setup

**Possible causes:**
1. File size exceeds 10MB limit
2. File type not in allowed MIME types
3. User trying to upload to another user's folder

**Check bucket configuration:**
```sql
SELECT * FROM storage.buckets WHERE id = 'kyc-documents';
```

## Security Verification

### Verify Bucket is Private

```sql
SELECT public FROM storage.buckets WHERE id = 'kyc-documents';
-- Should return: false
```

### Verify Storage Policies

```sql
SELECT policyname, cmd FROM pg_policies 
WHERE tablename = 'objects' 
AND schemaname = 'storage';
```

Expected policies:
- `Users can upload own KYC documents` (INSERT)
- `Users can update own KYC documents` (UPDATE)
- `Admins can access KYC documents` (SELECT)
- `Service role can manage KYC documents` (ALL)

### Verify RLS on Document Table

```sql
SELECT rowsecurity FROM pg_tables 
WHERE tablename = 'verification_documents';
-- Should return: true
```

## File Validation Security

The application performs three layers of validation:

1. **MIME Type Check** - Validates HTTP Content-Type header
2. **Magic Bytes Check** - Validates actual file content:
   - JPEG: `FF D8 FF`
   - PNG: `89 50 4E 47`
   - WebP: `RIFF....WEBP`
3. **SHA256 Hash** - Generated for integrity verification

## Rollback

To remove the KYC system:

```sql
-- Drop tables (in order due to foreign keys)
DROP TABLE IF EXISTS public.admin_review_history CASCADE;
DROP TABLE IF EXISTS public.verification_history CASCADE;
DROP TABLE IF EXISTS public.verification_documents CASCADE;
DROP TABLE IF EXISTS public.verification_documents CASCADE;
DROP TABLE IF EXISTS public.verification_profiles CASCADE;

-- Delete bucket (via storage management)
-- Requires manual deletion in Supabase Dashboard
```

## Support

For issues with:
- **Supabase setup**: https://supabase.com/docs
- **Storage policies**: https://supabase.com/docs/guides/storage
- **RLS policies**: https://supabase.com/docs/guides/auth/row-level-security
