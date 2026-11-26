'use strict';

/**
 * Q8QPay settlement pipeline - ONE implementation, used by every entry point.
 *
 * WHY THIS MODULE EXISTS
 *   The settlement rules (re-verify with the provider, then compare reference,
 *   asset, amount and address, then resolve a transaction hash, then credit
 *   atomically) used to live inline in the webhook route. Any second entry point
 *   - the customer's "check my payment" action, an operator tool - would have had
 *   to copy them, and a copy is how a validation rule quietly diverges from the
 *   one that protects the money.
 *
 * WHAT IT GUARANTEES
 *   * The PROVIDER is the only source of truth for "confirmed". The incoming
 *     webhook body only locates the invoice; the status, amount and hash that
 *     decide whether money moves come from an authenticated GET /invoices/:id.
 *   * Crediting goes through `credit_payment_safe`, which is atomic and
 *     idempotent (invoice `credited` flag + UNIQUE transaction_hash). A retry, a
 *     concurrent delivery, or a manual re-check can therefore never double-credit.
 *   * Every outcome is a NAMED state with a reply policy, so the caller can tell
 *     "retry me" (transient) from "record this and stop" (permanent) instead of
 *     answering 200 to everything.
 *
 * WHAT IT NEVER DOES
 *   * It never credits from an unverified database field ("status = confirmed" in
 *     our own row alone is not proof of payment).
 *   * It never weakens a comparison to make a payment pass.
 *   * It never touches a wallet directly; money moves only inside the RPC.
 */

const CONFIRMED = 'confirmed';
const SUPPORTED_ASSET = 'USDT_TRC20';

/**
 * Every outcome the pipeline can produce.
 *
 *   httpStatus   what a WEBHOOK should answer. 5xx means "a retry can still
 *                succeed", 2xx means "this delivery is finished - it is either
 *                credited, already handled, or irrecoverable as delivered".
 *   needsReview  true => a human must look at it. The caller is responsible for
 *                writing the durable record; this flag says that it must.
 *   transient    true => the same delivery could still settle later.
 *   code         stable machine value for the durable record / admin UI.
 */
const OUTCOMES = {
    CREDITED: {
        code: 'credited', httpStatus: 200, needsReview: false, transient: false,
        message: 'Payment processed'
    },
    ALREADY_CREDITED: {
        code: 'already_credited', httpStatus: 200, needsReview: false, transient: false,
        message: 'Already processed'
    },
    DUPLICATE: {
        code: 'duplicate', httpStatus: 200, needsReview: false, transient: false,
        message: 'Duplicate payment (not re-credited)'
    },
    PROVIDER_NOT_CONFIRMED: {
        // The webhook says confirmed, the provider's own record does not (yet).
        // A retry is genuinely useful: this is usually the webhook overtaking
        // the provider's read replica, and it is never a reason to credit.
        code: 'provider_not_confirmed', httpStatus: 500, needsReview: true, transient: true,
        message: 'Provider does not report this invoice as confirmed'
    },
    UNKNOWN_INVOICE: {
        code: 'unknown_invoice', httpStatus: 200, needsReview: true, transient: false,
        message: 'No Kalderix invoice matches this reference'
    },
    REFERENCE_MISMATCH: {
        code: 'reference_mismatch', httpStatus: 200, needsReview: true, transient: false,
        message: 'Provider invoice identity does not match the stored invoice'
    },
    ASSET_MISMATCH: {
        code: 'asset_mismatch', httpStatus: 200, needsReview: true, transient: false,
        message: 'Asset is not the USDT TRC20 deposit asset'
    },
    MISSING_STORED_AMOUNT: {
        code: 'missing_stored_amount', httpStatus: 200, needsReview: true, transient: false,
        message: 'The invoice has no stored exact amount to compare against'
    },
    AMOUNT_MISMATCH: {
        code: 'amount_mismatch', httpStatus: 200, needsReview: true, transient: false,
        message: 'The confirmed amount differs from the exact amount quoted'
    },
    ADDRESS_MISMATCH: {
        code: 'address_mismatch', httpStatus: 200, needsReview: true, transient: false,
        message: 'The confirmed payout address differs from the one quoted'
    },
    MISSING_TX_HASH: {
        // Confirmed money with no hash yet: the hash is the credit's idempotency
        // key, so we must not credit without it. A later retry can supply it.
        code: 'missing_tx_hash', httpStatus: 500, needsReview: true, transient: true,
        message: 'Confirmed payment without a transaction hash yet'
    },
    CREDIT_FAILED: {
        code: 'credit_failed', httpStatus: 500, needsReview: true, transient: true,
        message: 'The atomic credit did not complete'
    },
    VERIFY_FAILED: {
        code: 'verify_failed', httpStatus: 500, needsReview: true, transient: true,
        message: 'The provider could not be re-queried'
    },
    UNVERIFIABLE: {
        code: 'unverifiable', httpStatus: 200, needsReview: true, transient: false,
        message: 'The invoice cannot be re-verified with the provider'
    }
};

