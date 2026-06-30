-- =============================================================================
-- 09_debts_settlement.test.sql — pgTAP proof for migrations 0018+0019
--                                (ADR-0012 Slice 3: debts / آجل)
--
-- Proves the guarantees introduced by migrations 0018 and 0019:
--
--   BLOCK A — Debt-tender close: exactly one debt row, idempotent replay
--     (migration 0019, ADR-0012 Decision D1):
--     Tests 1–5: close_session_tx with payment_method='debt' and a p_debt
--     payload creates exactly one debts row (deterministic id). Replay call
--     (same idempotent payload) leaves row count = 1 (ON CONFLICT DO NOTHING).
--
--   BLOCK B — Debt close with null p_debt raises (guard 0e):
--     Test 6: passing payment_method='debt' but p_debt=null is rejected with
--     42501 (guard fires before any write — no money hole).
--
--   BLOCK C — can_discount enforcement (guard 0d, ADR-0012 Decision B1):
--     Test 7: Staff-Restricted (can_discount=false) + discount > 0 → 42501.
--     Test 8: Manager Alpha (absent can_discount, permissive default) + discount
--             > 0 → close succeeds.
--
--   BLOCK D — Recompute trigger (migration 0018 §5):
--     Tests 9–12: partial payment → paid_total updated + status='partially_paid';
--     full payment → paid_total = amount + status='settled'. Tests prove the
--     trigger correctly aggregates integer-piastre payments (ledger summation).
--
--   BLOCK E — Cross-tenant p_debt guard (guard 0c, migration 0019):
--     Test 13: p_tenant_id=A passes scalar guard, but p_debt.tenant_id=B is
--     caught by the per-row p_debt tenant-pin guard → 42501.
--
-- UUID conventions (ALL valid RFC-4122 hex; no collision with seed.sql or
-- tests 01–08):
--   Tenant A:           aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa  (from seed)
--   Tenant B:           bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb  (from seed)
--   Branch A-1:         aaaa0001-0000-4000-8000-aaaaaaaaaaaa  (from seed)
--   Device A-1:         aaaaaaaa-de01-4000-8000-000000000001  (from seed, free)
--   Device A-2:         aaaaaaaa-de01-4000-8000-000000000002  (from seed, free)
--   Owner Alpha:        00000000-0000-4000-8000-000000000001  (from seed)
--   Manager Alpha:      00000000-0000-4000-8000-000000000002  (from seed)
--   Staff-Restricted:   00000000-0000-4000-8000-000000000006  (this file)
--   Session HDBT:       aaaaaaaa-5e09-4000-8000-000000000300  (this file)
--   Segment HDBT:       aaaaaaaa-5e09-4000-8000-000000000301  (this file)
--   Audit HDBT:         aaaaaaaa-a091-4000-8000-000000000300  (this file)
--   Debt HDBT:          aaaaaaaa-deb1-4000-8000-000000000300  (this file)
--   Session HDISC:      aaaaaaaa-5e09-4000-8000-000000000310  (this file)
--   Segment HDISC:      aaaaaaaa-5e09-4000-8000-000000000311  (this file)
--   Audit HDISC:        aaaaaaaa-a091-4000-8000-000000000310  (this file)
--   Debt RECOMPUTE:     aaaaaaaa-deb1-4000-8000-000000000320  (this file)
--   Payment partial:    aaaaaaaa-d5a0-4000-8000-000000000320  (this file)
--   Payment full:       aaaaaaaa-d5a0-4000-8000-000000000321  (this file)
--
-- Plan: 13 tests.
-- Depends on seed.sql (Tenant A/B, devices A-1/A-2, Manager Alpha seeded).
-- All fixture writes are inside this transaction and rolled back at the end.
-- Run: npx supabase test db  (local Supabase stack / Docker, or CI).
-- =============================================================================

begin;
select plan(13);

-- ===========================================================================
-- FIXTURE SETUP (as superuser — before switching to the authenticated role)
-- ===========================================================================

-- ── Staff-Restricted auth user and membership (BLOCK C tests 7–8) ────────────
-- Staff-Restricted is a staff member of Tenant A with can_discount=false.
-- Mirrors the fixture in test 08; re-created here because test 08 rolls back.

