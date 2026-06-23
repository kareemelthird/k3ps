# Technical Design — Phase 2: Tenant Foundation (`@ps/core` + multi-tenant Supabase)

- **Author:** architect · **Date:** 2026-06-23 · **Status:** for build (after ADR-0003/0004 human gate)
- **Spec:** `docs/specs/phase-2-tenant-foundation.md`
- **Decision anchors:** [ADR-0002](../adr/0002-tenant-isolation-model-ratified.md) (Accepted — shared-DB + `tenant_id` + RLS) · [ADR-0003](../adr/0003-auth-claim-and-impersonation-model.md) (Proposed — scalar `tenant_id` claim, freshness, impersonation) · [ADR-0004](../adr/0004-tenant-schema-scoping-and-keys.md) (Proposed — `branch_id` set, `settings` keying, `payment_method` enum)
- **References:** `docs/reference/core-api.md`, `docs/reference/schema-and-rls.md`, `CLAUDE.md` §2/§3/§4/§5
- **Trial:** `D:\K3\Pochinki` — learning input only, never imported/copied.

> **`security-reviewer` sign-off is REQUIRED** for every item in §4 (claim helper, hook, RLS, `SECURITY DEFINER` audit, views, impersonation). On this build machine (no Docker/CLI) the backend is **authored + statically audited only**; live execution (`supabase db reset` + `rls-tenant-audit`) is DEFERRED to CI/hosted Supabase. The mandatory isolation tests are listed in §8.

---

## 1. Decisions this design forces (reversible vs. hard)

**Hard / hard-to-reverse → resolved by ADR (human-approved gate):**
- Isolation model → ADR-0002 (shared-DB + RLS).
- Claim shape, freshness, impersonation → ADR-0003 (scalar `tenant_id` + `roles` + `is_super_admin`; short TTL + hook-on-refresh; minted impersonation token, no RLS bypass).
- `branch_id` set, `settings` keying, `payment_method` enum → ADR-0004.

**Reversible detail → decided inline here:** exact column types, index list, helper-function bodies, edge-function file layout, `@ps/core` module split, migration numbering. None of these need an ADR.

---

## 2. `@ps/core` design (pure, framework-free)

### 2.1 Package boundary (hard rule, `CLAUDE.md` §2.4)
`@ps/core` imports **nothing** from React / React Native / Expo / Next.js / Supabase. Pure TypeScript, runs under Node + Jest. No `Date.now()` inside any cost-relevant function — timestamps are arguments. `tsconfig`: `strict` + `noUncheckedIndexedAccess`. A `purity` guard test (grep over `src/`) fails the build on a forbidden import; `pricing-engine-guard` fails on `Date.now()`/float-money in cost math.

### 2.2 Module layout (`packages/core/src/`)
```
src/
  money/index.ts      egpToPiastres, piastresToEgp, formatEgp, sumPiastres, toArabicDigits
  time/index.ts       CAFE_TZ, nowIso, dayTypeAt, isWithinWindow, elapsedMinutes,
                      elapsedSeconds, formatClock, localHm, localHour
  id/index.ts         uuidv4
  inventory/index.ts  LOW_STOCK_DEFAULT, StockStatus, isTracked, computeLevels,
                      stockStatus, offsettingVoids, inventoryValue
  types/index.ts      Role, enums, Tenant, Branch, TenantMember, operational entity types
  index.ts            re-exports the public surface
```
Deferred (NOT in Phase 2, per spec out-of-scope): `pricing/*` → Phase 4; `shifts/*`, `debts/*` → Phase 5. Phase 2 ships only the money/time/inventory/id/types those phases will consume, so they need no core API churn.

