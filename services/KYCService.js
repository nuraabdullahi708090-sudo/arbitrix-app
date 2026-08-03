/**
 * KYC Verification Service - Arbitrix AI
 * 
 * This service handles all KYC (Know Your Customer) verification operations.
 * It provides secure document handling, status management, and admin review.
 * 
 * SECURITY FEATURES:
 * - File type validation (MIME type + magic bytes)
 * - File size limits (10MB max)
 * - SHA256 file hashing for integrity
 * - Supabase Storage for secure document storage
 * - Signed URLs with expiration for document access
 * - Access control via RLS policies
 * - Audit logging for all admin actions
 * 
 * @author Arbitrix AI
 * @version 2.0.0
 */

const crypto = require('crypto');
const path = require('path');

// Configuration
const CONFIG = {
    STORAGE_BUCKET: 'kyc-documents',
    MAX_FILE_SIZE: parseInt(process.env.KYC_MAX_FILE_SIZE) || 10 * 1024 * 1024, // 10MB
    ALLOWED_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
    ALLOWED_EXTENSIONS: ['.jpg', '.jpeg', '.png', '.webp'],
    REQUIRED_DOCUMENTS: ['national_id', 'passport', 'drivers_license'], // At least one required
    MIN_DOCUMENT_COUNT: 2, // Identity doc + selfie minimum
    SIGNED_URL_EXPIRY_SECONDS: 300, // 5 minutes for document viewing
    DOCUMENT_TYPES: {
        national_id_front: { label: 'National ID (Front)', required: true, category: 'identity' },
        national_id_back: { label: 'National ID (Back)', required: false, category: 'identity' },
        passport: { label: 'Passport', required: true, category: 'identity' },
        drivers_license_front: { label: "Driver's License (Front)", required: true, category: 'identity' },
        drivers_license_back: { label: "Driver's License (Back)", required: false, category: 'identity' },
        selfie_with_id: { label: 'Selfie with ID', required: true, category: 'selfie' }
    }
};

// Verification statuses
const VERIFICATION_STATUS = {
    NOT_STARTED: 'not_started',
    PENDING_REVIEW: 'pending_review',
    APPROVED: 'approved',
    REJECTED: 'rejected',
    RESUBMISSION_REQUIRED: 'resubmission_required'
};

// Verification levels (for progress display)
const VERIFICATION_LEVELS = {
    EMAIL_VERIFIED: {
        level: 1,
        name: 'Email Verified',
        description: 'Your email has been verified',
        icon: 'fa-envelope-check',
        color: '#10B981'
    },
    IDENTITY_SUBMITTED: {
        level: 2,
        name: 'Identity Submitted',
        description: 'Identity documents submitted for review',
        icon: 'fa-file-upload',
        color: '#F59E0B'
    },
    IDENTITY_VERIFIED: {
        level: 3,
        name: 'Identity Verified',
        description: 'Your identity has been verified',
        icon: 'fa-user-check',
        color: '#3B82F6'
    },
    WITHDRAWAL_ENABLED: {
        level: 4,
        name: 'Withdrawal Enabled',
        description: 'You can now withdraw funds',
        icon: 'fa-wallet',
        color: '#10B981'
    }
};

// Admin review actions
const REVIEW_ACTIONS = {
    APPROVED: 'approved',
    REJECTED: 'rejected',
    REQUESTED_RESUBMISSION: 'requested_resubmission',
    VIEWED: 'viewed',
    DOWNLOADED_DOCUMENT: 'downloaded_document'
};

/**
 * KYC Service - Main class for verification operations
 */
class KYCService {
    constructor(supabase, storageClient = null) {
        this.supabase = supabase;
        this.storage = storageClient;
        this.config = CONFIG;
        this.statuses = VERIFICATION_STATUS;
        this.actions = REVIEW_ACTIONS;
        this.levels = VERIFICATION_LEVELS;
        
        console.log('[KYCService] Initialized with Supabase Storage support');
    }

