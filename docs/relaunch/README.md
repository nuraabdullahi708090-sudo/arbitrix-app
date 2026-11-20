# Relaunch documentation

Start with **`00-CONSOLIDATED-REPORT.md`** - it is the summary and it contains the
one finding that changes the plan.

| Document | Contents |
|---|---|
| `00-CONSOLIDATED-REPORT.md` | the 19 deliverables, files, commits, test results, approval gates, open decisions |
| `01-BASELINE.md` | repository inspection, architecture, the critical finding, money-path integrity, business constants |
| `02-BRAND.md` | 20 candidate names, availability evidence and its limits, recommendation, measured rebrand scope |
| `03-MIN-DEPOSIT-50.md` | every location the $100 lives, real trading feasibility of $50, unit economics, the prepared change set |
| `04-PAYHIP.md` | eligibility assessment, the fee/withdrawability economics, full technical design (tables, webhook, redemption, refunds, reconciliation, sandbox), deployment checklist |
| `05-PAYMENTS.md` | Q8Pay decimal-discriminator findings + fix, Trunkay (does not exist), Card2Crypto (do not use), recommended architecture |
| `06-MARKETS.md` | Google Ads policy evidence, Brazil vs Mexico vs Argentina, recommendation |
| `07-LOCALIZATION-ASSETS.md` | localization readiness per market, the 47-asset universe audit and the capability-flag recommendation |
| `08-ACTION-PLAN.md` | blocked items, the two viable product models, the ordered plan, the approval-gate table |

## Standing constraints for anything built from these documents

- Never credit a balance from a frontend confirmation. Payment must be verified
  server-to-server against the provider.
- Never deduct silently or create a negative balance. Every reversal is a ledger
  row; freeze the account instead.
- Never relax a risk control to make a small account look viable.
- Never describe the business inaccurately to a payment provider or an ad
  platform.
- Preserve the existing safeguards: the $700 withdrawal minimum, the
  first-deposit and completed-trade requirements, KYC, and the sandbox isolation
  are all pinned by tests and were not touched.
