# Spec — Phase 6: Owner web dashboard + Reports (the analytics surface)

- **Phase:** 6 (Roadmap `docs/ROADMAP.md`) · **Surfaces:** `apps/web` (Next.js — owner dashboard: KPIs, charts, report tables, CSV export — the primary deliverable), `supabase` (read path: aggregation strategy is the central architect decision — views / `security invoker` RPC / etc.; **no new operational tables**), `packages/core` (small pure additions only if §6 elects them — KPI rollups; **reuse** `businessDayKey`, `formatEgp`, `toArabicDigits`, `sumPiastres`). **No `apps/mobile` work this phase.**
- **Owner:** product-manager · **Status:** ready for design/build (pending the §6 architect decisions — chiefly the aggregation strategy ADR)
- **Decision anchors:** [ADR-0002 — isolation model](../adr/0002-tenant-isolation-model-ratified.md) (ACCEPTED) · [ADR-0004 — schema scoping & keys](../adr/0004-tenant-schema-scoping-and-keys.md) (`branch_id` only on `devices/shifts/sessions/orders/stock_movements`; `settings (tenant_id, key)` jsonb; `payment_method = cash|wallet|other|debt`) · [ADR-0005 — pricing/segments](../adr/0005-pricing-engine-segments-and-boundaries.md) (`grand_total = time_total + orders_total − discount`; reconstructible snapshots) · [ADR-0006 — orders/inventory/shifts](../adr/0006-orders-inventory-shifts.md) (**Decision 1 — `businessDayKey(atIso, cutoverHour=6, tz=CAFE_TZ)`** is the canonical business-day boundary every report inherits; Decision 3 — cash-only reconciles; `order_items.is_void`; session-attached orders settle through the session). New decisions this phase are captured as Open Questions (§6) and will land as **ADR-0007 (reporting/aggregation)**.
- **Builds on:** Phases 4 & 5 **write** all the data; Phase 6 only **reads and aggregates** it. Phase 4 made `time_total`/`grand_total`/segments real; Phase 5 made `orders_total`, walk-in `orders`, `order_items` (with `is_void`), `stock_movements`, and `shifts` (opening/expected/actual/difference) real. Nothing in Phase 6 changes how money is computed — it sums what the earlier phases already stored.
- **Already built (consume / extend, DO NOT re-derive):**
  - **Schema (all reads) — verified columns in `0002_operational_tables.sql` + `0006_orders_inventory_shifts.sql`:**
    - **`sessions`** (branch-scoped): `device_id`, `manager_id`, `shift_id`, `billing_mode`, `status` (`active|closed|void`), `started_at`/`ended_at` (UTC), `time_total`, `orders_total`, `grand_total`, `discount`, `payment_method` (all money int piastres).
    - **`session_segments`** (via session): `play_mode`, `rate_rule_id`, `price_per_hour_snapshot`, `started_at`/`ended_at` — the itemized time breakdown.
    - **`orders`** (branch-scoped): `session_id` (null ⇒ walk-in), `shift_id`, `manager_id`, `total`, `status` (`open|paid|void`), `payment_method`.
    - **`order_items`** (via order): `product_id`, `qty`, `unit_price` (snapshot piastres), **`is_void`** (Phase-5 `0006`), `voided_at`.
    - **`stock_movements`** (branch-scoped): `product_id`, `delta` (±), `reason` (`initial|restock|adjust|sale|void`), `order_id`, `manager_id`, `note`.
    - **`products`** (tenant-scoped): `name` (Arabic), `category`, `price`, `cost` (nullable), `stock` (nullable=untracked), `is_active`.
    - **`shifts`** (branch-scoped): `opened_at`/`closed_at`, `opening_cash`, `expected_cash`, `actual_cash`, `difference`, `status`, `manager_id`, `notes`.
    - **`devices`** (branch-scoped): `name`, `device_type`, `status`.
    - **`audit_log`** (owner-read / staff-insert per `0004`): `action`, `entity`, `entity_id`, `amount`, `meta`, `actor_id`, `created_at`.
    - **`product_stock_levels` view** (`security_invoker = true`): `on_hand = initial_stock + Σ deltas`.
    - **`settings (tenant_id, key)`**: `business_day` → `{ "cutover_hour": 6 }` (ADR-0006 Decision 1; default 6 when absent).
  - **RLS — already complete in `0004_rls_policies.sql`:** every table is staff-read or owner-read and tenant-isolated; `audit_log_owner_select` gates audit reads to owners. **No new operational-table RLS is expected**; the only RLS question is how the chosen aggregation mechanism (view / function / RPC) preserves tenant isolation (§6 Q1).
  - **`@ps/core`:** `money` (`formatEgp`, `egpToPiastres`, `piastresToEgp`, `sumPiastres`, `toArabicDigits`, `Piastres`), `time` (`CAFE_TZ`, `dayTypeAt`, **`businessDayKey`**, `WEEKEND_DAYS=[5,6]`, `nowIso`), `inventory` (`computeLevels`, `stockStatus`, `inventoryValue`), the pricing engine (`reconstructTimeCost`, `computeGrandTotal`).
  - **`apps/web` foundation:** `@supabase/ssr` server/middleware clients (`src/lib/supabase/*`), `AuthContext`, dashboard shell + `BranchSelect`, and reusable `EmptyState`/`ErrorState`/`Skeleton`/`StatusPill` UI. Reports live under `apps/web/src/app/dashboard/reports/`.
