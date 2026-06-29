-- =============================================================================
-- 05_outbox_close_tx.test.sql — pgTAP proof for migration 0009 (ADR-0009)
--
-- Proves four guarantees introduced by migration 0009:
--
--   BLOCK A — close_session_tx first call (AC 13):
--     Tests 1–5: calling close_session_tx as Manager Alpha (authenticated)
--     succeeds; session is marked closed; exactly 1 segment, 1 stock_movement,
--     and 1 audit_log row land with their deterministic ids.
--
--   BLOCK B — close_session_tx idempotency / no double-count (AC 14):
--     Tests 6–9: calling close_session_tx a second time with the identical
--     payload is a no-op — the replay succeeds without error, and row counts
--     remain 1 for segments (DO UPDATE same data), stock_movements
--     (ON CONFLICT DO NOTHING — never a second decrement), and audit_log
--     (ON CONFLICT DO NOTHING — exactly one close audit row).
--
--   BLOCK C — terminal-guard triggers (ADR-0009 §Q6):
--     Tests 10–13: the BEFORE UPDATE triggers on sessions and shifts raise
--     SQLSTATE 23514 (check_violation → permanent in classifyError → dead-letter
--     immediately) when any code tries to transition a 'closed' row to a
--     different status. Updates that do NOT change the status (e.g. touching
--     updated_at or notes on a closed row) are not blocked — the guard is
--     narrow and precise.
--
--   BLOCK D — cross-tenant isolation via scalar guard (AC 16, 26):
--     Tests 14–15: Manager Alpha (Tenant A) calling close_session_tx with
--     p_tenant_id=B is rejected by the SCALAR tenant guard (SQLSTATE 42501).
--     (Under SECURITY DEFINER RLS WITH CHECK does not apply; the scalar guard
--     is the actual rejection point here because p_tenant_id=B ≠ claim=A.)
--     Tenant B's session remains 'active' — zero cross-tenant effect.
--
--   BLOCK F — per-row payload exploit path (migration 0014) [AC 16, 26]:
--     Tests 19–21: the REAL exploit — p_tenant_id=A (passes scalar guard) but
--     a payload row carries tenant_id=B. Before migration 0014 this silently
--     wrote a row into tenant B. After 0014 the per-row pin guards catch it
--     and raise 42501 before any INSERT executes.
--
-- UUID conventions (ALL valid RFC-4122 hex — same legend as other test files):
--   Tenant A:       aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa
--   Tenant B:       bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb
--   Branch A-1:     aaaa0001-0000-4000-8000-aaaaaaaaaaaa
--   Branch B-1:     bbbb0001-0000-4000-8000-bbbbbbbbbbbb
--   Device A-1:     aaaaaaaa-de01-4000-8000-000000000001
--   Device B-1:     bbbbbbbb-de01-4000-8000-000000000001
--   Manager Alpha:  00000000-0000-4000-8000-000000000002
--   Manager Bravo:  00000000-0000-4000-8000-000000000004
--   Fixture session A: aaaaaaaa-5e09-4000-8000-000000000009
--   Fixture segment A: aaaaaaaa-5e09-4000-8000-000000000010
--   Fixture shift A:   aaaaaaaa-5f09-4000-8000-000000000009
--   Stock movement:    aaaaaaaa-5901-4000-8000-000000009009
--   Audit log row:     aaaaaaaa-a091-4000-8000-000000009009
--   Fixture session B: bbbbbbbb-5e09-4000-8000-000000000009
--
-- Plan: 23 tests (16 original + 3 added by migration 0013: BLOCK E
--       + 4 added by migrations 0014/0015: BLOCK F).
-- Depends on seed.sql (Tenant A = aaaaaaaa…, Tenant B = bbbbbbbb…; devices,
-- products, branches, and profiles already seeded).
-- All fixture writes are inside this transaction and rolled back at the end.
-- Run: npx supabase test db  (local Supabase stack / Docker, or CI).
-- =============================================================================

begin;
select plan(23);

-- ---------------------------------------------------------------------------
-- FIXTURE SETUP (as superuser — before switching to the authenticated role)
--
-- Creates the minimum rows needed by this test; every UUID is unique within
-- this file and does not collide with seed.sql or tests 01–04.
-- ---------------------------------------------------------------------------

-- Tenant-A active session on device 1 (Manager Alpha as manager_id).
-- Partial-unique index sessions_one_active_per_device allows exactly one
-- active session per (tenant_id, device_id) — device 1 is free in the seed.
insert into public.sessions
  (id, tenant_id, branch_id, device_id, manager_id,
   billing_mode, status, started_at,
   time_total, orders_total, grand_total, discount)