    /**
     * Initialize Supabase Storage client
     * Must be called after Supabase is initialized
     */
    async initializeStorage() {
        if (!this.storage && this.supabase) {
            // Use Supabase storage if available
            this.storage = this.supabase.storage;
        }
    }

    /**
     * Get verification level based on current status
     * @param {string} userId - User ID
     * @returns {Promise<object>}
     */
    async getVerificationLevel(userId) {
        const profile = await this.getVerificationProfile(userId);
        
        if (!profile) {
            return {
                current: VERIFICATION_LEVELS.EMAIL_VERIFIED,
                next: VERIFICATION_LEVELS.IDENTITY_SUBMITTED,
                progress: 25,
                status: 'not_started'
            };
        }

        switch (profile.status) {
            case VERIFICATION_STATUS.NOT_STARTED:
                return {
                    current: VERIFICATION_LEVELS.EMAIL_VERIFIED,
                    next: VERIFICATION_LEVELS.IDENTITY_SUBMITTED,
                    progress: 25,
                    status: profile.status
                };
            case VERIFICATION_STATUS.PENDING_REVIEW:
                return {
                    current: VERIFICATION_LEVELS.IDENTITY_SUBMITTED,
                    next: VERIFICATION_LEVELS.IDENTITY_VERIFIED,
                    progress: 75,
                    status: profile.status
                };
            case VERIFICATION_STATUS.RESUBMISSION_REQUIRED:
                return {
                    current: VERIFICATION_LEVELS.IDENTITY_SUBMITTED,
                    next: VERIFICATION_LEVELS.IDENTITY_VERIFIED,
                    progress: 50,
                    status: profile.status,
                    message: 'Please update your documents'
                };
            case VERIFICATION_STATUS.REJECTED:
                return {
                    current: VERIFICATION_LEVELS.IDENTITY_SUBMITTED,
                    next: VERIFICATION_LEVELS.IDENTITY_VERIFIED,
                    progress: 50,
                    status: profile.status,
                    message: 'Please resubmit your documents'
                };
            case VERIFICATION_STATUS.APPROVED:
                return {
                    current: VERIFICATION_LEVELS.WITHDRAWAL_ENABLED,
                    next: null,
                    progress: 100,
                    status: profile.status
                };
            default:
                return {
                    current: VERIFICATION_LEVELS.EMAIL_VERIFIED,
                    next: VERIFICATION_LEVELS.IDENTITY_SUBMITTED,
                    progress: 25,
                    status: 'unknown'
                };
        }
    }

    /**
     * Validate file MIME type using magic bytes
     * @param {Buffer} buffer - File buffer
     * @param {string} mimeType - Declared MIME type
     * @returns {boolean}
     */
    validateMagicBytes(buffer, mimeType) {
        if (!buffer || buffer.length < 4) return false;

        // JPEG magic bytes: FF D8 FF
        if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
            return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
        }

        // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
        if (mimeType === 'image/png') {
            return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
        }

        // WebP magic bytes: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
        if (mimeType === 'image/webp') {
            return buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46; // RIFF
        }