insert into auth.users
  (instance_id, id, aud, role, email, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-4000-8000-000000000006',
   'authenticated', 'authenticated',
   'staff.restricted@example.test', now(),
   '{"provider":"email","providers":["email"]}',
   '{"full_name":"Staff Restricted"}',
   now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, full_name, is_platform_admin, is_active)
values ('00000000-0000-4000-8000-000000000006', 'Staff Restricted', false, true)
on conflict (id) do update
  set full_name = excluded.full_name,
      is_active = excluded.is_active;

-- Staff-Restricted membership: can_discount=false (exercises guard 0d).
insert into public.tenant_members (tenant_id, profile_id, role, is_active, permissions)
values (
  'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
  '00000000-0000-4000-8000-000000000006',
  'staff', true,
  '{"can_restock":false,"can_void":false,"can_manage_debts":false,"can_discount":false}'::jsonb
)
on conflict (tenant_id, profile_id) do update
  set role        = excluded.role,
      is_active   = excluded.is_active,
      permissions = excluded.permissions;

-- ── Session HDBT: debt-tender close on Device A-1 (BLOCK A) ─────────────────
-- Active session; will be closed with payment_method='debt' and a p_debt payload.
-- Device A-1 is free in seed (no active sessions). Partial-unique index
-- (tenant_id, device_id) where status='active' allows exactly one.
insert into public.sessions
  (id, tenant_id, branch_id, device_id, manager_id,
   billing_mode, status, started_at,
   time_total, orders_total, grand_total, discount)
values
  ('aaaaaaaa-5e09-4000-8000-000000000300',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-de01-4000-8000-000000000001',   -- Device A-1
   '00000000-0000-4000-8000-000000000002',   -- Manager Alpha
   'open', 'active',
   '2026-06-30T09:00:00+00:00'::timestamptz,
   0, 0, 0, 0)
on conflict (id) do nothing;

-- Open segment for Session HDBT.
insert into public.session_segments
  (id, tenant_id, session_id, play_mode, price_per_hour_snapshot,
   started_at, ended_at)
values
  ('aaaaaaaa-5e09-4000-8000-000000000301',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-5e09-4000-8000-000000000300',
   'single', 6000,
   '2026-06-30T09:00:00+00:00'::timestamptz, null)
on conflict (id) do nothing;

-- ── Session HDISC: discount close on Device A-2 (BLOCK C) ───────────────────
-- Active session; used for the can_discount guard tests.
-- Test 7 (Staff-Restricted + discount → blocked) uses a savepoint rollback so
-- HDISC stays active. Test 8 (Manager Alpha + discount → succeeds) closes it.
insert into public.sessions
  (id, tenant_id, branch_id, device_id, manager_id,
   billing_mode, status, started_at,
   time_total, orders_total, grand_total, discount)
values
  ('aaaaaaaa-5e09-4000-8000-000000000310',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-de01-4000-8000-000000000002',   -- Device A-2
   '00000000-0000-4000-8000-000000000002',   -- Manager Alpha
   'open', 'active',
   '2026-06-30T11:00:00+00:00'::timestamptz,
   0, 0, 0, 0)
on conflict (id) do nothing;

-- Open segment for Session HDISC.
insert into public.session_segments
  (id, tenant_id, session_id, play_mode, price_per_hour_snapshot,
   started_at, ended_at)
values
  ('aaaaaaaa-5e09-4000-8000-000000000311',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-5e09-4000-8000-000000000310',
   'single', 5000,
   '2026-06-30T11:00:00+00:00'::timestamptz, null)
on conflict (id) do nothing;

-- ── Debt RECOMPUTE: fixture debt for trigger tests (BLOCK D) ─────────────────
-- Inserted as superuser (bypasses debts_insert RLS). amount=5000 p.
-- status='open', paid_total=0 (migration 0018 defaults).
-- Recompute trigger tests partially then fully settle this debt via
-- direct debt_payments inserts (also as superuser, bypassing RLS).
insert into public.debts
  (id, tenant_id, customer_name, amount, manager_id)
values
  ('aaaaaaaa-deb1-4000-8000-000000000320',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'Recompute Test Customer',
   5000,
   '00000000-0000-4000-8000-000000000002')   -- Manager Alpha
on conflict (id) do nothing;

