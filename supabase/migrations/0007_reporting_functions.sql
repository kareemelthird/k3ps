-- =============================================================================
-- Migration 0007 — Phase 6 reporting read path (aggregation RPCs + perf indexes)
--
-- Forward-only. No table created; no existing RLS policy altered.
-- Every function is SECURITY INVOKER (explicit) + STABLE + search_path=public,
-- so it runs under the CALLER's RLS — the existing current_tenant_id() policies
-- on every base table apply unchanged. NO function is SECURITY DEFINER.
-- Each function also ANDs is_tenant_owner() (defense in depth: reports are
-- owner-only; non-owners get zero rows). Sums are cast to bigint (overflow-safe:
-- int piastres cap at ~21.4M EGP, plausibly exceeded over a wide multi-branch
-- range — bigint avoids silent overflow, ADR-0007 Decision 2).
-- Materialized views are deliberately NOT used (they bypass RLS — ADR-0007 D1).
--
-- SECURITY REVIEWER: sign-off required (ADR-0007 Decisions 1 & 8). Verify:
--   * every function is SECURITY INVOKER (not DEFINER);
--   * no parameter is trusted as tenant_id (tenant scope comes only from RLS);
--   * is_tenant_owner() gate is present in every function's WHERE clause;
--   * rls-tenant-audit A<->B holds over every RPC (AC 4, 26).
-- =============================================================================

-- ── Supporting indexes (RLS-neutral; tenant_id-leading per ADR-0002) ─────────
-- sessions_started_idx (tenant_id, started_at) and
-- order_items_active_idx (tenant_id, order_id) where is_void=false already exist
-- (migrations 0002 and 0006 respectively). Only the two walk-in/shift scan
-- indexes are new here.
create index if not exists orders_tenant_created_idx
  on public.orders (tenant_id, created_at);

create index if not exists shifts_tenant_opened_idx
  on public.shifts (tenant_id, opened_at);

