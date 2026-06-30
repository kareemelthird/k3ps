-- =============================================================================
-- Migration 0018 — Debt ledger mechanics (Slice 3, ADR-0012 Decision D1)
--
-- What this migration does:
--   1. Adds  `debt_status` enum: open / partially_paid / settled.
--   2. Adds  `debts.status`     (debt_status, NOT NULL, default 'open').
--   3. Adds  `debts.paid_total` (integer piastres, NOT NULL, default 0).
--      `remaining = amount - paid_total` is DERIVED in views/queries; never stored.
--   4. Adds  `debts_tenant_status_idx` for the "open debts" dashboard query.
--   5. Adds  `customers_tenant_phone_idx` for phone-based customer lookup.
--   6. Creates `recompute_debt_totals()` — AFTER INSERT OR UPDATE OR DELETE trigger
--      on debt_payments; SECURITY DEFINER (see note below).
--      Idempotent: paid_total := Σ debt_payments.amount (ledger summation —
--      same pattern as on_hand = Σ delta; not pricing math).
--   7. Creates `audit_debt_change()` — AFTER INSERT trigger on debts AND
--      debt_payments; SECURITY INVOKER, context-skip (ADR-0008 verbatim).
--      Clones the audit_config_change() pattern from migration 0012.
--
-- WHY recompute_debt_totals() is SECURITY DEFINER (not INVOKER):
--   The trigger updates public.debts (parent table) when a payment is inserted.
--   The debts_update RLS policy gates updates to manager_id = auth.uid() OR
--   is_tenant_owner() — so a SECURITY INVOKER trigger called by Manager X
--   would silently fail (0 rows updated) when the debt was created by Manager Y,
--   leaving paid_total stale. SECURITY DEFINER bypasses RLS; the WHERE clause
--   pins to debt_id + tenant_id (no cross-tenant access possible). This is the
--   same justification as other SECURITY DEFINER aggregation helpers.
--
-- WHY audit_debt_change() is SECURITY INVOKER:
--   For direct client-side inserts (debt created by a UI action) the trigger
--   runs under the caller's RLS. For inserts inside close_session_tx (SECURITY
--   DEFINER, runs as postgres), the SECURITY INVOKER trigger also runs as
--   postgres (same privilege level as the enclosing SECURITY DEFINER) — audit
--   row is still correctly stamped via auth.uid() / JWT GUC.
--   Same reasoning as audit_config_change() (migration 0012).
--
-- Forward-only. Never edit an applied migration — add a corrective one.
--
-- SECURITY REVIEWER GATE: Required sign-off before merge. Verify:
--   (a) recompute_debt_totals() SECURITY DEFINER: only updates the parent debt
--       of the triggering payment row; WHERE clause is tenant-pinned (both
--       debt_id AND tenant_id); cannot reach another tenant's debts.
--   (b) audit_debt_change() context-skip: correctly skips seeds/service-role/
--       null-uid paths to avoid audit_log NOT NULL actor_id failures.
--   (c) No existing RLS policy weakened.
--   (d) paid_total arithmetic is integer-only (no floats); status derivation is
--       deterministic and idempotent (re-running gives same result).
-- =============================================================================

-- =============================================================================
-- 1. debt_status enum
-- =============================================================================
create type public.debt_status as enum ('open', 'partially_paid', 'settled');

-- =============================================================================
-- 2+3. New columns on public.debts
--
-- status:     lifecycle (open → partially_paid → settled).
--             Maintained by the recompute trigger on debt_payments.
-- paid_total: running sum of all associated debt_payments.amount values
--             (piastres; maintained by trigger — NOT hand-computed in SQL at
--             query time; NOT pricing math — it is ledger summation of stored
--             piastres, same pattern as product_stock_levels.on_hand = Σ delta).
--             `remaining = amount - paid_total` is always derived; never stored.
--
-- Both columns default to the "just created, no payments yet" state.
-- No backfill needed: existing rows are implicitly open with no payments.
-- =============================================================================

alter table public.debts
  add column status     public.debt_status not null default 'open',
  add column paid_total int                not null default 0;

-- =============================================================================
-- 4. Indexes
-- =============================================================================

-- Owner-dashboard "open debts" list: (tenant_id, status) — tenant_id leads.
create index debts_tenant_status_idx
  on public.debts (tenant_id, status);

-- Optional: phone-based customer lookup at debt-close time.
create index customers_tenant_phone_idx
  on public.customers (tenant_id, phone);

-- =============================================================================
-- 5. recompute_debt_totals() — AFTER INSERT OR UPDATE OR DELETE on debt_payments
--
-- SECURITY DEFINER required: see module-level note.
-- Tenant-pinned: the UPDATE always carries AND tenant_id = _tenant_id.
-- Idempotent: a DO-NOTHING-skipped duplicate payment insert never fires the
-- trigger; re-summing gives the same result regardless of trigger count.
-- =============================================================================

create or replace function public.recompute_debt_totals()
returns trigger
language plpgsql
security definer                     -- see WHY note above
set search_path = public
as $$
declare
  _debt_id   uuid;
  _tenant_id uuid;
  _paid      int;
  _amount    int;
  _status    public.debt_status;
