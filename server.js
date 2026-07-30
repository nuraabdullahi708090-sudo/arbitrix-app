const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = 'mySecret123';

// ---------- REPLACE WITH YOUR SUPABASE CREDENTIALS ----------
const supabaseUrl = 'https://gabqgewycepcyyzqkvvt.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhYnFnZXd5Y2VwY3l5enFrdnZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mjk2ODAsImV4cCI6MjA5ODMwNTY4MH0.xTEZ2-5S9I1deTEJ0xWYk-_diSveYQSYFWHuvod7HWs';
// ------------------------------------------------------------

const supabase = createClient(supabaseUrl, supabaseKey);

// CORS configuration - allow all origins for flexibility
// In production, you may want to restrict this to specific domains
app.use(cors({
  origin: true, // Allow all origins
  credentials: true, // Allow credentials (cookies, authorization headers)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- HELPERS ----------
async function getUser(id) {
  const { data, error } = await supabase.from('users').select('id, name, email, referral_code, is_admin, created_at').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function getUserByEmail(email) {
  const { data, error } = await supabase.from('users').select('id, name, email, password_hash, referral_code, is_admin').eq('email', email).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

async function getWallet(userId) {
  let { data, error } = await supabase.from('wallets').select('*').eq('user_id', userId).single();
  if (error && error.code === 'PGRST116') {
    const { data: newWallet, error: insertError } = await supabase.from('wallets').insert({ user_id: userId, demo_balance: 1000, live_balance: 50, bonus_balance: 0 }).select().single();
    if (insertError) throw insertError;
    return newWallet;
  }
  if (error) throw error;
  return data;
}

async function updateWallet(userId, field, amount) {
  const current = await getWallet(userId);
  const newVal = (current[field] || 0) + amount;
  await supabase.from('wallets').update({ [field]: newVal }).eq('user_id', userId);
}

async function addTransaction(userId, type, amount, detail) {
  await supabase.from('transactions').insert({ user_id: userId, type, amount, detail: detail || '' });
}

// ---------- AUTH MIDDLEWARE ----------
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}

function adminMiddleware(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  next();
}

// ---------- ROUTES ----------
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Register
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, referralCode } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
  if (await getUserByEmail(email)) return res.status(400).json({ error: 'Email already registered' });
  const hash = bcrypt.hashSync(password, 10);
  let refCode = 'ARBI-'; for (let i=0; i<6; i++) refCode += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random()*36)];
  const { data: user, error } = await supabase.from('users').insert({ name, email, password_hash: hash, referral_code: refCode, is_admin: 0 }).select('id, name, email, referral_code, is_admin').single();
  if (error) throw error;
  await getWallet(user.id);
  if (referralCode) {
    const { data: referrer } = await supabase.from('users').select('id').eq('referral_code', referralCode).single();
    if (referrer) {
      await supabase.from('referrals').insert({ referrer_id: referrer.id, referred_id: user.id, bonus_earned: 10 });
      await updateWallet(referrer.id, 'bonus_balance', 10);
      await addTransaction(referrer.id, 'Referral Bonus', 10, 'Referral for ' + email);
    }
  }
  const token = jwt.sign({ id: user.id, email: user.email, isAdmin: user.is_admin===1 }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await getUserByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, email: user.email, isAdmin: user.is_admin===1 }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, referralCode: user.referral_code, isAdmin: user.is_admin===1 } });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await getUser(req.user.id);
  const wallet = await getWallet(user.id);
  res.json({ user, wallet });
});

// ---------- Deposit ----------
app.post('/api/deposit/request', authMiddleware, async (req, res) => {
  const { amount, network } = req.body;
  if (!amount || amount < 10) return res.status(400).json({ error: 'Min $10' });
  const userId = req.user.id;
  const net = network || 'TRC20';
  const invoiceId = 'inv_' + Date.now() + '_' + userId;
  const addresses = { TRC20: 'TDQ2Ymmejp2MXxawBdbYkxqjZ7tTkMyMJR', ERC20: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', BEP20: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e' };
  const address = addresses[net] || addresses.TRC20;
  await supabase.from('deposits').insert({ user_id: userId, amount, network: net, address, invoice_id: invoiceId, status: 'pending' });
  res.json({ id: invoiceId, address, cryptoAmount: (amount/1.0018).toFixed(6), usdValue: amount, expiresAt: new Date(Date.now()+3600000).toISOString(), network: net });
});