/** Compare two amounts as the exact 4-decimal figures the provider quotes. */
function sameExactAmount(a, b) {
    if (a == null || b == null) return false;
    const x = Number(Number(a).toFixed(4));
    const y = Number(Number(b).toFixed(4));
    return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/**
 * Build the pipeline around a database handle and a provider instance.
 *
 * @param {object} deps
 * @param {object} deps.db       supabaseAdmin-compatible client (rpc + from)
 * @param {object} deps.provider the q8qpay provider (getInvoiceStatus + resolveTransactionHash)
 */
function createQ8qpaySettlement({ db, provider }) {
    if (!db) throw new Error('createQ8qpaySettlement: db is required');
    if (!provider) throw new Error('createQ8qpaySettlement: provider is required');

    /**
     * Re-verify a payment with the provider, validate it against OUR invoice, and
     * credit it atomically. Returns `{ outcome, details }` and NEVER throws: an
     * unexpected exception becomes CREDIT_FAILED (transient, needs review) so the
     * caller still has a defined thing to record and answer.
     *
     * @param {object} args
     * @param {object} args.invoice       the payment_invoices row (must have id, user_id, invoice_id, amount_usd)
     * @param {string} args.providerInvoiceId  q8qpay invoice UUID
     * @param {string} [args.webhookTxHash]    tx hash seen in the webhook body (may be absent)
     * @param {string} [args.source]           'webhook' | 'manual-check' (audit only)
     */
    async function settle({ invoice, providerInvoiceId, webhookTxHash, source }) {
        const base = {
            source: source || 'webhook',
            invoiceId: invoice && invoice.invoice_id,
            dbInvoiceId: invoice && invoice.id,
            userId: invoice && invoice.user_id,
            providerInvoiceId: providerInvoiceId || null
        };

        if (!invoice) {
            return { outcome: OUTCOMES.UNKNOWN_INVOICE, details: { ...base } };
        }
        // Idempotent fast path: the invoice is already paid for. No provider call.
        if (invoice.credited === true) {
            return { outcome: OUTCOMES.ALREADY_CREDITED, details: { ...base, creditedAt: invoice.credited_at || null } };
        }
        if (!providerInvoiceId) {
            return { outcome: OUTCOMES.UNVERIFIABLE, details: { ...base, reason: 'no provider invoice id on the invoice' } };
        }

        let verifyResult;
        try {
            verifyResult = await provider.getInvoiceStatus(providerInvoiceId);
        } catch (error) {
            return {
                outcome: OUTCOMES.VERIFY_FAILED,
                details: { ...base, reason: 'provider-query-failed', error: String((error && error.message) || error).slice(0, 200) }
            };
        }

        const verify = verifyResult || {};
        const verified = {
            ...base,
            providerStatus: verify.status || null,
            providerInvoiceId: verify.providerInvoiceId || providerInvoiceId,
            providerReference: verify.reference || null,
            providerAmountUsdtExact: verify.amountUsdtExact != null ? String(verify.amountUsdtExact) : null,
            providerPayoutAddress: verify.payoutAddress || null,
            providerAssetCode: verify.assetCode || null,
            providerTxHash: verify.tx_hash || null,
            providerIsTest: verify.isTest === true,
            storedAmountCrypto: invoice.amount_crypto != null ? String(invoice.amount_crypto) : null,
            storedWalletAddress: invoice.wallet_address || null,
            storedProviderInvoiceRef: invoice.provider_invoice_ref || null
        };

        // 1. The provider must agree that money is confirmed.
        if (verify.status !== CONFIRMED) {
            return { outcome: OUTCOMES.PROVIDER_NOT_CONFIRMED, details: verified };
        }

        // 2. Identity: the invoice we are about to credit must be the pair
        //    (our reference, provider invoice) that was created together. This is
        //    checked against the PROVIDER's own return values, so it also works
        //    when our stored provider ref is missing.
        const storedRef = invoice.provider_invoice_ref || null;
        if (storedRef && verify.providerInvoiceId && storedRef !== verify.providerInvoiceId) {
            return { outcome: OUTCOMES.REFERENCE_MISMATCH, details: { ...verified, reason: 'stored-provider-id-mismatch' } };
        }
        if (!storedRef && verify.providerInvoiceId && verify.providerInvoiceId !== providerInvoiceId) {
            return { outcome: OUTCOMES.REFERENCE_MISMATCH, details: { ...verified, reason: 'verified-id-differs-from-requested-id' } };
        }
        if (verify.reference && invoice.invoice_id && String(verify.reference) !== String(invoice.invoice_id)) {
            return { outcome: OUTCOMES.REFERENCE_MISMATCH, details: { ...verified, reason: 'provider-reference-mismatch' } };
        }

        // 3. Asset: deposits are USDT on TRON only.
        if (verify.assetCode !== SUPPORTED_ASSET) {
            return { outcome: OUTCOMES.ASSET_MISMATCH, details: verified };
        }

        // 4. Exact amount. The quote stored at creation IS the provider's
        //    amountUsdtExact, so a confirmed payment must equal it to 4 decimals.
        //    A "close" amount is never accepted: q8qpay itself refuses to confirm
        //    a transfer that does not match its invoice.
        if (invoice.amount_crypto == null) {
            return { outcome: OUTCOMES.MISSING_STORED_AMOUNT, details: verified };
        }
        if (!sameExactAmount(invoice.amount_crypto, verify.amountUsdtExact)) {
            return { outcome: OUTCOMES.AMOUNT_MISMATCH, details: verified };
        }

        // 5. Address: only compared when both sides have one (an invoice created
        //    before the address was stored still settles on amount + reference).
        if (invoice.wallet_address && verify.payoutAddress && invoice.wallet_address !== verify.payoutAddress) {
            return { outcome: OUTCOMES.ADDRESS_MISMATCH, details: verified };
        }

        // 6. Transaction hash: the credit's idempotency key.
        const txHash = provider.resolveTransactionHash({
            webhookTxHash: webhookTxHash || null,
            verifyTxHash: verify.tx_hash || null,
            verifyIsTest: verify.isTest === true,
            providerInvoiceId
        });
        if (!txHash) {
            return { outcome: OUTCOMES.MISSING_TX_HASH, details: verified };
        }

        // Audit fields first, so they survive a concurrent winner of the race.
        try {
            await db.from('payment_invoices')
                .update({
                    provider_tx_hash: txHash,
                    provider_invoice_ref: verify.providerInvoiceId || providerInvoiceId,
                    updated_at: new Date().toISOString()
                })
                .eq('id', invoice.id);
        } catch (error) {
            // Not fatal: the credit below is what matters, and this is audit data.
            console.error('[Q8QPay Settlement] Could not store audit fields:', (error && error.message) || error);
        }

        // 7. Atomic, idempotent credit.
        let credit;
        try {
            credit = await db.rpc('credit_payment_safe', {
                p_invoice_id: invoice.id,
                p_user_id: invoice.user_id,
                p_amount_usd: invoice.amount_usd,
                p_transaction_hash: txHash,
                p_provider_invoice_id: verify.providerInvoiceId || providerInvoiceId,
                p_provider_name: 'q8qpay'
            });
        } catch (error) {
            return {
                outcome: OUTCOMES.CREDIT_FAILED,
                details: { ...verified, txHash, reason: 'rpc-threw', error: String((error && error.message) || error).slice(0, 200) }
            };
        }

        if (credit && credit.error) {
            return {
                outcome: OUTCOMES.CREDIT_FAILED,
                details: { ...verified, txHash, reason: 'rpc-error', error: String(credit.error.message || credit.error).slice(0, 200) }
            };
        }

        const data = (credit && credit.data) || {};
        if (data.duplicate === true) {
            return { outcome: OUTCOMES.DUPLICATE, details: { ...verified, txHash } };
        }
        if (data.success !== true) {
            return {
                outcome: OUTCOMES.CREDIT_FAILED,
                details: { ...verified, txHash, reason: 'credit-refused', error: String(data.error || 'unknown').slice(0, 200) }
            };
        }

        return {
            outcome: OUTCOMES.CREDITED,
            details: {
                ...verified,
                txHash,
                credited: true,
                newBalance: data.new_balance,
                isFirstDeposit: data.is_first_deposit === true,
                referralBonus: data.referral_bonus
            }
        };
    }

    /**
     * Which invoices still need a human? Pure filter over already-loaded rows so
     * the reconciliation view and any future caller share one definition.
     *
     * A "stale" invoice is one we never settled: still pending, or expired by our
     * own clock. Being old is NOT evidence of payment - the provider must be asked.
     */
    function isUnsettled(invoice) {
        if (!invoice) return false;
        if (invoice.credited === true) return false;
        return invoice.status === 'pending' || invoice.status === 'expired';
    }

    return { settle, isUnsettled };
}

module.exports = {
    createQ8qpaySettlement,
    OUTCOMES,
    sameExactAmount,
    SUPPORTED_ASSET,
    CONFIRMED
};
