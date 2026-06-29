-- =============================================================================
-- Migration 0012 — Phase 10 production hardening:
--   (1) Atomic, by-construction audit for catalog/rate-rule config changes
--       (closes the web non-atomic client-insert gap; completes §2.7).
--       ADR-0011 §Q3 — the audit_config_change() AFTER INSERT OR UPDATE trigger
--       replaces the separate client-side audit insert in ProductForm.tsx /
--       ProductsView.tsx / RateRulesView.tsx. The trigger is the SOLE writer.
--   (2) Forward-only index on audit_log(tenant_id, entity, entity_id) to
--       accelerate the "history for this entity" read path (Q4 perf audit).
--
-- NOTE: ADR-0011 named this file 0011_audit_atomicity_and_perf_indexes.sql but
-- migration 0011_cap_reactivation_fix.sql is already applied; per the hand-off
-- instruction this file uses sequence number 0012.
--
-- RLS-safe by construction:
--   * audit_config_change() is SECURITY INVOKER → the audit_log INSERT runs under
--     the caller's RLS (owner has the audit_log insert grant via audit_log_staff_insert
--     in 0004: tenant_id = current_tenant_id() AND is_tenant_staff() — which is true
--     for is_tenant_owner() since owner ⊃ staff). The existing stamp_impersonator()
--     BEFORE INSERT trigger on audit_log still fires on that row and stamps
--     meta.impersonator_id from the signed claim (ADR-0008 preserved — AC 9).
--   * Adds NO policy, NO WITH CHECK on any table, NO SECURITY DEFINER data path
--     (ADR-0007 discipline intact — AC 10).
--   * Context-skip (ADR-0008 verbatim): no JWT claims / role=service_role /
--     null uid ⇒ return null, so seeds/backfills/service-role edits are never
--     blocked by NOT NULL actor_id or the audit policy (AC 7).
--   * Idempotent: deterministic audit id + ON CONFLICT (id) DO NOTHING (§2.8).
--
-- !! WEB CLIENT COORDINATION (critical — AC 6, blocker) !!
--   audit_config_change() is now the SOLE audit writer for products/rate_rules.
--   The web client MUST remove its separate audit_log upsert from:
--     apps/web/src/components/products/ProductForm.tsx  (lines 272-286)
--     apps/web/src/components/products/ProductsView.tsx  (any audit insert)
--     apps/web/src/components/rate-rules/RateRulesView.tsx (any audit insert)
--   Rationale: the client uses uuidv5(action:id:now, PS_UUID_NS) while the
--   trigger uses md5(action:id:epoch_of_updated_at)::uuid — the two schemes
--   produce DIFFERENT ids → if both write, each succeeds and you get 2 audit rows
--   per operation. The trigger cannot be made to match the client's uuidv5 scheme
--   without importing the JS UUID library into SQL. The clean solution is:
--   web engineer removes the client-side audit insert; the trigger owns it.
--   This must be coordinated as a single logical change (web + migration together).
--
-- SECURITY REVIEWER: required sign-off (AC 6–10, 24). Verify:
--   (a) trigger cannot write another tenant's audit row (tenant_id/branch_id from NEW,
--       already RLS-bound by products_owner_write/rate_rules_owner_write WITH CHECK);
--   (b) cannot fake impersonation (stamp_impersonator strips client-supplied
--       meta.impersonator_id when not impersonating — ADR-0008);
--   (c) changes no money/business behavior (audit only, amount=null);
--   (d) context-skip prevents NOT NULL actor_id failures in seed/migration paths.
-- =============================================================================

-- ── 1. audit_config_change() — atomic audit trigger for products & rate_rules ──
--
-- AFTER INSERT OR UPDATE, FOR EACH ROW, SECURITY INVOKER.
-- Receives the entity name ('product' | 'rate_rule') as TG_ARGV[0].
-- Returns NULL (AFTER trigger: return value is ignored by PostgreSQL).
create or replace function public.audit_config_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  _claims text;
  _actor  uuid := (select auth.uid());
  _action text;
  _entity text := tg_argv[0];          -- 'product' | 'rate_rule'
  _meta   jsonb;
  _id     uuid;
