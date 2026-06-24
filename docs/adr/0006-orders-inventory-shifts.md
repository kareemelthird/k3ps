# ADR-0006: Orders, inventory ledger & shift cash reconciliation — the daily-operations write contracts and `@ps/core` aggregation API

- **Status:** Accepted (Phase-5 design gate; the human project owner approves at the Phase-5 gate. **`security-reviewer` sign-off required** on Decisions 2, 6, 7 — the `order_items.is_void` migration, the `shifts` one-open-per-branch partial-unique index, and the audit taxonomy — and on AC 5, 13, 19, 30, 38 before the build merges.)
- **Date:** 2026-06-24
- **Deciders:** architect (deciding) · product-manager (Q1/Q3/Q4/Q8 business rules) · core-engineer (implements the pure helpers) · mobile-engineer + web-engineer (consume) · backend / supabase-migrate (authors `0006`) · `security-reviewer` (RLS/audit/migration sign-off) · human project owner (Phase-5 gate)
- **Builds on:** [ADR-0002 — isolation model](0002-tenant-isolation-model-ratified.md) (Accepted; `tenant_id` leading on every key) · [ADR-0004 — schema scoping & keys](0004-tenant-schema-scoping-and-keys.md) (`branch_id` placement; `settings (tenant_id, key)` jsonb; `payment_method = cash|wallet|other|debt`) · [ADR-0005 — pricing engine & segments](0005-pricing-engine-segments-and-boundaries.md) (`computeGrandTotal` already accepts `orders_total`). Resolves the 8 architect decisions deferred in [Phase-5 spec](../specs/phase-5-products-orders-inventory-shifts.md) §6/§7.
- **Reference:** `docs/reference/core-api.md` (inventory ledger + money sections) · `docs/reference/schema-and-rls.md` · `CLAUDE.md` §2 (non-negotiables), §3 (`grand_total = Σ segments + orders_total − discount`), §4 (money/time API), §5 (tenancy/RLS).

## Context

After Phase 4 a café can price **time** but cannot run a **day**. Sessions close with `orders_total = 0` and `shift_id = null`; no products can be sold, no stock is decremented, and there is no drawer to reconcile. Phase 5 completes daily operations: an owner-managed product catalog (web), an order builder for session-attached and walk-in sales (mobile), an immutable stock ledger, and shift open/close with cash reconciliation — all multi-tenant, RLS-isolated, and auditable.

The schema in `supabase/migrations/0002_operational_tables.sql` already defines every table Phase 5 needs (`products`, `orders`, `order_items`, `stock_movements`, `shifts`, the `product_stock_levels` view, and all enums), and `0004_rls_policies.sql` already ships every RLS policy (owner-only product writes; own-row/owner orders & shifts; parent-EXISTS order_items; staff stock inserts with owner-only `adjust`; owner-read/staff-insert audit). `@ps/core` already ships the `inventory` ledger (`computeLevels`, `isTracked`, `stockStatus`, `offsettingVoids`, `inventoryValue`), `money`, `time`, and the pricing engine. Phase 5 therefore adds **only**: three small pure aggregation helpers (+ one date helper), two tiny forward-only DB deltas, and the write/UI wiring — it must not re-derive money math in the DB or re-implement the inventory ledger.

**Constraints (hard, from `CLAUDE.md`):** money is integer piastres, sums are exact, never floats (§2.1); time derives from stored UTC timestamps, business-day logic computed in Africa/Cairo, weekend = Fri(5)+Sat(6) (§2.2, §2.3); `@ps/core` is pure — instants passed in, no `Date.now()` in money/aggregation math, no React/RN/Expo/Next/Supabase imports (§2.4); RLS on every table, tenant id from the trusted JWT claim, `WITH CHECK` on writes (§5); every money-affecting action writes one `audit_log` row (§2.7); idempotent client-UUID upserts (§2.8); every bill/drawer reconstructible from stored snapshots (§3).

