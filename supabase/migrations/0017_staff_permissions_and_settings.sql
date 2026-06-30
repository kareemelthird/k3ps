-- =============================================================================
-- Migration 0017 — Staff permissions + settings helpers (Slice 2, ADR-0012)
--
-- What this migration does:
--   1. Adds  `permissions jsonb not null default '{}'`  to tenant_members.
--   2. Creates the  has_permission(p_perm text)  SECURITY DEFINER helper.
--   3. Drops + recreates RLS policies that gain permission predicates:
--        stock_movements_staff_insert       — can_restock gate
--        sessions_update                    — can_void gate on WITH CHECK
--        orders_update                      — can_void gate on WITH CHECK
--        debts_insert                       — can_manage_debts gate
--        debt_payments (4 per-cmd policies) — can_manage_debts on INSERT/UPDATE/DELETE
--          select: open reads (unchanged from original)
--          insert: WITH CHECK + can_manage_debts
--          update: USING + WITH CHECK + can_manage_debts
--          delete: USING + can_manage_debts (FOR ALL + WITH CHECK cannot gate DELETE)
--   4. Creates  invite_staff_atomic()  service-role-only atomic membership RPC.
--
-- Settings (public.settings KV table): already correct — owner-write / staff-read
-- RLS exists in migration 0004 §4. No new table, no RLS change needed.
--
-- ADR-0012 Decision B1: can_discount is enforced inside close_session_tx (Slice 3),
-- NOT via an RLS policy, because close_session_tx is SECURITY DEFINER.
--
-- Forward-only. Never edit an applied migration — add a corrective one.
--
-- SECURITY REVIEWER GATE: Required sign-off before merge. Changes to verify:
--   * has_permission() semantics: owner → always true; absent flag → true
--     (permissive default); explicit false → false; non-member → false.
--   * All policy drops/recreates preserve the existing tenant_id isolation
--     (WITH CHECK still pins tenant_id = current_tenant_id()). The new predicate
--     is ANDed — it never replaces the tenant guard.
--   * debt_payments: split from FOR ALL into 4 per-command policies so that
--     DELETE is also gated by has_permission('can_manage_debts') in USING
--     (FOR ALL + WITH CHECK cannot gate DELETE; verified by pgTAP test T18).
--   * invite_staff_atomic(): SECURITY DEFINER + execute revoked from all non-
--     service-role principals; refuses to demote an existing owner; fatal audit.
-- =============================================================================

-- =============================================================================
-- 1. permissions column on tenant_members
-- =============================================================================
-- Permissive default: '{}'  means all permission flags are absent, which
-- has_permission() treats as "allowed" (see function §2 below).
-- No index needed: the column is read only via the membership row already
-- fetched by PK / tenant_members_profile_idx.
-- No backfill needed: '{}' ≡ all-allowed, so existing staff are unaffected.
-- =============================================================================

alter table public.tenant_members
  add column if not exists permissions jsonb not null default '{}'::jsonb;

-- =============================================================================
-- 2. has_permission() — SECURITY DEFINER permission helper
--
-- Returns true  iff the caller is permitted to perform action p_perm.
-- Rules (ADR-0012 Decision B1):
--   * Owner    → always true (is_tenant_owner() = true → short-circuit OR).
--   * Active staff/manager with flag absent  → true  (permissive default).
--   * Active staff/manager with flag = false → false.
--   * Non-member / inactive member → false (is_active_member() = false).
--
-- Operator precedence (SQL AND > OR) makes this:
--   is_tenant_owner()  OR  (coalesce(flag, true)  AND  is_active_member())
-- which factors to:
--   is_active_member()  AND  (is_owner_role  OR  coalesce(flag, true))
-- — exactly matching the ADR description: "active member AND (owner OR flag not false)".
--
-- SECURITY NOTE: SECURITY DEFINER + set search_path = public prevents
-- search-path injection. The function reads ONLY the signed JWT claim
-- (via auth.uid() / current_tenant_id()) and the authoritative
-- tenant_members row — never a client-supplied value.
-- =============================================================================

