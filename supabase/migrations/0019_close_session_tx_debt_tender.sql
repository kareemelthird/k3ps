-- =============================================================================
-- Migration 0019 — close_session_tx: debt tender + can_discount enforcement
--
-- WHY (ADR-0012 Decisions B1 + D1):
--
-- This migration is a STRICT SUPERSET of migration 0016. It replaces the 9-arg
-- close_session_tx with a 10-arg version that adds three new guards and one
-- new write step. EVERY existing guard, write, and comment from migration 0016
-- is preserved byte-for-byte. Only additions are made — no guard is weakened.
--
-- NEW PARAM:  p_debt jsonb DEFAULT NULL
--
-- NEW GUARDS (inserted after the 0016 guards, before any write step):
--
--   Guard 0c — p_debt per-row tenant pin:
--     If p_debt is provided, its tenant_id must equal p_tenant_id. Rejects the
--     exploit path where p_tenant_id=A (passes scalar guard) but p_debt.tenant_id=B
--     (would silently write a debt row into tenant B). Same NULL-safe pattern as
--     the migration 0014 per-row payload pin guards (IS DISTINCT FROM).
--     Applies only when p_debt IS NOT NULL (non-debt closes are unaffected).
--
--   Guard 0d — can_discount enforcement (ADR-0012 Decision B1):
--     If the session_patch carries a non-zero discount AND the caller lacks
--     has_permission('can_discount'), reject with 42501. This is the ONE
--     authoritative write-site for discount enforcement (close_session_tx is the
--     only path that finalises a session's discount column). Owners always pass
--     (has_permission() short-circuits on is_tenant_owner()). Staff with absent
--     can_discount flag pass too (permissive default). Only explicit false blocks.
--
--   Guard 0e — debt-close completeness:
--     If payment_method='debt' but p_debt is NULL, reject with 42501. A debt
--     close MUST atomically create the receivable — no money hole where a session
--     is 'debt'-closed but no debts row exists. This guard is permanent (dead-
--     letter on first attempt) so the outbox does not retry it pointlessly.
--
-- NEW WRITE STEP (step 6 — appended after the existing 5 steps):
--
--   Debt INSERT:
--     When p_debt is not null, insert a debts row. Columns sourced from p_debt;
--     status/paid_total default to 'open'/0. ON CONFLICT (id) DO NOTHING for
--     replay idempotency (same debt id = same session, second insert is a no-op).
--     The debts_audit_create AFTER INSERT trigger fires once on first insert;
--     replay is a true no-op because trigger won't fire on 0-rows inserted.
--
-- SIGNATURE CHANGE — OLD vs NEW:
--   OLD (migration 0016):
--     close_session_tx(uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb)
--   NEW (migration 0019):
--     close_session_tx(uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb, jsonb DEFAULT NULL)
--
--   The old 9-arg function is DROPPED. The new 10-arg function with DEFAULT NULL
--   for p_debt is backward-compatible: existing callers passing 9 positional args
--   (or omitting p_debt from a named-param RPC body) use NULL (= non-debt close).
--
-- CLIENT UPDATE REQUIRED (apps/mobile/src/features/session/api.ts):
--   All close_session_tx calls must add p_debt to the payload:
--     non-debt closes: p_debt: null
--     debt closes:     p_debt: { id, tenant_id, customer_id, customer_name,
--                                amount, session_id, manager_id, shift_id, note }
--   The debt id MUST be deterministic: uuidv5(`debt:${sessionId}`, PS_UUID_NS).
--
-- RLS-RELEVANT: changes to a SECURITY DEFINER function that touches the
-- highest-sensitivity write path. Security-reviewer sign-off REQUIRED.
--
-- Forward-only. Never edit an applied migration — add a corrective one.
--
-- SECURITY REVIEWER GATE: Required sign-off before merge. Verify:
--   (a) EVERY existing guard from 0016 is preserved unmodified (scalar tenant,
--       active-member, three per-row payload pins). No guard is weakened.
--   (b) Guard 0c: NULL-safe (IS DISTINCT FROM); p_debt.tenant_id=NULL rejected.
--   (c) Guard 0d: enforced at the one authoritative write-site (close RPC); does
--       not bypass the existing sessions_update RLS can_void gate.
--   (d) Guard 0e: 42501 errcode → treated as permanent by @ps/core classifyError
--       → dead-letters on first attempt (no retries for a programming error).
--   (e) Debt INSERT: ON CONFLICT (id) DO NOTHING makes replay a true no-op.
--       audit trigger fires once per real insert; never on the DO NOTHING path.
--   (f) REVOKE from 9-arg + GRANT to 10-arg: no privilege window.
--   (g) revenue accounting: report_revenue_by_day sums closed sessions regardless
--       of payment_method — no change to revenue reporting. debt_payments are
--       NOT revenue (never summed in revenue reports). ✓
-- =============================================================================

-- =============================================================================
-- Step 1: Revoke and drop the old 9-arg function
-- =============================================================================

-- Revoke old grants before dropping (belt-and-suspenders; DROP removes them too).
revoke execute on function public.close_session_tx(
  uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb
) from public;
revoke execute on function public.close_session_tx(
  uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb
) from authenticated;

-- Drop the old function (the 10-arg replacement below is a new overload, not a
-- replacement, so the old 9-arg must be explicitly removed to avoid ambiguity).
drop function if exists public.close_session_tx(
  uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb
);

-- =============================================================================
-- Step 2: Create the new 10-arg function
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
  p_audit         jsonb,
  p_debt          jsonb default null   -- NEW (Slice 3): debt payload for debt-tender closes
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

  -- ── 0c. NEW: p_debt per-row tenant pin guard (migration 0019) ──────────────
  -- Same pattern as the migration 0014 payload pin guards above. A malicious
  -- caller could pass p_tenant_id=A (passes guard 0) while setting
  -- p_debt.tenant_id=B — silently creating a receivable in tenant B's debts
  -- table. This guard catches that BEFORE any INSERT.
  --
  -- IS DISTINCT FROM is NULL-safe: if p_debt.tenant_id is absent/null in the
  -- JSON → (p_debt->>'tenant_id')::uuid is NULL → NULL IS DISTINCT FROM
  -- p_tenant_id (never null) → true → raises 42501. Fail-closed is correct;
  -- a legitimate debt payload always carries tenant_id.
  --
  -- Guard only fires when p_debt IS NOT NULL (non-debt closes are unaffected).
  if p_debt is not null then
    if (p_debt->>'tenant_id')::uuid is distinct from p_tenant_id then
      raise exception 'close_session_tx: cross-tenant p_debt payload detected (p_debt.tenant_id % != p_tenant_id %)',
        p_debt->>'tenant_id', p_tenant_id using errcode = '42501';
    end if;
  end if;

  -- ── 0d. NEW: can_discount enforcement (migration 0019, ADR-0012 Decision B1) ─
  -- If the patch carries a non-zero discount AND the caller lacks can_discount,
  -- reject with 42501. This gates the normal close FLOW, which is the only path
  -- the app uses to finalise a session's discount. Enforcing it here — rather than
  -- in an RLS policy — is necessary because this function is SECURITY DEFINER and
  -- RLS WITH CHECK does not apply to writes inside it.
  --
  -- CAVEAT (security review Finding 1, ACCEPTED): can_discount is an APP-LEVEL
  -- control, not a hard boundary. A session's manager_id can already set
  -- grand_total (and discount) to any value via a direct PostgREST UPDATE under
  -- the sessions_update policy — so a determined manager bypasses this regardless.
  -- This is consistent with the existing manager-trust money model; audit_log is
  -- the compensating control. Tenant isolation is unaffected (within-tenant only).
  --
  -- has_permission('can_discount') returns:
  --   true  — owner (always), active staff with absent flag (permissive default)
  --   false — active staff with explicit can_discount=false, non-members
  --
  -- coalesce(...)::int: if discount is absent from the patch, defaults to 0
  -- (backward-compatible — old clients that omit discount pass the guard).
  if coalesce((p_session_patch->>'discount')::bigint, 0) <> 0
     and not (select public.has_permission('can_discount'))
  then
    raise exception 'close_session_tx: caller lacks can_discount'
      using errcode = '42501';
  end if;

  -- ── 0e. NEW: debt-close completeness guard (migration 0019) ────────────────
  -- A session closed with payment_method='debt' MUST create a receivable.
  -- If p_debt is null for a debt-tender close, reject with 42501 (permanent
  -- error → dead-letters on first attempt; no retry for a client programming
  -- error). There must never be a gap where a session is 'debt'-closed but
  -- no debts row exists — that would be a money hole (lost revenue tracking).
  if (p_session_patch->>'payment_method') = 'debt' and p_debt is null then
    raise exception 'close_session_tx: payment_method=debt requires p_debt — no money hole'
      using errcode = '42501';
  end if;

  -- ── 0f. NEW: can_manage_debts enforcement on the debt-tender close path ─────
  -- (security review Finding 2). close_session_tx is SECURITY DEFINER and bypasses
  -- RLS, so the debts_insert can_manage_debts gate (migration 0017) does NOT apply
  -- to step 6's debt INSERT below. Without this guard a staff member with
  -- can_manage_debts=false could still extend café credit (آجل) via a debt-tender
  -- close — the exact action the owner denied. This mirrors guard 0d (can_discount),
  -- which exists for the identical "close bypasses RLS" reason.
  --
  -- has_permission('can_manage_debts'): owner short-circuits true; active staff
  -- with absent flag = permissive default (true); explicit false blocks (42501).
  -- Fires ONLY on a debt close (p_debt not null) — non-debt closes are unaffected.
  if p_debt is not null and not (select public.has_permission('can_manage_debts')) then
    raise exception 'close_session_tx: caller lacks can_manage_debts'
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

  -- ── 6. NEW: Debt creation — debt-tender closes only (migration 0019) ────────
  -- Executed ONLY when p_debt IS NOT NULL (guard 0c already tenant-pinned it;
  -- guard 0e already confirmed payment_method='debt' closes always have p_debt).
  --
  -- Columns explicitly listed: status and paid_total are omitted intentionally
  -- (they DEFAULT to 'open' and 0 — correct for a newly created receivable that
  -- has no payments yet).
  --
  -- ON CONFLICT (id) DO NOTHING makes the debt INSERT idempotent:
  --   * First flush:  debt row inserted; debts_audit_create trigger fires once.
  --   * Replay flush: 0 rows inserted — trigger never fires → no duplicate audit.
  --
  -- Deterministic id `debt:{session_id}` is computed client-side by
  -- uuidv5(`debt:${sessionId}`, PS_UUID_NS) before the outbox enqueue.
  -- The session_id → debt_id mapping is 1:1 (a session produces at most one
  -- debt receivable, which is the session's grand_total).
  if p_debt is not null then
    insert into public.debts
      (id, tenant_id, customer_id, customer_name, amount,
       session_id, manager_id, shift_id, note)
    values (
      (p_debt->>'id')::uuid,
      (p_debt->>'tenant_id')::uuid,
      nullif(p_debt->>'customer_id', '')::uuid,
      p_debt->>'customer_name',
      (p_debt->>'amount')::int,
      nullif(p_debt->>'session_id', '')::uuid,
      (p_debt->>'manager_id')::uuid,
      nullif(p_debt->>'shift_id',   '')::uuid,
      p_debt->>'note'
    )
    on conflict (id) do nothing;
  end if;

end;
$$;

-- =============================================================================
-- Step 3: Revoke and grant for the new 10-arg function
-- =============================================================================

-- Revoke the default PUBLIC execute grant (same rationale as migration 0016).
revoke execute on function public.close_session_tx(
  uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb, jsonb
) from public;

-- Grant EXECUTE to authenticated (the mobile app's API role).
grant execute on function public.close_session_tx(
  uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb, jsonb
) to authenticated;

-- =============================================================================
-- END OF MIGRATION 0019
-- =============================================================================
