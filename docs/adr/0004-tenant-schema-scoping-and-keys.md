# ADR-0004: Tenant schema scoping — `branch_id` placement, `settings` keying, and `payment_method` enum

- **Status:** Proposed (tenancy/schema — **`security-reviewer` sign-off required** for the RLS implications before Accepted; human project owner approves at the Phase-2 gate)
- **Date:** 2026-06-23
- **Deciders:** architect (proposing) · backend · `security-reviewer` (sign-off — these choices shape every operational table's keys and policies) · human project owner
- **Builds on:** [ADR-0002 — Multi-tenant data-isolation model](0002-tenant-isolation-model-ratified.md) (Accepted) and [ADR-0003 — JWT-claim shape, freshness, impersonation](0003-auth-claim-and-impersonation-model.md) (Proposed). ADR-0002 fixed shared-DB + `tenant_id` + RLS with `tenant_id` leading every PK/composite index; ADR-0003 fixed the claim/impersonation model. This ADR fixes the **schema-shaping decisions ADR-0002 left to the architect** that block migration authoring (spec §6 Q5–Q7, §7 hand-off).

## Context

Phase 2 must author the multi-tenant schema before any migration lands. ADR-0002/-0003 settled isolation and auth; three schema details remain hard to reverse once `tenant_id`/`branch_id` are stamped onto every table, every PK/index is built, and every RLS policy is written against those columns:

1. **`branch_id` exactness (spec Q5).** `docs/reference/schema-and-rls.md` lists `branch_id` on "devices, shifts, sessions, orders, stock_movements…" with a trailing ellipsis. The exact set must be pinned: which operational tables are **branch-scoped** (carry `branch_id not null`) vs. **tenant-scoped** (a branch column would be wrong or premature) — specifically `rate_rules`, `products`, `debts`, `customers`, `settings`.
2. **`settings` keying (spec Q6).** The trial's `settings` is `key text primary key` (single-café global). Multi-tenant requires a composite key. Is there a need for **platform-global** settings (no tenant) alongside per-tenant settings?
3. **`payment_method` enum (spec Q7).** Trial `0001` enum is `cash|wallet|other`; the core reference and `docs/reference/core-api.md` list `cash|wallet|other|debt`. Add `debt` now or defer to the Phase-5 debts feature?

**Constraints (from `CLAUDE.md` §2/§3/§5, ADR-0002):** `tenant_id` is the leading column of every PK/composite index; RLS on every table with `WITH CHECK` on writes; the proven trial role pattern is preserved and merely narrowed by tenant (spec AC 31a); `@ps/core` domain enums must match the DB enum decision; money is integer piastres; forward-only migrations. **Forces in tension:** model the branch layer richly now (matches `CLAUDE.md` §1 hierarchy: Tenant → Branch → Devices/Staff/Sessions/…) vs. avoid premature `branch_id` on entities whose ownership is genuinely tenant-wide (which would force fake branch values and complicate cross-branch config); keep enum churn forward-only vs. avoid an unused value.

**Domain facts that drive the decision:**
- A **branch is a physical location**; devices, staff/shifts, live sessions, walk-in orders, stock, and the cash drawer are inherently **per-location**. A session physically happens at one branch; a shift is one person's drawer at one branch on one day.
- **Configuration that an owner sets for the business** (price lists / `rate_rules`, the product catalog / `products`) is, in the gaming-café domain, naturally **tenant-wide** with per-branch pricing being a *future* refinement, not a Phase-2 requirement. Forcing `branch_id not null` on these now would (a) require duplicating a rate card per branch and (b) break the "one catalog for the business" mental model.
- **Customer accounts and their debts** are a relationship with the **business**, not a single location — a customer can owe money incurred at any branch and pay at any branch. Tenant-scoped, with `branch_id` recorded *where the transaction happened* only on the operational child rows.

## Options considered

### Decision 1 — `branch_id` placement

#### Option 1A — Branch-scope only the physically-located operational tables; keep config & customer/debt tenant-scoped — **CHOSEN**
- **`branch_id uuid not null`** (FK → `branches`, with `(tenant_id, branch_id)` consistency) on: `devices`, `shifts`, `sessions`, `orders`, `stock_movements`. These are inherently per-location.
- **Tenant-scoped, no `branch_id`** on: `rate_rules`, `products`, `settings`, `customers`, `debts`, `debt_payments`. These are business-wide config or business-wide relationships.
- **Child tables inherit via parent, no own `branch_id`:** `session_segments` (via `sessions`), `order_items` (via `orders`). They carry `tenant_id` (leading key + cheap RLS) but reach branch through the parent.
- `audit_log` carries `tenant_id` (mandatory) and a **nullable** `branch_id` (stamped when the audited action is branch-located, null for tenant/platform-level actions).
- Pros: matches the domain exactly; no fake/duplicated branch values on business-wide config; the cash-and-physical surfaces (the parts that *must* reconcile per location) are branch-keyed; keeps Phase-2 small while leaving per-branch pricing as a clean future ADR (add `branch_id nullable` to `rate_rules`/`products` later = "branch override falls back to tenant default").
- Cons: per-branch price overrides and per-branch product availability need a later migration (acceptable — not a Phase-2 requirement and forward-only-friendly); cross-branch queries for sessions/orders must filter on `branch_id` explicitly (normal).
- Evidence: `CLAUDE.md` §1 (Tenant → Branch → Devices/Staff/Shifts/Sessions/Orders/Products/Stock — note Products/Stock sit under the branch *physically* but the **catalog** is a business asset); `docs/reference/schema-and-rls.md` §"Multi-tenant deltas" (branch_id on "devices, shifts, sessions, orders, stock_movements…"); Azure multitenant data guidance — model the tenant boundary as the hard isolation key and sub-scope (branch) as an ordinary FK: https://learn.microsoft.com/azure/architecture/guide/multitenant/considerations/tenancy-models

#### Option 1B — `branch_id not null` on every operational table (including `rate_rules`/`products`/`debts`)
- Pros: uniform; every operational row knows its branch; per-branch pricing/catalog "for free".
- Cons: forces a rate card and product row **per branch** from day one (duplication, drift, owner confusion); makes a customer/debt belong to one branch when the relationship is business-wide; over-models a need (per-branch pricing) the spec does not have; larger, noisier schema with no Phase-2 payoff. Rejected as premature.
- Evidence: YAGNI / premature-generalization risk; same Azure guidance treats sub-tenant granularity as optional.

#### Option 1C — `branch_id nullable` everywhere (null = "applies to whole tenant")
- Pros: one shape; null encodes "business-wide".
- Cons: nullable `branch_id` on `sessions`/`shifts`/`stock_movements` is wrong — a live session/drawer/stock movement *always* happens at a real location; nullability there invites un-located financial rows (a cash-reconciliation hazard). Mixing "null = all branches" semantics with "not-yet-set" is ambiguous and a footgun for `WITH CHECK`. Rejected for the operational tables; **nullable is correct only for `audit_log.branch_id`** (genuinely sometimes branch-less), which Option 1A already does.

### Decision 2 — `settings` keying & platform-global settings

#### Option 2A — Per-tenant `settings (tenant_id, key)` composite PK; platform-global config lives in a **separate** `platform_settings (key)` table — **CHOSEN**
- Tenant settings: `settings (tenant_id uuid not null, key text not null, value jsonb, primary key (tenant_id, key))` — `tenant_id` leading, normal tenant RLS (staff-read / owner-write, AND-ed with tenant). Seeds per tenant: `cafe_name`, `currency=EGP`, `timezone=Africa/Cairo`, `peak_windows`, `schema_version`.
- Platform-global settings (feature flags, platform schema version, default seeds): a **distinct** `platform_settings (key text primary key, value jsonb)` table with RLS that grants **read to authenticated, write to `super_admin` only** — no `tenant_id`, never reachable by the tenant claim path.
- Pros: clean separation of "a tenant's preference" vs. "a platform fact"; no nullable `tenant_id` sentinel inside one table (which would be an RLS hazard — a `tenant_id IS NULL` row visible cross-tenant); `(tenant_id, key)` keeps `tenant_id` leading per ADR-0002; the platform table has an explicit, auditable super-admin-only policy.
- Cons: two tables instead of one (trivial); platform settings need their own (simple) policy.
- Evidence: ADR-0002 ("`tenant_id` leading column of every PK"); `docs/reference/schema-and-rls.md` §settings (the trial's `key` PK becomes `(tenant_id, key)`); Supabase RLS guidance against nullable-tenant sentinel rows in shared tables: https://supabase.com/docs/guides/database/postgres/row-level-security

#### Option 2B — Single `settings (tenant_id, key)` with `tenant_id` nullable for platform rows
- Pros: one table.
- Cons: a `tenant_id IS NULL` row is a cross-tenant-visible sentinel — the RLS policy must special-case it, which is exactly the kind of "extra branch in a policy" ADR-0003 fought to eliminate; easy to leak or to write a too-broad `using`. Rejected.

### Decision 3 — `payment_method` enum — add `debt` now

#### Option 3A — Define the enum as `cash | wallet | other | debt` in Phase 2 — **CHOSEN**
- The DB enum and `@ps/core`'s `PaymentMethod` type both ship as `cash|wallet|other|debt` now, even though the debts *feature* (tables `debts`/`debt_payments` get `tenant_id` now; the summary math is Phase 5) is not wired into checkout until later.
- Pros: **Postgres `ALTER TYPE … ADD VALUE` cannot run inside a transaction block** and is awkward to do later in a clean forward-only migration; defining the full value set once avoids a fragile enum-extension migration; keeps `@ps/core`'s `PaymentMethod` (already `cash|wallet|other|debt` per `docs/reference/core-api.md`) in lockstep with the DB so there's no type drift; the value is inert until the debts feature uses it (no behavior change, no data written with it in Phase 2).
- Cons: an enum value exists before its feature (cosmetic; guarded by the fact that nothing writes it yet).
- Evidence: Postgres enum-extension constraint (no `ADD VALUE` in a txn; safer to declare upfront): https://www.postgresql.org/docs/current/sql-altertype.html ; `docs/reference/core-api.md` (`PaymentMethod cash|wallet|other|debt`).

#### Option 3B — Defer `debt` to the Phase-5 debts migration
- Pros: enum matches only what's used today.
- Cons: forces a later `ALTER TYPE ADD VALUE` (transaction-block caveat, ordering hazards) and a temporary mismatch between `@ps/core` (which already lists `debt`) and the DB. Rejected — the upfront declaration is strictly cheaper and lower-risk.

## Decision

1. **`branch_id` (Option 1A):** branch-scope exactly `devices`, `shifts`, `sessions`, `orders`, `stock_movements` (each `branch_id uuid not null`, FK → `branches`, consistent with `tenant_id`). Keep `rate_rules`, `products`, `settings`, `customers`, `debts`, `debt_payments` **tenant-scoped** (no `branch_id`). Children `session_segments`/`order_items` carry `tenant_id` and reach branch via their parent. `audit_log` carries `tenant_id` (not null) + `branch_id` (nullable). Per-branch pricing/catalog overrides are a deliberately deferred future ADR (add a nullable `branch_id` override later, falling back to the tenant default).
2. **`settings` (Option 2A):** `settings` is `(tenant_id, key)` composite PK with tenant RLS; a separate `platform_settings (key)` table holds platform-global config with super-admin-only write / authenticated read. No nullable-`tenant_id` sentinel rows.
3. **`payment_method` (Option 3A):** define `payment_method` as `cash | wallet | other | debt` in Phase 2; the `debt` value is inert until the Phase-5 debts feature consumes it; `@ps/core`'s `PaymentMethod` ships identically.

**Single most important reason:** scope the *hard isolation key* (`tenant_id`) onto everything while scoping the *physical sub-key* (`branch_id`) only where the domain makes a row inherently location-bound — this gives correct branch-level cash/stock reconciliation without forcing fake branch values onto business-wide config, and it keeps every per-tenant RLS policy a single scalar equality (no nullable-branch or nullable-tenant special cases to leak through).

**Explicitly NOT doing now:** per-branch `rate_rules`/`products` overrides; a nullable-`tenant_id` settings sentinel; deferring the `debt` enum value; any branch-level RLS isolation (branch is an *ordinary FK filter within a tenant*, not a second isolation boundary — `security-reviewer` audits that policies still isolate by `tenant_id`, and branch filtering is application-level/manager-scope, consistent with the trial's `manager_id = auth.uid()` own-row pattern).

## Consequences

- **Becomes easy:**
  - Per-branch cash drawer (`shifts`), live floor (`devices`/`sessions`), walk-in orders, and stock movements all reconcile per location out of the box.
  - One business catalog/rate card and one customer/debt ledger per tenant — no duplication or cross-branch drift.
  - Every per-tenant RLS policy stays a single scalar equality on `tenant_id` (no nullable-branch/tenant branches), preserving ADR-0003's "one isolation surface" property.
  - Adding per-branch price/catalog overrides later is a clean forward-only migration (nullable `branch_id` override + COALESCE-to-tenant-default resolution in `@ps/core`).
- **Becomes hard / accepted risk:**
  - Per-branch pricing/catalog is not available until a future ADR/migration (acceptable; not a Phase-2 need).
  - `branch_id` is **not** an isolation boundary — a user with the tenant claim can, at the RLS level, read all branches of their tenant; *branch-level* restriction (e.g., a staffer only sees their branch) is enforced by the **own-row/manager-scope** predicates (and future branch-membership), not by RLS tenant isolation. `security-reviewer` must confirm branch is never mistaken for an isolation key.
  - `(tenant_id, branch_id)` FK consistency (a row's `branch_id` must belong to its `tenant_id`) is enforced by a **composite FK** `(tenant_id, branch_id) references branches (tenant_id, id)` — branches gets a `unique (tenant_id, id)` to support it.
- **Follow-up work (hand-off):**
  - **backend / `supabase-migrate`:** stamp `branch_id not null` only on the five branch-scoped tables with the composite FK; create `platform_settings` with its super-admin-only policy; define the `payment_method` enum with `debt`; keep `tenant_id` leading in every PK/index.
  - **`@ps/core`:** ship `PaymentMethod = cash|wallet|other|debt`; put `branch_id` on the entity types for the five branch-scoped operational entities and `tenant_id` on all; no branch-resolution logic needed in Phase 2.
  - **`security-reviewer` (sign-off required):** confirm tenant isolation does not depend on `branch_id`; audit `platform_settings` policy (no tenant claim path reaches it; super-admin-only write); confirm the composite-FK consistency and that child-table RLS still reaches the right tenant.
- **Must verify (before Accepted):**
  - `rls-tenant-audit`: A↮B isolation holds on all branch-scoped tables regardless of `branch_id`; a tenant-A user cannot read tenant-B rows even with a guessed `branch_id`.
  - `platform_settings`: a tenant (non-super-admin) user cannot write it; the table has no `tenant_id` and is not reachable via `current_tenant_id()`.
  - Composite FK rejects a row whose `(tenant_id, branch_id)` pair does not exist in `branches`.
  - **Env caveat (this machine):** authored + **statically audited only**; live execution DEFERRED to CI/hosted Supabase. `security-reviewer`'s verdict on this machine is **"static pass — pending live verification."**