create or replace function public.has_permission(p_perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- Owners always have all permissions (first branch short-circuits the OR).
    (select public.is_tenant_owner())
    or
    -- Non-owners: check the stored flag (or permissive default) AND membership.
    -- AND binds tighter than OR in SQL, so this parenthesises correctly.
    coalesce(
      (select (m.permissions ->> p_perm)::boolean
       from public.tenant_members m
       where m.tenant_id  = (select public.current_tenant_id())
         and m.profile_id = (select auth.uid())
         and m.is_active  = true),
      true    -- absent key ⇒ permissive default (flag not set = allowed)
    )
    and (select public.is_active_member())  -- non-members → false (fail-closed)
$$;

-- Grant EXECUTE to authenticated (helper only; RLS remains the security gate).
grant execute on function public.has_permission(text) to authenticated;

-- =============================================================================
-- 3. RLS deltas — drop + recreate named policies
--
-- Invariant: the tenant_id = current_tenant_id() predicate is NEVER removed
-- or weakened. The new permission predicate is always ANDed onto the existing
-- condition. WITH CHECK on writes is the cross-tenant prevention; we only ADD.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 3a. stock_movements_staff_insert
--     Existing gate: reason='adjust' requires is_tenant_owner().
--     New gate:      reason='restock' requires has_permission('can_restock').
--     Both are ANDed — the existing adjust gate is preserved.
-- ---------------------------------------------------------------------------
drop policy if exists stock_movements_staff_insert on public.stock_movements;

create policy stock_movements_staff_insert on public.stock_movements
  for insert
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
    and (reason <> 'adjust'  or (select public.is_tenant_owner()))
    and (reason <> 'restock' or (select public.has_permission('can_restock')))
  );

-- ---------------------------------------------------------------------------
-- 3b. sessions_update — add can_void gate to WITH CHECK
--
-- The NEW session status is evaluated in WITH CHECK (UPDATE sets the new row).
-- A client setting status='void' is rejected unless has_permission('can_void').
-- Owners always pass via has_permission (they own all perms).
-- close_session_tx (SECURITY DEFINER) bypasses RLS entirely — it enforces
-- its own scalar + membership guards and is unaffected by this change.
-- ---------------------------------------------------------------------------
drop policy if exists sessions_update on public.sessions;

create policy sessions_update on public.sessions
  for update
  using (
    tenant_id = (select public.current_tenant_id())
    and (
      manager_id = (select auth.uid())
      or (select public.is_tenant_owner())
    )
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (
      manager_id = (select auth.uid())
      or (select public.is_tenant_owner())
    )
    and (status <> 'void' or (select public.has_permission('can_void')))
  );

-- ---------------------------------------------------------------------------
-- 3c. orders_update — add can_void gate to WITH CHECK
--
-- Same reasoning as sessions_update. Setting an order's status to 'void'
-- requires can_void permission. Normal status transitions (open→paid, etc.)
-- are unaffected (the predicate only fires when NEW.status = 'void').
-- ---------------------------------------------------------------------------
drop policy if exists orders_update on public.orders;

create policy orders_update on public.orders
  for update
  using (
    tenant_id = (select public.current_tenant_id())
    and (
      manager_id = (select auth.uid())
      or (select public.is_tenant_owner())
    )
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (
      manager_id = (select auth.uid())
      or (select public.is_tenant_owner())
    )
    and (status <> 'void' or (select public.has_permission('can_void')))
  );

