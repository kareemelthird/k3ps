# ADR-0007: Reporting aggregation strategy, RLS-safe read path & the owner-dashboard revenue/utilization contracts

- **Status:** Accepted (Phase-6 design gate. **`security-reviewer` sign-off REQUIRED** before the build merges — on Decision 1 (the aggregation mechanism is RLS-preserving), Decision 8 (owner-only DB gate + export-audit default), and the whole `0007` migration / `rls-tenant-audit` over the report path: AC 4, 24, 25, 26, 28. The human project owner approves at the Phase-6 gate.)
- **Date:** 2026-06-25
- **Deciders:** architect (deciding, tenant-isolation authority) · product-manager (Q2 revenue ratification, Q3 denominator, Q4 export-audit, Q6 CSV format, Q8 role gate) · `security-reviewer` (RLS / function-security / matview-hazard / export-audit sign-off) · core-engineer (the new pure time/range/CSV helpers) · web-engineer (consumes the RPCs, builds CSV + charts) · backend / supabase-migrate (authors `0007` from the normative SQL below) · ux-designer (chart library + RTL labels) · human project owner (Phase-6 gate)
- **Builds on:** [ADR-0002 — isolation model](0002-tenant-isolation-model-ratified.md) (Accepted; shared-DB + `tenant_id` + RLS; **a view/function without `security_invoker` is the named leak vector**; `tenant_id` leads every index) · [ADR-0003 — auth claim model](0003-auth-claim-and-impersonation-model.md) (the `current_tenant_id()` / `is_tenant_owner()` helpers read the signed `app_metadata` claim) · [ADR-0004 — schema scoping & keys](0004-tenant-schema-scoping-and-keys.md) (`branch_id` on `devices/shifts/sessions/orders/stock_movements`; `settings (tenant_id, key)`; `payment_method`) · [ADR-0005 — pricing/segments](0005-pricing-engine-segments-and-boundaries.md) (`grand_total = time_total + orders_total − discount`; reconstructible snapshots) · [ADR-0006 — orders/inventory/shifts](0006-orders-inventory-shifts.md) (**Decision 1 `businessDayKey(atIso, cutoverHour=6, tz=CAFE_TZ)`** is the canonical business-day boundary every report inherits; Decision 3 cash-only reconciles + session-attached orders settle through the session; `order_items.is_void`).
- **Reference:** `docs/specs/phase-6-owner-dashboard-reports.md` §4 (revenue model) / §6 (the 8 open questions) · `docs/reference/core-api.md` · `docs/reference/schema-and-rls.md` · `packages/core/src/time/time.ts` (`businessDayKey`, `CAFE_TZ`, `DEFAULT_CUTOVER_HOUR=6`) · `packages/core/src/money/*` (`sumPiastres`, `piastresToEgp`, `formatEgp`, `toArabicDigits`, `Piastres`) · `CLAUDE.md` §2 (non-negotiables), §4 (money/time API), §5 (tenancy/RLS).

## Context

After Phase 5 a café can run a full day, but the **owner has no analytics surface**. Every figure already exists as **stored integer-piastre snapshots** (`sessions.time_total/orders_total/grand_total/discount`, walk-in `orders.total`, `order_items` lines, `shifts.expected_cash/actual_cash/difference`); Phase 6 only **reads and aggregates** them — it writes no operational data and re-computes no money math (it sums what Phases 4–5 stored). The deliverable is the owner web dashboard: KPI cards, charts, drill-down tables, and CSV export, scoped to the owner's tenant, bucketed by the **business day** (Cairo + tenant cutover hour, ADR-0006 Decision 1), filterable by a business-day **date range** and a **branch**.

The load-bearing decision is **how aggregation is exposed without breaking tenant isolation**. ADR-0002 chose shared-DB + RLS and named the exact failure modes: a Postgres **view or function runs with the *definer's* RLS context unless it is `security_invoker=on` (PG15+ views) / `SECURITY INVOKER` (functions, the default)**, and a **materialized view does NOT apply the querying user's RLS at all** — its rows are materialised by the owner role at refresh time, outside any RLS context, so a `SELECT` from it returns *every* tenant's data. This is the single hazard this ADR must rule on head-on. Confirmed against the Postgres docs and Supabase guidance (see Options → Evidence): regular views obey RLS only with `security_invoker=true`; SQL functions execute as the *caller* (and therefore under the caller's RLS) when `SECURITY INVOKER`, which is the language default; materialized views cannot carry RLS and are flagged by the Supabase advisor `0016_materialized_view_in_api` when exposed.

**Hard constraints (from `CLAUDE.md`):** money is integer piastres, sums exact, never floats (§2.1); time derives from stored UTC, bucketed in Africa/Cairo, weekend = Fri(5)+Sat(6) (§2.2/§2.3); `@ps/core` is pure — instants passed in, no `Date.now()` in math, no React/RN/Expo/Next/Supabase imports (§2.4); RLS on every table, tenant id from the trusted JWT claim, `WITH CHECK` on writes (§5); auditable money actions (§2.7). Plus ADR-0002's standing rule: **no SQL object ships on the read path without a stated isolation guarantee and `security-reviewer` sign-off.**

**Forces in tension:** simplest correct read path vs. not shipping a year of rows to the browser; set-based SQL performance vs. SQL surface to own/test; keeping money aggregation honest (exact integer Σ, no double-count) vs. the temptation to re-derive bills; a single source of truth for the business-day boundary (`@ps/core businessDayKey`) vs. needing the same bucketing inside set-based SQL.

The 9 open questions (spec §6) are locked below.

---

