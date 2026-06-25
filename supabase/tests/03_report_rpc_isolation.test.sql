-- =============================================================================
-- 03_report_rpc_isolation.test.sql — pgTAP isolation proof for the five
-- Phase-6 reporting RPCs (migration 0007, ADR-0007).
--
-- Proves three guarantees (ADR-0007 Decisions 1, 2, 8):
--
--   BLOCK A — Tenant-data isolation (5 tests):
--     As Tenant-A owner, each RPC returns only Tenant-A rows. The expected
--     exact aggregate values differ from what B-data would produce, so any
--     cross-tenant leak causes a measurable assertion failure.
--
--   BLOCK B — Branch-filter isolation (5 tests):
--     As Tenant-A owner, passing Tenant-B's branch UUID as p_branch returns
--     zero rows. This proves p_branch only *narrows* within the RLS-bounded
--     tenant scope — it cannot widen scope across tenants, even via a crafted
--     or guessed branch UUID (ADR-0007 Decision 1.2).
--
--   BLOCK C — Owner gate (5 tests):
--     As a manager of Tenant-A (is_tenant_owner() = false), every RPC returns
--     zero rows — the in-function is_tenant_owner() predicate is the DB-level
--     defense-in-depth gate behind the /dashboard/reports route gate (Decision 8).
--
-- Fixture revenue fingerprints (piastres):
--   Tenant-A (all visible to owner_a via is_tenant_owner()):
--     session aaaaaaaa-5e01 (manager_id=owner_a,   grand_total=6500, cash)
--     walk-in aaaaaaaa-0a01 (manager_id=owner_a,   total=1500,       cash, Pepsi Can ×3)
--     session aaaaaaaa-5e02 (manager_id=manager_a, grand_total=5000, cash)  ← Block C fixture
--     walk-in aaaaaaaa-0a02 (manager_id=manager_a, total=800,        cash, Mineral Water ×2) ← Block C
--     shift   aaaaaaaa-5f01 (manager_id=owner_a)
--     shift   aaaaaaaa-5f02 (manager_id=manager_a)                         ← Block C fixture
--   Tenant-A gross total = 6500 + 1500 + 5000 + 800 = 13800
--   Tenant-B: 1 closed session (grand_total=9999) + 1 walk-in (total=9000) → 18999
--   If B-data leaks into A-owner's RPC result, the sum assertion (13800) fails.
--
-- Plan: 15 tests (5 Block A + 5 Block B + 5 Block C).
-- Depends on seed.sql (Tenant A = aaaaaaaa…, Tenant B = bbbbbbbb…).
-- All fixture writes are inside this transaction and rolled back at the end.
-- Run: npx supabase test db  (local Supabase stack / Docker, or CI).
-- =============================================================================

begin;
select plan(15);

-- ---------------------------------------------------------------------------
-- FIXTURE SETUP (as superuser — before switching to the authenticated role)
-- All UUIDs use the suffix -000000000007 to avoid conflicts with seed.sql rows
-- and with the other test files (01_… uses -000000000001, 02_… uses no overlap).
-- ---------------------------------------------------------------------------

-- Tenant-A closed session (device 1 of branch 1; owner_a as manager)
insert into public.sessions
  (id, tenant_id, branch_id, device_id, manager_id,
   billing_mode, status,
   started_at, ended_at,
   time_total, orders_total, grand_total, discount, payment_method)
values
  ('aaaaaaaa-5e01-4000-8000-000000000007',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-de01-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000001',
   'open', 'closed',
   '2026-06-01 08:00:00+00', '2026-06-01 09:00:00+00',
   6000, 500, 6500, 0, 'cash')
on conflict (id) do nothing;

-- Tenant-B closed session — MUST be invisible to A-owner via RLS
insert into public.sessions
  (id, tenant_id, branch_id, device_id, manager_id,
   billing_mode, status,
   started_at, ended_at,
   time_total, orders_total, grand_total, discount, payment_method)
values
  ('bbbbbbbb-5e01-4000-8000-000000000007',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
   'bbbbbbbb-de01-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000003',
   'open', 'closed',
   '2026-06-01 08:00:00+00', '2026-06-01 09:00:00+00',
   7000, 600, 9999, 0, 'cash')
on conflict (id) do nothing;

