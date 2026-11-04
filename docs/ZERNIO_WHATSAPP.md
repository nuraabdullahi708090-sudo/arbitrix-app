# Zernio WhatsApp automation (en / pt-BR)

Operator runbook for the multilingual WhatsApp automation on top of Zernio.
The integration is **optional**: with no `ZERNIO_API_KEY` the factory returns
`null` and the server behaves exactly as before.

## 1. What existed, and what this adds

There was no Zernio or WhatsApp code in this repository. The customer funnel was
`Meta ad -> WhatsApp/Zernio -> registration -> first deposit -> first trade ->
referral`, with the welcome and the 6h / 1d / 3d touches configured inside
Zernio.

This integration does not create a second funnel. It:

* answers inbound WhatsApp messages in the customer's language,
* decides and stores the customer's language preference on the Zernio contact,
* enrolls the contact in the matching language follow-up sequence, and
* pauses automated promotional messaging when a human takes over.

It does not schedule its own timers; the existing Zernio sequences keep their
timing.

## 2. Files

| File | Purpose |
| --- | --- |
| `services/whatsapp/Languages.js` | Language registry (`en`, `pt-BR`, future `es`), aliases, Meta locale mapping, template suffixes. |
| `services/whatsapp/LanguageResolver.js` | Detection, confidence, ambiguity, explicit-choice parsing, priority order. |
| `services/whatsapp/WhatsAppContent.js` | All copy in English and Brazilian Portuguese, the four official links, intent patterns. |
| `services/whatsapp/WhatsAppTemplates.js` | Template catalogue, Meta payload, provisioning plan, approval gate. |
| `services/whatsapp/ZernioClient.js` | Thin REST client (contacts, custom fields, templates, inbox send, sequences, webhooks). |
| `services/whatsapp/ContactPreferences.js` | Reads/writes the language and automation flags on Zernio contact custom fields. |
| `services/whatsapp/FollowUpRouter.js` | 6h / 1d / 3d due checks and the per-language sequence spec. |
| `services/whatsapp/WhatsAppAutomation.js` | The conversation decisions (opt-out, opt-in, language, handoff, intents, enrollment). |
| `services/whatsapp/ZernioWebhook.js` | HMAC verification, event-id dedupe, status codes, dispatch. |
| `services/whatsapp/index.js` | Composition root and secret-free status description. |
| `scripts/zernio-setup.js` | Inspect / provision fields, templates, sequences and the webhook. |

Wired into `server.js`:

* `POST /api/zernio/webhook` - signed delivery endpoint.
* `GET /api/whatsapp/status` - admin, read-only, no secrets.
* `POST /api/whatsapp/followups/evaluate` - admin, dry run, sends nothing.

The webhook lives at `/api/zernio/webhook`, **not** `/api/webhook/zernio`: the
generic `/api/webhook/:provider` route is registered earlier and would shadow it.

## 3. Language resolver

Priority, highest first:

1. Explicit customer selection (`português`, `Portuguese`, `/language` then `2`, ...).
2. Persisted preference on the contact (`arbitrix_language`).
3. Reliable detection from the message text (confidence >= `WHATSAPP_LANGUAGE_CONFIDENCE_THRESHOLD`, default `0.6`, plus a margin between the best and second language).
4. Known campaign language (`arbitrix_campaign_language` on the contact, or `WHATSAPP_CAMPAIGN_LANGUAGE`).
5. English fallback.

Short or content-free messages (`yes`, `no`, `ok`, `sim`, `👍`, `12345`) are
**never** used to change the language. If detection is ambiguous and no
preference exists, the customer is asked:

```
1 - English
2 - Português (Brasil)
```

A stored preference is never overwritten by a detection. Only an explicit
request changes it.

## 4. Preference persistence

No new database. Preferences use Zernio contact custom fields, created by
`scripts/zernio-setup.js --apply`:

| Slug | Type | Meaning |
| --- | --- | --- |
| `arbitrix_language` | text | `en` or `pt-BR` |
| `arbitrix_language_source` | text | `explicit` / `detected` / `persisted` |
| `arbitrix_language_confirmed` | boolean | true only after an explicit choice |
| `arbitrix_language_prompt_at` | text (ISO) | when the language question was last asked |
| `arbitrix_opt_out` | boolean | promotional opt-out |
| `arbitrix_human_handoff` | boolean | a human owns the thread |
| `arbitrix_registered` | boolean | set by the funnel / CRM |
| `arbitrix_deposited` | boolean | set by the funnel / CRM |
| `arbitrix_welcomed` | boolean | welcome already sent |
| `arbitrix_sequence_language` | text | which sequence the contact is enrolled in |
| `arbitrix_followup_6h` / `_1d` / `_3d` | boolean | step already sent |

`arbitrix_registered` and `arbitrix_deposited` are written by your existing
registration/deposit automation (Zapier, Make, a backend job, or a manual
update); this code reads them and unenrolls the contact when they become true.

## 5. Templates

| Key | English | Brazilian Portuguese |
| --- | --- | --- |
| welcome | `arbitrix_welcome` | `arbitrix_welcome_pt_br` |
| 6h | `arbitrix_followup_6h` | `arbitrix_followup_6h_pt_br` |
| 1d | `arbitrix_followup_1d` | `arbitrix_followup_1d_pt_br` |
| 3d | `arbitrix_followup_3d` | `arbitrix_followup_3d_pt_br` |

* Category: `MARKETING`.
* Meta locale: `en` / `pt_BR`.
* Bodies contain **no variables**, so no `variableMapping` can be wrong. The
  personalised greeting is used only for the free-form reply inside the 24-hour
  window.
* The approval gate refuses anything except `APPROVED`
  (`isSendableTemplate` / `assertSendableTemplate`).
