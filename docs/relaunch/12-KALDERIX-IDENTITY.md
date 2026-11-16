# 12 - KALDERIX IDENTITY

Prepared for approval. **Nothing in this document is applied.** The shipped build
still presents the current name; the candidate is recorded as data in
`services/brand.js` and can be switched on in one command.

---

## 1. What is prepared

| Piece | Where | State |
|---|---|---|
| Name, monogram, tagline, app name, accent | `services/brand.js` + the mirror in `public/index.html` | recorded, not applied |
| Palette and typography (with rationale) | `BRAND.candidateIdentity` | recorded, not applied |
| Logo / favicon / wordmark / social card | `public/brand/kalderix-*.svg` | generated, referenced by nothing |
| Stylesheet override | `public/index.html` (`html[data-brand="kalderix"]`) | inert until the attribute is set |
| Static-literal rewrite | `scripts/rebrand.js` | dry run verified, 860 tokens across 29 files |
| Accent rewrite | `scripts/retheme.js` | dry run verified, 183 literals across 9 files |
| Test-fixture rewrite | `scripts/rebrand-tests.js` | dry run verified, 170 literals in 48 files |
| One-command approval | `scripts/relaunch-brand.js` | chains all three, then verifies |
| Database-written detail string | `supabase/migrations/051_...sql` | written, **unapplied** |
| Historical/era-safe display | `TX_DETAIL_LABELS` prefix mapping | shipped (display only) |

The whole rebrand was rehearsed on a clean copy of the repository:
`node scripts/relaunch-brand.js --to kalderix --with-tests --write` followed by
`npm test` gave **3259 passing, 0 failing**. That is the evidence that approval
is a mechanical step rather than a project.

---

## 2. The palette

| Token | Value | Why |
|---|---|---|
| accent | `#7C5CFF` | Violet reads as technology rather than as a currency logo, which is what the current gold does. It stays legible as the 3px active-item indicator on the dark surface. |
| accent hover | `#9B85FF` | Lighter, not brighter: hover states on dark surfaces lose contrast if you raise saturation. |
| accent pressed | `#6344E8` | One step down from the base so a press is visible without a shadow. |
| secondary | `#2ED3B7` | A cool teal for "opportunity" and "verified" states - a signal that cannot be confused with the green/red profit colours. |
| surfaces | `#070B14` / `#0C1220` | **Unchanged on purpose.** Every contrast ratio and chart colour in the product was tuned against them. |
| text | `#E8EDF7` / `#8896B5` | Unchanged. |

The semantic green (`#10B981`) and red (`#EF4444`) are **not** part of the
identity and were not touched. A retheme must never change what a number means.

Type: the display stack stays system-first (`system-ui, 'Inter', ...`) so nothing
is downloaded before first paint; numerics may use a monospace stack where the
dashboard aligns figures. **No size changes** - the current scale is tuned for the
dashboard's density, and shrinking or growing type during a rebrand is how
readable tables become unreadable ones.

### What the override covers, and what the script sweeps

The accent is a token (`--brand`, `--brand-rgb`, `--gold*`) wherever it matters,
so most surfaces follow the attribute alone. About 120 declarations predate the
token system and are literal hex or URL-encoded hex inside data-URI images;
`scripts/retheme.js` rewrites exactly those and prints the count per file. The two
inline-style substring rules in the override catch the hand-written
`color:#F0B90B` attributes that a token cannot reach.

---

## 3. Reviewing it

- `public/brand/kalderix-mark.svg` - app icon and sign-in mark.
- `public/brand/kalderix-favicon.svg` - 16px legibility check.
- `public/brand/kalderix-wordmark.svg` - horizontal lockup.
- `public/brand/kalderix-social.svg` - link preview (1200x630).
- `docs/relaunch/assets/kalderix-auth-preview.png` - the rebranded sign-in screen.
- `docs/relaunch/assets/kalderix-partners-preview.png` - the rebranded partner page.

Both screenshots come from the rehearsed build, not from a mock-up: the same
files, with the identity applied.

---

## 4. The approval command

```bash
# 1. rehearse (writes nothing)
node scripts/relaunch-brand.js --to kalderix --with-tests

# 2. apply
node scripts/relaunch-brand.js --to kalderix --with-tests --write

# 3. prove it
npm test                      # expect 0 failures
git diff --stat               # review which expectations moved
```

What step 2 does, in order: static literals -> accent literals -> the BRAND
constants in both mirrors -> the test fixtures -> a verification pass that reports
any old-name reference the guards deliberately protected, with a reason.

The command refuses a name that is not the recorded candidate. Approving a
different name means editing `BRAND.candidateIdentity` first, which is deliberate:
it forces the palette and rationale to be reconsidered rather than invented.

---

## 5. What a rename cannot do

These are **identifiers**, not branding. They are protected by the guards and must
change only through their own, separately approved process:

| Identifier | Why it must not follow the name |
|---|---|
| `arbitrix.pro` | Existing links, e-mail, search ranking, and every customer bookmark. A domain change is a migration with a redirect plan. |
| `arbitrix.ai` | Carries the verified SPF/DKIM records. Changing it before the records exist sends password resets to spam. |
| `@ArbitrixSupportBot`, `@Arbitrix_CSA1`, `@ArbitrixAnnouncements`, `@AlexArbitrix`, `@OliviaArbitrix` | Customers and partners already have these conversations open; a handle cannot be renamed without losing history and trust. |
| `Arbitrix Trading`, KVK 72923513 | The legal operator. The new name is a **trading name** of that entity. Registering a new entity is a legal act, not a deploy. |
| `admin@arbitrix.ai` | A credential. |
| localStorage keys (`jwt_token`, `arbi_*`), DB tables/columns/enums | Renaming logs every customer out or breaks isolation. |

The consequence to state plainly in customer-facing terms: after approval the
product is called Kalderix and the operator is still Arbitrix Trading. That is a
normal trading-name arrangement, and the legal pages keep saying so.

---

## 6. Two residues that had to be handled deliberately

**Applied migrations keep the old name.** A migration is a record of what ran; it
is not rewritten. The one *customer-visible* string that lives in a database
function is the subscription transaction detail (`'Arbitrix Pro Subscription'`,
written by `charge_subscription_safe` in migration 011).

- Migration `051` re-creates that function with **exactly one literal changed**.
  A test diffs it line-by-line against 011 and fails if any other line differs, if
  a guard disappears, or if an ACL statement is added.
- Historical rows keep the text they were written with - a rename is not a reason
  to rewrite a customer's past statements - and the frontend maps **both eras** to
  one localized label, so no history shows the old name.

**The knowledge base and the operator runbook do not follow the name.** The
support bot's approved answers are rewritten (they are customer-facing), but
`docs/` records the messages as they were approved and is left alone.

---

## 7. Before you approve

1. **Decide the name.** Kalderix is recorded as the candidate, not as cleared.
   Nothing here claims a trademark search or domain availability - see
   `02-BRAND.md` for the naming evidence and the outstanding checks.
2. **Decide the legal presentation.** Keep "operated by Arbitrix Trading (KVK
   72923513)" if the entity is not changing. If it is, that is a separate project.
3. **Do not change the domain in the same step.** The rebrand is reversible with a
   `git revert`; a domain change is not.
4. **Apply migration 051 only with the rename**, not before: it would make new
   transactions say Kalderix while the UI says the old name.

Rollback: `git revert` the rename commit. Domain, handles, mail and legal identity
are untouched, so nothing external has to be undone.
