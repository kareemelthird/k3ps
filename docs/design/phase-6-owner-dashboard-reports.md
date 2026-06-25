# Feature design — Phase 6: Owner web dashboard + Reports (the analytics surface)

> Tokens, type, spacing, motion, RTL, a11y, the shared primitives, **and the chart system** all come from
> **`docs/design/design-system.md`** ("Calm Operations" — dark-first, low-chroma, teal accent; charts in
> system **§10**). This doc specifies the **screens, their composition, component contracts, report-table
> column sets, CSV affordances, and the four states** for the Phase-6 owner analytics surface. It never
> re-derives a token or a chart rule; where a value appears it cites the system token.
>
> - **Surface:** `apps/web` only (Next.js 15 / React 19 + shadcn/Radix + Tailwind — owner dashboard).
>   **No `apps/mobile` work this phase.** Read-only analytics: it sums stored integer-piastre figures, never
>   recomputes a bill (spec §1, §4).
> - **Spec:** `docs/specs/phase-6-owner-dashboard-reports.md` (design to its ACs 12–22 + the ux hand-off §7).
> - **Continuity:** reuses the existing dashboard chrome (`TopBarSimple` nav, `DashboardPageShell`,
>   `EmptyState`/`ErrorState`/`Skeleton`/`StatusPill`/`Button`/`BranchSelect`) and the `DataTable`/`Charts`
>   contracts from design-system §9–§10. Same look as `/dashboard/rate-rules` and `/dashboard/products`.
> - **Library-agnostic:** the chart library is ADR-0007 Q7 (architect). This doc constrains the *visual /
>   interaction* output (RTL, Arabic-Indic labels, states), not the package.
> - **Trial = learning input only.** The trial's KPI definitions / day-grouping / revenue split informed the
>   numbers (spec §4); its orange look is **not** carried (system §11).

---

## 1. The surface (what Phase 6 adds)

```
TopBar nav:  الأجهزة | قواعد الأسعار | قائمة المنتجات | [+ التقارير]   ← new owner-only nav item
                                                            │
                                              /dashboard/reports
                                                            │
   ┌────────────────────────────────────────────────────────────────────────┐
   │  Scope bar:  [ date-range (business-day presets + custom) ] [ branch ▾ ] │
   │  Range+scope header: "آخر ٧ أيام · كل الفروع · ١٢ يونيو–١٨ يونيو"        │
   ├────────────────────────────────────────────────────────────────────────┤
   │  KPI row:  Gross · Time · Orders · Discounts · Cash   (+ supporting count)│
   ├────────────────────────────────────────────────────────────────────────┤
   │  Charts:  Revenue-over-time (stacked bar) │ Revenue-split donut          │
   │           Top-products bar │ Device-utilization bar │ Payment-mix donut  │
   ├────────────────────────────────────────────────────────────────────────┤
   │  Report tables (tabbed/sectioned):  per-day · per-device · per-product · │
   │                                     per-shift reconciliation             │
   │  each with its own [ تصدير CSV ] button                                  │
   └────────────────────────────────────────────────────────────────────────┘
```

**Audience: `owner` only** (spec §6 Q8 / AC 12). A signed-in manager/staff who reaches `/dashboard/reports`
gets a **denied state** (see §9). The nav item itself is hidden for non-owners (`empty-nav-state`: when the
destination is unavailable we explain rather than show a dead link — here the role simply has no analytics
surface this phase).

**One page, on-demand.** Everything responds to the **scope bar** (range + branch). Changing either
re-queries every KPI, chart, and table for the new scope (AC 13–14). It is desktop-primary (owner on a
laptop) and responsive down to tablet.

---

## 2. Information architecture & navigation

Reuse the existing inner-dashboard chrome (`DashboardPageShell` + `TopBarSimple`), adding **one nav item**.