### 2.3 Function contracts (the AC-pinned behavior)
- **money** — `egpToPiastres(egp): number` = `Math.round(egp*100)` (integer, no drift); `piastresToEgp(p)` = `p/100`, exact round-trip for integer EGP; `formatEgp(p, withSuffix=true)` uses `٬` thousands sep + `ج.م` suffix, omits `.00` for whole pounds, signs negatives; `sumPiastres([])=0`; `toArabicDigits` maps `0-9`→`٠-٩`, leaves other chars intact. (AC 1–5)
- **time** — `CAFE_TZ='Africa/Cairo'`; `dayTypeAt(iso)` returns `weekend` for Fri/Sat **in `CAFE_TZ`** (dayjs + tz/utc plugins), not host TZ; `isWithinWindow(iso,start,end)` is `[start,end)` end-exclusive, wraps past midnight when `start>end`, `null` bounds = all-day; `elapsedMinutes/Seconds` clamp `<0`→`0`; `formatClock(3661)='01:01:01'`; `nowIso()` valid UTC ISO; no cost-relevant fn reads the clock internally. (AC 6–12)
- **id** — `uuidv4()` returns distinct RFC-4122 v4 strings (crypto-backed). (AC 13)
- **inventory** — `computeLevels` = Σ delta per product, **may go negative** (oversell signal, not clamped); `stockStatus`: `<=0`→`out`, `<=low` (default 5, inclusive)→`low`, else `ok`, untracked→`untracked`; `offsettingVoids` exact negation per sale (sale+void=0); `inventoryValue` sums `onHand×cost` only for tracked + costed + positive. (AC 14–17)

### 2.4 Types (the multi-tenant additions)
```ts
type Role = 'super_admin' | 'owner' | 'manager' | 'staff'   // super_admin NEW (platform)
type PaymentMethod = 'cash' | 'wallet' | 'other' | 'debt'   // 'debt' per ADR-0004
interface Tenant      { id: string; name: string; status: 'active'|'suspended'; created_at: string }
interface Branch      { id: string; tenant_id: string; name: string; is_active: boolean }
interface TenantMember{ tenant_id: string; profile_id: string; role: Role; is_active: boolean }
```
Operational entity types carry `tenant_id: string` on **all**, and `branch_id: string` on the five branch-scoped entities (Device, Shift, Session, Order, StockMovement — ADR-0004). Enums match the DB enums exactly (`DeviceStatus`, `PlayMode`, `BillingMode`, `DayTypeRule`, `SessionStatus`, `OrderStatus`, `StockReason`, `ShiftStatus`, `PermissionKey`). (AC 18)

### 2.5 `@ps/core` does NOT contain
Any tenant-resolution / claim / RLS / Supabase logic. The DB enforces isolation; core stays a pure math/types library. (ADR-0002 Consequences.)

---

## 3. Data model (multi-tenant schema)

> Money = integer piastres. Times = `timestamptz` (UTC). All tables: `created_at`/`updated_at` + `set_updated_at()` trigger. `tenant_id` is the **leading column** of every PK/composite index (ADR-0002). UUID PKs are client-generatable for idempotent writes (`CLAUDE.md` §2.8).

### 3.1 New tenancy tables
| Table | Key columns | Notes |
|---|---|---|
| `tenants` | `id uuid pk`, `name text`, `status enum('active','suspended') default 'active'` | The café business. `status` gates access (ADR-0003 freshness). |
| `branches` | `id uuid pk`, `tenant_id uuid not null fk→tenants`, `name`, `is_active bool`, **`unique (tenant_id, id)`** | Physical location. The unique key backs the composite FK from branch-scoped tables. |
| `profiles` | `id uuid pk = auth.users.id`, `full_name`, `phone?`, **`is_platform_admin bool default false`**, `is_active bool` | **Cross-tenant**, NOT tenant-scoped. `is_platform_admin` → `super_admin` (ADR-0003 Option 3A). Role removed from `profiles` — role now lives per-tenant in `tenant_members`. |
| `tenant_members` | `tenant_id uuid not null fk→tenants`, `profile_id uuid not null fk→profiles`, `role enum('owner','manager','staff')`, `is_active bool default true`, **pk (tenant_id, profile_id)** | Many-to-many membership; the auth hook reads this to stamp the claim. `is_active` enforced in policy (ADR-0003 freshness). |
| `platform_settings` | `key text pk`, `value jsonb` | Platform-global config; super-admin-write / authenticated-read (ADR-0004). No `tenant_id`. |

Role enum: **DB enum `user_role` = `super_admin|owner|manager|staff`** (AC 21 requires `super_admin` in the enum). `super_admin` is represented operationally by `profiles.is_platform_admin` (a platform flag, never a `tenant_members` row — ADR-0003), but the enum value exists for completeness/typing.