-- Tenant-A walk-in paid order (session_id null; created_at explicit)
insert into public.orders
  (id, tenant_id, branch_id, manager_id, total, status, payment_method, created_at)
values
  ('aaaaaaaa-0a01-4000-8000-000000000007',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000001',
   1500, 'paid', 'cash', '2026-06-01 10:00:00+00')
on conflict (id) do nothing;

-- Tenant-B walk-in paid order — MUST be invisible to A-owner via RLS
insert into public.orders
  (id, tenant_id, branch_id, manager_id, total, status, payment_method, created_at)
values
  ('bbbbbbbb-0a01-4000-8000-000000000007',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
   '00000000-0000-4000-8000-000000000003',
   9000, 'paid', 'cash', '2026-06-01 10:00:00+00')
on conflict (id) do nothing;

-- Tenant-A order_item on A walk-in (Pepsi Can, qty=3 × 500 = 1500 revenue)
insert into public.order_items
  (id, tenant_id, order_id, product_id, qty, unit_price, is_void)
values
  ('aaaaaaaa-0107-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-0a01-4000-8000-000000000007',
   'aaaaaaaa-c0de-4000-8000-000000000001',
   3, 500, false)
on conflict (id) do nothing;

-- Tenant-B order_item on B walk-in (Coca Cola, qty=15 × 600 = 9000 revenue)
-- MUST be invisible to A-owner's report_top_products call
insert into public.order_items
  (id, tenant_id, order_id, product_id, qty, unit_price, is_void)
values
  ('bbbbbbbb-0107-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbbbbbb-0a01-4000-8000-000000000007',
   'bbbbbbbb-c0de-4000-8000-000000000001',
   15, 600, false)
on conflict (id) do nothing;

-- Tenant-A closed shift (branch 1; zero-variance for clean assertion)
insert into public.shifts
  (id, tenant_id, branch_id, manager_id,
   opened_at, closed_at,
   opening_cash, expected_cash, actual_cash, difference, status)
values
  ('aaaaaaaa-5f01-4000-8000-000000000007',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000001',
   '2026-06-01 06:00:00+00', '2026-06-01 18:00:00+00',
   50000, 58000, 58000, 0, 'closed')
on conflict (id) do nothing;

-- Tenant-B closed shift — MUST be invisible to A-owner via RLS
insert into public.shifts
  (id, tenant_id, branch_id, manager_id,
   opened_at, closed_at,
   opening_cash, expected_cash, actual_cash, difference, status)
values
  ('bbbbbbbb-5f01-4000-8000-000000000007',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
   '00000000-0000-4000-8000-000000000003',
   '2026-06-01 06:00:00+00', '2026-06-01 18:00:00+00',
   20000, 29000, 28000, -1000, 'closed')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- BLOCK C additional fixtures: Tenant-A rows owned by MANAGER_A
-- (manager_id = …000000000002 = manager_a).
--
-- WHY THESE ARE REQUIRED (security NB-1):
--   The base-table RLS for sessions/orders/shifts is:
--     tenant_id = current_tenant_id() AND (manager_id = auth.uid() OR is_tenant_owner())
--   When manager_a is the JWT context, rows with manager_id=owner_a are hidden
--   by RLS — so the original Block C tests returned 0 even if the in-function
--   is_tenant_owner() gate were deleted.  These fixtures have manager_id=manager_a,
--   so base-table RLS *allows* manager_a to read them; only the in-function
--   is_tenant_owner() predicate can now produce the expected 0-row result.
-- ---------------------------------------------------------------------------

-- Tenant-A closed session owned by manager_a (Block C regression fixture)
insert into public.sessions
  (id, tenant_id, branch_id, device_id, manager_id,
   billing_mode, status,
   started_at, ended_at,
   time_total, orders_total, grand_total, discount, payment_method)
values
  ('aaaaaaaa-5e02-4000-8000-000000000007',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-de01-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000002',   -- manager_a
   'open', 'closed',
   '2026-06-01 08:30:00+00', '2026-06-01 09:30:00+00',
   4800, 200, 5000, 0, 'cash')
on conflict (id) do nothing;

-- Tenant-A walk-in paid order owned by manager_a (Block C regression fixture)
insert into public.orders
  (id, tenant_id, branch_id, manager_id, total, status, payment_method, created_at)