app.get('/api/deposit/status/:invoiceId', authMiddleware, async (req, res) => {
  const { invoiceId } = req.params;
  const { data: deposit, error } = await supabase.from('deposits').select('*').eq('invoice_id', invoiceId).eq('user_id', req.user.id).single();
  if (error || !deposit) return res.status(404).json({ error: 'Invoice not found' });
  const elapsed = Date.now() - new Date(deposit.created_at).getTime();
  if (elapsed > 15000 && deposit.status === 'pending') {
    await supabase.from('deposits').update({ status: 'confirmed' }).eq('id', deposit.id);
    await updateWallet(req.user.id, 'live_balance', deposit.amount);
    await addTransaction(req.user.id, 'Deposit', deposit.amount, 'USDT (' + deposit.network + ')');
    deposit.status = 'confirmed';
  }
  if (elapsed > 3600000 && deposit.status === 'pending') {
    await supabase.from('deposits').update({ status: 'expired' }).eq('id', deposit.id);
    deposit.status = 'expired';
  }
  const wallet = await getWallet(req.user.id);
  res.json({ status: deposit.status, newBalance: wallet.live_balance, creditedAmount: deposit.status==='confirmed' ? deposit.amount : 0, network: deposit.network });
});

// ---------- Withdraw ----------
app.post('/api/withdraw/request', authMiddleware, async (req, res) => {
  const { amount, address } = req.body;
  const userId = req.user.id;
  const wallet = await getWallet(userId);
  if (!amount || amount < 700) return res.status(400).json({ error: 'Min $700' });
  if (amount > wallet.live_balance) return res.status(400).json({ error: 'Insufficient balance' });
  if (!address || address.length < 10) return res.status(400).json({ error: 'Valid address required' });
  const { count } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('type', 'Trade Executed');
  if (count < 1) return res.status(400).json({ error: 'Complete at least 1 trade first' });
  await updateWallet(userId, 'live_balance', -amount);
  await addTransaction(userId, 'Withdraw', -amount, 'To ' + address.slice(0,6) + '...');
  const { data, error } = await supabase.from('withdrawals').insert({ user_id: userId, amount, address, status: 'pending' }).select().single();
  if (error) throw error;
  res.json({ id: data.id, amount, address, status: 'pending', message: 'Withdrawal submitted.' });
});

app.get('/api/withdraw/history', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('withdrawals').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  res.json(data);
});

// ---------- Bot ----------
app.post('/api/bot/start', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { mode } = req.body;
  const wallet = await getWallet(userId);
  if (mode === 'live' && wallet.live_balance < 143) return res.status(400).json({ error: 'MTA not reached' });
  await supabase.from('bot_sessions').upsert({ user_id: userId, is_running: 1, mode, started_at: new Date().toISOString() }, { onConflict: 'user_id' });
  res.json({ status: 'started', mode });
});

app.post('/api/bot/stop', authMiddleware, async (req, res) => {
  await supabase.from('bot_sessions').update({ is_running: 0 }).eq('user_id', req.user.id);
  res.json({ status: 'stopped' });
});

app.get('/api/bot/status', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('bot_sessions').select('*').eq('user_id', req.user.id).single();
  if (error && error.code !== 'PGRST116') throw error;
  res.json({ isRunning: data ? data.is_running===1 : false, mode: data ? data.mode : 'demo', startedAt: data ? data.started_at : null });
});

// ---------- Transactions ----------
app.get('/api/transactions', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('transactions').select('id, type, amount, detail, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  res.json(data);
});

// ---------- Referral ----------
app.get('/api/referral/stats', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { count: invited } = await supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('referrer_id', userId);
  const { data: earnedData } = await supabase.from('referrals').select('bonus_earned').eq('referrer_id', userId);
  const earned = earnedData.reduce((s, r) => s + r.bonus_earned, 0);
  res.json({ invited: invited || 0, earned });
});

app.post('/api/referral/simulate', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  await supabase.from('referrals').insert({ referrer_id: userId, referred_id: -userId, bonus_earned: 10 });
  await updateWallet(userId, 'bonus_balance', 10);
  await addTransaction(userId, 'Referral Bonus', 10, 'Simulated referral');
  const { count: invited } = await supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('referrer_id', userId);
  const { data: earnedData } = await supabase.from('referrals').select('bonus_earned').eq('referrer_id', userId);
  const earned = earnedData.reduce((s, r) => s + r.bonus_earned, 0);
  res.json({ invited, earned, bonusAdded: 10 });
});

// ---------- 2FA mock ----------
app.post('/api/2fa/enable', authMiddleware, (req, res) => res.json({ success: true }));
app.post('/api/2fa/verify', authMiddleware, (req, res) => {
  const { code } = req.body;
  if (!code || code.length < 6) return res.status(400).json({ error: 'Invalid code' });
  res.json({ success: true });
});