-- ---------------------------------------------------------------------------
-- 3d. debts_insert — add can_manage_debts gate
--
-- The existing policy gates debts creation to own-row staff. We add the
-- permission check. customers_staff_write (any active staff may create a
-- customer) is intentionally LEFT AS-IS per ADR-0012 §D2 ("customers_staff_write
-- — leave as-is; any active staff may create a customer when opening آجل").
-- debts_update and debts_select are also left unchanged (only inserts gate).
-- ---------------------------------------------------------------------------
drop policy if exists debts_insert on public.debts;

create policy debts_insert on public.debts
  for insert
  with check (
    tenant_id = (select public.current_tenant_id())
    and manager_id = (select auth.uid())
    and (select public.is_tenant_staff())
    and (select public.has_permission('can_manage_debts'))
  );

-- ---------------------------------------------------------------------------
-- 3e. debt_payments — replace FOR ALL with four per-command policies
--
-- Security reviewer WARN 2.1: the original FOR ALL + WITH CHECK approach leaves
-- DELETE evaluated against USING only (WITH CHECK does not apply to DELETE).
-- A staff member with can_manage_debts=false who owns the parent debt could
-- delete debt_payment rows, which is money-affecting (lowers paid_total).
--
-- Fix: replace the single FOR ALL policy with four named per-command policies:
--   debt_payments_select — open reads (no permission gate; reads are informational)
--   debt_payments_insert — WITH CHECK includes has_permission
--   debt_payments_update — USING + WITH CHECK both include tenant/parent guards;
--                          WITH CHECK also gates on has_permission
--   debt_payments_delete — USING includes has_permission (DELETE has no WITH CHECK)
--
-- In every case the tenant_id = current_tenant_id() + parent-EXISTS predicate
-- is preserved intact — no cross-tenant leak.
-- ---------------------------------------------------------------------------
drop policy if exists debt_payments_all    on public.debt_payments;
drop policy if exists debt_payments_select on public.debt_payments;
drop policy if exists debt_payments_insert on public.debt_payments;
drop policy if exists debt_payments_update on public.debt_payments;
drop policy if exists debt_payments_delete on public.debt_payments;

-- SELECT: open reads within tenant — no permission gate (reads are informational).
create policy debt_payments_select on public.debt_payments
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and exists (
      select 1 from public.debts d
      where d.id        = debt_id
        and d.tenant_id = (select public.current_tenant_id())
        and (
          d.manager_id = (select auth.uid())
          or (select public.is_tenant_owner())
        )
    )
  );

-- INSERT: tenant + parent-EXISTS + can_manage_debts.
create policy debt_payments_insert on public.debt_payments
  for insert
  with check (
    tenant_id = (select public.current_tenant_id())
    and exists (
      select 1 from public.debts d
      where d.id        = debt_id
        and d.tenant_id = (select public.current_tenant_id())
        and (
          d.manager_id = (select auth.uid())
          or (select public.is_tenant_owner())
        )
    )
    and (select public.has_permission('can_manage_debts'))
  );

-- UPDATE: USING tenant+parent (row must be accessible); WITH CHECK also gates
-- on can_manage_debts so the update cannot be completed without the permission.
create policy debt_payments_update on public.debt_payments
  for update
  using (
    tenant_id = (select public.current_tenant_id())
    and exists (
      select 1 from public.debts d
      where d.id        = debt_id
        and d.tenant_id = (select public.current_tenant_id())
        and (
          d.manager_id = (select auth.uid())
          or (select public.is_tenant_owner())
        )
    )
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and exists (
      select 1 from public.debts d
      where d.id        = debt_id
        and d.tenant_id = (select public.current_tenant_id())
        and (
          d.manager_id = (select auth.uid())
          or (select public.is_tenant_owner())
        )
    )
    and (select public.has_permission('can_manage_debts'))
  );

-- DELETE: USING includes has_permission (DELETE uses USING only, no WITH CHECK).
-- This closes the gap where FOR ALL + WITH CHECK left DELETE ungated.
create policy debt_payments_delete on public.debt_payments
  for delete
  using (
    tenant_id = (select public.current_tenant_id())
    and exists (
      select 1 from public.debts d
      where d.id        = debt_id
        and d.tenant_id = (select public.current_tenant_id())
        and (
          d.manager_id = (select auth.uid())
          or (select public.is_tenant_owner())
        )
    )
    and (select public.has_permission('can_manage_debts'))
  );

