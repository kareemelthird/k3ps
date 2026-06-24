# Spec — Phase 5: Products + Orders + Inventory + Shifts (daily ops complete)

- **Phase:** 5 (Roadmap `docs/ROADMAP.md`) · **Surfaces:** `apps/web` (Next.js — owner product catalog CRUD), `apps/mobile` (Expo — order builder, walk-ins, stock-adjust, shift open/close + reconciliation), `packages/core` (small additions: order-total + cash-reconciliation math; reuse the existing `inventory` ledger), `supabase` (RLS/audit wiring on already-defined tables; minimal column additions only if §6 decides so)
- **Owner:** product-manager · **Status:** ready for design/build (pending the §6 architect decisions)
- **Decision anchors:** [ADR-0002 — isolation model](../adr/0002-tenant-isolation-model-ratified.md) (ACCEPTED) · [ADR-0004 — schema scoping & keys](../adr/0004-tenant-schema-scoping-and-keys.md) (`branch_id` placement; `payment_method = cash|wallet|other|debt`) · [ADR-0005 — pricing/segments](../adr/0005-pricing-engine-segments-and-boundaries.md). New decisions this phase are captured as Open Questions (§6).
- **Builds on:** [Phase 4 spec](phase-4-pricing-engine.md) — the pricing engine computes `grand_total = Σ segment time costs + orders_total − discount`. Phase 4 deliberately closed sessions with `orders_total = 0` and `shift_id = null`. **Phase 5 makes `orders_total` real (the order builder) and makes `shift_id` real (shift open/close + cash reconciliation).** The engine's `computeGrandTotal` signature already accepts `orders_total`, so no pricing-core churn is required.
- **Already built (consume / extend, DO NOT re-derive):**
  - **Schema — almost everything Phase 5 needs already exists in `supabase/migrations/0002_operational_tables.sql`:** `products` (`name`, `category`, `price` piastres, `cost` piastres nullable, `stock` int nullable = untracked, `is_active`), `orders` (`session_id` nullable, `shift_id` nullable, `manager_id`, `total` piastres, `status` `open|paid|void`, `payment_method`), `order_items` (`order_id`, `product_id`, `qty`, `unit_price` piastres snapshot), `stock_movements` (`product_id`, `delta` ±, `reason` `initial|restock|adjust|sale|void`, `order_id` nullable, `manager_id`, `note`), `shifts` (`manager_id`, `opened_at`, `closed_at`, `opening_cash`, `expected_cash`, `actual_cash` nullable, `difference` nullable, `notes`, `status` `open|closed`), the `product_stock_levels` view (`on_hand = initial_stock + Σ deltas`, `security_invoker = true`), and the `payment_method` / `order_status` / `stock_reason` / `shift_status` enums.
  - **RLS — defined in `0004_rls_policies.sql`:** `products` = staff-read / **owner-write**; `orders` = own-row (`manager_id = auth.uid()`) OR owner; `order_items` = parent-order EXISTS + tenant; `shifts` = own-row OR owner (staff insert with own `manager_id`); `stock_movements` = staff-read, **staff-insert except `reason='adjust'` which is owner-only**, owner update. `audit_log` = owner-read / staff-insert.
  - **`@ps/core`:** `money` (`egpToPiastres`, `piastresToEgp`, `formatEgp`, `sumPiastres`, `toArabicDigits`), `id` (`uuidv4`), `time` (`CAFE_TZ`, `dayTypeAt`, `nowIso`, weekend=Fri/Sat), and **`inventory`** (`computeLevels` on-hand = Σ deltas, `isTracked` = `stock != null`, `stockStatus`, `offsettingVoids`, `inventoryValue`, `LOW_STOCK_DEFAULT`). The pricing engine (`computeGrandTotal`, segment math) from Phase 4.
