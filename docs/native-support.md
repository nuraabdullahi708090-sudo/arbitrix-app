# Native in-app customer support

Customers reach AI assistance and human agents inside Arbitrix, without Telegram.
The Telegram bot keeps working exactly as before: this is a **second transport over
the same support brain**, not a second brain.

## 1. Reuse assessment

| Capability | Reused from | Notes |
|---|---|---|
| Dialogue planning (greetings, how-to, tutorials, hand-off) | `services/support/ConversationEngine.js` | `planTurn()` / `planCommand()` are pure; the native service calls `planTurn` with the stored `context` |
| Grounded answers + guardrails (no invented amounts/statuses) | `services/support/SupportAIService.js` | created once in `server.js` and shared by the Telegram bot and the messenger |
| Approved knowledge | `services/support/SupportKnowledge.js` + `arbitrix-knowledge.json` | untouched |
| Localized customer copy | `services/telegram-i18n.js` (en/pt/ar) | engine lines render through `i18n.t(lang, key)` |
| Event notifications | `services/Notifications.js` (migration 058) | two new events: `supportReply` (customer) and `supportMessage` (admins) |
| Auth / admin gating | `authMiddleware` / `adminMiddleware` | unchanged |
| UI shell, palette, i18n plumbing | `public/index.html` | widget labels live in `NS_TRANSLATIONS` merged into `TRANSLATIONS` |

Nothing from the Telegram project was copied: the bot's transport (webhook →
`sendMessage` + polling of `getUpdates`) is replaced by HTTP + 5s polling.

## 2. Database (migration `059_native_support.sql`)

* `support_conversations` — one ACTIVE thread per customer
  (`UNIQUE (user_id) WHERE status <> 'resolved'`), `status`
  (`open|assigned|waiting|resolved`), `category`, `language`, `ai_paused`,
  `assigned_admin_id`, engine `context` (JSONB, ids/flags only), preview,
  `unread_for_customer`, `unread_for_admin`.
* `support_messages` — `sender_type` (`customer|ai|agent|system`), body (1..4000),
  `client_message_id` with `UNIQUE (conversation_id, client_message_id)` for
  idempotent sends.
* `support_actions` — append-only audit (`takeover|resume|assign|resolve|reopen|initiate|escalate|message`).
* RLS **enabled** on all three with a single `service_role` policy; `REVOKE` from
  `PUBLIC/anon/authenticated` and sequence grants for `service_role`. A self-check
  `DO` block raises (and rolls back) if anything is missing.
* **No financial table is read or written by the migration.**

## 3. API

