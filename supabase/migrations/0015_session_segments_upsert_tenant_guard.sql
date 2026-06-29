-- =============================================================================
-- Migration 0015 — close_session_tx: tenant guard on session_segments upsert
--
-- WHY (defense-in-depth follow-up to migration 0014):
-- Migration 0014 added per-row payload pin guards that reject any incoming
-- payload row whose tenant_id IS DISTINCT FROM p_tenant_id — so a payload
-- carrying tenant_id=B now raises 42501 before any INSERT runs.
--
-- However the session_segments primary key is a simple global UUID (`id` alone,
-- not composite with tenant_id). The ON CONFLICT (id) DO UPDATE clause
-- previously had no WHERE predicate. If a caller supplied a payload row with
-- tenant_id=A (passes the 0014 pin guard) but whose `id` happens to collide
-- with a tenant-B segment, the DO UPDATE would fire and overwrite B's billing
-- snapshot fields (play_mode, rate_rule_id, price_per_hour_snapshot, started_at,
-- ended_at, updated_at) — the tenant_id column itself is safe (not in the SET
-- list), but the other fields would be corrupted.
--
-- In practice this attack requires guessing a tenant-B segment UUID, which is
-- a uuidv5 derived from an unguessable session UUID — very low practical risk.
-- But defense-in-depth is cheap here and eliminates the imprecision entirely.
--
-- THE FIX:
-- Add `WHERE session_segments.tenant_id = p_tenant_id` to the ON CONFLICT
-- DO UPDATE clause. This constrains the update to only fire when the conflicting
-- row already belongs to the caller's own tenant. A cross-tenant id collision
-- becomes a silent no-op (DO NOTHING semantics) rather than a write.
--
-- Combined with migration 0014's pin guards the invariant is now full:
--   incoming rows: tenant_id must equal p_tenant_id (pin guard raises 42501)
--   existing rows: the upsert only updates same-tenant rows (DO UPDATE WHERE)
--
-- SCOPE: strictly more restrictive — adds a rejection on an already-guarded
-- code path. No legitimate same-tenant upsert is affected because the
-- conflicting row always has the same tenant_id as the incoming payload row.
--
-- ALL OTHER BEHAVIOR is byte-identical to migration 0014 (one WHERE clause
-- added to the ON CONFLICT DO UPDATE on session_segments only).
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
-- END OF MIGRATION 0015
-- =============================================================================
