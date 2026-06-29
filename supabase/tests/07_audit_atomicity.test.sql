-- =============================================================================
-- 07_audit_atomicity.test.sql — pgTAP proof for migration 0012 (ADR-0011 §Q3/Q4)
--
-- Proves six guarantees introduced by the audit_config_change() trigger:
--
--   BLOCK A — Product INSERT audit (AC 6, 8):
--     Tests 1–3: inserting a product as Owner Alpha (authenticated owner) writes
--     exactly 1 audit_log row with action='product.create', the correct tenant_id
--     / actor_id / entity, and the trigger does NOT block the write (SECURITY
--     INVOKER + owner's audit_log_staff_insert policy pass together).
--
--   BLOCK B — Product UPDATE audit (AC 8):
--     Tests 4–5: updating a product name writes exactly 1 additional audit_log
--     row (action='product.update') with the correct actor.
--
--   BLOCK C — is_active transition actions (AC 8):
--     Tests 6–7: an UPDATE that sets is_active=false generates 'product.deactivate';
--     an UPDATE that sets is_active=true generates 'product.reactivate'.
--
--   BLOCK D — rate_rule trigger (AC 8):
--     Tests 8–9: the same trigger wired to rate_rules writes exactly 1 row with
--     action='rate_rule.create' on INSERT.
--
--   BLOCK E — Context-skip: ADR-0008 guard (AC 7):
--     Tests 10–11: a superuser INSERT (no JWT claims) and a service-role-JWT
--     INSERT both produce ZERO audit_log rows — the trigger's three-step
--     context-skip returns null before any write.
--
--   BLOCK F — Deterministic id + idempotency (AC 6, §2.8):
--     Tests 12–13: the stored audit_log.id matches the deterministic formula
--     md5(action:entity_id:epoch_of_updated_at)::uuid; a second insert with the
--     same id (simulating a replay or a pre-trigger client insert) is silently
--     discarded by ON CONFLICT DO NOTHING — still exactly 1 row.
--
-- UUID legend (ALL valid RFC-4122 hex; no collision with seed.sql or tests 01–06):
--   Tenant A:       aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa  (from seed)
--   Owner Alpha:    00000000-0000-4000-8000-000000000001  (from seed)
--   Test product:   aaaaaaaa-c0de-4000-8000-000000000099  (this file only)
--   Test rate_rule: aaaaaaaa-44ee-4000-8000-000000000099  (this file only)
--   Skip product:   aaaaaaaa-c0de-4000-8000-000000000098  (context-skip test)
--   Skip rate_rule: aaaaaaaa-44ee-4000-8000-000000000098  (context-skip test)
--
-- Fixed updated_at for Block F determinism:
--   '2026-06-26T12:00:00+00:00'::timestamptz → epoch 1750939200
--
-- Plan: 13 tests.
-- Depends on seed.sql (Tenant A and Owner Alpha already seeded).
-- All fixture writes are inside this transaction and rolled back at the end.
-- Run: npx supabase test db  (local Supabase stack / CI).
-- =============================================================================

begin;
select plan(13);

-- ===========================================================================
-- BLOCK A — Product INSERT audit (Tests 1–3)
-- ===========================================================================

-- Authenticate as Owner Alpha (Tenant A, roles='owner').
-- This matches the seed.sql tenant_members row:
--   tenant_id='aaaaaaaa…', profile_id='00000000…0001', role='owner', is_active=true
-- is_tenant_owner() = true  → products_owner_write WITH CHECK passes.
-- is_tenant_staff() = true  → audit_log_staff_insert WITH CHECK passes (trigger write).
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'owner',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

-- Test 1 — INSERT product as owner succeeds.
-- Proves the SECURITY INVOKER trigger does NOT break the write: the trigger's
-- internal audit_log INSERT runs under Owner Alpha's RLS and must pass the
-- audit_log_staff_insert WITH CHECK (tenant_id = current_tenant_id() AND
-- is_tenant_staff()). If either the product INSERT or the trigger's audit INSERT
-- fails, lives_ok reports the failure.
--
-- updated_at is set to a fixed timestamp so Block F can verify the deterministic id
-- formula. The set_updated_at() trigger is BEFORE UPDATE only and does not override
-- the explicit value on INSERT.
select lives_ok(
  $$ insert into public.products
       (id, tenant_id, name, category, price, is_active, updated_at)
     values (
       'aaaaaaaa-c0de-4000-8000-000000000099',
       'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
       'Test Widget', 'test', 1000, true,
       '2026-06-26T12:00:00+00:00'::timestamptz
     ) $$,
  'product.create: INSERT as owner succeeds — trigger + audit_log write both pass RLS (SECURITY INVOKER)');

-- Switch to superuser for verification (audit_log SELECT requires is_tenant_owner()
-- which owner has, but owner RLS scoping requires setting JWT each query).
-- Superuser bypasses RLS — consistent with all other test files.
reset role;

-- Test 2 — Exactly 1 audit_log row for the INSERT, action='product.create'.
-- Proves: (a) trigger fired atomically in the same statement, (b) exactly one row
-- (not 0 — the trigger didn't skip, not 2 — no duplicate), (c) action is correct.
select is(
  (select count(*)::bigint
   from public.audit_log
   where entity_id = 'aaaaaaaa-c0de-4000-8000-000000000099'::uuid
     and action    = 'product.create'),
  1::bigint,
  'product.create: exactly 1 audit_log row with action=product.create (atomic, same statement)');

-- Test 3 — Audit row has correct tenant_id, actor_id, entity.
-- Proves tenant isolation (trigger reads NEW.tenant_id = Tenant A, cannot cross
-- tenant) and actor attribution (trigger reads auth.uid() = Owner Alpha).
-- NULL result (row not found) evaluates to false → test fails with a clear message.
select is(
  (select (
     tenant_id = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid
     and actor_id = '00000000-0000-4000-8000-000000000001'::uuid
     and entity   = 'product'
   )
   from public.audit_log
   where entity_id = 'aaaaaaaa-c0de-4000-8000-000000000099'::uuid
     and action    = 'product.create'),
  true,
  'product.create: audit row has tenant_id=TenantA, actor_id=OwnerAlpha, entity=product');

-- ===========================================================================
-- BLOCK B — Product UPDATE audit (Tests 4–5)
-- ===========================================================================

-- Re-establish Owner Alpha JWT (reset role cleared the session to superuser context;
-- GUC request.jwt.claims persists within the transaction but role is reset).
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'owner',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

-- UPDATE product name → set_updated_at() fires (BEFORE UPDATE) and stamps a new
-- updated_at; then audit_config_change() fires (AFTER UPDATE) and writes a row
-- with action='product.update'.
update public.products
set name = 'Test Widget Updated'
where id = 'aaaaaaaa-c0de-4000-8000-000000000099';

reset role;

-- Test 4 — Exactly 1 audit_log row for the UPDATE, action='product.update'.
-- (Not 0: trigger fired and wrote. Not 2: ON CONFLICT deduplication works.)
select is(
  (select count(*)::bigint
   from public.audit_log
   where entity_id = 'aaaaaaaa-c0de-4000-8000-000000000099'::uuid
     and action    = 'product.update'),
  1::bigint,
  'product.update: exactly 1 audit_log row with action=product.update');

-- Test 5 — Update audit row has correct actor_id.
-- Proves the trigger reads auth.uid() correctly for UPDATEs (not a cached INSERT value).
select is(
  (select actor_id
   from public.audit_log
   where entity_id = 'aaaaaaaa-c0de-4000-8000-000000000099'::uuid
     and action    = 'product.update'),
  '00000000-0000-4000-8000-000000000001'::uuid,
  'product.update: audit row actor_id = Owner Alpha');

-- ===========================================================================
-- BLOCK C — is_active transition: deactivate / reactivate (Tests 6–7)
-- ===========================================================================

-- Owner Alpha deactivates the product (is_active: true → false).
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'owner',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

update public.products
set is_active = false
where id = 'aaaaaaaa-c0de-4000-8000-000000000099';

reset role;

-- Test 6 — is_active true→false produces action='product.deactivate'.
select is(
  (select count(*)::bigint
   from public.audit_log
   where entity_id = 'aaaaaaaa-c0de-4000-8000-000000000099'::uuid
     and action    = 'product.deactivate'),
  1::bigint,
  'product.deactivate: is_active true→false generates action=product.deactivate (exactly 1 row)');

-- Owner Alpha reactivates the product (is_active: false → true).
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'owner',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

update public.products
set is_active = true
where id = 'aaaaaaaa-c0de-4000-8000-000000000099';

reset role;

-- Test 7 — is_active false→true produces action='product.reactivate'.
select is(
  (select count(*)::bigint
   from public.audit_log
   where entity_id = 'aaaaaaaa-c0de-4000-8000-000000000099'::uuid
     and action    = 'product.reactivate'),
  1::bigint,
  'product.reactivate: is_active false→true generates action=product.reactivate (exactly 1 row)');

-- ===========================================================================
-- BLOCK D — rate_rule trigger (Tests 8–9)
-- ===========================================================================

-- Owner Alpha inserts a rate_rule — verifies the trigger is wired on rate_rules too.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'owner',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

-- Test 8 — INSERT rate_rule as owner succeeds.
select lives_ok(
  $$ insert into public.rate_rules
       (id, tenant_id, billing_mode, is_active)
     values (
       'aaaaaaaa-44ee-4000-8000-000000000099',
       'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
       'open', true
     ) $$,
  'rate_rule.create: INSERT as owner succeeds — trigger fires on rate_rules table');

reset role;

-- Test 9 — Exactly 1 audit_log row for the rate_rule INSERT, action='rate_rule.create'.
select is(
  (select count(*)::bigint
   from public.audit_log
   where entity_id = 'aaaaaaaa-44ee-4000-8000-000000000099'::uuid
     and action    = 'rate_rule.create'),
  1::bigint,
  'rate_rule.create: exactly 1 audit_log row with action=rate_rule.create');

-- ===========================================================================
-- BLOCK E — Context-skip: ADR-0008 guard (Tests 10–11)
-- ===========================================================================

-- Test 10 — Superuser INSERT with NO JWT claims → trigger skips → 0 audit rows.
--
-- Simulates a seed.sql / migration / direct-psql context where PostgREST never
-- sets request.jwt.claims. The trigger's Step 1 check:
--   coalesce(current_setting('request.jwt.claims', true), '') = '' → return null
-- returns null before any write, so audit_log is untouched.
--
-- The superuser role bypasses RLS entirely, so the INSERT itself succeeds.
-- audit_log is verified to have 0 rows for this entity_id.
select set_config('request.jwt.claims', '', true);
-- role stays superuser (RLS bypassed)

insert into public.products
  (id, tenant_id, name, category, price, is_active)
values (
  'aaaaaaaa-c0de-4000-8000-000000000098',
  'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
  'Seed Product (no audit expected)', 'test', 500, true
);

select is(
  (select count(*)::bigint
   from public.audit_log
   where entity_id = 'aaaaaaaa-c0de-4000-8000-000000000098'::uuid),
  0::bigint,
  'context-skip (no JWT claims): superuser INSERT → trigger returns null → 0 audit_log rows');

-- Test 11 — service_role JWT → trigger skips → 0 audit rows.
--
-- Simulates a Supabase edge function / service-role PostgREST call where the JWT
-- carries role='service_role'. The trigger's Step 2 check:
--   (_claims::jsonb ->> 'role') = 'service_role' → return null
-- returns null before any write. auth.uid() is null for service_role (no 'sub'),
-- but Step 2 fires before Step 3, so the service_role check is definitive.
--
-- The superuser role bypasses RLS so the INSERT succeeds regardless of JWT.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'role', 'service_role'
  )::text,
  true
);
-- role stays superuser (mirrors service-role bypassing RLS in production)

