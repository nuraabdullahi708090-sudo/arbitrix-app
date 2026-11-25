# Rebrand completion audit - Arbitrix -> Kalderix

Date: 2026-11-16
Scope: every customer-facing, operational and integration surface in this repository.
Outcome: 5 surfaces still showed the old brand and were corrected; every remaining
reference is a protected identifier, a legal identity, a historical record or an
external dashboard setting.

Run the audit yourself with:

```
node scripts/verify-rebrand.js --expect Kalderix
node --test tests/rebrand_audit.test.js
```

---

## 1. How the audit was done

Three independent passes, because each catches something the others miss:

1. **Static inventory** - case-insensitive grep for `Arbitrix` across the repository
   (169 files), bucketed by directory, then read line by line.
2. **Rendered-page scan** - Chromium loads every public page and every customer
   modal (dashboard, support, deposit, profile, subscription, verification,
   withdrawal) and lists the VISIBLE text that still says Arbitrix. This catches
   strings assembled at runtime that a grep reports as `{{brand}}`.
3. **Release gate** - `scripts/verify-rebrand.js` re-runs the context-aware detector
   over the pages AND the server-side copy.

Result of pass 2 after the fixes: **9 visible mentions, 0 unexplained**. All nine are
the legal entity ("Arbitrix Trading"), a Telegram handle, or `arbitrix.pro`.

---

## 2. Found and fixed (the five real defects)

| # | Location | Was | Now | Why it mattered |
|---|---|---|---|---|
| 1 | `services/MarketingContent.js` (8 strings, EN + PT) | `1. EXPLORE ARBITRIX`, `HOW TO DESCRIBE ARBITRIX ACCURATELY`, `STAYING SAFE WITH ARBITRIX`, `CONHECA A ARBITRIX`, `COMO DESCREVER A ARBITRIX...`, `SEGURANCA NA ARBITRIX` | `... KALDERIX` | These are the partner-group and announcement posts. The group was being told to explore a product name that no longer exists. |
| 2 | `scripts/tutorial/scenes.json`, `build.js`, `record.js` | "your Arbitrix dashboard", "Arbitrix creates/watch the blockchain", "the Arbitrix support team", closing card "How to fund your Arbitrix Live balance", on-screen chip `ARBITRIX` | Kalderix (and the narration now says "through the official support bot on Telegram" instead of spelling a handle that may change) | The generator burns this text into the video. The chip is literally rendered on screen for the whole recording. |
| 3 | `server.js` - three transactional email templates | pre-rename palette: `#ffd700` gold wordmark/code/button, `#0d1117` black header and code chip | `#5EA0FF` azure wordmark, `#101A26`/`#1B2A3A` slate header, `#8CBBFF -> #3F7BE0` button | Every OTP, password reset and email-change message still looked like the OLD brand. Name was right, identity was not. |
| 4 | `server.js` - email subjects, titles, wordmarks | literal `'Password Reset Request - Kalderix'` etc. | `'Password Reset Request - ' + BRAND.name`, `<title>... ${BRAND.name}</title>` | A future rename would have left eight hidden stale strings. Now there is one source. |
| 5 | `public/index.html`, `public/business-registration.html`, `.env.example`, `docs/telegram-referral-onboarding.md` | stale comments `ARBITRIX PRO SUBSCRIPTION`; download filename `arbitrix-kvk-business-registration.jpg`; profile placeholder `trader@arbitrix.ai`; the pinned onboarding message (9 sentences) | `KALDERIX ...`, `kalderix-kvk-business-registration.jpg`, `you@example.com`, Kalderix prose | A fake mailbox on the old domain, a filename the customer sees when saving their certificate, and an operator-facing doc that would re-post the old brand. |

### Detection gap that let this happen

`scripts/lib/rebrand-lint.js` searched case-SENSITIVELY for `Arbitrix`, so
`EXPLORE ARBITRIX` was invisible to it. The gate also scanned only `public/*.html`.
Both are fixed:

- `ARBITRIX` is now an alias.
- `scripts/verify-rebrand.js` scans two tiers: **PAGES** (shipped HTML) and **COPY**
  (support-bot replies, marketing posts, knowledge base, tutorial generators).
- New allow-rules cover the protected forms the wider scan now encounters:
  quoted bot handle, `ARBITRIX_...` configuration names, camelCase integration fields.
- New gate section **7. Transactional email** fails the build if a legacy gold/black
  value or a literal email subject returns.

---

## 3. Classification of every remaining reference

**A - Customer-facing branding, changed** (see section 2).

**B - External configuration required** (cannot be done in code):

