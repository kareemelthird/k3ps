-- =============================================================================
-- 06_billing_isolation.test.sql — pgTAP proof for migration 0010 (ADR-0010)
--
-- Proves six guarantees introduced by the Phase-9 billing schema:
--
--   BLOCK B — Subscription RLS isolation (AC 8, 9, 10)
--     Test  1: owner-A reads only own subscription (1 row)
--     Test  2: owner-A cannot see tenant-B's subscription (0 rows)
--     Test  3: authenticated client INSERT on subscriptions → 42501
--     Test  4: non-impersonating super-admin reads all subscriptions (2 rows)
--
--   BLOCK C — Webhook write isolation + idempotency (AC 12, 15, 16, 18)
--     Test  5: apply_stripe_subscription_event: new event → 'applied'
--     Test  6: correct tenant updated (tenant-A status changed, not B)
--     Test  7: replay same event_id → 'duplicate' (idempotency on event_id)
--     Test  8: stale event (older timestamp) → 'stale' (out-of-order guard)
--     Test  9: unknown customer → 'unmapped' (no guess, no write to wrong tenant)
--     Test 10: super-admin can see stripe_events (RLS allows)
--     Test 11: owner cannot see stripe_events (RLS denies)
--
--   BLOCK F — Plan cap enforcement (AC 30, 31, 32)
--     Test 12: under-limit branch insert succeeds (authenticated context, cap fires)
--     Test 13: over-limit branch insert raises 23514 (check_violation)
--     Test 14: service-role context → trigger skips → insert succeeds
--
--   BLOCK G — set_tenant_plan access control
--     Test 15: superuser can call set_tenant_plan (comp succeeds)
--     Test 16: authenticated user cannot execute set_tenant_plan (42501)
--
--   BLOCK H — Impersonation isolation + cross-tenant write denial (AC 13, Finding 2)
--     Test 17: impersonating super-admin (is_super_admin=true + impersonator_id claim
--              + live impersonation_sessions row) sees ONLY the target tenant's
--              subscription — NOT all rows (NOT is_impersonating() guard on
--              subscriptions_super_select fires; subscriptions_member_select limits
--              to target tenant).
--     Test 18: authenticated client UPDATE on another tenant's subscription → 0 rows
--              (no UPDATE policy; RLS default-deny; only INSERT-deny was previously
--              asserted — this extends coverage to UPDATE).
--     Test 19: authenticated client DELETE on another tenant's subscription → 0 rows
--              (no DELETE policy; same reasoning).
--
--   BLOCK I — Cap enforcement on reactivation (migration 0011, AC 30-32)
--     Test 20: normal UPDATE on a capped-table branch (no is_active change) →
--              succeeds; the WHEN clause on branches_plan_cap_update is not met.
--     Test 21: reactivating an inactive branch (is_active false→true) when already
--              at the plan limit → raises 23514 (check_violation).
--
-- UUID legend (ALL valid RFC-4122 hex):
--   Tenant A:     aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa
--   Tenant B:     bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb
--   Tenant C:     cccccccc-0000-4000-8000-cccccccccccc  (fixture, trial plan)
--   Owner Alpha:  00000000-0000-4000-8000-000000000001
--   Owner Bravo:  00000000-0000-4000-8000-000000000003
--   Owner Charlie:00000000-0000-4000-8000-000000000006
--   Platform Admin:00000000-0000-4000-8000-000000000005
--   Branch C-1:   cccc0001-0000-4000-8000-cccccccccccc
--   Branch C-2:   cccc0002-0000-4000-8000-cccccccccccc  (over-limit attempt)
--   Branch C-3:   cccc0003-0000-4000-8000-cccccccccccc  (service-role bypass)
--   Branch C-4:   cccc0004-0000-4000-8000-cccccccccccc  (inactive; reactivation test)
--   Impersonation session: eeeeeeee-0000-4000-8000-eeeeeeeeeeee
--   Stripe events: evt_bill_001, evt_bill_002, evt_bill_003
--
-- pgTAP gotchas (from prior tests in this project):
--   * Only valid-hex UUID chars (0-9, a-f). No s/o/w/i.
--   * count(*) returns bigint → cast to ::bigint in is() for type match.
--   * throws_ok wraps execution in a SAVEPOINT; the outer transaction is unaffected.
--   * SET LOCAL ROLE / RESET ROLE must bracket each role-change block.
--
-- Depends on seed.sql. All fixture writes are in this transaction → rolled back.
-- Run: npx supabase test db
-- =============================================================================

