# Spec — Phase 2: Tenant Foundation (`@ps/core` + multi-tenant backend)

- **Phase:** 2 (Roadmap `docs/ROADMAP.md`) · **Surfaces:** `packages/core`, `supabase`
- **Owner:** product-manager · **Status:** ready for design/build
- **Decision anchor:** [ADR-0002 — Multi-tenant data-isolation model](../adr/0002-tenant-isolation-model-ratified.md) (ACCEPTED)
- **References:** `docs/reference/core-api.md`, `docs/reference/schema-and-rls.md`, `CLAUDE.md` §2/§3/§4/§5/§7
- **Trial (learning input only — never import/copy):** `D:\K3\Pochinki` (`src/lib/*`, `src/features/*`, `supabase/migrations/0001..0011`)

---

## 1. Problem & goal

PS-Managment must serve **many independent café businesses on one platform** with airtight per-tenant data isolation, before any feature work lands. Phase 2 delivers the two non-UI foundations everything else builds on:

1. **`@ps/core`** — the pure, framework-free logic library (money in integer piastres, Africa/Cairo time, the inventory ledger, IDs, and the shared multi-tenant domain types). This is the single source of truth for money/time/inventory math, unit-tested to >90% so later phases inherit correctness for free.
2. **The multi-tenant Supabase foundation** — schema (`tenants`, `branches`, `tenant_members`, `super_admin` role, `profiles`), `tenant_id`/`branch_id` on every operational entity carried over from the trial's entity model, RLS on every table with `WITH CHECK` on writes, a signed `app_metadata` JWT tenant claim via a Custom Access Token Hook, super-admin tenant provisioning + a time-boxed audited impersonation path, seed data with ≥2 tenants, and the `rls-tenant-audit` isolation suite.

**The win:** a correct, tenancy-safe substrate where tenant A can never read or write tenant B's rows, and where all money/time/inventory math is centralized, pure, and proven. **Roles touched:** `super_admin` (new, platform), `owner` (tenant), `manager`/`staff` (branch).

**Hard environment constraint (this build machine):** node + npm reachable; **no Docker, no local Supabase CLI**. Therefore `@ps/core` is built and verified **for real** (tsc + jest). The backend is **fully authored** (migrations, RLS, hook, seed, isolation suite) and verified by a **static audit only**. Live DB verification (`supabase db reset` + executing the isolation suite against Postgres) is **DEFERRED to CI / a hosted Supabase project** and must be called out in the gate report. A static pass is "pending live verification," not full sign-off.

---

## 2. In scope / out of scope

### In scope — CORE (`packages/core`)
- **money** (integer piastres): `egpToPiastres`, `piastresToEgp`, `formatEgp`, `sumPiastres`, `toArabicDigits`.
- **time** (Africa/Cairo behind a named constant `CAFE_TZ`): `nowIso`, `dayTypeAt` (Fri+Sat = weekend), `isWithinWindow` (end-exclusive, midnight-wrap, null bounds = all-day), `elapsedMinutes`/`elapsedSeconds` (clamp ≥ 0), `formatClock`.
- **id**: `uuidv4` (client-generated, for idempotent writes).
- **inventory ledger**: `computeLevels` (Σ delta; may go negative), `stockStatus`, `offsettingVoids`, `inventoryValue`, plus `isTracked` and the `LOW_STOCK_DEFAULT`/`StockStatus` constants.
- **shared domain TYPES**, including multi-tenant additions: `super_admin` in `Role`; `tenant_id`/`branch_id` on entity types; `Tenant`, `Branch`, `TenantMember`; and the existing domain enums (`DeviceStatus`, `PlayMode`, `BillingMode`, `DayTypeRule`, `SessionStatus`, `PaymentMethod`, `OrderStatus`, `StockReason`, `ShiftStatus`, `PermissionKey`).
- **Money/time helpers the Phase-4 pricing engine will depend on** (the inputs it consumes), so Phase 4 needs no core API churn.
- Jest tests with **>90% line coverage** on money/time/inventory.