values
  ('aaaaaaaa-5e09-4000-8000-000000000009',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-de01-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000002',   -- Manager Alpha
   'open', 'active',
   '2026-06-26T09:00:00+00:00'::timestamptz,
   0, 0, 0, 0)
on conflict (id) do nothing;

-- Open segment for the session above (to be closed by the RPC).
insert into public.session_segments
  (id, tenant_id, session_id, play_mode, price_per_hour_snapshot,
   started_at, ended_at)
values
  ('aaaaaaaa-5e09-4000-8000-000000000010',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-5e09-4000-8000-000000000009',
   'single', 6000,
   '2026-06-26T09:00:00+00:00'::timestamptz, null)
on conflict (id) do nothing;

-- Tenant-A closed shift for the terminal-guard shift test (BLOCK C, test 11).
insert into public.shifts
  (id, tenant_id, branch_id, manager_id, status, opening_cash)
values
  ('aaaaaaaa-5f09-4000-8000-000000000009',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   '00000000-0000-4000-8000-000000000002',
   'closed', 0)
on conflict (id) do nothing;

-- ===========================================================================
-- BLOCK A — First close_session_tx call (tests 1–5)
-- ===========================================================================

-- Simulate Manager Alpha (Tenant A, role=manager) via JWT claims.
-- is_tenant_staff() = true for role='manager'; is_tenant_owner() = false.
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

-- Test 0 — Positive regression: a manager CAN insert an own-tenant audit_log row
-- DIRECTLY under the REAL audit_log_staff_insert policy + stamp trigger
-- (production conditions). This is the path every mobile money action uses; it
-- guards against a manager-audit-write regression independent of close_session_tx.
select lives_ok(
  $$ insert into public.audit_log
       (id, tenant_id, branch_id, actor_id, action, entity, entity_id, amount, meta, created_at)
     values ('aaaaaaaa-d1a9-4000-8000-000000000095',
             'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
             'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
             '00000000-0000-4000-8000-000000000002',
             'probe.direct', 'sessions', null, null, '{}'::jsonb, now()) $$,
  'manager can insert own-tenant audit_log directly (real policy + trigger)');

-- Test 1 — First call succeeds (no exception).
-- Payload mirrors what the mobile api.ts close path produces:
--   p_segments  : the single open segment, now closed at 10:00 UTC
--   p_movements : one 'sale' movement for product Pepsi Can (tracked, stock=100)
--                 id = uuidv5('stock-sale:{itemId}') — deterministic key
--   p_audit     : session.close row with id = uuidv5('close:{sessionId}')
select lives_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000009'::uuid,   -- p_session_id
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_tenant_id
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_branch_id
    '00000000-0000-4000-8000-000000000002'::uuid,   -- p_actor_id
    -- p_session_patch: frozen totals computed by @ps/core before enqueue
    '{
      "status":         "closed",
      "ended_at":       "2026-06-26T10:00:00+00:00",
      "time_total":     6000,
      "grand_total":    6000,
      "payment_method": "cash",
      "shift_id":       null,
      "updated_at":     "2026-06-26T10:00:00+00:00"
    }'::jsonb,
    -- p_segments: one segment (open → closed); id reuses the existing segment id
    '[{
      "id":                      "aaaaaaaa-5e09-4000-8000-000000000010",
      "tenant_id":               "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "session_id":              "aaaaaaaa-5e09-4000-8000-000000000009",
      "play_mode":               "single",
      "rate_rule_id":            null,
      "price_per_hour_snapshot": 6000,
      "started_at":              "2026-06-26T09:00:00+00:00",
      "ended_at":                "2026-06-26T10:00:00+00:00",
      "updated_at":              "2026-06-26T10:00:00+00:00"
    }]'::jsonb,
    -- p_movements: one sale movement (Pepsi Can, tracked, delta=-1)
    --   id = deterministic uuidv5('stock-sale:{order_item_id}')
    '[{
      "id":         "aaaaaaaa-5901-4000-8000-000000009009",
      "tenant_id":  "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id":  "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "product_id": "aaaaaaaa-c0de-4000-8000-000000000001",
      "delta":      -1,
      "reason":     "sale",
      "order_id":   null,
      "manager_id": "00000000-0000-4000-8000-000000000002",
      "note":       null,
      "created_at": "2026-06-26T10:00:00+00:00"
    }]'::jsonb,
    'aaaaaaaa-de01-4000-8000-000000000001'::uuid,   -- p_device_id
    -- p_audit: session.close audit row; id = uuidv5('close:{sessionId}')
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000009009",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000009",
      "amount":    6000,
      "meta":      {"billing_mode":"open","time_total":6000},
      "created_at":"2026-06-26T10:00:00+00:00"
    }'::jsonb
  ) $$,
  'close_session_tx: first call succeeds (no exception)');