values
  ('aaaaaaaa-0a02-4000-8000-000000000007',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000002',   -- manager_a
   800, 'paid', 'cash', '2026-06-01 11:00:00+00')
on conflict (id) do nothing;

-- Non-void order_item on manager_a's walk-in order (makes report_top_products testable)
insert into public.order_items
  (id, tenant_id, order_id, product_id, qty, unit_price, is_void)
values
  ('aaaaaaaa-0107-4000-8000-000000000002',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-0a02-4000-8000-000000000007',
   'aaaaaaaa-c0de-4000-8000-000000000002',   -- Mineral Water (A catalog)
   2, 400, false)
on conflict (id) do nothing;

-- Tenant-A closed shift owned by manager_a (Block C regression fixture)
insert into public.shifts
  (id, tenant_id, branch_id, manager_id,
   opened_at, closed_at,
   opening_cash, expected_cash, actual_cash, difference, status)
values
  ('aaaaaaaa-5f02-4000-8000-000000000007',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000002',   -- manager_a
   '2026-06-01 18:00:00+00', '2026-06-01 22:00:00+00',
   30000, 35800, 35800, 0, 'closed')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Switch to Tenant-A OWNER (Owner Alpha) — is_tenant_owner() = true
-- ---------------------------------------------------------------------------
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'owner',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

-- ===========================================================================
-- BLOCK A — Tenant-data isolation as A-owner (tests 1–5)
-- RPC range: all of 2026 (wide; captures all fixture rows).
-- p_cutover = 6 (matches seed business_day setting for both tenants).
-- ===========================================================================

