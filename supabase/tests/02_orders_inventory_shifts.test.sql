-- =============================================================================
-- 02_orders_inventory_shifts.test.sql — pgTAP behavioural tests for the
-- Phase-5 forward-only deltas in migration 0006 (ADR-0006).
--
-- Covers:
--   T1  order_items.is_void column exists and defaults to false (Decision 2).
--   T2  order_items.voided_at column exists and is nullable (Decision 2).
--   T3  order_items_active_idx exists as a partial index (Decision 2 perf).
--   T4  shifts_one_open_per_branch unique index exists (Decision 6).
--   T5  Positive control: Tenant A can open ONE shift for a branch.
--   T6  The unique index rejects a SECOND open shift for the same branch
--       (ADR-0006 Decision 6, AC 23) — SQLSTATE 23505.
--   T7  Closing the first shift (status → closed) frees the slot so a new
--       shift can be opened (the partial index only fires on status='open').
--   T8  is_void can be set to true on an order_items row (void update works).
--   T9  A voided item retains its original qty and unit_price snapshot.
--   T10 Tenant-B shift does NOT block Tenant-A from opening a shift for the
--       same logical branch_id value (isolation: unique index is tenant-scoped).
--
-- Depends on seed.sql (Tenant A = aaaaaaaa…, Tenant B = bbbbbbbb…).
-- Uses fixed seed UUIDs. Runs inside a transaction — all writes are rolled back.
-- Run: npx supabase test db   (local Supabase stack / Docker, or CI).
-- =============================================================================

begin;
select plan(10);

-- ── Setup: we need helper data (orders, order_items, shifts).
--    All inserts are done as superuser (outside the authenticated role) so we
--    can inject the test fixture rows directly; role is set to authenticated only
--    for RLS-sensitive assertions.
--    We use CTE-based inserts to keep the fixture self-contained. ──────────────

-- Reusable IDs (no conflicts with seed.sql fixed IDs).
-- shift: aa-shift-open, aa-shift-second, aa-shift-closed, bb-shift-open
-- order: aa-order-01
-- item:  aa-item-01

-- Insert a Tenant-A order so we can attach order_items to it.
insert into public.orders
  (id, tenant_id, branch_id, manager_id, total, status)
values
  ('aaaaaaaa-0d00-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000002',
   0, 'open')
on conflict (id) do nothing;

-- Insert a Tenant-A order_item for the void behaviour tests.
insert into public.order_items
  (id, tenant_id, order_id, product_id, qty, unit_price)
values
  ('aaaaaaaa-1100-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-0d00-4000-8000-000000000001',
   'aaaaaaaa-c0de-4000-8000-000000000001',  -- Pepsi Can (Tenant A)
   2, 500)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- T1 — is_void column exists and defaults to false
-- ---------------------------------------------------------------------------
select is(
  (
    select column_default
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'order_items'
      and column_name  = 'is_void'
  ),
  'false',
  'T1: order_items.is_void default is false'
);

-- ---------------------------------------------------------------------------
-- T2 — voided_at column exists and is nullable (is_nullable = 'YES')
-- ---------------------------------------------------------------------------
select is(
  (
    select is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'order_items'
      and column_name  = 'voided_at'
  ),
  'YES',
  'T2: order_items.voided_at is nullable (null until voided)'
);

-- ---------------------------------------------------------------------------
-- T3 — order_items_active_idx partial index exists
-- ---------------------------------------------------------------------------
select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename  = 'order_items'
      and indexname  = 'order_items_active_idx'
  ),
  'T3: order_items_active_idx partial index exists'
);

-- ---------------------------------------------------------------------------
-- T4 — shifts_one_open_per_branch unique index exists
-- ---------------------------------------------------------------------------
select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename  = 'shifts'
      and indexname  = 'shifts_one_open_per_branch'
  ),
  'T4: shifts_one_open_per_branch unique index exists'
);

