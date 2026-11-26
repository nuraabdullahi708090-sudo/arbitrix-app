
/* ===========================================================================
 * Native in-app support - CUSTOMER widget.
 * Renders labels through t() (strings live in NS_TRANSLATIONS), never innerHTML
 * for user content, and polls while open. Enabled only when /api/auth/me reports
 * nativeSupport:true (feature flag NATIVE_SUPPORT_ENABLED).
 * ========================================================================= */
(function () {
  'use strict';
  var state = { conversationId: null, lastId: 0, open: false, timer: null, sending: false, unread: 0, categories: null, started: false,
    seen: Object.create(null), pendingNode: null, pendingClientId: null, pendingText: null,
    identity: null, generation: 0 };

  function token() { try { return localStorage.getItem('jwt_token') || ''; } catch (e) { return ''; } }
  function tt(key, vars) { try { return typeof t === 'function' ? t(key, vars) : key; } catch (e) { return key; } }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function timeLabel(iso) {
    var d = iso ? new Date(iso) : new Date();
    try { return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function call(path, opts) {
    var o = opts || {};
    return fetch(path, {
      method: o.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() },
      body: o.body ? JSON.stringify(o.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (json) { return { status: r.status, ok: r.ok, body: json }; });
    });
  }

  var root = null, body = null, foot = null, launcher = null, badge = null;

  function build() {
    if (root) return;
    launcher = el('button', 'ns-launcher');
    launcher.type = 'button';
    launcher.setAttribute('aria-label', tt('ns.title'));
    launcher.appendChild(el('i', 'fas fa-comments'));
    launcher.appendChild(el('span', null, tt('ns.title')));
    badge = el('span', 'ns-badge');
    badge.style.display = 'none';
    launcher.appendChild(badge);
    launcher.addEventListener('click', open);
    document.body.appendChild(launcher);

    root = el('section', 'ns-panel');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', tt('ns.title'));
    var head = el('div', 'ns-head');
    head.appendChild(el('h3', null, tt('ns.title')));
    var close = el('button', null, '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', hide);
    head.appendChild(close);
    root.appendChild(head);
    body = el('div', 'ns-body');
    root.appendChild(body);
    foot = el('div', 'ns-foot');
    root.appendChild(foot);
    document.body.appendChild(root);
  }

  function renderChooser() {
    body.innerHTML = '';
    // The greeting belongs to the transcript, not the chooser: showing it here AND
    // as start()'s first system bubble made the assistant look like it was
    // restarting the moment the customer picked a topic.
    body.appendChild(el('div', 'ns-note', tt('ns.catQ')));
    var grid = el('div', 'ns-cats');
    ['deposit', 'withdrawal', 'trading', 'account', 'general'].forEach(function (cat) {
      var b = el('button', null, tt('ns.cat.' + cat));
      b.type = 'button';
      b.addEventListener('click', function () { start(cat); });
      grid.appendChild(b);
    });
    body.appendChild(grid);
    foot.innerHTML = '';
  }

  function setSending(on) {
    if (!foot) return;
    var b = foot.querySelector('.ns-send');
    if (b) { b.disabled = !!on; b.setAttribute('aria-busy', on ? 'true' : 'false'); }
  }

  function renderComposer() {
    foot.innerHTML = '';
    var row = el('div', 'ns-row');
    var input = el('textarea');
    input.placeholder = tt('ns.placeholder');
    input.maxLength = 2000;
    input.setAttribute('aria-label', tt('ns.placeholder'));
    var send = el('button', 'ns-send', tt('ns.send'));
    send.type = 'button';
    function submit() {
      var value = (input.value || '').trim();
      if (!value || state.sending) return;
      input.value = '';
      sendMessage(value);
    }
    send.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
    row.appendChild(input);
    row.appendChild(send);
    foot.appendChild(row);
    var human = el('button', 'ns-link', tt('ns.human'));
    human.type = 'button';
    human.addEventListener('click', requestHuman);
    foot.appendChild(human);
  }

  function messageNode(row, pending) {
    var cls = 'ns-msg ' + (row.sender_type || 'ai') + (pending ? ' pending' : '');
    if (pending && pending.failed) cls += ' failed';
    var node = el('div', cls);
    node.appendChild(el('span', null, row.body || ''));
    node.appendChild(el('span', 'ns-time', pending && pending.failed ? tt('ns.failed') : timeLabel(row.created_at)));
    return node;
  }

  // Server-id dedupe: the 5s poll can return a row that is already on screen
  // (an adopted optimistic bubble, or two overlapping polls). One row = one
  // bubble; a repeat only refreshes the timestamp.
  function appendMessage(row, pending) {
    if (!body) return null;
    if (row && row.id != null) {
      var id = Number(row.id);
      var known = state.seen[id];
      if (known) {
        var t = known.parentNode ? known.querySelector('.ns-time') : null;
        if (t && row.created_at) t.textContent = timeLabel(row.created_at);
        return known;
      }
      var node = messageNode(row, pending);
      state.seen[id] = node;
      body.appendChild(node);
      body.scrollTop = body.scrollHeight;
      if (id > state.lastId) state.lastId = id;
      return node;
    }
    var plain = messageNode(row, pending);
    body.appendChild(plain);
    body.scrollTop = body.scrollHeight;
    return plain;
  }

  // While a send is in flight a poll can return OUR message before the POST
  // response arrives. Adopt the server id onto the optimistic bubble instead of
  // rendering a second copy of the same message.
  function reconcileOrAppend(row) {
    if (!row) return;
    var pending = state.pendingNode;
    if (pending && row.id != null && Number(row.id) > state.lastId && row.sender_type === 'customer') {
      var sameClient = !!(row.client_message_id && state.pendingClientId && row.client_message_id === state.pendingClientId);
      var sameText = !row.client_message_id && !!state.pendingText && row.body === state.pendingText;
      if (sameClient || sameText) {
        var id = Number(row.id);
        pending.classList.remove('pending');
        state.seen[id] = pending;
        if (id > state.lastId) state.lastId = id;
        var t = pending.querySelector('.ns-time');
        if (t && row.created_at) t.textContent = timeLabel(row.created_at);
        state.pendingNode = null;
        state.pendingClientId = null;
        state.pendingText = null;
        return;
      }
    }
    appendMessage(row);
  }

  // The account this panel's state belongs to.
  //
  // The session token is the ONLY value that is (a) written by every login path,
  // (b) removed on logout and (c) actually authenticated by the API - so it is
  // compared IN FULL. Two deliberate choices, both for isolation safety:
  //   * the cached `arbi_user` profile is NOT used: it can lag behind a real
  //     account switch, and a stale id would make the comparison report "same
  //     account" for a different one;
  //   * no hash/fingerprint is taken: an exact comparison has no collision space
  //     at all, so two sessions can never be mistaken for each other.
  // A missing/unreadable token yields null (signed out), which never equals a
  // real identity, so the panel is reset rather than inherited.
  function accountIdentity() {
    var token = '';
    try { token = localStorage.getItem('jwt_token') || ''; } catch (e) { return null; }
    if (!token) return null;
    return 's:' + token;
  }

  // The single place that decides "this is a different account / signed out".
  function shouldResetAccount(previousIdentity, nextIdentity) {
    return nextIdentity !== previousIdentity;
  }

  // Drop EVERYTHING scoped to the previous account: cursors, dedupe map, in-flight
  // pointers and the rendered transcript. `generation` makes any response that is
  // still in flight for the old account get discarded instead of rendered.
  function resetAccountState() {
    state.generation++;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.conversationId = null;
    state.lastId = 0;
    state.started = false;
    state.sending = false;
    state.seen = Object.create(null);
    state.pendingNode = null;
    state.pendingClientId = null;
    state.pendingText = null;
    setUnread(0);
    if (body) body.innerHTML = '';
    if (foot) foot.innerHTML = '';
  }

  function stale(gen) { return gen !== state.generation; }

  function start(category) {
    var gen = state.generation;
    state.started = true;
    body.innerHTML = '';
    appendMessage({ sender_type: 'system', body: tt('ns.welcome'), created_at: new Date().toISOString() });
    renderComposer();
    call('/api/support/conversations', { method: 'POST', body: { category: category, language: (typeof currentLang === 'string' ? currentLang : 'en') } })
      .then(function (r) {
        if (stale(gen)) return;
        if (r.ok && r.body && r.body.conversation) {
          state.conversationId = r.body.conversation.id;
          markRead();
          poll();
        } else {
          appendMessage({ sender_type: 'system', body: tt('ns.error'), created_at: new Date().toISOString() });
        }
      })
      .catch(function () {
        if (stale(gen)) return;
        appendMessage({ sender_type: 'system', body: tt('ns.error'), created_at: new Date().toISOString() });
      });
  }

  function loadExisting() {
    var gen = state.generation;
    return call('/api/support/conversations').then(function (r) {
      if (stale(gen)) return;
      var list = (r.body && r.body.conversations) || [];
      var active = list.filter(function (c) { return c.status !== 'resolved'; })[0];
      var unread = list.reduce(function (n, c) { return n + (Number(c.unread_for_customer) || 0); }, 0);
      setUnread(unread);
      if (!active) { renderChooser(); return; }
      state.conversationId = active.id;
      state.started = true;
      body.innerHTML = '';
      renderComposer();
      return refresh().then(function () { if (typeof NativeSupport !== 'undefined') NativeSupport.unread = unread; });
    });
  }

  function refresh() {
    if (!state.conversationId) return Promise.resolve();
    var gen = state.generation;
    return call('/api/support/conversations/' + state.conversationId + '/messages?after=' + state.lastId).then(function (r) {
      if (stale(gen)) return;
      var rows = (r.body && r.body.messages) || [];
      rows.forEach(function (row) { reconcileOrAppend(row); });
      if (rows.length) {
        var conv = r.body.conversation || {};
        if (conv.ai_paused && (conv.status === 'waiting' || conv.status === 'assigned')) {
          var note = body.querySelector('.ns-agent-note');
          if (!note) { var n = el('div', 'ns-msg system ns-agent-note', tt('ns.agentJoined')); body.appendChild(n); }
        }
        markRead();
      }
    }).catch(function () { /* polling failures are silent; the next tick retries */ });
  }

  function sendMessage(text) {
    // One in-flight message per panel: a second click/Enter while the first POST
    // is pending is ignored (the server would store it as a separate message).
    if (!state.conversationId || state.sending) return;
    var gen = state.generation;
    state.sending = true;
    setSending(true);
    var clientId = 'c' + Date.now() + Math.random().toString(36).slice(2, 8);
    var optimistic = { sender_type: 'customer', body: text, created_at: new Date().toISOString() };
    var node = messageNode(optimistic, { pending: true });
    body.appendChild(node);
    body.scrollTop = body.scrollHeight;
    state.pendingNode = node;
    state.pendingClientId = clientId;
    state.pendingText = text;
    function clearPending() {
      state.pendingNode = null;
      state.pendingClientId = null;
      state.pendingText = null;
    }
    call('/api/support/conversations/' + state.conversationId + '/messages', {
      method: 'POST', body: { body: text, clientMessageId: clientId }
    }).then(function (r) {
      if (stale(gen)) return;
      state.sending = false;
      setSending(false);
      if (!r.ok) {
        node.className = 'ns-msg customer pending failed';
        var label = el('span', 'ns-time', tt(r.status === 429 ? 'ns.rateLimited' : 'ns.error'));
        node.appendChild(label);
        clearPending();
        return;
      }
      var message = (r.body && r.body.message) || null;
      if (message && message.id != null) {
        var id = Number(message.id);
        var already = state.seen[id];
        if (already && already !== node) {
          // The poll adopted this row first: keep the server node, drop ours.
          if (node.parentNode) node.parentNode.removeChild(node);
        } else {
          node.classList.remove('pending');
          state.seen[id] = node;
          if (id > state.lastId) state.lastId = id;
          var t = node.querySelector('.ns-time');
          if (t) t.textContent = timeLabel(message.created_at);
        }
      } else {
        node.classList.remove('pending');
      }
      clearPending();
      if (r.body && r.body.reply) appendMessage(r.body.reply);
    }).catch(function () {
      if (stale(gen)) return;
      state.sending = false;
      setSending(false);
      node.className = 'ns-msg customer pending failed';
      node.appendChild(el('span', 'ns-time', tt('ns.offline')));
      clearPending();
    });
  }

  function requestHuman() {
    if (!state.conversationId) return;
    var gen = state.generation;
    call('/api/support/conversations/' + state.conversationId + '/human', { method: 'POST', body: {} })
      .then(function (r) {
        if (stale(gen)) return;
        if (r.ok && r.body.message) appendMessage(r.body.message);
        else appendMessage({ sender_type: 'system', body: tt('ns.error'), created_at: new Date().toISOString() });
      }).catch(function () {});
  }

  function markRead() {
    if (!state.conversationId) return;
    var gen = state.generation;
    call('/api/support/conversations/' + state.conversationId + '/read', { method: 'POST', body: {} }).then(function () { if (stale(gen)) return; setUnread(0); }).catch(function () {});
  }

  var lastBadgeAt = 0;
  // Refresh the unread badge from the server. Called on every sync AND when the
  // panel closes: a reply that arrived while the messenger was closed has to be
  // visible on the launcher, not only on a fresh page load.
  function refreshBadge(force) {
    var now = Date.now();
    if (!force && now - lastBadgeAt < 5000) return Promise.resolve();
    lastBadgeAt = now;
    var gen = state.generation;
    return call('/api/support/conversations').then(function (r) {
      if (stale(gen)) return;
      var list = (r.body && r.body.conversations) || [];
      setUnread(list.reduce(function (n, c) { return n + (Number(c.unread_for_customer) || 0); }, 0));
    }).catch(function () {});
  }

  function setUnread(n) {
    state.unread = Math.max(0, Number(n) || 0);
    if (!badge) return;
    badge.textContent = String(state.unread);
    badge.style.display = state.unread > 0 ? 'inline-block' : 'none';
  }

  function poll() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () { if (state.open) refresh(); }, 5000);
  }

  function show() { if (launcher) launcher.classList.add('show'); }
  function hideLauncher() { if (launcher) launcher.classList.remove('show'); if (root) root.classList.remove('open'); state.open = false; }

  function open() {
    build();
    root.classList.add('open');
    state.open = true;
    if (launcher) launcher.classList.remove('show');
    if (!state.started) loadExisting();
    else refresh();
  }

  function hide() {
    if (root) root.classList.remove('open');
    state.open = false;
    show();
    refreshBadge(true);
  }

  var NativeSupport = {
    open: open,
    close: hide,
    refresh: refresh,
    unread: 0,
    reloadLabels: function () {
      if (!root) return;
      if (launcher) launcher.setAttribute('aria-label', tt('ns.title'));
      if (state.started) { renderComposer(); }
      else if (body && !body.children.length) renderChooser();
    },
    // Idempotent: safe to call on load, after /api/auth/me, on logout and on any
    // later session change. build() returns early once the DOM exists, so no
    // duplicate nodes or listeners are created by repeated calls.
    sync: function () {
      var enabled = (typeof APP !== 'undefined' && APP && APP.nativeSupport === true);
      var identity = enabled ? accountIdentity() : null;
      if (document.body) document.body.classList.toggle('ns-enabled', enabled);
      // A different account - or support switched off - must not inherit the
      // previous account's transcript, cursors or dedupe map. The same account
      // syncing again (page load, panel reopen, handler re-run) changes nothing,
      // so its transcript is preserved.
      if (shouldResetAccount(state.identity, identity)) {
        resetAccountState();
        state.identity = identity;
        // Only ever hydrate a transcript for an AUTHENTICATED identity: a reset
        // caused by a missing/unreadable session must leave the panel empty
        // rather than fetch with no credentials.
        if (enabled && identity && state.open) loadExisting();
      }
      if (!enabled) {
        if (state.timer) { clearInterval(state.timer); state.timer = null; }
        hideLauncher();
        return;
      }
      build();
      if (!state.open) refreshBadge(false);
      show();
    }
  };
  window.NativeSupport = NativeSupport;
  window.addEventListener('load', function () { setTimeout(function () { try { NativeSupport.sync(); } catch (e) {} }, 2500); });
})();