Customer (all `authMiddleware`; the user id is always `req.user.id`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/support/conversations` | own threads + unread counters |
| POST | `/api/support/conversations` | create/return the active thread (`category`, `language`) |
| GET | `/api/support/conversations/:id/messages?after=` | history / incremental poll |
| POST | `/api/support/conversations/:id/messages` | send (`body`, `clientMessageId`) → persists + AI reply |
| POST | `/api/support/conversations/:id/human` | request a human (pauses the AI) |
| POST | `/api/support/conversations/:id/read` | clear the customer unread counter |

Admin (`authMiddleware` + `adminMiddleware`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/support/counts` | open / assigned / waiting / unassigned / unread |
| GET | `/api/admin/support/conversations?status=&search=` | inbox list (customer name/email joined) |
| GET | `/api/admin/support/conversations/:id` | thread + audit (marks the admin counter read) |
| POST | `/api/admin/support/conversations/:id/messages` | agent reply |
| POST | `/api/admin/support/conversations/:id/takeover` `…/resume` `…/assign` `…/resolve` | human control |
| POST | `/api/admin/support/conversations` | **initiate** a conversation (`userId` or `email`) |
| GET | `/api/admin/support/customers?search=` | customer lookup for the composer |
| GET | `/api/admin/support/customers/:id/context` | read-only context: account, created date, last 5 deposits/withdrawals/trades, referral summary |

Every route is behind a flag guard: while `NATIVE_SUPPORT_ENABLED` is not `true`
they answer **404** (the surface does not exist for production customers).

## 4. Behaviour

* **AI-first.** A customer message is stored, then answered by the same brain:
  `ConversationEngine` for procedural dialogue, `SupportAIService` for factual
  questions (grounded, guard-railed). Any failure degrades to a localized
  "a support agent will reply here shortly" **and** a human hand-off — never to an
  invented status.
* **Human takeover.** `takeover` sets `ai_paused = TRUE`; while it is set no AI
  reply is produced (verified by test 5). `resume` clears it; `resolve` closes the
  thread (the next message reopens a new one).
* **No simultaneous answers (concurrency-safe).** The customer write and the AI
  turn are committed by two `SECURITY DEFINER` functions that take the
  conversation row lock (`SELECT ... FOR UPDATE`) BEFORE validating:
  `support_post_customer_message` (locked, idempotent send) and
  `support_commit_ai_turn` (locked commit). The race is therefore serialised in
  both directions - if a takeover/resolve commits while the model is generating,
  the AI turn re-reads under the lock, returns `{committed:false}` and writes
  **nothing** (no message, no context, no counters); if the AI turn commits
  first, the takeover's UPDATE waits and stays effective. Context is written by
  the same locked statement as the message, so two turns cannot interleave into
  a half-merged state. Before migration 059 is applied the service degrades to a
  conditional-update claim (`WHERE ai_paused = false AND status <> 'resolved'`),
  which still cannot undo a takeover; only the atomicity is lost.
* **Idempotency.** `client_message_id` (unique per conversation) makes a retried
  send return the original row (`duplicate: true`).
* **Unread counters** move on each side; the customer widget clears its own on
  read, the admin inbox clears the other when a thread is opened.
* **Notifications.** `supportReply` → customer feed; `supportMessage` → admin feed
  (deduped by message id per recipient). The bell itself is the 058 feed.
* **Rate limiting.** 20 messages/minute per user, 5 new conversations/hour
  (in-process sliding window).
* **Reconnection.** The widget polls every 5s while open; a failed poll is silently
  retried; a failed send is marked "Not sent" and the customer can resend.

## 5. Security

* Customer routes derive the account from the JWT only; no route accepts a
  `userId` from the body/query (pinned by test 15).
* Admin routes require `adminMiddleware`; the acting agent is `req.user.id`.
* RLS + service_role-only grants: a leaked anon key cannot read a transcript.
* Bodies are length-validated (1..2000 chars, 4000 in the DB), control characters
  stripped, and rendered with `textContent` (no HTML injection).
* The customer-context endpoint is admin-only, read-only, capped and returns no
  credentials, no card data and no full address history.
* The AI can never move money: the messenger service has no wallet/ledger access
  (pinned by test 23).

## 6. Rollout

1. Apply `supabase/migrations/059_native_support.sql` (idempotent; self-checking).
2. Set `NATIVE_SUPPORT_ENABLED=true` on the web service and restart.
3. Confirm `GET /api/auth/me` returns `nativeSupport: true`; the launcher appears
   for customers, and the Support tab appears in the admin dashboard.
4. Rollback: unset the flag (routes 404 immediately, no deploy needed). The tables
   can stay; `DROP TABLE support_actions, support_messages, support_conversations`
   removes everything (no money data).

## 6b. Launcher placement (verified in a browser)

* The launcher sits `bottom:160px`, above the toast band (toasts are fixed at
  `bottom:20px` and can wrap to several lines) and above the legacy assistant FAB.
* While the cookie-consent banner is present (`z-index 99999`, 118px tall) it is
  lifted to `bottom:250px` - the same treatment the legacy support widget already
  had - so the consent dialog can never swallow the tap.
* `body.ns-enabled` hides the legacy floating assistant launcher while the
  messenger is on: one support affordance at a time. The Support Center (sidebar
  entry + profile link) is untouched.
* The unread badge is refreshed on every `sync()` and whenever the panel closes
  (5s throttle), so a reply that arrived while the messenger was closed is
  visible on the launcher.

## 7. Known limitations

* Delivery is **polling** (5s), not a websocket/SSE stream — chosen deliberately:
  the app has no streaming infrastructure and this survives proxies, mobile
  backgrounding and Render restarts without extra state.
* Rate limits and the unread counters are per-process; the app runs a single web
  instance. A multi-instance deployment would need a shared limiter.
* The unread counters are read-modify-write on the conversation row; two
  simultaneous sends could undercount by one. Message delivery is unaffected.
* Admin notification fan-out is capped at 10 administrator accounts.
* The composed reply uses the engine's en/pt/ar copy; es/fr/zh fall back to English
  engine lines (the AI layer already answers in the customer's language when a
  provider is configured).
* The widget is hidden for `MARKETING_SANDBOX` accounts (`nativeSupport: false`).
