# Backlog

Living list, owned by `product-manager`. Items get pulled into a phase, specced (`docs/specs/`), and gated by the human. Status: 🔵 ready · 🟡 needs spec · ⚪ idea.

## Phase 5 — Products + Orders + Inventory + Shifts (daily ops complete) — ACTIVE PHASE, needs spec → build
> Spec: [`docs/specs/phase-5-products-orders-inventory-shifts.md`](specs/phase-5-products-orders-inventory-shifts.md) · Anchors: [ADR-0002](adr/0002-tenant-isolation-model-ratified.md) (ACCEPTED), [ADR-0004](adr/0004-tenant-schema-scoping-and-keys.md) (`branch_id` placement; `payment_method=cash|wallet|other|debt`), [ADR-0005](adr/0005-pricing-engine-segments-and-boundaries.md).
> Key fact: the **schema already exists** in `supabase/migrations/0002_operational_tables.sql` (`products`, `orders`, `order_items`, `stock_movements`, `shifts`, `product_stock_levels` view) and RLS in `0004_rls_policies.sql`. `@ps/core/inventory` (on-hand=Σ deltas, void offsets, stock status, valuation) already exists. Phase 5 wires behavior + UI + a few pure core helpers; **no new tables expected** beyond the two §6-conditional additions. Makes Phase-4's `orders_total` and `shift_id` real.
- 🟡 `@ps/core` (small pure additions, >90% on new code): `computeOrderTotal` (void-aware exact integer sum, no per-line rounding), `computeOrdersTotalForSession` (feeds the Phase-4 engine's `orders_total`), `computeShiftReconciliation` (`expected = opening + cash_sales − payouts`, `difference = counted − expected`, not clamped). **Reuse** existing `inventory.computeLevels/isTracked/stockStatus/offsettingVoids` — do not re-implement. (If §6 Q1 accepted) pure `businessDayKey(at_iso, cutoverHour, tz)`.
- 🟡 Web (Next.js) **owner product catalog**: list (owner write / manager read-only, tenant-scoped) filterable by category + active; create/edit/deactivate (soft delete, keeps order history) + reactivate; stock-tracking toggle (tracked int / untracked null); EGP↔piastres via `@ps/core`; cross-tenant write rejected by RLS `WITH CHECK`.
- 🟡 Mobile (Expo) **order builder + walk-ins + stock + shifts**: add catalog items to an active session OR a standalone walk-in; snapshot `unit_price` at add-time; per-line void + audit; session `orders_total` fold-in; walk-in pay (payment method); tracked-product sale → `stock_movements(reason='sale', −qty)` + void offset; untracked = no movement; restock/adjust UI (adjust owner-only) + audit; shift open (float) / close (expected vs counted → variance) via `@ps/core`; one open shift per branch; `shift_id` stamping; all idempotent client-UUID upserts.
- 🟡 Backend: seed a realistic catalog per tenant (tracked + untracked, categories) + opening float; author any §6-approved forward-only migration (`order_items.is_void`, `shifts` partial-unique one-open-per-branch); confirm `0004` RLS covers product/order/item/movement/shift writes + owner-only `adjust`; wire Phase-5 `audit_log` actions (`order.pay`, `order_item.void`, `stock.restock`, `stock.adjust`, `shift.open`, `shift.close`).
- 🟡 Fresh RTL/Arabic-first UX (`ui-ux-pro-max` + magic MCP): catalog (web); order builder + stock badges, walk-in/pay, stock adjust, shift open/close + variance (mobile). `formatEgp` + Arabic-Indic digits.
- 🟡 architect decisions blocking build (spec §6/§7): business-day boundary (Cairo + configurable cutover); order-line void model (`order_items.is_void` migration vs. order-level); cash vs non-cash + `debt` scope; stock-decrement commit point (paid vs add-time) + oversell warn-vs-block; opening-stock authorship + staff-restock division; one-open-shift-per-branch index; audit action/amount taxonomy; (confirm) no order-line rounding.
- ⚪ Out of scope (later phases): owner reports/KPIs/charts/CSV (6); super-admin portal/impersonation (7); offline outbox/dead-letter/realtime (8); Stripe subscriptions (9); debts/customer-credit ledger UI (deferred, `debt` method inert unless §6 Q3); prepaid top-up/expiry + discount UI (still deferred); per-branch catalog/pricing overrides (future ADR); purchase orders/suppliers/stock transfers/barcode/receipt printing (later).

## Phase 4 — Devices + Sessions + Pricing (the pricing engine) — BUILT, pending human gate
> Spec: [`docs/specs/phase-4-pricing-engine.md`](specs/phase-4-pricing-engine.md) · Decision: [ADR-0005](adr/0005-pricing-engine-segments-and-boundaries.md) (ACCEPTED) · Anchors: [ADR-0002](adr/0002-tenant-isolation-model-ratified.md), [ADR-0004](adr/0004-tenant-schema-scoping-and-keys.md). Replaces the Phase-3 single-flat-rate stopgap.
> Status (2026-06-24): core engine + web rate-rule editor + mobile session lifecycle built; code-review + security-review done (all blockers fixed); security SIGN-OFF on RLS/audit; gates green (tsc core/web/mobile, jest 220, next build, expo export). Commits 004338f, aa5df70, 6132420.
> Residual follow-ups: (1) `current_role_in_tenant()` reads `app_metadata->>'roles'` as scalar text while clients treat `roles` as an array (0003_claim_helpers.sql) — pre-existing Phase-2 auth-hook concern; route to the access-token-hook owner before Phase 7 super-admin/impersonation. Fail-closed (can only make the owner check stricter), so non-blocking. (2) Deploy/enable the `custom-access-token-hook` so claims are dynamic (demo currently uses static `app_metadata`).
- 🔵 `@ps/core` pricing engine (primary): `ruleMatches`/`resolveRule` (priority + id tie-break + Cairo day-type + end-exclusive/midnight-wrap window; no-match→null fallback); multi-segment open-meter aggregator (min-charge once at session level, sum never re-rounded); prepaid lock-honoring cost (0 valid, null-fallback); fixed-match cost; segment-boundary helper (ordered boundary instants); `computeGrandTotal` (+orders −discount, clamp ≥0); snapshot-only reconstruction helper. Re-derived from the trial; no import; no `Date.now()` in cost math; no floats; **>90%** coverage; `pricing-engine-guard` green.
- 🔵 Web (Next.js) **owner rate-rule editor**: list (owner write / manager read-only, tenant-scoped); create/edit/deactivate (soft delete) with mode-conditional validation; EGP↔piastres via `@ps/core`; **resolved-rate preview** using the same `resolveRule` the counter uses; cross-tenant write rejected by RLS `WITH CHECK`.
- 🔵 Mobile (Expo) deeper session lifecycle: mode-aware start (open/prepaid/fixed-match) incl. prepaid **locked price** + fixed-match `match_count`; switch play mode mid-session (close+open segment, idempotent client-UUID upsert); live per-segment + total cost derived from timestamps (survives backgrounding); mode-aware close (totals via core → free device → one `session.close` audit row, amount=grand_total); itemized, reconstructible close summary.
- 🔵 Backend: seed realistic rule sets per tenant (open weekday/weekend/peak + prepaid block + fixed-match); confirm owner-only `rate_rules` write policy + `WITH CHECK`; (if accepted) wire `rate_rule.*` audit writes.
- 🔵 Fresh RTL/Arabic-first UX (`ui-ux-pro-max` + magic MCP): rate-rule editor + preview (web); start sheet, live per-segment session card, mode-switch, itemized close summary (mobile).
- 🟡 architect decisions blocking build (spec §6/§7): live boundary-crossing contract (preview-split vs. write-on-cross), boundary key (rule_id vs. price), multi-boundary segment materialization, rate-rule change auditing + taxonomy, fixed-match price-lock timing/storage, min-charge rate for multi-segment, prepaid `prepaid_minutes` semantics, discount-UI deferral.
- ⚪ Out of scope (later phases): orders/products/inventory + order builder (5), shifts/cash (5), prepaid top-up/expiry + discount UI (5), device CRUD/maintenance UI (later), reports/KPIs (6), offline outbox (8), super-admin (7).

## Phase 3 — Walking skeleton
> Spec: [`docs/specs/phase-3-walking-skeleton.md`](specs/phase-3-walking-skeleton.md) · Anchors: [ADR-0002](adr/0002-tenant-isolation-model-ratified.md) (ACCEPTED), [ADR-0003](adr/0003-auth-claim-and-impersonation-model.md), [ADR-0004](adr/0004-tenant-schema-scoping-and-keys.md)
- 🔵 Wire a **hosted** Supabase dev project: apply migrations `0001..0005`, deploy + register the access-token hook, load seed, create real passworded auth users.
- 🔵 Live-run `rls-tenant-audit` against the hosted DB → graduate Phase-2 isolation from "static pass" to **live-verified** (ADR-0002 AC 32–35).
- 🔵 Mobile (Expo): email/password auth + sign-out; claim-driven tenant/role + branch switcher; device list (free/busy); start session (idempotent client-UUID multi-row write); close session (`@ps/core` time_total → free device → audit row); timestamp-derived live timer.
- 🔵 Web (Next.js, **fresh** — not `wip/web-scaffold`): auth; branch switcher; **read-only** device-state + current/recent sessions view.
- 🔵 Fresh RTL/Arabic-first UX via `ui-ux-pro-max` + magic MCP for all the above screens.
- 🟡 architect decisions blocking build (spec §6/§7): web auth pattern (`@supabase/ssr` vs client), active-tenant scope (branch-only switch this phase), first-segment rate snapshot, branch persistence, hosted-project env wiring.
- ⚪ Out of scope (later phases): pricing editor/engine (4), orders/products/inventory (5), shifts/cash (5), prepaid/fixed-match (4), offline outbox (8), super-admin portal (7), web write/KPIs/reports (6).

## Phase 2 — Tenant foundation (done — pending live verification)
> Spec: [`docs/specs/phase-2-tenant-foundation.md`](specs/phase-2-tenant-foundation.md) · Decision: [ADR-0002](adr/0002-tenant-isolation-model-ratified.md) (ACCEPTED)
- ✅ ADR: tenant isolation model (shared-DB+RLS) — ADR-0002 accepted.
- 🔵 Schema: `tenants`, `branches`, `tenant_members`, `profiles` (+`super_admin` role), `app_metadata` JWT claim hook.
- 🔵 RLS on every table + `WITH CHECK` on writes + `rls-tenant-audit` isolation suite (≥2 seeded tenants; live exec DEFERRED to CI).
- 🔵 Super-admin: provision/suspend a tenant; create the first owner; time-boxed audited impersonation.
- 🔵 Build `@ps/core`: money (piastres), time (Cairo TZ), id, inventory ledger, multi-tenant types — tests >90%.
- 🟡 architect decisions blocking migrations (see spec §6/§7): impersonation mechanics, JWT claim shape/freshness, `super_admin` placement, exact `branch_id` set, `settings` composite key, `payment_method` enum.

## Later (placeholders)
- ⚪ Devices CRUD + live grid (Phase 4)
- ⚪ Pricing engine port + rate-rule editor (Phase 4)
- ⚪ Orders/products/inventory + shift reconciliation (Phase 5)
- ⚪ Owner reports + CSV (Phase 6)
- ⚪ Super-admin portal + impersonation audit (Phase 7)
- ⚪ Offline outbox port + realtime (Phase 8)
- ⚪ Stripe subscriptions + paywall (Phase 9)
- ⚪ Sentry, EAS builds, a11y, security pass (Phase 10)

> Decisions land as ADRs in `docs/adr/`. Specs land in `docs/specs/`.