- **References:** `docs/reference/core-api.md` (money/time/inventory), `docs/reference/schema-and-rls.md`, `docs/reference/design-approach.md`, `CLAUDE.md` §2 / §4 / §5 / §6.
- **Trial (learning input only — never import/copy):** `D:\K3\Pochinki\src\features\reports\` (sound KPI definitions, day-grouping, and the revenue split) — re-derive cleaner, generalized for tenancy + the business-day cutover.

---

## 1. Problem & goal

After Phase 5 a café can run a full day — sell time and snacks, track stock, reconcile a drawer — but the **owner has no way to see how the business is doing**. Every figure exists in the database (closed sessions with `grand_total`, paid walk-in orders, the stock ledger, closed shifts with their variance) and is locked behind the counter/mobile surface. The owner cannot answer the questions that decide how they run the business: *How much did I make this week? How much of that was time vs. snacks? Which products sell? Which devices earn their floor space? Did my shifts balance, or am I leaking cash?*

Phase 6 delivers the **owner web dashboard + reports**: a read-only analytics surface on `apps/web` that aggregates the data Phases 4–5 already write, scoped to the owner's tenant (RLS), bucketed by the **business day** (Cairo + tenant cutover hour, ADR-0006 Decision 1), filterable by a **date range** and **branch**, with **KPI cards, charts, drill-down report tables, and CSV export** of every table. It is **analytics only** — it reads existing rows, it never writes operational data and never re-computes money (it sums the stored integer-piastre figures).

**The win:** an owner opens the dashboard, picks "this week", optionally narrows to one branch, and sees gross revenue split into time vs. orders, session and device-utilization metrics, the best-selling products, and a shift-reconciliation summary — every number derived from stored snapshots, correct to the piastre, in Arabic-first RTL with Arabic-Indic numerals, and exportable to CSV for their accountant.

**Roles touched:** `owner` (the sole audience — full tenant analytics across all branches or filtered to one). `manager`/`staff` are **not** the audience for Phase 6 and do not get the dashboard (§6 Q8 confirms the role gate). `super_admin` cross-tenant analytics is **Phase 7**.

---

## 2. In scope / out of scope

### In scope

**Reporting period & scope controls (`apps/web`)**
- A **date-range picker expressed in business-day terms** (presets: Today, Yesterday, Last 7 days, This month, Last month, Custom). The range is a pair of **business-day keys** (`'YYYY-MM-DD'`, ADR-0006 `businessDayKey`), converted to the UTC instant bounds that queries filter on — **never** naive UTC calendar days. A late-night session that began at 01:00 Cairo counts in the *previous* business day, consistently across every KPI, chart, and table.
- A **branch filter** (All branches / a specific branch) — an owner-facing UX convenience, **not** a security boundary (RLS already isolates the tenant; ADR-0004: branch is an ordinary FK within the tenant). "All branches" aggregates every branch of the tenant.
- The tenant's configured `cutover_hour` (default 6) and `Africa/Cairo` drive all bucketing; weekend = Fri/Sat where weekday/weekend splits are shown.

**Revenue KPIs (`apps/web`)**
- **Gross revenue**, **time revenue**, **orders revenue**, **discounts**, and **net** for the selected range/branch, defined precisely (see §4 revenue model + ACs) to **avoid double-counting** session-attached orders (which already fold into a session's `grand_total`).
- A **payment-method mix** (cash vs. wallet vs. other) of settled revenue.
- KPI cards show the figure via `formatEgp` + Arabic-Indic numerals, with the count behind each (e.g. number of sessions, number of paid walk-in orders).

**Session & device metrics (`apps/web`)**
- **Session count** (closed sessions in range), **average session duration** (from `started_at`/`ended_at`), and a **billing-mode breakdown** (open / prepaid / fixed-match counts).
- **Device utilization**: per device, the **busy minutes** in range and a **utilization %** against the defined available window (see §6 Q3 for the denominator — flagged), plus revenue attributed per device.

**Product metrics (`apps/web`)**
- **Top products** by **quantity sold** and by **revenue** (Σ `qty × unit_price` over **non-void** order lines), in range/branch, with category grouping; uses the `cost` snapshot to show gross margin **only where `cost` is known** (null cost ⇒ margin shown as "—", never a fabricated number).

**Shift reconciliation summary (`apps/web`)**
- Over the range/branch: per **closed** shift — `opening_cash`, `expected_cash`, `actual_cash` (counted), `difference` (over/short, color-coded, **never clamped**) — plus totals (Σ expected, Σ counted, Σ variance) and a count of short/over/balanced shifts.

**Report tables + CSV (`apps/web`)**
- Drill-down **tables**: **per-business-day** (revenue split, sessions, orders), **per-device** (utilization, revenue), **per-product** (qty, revenue, margin-where-known), and the **per-shift** reconciliation table.
- **CSV export** of each table: UTF-8 **with BOM**, correct escaping (quotes/commas/newlines), Arabic text preserved, numbers exported as **plain machine-readable values** (integer EGP or decimal — see §6 Q6) so a spreadsheet/accountant can consume them; the displayed (Arabic-Indic) rendering is a UI concern only.

**Charts (`apps/web`)**
- **Revenue over time** — bar (or line) per business-day across the range, optionally stacked time vs. orders.
- **Revenue split** — time vs. orders (and discounts) as a small donut/stacked bar.
- **Top products** — horizontal bar (top N by revenue or qty, toggle).
- **Device utilization** — bar per device (% or busy-minutes).
- **Payment-method mix** — donut (cash/wallet/other).
- Chart library/approach is an architect/ux call (§6 Q7); charts must render RTL-correctly with Arabic-Indic numeric labels and be readable empty.

**States & correctness**
- **Empty** (no data in range), **loading** (skeletons), and **error** (query failure / RLS denial) states for every KPI, chart, and table, per `design-approach.md`.
- A **large-range guard**: the dashboard must stay responsive for a wide range (e.g. a year) — the performance/aggregation approach is the central architect decision (§6 Q1) and pagination/row-cap policy is flagged (§6 Q5).

**Design**
- Fresh RTL/Arabic-first dashboard UX via `ui-ux-pro-max` + magic MCP. Currency via `formatEgp`; digits via `toArabicDigits` where the trial did.

### Out of scope (deferred — and why)
- **Super-admin / cross-tenant platform analytics / impersonation** → **Phase 7.** Phase 6 is strictly within one tenant via the owner's claim.
- **Offline / cached-report sync / realtime auto-refresh** → **Phase 8.** Reports are fetched on demand; a manual refresh is fine. No outbox.
- **Stripe / SaaS subscription revenue analytics** (the café's *own* sales are in scope; the platform's billing of the café is not) → **Phase 9.**
- **Scheduled / emailed / PDF reports, saved report presets, alerting/thresholds** → **later phase.** CSV-on-demand is the only export this phase.
- **Mobile reports / a manager mini-dashboard** → not this phase (owner web only; §6 Q8). If managers ever need a branch view it is a later, separately-specced surface.
- **Writing any new operational data, new audit *taxonomy for operations*, or new money math** → none. Phase 6 reads. (The only possible *new* write is an optional `report.export` audit row — §6 Q4, flagged, defaulting to off.)
- **Debts / customer-credit analytics** → deferred with the debts feature (the `debt` payment method is inert; ADR-0006 Decision 3). Debt rows are excluded from cash/revenue KPIs the same way wallet/other are.
- **Per-branch pricing/catalog override analytics, profit/P&L with labour/rent, tax reporting** → future (no data model for them yet).
- **Forecasting / predictive analytics / cohort retention** → not in the MVP.

---

## 3. User stories

- **As an `owner`**, I want a dashboard that shows my gross revenue for a date range and how it splits into time vs. snacks (orders) and discounts, so that I understand where my money comes from and can price/stock accordingly.
- **As an `owner`**, I want to filter every report by a business-day date range and (optionally) a single branch, so that I can compare locations and look at exactly the period I care about — with late-night sessions counted in the right day.
- **As an `owner`**, I want session and device-utilization metrics, so that I can see how busy my floor is and which devices earn their space.
- **As an `owner`**, I want a top-products report by quantity and revenue, so that I know what sells and what to restock or drop.
- **As an `owner`**, I want a shift-reconciliation summary across a range showing expected vs. counted cash and the variance per shift, so that I can spot drawers that don't balance and hold staff accountable.
- **As an `owner`**, I want to export any report table to CSV that opens correctly in Arabic with the right numbers, so that I can hand it to my accountant or analyze it myself.
- **As an `owner`/`security-reviewer`**, I want every report query to be RLS-scoped to my tenant so that no other café's numbers can ever appear, even via a tampered branch id or a crafted request.

---

## 4. Data model & the revenue model (reads only)

**No new operational tables.** Phase 6 reads the columns listed in the header. The only schema-adjacent question is *how* aggregation is exposed (raw-row client aggregation vs. SQL views vs. `security invoker` functions/RPC vs. materialized views) — **architect decision §6 Q1 → ADR-0007**. Whatever the mechanism, it MUST preserve tenant RLS (materialized views, which do **not** enforce the querying user's RLS, are the key hazard to rule on).

### Canonical figures (so KPIs are unambiguous and testable)

All over the selected business-day range and branch scope, integer piastres, computed from **stored** values (never re-derived from current rules/catalog):

- **Time revenue** = Σ `sessions.time_total` over **closed** sessions (`status='closed'`).
- **Orders revenue** = Σ (non-void `order_items.qty × unit_price`) across **both** session-attached **and** paid walk-in orders, excluding `status='void'` orders and `is_void` lines. Equivalently: Σ `sessions.orders_total` (closed sessions) + Σ paid walk-in `orders.total` (non-void).
- **Discounts** = Σ `sessions.discount` over closed sessions.
- **Gross revenue (collected)** = Σ `sessions.grand_total` (closed) **+** Σ paid walk-in `orders.total` (non-void). This is the **no-double-count** figure: `grand_total` already = `time_total + orders_total − discount`, and session-attached orders are settled *through* the session (ADR-0006 Decision 3), so they are **not** added again as standalone order payments. Walk-in orders (`session_id = null`) are the only orders added on their own.
- **Cash revenue** = the subset of Gross settled with `payment_method='cash'` (session settlement method for sessions; order payment_method for walk-ins). `wallet`/`other`/`debt` are reported in the mix but excluded from the cash line (mirrors ADR-0006 Decision 3 drawer rule).
- **Net** = Gross − Discounts is **already** reflected in `grand_total`; the dashboard shows Gross (net of discount) and Discounts separately rather than re-subtracting (so it cannot double-count discount). The exact KPI label set is confirmed in §6 Q2.

> These definitions are deliberately explicit because the time-vs-orders split and the session-vs-walk-in settlement model are the easiest place to double-count. §6 Q2 asks the architect/PM to ratify them before build.

### Time/bucketing semantics
- A session/order/shift is attributed to a business day via `businessDayKey(anchor_iso, cutover_hour, 'Africa/Cairo')`. **Anchor** per entity (confirm in §6 Q2): sessions → `started_at` (or `ended_at`?), walk-in orders → the pay instant / `created_at`, shifts → `opened_at` (ADR-0006 Decision 1 already pins shifts to `opened_at`).
- The range `[fromKey, toKey]` (inclusive business-day keys) maps to a UTC `[fromInstant, toInstant)` half-open window; **where** that mapping happens (SQL vs. `@ps/core`) is §6 Q1.

---

## 5. Acceptance criteria (numbered, testable — Given/When/Then)

> Money is **integer piastres** in every money AC; displayed via `@ps/core formatEgp` + Arabic-Indic digits; **no money math or formatting inlined in the UI**. Time is **UTC stored**, bucketed in **Africa/Cairo** with the tenant `cutover_hour` (default 6) via `@ps/core businessDayKey`; weekend = Fri(5)+Sat(6). Every figure is read from **stored** rows — Phase 6 never recomputes a bill from current rules/catalog. Every query is **RLS-scoped to the signed `app_metadata.tenant_id` claim**.

### A. Core helpers / business-day bucketing (`@ps/core`, pure — only if §6 Q1 elects helpers)
1. **Given** an instant `at_iso` and the tenant `cutover_hour` (default 6), **when** its business day is computed, **then** it equals `businessDayKey(at_iso, cutover_hour, 'Africa/Cairo')` — e.g. `2026-06-12T02:00+02:00` (Cairo) with cutover 6 → `'2026-06-11'`, and `…T06:00` → `'2026-06-12'` — and the same instant near a DST transition still maps to a single well-defined key (reuse ADR-0006's tested helper; do **not** re-implement).
2. **Given** a selected range of business-day keys `[fromKey, toKey]`, **when** it is converted to a query window, **then** it produces a half-open UTC `[fromInstant, toInstant)` such that exactly the rows whose anchor's `businessDayKey` falls in `[fromKey, toKey]` are included — verified at a UTC instant that is a different calendar day in UTC vs. Cairo (timezone-boundary case) and across a cutover edge (a 01:00 session lands in the prior key).
3. **Given** any KPI rollup helper added in `@ps/core` this phase (if §6 Q1 elects them, e.g. a revenue-split or utilization reducer), **when** tested, **then** it is **pure** (no `Date.now()`, no framework/Supabase import), operates on integer piastres with exact sums (`sumPiastres`), and is covered at **>90% line coverage**; if §6 Q1 keeps aggregation in SQL, no new core money math is added and this AC is N/A (recorded as such).

### B. Backend / aggregation (read path; tenant-isolated)
4. **Given** the chosen aggregation mechanism (view / `security invoker` function / RPC / raw-row read — §6 Q1), **when** any owner of **tenant A** runs any report, **then** only **tenant-A** rows contribute to every figure; **no** tenant-B row is ever read or aggregated, including via a tampered/guessed `branch_id` — proven by `rls-tenant-audit` over the report path (AC 26).
5. **Given** the dashboard's revenue figures, **when** computed for a range/branch, **then** they equal the §4 canonical definitions exactly: **Time revenue** = Σ closed `sessions.time_total`; **Orders revenue** = Σ non-void order-line totals (session-attached + walk-in); **Discounts** = Σ closed `sessions.discount`; **Gross** = Σ closed `sessions.grand_total` + Σ paid non-void walk-in `orders.total` — with **no double-counting** of session-attached orders (a snack on a session appears in Orders revenue and inside that session's Gross, but is **not** added a second time as a standalone order payment).
6. **Given** a session that is still `active` or a session/order that is `void`, **when** revenue is aggregated, **then** it is **excluded** (only `closed` sessions and non-void paid orders / non-void lines count); a voided order line (`is_void=true`) contributes **0** to Orders revenue and to top-products.
7. **Given** the cash/payment mix, **when** computed, **then** **Cash revenue** counts only `payment_method='cash'` settlements (session settlement + walk-in order method), and `wallet`/`other`/`debt` are reported in the mix but **excluded** from the cash line — consistent with ADR-0006 Decision 3.
8. **Given** device utilization for a range/branch, **when** computed, **then** each device's **busy minutes** = Σ over its closed sessions of `min(ended_at, rangeEnd) − max(started_at, rangeStart)` (clamped to the range, never negative), and **utilization %** = busy minutes ÷ the agreed available-window denominator (§6 Q3) — a device with no sessions shows 0% (not an error).
9. **Given** the top-products report, **when** computed, **then** each product's **qty** = Σ non-void `order_items.qty` and **revenue** = Σ non-void `qty × unit_price` over the range/branch, grouped by `product_id` and ordered descending; a product with a null `cost` shows margin as "—" (never a fabricated margin), and an inactive/deactivated product still appears if it sold in range (history preserved).
10. **Given** the shift-reconciliation summary, **when** computed for a range/branch, **then** it lists each **closed** shift with `opening_cash`, `expected_cash`, `actual_cash`, and `difference = actual − expected` exactly as stored (Phase-5 `computeShiftReconciliation` output, **never re-derived or clamped**), plus correct totals (Σ expected, Σ counted, Σ difference) and counts of short(<0)/over(>0)/balanced(=0) shifts.
11. **Given** a large range (e.g. a full year), **when** a report runs, **then** it returns within the agreed performance budget and applies the agreed row-cap/pagination policy (§6 Q5) without dropping rows from the aggregates silently (a capped *table* still reflects accurate *totals*).

### C. Web dashboard (`apps/web`, owner-only)
12. **Given** a signed-in **owner**, **when** they open `/dashboard/reports`, **then** they see the KPI cards, charts, and report tables for the default range (e.g. Last 7 days) scoped to their tenant; a signed-in **manager/staff** is **denied** the reports surface (redirect/403 per the role gate, §6 Q8) — reports are owner-only.
13. **Given** the date-range picker, **when** the owner selects a preset or a custom range, **then** the range is interpreted in **business-day** terms (Cairo + cutover), every KPI/chart/table re-queries for that range, and the active range is visibly labelled; an invalid custom range (from > to) is blocked with a field-level message and no query fires.
14. **Given** the branch filter, **when** the owner picks "All branches" vs. a specific branch, **then** every figure recomputes for that scope; "All branches" aggregates the whole tenant and a single-branch view shows only that branch — and switching branch **never** exposes another tenant's data (branch is a within-tenant filter, not a security boundary).
15. **Given** the revenue KPI cards, **when** rendered, **then** Gross / Time / Orders / Discounts / Cash each display the §4 figure via `formatEgp` with Arabic-Indic numerals, each with its supporting count (e.g. N sessions, M walk-in orders), and the displayed Gross equals the report table totals (KPIs and tables agree to the piastre).
16. **Given** the charts (revenue-over-time, revenue split, top products, device utilization, payment mix), **when** rendered, **then** each reflects the same underlying figures as the KPIs/tables for the range/branch, renders **RTL-correctly** with Arabic-Indic numeric labels, and shows a readable empty state when the range has no data.
17. **Given** any KPI/chart/table, **when** the query is loading, **then** a skeleton/loading state shows; **when** the range has no data, **then** an explicit **empty** state shows (not a zero that looks like an error vs. a blank); **when** a query fails (network/RLS), **then** an **error** state with a retry shows — per `design-approach.md`.
18. **Given** a report table (per-day / per-device / per-product / per-shift), **when** the owner clicks **Export CSV**, **then** a UTF-8 **BOM**-prefixed CSV downloads with the table's columns, correct escaping (fields with `,`/`"`/newline are quoted, embedded quotes doubled), **Arabic text intact** (opens correctly in Excel/Sheets), and numeric columns as **machine-readable values** (per §6 Q6) — the export content matches the on-screen rows for the current range/branch.
19. **Given** the dashboard, **when** the owner refreshes/re-queries, **then** the figures reflect the **current** stored data (a session closed a minute ago appears) — reports are read-on-demand; no stale cache is shown without a refresh affordance (and if a materialized view/cache is chosen in §6 Q1, its staleness window is disclosed in the UI).