-- Reset to superuser for count/status checks.
-- audit_log SELECT requires is_tenant_owner() which manager does not have,
-- so we use superuser access for all post-call verification queries.
reset role;

-- Test 2 — Session is now closed.
select is(
  (select status
   from public.sessions
   where id = 'aaaaaaaa-5e09-4000-8000-000000000009'),
  'closed'::public.session_status,
  'close_session_tx: session.status = closed after first call');

-- Test 3 — Exactly 1 session_segment row (the open segment is now closed).
select is(
  (select count(*)::bigint
   from public.session_segments
   where session_id = 'aaaaaaaa-5e09-4000-8000-000000000009'),
  1::bigint,
  'close_session_tx: exactly 1 session_segment after first call');

-- Test 4 — Exactly 1 stock_movement (deterministic id; never a duplicate decrement).
select is(
  (select count(*)::bigint
   from public.stock_movements
   where id = 'aaaaaaaa-5901-4000-8000-000000009009'),
  1::bigint,
  'close_session_tx: exactly 1 stock_movement (deterministic id) after first call');

-- Test 5 — Exactly 1 audit_log row (deterministic id = uuidv5(close:{sessionId})).
select is(
  (select count(*)::bigint
   from public.audit_log
   where id = 'aaaaaaaa-a091-4000-8000-000000009009'),
  1::bigint,
  'close_session_tx: exactly 1 audit_log row (deterministic id) after first call');

-- ===========================================================================
-- BLOCK B — Replay idempotency / no double-count (tests 6–9)
--
-- A second call with the identical payload must be a true no-op:
--   segments    → ON CONFLICT DO UPDATE (same data → same row, no duplicate)
--   session     → WHERE s.status <> 'closed' → 0 rows matched; trigger skipped
--   movements   → ON CONFLICT DO NOTHING → 0 rows inserted (no second decrement)
--   device free → idempotent UPDATE (already free; LWW same timestamp)
--   audit       → ON CONFLICT DO NOTHING → 0 rows inserted (one close audit)
-- ===========================================================================

-- Re-establish Manager Alpha JWT (reset role cleared it to superuser).
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

-- Test 6 — Second call (replay) succeeds without error.
-- The terminal guard does NOT fire because the session UPDATE WHERE
-- s.status <> 'closed' selects 0 rows (already closed), so no trigger.
select lives_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000009'::uuid,
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,
    '00000000-0000-4000-8000-000000000002'::uuid,
    '{
      "status":         "closed",
      "ended_at":       "2026-06-26T10:00:00+00:00",
      "time_total":     6000,
      "grand_total":    6000,
      "payment_method": "cash",
      "shift_id":       null,
      "updated_at":     "2026-06-26T10:00:00+00:00"
    }'::jsonb,
    '[{
      "id":                      "aaaaaaaa-5e09-4000-8000-000000000010",
      "tenant_id":               "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "session_id":              "aaaaaaaa-5e09-4000-8000-000000000009",
      "play_mode":               "single",
      "rate_rule_id":            null,
      "price_per_hour_snapshot": 6000,
      "started_at":              "2026-06-26T09:00:00+00:00",
      "ended_at":                "2026-06-26T10:00:00+00:00",
      "updated_at":              "2026-06-26T10:00:00+00:00"
    }]'::jsonb,
    '[{
      "id":         "aaaaaaaa-5901-4000-8000-000000009009",
      "tenant_id":  "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id":  "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "product_id": "aaaaaaaa-c0de-4000-8000-000000000001",
      "delta":      -1,
      "reason":     "sale",
      "order_id":   null,
      "manager_id": "00000000-0000-4000-8000-000000000002",
      "note":       null,
      "created_at": "2026-06-26T10:00:00+00:00"
    }]'::jsonb,
    'aaaaaaaa-de01-4000-8000-000000000001'::uuid,
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000009009",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000009",
      "amount":    6000,
      "meta":      {"billing_mode":"open","time_total":6000},
      "created_at":"2026-06-26T10:00:00+00:00"
    }'::jsonb
  ) $$,
  'close_session_tx: second call (replay) succeeds — no error, no duplicate');

reset role;

-- Test 7 — Still exactly 1 segment (ON CONFLICT DO UPDATE overwrites same data).
select is(
  (select count(*)::bigint
   from public.session_segments
   where session_id = 'aaaaaaaa-5e09-4000-8000-000000000009'),
  1::bigint,
  'close_session_tx: still exactly 1 segment after replay (no duplicate segment)');

