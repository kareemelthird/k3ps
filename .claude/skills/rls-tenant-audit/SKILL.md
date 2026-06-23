---
name: rls-tenant-audit
description: Prove multi-tenant isolation in Supabase — that tenant A can never read or write tenant B's data. Use whenever RLS policies, schema, auth, or edge functions change, and as part of QA and security review. Produces/refreshes isolation tests and a pass/fail verdict.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

# rls-tenant-audit

The prime safety check for the SaaS. Every tenant-scoped table must be **provably** isolated. Read `docs/reference/schema-and-rls.md` for the table list and claim contract.

## Per tenant-scoped table — verify (acting as a user signed into tenant A, with ≥2 seeded tenants)
1. **RLS enabled** on the table — a table with RLS off is an automatic FAIL.
2. **SELECT** returns only tenant-A rows — never a tenant-B row, directly OR via JOIN, view, or RPC.
3. **INSERT** with `tenant_id = B` is **rejected** by `WITH CHECK` (never lands in B).
4. **UPDATE** targeting a tenant-B row affects **0 rows**.
5. **DELETE** targeting a tenant-B row affects **0 rows**.
6. **Functions/views:** edge functions and `security definer` functions re-derive tenant from the JWT claim (they bypass RLS) and don't leak; views are `security_invoker` where appropriate.

## How to test
- Prefer SQL-level tests (pgTAP) and/or an integration test that signs in as a tenant-A user with a **real JWT carrying `app_metadata.tenant_id`** and exercises each table via the Supabase client.
- Always drive against a clean DB: `npx supabase db reset` (migrations + seed with ≥2 tenants), then run the isolation suite.
- Cover **new and changed** tables every time; grow the suite with the schema. A handy sweep to find unprotected tables:
  ```sql
  select tablename from pg_tables t
  where schemaname='public'
    and not exists (select 1 from pg_policies p where p.tablename=t.tablename);
  ```
  Any row returned = a table with no policies = FAIL.

## Output
A table — per table: RLS on? · SELECT isolated? · INSERT-cross blocked? · UPDATE-cross 0 rows? · DELETE-cross 0 rows? · functions/views safe? — each PASS/FAIL with the failing query/output. End with an explicit **isolation verdict** (PASS = ship / FAIL = blocker). **Any cross-tenant leak is always a blocker;** `security-reviewer` uses this for sign-off.
