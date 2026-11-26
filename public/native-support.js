/* ===========================================================================
 * Native in-app support - CUSTOMER widget.
 *
 * HUMAN-ONLY. There is no AI, no automated answer and no fallback bot: a message
 * is stored, acknowledged once by a SYSTEM notice and answered by a person (the
 * admin dashboard or Telegram). Both channels write to the same conversation, so
 * this widget is a transport, never an author.
 *
 * Thread model
 *   * ONE conversation per customer (the server resumes the active one), created
 *     on the FIRST message so opening the panel never leaves an empty thread in
 *     the agents' inbox.
 *   * History is read twice: a full read when the panel opens / the page loads
 *     (the newest N rows, always chronological) and an incremental read
 *     (`?after=<last id>`) every 5s while the panel is open. A reply that arrives
 *     while the widget is closed therefore appears on the next open or refresh,
 *     without the customer having to send anything.
 *   * Rendering is keyed on the SERVER message id, so a poll that overlaps a send
 *     adopts the optimistic bubble instead of drawing the message twice.
 *
 * Failure model
 *   * A failed SEND marks that bubble "Not sent" (the message is not stored, so
 *     saying anything else would be a lie).
 *   * A failed READ is NOT a message error: the thread is unchanged, so the
 *     widget shows one quiet "Reconnecting..." notice with a retry action and
 *     keeps polling. It never injects a chat bubble for a transport problem.
 * ========================================================================= */