### 3.2 Operational tables — tenant/branch scoping (ADR-0004)
| Table | `tenant_id` | `branch_id` | Leading PK/index | Special |
|---|---|---|---|---|
| `devices` | not null | **not null** | `(tenant_id, id)` | composite FK `(tenant_id, branch_id)`→branches |
| `rate_rules` | not null | — (tenant-scoped) | `(tenant_id, id)` | index `(tenant_id, device_type, play_mode, billing_mode, day_type, priority)` |
| `products` | not null | — (tenant-scoped) | `(tenant_id, id)` | |
| `settings` | not null | — | **pk `(tenant_id, key)`** | per-tenant config |
| `shifts` | not null | **not null** | `(tenant_id, id)` | `manager_id` (own-row) |
| `sessions` | not null | **not null** | `(tenant_id, id)` | **partial unique `(tenant_id, device_id) where status='active'`** (AC 23) |
| `session_segments` | not null | — (via session) | `(tenant_id, id)` | parent `sessions` (cascade) |
| `orders` | not null | **not null** | `(tenant_id, id)` | `session_id?` (null=walk-in) |
| `order_items` | not null | — (via order) | `(tenant_id, id)` | parent `orders` (cascade) |
| `stock_movements` | not null | **not null** | `(tenant_id, id)` | `reason enum`; `reason='adjust'` owner-only (AC 31a) |
| `customers` | not null | — (tenant-scoped) | `(tenant_id, id)` | business-wide relationship |
| `debts` | not null | — (tenant-scoped) | `(tenant_id, id)` | `customer_id?`, `session_id?` |
| `debt_payments` | not null | — (via debt) | `(tenant_id, id)` | parent `debts` (cascade) |
| `audit_log` | not null | **nullable** | `(tenant_id, id)` | actor/action/timestamp/amount; `branch_id` null for tenant/platform actions |

Indexes: every FK column and every RLS-policy column is indexed (ADR-0002 perf note), `tenant_id` always leading. Active-session uniqueness moves from the trial's `(device_id)` to `(tenant_id, device_id) where status='active'`.

### 3.3 Composite-FK consistency
Branch-scoped tables use `foreign key (tenant_id, branch_id) references branches (tenant_id, id)` so a row's branch always belongs to its tenant (ADR-0004). `branches` carries `unique (tenant_id, id)` to back this.

### 3.4 `payment_method` enum
`cash | wallet | other | debt` (ADR-0004) — declared once now; `debt` inert until Phase 5.

---

## 4. Auth, claim helpers & RLS (the isolation surface — `security-reviewer` gates all of this)

### 4.1 Custom Access Token Hook (edge function) — claim construction (ADR-0003)
Runs on **every** issuance incl. `token_refresh`. Reads `tenant_members` + `profiles` (server-side, never request input), writes **only** `app_metadata`:
```jsonc
app_metadata: {
  tenant_id: "<active tenant uuid>",   // scalar; the one tenant RLS enforces
  roles: "owner" | "manager" | "staff",// role for the active tenant
  is_super_admin: false,               // platform flag from profiles.is_platform_admin
  // impersonation tokens additionally carry:
  impersonator_id: "<super_admin profile id>",
  impersonation_exp: "<iso>"
}
```
Active tenant = the user's current selection (persisted server-side / defaulted to their sole or last tenant); switching tenant is a server-validated refresh that re-stamps `tenant_id`. The token carries **no** `tenant_ids[]` array (ADR-0003 Option 1A). Suspended tenants / inactive members are additionally enforced in-policy (below), independent of token freshness.

