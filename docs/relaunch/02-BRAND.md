# Workstream A - Brand replacement

Date: 2026-11-16
Status: **research complete, implementation NOT started (no name approved).**

---

## 0. Read this before renaming anything

Renaming is the cheapest workstream and the least valuable one. It changes what
the product is *called* without changing what it *does*. Given the finding in
`01-BASELINE.md` (the "arbitrage engine" is a positively biased random number
generator with withdrawal enabled), a rebrand executed first would do three
unhelpful things:

1. It would carry the same unsubstantiated claim under a name with no history.
2. It would discard whatever recognition `arbitrix.pro` has accumulated.
3. It would look, to a payment provider or a regulator reviewing the timeline,
   like an attempt to leave a previous operating model behind.

**Recommendation: fix the product claim first, then rebrand.** The name research
below is ready so the decision is not on the critical path.

A second constraint: a new trade name does **not** change the legal operator.
`Arbitrix Trading` (KVK 72923513, Assen) remains the contracting party. Any new
name must be presented as a trading name of that entity, and the KVK number must
stay visible wherever the old name's registration was (currently
`/business-registration`).

---

## 1. Twenty invented candidates

All are constructed words (no dictionary meaning in any launch language) chosen
for: 3 syllables or fewer, an unambiguous spelling after hearing it once, no
offensive reading in English/Spanish/Portuguese/French/Arabic/Chinese, and a
neutral register (nothing implying a licence, a guarantee, or a government body).

| # | Name | Rationale | Notes |
|---|---|---|---|
| 1 | **Kalderix** | hard consonants + "-ix" tech suffix | short, memorable, no meaning |
| 2 | **Vantallis** | "vantage" + "talis" | softer, premium |
| 3 | **Aequoris** | Latin *aequor* (level surface) | evokes parity/equilibrium |
| 4 | Nymborix | nimbus + "-rix" | distinctive, slightly game-like |
| 5 | Vindaril | Nordic-tinged | harder to spell |
| 6 | Novarion | nova + arion | generic, crowded field |
| 7 | Veltorna | velt + orna | quiet, corporate |
| 8 | Galdrix | short, punchy | sounds tabletop-game |
| 9 | Corvanor | corvus + -or | dark, financial |
| 10 | Quantavel | quantum + travel | implies quant (claim risk) |
| 11 | Astranov | astra + nov | spacey |
| 12 | Noventra | nova + entra | crowded |
| 13 | Zentaris | zenith + -aris | many lookalikes |
| 14 | Lumentrax | lumen + trax | "-trax" is heavily used |
| 15 | Sorvantis | observar + antis | pleasant, long |
| 16 | Traveon | travel + eon | generic |
| 17 | Mercavis | mercatus + avis | implies "market" |
| 18 | Terravix | terra + -ix | earthy, generic |
| 19 | Calyptra | botanical (a moss genus) | real word, collision risk |
| 20 | Opulento | "opulent" | implies wealth - bad fit |

Names deliberately **rejected** and why: anything containing *Arbi-* (keeps the
old association), anything with *Quant-/Algo-/Yield-/Earn-* (implies a
performance or investment claim we cannot substantiate), anything with *Bank-,
Capital-, Trust-, Exchange-* (implies regulated activity), and any Latin word
that means "money", "profit" or "interest".

## 2. Availability evidence (measured today, and its limits)

I checked DNS resolution for the `.com`, `.io` and `.app` of the strongest
candidates. **A missing A record does not prove a domain is unregistered** - a
registered-but-unpointed domain looks identical. So treat this as a signal that
narrows the field, not as availability.

| Name | `.com` | `.io` | `.app` | Reading |
|---|---|---|---|---|
| **Kalderix** | no A record | no A record | no A record | strongest candidate |
| **Vantallis** | no A record | no A record | no A record | strong |
| **Aequoris** | no A record | no A record | no A record | strong, spelling risk |
| Nymborix | no A record | no A record | no A record | weak brand register |
| Vindaril | no A record | no A record | no A record | spelling risk |
| Novarion | no A record | - | - | crowded |
| Veltorna | no A record | - | - | low distinctiveness |
| Galdrix | no A record | - | - | game association |

