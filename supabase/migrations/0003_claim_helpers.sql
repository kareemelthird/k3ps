-- =============================================================================
-- Migration 0003 — JWT claim helpers & role-resolution functions
--
-- These SECURITY DEFINER functions read ONLY the signed JWT app_metadata claim.
-- They NEVER read user_metadata, request headers, or client-supplied columns.
-- Every call is wrapped in (select ...) at the call site for initPlan caching.
--
-- SECURITY REVIEWER GATE: Every helper here must be reviewed for:
--   1. No cross-tenant data returned.
--   2. Reads app_metadata only (never user_metadata / body / header).
--   3. SECURITY DEFINER with explicit search_path = public.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- current_tenant_id()
-- Returns the active tenant UUID from the signed JWT app_metadata claim.
-- Returns NULL if the claim is absent or invalid (blocks all tenant policies).
-- ---------------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select nullif(
    (auth.jwt() -> 'app_metadata' ->> 'tenant_id'),
    ''
  )::uuid;
$$;

-- ---------------------------------------------------------------------------
-- current_role_in_tenant()
-- Returns the caller's role for their active tenant (from app_metadata.roles).
-- ---------------------------------------------------------------------------
create or replace function public.current_role_in_tenant()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select auth.jwt() -> 'app_metadata' ->> 'roles';
$$;

-- ---------------------------------------------------------------------------
-- is_super_admin()
-- True iff the caller's JWT carries is_super_admin=true in app_metadata.
-- The Custom Access Token Hook sets this from profiles.is_platform_admin.
-- ---------------------------------------------------------------------------
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'is_super_admin')::boolean,
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- is_active_member()
-- True iff the caller has an active tenant_members row AND the tenant is active.
-- This check is INDEPENDENT of token freshness: even if the token was minted
-- before a suspension, is_active_member() will gate them out immediately
-- (ADR-0003 freshness strategy).
-- ---------------------------------------------------------------------------
create or replace function public.is_active_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tenant_members m
    join public.tenants t on t.id = m.tenant_id
    where
      m.tenant_id  = (select public.current_tenant_id())
      and m.profile_id = (select auth.uid())
      and m.is_active  = true
      and t.status     = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- is_tenant_owner()
-- True iff the caller is an active member of their active tenant with role=owner.
-- ---------------------------------------------------------------------------
create or replace function public.is_tenant_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    (select public.current_role_in_tenant()) = 'owner'
    and (select public.is_active_member());
$$;

-- ---------------------------------------------------------------------------
-- is_tenant_staff()
-- True iff the caller is any active member of their active tenant
-- (owner OR manager OR staff — anyone with a valid active membership).
-- ---------------------------------------------------------------------------
create or replace function public.is_tenant_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (select public.is_active_member());
$$;

-- ---------------------------------------------------------------------------
-- auth_tenant_ids()
-- Returns all tenant UUIDs the caller is an active member of.
-- Used for multi-tenant membership queries (e.g. listing tenants for a user).
-- NOTE: Most policies use current_tenant_id() (the active tenant).
-- This function is for the token-hook and admin surfaces only.
-- ---------------------------------------------------------------------------
create or replace function public.auth_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.tenant_id
  from public.tenant_members m
  join public.tenants t on t.id = m.tenant_id
  where
    m.profile_id = (select auth.uid())
    and m.is_active = true
    and t.status    = 'active';
$$;

-- =============================================================================
-- END OF MIGRATION 0003
-- =============================================================================
