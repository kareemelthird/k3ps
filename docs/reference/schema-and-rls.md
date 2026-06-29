# Reference: schema & RLS — lessons from the trial + the multi-tenant system as built

The trial schema (`D:\K3\Pochinki\supabase\migrations`) is **single-café** (no `tenant_id`/`branch_id`) — a **learning input, not a blueprint**. Reuse its *sound entity model* (devices/sessions/segments/orders/shifts/…); the multi-tenant schema was designed **fresh and improved**, not transcribed. The isolation model was decided in [ADR-0002](../adr/0002-tenant-isolation-model-ratified.md): **shared database + `tenant_id` + RLS**.

---

## Trial tables (column shape to reuse)
- **profiles** `id`(=auth.users.id) · `role` enum(owner|manager) · `full_name` · `phone?` · `is_active` · `permissions` jsonb · timestamps.
- **devices** `id` · `name` · `device_type` · `status`(free|busy|maintenance) · `sort_order` · `is_active`.
- **rate_rules** `device_type` · `play_mode`(single|multi|any) · `billing_mode` · `day_type`(weekday|weekend|any) · `time_start?`/`time_end?` 'HH:mm' · `price_per_hour?` · `block_minutes?`/`block_price?` · `fixed_match_price?` · `rounding_minutes`=5 · `min_charge_minutes`=0 · `priority` · `is_active`.
- **shifts** `manager_id` · `opened_at`/`closed_at?` · `opening_cash`/`expected_cash`/`actual_cash?`/`difference?` · `notes?` · `status`(open|closed).
- **sessions** `device_id` · `manager_id` · `shift_id?` · `billing_mode` · `status`(active|closed|void) · `started_at`/`ended_at?` · `prepaid_minutes?` · `prepaid_total?` (locked price) · `match_count?` · `time_total`/`orders_total`/`grand_total`/`discount` · `payment_method?`(cash|wallet|other|debt).
- **session_segments** `session_id`(cascade) · `play_mode` · `rate_rule_id?` · `price_per_hour_snapshot` · `started_at`/`ended_at?`.
- **products** `name` · `category` · `price` · `cost?` · `stock?` (denormalized) · `is_active`.
- **orders** `session_id?`(null = walk-in) · `shift_id?` · `manager_id` · `total` · `status`(open|paid|void) · `payment_method?`.
- **order_items** `order_id`(cascade) · `product_id` · `qty` · `unit_price`.
- **stock_movements** `product_id`(cascade) · `delta`(±) · `reason`(initial|restock|adjust|sale|void) · `order_id?` · `manager_id?` · `note?`. (on-hand = Σ delta; view `product_stock_levels` with `security_invoker=true`.)
- **audit_log** `actor_id?` · `action`('session.close'|'session.void'|'shift.close'|'stock.adjust'|...) · `entity?`/`entity_id?` · `amount?` · `meta` jsonb.
- **debts** `customer_name` · `customer_id?` · `amount` · `session_id?` · `manager_id` · `shift_id?`. **debt_payments** `debt_id`(cascade) · `amount` · `manager_id` · `shift_id?`. **customers** `name` · `phone?` · `note?`.
- **settings** `key` PK · `value` jsonb. Seeded: cafe_name, currency=EGP, timezone=Africa/Cairo, peak_windows `[{start:'18:00',end:'02:00'}]`, schema_version.

Money columns are `int` piastres; times are `timestamptz` (UTC). All tables have `set_updated_at()` triggers. `handle_new_user()` auto-creates a `profiles` row (role=manager) on signup.

---

## Trial RLS model (the pattern to generalize)
Helper fns (security definer): `is_owner()` (profile role=owner AND is_active), `is_staff()` (profile exists AND is_active). Role resolved from `profiles` by `auth.uid()`. Pattern: config tables (devices/rate_rules/products/settings) = staff read + owner write; transactional tables (shifts/sessions/orders/...) = `manager_id = auth.uid() OR is_owner()`; child tables (segments/order_items) gate via parent EXISTS; `stock_movements` insert blocks `reason='adjust'` unless owner; `audit_log` owner-read / staff-insert.

---

## Multi-tenant schema — as built (Phases 2–10)

### New tables
- **`tenants`** — the café business entity (name, plan, status, Stripe customer id).
- **`branches`** (`tenant_id` FK) — a physical location; all operational tables carry `branch_id` where relevant.
- **`tenant_members`** (`tenant_id`, `profile_id`, `role`) — one user may belong to multiple tenants with a role per tenancy.
- **`plans`** / **`subscriptions`** / **`stripe_events`** — SaaS billing tables (migration `0010`).