In contrast, these resolved (i.e. are in use by someone):
Veltraxis, Corvanor, Quantavel, Astranov, Noventra, Zentaris, Avorent,
Lumentrax, Veridion, Calyptra, Sorvantis, Traveon, Opulento, Mercavis, Terravix,
Aurientis, Kavantis, Sylvetra, Quantaris, Ardenvia, Celestro, Meridianx,
Praxivo, Solvaris, Tendaris, Ulmora, Vesperion, Corvalis, Delmara, Elvantis,
Farrowen, Halvora.

**What is still NOT verified and must be before any purchase:** registrar
availability and price, trademark registers (EUIPO, Benelux BOIP, USPTO, WIPO
Madrid), company-name registers (KVK), social handles, and a paid similarity
search for phonetic collisions. Assessing trademark risk needs a lawyer; I will
not claim a name is "legally available".

## 3. Recommendation

**Primary: Kalderix** (`kalderix.com`)

- Three syllables, unambiguous spelling, no meaning in any launch language.
- No investment/performance implication, so it does not add a claim of its own.
- No A record on `.com`/`.io`/`.app` - the only candidate that scored clean on
  all three.
- Works as a trading name: "Kalderix, a trading name of Arbitrix Trading
  (KVK 72923513)".

**Alternative 1: Vantallis** - softer and more premium; suits a higher-ticket
positioning better than Kalderix if the package prices rise.

**Alternative 2: Aequoris** - the most conceptually apt (parity/equilibrium),
but "Aequo-" is hard to type from hearing, which costs direct traffic.

## 4. Rebrand inventory (exact, measured)

`Arbitrix` appears **1741 times** across the repository, excluding
`node_modules`. This is the actual scope of a rename:

| Surface | Occurrences | Notes |
|---|---|---|
| `public/index.html` | 479 | 6 locale dictionaries + markup + JS strings |
| `AGENTS.md` | 151 | internal documentation - can keep the historical name |
| `services/telegram-i18n.js` | 100 | 3 locales (en/pt/ar) |
| `public/partners.html` | 84 | has its own 84-key dictionary |
| `public/deposit-tutorials.html` | 79 | standalone page |
| `services/MarketingContent.js` | 60 | Telegram copy |
| `server.js` | 46 | emails, seeded admin, comments, log lines |
| `services/support/ConversationEngine.js` | 39 | support dialogue |
| `services/support/arbitrix-knowledge.json` | 33 | knowledge base (also the filename) |
| tests (~40 files) | ~400 | contract tests assert brand strings |

Ordered work list, cheapest-first:

1. **Identity assets** - logo, favicon (currently inline SVG data URI), OG image,
   `manifest.json` name/short_name, `<title>` and meta descriptions on
   `index.html`, `partners.html`, `deposit-tutorials.html`,
   `business-registration.html`, `reset-password.html`, `how-it-works.html`.
2. **Customer-facing copy** - the 6 dictionaries in `index.html` (479), the
   `partners.html` dictionary (84), `deposit-tutorials.html` (79). Brand tokens
   are concentrated in `landing.*`, `auth.brand.*`, `footer.*`, `support.*`.
3. **Support surfaces** - `telegram-i18n.js` (100), `ConversationEngine.js` (39),
   `arbitrix-knowledge.json` (33, plus rename the file and its 3 import sites).
4. **Marketing copy** - `MarketingContent.js` (60).
5. **Emails / server strings** - `server.js` (46): `EMAIL_FROM`, the seeded
   admin address, forgot-password template, notification copy.
6. **Domain + DNS** - **approval gate**. Do not touch.
7. **Legal** - "trading name of Arbitrix Trading (KVK 72923513)" on
   `/business-registration`, plus the privacy/terms pages, plus the disclaimer
   that the registration is a company registration and not a financial licence.
8. **Video** - `public/video/*` have burned-in branding; re-recording is a
   separate cost. Practical approach: keep the recordings, re-title them in the
   surrounding page copy, and schedule re-shoots.
9. **Tests** - ~400 assertions. Expect a deliberate, mechanical sweep; the
   suites are contract tests, so they will fail loudly until updated, which is
   the desired behaviour.

**Do NOT do in the same change:** the domain, the legal entity, the KVK number,
or the registered address. Those are approval-gated and, per the brief, do not
automatically follow from a name change.

## 5. Decision needed from the founder

- Approve one of: **Kalderix** (recommended), Vantallis, Aequoris, or supply a
  different name.
- Confirm whether the rename ships **after** the product-claim fix (recommended)
  or before.
- Confirm the trading-name wording for the registration page.
