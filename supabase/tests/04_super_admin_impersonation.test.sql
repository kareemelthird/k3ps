-- =============================================================================
-- 04_super_admin_impersonation.test.sql — pgTAP proof of AC 9–15 (ADR-0008)
--
-- Proves five guarantees introduced by migration 0008:
--
--   BLOCK A — Normal tenant user cannot use super-admin read policies (AC 9, 10)
--     Tests 1–3: owner-A (is_super_admin=false) still sees 0 of tenant-B's rows
--     from audit_log, tenant_members, branches. The new additive policies grant
--     nothing to non-super-admins.
--
--   BLOCK B — Super-admin cross-tenant reads when NOT impersonating (AC 11, 12)
--     Tests 4–7: super-admin sees audit_log, tenant_members, branches, profiles
--     across ALL tenants (the ratified cross-tenant read exception, AC 11).
--     Test 8: super-admin (not impersonating) sees both tenant rows via
--             tenants_super_select (Finding 1 fix).
--     Test 9: super-admin WITHOUT impersonation cannot write a device row
--             (no standing cross-tenant write, AC 12 — throws 42501).
--
--   BLOCK C — Live impersonation confines to exactly ONE tenant (AC 13)
--     Test 10: LIVE impersonation of tenant A → can read A's devices
--              (is_active_member() impersonation branch returns true).
--     Test 11: LIVE impersonation of tenant A → zero rows of tenant B's devices
--              (RLS is confined to the one target tenant).
--     Test 12: LIVE impersonation → is_impersonating()=true suppresses the
--              super-admin cross-tenant read policies → zero rows of tenant B's
--              audit_log (AC 13: "zero rows of tenant B" even with is_super_admin=true).
--     Test 13: LIVE impersonation → impersonator confined to target tenant in
--              tenants table — zero rows of tenant B (Finding 1 fix: tenants_member_select
--              now member-only; tenants_super_select suppressed by is_impersonating()).
--
--   BLOCK D — Expired and ended impersonation fail-closed (AC 27)
--     Test 14: EXPIRED session (expires_at in the past) → is_active_member()=false
--              → zero rows of tenant A visible (fails closed without JWT expiry).
--     Test 15: ENDED session (ended_at set) → is_active_member()=false
--              → zero rows of tenant A visible (immediate revocation).
--
--   BLOCK E — Audit trigger stamps impersonator_id by construction (AC 25)
--     Test 16: INSERT audit_log WITH impersonator_id claim → meta.impersonator_id
--              is present (trigger fires, stamps from signed claim).
--     Test 17: INSERT audit_log WITHOUT impersonator_id claim → meta.impersonator_id
--              is absent (trigger strips client-supplied key — Finding 3 fix).
--
-- UUID conventions (ALL valid hex — no mnemonic letters s/o/w/i):
--   Tenant A:      aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa
--   Tenant B:      bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb
--   Owner Alpha:   00000000-0000-4000-8000-000000000001
--   Manager Alpha: 00000000-0000-4000-8000-000000000002
--   Owner Bravo:   00000000-0000-4000-8000-000000000003
--   Platform Admin:00000000-0000-4000-8000-000000000005
--   Fixture audit_log rows: 44444444-0a91-4000-8000-00000000000{1,2,3,4}
--   Impersonation session: 11111111-1111-4000-8000-111111111111
--
-- pgTAP gotchas observed in this project:
--   * Use ONLY valid-hex UUID literals (0-9, a-f). No s/o/w/i.
--   * sum(bigint) returns numeric → cast to ::bigint when comparing with is().
--   * count(*) returns bigint natively → no cast needed.
--
-- Depends on seed.sql. All fixture writes are inside this transaction; rolled back.
-- Run: npx supabase test db  (local Supabase stack, or CI).
-- =============================================================================

begin;
select plan(18);

-- =============================================================================
-- FIXTURE SETUP (as superuser — RLS does not apply at this privilege level)
-- =============================================================================