begin
  -- ── Resolve which debt to recompute ────────────────────────────────────────
  -- For DELETE: use OLD (the payment being removed).
  -- For INSERT: use NEW (the payment being added).
  -- For UPDATE where debt_id changed: recompute OLD debt FIRST, then fall
  --   through to recompute the NEW debt (the final block below).
  --
  -- Changing debt_id on a payment is an edge case that should never happen in
  -- normal UI flows, but we handle it correctly for completeness.

  if tg_op = 'DELETE' then
    _debt_id   := old.debt_id;
    _tenant_id := old.tenant_id;

  elsif tg_op = 'UPDATE' and old.debt_id is distinct from new.debt_id then
    -- Payment moved between debts — recompute OLD debt first.
    select coalesce(sum(amount), 0) into _paid
    from public.debt_payments
    where debt_id = old.debt_id and tenant_id = old.tenant_id;

    select amount into _amount
    from public.debts
    where id = old.debt_id and tenant_id = old.tenant_id;

    update public.debts
    set paid_total = _paid,
        status     = case
                       when _paid <= 0       then 'open'::public.debt_status
                       when _paid >= _amount then 'settled'::public.debt_status
                       else                       'partially_paid'::public.debt_status
                     end,
        updated_at = now()
    where id = old.debt_id and tenant_id = old.tenant_id;  -- tenant-pinned

    -- Fall through to recompute NEW debt below.
    _debt_id   := new.debt_id;
    _tenant_id := new.tenant_id;

  else
    -- INSERT or UPDATE (same debt_id).
    _debt_id   := new.debt_id;
    _tenant_id := new.tenant_id;
  end if;

  -- ── Idempotent aggregate: paid_total = Σ debt_payments.amount ────────────
  -- This is ledger summation (NOT pricing math) — same pattern as
  -- on_hand = Σ stock_movements.delta; permitted in DB (CLAUDE.md §4, §3).
  -- Integer-only: sum(int) is always int in PostgreSQL.
  select coalesce(sum(amount), 0) into _paid
  from public.debt_payments
  where debt_id = _debt_id and tenant_id = _tenant_id;

  select amount into _amount
  from public.debts
  where id = _debt_id and tenant_id = _tenant_id;

  -- ── Derive status (deterministic) ─────────────────────────────────────────
  -- open:         no payments yet (paid_total = 0).
  -- partially_paid: partial settlement (0 < paid_total < amount).
  -- settled:      fully paid (paid_total >= amount; over-payment is settled).
  _status := case
    when _paid <= 0       then 'open'::public.debt_status
    when _paid >= _amount then 'settled'::public.debt_status
    else                       'partially_paid'::public.debt_status
  end;

  -- ── Tenant-pinned UPDATE on debts ─────────────────────────────────────────
  update public.debts
  set paid_total = _paid,
      status     = _status,
      updated_at = now()
  where id = _debt_id and tenant_id = _tenant_id;  -- tenant_id pin is mandatory

  return null;  -- AFTER trigger: return value ignored by PostgreSQL
end;
$$;

-- Trigger: fires AFTER each payment INSERT / UPDATE / DELETE.
-- drop-if-exists makes this idempotent on repeated db reset.
drop trigger if exists debt_payments_recompute on public.debt_payments;
create trigger debt_payments_recompute
  after insert or update or delete on public.debt_payments
  for each row execute function public.recompute_debt_totals();

-- =============================================================================
-- 6. audit_debt_change() — AFTER INSERT on debts and debt_payments
--
-- SECURITY INVOKER: see module-level note.
-- Context-skip (ADR-0008 verbatim): skips when no JWT claims / service_role /
-- null auth.uid() — prevents NOT NULL actor_id failures in seed/migration paths.
-- Deterministic id: md5(action:entity_id)::uuid — ON CONFLICT DO NOTHING makes
-- replay a true no-op (idempotency guarantee — CLAUDE.md §2.8).
-- =============================================================================

create or replace function public.audit_debt_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  _claims text;
  _actor  uuid := (select auth.uid());
  _action text;
  _id     uuid;
begin
  -- ── (a) Skip non-end-user contexts (ADR-0008 verbatim context-skip) ────────
  --
  --   Step 1: request.jwt.claims absent (empty string) → migration/seed/psql
  --           direct SQL → no audit written.
  --   Step 2: JWT role = 'service_role' → edge function / service-role PostgREST
  --           → no audit written. (These calls use BYPASSRLS; we also skip here
  --           so they are never blocked by audit_log's NOT NULL actor_id.)
  --   Step 3: auth.uid() is NULL → belt-and-suspenders → no audit written.
  _claims := current_setting('request.jwt.claims', true);
  if coalesce(_claims, '') = '' then return null; end if;
  if (_claims::jsonb ->> 'role') = 'service_role' then return null; end if;
  if _actor is null then return null; end if;

  -- ── (b) Derive action and deterministic id based on trigger source ──────────
  if tg_table_name = 'debts' then
    -- debt.create: fired on AFTER INSERT on debts.
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
    -- debt.payment: fired on AFTER INSERT on debt_payments.
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

-- Trigger on public.debts (debt creation audit).
drop trigger if exists debts_audit_create on public.debts;
create trigger debts_audit_create
  after insert on public.debts
  for each row execute function public.audit_debt_change();

-- Trigger on public.debt_payments (payment audit).
drop trigger if exists debt_payments_audit_create on public.debt_payments;
create trigger debt_payments_audit_create
  after insert on public.debt_payments
  for each row execute function public.audit_debt_change();

-- =============================================================================
-- END OF MIGRATION 0018
-- =============================================================================