### D. RTL / i18n
20. **Given** every user-facing string on the dashboard (KPI labels, chart legends/axes, table headers, range presets, branch filter, empty/error copy, CSV column headers), **when** inspected, **then** it comes from **i18n resources** (Arabic-first), with **RTL** layout, and **no hardcoded** user-facing copy (CLAUDE.md §2.6).
21. **Given** every money/numeric display (KPIs, chart labels, table cells, percentages, durations, counts), **when** rendered, **then** currency uses `@ps/core formatEgp` and digits use Arabic-Indic numerals via `toArabicDigits` where the trial did — **no** inline currency math, **no** hardcoded Western digits in the UI (CLAUDE.md §2.1, §4). (CSV values are exempt — they are machine-readable per §6 Q6.)
22. **Given** charts in an RTL layout, **when** rendered, **then** axes, legends, ordering, and tooltips read right-to-left correctly (time axis flows in the locale's natural direction; horizontal bars label on the correct side) — no clipped or mirrored-illegibly labels.

### E. Audit & security
23. **Given** Phase 6 is read-only, **when** the owner views reports, **then** **no** operational `audit_log` row is written for viewing; the **only** possible audit write is an optional `report.export` row on CSV export **iff** §6 Q4 elects it (default: not written) — and if elected, it is owner-actor, tenant-scoped, with the export descriptor in `meta` and `amount=null`.
24. **Given** audit-log-backed views (if any report reads `audit_log`, e.g. a "voids & adjustments" or "discounts" trail), **when** a **manager/staff** somehow reaches it, **then** `audit_log_owner_select` denies the read (owners only) — no staff sees the audit trail through a report.
25. **Given** the aggregation mechanism chosen in §6 Q1, **when** `security-reviewer` audits it, **then** it is confirmed to run with the **querying user's** RLS in force (e.g. `security invoker` views/functions, not `security definer` that bypasses RLS, and **not** a materialized view exposed without a RLS-enforcing wrapper) — tenant isolation cannot be bypassed through the report path.
26. **Given** the full report read surface, **when** `rls-tenant-audit` runs, **then** tenant A↔B isolation holds on every report query (sessions, orders, order_items, stock_movements, shifts, products, audit_log, devices) — a tenant-A owner cannot read tenant-B figures via any report, branch filter, or crafted request — and **`security-reviewer` signs off** before the human gate.

### F. Verification (`ps-verify`)
27. **Given** the completed work, **when** `ps-verify` runs, **then** `tsc --noEmit` passes with **0 errors** across `@ps/core` / `apps/web` (and `apps/mobile` stays green — untouched); `jest` passes including any new `@ps/core` report-helper suite at **>90% line coverage** on new code (or N/A per AC 3 if aggregation stays in SQL); `next build` produces a successful web production build; `expo export` still builds (no mobile regression).
28. **Given** the read/aggregation surface and any §6 Q1 SQL objects (views/functions), **when** `rls-tenant-audit` runs, **then** isolation holds (AC 26), the aggregation mechanism is RLS-preserving (AC 25), and **`security-reviewer` signs off**; RTL/i18n coverage (`rtl-i18n-check`) passes for the new dashboard (AC 20–22).

---

## 6. Open questions (for the architect / design / human) → drive ADR-0007

1. **Aggregation strategy + RLS interaction (architect + `security-reviewer`) — THE central decision.** How are KPIs/tables computed? Options: (a) **client-side aggregation** of RLS-scoped raw rows fetched via the `@supabase/ssr` client (simplest, RLS automatic, but heavy for wide ranges and ships rows to the client); (b) **Postgres views** (`security_invoker=true`, like `product_stock_levels`) that pre-shape per-day/per-product rollups (RLS preserved, set-based, but parameterizing the range/cutover in a view is awkward); (c) **`security invoker` SQL functions / RPC** (`create function … security invoker`, called via `supabase.rpc`) taking `(from, to, branch, cutover)` and returning aggregates (parameterizable, set-based, RLS in force — likely the sweet spot, but more SQL to own and test); (d) **materialized views** (fast for huge ranges but **do NOT enforce the querying user's RLS** — a serious isolation hazard requiring a RLS-enforcing wrapper + refresh strategy). **Recommend (c) `security invoker` RPC for the heavy rollups, with (a) client aggregation acceptable for small/cheap slices**, and **reject (d) unless wrapped**. This decision shapes where business-day bucketing lives (Q2/Q1-coupling), the performance budget (Q5), and CSV generation (Q6). **Pin in ADR-0007 before build.** Do **not** decide here.
2. **Revenue model ratification + per-entity day anchor (architect + product-manager).** Confirm the §4 canonical figures (esp. that session-attached orders are **not** double-counted, and Gross = Σ closed `grand_total` + Σ paid walk-in `orders.total`). Confirm the **business-day anchor** per entity: sessions by `started_at` vs `ended_at` (revenue recognised at start or close?), walk-in orders by pay-instant vs `created_at`; shifts are already `opened_at` (ADR-0006). **Recommend** sessions anchored at **`started_at`** (when play began) and walk-ins at pay-time; confirm.
3. **Device-utilization denominator (architect + product-manager).** Utilization % = busy ÷ *what*? Options: (a) **24h × days in range** (simple, but cafés aren't open 24h so % looks artificially low); (b) the tenant's **operating hours** (no operating-hours model exists yet — would need a setting); (c) the **observed open window** (first-open to last-close per business day). **Recommend (a) for v1** (report busy-minutes as the primary, utilization % against 24h as secondary and clearly labelled), defer an operating-hours setting. Confirm — this only affects a derived %, not money.
4. **Audit report exports? (product-manager + `security-reviewer`).** Should a CSV export of financial data write a `report.export` audit row (data-exfil traceability)? **Recommend default OFF this phase** (read-only phase; revisit in Phase 10 hardening), but flag for security-reviewer; if ON, pin the action string + `meta` shape.
5. **Performance budget, row-cap & pagination (architect).** What is the acceptable latency for the widest expected range, and what is the row-cap/pagination policy for the **tables** (the **aggregates/totals must stay exact** even if a table is paginated — AC 11)? **Recommend** server-side aggregation (Q1c) so totals are computed in SQL regardless of table pagination, with tables paginated/virtualized at e.g. 100 rows. Confirm budget + caps.
6. **CSV numeric format + locale (product-manager).** CSV numbers: export as **integer piastres**, **decimal EGP** (e.g. `12.50`), or formatted? And Western vs. Arabic-Indic digits in the file? **Recommend decimal EGP with Western digits + UTF-8 BOM** for accountant/spreadsheet compatibility (the *on-screen* values stay Arabic-Indic via `formatEgp`/`toArabicDigits`); confirm the column set per table and the decimal/thousands convention.
7. **Chart library & RTL approach (architect + ux-designer).** Which charting approach for Next.js that renders **RTL-correctly** with Arabic-Indic labels and stays light in the bundle (e.g. Recharts / visx / a lightweight SVG approach via the magic MCP)? **Recommend** the ux-designer pick via `ui-ux-pro-max` with an RTL + Arabic-numeral label adapter; confirm so `next build` bundle stays reasonable.
8. **Role gate confirmation (product-manager + architect).** Confirm reports are **owner-only** (manager/staff denied), matching "owner dashboard". Should a manager ever see a **read-only single-branch** view of their own branch? **Recommend owner-only this phase**; a manager branch view is a later, separately-specced surface. Confirm the redirect/403 behavior for non-owners.

---

## 7. Hand-off

### architect must decide (blocks build) → ADR-0007
- **Q1 Aggregation strategy + RLS interaction** (client raw-rows vs. `security_invoker` views vs. `security invoker` RPC vs. materialized-view-with-wrapper) — **the central decision**; blocks the entire read path, performance, and CSV location. Materialized views must not bypass RLS (AC 25).
- **Q2 Revenue model + per-entity business-day anchor** — blocks every KPI/table (AC 5) and bucketing (AC 1–2).
- **Q3 Device-utilization denominator** — blocks utilization (AC 8).
- **Q5 Performance budget + row-cap/pagination** (aggregates stay exact) — blocks the large-range guard (AC 11).
- **Q1/Q6 CSV generation location** (client vs. server, tied to Q1) + numeric format — blocks export (AC 18).
- With `security-reviewer`: **Q4 export auditing** (default off), and confirm the aggregation mechanism is **RLS-preserving** (AC 25–26, 28). No new operational-table RLS expected; any new SQL view/function gets `security-reviewer` sign-off.

### ux-designer must design (fresh, `ui-ux-pro-max` + magic MCP — Arabic-first / RTL; not the trial's look)
- **Dashboard layout:** KPI card row (Gross/Time/Orders/Discounts/Cash with supporting counts); the date-range picker (business-day presets + custom, with the invalid-range message); the branch filter; a clear "range + scope" header.
- **Charts (Q7):** revenue-over-time (bar/line per business-day, stacked time vs orders), revenue split donut, top-products horizontal bar (qty/revenue toggle), device-utilization bar, payment-mix donut — all RTL with Arabic-Indic labels and readable empty states.
- **Report tables:** per-day, per-device, per-product (with margin "—" where cost unknown), per-shift reconciliation (over/short color-coding, never clamped) — each with an **Export CSV** affordance.
- **States:** loading (skeletons), empty (per range), and error (with retry) for every KPI/chart/table; a non-owner denied state (Q8).
- All strings via i18n; no hardcoded copy; currency/digits via `@ps/core`.

### engineers build
- **core (only if Q1 elects helpers):** small **pure** report rollups (e.g. revenue-split / utilization reducers) over integer piastres using `sumPiastres`; **reuse** `businessDayKey`, `formatEgp`, `toArabicDigits` — do **not** re-implement bucketing or money math; >90% coverage; no `Date.now()`/framework imports. If Q1 keeps aggregation in SQL, core is untouched (AC 3 N/A).
- **backend / supabase-migrate:** author the Q1-approved read mechanism (e.g. `security invoker` reporting functions/RPC or rollup views) — **forward-only, no operational-table changes, no RLS weakening**; ensure business-day/range parameters map correctly (Q1/Q2); `security-reviewer` sign-off (AC 25–26).
- **web engineer:** `apps/web/src/app/dashboard/reports/*` — owner-only route gate; date-range (business-day) + branch controls; KPI cards, charts (Q7), and report tables wired to the Q1 read path via `@supabase/ssr`; CSV export (UTF-8 BOM, escaping, Arabic-safe, Q6 numeric format); loading/empty/error states; RTL/i18n; currency/digits via `@ps/core`.

### QA gates on (the testable success checks)
- **Bucketing/helpers:** AC 1–3 (business-day key incl. cutover + DST edge; range→UTC window; pure >90% or N/A).
- **Aggregation correctness:** AC 4–11 (tenant-only contribution; exact §4 revenue with **no double-count**; active/void exclusion; cash-only mix; utilization; top-products incl. margin-where-known + sold-but-inactive; shift summary un-clamped; large-range totals exact under pagination).
- **Web:** AC 12–19 (owner-only gate; business-day range + branch re-query; KPI⇄table agreement to the piastre; charts reflect same figures + RTL; loading/empty/error; CSV BOM+escaping+Arabic-safe; read-on-demand freshness/staleness disclosure).
- **RTL/i18n:** AC 20–22 (`rtl-i18n-check`; `formatEgp`/`toArabicDigits`; RTL charts).
- **Audit/security:** AC 23–26 — `security-reviewer` signs off on AC 25 (RLS-preserving aggregation) and AC 26 (`rls-tenant-audit` A↔B over the whole report path).
- **Full `ps-verify`:** AC 27 (tsc 0 errors, jest incl. >90% new-core-or-N/A, `next build`, `expo export` no-regression) + AC 28.
- Residual-risk note for the human gate: aggregation strategy + revenue-anchor pending ADR-0007 (Q1/Q2); device-utilization denominator is a labelled approximation (Q3); export auditing default-off (Q4); charts/CSV locale per Q6/Q7; scheduled/emailed/PDF reports, manager views, and super-admin cross-tenant analytics deferred (Phases 7/later); offline/realtime deferred (Phase 8).