- **References:** `docs/reference/core-api.md` (inventory ledger + money), `docs/reference/schema-and-rls.md`, `docs/reference/mobile-patterns.md`, `docs/reference/design-approach.md`, `CLAUDE.md` §2 / §3 / §4 / §5.
- **Trial (learning input only — never import/copy):** `D:\K3\Pochinki\src\features\inventory\`, `…\shifts\`, `…\debts\` (sound ledger/reconciliation ideas and their invariants). Re-derive any new math fresh in `packages/core`.

---

## 1. Problem & goal

After Phase 4, a café can price and run **time** correctly, but it cannot run a **day**. Counter staff sell snacks and drinks (attached to a playing customer or as a walk-in), the floor consumes stock, and at the end of a shift someone counts the cash drawer and has to know whether it balances. Today none of that is wired: sessions close with `orders_total = 0`, no products can be sold, stock is never decremented, and there is no drawer to reconcile against. The owner has no catalog to manage.

Phase 5 completes **daily operations**:

1. **Product catalog** (owner, web; readable on mobile) — a tenant-wide list of sellable items with an Arabic name, a category, an integer-piastres price, an active flag, and **optional** stock tracking. CRUD with validation and **soft-deactivate** (never hard-delete), mirroring the Phase-4 rate-rule editor pattern so historical bills stay reconstructible.
2. **Orders + order items** (mobile counter) — build an order of catalog items either **attached to an active session** (its total folds into that session's `grand_total` via `orders_total`) or as a **standalone walk-in** (paid on its own). Each line snapshots `unit_price` at add-time (price locked, integer piastres); per-item **void** writes audit. Idempotent client-UUID writes.
3. **Inventory / stock ledger** — every stock-affecting event (a sale of a tracked product, a manual adjust, a restock) writes an **immutable** `stock_movements` row; current on-hand is `Σ deltas` via `@ps/core inventory.computeLevels` / the `product_stock_levels` view. A mobile stock-adjust UI captures a **reason + note + audit**. Untracked products (`stock = null`) sell without writing a movement.
4. **Shifts + cash reconciliation** — open a shift with an **opening float**, close it with **counted cash vs. expected**, where `expected = opening_cash + cash sales − payouts`. The **variance** is computed in `@ps/core` (pure), stored on the shift, and audited. **One open shift per branch** at a time. Only **cash** counts toward the drawer; `wallet`/`other`/`debt` are excluded from `expected_cash`.

**The win:** a counter can run an entire day end-to-end — sell time and snacks, track stock, and hand over a drawer that reconciles to the piastre — all multi-tenant, RLS-isolated, and auditable.

**Roles touched:** `owner` (manages the catalog on web; can adjust stock; sees/closes any shift), `manager`/`staff` (build orders, sell, restock, open/close their own drawer on mobile). `super_admin` is out of scope (Phase 7).

---

## 2. In scope / out of scope

### In scope

**`@ps/core` (small, pure additions — reuse the existing `inventory` module; >90% coverage on new code)**
- `computeOrderTotal(items)` — `Σ (qty × unit_price)` over **non-void** items, integer piastres, no float, **no per-line rounding** (price and qty are already integers; total is an exact sum). A parallel "void-aware" total that excludes voided lines.
- `computeOrdersTotalForSession(orders)` — `Σ` of the totals of the session's **non-void** orders → the `orders_total` the pricing engine folds into `grand_total` (no change to `computeGrandTotal`; this just produces its input).
- `computeShiftReconciliation({ opening_cash, cash_sales, payouts, counted_cash })` → `{ expected_cash, difference }` where `expected_cash = opening_cash + cash_sales − payouts` and `difference = counted_cash − expected_cash` (positive = over, negative = short). Integer piastres; `difference` is allowed to be negative; no clamping.
- **Reuse** `inventory.computeLevels` / `isTracked` / `stockStatus` / `offsettingVoids` for stock math — do **not** re-implement.

**`apps/web` — owner product catalog**
- List the active tenant's `products` (owner can write; manager read-only), filterable by category and active/inactive.
- Create / edit / deactivate (soft `is_active=false`) / re-activate a product with field-level validation (see ACs), mirroring the rate-rule editor.
- Per-product **stock-tracking toggle**: tracked (`stock` = an integer opening count) vs. untracked (`stock = null`). Editing the catalog does **not** mutate the ledger; the opening count is recorded once via an `initial`/`restock` movement (see §6 Q5).

**`apps/mobile` — order builder, walk-ins, stock adjust, shifts**
- **Order builder:** pick catalog items (active, in-stock-or-untracked), set qty, see the running line total and order total; attach the order to the **currently active session on a device** OR start a **walk-in** order (no session). Each line snapshots `unit_price` from the catalog at add-time.
- **Per-item void:** void a line (status/soft removal) — recomputes the order total and, if the order is session-attached, the session's `orders_total`; writes an audit row.
- **Session fold-in:** for a session-attached order, the session's `orders_total` reflects `Σ` of its non-void orders, so the close summary's `grand_total` includes snacks (Phase-4 engine, unchanged).
- **Walk-in pay:** a standalone order is marked `paid` with a `payment_method` (cash/wallet/other); cash walk-ins contribute to the shift's `expected_cash`.
- **Stock decrement on sale:** when a **tracked** product is sold (order moves to `paid`, or per the §6 Q4 decision, at add-time), a `stock_movements` row (`reason='sale'`, negative `delta`, `order_id` set) is written. Untracked products write **no** movement.
- **Stock-adjust / restock UI:** capture a signed delta + `reason` (`restock` for + receipts; `adjust` for corrections — owner-only) + a `note`; write one immutable `stock_movements` row + audit. On-hand updates via the ledger.
- **Shift open:** open a shift for the active branch with an `opening_cash` float; blocked if a shift is already open for that branch.
- **Shift close:** show **expected** (computed via `@ps/core` from opening + cash sales − payouts), capture **counted** cash, store `expected_cash` / `actual_cash` / `difference`, set `status='closed'` + `closed_at`, write audit. New sessions/orders during a shift carry that `shift_id`.

**Design**
- Fresh RTL/Arabic-first UX for the catalog (web) and the order builder / stock-adjust / shift open-close screens (mobile) via `ui-ux-pro-max` + magic MCP. Arabic-Indic numerals where the trial displayed them; currency via `formatEgp`.

### Out of scope (deferred — and why)
- **Super-admin portal / cross-tenant tooling / impersonation** → **Phase 7**.
- **Owner reports / KPIs / charts / date-range revenue / product-mix / CSV export** → **Phase 6.** Phase 5 writes the *data* (orders, movements, shift reconciliations); Phase 6 reads/aggregates it. The only aggregation in Phase 5 is the per-shift reconciliation needed to close a drawer.
- **Offline outbox / dead-letter / realtime multi-tenant sync** → **Phase 8.** Idempotent client-UUID upserts are required now (orders, items, movements, shift open/close); full queue resilience is not.
- **Stripe / SaaS subscription billing** → **Phase 9** (unrelated to the café's own cash).
- **Prepaid top-up / extend / expiry & discount-entry UI** → still deferred (Phase-4 decision). `discount` remains an engine input defaulting to 0; no discount UI unless §6 finds it trivially needed. Prepaid `prepaid_minutes` stays advisory.
- **Debts / customer-credit feature** (`debts`, `debt_payments` tables exist with `tenant_id`; the `debt` payment method is inert) → **deferred** beyond Phase 5 unless §6 Q3 elects to include `debt` as a walk-in/session payment method. Default: **out of scope this phase**; if a session/order is settled as `debt`, it is **excluded from `expected_cash`** (like wallet/other), and no debt-ledger UI ships.
- **Per-branch product catalog / per-branch pricing overrides** → future ADR (ADR-0004 keeps `products` tenant-wide).
- **Purchase orders / supplier management / multi-warehouse / stock transfers between branches** → not in the gaming-café MVP.
- **Barcode scanning, receipt printing** → later hardening.

---

## 3. User stories

- **As an `owner`**, I want to manage a product catalog (Arabic name, category, price in EGP, active flag, optional stock tracking) on the web, so that my counter can sell a consistent, correctly-priced menu across the business.
- **As an `owner`**, I want to deactivate a discontinued product instead of deleting it, so that past orders that reference it stay intact and reconstructible.
- **As an `owner`**, I want only owners to make stock *corrections* (adjust) while staff can record normal restocks and sales, so that drawer- and stock-affecting overrides are controlled and audited.
- **As an `owner`/`manager`**, I want every shift to close with a clear expected-vs-counted cash figure and a recorded variance, so that I can hold the counter accountable and spot shortages.
- **As a `manager`/`staff` operator**, I want to add snacks/drinks to a customer's active session, so that everything they consumed is on one bill when they leave.
- **As a `manager`/`staff` operator**, I want to ring up a walk-in who only buys a drink (no device), so that I can sell to customers who aren't playing.
- **As a `manager`/`staff` operator**, I want each line's price locked when I add it, and the ability to void a wrong line, so that the bill is exactly what was sold and mistakes are corrected, not hidden.
- **As a `manager`/`staff` operator**, I want selling a tracked product to decrement its stock automatically and untracked items (e.g. brewed coffee) to sell without a count, so that inventory stays accurate without false alarms.
- **As a `manager`/`staff` operator**, I want to open my drawer with a starting float and close it by counting cash against an expected total, so that I can prove my shift balanced.
- **As an `owner`/`security-reviewer`**, I want every money-affecting action (order pay, item void, stock adjust, shift close) to write an `audit_log` row with actor, tenant, branch, timestamp, and amount, so that the day's money is fully traceable.

---

## 4. Data model touchpoints

**No new tables are expected.** Phase 5 exercises columns already in `0002_operational_tables.sql`. Any addition below is flagged as a §6 decision.

### Reused as-is (verified columns)
- **`products`** (tenant-scoped, owner-write RLS): `name` (Arabic), `category` (text, default `''`), `price` (int piastres), `cost` (int piastres, nullable — uncosted), `stock` (int, **nullable = untracked**), `is_active`. CRUD writes (owner-only) are **new this phase**.
- **`orders`** (branch-scoped, own-row/owner RLS): `session_id` (**nullable** → walk-in when null; FK `on delete set null`), `shift_id` (nullable), `manager_id`, `total` (int piastres), `status` (`open|paid|void`), `payment_method`. Writes are **new this phase**.
- **`order_items`** (tenant_id for RLS; branch via parent order): `order_id`, `product_id`, `qty`, `unit_price` (int piastres **snapshot at add-time**). Writes are **new this phase**. **NB:** there is no per-row `status`/void column yet — see §6 Q2 (line-void modeling).
- **`stock_movements`** (branch-scoped): `product_id`, `delta` (± int), `reason` (`initial|restock|adjust|sale|void`), `order_id` (nullable, links a sale movement to its order), `manager_id`, `note`. **Immutable ledger** — inserts only (owners may correct via owner-update policy). Writes are **new this phase**.
- **`shifts`** (branch-scoped, own-row/owner RLS): `opened_at`, `closed_at`, `opening_cash` (int piastres), `expected_cash` (int piastres), `actual_cash` (int, nullable until close), `difference` (int, nullable until close), `notes`, `status` (`open|closed`). Open/close writes are **new this phase**.
- **`sessions.orders_total`** (int piastres) and **`sessions.shift_id`**: Phase 4 left these at 0 / null. Phase 5 maintains `orders_total` from session-attached orders and stamps `shift_id` at session start.
- **`audit_log`**: new `action` values this phase — `order.pay`, `order_item.void` (or `order.void`), `stock.adjust`, `stock.restock`, `shift.open`, `shift.close` (see §6 Q7 taxonomy). `amount` = the money figure (order total / line amount / adjust value / shift difference). `actor_id`, `tenant_id`, `branch_id`.
- **`product_stock_levels` view** (`security_invoker = true`): `on_hand = initial_stock + Σ deltas`. Read path for current stock on mobile/web.

### Possible additions (only if §6 decides)
- **`order_items` line-void:** either an `is_void boolean` / `voided_at timestamptz` column on `order_items` (preferred for an immutable per-line audit), OR model void as deleting the line + an audit row, OR a compensating "void line" with negative qty. **Architect call (§6 Q2).**
- **A "uniqueness" guard for one-open-shift-per-branch:** a **partial unique index** `(tenant_id, branch_id) where status='open'` on `shifts` — analogous to the existing `sessions_one_active_per_device`. **Architect call (§6 Q6).** (Today nothing enforces single-open-shift at the DB level.)
- **`stock_reason` for sales by staff:** the enum already has `sale`; confirm the RLS `staff-insert except adjust=owner-only` lets staff write `reason='sale'`/`'restock'`/`'void'` and only blocks `'adjust'` (it does — verified in `0004`). **No change expected**, but `security-reviewer` confirms restock-by-staff is intended (§6 Q5).

**RLS:** all policies already exist (`0004`). No policy *shape* change is expected; `security-reviewer` confirms: owner-only product writes, own-row/owner order & shift writes, staff stock inserts with owner-only `adjust`, and that **cross-tenant** order/item/movement/shift writes are rejected by `WITH CHECK`. If §6 adds a shift partial-unique index or an `order_items.is_void` column, those land in a new forward-only migration with `security-reviewer` sign-off.

---

## 5. Acceptance criteria (numbered, testable — Given/When/Then)

> Money is **integer piastres** (100 = 1 EGP) in every money AC; never floats; sums are exact (no per-line rounding for orders). Time is **UTC ISO stored**, business-day / shift / weekend logic **computed in Africa/Cairo**; weekend = Friday(5)+Saturday(6). Stock on-hand = `Σ deltas` via `@ps/core inventory`. Cost/reconciliation math takes values/instants as arguments — **no `Date.now()` inside `@ps/core`**.

### A. Product catalog (`apps/web`, owner-only write; readable on mobile)
1. **Given** a signed-in **owner**, **when** they open the catalog, **then** they see only the **active tenant's** `products` (RLS-scoped; no other tenant's products ever appear), can filter by category and active/inactive, and can create/edit/deactivate; a signed-in **manager** sees the catalog **read-only** (no write controls) — both on web and as a read source on mobile.
2. **Given** the product form, **when** the owner saves, **then** validation enforces: `name` required (non-empty, Arabic-capable text); `price` required, integer **piastres** `>= 0`; `category` optional (defaults `''`); `cost` optional, integer piastres `>= 0` when present; stock-tracking is an explicit toggle (tracked ⇒ `stock` = integer `>= 0`; untracked ⇒ `stock = null`); invalid input blocks save with a field-level error and **no** row is written.
3. **Given** money fields in the catalog editor, **when** the owner enters EGP, **then** the value is converted to integer **piastres** via `@ps/core egpToPiastres` for storage and rendered back via `formatEgp` — `price` and `cost` columns are integer piastres, never floats.
4. **Given** a saved product, **when** the owner deactivates it, **then** `is_active` becomes `false` (soft delete — **not** hard-deleted, so existing `order_items` referencing it stay intact and reconstructible) and it no longer appears in the mobile order builder's sellable list, while past orders that include it still render its snapshot `unit_price`.
5. **Given** an owner of **tenant A**, **when** they attempt (via tampered request) to create/update a product with `tenant_id` = tenant B, **then** RLS `WITH CHECK` rejects the write; a **manager** attempting any product write is rejected by the owner-only `products_owner_write` policy.

### B. Orders & order items (`apps/mobile`, own-row/owner)
6. **Given** a device with an **active session**, **when** the operator adds a catalog item to that session's order, **then** an `orders` row exists with `session_id` = that session, `branch_id`/`tenant_id`/`manager_id` set, and an `order_items` row with `qty >= 1` and `unit_price` = the product's catalog `price` **snapshotted at add-time** (integer piastres) — and a later catalog price change does **not** alter that stored `unit_price`.
7. **Given** no device/session, **when** the operator starts a **walk-in** order and adds items, **then** an `orders` row is created with `session_id = null` (a standalone walk-in) and `order_items` rows with snapshot `unit_price`; the order can be paid independently of any session.
8. **Given** an order with multiple lines, **when** the order total is computed, **then** `total = Σ (qty × unit_price)` over **non-void** lines via `@ps/core computeOrderTotal`, integer piastres, **exact sum with no per-line rounding**, and the stored `orders.total` equals that value.
9. **Given** a **session-attached** order, **when** its total changes (line added/voided), **then** the parent session's `orders_total` is recomputed as `Σ` of that session's **non-void** orders via `@ps/core`, and the session's `grand_total` (Phase-4 engine = `Σ segments + orders_total − discount`) reflects the snacks — verified by closing the session and seeing the order amount in the bill.
10. **Given** a line added in error, **when** the operator **voids** that line, **then** the line is excluded from the order total (per the §6 Q2 void model), the order total (and any parent session `orders_total`) recomputes, and an `audit_log` row records the void with the line's amount — the original line data is **not** silently mutated away (auditable correction, not deletion of history).
11. **Given** an order add/void retried with the **same** client-generated UUID(s) (network retry / double-tap), **when** both reach the server, **then** the order/line is written **once** (idempotent upsert), the total is correct, and **no** duplicate line or duplicate `audit_log` row is produced (CLAUDE.md §2.8).
12. **Given** a **walk-in** order, **when** it is marked `paid` with a `payment_method`, **then** `orders.status='paid'`, `payment_method` is stored, the order carries the current open shift's `shift_id`, and an `audit_log` row (`action='order.pay'`, `amount = total`) is written.
13. **Given** an order of **tenant A**, **when** a tenant-B user attempts to read or add items to it, **then** RLS rejects it (orders own-row/owner + tenant; `order_items` parent-EXISTS + tenant) — no cross-tenant order access.

### C. Inventory / stock ledger (`@ps/core` + write path)
14. **Given** a set of `stock_movements` for a product, **when** on-hand is computed, **then** it equals the product's opening count **+ `Σ` deltas** via `@ps/core inventory.computeLevels` (equivalently the `product_stock_levels.on_hand`), and the value **may be negative** (oversell signal, never clamped).
15. **Given** a **tracked** product (`stock != null`) is sold, **when** the sale is committed (at the §6 Q4 commit point — order `paid` or add-time), **then** exactly one immutable `stock_movements` row is written with `reason='sale'`, `delta = −qty`, `order_id` linking the order, `manager_id`, `branch_id`/`tenant_id` — and on-hand decreases by `qty`.
16. **Given** an **untracked** product (`stock = null`) is sold, **when** the sale is committed, **then** **no** `stock_movements` row is written for it and selling it never produces a stock warning (CLAUDE.md / `inventory.isTracked`).
17. **Given** a sale movement is later **voided** (its order/line voided), **when** the void is committed, **then** an offsetting `stock_movements` row (`reason='void'`, `delta = +qty`, same `order_id`) is written via `@ps/core inventory.offsettingVoids`, so `sale + void = 0` and on-hand is restored exactly — **even if** the product was untracked at void time but tracked at sale time (the void follows the recorded sale, not the current flag).
18. **Given** a **restock** (goods received), **when** a staff member records it, **then** one immutable `stock_movements` row with `reason='restock'`, positive `delta`, a `note`, and `manager_id` is written; on-hand increases by `delta`; an `audit_log` row records it.
19. **Given** a stock **adjust** (correction), **when** a **non-owner** attempts it, **then** the `stock_movements_staff_insert` RLS policy **rejects** it (`reason='adjust'` is owner-only); **when** an **owner** records an adjust with a signed `delta` + `note`, **then** one immutable movement (`reason='adjust'`) + an `audit_log` row (`action='stock.adjust'`, `amount` = the value impact or null per §6 Q7) are written.
20. **Given** `stock_movements` is an append-only ledger, **when** any correction is needed, **then** it is made by writing a **new** movement (adjust/void), **not** by editing/deleting a past movement from the counter — staff inserts only; only owners may update (corrections), and every change is reflected as a new ledger row so on-hand stays reconstructible from the movement history.
21. **Given** a product whose on-hand is at or below its low threshold (`LOW_STOCK_DEFAULT` or per-product), **when** the order builder lists it, **then** `@ps/core inventory.stockStatus` drives its badge (`out`/`low`/`ok`/`untracked`) and an out-of-stock tracked product is flagged (sale still permitted but warned — oversell is visible, not blocked, per §6 Q4a).

### D. Shifts & cash reconciliation (`apps/mobile` + `@ps/core`, own-row/owner)
22. **Given** no open shift for the active branch, **when** the operator opens a shift with an `opening_cash` float (integer piastres `>= 0`), **then** a `shifts` row is created with `status='open'`, `opened_at = nowIso()` (UTC ISO), `manager_id = auth.uid()`, `branch_id`/`tenant_id`, and an `audit_log` row (`action='shift.open'`, `amount = opening_cash`).
23. **Given** an already-open shift for a branch, **when** a second shift open is attempted for that same branch, **then** it is **blocked** (UI + the one-open-shift-per-branch guard per §6 Q6), and no second open shift is created.
24. **Given** an open shift, **when** sessions and orders are created during it, **then** they carry that shift's `shift_id`, so the shift can attribute its cash sales (the set of `paid` cash orders + session cash settlements stamped with this `shift_id`).
25. **Given** a shift's cash sales, opening float, and payouts, **when** expected cash is computed, **then** `@ps/core computeShiftReconciliation` returns `expected_cash = opening_cash + cash_sales − payouts` where **`cash_sales` includes only cash-settled** orders/sessions (`payment_method='cash'`) — `wallet`, `other`, and `debt` are **excluded** from the drawer (integer piastres).
26. **Given** the operator counts the drawer at close, **when** they enter `counted_cash` (= `actual_cash`, integer piastres), **then** `difference = counted_cash − expected_cash` is computed in `@ps/core` (positive = over, negative = short, **not clamped**), and `shifts.expected_cash`/`actual_cash`/`difference` are stored exactly as computed.
27. **Given** a shift close, **when** it completes, **then** `status='closed'`, `closed_at = nowIso()` (UTC ISO), the reconciliation fields are persisted, and an `audit_log` row (`action='shift.close'`, `amount = difference`) is written; the close is **idempotent** (a retried close with the same identifiers closes once, writes totals once, one audit row).
28. **Given** the business-day boundary for shift/reporting attribution, **when** a shift's day is determined, **then** it is derived in **Africa/Cairo** (a shift opened late at night belongs to the Cairo calendar day per §6 Q1's definition), and all timestamps are stored UTC and converted with the Cairo plugin — never the device's local zone.
29. **Given** a non-cash settlement during the shift (wallet/other/debt), **when** the drawer is reconciled, **then** that amount does **not** appear in `expected_cash` (only the physical-cash line reconciles), so a balanced drawer is unaffected by digital payments.
30. **Given** a shift of **tenant A** / another manager, **when** a tenant-B user (or a non-owner who is not the shift's manager) attempts to read or close it, **then** RLS rejects it (`shifts` = tenant AND (own `manager_id` OR owner)); an owner of the same tenant **can** view/close any of the tenant's shifts.

### E. Audit & idempotency
31. **Given** any money-affecting action this phase (order pay, item/order void, stock restock, stock adjust, shift open, shift close), **when** it completes, **then** exactly **one** `audit_log` row exists for it with `action` from the §6 Q7 taxonomy, `actor_id = auth.uid()`, the row's `tenant_id` (+ `branch_id`), a timestamp, and `amount` = the relevant money figure (CLAUDE.md §2.7).
32. **Given** any Phase-5 mutation (order, item, movement, shift open/close) is retried with the **same** client-generated UUID, **when** both reach the server, **then** the effect is applied **once** (idempotent upsert) with **no** double-counted total, **no** duplicate ledger movement, and **no** duplicate audit row (CLAUDE.md §2.8).
33. **Given** a stored order and its `order_items` snapshots (qty + `unit_price`), **when** the order total is recomputed later **without** consulting the current catalog, **then** it equals the `orders.total` stored at pay-time — every order is reconstructible from its line snapshots, independent of later price/active changes.
34. **Given** a closed shift and the set of its cash-settled orders/sessions, **when** the reconciliation is recomputed from stored rows via `@ps/core`, **then** it reproduces the stored `expected_cash` and `difference` — the drawer is reconstructible (CLAUDE.md §2.7).

### F. RTL / i18n
35. **Given** every user-facing string on the new web (catalog) and mobile (order builder, walk-in, stock adjust, shift open/close) screens, **when** inspected, **then** it comes from **i18n resources** (Arabic-first), with RTL layout, and **no hardcoded** user-facing copy (CLAUDE.md §2.6).
36. **Given** every money/numeric display on the new screens (prices, line totals, order total, opening/expected/counted cash, variance, on-hand counts), **when** rendered, **then** currency uses `@ps/core formatEgp` and displayed digits use Arabic-Indic numerals via `toArabicDigits` where the trial did — **no** inline currency math or hardcoded digits (CLAUDE.md §2.1, §4).

### G. Verification (`ps-verify`)
37. **Given** the completed work, **when** `ps-verify` runs, **then** `tsc --noEmit` passes with **0 errors** across `@ps/core` / `apps/mobile` / `apps/web`; `jest` passes including the new order-total / reconciliation / inventory suites at **>90% line coverage** on the new `packages/core` code (and the reused `inventory` module stays covered); `expo export` builds the mobile bundle; `next build` produces a successful web production build.
38. **Given** the new/changed RLS surface (product writes, order/item writes, stock inserts incl. owner-only `adjust`, shift open/close, plus any §6 migration), **when** `rls-tenant-audit` runs, **then** tenant A↔B isolation holds on `products`, `orders`, `order_items`, `stock_movements`, `shifts` (no cross-tenant read/write), the owner-only and own-row predicates hold, and **`security-reviewer` signs off** before the human gate.

---

## 6. Open questions (for the architect / design / human)

1. **Business-day boundary definition (architect + product-manager).** A "business day" governs shift attribution now and reporting in Phase 6. Two candidates: (a) the **Cairo calendar day** (00:00–24:00 Africa/Cairo), or (b) a **configurable day-cutover hour** (e.g. 06:00 Cairo) so a café open past midnight keeps a late session on the *previous* business day. The trial and most late-night cafés want a cutover. **Recommend define the business day as Cairo-local with a tenant `settings.day_cutover_hour` (default 06:00)**, computed in `@ps/core` (pure, instant + cutover in, day-key out). Pin this now because Phase-6 reports inherit it. Confirm the default and whether shifts use the cutover or just `opened_at`'s Cairo date.

2. **Order-line void modeling (architect).** `order_items` has **no** void/status column today. Options: (a) add `is_void boolean` + `voided_at` to `order_items` (immutable per-line audit, totals filter on `is_void=false`) — **recommended**; (b) void the whole `orders` row only (no partial void) — simpler but can't correct one wrong line; (c) compensating negative-qty "void line". **Recommend (a)** for piastre-accurate, auditable per-line correction; needs a small forward-only migration + `security-reviewer` sign-off. Confirm.

3. **Cash vs. non-cash payment modeling + `debt` (architect + product-manager).** `payment_method` enum is `cash|wallet|other|debt`. Confirm: (a) **only `cash` reconciles** to the drawer; `wallet`/`other`/`debt` are recorded but excluded from `expected_cash` (assumed in AC 25/29). (b) Is `debt` selectable as a settlement this phase (deferring the *debt-ledger UI* but allowing "put it on the tab"), or fully out of scope? **Recommend: cash-only reconciliation; allow recording `wallet`/`other` on walk-ins/sessions; keep `debt` out of the UI this phase** (the enum value stays inert), revisit with the debts feature. (c) Where is a session's settlement `payment_method` captured — at close — and does a session settled non-cash get excluded from the drawer the same way? Confirm.

4. **Stock-decrement commit point + oversell policy (architect + product-manager).** When does a tracked sale write its `stock_movements` row: (a) at **order `paid`** (clean, one ledger write per finalized sale, matches "money moved") — **recommended**; or (b) at **add-time** (live on-hand reflects the cart, but voids/abandoned orders need reversal). Also: if on-hand would go **negative**, do we **block** the sale or **warn-and-allow**? **Recommend warn-and-allow** (oversell is a visible signal per `inventory` design, never clamped — AC 14/21), decrement at `paid`. Confirm both.

5. **Opening-stock & restock authorship (architect + security-reviewer).** When a product is created **tracked** with an opening count, is that count recorded as (a) the `products.stock` column only (the view's `initial_stock`), or (b) also/instead an `initial` `stock_movements` row? The view already sums `initial_stock + Σ deltas`, so setting `products.stock` alone is consistent — **recommend `products.stock` = the opening count (no separate `initial` movement on create)**, and all subsequent change goes through movements. Also confirm **staff may insert `reason='restock'`** (the `0004` policy allows any non-`adjust` reason for staff) is the intended division of duties. Confirm.

6. **One-open-shift-per-branch enforcement (architect + security-reviewer).** Nothing at the DB level enforces a single open shift per branch today (unlike `sessions_one_active_per_device`). **Recommend add a partial unique index** `shifts_one_open_per_branch on shifts (tenant_id, branch_id) where status='open'` in a forward-only migration, so AC 23 is guaranteed in the DB, not just the UI. Confirm (and whether multiple concurrent managers/drawers per branch is ever desired — if so, this changes).

7. **Audit `action` taxonomy + `amount` semantics (architect + security-reviewer).** Pin the Phase-5 `action` strings and what `amount` means for each: `order.pay` (amount=order total), `order_item.void` (amount=line amount) vs. `order.void` (amount=order total), `stock.restock` (amount=null or `delta×cost`?), `stock.adjust` (amount=null or value impact?), `shift.open` (amount=opening_cash), `shift.close` (amount=difference). **Recommend the strings above; for stock actions set `amount=null` unless `cost` is known, then `delta×cost`.** Confirm so QA can assert exact rows (AC 31).

8. **Order total rounding (product-manager — confirm, low-risk).** Order totals are `Σ (qty × unit_price)` of integers, so there is **no rounding** — unlike time billing. Confirm there are **no order-level discounts/taxes** this phase that would introduce rounding (discount UI is deferred; the session-level `discount` is applied once by the pricing engine, not per order line). **Recommend: no order-line rounding; exact integer sums** — keep it that way.

---

## 7. Hand-off

### architect must decide (blocks build)
- **Q1 Business-day boundary** (Cairo-local + configurable cutover) — blocks shift attribution and Phase-6 reporting; pin now.
- **Q2 Order-line void model** (`order_items.is_void` migration vs. order-level void) — blocks the order builder + AC 8/10.
- **Q3 Cash vs. non-cash + `debt`** — blocks reconciliation math (AC 25/29) and the pay UI.
- **Q4 Stock-decrement commit point + oversell** (paid vs. add-time; warn vs. block) — blocks the sale write path + AC 15/21.
- **Q5 Opening-stock authorship + staff-restock division** — blocks catalog create + restock UI.
- **Q6 One-open-shift-per-branch** partial-unique index (with `security-reviewer`) — blocks AC 23 DB guarantee.
- **Q7 Audit `action`/`amount` taxonomy** (with `security-reviewer`) — blocks every audit AC (31) and QA assertions.
- Confirm **no RLS policy *shape* change** beyond what `0004` ships; any new migration (`order_items.is_void`, `shifts` partial-unique) gets `security-reviewer` sign-off (AC 38).

### ux-designer must design (fresh, `ui-ux-pro-max` + magic MCP — Arabic-first / RTL; not the trial's look)
- **Web (catalog):** product list (filter by category + active/inactive; owner-write vs. manager read-only states); create/edit form with the stock-tracking toggle + EGP price/cost fields + field-level validation; deactivate/reactivate affordance; empty/loading/error states.
- **Mobile (order builder):** item picker with category grouping + stock badge (`out`/`low`/`ok`/`untracked`) + qty stepper + running line/order total; attach-to-session vs. walk-in entry; per-line **void** with confirm + audit; walk-in **pay** sheet (payment method) — all `formatEgp` + Arabic-Indic digits.
- **Mobile (stock):** restock/adjust sheet (signed delta + reason + note; `adjust` owner-only state); on-hand display from the ledger.
- **Mobile (shift):** open-shift sheet (opening float); close-shift screen showing **expected** (computed), **counted** input, and **variance** (over/short, color-coded) + notes; one-open-shift-per-branch blocked state.
- All strings via i18n resources; no hardcoded copy.

### engineers build
- **core:** `computeOrderTotal` (void-aware), `computeOrdersTotalForSession`, `computeShiftReconciliation` (expected/difference) — pure, integer piastres, no `Date.now()`, >90% coverage; **reuse** the `inventory` module (`computeLevels`/`isTracked`/`stockStatus`/`offsettingVoids`) — do not re-implement. If §6 Q1 lands a cutover, add a pure `businessDayKey(at_iso, cutoverHour, tz)` helper.
- **web engineer:** `apps/web` product catalog (owner CRUD + validation + soft-delete + reactivate), EGP↔piastres via `@ps/core`, RTL/i18n; owner-only write enforced client-side and verified against RLS.
- **mobile engineer:** order builder (session-attached + walk-in), per-line void + audit, snapshot `unit_price`, session `orders_total` maintenance, sale→`stock_movements` write (tracked only) + void offset, restock/adjust UI (adjust owner-only), shift open/close + reconciliation via `@ps/core`, `shift_id` stamping; all mutations idempotent client-UUID upserts; RTL/i18n + `formatEgp`/`toArabicDigits`.
- **backend / supabase-migrate:** seed a realistic catalog per seeded tenant (tracked + untracked products, a couple categories) + an opening shift float; author any §6-approved migration (`order_items.is_void`, `shifts` partial-unique) forward-only; confirm `0004` RLS covers product/order/item/movement/shift writes and the owner-only `adjust`; wire the Phase-5 `audit_log` actions per the Q7 taxonomy.

### QA gates on (the testable success checks)
- **Catalog:** AC 1–5 (owner-only, validation, piastres storage, soft-delete keeps history, cross-tenant write rejected).
- **Orders/items:** AC 6–13 (snapshot price, walk-in vs. session, exact-sum total, session fold-in, void + audit, idempotent, cross-tenant rejected).
- **Inventory ledger:** AC 14–21 (on-hand = opening + Σ deltas incl. negative, tracked-only sale movement, untracked no-movement, void offset restores, restock/adjust with owner-only adjust, append-only, stock status badges).
- **Shifts/cash:** AC 22–30 (open float + audit, single-open-shift block, `shift_id` stamping, `expected = opening + cash_sales − payouts`, cash-only reconciliation, variance not clamped, close idempotent + audit, Cairo business-day, non-cash excluded, cross-tenant/own-row RLS).
- **Audit & idempotency:** AC 31–34 (one audit row per action with correct amount, idempotent retries, order + drawer reconstructible from snapshots) — `security-reviewer` signs off on AC 5, 13, 19, 30, 38.
- **RTL/i18n + full `ps-verify`** (tsc 0 errors, jest incl. >90% new-core coverage, `expo export`, `next build`): AC 35–37; `rls-tenant-audit`: AC 38.
- Residual-risk note for the human gate: debts/customer-credit deferred (debt method inert unless §6 Q3 says otherwise); discount/prepaid-topup UI still deferred; offline resilience thin (Phase 8); reports/CSV are Phase 6; the order-line void column and shift partial-unique index depend on §6 Q2/Q6 decisions.
