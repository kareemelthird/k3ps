# supabase

Multi-tenant backend: Postgres schema, **RLS policies (tenant isolation)**, edge functions, and seed data.

```
supabase/
  migrations/   # numbered SQL migrations (0001_..., 0002_...)
  functions/    # edge functions (auth hooks, billing webhooks, etc.)
  seed.sql      # sample tenants/branches/devices/rate-rules/products for dev
```

**Built in Phase 2 (tenant foundation).** The `backend-engineer` agent owns this directory; the `security-reviewer` agent must sign off on every RLS change.

## Tenant isolation (decision pending — Phase 2 ADR)

The isolation model (shared-DB + `tenant_id` + RLS vs schema/DB-per-tenant) is decided via `docs/adr/` using the `architecture-decision` workflow before any schema lands. Whatever is chosen:

- **RLS enabled on every table** in the `public` schema — no exceptions.
- Every tenant-scoped table carries an indexed `tenant_id`.
- Policies use `WITH CHECK` on writes so a user cannot insert into another tenant.
- Tenant id is read from a **trusted JWT claim** (`app_metadata`), never from client-supplied request bodies.
- Isolation is proven by tests: tenant A can never read/write tenant B's rows.

See root `CLAUDE.md` → "Tenancy & security".
