-- =============================================================================
-- 01_tenant_isolation.test.sql — pgTAP tenant-isolation proof (rls-tenant-audit)
--
-- Acting as an AUTHENTICATED Tenant-A user (Owner Alpha), proves Tenant A can
-- never read or write Tenant B's rows: SELECT excludes B, cross-tenant INSERT is
-- rejected by WITH CHECK, and UPDATE/DELETE of B rows affect 0 rows. Includes a
-- positive control (A can act on its own rows).
--
-- Phase-5 extension (ADR-0006 AC 13/38): adds authenticated-role RLS coverage
-- for orders, order_items, stock_movements, shifts, and audit_log; role-split
-- test for stock_movements (manager vs owner, reason='adjust'); and positive
-- controls for every new write surface.
--
-- Depends on seed.sql (Tenant A = aaaaaaaa…, Tenant B = bbbbbbbb…).
-- Run: supabase test db  (local Supabase stack / Docker, or CI).
-- =============================================================================

begin;
select plan(32);

-- ---------------------------------------------------------------------------
-- FIXTURE SETUP (as superuser, before switching to authenticated role)
--
-- Insert minimal Tenant-A and Tenant-B rows for orders/order_items so we can
-- test UPDATE-cross-tenant (a) and SELECT isolation counts.
-- All fixture writes are inside this transaction and are rolled back at the end.
-- UUID legend:
--   aaaaaaaa-0d01-… : Tenant-A fixture order (for SELECT count + order_item FK)
--   bbbbbbbb-0d01-… : Tenant-B fixture order
--   bbbbbbbb-1101-… : Tenant-B fixture order_item (for UPDATE-isolation test a)
-- ---------------------------------------------------------------------------

insert into public.orders
  (id, tenant_id, branch_id, manager_id, total, status)
values
  -- Tenant A — fixture order (positive control anchor)
  ('aaaaaaaa-0d01-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000001',
   0, 'open'),
  -- Tenant B — fixture order (must stay invisible to Tenant-A authenticated user)
  ('bbbbbbbb-0d01-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
   '00000000-0000-4000-8000-000000000003',
   0, 'open')
on conflict (id) do nothing;

-- Tenant-B order_item attached to the Tenant-B order above.
-- Used in test (a): as Tenant-A owner, UPDATE should affect 0 rows.
insert into public.order_items
  (id, tenant_id, order_id, product_id, qty, unit_price)
values
  ('bbbbbbbb-1101-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbbbbbb-0d01-4000-8000-000000000001',
   'bbbbbbbb-c0de-4000-8000-000000000001',
   1, 600)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Simulate Tenant-A owner (Owner Alpha): set the signed JWT claims, then drop
-- to the non-superuser `authenticated` role so RLS actually applies.
-- ---------------------------------------------------------------------------
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000001',     -- Owner Alpha
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',  -- Tenant A
      'roles',          'owner',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

-- ---------------------------------------------------------------------------
-- DEVICES — full CRUD isolation matrix
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.devices),
  2::bigint, 'devices: A sees exactly its own 2 rows');