## Decisions (the 9 open questions, locked)

### Decision 1 — Aggregation mechanism: **`SECURITY INVOKER` SQL functions (RPC) for every rollup, owner-gated; client-side aggregation only for already-bounded small slices; materialized views REJECTED** (Q1 → recommend (c), accepted; **`security-reviewer` signs off**)

All heavy rollups (revenue-by-day, by-device, top-products, payment-mix) are exposed as **`language sql … stable security invoker` functions** in a new forward-only migration `0007` (DDL below, §"Forward-only migration"), called from `apps/web` via `supabase.rpc(...)`. Each takes `(p_from timestamptz, p_to timestamptz, p_branch uuid, p_cutover int)` and returns a **bounded** pre-aggregated set (≤ ~366 day-rows/yr, ≤ N devices, ≤ M products, payment-method ≤ 4).

**The isolation guarantee (the crux), stated exactly:**
1. **`SECURITY INVOKER` is the language default and is set explicitly** on every reporting function. A `SECURITY INVOKER` function executes with the privileges and the **RLS context of the calling role** (`authenticated`), so every base-table reference inside the function is filtered by the *existing* `0004` policies exactly as if the owner had queried the table directly. We add **no `SECURITY DEFINER`** on the read path — a definer function owned by `postgres` would carry `BYPASSRLS` and leak. (The pre-existing claim helpers `current_tenant_id()` / `is_tenant_owner()` are `SECURITY DEFINER` but provably tenant-agnostic — they read only the signed `auth.jwt()` request claim and return scalars, never table rows; they compose safely inside an invoker function.)
2. **The existing `current_tenant_id()` policies compose unchanged.** Because the functions never reference `tenant_id` from a parameter and never disable RLS, the `tenant_id = current_tenant_id()` predicate on `sessions`/`orders`/`order_items`/`stock_movements`/`shifts`/`products`/`devices` is in force on every read. A tampered/guessed `p_branch` cannot widen scope: `branch_id` is an ordinary within-tenant FK (ADR-0004), so `p_branch` only *narrows* via `(p_branch is null or branch_id = p_branch)` and RLS still bounds the row set to the caller's tenant.
3. **Defense in depth — owner gate inside the function.** Reports are owner-only (Decision 8). The `0004` *staff*-readable policies on `sessions`/`orders` restrict non-owners to their **own** `manager_id` rows, so a staff caller would otherwise get partial, misleading aggregates. Each function therefore additionally ANDs `(select public.is_tenant_owner())` into its predicate — a non-owner gets **zero rows**, never another user's or another tenant's data. The web route also gates owner-only (Decision 8); the DB gate is the second line.
4. **Materialized views are REJECTED outright.** They do not enforce the querying user's RLS (rows are materialised by the owner role at refresh, outside RLS) and are flagged by the Supabase advisor when exposed — a direct cross-tenant leak. If a future phase ever needs one for scale, it requires a *new* ADR and an RLS-enforcing wrapper (an invoker function or `security_invoker` view that re-applies `tenant_id = current_tenant_id()`), never raw exposure.

**Why RPC over the alternatives:** plain `security_invoker` views (option b, like the existing `product_stock_levels`) cannot cleanly take the per-request range/cutover parameters and would push all grouping to the client; raw client-side aggregation (option a) is RLS-automatic but ships up to ~50k session rows for a year to the browser. RPC is the sweet spot — parameterizable, set-based, exact integer Σ in SQL, RLS in force, totals computed server-side so they stay **exact regardless of client table pagination** (Decision 7). **Client-side aggregation is explicitly permitted only for already-bounded small slices** — the per-shift reconciliation list (≤ ~730 rows/yr) is fetched as RLS-scoped rows and summed in the web layer; that is a sanctioned exception, not the default.

### Decision 2 — Revenue model ratified + per-entity business-day anchor (Q2 → accepted by PM)

The §4 canonical figures are **ratified** against the real columns (all integer piastres; **sums cast to `bigint` in SQL** to avoid 32-bit overflow over wide ranges — `int` caps at 2.1e9 piastres ≈ 21.4M EGP, plausibly exceeded by a busy multi-branch tenant over a year):

- **Time revenue** = `Σ sessions.time_total` over `status='closed'`.
- **Orders revenue** = `Σ sessions.orders_total` (closed sessions) **+** `Σ orders.total` over walk-ins (`session_id IS NULL AND status='paid'`). This equals `Σ` non-void `order_items.qty × unit_price` (the stored `orders_total` / `orders.total` are already kept void-aware by the Phase-5 write path, ADR-0006 Decision 2/8); we sum the **stored aggregate columns** as canonical (fewer joins) and assert line-sum equivalence in tests.
- **Discounts** = `Σ sessions.discount` over closed sessions.
- **Gross (collected)** = `Σ sessions.grand_total` (closed) **+** `Σ orders.total` (walk-in, `session_id IS NULL AND status='paid'`). **No double-count:** `grand_total` already = `time_total + orders_total − discount`, and session-attached orders settle *through* the session (ADR-0006 Decision 3), so they are **never** added again as standalone order payments. Only walk-ins (`session_id IS NULL`) are added on their own.
- **Cash revenue** = the subset of Gross with `payment_method='cash'` (`sessions.payment_method` for sessions; `orders.payment_method` for walk-ins). `wallet`/`other`/`debt` appear in the mix but are excluded from the cash line (mirrors ADR-0006 Decision 3).
- **Net** is **not** separately re-subtracted — `grand_total` is already net of discount; the dashboard shows **Gross** (net of discount) and **Discounts** as distinct figures so discount can never be double-applied.

