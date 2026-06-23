-- =============================================================================
-- 00_rls_enabled.test.sql — pgTAP meta-guard (rls-tenant-audit)
--
-- Asserts the two structural invariants that make tenant isolation possible:
--   1. EVERY table in `public` has RLS enabled.
--   2. EVERY table in `public` has at least one policy.
-- These are set-based so they automatically cover tables added in future
-- migrations — a new table shipped without a policy fails this test.
--
-- Run: supabase test db   (requires the local Supabase stack / Docker, or CI).
-- =============================================================================

begin;
select plan(2);

-- 1. RLS enabled on every public table.
select is(
  (
    select count(*)
    from pg_tables t
    where t.schemaname = 'public'
      and not coalesce(
        (select c.relrowsecurity
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = t.tablename),
        false)
  ),
  0::bigint,
  'every public table has RLS enabled'
);

-- 2. At least one policy on every public table.
select is(
  (
    select count(*)
    from pg_tables t
    where t.schemaname = 'public'
      and not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = t.tablename
      )
  ),
  0::bigint,
  'every public table has at least one RLS policy'
);

select * from finish();
rollback;
