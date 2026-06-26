# Feature design — Phase 7: Super-admin portal (platform operations)

> Tokens, type, spacing, motion, RTL, a11y, the four states, and the shared primitives all come from
> **`docs/design/design-system.md`** ("Calm Operations"). The **new platform + impersonation-banner tokens**
> are registered there in **§2.4**; this doc composes against them and never re-derives a token.
>
> - **Surface:** `apps/web` only (Next.js 15 / React 19 + shadcn/Radix + Tailwind). No mobile, no `@ps/core`
>   change (spec §3 out-of-scope). Route group `/admin`.
> - **Spec:** `docs/specs/phase-7-super-admin-portal.md` — design to the **ux hand-off §7** and ACs:
>   Block A (route/gate 1–4), Block B (overview/detail 5–8), Block D (lifecycle 16–20), Block E
>   (impersonation 21–29), Block F (audit 30–32). Blocks C/G/H are backend/security/verify (no UI surface,
>   but the design must not assume any cross-tenant reach beyond what those ratify).
> - **Continuity:** this is the **build-time** realization of the two Phase-2 *conceptual* docs
>   (`super-admin-console.md`, `impersonation.md`). It **supersedes** them for the build and reconciles the
>   one open chrome question (sidebar vs top bar) and the one language question (Arabic-first vs bilingual)
>   below (§1.3, §1.4). Those Phase-2 docs stay as the originating rationale; where they differ, **this doc
>   wins**.
> - **Trial = learning input only.** No Pochinki look; the super-admin surface never existed in the trial.
> - **Most security-sensitive phase.** The design's hard jobs: make the `/admin` context unmistakable, make
>   impersonation *impossible to forget*, and never imply a cross-tenant reach the RLS layer doesn't grant.

---

## 1. Direction & the two reconciliations

### 1.1 What Phase 7 adds (the surface map)

```
/admin                         ← Platform overview (tenants list + health + provision)   [default]
/admin/tenants/[id]            ← Tenant detail (info · members · branches · audit · lifecycle · impersonate)
/admin/audit                   ← Platform audit view (cross-tenant, read-only, filterable)

(active impersonation)         ← persistent ImpersonationBanner + inset frame over the WHOLE app
                                  (tenant surfaces, not /admin — you are now "inside" the tenant)
```

Everything is **dual-gated**: a client route guard (`claim.is_super_admin`) renders the shell, and **every**
server fetch / server action independently re-verifies `is_super_admin()` (AC 1–4). The UI gate is a
courtesy; the real gate is server-side. A non-super-admin who reaches `/admin` sees the **denied state**
(§9), never platform data.

### 1.2 Personality

The portal is a **command deck for a cash business**: dense, precise, auditable, no marketing flourish —
the same "trustworthy, fast, calm" Calm Operations personality, tuned one notch more *serious* because every
action here is platform-wide and irreversible-feeling (provision, suspend, impersonate). `ui-ux-pro-max`
drivers applied: `nav-hierarchy` + `adaptive-navigation` (sidebar for a desktop ops tool), `primary-action`
(one CTA per screen), `destructive-nav-separation` + `destructive-emphasis` + `confirmation-dialogs` (suspend
/ impersonate are spatially isolated and high-friction), `state-clarity` and `color-not-only` throughout.

### 1.3 Reconciliation A — the chrome makes the context "unmistakable" **structurally**

The spec demands `/admin` be *visually separated from a tenant dashboard*. The tenant dashboard uses a
**top bar** (`TopBarSimple`). So the portal uses a **left sidebar** (`AdminSidebar`) — the structural
contrast alone says "this is a different kind of place," before any color. This matches the Phase-2
`super-admin-console.md` intent (sidebar, adaptive) and `ui-ux-pro-max` `adaptive-navigation` (≥1024px prefer
sidebar; the portal is desktop-primary ops). Distinction is layered (redundant, `color-not-only`):

1. **Sidebar** nav (vs the tenant top bar) — different layout.
2. A persistent **platform badge** (`admin.platform.badge` — "المنصة") locked to the sidebar header with the
   `platform` steel hue and a distinct platform monogram (not the tenant name).
3. The **`platform-surface`** chrome (one step off the canvas) + a `platform` hairline under the header.
4. **No branch switcher and no tenant identity** in the chrome — the portal is above tenants, not inside one.
5. The unique nav set: **Tenants** · **Audit** (no Devices/Rate-rules/Products/Reports).

The brand stays one brand: the **action** accent inside the portal is still `primary` teal (the Provision
CTA, focus rings); `platform` steel is identity-only (§2.4). No loud new action color is introduced.

### 1.4 Reconciliation B — Arabic-first now; bilingual is a reserved future

Phase-2 `super-admin-console.md` floated a bilingual AR/EN ops tool. **Binding for Phase 7: Arabic-first /
RTL / Arabic-Indic numerals**, every string an i18n key (CLAUDE.md §6; spec §5). The key inventory (§11) is
authored so a later EN toggle is a pure resource add — but **no EN toggle is built this phase** (out of
scope, no human-approved deviation). Emails / slugs / device ids stay **LTR-isolated** (`bdi`) inside the
RTL flow so a Latin token never flips the surrounding Arabic.