**Exclusions:** `active` sessions and `void` sessions/orders contribute **0**; a voided line (`is_void=true`) contributes 0 to Orders revenue and to top-products.

**Per-entity business-day anchor (ratified):**
- **Sessions → `started_at`** (revenue recognised when play began; also matches the existing `sessions_started_idx (tenant_id, started_at)` for an indexed range scan).
- **Walk-in orders → `orders.created_at`** (a counter walk-in is created and paid in one action, so `created_at` ≈ pay-instant; **no `paid_at` column exists and Phase 6 adds none**, and `updated_at` is unreliable because a later void would move it — `created_at` is the only stable, stored anchor).
- **Order lines (top-products) → `coalesce(parent session.started_at, order.created_at)`** so a snack consumed on a session buckets with that session and a walk-in snack buckets at its order — keeping top-products consistent with Orders revenue to the piastre.
- **Shifts → `opened_at`** (already pinned by ADR-0006 Decision 1).

### Decision 3 — Business-day bucketing: **range→UTC window in `@ps/core`; per-row day label in SQL (normative expression); parity test required** (Q1/Q2-coupled, accepted)

To keep **one source of truth** for the boundary while still doing set-based SQL:

- The selected **range** `[fromKey, toKey]` (inclusive business-day keys) is converted to a **half-open UTC window `[fromIso, toIso)`** by a new pure helper `businessDayRange(fromKey, toKey, cutoverHour?, tz?)` in `@ps/core` (signature below). The RPCs filter rows on the raw anchor timestamp against this window — so **which rows are included is decided by the tested `@ps/core` helper**, not by SQL, and is exact across UTC↔Cairo and DST edges.
- The **per-row business-day label** (the `GROUP BY` key the per-day chart/table needs) is computed in SQL by this **normative expression**, which replicates `businessDayKey`:
  ```sql
  ((anchor AT TIME ZONE 'Africa/Cairo') - make_interval(hours => p_cutover))::date::text
  ```
  (`AT TIME ZONE` yields the Cairo wall-clock at that instant; subtract the cutover; the date is the key — DST-safe because the zone conversion happens per instant.)
- **A parity test is mandatory** (QA gate): a fixture of instants — including a 02:00 Cairo late-night instant (→ previous key), a 06:00 instant (→ same key), and an instant inside an Egypt DST transition (DST is live since 2023, last-Fri-Apr → last-Thu-Oct) — must satisfy `SQL-label == businessDayKey(instant, cutover, 'Africa/Cairo')`. The window bounds (`@ps/core`) and the labels (SQL) must agree; any divergence is a build blocker.
- `p_cutover` is read by the web layer from `settings` key `business_day → {cutover_hour}` (default `6` when absent, ADR-0006 Decision 1) and passed to every RPC.

### Decision 4 — Device-utilization denominator: **24h × business-days-in-range, clearly labelled; busy-minutes is the primary honest metric** (Q3 → recommend (a), accepted by PM)

Per device over the range/branch:
- **Busy minutes** (the primary, honest figure) = `Σ` over the device's **closed** sessions of `floor(greatest(0, extract(epoch from (least(ended_at, p_to) − greatest(started_at, p_from))) / 60))` — overlap clamped to the window, never negative; a device with no sessions shows **0** (not an error).
- **Utilization %** (secondary, explicitly labelled "% of 24h") = `busy_minutes ÷ (daysInRange × 24 × 60)`, computed in the **web layer** from the RPC's `busy_minutes` and the pure helper `daysInRange(fromKey, toKey)`. This is a pure ratio (no money), so it lives outside SQL and outside core money math.
- **Device revenue** = `Σ sessions.grand_total` for that `device_id` (closed, in range) — note this includes the device's session-attached orders (folded into `grand_total`); walk-in orders carry no `device_id` and are excluded from per-device revenue (disclosed in the UI).

An **operating-hours model is deferred** (no schema for it; would need a `settings` key + a new spec). The "% of 24h" denominator is intentionally simple and labelled so it is never mistaken for "% of opening hours."

### Decision 5 — New `@ps/core` pure helpers (time/range/CSV only; **no new money aggregation in core**) (Q5/Q6-coupled, accepted)

The piastre **sums** live in SQL (exact integer `bigint` Σ of already-computed columns — aggregation, **not** money math: no rounding, no pricing, nothing re-derived), so AC 3's "new core money rollup" is **N/A this phase**. Core gains only **pure time/range/format helpers** (no `Date.now()` in math, no framework/Supabase imports, >90% coverage on new code). Suggested file `packages/core/src/reports/report-helpers.ts` (+ `formatEgpPlain` beside the money formatters); re-export via module + root `index.ts`; extend `purity.test.ts`.

