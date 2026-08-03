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
 * - Secure file storage with randomized names
 * - Access control via RLS policies
 * - Audit logging for all admin actions
 * 
 * @author Arbitrix AI
 * @version 1.0.0
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Configuration
const CONFIG = {
    UPLOAD_DIR: process.env.KYC_UPLOAD_DIR || './uploads/kyc',
    MAX_FILE_SIZE: parseInt(process.env.KYC_MAX_FILE_SIZE) || 10 * 1024 * 1024, // 10MB
    ALLOWED_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
    ALLOWED_EXTENSIONS: ['.jpg', '.jpeg', '.png', '.webp'],
    REQUIRED_DOCUMENTS: ['national_id', 'passport', 'drivers_license'], // At least one required
    MIN_DOCUMENT_COUNT: 2, // Front + selfie minimum
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
    constructor(supabase) {
        this.supabase = supabase;
        this.config = CONFIG;
        this.statuses = VERIFICATION_STATUS;
        this.actions = REVIEW_ACTIONS;
        
        // Ensure upload directory exists
        this.ensureUploadDir();
    }

    /**
     * Ensure the upload directory exists
     */
    ensureUploadDir() {
        try {
            if (!fs.existsSync(this.config.UPLOAD_DIR)) {
                fs.mkdirSync(this.config.UPLOAD_DIR, { recursive: true });
                console.log(`[KYCService] Created upload directory: ${this.config.UPLOAD_DIR}`);
            }
        } catch (error) {
            console.error('[KYCService] Failed to create upload directory:', error.message);
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
     * Upload a verification document
     * @param {string} userId - User ID
     * @param {string} documentType - Type of document
     * @param {object} file - File object
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
        await this.supabase
            .from('verification_documents')
            .update({ 
                is_active: false, 
                replaced_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('document_type', documentType)
            .eq('is_active', true);

        // Generate secure filename and save
        const secureFilename = this.generateSecureFilename(file.originalname);
        const filePath = path.join(this.config.UPLOAD_DIR, secureFilename);
        
        try {
            fs.writeFileSync(filePath, file.buffer);
        } catch (writeError) {
            console.error('[KYCService] File write error:', writeError);
            throw new Error('Failed to save document');
        }

        // Insert document record
        const { data, error } = await this.supabase
            .from('verification_documents')
            .insert({
                verification_id: profile.id,
                user_id: userId,
                document_type: documentType,
                original_filename: file.originalname,
                stored_filename: secureFilename,
                file_path: filePath,
                file_size: file.buffer.length,
                mime_type: file.mimetype,
                file_hash: validation.hash,
                is_uploaded: true,
                upload_completed_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            // Clean up file on database error
            try {
                fs.unlinkSync(filePath);
            } catch (cleanupError) {
                console.error('[KYCService] Cleanup error:', cleanupError);
            }
            throw error;
        }

        return data;
    }

    /**
     * Delete a document
     * @param {string} userId - User ID
     * @param {string} documentId - Document ID
     * @returns {Promise<boolean>}
     */
    async deleteDocument(userId, documentId) {
        // Get the document
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
        if (profile.status === VERIFICATION_STATUS.PENDING_REVIEW) {
            throw new Error('Cannot delete documents while verification is under review');
        }

        // Mark as inactive
        const { error } = await this.supabase
            .from('verification_documents')
            .update({ 
                is_active: false, 
                replaced_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', documentId);

        if (error) throw error;

        // Delete physical file
        try {
            if (fs.existsSync(doc.file_path)) {
                fs.unlinkSync(doc.file_path);
            }
        } catch (cleanupError) {
            console.error('[KYCService] File cleanup error:', cleanupError);
        }

        return true;
    }

    /**
     * Get document by ID (with access control)
     * @param {string} userId - Requesting user ID
     * @param {string} documentId - Document ID
     * @param {boolean} isAdmin - Whether requester is admin
     * @returns {Promise<object>}
     */
    async getDocument(userId, documentId, isAdmin = false) {
        let query = this.supabase
            .from('verification_documents')
            .select('*')
            .eq('id', documentId);

        if (!isAdmin) {
            query = query.eq('user_id', userId);
        }

        const { data, error } = await query.single();
        if (error) throw error;

        // Read file and return with data
        let fileBuffer = null;
        try {
            if (fs.existsSync(data.file_path)) {
                fileBuffer = fs.readFileSync(data.file_path);
            }
        } catch (readError) {
            console.error('[KYCService] File read error:', readError);
        }

        return {
            ...data,
            file_buffer: fileBuffer ? fileBuffer.toString('base64') : null
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
    REVIEW_ACTIONS,
    CONFIG
};