        return false;
    }

    /**
     * Generate SHA256 hash of file buffer
     * @param {Buffer} buffer - File buffer
     * @returns {string}
     */
    generateFileHash(buffer) {
        return crypto.createHash('sha256').update(buffer).digest('hex');
    }

    /**
     * Generate secure random filename
     * @param {string} originalName - Original filename
     * @returns {string}
     */
    generateSecureFilename(originalName) {
        const ext = path.extname(originalName).toLowerCase();
        const randomBytes = crypto.randomBytes(16).toString('hex');
        const timestamp = Date.now().toString(36);
        return `${timestamp}_${randomBytes}${ext}`;
    }

    /**
     * Validate uploaded file
     * @param {object} file - File object from multer/express
     * @returns {object} - { valid: boolean, error?: string, hash?: string }
     */
    validateFile(file) {
        // Check file exists
        if (!file || !file.buffer) {
            return { valid: false, error: 'No file provided' };
        }

        // Check file size
        if (file.buffer.length > this.config.MAX_FILE_SIZE) {
            return { 
                valid: false, 
                error: `File too large. Maximum size is ${this.config.MAX_FILE_SIZE / (1024 * 1024)}MB` 
            };
        }

        // Check MIME type
        if (!this.config.ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            return { 
                valid: false, 
                error: `Invalid file type. Allowed types: ${this.config.ALLOWED_MIME_TYPES.join(', ')}` 
            };
        }

        // Validate magic bytes
        if (!this.validateMagicBytes(file.buffer, file.mimetype)) {
            return { valid: false, error: 'File content does not match declared type' };
        }

        // Generate hash
        const hash = this.generateFileHash(file.buffer);

        return { valid: true, hash };
    }

    /**
     * Get user's verification profile
     * @param {string} userId - User ID
     * @returns {Promise<object>}
     */
    async getVerificationProfile(userId) {
        const { data, error } = await this.supabase
            .from('verification_profiles')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw error;
        }

        return data || null;
    }

    /**
     * Get user's verification status (quick check)
     * @param {string} userId - User ID
     * @returns {Promise<string>}
     */
    async getVerificationStatus(userId) {
        const profile = await this.getVerificationProfile(userId);
        return profile?.status || VERIFICATION_STATUS.NOT_STARTED;
    }

    /**
     * Create or update verification profile
     * @param {string} userId - User ID
     * @param {object} personalInfo - Personal information
     * @returns {Promise<object>}
     */
    async upsertVerificationProfile(userId, personalInfo) {
        const existing = await this.getVerificationProfile(userId);
        
        const profileData = {
            user_id: userId,
            full_legal_name: personalInfo.fullLegalName,
            date_of_birth: personalInfo.dateOfBirth,
            country: personalInfo.country,
            residential_address: personalInfo.residentialAddress,
            updated_at: new Date().toISOString()
        };

        // If existing and under review, don't allow updates
        if (existing && existing.status === VERIFICATION_STATUS.PENDING_REVIEW) {
            throw new Error('Cannot update profile while under review');
        }

        if (existing) {
            // Update existing profile
            const { data, error } = await this.supabase
                .from('verification_profiles')
                .update(profileData)
                .eq('user_id', userId)
                .select()
                .single();

            if (error) throw error;
            return data;
        } else {
            // Create new profile
            const { data, error } = await this.supabase
                .from('verification_profiles')
                .insert(profileData)
                .select()
                .single();

            if (error) throw error;
            return data;
        }
    }

    /**
     * Get user's uploaded documents
     * @param {string} userId - User ID
     * @returns {Promise<array>}
     */
    async getUserDocuments(userId) {
        const { data, error } = await this.supabase
            .from('verification_documents')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .order('created_at', { ascending: true });

        if (error) throw error;
        return data || [];
    }

    /**
     * Get documents for a verification profile
     * @param {string} verificationId - Verification profile ID
     * @returns {Promise<array>}
     */
    async getDocumentsByVerificationId(verificationId) {
        const { data, error } = await this.supabase
            .from('verification_documents')
            .select('*')
            .eq('verification_id', verificationId)
            .eq('is_active', true)
            .order('created_at', { ascending: true });

        if (error) throw error;
        return data || [];
    }

    /**
     * Upload a verification document to Supabase Storage
     * @param {string} userId - User ID
     * @param {string} documentType - Type of document
     * @param {object} file - File object with buffer, mimetype, originalname
     * @returns {Promise<object>}
     */
    async uploadDocument(userId, documentType, file) {
        // Validate file
        const validation = this.validateFile(file);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        // Get or create verification profile
        let profile = await this.getVerificationProfile(userId);
        if (!profile) {
            throw new Error('Please complete personal information first');
        }

        // Check if user can upload documents
        if (profile.status === VERIFICATION_STATUS.PENDING_REVIEW) {
            throw new Error('Cannot upload documents while verification is under review');
        }

        // Check document type is valid
        if (!this.config.DOCUMENT_TYPES[documentType]) {
            throw new Error('Invalid document type');
        }

        // Mark existing same-type documents as inactive
        const existingDocs = await this.getUserDocuments(userId);
        const existingSameType = existingDocs.filter(d => d.document_type === documentType);
        
        for (const doc of existingSameType) {
            // Delete from storage
            if (this.storage && doc.storage_path) {
                try {
                    await this.storage.from(CONFIG.STORAGE_BUCKET).remove([doc.storage_path]);
                } catch (e) {
                    console.error('[KYCService] Failed to delete old storage file:', e);
                }
            }
            // Mark as inactive in database
            await this.supabase
                .from('verification_documents')
                .update({ 
                    is_active: false, 
                    replaced_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', doc.id);
        }

        // Generate secure storage path
        const secureFilename = this.generateSecureFilename(file.originalname);
        const storagePath = `${userId}/${secureFilename}`;
        
        // Upload to Supabase Storage
        if (this.storage) {
            try {
                const { data: uploadData, error: uploadError } = await this.storage
                    .from(CONFIG.STORAGE_BUCKET)
                    .upload(storagePath, file.buffer, {
                        contentType: file.mimetype,
                        upsert: false
                    });

                if (uploadError) {
                    console.error('[KYCService] Storage upload error:', uploadError);
                    throw new Error('Failed to upload document to storage');
                }
            } catch (storageError) {
                console.error('[KYCService] Storage error:', storageError);
                throw new Error('Failed to save document securely');
            }
        } else {
            console.warn('[KYCService] Supabase Storage not configured, document not persisted');
        }

        // Insert document record (with storage path, not local path)
        const { data, error } = await this.supabase
            .from('verification_documents')
            .insert({
                verification_id: profile.id,
                user_id: userId,
                document_type: documentType,
                original_filename: file.originalname,
                stored_filename: secureFilename,
                storage_path: storagePath, // New field for Supabase Storage
                file_size: file.buffer.length,
                mime_type: file.mimetype,
                file_hash: validation.hash,
                is_uploaded: true,
                upload_completed_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            // Clean up storage on database error
            if (this.storage && storagePath) {
                try {
                    await this.storage.from(CONFIG.STORAGE_BUCKET).remove([storagePath]);
                } catch (cleanupError) {
                    console.error('[KYCService] Cleanup error:', cleanupError);
                }
            }
            throw error;
        }

        return data;
    }

    /**
     * Delete a document (soft delete - marks as inactive)
     * @param {string} userId - User ID
     * @param {string} documentId - Document ID
     * @returns {Promise<boolean>}
     */
    async deleteDocument(userId, documentId) {
        // Get the document with access control
        const { data: doc, error: fetchError } = await this.supabase
            .from('verification_documents')
            .select('*')
            .eq('id', documentId)
            .eq('user_id', userId)
            .single();

        if (fetchError || !doc) {
            throw new Error('Document not found');
        }

        // Check if profile is under review
        const profile = await this.getVerificationProfile(userId);
        if (profile && profile.status === VERIFICATION_STATUS.PENDING_REVIEW) {
            throw new Error('Cannot delete documents while verification is under review');
        }

        // Delete from Supabase Storage
        if (this.storage && doc.storage_path) {
            try {
                await this.storage.from(CONFIG.STORAGE_BUCKET).remove([doc.storage_path]);
            } catch (storageError) {
                console.error('[KYCService] Storage deletion error:', storageError);
                // Continue with soft delete even if storage deletion fails
            }
        }

        // Mark as inactive (soft delete - document cannot be recovered by normal means)
        const { error } = await this.supabase
            .from('verification_documents')
            .update({ 
                is_active: false, 
                replaced_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', documentId);

        if (error) throw error;
        return true;
    }

    /**
     * Get document by ID with signed URL
     * SECURITY: Returns signed URL with expiration instead of direct file access
     * @param {string} userId - Requesting user ID (for access control)
     * @param {string} documentId - Document ID
     * @param {boolean} isAdmin - Whether requester is admin
     * @returns {Promise<object>}
     */
    async getDocument(userId, documentId, isAdmin = false) {
        // Access control: Non-admins can only access their own documents
        let query = this.supabase
            .from('verification_documents')
            .select('*')
            .eq('id', documentId);

        if (!isAdmin) {
            if (!userId) {
                throw new Error('User ID required for document access');
            }
            query = query.eq('user_id', userId);
        }

        const { data, error } = await query.single();
        if (error) throw error;
        
        // SECURITY: Check if document is active (not deleted)
        if (!data.is_active) {
            throw new Error('Document not found or has been removed');
        }

        // Generate signed URL for secure document access
        let signedUrl = null;
        
        if (this.storage && data.storage_path) {
            try {
                // Generate signed URL with expiration (5 minutes by default)
                const { data: urlData, error: urlError } = await this.storage
                    .from(CONFIG.STORAGE_BUCKET)
                    .createSignedUrl(data.storage_path, CONFIG.SIGNED_URL_EXPIRY_SECONDS);
                
                if (urlError) {
                    console.error('[KYCService] Signed URL error:', urlError);
                    throw new Error('Failed to generate secure document URL');
                }
                
                signedUrl = urlData.signedUrl;
            } catch (storageError) {
                console.error('[KYCService] Storage access error:', storageError);
                throw new Error('Failed to retrieve document');
            }
        }

        return {
            ...data,
            signed_url: signedUrl,
            signed_url_expires_in: CONFIG.SIGNED_URL_EXPIRY_SECONDS
        };
    }

    /**
     * Check if user has submitted all required documents
     * @param {string} userId - User ID
     * @returns {Promise<object>}
     */
    async checkDocumentCompletion(userId) {
        const documents = await this.getUserDocuments(userId);
        const documentTypes = new Set(documents.map(d => d.document_type));

        // Check for selfie (required)
        const hasSelfie = documentTypes.has('selfie_with_id');

        // Check for at least one identity document
        const identityTypes = ['national_id_front', 'passport', 'drivers_license_front'];
        const hasIdentity = identityTypes.some(type => documentTypes.has(type));

        // Check if user has at least 2 documents total
        const sufficientDocs = documents.length >= this.config.MIN_DOCUMENT_COUNT;

        return {
            complete: hasSelfie && hasIdentity && sufficientDocs,
            hasSelfie,
            hasIdentity,
            sufficientDocs,
            documentCount: documents.length,
            requiredCount: this.config.MIN_DOCUMENT_COUNT,
            uploadedTypes: Array.from(documentTypes)
        };
    }

    /**
     * Submit verification for review
     * @param {string} userId - User ID
     * @returns {Promise<object>}
     */
    async submitForReview(userId) {
        const profile = await this.getVerificationProfile(userId);
        if (!profile) {
            throw new Error('Please complete personal information first');
        }

        // Check document completion
        const completion = await this.checkDocumentCompletion(userId);
        if (!completion.complete) {
            throw new Error(`Missing required documents. Need ${completion.requiredCount}, have ${completion.documentCount}. Selfie: ${completion.hasSelfie}, Identity: ${completion.hasIdentity}`);
        }

        // Check if already submitted
        if (profile.status === VERIFICATION_STATUS.PENDING_REVIEW) {
            throw new Error('Verification already submitted');
        }

        // Update status
        const { data, error } = await this.supabase
            .from('verification_profiles')
            .update({
                status: VERIFICATION_STATUS.PENDING_REVIEW,
                submitted_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .select()
            .single();

        if (error) throw error;

        // Add to history
        await this.addVerificationHistory(userId, profile.status, VERIFICATION_STATUS.PENDING_REVIEW, {
            submitted: true,
            documentsSubmitted: completion.documentCount
        });

        return data;
    }

    /**
     * Add verification history entry
     * @param {string} userId - User ID
     * @param {string} previousStatus - Previous status
     * @param {string} newStatus - New status
     * @param {object} details - Additional details
     */
    async addVerificationHistory(userId, previousStatus, newStatus, details = {}) {
        const profile = await this.getVerificationProfile(userId);
        
        await this.supabase
            .from('verification_history')
            .insert({
                verification_id: profile?.id,
                user_id: userId,
                previous_status: previousStatus,
                new_status: newStatus,
                change_summary: details.summary || `Status changed from ${previousStatus} to ${newStatus}`,
                changed_fields: details.fields || [],
                rejection_reason: details.rejectionReason || null
            });
    }

    /**
     * Get verification history for a user
     * @param {string} userId - User ID
     * @returns {Promise<array>}
     */
    async getVerificationHistory(userId) {
        const { data, error } = await this.supabase
            .from('verification_history')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        return data || [];
    }

    /**
     * Get all pending verifications (for admin)
     * @param {object} options - Filter options
     * @returns {Promise<array>}
     */
    async getPendingVerifications(options = {}) {
        let query = this.supabase
            .from('verification_profiles')
            .select(`
                *,
                users:id(name, email, created_at)
            `)
            .eq('status', VERIFICATION_STATUS.PENDING_REVIEW)
            .order('submitted_at', { ascending: true });

        if (options.limit) {
            query = query.limit(options.limit);
        }

        if (options.offset) {
            query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
        }

        const { data, error } = await query;
        if (error) throw error;

        return data || [];
    }

    /**
     * Search verifications (for admin)
     * @param {object} filters - Search filters
     * @returns {Promise<array>}
     */
    async searchVerifications(filters = {}) {
        let query = this.supabase
            .from('verification_profiles')
            .select(`
                *,
                users:id(name, email, created_at)
            `)
            .order('updated_at', { ascending: false });

        if (filters.status) {
            query = query.eq('status', filters.status);
        }

        if (filters.search) {
            // Search by name or email (requires join)
            query = query.or(`full_legal_name.ilike.%${filters.search}%`);
        }

        if (filters.limit) {
            query = query.limit(filters.limit);
        }

        if (filters.offset) {
            query = query.range(filters.offset, filters.offset + (filters.limit || 50) - 1);
        }

        const { data, error } = await query;
        if (error) throw error;

        return data || [];
    }

    /**
     * Get verification details with documents (for admin)
     * @param {string} verificationId - Verification profile ID
     * @returns {Promise<object>}
     */
    async getVerificationDetails(verificationId) {
        const { data: profile, error: profileError } = await this.supabase
            .from('verification_profiles')
            .select(`
                *,
                users:id(name, email, created_at)
            `)
            .eq('id', verificationId)
            .single();

        if (profileError) throw profileError;

        const documents = await this.getDocumentsByVerificationId(verificationId);
        const history = await this.getVerificationHistory(profile.user_id);

        return {
            ...profile,
            documents,
            history
        };
    }

    /**
     * Admin review action
     * @param {string} adminId - Admin user ID
     * @param {string} verificationId - Verification profile ID
     * @param {string} action - Review action
     * @param {string} reason - Reason/notes
     * @param {string} ipAddress - Admin IP address
     * @param {string} userAgent - Admin user agent
     * @returns {Promise<object>}
     */
    async adminReview(adminId, verificationId, action, reason = '', ipAddress = null, userAgent = null) {
        const { data: profile, error: fetchError } = await this.supabase
            .from('verification_profiles')
            .select('*')
            .eq('id', verificationId)
            .single();

        if (fetchError || !profile) {
            throw new Error('Verification not found');
        }

        if (profile.status !== VERIFICATION_STATUS.PENDING_REVIEW) {
            throw new Error('Verification is not pending review');
        }

        let newStatus;
        switch (action) {
            case REVIEW_ACTIONS.APPROVED:
                newStatus = VERIFICATION_STATUS.APPROVED;
                break;
            case REVIEW_ACTIONS.REJECTED:
                newStatus = VERIFICATION_STATUS.REJECTED;
                break;
            case REVIEW_ACTIONS.REQUESTED_RESUBMISSION:
                newStatus = VERIFICATION_STATUS.RESUBMISSION_REQUIRED;
                break;
            case REVIEW_ACTIONS.VIEWED:
                // Just log, don't change status
                newStatus = profile.status;
                break;
            default:
                throw new Error('Invalid review action');
        }

        // Update verification profile
        const { data: updatedProfile, error: updateError } = await this.supabase
            .from('verification_profiles')
            .update({
                status: newStatus,
                reviewed_at: new Date().toISOString(),
                reviewed_by: adminId,
                rejection_reason: action === REVIEW_ACTIONS.REJECTED ? reason : null,
                updated_at: new Date().toISOString()
            })
            .eq('id', verificationId)
            .select()
            .single();

        if (updateError) throw updateError;

        // Add verification history
        await this.addVerificationHistory(profile.user_id, profile.status, newStatus, {
            summary: `Admin review: ${action}`,
            rejectionReason: reason
        });

        // Add admin review history
        await this.supabase
            .from('admin_review_history')
            .insert({
                verification_id: verificationId,
                user_id: profile.user_id,
                admin_id: adminId,
                action: action,
                reason: reason,
                notes: reason,
                ip_address: ipAddress,
                user_agent: userAgent
            });

        return updatedProfile;
    }

    /**
     * Log admin document access
     * @param {string} adminId - Admin user ID
     * @param {string} documentId - Document ID
     * @param {string} ipAddress - Admin IP address
     * @param {string} userAgent - Admin user agent
     */
    async logDocumentAccess(adminId, documentId, ipAddress = null, userAgent = null) {
        const { data: doc } = await this.supabase
            .from('verification_documents')
            .select('verification_id, user_id')
            .eq('id', documentId)
            .single();

        if (doc) {
            await this.supabase
                .from('admin_review_history')
                .insert({
                    verification_id: doc.verification_id,
                    user_id: doc.user_id,
                    admin_id: adminId,
                    action: REVIEW_ACTIONS.DOWNLOADED_DOCUMENT,
                    ip_address: ipAddress,
                    user_agent: userAgent
                });
        }
    }

    /**
     * Get admin review statistics
     * @returns {Promise<object>}
     */
    async getAdminStats() {
        const { count: pending } = await this.supabase
            .from('verification_profiles')
            .select('*', { count: 'exact', head: true })
            .eq('status', VERIFICATION_STATUS.PENDING_REVIEW);

        const { count: approved } = await this.supabase
            .from('verification_profiles')
            .select('*', { count: 'exact', head: true })
            .eq('status', VERIFICATION_STATUS.APPROVED);

        const { count: rejected } = await this.supabase
            .from('verification_profiles')
            .select('*', { count: 'exact', head: true })
            .eq('status', VERIFICATION_STATUS.REJECTED);

        const { count: resubmission } = await this.supabase
            .from('verification_profiles')
            .select('*', { count: 'exact', head: true })
            .eq('status', VERIFICATION_STATUS.RESUBMISSION_REQUIRED);

        return {
            pending: pending || 0,
            approved: approved || 0,
            rejected: rejected || 0,
            resubmissionRequired: resubmission || 0,
            total: (pending || 0) + (approved || 0) + (rejected || 0) + (resubmission || 0)
        };
    }

    /**
     * Check if user is verified (for withdrawal integration)
     * @param {string} userId - User ID
     * @returns {Promise<boolean>}
     */
    async isUserVerified(userId) {
        const status = await this.getVerificationStatus(userId);
        return status === VERIFICATION_STATUS.APPROVED;
    }
}

module.exports = {
    KYCService,
    VERIFICATION_STATUS,
    VERIFICATION_LEVELS,
    REVIEW_ACTIONS,
    CONFIG
};
