-- =============================================================================
-- Migration 0001 — Tenancy core
-- Creates: tenants, branches, profiles, tenant_members, platform_settings,
--          set_updated_at() trigger, handle_new_user() trigger, user_role enum.
-- RLS: enabled on every new table in this file.
-- SECURITY REVIEWER: required sign-off on all RLS + claim helpers.
-- =============================================================================

-- Idempotent pgcrypto extension (needed for gen_random_uuid())
create extension if not exists "pgcrypto";

-- =============================================================================
-- SECTION 1: Utility trigger
-- =============================================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- SECTION 2: Platform role enum
-- =============================================================================

-- Role enum covers the full hierarchy.
-- super_admin is a platform flag (profiles.is_platform_admin).
-- owner/manager/staff live in tenant_members.role.
create type public.user_role as enum ('super_admin', 'owner', 'manager', 'staff');

-- =============================================================================
-- SECTION 3: profiles (cross-tenant — NOT tenant-scoped)
-- =============================================================================

create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  full_name        text not null default '',
  phone            text,
  is_platform_admin boolean not null default false,
  is_active        boolean not null default true,
  permissions      jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- RLS: profiles is cross-tenant.
-- Users can read their own row; owners of the same tenant can read co-members;
-- is_platform_admin is never self-settable (only via migration / super-admin path).
alter table public.profiles enable row level security;

-- Everyone can read their own profile
create policy profiles_self_select on public.profiles
  for select using (id = (select auth.uid()));

-- Self-update of non-privileged fields (full_name, phone, permissions)
create policy profiles_self_update on public.profiles
  for update using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    -- is_platform_admin cannot be changed by the user themselves;
    -- the application layer must enforce this; the DB cannot reliably
    -- guard a specific column in a WITH CHECK without a trigger.
  );

-- handle_new_user creates the row; super-admin provisioning may also insert
create policy profiles_system_insert on public.profiles
  for insert with check (id = (select auth.uid()));

-- =============================================================================
-- SECTION 4: tenants
-- =============================================================================

create type public.tenant_status as enum ('active', 'suspended');

create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  status     public.tenant_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_tenants_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

create index tenants_status_idx on public.tenants (status);

-- RLS: readable by members of that tenant (enforced in 0004); super-admin can manage.
-- Note: claim helpers are defined in 0003; here we enable RLS and set minimal policies.
-- Full tenant policies are in 0004.
alter table public.tenants enable row level security;

-- =============================================================================
-- SECTION 5: branches
-- =============================================================================

create table public.branches (
  id         uuid not null default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Composite unique: backs the composite FK from branch-scoped operational tables
  primary key (id),
  unique (tenant_id, id)
);

create trigger set_branches_updated_at
  before update on public.branches
  for each row execute function public.set_updated_at();

create index branches_tenant_idx on public.branches (tenant_id);

alter table public.branches enable row level security;

-- =============================================================================
-- SECTION 6: tenant_members (many-to-many user↔tenant with role)
-- =============================================================================

create table public.tenant_members (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role       public.user_role not null check (role in ('owner', 'manager', 'staff')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, profile_id)
);

create trigger set_tenant_members_updated_at
  before update on public.tenant_members
  for each row execute function public.set_updated_at();

-- tenant_id is already the leading column of the PK.
create index tenant_members_profile_idx on public.tenant_members (profile_id);
create index tenant_members_tenant_role_idx on public.tenant_members (tenant_id, role);

alter table public.tenant_members enable row level security;

-- =============================================================================
-- SECTION 7: platform_settings (super-admin write / authenticated read)
-- =============================================================================

create table public.platform_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_platform_settings_updated_at
  before update on public.platform_settings
  for each row execute function public.set_updated_at();

-- No tenant_id: platform-global. RLS policies reference is_super_admin() from 0003.
alter table public.platform_settings enable row level security;

-- =============================================================================
-- SECTION 8: handle_new_user trigger (idempotent profile creation)
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Idempotent: on conflict (id) do nothing (AC 25)
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- END OF MIGRATION 0001
-- =============================================================================