---

## 2. The shell — `AdminShell` + `AdminSidebar`

A new shell (sibling to `DashboardPageShell`, **not** a reuse — different layout, different gate). Desktop-
primary; responsive to tablet (sidebar collapses to a top bar + drawer below 1024px, `adaptive-navigation`).

```
┌───────────────┬──────────────────────────────────────────────────────────┐
│  [▢] المنصة    │  Page header (title · count · one primary CTA at end)      │
│  ───────────  │ ─────────────────────────────────────────────────────────│
│  ▣ العملاء     │                                                            │
│  ▢ سجل التدقيق  │   #main-content  (max-w-7xl, px-xl py-2xl)                 │
│               │                                                            │
│               │                                                            │
│  ───────────  │                                                            │
│  المشرف ▾      │                                                            │
│  تسجيل الخروج   │                                                            │
└───────────────┴──────────────────────────────────────────────────────────┘
   platform-surface, platform hairline, sidebar pinned to the START edge (RTL → right)
```

**`AdminShell` props:** `children`, `pageTitle`, `headerActions?` (the one primary CTA slot), `activeNav`.
**Behavior:** on mount, if `!claim` → redirect `/login` (AC 2); if `claim && !claim.is_super_admin` → render
`DeniedState` (AC 1), fetch nothing. While `authLoading` → centered `state.loading`. Focus moves to
`#main-content` on route change (`focus-on-route-change`).

**`AdminSidebar` props:** `active('overview'|'audit')`, `onSignOut`.
- **Header:** platform monogram (a square `platform`-tinted SVG mark via `logo_search`/Lucide `shield`/
  `layout-grid`, **not** an emoji) + `admin.platform.badge`. This block is the persistent "you are on the
  platform" signal.
- **Nav items** (icon + label, `nav-label-icon`): `admin.nav.tenants` (→ `/admin`), `admin.nav.audit`
  (→ `/admin/audit`). Active item: `platform`-tinted fill + `aria-current="page"` (`nav-state-active`).
- **Footer:** the super-admin's own identity (name/email, LTR-isolated email) + **sign out** (reuse
  `auth.signOut`). Sign-out is spatially separated from nav (`destructive-nav-separation`).

**RTL/a11y:** sidebar pinned to the **start** edge (logical, mirrors to the right in RTL); nav order follows
reading order; `role="navigation"` with `aria-label`; below 1024px the drawer has a labelled toggle and traps
focus when open; the platform badge is `aria-hidden` decoration backed by the visible label text.

---

## 3. Screen — Platform overview (`/admin`)

**Purpose:** see every café business, its status and health, and act (provision / open / impersonate /
suspend). **Primary action:** **Provision tenant** (the one CTA, header end). Maps AC 5–6, 16.

### 3.1 Layout

```
Page header:  "نظرة عامة على المنصة"   ················   [ + تجهيز عميل جديد ]   (primary, end)
Stat strip:   [ إجمالي العملاء N ] [ نشط N ] [ موقوف N ]     (3 compact StatCards, tabular)
Filter bar:   [ 🔎 ابحث باسم العميل ............ ]   [ الكل | نشط | موقوف ]  (SegmentedControl)
Table:        TenantsTable  (DataTable §9.7)
```

### 3.2 `StatStrip` (health-at-a-glance summary)

Three `StatCard`s (label + tabular count): total / active / suspended. The suspended count uses
`status-maint`; it is a glance signal, not an action. Counts Arabic-Indic. Empty range → contextual zeros
(never a blank), same rule as Phase-6 KPI cards.

### 3.3 `TenantsTable` (built on `DataTable` §9.7)

Columns (start→end, RTL-mirrored). **Health is a derived, coarse signal** (spec §3.2): healthy =
has-≥1-active-owner **and** recent `audit_log` activity; otherwise "attention" with a specific cause.

| Column | Content |
|---|---|
| `admin.tenant.col.name` | name (`h3`) + slug/id (`text-faint`, **LTR-isolated**) |
| `admin.tenant.col.status` | `StatusPill` — active=`status-free`, suspended=`status-maint` + lock icon |
| `admin.tenant.col.health` | `StatusPill` — healthy=`status-free`; attention=`warning` + cause tooltip (`health.noOwner` / `health.idle`); suspended tenants show `health.suspended` (neutral, not a false "attention") |
| `admin.tenant.col.members` | count, tabular, Arabic-Indic |
| `admin.tenant.col.branches` | count, tabular, Arabic-Indic |
| `admin.tenant.col.created` | Arabic-Indic date; absolute on hover/title |
| `admin.tenant.col.lastActivity` | relative ("منذ ٣ ساعات") from `audit_log.created_at`; "—" if none |
| `admin.tenant.col.actions` | end cell: **Open** (→ detail) + overflow menu (`overflow-menu`): Impersonate, Suspend/Reactivate |