-- Test 8 — Still exactly 1 stock_movement (ON CONFLICT DO NOTHING → no second decrement).
select is(
  (select count(*)::bigint
   from public.stock_movements
   where id = 'aaaaaaaa-5901-4000-8000-000000009009'),
  1::bigint,
  'close_session_tx: still exactly 1 stock_movement after replay (DO NOTHING — no double decrement)');

-- Test 9 — Still exactly 1 audit_log row (ON CONFLICT DO NOTHING → one close audit).
select is(
  (select count(*)::bigint
   from public.audit_log
   where id = 'aaaaaaaa-a091-4000-8000-000000009009'),
  1::bigint,
  'close_session_tx: still exactly 1 audit_log row after replay (DO NOTHING — exactly once)');

-- ===========================================================================
-- BLOCK C — Terminal-guard triggers (tests 10–13)
--
-- Tests 10 & 11: guard fires → raises 23514 (check_violation).
--   23514 maps to 'permanent' in @ps/core classifyError → dead-letter
--   immediately (no wasted retry attempts — ADR-0009 §Q4).
--
-- Tests 12 & 13: guard does NOT fire for non-status UPDATE (guard is narrow).
--   Updating updated_at or notes on a closed row leaves status = 'closed',
--   so the condition (old.status='closed' AND new.status IS DISTINCT FROM
--   'closed') is false — trigger returns new without raising.
--
-- All tests run as superuser (RLS bypassed) to isolate trigger behavior.
-- ===========================================================================

-- Test 10 — Session guard: reopen a closed session raises 23514.
-- old.status='closed', new.status='active' → IS DISTINCT FROM 'closed' → true
-- → trigger raises check_violation (23514).
select throws_ok(
  $$ update public.sessions
        set status = 'active'
      where id = 'aaaaaaaa-5e09-4000-8000-000000000009' $$,
  '23514', null,
  'terminal guard: UPDATE closed session to active raises check_violation (23514)');

-- Test 11 — Shift guard: reopen a closed shift raises 23514.
-- The fixture shift was created with status='closed'.
-- old.status='closed', new.status='open' → raises 23514.
select throws_ok(
  $$ update public.shifts
        set status = 'open'
      where id = 'aaaaaaaa-5f09-4000-8000-000000000009' $$,
  '23514', null,
  'terminal guard: UPDATE closed shift to open raises check_violation (23514)');

-- Test 12 — Session guard: UPDATE that does NOT change status is not blocked.
-- new.status = old.status = 'closed' → (new.status IS DISTINCT FROM 'closed')
-- = false → trigger returns new without raising.
select lives_ok(
  $$ update public.sessions
        set updated_at = now()
      where id     = 'aaaaaaaa-5e09-4000-8000-000000000009'
        and status = 'closed' $$,
  'terminal guard: UPDATE closed session (status unchanged) does NOT raise');

-- Test 13 — Shift guard: UPDATE that does NOT change status is not blocked.
select lives_ok(
  $$ update public.shifts
        set notes = 'reconciled-by-test'
      where id     = 'aaaaaaaa-5f09-4000-8000-000000000009'
        and status = 'closed' $$,
  'terminal guard: UPDATE closed shift (status unchanged) does NOT raise');

-- ===========================================================================
-- BLOCK D — Cross-tenant isolation via scalar guard (tests 14–15)
--
-- Manager Alpha (Tenant A) attempts to call close_session_tx with
-- p_tenant_id=B (and segments/audit rows with tenant_id=B).
--
-- Under SECURITY DEFINER, RLS WITH CHECK does NOT apply inside the function.
-- The rejection comes from the SCALAR guard (guard 0):
--   p_tenant_id = 'bbbbbbbb...' (B) != current_tenant_id() = 'aaaaaaaa...' (A)
--   -> raises 42501 BEFORE any INSERT or UPDATE executes (AC 16).
--
-- Note: this test does NOT exercise the per-row payload exploit path, because
-- p_tenant_id=B itself triggers the scalar guard first. The per-row exploit
-- (p_tenant_id=A but payload.tenant_id=B) is tested in BLOCK F (tests 19-21).
--
-- pgTAP's throws_ok wraps the call in a savepoint; the exception rolls back
-- to the savepoint, so B's session row is unchanged.
-- ===========================================================================

-- Insert Tenant-B session as superuser (fixture for the cross-tenant call).
insert into public.sessions
  (id, tenant_id, branch_id, device_id, manager_id,
   billing_mode, status, started_at,
   time_total, orders_total, grand_total, discount)
values
  ('bbbbbbbb-5e09-4000-8000-000000000009',
   'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb',
   'bbbb0001-0000-4000-8000-bbbbbbbbbbbb',
   'bbbbbbbb-de01-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000004',   -- Manager Bravo
   'open', 'active',
   '2026-06-26T09:00:00+00:00'::timestamptz,
   0, 0, 0, 0)