-- =============================================================================
-- 4. invite_staff_atomic() — atomic membership upsert + fatal audit
--
-- Service-role-only RPC; mirrors provision_tenant_atomic() (migration 0008 §11).
-- The invite-staff edge function calls this AFTER verifying caller authority.
--
-- Properties:
--   * Atomic: membership upsert + audit INSERT commit together or not at all.
--   * Idempotent: ON CONFLICT DO UPDATE re-applies role/permissions on retry.
--   * Owner-safe: the DO UPDATE WHERE clause refuses to demote an existing owner.
--   * Audit-fatal: the audit INSERT is not wrapped in an exception handler;
--     failure rolls back the whole transaction (no membership without a trail).
--   * SECURITY DEFINER + set search_path = public: prevents injection; runs
--     as owner (postgres) so it can write regardless of caller RLS context.
--   * execute REVOKED from all non-service-role principals.
-- =============================================================================

create or replace function public.invite_staff_atomic(
  p_tenant_id   uuid,
  p_profile_id  uuid,
  p_actor_id    uuid,
  p_role        public.user_role,
  p_permissions jsonb,
  p_email       text    default null,
  p_is_new_user boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Role guard: only manager or staff may be minted here.
  -- Owners are provisioned by the super-admin via provision_tenant_atomic().
  if p_role not in ('manager'::public.user_role, 'staff'::public.user_role) then
    raise exception 'invite_staff_atomic: role must be manager or staff'
      using errcode = '22023';
  end if;

  -- Idempotent membership upsert.
  -- ON CONFLICT DO UPDATE WHERE ... refuses to overwrite an existing owner row
  -- (the WHERE clause in DO UPDATE acts as a conditional skip for owner rows).
  -- A silently-skipped update is acceptable: the call is still audited below,
  -- and the caller (invite-staff edge function) can surface this to the owner.
  insert into public.tenant_members (tenant_id, profile_id, role, is_active, permissions)
  values (p_tenant_id, p_profile_id, p_role, true, coalesce(p_permissions, '{}'::jsonb))
  on conflict (tenant_id, profile_id) do update
    set role        = excluded.role,
        permissions = excluded.permissions,
        is_active   = true
    where public.tenant_members.role <> 'owner';

  -- FATAL audit — no exception handler. If this INSERT fails (FK violation,
  -- constraint error, etc.), the entire transaction rolls back: no membership
  -- row will exist without a corresponding audit entry.
  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, meta)
  values (
    p_tenant_id,
    p_actor_id,
    'member.invite',
    'tenant_members',
    p_profile_id,
    jsonb_build_object(
      'role',         p_role::text,
      'email',        coalesce(p_email, ''),
      'new_auth_user', p_is_new_user,
      'permissions',  coalesce(p_permissions, '{}'::jsonb)
    )
  );
end;
$$;

-- Revoke from all non-service-role principals (fail-closed).
revoke execute on function public.invite_staff_atomic(uuid, uuid, uuid, public.user_role, jsonb, text, boolean)
  from public;
revoke execute on function public.invite_staff_atomic(uuid, uuid, uuid, public.user_role, jsonb, text, boolean)
  from anon;
revoke execute on function public.invite_staff_atomic(uuid, uuid, uuid, public.user_role, jsonb, text, boolean)
  from authenticated;

-- Grant ONLY to service_role — edge function uses this role.
grant execute on function public.invite_staff_atomic(uuid, uuid, uuid, public.user_role, jsonb, text, boolean)
  to service_role;

-- =============================================================================
-- END OF MIGRATION 0017
-- =============================================================================
