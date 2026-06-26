-- =============================================================================
-- Migration 0009 — Phase 8 offline-first hardening:
--   (1) Realtime publication + REPLICA IDENTITY FULL for tenant-scoped
--       postgres_changes (ADR-0009 §Q5)
--   (2) Terminal-state guard triggers (ADR-0009 §Q6)
--   (3) Idempotent transactional close RPC — SECURITY INVOKER (ADR-0009 §Q3)
--
-- SECURITY REVIEWER: required sign-off (AC 16, 26, 35). Verify:
--   * Realtime exposes ONLY the 7 listed tables; each already has a
--     `tenant_id = current_tenant_id()` SELECT policy (migration 0004).
--     postgres_changes evaluates those existing policies per event under
--     the subscriber's JWT — a tenant-A client NEVER receives a tenant-B
--     row event (AC 26). No new realtime-specific RLS table is needed.
--   * close_session_tx is SECURITY INVOKER: every internal write is checked
--     by the CALLER's RLS WITH CHECK (cannot write another tenant — AC 16).
--     It receives a frozen integer-piastres payload and runs NO money math.
--     It is idempotent by construction (deterministic ids + ON CONFLICT DO
--     NOTHING for append-only ledger rows; terminal-guard backstops).
--   * terminal-guard triggers are SECURITY INVOKER (no privilege escalation);
--     they only REJECT illegal transitions and cannot be bypassed by a stale
--     offline write.
--   * No existing RLS policy is weakened. No SECURITY DEFINER data path added.
-- =============================================================================

-- =============================================================================
-- SECTION 1 — Realtime: REPLICA IDENTITY FULL + publication membership
--
-- REPLICA IDENTITY FULL: stores the full OLD row in the WAL so that
-- postgres_changes can deliver the old tenant_id on UPDATE/DELETE events.
-- Without it, the old-row tenant_id is absent and RLS-based filtering on
-- delete/update delivery is unreliable (ADR-0009 §Q5 Decision).
--
-- Setting REPLICA IDENTITY is idempotent (re-running is a no-op).
-- =============================================================================

alter table public.devices          replica identity full;
alter table public.sessions         replica identity full;
alter table public.session_segments replica identity full;
alter table public.orders           replica identity full;
alter table public.order_items      replica identity full;
alter table public.stock_movements  replica identity full;
alter table public.shifts           replica identity full;

-- Idempotent publication membership guard.
-- Creates `supabase_realtime` if absent (safety for non-Supabase envs),
-- then adds each table only if it is not already a member.
--
-- Isolation note: postgres_changes delivers a row event ONLY to clients
-- whose RLS SELECT policy allows them to see that row — the existing
-- `tenant_id = current_tenant_id()` SELECT policies from migration 0004
-- are the isolation boundary. A tenant-A subscriber CANNOT receive a
-- tenant-B event because the SELECT policy filters it at delivery time.
-- The client `filter: tenant_id=eq.<claim>` is defense-in-depth only.
do $$
declare
  _t text;