select is(
  (select count(*) from public.devices
    where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint, 'devices: A sees 0 of B''s rows (SELECT isolated)');

-- 4-arg throws_ok: check SQLSTATE 42501 only (message text varies). NULL errmsg.
select throws_ok(
  $$ insert into public.devices (id, tenant_id, branch_id, name, device_type, status, sort_order, is_active)
     values ('cccccccc-de01-4000-8000-000000000099',
             'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
             'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
             'Hijacked', 'PS5', 'free', 9, true) $$,
  '42501', NULL,
  'devices: cross-tenant INSERT (tenant_id=B) rejected by WITH CHECK');

-- Data-modifying CTE must be at statement top level (not inside a sub-select).
with u as (
  update public.devices set name = 'pwned'
  where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'
  returning 1)
select is((select count(*) from u), 0::bigint,
  'devices: UPDATE of B rows affects 0 rows');

with d as (
  delete from public.devices
  where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'
  returning 1)
select is((select count(*) from d), 0::bigint,
  'devices: DELETE of B rows affects 0 rows');

select lives_ok(
  $$ insert into public.devices (id, tenant_id, branch_id, name, device_type, status, sort_order, is_active)
     values ('aaaaaaaa-de01-4000-8000-000000000099',
             'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
             'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
             'Alpha New', 'PS5', 'free', 9, true) $$,
  'devices: A CAN insert its own row (positive control)');

-- ---------------------------------------------------------------------------
-- PRODUCTS — SELECT isolation
-- ---------------------------------------------------------------------------
select is((select count(*) from public.products), 7::bigint,
  'products: A sees exactly its own 7 rows');
select is((select count(*) from public.products
            where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint, 'products: A sees 0 of B''s rows');

-- ---------------------------------------------------------------------------
-- BRANCHES — SELECT isolation
-- ---------------------------------------------------------------------------
select is((select count(*) from public.branches), 2::bigint,
  'branches: A sees exactly its own 2 rows');
select is((select count(*) from public.branches
            where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint, 'branches: A sees 0 of B''s rows');

-- ---------------------------------------------------------------------------
-- RATE_RULES — SELECT isolation
-- ---------------------------------------------------------------------------
select is((select count(*) from public.rate_rules), 3::bigint,
  'rate_rules: A sees exactly its own 3 rows');
select is((select count(*) from public.rate_rules
            where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint, 'rate_rules: A sees 0 of B''s rows');

-- ---------------------------------------------------------------------------
-- SETTINGS — SELECT isolation (per-tenant key/value)
-- ---------------------------------------------------------------------------
select is((select count(*) from public.settings), 5::bigint,
  'settings: A sees exactly its own 5 keys');
select is((select count(*) from public.settings
            where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint, 'settings: A sees 0 of B''s rows');

-- ===========================================================================
-- PHASE-5 EXTENSION — orders, order_items, stock_movements, shifts, audit_log
-- (ADR-0006 AC 13/38 — regression guard for RLS-touching changes)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- ORDERS — SELECT isolation (owner_a can see A's orders, not B's)
--
-- The fixture setup inserted 1 Tenant-A order and 1 Tenant-B order as
-- superuser.  As authenticated Tenant-A owner, only A's row must be visible.
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.orders
    where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'orders: A sees 0 of B''s rows (SELECT isolated)');

-- Positive SELECT: fixture Tenant-A order must be visible.
select is(
  (select count(*) from public.orders
    where tenant_id = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'),
  1::bigint,
  'orders: A sees exactly its own 1 fixture row (positive SELECT control)');

-- ---------------------------------------------------------------------------
-- ORDER_ITEMS — (a) UPDATE of a Tenant-B row affects 0 rows
--
-- The USING clause hides all Tenant-B rows from Tenant-A's session, so
-- an UPDATE targeting them by ID returns 0 affected rows (no error, just
-- invisible — same as the devices/DELETE pattern above).
-- ---------------------------------------------------------------------------
with void_b as (
  update public.order_items
    set is_void = true, voided_at = now()
    where id = 'bbbbbbbb-1101-4000-8000-000000000001'
  returning 1)
select is(
  (select count(*) from void_b),
  0::bigint,
  'order_items: (a) UPDATE of B''s row (is_void=true) affects 0 rows — RLS USING hides it');

-- SELECT isolation: no Tenant-B order_items visible.
select is(
  (select count(*) from public.order_items
    where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'order_items: A sees 0 of B''s rows (SELECT isolated)');

-- ---------------------------------------------------------------------------
-- (b) CROSS-TENANT INSERT ATTEMPTS — all must raise SQLSTATE 42501
--
-- In each case: tenant_id=B while current_tenant_id()=A.  The WITH CHECK on
-- every policy uses `tenant_id = current_tenant_id()` as its first predicate,
-- which evaluates B = A → false → permission denied.
-- ---------------------------------------------------------------------------

-- orders: WITH CHECK (tenant_id = current_tenant_id() AND manager_id = auth.uid() ...)
select throws_ok(
  $$ insert into public.orders
       (id, tenant_id, branch_id, manager_id, total, status)
     values ('cccccccc-0d01-4000-8000-000000000099',
             'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
             'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
             '00000000-0000-4000-8000-000000000001',
             0, 'open') $$,
  '42501', NULL,
  'orders: (b) cross-tenant INSERT (tenant_id=B) rejected by WITH CHECK');

-- order_items: WITH CHECK (tenant_id = current_tenant_id() AND parent EXISTS ...)
select throws_ok(
  $$ insert into public.order_items
       (id, tenant_id, order_id, product_id, qty, unit_price)
     values ('cccccccc-1101-4000-8000-000000000099',
             'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
             'bbbbbbbb-0d01-4000-8000-000000000001',
             'bbbbbbbb-c0de-4000-8000-000000000001',
             1, 600) $$,
  '42501', NULL,
  'order_items: (b) cross-tenant INSERT (tenant_id=B) rejected by WITH CHECK');

-- stock_movements: WITH CHECK (tenant_id = current_tenant_id() AND is_tenant_staff() ...)
select throws_ok(
  $$ insert into public.stock_movements
       (id, tenant_id, branch_id, product_id, delta, reason)
     values ('cccccccc-5901-4000-8000-000000000099',
             'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
             'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
             'bbbbbbbb-c0de-4000-8000-000000000001',
             10, 'restock') $$,
  '42501', NULL,
  'stock_movements: (b) cross-tenant INSERT (tenant_id=B) rejected by WITH CHECK');

-- shifts: WITH CHECK (tenant_id = current_tenant_id() AND manager_id = auth.uid() ...)
select throws_ok(
  $$ insert into public.shifts
       (id, tenant_id, branch_id, manager_id, opening_cash, status)
     values ('cccccccc-5110-4000-8000-000000000099',
             'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
             'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
             '00000000-0000-4000-8000-000000000001',
             0, 'open') $$,
  '42501', NULL,
  'shifts: (b) cross-tenant INSERT (tenant_id=B) rejected by WITH CHECK');

-- audit_log: WITH CHECK (tenant_id = current_tenant_id() AND is_tenant_staff())
select throws_ok(
  $$ insert into public.audit_log
       (id, tenant_id, actor_id, action, entity, amount)
     values ('cccccccc-a091-4000-8000-000000000099',
             'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
             '00000000-0000-4000-8000-000000000001',
             'void_order_item', 'order_items', 600) $$,
  '42501', NULL,
  'audit_log: (b) cross-tenant INSERT (tenant_id=B) rejected by WITH CHECK');

-- ---------------------------------------------------------------------------
-- SHIFTS — SELECT isolation
-- No shifts are seeded; Tenant-A fixture inserts below (positive control d).
-- As owner_a, the USING clause (manager_id=uid OR is_tenant_owner()) allows
-- reading all Tenant-A shifts; zero Tenant-B rows must leak.
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.shifts
    where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'shifts: A sees 0 of B''s rows (SELECT isolated)');

-- ---------------------------------------------------------------------------
-- STOCK_MOVEMENTS — SELECT isolation
-- No movements seeded; Tenant-A fixtures inserted in role-split tests below.
-- Zero Tenant-B rows must be visible to Tenant-A staff.
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.stock_movements
    where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'stock_movements: A sees 0 of B''s rows (SELECT isolated)');

-- ---------------------------------------------------------------------------
-- AUDIT_LOG — SELECT isolation
-- Policy: owner-read only (is_tenant_owner()). No audit rows are seeded.
-- Zero Tenant-B rows must be visible to Tenant-A owner.
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.audit_log
    where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'audit_log: A sees 0 of B''s rows (SELECT isolated)');

-- ---------------------------------------------------------------------------
-- (c) ROLE SPLIT — stock_movements reason='adjust' (owner-only gate, AC 31a)
--
-- Switch to Manager Alpha (same tenant A, role=manager) — is_tenant_staff()
-- passes but is_tenant_owner() fails.  The stock_movements_staff_insert policy
-- WITH CHECK: tenant_id=A AND is_tenant_staff() AND (reason<>'adjust' OR is_owner).
--
-- Test 1: manager + reason='restock' → succeeds (reason<>'adjust' is true).
-- Test 2: manager + reason='adjust'  → rejected 42501 (is_owner false).
-- Test 3: switch back to owner_a; reason='adjust' → succeeds.
-- ---------------------------------------------------------------------------

-- Switch JWT to Manager Alpha (uid ...0002, role='manager').
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000002',     -- Manager Alpha
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',  -- Tenant A
      'roles',          'manager',
      'is_super_admin', false
    )
  )::text,
  true
);

