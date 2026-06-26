-- =============================================================================
-- Migration 0011 — Plan cap: block reactivation bypass (Phase 9 follow-up)
--
-- Forward-only. Additive only — no existing policy, trigger, or index is altered.
--
-- PROBLEM (security finding): enforce_plan_cap fires only on BEFORE INSERT.
-- An owner can deactivate a resource (set is_active=false), insert a new resource
-- under the cap, then reactivate the old one — bypassing the cap entirely.
--
-- FIX: Add BEFORE UPDATE triggers with WHEN clauses that fire ONLY when a row
-- transitions from is_active=false → is_active=true (reactivation).
-- The WHEN clause is evaluated per-row BEFORE the trigger function is called:
--   * Normal UPDATEs (name, config, any field where is_active does not go false→true)
--     → trigger NEVER called (zero overhead on ordinary UPDATEs).
--   * Deactivation (true→false) → trigger NEVER called.
--   * Reactivation (false→true) → trigger called → enforce_plan_cap() counts
--     current active rows and blocks with 23514 if count >= plan limit.
--
-- The function body is identical to migration 0010.  CREATE OR REPLACE here
-- adds only the BEFORE UPDATE documentation comment; the business logic is
-- unchanged.  (Postgres triggers share the function; INSERT + UPDATE triggers
-- both call the same enforce_plan_cap().)
--
-- Service-role / seed / migration contexts skip via the same ADR-0008 guards
-- (request.jwt.claims absent OR role='service_role') — those paths are NEVER blocked.
--
-- errcode = 'check_violation' (23514) matches the INSERT path; the web
-- classifyError → 'permanent' → upgrade CTA path is unchanged.
--
-- SECURITY REVIEWER: additive trigger only; no policy change; no new SECURITY
-- DEFINER path.  Required sign-off to confirm the WHEN clause is structurally
-- correct and cannot be defeated.
-- =============================================================================

-- ── 1. Replace enforce_plan_cap() — logic identical; comment documents UPDATE ─
--
-- BEFORE INSERT: fired for every INSERT where is_active=true (new row).
--   Count = current active rows.  Reject if count >= limit (inserting would make
--   count+1 which exceeds the limit).
--
-- BEFORE UPDATE (reactivation path — guarded by WHEN clause on the trigger):
--   The WHEN clause ensures we only run here when OLD.is_active=false →
--   NEW.is_active=true.  The row being reactivated is STILL is_active=false in
--   the table at this point (BEFORE trigger fires before the change is applied).
--   Count = current active rows (does NOT include this row yet).
--   Reject if count >= limit (reactivating would make count+1 > limit).
--   Identical condition to INSERT — same function, no branching on TG_OP required.
create or replace function public.enforce_plan_cap()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  _claims text;
  _kind   text := tg_argv[0];      -- 'branches' | 'devices' | 'staff'
  _limit  int;
  _count  int;
begin
  -- (a) Skip when there is no PostgREST request context (migration/seed/psql).
  _claims := current_setting('request.jwt.claims', true);
  if coalesce(_claims, '') = '' then return new; end if;

  -- (b) Skip when the caller is the service_role (provision/comp/backfill).
  if (_claims::jsonb ->> 'role') = 'service_role' then return new; end if;

  -- (c) Resolve the tenant's effective plan limit.
  --     Fail OPEN (return NEW) if no subscription row resolves — never brick a tenant.
  select case _kind
           when 'branches' then p.max_branches
           when 'devices'  then p.max_devices
           when 'staff'    then p.max_staff
         end
    into _limit
  from public.subscriptions s
  join public.plans p on p.key = s.plan
  where s.tenant_id = new.tenant_id;

  if _limit is null then return new; end if;       -- no plan resolved → no cap applied

  -- (d) Count current ACTIVE rows for this tenant.
  --     For both INSERT and UPDATE (reactivation): the row being added/reactivated
  --     is NOT yet counted (BEFORE trigger fires before the row lands).
  --     Post-operation count = _count + 1.  Block when _count >= _limit.
  if _kind = 'branches' then
    select count(*) into _count
      from public.branches where tenant_id = new.tenant_id and is_active;
  elsif _kind = 'devices' then
    select count(*) into _count
      from public.devices where tenant_id = new.tenant_id and is_active;
  elsif _kind = 'staff' then
    select count(*) into _count
      from public.tenant_members where tenant_id = new.tenant_id and is_active;
  end if;

  -- (e) Reject if at or over the limit.
  if _count >= _limit then
    raise exception 'plan limit reached for % (max %)', _kind, _limit
      using errcode = 'check_violation';            -- 23514 → permanent → upgrade CTA
  end if;

  return new;
end;
$$;

-- ── 2. BEFORE UPDATE triggers — reactivation bypass fix ──────────────────────
--
-- WHEN clause: fires ONLY when is_active transitions false → true.
-- A normal UPDATE (name change, config, deactivation true→false, same value)
-- never matches the WHEN clause and incurs zero trigger overhead.

drop trigger if exists branches_plan_cap_update on public.branches;
create trigger branches_plan_cap_update
  before update on public.branches
  for each row
  when (new.is_active = true and old.is_active = false)
  execute function public.enforce_plan_cap('branches');

drop trigger if exists devices_plan_cap_update on public.devices;
create trigger devices_plan_cap_update
  before update on public.devices
  for each row
  when (new.is_active = true and old.is_active = false)
  execute function public.enforce_plan_cap('devices');

drop trigger if exists tenant_members_plan_cap_update on public.tenant_members;
create trigger tenant_members_plan_cap_update
  before update on public.tenant_members
  for each row
  when (new.is_active = true and old.is_active = false)
  execute function public.enforce_plan_cap('staff');

-- =============================================================================
-- END OF MIGRATION 0011
-- =============================================================================