### In scope — BACKEND (`supabase`)
- Forward-only **numbered migrations** for the multi-tenant foundation.
- New tables: `tenants`, `branches`, `tenant_members(tenant_id, profile_id, role)`; add `super_admin` to the role enum; `profiles` + `handle_new_user` trigger.
- Add `tenant_id` (+ `branch_id` where relevant) to every trial operational entity: `devices`, `rate_rules`, `products`, `settings`, `shifts`, `sessions`, `session_segments`, `orders`, `order_items`, `stock_movements`, `audit_log`, `debts`, `debt_payments`, `customers`.
- `tenant_id` is the **LEADING column** of every PK/composite index; convert unique-active-session to `(tenant_id, device_id) where status='active'`.
- **RLS ENABLED on every `public` table**, with `WITH CHECK` on every write policy.
- `current_tenant_id()` reading `auth.jwt() -> 'app_metadata' ->> 'tenant_id'` (and `auth_tenant_ids()` for multi-tenant membership); auth-fn calls wrapped in `(select …)` for initPlan caching.
- **Custom Access Token Hook** (edge function) injecting the tenant claim into `app_metadata`.
- **Super-admin** tenant provisioning + a **time-boxed, audited impersonation path**.
- `seed.sql` with **≥2 tenants** (+ branches, devices, rate_rules, products).
- The **`rls-tenant-audit` isolation suite** proving A↮B isolation across **every** table (select/insert/update/delete; child tables via parent `EXISTS`; views `security_invoker=true`).

### Out of scope (deferred — say why)
- **Full pricing engine** (`resolveRule`, `computeOpenMeterCost`, `computePrepaidCost`, `computeFixedMatchCost`, segment math, `computeGrandTotal`) → **Phase 4**. Phase 2 ships only the money/time/types it depends on.
- **Shifts/debts summary logic** (`summarizeShift`, `breakdownPayments`, `paidByDebt`, …) → **Phase 5** (the tables get `tenant_id` now; the math is later).
- **Any UI** (mobile/web), realtime, offline outbox → Phases 3/8.
- **Building the Option-D "promote a tenant to isolated storage" pipeline** — explicitly deferred per ADR-0002 (governance: requires a new ADR + concrete trigger). Phase 2 only keeps it cheap by making `tenant_id` the leading key.
- **Live DB execution** of migrations/isolation suite — deferred to CI/hosted Supabase (env constraint above).
- **SaaS billing / Stripe** → Phase 9.

---

## 3. User stories

- **As a `super_admin`**, I want to provision a new tenant (with its first owner) and suspend a tenant, so that I can onboard and manage café businesses without touching SQL by hand.
- **As a `super_admin`**, I want a time-boxed, audited impersonation path into a tenant, so that I can support a customer without silent, unaccountable cross-tenant access.
- **As an `owner`**, I want my tenant's data (devices, rules, products, sessions, money) to be invisible and unwritable to any other tenant, so that I can trust the platform with my cash business.
- **As an `owner`/`manager`/`staff`**, I want my tenant identity resolved from a trusted signed token claim, so that no client request can impersonate another tenant.
- **As a developer (later phases)**, I want money/time/inventory math centralized in a pure, tested `@ps/core`, so that I never re-implement currency rounding or Cairo day-type logic and never leak floats or `Date.now()` into cost math.
- **As `security-reviewer`**, I want every table to have RLS + `WITH CHECK` and an isolation suite proving A↮B, so that I can gate tenancy/auth changes adversarially.

---

## 4. Acceptance criteria (numbered, testable — Given/When/Then)

### A. `@ps/core` — money (piastres)
1. **Given** `egpToPiastres(12.5)`, **when** evaluated, **then** it returns the integer `1250` and never a float; `egpToPiastres(0.1)` returns `10`; rounding uses `Math.round` with no accumulated drift across a sequence.
2. **Given** `piastresToEgp(1250)`, **when** evaluated, **then** it returns `12.5`, and `piastresToEgp(egpToPiastres(x))` round-trips integer-EGP values exactly.
3. **Given** `formatEgp(125000)`, **when** evaluated, **then** it returns a string containing the Arabic thousands separator `٬`, the currency suffix `ج.م`, omits a fractional part for whole pounds, and renders negatives with a sign (e.g. `formatEgp(-500)` is negative).
4. **Given** `sumPiastres([10, 20, 30])`, **when** evaluated, **then** it returns `60` as an integer; `sumPiastres([])` returns `0`.
5. **Given** `toArabicDigits('12345')`, **when** evaluated, **then** it returns `'١٢٣٤٥'` and leaves non-digit characters unchanged.

