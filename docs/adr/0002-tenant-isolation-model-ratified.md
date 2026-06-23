# ADR-0002: Multi-tenant data-isolation model (ratified by judge panel)

- **Status:** Accepted (human-approved at the Phase-2 gate, 2026-06-23) — supersedes [ADR-0001](0001-tenant-isolation-model.md)
- **Date:** 2026-06-23
- **Deciders:** architect (proposing) · `security-reviewer` (sign-off **required** — tenancy/auth) · human project owner (approved the Phase-2 gate)

## Why this supersedes ADR-0001

ADR-0001 proposed Option A on qualitative grounds. The `architecture-decision` workflow then ran a weighted judge panel (isolation weighted highest) over all four options. This ADR **ratifies the same Decision (Option A)** but anchors it to the panel's scores and trade-offs, and grafts the runner-up's (Option D, deferred) strengths explicitly into Consequences. ADR-0001 is marked Superseded; no Accepted ADR was rewritten.

**Panel result (weighted, high → low):**

| Rank | Option | Score |
|---|---|---|
| 1 | **A — Shared DB + shared schema + `tenant_id` + RLS** | **7.5** |
| 2 | D — Hybrid: A by default, promote large/sensitive tenants later (deferred) | 7.4 |
| 3 | C — Database-per-tenant / Supabase-project-per-tenant | 4.5 |
| 4 | B — Shared DB + schema-per-tenant | 4.2 |

## Context

