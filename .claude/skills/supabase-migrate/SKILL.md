---
name: supabase-migrate
description: Author and apply Supabase Postgres migrations for PS-Managment safely. Use when creating or changing the schema, RLS policies, or edge functions. Enforces forward-only numbered migrations, RLS-on-every-table, and tenant_id conventions.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

# supabase-migrate

Author multi-tenant-safe migrations. Follow this every time you touch `supabase/`.

## Rules
1. **Forward-only, numbered.** Create a new file `supabase/migrations/NNNN_short_name.sql` (zero-padded, next number). **Never edit an already-applied migration** — add a corrective one.
2. **RLS on every `public` table.** Immediately after `CREATE TABLE`, add `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` and the policies. A table without policies = no access (and a review blocker).
3. **Tenant scoping.** Tenant-scoped tables get an indexed `tenant_id uuid not null` (and `branch_id` where relevant). Add the index in the same migration.
4. **Policies read trusted claims.** Use the tenant id from the JWT `app_metadata` claim via a helper (e.g. `auth.jwt() -> 'app_metadata' ->> 'tenant_id'`), never from a client-supplied column value. Use `WITH CHECK` on INSERT/UPDATE so a user cannot write into another tenant.
5. **Money** columns are `integer` (piastres). **Timestamps** are `timestamptz` defaulting to `now()` (UTC).
6. **Audit.** Money-affecting tables/operations write to `audit_log`.

## Workflow
1. Draft the migration SQL following the rules above.
2. Apply locally and confirm it runs from a clean DB:
   ```
   npx supabase db reset        # applies all migrations + seed from scratch
   ```
   (or `npx supabase migration up` against a running local stack).
3. Update `supabase/seed.sql` so at least **two tenants** exist for isolation testing.
4. Hand off to `rls-tenant-audit` to add/confirm isolation tests.

## Output
List the migration file added, tables/policies/indexes created, the JWT-claim contract, and confirmation it applies cleanly from scratch. Flag for `security-reviewer`.
