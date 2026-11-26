'use strict';

/**
 * HTTP surface for the native in-app support system.
 *
 * Split out of server.js so the wiring is ~10 lines and the whole surface can be
 * reviewed (and unit-tested) in one place. Every dependency is injected:
 *
 *   support        services/NativeSupport.js instance
 *   authMiddleware / adminMiddleware   the app's existing gates
 *   supabaseAdmin  service-role client (admin-only customer context)
 *   isEnabled      feature flag (NATIVE_SUPPORT_ENABLED)
 *
 * Authorisation rules, stated once:
 *   * CUSTOMER routes derive the user id from the verified JWT only. No route
 *     reads a user id from the body or query, so one customer can never read or
 *     write another customer's thread.
 *   * ADMIN routes sit behind adminMiddleware; the module additionally does not
 *     trust any client-supplied actor id (the agent is req.user.id).
 *   * While the feature flag is off every route answers 404, so the surface does
 *     not exist for production customers until it is deliberately enabled.
 */

const STATUS_CODES = {
    'unauthenticated': 401,
    'not-found': 404,
    'rate-limited': 429,
    'empty-body': 400,
    'invalid-body': 400,
    'body-too-long': 400,
    'missing-user': 400,
    'invalid-category': 400,
    'unavailable': 503,
};

function statusFor(result) {
    return STATUS_CODES[result && result.reason] || 400;
}

function sendResult(res, result, okStatus) {
    if (result && result.ok) return res.status(okStatus || 200).json(result);
    const status = statusFor(result);
    if (status === 429) res.set('Retry-After', '60');
    return res.status(status).json(Object.assign({ ok: false, error: (result && result.reason) || 'error' }, result || {}));
}

