-- =============================================================================
-- Migration 0020 — audit_debt_change(): SECURITY INVOKER → SECURITY DEFINER
--
-- WHY (corrective; fixes a regression introduced by migration 0018):
--
-- Migration 0018 created audit_debt_change() as SECURITY INVOKER. That is the
-- right default for an audit-writer trigger — EXCEPT it breaks for any caller
-- that is not the tenant owner, because of the documented nested-invoker gotcha:
--
--   When the audit_log INSERT runs nested inside a SECURITY INVOKER trigger,
--   the `audit_log_staff_insert` WITH CHECK's `is_tenant_staff()` evaluates
--   FALSE for a non-owner (manager/staff) caller — even though the SAME caller's
--   direct, top-level audit_log INSERT passes the identical policy. This is the
--   exact bug that forced close_session_tx to SECURITY DEFINER (ADR-0009 /
--   docs/reference/schema-and-rls.md §"close_session_tx SECURITY DEFINER lesson"
--   and migration 0009).
--
-- Symptom: a manager/staff member creating a debt (direct debts INSERT) or
-- recording a debt payment (direct debt_payments INSERT) failed with 42501
-- "new row violates row-level security policy for table audit_log", raised from
-- inside audit_debt_change(). Proven by pgTAP 08 tests 13 + 17 (manager with the
-- permissive-default can_manage_debts → INSERT must succeed) regressing after 0018.
-- (The debt INSERT inside close_session_tx was unaffected, because that function
-- is already SECURITY DEFINER → its nested audit write runs as postgres.)
--
-- THE FIX: make audit_debt_change() SECURITY DEFINER, exactly mirroring the
-- close_session_tx resolution. The function body is otherwise byte-for-byte the
-- same as migration 0018.
--
-- WHY SECURITY DEFINER IS SAFE HERE (no privilege escalation, no cross-tenant leak):
--   * The trigger only ever fires AFTER a debts / debt_payments row has already
--     been inserted — i.e. AFTER that row passed its OWN table's INSERT WITH CHECK,
--     which pins tenant_id = current_tenant_id() (the caller's signed-claim tenant)
--     and gates on has_permission('can_manage_debts'). So NEW is already trusted.
--   * Every value written to audit_log is DERIVED FROM NEW (tenant_id := new.tenant_id,
--     entity_id := new.id, amount := new.amount) or from the verified caller
--     (actor_id := auth.uid(), which is unchanged under DEFINER — it reads the JWT
--     GUC, not the function owner). The trigger cannot be made to write an audit
--     row for another tenant: new.tenant_id == the caller's tenant by construction.
--   * The context-skip (empty claims / service_role / null auth.uid()) is retained
--     verbatim, so seeds / migrations / service-role paths still write no audit row
--     and are never blocked by audit_log's NOT NULL actor_id.
--   * The stamp_impersonator() BEFORE INSERT trigger on audit_log still fires on
--     this insert (it is a separate trigger) and stamps meta.impersonator_id from
--     the signed claim — impersonation auditing (ADR-0008) is fully preserved.
--   * search_path is pinned to public (mandatory for SECURITY DEFINER).
--
-- The existing triggers (debts_audit_create, debt_payments_audit_create) reference
-- this function by name; CREATE OR REPLACE updates the function in place, so the
-- triggers automatically use the new SECURITY DEFINER body — no trigger recreation
-- needed. recompute_debt_totals() is unchanged (it was already SECURITY DEFINER).
--
-- Forward-only. Never edit an applied migration — this is the corrective migration
-- for 0018's audit_debt_change security mode.
--
-- SECURITY REVIEWER GATE: Required sign-off. Verify:
--   (a) DEFINER is safe: every audit_log value derives from the already-RLS-
--       validated NEW row or from auth.uid(); tenant_id is pinned to new.tenant_id;
--       no cross-tenant audit row can be produced.
--   (b) Context-skip preserved verbatim (no seed/service-role audit failures).
--   (c) search_path pinned to public.
--   (d) No RLS policy is added, removed, or weakened by this migration.
--   (e) Behaviour parity with the close_session_tx DEFINER precedent.
-- =============================================================================

create or replace function public.audit_debt_change()
returns trigger
language plpgsql
security definer                      -- CHANGED from 0018 (was: security invoker) — see WHY note
set search_path = public
as $$
declare
  _claims text;
  _actor  uuid := (select auth.uid());
  _action text;
  _id     uuid;
begin
  -- ── (a) Skip non-end-user contexts (ADR-0008 verbatim context-skip) ────────
  --   Step 1: request.jwt.claims absent (empty string) → migration/seed/psql
  --           direct SQL → no audit written.
  --   Step 2: JWT role = 'service_role' → edge function / service-role PostgREST
  --           → no audit written.
  --   Step 3: auth.uid() is NULL → belt-and-suspenders → no audit written.
  _claims := current_setting('request.jwt.claims', true);
  if coalesce(_claims, '') = '' then return null; end if;
  if (_claims::jsonb ->> 'role') = 'service_role' then return null; end if;
  if _actor is null then return null; end if;

  -- ── (b) Derive action and deterministic id based on trigger source ──────────
  if tg_table_name = 'debts' then
    _action := 'debt.create';
    _id     := md5('debt.create:' || new.id::text)::uuid;

    insert into public.audit_log
      (id, tenant_id, branch_id, actor_id, action, entity, entity_id,
       amount, meta, created_at)
    values
      (_id, new.tenant_id, null, _actor, _action, 'debt', new.id,
       new.amount,
       jsonb_build_object(
         'customer_name', new.customer_name,
         'amount',        new.amount
       ),
       now())
    on conflict (id) do nothing;

  elsif tg_table_name = 'debt_payments' then
    _action := 'debt.payment';
    _id     := md5('debt.payment:' || new.id::text)::uuid;

    insert into public.audit_log
      (id, tenant_id, branch_id, actor_id, action, entity, entity_id,
       amount, meta, created_at)
    values
      (_id, new.tenant_id, null, _actor, _action, 'debt_payment', new.id,
       new.amount,
       jsonb_build_object(
         'debt_id', new.debt_id,
         'amount',  new.amount
       ),
       now())
    on conflict (id) do nothing;
  end if;

  return null;  -- AFTER trigger: return value ignored by PostgreSQL
end;
$$;

-- =============================================================================
-- END OF MIGRATION 0020
-- =============================================================================