on conflict (id) do nothing;

-- Switch to Manager Alpha (Tenant A) — current_tenant_id() = A.
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

-- Test 14 — Cross-tenant call rejected by scalar tenant guard (42501).
-- p_tenant_id=B != current_tenant_id()=A -> guard 0 raises 42501 before any
-- INSERT. (Under SECURITY DEFINER, RLS WITH CHECK does not apply; the scalar
-- guard is the actual rejection point here, not per-row policy enforcement.)
-- The entire function call is rolled back to the savepoint by throws_ok,
-- so no partial state lands in B's tables.
select throws_ok(
  $$ select public.close_session_tx(
    'bbbbbbbb-5e09-4000-8000-000000000009'::uuid,   -- B's session
    'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb'::uuid,   -- B's tenant_id
    'bbbb0001-0000-4000-8000-bbbbbbbbbbbb'::uuid,
    '00000000-0000-4000-8000-000000000004'::uuid,
    '{
      "status":         "closed",
      "ended_at":       "2026-06-26T10:00:00+00:00",
      "time_total":     7000,
      "grand_total":    7000,
      "payment_method": "cash",
      "shift_id":       null,
      "updated_at":     "2026-06-26T10:00:00+00:00"
    }'::jsonb,
    -- Segment with tenant_id=B — WITH CHECK (tenant_id=B, current=A) → 42501
    '[{
      "id":                      "bbbbbbbb-5e09-4000-8000-000000009009",
      "tenant_id":               "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb",
      "session_id":              "bbbbbbbb-5e09-4000-8000-000000000009",
      "play_mode":               "single",
      "rate_rule_id":            null,
      "price_per_hour_snapshot": 7000,
      "started_at":              "2026-06-26T09:00:00+00:00",
      "ended_at":                "2026-06-26T10:00:00+00:00",
      "updated_at":              "2026-06-26T10:00:00+00:00"
    }]'::jsonb,
    '[]'::jsonb,   -- no movements
    'bbbbbbbb-de01-4000-8000-000000000001'::uuid,
    '{
      "id":        "bbbbbbbb-a091-4000-8000-000000009009",
      "tenant_id": "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb",
      "branch_id": "bbbb0001-0000-4000-8000-bbbbbbbbbbbb",
      "actor_id":  "00000000-0000-4000-8000-000000000004",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "bbbbbbbb-5e09-4000-8000-000000000009",
      "amount":    7000,
      "meta":      {},
      "created_at":"2026-06-26T10:00:00+00:00"
    }'::jsonb
  ) $$,
  '42501', null,
  'close_session_tx: cross-tenant call (tenant_id=B) rejected by RLS WITH CHECK (42501)');

-- Reset to superuser to check B's session state.
reset role;

-- Test 15 — B's session is still 'active' (cross-tenant call had zero effect).
-- The savepoint rollback inside throws_ok undid the RPC's partial writes.
select is(
  (select status
   from public.sessions
   where id = 'bbbbbbbb-5e09-4000-8000-000000000009'),
  'active'::public.session_status,
  'close_session_tx: cross-tenant call had zero effect — B''s session still active');

-- ===========================================================================
-- BLOCK E — orders_total persistence (migration 0013, tests 16–18)
--
-- Proves that close_session_tx now writes orders_total from the patch into
-- sessions.orders_total (previously always 0), and that the dashboard
-- reconciliation invariant grand_total = time_total + orders_total − discount
-- holds after a close with F&B orders.
--
-- Fixture: a second active session on Device A-2 (aaaaaaaa-de01-…-0002),
-- with one paid order containing 3 × Pepsi Can (500 p each) = 1500 p total.
-- The patch sends time_total=6000, orders_total=1500, grand_total=7500,
-- discount=0 — so both the component column and the invariant are verifiable.
--
-- UUIDs (BLOCK E — all valid RFC-4122 hex; no mnemonic letters beyond a–f):
--   Session E:       aaaaaaaa-5e09-4000-8000-000000000099
--   Segment E:       aaaaaaaa-5e09-4000-8000-000000000199
--   Order E:         aaaaaaaa-0d0e-4000-8000-000000000001
--   Order item E:    aaaaaaaa-01e1-4000-8000-000000000001
--   Audit log E:     aaaaaaaa-a091-4000-8000-000000000199
-- ===========================================================================

-- ── BLOCK E fixture setup (as superuser — before switching role) ─────────────