PS-Managment is a multi-tenant SaaS for gaming cafés on Supabase (Postgres + Auth + RLS). One platform serves **many independent café businesses**. Each business is a **tenant** owning **1..N branches**; most tenants are small (a handful of devices, 1-3 branches, a few staff). See `CLAUDE.md` §1 (tenancy hierarchy) and §5 (tenancy & security), and `docs/reference/schema-and-rls.md` (the trial's single-café schema + the multi-tenant deltas this ADR must enable).

We must choose **how tenant data is separated** before any multi-tenant schema lands — the Phase-2 gating decision per `CLAUDE.md` §5.

**Hard constraints (from `CLAUDE.md` §5/§6):**
- Tenant isolation is **airtight**: no tenant can ever read or write another tenant's rows. Enforced in Postgres (RLS), not just the app — defense in depth.
- Tenant identity comes from a **trusted JWT claim in `app_metadata`** set by a Supabase auth hook — never client input, never a hot-path `profiles` lookup.
- Every tenant-scoped table: indexed `tenant_id` (+ `branch_id` where relevant), RLS enabled, `WITH CHECK` on writes.
- **Forward-only migrations** via Supabase CLI.
- Low operational overhead is an explicit goal; the team is an AI-agent "company" + one human, not a DBA fleet.
- Business logic (money/time/pricing) lives in `@ps/core`, so the DB stays a thin, mostly-uniform store — favoring a single uniform schema.

**Forces in tension:** maximal isolation (separate DBs) vs. operational simplicity + cost with many small tenants vs. clean fit with Supabase's defaults (PostgREST exposes `public`; Auth hooks set JWT claims; connection pooling is shared via Supavisor).

**Panel weighting:** isolation 0.40, ops/migrations 0.15, cost 0.15, velocity 0.15, reversibility 0.15. Isolation is deliberately the dominant criterion — and the winner's lowest sub-score is precisely there, which the panel surfaced honestly (see Decision).

## Options considered

### Option A — Shared database + shared schema + `tenant_id` column on every table, enforced by RLS — **CHOSEN (7.5)**
Every tenant-scoped table carries `tenant_id uuid not null` (and `branch_id` where relevant), indexed and placed **first** in composite indexes. RLS enabled on every `public` table; policies `AND` a tenant predicate reading the trusted JWT claim (`current_tenant_id()` / `auth_tenant_ids()` over `auth.jwt() -> app_metadata`), with `WITH CHECK` on writes. The tenant claim is injected by a **Custom Access Token Hook** into `app_metadata`, which is cryptographically signed and not user-editable.

- **Sub-scores:** isolation 6, ops/migrations 9, cost 9, velocity 8, reversibility 8.
- Pros:
  - Strongest fit with Supabase defaults: PostgREST already exposes `public`; one auth hook; no per-tenant provisioning, no per-tenant PostgREST reconfiguration.
  - **Best ops/migrations of the four (9):** one shared schema = one forward-only Supabase CLI target, no O(N) fan-out, one PostgREST config, one connection pool; add-a-tenant is a row insert.
  - **Lowest per-tenant cost (9):** matches the many-small-cafés profile; scales to very high tenant counts.
  - **High velocity (8):** uniform thin schema, logic in `@ps/core`, standard Supabase defaults, trivial two-tenant-rows isolation test.
  - **Strong reversibility (8):** `tenant_id` as the leading column of every PK/composite index keeps per-tenant export/move tractable, so the Option D promotion path stays open.
  - RLS performance is solved: index policy columns and wrap auth calls in `(select ...)` for initPlan caching (Supabase reports 94-99% improvements).
- Cons:
  - **Isolation is logical, not physical (6 — the dominant-weight sub-score):** a missing `WITH CHECK`, an unscoped `SECURITY DEFINER` helper, a view without `security_invoker`, or a new table shipped without a policy each leaks across tenants. MS Learn: a multitenant DB "necessarily sacrifices tenant isolation." Correctness rests on **policy discipline + `rls-tenant-audit` + `security-reviewer` sign-off** — procedure, not a physical wall.
  - Noisy-neighbor risk: shared CPU/IO; no native per-tenant resource governance.
  - Per-tenant point-in-time restore requires `tenant_id`-filtered export, not a DB restore.
  - Standing tax: every new table must add RLS+policy correctly; JWT-claim freshness (hook runs at token issuance) must be handled in role-change flows.
- Evidence:
  - https://learn.microsoft.com/azure/azure-sql/database/saas-tenancy-app-design-patterns (lowest per-tenant cost; isolation sacrificed; models compared)
  - https://learn.microsoft.com/azure/architecture/guide/multitenant/service/postgresql (Postgres RLS for tenant isolation; index policy columns; perf-test)
  - https://supabase.com/docs/guides/database/postgres/row-level-security (index policy columns; wrap auth fns in `select` for initPlan caching; use `raw_app_meta_data`, not `user_metadata`)
  - https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook (inject signed, non-user-editable claims into `app_metadata`)
  - https://makerkit.dev/blog/tutorials/supabase-rls-best-practices ; https://blog.ardabeyazoglu.com/supabase-multi-tenancy (shared-schema + `tenant_id` + RLS is the practical default)

### Option D — Hybrid: shared-schema + RLS by default, promote large/sensitive tenants to isolated schema/DB later (runner-up, 7.4)
Start with Option A for all tenants; reserve the ability to move an exceptional tenant (very large, or contractual data-residency/isolation) to a dedicated schema or Supabase project.

- **Sub-scores:** isolation 7, ops/migrations 6, cost 9, velocity 7, reversibility 9.
- Pros:
  - Same day-one isolation **floor** as A, but a higher isolation **ceiling** (physical isolation available for a rare large/regulated tenant).
  - **Best reversibility (9):** isolation becomes opt-in per tenant, evidence-gated, cheap to undo; `tenant_id`-leading keys make per-tenant move tractable with no schema rework.
  - Captures A's cost/velocity while keeping a documented escape hatch.
- Cons:
  - The "promote later" machinery (placement/routing table, dual auth-claim resolution, dual RLS/connection paths, export-by-tenant pipeline) is **real, security-sensitive work we do not need yet**; building it early *reduces* net isolation by adding attack surface, and drops ops to 6 (two code paths, drift across heterogeneous backends).
  - Risk of scope creep / premature construction for a need absent in the gaming-café domain (small tenants, 1-3 branches, no stated residency/HIPAA mandate).
- Evidence:
  - https://learn.microsoft.com/azure/azure-sql/database/elastic-scale-introduction (move a tenant from multitenant to single-tenant DB when it graduates)
  - https://learn.microsoft.com/azure/architecture/guide/multitenant/considerations/tenancy-models (isolation is a spectrum; mix per requirement)
  - https://makerkit.dev/blog/tutorials/supabase-rls-best-practices (hybrid: shared schema for common data, isolate only when necessary)

### Option C — Database-per-tenant (or Supabase-project-per-tenant) (4.5)
Each tenant gets its own database or Supabase project. Maximum isolation.

- **Sub-scores:** isolation 10, ops/migrations 1, cost 1, velocity 2, reversibility 3.
- Pros: strongest **physical** isolation (10) — a forgotten policy or `tenant_id` bug cannot leak across databases; smallest blast radius; trivial per-tenant backup/restore and resource sizing.
- Cons: catastrophic ops fit for a one-human+agents team — migrations fan out across N projects (control plane, fleet runner, drift tooling); worst cost for small tenants (~$10/mo dedicated compute + ~$25/mo org base per project, hundreds idle); **breaks the single-Auth-hook JWT-claim model** (one GoTrue per project fragments login, cross-tenant users, super-admin federation; `rls-tenant-audit`'s two-rows-one-DB test no longer applies); merging back is painful identity reconciliation.
- Evidence:
  - https://learn.microsoft.com/azure/azure-sql/database/saas-tenancy-app-design-patterns (db-per-tenant: high isolation, high cost)
  - https://planetscale.com/blog/approaches-to-tenancy-in-postgres (connection limits the blocker; ~8 MB catalogs per DB; won't scale past a few hundred)
  - https://dzone.com/articles/database-connection-pooling-at-scale-pgbouncer-mul (PgBouncer pools per-database exhaust `max_connections`)

### Option B — Shared database + schema-per-tenant (4.2)
Each tenant gets a Postgres schema (`tenant_<id>`) cloned from a template; the app routes to the tenant's schema.

- **Sub-scores:** isolation 6, ops/migrations 2, cost 5, velocity 3, reversibility 3.
- Pros: stronger happy-path isolation than shared-schema (wrong schema returns no rows); per-tenant customization (not needed).
- Cons: isolation is still only logical AND adds a **second** enforcement surface (schema routing) while RLS is *still* required for the shared/platform schema. **Supabase-specific footgun:** `search_path`-per-connection is unsafe under the transaction-mode Supavisor pooler and can **silently mix tenants' data** (catastrophic leak); the safe alternative (PostgREST `Accept-Profile`/`Content-Profile`) only reaches schemas pre-listed in static `db-schemas`, requiring a config change + schema-cache reload on every onboard. Migrations fan out O(N) across schemas + template; pg_class bloat caps scale at low hundreds.
- Evidence:
  - https://blog.ardabeyazoglu.com/supabase-multi-tenancy (PostgREST exposes only `public`; no dynamic switch; per-tenant schema exposure adds overhead + leak risk; recommends shared-schema + RLS)
  - https://supabase.com/docs/guides/troubleshooting/pgrst106-the-schema-must-be-one-of-the-following-error-when-querying-an-exposed-schema (PostgREST only serves schemas in `pgrst.db_schemas`)
  - https://planetscale.com/blog/approaches-to-tenancy-in-postgres (schema-per-tenant: catalog/FK bloat, migration fan-out)

## Decision

**Adopt Option A — shared database + shared `public` schema + `tenant_id` on every tenant-scoped table, enforced by RLS — with the Option D escape hatch documented but NOT built now.**

Single most important reason: Option A is the **only model that simultaneously delivers airtight isolation (via RLS + a trusted, signed `app_metadata` JWT claim + mandatory two-tenant isolation tests) AND the low operational overhead / forward-only single-target migrations / clean Supabase fit** that our many-small-tenants profile and one-human-plus-agents team require. It won the panel (7.5) on exactly these axes (ops 9, cost 9, velocity 8, reversibility 8).

**Honest acknowledgement of the winner's weakness:** Option A's lowest sub-score (isolation, 6) sits on the **highest-weighted** criterion, because isolation here is *logical*, not physical. The 7.5 is the price of buying cost/ops/velocity with a discipline-dependent isolation model rather than a physical wall. We accept this **only** because the mitigations below convert a potential leak from an architectural inevitability into a detectable discipline failure: the signed `app_metadata` claim (never client input, never a hot-path lookup), `WITH CHECK` on every write, app-layer filtering as a second line, and the `rls-tenant-audit` suite gating every RLS change with `security-reviewer` sign-off.

**Grafted from the runner-up (Option D, 7.4):** we adopt Option D's *reversibility posture without its machinery*. Concretely: `tenant_id` is the **leading column of every PK/composite index** from day one so a future per-tenant export/move is tractable; and the promotion path is recorded as the sanctioned future direction — to be *built only* when a concrete trigger arises, via a new ADR.

**Explicitly NOT doing now:** schema-per-tenant (Option B); database/project-per-tenant (Option C); building the "promote a tenant to isolated storage" pipeline (Option D machinery — placement/routing table, dual auth-claim resolution, dual RLS/connection paths). **Hard governance rule:** no tenant is promoted to isolated storage without a *concrete data-residency, contractual-isolation, or noisy-neighbor-SLA trigger* ratified by a new ADR that supersedes the relevant part of this one.

## Consequences

- **Becomes easy:**
  - One forward-only migration target (Supabase CLI); one PostgREST config; one Auth hook.
  - Adding tenants is a row insert, not provisioning. Lowest cost for many small tenants.
  - Uniform schema matches the `@ps/core`-thin-DB design; cross-tenant super-admin analytics are a normal query (guarded + audited).
  - The Option D promotion path stays cheap to open later (promoting a tenant *out* is the cheap direction) because every table carries `tenant_id` as its leading key.

- **Becomes hard / accepted risk:**
  - Isolation correctness rests on **policy discipline**, not physical walls — one wrong policy, an unscoped `SECURITY DEFINER` helper, or a view missing `security_invoker=true` can leak. This is why `rls-tenant-audit` and `security-reviewer` sign-off are non-negotiable gates.
  - No native per-tenant resource governance (noisy-neighbor); per-tenant point-in-time restore requires `tenant_id`-filtered export, not a DB restore.
  - JWT-claim **freshness**: the custom access token hook runs at token issuance; tenant/role changes in `app_metadata` take effect only on token refresh/re-auth — design role changes to tolerate this (or force a refresh).
  - Committing every tenant-scoped table to carry `tenant_id` + RLS up front (the price of cheap reversibility).

- **Follow-up work (hand-off):**
  - **`security-reviewer`** — sign off on the auth-hook claim shape, every helper (`current_tenant_id()`/`auth_tenant_ids()`), and every RLS policy; own the `rls-tenant-audit` gate. **This decision and all derived tenancy/auth work are flagged for `security-reviewer`.**
  - **backend / `supabase-migrate`** — add `tenants`, `branches`, `tenant_members(tenant_id, profile_id, role)`; add `super_admin` role; add `tenant_id` (+ `branch_id` where relevant) to every operational table; index it **first** in composite indexes; convert the unique-active-session constraint to `(tenant_id, device_id) where status='active'`. Implement the Custom Access Token Hook injecting `current_tenant_id`/`tenant_ids` into `app_metadata`; implement the claim-reading helpers. Rewrite every policy to `AND` the tenant predicate with `WITH CHECK` on writes; wrap auth-fn calls in `(select ...)` for initPlan caching; index all policy columns. Guard + audit the super-admin / impersonation cross-tenant path (time-boxed, explicit, audited). Seed ≥2 tenants for isolation testing.
  - **`@ps/core`** — no DB-isolation logic leaks into core; core stays pure (money/time/pricing). DB and UI remain thin adapters that pass `tenant_id` through, never re-deriving tenant from client input.
  - **mobile / web** — never send a client-supplied `tenant_id` as the source of truth; rely on the signed claim. Handle token-refresh on role/tenant change. Super-admin impersonation UI must be explicit and audited.

- **Must verify (before this decision is "done"):**
  - `rls-tenant-audit`: prove tenant A cannot **read or write** tenant B's rows across **every** tenant-scoped table — for `select`, `insert`, `update`, `delete`, including child tables (gated via parent `EXISTS`) and views (`security_invoker=true`). Two seeded tenants minimum.
  - `WITH CHECK` proof: a write attempting to set `tenant_id` to another tenant is rejected (not silently scoped).
  - `SECURITY DEFINER` audit: every definer helper either filters by the trusted claim or is provably tenant-agnostic; no definer function returns cross-tenant rows.
  - JWT-claim trust: the tenant claim is in **signed `app_metadata`** (not `user_metadata`, not a request body/header); policies never trust client-supplied tenant identifiers.
  - Performance: confirm `tenant_id` indexes are used and policies use cached `(select auth.jwt())` initPlans (Supabase/MS-Learn perf guidance).
  - Super-admin path: cross-tenant access is time-boxed, explicit, and writes an `audit_log` row.
  - **Sign-off:** `security-reviewer` approves every RLS/auth change; the human project owner approves the Phase-2 gate.