-- ===========================================================================
-- BLOCK A — Debt-tender close (tests 1–5)
--
-- Proves close_session_tx with payment_method='debt' + p_debt payload:
--   1. Succeeds (lives_ok)
--   2. Session is now 'closed'
--   3. Exactly one debts row with the deterministic debt id
--   4. Replay call succeeds (no error)
--   5. Still exactly one debts row (ON CONFLICT DO NOTHING — idempotency)
-- ===========================================================================

-- Establish Manager Alpha (Tenant A) JWT.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'manager',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

-- Test 1 — Debt-tender close succeeds.
-- payment_method='debt'; p_debt carries the debt row that must be atomically
-- created. Debt id = deterministic (would be uuidv5('debt:{sessionId}', NS)
-- in production; here we use a fixed UUID for testability).
select lives_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000300'::uuid,   -- p_session_id (Session HDBT)
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_tenant_id (Tenant A)
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_branch_id
    '00000000-0000-4000-8000-000000000002'::uuid,   -- p_actor_id (Manager Alpha)
    '{
      "status":         "closed",
      "ended_at":       "2026-06-30T10:00:00+00:00",
      "time_total":     6000,
      "orders_total":   0,
      "grand_total":    6000,
      "discount":       0,
      "payment_method": "debt",
      "shift_id":       null,
      "updated_at":     "2026-06-30T10:00:00+00:00"
    }'::jsonb,
    '[{
      "id":                      "aaaaaaaa-5e09-4000-8000-000000000301",
      "tenant_id":               "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "session_id":              "aaaaaaaa-5e09-4000-8000-000000000300",
      "play_mode":               "single",
      "rate_rule_id":            null,
      "price_per_hour_snapshot": 6000,
      "started_at":              "2026-06-30T09:00:00+00:00",
      "ended_at":                "2026-06-30T10:00:00+00:00",
      "updated_at":              "2026-06-30T10:00:00+00:00"
    }]'::jsonb,
    '[]'::jsonb,                                    -- p_movements: none
    'aaaaaaaa-de01-4000-8000-000000000001'::uuid,   -- p_device_id (Device A-1)
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000000300",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000300",
      "amount":    6000,
      "meta":      {"billing_mode":"open","time_total":6000,"payment_method":"debt"},
      "created_at":"2026-06-30T10:00:00+00:00"
    }'::jsonb,
    -- p_debt: the debt row to create atomically (tenant-pinned to A)
    '{
      "id":            "aaaaaaaa-deb1-4000-8000-000000000300",
      "tenant_id":     "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "customer_id":   null,
      "customer_name": "Test Debt Customer",
      "amount":        6000,
      "session_id":    "aaaaaaaa-5e09-4000-8000-000000000300",
      "manager_id":    "00000000-0000-4000-8000-000000000002",
      "shift_id":      null,
      "note":          null
    }'::jsonb
  ) $$,
  'close_session_tx (0019): debt-tender close succeeds');

reset role;

-- Test 2 — Session HDBT is now closed.
select is(
  (select status from public.sessions
   where id = 'aaaaaaaa-5e09-4000-8000-000000000300'),
  'closed'::public.session_status,
  'close_session_tx (0019): session status = closed after debt-tender close');

-- Test 3 — Exactly one debts row with the deterministic debt id.
select is(
  (select count(*)::bigint from public.debts
   where id = 'aaaaaaaa-deb1-4000-8000-000000000300'
     and tenant_id = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'),
  1::bigint,
  'close_session_tx (0019): exactly 1 debts row created by debt-tender close');

-- Re-establish Manager Alpha JWT (reset role cleared it).
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'manager',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

-- Test 4 — Replay (identical payload) succeeds — no error, no duplicate.
-- Session is now 'closed', so the session UPDATE WHERE status<>'closed' matches
-- 0 rows (idempotent). The debt INSERT is ON CONFLICT DO NOTHING → 0 rows.
select lives_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000300'::uuid,
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,
    '00000000-0000-4000-8000-000000000002'::uuid,
    '{
      "status":         "closed",
      "ended_at":       "2026-06-30T10:00:00+00:00",
      "time_total":     6000,
      "orders_total":   0,
      "grand_total":    6000,
      "discount":       0,
      "payment_method": "debt",
      "shift_id":       null,
      "updated_at":     "2026-06-30T10:00:00+00:00"
    }'::jsonb,
    '[{
      "id":                      "aaaaaaaa-5e09-4000-8000-000000000301",
      "tenant_id":               "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "session_id":              "aaaaaaaa-5e09-4000-8000-000000000300",
      "play_mode":               "single",
      "rate_rule_id":            null,
      "price_per_hour_snapshot": 6000,
      "started_at":              "2026-06-30T09:00:00+00:00",
      "ended_at":                "2026-06-30T10:00:00+00:00",
      "updated_at":              "2026-06-30T10:00:00+00:00"
    }]'::jsonb,
    '[]'::jsonb,
    'aaaaaaaa-de01-4000-8000-000000000001'::uuid,
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000000300",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000300",
      "amount":    6000,
      "meta":      {"billing_mode":"open","time_total":6000,"payment_method":"debt"},
      "created_at":"2026-06-30T10:00:00+00:00"
    }'::jsonb,
    '{
      "id":            "aaaaaaaa-deb1-4000-8000-000000000300",
      "tenant_id":     "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "customer_id":   null,
      "customer_name": "Test Debt Customer",
      "amount":        6000,
      "session_id":    "aaaaaaaa-5e09-4000-8000-000000000300",
      "manager_id":    "00000000-0000-4000-8000-000000000002",
      "shift_id":      null,
      "note":          null
    }'::jsonb
  ) $$,
  'close_session_tx (0019): replay call succeeds — no error, no duplicate');