-- ── 1. Revenue by business day ───────────────────────────────────────────────
--
-- Buckets closed-session revenue and paid walk-in order revenue by business day.
-- Business-day label (GROUP BY key) replicates packages/core businessDayKey:
--   ((anchor AT TIME ZONE 'Africa/Cairo') - make_interval(hours => p_cutover))::date::text
-- AT TIME ZONE yields the Cairo wall-clock at that instant; subtracting the
-- cutover shifts the boundary; ::date extracts the key — DST-safe because the
-- zone conversion happens per-instant (ADR-0007 Decision 3).
--
-- No double-count: grand_total already = time_total + orders_total − discount;
-- session-attached orders settle through the session (ADR-0006 Decision 3) and
-- are never added again. Only walk-ins (session_id IS NULL) are counted on their
-- own (ADR-0007 Decision 2).
--
-- Isolation guarantee: SECURITY INVOKER → caller's RLS applies on every base
-- table; is_tenant_owner() is the DB-level defense-in-depth owner gate behind
-- the route gate (Decision 8). Non-owners get zero rows.
create or replace function public.report_revenue_by_day(
  p_from    timestamptz,
  p_to      timestamptz,
  p_branch  uuid,
  p_cutover int default 6
)
returns table (
  business_day        text,
  time_total          bigint,
  orders_total        bigint,
  discount            bigint,
  gross               bigint,
  session_count       bigint,
  walkin_order_count  bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  -- p_cutover clamped to [0,23]: an out-of-range value corrupts business-day
  -- labels only for the caller; clamp is a data-quality guard (NB-1 hardening).
  with cutover(v) as (
    select greatest(0, least(23, p_cutover))
  ),
  rows as (
    -- Closed sessions, anchored at started_at (revenue recognised when play began)
    select
      ((s.started_at at time zone 'Africa/Cairo')
        - make_interval(hours => (select v from cutover)))::date::text as business_day,
      s.time_total::bigint   as time_total,
      s.orders_total::bigint as orders_total,
      s.discount::bigint     as discount,
      s.grand_total::bigint  as gross,
      1::bigint              as is_session,
      0::bigint              as is_walkin
    from public.sessions s
    where s.status = 'closed'
      and s.started_at >= p_from and s.started_at < p_to
      and (p_branch is null or s.branch_id = p_branch)
      and (select public.is_tenant_owner())   -- short-circuit per-branch (NB-1 hardening)
    union all
    -- Walk-in paid orders (session_id IS NULL), anchored at created_at.
    -- No paid_at column exists; created_at is the stable anchor for one-shot
    -- counter sales (ADR-0007 Decision 2).
    select
      ((o.created_at at time zone 'Africa/Cairo')
        - make_interval(hours => (select v from cutover)))::date::text,
      0::bigint, o.total::bigint, 0::bigint, o.total::bigint,
      0::bigint, 1::bigint
    from public.orders o
    where o.session_id is null
      and o.status = 'paid'
      and o.created_at >= p_from and o.created_at < p_to
      and (p_branch is null or o.branch_id = p_branch)
      and (select public.is_tenant_owner())   -- short-circuit per-branch (NB-1 hardening)
  )
  select
    r.business_day,
    sum(r.time_total),
    sum(r.orders_total),
    sum(r.discount),
    sum(r.gross),
    sum(r.is_session),
    sum(r.is_walkin)
  from rows r
  where (select public.is_tenant_owner())   -- outer owner gate (defense in depth, ADR-0007 D8)
  group by r.business_day
  order by r.business_day;
$$;

-- ── 2. By device (busy minutes, sessions, revenue) ───────────────────────────
--
-- Busy minutes per closed session: clamped to the query window so a session
-- that spans the boundary is not double-counted:
--   floor(greatest(0, extract(epoch from
--     (least(ended_at, p_to) − greatest(started_at, p_from))) / 60))
-- A device with no sessions in range shows busy_minutes=0 (not an error —
-- left join produces a NULL-session row, coalesce(sum(null),0) = 0).
-- Utilization % (busy ÷ daysInRange×24×60) is computed in the web layer
-- from busy_minutes + the pure @ps/core daysInRange helper (Decision 4).
-- Device revenue = Σ grand_total of closed sessions; walk-in orders carry no
-- device_id and are correctly excluded from per-device revenue (labelled in UI).
create or replace function public.report_by_device(
  p_from    timestamptz,
  p_to      timestamptz,
  p_branch  uuid,
  p_cutover int default 6
)
returns table (
  device_id     uuid,
  device_name   text,
  busy_minutes  bigint,
  session_count bigint,
  revenue       bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    d.id,
    d.name,
    coalesce(sum(
      floor(greatest(0, extract(epoch from (
        least(s.ended_at, p_to) - greatest(s.started_at, p_from)
      )) / 60))
    ), 0)::bigint                              as busy_minutes,
    count(s.id)::bigint                        as session_count,
    coalesce(sum(s.grand_total), 0)::bigint    as revenue
  from public.devices d
  left join public.sessions s
    on s.device_id = d.id
   and s.tenant_id = d.tenant_id    -- second line of defense: explicit tenant join predicate (NB-1 hardening)
   and s.status = 'closed'
   and s.started_at >= p_from and s.started_at < p_to
  where (p_branch is null or d.branch_id = p_branch)
    and (select public.is_tenant_owner())      -- owner-only DB gate (defense in depth)
  group by d.id, d.name
  order by busy_minutes desc;
$$;

-- ── 3. Top products (qty, revenue, current cost for margin-where-known) ───────
--
-- Covers both session-attached and walk-in order lines. The business-day anchor
-- is coalesce(session.started_at, order.created_at) so a snack consumed on a
-- session buckets with that session's day, and a walk-in snack buckets at its
-- order's created_at — keeping top-products consistent with Orders revenue
-- (ADR-0007 Decision 2 per-entity anchor ratification).
-- Voided lines (is_void=true) and void-status orders contribute 0 (AC 6/9).
-- An inactive/deactivated product still appears if it sold in range (history
-- preserved, AC 9). p.cost is the current catalog cost — null if uncosted;
-- margin computation ("—" where null) lives in the web layer, never SQL.
create or replace function public.report_top_products(
  p_from    timestamptz,
  p_to      timestamptz,
  p_branch  uuid,
  p_cutover int default 6
)
returns table (
  product_id uuid,
  name       text,
  category   text,
  qty        bigint,
  revenue    bigint,
  cost       int
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    p.id,
    p.name,
    p.category,
    sum(oi.qty)::bigint                       as qty,
    sum(oi.qty * oi.unit_price)::bigint       as revenue,
    p.cost
  from public.order_items oi
  join public.orders o   on o.id = oi.order_id
  join public.products p on p.id = oi.product_id
  left join public.sessions s on s.id = o.session_id
  where oi.is_void = false
    and o.status <> 'void'
    and (
      (o.session_id is null and o.status = 'paid')
      or (o.session_id is not null and s.status = 'closed')
    )
    -- coalesce(session.started_at, order.created_at) is the per-entity anchor
    and coalesce(s.started_at, o.created_at) >= p_from
    and coalesce(s.started_at, o.created_at) <  p_to
    and (p_branch is null or o.branch_id = p_branch)
    and (select public.is_tenant_owner())     -- owner-only DB gate (defense in depth)
  group by p.id, p.name, p.category, p.cost
  order by revenue desc;
$$;

-- ── 4. Payment-method mix (cash/wallet/other/debt) ───────────────────────────
--
-- Combines closed-session settlements and paid walk-in order settlements.
-- Cash revenue = rows where payment_method='cash'; wallet/other/debt are in the
-- mix but excluded from the cash line (ADR-0006 Decision 3 / ADR-0007 Decision 2).
-- payment_method is coalesced to 'unknown' to prevent NULL-keyed group collapse.
create or replace function public.report_payment_mix(
  p_from    timestamptz,
  p_to      timestamptz,
  p_branch  uuid,
  p_cutover int default 6
)
returns table (
  payment_method text,
  amount         bigint,
  txn_count      bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with rows as (
    select coalesce(s.payment_method::text, 'unknown') as payment_method,
           s.grand_total::bigint as amount
    from public.sessions s
    where s.status = 'closed'
      and s.started_at >= p_from and s.started_at < p_to
      and (p_branch is null or s.branch_id = p_branch)
      and (select public.is_tenant_owner())   -- short-circuit per-branch (NB-1 hardening)
    union all
    select coalesce(o.payment_method::text, 'unknown'),
           o.total::bigint
    from public.orders o
    where o.session_id is null and o.status = 'paid'
      and o.created_at >= p_from and o.created_at < p_to
      and (p_branch is null or o.branch_id = p_branch)
      and (select public.is_tenant_owner())   -- short-circuit per-branch (NB-1 hardening)
  )
  select r.payment_method, sum(r.amount), count(*)::bigint
  from rows r
  where (select public.is_tenant_owner())    -- outer owner gate (defense in depth, ADR-0007 D8)
  group by r.payment_method
  order by sum(r.amount) desc;
$$;

-- ── 5. Per-shift reconciliation (closed shifts, anchored at opened_at) ────────
--
-- Returns the bounded list of closed shifts in range; totals (Σ expected, Σ
-- counted, Σ difference) and over/short/balanced counts are computed by the
-- caller (web layer) — a sanctioned small-slice client aggregation (Decision 1,
-- Decision 7). difference is stored as-is from Phase-5 computeShiftReconciliation
-- and is NEVER re-derived or clamped here (AC 10).
-- Business-day label applies the same normative expression as function 1.
create or replace function public.report_shifts(
  p_from    timestamptz,
  p_to      timestamptz,
  p_branch  uuid,
  p_cutover int default 6
)
returns table (
  shift_id      uuid,
  business_day  text,
  opened_at     timestamptz,
  closed_at     timestamptz,
  opening_cash  int,
  expected_cash int,
  actual_cash   int,
  difference    int,
  manager_id    uuid
)
language sql
stable
security invoker
set search_path = public
as $$
  -- p_cutover clamped to [0,23]: data-quality guard (NB-1 hardening).
  select
    sh.id,
    ((sh.opened_at at time zone 'Africa/Cairo')
      - make_interval(hours => greatest(0, least(23, p_cutover))))::date::text,
    sh.opened_at, sh.closed_at,
    sh.opening_cash, sh.expected_cash, sh.actual_cash, sh.difference,
    sh.manager_id
  from public.shifts sh
  where sh.status = 'closed'
    and sh.opened_at >= p_from and sh.opened_at < p_to
    and (p_branch is null or sh.branch_id = p_branch)
    and (select public.is_tenant_owner())    -- owner-only DB gate (defense in depth, ADR-0007 D8)
  order by sh.opened_at;
$$;

-- ── EXECUTE grants: authenticated only; not anon/public ──────────────────────
--
-- REVOKE first to ensure a clean grant state regardless of prior defaults.
-- Only `authenticated` (signed-in users) may call these RPCs; the `public`
-- and `anon` pseudo-roles (unauthenticated callers) are explicitly denied.
revoke all on function
  public.report_revenue_by_day(timestamptz, timestamptz, uuid, int),
  public.report_by_device(timestamptz, timestamptz, uuid, int),
  public.report_top_products(timestamptz, timestamptz, uuid, int),
  public.report_payment_mix(timestamptz, timestamptz, uuid, int),
  public.report_shifts(timestamptz, timestamptz, uuid, int)
  from public, anon;

grant execute on function
  public.report_revenue_by_day(timestamptz, timestamptz, uuid, int),
  public.report_by_device(timestamptz, timestamptz, uuid, int),
  public.report_top_products(timestamptz, timestamptz, uuid, int),
  public.report_payment_mix(timestamptz, timestamptz, uuid, int),
  public.report_shifts(timestamptz, timestamptz, uuid, int)
  to authenticated;

-- =============================================================================
-- END OF MIGRATION 0007
-- =============================================================================