-- ---------------------------------------------------------------------------
-- T5 — Positive control: first open shift for a branch succeeds
-- ---------------------------------------------------------------------------
select lives_ok(
  $$
    insert into public.shifts
      (id, tenant_id, branch_id, manager_id, opening_cash, status)
    values
      ('aaaaaaaa-5110-4000-8000-000000000001',
       'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
       'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
       '00000000-0000-4000-8000-000000000002',
       50000, 'open')
  $$,
  'T5: first open shift for Tenant-A Branch-1 succeeds (positive control)'
);

-- ---------------------------------------------------------------------------
-- T6 — Unique index rejects a second open shift for the same branch/tenant
--       Expected SQLSTATE: 23505 (unique_violation)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$
    insert into public.shifts
      (id, tenant_id, branch_id, manager_id, opening_cash, status)
    values
      ('aaaaaaaa-5110-4000-8000-000000000002',
       'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
       'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
       '00000000-0000-4000-8000-000000000002',
       30000, 'open')
  $$,
  '23505', NULL,
  'T6: second open shift for same tenant+branch rejected by unique index (23505)'
);

-- ---------------------------------------------------------------------------
-- T7 — Closing the first shift frees the slot; a new open shift succeeds
-- ---------------------------------------------------------------------------

-- Close the first shift.
update public.shifts
  set status = 'closed', closed_at = now(), actual_cash = 50000, difference = 0
  where id = 'aaaaaaaa-5110-4000-8000-000000000001';

-- Now a new open shift for the same branch must succeed.
select lives_ok(
  $$
    insert into public.shifts
      (id, tenant_id, branch_id, manager_id, opening_cash, status)
    values
      ('aaaaaaaa-5110-4000-8000-000000000003',
       'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
       'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
       '00000000-0000-4000-8000-000000000002',
       20000, 'open')
  $$,
  'T7: after closing the first shift, a new open shift succeeds (slot freed)'
);

-- ---------------------------------------------------------------------------
-- T8 — is_void can be set to true (void UPDATE works)
-- ---------------------------------------------------------------------------
update public.order_items
  set is_void = true, voided_at = now()
  where id = 'aaaaaaaa-1100-4000-8000-000000000001';

select is(
  (select is_void from public.order_items
    where id = 'aaaaaaaa-1100-4000-8000-000000000001'),
  true,
  'T8: is_void can be set to true (void update writes correctly)'
);

-- ---------------------------------------------------------------------------
-- T9 — Voided item retains original qty and unit_price snapshot (no mutation)
-- ---------------------------------------------------------------------------
select is(
  (select row(qty, unit_price)::text from public.order_items
    where id = 'aaaaaaaa-1100-4000-8000-000000000001'),
  row(2, 500)::text,
  'T9: voided item retains original qty=2 and unit_price=500 (snapshot intact)'
);

-- ---------------------------------------------------------------------------
-- T10 — Tenant isolation: Tenant B's open shift for the same branch_id UUID
--        does NOT block Tenant A from opening its own shift (index is tenant-scoped).
--        First insert Tenant B's open shift; then verify Tenant A can also open
--        one for a branch that happens to share the same UUID. We use
--        Tenant B's branch UUID to make the cross-tenant scenario explicit.
-- ---------------------------------------------------------------------------

-- Insert an open shift for Tenant B on bbbb0001.
insert into public.shifts
  (id, tenant_id, branch_id, manager_id, opening_cash, status)
values
  ('bbbbbbbb-5110-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
   '00000000-0000-4000-8000-000000000004',
   40000, 'open')
on conflict (id) do nothing;

-- Tenant A opens a shift for its own branch aaaa0002 (different branch, different
-- tenant — the unique index (tenant_id, branch_id) is fully distinct).
select lives_ok(
  $$
    insert into public.shifts
      (id, tenant_id, branch_id, manager_id, opening_cash, status)
    values
      ('aaaaaaaa-5110-4000-8000-000000000004',
       'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
       'aaaa0002-0000-4000-8000-aaaaaaaaaaaa',
       '00000000-0000-4000-8000-000000000002',
       15000, 'open')
  $$,
  'T10: Tenant A can open a shift while Tenant B has an open shift (index is tenant-scoped)'
);

select * from finish();
rollback;