/* ===========================================================================
 * Native in-app support - ADMIN Support Inbox.
 * List / filter / search, full history, human takeover + AI resume, assignment,
 * resolve, administrator-INITIATED conversations and a read-only customer
 * context panel. Every action calls an admin-gated endpoint; the agent id is
 * never sent from the browser (the server uses the JWT).
 * ========================================================================= */
(function () {
  'use strict';
  var st = { list: [], selected: null, filter: 'all', search: '', composing: false, timer: null };

  function token() { try { return localStorage.getItem('jwt_token') || ''; } catch (e) { return ''; } }
  function tt(key, vars) { try { return typeof t === 'function' ? t(key, vars) : key; } catch (e) { return key; } }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function when(iso) { if (!iso) return ''; var d = new Date(iso); try { return d.toLocaleString(); } catch (e) { return ''; } }
  function call(path, opts) {
    var o = opts || {};
    return fetch(path, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() }, body: o.body ? JSON.stringify(o.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, ok: r.ok, body: j }; }); });
  }
  function enabled() { return (typeof APP !== 'undefined' && APP && APP.nativeSupport === true); }
  function $(id) { return document.getElementById(id); }

  function loadCounts() {
    call('/api/admin/support/counts').then(function (r) {
      var c = (r.body && r.body.counts) || {};
      var node = $('nsInboxCounts');
      if (node) node.textContent = 'Open ' + (c.open || 0) + '  |  Assigned ' + (c.assigned || 0) + '  |  Waiting ' + (c.waiting || 0) + '  |  Unassigned ' + (c.unassigned || 0) + '  |  Unread ' + (c.unread || 0);
      var badge = $('adminTabSupport');
      if (badge && c.unread) badge.textContent = tt('admin.supp.tab') + ' (' + c.unread + ')';
      else if (badge) badge.textContent = tt('admin.supp.tab');
    }).catch(function () {});
  }

  function loadList() {
    var q = '/api/admin/support/conversations?status=' + encodeURIComponent(st.filter === 'all' ? '' : st.filter)
      + '&search=' + encodeURIComponent(st.search);
    call(q).then(function (r) {
      st.list = (r.body && r.body.conversations) || [];
      renderList();
    }).catch(function () { st.list = []; renderList(); });
  }

  function renderList() {
    var list = $('nsInboxList');
    if (!list) return;
    list.innerHTML = '';
    if (!st.list.length) { list.appendChild(el('div', 'ns-note', tt('admin.supp.empty'))); return; }
    st.list.forEach(function (c) {
      var item = el('div', 'ns-item' + (st.selected && st.selected.id === c.id ? ' active' : ''));
      var top = el('div', 'ns-item-top');
      var who = c.customer || {};
      top.appendChild(el('span', null, who.name || who.email || ('#' + c.user_id)));
      top.appendChild(el('span', null, (c.status || '') + (Number(c.unread_for_admin) > 0 ? ' \u2022 ' + c.unread_for_admin : '')));
      item.appendChild(top);
      item.appendChild(el('p', null, (c.category || '') + ' \u2014 ' + (c.last_message_preview || '')));
      item.appendChild(el('div', 'ns-note', when(c.last_message_at || c.created_at)));
      item.addEventListener('click', function () { select(c.id); });
      list.appendChild(item);
    });
  }

  function select(id) {
    call('/api/admin/support/conversations/' + id).then(function (r) {
      if (!r.ok) return;
      st.selected = r.body;
      renderThread();
      loadContext(r.body.conversation.user_id);
      loadList();
      loadCounts();
    });
  }

  function renderThread() {
    var pane = $('nsInboxThread');
    if (!pane) return;
    pane.innerHTML = '';
    var c = st.selected && st.selected.conversation;
    if (!c) {
      pane.appendChild(el('div', 'ns-note', tt('admin.supp.none')));
      if (st.composing) renderComposer(pane);
      return;
    }
    var who = st.selected.customer || {};
    var head = el('div');
    head.appendChild(el('strong', null, (who.name || '') + ' ' + (who.email ? '(' + who.email + ')' : '') + ' #' + c.user_id));
    head.appendChild(el('div', 'ns-note', (c.ai_paused ? tt('admin.supp.aiOff') : tt('admin.supp.aiOn')) + ' \u2022 ' + (c.status || '')));
    pane.appendChild(head);

    var bar = el('div', 'ns-toolbar');
    function action(label, path, body) {
      var b = el('button', null, label);
      b.type = 'button';
      b.addEventListener('click', function () {
        call(path, { method: 'POST', body: body || {} }).then(function () { select(c.id); }).catch(function () {});
      });
      bar.appendChild(b);
    }
    if (c.ai_paused) action(tt('admin.supp.resume'), '/api/admin/support/conversations/' + c.id + '/resume');
    else action(tt('admin.supp.takeover'), '/api/admin/support/conversations/' + c.id + '/takeover');
    action(tt('admin.supp.assign'), '/api/admin/support/conversations/' + c.id + '/assign');
    action(tt('admin.supp.resolve'), '/api/admin/support/conversations/' + c.id + '/resolve');
    pane.appendChild(bar);

    var msgs = el('div', 'ns-thread-msgs');
    (st.selected.messages || []).forEach(function (m) {
      var node = el('div', 'ns-msg ' + m.sender_type);
      node.appendChild(el('span', null, m.body || ''));
      node.appendChild(el('span', 'ns-time', when(m.created_at)));
      msgs.appendChild(node);
    });
    pane.appendChild(msgs);

    var row = el('div', 'ns-row');
    var input = el('textarea');
    input.placeholder = tt('admin.supp.reply');
    input.maxLength = 2000;
    var send = el('button', null, tt('admin.supp.send'));
    send.type = 'button';
    send.addEventListener('click', function () {
      var v = (input.value || '').trim();
      if (!v) return;
      input.value = '';
      call('/api/admin/support/conversations/' + c.id + '/messages', { method: 'POST', body: { body: v } })
        .then(function () { select(c.id); }).catch(function () {});
    });
    row.appendChild(input);
    row.appendChild(send);
    pane.appendChild(row);

    var ctx = el('div', 'ns-context');
    ctx.id = 'nsContextPanel';
    ctx.textContent = tt('admin.supp.context') + '...';
    pane.appendChild(ctx);
  }

  function loadContext(userId) {
    call('/api/admin/support/customers/' + userId + '/context').then(function (r) {
      var ctx = $('nsContextPanel');
      if (!ctx || !r.ok) return;
      ctx.innerHTML = '';
      var table = el('table');
      function row(label, value) {
        var tr = el('tr');
        tr.appendChild(el('td', null, label));
        tr.appendChild(el('td', null, String(value == null ? '-' : value)));
        table.appendChild(tr);
      }
      var w = r.body.wallet || {};
      row('Account', '#' + r.body.customer.id + ' \u2022 ' + (r.body.customer.environment || 'PRODUCTION'));
      row('Created', when(r.body.customer.createdAt));
      row('Live balance', w.live_balance != null ? '$' + Number(w.live_balance).toFixed(2) : '-');
      row('Deposits', (r.body.deposits || []).length ? (r.body.deposits || []).map(function (d) { return d.status + ' $' + Number(d.amount).toFixed(2); }).join(', ') : 'none');
      row('Withdrawals', (r.body.withdrawals || []).length ? (r.body.withdrawals || []).map(function (d) { return d.status + ' $' + Number(d.amount).toFixed(2); }).join(', ') : 'none');
      row('Trades', (r.body.trades || []).length ? (r.body.trades || []).length + ' recent' : 'none');
      row('Referrals', (r.body.referrals || {}).active + ' active / ' + (r.body.referrals || {}).total + ' total');
      ctx.appendChild(table);
    }).catch(function () {});
  }

  function renderComposer(pane) {
    var form = el('div');
    form.appendChild(el('div', 'ns-note', tt('admin.supp.new')));
    var search = el('input');
    search.type = 'search';
    search.placeholder = tt('admin.supp.findCustomer');
    form.appendChild(search);
    var results = el('div');
    form.appendChild(results);
    var box = el('textarea');
    box.placeholder = tt('admin.supp.reply');
    form.appendChild(box);
    var send = el('button', 'btn btn-primary', tt('admin.supp.send'));
    send.type = 'button';
    var targetId = 0;
    search.addEventListener('input', function () {
      var term = (search.value || '').trim();
      results.innerHTML = '';
      if (term.length < 3) return;
      call('/api/admin/support/customers?search=' + encodeURIComponent(term)).then(function (r) {
        (r.body.customers || []).forEach(function (u) {
          var b = el('button', 'ns-link', (u.name || '') + ' ' + (u.email || '') + ' #' + u.id);
          b.type = 'button';
          b.addEventListener('click', function () { targetId = u.id; results.textContent = 'Selected: ' + (u.email || u.id); });
          results.appendChild(el('div')).appendChild(b);
        });
      }).catch(function () {});
    });
    send.addEventListener('click', function () {
      var v = (box.value || '').trim();
      if (!targetId || !v) return;
      call('/api/admin/support/conversations', { method: 'POST', body: { userId: targetId, body: v } })
        .then(function (r) {
          if (r.ok) { st.composing = false; select(r.body.conversationId); }
        }).catch(function () {});
    });
    form.appendChild(send);
    pane.appendChild(form);
  }

  function bind() {
    var filter = $('nsInboxFilter');
    if (filter && !filter.dataset.bound) {
      filter.dataset.bound = '1';
      ['all', 'open', 'assigned', 'waiting', 'resolved'].forEach(function (v) {
        var o = el('option', null, v === 'all' ? tt('admin.supp.all') : v);
        o.value = v;
        filter.appendChild(o);
      });
      filter.addEventListener('change', function () { st.filter = filter.value; loadList(); });
    }
    var search = $('nsInboxSearch');
    if (search && !search.dataset.bound) {
      search.dataset.bound = '1';
      var tmr = null;
      search.addEventListener('input', function () {
        clearTimeout(tmr);
        tmr = setTimeout(function () { st.search = search.value; loadList(); }, 300);
      });
    }
    var refresh = $('nsInboxRefresh');
    if (refresh && !refresh.dataset.bound) {
      refresh.dataset.bound = '1';
      refresh.addEventListener('click', function () { loadCounts(); loadList(); });
    }
    var fresh = $('nsInboxNewBtn');
    if (fresh && !fresh.dataset.bound) {
      fresh.dataset.bound = '1';
      fresh.addEventListener('click', function () {
        st.composing = true;
        st.selected = null;
        renderThread();
        var pane = $('nsInboxThread');
        if (pane && !pane.querySelector('input')) renderComposer(pane);
      });
    }
    var title = $('nsInboxTitle');
    if (title) title.textContent = tt('admin.supp.inbox');
  }

  var Inbox = {
    open: function () {
      if (!enabled()) return;
      bind();
      loadCounts();
      loadList();
      if (st.timer) clearInterval(st.timer);
      st.timer = setInterval(function () { var pane = $('adminTabContentSupport'); if (pane && !pane.classList.contains('hidden')) loadCounts(); }, 30000);
    },
    reloadLabels: function () { bind(); renderList(); if (st.selected) renderThread(); },
    loadCounts: loadCounts,
    loadList: loadList
  };
  window.NativeSupportInbox = Inbox;
  window.addEventListener('load', function () {
    setTimeout(function () {
      var tab = $('adminTabSupport');
      if (tab && (typeof APP === 'undefined' || !APP || APP.nativeSupport !== true)) tab.style.display = 'none';
    }, 2500);
  });
})();