- **Suspended rows** render at .7 opacity + the lock icon (status is **never** color-only — pill + icon +
  dimming, `color-not-only`).
- **Search** filters by name (debounced, `debounce-throttle`); the **status SegmentedControl**
  (`all`/`active`/`suspended`) filters in place (AC 6); clearing both restores all. Filters AND together.
- The destructive row action (Suspend) lives in the **overflow menu**, never as a bare row button
  (`destructive-nav-separation`); it opens a confirm (§6).
- Virtualize at 50+ rows (`virtualize-lists`); sortable headers expose `aria-sort`; default sort = name asc
  (or last-activity desc — engineer's choice, documented).

### 3.4 Four states + denied

| State | Contract |
|---|---|
| **Empty** | No tenants at all: `EmptyState` icon + "لا يوجد عملاء بعد — جهّز أول عميل" + the Provision CTA (AC 16 first-run). Filtered-to-empty (e.g. status=suspended, none): a lighter inline empty row "لا يوجد عملاء بهذه الحالة" with a **clear-filter** affordance — distinct from the no-data-at-all state. |
| **Loading** | Stat strip + 6 shimmer table rows matching column widths (CLS < 0.1, > 300ms). |
| **Error** | Inline panel "تعذّر تحميل العملاء" + Retry (`error-recovery`, `role="alert"`). |
| **Offline / degraded** | Provision + all row mutations **disabled** with a chrome banner (system §8 web rule: super-admin disables mutations); the read list stays from last fetch. |
| **Denied** | Non-super-admin: `DeniedState` (`admin.denied.*`) with a single back action; no platform data in payload (AC 1). |

---

## 4. Screen — Tenant detail (`/admin/tenants/[id]`)

**Purpose:** one tenant's info, people, branches, recent platform audit, and the privileged actions
(provision is on the overview; **suspend/reactivate + impersonate** live here). Maps AC 7–8, 18–19, 21–26.

Breadcrumb: `admin.nav.tenants / <tenant name>` (`breadcrumb-web`, 2-level orientation). Sections as cards,
`space-y-2xl`:

1. **`TenantOverviewCard`** — name + status `StatusPill` + created date + counts (members / branches /
   owners), all tabular Arabic-Indic. Health signal repeated with its cause.
2. **`MembersTable`** — columns: name · email (LTR-isolated) · role (`admin.detail.role.*`) · active flag
   (`StatusPill` free/maint). Count must equal the overview's N (AC 7). Empty → inline "لا يوجد أعضاء".
3. **`BranchesList`** — read-only list of branch names; count equals M (AC 7). Empty → "لا توجد فروع".
4. **`RecentAuditCard`** — last ~10 platform-relevant audit rows **for this tenant**, most-recent-first
   (AC 8), each: time (Arabic-Indic) · actor · action (`admin.action.*`) · amount via `formatEgp` where
   present. A **"عرض كل السجل"** link → `/admin/audit?tenant=<id>` (pre-filtered).
5. **`DangerZoneCard`** — visually separated, `danger`-bordered, far from any primary action
   (`destructive-emphasis`). Holds **Suspend** (active tenants) / **Reactivate** (suspended). The
   **Impersonate** entry is a guarded `secondary` button carrying the `impersonation` violet on its icon —
   prominent but never a one-click silent jump (§7); placed in its own row, distinct from the danger zone
   (impersonation is dangerous but not *destructive* — different semantics).

**Four states:** overview/section skeletons on load; per-section error + retry (one section can fail without
the page); empty member/branch rows inline; offline disables all mutations (impersonate, suspend, reactivate)
with the chrome banner.

---

## 5. Lifecycle dialogs (provision · suspend · reactivate)

All built on `Dialog` (§9.3) + `Button`/`TextField`/`SegmentedControl` + `ConfirmDialog` (§9.8). Each writes
an `audit_log` row via its guarded server path (provision/suspend/reactivate); the UI shows
loading→success/error and never leaves partial state on a validation failure (AC 20). All validation on
**blur** (`inline-validation`); required fields marked `*`; first invalid field focused on submit error
(`focus-management`).

### 5.1 `ProvisionTenantDialog` (AC 16, 17, 20)

Two-step wizard with a progress indicator (`multi-step-progress`).

- **Step 1 — Business:** `admin.provision.field.name` (required) · `admin.provision.field.slug`
  (auto-suggested, editable, unique-validated, **LTR-isolated**, helper `slugHelper`). Region/timezone shown
  read-only = `Africa/Cairo` with a note that business-day logic uses Cairo (`@ps/core`, CLAUDE.md §3).
- **Step 2 — First owner:** `ownerName` (required) · `ownerEmail` (required, `type=email`, autocomplete,
  LTR-isolated) · `inviteMode` SegmentedControl (`invite.send` default / `invite.temp`).
- **Summary line** (`admin.provision.summary`) sets the AC-16 expectation: "creates tenant + first owner and
  writes an audit entry."
- **Submit:** spinner + disabled (`loading-buttons`); success → toast `admin.provision.success` + route to
  the new tenant detail (the new row also appears in the overview, optimistic). Failure → inline cause, form
  **preserved** (no data loss). **Idempotency:** client generates the tenant UUID (`@ps/core uuidv4`) so a
  double-submit upserts, not duplicates (CLAUDE.md §2.8).
- **Validation keys:** `nameRequired`, `ownerNameRequired`, `emailRequired`, `emailInvalid`, `slugTaken`.

### 5.2 `SuspendTenantDialog` (AC 18, 20)

High-friction destructive `ConfirmDialog`:

- **Body** `admin.suspend.body`: "members lose access immediately until reactivation" — sets the
  immediate-effect expectation (AC 18: gated by `is_active_member()` on next request, no token-expiry wait).
- **Required reason** `admin.suspend.reason` (≥5 chars, helper `reasonHelper`, persisted to audit meta).
  Validation `admin.suspend.validation.reasonRequired`.
- **Type-to-confirm:** `admin.suspend.confirmLabel` — the operator types the tenant name to enable Submit
  (extra friction for a tenant-wide destructive action). Validation `nameMismatch`.
- **Submit** uses `danger` fill; success → toast `admin.suspend.success`; the tenant's status pill flips to
  suspended everywhere.

### 5.3 `ReactivateTenantDialog` (AC 19)

Lighter `ConfirmDialog`: body `admin.reactivate.body` ("members regain access"), single confirm
(`admin.reactivate.submit`), success toast `admin.reactivate.success`. Not type-to-confirm (restorative, not
destructive).

---

## 6. Component contracts (lifecycle + table — new this phase)

| Component | Built on | Key props | States |
|---|---|---|---|
| `AdminShell` | — (new shell) | `pageTitle`, `headerActions?`, `activeNav`, `children` | authLoading · denied · ready |
| `AdminSidebar` | — | `active`, `onSignOut` | active-item highlight; collapsed/drawer < 1024 |
| `StatStrip` / `StatCard` | — | `label`, `value`, `tone?` | loading(skeleton) · ready · zero-with-context |
| `TenantsTable` | `DataTable` §9.7 | `tenants[]`, `query`, `status`, `onSearch`, `onStatusChange`, `onOpen`, `onImpersonate`, `onSuspendToggle`, `loading`, `error`, `onRetry` | four states + filtered-empty |
| `TenantOverviewCard` / `MembersTable` / `BranchesList` / `RecentAuditCard` | cards + `DataTable` | tenant-scoped data + counts | skeleton · per-section error · inline-empty |
| `DangerZoneCard` | card + `Button(danger)` | `status`, `onSuspend`, `onReactivate` | enabled · disabled(offline) |
| `ProvisionTenantDialog` | `Dialog`§9.3 | `open`, `onClose`, `onSubmit(payload)`, `submitting`, `error` | step1/step2 · per-field validation · submitting · error(form preserved) · `confirmOnDirty` |
| `SuspendTenantDialog` | `ConfirmDialog`§9.8 | `open`, `tenant`, `onConfirm({reason})`, `submitting`, `error` | default · reason-invalid · name-mismatch · submitting · error |
| `ReactivateTenantDialog` | `ConfirmDialog` | `open`, `tenant`, `onConfirm`, `submitting` | default · submitting |
| `DeniedState` | `EmptyState`§9.9 | `titleKey`, `bodyKey`, `onBack` | static |

`ProvisionTenantDialog` payload: `{ id (client uuid), name, slug, ownerName, ownerEmail, inviteMode }`.

---

## 7. Impersonation — the safety-critical flow (AC 21–29)

This is the most dangerous path on the platform. The design's single job: make it **impossible to start
silently, impossible to forget while active, and impossible to leave un-audited.** It uses the dedicated
`impersonation` violet (one-purpose, §2.2) and the **solid** banner sub-tokens (`impersonation-surface`,
`on-impersonation`, `impersonation-frame`, §2.4) — a deliberate departure from the calm tinted-fill rule
because a safety control must shout. Four redundant signals carry the state (never color alone): a
full-saturation violet **bar** + a persistent **text label** + a 3px inset **frame** + a live **countdown**.

```
Tenant detail ─[الدخول كـ]→ Start dialog ─[confirm]→ minted short-lived session ─→ Active (banner + frame)
                                  │                                                      │
                              [cancel]                                      [إنهاء الآن] / [auto-expire]
                                  ▼                                                      ▼
                            (no change)                            Return to /admin + audit stop row
```

### 7.1 `ImpersonationStartDialog` (entry — high-friction, never one-click; AC 21–23)

Guarded **secondary** button (`admin.tenant.action.impersonate`, violet icon) on tenant detail / row
overflow → opens this dialog (not a jump). It states consequences and captures intent:

- **Title** `admin.impersonate.start.title` ("الدخول كـ {tenant}") with the violet icon; tenant name
  LTR-isolated if Latin.
- **Consequences** (plain, three lines): `consequence1` (you act inside this tenant as the owner) ·
  `consequence2` ("limited to {duration}, ends automatically" — duration rendered Arabic-Indic) ·
  `consequence3` (entry + exit are written to the audit log).
- **Required reason** `admin.impersonate.start.reason` (helper `reasonHelper`, persisted to the start audit
  row; validated non-empty on blur — `validation.reasonRequired`).
- **Duration** `admin.impersonate.start.duration`: a `SegmentedControl` of presets within the cap
  (`duration.15/30/60`). Default **900s** when unspecified; any value above
  `platform_settings.impersonation_max_ttl_seconds` (3600) is **clamped** by the server — the dialog never
  offers a preset above the cap (AC 23). **Never unbounded.**
- **Suspended-tenant guard:** if the target is suspended, the Impersonate control is disabled with a tooltip
  `admin.impersonate.start.error.suspended`; a server 422 is also surfaced inline (AC 22).
- **Actions:** Cancel (start edge, ghost) · **Confirm** (end edge) — the confirm button uses the
  `impersonation` **violet** fill, not brand teal, so even the confirm signals the special mode. Loading +
  disabled on submit.
- **On confirm:** the server (edge function) **mints a real short-lived session** carrying
  `tenant_id=<target>`, scalar `roles`, `is_super_admin=true`, `impersonator_id`, `impersonation_exp`, writes
  the `impersonation.start` audit row (reason, target, ttl, expiry), and the browser receives **only a normal
  user session** — **no service-role/secret key ever reaches the client** (AC 29). The UI then routes into
  the impersonated tenant context with the banner already painted (§7.4 loading).

### 7.2 `ImpersonationBanner` — the always-on chrome (AC 24)

Persistent, full-width, **sticky at the very top above all other chrome** (highest z-index tier), `e3`
elevation, **solid `impersonation-surface` violet**, `on-impersonation` white text. Mounts a **3px
`impersonation-frame` inset border** around the whole app shell (belt-and-suspenders so the state reads even
if the banner scrolls inside a child region). Wraps **every** page while a session is active — including the
tenant operator surfaces, because you are now *inside* the tenant.

Layout (RTL-mirrored): **start** = violet shield icon + `admin.impersonate.banner.label` ("أنت تتصرّف كـ
{tenant}"). **center** = `admin.impersonate.banner.remaining` label + a **live countdown** = `LiveTimer`
in remaining mode, derived from `impersonation_exp` (timestamp, **never** an interval counter — CLAUDE.md
§2.2 / §9.10), tabular, Arabic-Indic; default `on-impersonation` white, → `warning` amber under ~2 min, →
`danger` red under ~30s (color/weight only, reduced-motion-safe). **end** = **End now** button
(`admin.impersonate.banner.endNow`, `danger`-adjacent, always reachable).

- **`ImpersonationBanner` props:** `tenantName`, `expiresAtIso`, `nowIso` (injected), `onEndNow`.
- **States:** active (violet) · warning (<2min) · critical (<30s) · expiring (hands to the interstitial).
  **Never hidden, never dismissible while active.**
- **RTL/a11y:** mirrored (identity start, countdown center, End-now end); `role="status"` /
  `aria-live="polite"` announces `admin.impersonate.banner.a11y` ("impersonation active — acting as {tenant},
  {time} remaining"); the countdown's `accessibilityLabel` reads remaining time in words, not raw glyphs; the
  countdown is a clock → **not mirrored** (§6 RTL rule). **End now is a skip-link target** — keyboard-
  reachable from any focus position, never behind a menu (`escape-routes`, highest-priority escape).

### 7.3 Exit & expiry (AC 26–28)

- **Manual end** — **End now** → `ImpersonationEndDialog` (`ConfirmDialog`, title `admin.impersonate.end.title`,
  body `end.body` "you'll return to your platform admin account") → on confirm: ends the session, writes the
  `impersonation.stop` audit row (reason "ended by operator"), reverts the claim to the super-admin's own
  context (no impersonated `tenant_id`/`impersonator_id` in the next claim — AC 26), routes back to
  `/admin/tenants/[id]` with toast `admin.impersonate.end.success`.
- **Auto-expiry** — when the countdown hits zero (or the hook drops the claim on refresh past
  `impersonation_exp`, AC 27): `ImpersonationExpiredInterstitial` — a **non-dismissible** modal (scrim,
  focus moved to it), title `admin.impersonate.expired.title`, body `expired.body`, single action
  `expired.return`. The `impersonation.stop` audit row is written (reason "expired"). **No silent
  extension**; re-entry requires a fresh Start dialog (new reason, new audit pair).
- **Audit invariant (the hard design rule):** there is **no UI path** that enters or leaves impersonation
  without a corresponding `audit_log` pair (`impersonation.start` / `impersonation.stop`). Maps AC 26, 28.

### 7.4 Impersonation four states

| State | Contract |
|---|---|
| **Loading** | Start-dialog submit: spinner + disabled. Entering the impersonated context: skeleton of the tenant shell **with the banner + frame already painted** — the mode is signaled before content loads. |
| **Empty** | n/a as a data surface (audit empties live in §8). |
| **Error** | Start failure → inline cause + retry; **no session started, no `impersonation.start` row written** (audit reflects only real sessions). End-now failure → the banner **stays** (fail-safe: never leave the operator silently still-impersonating without the chrome) + a retry toast. |
| **Offline** | Cannot **start** while offline (minting an audited time-boxed session needs the live backend — Impersonate + confirm disabled with a banner). An **already-active** session keeps its banner + countdown (timestamp-derived → expires correctly even offline); End-now queues and reconciles, and the local frame/countdown still enforces the visual time-box. |

### 7.5 Impersonation component contracts

| Component | Built on | Key props | States |
|---|---|---|---|
| `ImpersonationStartDialog` | `ConfirmDialog`§9.8 + `SegmentedControl`§9.4 + `TextField` | `open`, `tenant`, `maxTtlSec`, `presets[]`, `onConfirm({reason, ttlSec})`, `submitting`, `error` | default · reason-invalid · suspended-blocked · submitting · error(form preserved) |
| `ImpersonationBanner` | — (new) | `tenantName`, `expiresAtIso`, `nowIso`, `onEndNow` | active · warning · critical · expiring; never hidden/dismissible |
| `ImpersonationEndDialog` | `ConfirmDialog` | `open`, `tenantName`, `onConfirm`, `submitting` | default · submitting · error(banner stays) |
| `ImpersonationExpiredInterstitial` | `Dialog`(non-dismissible) | `tenantName`, `onReturn` | static, focus-trapped |

---

## 8. Screen — Platform audit view (`/admin/audit`) (AC 30–32)

**Purpose:** the **cross-tenant** audit trail — read-only, filterable, the operator's incident-investigation
surface and the place every impersonation/lifecycle action is provable. This is the **single ratified
cross-tenant read** (spec §5, ADR-0008); the design never implies any other cross-tenant reach.

### 8.1 Layout

```
Page header:  "سجل التدقيق عبر المنصة"   "كل الإجراءات عبر جميع العملاء — للقراءة فقط"
Filter bar:   [ العميل ▾ ] [ المنفّذ ▾ ] [ الإجراء ▾ ] [ من تاريخ ] [ إلى تاريخ ] [ مسح الفلاتر ]
Table:        AuditTable (DataTable §9.7, virtualized, most-recent first)
```

### 8.2 `AuditTable` (built on `DataTable` §9.7)

| Column (start→end) | Content |
|---|---|
| `admin.audit.col.time` | timestamp, Arabic-Indic, most-recent first |
| `admin.audit.col.tenant` | tenant name (LTR-isolated id on hover) |
| `admin.audit.col.actor` | actor name/email (LTR-isolated email) |
| `admin.audit.col.action` | localized `admin.action.*` label |
| `admin.audit.col.entity` | entity + id (LTR-isolated) |
| `admin.audit.col.amount` | `formatEgp` + Arabic-Indic **only when money-affecting**, else "—"; tabular, end-aligned |
| `admin.audit.col.detail` | meta summary (reason / target / expiry), legible per row type |

- **Filters** (AC 31): tenant (`filter.allTenants` default), actor, action type (`filter.allActions`
  default), date-from / date-to. Combined filters **AND** together; `filter.clear` restores the full set.
  Date inputs are business-day-agnostic here (raw timestamps — this is an audit trail, not a business
  report), Arabic-Indic display.
- **Impersonation & lifecycle rows are first-class and filterable** (AC 32): rows for
  `impersonation.start` / `impersonation.stop` / `tenant.*` are tinted with the `impersonation` (for
  impersonation) or a neutral lifecycle treatment, with a leading icon, and their `meta` (reason, target,
  expiry) is legible.
- **Rows produced *during* an impersonation** (any audited action carrying `impersonator_id` in meta, AC 25)
  show a small `admin.audit.impersonated` chip ("أثناء دخول مؤقت بواسطة {actor}") with the `impersonation`
  violet at low alpha — so an action taken *as* a tenant is visibly attributable to the operator.
- Money via `formatEgp` (tabular, end-aligned); virtualized (`virtualize-lists`); `aria-sort` on sortable
  headers.

### 8.3 Four states

| State | Contract |
|---|---|
| **Empty** | Filtered-to-empty: `EmptyState` `admin.audit.empty.*` ("no rows match these filters") + a clear-filters affordance. No-data-at-all (fresh platform): same component, body adjusted. Never a blank table. |
| **Loading** | Filter bar renders immediately; table = shimmer rows (CLS < 0.1). |
| **Error** | Inline panel + Retry (`role="alert"`); filters stay usable. |
| **Offline / stale** | Read-only surface: shows last fetch with a refresh affordance + "آخر تحديث" caption (system §8 web rule); no mutations exist here. |

---

## 9. The four states at portal level + denied (summary)

Every data surface in the portal specifies all four (system §8) — itemized per screen in §3.4, §4, §7.4,
§8.3. The **denied** state (`DeniedState`, `admin.denied.*`) is the UX face of the route role-gate (AC 1):
shown to any non-super-admin who reaches `/admin`, with a single back action and **zero platform data in the
payload**. The real gate is server-side (every fetch re-verifies `is_super_admin()`, AC 4) — the UI never
relies on the client guard alone.

---

## 10. Cross-cutting contracts (binding)

- **No cross-tenant reach beyond what ADR-0008 ratifies.** The design surfaces exactly two cross-tenant data
  reads — the **platform audit view** (§8) and the **overview/detail counts** — both `is_super_admin()`-gated
  reads. **No** UI implies a standing cross-tenant *write*; the only cross-tenant write path is **via
  impersonation** (a normal-looking minted session enforced by the same RLS). The design must never send a
  tenant id from the client to widen scope.
- **No service-role/secret key in the browser** (AC 29, CLAUDE.md §5): the portal calls edge functions with
  the super-admin's user JWT; the mint happens server-side only; the client receives only a normal session.
- **Money (CLAUDE.md §2.1, §4):** every amount is integer piastres in state, rendered **only** via
  `formatEgp` (Arabic separator `٬`, suffix `ج.م`). No inline currency math anywhere (audit amount column,
  detail meta).
- **Numerals (CLAUDE.md §2.6):** all *displayed* digits Arabic-Indic via `toArabicDigits` (counts, dates,
  countdown, ttl, amounts); business/query/log values stay Western. The portal renders **no** CSV this phase
  (no Western-digit export surface).
- **Time/timers (CLAUDE.md §2.2):** the impersonation countdown derives from `impersonation_exp` via
  `LiveTimer` (timestamp-derived, never `setInterval` elapsed) so a backgrounded tab or dropped network
  cannot mis-display the remaining window.
- **All strings via i18n (CLAUDE.md §6):** zero hardcoded copy — nav, badges, table headers, filter labels,
  dialog copy, consequence lines, audit action labels, validation, empty/error/denied. Inventory in §11.
- **A11y floors (system §7):** focus → `#main-content` on route entry; visible 2–4px `primary` focus rings;
  contrast verified both themes (the violet banner ≥4.5:1 white-on-fill, §2.4); interactive controls ≥ 44
  (web; the 52px counter-speed floor is a mobile rule — this is a desktop ops tool, but dialog actions and
  row controls stay ≥ 44 with ≥ 8px spacing); reduced-motion disables skeleton shimmer and the countdown's
  critical-state cue is color/weight only; destructive actions (suspend, end-impersonation) use `danger`,
  are spatially separated, and require confirmation.

---

## 11. i18n key inventory (Phase 7 — keys only; Arabic strings live in `apps/web/src/i18n/messages/ar.json`)

```
admin.platform.badge · admin.platform.name · admin.platform.monogramAlt
admin.nav.tenants · admin.nav.audit
admin.signedInAs                                  ("مشرف المنصة: {name}")

admin.denied.title · admin.denied.body · admin.denied.back

admin.overview.title · admin.overview.subtitle
admin.overview.stat.total · admin.overview.stat.active · admin.overview.stat.suspended
admin.overview.search · admin.overview.provision
admin.overview.filter.all · admin.overview.filter.active · admin.overview.filter.suspended
admin.overview.empty.title · admin.overview.empty.body
admin.overview.filteredEmpty · admin.overview.clearFilters
admin.overview.error

admin.tenant.col.name · admin.tenant.col.status · admin.tenant.col.health
admin.tenant.col.members · admin.tenant.col.branches · admin.tenant.col.created
admin.tenant.col.lastActivity · admin.tenant.col.actions
admin.tenant.status.active · admin.tenant.status.suspended
admin.tenant.health.healthy · admin.tenant.health.attention
admin.tenant.health.noOwner · admin.tenant.health.idle · admin.tenant.health.suspended
admin.tenant.lastActivity.none                    ("—")
admin.tenant.action.open · admin.tenant.action.impersonate
admin.tenant.action.suspend · admin.tenant.action.reactivate

admin.detail.breadcrumb · admin.detail.overview · admin.detail.created
admin.detail.counts.members · admin.detail.counts.branches · admin.detail.counts.owners
admin.detail.members · admin.detail.members.empty
admin.detail.member.col.name · admin.detail.member.col.email
admin.detail.member.col.role · admin.detail.member.col.active
admin.detail.role.owner · admin.detail.role.manager · admin.detail.role.staff
admin.detail.branches · admin.detail.branches.empty
admin.detail.audit · admin.detail.audit.viewAll
admin.detail.dangerZone

admin.provision.title
admin.provision.step.business · admin.provision.step.owner
admin.provision.field.name · admin.provision.field.slug · admin.provision.field.slugHelper
admin.provision.field.region                      (read-only "Africa/Cairo" note)
admin.provision.field.ownerName · admin.provision.field.ownerEmail
admin.provision.field.inviteMode
admin.provision.invite.send · admin.provision.invite.temp
admin.provision.summary
admin.provision.next · admin.provision.back · admin.provision.submit
admin.provision.success
admin.provision.validation.nameRequired · admin.provision.validation.ownerNameRequired
admin.provision.validation.emailRequired · admin.provision.validation.emailInvalid
admin.provision.validation.slugTaken

admin.suspend.title · admin.suspend.body
admin.suspend.reason · admin.suspend.reasonHelper
admin.suspend.confirmLabel · admin.suspend.submit · admin.suspend.success
admin.suspend.validation.reasonRequired · admin.suspend.validation.nameMismatch

admin.reactivate.title · admin.reactivate.body
admin.reactivate.submit · admin.reactivate.success

admin.impersonate.start.title
admin.impersonate.start.consequence1 · admin.impersonate.start.consequence2
admin.impersonate.start.consequence3
admin.impersonate.start.reason · admin.impersonate.start.reasonHelper
admin.impersonate.start.duration · admin.impersonate.start.submit
admin.impersonate.start.validation.reasonRequired
admin.impersonate.start.error.suspended
admin.impersonate.duration.15 · admin.impersonate.duration.30 · admin.impersonate.duration.60

admin.impersonate.banner.label · admin.impersonate.banner.remaining
admin.impersonate.banner.endNow · admin.impersonate.banner.a11y

admin.impersonate.end.title · admin.impersonate.end.body
admin.impersonate.end.submit · admin.impersonate.end.success

admin.impersonate.expired.title · admin.impersonate.expired.body
admin.impersonate.expired.return

admin.audit.title · admin.audit.subtitle
admin.audit.filter.tenant · admin.audit.filter.actor · admin.audit.filter.action
admin.audit.filter.dateFrom · admin.audit.filter.dateTo
admin.audit.filter.allTenants · admin.audit.filter.allActions · admin.audit.filter.clear
admin.audit.col.time · admin.audit.col.tenant · admin.audit.col.actor
admin.audit.col.action · admin.audit.col.entity · admin.audit.col.amount · admin.audit.col.detail
admin.audit.empty.title · admin.audit.empty.body
admin.audit.impersonated                          ("أثناء دخول مؤقت بواسطة {actor}")
admin.audit.noAmount                              ("—")

admin.action.tenant.provision · admin.action.tenant.suspend · admin.action.tenant.reactivate
admin.action.impersonation.start · admin.action.impersonation.stop
```

**Reused existing keys (no re-introduction):** `auth.signOut`, `action.retry`, `action.cancel`,
`action.close`, `state.loading`, `state.error.generic`, `web.offline.stale`, `app.name`, `branch.label`.

---

## 12. Design tokens added this phase

Registered in **`docs/design/design-system.md §2.4`** (the source of truth):

- **`platform`** — steel-indigo identity hue for the admin chrome (sidebar active item, platform badge,
  header hairline). **Identity-only**, never action/status/chart/impersonation.
- **`platform-surface`** — the admin chrome surface (one step off the canvas, so the shell reads as platform).
- **`impersonation-surface`** — solid violet fill for the impersonation banner (white text clears AA both
  modes).
- **`on-impersonation`** — text/icon on the banner fill.
- **`impersonation-frame`** — the 3px violet inset frame around the whole shell while impersonating.
- **Banner countdown states** reuse the existing `warning` (<2 min) / `danger` (<30s) tokens — no new token.

No new spacing/radius/type/motion tokens — the portal composes the existing scale verbatim.

---

## 13. Component-draft note (21st.dev magic MCP)

The magic MCP may draft concrete **web** shells for `AdminSidebar`, `TenantsTable`, `ProvisionTenantDialog`,
the `ImpersonationBanner`, and `AuditTable` against the contracts above. When used, **discard any output
that:** (a) hardcodes Latin/Western numerals or inline currency — must route through `formatEgp` /
`toArabicDigits`; (b) assumes LTR layout — must follow the system §6 RTL rules (logical start/end, no
hardcoded left/right, LTR-isolated emails/slugs/ids); (c) ships a surface without the four states / denied
state; (d) renders the impersonation banner as a calm tinted strip — it **must** be the solid
`impersonation-surface` violet with the persistent label + frame + countdown (§7.2); (e) introduces a loud
new action color for the platform chrome — the action accent stays `primary` teal, identity stays the
restrained `platform` steel. Keep only the **visual vocabulary** (sidebar framing, table density, dialog
layout, banner proportions) and bind it to the tokens + contracts here — exactly as Phases 3 and 6 did with
rejected MCP samples.

---

## 14. Relationship to the Phase-2 conceptual docs

`docs/design/super-admin-console.md` and `docs/design/impersonation.md` were authored in Phase 2 as
forward-looking rationale before the chrome and backend existed. **This doc is the build-time source of
truth for Phase 7** and reconciles their two open points: (1) **chrome** — sidebar confirmed (§1.3,
distinct from the Phase-6 tenant top bar); (2) **language** — Arabic-first now, bilingual reserved (§1.4).
Where the Phase-2 docs and this doc differ, **this doc wins**; the Phase-2 docs remain as originating
rationale and the impersonation UX invariants they established (visually unmistakable, time-boxed, audited
entry+exit pair, no silent path) are carried verbatim here.
```