### Tenant-scoping rules
- **Every operational table** has `tenant_id uuid NOT NULL` indexed first in composite indexes. `branch_id` is added to tables where branch-level data separation applies (devices, shifts, sessions, orders, stock_movements).
- **Tenant id from the JWT claim only.** The helper `current_tenant_id()` reads `app_metadata ->> 'tenant_id'` from the signed JWT. It is **never** read from a client-supplied body/header or from `profiles` in the hot path.
- **`is_active_member()` SECURITY DEFINER** — checks `tenant_members` for the current `auth.uid()` + `current_tenant_id()`. Used in policy `USING` clauses so callers cannot fake their membership.
- **`WITH CHECK` on every write policy** — a user cannot insert or update a row with a `tenant_id` that is not their own.

### RLS policy shape (representative)
```sql
-- SELECT: staff of this tenant can read
create policy "sessions_tenant_read" on public.sessions
  for select using (tenant_id = current_tenant_id() and is_active_member());

-- INSERT/UPDATE: owner of this tenant can write; WITH CHECK prevents cross-tenant
create policy "rate_rules_owner_write" on public.rate_rules
  for all to authenticated
  using  (tenant_id = current_tenant_id() and is_tenant_owner())
  with check (tenant_id = current_tenant_id() and is_tenant_owner());
```

### Super-admin cross-tenant read
Super-admin (platform operator) gets a cross-tenant **read** policy on operational tables — no direct cross-tenant write; writes require impersonation (ADR-0008).

```sql
create policy "sessions_super_admin_read" on public.sessions
  for select using (is_platform_admin());
```

`is_platform_admin()` is a SECURITY DEFINER function that checks `profiles.role = 'super_admin'` — no `OR is_super_admin()` shortcut on operational write policies.

---

## Migration sequence (migrations `0001–0012`)

| Migration | Contents |
|---|---|
| `0001_tenancy_core.sql` | `tenants`, `branches`, `tenant_members`, `profiles` (+super_admin role), auth hook skeleton |
| `0002_operational_tables.sql` | `devices`, `rate_rules`, `sessions`, `session_segments`, `products`, `orders`, `order_items`, `stock_movements`, `shifts`, `audit_log`, `product_stock_levels` view |
| `0003_claim_helpers.sql` | `current_tenant_id()`, `is_active_member()`, `is_tenant_owner()`, `is_platform_admin()` — all SECURITY DEFINER, resolve from signed JWT |
| `0004_rls_policies.sql` | RLS policies on all tables; `WITH CHECK` on writes; `rls-tenant-audit` suite proves isolation |
| `0005_grants.sql` | Role grants for `authenticated` and `service_role` |
| `0006_orders_inventory_shifts.sql` | `order_items.is_void`/`voided_at`, `shifts_one_open_per_branch` index |
| `0007_reporting_functions.sql` | `SECURITY INVOKER` reporting RPCs; `businessDayKey`-aligned bucketing |
| `0008_super_admin_and_impersonation.sql` | Super-admin cross-tenant read policies; `stamp_impersonator()` BEFORE INSERT trigger on `audit_log`; impersonation RPCs |
| `0009_outbox_realtime_and_close_rpc.sql` | `close_session_tx` SECURITY INVOKER RPC; Realtime publication setup |
| `0010_billing.sql` | `plans`, `subscriptions`, `stripe_events`; billing SECURITY DEFINER RPCs (service-role-only); seeded catalog; trial backfill |
| `0011_cap_reactivation_fix.sql` | Billing cap reactivation edge-case fix |
| `0012_audit_atomicity_and_perf_indexes.sql` | `audit_config_change()` SECURITY INVOKER trigger; `audit_log_entity_idx` |

> **Numbering note:** ADR-0011 originally planned `0011_audit_atomicity_and_perf_indexes.sql` but `0011_cap_reactivation_fix.sql` was already applied; the audit trigger therefore landed in `0012`. The migration comment documents this.

---

## Key RLS/security lessons

### `current_tenant_id()` is the only tenant resolver
Never resolve tenant identity from `profiles`, from `tenant_members` JOINs in policy `USING` clauses, or from any client-supplied value. `current_tenant_id()` reads the `app_metadata` claim from the signed JWT — set by the `custom-access-token` auth hook. If that hook is not deployed and enabled on the hosted project, claims are absent and policies fail closed.