-- 1. report_revenue_by_day: gross sum must equal A-only total (13800).
--    A has: session 5e01 (6500) + walk-in 0a01 (1500) + session 5e02 (5000) + walk-in 0a02 (800) = 13800.
--    B's gross (9999+9000=18999) would raise this number if leaked.
select is(
  (select coalesce(sum(gross), 0)::bigint
   from public.report_revenue_by_day(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  13800::bigint,
  'report_revenue_by_day: A-owner sum(gross)=13800 — only A rows included (B excluded)');

-- 2. report_by_device: A has 2 devices (seed); B has 2. Only A's 2 visible.
--    Count=4 would indicate B device rows leaked.
select is(
  (select count(*)
   from public.report_by_device(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  2::bigint,
  'report_by_device: A-owner count=2 (A devices only; B devices excluded)');

-- 3. report_top_products: A sold 2 distinct products (Pepsi Can via 0a01, Mineral Water via 0a02).
--    B sold Coca Cola. Count=3 would indicate a B product row leaked.
select is(
  (select count(*)
   from public.report_top_products(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  2::bigint,
  'report_top_products: A-owner count=2 (Pepsi Can + Mineral Water; B product excluded)');

-- 4. report_payment_mix: A cash total = 13800 (5e01:6500 + 0a01:1500 + 5e02:5000 + 0a02:800).
--    B cash total would be 18999 if leaked.
select is(
  (select coalesce(sum(amount), 0)::bigint
   from public.report_payment_mix(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  13800::bigint,
  'report_payment_mix: A-owner sum(amount)=13800 — only A settlements included');

-- 5. report_shifts: A has 2 closed shifts (5f01 owned by owner_a, 5f02 owned by manager_a);
--    B has 1. Count=3 would indicate a B shift leaked.
select is(
  (select count(*)
   from public.report_shifts(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  2::bigint,
  'report_shifts: A-owner count=2 (5f01+5f02; B shift excluded)');

-- ===========================================================================
-- BLOCK B — Branch-filter isolation: A-owner + p_branch = B's branch (tests 6–10)
--
-- A-owner's RLS already scopes all base-table reads to Tenant-A rows. A has no
-- sessions, orders, or shifts in Tenant-B's branch. B's devices are invisible
-- to A-owner (RLS). Therefore every RPC must return zero rows — proving that a
-- crafted p_branch UUID cannot widen scope across tenants (ADR-0007 Decision 1.2).
-- ===========================================================================

-- 6. report_revenue_by_day with B's branch UUID
select is(
  (select count(*)
   from public.report_revenue_by_day(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     'bbbb0001-0000-4000-8000-bbbbbbbbbbbb'::uuid, 6)),
  0::bigint,
  'report_revenue_by_day: A-owner + B-branch returns 0 — crafted branch cannot cross tenant');

-- 7. report_by_device with B's branch UUID (B's devices invisible to A via RLS)
select is(
  (select count(*)
   from public.report_by_device(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     'bbbb0001-0000-4000-8000-bbbbbbbbbbbb'::uuid, 6)),
  0::bigint,
  'report_by_device: A-owner + B-branch returns 0 — B devices invisible, branch only narrows');

-- 8. report_top_products with B's branch UUID
select is(
  (select count(*)
   from public.report_top_products(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     'bbbb0001-0000-4000-8000-bbbbbbbbbbbb'::uuid, 6)),
  0::bigint,
  'report_top_products: A-owner + B-branch returns 0 — B orders invisible to A-owner');

-- 9. report_payment_mix with B's branch UUID
select is(
  (select count(*)
   from public.report_payment_mix(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     'bbbb0001-0000-4000-8000-bbbbbbbbbbbb'::uuid, 6)),
  0::bigint,
  'report_payment_mix: A-owner + B-branch returns 0 — B sessions/orders invisible');

-- 10. report_shifts with B's branch UUID
select is(
  (select count(*)
   from public.report_shifts(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     'bbbb0001-0000-4000-8000-bbbbbbbbbbbb'::uuid, 6)),
  0::bigint,
  'report_shifts: A-owner + B-branch returns 0 — B shifts invisible to A-owner');

-- ===========================================================================
-- BLOCK C — Owner gate: manager (non-owner) calling any RPC gets 0 rows
-- (ADR-0007 Decision 8: is_tenant_owner() in each function's WHERE clause)
--
-- The regression fixtures above (aaaaaaaa-5e02/0a02/5f02/0107-…-000000000007)
-- are owned by manager_a (manager_id = …000000000002).  Base-table RLS allows
-- manager_a to read their own rows via the manager_id = auth.uid() branch.
-- Therefore, if the in-function is_tenant_owner() gate were deleted, these
-- fixtures would produce non-zero rows — turning the tests into genuine
-- regression guards for ADR-0007 Decision 8.
-- ===========================================================================

-- Switch JWT to Manager Alpha (same Tenant A, role='manager').
-- is_tenant_owner() = false because current_role_in_tenant() = 'manager' ≠ 'owner'.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'manager',
      'is_super_admin', false
    )
  )::text,
  true
);

-- 11. report_revenue_by_day: manager gets 0 rows despite owning fixtures in range.
--     If is_tenant_owner() were removed from the function body, the manager_a-owned
--     session (grand_total=5000) and walk-in order (total=800) would appear.
select is(
  (select count(*)
   from public.report_revenue_by_day(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  0::bigint,
  'report_revenue_by_day: manager owns fixtures in range but in-function is_tenant_owner() gate returns 0');

-- 12. report_by_device: manager gets 0 rows.
--     Devices are staff-readable (no manager_id column); the in-function gate
--     is the sole blocker here too — always was (no base-table ambiguity).
select is(
  (select count(*)
   from public.report_by_device(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  0::bigint,
  'report_by_device: manager (non-owner) gets 0 rows — in-function is_tenant_owner() gate');

-- 13. report_top_products: manager gets 0 rows despite owning the walk-in order
--     (aaaaaaaa-0a02) whose order_item (Mineral Water × 2) is in range.
select is(
  (select count(*)
   from public.report_top_products(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  0::bigint,
  'report_top_products: manager owns order_item in range but in-function is_tenant_owner() gate returns 0');

-- 14. report_payment_mix: manager gets 0 rows despite owning session + walk-in fixtures.
select is(
  (select count(*)
   from public.report_payment_mix(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  0::bigint,
  'report_payment_mix: manager owns fixtures in range but in-function is_tenant_owner() gate returns 0');

-- 15. report_shifts: manager gets 0 rows despite owning the shift (aaaaaaaa-5f02).
select is(
  (select count(*)
   from public.report_shifts(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  0::bigint,
  'report_shifts: manager owns shift in range but in-function is_tenant_owner() gate returns 0');

select * from finish();
rollback;