// ---------- ADMIN ----------
app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { data: deposits } = await supabase.from('deposits').select('amount').eq('status', 'confirmed');
  const totalDeposits = deposits.reduce((s, d) => s + d.amount, 0);
  const { data: withdrawals } = await supabase.from('withdrawals').select('amount').eq('status', 'approved');
  const totalWithdrawals = withdrawals.reduce((s, w) => s + w.amount, 0);
  const { data: txs } = await supabase.from('transactions').select('amount');
  const totalVolume = txs.reduce((s, t) => s + t.amount, 0);
  const { count: activeBots } = await supabase.from('bot_sessions').select('*', { count: 'exact', head: true }).eq('is_running', 1);
  const { data: wallets } = await supabase.from('wallets').select('live_balance');
  const totalLiveBalance = wallets.reduce((s, w) => s + w.live_balance, 0);
  res.json({ totalUsers: totalUsers||0, totalDeposits, totalWithdrawals, totalVolume, activeBots: activeBots||0, totalLiveBalance });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('users').select('id, name, email, referral_code, is_admin, created_at, wallets(demo_balance, live_balance, bonus_balance)').order('created_at', { ascending: false });
  if (error) throw error;
  const users = data.map(u => ({ ...u, demo_balance: u.wallets ? u.wallets.demo_balance : 0, live_balance: u.wallets ? u.wallets.live_balance : 0, bonus_balance: u.wallets ? u.wallets.bonus_balance : 0, wallets: undefined }));
  res.json(users);
});

app.get('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('users').select('id, name, email, referral_code, is_admin, wallets(demo_balance, live_balance, bonus_balance)').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'User not found' });
  const user = { ...data, demo_balance: data.wallets ? data.wallets.demo_balance : 0, live_balance: data.wallets ? data.wallets.live_balance : 0, bonus_balance: data.wallets ? data.wallets.bonus_balance : 0, wallets: undefined };
  res.json(user);
});

app.put('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, email, demo_balance, live_balance, bonus_balance } = req.body;
  await supabase.from('users').update({ name, email }).eq('id', id);
  await supabase.from('wallets').update({ demo_balance, live_balance, bonus_balance }).eq('user_id', id);
  res.json({ success: true });
});

app.post('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { name, email, password, demo_balance } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (await getUserByEmail(email)) return res.status(400).json({ error: 'Email exists' });
  const hash = bcrypt.hashSync(password, 10);
  let refCode = 'ARBI-'; for (let i=0; i<6; i++) refCode += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random()*36)];
  const { data: user, error } = await supabase.from('users').insert({ name, email, password_hash: hash, referral_code: refCode, is_admin: 0 }).select().single();
  if (error) throw error;
  await supabase.from('wallets').insert({ user_id: user.id, demo_balance: demo_balance || 1000, live_balance: 50, bonus_balance: 0 });
  res.json({ success: true, user });
});

app.get('/api/admin/deposits', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('deposits').select('*, users(name)').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  const deposits = data.map(d => ({ ...d, user_name: d.users ? d.users.name : null, users: undefined }));
  res.json(deposits);
});

app.put('/api/admin/deposits/:id/confirm', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { data: deposit, error } = await supabase.from('deposits').select('*').eq('id', id).single();
  if (error || !deposit) return res.status(404).json({ error: 'Deposit not found' });
  if (deposit.status !== 'pending') return res.status(400).json({ error: 'Already ' + deposit.status });
  await supabase.from('deposits').update({ status: 'confirmed' }).eq('id', id);
  await updateWallet(deposit.user_id, 'live_balance', deposit.amount);
  await addTransaction(deposit.user_id, 'Deposit', deposit.amount, 'USDT (' + deposit.network + ')');
  res.json({ success: true });
});

app.get('/api/admin/withdrawals', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('withdrawals').select('*, users(name)').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  const withdrawals = data.map(w => ({ ...w, user_name: w.users ? w.users.name : null, users: undefined }));
  res.json(withdrawals);
});

app.put('/api/admin/withdrawals/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { data: withdrawal, error } = await supabase.from('withdrawals').select('*').eq('id', id).single();
  if (error || !withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
  if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Already ' + withdrawal.status });
  await supabase.from('withdrawals').update({ status: 'approved' }).eq('id', id);
  await addTransaction(withdrawal.user_id, 'Withdraw Approved', -withdrawal.amount, 'Approved withdrawal');
  res.json({ success: true });
});