insert into public.rate_rules
  (id, tenant_id, billing_mode, is_active)
values (
  'aaaaaaaa-44ee-4000-8000-000000000098',
  'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
  'open', true
);

select is(
  (select count(*)::bigint
   from public.audit_log
   where entity_id = 'aaaaaaaa-44ee-4000-8000-000000000098'::uuid),
  0::bigint,
  'context-skip (service_role JWT): INSERT → trigger returns null → 0 audit_log rows');

-- ===========================================================================
-- BLOCK F — Deterministic id + idempotency (Tests 12–13)
-- ===========================================================================

-- Clear JWT state from Block E (superuser context; no role change needed).
select set_config('request.jwt.claims', '', true);

-- Test 12 — The audit_log.id matches the deterministic formula.
--
-- The product in Block A was inserted with:
--   action    = 'product.create'
--   entity_id = 'aaaaaaaa-c0de-4000-8000-000000000099'
--   updated_at = '2026-06-26T12:00:00+00:00'::timestamptz
--     → epoch = extract(epoch from '2026-06-26T12:00:00+00:00'::timestamptz)
--
-- Expected id = md5('product.create:aaaaaaaa-c0de-4000-8000-000000000099:' || epoch)::uuid
--
-- This test proves the trigger uses the documented formula (ADR-0011 §Q3) and
-- that the id is reproducibly derivable from the write parameters alone.
select is(
  (select id
   from public.audit_log
   where entity_id = 'aaaaaaaa-c0de-4000-8000-000000000099'::uuid
     and action    = 'product.create'),
  (select md5(
     'product.create' || ':' ||
     'aaaaaaaa-c0de-4000-8000-000000000099' || ':' ||
     extract(epoch from '2026-06-26T12:00:00+00:00'::timestamptz)::text
   )::uuid),
  'deterministic id: audit_log.id = md5(action:entity_id:epoch_of_updated_at)::uuid');