```ts
/** Inclusive business-day key range → half-open UTC instant window. */
export interface BusinessDayWindow { fromIso: string; toIso: string; }

/**
 * Map an inclusive business-day key range [fromKey, toKey] ('YYYY-MM-DD') to the
 * half-open UTC window [fromIso, toIso) that exactly covers those business days,
 * given the tenant cutover hour. Reuses the SAME boundary math as businessDayKey
 * (ADR-0006 Decision 1) so windows and labels agree across UTC/Cairo + DST.
 *   fromIso = local fromKey 00:00 + cutover, as UTC.
 *   toIso   = local (toKey + 1 day) 00:00 + cutover, as UTC.
 * Invariant: businessDayKey(fromIso,…) === fromKey and the last instant before
 * toIso maps to toKey. Pure; instants derived from the keys, no clock read.
 */
export function businessDayRange(
  fromKey: string,
  toKey: string,
  cutoverHour?: number,   // default DEFAULT_CUTOVER_HOUR (6)
  tz?: string,            // default CAFE_TZ
): BusinessDayWindow;

/**
 * Inclusive count of calendar days between two 'YYYY-MM-DD' keys
 * (utilization denominator). daysInRange('2026-06-01','2026-06-07') === 7.
 * Pure; no tz needed (keys are already business-day dates); no clock read.
 */
export function daysInRange(fromKey: string, toKey: string): number;

/**
 * Machine-readable decimal-EGP string for CSV: integer piastres → '1234.50'
 * (exactly two decimals, Western digits, NO currency symbol, NO thousands
 * separators). Keeps currency formatting in @ps/core (CLAUDE.md §4) and off the
 * UI; the on-screen value stays Arabic-Indic via formatEgp/toArabicDigits.
 * Pure; exact (integer arithmetic, no float drift).
 */
export function formatEgpPlain(piastres: Piastres): string;
```

**Reuse, do NOT re-implement:** `businessDayKey`, `CAFE_TZ`, `DEFAULT_CUTOVER_HOUR`, `dayjs` tz plugin (time); `sumPiastres`, `piastresToEgp`, `formatEgp`, `toArabicDigits`, `Piastres` (money). No new pricing/grand-total math.

### Decision 6 — CSV generated **client-side** in `apps/web`; **decimal EGP, Western digits, UTF-8 with BOM, RFC-4180 escaping** (Q6 → recommend, accepted by PM)

CSV is built in the browser from the already-fetched RPC rows — no edge function (simplest; the data is already RLS-scoped on arrival). Format (locked): **UTF-8 with a leading BOM** (`﻿`, so Excel renders Arabic correctly); fields containing `,` `"` or newline are wrapped in double-quotes with embedded quotes doubled (RFC 4180); **Arabic text preserved**; **money columns as decimal EGP via `formatEgpPlain` (e.g. `1234.50`, Western digits, dot decimal, no thousands separator)**; counts/percentages as plain Western integers/decimals. The on-screen rendering stays Arabic-Indic (`formatEgp`/`toArabicDigits`) — CSV is machine-readable for the accountant/spreadsheet and is the one place Arabic-Indic digits are intentionally **not** used (AC 21 exemption). The export content matches the on-screen rows for the current range/branch.

### Decision 7 — Performance budget + pagination: **aggregates always exact in SQL; tables paginate client-side; totals never derived from a paginated page** (Q5 → recommend, accepted)

- **Budget:** p95 < ~1.5 s for the widest expected range (one year) on a single café-tenant's volumes (order-of-magnitude: ≤ ~50k sessions, ≤ ~50k orders, ≤ ~100k order_items per year). These are small for Postgres; set-based RPCs with the supporting indexes below comfortably meet it.
- **Exactness rule (AC 11):** every total/KPI is computed by an RPC `Σ` over the **full** in-range set — it is **never** derived by summing a client page. The per-day/by-device/top-products/payment-mix RPCs return **bounded** result sets (≤ ~366 days, device/product counts), so they are returned whole; the web layer may virtualize/paginate the *display* at ~100 rows, but the KPI figures come from the same RPCs, so KPIs and table totals **agree to the piastre** (AC 15). The per-shift list (small) is fetched whole and summed client-side (the Decision 1 sanctioned small-slice exception). If any future detail drill-down returns an unbounded raw set, it must paginate AND its totals must still come from an aggregate RPC, never the page.
- **Supporting indexes** (forward-only, RLS-neutral performance structures) added in `0007`: `orders (tenant_id, created_at)` for the walk-in range scan, and `shifts (tenant_id, opened_at)` for the shift range scan. `sessions (tenant_id, started_at)` (`sessions_started_idx`) and `order_items (tenant_id, order_id) where is_void=false` (`order_items_active_idx`) already exist and serve the session/line scans.

### Decision 8 — Export audit: **default OFF this phase**; reports **owner-only**, gated at the route AND in the RPC (Q4 + Q8 → accepted by PM + `security-reviewer`)

- **Export audit OFF.** Phase 6 is read-only; no money moves on a CSV export, so **no `report.export` audit row is written** by default. Data-exfiltration traceability is revisited in Phase 10 (hardening). **If** a future phase turns it on, the locked shape is: `action='report.export'`, `actor_id=auth.uid()` (owner), `tenant_id` from the claim, `entity='report'`, `entity_id=null`, `amount=null`, `meta={ report, from_key, to_key, branch_id, row_count, format:'csv' }` — and it then needs `audit_log_staff_insert` (owners are staff) plus `security-reviewer` re-sign-off. **No viewing ever writes an audit row.**
- **Owner-only, enforced twice.** The `/dashboard/reports` route gate denies `manager`/`staff` (redirect/403) using the role claim; **and** every reporting RPC ANDs `(select public.is_tenant_owner())` (Decision 1.3) so a non-owner who reaches the RPC gets **zero rows**. Managers do **not** get a branch mini-dashboard this phase (a later, separately-specced surface if ever needed). Any report that reads `audit_log` (e.g. a future voids/discounts trail) is additionally gated by the existing `audit_log_owner_select` (owners only) — staff can never see the audit trail through a report (AC 24).

### Decision 9 — Chart library: **Recharts** (with `react-is` override for React 19), RTL via reversed axes + Arabic-Indic `tickFormatter` (Q7 → architect+ux-designer recommendation; ux-designer confirms)