* Provisioning is idempotent: an existing template with the same name and locale
  is never recreated, edited or deleted.

**Status is not knowable until you look.** Run `node scripts/zernio-setup.js`
and read `Templates:`; every entry shows `MISSING`, `PENDING`, `APPROVED` or
`REJECTED`. Nothing in this repository can approve a template.

## 6. Follow-ups and the human handoff

Intervals are unchanged: 6h, 1d, 3d after enrollment (360 / 1080 / 2880
minutes). `evaluateFollowUp` refuses to send when:

* the contact replied after enrollment (`replied`),
* the contact registered or deposited (`registered` / `deposited`),
* the contact opted out (`opted_out`),
* a human owns the thread (`human_handoff`),
* the step was already sent (`already_sent`).

A human request, a human reply from the inbox (`sentVia: "human"`), or another
app taking the conversation (`conversation.control_changed` with
`owner !== "app"`) sets `arbitrix_human_handoff` and unenrolls the sequence.
When control returns to the app the flag clears; the language preference is
**not** touched. The Zernio sequence also has `exitOnReply` and
`exitOnUnsubscribe` enabled.

Sequences are created as **drafts**. `--activate-sequences` activates them only
when every template for that language is `APPROVED`.

## 7. Environment

See `.env.example` (`ZERNIO WHATSAPP AUTOMATION`). Required to run:

```
ZERNIO_API_KEY=...
ZERNIO_PROFILE_ID=...
ZERNIO_WHATSAPP_ACCOUNT_ID=...
ZERNIO_WEBHOOK_SECRET=...
WHATSAPP_AUTOMATION_ENABLED=true
ZERNIO_SEQUENCE_EN=...          # id printed by the setup script
ZERNIO_SEQUENCE_PT_BR=...
BASE_URL=https://arbitrix.pro
```

Optional: `ZERNIO_BASE_URL` (default `https://zernio.com/api`),
`ZERNIO_TIMEOUT_MS`, `WHATSAPP_LANGUAGE_CONFIDENCE_THRESHOLD`,
`WHATSAPP_CAMPAIGN_LANGUAGE`, `WHATSAPP_LANGUAGE_PROMPT_TTL_HOURS`,
`WHATSAPP_SEND_WELCOME`.

`WHATSAPP_SEND_WELCOME=false` is the setting to use while the EXISTING Zernio
automation still sends the immediate welcome. The first inbound message is then
answered (and the language stored) instead of producing a second welcome. Set it
to `true` only when this integration replaces that welcome.

## 8. Deployment procedure

1. Set the environment variables in the host. Do **not** enable the automation
   yet.
2. `node scripts/zernio-setup.js` - read-only. Confirm the WhatsApp account id
   and the current templates.
3. `node scripts/zernio-setup.js --apply` - creates the custom fields, submits
   the templates, creates the sequences as drafts.
4. Wait for Meta. Re-run the inspect command until all templates show
   `APPROVED`. A `REJECTED` template must be edited and resubmitted; this code
   does not do that.
5. `node scripts/zernio-setup.js --apply --activate-sequences` - activates the
   sequences. It refuses while any template for that language is not approved.
6. `node scripts/zernio-setup.js --apply --apply-webhook` - registers
   `https://<BASE_URL>/api/zernio/webhook` with `ZERNIO_WEBHOOK_SECRET`.
7. Copy the sequence ids into `ZERNIO_SEQUENCE_EN` / `ZERNIO_SEQUENCE_PT_BR`,
   set `WHATSAPP_AUTOMATION_ENABLED=true`, restart the service.
8. Confirm with `GET /api/whatsapp/status` (admin token):
   `configured`, `enabled`, `webhookSecretConfigured`, `sequences`, `templates`,
   `stats`.
9. Send one message from a test phone in each language and confirm the reply and
   the contact fields.

## 9. What still needs manual work in Zernio

* **Meta approval** of the templates (this repository can only submit them).
* **Sequence activation** after approval (gated flag above).
* **Webhook registration** (one command, or configure it in the Zernio dashboard).
* **Funnel field updates**: something must set `arbitrix_registered` and
  `arbitrix_deposited`. If nothing does, the follow-ups will still run and the
  contact can reply or opt out, but the funnel will not stop on registration or
  a deposit automatically.
* **Campaign language** on the contact (optional). Without it, an ambiguous first
  message falls back to English until the customer chooses.
* **AI replies**: this integration has no LLM provider of its own. Unknown
  messages receive a localized fallback that points at the official links and
  the human handoff. If Zernio's AI replies are enabled in the dashboard, keep
  them off for these conversations or point them at this webhook, so a customer
  does not receive two different answers.

## 10. Known limitations

* Language detection is lexical (word lists + diacritics + confidence). It is
  deliberately conservative: a mixed message is treated as ambiguous and the
  customer is asked, instead of being switched silently.
* Portuguese and English are the only active languages. Adding Spanish needs a
  content block, a `LANGUAGES` entry and a contact-language value; the resolver,
  templates, sequences and webhook already handle an arbitrary language code.
* The in-process event dedupe is per process. Retries are additionally covered by
  the `Idempotency-Key` header on every reply, which Zernio deduplicates.
* `contact.field_changed` handling is best-effort: if your funnel writes the
  custom field with a different payload shape, nothing breaks, but the contact
  is not unenrolled automatically.
* No message is ever sent by the tests or by `scripts/zernio-setup.js`.

## 11. Tests

```
node --test tests/whatsapp_multilingual.test.js      # 71 tests, no network
node --test tests/whatsapp_webhook_e2e.test.js       # real server + fake Zernio
node --test tests/zernio_setup_script.test.js        # provisioning safety
```