**Forces in tension:** auditable correction (never mutate/delete history) vs. schema minimalism (the spec says "no new tables"); live stock accuracy (decrement at add-time) vs. ledger cleanliness and void-reversal simplicity (decrement at paid); DB-enforced single-drawer invariant vs. concurrent-drawer flexibility; reconciliation fidelity (exact, un-clamped variance) vs. the temptation to clamp a "short" drawer to zero.

The 8 open questions shape the `@ps/core` API surface, the order/stock/shift write contracts, and the Phase-6 reporting model (the business-day boundary is inherited by every future report). They are locked below.

---

## Decisions (the 8 open questions, locked)

### Decision 1 — Business-day boundary: **Cairo-local day with a tenant-configurable cutover hour, default 06:00** (Q1 → recommend (b), accepted)

A "business day" is **not** the raw Cairo calendar day; it is the Cairo-local day shifted by a per-tenant **cutover hour** so a late-night session/shift that runs past midnight stays on the *previous* business day (the dominant late-night-café pattern, and the trial's behavior). The cutover is stored per tenant in `settings` under key `business_day` as `{ "cutover_hour": 6 }` (ADR-0004 `settings (tenant_id, key)` jsonb; **default 6** when the key is absent), so it is owner-configurable without a schema change and inherited verbatim by Phase-6 reporting.

The mapping is a **pure** `@ps/core` helper `businessDayKey(atIso, cutoverHour, tz)` returning a `'YYYY-MM-DD'` key in the business calendar: convert `atIso` to local time in `tz`, subtract `cutoverHour` hours, and take the resulting local date. (e.g. with cutover 6: an instant at 02:00 Cairo on the 12th → key `2026-06-11`; an instant at 06:00 Cairo on the 12th → key `2026-06-12`.) `tz` defaults to `CAFE_TZ` (`Africa/Cairo`); `cutoverHour` defaults to `6`. **No clock read** — the instant is passed in.

**Shift attribution this phase** uses `opened_at` mapped through `businessDayKey` (a shift belongs to the business day it *opened* in, even if it closes after the next cutover). This is the figure Phase-6 reporting will group by. We deliberately pin the cutover model now (not the raw calendar day) because reversing it later would silently re-bucket historical revenue.

### Decision 2 — Order-line void model: **`order_items.is_void boolean` + `voided_at timestamptz` (forward-only migration)** (Q2 → recommend (a), accepted; **`security-reviewer` signs off**)

`order_items` gains two columns in migration `0006`: `is_void boolean not null default false` and `voided_at timestamptz` (null until voided). A void is an **update** that sets `is_void = true`, `voided_at = nowIso()` — the original `qty`/`unit_price` snapshot is **never** mutated or deleted (auditable correction, not erasure — AC 10/33). All order-total math (`computeOrderTotal`, `computeOrdersTotalForSession`) filters on `is_void = false`. Rejected alternatives: order-level-only void (cannot correct one wrong line — AC 10 requires per-line), and negative-qty compensating lines (pollutes the line list, double-counts in naive sums, and makes "what was actually on the bill" ambiguous).

**RLS / WITH CHECK:** the existing `order_items_all` policy (parent-order EXISTS + own tenant, own-row-or-owner) already governs `for all` including the void `UPDATE`; the two new columns are covered by that policy unchanged — **no policy shape change**, only column additions. `security-reviewer` confirms a tenant-B user cannot flip `is_void` on a tenant-A line (blocked by the parent-EXISTS `USING` + `WITH CHECK`). The void also writes a stock-void offset (Decision 4) and one audit row (Decision 7).

### Decision 3 — Cash vs non-cash + `debt`: **cash-only reconciles; `wallet`/`other` recordable; `debt` inert this phase** (Q3 → recommend, accepted by PM)

Only `payment_method = 'cash'` settlements count toward the drawer. `wallet`, `other`, and `debt` are recorded on the order/session but **excluded** from `expected_cash` (AC 25/29). `debt` stays **inert** in the pay UI this phase (the enum value exists but is not offered as a selectable settlement — the debt-ledger feature is deferred); if a future phase makes a `debt` settlement, it is excluded from the drawer exactly like wallet/other and gates a debt-ledger write. Selectable this phase: `cash`, `wallet`, `other`.

**Where the settlement `payment_method` is captured:**
- **Walk-in order** (`session_id = null`): captured on `orders.payment_method` at pay-time, when `orders.status → 'paid'`.
- **Session-attached consumption**: an in-session order's items fold into the session's `orders_total` and are **settled once at session close** via the existing `sessions.payment_method` column (Phase-4 close path). A session-attached order is **not** independently "paid" — its `orders.payment_method` stays null and its total is reconciled through the session's settlement. This avoids double-counting a snack both as an order payment and as part of the session bill.
- **Drawer attribution:** a shift's `cash_sales = Σ (grand_total of cash-settled sessions stamped with this shift_id) + Σ (total of cash-settled walk-in orders stamped with this shift_id)`, over non-void rows only. The mobile close path computes this set from stored rows and passes the integer sum into `computeShiftReconciliation` — `@ps/core` does not query; it sums what it is given.

### Decision 4 — Stock decrement commit point + oversell policy: **decrement at order `paid` / session close; warn-and-allow oversell (never block, never clamp)** (Q4 → recommend, accepted by PM)

A tracked product's sale `stock_movements` row (`reason='sale'`, `delta = −qty`, `order_id` set) is written **when the sale is finalized** — at `orders.status → 'paid'` for a walk-in, and at **session close** for session-attached order items — not at add-time. Rationale: one ledger write per finalized sale (matches "money moved"), and abandoned/edited carts never need reversal. **Untracked products** (`stock = null`) write **no** movement (AC 16; `inventory.isTracked`).

**Oversell is warn-and-allow:** if finalizing would drive on-hand negative, the sale still commits and on-hand is allowed to go negative — the negative value is the oversell signal the `inventory` module deliberately never clamps (AC 14/21). The order builder surfaces `inventory.stockStatus` (`out`/`low`/`ok`/`untracked`) as a badge and warns on an out-of-stock tracked item, but never blocks the sale. Blocking was rejected: a café cannot refuse a cash sale because a manual count drifted; visibility beats prevention for a cash business.

**Void reversal:** when a paid order or a single line is voided, the write path writes the offsetting movement(s) via `inventory.offsettingVoids` over the **recorded** sale movements (`reason='void'`, `delta = +qty`, same `order_id`), so `sale + void = 0` and on-hand restores exactly — even if the product was later untracked (the void follows the recorded sale, not the current flag — AC 17).

### Decision 5 — Opening stock authorship + staff restock: **`products.stock` is the opening count (no `initial` movement on create); staff may insert `reason='restock'`** (Q5 → recommend, accepted; **`security-reviewer` confirms duty split**)

When an owner creates a tracked product, the opening count lives in the **`products.stock` column only** — it is the `product_stock_levels.initial_stock` term, and on-hand = `initial_stock + Σ deltas`. **No separate `initial` `stock_movements` row is written on create.** Editing the catalog never mutates the ledger; after creation, **all** stock change flows through movements (`restock` +, `sale` −, `void` +, `adjust` ±). (The `initial` enum value remains available for a future bulk-import path but is not used by the Phase-5 create flow.) Changing `products.stock` after creation is an owner-only catalog edit that *re-bases* the opening count; the recommended correction path for a counted discrepancy is an owner `adjust` movement, not editing `stock`, so the ledger stays the audit trail.

**Duty split:** staff may insert `reason ∈ {restock, sale, void}`; only owners may insert `reason='adjust'` (corrections). This is already enforced by the `stock_movements_staff_insert` policy in `0004` (`reason <> 'adjust' or is_tenant_owner()`). `security-reviewer` confirms staff-restock is the intended division — **no RLS change**.

### Decision 6 — One open shift per branch: **partial unique index `(tenant_id, branch_id) where status='open'` (forward-only migration)** (Q6 → recommend, accepted; **`security-reviewer` signs off**)

Migration `0006` adds `create unique index shifts_one_open_per_branch on public.shifts (tenant_id, branch_id) where status = 'open';` — mirroring the existing `sessions_one_active_per_device` partial-unique index. This guarantees AC 23 at the **database** level, not just in the UI: a second concurrent open shift for the same branch fails the unique constraint regardless of client. Closing a shift (`status → 'closed'`) frees the slot. Single-drawer-per-branch is the intended Phase-5 model; multi-drawer-per-branch is explicitly **not** supported this phase (if ever desired it needs a new ADR and a different index). `security-reviewer` confirms the index is `tenant_id`-leading (ADR-0002) and does not weaken isolation (a unique index is tenant-scoped by its leading column and is orthogonal to the RLS `USING`/`WITH CHECK` predicates, which still apply).

### Decision 7 — Audit `action` / `amount` taxonomy (locked) (Q7 → recommend strings, accepted; **`security-reviewer` signs off**)

Every money-affecting Phase-5 action writes exactly **one** `audit_log` row, idempotent per client UUID. `actor_id = auth.uid()`; `tenant_id` from the trusted JWT claim; `branch_id` set for branch-scoped actions (orders/stock/shifts), null for tenant-scoped (none money-affecting this phase). **Locked taxonomy:**

| `action` | when | `amount` (piastres) | `entity` / `entity_id` | `meta` |
|---|---|---|---|---|
| `order.pay` | a walk-in order → `paid` | order `total` (non-void Σ) | `'order'` / order id | `{ payment_method, shift_id }` |
| `order_item.void` | a single line voided | the voided line amount `qty × unit_price` | `'order_item'` / item id | `{ order_id, product_id, qty, unit_price }` |
| `order.void` | a whole order voided | order `total` at void time (non-void Σ) | `'order'` / order id | `{ payment_method, line_count }` |
| `stock.restock` | a `restock` movement | `delta × cost` if `cost` known, else `null` | `'product'` / product id | `{ movement_id, delta, reason:'restock' }` |
| `stock.adjust` | an owner `adjust` movement | `delta × cost` if `cost` known, else `null` | `'product'` / product id | `{ movement_id, delta, reason:'adjust', note }` |
| `shift.open` | a shift opened | `opening_cash` | `'shift'` / shift id | `{ branch_id, business_day }` |
| `shift.close` | a shift closed | `difference` (counted − expected; **may be negative**) | `'shift'` / shift id | `{ opening_cash, expected_cash, actual_cash, business_day }` |

`amount` semantics are pinned so QA can assert exact rows (AC 31). For stock actions, `amount = delta × cost` when the product carries a `cost`, otherwise `null` (the column is nullable for exactly the uncosted case). The audit insert is owner-read/staff-insert per the existing `audit_log` policies (`0004`) — no policy change; `security-reviewer` confirms the staff-insert `WITH CHECK` pins `tenant_id` from the claim.

### Decision 8 — Order-line rounding: **none — exact integer Σ of `qty × unit_price`; no order-level discount/tax this phase** (Q8 → recommend, accepted by PM)

`qty` and `unit_price` are already integers (piastres), so `computeOrderTotal = Σ (qty × unit_price)` over non-void lines is an **exact integer sum with no rounding** — unlike time billing, which rounds minutes per segment. There are **no order-level discounts or taxes** this phase (the session-level `discount` is applied once by the pricing engine via `computeGrandTotal`, never per order line; the discount-entry UI remains deferred). This keeps order totals trivially reconstructible from line snapshots (AC 8/33).

---

## Options considered (for the load-bearing choices)

### Business-day boundary (Decision 1)

#### Option A — Configurable cutover hour, default 06:00 — **CHOSEN**
- Pros: matches late-night-café reality (a 01:00 session belongs to "yesterday"); owner-configurable via existing `settings` jsonb (no schema change); pins Phase-6 reporting deterministically; a single pure helper drives shifts now and reports later.
- Cons: one more pure helper and a `settings` read on the report/attribution path (trivial; cached).
- Evidence: trial's day-boundary handling for late sessions (`D:\K3\Pochinki\src\features\shifts\` day-grouping). General guidance that "business day ≠ calendar day" for hospitality reporting and that the cutover should be configurable: https://learn.microsoft.com/azure/architecture/best-practices/api-design (versioned, explicit time semantics) and date-bucketing as a pure, timezone-aware function — store UTC, bucket in business tz (consistent with `CLAUDE.md` §2.3 and the existing `dayTypeAt` Cairo pattern).

#### Option B — Raw Cairo calendar day (00:00–24:00)
- Pros: simplest; no setting; no helper parameter.
- Cons: splits a single late-night shift across two report days; surprises owners; reversing it later silently re-buckets historical revenue. Rejected — the cost of getting the reporting boundary wrong is high and hard to reverse.

### Order-line void model (Decision 2)

#### Option A — `is_void` + `voided_at` columns on `order_items` — **CHOSEN**
- Pros: piastre-accurate per-line correction; original snapshot preserved (auditable, AC 10/33); totals are a simple `where is_void=false` filter; existing `order_items_all` RLS covers the update unchanged.
- Cons: a 2-column forward-only migration (small) + `security-reviewer` sign-off.
- Evidence: append-only / soft-state correction pattern — https://learn.microsoft.com/azure/architecture/patterns/event-sourcing (never mutate history; record the correction).

#### Option B — Order-level void only
- Pros: no migration.
- Cons: cannot correct one wrong line on a multi-line order (fails AC 10); forces voiding/re-keying the whole order. Rejected.

#### Option C — Negative-qty compensating line
- Pros: no schema change; preserves history.
- Cons: pollutes the line list; naive `Σ qty×unit_price` would double-count unless every consumer knows to net them; "what is on the bill" becomes ambiguous; harder stock-void mapping. Rejected for correctness clarity.

### Stock decrement commit point (Decision 4)

#### Option A — Decrement at `paid`/close; warn-and-allow oversell — **CHOSEN**
- Pros: one ledger write per finalized sale; no reversal for abandoned/edited carts; matches "money moved"; oversell stays a visible, un-clamped signal (consistent with the existing `inventory` design).
- Cons: live on-hand does not reflect items sitting in an open cart (acceptable — the badge warns; the count is only authoritative at finalization).
- Evidence: existing `inventory` module contract (on-hand may go negative, never clamped — `packages/core/src/inventory/stock.ts`); idempotent finalization aligns with `CLAUDE.md` §2.8.

#### Option B — Decrement at add-time; block on negative
- Pros: live on-hand reflects the cart.
- Cons: every void/abandon needs a reversal write (more ledger churn, more idempotency surface); blocking refuses a real cash sale on a stale count (bad for a cash business). Rejected.

### One-open-shift-per-branch (Decision 6)

#### Option A — Partial unique index — **CHOSEN**
- Pros: DB-guaranteed single drawer (AC 23) independent of any client; mirrors the proven `sessions_one_active_per_device` pattern; `tenant_id`-leading (ADR-0002).
- Cons: forecloses multi-drawer-per-branch without a new ADR (intended this phase).
- Evidence: existing `sessions_one_active_per_device` index (`0002` §7); Postgres partial unique index for "one active row per group" — https://www.postgresql.org/docs/current/indexes-partial.html

#### Option B — UI/app-level guard only
- Pros: no migration.
- Cons: a race or a second device can open two drawers; the invariant that the whole reconciliation rests on is not enforced where it matters. Rejected.

---

## The `@ps/core` API contract (what the core-engineer builds)

New pure helpers, integer piastres, **no `Date.now()` in money/aggregation math**, **no framework imports**. They **reuse** the existing `inventory` exports (`computeLevels`, `isTracked`, `stockStatus`, `offsettingVoids`, `inventoryValue`) and `money` (`sumPiastres`, `Piastres`) and `time` (`CAFE_TZ`, the dayjs `tz` plugin) — they do **not** re-implement stock or money math. Suggested files: a new `packages/core/src/orders/order-total.ts` (order/session aggregation), `packages/core/src/shifts/reconciliation.ts` (drawer math), and the `businessDayKey` helper appended to `packages/core/src/time/time.ts` (it is a time helper). Re-export each via its module `index.ts` and the root `packages/core/src/index.ts`. New tests: `order-total.test.ts`, `reconciliation.test.ts`, and `businessDayKey` cases added to the time suite; `purity.test.ts` extended to cover the new modules. Target **>90% line coverage** on the new code.

### 1. Order total (void-aware exact integer sum) — Decision 2 + 8

```ts
/** Minimal shape of an order line the total math needs. */
export interface OrderLineInput {
  qty: number;            // integer >= 1
  unit_price: Piastres;   // integer piastres, snapshot at add-time
  is_void?: boolean;      // default false; voided lines are excluded
}

/**
 * Σ (qty × unit_price) over NON-VOID lines. Exact integer piastres — NO
 * rounding (qty and unit_price are already integers; Decision 8). A line with
 * is_void === true is excluded. Empty / all-void ⇒ 0. Pure; no clock read.
 * Defensive: negative or non-integer qty/unit_price are treated as their
 * Math.round value and qty floored at 0 (a malformed line never inflates a
 * bill); callers pass validated integers.
 */
export function computeOrderTotal(lines: OrderLineInput[]): Piastres;
```

### 2. Session orders total (the `orders_total` the pricing engine folds in) — Decision 3

```ts
/** Minimal shape of an order the session-rollup needs. */
export interface OrderRollupInput {
  status: 'open' | 'paid' | 'void';   // 'void' orders are excluded entirely
  lines: OrderLineInput[];            // the order's lines (void-aware via computeOrderTotal)
}

/**
 * Σ of computeOrderTotal(order.lines) over the session's NON-VOID orders
 * (status !== 'void'). This is exactly the `orders_total` that
 * computeGrandTotal(...) folds into a session's grand_total (ADR-0005 §6) —
 * computeGrandTotal is UNCHANGED; this only produces its input. Empty ⇒ 0.
 * Pure; integer piastres; no clock read.
 *
 * NB: open AND paid orders both count toward orders_total while the session is
 * live (snacks consumed are owed regardless of an order's own status); only a
 * voided ORDER (status==='void') or a voided LINE (is_void) is excluded.
 */
export function computeOrdersTotalForSession(orders: OrderRollupInput[]): Piastres;
```

### 3. Shift cash reconciliation (expected / difference, un-clamped) — Decision 3

```ts
export interface ShiftReconciliationInput {
  opening_cash: Piastres;   // integer piastres >= 0 (the float)
  cash_sales: Piastres;     // integer piastres; Σ CASH-settled session grand_totals
                            //   + CASH walk-in order totals stamped with this shift_id
                            //   (wallet/other/debt EXCLUDED by the caller — Decision 3)
  payouts: Piastres;        // integer piastres; cash paid OUT of the drawer (default 0)
  counted_cash: Piastres;   // integer piastres; the physical count at close (= actual_cash)
}

export interface ShiftReconciliation {
  expected_cash: Piastres;  // opening_cash + cash_sales − payouts
  difference: Piastres;     // counted_cash − expected_cash; positive = OVER, negative = SHORT
}

/**
 * Pure drawer reconciliation:
 *   expected_cash = opening_cash + cash_sales − payouts
 *   difference    = counted_cash − expected_cash   (NOT clamped — short is negative)
 * Integer piastres throughout; no rounding (all inputs are integers); no clock
 * read. The caller is responsible for building `cash_sales` from CASH-settled
 * rows only (Decision 3) — this function sums what it is given, it never queries.
 * `payouts` defaults to 0 if the caller omits it.
 */
export function computeShiftReconciliation(
  input: ShiftReconciliationInput,
): ShiftReconciliation;
```

### 4. Business-day key (Decision 1) — appended to `time`

```ts
/**
 * The business-day key 'YYYY-MM-DD' for an instant, in a tz, shifted by a
 * cutover hour so late-night activity stays on the previous business day.
 * Algorithm: take the local (tz) wall-clock of `atIso`, subtract `cutoverHour`
 * hours, return the resulting local calendar date as 'YYYY-MM-DD'.
 *   cutover 6: 2026-06-12T02:00 Cairo → '2026-06-11';
 *              2026-06-12T06:00 Cairo → '2026-06-12'.
 * Pure: the instant is passed in (no clock read). `tz` defaults to CAFE_TZ;
 * `cutoverHour` defaults to 6 (Decision 1). DST-safe via the dayjs tz plugin
 * already used by dayTypeAt/localHm.
 */
export function businessDayKey(
  atIso: string,
  cutoverHour?: number,   // default 6
  tz?: string,            // default CAFE_TZ
): string;
```

### Reuse (do NOT re-implement)

- **Stock math:** `computeLevels` (on-hand = Σ deltas, may be negative), `isTracked` (`stock != null`), `stockStatus` (`out`/`low`/`ok`/`untracked`), `offsettingVoids` (void-reversal deltas from recorded sales), `inventoryValue` — all from `@ps/core` `inventory`.
- **Money:** `sumPiastres`, `egpToPiastres`, `piastresToEgp`, `formatEgp`, `toArabicDigits`, `Piastres`.
- **Pricing:** `computeGrandTotal` (unchanged — `computeOrdersTotalForSession` produces its `orders_total` input), `reconstructTimeCost`.
- **Time:** `nowIso` (write path only), `CAFE_TZ`, dayjs `tz`.

---

## Forward-only migration (`supabase/migrations/0006_orders_inventory_shifts.sql`)

Backend / supabase-migrate authors this; **`security-reviewer` signs off**. It does **not** weaken any existing `0004` policy.

```sql
-- 0006 — Phase 5 deltas: order-line void + one-open-shift-per-branch
-- Forward-only. No table is created; no existing RLS policy is altered.
-- SECURITY REVIEWER: sign-off required (Decisions 2 & 6).

-- Decision 2 — per-line void on order_items (immutable snapshot preserved).
alter table public.order_items
  add column if not exists is_void   boolean    not null default false,
  add column if not exists voided_at timestamptz;

-- Partial index so non-void line lookups (the hot path for order totals) stay cheap.
create index if not exists order_items_active_idx
  on public.order_items (tenant_id, order_id)
  where is_void = false;

-- Decision 6 — one open shift per branch (mirrors sessions_one_active_per_device).
create unique index if not exists shifts_one_open_per_branch
  on public.shifts (tenant_id, branch_id)
  where status = 'open';
```

**RLS / WITH CHECK consideration (no policy change):**
- `order_items.is_void` / `voided_at` are written by the existing `order_items_all` policy (`for all`, parent-order EXISTS + own tenant + own-row-or-owner) — a void is an UPDATE already covered; a tenant-B user cannot flip the flag on a tenant-A line (`USING` + `WITH CHECK` both gate on the parent order's tenant and owner/own-row). **Verify in `rls-tenant-audit`** (AC 13, 38).
- `shifts_one_open_per_branch` is a constraint, not a policy; the `shifts_insert` `WITH CHECK` (tenant pinned, `manager_id = auth.uid()`, staff) still applies. The unique index is `tenant_id`-leading (ADR-0002) so it cannot collide across tenants. **Verify** a second open shift for a branch is rejected (AC 23) and that the rejection does not leak another tenant's row existence (it cannot — the index is tenant-scoped and RLS hides foreign rows).

---

## Per-engineer hand-off

- **core-engineer:** `computeOrderTotal`, `computeOrdersTotalForSession`, `computeShiftReconciliation`, and `businessDayKey` exactly as signed above — pure, integer piastres, no `Date.now()` in math, >90% coverage; **reuse** the `inventory` module; export via module + root `index.ts`; extend `purity.test.ts`. Do **not** touch `computeGrandTotal`.
- **backend / supabase-migrate:** author `0006` exactly as the DDL above (forward-only; `if not exists` everywhere); seed a realistic catalog per seeded tenant (tracked + untracked products, ≥2 categories) and an opening shift float; wire the Phase-5 `audit_log` actions per the Decision 7 taxonomy; confirm `0004` RLS covers product/order/item/movement/shift writes and owner-only `adjust`. Get `security-reviewer` sign-off before merge.
- **web-engineer:** `apps/web` product catalog (owner CRUD + field validation + soft-deactivate/reactivate; never hard-delete), EGP↔piastres via `egpToPiastres`/`formatEgp`, stock-tracking toggle (tracked ⇒ `stock` integer ≥ 0 = opening count, no `initial` movement; untracked ⇒ `stock = null`), RTL/i18n; owner-only write enforced client-side and verified against RLS.
- **mobile-engineer:** order builder (session-attached folds into `orders_total`; walk-in pays standalone), snapshot `unit_price` at add-time, per-line void (set `is_void`/`voided_at`, recompute order + session `orders_total`, write `order_item.void` audit + stock-void offset for tracked lines), sale → `stock_movements` write at `paid`/close for **tracked** products only (+ void offset via `offsettingVoids`), restock/adjust UI (adjust owner-only), shift open/close + reconciliation via `computeShiftReconciliation`, `shift_id` stamping on sessions/orders, `payment_method` capture per Decision 3; all mutations idempotent client-UUID upserts; RTL/i18n + `formatEgp`/`toArabicDigits`. Cash-only contributes to `cash_sales`.

## Consequences

- **Becomes easy:**
  - One pure helper set drives order totals, the session fold-in (`orders_total` → unchanged `computeGrandTotal`), and the drawer — they cannot disagree.
  - Business-day bucketing is decided once (`businessDayKey`) and inherited by Phase-6 reporting verbatim; no re-litigation.
  - The stock ledger stays the single source of on-hand (`computeLevels` / the view); voids reverse exactly via `offsettingVoids`.
  - No new tables; two tiny column/index deltas; every existing `0004` RLS policy stands unchanged.
- **Becomes hard / watch-outs:**
  - The finalize path (order `paid` / session close) MUST write tracked-sale movements and MUST write void offsets, idempotently keyed by client UUID — gate double-write and double-audit in tests (AC 11/32).
  - Session-attached order items must **not** be settled as their own `order.pay` (would double-count against the session bill) — they reconcile through the session's `payment_method` at close (Decision 3). Gate this in an integration test.
  - `difference` must never be clamped — a short drawer is a negative number the owner needs to see (AC 26).
  - Oversell is allowed: on-hand may go negative; the badge warns but the sale commits (AC 14/21).
- **Follow-up / deferred:** debts/customer-credit + selectable `debt` settlement → later ADR; order-level discount/tax UI → deferred; offline outbox resilience → Phase 8; owner reports/CSV that consume `businessDayKey` → Phase 6; per-branch catalog/pricing → future ADR (ADR-0004 left the door open); multi-drawer-per-branch → new ADR if ever needed.
- **Must verify (Phase-5 QA gates):**
  - Unit (>90% on new core): `computeOrderTotal` exact-sum + void exclusion (Decision 2/8); `computeOrdersTotalForSession` open+paid counted, void order/line excluded; `computeShiftReconciliation` expected/difference incl. negative (not clamped); `businessDayKey` cutover edges (02:00→prev, 06:00→same, DST-spanning instant). Reused `inventory` stays covered.
  - `pricing-engine-guard` / purity: no `Date.now()` in the new math, no floats, no framework imports.
  - `rls-tenant-audit` (AC 38): tenant A↔B isolation on `products`, `orders`, `order_items` (incl. the new `is_void` UPDATE), `stock_movements`, `shifts`; owner-only product write + owner-only `adjust`; own-row/owner orders & shifts; the `shifts_one_open_per_branch` index rejects a second open shift (AC 23) without leaking foreign rows.
  - Full `ps-verify`: tsc 0 errors, jest, `expo export`, `next build`.
  - **`security-reviewer` signs off** on Decisions 2, 6, 7 and AC 5, 13, 19, 30, 38 before the human Phase-5 gate.
</content>
</invoke>