**Recommend Recharts** for `apps/web` (Next.js 15 / React 19): the most widely-understood component API for dashboards, declarative SVG, reasonable tree-shaken bundle, and — critically for us — first-class `tickFormatter`/`labelFormatter`/custom-label hooks so every axis/legend/tooltip number can pass through `toArabicDigits` (and money through `formatEgp`), with `<XAxis reversed />` + an RTL container for right-to-left flow. React 19 needs a `react-is` dependency override pinned to the React 19 version (known, documented). **Fallback:** if the `next build` bundle budget is exceeded, drop to **visx** (lower-level, smaller, more code) — but Recharts is the default. The ux-designer owns the final pick and the RTL/Arabic-numeral label adapter via `ui-ux-pro-max`; this decision is the engineering recommendation they build on, not a binding lock.

---

## Options considered (the load-bearing choice — Decision 1)

### Option A — Client-side aggregation of RLS-scoped raw rows
- Pros: RLS is automatic (the `@supabase/ssr` client reads base tables under the caller's policies); zero new SQL to own; simplest mental model.
- Cons: ships up to ~50k session + ~50k order + ~100k line rows for a one-year range to the browser (bandwidth, memory, slow); aggregation/Σ logic moves to the client where it is harder to keep exact and consistent with KPIs vs. tables; totals risk being computed off a paginated page. Acceptable **only** for already-bounded small slices (the shift list). Rejected as the primary mechanism.
- Evidence: https://supabase.com/docs/guides/database/postgres/row-level-security (RLS applies to direct table reads under the caller's role); https://learn.microsoft.com/azure/architecture/guide/multitenant/service/postgresql (push tenant-scoped aggregation into the DB; index policy columns).

### Option B — `security_invoker=true` views
- Pros: RLS-preserving (PG15+ `security_invoker`, proven by the existing `product_stock_levels` view); set-based; no client row-shipping.
- Cons: a view cannot take per-request `(from, to, branch, cutover)` parameters — it would expose every day/row and force the client to filter/group, or bake a fixed cutover; awkward for the parameterized, bucketed rollups we need. Good for static shapes, wrong fit here. Rejected as primary (the pattern is still used for `product_stock_levels`).
- Evidence: https://www.postgresql.org/docs/current/sql-createview.html (`security_invoker`); https://pganalyze.com/blog/5mins-postgres-row-level-security-bypassrls-security-invoker-views-leakproof-functions (security-invoker views apply the querying user's RLS).

### Option C — `SECURITY INVOKER` SQL functions / RPC — **CHOSEN**
- Pros: fully parameterizable `(from, to, branch, cutover)`; set-based exact integer Σ in SQL; **runs under the caller's RLS** (invoker is the function default), so the existing `current_tenant_id()` policies compose unchanged; totals computed server-side stay exact regardless of client pagination; small, testable SQL surface; owner-gate baked in for defense in depth.
- Cons: more SQL to own and test than Option A; the per-row business-day label must replicate `businessDayKey` in SQL (mitigated by the mandatory parity test, Decision 3).
- Evidence: https://www.postgresql.org/docs/current/sql-createfunction.html (`SECURITY INVOKER` is the default; the function runs with the privileges of the caller); https://www.postgresql.org/docs/current/ddl-rowsecurity.html (RLS applies per the current user; `BYPASSRLS`/table-owner exemptions are the bypass vectors to avoid); https://www.bytebase.com/blog/postgres-row-level-security-footguns/ (SECURITY DEFINER owned by a superuser bypasses RLS — so we use INVOKER and never DEFINER on the read path); https://supabase.com/docs/guides/database/postgres/row-level-security (index policy columns; wrap auth calls in `(select …)` for initPlan caching).

### Option D — Materialized views — **REJECTED**
- Pros: fastest for very large ranges (pre-computed).
- Cons: **do NOT enforce the querying user's RLS at all** — rows are materialised by the owner role outside any RLS context, so a `SELECT` returns every tenant's data; Postgres does not support RLS on materialized views; Supabase's advisor flags an exposed matview as a finding. A direct cross-tenant leak; unjustified for single-café data volumes. Only revisitable behind an RLS-enforcing wrapper via a new ADR.
- Evidence: https://www.bytebase.com/blog/postgres-row-level-security-footguns/ ("a `SELECT *` into a materialized view happily copies every tenant's rows"); https://github.com/orgs/supabase/discussions/17790 (matviews cannot carry RLS; wrap or avoid); https://supabase.com/docs/guides/database/database-advisors?lint=0016_materialized_view_in_api (the `materialized_view_in_api` security advisor).

### Device-utilization denominator (Decision 4)
- **(a) 24h × days-in-range — CHOSEN:** simple, no new schema, always computable; honest once labelled "% of 24h" with busy-minutes as the primary figure. Con: % reads low for a café open ~12h (accepted, and labelled).
- **(b) tenant operating hours:** most meaningful %, but **no operating-hours model exists** — needs a `settings` key + new spec. Deferred.
- **(c) observed open window (first-open→last-close/day):** self-referential (busy time inflates its own denominator), harder to explain. Rejected.
- Evidence: existing `settings (tenant_id, key)` jsonb pattern (ADR-0004) keeps (b) cheap to add later; ADR-0006 Decision 1 cutover already drives "days-in-range."

---

## Forward-only migration (`supabase/migrations/0007_reporting_functions.sql`) — NORMATIVE

Backend / supabase-migrate creates the actual file from this spec. **`security-reviewer` sign-off required.** It creates **no tables**, alters **no existing RLS policy**, and adds **only** `SECURITY INVOKER` functions + RLS-neutral performance indexes. All reads inside the functions are bound by the existing `0004` policies (the caller's RLS) plus the in-function owner gate.

```sql
-- =============================================================================
-- Migration 0007 — Phase 6 reporting read path (aggregation RPCs + perf indexes)
--
-- Forward-only. No table created; no existing RLS policy altered.
-- Every function is SECURITY INVOKER (explicit) + STABLE + search_path=public,
-- so it runs under the CALLER's RLS — the existing current_tenant_id() policies
-- on every base table apply unchanged. NO function is SECURITY DEFINER.
-- Each function also ANDs is_tenant_owner() (defense in depth: reports are
-- owner-only; non-owners get zero rows). Sums are cast to bigint (overflow-safe).
-- Materialized views are deliberately NOT used (they bypass RLS — ADR-0007 D1).
--
-- SECURITY REVIEWER: sign-off required (ADR-0007 Decisions 1 & 8). Verify:
--   * every function is security invoker (not definer);
--   * no parameter is trusted as tenant_id (tenant scope comes only from RLS);
--   * is_tenant_owner() gate present in each;
--   * rls-tenant-audit A<->B holds over every RPC (AC 4, 26).
-- =============================================================================

-- ── Supporting indexes (RLS-neutral; tenant_id-leading, ADR-0002) ────────────
create index if not exists orders_tenant_created_idx
  on public.orders (tenant_id, created_at);
create index if not exists shifts_tenant_opened_idx
  on public.shifts (tenant_id, opened_at);
-- sessions_started_idx (tenant_id, started_at) and
-- order_items_active_idx (tenant_id, order_id) where is_void=false already exist.

-- ── 1. Revenue by business day ───────────────────────────────────────────────
create or replace function public.report_revenue_by_day(
  p_from    timestamptz,
  p_to      timestamptz,
  p_branch  uuid,
  p_cutover int default 6
)
returns table (
  business_day        text,
  time_total          bigint,
  orders_total        bigint,
  discount            bigint,
  gross               bigint,
  session_count       bigint,
  walkin_order_count  bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with rows as (
    -- Closed sessions, anchored at started_at
    select
      ((s.started_at at time zone 'Africa/Cairo')
        - make_interval(hours => p_cutover))::date::text as business_day,
      s.time_total::bigint   as time_total,
      s.orders_total::bigint as orders_total,
      s.discount::bigint     as discount,
      s.grand_total::bigint  as gross,
      1::bigint              as is_session,
      0::bigint              as is_walkin
    from public.sessions s
    where s.status = 'closed'
      and s.started_at >= p_from and s.started_at < p_to
      and (p_branch is null or s.branch_id = p_branch)
    union all
    -- Walk-in paid orders, anchored at created_at
    select
      ((o.created_at at time zone 'Africa/Cairo')
        - make_interval(hours => p_cutover))::date::text,
      0::bigint, o.total::bigint, 0::bigint, o.total::bigint,
      0::bigint, 1::bigint
    from public.orders o
    where o.session_id is null
      and o.status = 'paid'
      and o.created_at >= p_from and o.created_at < p_to
      and (p_branch is null or o.branch_id = p_branch)
  )
  select
    r.business_day,
    sum(r.time_total),
    sum(r.orders_total),
    sum(r.discount),
    sum(r.gross),
    sum(r.is_session),
    sum(r.is_walkin)
  from rows r
  where (select public.is_tenant_owner())   -- owner-only (defense in depth)
  group by r.business_day
  order by r.business_day;
$$;

-- ── 2. By device (busy minutes, sessions, revenue) ───────────────────────────
create or replace function public.report_by_device(
  p_from    timestamptz,
  p_to      timestamptz,
  p_branch  uuid,
  p_cutover int default 6
)
returns table (
  device_id     uuid,
  device_name   text,
  busy_minutes  bigint,
  session_count bigint,
  revenue       bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    d.id,
    d.name,
    coalesce(sum(
      floor(greatest(0, extract(epoch from (
        least(s.ended_at, p_to) - greatest(s.started_at, p_from)
      )) / 60))
    ), 0)::bigint                              as busy_minutes,
    count(s.id)::bigint                        as session_count,
    coalesce(sum(s.grand_total), 0)::bigint    as revenue
  from public.devices d
  left join public.sessions s
    on s.device_id = d.id
   and s.status = 'closed'
   and s.started_at >= p_from and s.started_at < p_to
  where (p_branch is null or d.branch_id = p_branch)
    and (select public.is_tenant_owner())
  group by d.id, d.name
  order by busy_minutes desc;
$$;

-- ── 3. Top products (qty, revenue, current cost for margin-where-known) ───────
create or replace function public.report_top_products(
  p_from    timestamptz,
  p_to      timestamptz,
  p_branch  uuid,
  p_cutover int default 6
)
returns table (
  product_id uuid,
  name       text,
  category   text,
  qty        bigint,
  revenue    bigint,
  cost       int
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    p.id,
    p.name,
    p.category,
    sum(oi.qty)::bigint                       as qty,
    sum(oi.qty * oi.unit_price)::bigint       as revenue,
    p.cost
  from public.order_items oi
  join public.orders o   on o.id = oi.order_id
  join public.products p on p.id = oi.product_id
  left join public.sessions s on s.id = o.session_id
  where oi.is_void = false
    and o.status <> 'void'
    and (
      (o.session_id is null and o.status = 'paid')
      or (o.session_id is not null and s.status = 'closed')
    )
    and coalesce(s.started_at, o.created_at) >= p_from
    and coalesce(s.started_at, o.created_at) <  p_to
    and (p_branch is null or o.branch_id = p_branch)
    and (select public.is_tenant_owner())
  group by p.id, p.name, p.category, p.cost
  order by revenue desc;
$$;

-- ── 4. Payment-method mix (cash/wallet/other/debt) ───────────────────────────
create or replace function public.report_payment_mix(
  p_from    timestamptz,
  p_to      timestamptz,
  p_branch  uuid,
  p_cutover int default 6
)
returns table (
  payment_method text,
  amount         bigint,
  txn_count      bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with rows as (
    select coalesce(s.payment_method::text, 'unknown') as payment_method,
           s.grand_total::bigint as amount
    from public.sessions s
    where s.status = 'closed'
      and s.started_at >= p_from and s.started_at < p_to
      and (p_branch is null or s.branch_id = p_branch)
    union all
    select coalesce(o.payment_method::text, 'unknown'),
           o.total::bigint
    from public.orders o
    where o.session_id is null and o.status = 'paid'
      and o.created_at >= p_from and o.created_at < p_to
      and (p_branch is null or o.branch_id = p_branch)
  )
  select r.payment_method, sum(r.amount), count(*)::bigint
  from rows r
  where (select public.is_tenant_owner())
  group by r.payment_method
  order by sum(r.amount) desc;
$$;

-- ── 5. Per-shift reconciliation (closed shifts, anchored opened_at) ───────────
-- Returns the bounded list; totals are summed by the caller (small slice).
create or replace function public.report_shifts(
  p_from    timestamptz,
  p_to      timestamptz,
  p_branch  uuid,
  p_cutover int default 6
)
returns table (
  shift_id      uuid,
  business_day  text,
  opened_at     timestamptz,
  closed_at     timestamptz,
  opening_cash  int,
  expected_cash int,
  actual_cash   int,
  difference    int,
  manager_id    uuid
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    sh.id,
    ((sh.opened_at at time zone 'Africa/Cairo')
      - make_interval(hours => p_cutover))::date::text,
    sh.opened_at, sh.closed_at,
    sh.opening_cash, sh.expected_cash, sh.actual_cash, sh.difference,
    sh.manager_id
  from public.shifts sh
  where sh.status = 'closed'
    and sh.opened_at >= p_from and sh.opened_at < p_to
    and (p_branch is null or sh.branch_id = p_branch)
    and (select public.is_tenant_owner())
  order by sh.opened_at;
$$;

-- ── EXECUTE grants: authenticated only; not anon/public ──────────────────────
revoke all on function
  public.report_revenue_by_day(timestamptz, timestamptz, uuid, int),
  public.report_by_device(timestamptz, timestamptz, uuid, int),
  public.report_top_products(timestamptz, timestamptz, uuid, int),
  public.report_payment_mix(timestamptz, timestamptz, uuid, int),
  public.report_shifts(timestamptz, timestamptz, uuid, int)
  from public, anon;

grant execute on function
  public.report_revenue_by_day(timestamptz, timestamptz, uuid, int),
  public.report_by_device(timestamptz, timestamptz, uuid, int),
  public.report_top_products(timestamptz, timestamptz, uuid, int),
  public.report_payment_mix(timestamptz, timestamptz, uuid, int),
  public.report_shifts(timestamptz, timestamptz, uuid, int)
  to authenticated;

-- =============================================================================
-- END OF MIGRATION 0007
-- =============================================================================
```

**RLS-safety reasoning (no policy change needed):** every function is `security invoker`, so each base-table read is filtered by the existing `0004` `tenant_id = current_tenant_id()` policies (the caller's context). No parameter is trusted as `tenant_id`; `p_branch` only narrows within the already-RLS-bounded tenant. No `security definer` is used on the read path, so there is no `BYPASSRLS` vector. The in-function `is_tenant_owner()` predicate enforces owner-only at the DB (defense in depth behind the route gate). Indexes are `tenant_id`-leading performance structures, orthogonal to RLS. **Verify in `rls-tenant-audit` (AC 4, 26) and `security-reviewer` sign-off (AC 25, 28).**

---

## Per-engineer hand-off

- **core-engineer:** add `businessDayRange`, `daysInRange`, `formatEgpPlain` exactly as signed (Decision 5) — pure, no `Date.now()` in math, no framework/Supabase imports, **reuse** `businessDayKey`/`CAFE_TZ`/`DEFAULT_CUTOVER_HOUR` and the money formatters; export via module + root `index.ts`; extend `purity.test.ts`; new suite at >90% coverage incl. the cutover edge, the UTC↔Cairo boundary, the inclusive `daysInRange`, and `formatEgpPlain` exactness. **No new money aggregation** (AC 3 N/A — sums are in SQL).
- **backend / supabase-migrate:** author `supabase/migrations/0007_reporting_functions.sql` **verbatim** from the normative SQL above (forward-only; `security invoker` everywhere; owner gate in each; `bigint` sums; the two perf indexes; the revoke/grant block). Add the SQL↔`businessDayKey` **parity test** (Decision 3) and the no-double-count / void-exclusion assertions. **Get `security-reviewer` sign-off before merge** (Decisions 1 & 8; AC 25–26, 28).
- **web-engineer:** `apps/web/src/app/dashboard/reports/*` — **owner-only route gate** (redirect/403 for manager/staff, Decision 8); business-day date-range picker (presets + custom, invalid-range blocked) and branch filter; read `cutover_hour` from `settings` and call the five RPCs via `supabase.rpc` with `businessDayRange(...)` bounds; KPI cards, charts (Recharts, Decision 9), and report tables wired to the RPCs; utilization % via `daysInRange` (Decision 4); **client-side CSV** (UTF-8 BOM, RFC-4180 escaping, `formatEgpPlain` money, Arabic-safe, Decision 6); the per-shift list summed client-side (sanctioned small slice); loading/empty/error states; RTL/i18n; all currency/digits via `@ps/core` (`formatEgp`/`toArabicDigits`). **No money math or formatting inlined in the UI.**
- **ux-designer:** confirm Recharts (or visx fallback) + the RTL/Arabic-Indic label adapter via `ui-ux-pro-max`; dashboard layout, chart set, table designs, and all states per spec §7; all strings via i18n.
- **`security-reviewer`:** sign off on Decision 1 (every RPC is `security invoker`, no definer, owner-gated, no parameter trusted as tenant), Decision 8 (owner-only + export-audit default off), and the `0007` migration; own the `rls-tenant-audit` A↔B gate over the whole report path.

## Consequences

- **Becomes easy:**
  - One consistent, RLS-safe read mechanism (invoker RPCs) for every rollup; KPIs and tables come from the same SQL Σ, so they cannot disagree (AC 15).
  - The business-day boundary stays a single source of truth (`businessDayKey`/`businessDayRange`); SQL only labels rows already selected by the tested window helper.
  - Totals are exact in SQL regardless of client pagination (AC 11); no double-count by construction (stored `grand_total` + walk-in-only orders, Decision 2).
  - No new operational tables, no RLS-policy changes — just invoker functions + two perf indexes; the existing `current_tenant_id()` policies do all the isolation work.
- **Becomes hard / watch-outs:**
  - The SQL business-day label must stay in lockstep with `businessDayKey` — the **parity test is mandatory** (DST live in Egypt since 2023). A divergence at a DST edge could mislabel a boundary row; the window bounds (from `@ps/core`) prevent wrong *inclusion*, but labels must be tested.
  - `security invoker` + the in-function owner gate must be present on **every** reporting function — a single `security definer` or a missing `is_tenant_owner()` would weaken isolation/role-gating. `security-reviewer` checks each.
  - Sums must be `bigint` (int piastres overflow over wide ranges); the device "% of 24h" denominator must stay clearly labelled (it is an approximation, not opening-hours).
  - Walk-in revenue is anchored at `created_at` (no `paid_at` exists) — correct for one-shot counter sales; revisit only if a deferred-payment walk-in flow is ever added.
- **Follow-up / deferred:** operating-hours setting for a truthful utilization denominator → future spec; export auditing → Phase 10 hardening; super-admin cross-tenant analytics + impersonation → Phase 7; scheduled/emailed/PDF reports, saved presets, manager branch view → later phase; offline/realtime report refresh → Phase 8; materialized-view acceleration (only behind an RLS-enforcing wrapper) → new ADR if scale ever demands it.
- **Must verify (Phase-6 QA gates):**
  - **Isolation (`rls-tenant-audit`, AC 4/26):** tenant A↔B over **all five RPCs** and every base table they read — a tenant-A owner cannot read tenant-B figures via any RPC, branch filter, or crafted `p_branch`; a non-owner gets zero rows from every RPC (Decision 8).
  - **RLS-preserving mechanism (AC 25):** `security-reviewer` confirms every function is `security invoker` (not definer), no parameter is trusted as `tenant_id`, no materialized view is on the read path.
  - **Revenue correctness (AC 5–7):** figures equal the Decision 2 definitions exactly; **no double-count** of session-attached orders; `active`/`void` excluded; voided line = 0; cash-only mix.
  - **Bucketing (AC 1–2 + Decision 3):** `businessDayRange` window correct across the UTC↔Cairo boundary and cutover edge; SQL label == `businessDayKey` (incl. DST).
  - **Utilization / top-products / shifts (AC 8–10):** clamped busy-minutes; qty/revenue over non-void lines with margin "—" where `cost` null and sold-but-inactive products still listed; shift `difference` un-clamped.
  - **Web (AC 12–19), RTL/i18n (AC 20–22), full `ps-verify` (AC 27–28).**
  - **Sign-off:** `security-reviewer` approves Decisions 1 & 8 and the `0007` migration; the human project owner approves the Phase-6 gate.

## Sources

- PostgreSQL — Row Security Policies: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PostgreSQL — CREATE FUNCTION (`SECURITY INVOKER` default): https://www.postgresql.org/docs/current/sql-createfunction.html
- PostgreSQL — CREATE VIEW (`security_invoker`): https://www.postgresql.org/docs/current/sql-createview.html
- pganalyze — RLS, security-invoker views, LEAKPROOF: https://pganalyze.com/blog/5mins-postgres-row-level-security-bypassrls-security-invoker-views-leakproof-functions
- Bytebase — Postgres RLS footguns (SECURITY DEFINER bypass; materialized-view leak): https://www.bytebase.com/blog/postgres-row-level-security-footguns/
- Supabase — Row Level Security (index policy columns; `(select …)` initPlan caching; `app_metadata`): https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase — `materialized_view_in_api` security advisor (0016): https://supabase.com/docs/guides/database/database-advisors?lint=0016_materialized_view_in_api
- Supabase — Materialized views + RLS limitations (discussion #17790): https://github.com/orgs/supabase/discussions/17790
- Azure Architecture — Multitenant PostgreSQL (RLS for isolation; push aggregation into the DB): https://learn.microsoft.com/azure/architecture/guide/multitenant/service/postgresql
- Recharts (npm; React 19 `react-is` override): https://www.npmjs.com/package/recharts · https://github.com/recharts/recharts/issues/5146