begin;
select plan(21);

-- =============================================================================
-- FIXTURE SETUP (as superuser — RLS and trigger caps do not apply)
-- =============================================================================

-- Attach Stripe customer IDs to the backfill subscriptions for webhook tests.
update public.subscriptions
  set stripe_customer_id = 'cus_test_aaaa'
where tenant_id = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';

update public.subscriptions
  set stripe_customer_id = 'cus_test_bbbb'
where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

-- =============================================================================
-- BLOCK B: Subscription RLS isolation (tests 1-4)
-- =============================================================================

-- Simulate owner-A (authenticated, tenant-A).
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

-- Test 1: owner-A reads only own subscription.
select is(
  (select count(*)::bigint from public.subscriptions),
  1::bigint,
  'AC8+: owner-A sees exactly 1 subscription (own)'
);

-- Test 2: owner-A cannot see tenant-B's subscription.
select is(
  (select count(*)::bigint from public.subscriptions
   where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'),
  0::bigint,
  'AC8-: owner-A cannot see tenant-B subscription'
);

-- Test 3: authenticated client INSERT on subscriptions → 42501.
-- No INSERT policy exists; RLS default-deny raises permission denied.
-- Using a UUID that does not conflict with any existing PK.
select throws_ok(
  $$insert into public.subscriptions (tenant_id, plan, status)
    values ('ffffffff-0000-4000-8000-ffffffffffff', 'pro', 'active')$$,
  '42501',
  null,
  'AC9: authenticated INSERT on subscriptions raises 42501'
);

-- Switch to super-admin (still in authenticated role).
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000005',
    'role', 'authenticated',
    'app_metadata', json_build_object('is_super_admin', true)
  )::text,
  true
);

