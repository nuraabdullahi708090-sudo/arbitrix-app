// Injected before any page script: a full fake backend for the native support UI.
(function () {
  const S = {
    conv: null,
    messages: [],
    nextId: 100,
    calls: [],
    failNextSend: false,
    downstream: [
      { id: 501, user_id: 7, category: 'deposit', status: 'waiting', ai_paused: true, last_message_at: new Date().toISOString(),
        last_message_preview: 'I sent USDT but nothing arrived', unread_for_admin: 2,
        customer: { id: 7, name: 'Ada Lovelace', email: 'ada@example.com', environment: 'PRODUCTION' } },
      { id: 502, user_id: 8, category: 'withdrawal', status: 'open', ai_paused: false, last_message_at: new Date().toISOString(),
        last_message_preview: 'How long do withdrawals take?', unread_for_admin: 0,
        customer: { id: 8, name: 'Grace Hopper', email: 'grace@example.com', environment: 'PRODUCTION' } }
    ]
  };
  window.__NS = S;
  function json(body, status) { return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } })); }
  function msg(sender, body) { const m = { id: S.nextId++, conversation_id: S.conv ? S.conv.id : 1, sender_type: sender, body: body, created_at: new Date().toISOString() }; S.messages.push(m); return m; }

  window.fetch = function (url, opts) {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    S.calls.push(method + ' ' + u);
    if (/cdn|jsdelivr|unpkg|fonts\.googleapis|tradingview/i.test(u)) return json({});
    if (u.indexOf('/api/auth/me') === 0) return json({ user: { id: 7, name: 'Ada', email: 'ada@example.com' }, wallet: {}, nativeSupport: true });
    // ---- customer
    if (u.indexOf('/api/support/conversations') === 0) {
      const rest = u.slice('/api/support/conversations'.length);
      if (!rest || rest === '') {
        if (method === 'POST') {
          if (!S.conv) S.conv = { id: 900, user_id: 7, status: 'open', ai_paused: false, category: body.category || 'general', unread_for_customer: 0, created_at: new Date().toISOString() };
          return json({ ok: true, conversation: S.conv, created: true }, 201);
        }
        return json({ ok: true, conversations: S.conv ? [Object.assign({}, S.conv, { last_message_preview: 'hi' })] : [] });
      }
      const m = rest.match(/^\/(\d+)\/(messages|human|read)$/);
      if (m) {
        const id = Number(m[1]); const action = m[2];
        if (id !== (S.conv && S.conv.id)) return json({ ok: false, error: 'not-found' }, 404);
        if (action === 'messages' && method === 'GET') {
          const after = Number((u.split('after=')[1] || '0'));
          return json({ ok: true, conversation: S.conv, messages: S.messages.filter((x) => x.id > after) });
        }
        if (action === 'messages' && method === 'POST') {
          if (S.failNextSend) { S.failNextSend = false; return json({ ok: false, error: 'unavailable' }, 503); }
          if (S.forceUnavailable) {
            const mine = msg('customer', body.body);
            const notice = msg('system', 'Thanks for your message. A support agent will reply here shortly.');
            return json({ ok: true, supportUnavailable: true, aiPaused: true, conversationId: id, message: mine, reply: notice }, 201);
          }
          const mine = msg('customer', body.body);
          const reply = msg('ai', 'Thanks - here is the approved answer about deposits.');
          S.conv.unread_for_customer = 0;
          return json({ ok: true, conversationId: id, status: 'open', aiPaused: false, message: mine, reply: reply }, 201);
        }
        if (action === 'human') { const n = msg('system', 'A support agent has been notified and will reply here.'); S.conv.ai_paused = true; S.conv.status = 'waiting'; return json({ ok: true, message: n, status: 'waiting', aiPaused: true }); }
        if (action === 'read') { S.conv.unread_for_customer = 0; return json({ ok: true }); }
      }
      return json({ ok: false, error: 'not-found' }, 404);
    }
    // ---- admin
    if (u.indexOf('/api/admin/support/counts') === 0) return json({ ok: true, counts: { total: 2, open: 1, assigned: 0, waiting: 1, resolved: 0, unassigned: 2, unread: 1 } });
    if (u.indexOf('/api/admin/support/customers/') === 0 && u.indexOf('/context') === -1) return json({ ok: true, customers: [] });
    if (u.indexOf('/api/admin/support/customers/') === 0) {
      return json({ ok: true, customer: { id: 7, name: 'Ada Lovelace', email: 'ada@example.com', createdAt: new Date().toISOString(), environment: 'PRODUCTION' },
        wallet: { live_balance: 250, demo_balance: 1000 }, deposits: [{ amount: 100, status: 'confirmed' }],
        withdrawals: [], trades: [{ amount: 12.5, asset: 'BTC/USDT' }], referrals: { total: 3, active: 2, earned: 40 } });
    }
    if (u.indexOf('/api/admin/support/customers') === 0) return json({ ok: true, customers: [{ id: 7, name: 'Ada Lovelace', email: 'ada@example.com' }] });
    if (u.indexOf('/api/admin/support/conversations') === 0) {
      const rest = u.slice('/api/admin/support/conversations'.length).split('?')[0];
      if (!rest) {
        if (method === 'POST') { S.conv = { id: 901, user_id: 7, status: 'assigned', ai_paused: true, category: 'general', unread_for_customer: 1 }; msg('agent', body.body); return json({ ok: true, conversationId: 901, status: 'assigned', aiPaused: true }, 201); }
        return json({ ok: true, conversations: S.downstream });
      }
      const m = rest.match(/^\/(\d+)(?:\/(messages|takeover|resume|assign|resolve))?$/);
      if (m) {
        const id = Number(m[1]); const action = m[2];
        const row = S.downstream.find((c) => c.id === id) || { id: id, user_id: 7, category: 'deposit', status: 'waiting', ai_paused: true, customer: { id: 7, name: 'Ada Lovelace', email: 'ada@example.com' } };
        if (!action) {
          return json({ ok: true, conversation: row, messages: [
            { id: 1, sender_type: 'customer', body: 'I sent USDT but nothing arrived', created_at: new Date().toISOString() },
            { id: 2, sender_type: 'ai', body: 'A support agent will reply here shortly.', created_at: new Date().toISOString() }
          ], actions: [{ action: 'escalate' }] });
        }
        if (action === 'messages') { msg('agent', body.body); return json({ ok: true, conversationId: id, message: { id: 3 } }, 201); }
        if (action === 'takeover') { row.ai_paused = true; row.status = 'assigned'; return json({ ok: true, conversationId: id, status: 'assigned', aiPaused: true }); }
        if (action === 'resume') { row.ai_paused = false; row.status = 'assigned'; return json({ ok: true, conversationId: id, status: 'assigned', aiPaused: false }); }
        if (action === 'assign') { row.status = 'assigned'; return json({ ok: true, conversationId: id, status: 'assigned', aiPaused: row.ai_paused }); }
        if (action === 'resolve') { row.status = 'resolved'; row.ai_paused = true; return json({ ok: true, conversationId: id, status: 'resolved', aiPaused: true }); }
      }
      return json({ ok: false, error: 'not-found' }, 404);
    }
    return json({ ok: true });
  };
  window.__NS_FAIL_NEXT_SEND = function () { S.failNextSend = true; };
})();