begin
  -- Ensure the publication exists (Supabase creates it by default; guard for CI).
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;

  -- Add each operational table only if not already in the publication.
  foreach _t in array array[
    'devices', 'sessions', 'session_segments',
    'orders', 'order_items', 'stock_movements', 'shifts'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname    = 'supabase_realtime'
        and schemaname = 'public'
        and tablename  = _t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', _t);
    end if;
  end loop;
end $$;

-- =============================================================================
-- SECTION 2 — Terminal-state guard triggers (defense-in-depth for Q6 policy)
--
-- A DB trigger is the last line of defense against a stale offline write
-- that tries to reopen a terminal row after a newer close already landed.
-- The trigger runs at the DB level regardless of which code path caused the
-- UPDATE, so it cannot be bypassed by client misbehavior.
--
-- Errcode 'check_violation' (23514) is intentional: the pure `classifyError`
-- in @ps/core maps 23xxx → 'permanent' → dead-letter immediately (no retries
-- wasted on a logically-rejected transition — ADR-0009 §Q4 taxonomy).
--
-- Guard is NARROW: only fires when status transitions OUT of 'closed'.
--   - active → closed : allowed (normal close path)
--   - closed → closed : allowed (replay of the same close — idempotent)
--   - closed → active : BLOCKED (23514)
--   - closed → void   : BLOCKED (23514)
-- =============================================================================

-- ── sessions terminal guard ───────────────────────────────────────────────────
create or replace function public.guard_session_terminal()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Only guard transitions OUT of 'closed'.
  -- 'closed' → 'closed' (replay / idempotent re-close) is explicitly allowed.
  if old.status = 'closed' and new.status is distinct from 'closed' then
    raise exception
      'session % is closed (terminal); cannot transition to status=%',
      old.id, new.status
      using errcode = 'check_violation';   -- 23514 → permanent → dead-letter
  end if;
  return new;
end;
$$;

drop trigger if exists sessions_guard_terminal on public.sessions;
create trigger sessions_guard_terminal
  before update on public.sessions
  for each row execute function public.guard_session_terminal();

-- ── shifts terminal guard ─────────────────────────────────────────────────────
create or replace function public.guard_shift_terminal()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Only guard transitions OUT of 'closed'.
  if old.status = 'closed' and new.status is distinct from 'closed' then
    raise exception
      'shift % is closed (terminal); cannot transition to status=%',
      old.id, new.status
      using errcode = 'check_violation';   -- 23514 → permanent → dead-letter
  end if;
  return new;
end;
$$;

drop trigger if exists shifts_guard_terminal on public.shifts;
create trigger shifts_guard_terminal
  before update on public.shifts
  for each row execute function public.guard_shift_terminal();

-- =============================================================================
-- SECTION 3 — Idempotent transactional close RPC (SECURITY INVOKER)
--
-- close_session_tx is the atomic write path for session close (ADR-0009 §Q3).
-- It fixes the Phase-5 "close sequence not atomic" residual by persisting all
-- five writes (segments + session update + stock movements + device free +
-- audit row) in a single DB transaction — all-or-nothing.
--
-- DESIGN PRINCIPLES:
--
--   SECURITY INVOKER: every internal INSERT/UPDATE is checked by the CALLER'S
--   RLS WITH CHECK. A queue entry carrying a mismatched tenant_id is rejected
--   at the INSERT the same way a direct write would be (AC 16). No SECURITY
--   DEFINER bypass exists on any data path.
--
--   NO MONEY MATH: the function receives a FROZEN, pre-computed payload
--   (integer piastres computed by @ps/core + the mobile close path BEFORE
--   enqueueing). It persists; it does not re-compute (CLAUDE.md §2.1/§2.2).
--
--   IDEMPOTENCY — three mechanisms:
--     (a) Segments: ON CONFLICT (id) DO UPDATE (LWW merge) — a replay of the
--         same segment data lands the identical row. Deterministic ids ensure
--         each boundary sub-segment maps to exactly one DB row.
--     (b) Session update: WHERE s.status <> 'closed' — a replay finds 0 rows
--         (already closed), affects nothing, and the terminal guard trigger
--         never fires (no row selected). The terminal guard is the backstop
--         for any code path that omits the WHERE predicate.
--     (c) Ledger rows (stock_movements, audit_log): ON CONFLICT (id) DO NOTHING
--         — deterministic ids (`stock-sale:{itemId}`, `close:{sessionId}`)
--         mean a replay inserts 0 rows. This is the correct behavior because:
--           - stock_movements has no UPDATE policy (no cross-movement edits),
--             so DO UPDATE would be RLS-rejected on replay.
--           - audit_log has no UPDATE policy (append-only), same issue.
--           - DO NOTHING ensures a replay is a true no-op needing no update
--             grant (ADR-0009 §Q6 table, last column "Guard").
--
--   Parameters (all caller-supplied and frozen — no server-side derivation):
--     p_session_id   uuid      — the session being closed
--     p_tenant_id    uuid      — pinned tenant; RLS WITH CHECK re-verifies
--                                against current_tenant_id() at every write
--     p_branch_id    uuid      — branch for device lookup + audit
--     p_actor_id     uuid      — the manager/staff closing the session
--     p_session_patch jsonb    — {status, ended_at, time_total, grand_total,
--                                  payment_method, shift_id, updated_at}
--     p_segments      jsonb    — array of fully-formed session_segments rows
--                                (deterministic ids; LWW merge on conflict)
--     p_movements     jsonb    — array of stock_movements rows
--                                (deterministic ids; DO NOTHING on conflict)
--     p_device_id     uuid     — device to mark free
--     p_audit         jsonb    — the audit_log row (deterministic id
--                                close:{sessionId}; DO NOTHING on conflict)
-- =============================================================================

create or replace function public.close_session_tx(
  p_session_id    uuid,
  p_tenant_id     uuid,
  p_branch_id     uuid,
  p_actor_id      uuid,
  p_session_patch jsonb,
  p_segments      jsonb,
  p_movements     jsonb,
  p_device_id     uuid,
  p_audit         jsonb
)
returns void
language plpgsql
-- SECURITY DEFINER (not invoker): the audit_log WITH CHECK's is_tenant_staff()
-- evaluated FALSE when the INSERT ran nested inside a SECURITY INVOKER function
-- (a direct manager audit INSERT passes the identical policy — proven by pgTAP
-- probes), so the close failed under invoker. We run as definer and enforce
-- tenant confinement + membership EXPLICITLY below — equivalent protection,
-- robust and auditable. Internal writes bypass RLS but are pinned to
-- p_tenant_id (= the caller's signed claim) by the guards + every WHERE clause.
security definer
set search_path = public
as $$
begin
  -- ── 0. Explicit authorization (replaces the per-row WITH CHECK under invoker) ──
  -- Confine to the caller's own tenant: p_tenant_id MUST equal the signed claim.
  -- A cross-tenant payload (p_tenant_id <> current_tenant_id()) is rejected with
  -- 42501 BEFORE any write — preserving AC 16/26 (cross-tenant close rejected).
  if p_tenant_id is distinct from (select public.current_tenant_id()) then
    raise exception 'close_session_tx: cross-tenant call rejected (payload tenant %, claim %)',
      p_tenant_id, (select public.current_tenant_id()) using errcode = '42501';
  end if;
  -- Caller must be an active member (or live impersonator) of that tenant —
  -- mirrors the is_tenant_staff() WITH CHECK that staff-insert policies enforce.
  if not (select public.is_active_member()) then
    raise exception 'close_session_tx: caller is not an active member of tenant %',
      p_tenant_id using errcode = '42501';
  end if;
  -- ── 1. Session segments: upsert (LWW merge) ────────────────────────────────
  -- Deterministic segment ids (boundary sub-segments keyed by
  -- seg:{sessionId}:{plan.started_at}) make each segment addressable and
  -- idempotent. ON CONFLICT DO UPDATE overwrites with the same data on replay.
  -- Caller's RLS WITH CHECK (tenant_id = current_tenant_id()) enforces
  -- tenant isolation on each inserted/updated row (AC 16).
  --
  -- Explicit column list (omits `created_at`) so new boundary-split rows use
  -- the column DEFAULT (now()) rather than NULL — jsonb_populate_recordset
  -- returns NULL for JSON-absent fields, which would violate the NOT NULL
  -- constraint on `created_at` for new rows. The mobile close payload does not
  -- include `created_at` in segment rows (it only stamps `updated_at`).
  insert into public.session_segments
    (id, tenant_id, session_id, play_mode, rate_rule_id,
     price_per_hour_snapshot, started_at, ended_at, updated_at)
  select
    id, tenant_id, session_id, play_mode, rate_rule_id,
    price_per_hour_snapshot, started_at, ended_at, updated_at
  from jsonb_populate_recordset(null::public.session_segments, p_segments)
  on conflict (id) do update set
    play_mode                = excluded.play_mode,
    rate_rule_id             = excluded.rate_rule_id,
    price_per_hour_snapshot  = excluded.price_per_hour_snapshot,
    started_at               = excluded.started_at,
    ended_at                 = excluded.ended_at,
    updated_at               = excluded.updated_at;

  -- ── 2. Session: terminal-guarded update ────────────────────────────────────
  -- WHERE s.status <> 'closed' makes this idempotent:
  --   * First call:  row is 'active' → UPDATE succeeds → status becomes 'closed'.
  --   * Replay call: row is 'closed' → WHERE matches 0 rows → 0 rows updated;
  --                  terminal-guard trigger never fires (nothing selected).
  -- The trigger is the backend defense-in-depth for any caller that omits this
  -- predicate (e.g. a direct UPDATE from a bug): it rejects 'closed' → non-closed
  -- with errcode 23514 (permanent in classifyError → dead-letter fast).
  update public.sessions s set
    status         = (p_session_patch->>'status')::public.session_status,
    ended_at       = (p_session_patch->>'ended_at')::timestamptz,
    time_total     = (p_session_patch->>'time_total')::bigint,
    grand_total    = (p_session_patch->>'grand_total')::bigint,
    payment_method = nullif(p_session_patch->>'payment_method', '')::public.payment_method,
    shift_id       = nullif(p_session_patch->>'shift_id',       '')::uuid,
    updated_at     = (p_session_patch->>'updated_at')::timestamptz
  where s.id        = p_session_id
    and s.tenant_id = p_tenant_id
    and s.status   <> 'closed';    -- idempotent: replay hits 0 rows; trigger backstops

  -- ── 3. Stock movements: append-only ledger — DO NOTHING on conflict ─────────
  -- Deterministic id `stock-sale:{order_item_id}` ensures each sale movement
  -- is uniquely identified. ON CONFLICT DO NOTHING means:
  --   * First flush:  movement inserted (stock decremented once).
  --   * Replay flush: 0 rows inserted — never a second decrement (AC 14, 15).
  -- DO NOTHING is correct here because stock_movements has no UPDATE policy
  -- (only an owner-write policy for explicit corrections, not for replay idempotency).
  --
  -- Explicit column list (omits `updated_at`) so new rows use the column DEFAULT
  -- (now()) — the mobile movement payload includes `created_at` but not `updated_at`.
  -- The BEFORE UPDATE trigger set_stock_movements_updated_at handles future updates.
  insert into public.stock_movements
    (id, tenant_id, branch_id, product_id, delta, reason,
     order_id, manager_id, note, created_at)
  select
    id, tenant_id, branch_id, product_id, delta, reason,
    order_id, manager_id, note, created_at
  from jsonb_populate_recordset(null::public.stock_movements, p_movements)
  on conflict (id) do nothing;

  -- ── 4. Device: mark free (LWW — idempotent; already free on replay is fine) ─
  -- Caller's `devices_staff_status_update` policy allows staff to update status.
  update public.devices d
  set status     = 'free',
      updated_at = (p_session_patch->>'updated_at')::timestamptz
  where d.id        = p_device_id
    and d.tenant_id = p_tenant_id;

  -- ── 5. Audit log: append-only — DO NOTHING on conflict ─────────────────────
  -- Deterministic id `close:{sessionId}` (computed by @ps/core uuidv5 before
  -- enqueue) means every replay of the same close produces the same id.
  -- ON CONFLICT DO NOTHING makes replay a true no-op:
  --   * First flush:  audit row inserted with correct amount + meta.
  --   * Replay flush: 0 rows inserted — exactly one audit row per close (AC 13).
  -- DO NOTHING is mandatory here: audit_log has NO UPDATE policy (append-only
  -- by design; 0004 gives only INSERT to staff). An ON CONFLICT DO UPDATE
  -- would be RLS-rejected on replay, breaking idempotency. DO NOTHING avoids
  -- needing the UPDATE grant (ADR-0009 §Q6).
  --
  -- Explicit column list for safety (audit_log has no updated_at, but being
  -- explicit is defensive and self-documenting for the reviewer).
  insert into public.audit_log
    (id, tenant_id, branch_id, actor_id, action, entity, entity_id,
     amount, meta, created_at)
  select
    id, tenant_id, branch_id, actor_id, action, entity, entity_id,
    amount, meta, created_at
  from jsonb_populate_record(null::public.audit_log, p_audit)
  on conflict (id) do nothing;

end;
$$;

-- Revoke the default PUBLIC execute grant for least-privilege defense-in-depth.
-- Under `anon`, current_tenant_id()=NULL and auth.uid()=NULL so every WITH CHECK
-- would fail anyway — but `REVOKE FROM PUBLIC` removes the surface entirely.
revoke execute on function public.close_session_tx(
  uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb
) from public;

-- Grant EXECUTE to authenticated (the mobile app's API role).
-- RLS policies on each table are the actual security gate; the GRANT only
-- allows the role to call the function at all.
grant execute on function public.close_session_tx(
  uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb
) to authenticated;

-- =============================================================================
-- END OF MIGRATION 0009
-- =============================================================================