-- Test 4: non-impersonating super-admin reads all subscriptions.
-- At this point only tenant-A and tenant-B subscriptions exist (2 from backfill).
-- Tenant-C fixture is created AFTER this test to keep the count deterministic.
select is(
  (select count(*)::bigint from public.subscriptions),
  2::bigint,
  'AC10: super-admin reads all subscriptions (A and B from backfill)'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- =============================================================================
-- FIXTURE: Create tenant-C (trial plan) for cap trigger tests (blocks F and G).
-- Inserted as superuser → trigger jwt.claims check sees '' → returns NEW (no cap).
-- =============================================================================

insert into auth.users
  (instance_id, id, aud, role, email, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-4000-8000-000000000006',
   'authenticated', 'authenticated',
   'owner.charlie@example.test', now(),
   '{"provider":"email","providers":["email"]}',
   '{"full_name":"Owner Charlie"}',
   now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, full_name, is_platform_admin, is_active)
values ('00000000-0000-4000-8000-000000000006', 'Owner Charlie', false, true)
on conflict (id) do update
  set full_name = excluded.full_name, is_platform_admin = excluded.is_platform_admin;

insert into public.tenants (id, name, status)
values ('cccccccc-0000-4000-8000-cccccccccccc', 'Charlie Cafe', 'active')
on conflict (id) do nothing;

-- Trial plan: max_branches=1, max_devices=5, max_staff=3.
insert into public.subscriptions (tenant_id, plan, status, trial_end)
values ('cccccccc-0000-4000-8000-cccccccccccc', 'trial', 'trialing', now() + interval '14 days')
on conflict (tenant_id) do nothing;

insert into public.tenant_members (tenant_id, profile_id, role, is_active)
values ('cccccccc-0000-4000-8000-cccccccccccc',
        '00000000-0000-4000-8000-000000000006', 'owner', true)
on conflict (tenant_id, profile_id) do nothing;

-- =============================================================================
-- BLOCK C: Webhook write isolation + idempotency (tests 5-11)
-- All RPC calls run as postgres superuser — EXECUTE grant is bypassed by superuser.
-- =============================================================================

-- Test 5: new event → 'applied'. Sets tenant-A status to 'trialing'
--         (changed from 'active' set by the backfill — proves state change happened).
select is(
  (select public.apply_stripe_subscription_event(
    'evt_bill_001',
    'customer.subscription.updated',
    now(),
    'cus_test_aaaa',
    'sub_test_aaaa_001',
    'trialing'::public.subscription_status,
    null,
    null,
    now() + interval '14 days',
    false,
    null,
    null
  )),
  'applied',
  'AC12/16: new event for known customer returns applied'
);

-- Test 6: verify correct tenant-A was updated (status changed to trialing).
--         If the wrong tenant were written, this check would fail on a different row.
select is(
  (select status::text from public.subscriptions
   where tenant_id = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'),
  'trialing',
  'AC16: apply wrote to correct tenant (A status = trialing)'
);

-- Test 7: replay the same event_id → 'duplicate' (idempotency on event_id).
--         The subscription must NOT be changed a second time.
select is(
  (select public.apply_stripe_subscription_event(
    'evt_bill_001',                              -- SAME event_id
    'customer.subscription.updated',
    now() + interval '1 second',                 -- different timestamp is irrelevant
    'cus_test_aaaa',
    'sub_test_aaaa_001',
    'canceled'::public.subscription_status,      -- would regress if applied
    null, null, null, false, null, null
  )),
  'duplicate',
  'AC15: replay same event_id returns duplicate (no double-write)'
);

-- Test 8: stale event (older timestamp than last_stripe_event_at) → 'stale'.
--         last_stripe_event_at was set to ~now() by test 5.
--         This event is 1 hour older → must be discarded without regressing state.
select is(
  (select public.apply_stripe_subscription_event(
    'evt_bill_002',                              -- new event_id
    'customer.subscription.updated',
    now() - interval '1 hour',                   -- OLDER than last_stripe_event_at
    'cus_test_aaaa',
    'sub_test_aaaa_001',
    'canceled'::public.subscription_status,      -- would regress if applied
    null, null, null, false, null, null
  )),
  'stale',
  'AC18: stale event (older timestamp) returns stale (not applied)'
);

-- Test 9: unknown customer → 'unmapped'.
--         No subscription row has stripe_customer_id='cus_nonexistent_xxxx'.
--         The function must record the event and return 'unmapped' — no guess.
select is(
  (select public.apply_stripe_subscription_event(
    'evt_bill_003',
    'customer.subscription.updated',
    now(),
    'cus_nonexistent_xxxx',                      -- unknown customer
    'sub_unknown_001',
    'active'::public.subscription_status,
    null, null, null, false, null, null
  )),
  'unmapped',
  'AC19: unknown customer returns unmapped (no write to any tenant)'
);

-- Test 10: super-admin can SELECT stripe_events (forensics access).
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000005',
    'role', 'authenticated',
    'app_metadata', json_build_object('is_super_admin', true)
  )::text,
  true
);
set local role authenticated;

select is(
  (select count(*)::bigint from public.stripe_events where event_id = 'evt_bill_001'),
  1::bigint,
  'stripe_events: super-admin sees applied event row'
);

-- Test 11: owner-A cannot see stripe_events (stripe_events_super_select only).
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
-- still in authenticated role

select is(
  (select count(*)::bigint from public.stripe_events),
  0::bigint,
  'stripe_events: owner cannot see any stripe_events (RLS denies)'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- =============================================================================
-- BLOCK F: Plan cap enforcement (tests 12-14)
--
-- We run as postgres SUPERUSER (bypasses RLS so the INSERT reaches the trigger),
-- but set request.jwt.claims to role=authenticated so the cap trigger fires.
-- Tenant-C is on 'trial': max_branches=1, currently 0 branches.
-- =============================================================================

-- Simulate authenticated context for the cap trigger (not service_role, not empty).
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated"}',
  true
);