reset role;

-- Test 5 — Still exactly one debts row (ON CONFLICT DO NOTHING on replay).
select is(
  (select count(*)::bigint from public.debts
   where id = 'aaaaaaaa-deb1-4000-8000-000000000300'
     and tenant_id = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'),
  1::bigint,
  'close_session_tx (0019): still exactly 1 debts row after replay (ON CONFLICT DO NOTHING)');

-- ===========================================================================
-- BLOCK B — Debt close with null p_debt raises (guard 0e) [test 6]
--
-- payment_method='debt' but p_debt=null → guard 0e raises 42501.
-- Guard fires BEFORE any write, so no state changes occur.
-- We use the (now closed) Session HDBT — the guard fires before the session
-- UPDATE's WHERE status<>'closed' predicate, so session state is irrelevant.
-- ===========================================================================

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'manager',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

-- Test 6 — payment_method='debt' + p_debt=null → guard 0e raises 42501.
select throws_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000300'::uuid,   -- p_session_id (already closed; guard fires first)
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_tenant_id
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_branch_id
    '00000000-0000-4000-8000-000000000002'::uuid,   -- p_actor_id
    '{
      "status":         "closed",
      "ended_at":       "2026-06-30T10:00:00+00:00",
      "time_total":     6000,
      "orders_total":   0,
      "grand_total":    6000,
      "discount":       0,
      "payment_method": "debt",
      "shift_id":       null,
      "updated_at":     "2026-06-30T10:00:00+00:00"
    }'::jsonb,
    '[]'::jsonb,                                    -- p_segments: empty
    '[]'::jsonb,                                    -- p_movements: empty
    'aaaaaaaa-de01-4000-8000-000000000001'::uuid,   -- p_device_id
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000000302",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000300",
      "amount":    6000,
      "meta":      {},
      "created_at":"2026-06-30T10:00:00+00:00"
    }'::jsonb,
    NULL::jsonb  -- p_debt: NULL for a 'debt' payment_method → guard 0e fires
  ) $$,
  '42501', null,
  'close_session_tx (0019): payment_method=debt with p_debt=null raises 42501 (guard 0e — no money hole)');

reset role;

-- ===========================================================================
-- BLOCK C — can_discount enforcement (guard 0d, ADR-0012 Decision B1)
--           [tests 7–8]
--
-- Test 7: Staff-Restricted (can_discount=false) attempting to close Session
--         HDISC with discount=1000 is rejected by guard 0d (42501).
--         throws_ok savepoint rolls back → Session HDISC remains active.
--
-- Test 8: Manager Alpha (absent can_discount = permissive default) closes
--         Session HDISC with discount=500 → succeeds.
-- ===========================================================================

-- Test 7 — Staff-Restricted (can_discount=false) + discount=1000 → 42501.
-- Guard 0d fires: discount=1000 ≠ 0 AND NOT has_permission('can_discount')=true.
-- Note: guard fires BEFORE the session ownership check (session UPDATE),
-- so the test correctly demonstrates function-level enforcement regardless
-- of whether Staff-Restricted is the session's manager_id.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000006',  -- Staff-Restricted
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'staff',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