-- Second active session on Device A-2 (free throughout; Device A-1 was freed
-- by the close in BLOCK A so could also be reused, but using Device A-2 keeps
-- the fixtures orthogonal).
insert into public.sessions
  (id, tenant_id, branch_id, device_id, manager_id,
   billing_mode, status, started_at,
   time_total, orders_total, grand_total, discount)
values
  ('aaaaaaaa-5e09-4000-8000-000000000099',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-de01-4000-8000-000000000002',   -- Device A-2
   '00000000-0000-4000-8000-000000000002',   -- Manager Alpha
   'open', 'active',
   '2026-06-26T09:00:00+00:00'::timestamptz,
   0, 0, 0, 0)
on conflict (id) do nothing;

-- Open segment for Session E (to be closed by the RPC).
insert into public.session_segments
  (id, tenant_id, session_id, play_mode, price_per_hour_snapshot,
   started_at, ended_at)
values
  ('aaaaaaaa-5e09-4000-8000-000000000199',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-5e09-4000-8000-000000000099',
   'single', 6000,
   '2026-06-26T09:00:00+00:00'::timestamptz, null)
on conflict (id) do nothing;

-- A paid order attached to Session E: 3 × Pepsi Can @ 500 p = 1500 p.
-- Status 'paid' (non-void) — these are the "non-void order lines" whose sum
-- the mobile client passes as orders_total in the close patch.
insert into public.orders
  (id, tenant_id, branch_id, session_id, manager_id, total, status)
values
  ('aaaaaaaa-0d0e-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaa0001-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-5e09-4000-8000-000000000099',
   '00000000-0000-4000-8000-000000000002',
   1500, 'paid'::public.order_status)
on conflict (id) do nothing;

insert into public.order_items
  (id, tenant_id, order_id, product_id, qty, unit_price)
values
  ('aaaaaaaa-01e1-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
   'aaaaaaaa-0d0e-4000-8000-000000000001',
   'aaaaaaaa-c0de-4000-8000-000000000001',   -- Pepsi Can (500 p each, tracked)
   3, 500)
on conflict (id) do nothing;

-- ── Re-establish Manager Alpha JWT ───────────────────────────────────────────

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

-- Test 16 — close_session_tx with orders_total in patch succeeds.
-- The patch includes "orders_total": 1500 (sum of the 3 Pepsi Can items).
-- time_total = 6000 (1 h at 6000 p/h), grand_total = 7500, discount = 0.
-- No stock movements passed (p_movements = '[]') to keep the fixture minimal;
-- the test focus is orders_total persistence, not the movement path.
select lives_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000099'::uuid,   -- p_session_id
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_tenant_id
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_branch_id
    '00000000-0000-4000-8000-000000000002'::uuid,   -- p_actor_id
    -- p_session_patch: includes orders_total (the field added by migration 0013)
    '{
      "status":         "closed",
      "ended_at":       "2026-06-26T10:00:00+00:00",
      "time_total":     6000,
      "orders_total":   1500,
      "grand_total":    7500,
      "payment_method": "cash",
      "shift_id":       null,
      "updated_at":     "2026-06-26T10:00:00+00:00"
    }'::jsonb,
    -- p_segments: one segment closed at 10:00
    '[{
      "id":                      "aaaaaaaa-5e09-4000-8000-000000000199",
      "tenant_id":               "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "session_id":              "aaaaaaaa-5e09-4000-8000-000000000099",
      "play_mode":               "single",
      "rate_rule_id":            null,
      "price_per_hour_snapshot": 6000,
      "started_at":              "2026-06-26T09:00:00+00:00",
      "ended_at":                "2026-06-26T10:00:00+00:00",
      "updated_at":              "2026-06-26T10:00:00+00:00"
    }]'::jsonb,
    '[]'::jsonb,                                    -- p_movements: none (focus is orders_total)
    'aaaaaaaa-de01-4000-8000-000000000002'::uuid,   -- p_device_id (Device A-2)
    -- p_audit: deterministic id for this session close
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000000199",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000099",
      "amount":    7500,
      "meta":      {"billing_mode":"open","time_total":6000,"orders_total":1500},
      "created_at":"2026-06-26T10:00:00+00:00"
    }'::jsonb
  ) $$,
  'close_session_tx (0013): call with orders_total in patch succeeds');

-- Reset to superuser for the verification queries below.
reset role;

-- Test 17 — sessions.orders_total is now 1500 (no longer the dead initial 0).
-- This is the direct proof that migration 0013 fixed the dead column: the value
-- from the patch was persisted into the sessions row.
select is(
  (select orders_total::bigint
   from public.sessions
   where id = 'aaaaaaaa-5e09-4000-8000-000000000099'),
  1500::bigint,
  'close_session_tx (0013): orders_total = sum of non-void order lines (1500 p) after close');

