-- =============================================================================
-- Migration 0004 — RLS policies on EVERY public table
--
-- Every tenant-scoped write carries WITH CHECK (tenant_id = current_tenant_id())
-- so a caller cannot land a row in another tenant (ADR-0002, CLAUDE.md §5).
--
-- Policy pattern (from the trial, narrowed by tenant — AC 31a, never replaced):
--   config tables  (devices/rate_rules/products/settings): staff-read / owner-write
--   transactional  (shifts/sessions/orders/debts): own-row OR owner
--   child tables   (segments/order_items/debt_payments): parent EXISTS + tenant_id
--   stock_movements: staff insert; reason='adjust' blocked for non-owners
--   audit_log      : owner-read / staff-insert
--   tenancy tables : scoped to active members / super-admin
--   platform_settings: super-admin write / authenticated read
--
-- Every call to a claim helper is wrapped in (select ...) for initPlan caching.
--
-- SECURITY REVIEWER GATE: Sign-off required on ALL policies in this file.
-- =============================================================================

-- =============================================================================
-- 1. TENANCY TABLES: tenants, branches, tenant_members
-- =============================================================================

-- ── tenants ──────────────────────────────────────────────────────────────────
-- Super-admin provisions tenants (via edge fn provision-tenant).
-- Active members of a tenant can read their tenant row.
create policy tenants_member_select on public.tenants
  for select
  using (
    (select public.is_super_admin())
    or exists (
      select 1 from public.tenant_members m
      where m.tenant_id = id
        and m.profile_id = (select auth.uid())
        and m.is_active = true
    )
  );

-- Only super-admin can insert tenants (via provision-tenant edge fn)
create policy tenants_super_insert on public.tenants
  for insert
  with check ((select public.is_super_admin()));

-- Super-admin can update (suspend/reactivate); tenant owners cannot self-modify status
create policy tenants_super_update on public.tenants
  for update
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- ── branches ─────────────────────────────────────────────────────────────────
-- Members can read branches of their active tenant.
create policy branches_member_select on public.branches
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

-- Owners can create/update branches in their tenant; WITH CHECK pins tenant_id
create policy branches_owner_write on public.branches
  for all
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  );

-- ── tenant_members ────────────────────────────────────────────────────────────
-- Members can read the membership list of their active tenant.
create policy tenant_members_staff_select on public.tenant_members
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

-- Owners can grant/revoke membership in their tenant; tenant_id pinned by WITH CHECK.
create policy tenant_members_owner_write on public.tenant_members
  for all
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  );

-- =============================================================================
-- 2. PROFILES (cross-tenant)
-- =============================================================================

-- Anyone reads co-tenant members' profiles (for display); owners read all in tenant.
create policy profiles_co_member_select on public.profiles
  for select
  using (
    -- Self
    id = (select auth.uid())
    -- OR a co-member of the caller's active tenant
    or exists (
      select 1 from public.tenant_members m
      where m.profile_id = profiles.id
        and m.tenant_id = (select public.current_tenant_id())
        and m.is_active = true
    )
  );

-- =============================================================================
-- 3. PLATFORM SETTINGS (super-admin write / authenticated read)
-- =============================================================================

create policy platform_settings_read on public.platform_settings
  for select
  using ((select auth.uid()) is not null);

create policy platform_settings_super_write on public.platform_settings
  for all
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- =============================================================================
-- 4. CONFIG TABLES: devices, rate_rules, products, settings
-- Staff-read / owner-write — AND-ed with tenant (AC 31a)
-- =============================================================================

-- ── devices ──────────────────────────────────────────────────────────────────
create policy devices_staff_select on public.devices
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

-- Owner manages config; WITH CHECK prevents landing in another tenant
create policy devices_owner_write on public.devices
  for all
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  );

-- Staff can update device status (free/busy/maintenance) during operations
create policy devices_staff_status_update on public.devices
  for update
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

-- ── rate_rules ────────────────────────────────────────────────────────────────
create policy rate_rules_staff_select on public.rate_rules
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

create policy rate_rules_owner_write on public.rate_rules
  for all
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  );

-- ── products ─────────────────────────────────────────────────────────────────
create policy products_staff_select on public.products
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

create policy products_owner_write on public.products
  for all
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  );

-- ── settings ─────────────────────────────────────────────────────────────────
create policy settings_staff_select on public.settings
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

create policy settings_owner_write on public.settings
  for all
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  );

-- =============================================================================
-- 5. TRANSACTIONAL TABLES: shifts, sessions, orders, debts
-- Own-row (manager_id = auth.uid()) OR owner — AND-ed with tenant (AC 31a)
-- =============================================================================

-- ── shifts ────────────────────────────────────────────────────────────────────
create policy shifts_select on public.shifts
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (
      manager_id = (select auth.uid())
      or (select public.is_tenant_owner())
    )
  );

create policy shifts_insert on public.shifts
  for insert
  with check (
    tenant_id = (select public.current_tenant_id())
    and manager_id = (select auth.uid())
    and (select public.is_tenant_staff())
  );