- **Nav:** `nav.reports` ("التقارير") appended to the `TopBarSimple` nav list, **owner-gated** (only
  rendered when `claim.role === 'owner'`). Active state uses the existing `nav-state-active` pattern
  (`bg-surface-3 text-primary`, `aria-current="page"`).
- **Route:** `/dashboard/reports` (the spec's path). `dynamic = 'force-dynamic'` like the other dashboard
  pages (RLS-scoped client/server fetch).
- **Branch scope here is page-local** (a *report filter*, not the operator branch switcher). Unlike
  `/dashboard` (devices) where a branch must be picked to see anything, reports default to **"All branches"**
  and offer a branch `Select` in the scope bar (spec §2: branch is a within-tenant convenience, not a
  security boundary). The existing `BranchSelect` is reused but with an **"All branches"** option prepended.
- **No breadcrumb** (single-level page, like rate-rules/products). The **range+scope header** provides
  orientation instead.

---

## 3. Page layout & responsive grid

Container matches the other dashboard pages: `max-w-7xl mx-auto px-xl py-2xl`, `space-y-2xl` between sections.

| Breakpoint | Scope bar | KPI row | Charts | Tables |
|---|---|---|---|---|
| `< 768` (tablet-portrait floor) | stacked: range picker full-width, then branch select | 1 col (cards stack) | 1 col (charts stack full-width) | horizontal-scroll-free: tables become stacked row cards (`DataTable` mobile fallback) |
| `768–1023` | range + branch on one row | 2 cols (KPI cards wrap) | 1–2 cols | full tables, sticky header |
| `≥ 1024` (primary) | range + branch + active-range label on one row | **5 cols** (Gross/Time/Orders/Discounts/Cash) | 12-col grid: row A = revenue-over-time (8) + revenue-split donut (4); row B = top-products (6) + utilization (6); row C = payment-mix donut (4) | full tables |

`spacing-scale` 4/8 rhythm throughout; section spacing 32–48 (`2xl`/`3xl`). No horizontal scroll at any
width (`horizontal-scroll`); charts reflow/simplify on small screens (`responsive-chart` — fewer ticks,
horizontal bars stay horizontal).

---

## 4. Scope controls (the bar that drives everything)

### 4.1 `BusinessDayRangePicker` — date-range in **business-day** terms

The single most important control. The range is a pair of **business-day keys** (`'YYYY-MM-DD'`,
`@ps/core businessDayKey`), *not* naive UTC calendar days — a 01:00-Cairo session counts in the previous
business day, consistently (spec §4 / AC 13). The control never exposes raw UTC to the owner.

**Layout:** a `Button variant='secondary'` trigger showing the active range label (e.g. "آخر ٧ أيام") with a
calendar icon at the **start** and a chevron (mirrored RTL) at the **end**; opens a `Dialog`/popover (system
§9.3) containing:
1. **Presets** (segmented list, one tap each): `range.preset.today` · `.yesterday` · `.last7` · `.thisMonth`
   · `.lastMonth` · `.custom`. Presets are computed in **business-day** terms against the tenant
   `cutover_hour` (default 6) and `Africa/Cairo` — "today" = the current business day, which after midnight
   but before 06:00 is still *yesterday's* calendar date.
- **Custom:** two `TextField`-style date inputs (`range.from` / `range.to`), each a business-day date.
   Validation on **blur**: if `from > to`, show a field-level `danger` message `range.error.invalid` below
   the inputs and **block the query** (no fetch fires, AC 13); the Apply button is disabled until valid.
4. **Apply** (`primary`) / **Cancel** (`ghost`, at start).

**Props — `BusinessDayRangePicker`**
- `value: { fromKey: string; toKey: string; preset: RangePreset | 'custom' }`
- `cutoverHour: number` (from `settings.business_day`, default 6) — drives preset math; **passed in**, never
  read from the clock inside core (CLAUDE.md §4).
- `onChange(next)` · `disabled`
- Internally maps `[fromKey, toKey]` → half-open UTC `[fromInstant, toInstant)` for the query (spec §4 /
  AC 2); **where** that mapping lives (SQL vs `@ps/core` helper) is ADR-0007 Q1 — the control only emits keys.

**States:** default (a preset selected) · open (popover, focus-trapped) · invalid-custom (inline message,
Apply disabled) · disabled (during an in-flight query, optional).

**RTL/a11y:** calendar icon at start, chevron at end (mirrored); preset list is a `radiogroup` with the
active preset `aria-checked`; date inputs use a native-friendly type for the correct keyboard; all numerals
in the displayed label Arabic-Indic; the label reads e.g. "آخر ٧ أيام · ١٢ يونيو ← ١٨ يونيو" (month names
localized, digits Arabic-Indic). Esc closes, focus returns to the trigger.

### 4.2 Branch filter

Reuse `BranchSelect` (existing) with an **"All branches"** sentinel prepended (`branch.all`). Selecting it
aggregates the whole tenant; a specific branch narrows every figure (AC 14). Switching branch **never**
exposes another tenant (RLS; branch is a within-tenant FK). Default = **All branches**.

- **Props addition:** `allowAll: boolean` (true here), `value: string | 'ALL'`.
- **RTL/a11y:** selected option `aria-current`; the control shows the active branch (or "كل الفروع") as its
  label; ≥ 44 height.

### 4.3 Range + scope header (orientation)

A single `caption`/`label` line under the scope bar restating the active scope so every number is
unambiguous (`drill-down-consistency`, `time-scale-clarity`): **"{presetLabel} · {branchLabel} ·
{fromDate} – {toDate}"** — e.g. "آخر ٧ أيام · فرع المعادي · ١٢ يونيو – ١٨ يونيو". Digits Arabic-Indic; the
date span uses the locale month names. This line is the screen-reader anchor announced on scope change
(`aria-live="polite"`).

---

## 5. KPI cards (`KpiCard` + `KpiRow`)

Five cards (AC 15), each: a **label**, the **figure** (large, `money` role, tabular, via `formatEgp` +
Arabic-Indic), and a **supporting count/sub-line** (e.g. "عن ١٢٤ جلسة"). The figure is the hero; the label
sits above (`caption`/`label`, `text-muted`), the count below (`caption`, `text-faint`).

| Card | Figure (spec §4 canonical) | Supporting sub-line | Accent |
|---|---|---|---|
| `kpi.gross` | Σ closed `grand_total` + Σ paid non-void walk-in `orders.total` | "{n} جلسة · {m} طلب خارجي" | `primary` teal (the headline number — the one place the brand accent paints money, system §2.2) |
| `kpi.time` | Σ closed `sessions.time_total` | "{n} جلسة" | `chart-time` dot |
| `kpi.orders` | Σ non-void order-line totals (session + walk-in) | "{k} صنف مُباع" | `chart-orders` dot |
| `kpi.discounts` | Σ closed `sessions.discount` | "على {n} جلسة" | `chart-discount` dot |
| `kpi.cash` | subset of Gross with `payment_method='cash'` | "{pct} من الإجمالي" | `chart-cash` dot |

- **No double-count** is a *data* guarantee (AC 5), but the design reinforces it: Gross is visually the
  headline; Time + Orders − Discounts are shown as its **composition** (the revenue-split donut sits beside
  the KPI row and its center equals Gross), so the owner reads them as parts of one whole, never as
  five addable totals.
- **KPI ⇄ table agreement:** the Gross figure equals the per-day table's total row to the piastre (AC 15) —
  the design places the per-day table's footer total visibly so the owner can self-verify.

**`KpiCard` props:** `label`, `value` (piastres), `format('money'|'count'|'percent')`, `subLine?`,
`accentToken?`, `loading`, `error?`, `onRetry?`.

**Four states (per card, AC 17):**
- **Empty** (range has no data): the card shows **`formatEgp(0)`** with a muted "لا توجد بيانات في هذه
  الفترة" sub-line — an explicit zero-with-context, **never** a bare `٠` that looks like an error, and never
  a blank card.
- **Loading:** a `Skeleton` block sized to the figure + sub-line (shimmer > 300ms, reserves height → no CLS).
- **Error:** the card body becomes a compact inline error with a small **Retry** (`error-recovery`); the
  label stays so the owner knows *which* KPI failed; one card can fail without taking down the row.
- **Offline/stale:** read-on-demand — shows last figures with the page-level refresh affordance (§10).

**RTL/a11y:** label + sub-line align **start**; figure tabular so it never reflows as the range changes
(`number-tabular`); each card is a labelled region (`aria-label` = label + spoken value via `formatEgp`'s
accessible form, not raw glyphs); the accent dot is decorative (`aria-hidden`) — the label carries meaning,
never color alone (`color-not-only`).

---

## 6. Charts (compose against design-system §10)

All five charts use the **chart tokens, palette, RTL rules, a11y rules, and four states** from system §10.
Each chart sits in a `ChartCard` (title `h3` at start, optional toggle at end, body = chart, footnote =
screen-reader summary + "see table below"). The figures **must match** the KPIs/tables for the same scope
(AC 16).

| # | Chart | Series → token | Interaction | Notes |
|---|---|---|---|---|
| C1 | **Revenue over time** (stacked vertical bar, one bar / business-day) | time→`chart-time`, orders→`chart-orders` | tap a bar → tooltip with day, time, orders, gross (`formatEgp`); legend toggles a series | earliest day at **right** (RTL, §10.4); x-ticks auto-skip on wide ranges (`axis-readability`); if range > ~60 days, aggregate to weekly buckets and label granularity (`time-scale-clarity`, spec AC 11) |
| C2 | **Revenue split** (donut ≤3) | time/orders/discount → `chart-time`/`chart-orders`/`chart-discount` | tap slice → value + %; center = **Gross** (`money`, tabular) | proportion of the whole; legend at start |
| C3 | **Top products** (horizontal bar, top N) | bars `chart-time` (or categorical sequence when grouped by category) | **qty ↔ revenue toggle** (`SegmentedControl`, system §9.4); tap → exact qty + revenue + margin-where-known | bars grow from the **right**; product name at start, value at bar end (`direct-labeling`); "أخرى" bucket beyond top N |
| C4 | **Device utilization** (horizontal bar / device) | bars `chart-orders`; track `chart-track` | busy-minutes primary; **util %** as a secondary end-label; tap → minutes + % + revenue attributed | denominator is a **labelled approximation** (24h × days, ADR-0007 Q3) — the axis title states it ("٪ من ٢٤ ساعة") so the % is never misread |
| C5 | **Payment-method mix** (donut, 3) | cash/wallet/other → `chart-cash`/`chart-orders`/`N400` | tap slice → amount + % | `debt` excluded (inert, system §2.2); center = settled total |

Sessions-by-day (vertical bar) is an optional sixth (§10.3) folded into C1's tooltip / the per-day table to
avoid chart sprawl (`data-density`); promote to its own chart only if the per-day table proves insufficient.

**Every chart:** legend interactive, tooltip keyboard-reachable (≥44 hit), Arabic-Indic numerals on all
ticks/labels/tooltips/centers, the four states from §10.6, a one-line screen-reader summary, and the report
table below as the accessible data alternative (§10.5).

---

## 7. Report tables (`ReportTable` built on `DataTable` §9.7)

Four drill-down tables (AC 18). Presented as a **tabbed section** (`SegmentedControl` of table names) on
desktop to avoid an overwhelming wall (`progressive-disclosure`), or stacked sections on tablet. Each table:
sticky header, sortable columns (`aria-sort`), a **footer total row** (where summable), pagination/virtualize
at 100 rows with **totals computed server-side so they stay exact even when the table is paged** (AC 11), and
its own **Export CSV** button at the section header **end**.

All money cells: `formatEgp` + Arabic-Indic, **end-aligned** (logical), tabular. All count/%/duration cells:
Arabic-Indic, tabular. Columns lay out **start→end mirrored** (RTL); numeric columns end-aligned.

### 7.1 Per-business-day (`reports.byDay`)
| Column (start→end) | Content |
|---|---|
| `col.day` | business-day date (Arabic-Indic, localized) |
| `col.gross` | Σ gross that day |
| `col.time` | time revenue |
| `col.orders` | orders revenue |
| `col.discount` | discounts |
| `col.cash` | cash share |
| `col.sessions` | session count |
| `col.walkins` | paid walk-in count |
Footer: totals row (matches the KPI Gross, AC 15). Default sort: day descending (newest at top).

### 7.2 Per-device (`reports.byDevice`)
| Column | Content |
|---|---|
| `col.device` | device name + type badge (LTR-isolated id) |
| `col.busyMinutes` | busy minutes in range |
| `col.utilization` | % vs the labelled 24h denominator |
| `col.sessions` | session count |
| `col.revenue` | revenue attributed to the device |
Footer: total busy minutes + total device revenue. Default sort: revenue descending.

### 7.3 Per-product (`reports.byProduct`)
| Column | Content |
|---|---|
| `col.product` | product name |
| `col.category` | category (or `products.noCategory`) |
| `col.qty` | Σ non-void qty |
| `col.productRevenue` | Σ non-void qty × unit_price |
| `col.margin` | margin **only where `cost` known**; otherwise **"—"** (`products.noCost`) — never a fabricated number (AC 9) |
A **deactivated product that sold in range still appears** (history preserved, AC 9) — shown with a muted
`products.status.inactive` badge, not hidden. Footer: total qty + total product revenue. Default sort:
revenue descending; qty toggle mirrors the C3 chart toggle.

### 7.4 Per-shift reconciliation (`reports.byShift`)
| Column | Content |
|---|---|
| `col.shiftOpened` | opened-at (business-day, Arabic-Indic) |
| `col.manager` | manager name |
| `col.openingCash` | opening cash |
| `col.expectedCash` | expected (system-computed) |
| `col.actualCash` | actual (counted) |
| `col.difference` | `actual − expected` exactly as stored — **never clamped** (AC 10), **color-coded** |
**Difference color convention (binding):** short (< 0) = `chart-neg` red + down-arrow; over (> 0) =
`chart-discount` amber + up-arrow; balanced (= 0) = `chart-cash` green + check. Color is **never alone** — the
arrow/check icon + the signed value carry it too (`color-not-only`). Footer: Σ expected, Σ counted, Σ
difference, **and** a count chip row of `reports.shift.short` / `.over` / `.balanced` (StatusPill-style).

### 7.5 `ReportTable` props
`titleKey`, `columns[]` (`{key, labelKey, align('start'|'end'), format, sortable}`), `rows[]`, `footer?`
(totals), `onSort`, `sort`, `onExportCsv`, `pageSize=100`, `loading`, `error`, `onRetry`, `emptyKey`.

### 7.6 CSV export (`exportReportCsv` affordance — AC 18)
- **Button:** `Button variant='secondary'` with a download icon, at the section header **end**, label
  `reports.exportCsv`; shows a spinner while generating, then a success `Toast` (`success-feedback`). Disabled
  when the table is empty.
- **File contract (the design intent; engineer implements):** UTF-8 **with BOM**; correct escaping (fields
  with `,`/`"`/newline quoted, embedded quotes doubled); **Arabic text intact** (opens correctly in
  Excel/Sheets); **numbers as machine-readable values** — **decimal EGP with Western digits** (ADR-0007 Q6
  recommendation), e.g. `12.50`, **not** Arabic-Indic and **not** `formatEgp` glyphs. The on-screen rendering
  stays Arabic-Indic (CSV is the only Western-digit surface, AC 21 exemption). Column headers come from i18n
  (the active locale's table headers, AC 20). Export content matches the on-screen rows for the **current
  scope** (range + branch).
- Whether export writes a `report.export` audit row is **ADR-0007 Q4 (default off)** — no UI implication
  either way; the button behaves identically.

---

## 8. Component contracts (new this phase)

| Component | Built on | Key props | States |
|---|---|---|---|
| `ReportsView` (page root) | — | `isOwner`, `branches[]`, `cutoverHour` | owner-gate → denied; else the four data states cascade to children |
| `ScopeBar` | `BusinessDayRangePicker` + `BranchSelect` | `range`, `branch`, `onRangeChange`, `onBranchChange` | controls disabled during in-flight query (optional) |
| `BusinessDayRangePicker` | `Dialog` §9.3, `Button`, `TextField` | see §4.1 | default · open · invalid-custom · disabled |
| `KpiRow` / `KpiCard` | — | see §5 | empty(zero+context) · loading(skeleton) · error(inline+retry) · stale |
| `ChartCard` | system §10 | `titleKey`, `toggle?`, `summary`, chart slot | §10.6 four states |
| `ReportTable` | `DataTable` §9.7 | see §7.5 | built-in four states + footer totals |
| `ReportTabs` | `SegmentedControl` §9.4 | `tables[]`, `active`, `onChange` | — |
| `DeniedState` | `EmptyState` §9.9 | `titleKey`, `bodyKey` | static |

**`ReportsView` cascade:** one `loading` flag drives skeletons across KPIs + charts + the active table
together (a single scope query); on error the **whole data region** shows one `ErrorState` + Retry (the
scope bar + header stay usable so the owner can adjust and re-run, `error-recovery`). Per-card/per-chart
inline errors (§5/§10.6) apply when a *sub-query* fails independently under the ADR-0007 Q1 fetch shape.

---

## 9. The four states at page level + the denied state

| State | Page contract |
|---|---|
| **Empty** | Scope resolved, **zero rows** in range/branch: KPI cards show contextual zeros (§5), charts show labelled zeroed frames with "no data in this range" (§10.6), tables show their own empty rows (`reports.empty.*`). The scope bar stays fully usable so the owner can widen the range — the empty state always points to "try a wider range / another branch" (`empty-states`). **Never** a blank page. |
| **Loading** | Skeleton KPI cards + skeleton chart blocks + skeleton table rows matching final layout (shimmer > 300ms, CLS < 0.1). The scope bar renders immediately (it doesn't depend on data). |
| **Error** | Query/RLS failure → one `ErrorState` + Retry in the data region; scope bar + header remain interactive. `role="alert"`/`aria-live`. If a materialized cache is chosen (ADR-0007 Q1), its staleness window is disclosed near the header (AC 19). |
| **Offline / stale** | Read-on-demand, no outbox (deferred to Phase 8). A reconnect/refresh affordance sits by the range+scope header; figures keep showing the last successful fetch with a "آخر تحديث: {time}" caption so a stale number is never mistaken for live (AC 19). |
| **Denied (non-owner)** | A manager/staff who reaches `/dashboard/reports` sees a `DeniedState` (`reports.denied.title` / `.body` — "هذه الصفحة متاحة للمالك فقط") with a single action back to `/dashboard`. The nav item is also hidden for them. This is the UX face of the route role-gate (AC 12 / spec §6 Q8); the real gate is server-side. |

---

## 10. Cross-cutting contracts (binding)

- **Money (CLAUDE.md §2.1, §4):** every amount is integer piastres in state, rendered **only** via
  `formatEgp` (Arabic separator `٬`, suffix `ج.م`). **No inline currency math, no manual formatting** in any
  KPI, chart label, table cell, or footer total. Percentages via the shared `formatPercentAr` helper
  (Arabic-Indic + `٪`); durations via a shared minutes→"س/د" formatter (Arabic-Indic).
- **Numerals (CLAUDE.md §2.6):** all *displayed* digits Arabic-Indic via `toArabicDigits` (axes, labels,
  tooltips, donut centers, counts, dates, %); business/query values stay Western. **CSV is the only
  Western-digit surface** (machine-readable, AC 21 exemption).
- **Business-day bucketing (CLAUDE.md §3):** every figure is attributed to a business day via
  `businessDayKey(anchor, cutoverHour, 'Africa/Cairo')`; the picker emits keys, not UTC; weekend = Fri/Sat
  where a weekday/weekend split is shown. The cutover hour is **passed in** from `settings`, never read from
  the clock in core.
- **Read-only / no recompute:** Phase 6 sums **stored** snapshots; it never re-derives a bill from current
  rules/catalog (spec §1). No mutation UI, no operational audit writes on view (AC 23).
- **Tenant isolation:** every query is RLS-scoped to the signed `app_metadata.tenant_id`; the branch filter
  is a within-tenant convenience and **never** a security boundary (AC 14, 26). The design never sends a
  tenant id from the client.
- **All strings via i18n (CLAUDE.md §2.6):** zero hardcoded user-facing copy — KPI labels, chart
  legends/axes/titles, table headers, range presets, branch options, empty/error/denied copy, **and CSV
  column headers** all come from resources (AC 20).
- **A11y floors:** focus moves to `#main-content` on route entry (`focus-on-route-change`); visible focus
  rings (2–4px `primary`); contrast verified both themes; interactive controls ≥ 44 (scope controls ≥ 44,
  chart hit targets ≥ 44); reduced-motion disables chart grow-in + skeleton shimmer; tables sortable by
  keyboard with `aria-sort`.

---

## 11. i18n key inventory (Phase 6 — keys only; Arabic strings live in `apps/web/src/i18n/messages/ar.json`)

```
nav.reports

reports.title · reports.subtitle
reports.exportCsv · reports.exporting · reports.exportDone
reports.denied.title · reports.denied.body · reports.denied.backToDashboard
reports.empty.title · reports.empty.body            (no data in range — try wider range/another branch)
reports.lastUpdated                                 ("آخر تحديث: {time}")
reports.refresh

range.label                                         (active-range trigger label)
range.preset.today · range.preset.yesterday · range.preset.last7
range.preset.thisMonth · range.preset.lastMonth · range.preset.custom
range.from · range.to · range.apply · range.cancel
range.error.invalid                                 (from > to)
range.scopeHeader                                   ("{preset} · {branch} · {from} – {to}")

branch.all                                          ("كل الفروع")

kpi.gross · kpi.gross.sub          · kpi.time · kpi.time.sub
kpi.orders · kpi.orders.sub        · kpi.discounts · kpi.discounts.sub
kpi.cash · kpi.cash.sub            · kpi.noData

chart.revenueOverTime.title · chart.revenueSplit.title · chart.topProducts.title
chart.deviceUtilization.title · chart.paymentMix.title
chart.legend.time · chart.legend.orders · chart.legend.discount
chart.legend.cash · chart.legend.wallet · chart.legend.other
chart.toggle.qty · chart.toggle.revenue
chart.axis.day · chart.axis.egp · chart.axis.minutes · chart.axis.utilizationOf24h
chart.empty · chart.summary.revenueOverTime · chart.summary.revenueSplit
chart.summary.topProducts · chart.summary.deviceUtilization · chart.summary.paymentMix

reports.tab.byDay · reports.tab.byDevice · reports.tab.byProduct · reports.tab.byShift

col.day · col.gross · col.time · col.orders · col.discount · col.cash
col.sessions · col.walkins
col.device · col.busyMinutes · col.utilization · col.revenue
col.product · col.category · col.qty · col.productRevenue · col.margin
col.shiftOpened · col.manager · col.openingCash · col.expectedCash
col.actualCash · col.difference
col.total                                            (footer total label)

reports.byDay.empty · reports.byDevice.empty · reports.byProduct.empty · reports.byShift.empty
reports.shift.short · reports.shift.over · reports.shift.balanced

format.percentSuffix                                 ("٪" — used by formatPercentAr)
format.duration.hours · format.duration.minutes      ("س" / "د")
```

Reused existing keys (no re-introduction): `state.loading`, `state.error.generic`, `action.retry`,
`action.cancel`, `action.close`, `products.noCategory`, `products.noCost`, `products.status.inactive`,
`device.status.*`, `app.name`.

---

## 12. Design tokens added this phase

All in **`docs/design/design-system.md §10`** (the chart system is now realized, not reserved):

- **Chart color tokens:** `chart-time`, `chart-orders`, `chart-discount`, `chart-cash`, `chart-pos`,
  `chart-neg` (both modes) + the 6-step **extended categorical sequence** + the payment-mix mapping.
- **Chart structural tokens:** `chart-grid`, `chart-axis`, `chart-axis-title`, `chart-track`,
  `chart-tooltip-bg`, `series-stroke`, `bar-radius`, `donut-thickness`.
- **Binding rules:** RTL chart rules (§10.4), chart a11y (§10.5), the four chart states (§10.6), and the
  chart-type→KPI mapping (§10.3).
- **Shift-difference color convention** (this doc §7.4): short=`chart-neg`, over=`chart-discount`,
  balanced=`chart-cash`, always with icon + signed value (never color alone).

No new spacing/radius/type/motion tokens — Phase 6 composes the existing scale verbatim.

---

## 13. Open items handed to / from the architect (ADR-0007) that touch the design

These do **not** block the visual spec (it is library- and mechanism-agnostic), but the design accommodates
each outcome:

- **Q1 aggregation mechanism / fetch shape** — determines whether KPIs/charts/the active table load on one
  scope query (single page-level skeleton + one `ErrorState`) or as independent sub-queries (per-card/
  per-chart inline errors). The design supports **both** (§8 cascade + §5/§10.6 inline errors).
- **Q3 utilization denominator** — the design **labels** the % as "٪ من ٢٤ ساعة" so whatever denominator is
  ratified is never misread; busy-minutes is the primary figure regardless (§6 C4, §7.2).
- **Q5 pagination / row-cap** — tables page/virtualize at 100 rows with **server-side totals** so footers
  stay exact (§7); the design never derives a footer total from the visible page.
- **Q6 CSV numeric format** — the design assumes **decimal EGP, Western digits, UTF-8 BOM** (§7.6); if the
  human picks integer piastres instead, only the file changes, not the UI.
- **Q7 chart library** — anything that can emit the §10 SVG output (RTL direction, Arabic-Indic tick
  formatter, interactive legend, keyboard tooltip) satisfies this spec.

---

## 14. Component-draft note (21st.dev magic MCP)

The magic MCP can draft concrete KPI-card / chart-card / filter-bar shells for the **web** render against the
contracts above (`KpiCard`, `ChartCard`, `ScopeBar`, `ReportTable`). When used, **discard any output that**:
(a) hardcodes Latin/Western numerals or inline currency formatting — must route through `formatEgp` /
`toArabicDigits`; (b) assumes LTR axis/legend order — must follow §10.4 RTL rules; (c) ships a chart without
the four states or the screen-reader summary (§10.5–§10.6). Keep only the **visual vocabulary** (card framing,
donut/bar proportions, tooltip styling) and bind it to the tokens + contracts here — exactly as Phase 3 did
with the rejected countdown samples (`phase-3-walking-skeleton.md` §6).