-- (c-1) Manager A: INSERT reason='restock' succeeds (non-adjust, staff allowed).
select lives_ok(
  $$ insert into public.stock_movements
       (id, tenant_id, branch_id, product_id, delta, reason, manager_id)
     values ('aaaaaaaa-5901-4000-8000-000000000001',
             'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
             'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
             'aaaaaaaa-c0de-4000-8000-000000000001',
             10, 'restock',
             '00000000-0000-4000-8000-000000000002') $$,
  'stock_movements: (c) manager_a INSERT reason=restock succeeds (non-adjust allowed)');

-- (c-2) Manager A: INSERT reason='adjust' rejected — only owner may adjust.
select throws_ok(
  $$ insert into public.stock_movements
       (id, tenant_id, branch_id, product_id, delta, reason, manager_id)
     values ('aaaaaaaa-5901-4000-8000-000000000002',
             'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
             'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
             'aaaaaaaa-c0de-4000-8000-000000000001',
             -5, 'adjust',
             '00000000-0000-4000-8000-000000000002') $$,
  '42501', NULL,
  'stock_movements: (c) manager_a INSERT reason=adjust rejected 42501 (owner-only gate)');

-- Switch JWT back to Owner Alpha (uid ...0001, role='owner').
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000001',     -- Owner Alpha
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',  -- Tenant A
      'roles',          'owner',
      'is_super_admin', false
    )
  )::text,
  true
);