-- Fixture audit_log rows: one for tenant A, one for tenant B.
-- Used in Block B (super-admin cross-tenant read) and Block C (impersonation
-- suppresses super-admin read → B's row must not be visible under impersonation).
insert into public.audit_log
  (id, tenant_id, actor_id, action, entity)
values
  ('44444444-0a91-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000001',
   'session.close', 'sessions'),
  ('44444444-0a91-4000-8000-000000000002',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   '00000000-0000-4000-8000-000000000003',
   'session.close', 'sessions')
on conflict (id) do nothing;

-- Impersonation session: super-admin impersonating tenant A with role='owner'.
-- Initially LIVE (expires_at in the future, ended_at=NULL).
-- Used for tests 10–13 (live), then mutated for test 14 (expired) and test 15 (ended).
insert into public.impersonation_sessions
  (id, impersonator_id, target_tenant_id, role, reason, started_at, expires_at, ended_at)
values
  ('11111111-1111-4000-8000-111111111111',
   '00000000-0000-4000-8000-000000000005',   -- Platform Admin
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',   -- Tenant A
   'owner',
   'Support investigation test fixture',
   now(),
   now() + interval '1 hour',
   null)                                       -- null = active
on conflict (id) do nothing;

-- =============================================================================
-- BLOCK A — Normal tenant owner cannot use super-admin read policies
-- (AC 9: existing isolation preserved; AC 10: new policies grant nothing to
--  non-super-admins)
-- =============================================================================

-- Switch to Owner Alpha (Tenant A, is_super_admin=false, no impersonation).
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

-- Test 1: Normal owner (is_super_admin=false) sees 0 of tenant-B's audit_log rows.
-- The new audit_log_super_select policy requires is_super_admin()=true; the existing
-- audit_log_owner_select policy requires tenant_id = current_tenant_id() = A.
-- Neither grants access to B's row to a non-super-admin.
select is(
  (select count(*) from public.audit_log
    where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'Block A: owner-A (is_super_admin=false) sees 0 tenant-B audit_log rows — new super policy grants nothing to non-admins'
);

-- Test 2: Normal owner sees 0 of tenant-B's tenant_members rows.
-- The new tenant_members_super_select policy requires is_super_admin()=true.
-- The existing tenant_members_staff_select requires tenant_id = current_tenant_id() = A.
select is(
  (select count(*) from public.tenant_members
    where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'Block A: owner-A (is_super_admin=false) sees 0 tenant-B tenant_members rows — new super policy grants nothing to non-admins'
);

-- Test 3: Normal owner sees 0 of tenant-B's branches rows.
-- The new branches_super_select policy requires is_super_admin()=true.
-- The existing branches_member_select requires tenant_id = current_tenant_id() = A.
select is(
  (select count(*) from public.branches
    where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'Block A: owner-A (is_super_admin=false) sees 0 tenant-B branches rows — new super policy grants nothing to non-admins'
);

-- =============================================================================
-- BLOCK B — Super-admin cross-tenant reads (NOT impersonating)
-- (AC 11: super-admin can read across all tenants; AC 12: no standing write)
-- =============================================================================

-- Switch to Platform Admin (is_super_admin=true, no tenant_id, no impersonator_id).
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000005',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'is_super_admin', true
      -- no tenant_id: super-admin not scoped to any tenant when not impersonating
      -- no impersonator_id: is_impersonating() = false
    )
  )::text,
  true
);
-- Role stays authenticated (already set in Block A's set local role).
-- The JWT claim change takes effect immediately for subsequent RLS policy evaluations.

-- Test 4: Super-admin sees BOTH audit_log fixture rows across all tenants.
-- audit_log_super_select: is_super_admin()=true AND NOT is_impersonating()=true.
-- Without this policy a super-admin with no tenant_id claim would see 0 rows.
select is(
  (select count(*) from public.audit_log
    where id in (
      '44444444-0a91-4000-8000-000000000001',   -- Tenant A fixture row
      '44444444-0a91-4000-8000-000000000002'    -- Tenant B fixture row
    )),
  2::bigint,
  'Block B: super-admin (not impersonating) sees audit_log rows across all tenants via new super policy'
);

-- Test 5: Super-admin sees all 4 tenant_members rows (from seed: 2 for A, 2 for B).
-- tenant_members_super_select: is_super_admin()=true AND NOT is_impersonating().
select is(
  (select count(*) from public.tenant_members),
  4::bigint,
  'Block B: super-admin (not impersonating) sees all 4 tenant_members rows across all tenants'
);

-- Test 6: Super-admin sees all 3 branches rows (from seed: 2 for A, 1 for B).
-- branches_super_select: is_super_admin()=true AND NOT is_impersonating().
select is(
  (select count(*) from public.branches),
  3::bigint,
  'Block B: super-admin (not impersonating) sees all 3 branches rows across all tenants'
);

-- Test 7: Super-admin sees all 5 profiles rows (from seed: 4 staff + 1 platform admin).
-- profiles_super_select: is_super_admin()=true AND NOT is_impersonating().
select is(
  (select count(*) from public.profiles),
  5::bigint,
  'Block B: super-admin (not impersonating) sees all 5 profiles rows across all tenants'
);

-- Test 8: Super-admin (NOT impersonating) sees both tenant rows via tenants_super_select.
-- Finding 1 fix: tenants_member_select is now member-only (no is_super_admin() OR branch).
-- A non-impersonating super-admin must still see all tenants via the new
-- tenants_super_select policy (is_super_admin()=true AND NOT is_impersonating()=true).
-- Without this policy the super-admin portal "all tenants" list would be empty.
select is(
  (select count(*) from public.tenants),
  2::bigint,
  'Block B: super-admin (not impersonating) sees both tenant rows via tenants_super_select (Finding 1 fix)'
);

-- Test 9: Super-admin WITHOUT impersonation cannot INSERT a device row.
-- No operational write policy grants super-admin standing cross-tenant write (AC 12).
-- current_tenant_id()=null → devices_owner_write: tenant_id=A ≠ null → false.
-- devices_staff_status_update is UPDATE only. Result: 42501.
select throws_ok(
  $$ insert into public.devices
       (id, tenant_id, branch_id, name, device_type, status, sort_order, is_active)
     values ('44444444-de01-4000-8000-000000000099',
             'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
             'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
             'Hijacked Device', 'PS5', 'free', 99, true) $$,
  '42501', NULL,
  'Block B: super-admin without impersonation cannot INSERT a device row — no standing cross-tenant write (AC 12, test 9)'
);

-- =============================================================================
-- BLOCK C — Live impersonation confines to exactly ONE tenant (AC 13)
-- The impersonation_sessions fixture row for super-admin → tenant A is live.
-- =============================================================================

-- Switch to Platform Admin WITH live impersonation claim for tenant A.
-- The hook stamps these claims from the impersonation_sessions row (live).
-- is_active_member() impersonation branch: target_tenant_id=A, impersonator_id=super,
-- claim impersonator_id=super, ended_at=null, expires_at>now, tenant=active → TRUE.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000005',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',  -- target
      'roles',          'owner',                                  -- from session.role
      'is_super_admin', true,
      'impersonator_id','00000000-0000-4000-8000-000000000005'   -- super-admin id
    )
  )::text,
  true
);

