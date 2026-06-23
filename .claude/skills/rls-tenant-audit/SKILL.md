---
name: rls-tenant-audit
description: Prove multi-tenant isolation in Supabase — that tenant A can never read or write tenant B's data. Use whenever RLS policies, schema, auth, or edge functions change, and as part of QA and security review. Produces/refreshes isolation tests and a pass/fail verdict.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

# rls-tenant-audit

The prime safety check for a multi-tenant SaaS. Every tenant-scoped table must be provably isolated.

## What to verify (per tenant-scoped table)
For two distinct seeded tenants A and B, acting as a user authenticated into tenant A:

1. **SELECT** returns only tenant A rows — never any tenant B row (directly, via JOIN, or via a view/RPC).
2. **INSERT** with `tenant_id = B` is **rejected** by `WITH CHECK` (or silently coerced/blocked — never lands in B).
3. **UPDATE** of a tenant B row affects **0 rows**.
4. **DELETE** of a tenant B row affects **0 rows**.
5. **Edge functions / `security definer` functions** do not leak across tenants and re-derive tenant id from the trusted claim, not from arguments.
6. **RLS is enabled** on the table (a table with RLS off is an automatic FAIL).

## How to test
- Prefer SQL-level tests (e.g. pgTAP) or an integration test that signs in as a tenant-A user (real JWT with `app_metadata.tenant_id`) and exercises each table via the Supabase client.
- Drive against a clean DB: `npx supabase db reset` (applies migrations + seed with ≥2 tenants), then run the isolation suite.
- Cover **new and changed** tables; keep the suite growing with the schema.

## Checklist to emit
For each table: RLS enabled? · SELECT isolated? · INSERT-cross blocked? · UPDATE-cross 0 rows? · DELETE-cross 0 rows? · functions/views safe? → PASS/FAIL with the failing query/output.

## Output
A table of results + an explicit **isolation verdict** (PASS = ship / FAIL = blocker). Any cross-tenant leak is always a blocker. `security-reviewer` uses this for sign-off.
