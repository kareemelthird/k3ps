-- =============================================================================
-- seed.sql — Development seed data
--
-- Creates ≥2 tenants (A and B) with branches, devices, rate_rules, products,
-- and members so that the rls-tenant-audit isolation tests can demonstrate
-- tenant A cannot read/write tenant B's rows.
--
-- UUIDs are fixed and deterministic for reproducible tests. Every id is a
-- valid RFC-4122 UUID (8-4-4-4-12 hex); the 2nd group encodes the entity type
-- (de01=device, 44ee=rate_rule, c0de=product) purely for human readability.
-- All money columns are integer piastres (100 = 1 EGP).
-- WARNING: Do NOT run this against production. Dev/CI only.
-- =============================================================================

-- =============================================================================
-- AUTH USERS (for local Supabase / CI use)
-- =============================================================================
-- These are created via Supabase Auth in real tests; here we use
-- placeholder IDs for the seed data cross-references.

-- Tenant A users
-- owner_a:   00000000-0000-4000-8000-000000000001
-- manager_a: 00000000-0000-4000-8000-000000000002
-- Tenant B users
-- owner_b:   00000000-0000-4000-8000-000000000003
-- manager_b: 00000000-0000-4000-8000-000000000004
-- Super admin
-- super:     00000000-0000-4000-8000-000000000005

-- =============================================================================
-- PROFILES
-- =============================================================================

insert into public.profiles (id, full_name, is_platform_admin, is_active)
values
  -- Tenant A
  ('00000000-0000-4000-8000-000000000001', 'Owner Alpha',        false, true),
  ('00000000-0000-4000-8000-000000000002', 'Manager Alpha',      false, true),
  -- Tenant B
  ('00000000-0000-4000-8000-000000000003', 'Owner Bravo',        false, true),
  ('00000000-0000-4000-8000-000000000004', 'Manager Bravo',      false, true),
  -- Super admin
  ('00000000-0000-4000-8000-000000000005', 'Platform Admin',     true,  true)
on conflict (id) do nothing;

-- =============================================================================
-- TENANTS
-- =============================================================================

insert into public.tenants (id, name, status)
values
  ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'Alpha Café',  'active'),
  ('bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', 'Bravo Lounge', 'active')
on conflict (id) do nothing;

-- =============================================================================
-- BRANCHES
-- =============================================================================

insert into public.branches (id, tenant_id, name, is_active)
values
  -- Tenant A branches
  ('aaaa0001-0000-4000-8000-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'Alpha Main Branch', true),
  ('aaaa0002-0000-4000-8000-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'Alpha Second Branch', true),
  -- Tenant B branches
  ('bbbb0001-0000-4000-8000-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', 'Bravo Main Branch', true)
on conflict (id) do nothing;

-- =============================================================================
-- TENANT MEMBERS
-- =============================================================================

insert into public.tenant_members (tenant_id, profile_id, role, is_active)
values
  -- Tenant A
  ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'owner',   true),
  ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000002', 'manager', true),
  -- Tenant B
  ('bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', '00000000-0000-4000-8000-000000000003', 'owner',   true),
  ('bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', '00000000-0000-4000-8000-000000000004', 'manager', true)
on conflict (tenant_id, profile_id) do nothing;

-- =============================================================================
-- DEVICES
-- =============================================================================

insert into public.devices (id, tenant_id, branch_id, name, device_type, status, sort_order, is_active)
values
  -- Tenant A, Branch 1
  ('aaaaaaaa-de01-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'aaaa0001-0000-4000-8000-aaaaaaaaaaaa', 'PS5 Alpha 1', 'PS5', 'free', 1, true),
  ('aaaaaaaa-de01-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'aaaa0001-0000-4000-8000-aaaaaaaaaaaa', 'PS4 Alpha 2', 'PS4', 'free', 2, true),
  -- Tenant B, Branch 1
  ('bbbbbbbb-de01-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', 'bbbb0001-0000-4000-8000-bbbbbbbbbbbb', 'PS5 Bravo 1', 'PS5', 'free', 1, true),
  ('bbbbbbbb-de01-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', 'bbbb0001-0000-4000-8000-bbbbbbbbbbbb', 'PS4 Bravo 2', 'PS4', 'free', 2, true)
on conflict (id) do nothing;

-- =============================================================================
-- RATE RULES (piastres: 1 EGP = 100 piastres)
-- =============================================================================

insert into public.rate_rules (
  id, tenant_id, device_type, play_mode, billing_mode, day_type,
  price_per_hour, rounding_minutes, min_charge_minutes, priority, is_active
)
values
  -- Tenant A: PS5 single weekday open
  ('aaaaaaaa-44ee-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'PS5', 'single', 'open', 'weekday',
   6000, 5, 0, 0, true),
  -- Tenant A: PS5 single weekend open (peak)
  ('aaaaaaaa-44ee-4000-8000-000000000002',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'PS5', 'single', 'open', 'weekend',
   8000, 5, 0, 10, true),
  -- Tenant A: PS4 any open (lower priority)
  ('aaaaaaaa-44ee-4000-8000-000000000003',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'PS4', 'any', 'open', 'any',
   5000, 5, 0, 0, true),
  -- Tenant B: PS5 single open
  ('bbbbbbbb-44ee-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'PS5', 'single', 'open', 'any',
   7000, 5, 0, 0, true),
  -- Tenant B: PS4 any open
  ('bbbbbbbb-44ee-4000-8000-000000000002',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'PS4', 'any', 'open', 'any',
   4500, 5, 0, 0, true)
on conflict (id) do nothing;

-- =============================================================================
-- PRODUCTS
-- =============================================================================

insert into public.products (id, tenant_id, name, category, price, cost, stock, is_active)
values
  -- Tenant A products
  ('aaaaaaaa-c0de-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'Pepsi Can',     'drinks',  500,  250, 100, true),
  ('aaaaaaaa-c0de-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'Lays Chips',    'snacks',  700,  350, 50,  true),
  ('aaaaaaaa-c0de-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'Water Bottle',  'drinks',  300,  100, null, true),  -- untracked
  -- Tenant B products
  ('bbbbbbbb-c0de-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', 'Coca Cola',     'drinks',  600,  300, 80,  true),
  ('bbbbbbbb-c0de-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', 'Energy Bar',    'snacks',  1200, 600, 30,  true)
on conflict (id) do nothing;

-- =============================================================================
-- SETTINGS
-- =============================================================================

insert into public.settings (tenant_id, key, value)
values
  ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'cafe_name',    '"Alpha Café"'),
  ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'currency',     '"EGP"'),
  ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'timezone',     '"Africa/Cairo"'),
  ('aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', 'schema_version', '2'),
  ('bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', 'cafe_name',    '"Bravo Lounge"'),
  ('bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', 'currency',     '"EGP"'),
  ('bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', 'timezone',     '"Africa/Cairo"'),
  ('bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', 'schema_version', '2')
on conflict (tenant_id, key) do nothing;

-- =============================================================================
-- PLATFORM SETTINGS
-- =============================================================================

insert into public.platform_settings (key, value)
values
  ('schema_version', '2'),
  ('max_branches_per_tenant', '10'),
  ('impersonation_max_ttl_seconds', '3600')
on conflict (key) do nothing;

-- =============================================================================
-- END OF SEED
-- =============================================================================
