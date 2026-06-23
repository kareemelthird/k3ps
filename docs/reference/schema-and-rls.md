# Reference: schema & RLS — lessons from the trial + multi-tenant deltas

The trial schema (`D:\K3\Pochinki\supabase\migrations`) is **single-café** (no `tenant_id`/`branch_id`) — a **learning input, not a blueprint**. Reuse its *sound entity model* (devices/sessions/segments/orders/shifts/…); design the multi-tenant schema **fresh and improved**, don't transcribe it. The isolation model is decided by the Phase-2 ADR; this doc is input to it, not the decision.

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

## Trial RLS model (the pattern to generalize)
Helper fns (security definer): `is_owner()` (profile role=owner AND is_active), `is_staff()` (profile exists AND is_active). Role resolved from `profiles` by `auth.uid()`. Pattern: config tables (devices/rate_rules/products/settings) = staff read + owner write; transactional tables (shifts/sessions/orders/...) = `manager_id = auth.uid() OR is_owner()`; child tables (segments/order_items) gate via parent EXISTS; `stock_movements` insert blocks `reason='adjust'` unless owner; `audit_log` owner-read / staff-insert.

## Multi-tenant deltas (the work for Phase 2)
1. **New tables:** `tenants` (the café business), `branches` (`tenant_id` FK), and a membership table `tenant_members(tenant_id, profile_id, role)` — one user may belong to multiple tenants/branches with a role per place. Add `super_admin` above owner.
2. **Add `tenant_id uuid not null`** (and `branch_id` where relevant: devices, shifts, sessions, orders, stock_movements...) to every operational table; index it; put it first in composite indexes (e.g. unique active session becomes `(tenant_id, device_id) where status='active'`).
3. **Tenant id from a trusted JWT `app_metadata` claim** (set via auth hook), NOT from `profiles` lookups in the hot path and NEVER from client input. New helper `auth_tenant_ids()` / `current_tenant_id()` reads the claim.
4. **Rewrite every policy** to AND a tenant predicate: e.g. `tenant_id = current_tenant_id()` plus the existing role/owner logic, with `WITH CHECK` on writes so a row can't be written into another tenant.
5. **RLS on every new table.** `profiles` stays cross-tenant; access to tenant data flows through `tenant_members` + the JWT claim.
6. **Seed ≥2 tenants** so `rls-tenant-audit` can prove isolation.
7. **Super-admin / impersonation** path must be explicit, time-boxed, and audited — never a silent cross-tenant read.

See `CLAUDE.md` §5 and skills `supabase-migrate`, `rls-tenant-audit`.