### B. `@ps/core` — time (Africa/Cairo)
6. **Given** an ISO timestamp that is a Friday or Saturday **in `Africa/Cairo`**, **when** `dayTypeAt(iso)` is called, **then** it returns `'weekday'` only for Sun–Thu and `'weekend'` for Fri/Sat — computed in `CAFE_TZ`, not the host timezone (verified by a test that fixes a known UTC instant straddling Cairo midnight).
7. **Given** a window `start='18:00'`, `end='02:00'` (wraps past midnight), **when** `isWithinWindow(iso, start, end)` is tested at `01:00` Cairo, **then** it returns `true`; at `02:00` it returns `false` (end-exclusive); at `17:59` it returns `false`.
8. **Given** `isWithinWindow(iso, null, null)`, **when** evaluated for any `iso`, **then** it returns `true` (null bounds = all-day).
9. **Given** `start='09:00'`, `end='17:00'` (no wrap), **when** tested at `09:00` it returns `true` and at `17:00` it returns `false` (end-exclusive).
10. **Given** `elapsedMinutes(startIso, endIso)` where `end` is **before** `start`, **when** evaluated, **then** it returns `0` (clamped ≥ 0); the same clamp holds for `elapsedSeconds`.
11. **Given** `elapsedSeconds` of `3661`, **when** passed to `formatClock`, **then** it returns `'01:01:01'`.
12. **Given** `nowIso()`, **when** called, **then** it returns a valid UTC ISO-8601 string; **and** no function in the `time` or `pricing-relevant` modules reads the system clock internally for any computation that takes an `at_iso`/timestamp argument (verified by code inspection / guard: no `Date.now()` inside cost-relevant math).

### C. `@ps/core` — id & inventory ledger
13. **Given** `uuidv4()`, **when** called twice, **then** it returns two distinct strings matching the RFC-4122 v4 format.
14. **Given** movements `[{product:'p', delta:+10}, {product:'p', delta:-3}]`, **when** `computeLevels` runs, **then** `levels['p'] === 7`; **and given** a net-negative set, the level **is allowed to go negative** (oversell signal), not clamped.
15. **Given** on-hand `0`, **when** `stockStatus(0)` runs, **then** it returns `'out'`; `stockStatus(5, 5)` returns `'low'` (inclusive); `stockStatus(6, 5)` returns `'ok'`; an untracked product returns `'untracked'`.
16. **Given** recorded sales, **when** `offsettingVoids(sales)` runs, **then** each returned entry is the exact negation of the corresponding sale delta (sum of sale + void = 0 per product).
17. **Given** products with `cost` and computed `levels`, **when** `inventoryValue` runs, **then** it sums `onHand × cost` only for tracked, costed, positive-stock products and ignores untracked/uncosted/negative entries.

### D. `@ps/core` — types & purity
18. **Given** the `Role` type, **when** inspected, **then** it includes `super_admin`, `owner`, `manager`, `staff`; and `Tenant`, `Branch`, `TenantMember` types exist with `tenant_id`/`branch_id` present on the operational entity types.
19. **Given** the entire `@ps/core` package, **when** scanned, **then** there are **zero** imports from React, React Native, Expo, Next.js, or Supabase (purity guard), and the package compiles under `tsc --noEmit` with `strict` + `noUncheckedIndexedAccess`.
20. **Given** the jest suite for money/time/inventory, **when** run with coverage, **then** **line coverage > 90%** on those modules and **all tests pass**.