-- Test 18 — grand_total = time_total + orders_total − discount (invariant).
-- Rather than hard-coding 7500, we compute the RHS from the row itself so the
-- test validates the structural relationship, not just the literal value.
-- grand_total(7500) = time_total(6000) + orders_total(1500) − discount(0).
select is(
  (select grand_total::bigint
   from public.sessions
   where id = 'aaaaaaaa-5e09-4000-8000-000000000099'),
  (select (time_total + orders_total - discount)::bigint
   from public.sessions
   where id = 'aaaaaaaa-5e09-4000-8000-000000000099'),
  'close_session_tx (0013): grand_total = time_total + orders_total - discount (invariant)');

-- ===========================================================================
-- BLOCK F — Per-row payload tenant-pin guards (migration 0014) [tests 19–21]
--
-- These tests prove the REAL exploit path that BLOCK D (test 14) did NOT
-- cover. Test 14 rejects because p_tenant_id=B hits the SCALAR guard (guard 0)
-- — not because of per-row enforcement. These tests call with p_tenant_id=A
-- (passes the scalar guard) but embed tenant_id=B inside individual payload
-- rows — the exploit that silently wrote to tenant B under SECURITY DEFINER
-- before migration 0014 added per-row pin guards.
--
-- Migration 0014 adds three guards immediately after the scalar guards and
-- before any INSERT; they raise 42501 if any payload row's tenant_id IS
-- DISTINCT FROM p_tenant_id (NULL-safe). No data is written before the raise,
-- and pgTAP's throws_ok savepoint rolls back the rejected call.
--
-- UUIDs (new — no collision with BLOCKS A–E):
--   Cross-tenant audit row (test 19):     bbbbbbbb-a091-4000-8000-000000000019
--   Cross-tenant movement row (test 21):  bbbbbbbb-5901-4000-8000-000000000021
--   Audit row for test-21 call (valid A): aaaaaaaa-a091-4000-8000-000000000021
--   Cross-tenant segment row (test 22):   bbbbbbbb-5e09-4000-8000-000000000022
-- ===========================================================================

-- Re-establish Manager Alpha JWT (tenant A) for BLOCK F.
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

-- Test 19 — Exploit path: p_tenant_id=A passes scalar guard, but p_audit.tenant_id=B
-- is caught by the NEW per-row audit_log payload pin guard (migration 0014).
-- Before 0014 this would silently write a row into tenant B's audit_log under
-- SECURITY DEFINER (BYPASSRLS). After 0014 it raises 42501 before any INSERT.
-- p_segments and p_movements are empty arrays so only the audit guard fires.
select throws_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000009'::uuid,   -- p_session_id (A; closed — guards fire first)
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_tenant_id = A (passes scalar guard)
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_branch_id
    '00000000-0000-4000-8000-000000000002'::uuid,   -- p_actor_id
    '{
      "status":         "closed",
      "ended_at":       "2026-06-26T11:00:00+00:00",
      "time_total":     3000,
      "grand_total":    3000,
      "payment_method": "cash",
      "shift_id":       null,
      "updated_at":     "2026-06-26T11:00:00+00:00"
    }'::jsonb,
    '[]'::jsonb,   -- p_segments: empty — passes segments pin guard
    '[]'::jsonb,   -- p_movements: empty — passes movements pin guard
    'aaaaaaaa-de01-4000-8000-000000000001'::uuid,   -- p_device_id
    -- p_audit: tenant_id=B -> caught by per-row audit_log pin guard -> 42501
    '{
      "id":        "bbbbbbbb-a091-4000-8000-000000000019",
      "tenant_id": "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb",
      "branch_id": "bbbb0001-0000-4000-8000-bbbbbbbbbbbb",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000009",
      "amount":    3000,
      "meta":      {},
      "created_at":"2026-06-26T11:00:00+00:00"
    }'::jsonb
  ) $$,
  '42501', null,
  'close_session_tx (0014): p_tenant_id=A but p_audit.tenant_id=B rejected by per-row payload pin (42501)');

-- Reset to superuser to verify no cross-tenant write occurred.
reset role;

-- Test 20 — Zero rows in tenant B's audit_log (cross-tenant write never landed).
-- The throws_ok savepoint rollback ensures the rejected call had zero effect.
select is(
  (select count(*)::bigint
   from public.audit_log
   where id = 'bbbbbbbb-a091-4000-8000-000000000019'),
  0::bigint,
  'close_session_tx (0014): cross-tenant audit_log payload rejected — zero B-rows written');

-- Re-establish Manager Alpha JWT for test 21.
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