-- Test 12: under-limit insert succeeds (0 existing < 1 allowed).
select lives_ok(
  $$insert into public.branches (id, tenant_id, name, is_active)
    values ('cccc0001-0000-4000-8000-cccccccccccc',
            'cccccccc-0000-4000-8000-cccccccccccc',
            'Charlie Branch 1', true)$$,
  'AC31: under-limit branch insert succeeds (0 of 1 used)'
);

-- Test 13: over-limit insert raises 23514 check_violation.
-- Tenant-C now has 1 branch (from test 12). Trial limit = 1. 1 >= 1 → raise.
select throws_ok(
  $$insert into public.branches (id, tenant_id, name, is_active)
    values ('cccc0002-0000-4000-8000-cccccccccccc',
            'cccccccc-0000-4000-8000-cccccccccccc',
            'Charlie Branch 2', true)$$,
  '23514',
  null,
  'AC30: over-limit branch insert raises check_violation (23514)'
);

-- Test 14: service_role context → trigger skips the cap → insert succeeds.
-- Tenant-C still has 1 branch (throws_ok uses a savepoint; test 13 raised without
-- committing the insert). Changing to service_role claims bypasses the cap check.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$insert into public.branches (id, tenant_id, name, is_active)
    values ('cccc0003-0000-4000-8000-cccccccccccc',
            'cccccccc-0000-4000-8000-cccccccccccc',
            'Charlie Branch 3', true)$$,
  'AC32: service-role bypasses cap trigger (provision/comp never blocked)'
);

select set_config('request.jwt.claims', '', true);

-- =============================================================================
-- BLOCK G: set_tenant_plan access control (tests 15-16)
-- =============================================================================

-- Test 15: superuser can call set_tenant_plan (comp tenant-C from trial to pro).
select lives_ok(
  $$select public.set_tenant_plan(
    'cccccccc-0000-4000-8000-cccccccccccc',
    'pro',
    '00000000-0000-4000-8000-000000000005',
    'pgTAP fixture comp to pro',
    true,
    null
  )$$,
  'set_tenant_plan: superuser/service-role can call (comp succeeds)'
);

-- Test 16: authenticated user (owner-A) cannot execute set_tenant_plan (42501).
-- REVOKE from authenticated was applied in migration 0010.
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

select throws_ok(
  $$select public.set_tenant_plan(
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
    'pro',
    '00000000-0000-4000-8000-000000000001',
    'attempt by authenticated user',
    true,
    null
  )$$,
  '42501',
  null,
  'set_tenant_plan: authenticated user cannot execute (permission denied)'
);

reset role;

-- =============================================================================
-- FIXTURE: Live impersonation session for Block H tests (inserted as superuser).
-- Impersonator = Platform Admin (00000000-0000-4000-8000-000000000005)
-- Target       = Tenant A      (aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa)
-- =============================================================================
select set_config('request.jwt.claims', '', true);

insert into public.impersonation_sessions
  (id, impersonator_id, target_tenant_id, role, reason, started_at, expires_at)
values
  ('eeeeeeee-0000-4000-8000-eeeeeeeeeeee',
   '00000000-0000-4000-8000-000000000005',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'owner',
   'pgTAP fixture: billing impersonation isolation test',
   now(),
   now() + interval '1 hour')
on conflict (id) do nothing;

-- =============================================================================
-- BLOCK H: Impersonation isolation + cross-tenant write denial (tests 17-19)
-- =============================================================================

-- Test 17: Impersonating super-admin sees ONLY the target tenant's subscription.
--
-- JWT carries is_super_admin=true + impersonator_id (→ is_impersonating()=true).
-- subscriptions_super_select: is_super_admin() AND NOT is_impersonating() = FALSE →
--   the cross-tenant read-all path is SUPPRESSED.
-- subscriptions_member_select: tenant_id=current_tenant_id()='aaaa...' AND
--   is_tenant_staff() = is_active_member() → impersonation branch succeeds (live
--   impersonation_sessions row inserted above) → allows reading tenant-A row only.
-- Result: exactly 1 row (tenant-A), never all rows.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000005',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',       'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',           'owner',
      'is_super_admin',  true,
      'impersonator_id', '00000000-0000-4000-8000-000000000005'
    )
  )::text,
  true
);
set local role authenticated;

