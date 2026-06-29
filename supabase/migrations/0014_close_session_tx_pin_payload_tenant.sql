-- =============================================================================
-- Migration 0014 — close_session_tx: per-row payload tenant-pinning guards
--
-- WHY (cross-phase regression fix):
-- Phase 8 deliberately changed close_session_tx from SECURITY INVOKER to
-- SECURITY DEFINER because the nested audit_log INSERT failed 42501 under
-- INVOKER (is_tenant_staff() in the audit_log WITH CHECK evaluated FALSE in
-- the nested-invoker context). The DEFINER switch fixed that correctness bug
-- but silently dropped per-row RLS enforcement: under SECURITY DEFINER
-- (owner=postgres → BYPASSRLS), the INSERT policies' WITH CHECK predicates
-- do NOT apply to writes inside the function.
--
-- THE BUG (cross-tenant WRITE primitive):
-- The only tenant guard after Phase 8 was the SCALAR check:
--   if p_tenant_id is distinct from current_tenant_id() then raise 42501;
-- This guard prevents p_tenant_id=B when the caller's claim is A. But a
-- malicious tenant-A member can call with p_tenant_id=A (passes scalar guard)
-- and embed tenant_id=B inside individual payload rows. Before this migration,
-- three INSERTs consumed tenant_id from client-supplied jsonb without pinning:
--   • session_segments INSERT  (~0013 line 90-96)
--   • stock_movements INSERT   (~0013 line 141-147)
--   • audit_log INSERT         (~0013 line 171-177)
-- Exploit: authenticated A-member calls with p_tenant_id=A but payload rows
-- carrying tenant_id=B → rows land in tenant B. The session/device UPDATEs
-- are safe (they have WHERE tenant_id = p_tenant_id); only these three
-- payload INSERTs were vulnerable.
--
-- THE FIX:
-- Add three per-row tenant-pinning guards immediately after the two existing
-- scalar guards, before any INSERT. Each guard checks EVERY row in the
-- respective payload; if any row's tenant_id IS DISTINCT FROM p_tenant_id
-- (NULL-safe), raise 42501. This restores exactly what the RLS WITH CHECK
-- would have enforced under SECURITY INVOKER. Guard pinning to p_tenant_id
-- == pinning to the caller's signed-claim tenant (guard 0 already verified
-- p_tenant_id = current_tenant_id()).
--
-- SCOPE: this change is STRICTLY MORE RESTRICTIVE — it adds rejections that
-- did not exist before. No legitimate same-tenant close call is affected,
-- because a legitimate client always sets every payload row's tenant_id to
-- the same tenant as the caller's claim. No other behavior changes.
--
-- MISLEADING COMMENT FIXED: the "Caller's RLS WITH CHECK enforces tenant
-- isolation on each inserted/updated row" note in the session_segments section
-- of migration 0013 (carried from the original INVOKER design) was false under
-- SECURITY DEFINER. That comment is corrected below to state the truth.
--
-- RLS-RELEVANT: adds 42501 rejection paths on INSERT payloads. Security-
-- reviewer sign-off REQUIRED before merge per CLAUDE.md §5 and AGENTS.md.
--
-- Forward-only. Never edit an applied migration — add a corrective one.
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
-- p_tenant_id (= the caller's signed claim) by the guards + per-row payload
-- checks (migration 0014) + every WHERE clause on UPDATEs.
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

  -- ── 0b. Per-row payload tenant-pinning guards (migration 0014) ─────────────
  -- SECURITY DEFINER bypasses RLS; the WITH CHECK (tenant_id = current_tenant_id())
  -- on each table's INSERT policy does NOT apply inside this function. Guard 0
  -- above confirms p_tenant_id equals the caller's signed claim, but a malicious
  -- caller can pass p_tenant_id=A (passes scalar guard) while embedding tenant_id=B
  -- inside individual payload rows — silently writing to tenant B's tables under
  -- BYPASSRLS. These guards close that exploit by validating every payload row's
  -- tenant_id against p_tenant_id BEFORE any INSERT executes.
  -- IS DISTINCT FROM is NULL-safe: a payload row with tenant_id=NULL is also
  -- rejected — correct fail-loud behavior; a legitimate client always sends it.
  if exists (
    select 1
    from jsonb_populate_recordset(null::public.session_segments, p_segments)
    where tenant_id is distinct from p_tenant_id
  ) then
    raise exception 'close_session_tx: cross-tenant session_segments payload detected'
      using errcode = '42501';
  end if;
  if exists (
    select 1
    from jsonb_populate_recordset(null::public.stock_movements, p_movements)
    where tenant_id is distinct from p_tenant_id
  ) then
    raise exception 'close_session_tx: cross-tenant stock_movements payload detected'
      using errcode = '42501';
  end if;
  if exists (
    select 1
    from jsonb_populate_record(null::public.audit_log, p_audit)
    where tenant_id is distinct from p_tenant_id
  ) then
    raise exception 'close_session_tx: cross-tenant audit_log payload detected'
      using errcode = '42501';
  end if;

  -- ── 1. Session segments: upsert (LWW merge) ────────────────────────────────
  -- Deterministic segment ids (boundary sub-segments keyed by
  -- seg:{sessionId}:{plan.started_at}) make each segment addressable and
  -- idempotent. ON CONFLICT DO UPDATE overwrites with the same data on replay.
  -- SECURITY DEFINER bypasses RLS; per-row tenant isolation is re-enforced by
  -- the explicit payload-pin guards in migration 0014 (above). AC 16 holds.
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
  --
  -- orders_total: COALESCE so a patch that omits the key preserves the existing
  -- row value (backward-compatible — old clients pass nothing, new clients pass
  -- the computed sum of non-void order lines from @ps/core).
  update public.sessions s set
    status         = (p_session_patch->>'status')::public.session_status,
    ended_at       = (p_session_patch->>'ended_at')::timestamptz,
    time_total     = (p_session_patch->>'time_total')::bigint,
    grand_total    = (p_session_patch->>'grand_total')::bigint,
    orders_total   = coalesce((p_session_patch->>'orders_total')::bigint, orders_total),
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
-- END OF MIGRATION 0014
-- =============================================================================