-- Test 13 — ON CONFLICT DO NOTHING: a second write with the same deterministic id
-- is silently discarded — still exactly 1 row.
--
-- Simulates: a pre-migration client insert that happened to use the same id formula,
-- a replayed trigger invocation, or a retry scenario. The idempotency guarantee
-- means the count stays at 1 regardless of how many times the same logical event
-- is recorded (§2.8 — idempotent writes, CLAUDE.md).
--
-- As superuser (RLS bypassed), the INSERT itself succeeds without needing the
-- audit_log_staff_insert policy. ON CONFLICT DO NOTHING ensures 0 rows affected.
insert into public.audit_log
  (id, tenant_id, actor_id, action, entity, entity_id, meta, created_at)
values (
  (select md5(
     'product.create' || ':' ||
     'aaaaaaaa-c0de-4000-8000-000000000099' || ':' ||
     extract(epoch from '2026-06-26T12:00:00+00:00'::timestamptz)::text
   )::uuid),
  'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  'product.create',
  'product',
  'aaaaaaaa-c0de-4000-8000-000000000099'::uuid,
  '{"idempotency_test": true}'::jsonb,
  now()
)
on conflict (id) do nothing;

select is(
  (select count(*)::bigint
   from public.audit_log
   where entity_id = 'aaaaaaaa-c0de-4000-8000-000000000099'::uuid
     and action    = 'product.create'),
  1::bigint,
  'idempotency: ON CONFLICT DO NOTHING — duplicate deterministic id is silently discarded (still 1 row)');

-- ===========================================================================

select * from finish();
rollback;