app.put('/api/admin/withdrawals/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { data: withdrawal, error } = await supabase.from('withdrawals').select('*').eq('id', id).single();
  if (error || !withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
  if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Already ' + withdrawal.status });
  await supabase.from('withdrawals').update({ status: 'rejected' }).eq('id', id);
  await updateWallet(withdrawal.user_id, 'live_balance', withdrawal.amount);
  await addTransaction(withdrawal.user_id, 'Withdraw Rejected', withdrawal.amount, 'Rejected withdrawal refund');
  res.json({ success: true });
});

app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('transactions').select('*, users(name)').order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  const txs = data.map(t => ({ ...t, user_name: t.users ? t.users.name : null, users: undefined }));
  res.json(txs);
});

app.get('/api/admin/referrals', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('referrals').select('*, referrer:users!referrer_id(name), referred:users!referred_id(name)').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  const refs = data.map(r => ({ ...r, referrer_name: r.referrer ? r.referrer.name : null, referred_name: r.referred ? r.referred.name : null, referrer: undefined, referred: undefined }));
  res.json(refs);
});

// ---------- SEED ADMIN ----------
(async function seedAdmin() {
  try {
    const existing = await supabase.from('users').select('id').eq('email', 'admin@arbitrix.ai').single();
    if (!existing.data) {
      const hash = bcrypt.hashSync('admin123', 10);
      const { data: admin, error } = await supabase.from('users').insert({
        name: 'Admin',
        email: 'admin@arbitrix.ai',
        password_hash: hash,
        referral_code: 'ARBI-ADMIN',
        is_admin: 1
      }).select().single();
      if (admin) {
        await supabase.from('wallets').insert({
          user_id: admin.id,
          demo_balance: 10000,
          live_balance: 5000,
          bonus_balance: 0
        });
        console.log('✅ Admin created: admin@arbitrix.ai / admin123');
      }
    }
  } catch (e) {
    console.log('Admin check:', e.message);
  }
})();

// ---------- SERVE FRONTEND (FIXED – NO * WILDCARD) ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Diagnostic endpoint to check Supabase connection (MUST be before fallback)
app.get('/api/diagnostic', async (req, res) => {
  const diagnostics = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    supabaseUrl: supabaseUrl,
    supabaseProjectRef: supabaseUrl.replace('https://', '').split('.')[0],
    supabaseUrlReachable: false,
    supabaseQueryTest: null
  };
  
  // Test Supabase query
  try {
    const { data, error, details, hint, message } = await supabase.from('users').select('id').limit(1);
    diagnostics.supabaseUrlReachable = true;
    if (error) {
      diagnostics.supabaseQueryTest = { 
        success: false, 
        error: message || error.message || 'Unknown error',
        details: details || null,
        hint: hint || null
      };
    } else {
      diagnostics.supabaseQueryTest = { success: true, data };
    }
  } catch (e) {
    diagnostics.supabaseUrlReachable = false;
    console.error('Supabase connection error:', e.message);
    console.error('Error cause:', e.cause);
    diagnostics.supabaseQueryTest = { 
      success: false, 
      error: e.message,
      cause: e.cause ? (e.cause.message || e.cause.code || String(e.cause)) : null
    };
  }
  
  res.json(diagnostics);
});

// Fallback – uses app.use, which does NOT cause the PathError
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware - MUST be defined after all routes
// This prevents Express from rendering "[object Object]" as HTML
app.use((err, req, res, next) => {
  console.error('Server Error:', err.message || err);
  
  // Log detailed error information for debugging
  if (err.cause) {
    console.error('Error cause:', err.cause.message || err.cause);
    console.error('Error cause details:', JSON.stringify(err.cause));
  }
  
  // Determine status code
  const statusCode = err.statusCode || err.status || 500;
  
  // Build error response
  let errorMessage = err.message || 'Internal server error';
  
  // Handle "fetch failed" errors with more detail
  if (errorMessage === 'fetch failed' || errorMessage === 'TypeError: fetch failed') {
    if (err.cause) {
      errorMessage = `Supabase connection failed: ${err.cause.message || err.cause.code || 'Network error'}`;
    } else {
      errorMessage = 'Supabase connection failed: Unable to reach the database server';
    }
  }
  
  const errorResponse = {
    error: errorMessage
  };
  
  // Include stack trace in development only
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    errorResponse.stack = err.stack.split('\n').slice(0, 3).join('\n');
    if (err.cause) {
      errorResponse.cause = err.cause.message || String(err.cause);
    }
  }
  
  res.status(statusCode).json(errorResponse);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Admin panel at http://0.0.0.0:${PORT}/admin`);
});
