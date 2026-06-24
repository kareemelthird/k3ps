-- =============================================================================
-- Migration 0006 — Phase 5 deltas: order-line void + one-open-shift-per-branch
--
-- Forward-only. No table is created; no existing RLS policy is altered;
-- no existing index is modified. All additions are guarded with IF NOT EXISTS.
--
-- SECURITY REVIEWER: sign-off required (ADR-0006 Decisions 2 & 6).
--
-- RLS-safety reasoning (no policy change is needed):
--
-- (A) order_items.is_void / voided_at (Decision 2)
--     The two new columns are written by an UPDATE on order_items.
--     The existing `order_items_all` policy in 0004 is a `for all` policy whose
--     USING clause checks:
--       tenant_id = current_tenant_id()
--       AND parent order EXISTS with own tenant + (own manager_id OR is_owner)
--     Its WITH CHECK carries the same predicate.
--     A void is an ordinary UPDATE already covered by this policy — the caller
--     must own the parent order (or be the owner role) AND be in the same tenant.
--     A Tenant-B user cannot flip is_void on a Tenant-A line because the
--     USING clause first tests `tenant_id = current_tenant_id()` (which resolves
--     to B's tenant_id) — the Tenant-A row is invisible, so the UPDATE affects
--     0 rows. No additional policy is required.
--     Verify: rls-tenant-audit AC 13, 38.
--
-- (B) order_items_active_idx (partial index, Decision 2)
--     A partial index is a performance structure. It participates in query plans
--     but is not a security boundary. RLS USING/WITH CHECK still apply on every
--     query regardless of which index the planner selects. The index is
--     tenant_id-leading (ADR-0002) so cross-tenant planner collisions are
--     impossible: the RLS WHERE clause (tenant_id = current_tenant_id()) and the
--     index leading column are the same predicate. No policy change needed.
--
-- (C) shifts_one_open_per_branch (partial unique index, Decision 6)
--     A unique index is a constraint, not an access control primitive. The
--     existing shifts_insert policy in 0004 already pins tenant_id from the JWT
--     claim via WITH CHECK (tenant_id = current_tenant_id()). The unique index
--     is tenant_id-leading so a collision can only fire within the same tenant —
--     it cannot leak the existence of another tenant's open shift (a tenant-B
--     user only ever sees constraint violations on rows that pass their own RLS
--     USING predicate, i.e. tenant-B rows). No policy change needed.
--     Verify: rls-tenant-audit AC 23.
--
-- GRANTs: not required. Migration 0005 used ALTER DEFAULT PRIVILEGES to grant
-- DML on all future tables to `authenticated` and `service_role`. Indexes and
-- column additions to existing tables inherit the table's existing grants
-- automatically — no separate GRANT statement is needed here.
-- =============================================================================

-- =============================================================================
-- Decision 2 — Per-line void on order_items (immutable snapshot preserved)
--
-- is_void   : false by default; set to true when the line is voided.
-- voided_at : null until voided; records the UTC timestamp of the void action.
--
-- The original qty / unit_price snapshot is NEVER mutated or deleted —
-- auditable correction, not erasure (ADR-0006 §Decision 2, AC 10/33).
-- All order-total math (computeOrderTotal, computeOrdersTotalForSession) filters
-- on is_void = false.
-- =============================================================================

alter table public.order_items
  add column if not exists is_void   boolean     not null default false,
  add column if not exists voided_at timestamptz;

-- Partial index on (tenant_id, order_id) for the hot path: fetching active
-- (non-void) lines for a given order. tenant_id leads (ADR-0002).
-- The `where is_void = false` predicate keeps the index small — voided lines
-- are archived, not queried on the hot path.
create index if not exists order_items_active_idx
  on public.order_items (tenant_id, order_id)
  where is_void = false;

-- =============================================================================
-- Decision 6 — One open shift per branch (mirrors sessions_one_active_per_device)
--
-- Guarantees AC 23 at the database level, independently of the client.
-- A second concurrent INSERT for the same (tenant_id, branch_id) while any shift
-- has status='open' fails with a unique-constraint violation (SQLSTATE 23505)
-- regardless of which client, device, or network path issues it.
-- Closing a shift (status → 'closed') removes the row from this partial index,
-- freeing the slot for the next shift.
-- tenant_id leads (ADR-0002); cannot collide across tenants.
-- =============================================================================

create unique index if not exists shifts_one_open_per_branch
  on public.shifts (tenant_id, branch_id)
  where status = 'open';

-- =============================================================================
-- END OF MIGRATION 0006
-- =============================================================================