-- Test 10: LIVE impersonation → can read tenant A's devices (positive: 2 rows).
-- devices_staff_select: tenant_id=A = current_tenant_id()=A AND is_tenant_staff()
--   → is_tenant_staff() = is_active_member() → impersonation branch → TRUE.
select is(
  (select count(*) from public.devices
    where tenant_id = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'),
  2::bigint,
  'Block C: LIVE impersonation of tenant A — can read A''s 2 devices (is_active_member impersonation branch = true, test 10)'
);

-- Test 11: LIVE impersonation of tenant A → zero rows of tenant B's devices.
-- devices_staff_select: tenant_id=B ≠ current_tenant_id()=A → false (isolation).
-- The impersonation token is confined to exactly one tenant (AC 13).
select is(
  (select count(*) from public.devices
    where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'Block C: LIVE impersonation of tenant A — zero rows of tenant B''s devices (confined to one tenant, test 11)'
);

-- Test 12: LIVE impersonation → is_impersonating()=true suppresses super-admin
-- cross-tenant read policies → zero rows of tenant B's audit_log.
-- audit_log_super_select: is_super_admin()=true AND NOT is_impersonating()
--   = true AND NOT true = false → suppressed.
-- audit_log_owner_select: tenant_id=B ≠ current_tenant_id()=A → false.
-- B's fixture row (44444444-0a91-…002) must not be visible.
select is(
  (select count(*) from public.audit_log
    where id = '44444444-0a91-4000-8000-000000000002'),
  0::bigint,
  'Block C: LIVE impersonation suppresses super-admin cross-tenant read — zero rows of tenant B audit_log (AC 13, test 12)'
);

-- Test 13: LIVE impersonation → impersonator confined to one tenant in tenants table.
-- Finding 1 fix: tenants_member_select is now member-only (no is_super_admin() OR branch).
-- tenants_super_select: is_super_admin()=true AND NOT is_impersonating()
--   = true AND NOT true = false → suppressed.
-- tenants_member_select: id = current_tenant_id() AND is_active_member()
--   For tenant B: id=B ≠ current_tenant_id()=A → false.
-- Therefore an impersonating super-admin CANNOT read tenant B's row in the tenants
-- table — they are confined to the target tenant (Tenant A) only.
select is(
  (select count(*) from public.tenants
    where id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'Block C: LIVE impersonation — impersonator confined to target tenant in tenants table — 0 rows of tenant B (Finding 1 fix, test 13)'
);

-- =============================================================================
-- BLOCK D — Expired and ended impersonation fail-closed (AC 27)
-- Mutate the fixture session row as superuser between tests.
-- JWT claim is unchanged (same impersonator_id + tenant_id): only the DB row
-- state determines whether is_active_member() grants access.
-- =============================================================================

-- Return to superuser to mutate the impersonation_sessions row.
reset role;

-- Make the session EXPIRED: expires_at set to 1 hour in the past.
-- The is_active_member() impersonation branch: expires_at > now() → FALSE.
update public.impersonation_sessions
  set expires_at = now() - interval '1 hour'
  where id = '11111111-1111-4000-8000-111111111111';

-- Switch back to authenticated with the SAME impersonation claim.
-- The claim still carries impersonator_id and tenant_id=A, but the DB row is expired.
set local role authenticated;

-- Test 14: EXPIRED session → is_active_member()=false → zero rows of tenant A.
-- Neither impersonation branch (expires_at > now() = false) nor normal branch
-- (super-admin has no tenant_members row) grants access. Fail-closed without
-- waiting for JWT expiry (AC 27: "impersonation never silently auto-extends").
select is(
  (select count(*) from public.devices
    where tenant_id = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'),
  0::bigint,
  'Block D: EXPIRED impersonation session — is_active_member()=false — zero rows of tenant A (fail-closed, AC 27, test 14)'
);

-- Return to superuser to update the row again.
reset role;

-- Make the session ENDED: restore expires_at to the future, set ended_at.
-- The is_active_member() impersonation branch: ended_at IS NULL → FALSE.
update public.impersonation_sessions
  set expires_at = now() + interval '1 hour',
      ended_at   = now() - interval '5 minutes'
  where id = '11111111-1111-4000-8000-111111111111';

set local role authenticated;

-- Test 15: ENDED session (ended_at set) → is_active_member()=false → zero rows.
-- ended_at IS NULL = false → impersonation branch fails → no access.
-- Demonstrates immediate revocation: ended_at independently enforces the boundary
-- in-policy, regardless of token TTL or expires_at value (AC 27).
select is(
  (select count(*) from public.devices
    where tenant_id = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'),
  0::bigint,
  'Block D: ENDED impersonation session (ended_at set) — is_active_member()=false — zero rows of tenant A (immediate revocation, test 15)'
);

-- =============================================================================
-- BLOCK E — audit_log BEFORE INSERT trigger stamps meta.impersonator_id (AC 25)
-- Tested at superuser level (RLS bypassed) so we isolate the trigger behaviour.
-- The trigger reads auth.jwt() → request.jwt.claims (a session GUC set above).
-- =============================================================================

reset role;

-- Test 16: INSERT with impersonator_id in the JWT claim → trigger stamps meta.
-- stamp_impersonator() calls current_impersonator_id() which reads app_metadata.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000005',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'is_super_admin',  true,
      'impersonator_id', '00000000-0000-4000-8000-000000000005'
    )
  )::text,
  true
);

insert into public.audit_log
  (id, tenant_id, actor_id, action, entity)
values
  ('44444444-0a91-4000-8000-000000000003',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000005',
   'test.trigger.stamp', 'test');

select is(
  (select meta->>'impersonator_id'
     from public.audit_log
    where id = '44444444-0a91-4000-8000-000000000003'),
  '00000000-0000-4000-8000-000000000005',
  'Block E: audit_log trigger stamps meta.impersonator_id from signed JWT claim during impersonation (AC 25, test 16)'
);

-- Test 17: INSERT without impersonator_id in the JWT claim → trigger STRIPS any
-- client-supplied impersonator_id from meta (Finding 3 fix — audit integrity).
-- Without this strip, a normal user could INSERT a row with meta:{impersonator_id:X}
-- and make their action look like an impersonation event in the audit trail.
-- With the fix: stamp_impersonator() detects imp=NULL → strips the key from new.meta.
-- We supply a client-injected impersonator_id in the INSERT to verify it is removed.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000005',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'is_super_admin', true
      -- no impersonator_id: is_impersonating() = false
    )
  )::text,
  true
);