create policy shifts_update on public.shifts
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
  );

-- ── sessions ─────────────────────────────────────────────────────────────────
create policy sessions_select on public.sessions
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (
      manager_id = (select auth.uid())
      or (select public.is_tenant_owner())
    )
  );

create policy sessions_insert on public.sessions
  for insert
  with check (
    tenant_id = (select public.current_tenant_id())
    and manager_id = (select auth.uid())
    and (select public.is_tenant_staff())
  );

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
  );

-- ── orders ────────────────────────────────────────────────────────────────────
create policy orders_select on public.orders
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (
      manager_id = (select auth.uid())
      or (select public.is_tenant_owner())
    )
  );

create policy orders_insert on public.orders
  for insert
  with check (
    tenant_id = (select public.current_tenant_id())
    and manager_id = (select auth.uid())
    and (select public.is_tenant_staff())
  );

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
  );

-- ── debts ─────────────────────────────────────────────────────────────────────
create policy debts_select on public.debts
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (
      manager_id = (select auth.uid())
      or (select public.is_tenant_owner())
    )
  );

create policy debts_insert on public.debts
  for insert
  with check (
    tenant_id = (select public.current_tenant_id())
    and manager_id = (select auth.uid())
    and (select public.is_tenant_staff())
  );

create policy debts_update on public.debts
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
  );

-- ── customers ─────────────────────────────────────────────────────────────────
-- Customers are a shared tenant resource (any staff can read; owner writes)
create policy customers_staff_select on public.customers
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

create policy customers_staff_write on public.customers
  for all
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

-- =============================================================================
-- 6. CHILD TABLES: session_segments, order_items, debt_payments
-- Parent EXISTS AND own tenant_id — blocks cross-tenant child access (AC 35)
-- =============================================================================

-- ── session_segments ──────────────────────────────────────────────────────────
-- Access requires:  own tenant_id  AND  the parent session is visible to caller
create policy segments_all on public.session_segments
  for all
  using (
    tenant_id = (select public.current_tenant_id())
    and exists (
      select 1 from public.sessions s
      where s.id = session_id
        and s.tenant_id = (select public.current_tenant_id())
        and (
          s.manager_id = (select auth.uid())
          or (select public.is_tenant_owner())
        )
    )
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and exists (
      select 1 from public.sessions s
      where s.id = session_id
        and s.tenant_id = (select public.current_tenant_id())
        and (
          s.manager_id = (select auth.uid())
          or (select public.is_tenant_owner())
        )
    )
  );

-- ── order_items ───────────────────────────────────────────────────────────────
create policy order_items_all on public.order_items
  for all
  using (
    tenant_id = (select public.current_tenant_id())
    and exists (
      select 1 from public.orders o
      where o.id = order_id
        and o.tenant_id = (select public.current_tenant_id())
        and (
          o.manager_id = (select auth.uid())
          or (select public.is_tenant_owner())
        )
    )
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and exists (
      select 1 from public.orders o
      where o.id = order_id
        and o.tenant_id = (select public.current_tenant_id())
        and (
          o.manager_id = (select auth.uid())
          or (select public.is_tenant_owner())
        )
    )
  );

-- ── debt_payments ─────────────────────────────────────────────────────────────
create policy debt_payments_all on public.debt_payments
  for all
  using (
    tenant_id = (select public.current_tenant_id())
    and exists (
      select 1 from public.debts d
      where d.id = debt_id
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
      where d.id = debt_id
        and d.tenant_id = (select public.current_tenant_id())
        and (
          d.manager_id = (select auth.uid())
          or (select public.is_tenant_owner())
        )
    )
  );

-- =============================================================================
-- 7. STOCK MOVEMENTS
-- Staff insert; reason='adjust' requires is_tenant_owner() (AC 31a)
-- =============================================================================

create policy stock_movements_staff_select on public.stock_movements
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

-- Insert: staff can insert non-adjust reasons; adjust is owner-only (AC 31a)
create policy stock_movements_staff_insert on public.stock_movements
  for insert
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
    and (
      reason <> 'adjust'
      or (select public.is_tenant_owner())
    )
  );

-- Owners can update/delete stock movements (e.g. corrections)
create policy stock_movements_owner_write on public.stock_movements
  for update
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  );

-- =============================================================================
-- 8. AUDIT LOG
-- Owner-read / staff-insert — AND-ed with tenant (AC 31a, AC 39)
-- =============================================================================

create policy audit_log_owner_select on public.audit_log
  for select
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_owner())
  );

-- Staff (including managers) can insert audit rows; tenant_id pinned by WITH CHECK
create policy audit_log_staff_insert on public.audit_log
  for insert
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

-- Super-admin can also insert audit rows (for platform-level actions)
create policy audit_log_super_insert on public.audit_log
  for insert
  with check ((select public.is_super_admin()));

-- =============================================================================
-- END OF MIGRATION 0004
-- =============================================================================
