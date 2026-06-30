# Architecture Decision Records

One ADR per significant, hard-to-reverse design choice. Accepted ADRs are never rewritten; they are superseded by a new one. See `docs/adr/0000-template.md` for the authoring template.

## Index

| ADR | Title | Status | Phase |
|---|---|---|---|
| [0001](0001-tenant-isolation-model.md) | Tenant isolation model — initial proposal | Superseded by ADR-0002 | 2 |
| [0002](0002-tenant-isolation-model-ratified.md) | Tenant isolation model — shared-DB + `tenant_id` + RLS (ratified) | Accepted | 2 |
| [0003](0003-auth-claim-and-impersonation-model.md) | Auth claim and impersonation model — scalar `tenant_id` in JWT `app_metadata`, short-TTL freshness, server-minted time-boxed audited impersonation | Accepted | 2 |
| [0004](0004-tenant-schema-scoping-and-keys.md) | Tenant schema scoping and keys — `branch_id` placement, composite index strategy, `payment_method` enum | Accepted | 2 |
| [0005](0005-pricing-engine-segments-and-boundaries.md) | Pricing engine — segments and rate-boundary algorithm; live preview-splits / close-materializes | Accepted | 4 |
| [0006](0006-orders-inventory-shifts.md) | Orders, inventory and shifts — order-line void model, cash-only reconciliation, one-open-shift-per-branch, audit taxonomy | Accepted | 5 |
| [0007](0007-reporting-aggregation-and-rls.md) | Reporting aggregation and RLS — `SECURITY INVOKER` RPCs, business-day bucketing, no bare materialized views | Accepted | 6 |
| [0008](0008-super-admin-and-impersonation.md) | Super-admin and impersonation — `is_platform_admin`, SECURITY DEFINER + service-role-only RPCs, `stamp_impersonator()` BEFORE INSERT trigger, cross-tenant read policies | Accepted | 7 |
| [0009](0009-offline-outbox-and-realtime.md) | Offline outbox and realtime sync — pure-core state machine, crash-safe persistence, dependency-ordered drain, tenant-scoped realtime, `close_session_tx` SECURITY INVOKER RPC | Accepted | 8 |
| [0010](0010-saas-billing-stripe.md) | SaaS billing — Stripe subscriptions, entitlements in `@ps/core`, webhook trust boundary, `stripe_events` dedupe, service-role-only RPCs | Accepted | 9 |
| [0011](0011-production-hardening-observability.md) | Production hardening — DSN-gated Sentry observability, pure `@ps/core` scrubber with `SAFE_TAG_KEYS` allowlist, `audit_config_change()` SECURITY INVOKER trigger (completes §2.7), EAS build profiles, perf/a11y/security gates | Accepted | 10 |
| [0012](0012-staff-permissions-settings-and-debts.md) | Staff provisioning (`invite-staff` edge fn) + per-staff `permissions jsonb` on `tenant_members` + `has_permission()` RLS gate + KV-reuse for tenant settings + customer debts (آجل) via existing tables/`'debt'` enum + debt creation folded into `close_session_tx` | Proposed | — |

## Conventions

- **Superseded ADRs** remain in the index with their status updated; the superseding ADR references the superseded one.
- **Status values:** Proposed → Accepted | Rejected | Deprecated | Superseded.
- Every ADR that touches RLS or security must have `security-reviewer` co-sign noted in the Deciders field.
- The human project owner approves at the phase gate; ADRs are finalized before that gate closes.