select is(
  (select count(*)::bigint from public.subscriptions),
  1::bigint,
  'AC13/imp: impersonating super-admin sees only target tenant sub (1 row, not all)'
);

reset role;

-- Tests 18-19: cross-tenant write denial for subscriptions.
-- No UPDATE or DELETE policy exists on subscriptions → RLS default-deny → 0 rows.
-- Switch to owner-A normal (non-impersonating) context.
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

-- Test 18: UPDATE on another tenant's subscription → 0 rows affected.
-- No UPDATE policy: no rows match the implicit USING=false; UPDATE is silently denied.
-- Data-modifying CTE must be at the statement top level (not nested in a scalar
-- subquery), so the WITH leads the statement and is() reads the result set.
with upd as (
  update public.subscriptions
     set plan = 'basic'
   where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'
   returning tenant_id
)
select is(
  (select count(*)::bigint from upd),
  0::bigint,
  'AC-deny-update: cross-tenant UPDATE on subscriptions affects 0 rows (no UPDATE policy)'
);

-- Test 19: DELETE on another tenant's subscription → 0 rows affected.
-- No DELETE policy: same reasoning.
with del as (
  delete from public.subscriptions
   where tenant_id = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'
   returning tenant_id
)
select is(
  (select count(*)::bigint from del),
  0::bigint,
  'AC-deny-delete: cross-tenant DELETE on subscriptions affects 0 rows (no DELETE policy)'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- =============================================================================
-- BLOCK I: Cap enforcement on reactivation (migration 0011, tests 20-21)
--
-- At this point tenant-C has:
--   C-1: is_active=true  (inserted in test 12 — under-limit insert succeeded)
--   C-3: is_active=true  (inserted in test 14 — service-role bypass)
-- Trial plan: max_branches=1. Active count=2, already over limit.
-- Insert C-4 as inactive (superuser; cap skipped — jwt.claims='') for test 21.
-- =============================================================================

insert into public.branches (id, tenant_id, name, is_active)
values ('cccc0004-0000-4000-8000-cccccccccccc',
        'cccccccc-0000-4000-8000-cccccccccccc',
        'Charlie Branch 4 (inactive)', false)
on conflict (id) do nothing;

-- Simulate authenticated context so cap trigger fires (not service_role, not empty).
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);

-- Test 20: Normal UPDATE (no is_active change) on a capped-table branch → succeeds.
-- The WHEN clause on branches_plan_cap_update requires
--   (NEW.is_active = true AND OLD.is_active = false).
-- C-1 is already active (is_active=true), so OLD.is_active=true. The WHEN clause
-- does NOT fire → enforce_plan_cap() is never called → UPDATE succeeds.
select lives_ok(
  $$update public.branches
       set name = 'Charlie Branch 1 (renamed)'
     where id = 'cccc0001-0000-4000-8000-cccccccccccc'$$,
  'AC-cap-update-normal: non-reactivation UPDATE on capped table succeeds (WHEN clause not met)'
);

-- Test 21: Reactivation (is_active false→true) over cap → raises 23514.
-- C-4 is is_active=false. Reactivating it would bring active count from 2 → 3
-- (above the trial limit of 1). The WHEN clause fires → enforce_plan_cap() counts
-- 2 active branches (>= limit 1) → raises check_violation (23514).
select throws_ok(
  $$update public.branches
       set is_active = true
     where id = 'cccc0004-0000-4000-8000-cccccccccccc'$$,
  '23514',
  null,
  'AC-cap-reactivate: reactivating branch over plan limit raises check_violation (23514)'
);

select set_config('request.jwt.claims', '', true);

rollback;
