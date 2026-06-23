# Backlog

Living list, owned by `product-manager`. Items get pulled into a phase, specced (`docs/specs/`), and gated by the human. Status: 🔵 ready · 🟡 needs spec · ⚪ idea.

## Phase 2 — Tenant foundation (next)
- 🟡 ADR: tenant isolation model (shared-DB+RLS vs schema/DB-per-tenant) — run `architecture-decision` workflow.
- 🟡 Schema: `tenants`, `branches`, `profiles` (with role + tenant/branch), `app_metadata` JWT claim hook.
- 🟡 RLS baseline + `rls-tenant-audit` isolation tests (≥2 seeded tenants).
- 🟡 Super-admin: provision/suspend a tenant; create the first owner.
- 🟡 Port `@ps/core`: money (piastres), time (Cairo TZ), inventory ledger, shared types — with tests >90%.

## Later (placeholders)
- ⚪ Devices CRUD + live grid (Phase 4)
- ⚪ Pricing engine port + rate-rule editor (Phase 4)
- ⚪ Orders/products/inventory + shift reconciliation (Phase 5)
- ⚪ Owner reports + CSV (Phase 6)
- ⚪ Super-admin portal + impersonation audit (Phase 7)
- ⚪ Offline outbox port + realtime (Phase 8)
- ⚪ Stripe subscriptions + paywall (Phase 9)
- ⚪ Sentry, EAS builds, a11y, security pass (Phase 10)

> Decisions land as ADRs in `docs/adr/`. Specs land in `docs/specs/`.
