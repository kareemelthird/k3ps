# supabase

Multi-tenant backend: Postgres schema, **RLS policies (tenant isolation)**, edge functions, seed data, and pgTAP isolation tests.

```
supabase/
  migrations/   # 0001–0012 — numbered SQL migrations; applied in order
  functions/    # edge functions (custom-access-token hook, Stripe webhook, billing sessions, tenant lifecycle)
  tests/        # pgTAP isolation tests (00–07); run in CI with `supabase test db`
  seed.sql      # sample tenants/branches/devices/rate-rules/products for dev
```

The `backend-engineer` / `supabase-migrate` agent owns this directory. The `security-reviewer` agent must sign off on every RLS change.

## Migration sequence

| Migration | Purpose |
|---|---|
| `0001_tenancy_core.sql` | `tenants`, `branches`, `tenant_members`, `profiles`, auth hook |
| `0002_operational_tables.sql` | `devices`, `rate_rules`, `sessions`, `session_segments`, `products`, `orders`, `order_items`, `stock_movements`, `shifts`, `audit_log`, `product_stock_levels` view |
| `0003_claim_helpers.sql` | `current_tenant_id()`, `is_active_member()`, `is_tenant_owner()`, `is_platform_admin()` — SECURITY DEFINER, JWT-claim-based |
| `0004_rls_policies.sql` | RLS policies on all tables; `WITH CHECK` on every write |
| `0005_grants.sql` | `authenticated` and `service_role` grants |
| `0006_orders_inventory_shifts.sql` | `order_items.is_void`/`voided_at`, `shifts_one_open_per_branch` unique index |
| `0007_reporting_functions.sql` | `SECURITY INVOKER` reporting RPCs |
| `0008_super_admin_and_impersonation.sql` | Super-admin cross-tenant read policies; `stamp_impersonator()` BEFORE INSERT trigger on `audit_log` |
| `0009_outbox_realtime_and_close_rpc.sql` | `close_session_tx` SECURITY INVOKER RPC; Realtime publication |
| `0010_billing.sql` | `plans`, `subscriptions`, `stripe_events`; billing SECURITY DEFINER RPCs; trial backfill |
| `0011_cap_reactivation_fix.sql` | Billing cap reactivation edge-case fix |
| `0012_audit_atomicity_and_perf_indexes.sql` | `audit_config_change()` SECURITY INVOKER trigger on `products`/`rate_rules`; `audit_log_entity_idx` |

## Tenant isolation model (ADR-0002: shared-DB + `tenant_id` + RLS)

- **RLS enabled on every table** in the `public` schema — no exceptions.
- Every tenant-scoped table carries an indexed `tenant_id` (and `branch_id` where relevant).
- Tenant identity resolved via `current_tenant_id()` — reads the signed `app_metadata` JWT claim set by the `custom-access-token` auth hook. Never from a client-supplied body.
- Write policies use `WITH CHECK (tenant_id = current_tenant_id())` so a user cannot insert into another tenant.
- Proven by the pgTAP suite below.

## Running locally

```sh
# start the local stack (Docker required)
supabase start

# apply all migrations + seed
supabase db reset

# run pgTAP isolation tests
supabase test db
```

## pgTAP test suite

| File | What it proves |
|---|---|
| `00_rls_enabled.test.sql` | RLS is enabled on every public table |
| `01_tenant_isolation.test.sql` | Tenant A cannot read or write Tenant B's rows |
| `02_orders_inventory_shifts.test.sql` | Order/stock/shift writes respect tenant isolation |
| `03_report_rpc_isolation.test.sql` | Reporting RPCs return only the caller's tenant data |
| `04_super_admin_impersonation.test.sql` | Super-admin cross-tenant read; impersonation stamp |
| `05_outbox_close_tx.test.sql` | `close_session_tx` is atomic and RLS-correct |
| `06_billing_isolation.test.sql` | Billing tables + entitlement RPCs respect tenant isolation |
| `07_audit_atomicity.test.sql` | `audit_config_change()` trigger fires atomically; cannot cross tenants |

Tests `01–07` run in CI on every push. If you add a new table, add a row to `00_rls_enabled` and extend the relevant isolation test.

## Edge functions

| Function | Auth | Purpose |
|---|---|---|
| `custom-access-token` | Supabase hook | Sets `tenant_id`/`role` in JWT `app_metadata` claims; must be **deployed and enabled** in the Supabase dashboard |
| `stripe-webhook` | `verify_jwt=false` + raw-body signature | Processes Stripe events; `event.id` dedupe; writes `subscriptions` + `audit_log` |
| `create-checkout-session` | JWT (owner only) | Server-mints Stripe Checkout URL; no secret to client |
| `create-portal-session` | JWT (owner only) | Server-mints Stripe Portal URL; no secret to client |
| `set-tenant-plan` | JWT (super-admin only) | Comp/override subscription; audited |
| `impersonate-tenant` | JWT (super-admin only) | Mints a short-lived impersonation session; audited |
| `end-impersonation` | JWT | Ends impersonation; audited |
| `reactivate-tenant` | JWT (super-admin only) | Reactivates a suspended tenant; audited |
| `provision-tenant` | JWT (super-admin only) | Provisions a new tenant + first owner + trial subscription |

## Secrets

Edge function secrets are set via `supabase secrets set` (never committed). Required for production:

- `SUPABASE_SERVICE_ROLE_KEY` — set automatically by Supabase for hosted projects
- `STRIPE_SECRET_KEY` — Stripe secret (`sk_test_…` for test-mode)
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret

See root [`CLAUDE.md`](../CLAUDE.md) §5 for the full tenancy and security rules.