### SECURITY DEFINER vs SECURITY INVOKER — the discipline (ADR-0007)
- Helper fns (`current_tenant_id`, `is_active_member`, `is_tenant_owner`, `is_platform_admin`, `stamp_impersonator`) are **SECURITY DEFINER** because they need to read privilege-elevated tables (`profiles`, `tenant_members`) — not because the caller needs elevated data access.
- **Reporting RPCs and the `product_stock_levels` view use `SECURITY INVOKER`** — the caller's own RLS applies. No `SECURITY DEFINER` on any path that returns tenant data.
- **`close_session_tx` (ADR-0009) is `SECURITY INVOKER`** — it writes the session close + audit row in one atomic transaction under the caller's RLS. This is the reference pattern for atomic multi-row writes that must also write to `audit_log`.

### The `audit_config_change()` trigger (Phase 10 — migration `0012`)
Before Phase 10, `ProductForm.tsx` issued a separate client-side `audit_log` upsert after the product upsert — non-atomic and client-skippable, violating §2.7's intent. The fix is a `SECURITY INVOKER` `AFTER INSERT OR UPDATE` trigger on `products` and `rate_rules`:

- **By construction, un-skippable** — fires on any write path (direct PostgREST, RPC, future surface), not just when the client remembers to call it.
- **SECURITY INVOKER** — the `audit_log` insert runs under the caller's RLS; the existing `stamp_impersonator()` BEFORE INSERT trigger still fires and stamps `meta.impersonator_id` from the signed claim (ADR-0008 preserved).
- **Context-skip** — if `request.jwt.claims` is empty (migration/seed/`psql`) or JWT role is `service_role` or `auth.uid()` is null, the trigger returns without writing. Seeds and backfills are never blocked by `NOT NULL actor_id`.
- **Idempotent** — deterministic id: `md5(action || ':' || entity_id || ':' || extract(epoch from new.updated_at))::uuid`, inserted `ON CONFLICT (id) DO NOTHING`. A retried upsert with the same `updated_at` does not duplicate the audit row.
- **Adds no policy, no `WITH CHECK`, no `SECURITY DEFINER` data path** (ADR-0007 discipline intact).
- **Web client** (`ProductForm.tsx`, `ProductsView.tsx`, `RateRulesView.tsx`) had its separate `audit_log` upsert removed — the trigger is now the sole writer.

### The `stamp_impersonator()` BEFORE INSERT trigger on `audit_log` (Phase 7)
Fires before every `audit_log` insert. Reads `current_impersonator_id()` from the JWT claim (set during an impersonation session) and stamps `meta.impersonator_id`. A client-supplied `meta.impersonator_id` is stripped — it cannot be forged. This means **any** audit write, including the new trigger's write, automatically gets the impersonator stamp without extra code.

### The `close_session_tx` SECURITY INVOKER + SECURITY DEFINER lesson (ADR-0009)
`close_session_tx` was originally designed as `SECURITY DEFINER` to guarantee the audit row is written even if the caller lacks direct `audit_log` insert permission. During implementation it was discovered that nested `audit_log` inserts inside a SECURITY DEFINER function bypass RLS — the `audit_log_staff_insert` policy (`tenant_id = current_tenant_id()`) would not be evaluated. The fix: **`SECURITY INVOKER` throughout**, with an explicit `tenant_id`/`member` guard at the top of the function body. This is the canonical pattern: functions that must also write to `audit_log` must be `SECURITY INVOKER` + carry their own guard, not use `SECURITY DEFINER` as a shortcut.

### `audit_log_entity_idx` (Phase 10 — migration `0012`)
Forward-only index on `audit_log(tenant_id, entity, entity_id)`. Added after the Phase 10 perf audit confirmed the "history for this entity" read path (e.g., all audit rows for a specific product) is a hot path on the owner dashboard with no existing index.

### Tenant-isolation test suite (pgTAP)
Tests live in `supabase/tests/` and run in CI:

| File | What it proves |
|---|---|
| `00_rls_enabled.test.sql` | RLS is enabled on every public table |
| `01_tenant_isolation.test.sql` | Tenant A cannot read or write Tenant B's rows |
| `02_orders_inventory_shifts.test.sql` | Order/stock/shift writes respect tenant isolation |
| `03_report_rpc_isolation.test.sql` | Reporting RPCs return only the caller's tenant data |
| `04_super_admin_impersonation.test.sql` | Super-admin cross-tenant read; impersonation paths |
| `05_outbox_close_tx.test.sql` | `close_session_tx` is atomic and RLS-correct |
| `06_billing_isolation.test.sql` | Billing tables + entitlement RPCs respect tenant isolation |
| `07_audit_atomicity.test.sql` | `audit_config_change()` trigger fires atomically and cannot cross tenants |

See `CLAUDE.md` §5 and skills `supabase-migrate`, `rls-tenant-audit`.
