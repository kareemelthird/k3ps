# ADR-0001: Multi-tenant data-isolation model

- **Status:** Superseded by [ADR-0002](0002-tenant-isolation-model-ratified.md)
- **Date:** 2026-06-23
- **Note:** This was the qualitative proposal. The `architecture-decision` judge panel ratified the **same Decision (Option A)** with weighted scores and grafted runner-up (Option D) strengths into Consequences — see ADR-0002. Decision unchanged; ADR-0002 is the authoritative record.
- **Deciders:** architect (proposing) · `security-reviewer` (sign-off required) · human project owner (approves the gate)

## Context

PS-Managment is a multi-tenant SaaS for gaming cafés on Supabase (Postgres + Auth + RLS). One platform serves **many independent café businesses**. Each business is a **tenant** owning **1..N branches**; most tenants are small (a handful of devices, 1-3 branches, a few staff). See `CLAUDE.md` §1 (tenancy hierarchy) and §5 (tenancy & security), and `docs/reference/schema-and-rls.md` (the trial's single-café schema + the multi-tenant deltas this ADR must enable).

We must choose **how tenant data is physically/logically separated** before any multi-tenant schema lands (this is the Phase-2 gating decision per `CLAUDE.md` §5).

**Hard constraints (from `CLAUDE.md`):**
- Tenant isolation is **airtight**: no tenant can ever read or write another tenant's rows. Enforced in Postgres (RLS), not just the app — defense in depth (§5).
- Tenant identity comes from a **trusted JWT claim in `app_metadata`** set by a Supabase auth hook — never from client input and never from a hot-path `profiles` lookup (§5).
- Every tenant-scoped table: indexed `tenant_id` (+ `branch_id` where relevant), RLS enabled, `WITH CHECK` on writes (§5).
- **Forward-only migrations** via Supabase CLI (§6).
- Low operational overhead is an explicit goal; the team is an AI agent "company" + one human, not a DBA fleet.
- Business logic (money/time/pricing) lives in `@ps/core`, so the DB stays a thin, mostly-uniform store (`docs/reference/core-api.md`) — this favors a single uniform schema.

**Forces in tension:** maximal isolation (separate DBs) vs. operational simplicity + cost with many small tenants vs. clean fit with Supabase's defaults (PostgREST exposes the `public` schema; Auth hooks set JWT claims; connection pooling is shared).

## Options considered

### Option A — Shared database + shared schema + `tenant_id` column on every table, enforced by RLS
Every tenant-scoped table carries `tenant_id uuid not null` (and `branch_id` where relevant), indexed and placed first in composite indexes. RLS is enabled on every `public` table; policies `AND` a tenant predicate that reads the trusted JWT claim (`current_tenant_id()` / `auth_tenant_ids()` helper over `auth.jwt() -> app_metadata`), with `WITH CHECK` on writes. The tenant claim is injected by a **Custom Access Token Hook** into `app_metadata`, which is cryptographically signed and not user-editable.

- Pros:
  - Strongest fit with Supabase defaults: PostgREST already exposes `public`; one auth hook; no per-tenant provisioning, no per-tenant PostgREST schema reconfiguration.
  - Lowest operational overhead and cost for **many small tenants** — one schema, one migration target, shared connection pool, shared catalogs. MS Learn: multitenant DB has "the lowest per-tenant cost" and scales to very high tenant counts.
  - Forward-only migrations apply once to one schema (Supabase CLI) — no fan-out across N schemas/DBs.
  - Keeps the DB uniform and thin, matching `@ps/core`-centric design (`docs/reference/core-api.md`).
  - RLS performance is a solved problem: index policy columns and wrap auth calls in `(select ...)` for initPlan caching (Supabase docs report 94-99% improvements).
- Cons:
  - **Isolation is logical, not physical** — a single bad policy or a `SECURITY DEFINER` helper that forgets the tenant filter can leak across tenants. MS Learn: "a multitenant database necessarily sacrifices tenant isolation." Mitigated by mandatory `rls-tenant-audit` tests + `security-reviewer` sign-off + defense in depth.
  - Noisy-neighbor risk: tenants share CPU/IO; no native per-tenant resource governance.
  - Per-tenant restore is harder (must filter by `tenant_id`, not restore a DB).
- Evidence:
  - https://learn.microsoft.com/azure/azure-sql/database/saas-tenancy-app-design-patterns (lowest per-tenant cost; isolation sacrificed; models compared)
  - https://learn.microsoft.com/azure/architecture/guide/multitenant/service/postgresql (Postgres RLS for tenant isolation; index policy columns; perf-test)
  - https://supabase.com/docs/guides/database/postgres/row-level-security (index policy columns; wrap auth fns in `select` for initPlan caching; use `raw_app_meta_data`, not user_metadata)
  - https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook (inject signed, non-user-editable claims into `app_metadata`)
  - https://makerkit.dev/blog/tutorials/supabase-rls-best-practices ; https://blog.ardabeyazoglu.com/supabase-multi-tenancy (shared-schema + tenant_id + RLS is the practical default)

### Option B — Shared database + schema-per-tenant
Each tenant gets a Postgres schema (`tenant_<id>`) cloned from a template; identical tables per schema; the app routes to the tenant's schema.

- Pros:
  - Stronger logical isolation than a shared schema; a query in the wrong schema simply finds no data.
  - Per-tenant schema customization is possible (we don't need it).
- Cons:
  - **Poor fit with Supabase/PostgREST:** only the `public` schema is exposed by default; each new tenant requires reconfiguring the authenticator's exposed-schemas setting at signup — "no built-in way to change it dynamically" and it "increases the risk of security leaks."
  - **Migrations fan out across every schema** — forward-only migrations must be applied N times; the agent CLI workflow doesn't support this cleanly. Catalog/FK bloat grows with tenant count.
  - Cross-schema shared/reference data and RLS still needed for the shared parts → ends up a hybrid anyway.
  - Higher dev + ops complexity for no benefit at our scale (mostly small tenants).
- Evidence:
  - https://blog.ardabeyazoglu.com/supabase-multi-tenancy (PostgREST exposes only `public`; no dynamic switch; per-tenant schema exposure adds overhead + leak risk; recommends shared-schema + RLS)
  - https://supabase.com/docs/guides/troubleshooting/pgrst106-the-schema-must-be-one-of-the-following-error-when-querying-an-exposed-schema (PostgREST only serves schemas in `pgrst.db_schemas`)
  - https://planetscale.com/blog/approaches-to-tenancy-in-postgres (schema-per-tenant: catalog/FK bloat, migration fan-out)

### Option C — Database-per-tenant (or Supabase-project-per-tenant)
Each tenant gets its own database (or its own Supabase project). Maximum isolation.

- Pros:
  - Strongest physical isolation; trivial per-tenant backup/restore and per-tenant resource sizing; per-tenant encryption keys possible. MS Learn rates tenant isolation "High."
- Cons:
  - **Does not scale to many small tenants.** Connection pooling is per-database and quickly exceeds `max_connections`; each `CREATE DATABASE` carries its own ~8 MB catalogs; "likely won't scale beyond a few hundred tenants." Supabase-project-per-tenant means N projects to provision/bill/monitor/migrate — operationally hostile for a one-human + agents team.
  - **Migrations fan out across every DB/project** — forward-only migrations applied N times; highest ops complexity.
  - Highest per-tenant cost for small tenants. MS Learn: standalone/db-per-tenant cost is "High … sized for peaks."
  - Worst fit with a single Supabase Auth instance + one JWT-claim model.
- Evidence:
  - https://learn.microsoft.com/azure/azure-sql/database/saas-tenancy-app-design-patterns (db-per-tenant: high isolation, high cost, scale to ~100,000s only with pooling tooling we don't have)
  - https://planetscale.com/blog/approaches-to-tenancy-in-postgres (connection limits are the primary blocker; ~8 MB catalogs per DB; won't scale past a few hundred)
  - https://dzone.com/articles/database-connection-pooling-at-scale-pgbouncer-mul (PgBouncer pools per-database exhaust `max_connections`)

### Option D — Hybrid: shared-schema + RLS by default, promote large/sensitive tenants to an isolated schema/DB later
Start with Option A for all tenants; reserve the ability to move an exceptional tenant (very large, or with a contractual data-residency/isolation requirement) to a dedicated schema or Supabase project.

- Pros:
  - Captures Option A's velocity/cost while keeping a documented escape hatch for the rare big/sensitive tenant. MS Learn explicitly endorses migrating a graduating tenant out of a shared DB (split-merge / move).
  - Reversibility built in — the default is the cheap path; isolation is opt-in per tenant when justified by evidence.
- Cons:
  - The "promote later" machinery (export by `tenant_id`, routing layer, dual-path RLS/auth) is **real work we do not need yet** — building it now is premature.
  - Two code paths if implemented early; risk of complexity creep.
- Evidence:
  - https://learn.microsoft.com/azure/azure-sql/database/elastic-scale-introduction (move a tenant from multitenant to single-tenant DB when it graduates)
  - https://learn.microsoft.com/azure/architecture/guide/multitenant/considerations/tenancy-models (isolation is a spectrum; mix per requirement)
  - https://makerkit.dev/blog/tutorials/supabase-rls-best-practices (hybrid: shared schema for common data, isolate only when necessary)

## Decision

**Adopt Option A — shared database + shared `public` schema + `tenant_id` on every tenant-scoped table, enforced by RLS — with the Option D escape hatch documented but NOT built now.**

Single most important reason: it is the **only model that simultaneously delivers airtight isolation (via RLS + a trusted, signed `app_metadata` JWT claim + mandatory isolation tests) AND the low operational overhead / forward-only single-target migrations / clean Supabase fit** our many-small-tenants profile and one-human-plus-agents team require. Schema- and DB-per-tenant both force migration fan-out and fight Supabase's `public`-only PostgREST default; DB-per-tenant additionally hits connection-pool limits within a few hundred tenants. We explicitly accept logical (not physical) isolation and compensate with defense in depth: RLS `WITH CHECK` on every write, the trusted-claim helper, app-layer filtering as a second line, and the `rls-tenant-audit` test suite gating every RLS change.

**Explicitly NOT doing now:** schema-per-tenant; database/project-per-tenant; building the "promote a tenant to isolated storage" pipeline. Option D is recorded as the sanctioned future path; revisit only when a concrete tenant presents a data-residency/contractual-isolation requirement or a noisy-neighbor SLA problem — at which point a new ADR supersedes the relevant part of this one.

## Consequences

- **Becomes easy:**
  - One forward-only migration target (Supabase CLI); one PostgREST config; one Auth hook.
  - Adding tenants is a row insert, not provisioning. Lowest cost for many small tenants.
  - Uniform schema matches the `@ps/core`-thin-DB design; cross-tenant super-admin analytics are a normal query (guarded + audited).
- **Becomes hard / accepted risk:**
  - Isolation correctness rests on **policy discipline**, not physical walls — one wrong policy or an unscoped `SECURITY DEFINER` helper can leak. This is why `rls-tenant-audit` and `security-reviewer` sign-off are non-negotiable gates.
  - No native per-tenant resource governance (noisy-neighbor); per-tenant point-in-time restore requires `tenant_id`-filtered export, not a DB restore.
  - JWT-claim **freshness**: the custom access token hook runs at token issuance; tenant/role changes in `app_metadata` only take effect on token refresh/re-auth — design role changes to tolerate this (or force a refresh).

- **Follow-up work (hand-off — see design below):**
  - Add `tenants`, `branches`, `tenant_members(tenant_id, profile_id, role)`; add `super_admin` role.
  - Add `tenant_id` (+ `branch_id` where relevant) to every operational table; index it first in composite indexes; convert the unique-active-session constraint to `(tenant_id, device_id) where status='active'`.
  - Implement the **Custom Access Token Hook** injecting `tenant_ids`/`current_tenant_id` into `app_metadata`; implement `current_tenant_id()` / `auth_tenant_ids()` helpers reading `auth.jwt()`.
  - Rewrite every policy to `AND` the tenant predicate with `WITH CHECK` on writes; wrap auth-fn calls in `(select ...)` for initPlan caching; index all policy columns.
  - Guard + audit the super-admin / impersonation cross-tenant path (time-boxed, explicit, audited).
  - Seed ≥2 tenants for isolation testing.

- **Must verify (before this decision is "done"):**
  - `rls-tenant-audit`: prove tenant A cannot read **or** write tenant B's rows across every tenant-scoped table — for `select`, `insert`, `update`, `delete`, including child tables and views (`security_invoker=true`).
  - Performance: confirm `tenant_id` indexes are used and policies use cached `(select auth.jwt())` initPlans; run a perf check per Supabase/MS-Learn guidance.
  - JWT-claim trust: verify the tenant claim is in signed `app_metadata` (not `user_metadata`, not client input) and that policies never trust client-supplied tenant identifiers.
  - **Sign-off:** `security-reviewer` must approve every RLS/auth change; the human project owner approves the Phase-2 gate. **This decision and all derived tenancy/auth work are flagged for `security-reviewer`.**