### 4.2 Claim-reading helpers (SQL, `SECURITY DEFINER`, audited)
```sql
-- the ONE value every tenant policy reads; wrap calls in (select …) for initPlan caching
create function public.current_tenant_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid;
$$;

create function public.current_role_in_tenant() returns text
  language sql stable security definer set search_path = public as $$
  select auth.jwt() -> 'app_metadata' ->> 'roles';
$$;

create function public.is_super_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'is_super_admin')::boolean, false);
$$;

-- membership / active-status gate (suspension enforced independent of token freshness, ADR-0003)
create function public.is_active_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_members m join public.tenants t on t.id = m.tenant_id
    where m.tenant_id = (select public.current_tenant_id())
      and m.profile_id = (select auth.uid())
      and m.is_active and t.status = 'active'
  );
$$;
```
**Role helpers replace the trial's `is_owner()`/`is_staff()`, narrowed to the active tenant:**
```sql
create function public.is_tenant_owner() returns boolean ... as $$
  select (select public.current_role_in_tenant()) = 'owner' and (select public.is_active_member());
$$;
create function public.is_tenant_staff() returns boolean ... as $$
  select (select public.is_active_member());  -- any active member of the active tenant
$$;
```
`security-reviewer` audit: every `SECURITY DEFINER` helper either reads the trusted claim or is provably tenant-agnostic; none returns cross-tenant rows (AC 30). `current_tenant_id()` reads **`app_metadata`** only — never `user_metadata`, body, or header, never a hot-path `profiles` scan (AC 28).

### 4.3 RLS policy sketch — preserve the trial role pattern, AND-ed with tenant (AC 31a)
Every tenant table: `enable row level security` + ≥1 policy + `WITH CHECK` on writes. The proven trial predicate is **narrowed by tenant, never replaced**. The tenant predicate is `tenant_id = (select public.current_tenant_id())`.

**Config tables** (`devices`, `rate_rules`, `products`, `settings`) — staff-read / owner-write, AND tenant:
```sql
create policy devices_read on public.devices for select
  using (tenant_id = (select current_tenant_id()) and (select is_tenant_staff()));
create policy devices_owner_write on public.devices for all
  using (tenant_id = (select current_tenant_id()) and (select is_tenant_owner()))
  with check (tenant_id = (select current_tenant_id()) and (select is_tenant_owner()));
-- devices also keep the manager status-flip update (staff) AND-ed with tenant (trial parity)
```

**Transactional tables** (`shifts`, `sessions`, `orders`, `debts`) — own-row OR owner, AND tenant:
```sql
create policy sessions_select on public.sessions for select
  using (tenant_id = (select current_tenant_id())
         and (manager_id = (select auth.uid()) or (select is_tenant_owner())));
create policy sessions_insert on public.sessions for insert
  with check (tenant_id = (select current_tenant_id()) and manager_id = (select auth.uid()));
create policy sessions_update on public.sessions for update
  using (tenant_id = (select current_tenant_id())
         and (manager_id = (select auth.uid()) or (select is_tenant_owner())))
  with check (tenant_id = (select current_tenant_id())
         and (manager_id = (select auth.uid()) or (select is_tenant_owner())));
```

**Child tables** (`session_segments`, `order_items`, `debt_payments`) — parent `EXISTS` AND own `tenant_id` (AC 35):
```sql
create policy segments_all on public.session_segments for all
  using (tenant_id = (select current_tenant_id()) and exists (
    select 1 from public.sessions s
    where s.id = session_id and s.tenant_id = (select current_tenant_id())
      and (s.manager_id = (select auth.uid()) or (select is_tenant_owner()))))
  with check (tenant_id = (select current_tenant_id()) and exists (
    select 1 from public.sessions s
    where s.id = session_id and s.tenant_id = (select current_tenant_id())
      and (s.manager_id = (select auth.uid()) or (select is_tenant_owner()))));
```

**`stock_movements`** — staff read; insert blocks `reason='adjust'` for non-owners (AC 31a):
```sql
create policy stock_insert on public.stock_movements for insert
  with check (tenant_id = (select current_tenant_id()) and (select is_tenant_staff())
              and (reason <> 'adjust' or (select is_tenant_owner())));
```

**`audit_log`** — owner-read / staff-insert, AND tenant (AC 39):
```sql
create policy audit_select on public.audit_log for select
  using (tenant_id = (select current_tenant_id()) and (select is_tenant_owner()));
create policy audit_insert on public.audit_log for insert
  with check (tenant_id = (select current_tenant_id()) and (select is_tenant_staff()));
```