### E. Backend — schema & migrations
21. **Given** the migrations applied (live, in CI), **when** the schema is inspected, **then** tables `tenants`, `branches`, `tenant_members(tenant_id, profile_id, role)`, and `profiles` exist, and the role enum includes `super_admin`.
22. **Given** every operational table (`devices`, `rate_rules`, `products`, `settings`, `shifts`, `sessions`, `session_segments`, `orders`, `order_items`, `stock_movements`, `audit_log`, `debts`, `debt_payments`, `customers`), **when** inspected, **then** each carries `tenant_id uuid not null` (and `branch_id` where relevant per the schema-and-rls reference), and `tenant_id` is the **leading column** of its PK/composite indexes.
23. **Given** the active-session uniqueness rule, **when** inspected, **then** it is a partial unique index on `(tenant_id, device_id) where status='active'` (not the trial's `(device_id)`).
24. **Given** migrations are forward-only and numbered, **when** the migrations directory is listed, **then** files are sequentially numbered with no edits to previously-shipped migrations (append-only).
25. **Given** a new auth user is created, **when** `handle_new_user` fires, **then** a `profiles` row is created idempotently (`on conflict do nothing`).

### F. Backend — RLS & tenant claim
26. **Given** every table in `public`, **when** the migrations are statically scanned, **then** each has `enable row level security` **and** at least one policy (no table ships without a policy).
27. **Given** every write policy (`insert`/`update`/`all`), **when** scanned, **then** it has a `WITH CHECK` clause that constrains `tenant_id` to the caller's tenant (a write cannot set `tenant_id` to another tenant).
28. **Given** `current_tenant_id()`, **when** inspected, **then** it reads `auth.jwt() -> 'app_metadata' ->> 'tenant_id'` (signed claim) and **never** a client-supplied body/header or a hot-path `profiles` lookup; `auth_tenant_ids()` resolves membership for multi-tenant users.
29. **Given** any view in `public`, **when** inspected, **then** it is created with `security_invoker = true`.
30. **Given** any `SECURITY DEFINER` helper, **when** audited, **then** it either filters by the trusted claim or is provably tenant-agnostic; no definer function returns cross-tenant rows.
31. **Given** the Custom Access Token Hook (edge function), **when** a token is issued, **then** it injects `tenant_id`/`tenant_ids` into `app_metadata` (signed, non-user-editable), sourced from `tenant_members` — not from `user_metadata` or request input.

31a. **Given** the generalized policies, **when** statically scanned, **then** every config table (`devices`/`rate_rules`/`products`/`settings`) keeps a staff-read + owner-write split, every transactional table keeps an own-row (`manager_id = auth.uid()`) OR owner predicate, `stock_movements` still blocks `reason='adjust'` for non-owners, and each such predicate is **`AND`-ed** with `tenant_id = current_tenant_id()` — i.e. the proven trial role logic survives the tenancy rewrite (it is narrowed by tenant, never replaced).

### G. Backend — isolation suite (`rls-tenant-audit`)
32. **Given** ≥2 seeded tenants (A and B) with branches/devices/rate_rules/products, **when** the isolation suite runs as a tenant-A user, **then** **SELECT** of any tenant-B row across **every** tenant-scoped table returns **zero rows**.
33. **Given** a tenant-A user, **when** they attempt **INSERT** of a row with `tenant_id = B` (or no tenant), **then** the write is **rejected** by `WITH CHECK` (not silently re-scoped).
34. **Given** a tenant-A user, **when** they attempt **UPDATE** or **DELETE** of a tenant-B row, **then** **zero rows** are affected.
35. **Given** child tables (`session_segments`, `order_items`, `debt_payments`), **when** accessed cross-tenant, **then** access is blocked via the parent `EXISTS` predicate (a tenant-A user cannot reach tenant-B children through any parent).
36. **Given** the env constraint (no Docker/CLI on the build machine), **when** the gate report is produced, **then** AC 32–35 are marked **authored + statically audited; live execution DEFERRED to CI/hosted Supabase**, and the static audit explicitly confirms: every table has a policy (AC 26), `WITH CHECK` on writes (AC 27), views `security_invoker` (AC 29), and no `SECURITY DEFINER` cross-tenant leak (AC 30).

### H. Super-admin & impersonation
37. **Given** a `super_admin`, **when** they provision a tenant, **then** a `tenants` row (and first `owner` via `tenant_members`) is created, and the action writes an `audit_log` row (actor, tenant, timestamp).
38. **Given** a `super_admin` impersonates a tenant, **when** the path is exercised, **then** access is **explicit and time-boxed** (bounded validity) and writes an `audit_log` row; there is **no silent** cross-tenant read path.
39. **Given** the `audit_log` table, **when** inspected, **then** it carries `tenant_id` and records actor/action/timestamp/amount for money-affecting and cross-tenant actions per `CLAUDE.md` §2.7.

### I. Verification gates
40. **Given** the completed work, **when** `ps-verify` runs, **then** `tsc --noEmit` passes with **0 errors** across `@ps/core`; `jest` passes all `@ps/core` tests; `pricing-engine-guard` confirms no floats/`Date.now()` in cost-relevant math and `@ps/core` purity.
41. **Given** backend changes, **when** the gate report is assembled, **then** `security-reviewer` records an **explicit verdict**; with only a static pass available on this machine, the verdict is **"pending live verification,"** not full sign-off, and the deferred live items are enumerated.

---

## 5. Domain notes (links to `CLAUDE.md`)

- **Money is integer piastres** (`CLAUDE.md` §2.1, §4) — AC 1–5. All money helpers live in `@ps/core`; no inline currency math.
- **Timers/time derive from timestamps; `Africa/Cairo`; Egypt weekend = Fri/Sat** (`§2.2, §2.3, §4`) — AC 6–12. `CAFE_TZ` is a named constant for later multi-tz.
- **`@ps/core` is pure; no `Date.now()` in cost math** (`§2.4, §4`) — AC 12, 19.
- **RLS on every table; trusted `app_metadata` JWT claim; `WITH CHECK` on writes; isolation tests mandatory** (`§5`) — AC 26–36, anchored to [ADR-0002](../adr/0002-tenant-isolation-model-ratified.md).
- **`tenant_id` leading column of every PK/composite index** (ADR-0002 "grafted reversibility") — AC 22.
- **Preserve the trial's proven role pattern under tenancy** (learning input `Pochinki/supabase/migrations/0002_rls.sql`): config tables (`devices`/`rate_rules`/`products`/`settings`) = staff-read + owner-write; transactional tables (`shifts`/`sessions`/`orders`/`stock_movements`/`debts`/…) = own-row (`manager_id = auth.uid()`) OR owner-sees-all; child tables (`session_segments`/`order_items`/`debt_payments`) gate via parent `EXISTS`; `stock_movements` `reason='adjust'` is owner-only; `audit_log` = owner-read / staff-insert. Every one of these predicates is **`AND`-ed with `tenant_id = current_tenant_id()`** and `WITH CHECK` on writes (do not drop the proven role logic when adding the tenant predicate) — AC 26–35.
- **Auditable money & cross-tenant actions** (`§2.7`) — AC 37–39.
- **Idempotent writes; client UUIDs** (`§2.8`) — AC 13, 25.
- **Arabic-first/RTL numerals** (`§2.6`) — AC 3, 5 (display via `toArabicDigits`/`formatEgp`).
- **Definition of done = `ps-verify` + acceptance criteria + `security-reviewer` sign-off** (`§7, §8`) — AC 40–41.

---

## 6. Open questions

1. **Multi-tenant membership shape:** Does an `owner` belong to exactly one tenant, or can one user own/staff multiple tenants? `tenant_members` supports many-to-many; confirm whether the JWT carries a single `tenant_id` (active) plus a `tenant_ids` array, and how the "active tenant" is selected on login. → **architect / security-reviewer** (claim shape).
2. **Impersonation mechanics:** Is impersonation implemented as a short-lived minted token with an injected target `tenant_id` + `impersonator_id` claim, or as a `super_admin` RLS bypass predicate? The time-box duration and audit fields need a concrete decision. → **architect ADR + security-reviewer**.
3. **JWT-claim freshness on role/tenant change:** ADR-0002 notes the hook runs at token issuance. What is the policy when an owner adds/removes a staff member or changes a role mid-session — forced refresh, short token TTL, or accept eventual consistency? → **architect / security-reviewer**.
4. **`super_admin` placement vs `tenant_members`:** Is `super_admin` a platform-level flag on `profiles` (no tenant), or a special row? It must not be tenant-scoped. → **architect**.
5. **`branch_id` exactness:** The reference lists `branch_id` on "devices, shifts, sessions, orders, stock_movements…". Confirm the exact set (e.g. are `rate_rules`/`products`/`debts` branch-scoped or tenant-scoped?) before migration authoring. → **architect** (with backend).
6. **`settings` key scoping:** Trial `settings` is `key PK`. Multi-tenant requires `(tenant_id, key)` PK — confirm composite-key shape and whether any settings are platform-global. → **backend / architect**.
7. **`payment_method` enum:** Trial `0001` enum is `cash|wallet|other`; reference/core lists `cash|wallet|other|debt`. Confirm whether `debt` is added to the enum in Phase 2 or deferred with the debts feature. → **architect** (low risk; types in core should match the DB enum decision).

---

## 7. Hand-off

### architect must decide (ADRs / design notes)
- Open questions 1–7 above — especially **impersonation mechanics** (Q2), **JWT claim shape & freshness** (Q1, Q3), **`super_admin` placement** (Q4), and the **exact `branch_id` set** (Q5). These block migration authoring.
- Confirm `tenant_members` cardinality and the "active tenant" selection contract for the auth hook.

### ux-designer must design
- **Nothing in Phase 2** (no UI surface). Note for Phase 3/7: the super-admin provisioning + impersonation flows will need UX, and impersonation must be visually unmistakable + audited.

### security-reviewer gates (sign-off required)
- The auth-hook claim shape; `current_tenant_id()` / `auth_tenant_ids()`; **every** RLS policy and `WITH CHECK`; the `SECURITY DEFINER` audit; views `security_invoker`; the impersonation time-box + audit.
- Owns the `rls-tenant-audit` gate. On this machine the verdict is **"static pass — pending live verification"**; full sign-off requires CI/hosted execution of AC 32–35.

### QA gates on (the testable success checks)
- **Live-now (this machine):** AC **1–20, 40** (`@ps/core` tsc + jest >90% + `pricing-engine-guard`).
- **Static audit now / live in CI:** AC **21–39, 41** — authored + grep/static-verified on this machine; **DEFERRED** to CI/hosted Supabase for `supabase db reset` + isolation-suite execution. The gate report must list every deferred item explicitly and not claim a full backend pass.