| Surface | Where it is set | Action |
|---|---|---|
| Telegram bot display name / About / photo | BotFather | See section 5 |
| Telegram group name, description, photo | Group settings | See section 5 |
| Telegram channel name, description, photo | Channel settings | See section 5 |
| Payhip product names and store description | Payhip dashboard | See section 6 |
| Q8Pay merchant display name | Q8Pay dashboard | See section 6 |
| Resend/SMTP sender name | `EMAIL_FROM` env (currently derived from BRAND) | Optional override only |

**C - Legal identity, preserved**

- `services/brand.js` `legalName: 'Arbitrix Trading'`, `kvk: '72923513'`.
- `public/business-registration.html`, `privacy-policy.html`, `terms-of-service.html`:
  "Kalderix is operated by Arbitrix Trading".
- `services/support/arbitrix-knowledge.json` business_registration answer.
- `@Arbitrix_CSA1` / `@AlexArbitrix` / `@OliviaArbitrix`: staff and partner handles.
  A product rename does not rename a person or an existing chat identity.

**D - Historical data, preserved**

- Applied migrations (`supabase/migrations/*`), including `011` and `051`, plus
  `AGENTS.md`, `docs/`, and every historical test pin that names the old brand.
- Existing `transactions.detail` rows. `051_rebrand_subscription_detail.sql` changed
  the label written by `charge_subscription_safe` going FORWARD; past statements keep
  the text they were written with, and the UI maps both eras to a localized label.
- Referral rows, ledger entries, KYC records, email history: untouched.

**E - Compatibility identifiers, preserved**

| Identifier | Location | Why it stays |
|---|---|---|
| `arbitrix.pro` | `BRAND.domain`, canonical, OG, CORS, webhooks | The live domain. Changing it needs DNS + re-verification (section 7). |
| `arbitrix.ai` | `BRAND.mailDomain`, `noreply@` | SPF/DKIM are verified for this domain. Swapping it sends password resets to spam. |
| `@ArbitrixSupportBot`, `t.me/ArbitrixAnnouncements/*` | 4 places | A Telegram username cannot be renamed without breaking every link a customer already has. |
| `admin@arbitrix.ai` | server seed | An existing credential. |
| `jwt_token`, `arbi_*` localStorage keys | frontend | Renaming logs every user out. |
| `arbitrix:mode-changed` custom event | frontend | Internal contract between listeners. |
| `arbitrix-shell-v1` | `public/sw.js` | Service-worker cache key. |
| `arbitrix-support-telegram`, `ARBITRIX_*_TELEGRAM_URL` | meta tags + window hooks | Operators may already have set them; they are documented override points. |
| `arbitrixUserId` / `arbitrixDepositRef` / `arbitrixInvoiceId` | `services/providers/q8qpay.js` | Provider payload field names. Changing them breaks reconciliation of past invoices. |
| `arbitrix-knowledge.json`, `what_is_arbitrix` entry ids | support KB | File path and retrieval keys referenced by code and tests. |
| `arbitrix-app` | `package.json` | npm package name. |
| `arbitrix-*.mp4`, `arbitrix-*-poster.jpg` | `public/video/` | Published URLs already shared with customers. |

**F - Internal-only, evaluated**

- Code comments naming the bot or the legal entity (`server.js`, `TelegramSupportService.js`).
  Left as-is: they document the real handle and cost nothing to keep accurate.
- `AGENTS.md` and `docs/*` engineering logs. Left as history.
- Test fixtures that assert the deny-list behaves (`tests/brand_token.test.js` etc.).

**G - Financial or security-sensitive, untouched**

- `services/brand.js` identity data only: no price, cap or threshold.
- No migration was added. No wallet, ledger, trading, deposit, withdrawal, KYC,
  referral or subscription logic was edited. Verified by test:
  `PLATFORM_MIN_DEPOSIT_USD = 100`, `MIN_WITHDRAWAL_USD = 700`, promo cap `20`,
  referral `20%`, profit pause, and the money-moving routes are all unchanged.

---

## 4. Assets

| Asset | Status |
|---|---|
| `public/brand/kalderix-mark.svg`, `kalderix-favicon.svg`, `kalderix-wordmark.svg` | Current (drawn symbol, blue). |
| `public/brand/kalderix-social.svg` | Current azure social card; not regenerated here. |
| `public/video/arbitrix-how-it-works-product-demo-en.mp4` | Filename is an identifier, but the CONTENT was produced for the old brand. Regenerate when convenient. |
| `public/video/arbitrix-partner-payout-demo.mp4` | Screen recording; brand neutral apart from UI chrome, which is already Kalderix. |
| `build/video/deposit-tutorial/*` (untracked) | Never published. The generator now says Kalderix, so a rebuild is clean. |
| `public/certificates/kvk-business-registration-page-1.jpg` | Legal document. Never retouched or renamed. |

No new logo was invented and no asset was redesigned in this pass.

---

