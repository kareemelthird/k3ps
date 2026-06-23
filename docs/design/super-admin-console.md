# Feature design — Super-Admin Console (tenant provisioning & management)

> Surface: **web** (Next.js + shadcn/ui), platform-only. Tokens & primitives: `docs/design/design-system.md`.
> Spec: `docs/specs/phase-2-tenant-foundation.md` (US: super_admin provisioning + suspend; AC H 37–39).
> Sibling: impersonation flow → `docs/design/impersonation.md`.
>
> This is the **only** operational UI implied by Phase 2 (the spec defers all tenant-facing UI). It is built
> against the live backend authored in Phase 2 (provisioning writes `tenants` + first `owner` via
> `tenant_members` + an `audit_log` row).

---

## 1. Purpose, audience, language

- **Audience:** platform staff (`super_admin`) only — not café users. This portal is *not* the Expo app
  (`mobile-patterns.md`: "Super-admin gets a web portal, not this app").
- **Language:** the console is **Arabic-first / RTL like the rest of the brand**, but because it is an
  internal English-fluent ops tool, it ships **bilingual** (AR default, EN toggle). All strings via i18n;
  numerals Arabic-Indic in AR, Western in EN. Money via `formatEgp`.
- **Tone:** dense, precise, auditable. No marketing flourish. Calm Operations direction.

---

## 2. Information architecture & navigation

Desktop-first (ops staff on laptops), responsive down to tablet. **Sidebar** navigation (adaptive: sidebar
≥1024px, top bar + drawer below) — `adaptive-navigation`, `drawer-usage`.

```
Super-Admin Console
├─ Tenants            (default)  — list, search, filter, provision, suspend
│   └─ Tenant detail            — overview, owners, branches, audit, impersonate
├─ Audit log                     — platform-wide, filterable (actor/action/tenant/time)
└─ Settings                      — platform config (later)
```

- Current location highlighted in the sidebar (`nav-state-active`).
- Breadcrumb on detail pages (`Tenants / فلامنجو جيمنج`) — 3-level orientation (`breadcrumb-web`).
- Destructive items (suspend) are **never** in primary nav; they live on the entity with confirmation
  (`destructive-nav-separation`).
- The impersonation entry point is on the **tenant detail** page (and per-row action), guarded — see
  `impersonation.md`.

---

## 3. Screens & flows

### 3.1 Tenants list (default screen)

**Purpose:** see every café business, its health, and act (provision / open / suspend).
**Primary action:** **Provision tenant** (one CTA, top-end of the header).

Layout: page header (title + count + Provision CTA) · filter bar (search by name, status filter
all/active/suspended) · `DataTable`.

**Columns** (start→end, RTL-mirrored):
| Column | Content |
|---|---|
| Tenant | Name (h3) + slug/id (faint, isolated LTR) |
| Status | `StatusPill` active(`status-free`) / suspended(`status-maint` + lock icon) |
| Branches | count (tabular, Arabic-Indic) |
| Owner | primary owner name + email (email isolated LTR) |
| Created | relative + absolute on hover; Arabic-Indic date |
| Actions | end cell: **Open** (→detail) · overflow menu (Impersonate, Suspend/Reactivate) |

**Four states**
- **Empty:** illustration + "لا يوجد عملاء بعد — جهّز أول عميل" / "No tenants yet — Provision the first
  tenant" + Provision CTA.
- **Loading:** table skeleton, 6 shimmer rows matching column widths (no layout shift).
- **Error:** inline panel "تعذّر تحميل العملاء" + Retry (`error-recovery`).
- **Offline / degraded:** Provision + row mutations disabled with a banner "غير متصل — الإجراءات معطّلة";
  read still shows cached list.

### 3.2 Provision Tenant (dialog/wizard)

**Trigger:** Provision CTA → modal `Dialog` (sheet on small screens). Short 2-step wizard with progress
(`multi-step-progress`).

**Step 1 — Business**
- `TextField` Tenant name (required) · auto-suggested slug (editable, validated unique, LTR-isolated) ·
  optional region/timezone (defaults `Africa/Cairo`, shown read-only with note that business-day logic uses
  Cairo per `@ps/core`).

**Step 2 — First owner**
- `TextField` Owner full name (required) · Owner email (required, `type=email`, autocomplete, LTR-isolated)
  · choice: **send invite** (default) vs **set temp password**.
