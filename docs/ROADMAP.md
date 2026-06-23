# Roadmap

Built phase by phase. Each phase runs through the `feature` workflow and ends at a **human approval gate** before the next begins. Localization is Arabic-first/EGP (like Pochinki); multi-currency/i18n generalization is deferred.

| Phase | Goal | Surfaces | Status |
| --- | --- | --- | --- |
| **1. The factory** | Agent team + workflows + skills + monorepo scaffolding + CLAUDE.md | — | ✅ in progress |
| **2. Tenant foundation** | ADR on isolation model; Supabase schema with `tenant_id`+`branch_id`; auth + JWT claim; multi-tenant RLS; super-admin tenant provisioning; port `@ps/core` (money/time/inventory/types) | core, backend | ⬜ next |
| **3. Walking skeleton** | Thin end-to-end slice: login → tenant → branch → device → start/close one session, on mobile + web | all | ⬜ |
| **4. Devices + Sessions + Pricing** | Port the pricing engine into `@ps/core`; live device grid; session lifecycle + segments (open/prepaid/fixed-match) | core, backend, mobile | ⬜ |
| **5. Products + Orders + Inventory + Shifts** | Catalog, order builder, stock ledger, walk-ins, shift open/close + cash reconciliation | core, backend, mobile | ⬜ |
| **6. Owner web dashboard + Reports** | KPIs, charts, reports by date/device/product, CSV export | backend, web | ⬜ |
| **7. Super-admin portal** | Tenant lifecycle, support tools, guarded+audited impersonation | backend, web | ⬜ |
| **8. Offline-first hardening** | Port/harden the outbox + realtime for multi-tenant; dead-letter + sync UI | core, backend, mobile | ⬜ |
| **9. SaaS billing** | Stripe subscriptions, trial → tiers, paywall, super-admin plan management | backend, web | ⬜ |
| **10. Production hardening** | Sentry, audit trail, EAS builds, performance, a11y, full security pass | all | ⬜ |

## Principles
- **Reuse the trial's proven core** — don't reinvent pricing/money/time/inventory.
- **Tenant isolation before features** — Phase 2 locks the isolation model with an ADR and isolation tests.
- **Definition of done** = `ps-verify` green + acceptance criteria met + (for backend) `security-reviewer` sign-off.
- **One phase at a time** — the human approves each gate.