**`tenants` / `branches` / `tenant_members`** — readable by active members of that tenant; written by owners (members/branches) and super-admin path (tenants). `branches` write = owner of the tenant. `tenant_members` write = owner of the tenant (with `WITH CHECK` pinning `tenant_id`).

**`profiles`** — cross-tenant: self-read + read of co-members; self-update of non-privileged fields; `is_platform_admin` never self-settable (guarded — only a migration/super-admin path sets it).

**`platform_settings`** — `select` to authenticated; `all` write `using/with check (select is_super_admin())`. No `tenant_id`, unreachable via `current_tenant_id()` (ADR-0004).

**Views** — any view (e.g. `product_stock_levels`) is `security_invoker = true` so RLS of the querying user applies (AC 29).

### 4.4 `handle_new_user` trigger
On `auth.users` insert → idempotent `insert into profiles (id, full_name) … on conflict (id) do nothing` (AC 25). It does **not** create a `tenant_members` row — membership is granted explicitly (super-admin provisioning or owner invite).

---

## 5. Edge-function / server contracts

### 5.1 `custom-access-token-hook` (Supabase Auth hook)
- **Input:** Supabase hook event `{ user_id, claims, authentication_method }`.
- **Behavior:** resolve active tenant for `user_id` from `tenant_members` (+ persisted active selection), read role + `profiles.is_platform_admin`; merge `{ tenant_id, roles, is_super_admin }` into `claims.app_metadata`; return claims. Re-runs on `token_refresh` (freshness, ADR-0003). Never reads request body for tenant identity.

### 5.2 `provision-tenant` (super-admin only, service-role server-side)
- **Input:** `{ tenant_name, owner_email | owner_profile_id }`. **Guard:** caller `is_super_admin`.
- **Behavior (one transaction):** insert `tenants`; insert/locate the owner `profiles`; insert `tenant_members(tenant_id, owner_profile_id, role='owner', is_active=true)`; insert `audit_log(tenant_id, actor=super_admin, action='tenant.provision', timestamp)`. (AC 37)

### 5.3 `impersonate-tenant` (super-admin only, service-role server-side) — ADR-0003 Option 3A
- **Input:** `{ target_tenant_id, ttl_seconds (≤ window, default e.g. 900) }`. **Guard:** `is_super_admin`.
- **Behavior:** write `audit_log(action='impersonation.start', actor, target_tenant_id, expiry)`; mint a **short-lived** session whose `app_metadata` = `{ tenant_id: target, roles: <support role>, is_super_admin: true, impersonator_id, impersonation_exp }`. The minted token is enforced by the **same** RLS as a normal tenant user → super-admin sees only that one tenant, only while valid. **No RLS bypass branch exists anywhere** (AC 38). `impersonation.stop` (or expiry) ends it; audited.

### 5.4 `suspend-tenant` (super-admin only)
- Sets `tenants.status='suspended'`; writes `audit_log`. Suspension takes effect via `is_active_member()` gating (no token-freshness dependency).

---

## 6. Migration plan (forward-only, numbered, append-only — AC 24)
```
supabase/migrations/
  0001_tenancy_core.sql      tenants, branches(unique tenant_id,id), profiles(is_platform_admin),
                             tenant_members, user_role enum(super_admin|owner|manager|staff),
                             handle_new_user, set_updated_at, platform_settings
  0002_operational_tables.sql devices/rate_rules/products/settings/shifts/sessions/segments/
                             orders/order_items/stock_movements/customers/debts/debt_payments/
                             audit_log — all with tenant_id (+branch_id per ADR-0004), enums
                             incl. payment_method(...|debt), composite FKs, tenant_id-leading
                             indexes, partial unique active-session, updated_at triggers
  0003_claim_helpers.sql     current_tenant_id, current_role_in_tenant, is_super_admin,
                             is_active_member, is_tenant_owner, is_tenant_staff
  0004_rls_policies.sql      enable RLS + policies on EVERY public table (config/transactional/
                             child/stock/audit/tenancy/platform_settings), WITH CHECK on writes,
                             views security_invoker=true
  0005_seed.sql              ≥2 tenants A/B + branches/devices/rate_rules/products/members
```
Edge functions live under `supabase/functions/{custom-access-token-hook,provision-tenant,impersonate-tenant,suspend-tenant}/`. Numbering is sequential; previously-shipped migrations are never edited (append-only). All money columns `int` piastres; never edit a shipped file — extend with a new numbered migration.

