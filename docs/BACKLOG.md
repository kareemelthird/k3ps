# Backlog

Living list, owned by `product-manager`. Items get pulled into a phase, specced (`docs/specs/`), and gated by the human. Status: 🔵 ready · 🟡 needs spec · ⚪ idea.

## Phase 2 — Tenant foundation (next)
> Spec: [`docs/specs/phase-2-tenant-foundation.md`](specs/phase-2-tenant-foundation.md) · Decision: [ADR-0002](adr/0002-tenant-isolation-model-ratified.md) (ACCEPTED)
- ✅ ADR: tenant isolation model (shared-DB+RLS) — ADR-0002 accepted.
- 🔵 Schema: `tenants`, `branches`, `tenant_members`, `profiles` (+`super_admin` role), `app_metadata` JWT claim hook.
- 🔵 RLS on every table + `WITH CHECK` on writes + `rls-tenant-audit` isolation suite (≥2 seeded tenants; live exec DEFERRED to CI).
- 🔵 Super-admin: provision/suspend a tenant; create the first owner; time-boxed audited impersonation.
- 🔵 Build `@ps/core`: money (piastres), time (Cairo TZ), id, inventory ledger, multi-tenant types — tests >90%.
- 🟡 architect decisions blocking migrations (see spec §6/§7): impersonation mechanics, JWT claim shape/freshness, `super_admin` placement, exact `branch_id` set, `settings` composite key, `payment_method` enum.

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