## 5. Telegram changes required (external, no code)

The bot username stays `@ArbitrixSupportBot`. Its DISPLAY identity should follow:

1. **Bot display name** - BotFather -> `/setname` -> `Kalderix Telegram Assistant` (the in-app messenger is `Kalderix Support`; the username, token and webhook are unchanged).
   Users see the name; the `@username` link keeps working.
2. **About text** - BotFather -> `/setabouttext`:
   `Official Kalderix support. We reply here and never ask for your password, codes or keys.`
3. **Description** - BotFather -> `/setdescription`
   (shown before the first message): one sentence on what Kalderix is plus a link to
   `https://arbitrix.pro`.
4. **Profile photo** - BotFather -> `/setuserpic` -> the Kalderix symbol on slate
   (`public/brand/kalderix-favicon.svg` rendered to 512x512 PNG).
5. **Partner group** - rename the title to `Kalderix Partners Community`, update the
   description and photo; the invite link does not change.
6. **Announcement channel** - rename to `Kalderix Announcements`, update the photo.
   Tutorial deep links (`t.me/ArbitrixAnnouncements/16-19`) keep working because the
   channel username is unchanged.
7. **Pinned message** - replace it with the copy in
   `docs/telegram-referral-onboarding.md` (now Kalderix).

Telegram does not allow a bot username change that preserves history, which is why
the handle is a protected identifier rather than a branding asset.

---

## 6. Email and payment-provider changes required (external)

**Email** - code side is complete: the sender display name is `BRAND.name`
(`services/brand.js`), the subjects/titles/wordmarks derive from `BRAND.name`, and the
templates use the azure/slate palette. Remaining external work:

- The FROM address stays `noreply@arbitrix.ai` until a Kalderix domain exists and
  SPF/DKIM are verified there. Only then change `BRAND.mailDomain` (one line) and the
  `EMAIL_FROM` env if it is set.
- Optional: set `EMAIL_FROM=Kalderix <noreply@arbitrix.ai>` explicitly so the header
  does not depend on the code default.

**Payments** - nothing in the code is customer-branded wrongly any more: the Q8Pay
invoice title already follows `BRAND`. External work:

- Q8Pay dashboard: merchant/store display name -> Kalderix.
- Payhip dashboard: product names and store name -> Kalderix (the checkout page is
  served by Payhip, not by us).
- Keep the webhook URLs unchanged; they contain the domain, not the brand.

---

## 7. Domain migration checklist (for when a Kalderix domain is purchased)

Nothing in this audit changed a domain. When the new domain exists:

1. Add the domain to the host and issue TLS; keep `arbitrix.pro` serving.
2. `BRAND.domain` (one line) - drives canonical links and metadata.
3. Search for the literal `arbitrix.pro` and update: canonical + OG URLs on
   `partners.html` and `deposit-tutorials.html`, `ALLOWED_ORIGINS`, `BASE_URL`,
   `Q8QPAY_CALLBACK_URL`, `PAYHIP_RETURN_URL`, `TELEGRAM_DEPOSIT_TUTORIAL_URL`,
   `TELEGRAM_MARKETING_*_URL`, the guest links inside `telegram-i18n.js` and
   `ConversationEngine.js`, and `DEPOSIT_TUTORIALS` / `HOW_IT_WORKS` constants.
4. Re-register provider webhooks (Q8Pay, Payhip) against the new host.
5. Re-verify transactional mail on the new mail domain before changing
   `BRAND.mailDomain`; then update SPF, DKIM and DMARC.
6. Keep 301 redirects from every old path; update the search-engine property and OG
   image URLs; resubmit the sitemap.
7. Keep `@ArbitrixSupportBot` and the announcement channel: Telegram usernames cannot
   be migrated, and existing customer links must keep resolving.
8. Update `docs/` and `.env.example` examples; leave `AGENTS.md` as history.
9. Verify after cutover: the rendered-page scan (section 1, pass 2) must still return
   0 unexplained mentions.

---

## 8. Unresolved / for a human decision

1. **Video content** - the two published MP4s were produced before the rename. Their
   filenames are identifiers; their content is brand-neutral apart from already-updated
   UI chrome, but a future re-record is the clean fix.
2. **`@AlexArbitrix` / `@OliviaArbitrix` / `@Arbitrix_CSA1`** - real people and a
   support account. Renaming a Telegram handle is a business decision with a
   link-breakage cost; left untouched.
3. **Social share card** - `public/brand/kalderix-social.svg` should be visually
   confirmed as the azure version before the next paid campaign.
4. **q8qpay payload field names** (`arbitrixUserId`, ...) - they are reconciliation
   identifiers. A future provider migration is the natural moment to rename them.
5. **`package.json` name `arbitrix-app`** - never displayed; leave it.