select throws_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000310'::uuid,   -- p_session_id (Session HDISC)
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_tenant_id
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_branch_id
    '00000000-0000-4000-8000-000000000006'::uuid,   -- p_actor_id (Staff-Restricted)
    '{
      "status":         "closed",
      "ended_at":       "2026-06-30T12:00:00+00:00",
      "time_total":     5000,
      "orders_total":   0,
      "grand_total":    4000,
      "discount":       1000,
      "payment_method": "cash",
      "shift_id":       null,
      "updated_at":     "2026-06-30T12:00:00+00:00"
    }'::jsonb,
    '[]'::jsonb,                                    -- p_segments: empty (guard fires first)
    '[]'::jsonb,                                    -- p_movements: empty
    'aaaaaaaa-de01-4000-8000-000000000002'::uuid,   -- p_device_id (Device A-2)
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000000311",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000006",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000310",
      "amount":    4000,
      "meta":      {},
      "created_at":"2026-06-30T12:00:00+00:00"
    }'::jsonb,
    NULL::jsonb  -- p_debt: cash close
  ) $$,
  '42501', null,
  'close_session_tx (0019): staff with can_discount=false + discount=1000 rejected by guard 0d (42501)');

reset role;

-- Test 8 — Manager Alpha (absent can_discount = permissive default) + discount=500
-- on Session HDISC → close succeeds.
-- has_permission('can_discount'): Manager Alpha permissions='{}' (absent flag) →
--   coalesce(null, true) AND is_active_member() = true AND true = true.
-- NOT true = false → guard 0d does NOT fire → close proceeds.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000002',  -- Manager Alpha
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'manager',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

select lives_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000310'::uuid,   -- p_session_id (Session HDISC, still active)
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_tenant_id
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_branch_id
    '00000000-0000-4000-8000-000000000002'::uuid,   -- p_actor_id (Manager Alpha)
    '{
      "status":         "closed",
      "ended_at":       "2026-06-30T12:00:00+00:00",
      "time_total":     5000,
      "orders_total":   0,
      "grand_total":    4500,
      "discount":       500,
      "payment_method": "cash",
      "shift_id":       null,
      "updated_at":     "2026-06-30T12:00:00+00:00"
    }'::jsonb,
    '[{
      "id":                      "aaaaaaaa-5e09-4000-8000-000000000311",
      "tenant_id":               "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "session_id":              "aaaaaaaa-5e09-4000-8000-000000000310",
      "play_mode":               "single",
      "rate_rule_id":            null,
      "price_per_hour_snapshot": 5000,
      "started_at":              "2026-06-30T11:00:00+00:00",
      "ended_at":                "2026-06-30T12:00:00+00:00",
      "updated_at":              "2026-06-30T12:00:00+00:00"
    }]'::jsonb,
    '[]'::jsonb,
    'aaaaaaaa-de01-4000-8000-000000000002'::uuid,   -- p_device_id (Device A-2)
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000000310",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000310",
      "amount":    4500,
      "meta":      {"billing_mode":"open","time_total":5000,"discount":500},
      "created_at":"2026-06-30T12:00:00+00:00"
    }'::jsonb,
    NULL::jsonb  -- p_debt: cash close
  ) $$,
  'close_session_tx (0019): manager with absent can_discount (permissive default) + discount=500 → succeeds');

reset role;

-- ===========================================================================
-- BLOCK D — Recompute trigger (migration 0018 §5) [tests 9–12]
--
-- Directly tests the recompute_debt_totals() AFTER INSERT trigger.
-- Uses Debt RECOMPUTE (amount=5000) inserted as a superuser fixture above.
-- Inserts partial (2500 p) then full (2500 p more = 5000 total) payments and
-- verifies paid_total and status are updated atomically by the trigger.
--
-- Runs as superuser (RLS bypassed) to isolate trigger behavior from policy gates.
-- The recompute trigger is SECURITY DEFINER — it updates debts regardless of
-- the calling role, which is the correct behavior for a cross-manager payment.
-- ===========================================================================

-- Clear JWT so audit trigger context-skip fires (avoids NOT NULL actor_id fail).
select set_config('request.jwt.claims', '', true);

-- Insert partial payment (2500 p) — trigger recomputes paid_total and status.
insert into public.debt_payments
  (id, tenant_id, debt_id, amount, manager_id)