begin
  -- (a) Skip non-end-user contexts — ADR-0008 verbatim context-skip:
  --
  --   Step 1: request.jwt.claims absent (empty string) → migration/seed/psql/
  --           direct SQL connection that never sets this GUC → no audit written.
  --           PostgREST sets this GUC on every request; direct SQL never does.
  --
  --   Step 2: JWT role = 'service_role' → Supabase edge function / service-role
  --           PostgREST call → no audit written. These paths use the service-role
  --           client which bypasses RLS; we also skip audit here so they are never
  --           blocked by audit_log's NOT NULL actor_id constraint.
  --
  --   Step 3: auth.uid() is NULL → belt-and-suspenders for any context where no
  --           user identity exists → no audit written.
  --
  --   These three checks guard seed.sql inserts, migration backfills, provision_tenant_atomic,
  --   suspend_tenant, and all other service-role paths from spurious audit failures.
  _claims := current_setting('request.jwt.claims', true);
  if coalesce(_claims, '') = '' then return null; end if;
  if (_claims::jsonb ->> 'role') = 'service_role' then return null; end if;
  if _actor is null then return null; end if;

  -- (b) Derive action verb from TG_OP + the is_active transition.
  --
  --   Action taxonomy (ADR-0011 §Q3, matches client action strings in ProductForm.tsx):
  --     INSERT                             → product.create / rate_rule.create
  --     UPDATE old.is_active=true → false  → product.deactivate / rate_rule.deactivate
  --     UPDATE old.is_active=false → true  → product.reactivate / rate_rule.reactivate
  --     UPDATE (any other field change)    → product.update / rate_rule.update
  --
  --   Meta captures:
  --     INSERT  → snapshot of NEW row (minus tenant_id — already isolated by RLS)
  --     UPDATE  → before/after of OLD and NEW rows (minus tenant_id)
  if tg_op = 'INSERT' then
    _action := _entity || '.create';
    _meta := jsonb_build_object('snapshot', to_jsonb(new) - 'tenant_id');
  else
    -- tg_op = 'UPDATE'
    if old.is_active is distinct from new.is_active then
      -- is_active transition: deactivate or reactivate
      _action := _entity || case when new.is_active then '.reactivate' else '.deactivate' end;
    else
      -- Any other field change: update
      _action := _entity || '.update';
    end if;
    _meta := jsonb_build_object(
      'before', to_jsonb(old) - 'tenant_id',
      'after',  to_jsonb(new) - 'tenant_id'
    );
  end if;

  -- (c) Deterministic audit row id (idempotency — §2.8).
  --
  --   Formula: md5(action || ':' || entity_id || ':' || epoch_of_updated_at)::uuid
  --
  --   A retried upsert that lands the same row (same id + same updated_at) produces
  --   the same audit id → ON CONFLICT DO NOTHING → exactly one audit row per logical
  --   write event. This matches the pattern from ADR-0008 and ADR-0009.
  --
  --   Note: the client (ProductForm.tsx) uses uuidv5(action:id:now, PS_UUID_NS) which
  --   produces a DIFFERENT id than this formula. This is intentional — the web client
  --   must remove its audit insert (see WEB CLIENT COORDINATION above). The two schemes
  --   cannot trivially be unified in SQL, and the trigger is the authoritative path.
  _id := md5(
    _action || ':' || new.id::text || ':' ||
    extract(epoch from new.updated_at)::text
  )::uuid;

  -- (d) Append the audit row.
  --
  --   amount = null: products/rate_rules are config changes, not money transactions
  --                  (CLAUDE.md §2.7 lists them as non-money config changes).
  --   branch_id = null: products and rate_rules are tenant-scoped (not branch-scoped)
  --                     per the 0002 schema; branch_id is nullable on audit_log.
  --
  --   stamp_impersonator() BEFORE INSERT trigger on audit_log fires here
  --   and stamps meta.impersonator_id from the signed claim when impersonating,
  --   or strips any client-supplied impersonator_id when not impersonating
  --   (ADR-0008 — the composition is automatic and cannot be bypassed).
  --
  --   ON CONFLICT DO NOTHING: if a row with this deterministic id already exists
  --   (duplicate trigger invocation, replay, or a pre-trigger client insert that
  --   happens to collide), silently skip — never a duplicate audit row.
  insert into public.audit_log
    (id, tenant_id, branch_id, actor_id, action, entity, entity_id, amount, meta, created_at)
  values
    (_id, new.tenant_id, null, _actor, _action, _entity, new.id, null, _meta, now())
  on conflict (id) do nothing;

  return null;   -- AFTER trigger: return value ignored by PostgreSQL
end;
$$;

-- Trigger on public.products.
-- drop-if-exists makes this migration idempotent on repeated db reset.
drop trigger if exists products_audit_change on public.products;
create trigger products_audit_change
  after insert or update on public.products
  for each row execute function public.audit_config_change('product');

-- Trigger on public.rate_rules.
drop trigger if exists rate_rules_audit_change on public.rate_rules;
create trigger rate_rules_audit_change
  after insert or update on public.rate_rules
  for each row execute function public.audit_config_change('rate_rule');

-- ── 2. Forward-only hot-path index (Q4 perf audit) ────────────────────────────
--
-- Gap confirmed: audit_log (migration 0002) has indexes on:
--   (tenant_id)                → tenant-scoped scan
--   (tenant_id, actor_id)      → "activity by user" queries
--   (tenant_id, action)        → "events of type X" queries
--   (tenant_id, created_at)    → time-range report queries
--
-- Missing: the "history of changes to entity X" query shape:
--   SELECT * FROM audit_log
--   WHERE tenant_id = $1 AND entity = 'product' AND entity_id = $2
--   ORDER BY created_at DESC;
--
-- This is the natural owner/admin read for the config-change audit trail (e.g.,
-- "show me all audit entries for product P" on the product detail page, or for
-- rate_rule R on the rate-rule editor). Without this index the planner falls back
-- to a tenant-scoped sequential scan on audit_log that grows with every audit
-- event in the tenant — O(N_events) instead of O(log N + k_results).
--
-- CREATE INDEX IF NOT EXISTS: idempotent; forward-only; RLS-neutral.
create index if not exists audit_log_entity_idx
  on public.audit_log (tenant_id, entity, entity_id);

-- =============================================================================
-- END OF MIGRATION 0012
-- =============================================================================