-- Test 21 — Exploit path: p_tenant_id=A, p_movements[0].tenant_id=B rejected by
-- the NEW per-row stock_movements payload pin guard (migration 0014) before any write.
-- p_segments is empty (passes segments guard); the movements guard fires first.
select throws_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000009'::uuid,   -- p_session_id (A)
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_tenant_id = A (passes scalar guard)
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_branch_id
    '00000000-0000-4000-8000-000000000002'::uuid,   -- p_actor_id
    '{
      "status":         "closed",
      "ended_at":       "2026-06-26T11:00:00+00:00",
      "time_total":     3000,
      "grand_total":    3000,
      "payment_method": "cash",
      "shift_id":       null,
      "updated_at":     "2026-06-26T11:00:00+00:00"
    }'::jsonb,
    '[]'::jsonb,   -- p_segments: empty — passes segments pin guard
    -- p_movements: tenant_id=B -> caught by per-row stock_movements pin guard -> 42501
    '[{
      "id":         "bbbbbbbb-5901-4000-8000-000000000021",
      "tenant_id":  "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb",
      "branch_id":  "bbbb0001-0000-4000-8000-bbbbbbbbbbbb",
      "product_id": "aaaaaaaa-c0de-4000-8000-000000000001",
      "delta":      -1,
      "reason":     "sale",
      "order_id":   null,
      "manager_id": "00000000-0000-4000-8000-000000000002",
      "note":       null,
      "created_at": "2026-06-26T11:00:00+00:00"
    }]'::jsonb,
    'aaaaaaaa-de01-4000-8000-000000000001'::uuid,   -- p_device_id
    -- p_audit: tenant_id=A (valid); never reached because movements guard fires first
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000000021",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000009",
      "amount":    3000,
      "meta":      {},
      "created_at":"2026-06-26T11:00:00+00:00"
    }'::jsonb
  ) $$,
  '42501', null,
  'close_session_tx (0014): p_tenant_id=A but p_movements.tenant_id=B rejected by per-row payload pin (42501)');

reset role;

-- Re-establish Manager Alpha JWT for test 22.
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

-- Test 22 — Exploit path: p_tenant_id=A, p_segments[0].tenant_id=B rejected by
-- the per-row session_segments payload pin guard (migration 0014) before any write.
-- This directly exercises the segments pin guard that tests 19/21 left uncovered.
select throws_ok(
  $$ select public.close_session_tx(
    'aaaaaaaa-5e09-4000-8000-000000000009'::uuid,   -- p_session_id (A)
    'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_tenant_id = A (passes scalar guard)
    'aaaa0001-0000-4000-8000-aaaaaaaaaaaa'::uuid,   -- p_branch_id
    '00000000-0000-4000-8000-000000000002'::uuid,   -- p_actor_id
    '{
      "status":         "closed",
      "ended_at":       "2026-06-26T11:00:00+00:00",
      "time_total":     3000,
      "grand_total":    3000,
      "payment_method": "cash",
      "shift_id":       null,
      "updated_at":     "2026-06-26T11:00:00+00:00"
    }'::jsonb,
    -- p_segments: tenant_id=B -> caught by per-row session_segments pin guard -> 42501
    '[{
      "id":                      "bbbbbbbb-5e09-4000-8000-000000000022",
      "tenant_id":               "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb",
      "session_id":              "bbbbbbbb-5e09-4000-8000-000000000009",
      "play_mode":               "single",
      "rate_rule_id":            null,
      "price_per_hour_snapshot": 7000,
      "started_at":              "2026-06-26T09:00:00+00:00",
      "ended_at":                "2026-06-26T11:00:00+00:00",
      "updated_at":              "2026-06-26T11:00:00+00:00"
    }]'::jsonb,
    '[]'::jsonb,   -- p_movements: empty
    'aaaaaaaa-de01-4000-8000-000000000001'::uuid,   -- p_device_id
    -- p_audit: tenant_id=A (valid); never reached because segments guard fires first
    '{
      "id":        "aaaaaaaa-a091-4000-8000-000000000022",
      "tenant_id": "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
      "branch_id": "aaaa0001-0000-4000-8000-aaaaaaaaaaaa",
      "actor_id":  "00000000-0000-4000-8000-000000000002",
      "action":    "session.close",
      "entity":    "sessions",
      "entity_id": "aaaaaaaa-5e09-4000-8000-000000000009",
      "amount":    3000,
      "meta":      {},
      "created_at":"2026-06-26T11:00:00+00:00"
    }'::jsonb
  ) $$,
  '42501', null,
  'close_session_tx (0014): p_tenant_id=A but p_segments.tenant_id=B rejected by per-row payload pin (42501)');

reset role;

-- ===========================================================================

select * from finish();
rollback;