values
  ('aaaaaaaa-d5a0-4000-8000-000000000320',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-deb1-4000-8000-000000000320',   -- Debt RECOMPUTE
   2500,
   '00000000-0000-4000-8000-000000000002')   -- Manager Alpha
on conflict (id) do nothing;

-- Test 9 — paid_total = 2500 after partial payment.
select is(
  (select paid_total from public.debts
   where id = 'aaaaaaaa-deb1-4000-8000-000000000320'),
  2500,
  'recompute_debt_totals: paid_total = 2500 after partial payment (Σ debt_payments.amount)');

-- Test 10 — status = 'partially_paid' (0 < 2500 < 5000).
select is(
  (select status from public.debts
   where id = 'aaaaaaaa-deb1-4000-8000-000000000320'),
  'partially_paid'::public.debt_status,
  'recompute_debt_totals: status = partially_paid when 0 < paid_total < amount');

-- Insert the second payment (2500 p more → total 5000 = amount → settled).
insert into public.debt_payments
  (id, tenant_id, debt_id, amount, manager_id)
values
  ('aaaaaaaa-d5a0-4000-8000-000000000321',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-deb1-4000-8000-000000000320',   -- Debt RECOMPUTE
   2500,
   '00000000-0000-4000-8000-000000000002')   -- Manager Alpha
on conflict (id) do nothing;

-- Test 11 — paid_total = 5000 = amount after full payment.
select is(
  (select paid_total from public.debts
   where id = 'aaaaaaaa-deb1-4000-8000-000000000320'),
  5000,
  'recompute_debt_totals: paid_total = 5000 (= amount) after second payment');

-- Test 12 — status = 'settled' (paid_total >= amount).
select is(
  (select status from public.debts
   where id = 'aaaaaaaa-deb1-4000-8000-000000000320'),
  'settled'::public.debt_status,
  'recompute_debt_totals: status = settled when paid_total >= amount');

-- ===========================================================================
-- BLOCK E — Cross-tenant p_debt guard (guard 0c, migration 0019) [test 13]
--
-- The exploit: p_tenant_id=A (passes guard 0 scalar check) but p_debt.tenant_id=B
-- → guard 0c catches the cross-tenant p_debt payload and raises 42501.
-- Zero writes happen (guard fires before any INSERT).
-- ===========================================================================

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-4000-8000-000000000002',  -- Manager Alpha (Tenant A)
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'tenant_id',      'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
      'roles',          'manager',
      'is_super_admin', false
    )
  )::text,
  true
);
set local role authenticated;

-- Test 13 — p_tenant_id=A passes scalar guard; p_debt.tenant_id=B rejected by
-- guard 0c → 42501 before any write (no cross-tenant debt created).
select throws_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000300'::uuid,   -- p_session_id (already closed; guard fires first)
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_tenant_id = A (passes guard 0)
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_branch_id
    '00000000-0000-4000-8000-000000000002'::uuid,   -- p_actor_id
    '{
      "status":         "closed",
      "ended_at":       "2026-06-30T10:00:00+00:00",
      "time_total":     6000,
      "orders_total":   0,
      "grand_total":    6000,
      "discount":       0,
      "payment_method": "debt",
      "shift_id":       null,
      "updated_at":     "2026-06-30T10:00:00+00:00"
    }'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    'aaaaaaaa-de01-4000-8000-000000000001'::uuid,
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000000313",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000300",
      "amount":    6000,
      "meta":      {},
      "created_at":"2026-06-30T10:00:00+00:00"
    }'::jsonb,
    -- p_debt: tenant_id=B → rejected by guard 0c → 42501 before any INSERT
    '{
      "id":            "bbbbbbbb-deb1-4000-8000-000000000300",
      "tenant_id":     "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb",
      "customer_id":   null,
      "customer_name": "Cross-Tenant Attacker",
      "amount":        6000,
      "session_id":    "aaaaaaaa-5e09-4000-8000-000000000300",
      "manager_id":    "00000000-0000-4000-8000-000000000002",
      "shift_id":      null,
      "note":          null
    }'::jsonb
  ) $$,
  '42501', null,
  'close_session_tx (0019): p_tenant_id=A but p_debt.tenant_id=B rejected by per-row p_debt pin guard (42501)');

reset role;

-- ===========================================================================

select * from finish();
rollback;