- Summary line: "سيتم إنشاء العميل + أول مالك وتسجيلها في سجل التدقيق" ("creates tenant + first owner and
  writes an audit entry") — sets expectation for AC 37.

**Submit**
- Button shows inline spinner + disabled (`loading-buttons`); on success a toast "تم تجهيز العميل" + the new
  row appears (optimistic) and the dialog routes to the new tenant detail. On failure, inline error with the
  cause + the form stays filled (`form-autosave` spirit; no data loss).
- **Idempotency:** the client generates the tenant UUID (`@ps/core uuidv4`) so a double-submit upserts, not
  duplicates (`CLAUDE.md` §2.8).

**Validation:** on blur (`inline-validation`); required fields marked with `*` (`required-indicators`);
errors below each field; first invalid field focused on submit error (`focus-management`).

### 3.3 Tenant detail

**Purpose:** single tenant's overview + the privileged actions.
Sections (cards): **Overview** (status, created, region, counts: branches/devices/owners — tabular) ·
**Owners & members** (table: name, email, role, active) · **Branches** (read list) · **Recent audit**
(last N entries for this tenant) · **Danger zone** (Suspend / Reactivate).

**Actions**
- **Impersonate** — prominent but guarded `secondary` button with the impersonation violet accent on its
  icon; opens the consent dialog (see `impersonation.md`). Never a one-click silent jump.
- **Suspend** — in a visually separated **Danger zone** card; `danger` button → `ConfirmDialog` requiring
  the operator to type the tenant name to confirm (high-friction for a destructive, tenant-wide action);
  writes `audit_log`. Reactivate is a normal confirm.

**Four states:** overview skeleton on load; per-section error with retry; empty owners/branches handled with
inline empty rows; offline disables all mutations.

### 3.4 Audit log (platform-wide)

Read-only `DataTable`: timestamp (Arabic-Indic) · actor · action · tenant · amount (`formatEgp`, only when
money-affecting) · detail. Filters: actor, action type, tenant, date range. **Impersonation sessions are
first-class audit rows** with start/end and the impersonator id (AC 38–39). Money amounts tabular and
end-aligned. Empty/loading/error/offline per §8 of the design system.

---

## 4. Component contracts (new to this feature)

### `TenantRow` / `TenantsTable`
- **Props:** `tenants: TenantSummary[]`, `onOpen(id)`, `onProvision()`, `onImpersonate(id)`,
  `onSuspendToggle(id)`, `loading`, `error`, `query`, `status('all'|'active'|'suspended')`.
- **States:** all four; row hover `e1`; suspended rows render at .7 opacity + lock icon (not color-only).
- **RTL/a11y:** columns mirrored; status by pill (dot+label); actions in an end overflow menu with labels;
  `aria-sort` on sortable headers; row is a link to detail with a descriptive label.

### `ProvisionTenantDialog`
- **Props:** `open`, `onClose`, `onSubmit(payload)`, `submitting`, `error`.
- **Payload:** `{ id (client uuid), name, slug, ownerName, ownerEmail, inviteMode }`.
- **States:** step1/step2; per-field validation; submitting (disabled + spinner); success (toast + route);
  error (inline, form preserved). `confirmOnDirty` on dismiss.
- **RTL/a11y:** labels/errors start-aligned; email/slug LTR-isolated; focus trap; Esc; progress indicator
  announced; first-invalid-field focus on error.

### `TenantOverviewCard`, `MembersTable`, `DangerZoneCard`
- `DangerZoneCard`: visually separated, `danger`-bordered; suspend requires typed confirmation; spatially
  far from any primary action (`destructive-emphasis`). All actions write audit and surface a toast.

### `AuditTable`
- **Props:** `entries`, `filters`, `onFilterChange`, `loading`, `error`.
- **States:** four states; virtualized; money column via `formatEgp` (tabular, end-aligned); impersonation
  rows tinted with the `impersonation` token at low alpha and an icon.

---

## 5. RTL & a11y notes (feature-specific)

- Every email/slug/id is **LTR-isolated** (`bdi`) inside the otherwise-RTL layout so it doesn't flip the
  Arabic flow.
- Dates and counts Arabic-Indic in AR mode (`toArabicDigits`); money always `formatEgp`.
- The **Suspend** and **Impersonate** controls are the two highest-consequence actions — both are visually
  separated from navigation and primary CTAs, both require confirmation, both write `audit_log`.
- Table actions reachable by keyboard; overflow menus open with focus management; `aria-sort` reflects state.
- All four states present on every data surface; offline disables mutations rather than failing silently.

---

## 6. Open dependencies (block final visual build, not this spec)

These map to the spec's open questions §6 and hand-off §7 (architect-owned):
- **Multi-tenant membership shape / active-tenant selection** (Q1) → affects whether the console shows a
  user across multiple tenants. Design assumes one primary owner per tenant in the list, many members in
  detail.
- **Impersonation mechanics** (Q2) → consent dialog copy + time-box display defined in `impersonation.md`,
  but the exact token TTL must come from the architect ADR.
- **`super_admin` placement** (Q4) → the console gates entirely on the platform-level super_admin flag; no
  tenant scoping applies to this surface.
