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
--   Tenant-A: 1 closed session (grand_total=6500, cash) +
--             1 walk-in order (total=1500, cash)  → gross total = 8000
--   Tenant-B: 1 closed session (grand_total=9999, cash) +
--             1 walk-in order (total=9000, cash)  → gross total = 18999
--   If B-data leaks into A-owner's RPC result, the sum assertion (8000) fails.
--
-- Plan: 15 tests.
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
  ('aaaaaaaa-se01-4000-8000-000000000007',
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
  ('bbbbbbbb-se01-4000-8000-000000000007',
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
  ('aaaaaaaa-ow01-4000-8000-000000000007',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000001',
   1500, 'paid', 'cash', '2026-06-01 10:00:00+00')
on conflict (id) do nothing;

-- Tenant-B walk-in paid order — MUST be invisible to A-owner via RLS
insert into public.orders
  (id, tenant_id, branch_id, manager_id, total, status, payment_method, created_at)
values
  ('bbbbbbbb-ow01-4000-8000-000000000007',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
   '00000000-0000-4000-8000-000000000003',
   9000, 'paid', 'cash', '2026-06-01 10:00:00+00')
on conflict (id) do nothing;

-- Tenant-A order_item on A walk-in (Pepsi Can, qty=3 × 500 = 1500 revenue)
insert into public.order_items
  (id, tenant_id, order_id, product_id, qty, unit_price, is_void)
values
  ('aaaaaaaa-oi07-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-ow01-4000-8000-000000000007',
   'aaaaaaaa-c0de-4000-8000-000000000001',
   3, 500, false)
on conflict (id) do nothing;

-- Tenant-B order_item on B walk-in (Coca Cola, qty=15 × 600 = 9000 revenue)
-- MUST be invisible to A-owner's report_top_products call
insert into public.order_items
  (id, tenant_id, order_id, product_id, qty, unit_price, is_void)
values
  ('bbbbbbbb-oi07-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbbbbbb-ow01-4000-8000-000000000007',
   'bbbbbbbb-c0de-4000-8000-000000000001',
   15, 600, false)
on conflict (id) do nothing;

-- Tenant-A closed shift (branch 1; zero-variance for clean assertion)
insert into public.shifts
  (id, tenant_id, branch_id, manager_id,
   opened_at, closed_at,
   opening_cash, expected_cash, actual_cash, difference, status)
values
  ('aaaaaaaa-sf01-4000-8000-000000000007',
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
  ('bbbbbbbb-sf01-4000-8000-000000000007',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
   '00000000-0000-4000-8000-000000000003',
   '2026-06-01 06:00:00+00', '2026-06-01 18:00:00+00',
   20000, 29000, 28000, -1000, 'closed')
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

-- 1. report_revenue_by_day: gross sum must equal A-only total (8000).
--    B's gross (9999+9000=18999) would raise this number if leaked.
select is(
  (select coalesce(sum(gross), 0)
   from public.report_revenue_by_day(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  8000::bigint,
  'report_revenue_by_day: A-owner sum(gross)=8000 — only A rows included (B excluded)');

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

-- 3. report_top_products: A sold Pepsi Can (1 distinct product).
--    B sold Coca Cola. Count=2 would indicate B product row leaked.
select is(
  (select count(*)
   from public.report_top_products(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  1::bigint,
  'report_top_products: A-owner count=1 (A product only; B product excluded)');

-- 4. report_payment_mix: A cash total = 8000 (session 6500 + walk-in 1500).
--    B cash total would be 18999 if leaked.
select is(
  (select coalesce(sum(amount), 0)
   from public.report_payment_mix(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  8000::bigint,
  'report_payment_mix: A-owner sum(amount)=8000 — only A settlements included');

-- 5. report_shifts: A has 1 closed shift; B has 1. Only A's is visible.
--    Count=2 would indicate B shift leaked.
select is(
  (select count(*)
   from public.report_shifts(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  1::bigint,
  'report_shifts: A-owner count=1 (A shift only; B shift excluded)');

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

-- 11. report_revenue_by_day: manager gets 0 rows (owner gate rejects)
select is(
  (select count(*)
   from public.report_revenue_by_day(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  0::bigint,
  'report_revenue_by_day: manager (non-owner) gets 0 rows — is_tenant_owner() gate');

-- 12. report_by_device: manager gets 0 rows (owner gate rejects)
select is(
  (select count(*)
   from public.report_by_device(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  0::bigint,
  'report_by_device: manager (non-owner) gets 0 rows — is_tenant_owner() gate');

-- 13. report_top_products: manager gets 0 rows (owner gate rejects)
select is(
  (select count(*)
   from public.report_top_products(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  0::bigint,
  'report_top_products: manager (non-owner) gets 0 rows — is_tenant_owner() gate');

-- 14. report_payment_mix: manager gets 0 rows (owner gate rejects)
select is(
  (select count(*)
   from public.report_payment_mix(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  0::bigint,
  'report_payment_mix: manager (non-owner) gets 0 rows — is_tenant_owner() gate');

-- 15. report_shifts: manager gets 0 rows (owner gate rejects)
select is(
  (select count(*)
   from public.report_shifts(
     '2026-01-01 00:00:00+00'::timestamptz,
     '2027-01-01 00:00:00+00'::timestamptz,
     null, 6)),
  0::bigint,
  'report_shifts: manager (non-owner) gets 0 rows — is_tenant_owner() gate');

select * from finish();
rollback;
