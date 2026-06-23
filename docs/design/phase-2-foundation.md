# Feature design — Phase 2 Foundation (the display contract `@ps/core` delivers)

> Surface: **none directly** — Phase 2 ships `@ps/core` (pure logic) + the multi-tenant Supabase backend, with no operational screens (spec §7 hand-off: "ux-designer must design: Nothing in Phase 2 (no UI surface)").
> Tokens & primitives: `docs/design/design-system.md`. Spec: `docs/specs/phase-2-tenant-foundation.md`.
> What this doc owns: the **formatting & numerals display contract** that `@ps/core` exposes and that **every later screen must render through** — and the forward UX notes the spec flagged.

---

## 1. Why a design doc for a "no-UI" phase

Phase 2 has no screens, but it ships the **display primitives** every future screen renders money, time, and counts with: `formatEgp`, `toArabicDigits`, `formatClock` (and the conversion/sum helpers behind them). These are the *design layer of the data layer*. If the design contract for them is pinned now, every Phase-3+ screen (device grid, sessions, owner dashboard, super-admin console) inherits a consistent, RTL-correct, Arabic-first money/number presentation **for free** — and no engineer re-implements currency or numeral formatting in a component (`CLAUDE.md` §2.1, §2.6, §4).

This doc is the bridge between the pure `@ps/core` API (spec AC A/B/C) and the design system's typography + RTL rules.

---

## 2. The display contract (binding for every later screen)

The UI **consumes these functions; it never re-implements their behavior.** Raw piastres and Latin-digit prices are never shown to a user.

| `@ps/core` function | Display contract | Design-system role |
|---|---|---|
| `formatEgp(piastres)` | Canonical money string: Arabic thousands separator `٬`, suffix `ج.م`, omits fraction for whole pounds, signs negatives (spec AC 3). UI passes **integer piastres only**. | `money` role, **tabular figures mandatory**, suffix at the logical **end** in RTL. Emphasized total/revenue → `primary` (teal). Negative (void/refund/deficit) → `danger` + minus sign. |
| `toArabicDigits(s)` | Latin→Arabic-Indic `٠١٢٣٤٥٦٧٨٩`; non-digits unchanged (AC 5). | Use for **all** user-facing numbers: counts, percentages, dates, badge values. Latin digits only in debug/non-user contexts. |
| `formatClock(seconds)` | `HH:MM:SS`, e.g. `01:01:01` (AC 11). | Pipe through `toArabicDigits` for display. `timer` role, tabular, **never wraps**. The session timer is the one place a number is the largest element on screen. |
| `elapsedSeconds` / `elapsedMinutes` | Derive elapsed from `started_at` + a `nowIso` argument, clamped ≥ 0 (AC 10). Never an interval counter. | Feeds `TimerText`. A visual tick may refresh the render, but the value is always **timestamp-derived** (`CLAUDE.md` §2.2) so backgrounding/offline never corrupts the displayed bill. |
| `egpToPiastres` / `piastresToEgp` | Conversion only (AC 1–2). | A price **input field** converts once via `egpToPiastres` on save; the UI never does its own EGP↔piastres arithmetic. |
| `sumPiastres` | Integer-safe total (AC 4). | Cart/order/shift totals go through this — never `+` on money in a component. |

### 2.1 Money presentation rules (apply everywhere money appears)

- Money is **always** `formatEgp(...)` output: Arabic-Indic, tabular, `ج.م` suffix at the RTL end.
- Color by meaning: neutral amount = `text`; emphasized total/running revenue = `primary`; negative (deficit, refund, void) = `danger` + sign.
- Tabular figures so amounts never reflow as they change (`number-tabular`).
- Reserve the field width for the largest plausible value so live updates cause no layout shift.

### 2.2 The two consuming primitives (already specified in the system)

`MoneyText` and `TimerText` in `docs/design/design-system.md` §9 are the **only** components that render money/time. They take raw `piastres` / ISO timestamps and call these `@ps/core` functions internally — so screens never touch formatting directly. Phase 2 fixes their contract; Phase 3 builds them.

---

## 3. Tenancy concepts the UI will surface later (forward note)

Phase 2 adds the multi-tenant types/columns (`tenant_id`, `branch_id`, `Tenant`, `Branch`, `TenantMember`, `super_admin` role). No screen renders them yet, but the design reserves how they appear later:

- **Branch context** will be a top-of-app selector (manager/owner) once branches are user-facing (Phase 3+); design TBD with the devices feature. The token/nav slots are reserved in the design system §9.
- **Tenant isolation is invisible by design** to café users — there is no tenant switcher in the operator app; identity comes from the signed JWT claim. The only surface that sees multiple tenants is the **super-admin console** (already designed) and **impersonation** (already designed).

---

## 4. The flagged forward UX (spec hand-off §7) — status

The spec's only design call-outs for Phase 2 are forward notes, both now authored:

| Flagged flow | Doc | Status |
|---|---|---|
| Super-admin tenant provisioning + management | `docs/design/super-admin-console.md` | Authored — list, provision wizard, tenant detail, platform audit log, all four states + RTL/a11y. |
| Time-boxed, audited, **visually unmistakable** impersonation | `docs/design/impersonation.md` | Authored — consent dialog, persistent violet banner + live countdown + frame, auto-expiry/exit, audit pair, all four states + RTL/a11y. |

Both build against the live backend authored in Phase 2; both depend on the architect's open questions (impersonation mechanics/TTL, claim shape) for final values — the UX contracts reserve those slots.

---

## 5. Four states (this "feature")

Phase 2 has no data screen, so the four states apply to the **consuming components**, contracted here for Phase 3:

- **Loading** — `MoneyText`/`TimerText` render a tabular skeleton placeholder of the reserved width (no shift) until the value resolves.
- **Empty** — a money field with no value shows `formatEgp(0)` (`٠ ج.م`), never blank.
- **Error** — if a value can't be computed (e.g. a corrupt segment), the field shows a neutral dash placeholder `—` with the surrounding card carrying the error/retry, never `NaN` or a raw number.
- **Offline** — a running `TimerText`/running total stays correct (timestamp-derived) and is marked stale/queued per the offline rules; it is **never** blocked or recomputed from an interval counter.

---

## 6. RTL & a11y notes

- Displayed money/counts/timers are Arabic-Indic via `@ps/core`; the `ج.م` suffix and any sign sit at the logical **end** under RTL.
- Money columns and timers are tabular so RTL alignment stays stable.
- Any Latin token embedded in Arabic (slug, email, device id, a debug Western number) is LTR-isolated so it doesn't flip the surrounding direction.
- `TimerText` exposes an `accessibilityLabel` reading the time in Arabic words/digits, not the raw `HH:MM:SS` glyphs alone.
- Enforced by `rtl-i18n-check` (numerals/format correctness) and `pricing-engine-guard` (no float/`Date.now()` in the math behind these displays).

---

## 7. Handoff

- **Engineers (Phase 2):** implement `formatEgp`/`toArabicDigits`/`formatClock`/conversions to the contracts in §2 (already the AC). No component work this phase.
- **Engineers (Phase 3+):** build `MoneyText`/`TimerText` (design-system §9) as the sole money/time renderers, consuming these functions; never format money/time inline.
- **ux-designer (Phase 3):** the devices-grid + sessions feature design will compose `MoneyText`/`TimerText`/`DeviceCard`/`Sheet`/`SegmentedControl` from the system — this doc guarantees the money/time substrate they sit on.