-- (c-3) Owner A: INSERT reason='adjust' succeeds (is_tenant_owner() = true).
select lives_ok(
  $$ insert into public.stock_movements
       (id, tenant_id, branch_id, product_id, delta, reason, manager_id)
     values ('aaaaaaaa-5902-4000-8000-000000000001',
             'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
             'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
             'aaaaaaaa-c0de-4000-8000-000000000001',
             -3, 'adjust',
             '00000000-0000-4000-8000-000000000001') $$,
  'stock_movements: (c) owner_a INSERT reason=adjust succeeds (is_tenant_owner passes)');

-- ---------------------------------------------------------------------------
-- (d) POSITIVE CONTROLS — Tenant-A owner can INSERT and SELECT own rows
--
-- Confirms the RLS policies do NOT over-restrict the legitimate owner path.
-- UUIDs chosen to avoid conflicts with seed.sql and test 02.
-- ---------------------------------------------------------------------------

-- (d-1) Owner A inserts own order.
select lives_ok(
  $$ insert into public.orders
       (id, tenant_id, branch_id, manager_id, total, status)
     values ('aaaaaaaa-0d02-4000-8000-000000000001',
             'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
             'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
             '00000000-0000-4000-8000-000000000001',
             0, 'open') $$,
  'orders: (d) owner_a INSERT own order succeeds (positive control)');

-- (d-2) Owner A inserts own order_item on the fixture Tenant-A order.
--       is_tenant_owner() makes the parent EXISTS pass for any A order.
select lives_ok(
  $$ insert into public.order_items
       (id, tenant_id, order_id, product_id, qty, unit_price)
     values ('aaaaaaaa-1102-4000-8000-000000000001',
             'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
             'aaaaaaaa-0d01-4000-8000-000000000001',
             'aaaaaaaa-c0de-4000-8000-000000000001',
             2, 500) $$,
  'order_items: (d) owner_a INSERT own order_item succeeds (positive control)');

-- (d-3) Owner A inserts own shift (manager_id = auth.uid() is required by INSERT policy).
--       Using branch aaaa0002 to avoid unique-index conflict with other in-transaction shifts.
select lives_ok(
  $$ insert into public.shifts
       (id, tenant_id, branch_id, manager_id, opening_cash, status)
     values ('aaaaaaaa-5101-4000-8000-000000000001',
             'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
             'aaaa0002-0000-4000-8000-aaaaaaaaaaaa',
             '00000000-0000-4000-8000-000000000001',
             50000, 'open') $$,
  'shifts: (d) owner_a INSERT own shift succeeds (positive control)');

select * from finish();
rollback;
