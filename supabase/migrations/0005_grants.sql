-- =============================================================================
-- Migration 0005 — role grants for the API roles
--
-- RLS (migration 0004) is the ROW-level gate: it decides which rows each tenant
-- can see/modify. But Postgres also needs TABLE-level privileges for a role to
-- touch a table at all. Tables created in SQL migrations are NOT auto-granted to
-- Supabase's API roles, so without this every authenticated query fails with
-- "permission denied for table ..." (caught by the CI isolation suite).
--
-- Safe because RLS still restricts rows: granting DML to `authenticated` only
-- lets the role attempt access; current_tenant_id()-based policies (+ WITH CHECK)
-- still confine it to its own tenant. `service_role` (BYPASSRLS) is for trusted
-- server-side/edge-function use only.
-- =============================================================================

grant usage on schema public to authenticated, service_role;

-- authenticated: full DML, row-gated by RLS.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- service_role: full access (bypasses RLS) for edge functions / admin tasks.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Future tables added by later migrations inherit the same grants.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant all on sequences to service_role;

-- =============================================================================
-- END OF MIGRATION 0005
-- =============================================================================