(function () {
  'use strict';
  // DUPLICATE-INCLUDE GUARD. A second load of this file (a repeated <script>, a
  // re-injected bundle, a double eval) would create a SECOND launcher/panel pair -
  // i.e. two support buttons and two transcripts. The first instance owns the DOM
  // and the poller; every later one must do nothing at all.
  if (typeof window !== 'undefined' && window.NativeSupport && window.NativeSupport.__mounted === true) return;

  var state = { conversationId: null, lastId: 0, open: false, timer: null, sending: false, unread: 0, started: false, creating: null,
    // Why the customer opened support ('deposit' | 'withdrawal' | 'trading' |
    // 'account'), set by the caller of open({ context }). Display-only, and it
    // becomes the conversation category on the FIRST message - it never sends
    // anything on the customer's behalf.
    context: null,
    seen: Object.create(null), pendingNode: null, pendingClientId: null, pendingText: null,
    identity: null, generation: 0, readFailures: 0, surface: null };

  // ---- which support surface is on screen -----------------------------------
  //
  // ONE decision, expressed as ONE body attribute that the stylesheet keys on:
  //
  //   'pending' - the session / feature flag is still being resolved: NEITHER
  //               launcher is drawn, so the legacy assistant can never be tapped
  //               (or left open) while the messenger is about to take over.
  //   'native'  - the messenger; the legacy assistant is removed from the layout.
  //   'legacy'  - the floating assistant; the messenger launcher cannot be shown.
  //
  // Before this existed the two launchers were controlled independently: the
  // legacy one was visible from first paint by CSS and the native one appeared
  // whenever the flag happened to arrive, so a slow (or failed) /api/auth/me left
  // the wrong launcher on screen - and the second marker that was supposed to keep
  // them apart (`body.ns-enabled`) could be wiped while the messenger was mounted,
  // which showed both at once. There is one marker now, and it is the attribute.
  var SURFACES = { pending: true, native: true, legacy: true };
  // A resolution that never arrives (slow, hung or failed auth) must not leave the
  // customer with no support at all: after this long the legacy surface is used and
  // a later sync() that learns the flag still upgrades to the messenger. Sized to
  // outlast a normal session validation + /api/auth/me on a slow mobile link, so
  // the honest answer - not the fallback - is what the customer sees.
  var SURFACE_PENDING_MS = 8000;
  var surfaceTimer = null;

  function setSurface(next) {
    var value = SURFACES[next] ? next : 'legacy';
    state.surface = value;
    // The host page owns the controller (public/index.html, KxSupportSurface):
    // ONE writer of the attribute, ONE watchdog. Delegating keeps a single
    // implementation even though this module loads after the first startup pass.
    if (window.KxSupportSurface && typeof window.KxSupportSurface.set === 'function') {
      window.KxSupportSurface.set(value);
      return;
    }
    // Standalone load (tests, embedded harness): the same rule, applied here.
    try {
      if (document.body && document.body.dataset) document.body.dataset.supportSurface = value;
    } catch (e) {}
    if (value === 'pending' && surfaceTimer) return;   // keep the original deadline
    if (surfaceTimer) { clearTimeout(surfaceTimer); surfaceTimer = null; }
    if (value === 'pending') {
      surfaceTimer = setTimeout(function () {
        surfaceTimer = null;
        if (state.surface !== 'pending') return;
        setSurface('legacy');
        hideLauncher();
      }, SURFACE_PENDING_MS);
    }
  }

  function token() { try { return localStorage.getItem('jwt_token') || ''; } catch (e) { return ''; } }
  function tt(key, vars) { try { return typeof t === 'function' ? t(key, vars) : key; } catch (e) { return key; } }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  // The ONLY automated strings in this widget. The welcome is an interface
  // message; the acknowledgement says the team has the message - it never
  // pretends to be an agent and never answers the question.
  var COPY = {
    en: {
      welcome: 'Welcome to Kalderix Support. How can we help you today? Send us a message and a member of our support team will respond personally.',
      received: "Thank you for contacting Kalderix. We've received your message and our support team will respond as soon as possible.",
      sending: 'Sending\u2026', delivered: 'Delivered'
    },
    es: {
      welcome: 'Te damos la bienvenida al soporte de Kalderix. \u00bfC\u00f3mo podemos ayudarte hoy? Env\u00edanos un mensaje y un miembro de nuestro equipo de soporte te responder\u00e1 personalmente.',
      received: 'Gracias por contactar con Kalderix. Hemos recibido tu mensaje y nuestro equipo de soporte responder\u00e1 lo antes posible.',
      sending: 'Enviando\u2026', delivered: 'Entregado'
    },
    pt: {
      welcome: 'Bem-vindo ao Suporte Kalderix. Como podemos ajudar hoje? Envie-nos uma mensagem e um membro da nossa equipa de suporte responder\u00e1 pessoalmente.',
      received: 'Obrigado por contactar a Kalderix. Recebemos a sua mensagem e a nossa equipa de suporte responder\u00e1 o mais breve poss\u00edvel.',
      sending: 'A enviar\u2026', delivered: 'Entregue'
    },
    fr: {
      welcome: "Bienvenue dans l'assistance Kalderix. Comment pouvons-nous vous aider aujourd'hui ? Envoyez-nous un message et un membre de notre \u00e9quipe d'assistance vous r\u00e9pondra personnellement.",
      received: "Merci d'avoir contact\u00e9 Kalderix. Nous avons bien re\u00e7u votre message et notre \u00e9quipe d'assistance vous r\u00e9pondra d\u00e8s que possible.",
      sending: 'Envoi\u2026', delivered: 'Envoy\u00e9'
    },
    ar: {
      welcome: '\u0645\u0631\u062d\u0628\u0627\u064b \u0628\u0643 \u0641\u064a \u062f\u0639\u0645 Kalderix. \u0643\u064a\u0641 \u064a\u0645\u0643\u0646\u0646\u0627 \u0645\u0633\u0627\u0639\u062f\u062a\u0643 \u0627\u0644\u064a\u0648\u0645\u061f \u0623\u0631\u0633\u0644 \u0644\u0646\u0627 \u0631\u0633\u0627\u0644\u0629 \u0648\u0633\u064a\u0631\u062f \u0639\u0644\u064a\u0643 \u0623\u062d\u062f \u0623\u0639\u0636\u0627\u0621 \u0641\u0631\u064a\u0642 \u0627\u0644\u062f\u0639\u0645 \u0644\u062f\u064a\u0646\u0627 \u0634\u062e\u0635\u064a\u0627\u064b.',
      received: '\u0634\u0643\u0631\u0627\u064b \u0644\u062a\u0648\u0627\u0635\u0644\u0643 \u0645\u0639 Kalderix. \u0644\u0642\u062f \u0627\u0633\u062a\u0644\u0645\u0646\u0627 \u0631\u0633\u0627\u0644\u062a\u0643 \u0648\u0633\u064a\u0631\u062f \u0639\u0644\u064a\u0643 \u0641\u0631\u064a\u0642 \u0627\u0644\u062f\u0639\u0645 \u0644\u062f\u064a\u0646\u0627 \u0641\u064a \u0623\u0642\u0631\u0628 \u0648\u0642\u062a \u0645\u0645\u0643\u0646.',
      sending: '\u062c\u0627\u0631\u064d \u0627\u0644\u0625\u0631\u0633\u0627\u0644\u2026', delivered: '\u062a\u0645 \u0627\u0644\u0625\u0631\u0633\u0627\u0644'
    },
    zh: {
      welcome: '\u6b22\u8fce\u4f7f\u7528 Kalderix \u652f\u6301\u3002\u4eca\u5929\u6211\u4eec\u80fd\u4e3a\u60a8\u505a\u4e9b\u4ec0\u4e48\uff1f\u8bf7\u7ed9\u6211\u4eec\u53d1\u9001\u6d88\u606f\uff0c\u6211\u4eec\u7684\u652f\u6301\u56e2\u961f\u6210\u5458\u4f1a\u4eb2\u81ea\u56de\u590d\u60a8\u3002',
      received: '\u611f\u8c22\u60a8\u8054\u7cfb Kalderix\u3002\u6211\u4eec\u5df2\u6536\u5230\u60a8\u7684\u6d88\u606f\uff0c\u5ba2\u670d\u56e2\u961f\u4f1a\u5c3d\u5feb\u56de\u590d\u60a8\u3002',
      sending: '\u53d1\u9001\u4e2d\u2026', delivered: '\u5df2\u53d1\u9001'
    }
  };
  function copy(key) {
    var lang = (typeof currentLang === 'string' && COPY[currentLang]) ? currentLang : 'en';
    return (COPY[lang] && COPY[lang][key]) || COPY.en[key];
  }

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

  var root = null, body = null, foot = null, launcher = null, badge = null, notice = null;
  var contextEl = null;

  function build() {
    if (root) return;
    // A small circular affordance: the icon carries the meaning and the
    // accessible name carries the words (plus the unread count). No permanent
    // "Kalderix Support" label - the closed launcher is a button, not an advert.
    launcher = el('button', 'ns-launcher');
    launcher.type = 'button';
    launcher.setAttribute('aria-label', launcherLabel());
    launcher.setAttribute('title', tt('ns.launcher'));
    var icon = el('i', 'fas fa-comments');
    icon.setAttribute('aria-hidden', 'true');
    launcher.appendChild(icon);
    badge = el('span', 'ns-badge');
    badge.setAttribute('aria-hidden', 'true');   // the count is in the aria-label
    badge.style.display = 'none';
    launcher.appendChild(badge);
    launcher.addEventListener('click', open);
    document.body.appendChild(launcher);

    root = el('section', 'ns-panel');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', tt('ns.title'));
    var head = el('div', 'ns-head');
    var ident = el('div', 'ns-head-id');
    ident.appendChild(el('span', 'ns-dot'));
    ident.appendChild(el('h3', null, tt('ns.title')));
    head.appendChild(ident);
    var close = el('button', 'ns-close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', tt('ns.close'));
    close.addEventListener('click', hide);
    head.appendChild(close);
    root.appendChild(head);
    // Context chip: shown only when support was opened from a specific area
    // (deposit / withdrawal / trading / account). Localized, no request.
    contextEl = el('div', 'ns-context');
    contextEl.hidden = true;
    root.appendChild(contextEl);
    body = el('div', 'ns-body');
    body.setAttribute('role', 'log');
    body.setAttribute('aria-live', 'polite');
    root.appendChild(body);
    foot = el('div', 'ns-foot');
    root.appendChild(foot);
    document.body.appendChild(root);
  }

  // Support is ONE conversation: opening the widget shows the static welcome and
  // the composer. A category is never requested, and no conversation row is
  // created until the customer actually writes something.
  function renderWelcome() {
    if (!body) return;
    body.innerHTML = '';
    appendMessage({
      sender_type: 'system',
      body: copy('welcome'),
      created_at: new Date().toISOString()
    });
    renderComposer();
  }
  // Alias: the panel is the "welcome" state, and older call sites/tests still
  // refer to the chooser by name.
  var renderChooser = renderWelcome;

  function setSending(on) {
    if (!foot) return;
    var b = foot.querySelector('.ns-send');
    if (b) { b.disabled = !!on; b.setAttribute('aria-busy', on ? 'true' : 'false'); }
  }

  function renderComposer() {
    if (!foot) return;
    foot.innerHTML = '';
    var row = el('div', 'ns-row');
    var input = el('textarea');
    input.placeholder = tt('ns.placeholder');
    input.setAttribute('aria-label', tt('ns.placeholder'));
    input.rows = 1;
    input.maxLength = 2000;
    var send = el('button', 'ns-send');
    send.type = 'button';
    send.setAttribute('aria-label', tt('ns.send'));
    var icon = el('i', 'fas fa-paper-plane');
    icon.setAttribute('aria-hidden', 'true');
    send.appendChild(icon);
    send.appendChild(el('span', 'ns-send-text', tt('ns.send')));
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
  }

  function messageNode(row, pending) {
    var kind = row.sender_type || 'system';
    var cls = 'ns-msg ' + kind + (pending ? ' pending' : '');
    if (pending && pending.failed) cls += ' failed';
    var node = el('div', cls);
    // Message ORIGIN (customer / admin / telegram / system) travels with the row
    // so a bubble can be attributed without leaking the channel into the copy.
    if (row.via) node.setAttribute('data-via', row.via);
    if (kind === 'agent') node.setAttribute('data-role', 'agent');
    node.appendChild(el('span', 'ns-text', row.body || ''));
    var meta;
    if (pending) meta = pending.failed ? tt('ns.failed') : copy('sending');
    else if (kind === 'agent') meta = timeLabel(row.created_at);
    else meta = timeLabel(row.created_at) + (kind === 'customer' ? ' \u00b7 ' + copy('delivered') : '');
    node.appendChild(el('span', 'ns-time', meta));
    return node;
  }

  function scrollToEnd() { if (body) body.scrollTop = body.scrollHeight; }

  // Server-id dedupe: the 5s poll can return a row that is already on screen (an
  // adopted optimistic bubble, or two overlapping polls). One row = one bubble; a
  // repeat only refreshes the timestamp.
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
      if (id > state.lastId) state.lastId = id;
      scrollToEnd();
      return node;
    }
    var plain = messageNode(row, pending);
    body.appendChild(plain);
    scrollToEnd();
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

  // ---- transport notices -----------------------------------------------------
  // A failed READ is a transport problem, not a message: show ONE quiet notice
  // with a retry action, never a chat bubble, and never repeat it.
  function showNotice(key) {
    if (!body) return;
    if (notice && notice.parentNode) {
      var label = notice.querySelector('.ns-notice-text');
      if (label) label.textContent = tt(key);
      return;
    }
    notice = el('div', 'ns-notice');
    notice.setAttribute('role', 'status');
    notice.appendChild(el('span', 'ns-notice-text', tt(key)));
    var retry = el('button', 'ns-notice-retry', tt('ns.retry'));
    retry.type = 'button';
    retry.addEventListener('click', function () { clearNotice(); resync(); });
    notice.appendChild(retry);
    body.appendChild(notice);
  }

  function clearNotice() {
    if (notice && notice.parentNode) notice.parentNode.removeChild(notice);
    notice = null;
  }

  // ---- account identity ------------------------------------------------------
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
    stopBadgeWatcher();
    state.conversationId = null;
    state.lastId = 0;
    state.started = false;
    state.sending = false;
    state.readFailures = 0;
    state.seen = Object.create(null);
    state.pendingNode = null;
    state.pendingClientId = null;
    state.pendingText = null;
    state.context = null;
    notice = null;
    setUnread(0);
    if (typeof contextEl !== 'undefined' && contextEl) {
      contextEl.hidden = true;
      contextEl.textContent = '';
    }
    if (body) body.innerHTML = '';
    if (foot) foot.innerHTML = '';
  }

  function stale(gen) { return gen !== state.generation; }

  // Created on the FIRST message. The server endpoint is get-or-create, so this
  // can never open a second active thread for the same customer.
  function ensureConversation() {
    if (state.conversationId) return Promise.resolve(state.conversationId);
    if (state.creating) return state.creating;
    var gen = state.generation;
    state.creating = call('/api/support/conversations', {
      method: 'POST',
      body: { category: state.context || 'general', language: (typeof currentLang === 'string' ? currentLang : 'en') }
    }).then(function (r) {
      state.creating = null;
      if (stale(gen)) return null;
      if (r.ok && r.body && r.body.conversation) {
        state.conversationId = r.body.conversation.id;
        state.started = true;
        markRead();
        poll();
        return state.conversationId;
      }
      // Nothing was stored, so nothing claims otherwise: the caller restores the
      // draft and the notice offers a retry.
      showNotice('ns.reconnecting');
      return null;
    }).catch(function () {
      state.creating = null;
      if (stale(gen)) return null;
      showNotice('ns.reconnecting');
      return null;
    });
    return state.creating;
  }

  function loadExisting() {
    var gen = state.generation;
    return call('/api/support/conversations').then(function (r) {
      if (stale(gen)) return;
      if (!r.ok) {
        // We cannot tell whether a thread exists, so do NOT create one: show the
        // welcome, say we are reconnecting, and let the server's get-or-create
        // endpoint resolve it when the customer writes.
        state.readFailures++;
        renderWelcome();
        showNotice('ns.reconnecting');
        return;
      }
      var list = (r.body && r.body.conversations) || [];
      var active = list.filter(function (c) { return c.status !== 'resolved'; })[0];
      var unread = unreadFrom(list);
      setUnread(unread);
      state.readFailures = 0;
      clearNotice();
      if (!active) { renderWelcome(); return; }
      state.conversationId = active.id;
      state.started = true;
      body.innerHTML = '';
      renderComposer();
      return refresh({ full: true }).then(function () {
        if (typeof NativeSupport !== 'undefined') NativeSupport.unread = unread;
      });
    }).catch(function () {
      if (stale(gen)) return;
      state.readFailures++;
      renderWelcome();
      showNotice('ns.reconnecting');
    });
  }

  /**
   * Read the thread.
   *   refresh()            -> only rows after the cursor (polling)
   *   refresh({full:true}) -> the whole thread, newest N rows, chronological
   * A failed read leaves the transcript untouched and surfaces one notice; the
   * next tick retries, and resync() repairs a cursor that has gone stale.
   */
  function refresh(options) {
    if (!state.conversationId) return Promise.resolve();
    var full = !!(options && options.full);
    var gen = state.generation;
    var path = '/api/support/conversations/' + state.conversationId + '/messages'
      + (full ? '' : '?after=' + state.lastId);
    return call(path).then(function (r) {
      if (stale(gen)) return;
      if (!r.ok) {
        if (r.status === 404) {
          // The conversation is gone (resolved elsewhere / not ours): forget the
          // cursor so the next open starts from a clean read instead of polling a
          // thread that no longer exists.
          state.started = false;
          state.conversationId = null;
          state.lastId = 0;
          state.seen = Object.create(null);
          renderWelcome();
          return;
        }
        throw new Error('history-unavailable');
      }
      state.readFailures = 0;
      clearNotice();
      var rows = (r.body && r.body.messages) || [];
      rows.forEach(function (row) { reconcileOrAppend(row); });
      // No "an agent joined" banner: the agent's own green bubble says so, and an
      // extra synthetic line would compete with the real transcript.
      //
      // READ RECEIPT: only after the rows above are on screen. A failed read
      // returns before this point, so an outage can never mark a reply as read,
      // and a background refresh (panel closed) never clears the badge at all.
      if (state.open && (rows.length || state.unread > 0)) markRead();
    }).catch(function () {
      if (stale(gen)) return;
      state.readFailures++;
      // One notice, not one per failed poll.
      showNotice('ns.reconnecting');
    });
  }

  /**
   * Repair the view: re-read the WHOLE thread and redraw it. Used by the notice's
   * retry action and whenever a cursor may be ahead of the server. Rendering is
   * id-based, so a row that is already on screen cannot be duplicated.
   */
  function resync() {
    if (!state.conversationId) return loadExisting();
    var gen = state.generation;
    state.lastId = 0;
    state.seen = Object.create(null);
    state.pendingNode = null;
    state.pendingClientId = null;
    state.pendingText = null;
    if (body) body.innerHTML = '';
    renderComposer();
    return refresh({ full: true }).then(function () {
      if (stale(gen)) return;
      if (!body || !body.children.length) renderWelcome();
    });
  }

  function sendMessage(text) {
    // One in-flight message per panel: a second click/Enter while the first POST
    // is pending is ignored (the server would store it as a separate message).
    if (state.sending) return;
    if (!state.conversationId) {
      var gen0 = state.generation;
      ensureConversation().then(function (id) {
        if (stale(gen0)) return;
        if (id) { sendMessage(text); return; }
        // Nothing was stored: put the text back so the customer does not lose it.
        var input = foot && foot.querySelector('textarea');
        if (input && !input.value) input.value = text;
      });
      return;
    }
    var gen = state.generation;
    state.sending = true;
    setSending(true);
    clearNotice();
    var clientId = 'c' + Date.now() + Math.random().toString(36).slice(2, 8);
    var optimistic = { sender_type: 'customer', body: text, created_at: new Date().toISOString() };
    var node = messageNode(optimistic, { pending: true });
    body.appendChild(node);
    scrollToEnd();
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
        // The message is NOT stored: mark THIS bubble and stop there. No chat
        // bubble is added for the transport problem itself.
        node.className = 'ns-msg customer pending failed';
        var label = node.querySelector('.ns-time');
        if (label) label.textContent = tt(r.status === 429 ? 'ns.rateLimited' : 'ns.error');
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
          if (t) t.textContent = timeLabel(message.created_at) + ' \u00b7 ' + copy('delivered');
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
      var t = node.querySelector('.ns-time');
      if (t) t.textContent = tt('ns.offline');
      clearPending();
    });
  }

  /**
   * Read receipt. ONLY while the panel is open: the receipt means "the customer
   * has this thread in front of them", so a background badge poll or a closed
   * panel must never clear an unread reply.
   */
  function markRead() {
    if (!state.conversationId) return;
    if (!state.open) return;
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
      setUnread(unreadFrom(list));
    }).catch(function () {});
  }

  // A badge wider than two digits would start to distort the circle, so the count
  // is capped at 9+. The exact number is still spoken (see launcherLabel()).
  var UNREAD_CAP = 9;
  function unreadText(n) { return n > UNREAD_CAP ? UNREAD_CAP + '+' : String(n); }

  function launcherLabel() {
    var base = tt('ns.launcher');
    if (!state.unread) return base;
    return base + ', ' + tt('ns.unreadLabel', { count: state.unread });
  }

  // Closed-state unread watcher.
  //
  // The open panel polls the thread every 5s; while the panel is CLOSED the only
  // way a reply could reach the launcher badge was a page load or a re-sync, so an
  // agent answer could sit unseen for hours. This reuses the SAME conversation-list
  // endpoint (the one sync() already calls) at a much lower frequency, and only
  // while the messenger is the surface, the panel is closed and the tab is
  // visible. One timer, guarded, stopped the moment the panel opens or the
  // account/surface changes.
  var badgeTimer = null;
  var BADGE_POLL_MS = 25000;

  function badgePollDue() {
    if (state.surface !== 'native' || state.open) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    return true;
  }

  function startBadgeWatcher() {
    if (badgeTimer || typeof setInterval !== 'function') return;
    if (!badgePollDue()) return;
    badgeTimer = setInterval(function () {
      if (!badgePollDue()) return;
      refreshBadge(true);
    }, BADGE_POLL_MS);
  }

  function stopBadgeWatcher() {
    if (!badgeTimer) return;
    if (typeof clearInterval === 'function') clearInterval(badgeTimer);
    badgeTimer = null;
  }

  /**
   * Unread for the threads this widget can actually SHOW.
   *
   * The badge and the read receipt must agree: the panel displays the newest
   * non-resolved conversation, so counting a resolved thread's counter would
   * produce a badge that opening the panel can never clear (and clearing it would
   * mean marking a thread read that was never retrieved - exactly what the
   * receipt must not do).
   */
  function unreadFrom(list) {
    return (list || []).reduce(function (n, c) {
      if (!c || c.status === 'resolved') return n;
      return n + (Number(c.unread_for_customer) || 0);
    }, 0);
  }

  function setUnread(n) {
    state.unread = Math.max(0, Math.floor(Number(n) || 0));
    if (badge) {
      // Nothing unread -> no text at all, so a hidden badge can never leak a
      // stale "0" into the accessibility tree or into a layout measurement.
      badge.textContent = state.unread > 0 ? unreadText(state.unread) : '';
      badge.style.display = state.unread > 0 ? 'inline-block' : 'none';
    }
    if (launcher) launcher.setAttribute('aria-label', launcherLabel());
    // The public counter mirrors the badge for any host code that reads it.
    if (typeof NativeSupport !== 'undefined' && NativeSupport) NativeSupport.unread = state.unread;
  }

  function poll() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () { if (state.open) refresh(); }, 5000);
  }

  function show() { if (launcher) launcher.classList.add('show'); }
  function hideLauncher() {
    if (launcher) launcher.classList.remove('show');
    if (root) root.classList.remove('open');
    state.open = false;
    stopBadgeWatcher();
  }

  // The four reasons a customer can arrive with. Mirrors the conversation
  // categories the server already stores (support_conversations.category), so
  // passing one needs no schema change.
  var CONTEXTS = { deposit: 1, withdrawal: 1, trading: 1, account: 1 };

  function normaliseContext(topic) {
    var key = String(topic == null ? '' : topic).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(CONTEXTS, key) ? key : null;
  }

  function setContext(topic) {
    state.context = normaliseContext(topic);
    var chip = (typeof contextEl === 'undefined') ? null : contextEl;
    if (!chip) return;
    if (!state.context) {
      chip.hidden = true;
      chip.textContent = '';
      return;
    }
    chip.hidden = false;
    chip.textContent = tt('ns.context.' + state.context);
  }

  function open(opts) {
    // The messenger opens ONLY on its own surface. Opening it while the legacy
    // assistant owns support would put two support surfaces on screen at once (and
    // its API may be switched off server-side). Callers get `false` and decide
    // what to say instead - see handOverToHumanSupport() in index.html.
    if (state.surface !== 'native') return false;
    build();
    if (opts && typeof opts === 'object' && opts.context) setContext(opts.context);
    root.classList.add('open');
    state.open = true;
    if (launcher) launcher.classList.remove('show');
    // The open panel reads the thread itself; the closed-state badge poller would
    // only double the traffic.
    stopBadgeWatcher();
    // Start (or restart) the incremental read: an agent reply must appear while
    // the panel sits open, without the customer sending anything. poll() is
    // idempotent, and it only ticks while `state.open` is true.
    poll();
    if (!state.started) {
      loadExisting();
    } else {
      // Coming back to an open panel: read the WHOLE thread so anything that
      // arrived meanwhile is on screen without waiting for the next poll. The read
      // receipt is issued by refresh() once the rows are actually rendered - never
      // here, where a failed fetch would clear the badge for a thread nobody saw.
      refresh({ full: true });
    }
    return true;
  }

  function hide() {
    if (root) root.classList.remove('open');
    state.open = false;
    setContext(null);
    show();
    refreshBadge(true);
    // Closed again: keep watching for an agent reply so the badge can appear
    // without the customer refreshing the page.
    startBadgeWatcher();
  }

  var NativeSupport = {
    // Marks the DOM as owned, so a duplicate include cannot mount a second widget.
    __mounted: true,
    // Used by the host's support-surface watchdog when a session never resolves.
    hideLauncher: hideLauncher,
    // 'pending' | 'native' | 'legacy' - read-only view of the current decision.
    surface: function () { return state.surface; },
    open: open,
    close: hide,
    refresh: refresh,
    resync: resync,
    unread: 0,
    // Read-only view of the two loops, so "no duplicate polling" is observable
    // rather than assumed (used by tests and available in a browser console).
    timers: function () { return { poll: !!state.timer, badge: !!badgeTimer }; },
    reloadLabels: function () {
      if (!root) return;
      if (launcher) {
        launcher.setAttribute('title', tt('ns.launcher'));
        launcher.setAttribute('aria-label', launcherLabel());
      }
      if (typeof contextEl !== 'undefined' && contextEl && state.context) {
        contextEl.textContent = tt('ns.context.' + state.context);
      }
      if (notice) {
        var label = notice.querySelector('.ns-notice-text');
        if (label) label.textContent = tt('ns.reconnecting');
        var retry = notice.querySelector('.ns-notice-retry');
        if (retry) retry.textContent = tt('ns.retry');
      }
      if (state.started) { renderComposer(); }
      else if (body && !body.children.length) renderChooser();
    },
    // Idempotent: safe to call on load, after /api/auth/me, on logout and on any
    // later session change. build() returns early once the DOM exists, so no
    // duplicate nodes or listeners are created by repeated calls.
    sync: function () {
      // The flag is a TRI-STATE: `true`/`false` are answers, `undefined` means the
      // session has not been resolved yet (no /api/auth/me response, or it failed).
      // `APP.nativeSupportKnown` lets the caller state "this answer is final" even
      // when the server omitted the field entirely.
      var flag = (typeof APP !== 'undefined' && APP) ? APP.nativeSupport : undefined;
      var known = (typeof APP !== 'undefined' && APP && APP.nativeSupportKnown === true) || typeof flag === 'boolean';
      var enabled = known && flag === true;
      // Exactly one launcher: the surface is decided here and nowhere else. While
      // the answer is unknown NOTHING is shown (a watchdog falls back to legacy).
      setSurface(known ? (enabled ? 'native' : 'legacy') : 'pending');
      var identity = enabled ? accountIdentity() : null;
      // A different account - or support switched off - must not inherit the
      // previous account's transcript, cursors or dedupe map. The same account
      // syncing again (page load, panel reopen, handler re-run) changes nothing,
      // so its transcript is preserved.
      var accountChanged = shouldResetAccount(state.identity, identity);
      if (accountChanged) {
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
      // Never show the launcher while the panel it opens is ALREADY open: sync()
      // runs on login, on an account switch and on a duplicate script load, and
      // showing it there put a launcher pill on top of an open messenger - two
      // support surfaces on screen at once.
      if (!state.open) {
        // A different account must get ITS unread count immediately, not after the
        // 5s rate-limit window that the previous account's refresh opened.
        refreshBadge(accountChanged);
        show();
        startBadgeWatcher();
      } else {
        stopBadgeWatcher();
      }
    }
  };
  window.NativeSupport = NativeSupport;
  window.addEventListener('load', function () { setTimeout(function () { try { NativeSupport.sync(); } catch (e) {} }, 2500); });

  // A backgrounded tab must not poll. On return, refresh once immediately (a
  // reply may have arrived while hidden) and let the watcher resume.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopBadgeWatcher(); return; }
      if (state.surface !== 'native' || state.open) return;
      refreshBadge(true);
      startBadgeWatcher();
    });
  }
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

  // Provenance labels. `ai` exists only for messages written before the switch to
  // human-only support, so a historical row can never look like a person's reply.
  var VIA_LABELS = {
    customer: 'Customer',
    admin: 'Dashboard',
    telegram: 'Telegram',
    system: 'System',
    ai: 'Assistant (historical)'
  };
  function viaLabel(m) {
    if (m && m.via && VIA_LABELS[m.via]) return VIA_LABELS[m.via];
    if (m && m.sender_type === 'customer') return VIA_LABELS.customer;
    if (m && m.sender_type === 'agent') return VIA_LABELS.admin;
    if (m && m.sender_type === 'system') return VIA_LABELS.system;
    return VIA_LABELS.ai;
  }

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
    // No AI wording survives here: a thread is either owned by an agent or waiting
    // for one, and the customer's e-mail and account id identify who is writing.
    head.appendChild(el('div', 'ns-note', (c.ai_paused ? 'Agent handling' : 'Waiting for an agent')
      + ' \u2022 ' + (c.status || '')
      + (c.assigned_admin_id ? ' \u2022 assigned #' + c.assigned_admin_id : '')));
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
      node.appendChild(el('span', 'ns-note', viaLabel(m) + ' \u00b7 ' + when(m.created_at)));
      node.appendChild(el('span', null, m.body || ''));
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

  // Re-render the open thread when new messages arrive, keeping whatever the agent
  // has already typed in the reply box.
  function refreshSelected() {
    if (!st.selected || !st.selected.conversation) return;
    var id = st.selected.conversation.id;
    call('/api/admin/support/conversations/' + id).then(function (r) {
      if (!r.ok || !st.selected || st.selected.conversation.id !== id) return;
      var before = (st.selected.messages || []).length;
      var after = (r.body.messages || []).length;
      if (after === before && r.body.conversation.status === st.selected.conversation.status) return;
      var pane = $('nsInboxThread');
      var draft = pane && pane.querySelector('textarea') ? pane.querySelector('textarea').value : '';
      st.selected = r.body;
      renderThread();
      var box = pane && pane.querySelector('textarea');
      if (box && draft) box.value = draft;
    }).catch(function () {});
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
      // Agents see new customer messages while the inbox is open (the 30s counter
      // tick above is not enough for an active conversation).
      if (st.threadTimer) clearInterval(st.threadTimer);
      st.threadTimer = setInterval(function () {
        var pane = $('adminTabContentSupport');
        if (!pane || pane.classList.contains('hidden')) return;
        loadList();
        refreshSelected();
      }, 6000);
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
