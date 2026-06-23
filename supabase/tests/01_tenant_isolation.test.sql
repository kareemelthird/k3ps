-- =============================================================================
-- 01_tenant_isolation.test.sql — pgTAP tenant-isolation proof (rls-tenant-audit)
--
-- Acting as an AUTHENTICATED Tenant-A user (Owner Alpha), proves Tenant A can
-- never read or write Tenant B's rows: SELECT excludes B, cross-tenant INSERT is
-- rejected by WITH CHECK, and UPDATE/DELETE of B rows affect 0 rows. Includes a
-- positive control (A can act on its own rows).
--
-- Depends on seed.sql (Tenant A = aaaaaaaa…, Tenant B = bbbbbbbb…).
-- Run: supabase test db  (local Supabase stack / Docker, or CI).
-- =============================================================================

begin;
select plan(14);

-- --- Simulate Tenant-A owner: set the signed JWT claims, then drop to the
--     non-superuser `authenticated` role so RLS actually applies. -------------
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

select throws_ok(
  $$ insert into public.devices (id, tenant_id, branch_id, name, device_type, status, sort_order, is_active)
     values ('cccccccc-de01-4000-8000-000000000099',
             'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
             'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
             'Hijacked', 'PS5', 'free', 9, true) $$,
  '42501',
  'devices: cross-tenant INSERT (tenant_id=B) rejected by WITH CHECK');

select is(
  (with u as (
     update public.devices set name = 'pwned'
     where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'
     returning 1)
   select count(*) from u),
  0::bigint, 'devices: UPDATE of B rows affects 0 rows');

select is(
  (with d as (
     delete from public.devices
     where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'
     returning 1)
   select count(*) from d),
  0::bigint, 'devices: DELETE of B rows affects 0 rows');

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
select is((select count(*) from public.products), 3::bigint,
  'products: A sees exactly its own 3 rows');
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
select is((select count(*) from public.settings), 4::bigint,
  'settings: A sees exactly its own 4 keys');
select is((select count(*) from public.settings
            where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint, 'settings: A sees 0 of B''s rows');

select * from finish();
rollback;