function intParam(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function registerNativeSupportRoutes(app, deps) {
    const support = deps.support;
    const authMiddleware = deps.authMiddleware;
    const adminMiddleware = deps.adminMiddleware;
    const supabaseAdmin = deps.supabaseAdmin;
    const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : function () { return false; };

    function guard(req, res, next) {
        if (!isEnabled()) return res.status(404).json({ error: 'Not found' });
        next();
    }

    // A support transcript is private, per-customer and polled. Any cache - the
    // browser's, an intermediary's or the CDN in front of the app - must never
    // answer a poll with an older body, which is exactly how an agent's reply can
    // be "missing" while the database has it.
    function noStore(req, res, next) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        next();
    }

    function wrap(handler) {
        return async function wrapped(req, res) {
            try {
                await handler(req, res);
            } catch (err) {
                console.error('[native-support]', req.method, req.path, err && err.message ? err.message : err);
                if (!res.headersSent) res.status(500).json({ ok: false, error: 'Server error' });
            }
        };
    }

    // ------------------------------------------------------------- customer API

    app.get('/api/support/conversations', guard, noStore, authMiddleware, wrap(async (req, res) => {
        sendResult(res, await support.listConversations(req.user.id));
    }));

    app.post('/api/support/conversations', guard, noStore, authMiddleware, wrap(async (req, res) => {
        const body = req.body || {};
        sendResult(res, await support.getOrCreateConversation(req.user.id, {
            category: body.category,
            language: body.language,
        }), 201);
    }));

    app.get('/api/support/conversations/:id/messages', guard, noStore, authMiddleware, wrap(async (req, res) => {
        sendResult(res, await support.listMessages(req.user.id, intParam(req.params.id, 0), {
            afterId: intParam(req.query.after, 0) || null,
            limit: intParam(req.query.limit, 0) || undefined,
        }));
    }));

    app.post('/api/support/conversations/:id/messages', guard, noStore, authMiddleware, wrap(async (req, res) => {
        const body = req.body || {};
        sendResult(res, await support.sendCustomerMessage({
            userId: req.user.id,
            conversationId: intParam(req.params.id, 0),
            body: body.body,
            clientMessageId: body.clientMessageId,
        }), 201);
    }));

    app.post('/api/support/conversations/:id/human', guard, authMiddleware, wrap(async (req, res) => {
        sendResult(res, await support.requestHuman(req.user.id, intParam(req.params.id, 0)));
    }));

    app.post('/api/support/conversations/:id/read', guard, noStore, authMiddleware, wrap(async (req, res) => {
        sendResult(res, await support.markCustomerRead(req.user.id, intParam(req.params.id, 0)));
    }));

    // ---------------------------------------------------------------- admin API

    app.get('/api/admin/support/counts', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        sendResult(res, await support.countsForAdmin());
    }));

    app.get('/api/admin/support/conversations', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        sendResult(res, await support.listForAdmin({
            status: req.query.status,
            search: req.query.search,
            assignedTo: intParam(req.query.assignedTo, 0) || null,
            userId: intParam(req.query.userId, 0) || null,
            limit: intParam(req.query.limit, 0) || undefined,
        }));
    }));

    // Customer lookup for the "message a customer" composer. Read-only, admin
    // only, and returns at most 10 rows with no financial detail.
    app.get('/api/admin/support/customers', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        const term = String(req.query.search || '').trim();
        if (term.length < 3) return res.json({ ok: true, customers: [] });
        const columns = 'id, name, email, created_at, environment';
        let query = supabaseAdmin.from('users').select(columns).limit(10);
        if (/^\d+$/.test(term)) {
            query = supabaseAdmin.from('users').select(columns).eq('id', Number(term)).limit(1);
        } else {
            query = supabaseAdmin.from('users').select(columns).ilike('email', '%' + term.replace(/[%_]/g, '') + '%').limit(10);
        }
        const { data, error } = await query;
        if (error) return res.status(503).json({ ok: false, error: 'unavailable' });
        res.json({ ok: true, customers: data || [] });
    }));

    app.get('/api/admin/support/conversations/:id', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        const result = await support.getConversationForAdmin(intParam(req.params.id, 0));
        sendResult(res, result);
    }));

    app.post('/api/admin/support/conversations/:id/messages', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        const body = req.body || {};
        sendResult(res, await support.sendAgentMessage({
            adminId: req.user.id,
            conversationId: intParam(req.params.id, 0),
            body: body.body,
            clientMessageId: body.clientMessageId,
        }), 201);
    }));

    app.post('/api/admin/support/conversations/:id/takeover', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        sendResult(res, await support.takeover(intParam(req.params.id, 0), req.user.id));
    }));

    app.post('/api/admin/support/conversations/:id/resume', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        sendResult(res, await support.resume(intParam(req.params.id, 0), req.user.id));
    }));

    app.post('/api/admin/support/conversations/:id/assign', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        const body = req.body || {};
        const assignee = intParam(body.adminId, 0) || req.user.id;
        sendResult(res, await support.assign(intParam(req.params.id, 0), req.user.id, assignee));
    }));

    app.post('/api/admin/support/conversations/:id/resolve', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        sendResult(res, await support.resolve(intParam(req.params.id, 0), req.user.id));
    }));

    // Administrator-INITIATED conversation: the inbox can message any customer.
    app.post('/api/admin/support/conversations', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        const body = req.body || {};
        let userId = intParam(body.userId, 0);
        if (!userId && body.email) {
            const { data, error } = await supabaseAdmin.from('users').select('id')
                .ilike('email', String(body.email).trim()).limit(1);
            if (error) return res.status(503).json({ ok: false, error: 'unavailable' });
            userId = data && data[0] ? data[0].id : 0;
        }
        if (!userId) return res.status(404).json({ ok: false, error: 'missing-user' });
        sendResult(res, await support.initiate({
            adminId: req.user.id,
            userId: userId,
            body: body.body,
            category: body.category,
            language: body.language,
        }), 201);
    }));

    // Read-only customer context shown next to a conversation (section 6 of the
    // brief). ADMIN ONLY, minimal fields, capped rows, no credentials.
    app.get('/api/admin/support/customers/:id/context', guard, authMiddleware, adminMiddleware, wrap(async (req, res) => {
        const userId = intParam(req.params.id, 0);
        if (!userId) return res.status(400).json({ ok: false, error: 'invalid-user' });
        const [user, wallet, deposits, withdrawals, trades, referrals] = await Promise.all([
            supabaseAdmin.from('users').select('id, name, email, created_at, is_admin, environment').eq('id', userId).limit(1),
            supabaseAdmin.from('wallets').select('live_balance, demo_balance, bonus_balance').eq('user_id', userId).limit(1),
            supabaseAdmin.from('deposits').select('id, amount, status, created_at, network').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
            supabaseAdmin.from('withdrawals').select('id, amount, status, created_at, network').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
            supabaseAdmin.from('trades').select('id, amount, asset, mode, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
            supabaseAdmin.from('referrals').select('id, status, bonus_earned, created_at').eq('referrer_id', userId).limit(50),
        ]);
        const row = user && user.data && user.data[0];
        if (!row) return res.status(404).json({ ok: false, error: 'not-found' });
        const refs = (referrals && referrals.data) || [];
        res.set('Cache-Control', 'no-store');
        res.json({
            ok: true,
            customer: {
                id: row.id,
                name: row.name || null,
                email: row.email || null,
                createdAt: row.created_at || null,
                isAdmin: Number(row.is_admin) === 1 || row.is_admin === true,
                environment: row.environment || 'PRODUCTION',
            },
            wallet: (wallet && wallet.data && wallet.data[0]) || null,
            deposits: (deposits && deposits.data) || [],
            withdrawals: (withdrawals && withdrawals.data) || [],
            trades: (trades && trades.data) || [],
            referrals: {
                total: refs.length,
                active: refs.filter(function (r) { return r.status === 'active'; }).length,
                earned: refs.reduce(function (sum, r) { return sum + (Number(r.bonus_earned) || 0); }, 0),
            },
        });
    }));
}

module.exports = { registerNativeSupportRoutes, STATUS_CODES, statusFor };