---

## 7. Package / ownership boundaries
- **`@ps/core`** (architect-specified, core-engineer builds): pure money/time/inventory/id/types. No DB/claim logic.
- **`supabase`** (backend-engineer builds): migrations, helpers, RLS, hook, edge functions, seed, isolation suite. DB is a thin uniform store; no money math re-derived in SQL (it lives in `@ps/core`).
- **mobile/web** (Phase 3+): never send client `tenant_id` as source of truth; rely on the signed claim; handle refresh on tenant/role switch; impersonation UI visually unmistakable + audited.

---

## 8. Per-engineer hand-off + mandatory isolation tests

### CORE engineer — `packages/core`
Build the §2 modules + types. Honor: integer-piastres money, Cairo time with `CAFE_TZ`, no `Date.now()` in cost-relevant math, purity (no framework imports), `PaymentMethod` incl. `debt`, `Role` incl. `super_admin`, `tenant_id` on all + `branch_id` on the five branch-scoped entity types. **Done = AC 1–20, 40:** `tsc --noEmit` 0 errors, `jest` all pass, **>90%** line coverage on money/time/inventory, `pricing-engine-guard` clean. *(Live-verifiable on this machine.)*

### BACKEND engineer — `supabase`
Author the §6 migrations + §4 helpers/RLS + §5 edge functions + ≥2-tenant seed + the `rls-tenant-audit` suite. Honor ADR-0002/-0003/-0004 exactly: `tenant_id` leading every key; `WITH CHECK` on every write pinning `tenant_id`; trial role pattern AND-ed with tenant (never replaced); claim from `app_metadata` only; no RLS-bypass branch; views `security_invoker`. **Done (this machine) = authored + statically audited (AC 21–39, 31a, 41); live execution DEFERRED to CI/hosted Supabase.**

### SECURITY-REVIEWER (sign-off REQUIRED — flagged tenancy/auth)
Gate: the hook claim construction (writes `app_metadata` only, reads `tenant_members`/`profiles`, never request input); `current_tenant_id()`/`current_role_in_tenant()`/`is_super_admin()`/`is_active_member()`/role helpers; **every** RLS policy + `WITH CHECK`; the `SECURITY DEFINER` audit (no cross-tenant leak); views `security_invoker=true`; `platform_settings` super-admin-only write; impersonation time-box + audit + absence of any bypass. Owns the `rls-tenant-audit` gate. **Verdict on this machine: "static pass — pending live verification"** — enumerate the deferred live items (AC 32–35).

### Mandatory isolation tests (`rls-tenant-audit`, must pass in CI)
With ≥2 seeded tenants A/B, as a tenant-A user:
1. **SELECT** of any tenant-B row across **every** tenant-scoped table → **0 rows** (AC 32).
2. **INSERT** with `tenant_id=B` (or none) → **rejected by `WITH CHECK`**, not silently re-scoped (AC 33).
3. **UPDATE/DELETE** of tenant-B rows → **0 rows affected** (AC 34).
4. **Child tables** (`session_segments`, `order_items`, `debt_payments`) cross-tenant via parent `EXISTS` → blocked (AC 35).
5. **Impersonation token** for tenant B → super-admin sees only B, only while valid; `audit_log` start/stop written (ADR-0003).
6. **`platform_settings`** → a non-super-admin tenant user cannot write it (ADR-0004).
7. **Static audit (this machine):** every public table has RLS + ≥1 policy (AC 26); `WITH CHECK` on every write (AC 27); views `security_invoker` (AC 29); no `SECURITY DEFINER` cross-tenant leak (AC 30); no `is_super_admin`/`OR true`/service-role escape in any tenant policy.

### QA gates
- **Live now (this machine):** AC 1–20, 40.
- **Static-audited now / live in CI:** AC 21–39, 31a, 41 — gate report must enumerate every deferred live item and must NOT claim a full backend pass.