-- Insert with a client-supplied impersonator_id in meta to prove the trigger strips it.
-- The JWT claim carries no impersonator_id, so stamp_impersonator() will execute the
-- else branch: new.meta := new.meta - 'impersonator_id'.
insert into public.audit_log
  (id, tenant_id, actor_id, action, entity, meta)
values
  ('44444444-0a91-4000-8000-000000000004',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000005',
   'test.trigger.no_stamp', 'test',
   -- Client attempts to inject a fabricated impersonator_id into the audit row.
   '{"impersonator_id": "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb"}'::jsonb);

select is(
  (select meta->>'impersonator_id'
     from public.audit_log
    where id = '44444444-0a91-4000-8000-000000000004'),
  null::text,
  'Block E: audit_log trigger STRIPS client-supplied meta.impersonator_id when not impersonating — audit integrity (Finding 3 fix, test 17)'
);

-- =============================================================================
-- BLOCK F — guard_is_platform_admin trigger: authenticated user cannot
-- self-elevate is_platform_admin (BLOCKER fix for supabase db reset)
--
-- The trigger was previously unconditional (fired for ALL connections).
-- After the fix it fires ONLY when request.jwt.claims is non-empty (PostgREST
-- context) AND the JWT role is not 'service_role' AND auth.uid() is not null.
-- Seed.sql's upsert (which becomes an UPDATE after handle_new_user creates
-- the profile row) runs without PostgREST context → request.jwt.claims='' →
-- guard skipped → seed completes → pgTAP suite can run.
--
-- This test proves the end-user block still works in PostgREST context.
-- (The seed path cannot be proven in pgTAP because pgTAP always sets
-- request.jwt.claims; its correctness is validated by supabase db reset
-- completing without error.)
-- =============================================================================

reset role;

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

-- Test 18: Authenticated user cannot self-elevate is_platform_admin.
-- The trigger sees request.jwt.claims non-empty + role='authenticated' +
-- auth.uid()='00000000-…001' (non-null) → all bypass conditions false →
-- is_platform_admin change detected → raises 42501.
-- This proves the guard works in PostgREST context (end-user block intact).
select throws_ok(
  $$ update public.profiles
     set is_platform_admin = true
     where id = '00000000-0000-4000-8000-000000000001' $$,
  '42501', NULL,
  'Block F: Authenticated user self-elevating is_platform_admin is rejected by trigger in PostgREST context (BLOCKER fix, test 18)'
);

select * from finish();
rollback;
