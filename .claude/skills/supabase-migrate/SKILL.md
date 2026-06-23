---
name: supabase-migrate
description: Author and apply Supabase Postgres migrations for PS-Managment safely. Use when creating or changing the schema, RLS policies, or edge functions. Enforces forward-only numbered migrations, RLS-on-every-table, and tenant_id conventions.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

# supabase-migrate

Author multi-tenant-safe migrations. Read `docs/reference/schema-and-rls.md` first — it has the trial's table shapes and the exact multi-tenant deltas.

## Rules
1. **Forward-only, numbered.** New file `supabase/migrations/NNNN_short_name.sql` (next zero-padded number). **Never edit an applied migration** — add a corrective one.
2. **RLS on every `public` table.** Right after `CREATE TABLE`, add `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` and the policies, in the **same** migration. No policies = no access = review blocker.
3. **Tenant scoping.** Tenant-scoped tables get `tenant_id uuid not null` (+ `branch_id` where relevant) and an index with `tenant_id` first. Unique constraints include it (e.g. `unique (tenant_id, device_id) where status='active'`).
4. **Policies read the trusted claim**, never a client-set value. Use a helper, e.g.:
   ```sql
   create or replace function public.current_tenant_id() returns uuid
   language sql stable as $$ select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id','')::uuid $$;
   ```
   Tenant policy shape:
   ```sql
   create policy tbl_select on public.tbl for select
     using (tenant_id = public.current_tenant_id());
   create policy tbl_write on public.tbl for insert
     with check (tenant_id = public.current_tenant_id());   -- WITH CHECK blocks cross-tenant writes
   ```
   `security definer` functions MUST re-derive tenant from the claim (they bypass RLS).
5. **Money** columns `integer` (piastres); **timestamps** `timestamptz default now()` (UTC). Keep `set_updated_at()` triggers (port the trial's `0001` helper).
6. **Audit.** Money-affecting operations write `audit_log` (tenant, actor, action, amount, meta).

## Workflow
1. Draft the migration following the rules. Put table + RLS + indexes together.
2. Apply from a clean DB and confirm it runs end-to-end:
   ```
   npx supabase db reset        # applies all migrations + seed from scratch
   ```
3. Update `supabase/seed.sql` so **≥2 tenants** (+ branches/devices/rate_rules/products) exist for isolation testing.
4. Hand to `rls-tenant-audit` to add/confirm isolation tests, then run `ps-verify`.

## Output
List the migration file, tables/policies/indexes created, the JWT-claim contract, and confirmation it applies cleanly from scratch. **Flag for `security-reviewer`.**
