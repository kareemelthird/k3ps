-- =============================================================================
-- Migration 0016 — close_session_tx: persist the operator-entered discount
--
-- WHY (correctness / reconstruction-invariant fix; found by Slice 1 review):
-- Slice 1 added a discount field to the mobile close-session sheet. The client
-- computes grand_total = time_total + orders_total − discount (clamped >= 0 via
-- @ps/core computeGrandTotal) and sends BOTH grand_total AND discount in
-- p_session_patch. But close_session_tx's session UPDATE set-list (migration
-- 0015) wrote grand_total and payment_method yet OMITTED `discount`.
--
-- Effect of the bug: the bill total was reduced correctly, but the sessions.row
-- `discount` column stayed at its old value (0). That:
--   * breaks the reconstruction invariant (CLAUDE.md §3): a stored row had
--     grand_total <> time_total + orders_total − discount(0);
--   * under-reports discounts in reports/reconciliation that read the column.
--
-- THE FIX:
-- Add ONE line to the session UPDATE set-list:
--     discount = coalesce((p_session_patch->>'discount')::bigint, discount)
-- COALESCE (same pattern as orders_total in 0015) keeps it backward-compatible:
--   * old clients that omit the key  → existing value preserved (no surprise);
--   * new clients that send discount  → persisted, so the row reconciles.
--
-- ALL OTHER BEHAVIOR is byte-identical to migration 0015 (security definer,
-- scalar tenant guard, active-member guard, the three per-row payload pin guards,
-- the session_segments ON CONFLICT WHERE tenant guard, orders_total COALESCE,
-- tenant-pinned session/device UPDATEs, DO NOTHING on stock_movements/audit_log,
-- REVOKE/GRANT). Only the one discount line is added.
--
-- RLS-RELEVANT: changes the write behavior of a SECURITY DEFINER function.
-- Security-reviewer sign-off REQUIRED before merge per CLAUDE.md §5.
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
-- checks (migration 0014) + every WHERE clause on UPDATEs (incl. 0015).
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
  -- Migration 0015 adds WHERE session_segments.tenant_id = p_tenant_id to the
  -- DO UPDATE: if (hypothetically) an incoming row's `id` collided with a
  -- tenant-B segment, the DO UPDATE would be a silent no-op rather than
  -- overwriting B's billing snapshot fields. Combined with the 0014 pin guard
  -- that already rejects incoming rows with tenant_id != p_tenant_id, the
  -- session_segments upsert is now fully tenant-confined in both directions.
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
    updated_at               = excluded.updated_at
  where session_segments.tenant_id = p_tenant_id;

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
  --
  -- discount (migration 0016): COALESCE for the same backward-compat reason.
  -- The client now sends an operator-entered discount; grand_total already
  -- accounts for it (computeGrandTotal clamps >= 0). Persisting the column keeps
  -- the row reconcilable: grand_total = time_total + orders_total − discount.
  update public.sessions s set
    status         = (p_session_patch->>'status')::public.session_status,
    ended_at       = (p_session_patch->>'ended_at')::timestamptz,
    time_total     = (p_session_patch->>'time_total')::bigint,
    grand_total    = (p_session_patch->>'grand_total')::bigint,
    orders_total   = coalesce((p_session_patch->>'orders_total')::bigint, orders_total),
    discount       = coalesce((p_session_patch->>'discount')::bigint, discount),
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
-- END OF MIGRATION 0016
-- =============================================================================
