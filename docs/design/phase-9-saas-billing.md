# Feature design — Phase 9: SaaS billing (Stripe subscriptions · trial → tiers · paywall · plan management)

> Tokens, type, spacing, motion, RTL, a11y, the four states, and every shared primitive come from
> **`docs/design/design-system.md`** ("Calm Operations"). The **billing status→token mapping, the usage-meter
> colour convention, and the platform-currency formatter contract** are registered there in **§2.5**; this
> doc composes against them and never re-derives a token.
>
> - **Surface:** `apps/web` only (Next.js 15 / React 19 + shadcn/Radix + Tailwind). Two contexts:
>   the **owner dashboard** (`/dashboard/billing`, top-bar chrome) and the **super-admin portal**
>   (`/admin/subscriptions`, sidebar chrome). **No mobile feature work** (spec §3); the counter app at most
>   *respects* the resolved read-only/cap state if trivially shared — no billing UI there.
> - **Spec:** `docs/specs/phase-9-saas-billing-stripe.md` — design to the **ux hand-off §7** and the ACs:
>   Block E (owner billing UI 25–29), Block F (plan-limit enforcement 30–32), Block G (super-admin plan
>   management 33–35), Block H (RTL/i18n 36–37). Blocks A–D, I, J are core/backend/security/verify (no UI
>   surface, but the design must not assume any reach those blocks don't ratify).
> - **Continuity:** reuses the existing owner chrome (`DashboardPageShell` + `TopBarSimple`,
>   `EmptyState`/`ErrorState`/`Skeleton`/`StatusPill`/`Button`/`TextField`) **and** the Phase-7 admin chrome
>   (`AdminShell` + `AdminSidebar`, the `StatStrip` / `TenantsTable` / `*Dialog` patterns). Same look as
>   `/dashboard/reports` (owner) and `/admin` (platform). It adds **one** owner nav item and **one** admin
>   nav item — nothing structurally new in the shells.
> - **Two money axes, kept visibly separate (CLAUDE.md §2.1, spec §5).** Café operational money is EGP
>   piastres via `formatEgp` and is untouched. The subscription charge is the **platform→tenant** amount in
>   the platform billing currency (§2.5 formatter contract) — always labelled with its currency so it is
>   never read as in-app EGP.
> - **The UI never holds a secret.** Every Stripe redirect (Checkout, Portal) is a **server-minted URL**
>   returned by an edge function; the browser only follows it (spec §3.4–§3.5, AC 20/26/27). No publishable
>   key, secret key, or signing secret is a design concern beyond "the button calls a function and redirects."
> - **The billing page is never gated.** Whatever the paywall does to the rest of the app, `/dashboard/billing`
>   + its Checkout/Portal actions are **always reachable** so the owner can always recover (spec §3.7, AC 28).
> - **Trial = learning input only.** Pochinki never had subscriptions; nothing is carried from it.

---

## 1. Direction & the two contexts

### 1.1 Surface map (what Phase 9 adds)

```
OWNER (top-bar chrome, /dashboard/*)
  TopBar nav:  الأجهزة | قواعد الأسعار | قائمة المنتجات | التقارير | [+ الفوترة]   ← new owner-only item
                                                                       │
                                                          /dashboard/billing
                                                                       │
   ┌────────────────────────────────────────────────────────────────────────┐
   │  [ paywall banner — only when past_due / canceled / read-only ]          │
   │  CurrentPlanCard:  plan · status pill · trial-end|renewal · amount       │
   │  UsageMeterGroup:  branches ▓▓░  · devices ▓▓▓▓░ · staff ▓░             │
   │  PlanComparison:   [ tier cards ]  → Upgrade (Checkout)  · Manage(Portal)│
   └────────────────────────────────────────────────────────────────────────┘

APP-WIDE (every /dashboard surface)
  ReadOnlyModeBanner   ← persists across the app while read-only (grace-elapsed / canceled)
  LimitReachedDialog   ← raised at any create point (add branch/device/staff) when the cap is hit

SUPER-ADMIN (sidebar chrome, /admin/*)
  Sidebar nav:  العملاء | [+ الاشتراكات] | سجل التدقيق          ← new platform item
                              │
                  /admin/subscriptions
                              │
   ┌────────────────────────────────────────────────────────────────────────┐
   │  SubscriptionStatStrip:  [اشتراكات نشطة N] [تجريبي N] [متعثّر N] [MRR≈]  │
   │  Filter bar:  [ الحالة ▾ ] [ الخطة ▾ ] [ 🔎 بحث ]                        │
   │  SubscriptionsTable:  tenant · plan · status · period-end · amount · ⋯   │
   │                                            └ comp/override → dialog       │
   └────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Personality

Billing is a **trust surface in a cash business**: calm, factual, never punitive. The hardest design job is
the *lapse* — a `past_due`/`canceled` café must feel *helped toward recovery*, not locked out and scolded.
`ui-ux-pro-max` drivers applied: `primary-action` (one CTA per surface — Upgrade on the owner page, Comp on
the admin dialog), `error-clarity` + `error-recovery` (every paywall state names the cause **and** the fix),
`empty-states` / `disabled-states` (a hit cap is an explainable, actionable disabled state, never a dead
button), `confirmation-dialogs` + `destructive-emphasis` (the super-admin comp/override is reason-gated and
audited), `progressive-disclosure` (plan details expand; the page leads with "where you stand" then "what to
do"), `number-tabular` + `contrast-feedback` throughout.

### 1.3 Role gates (who sees what)

- **Owner** → full `/dashboard/billing`: plan, usage, Upgrade (Checkout), Manage (Portal), paywall recovery.
- **Manager / staff** → **denied** the billing *management* route (spec §7 Q9 default = owner-only). The nav
  item is **hidden** for them (the `empty-nav-state` pattern already used for Reports). If they deep-link to
  `/dashboard/billing` they get a `DeniedState` ("الفوترة متاحة للمالك — راجع المالك"), **and** when the app
  is read-only or a cap is hit they see the **staff variant** of the banner/dialog: a calm "أبلغ المالك"
  message, never Checkout/Portal controls (AC 29, spec story "ask the owner").
- **Super-admin** → `/admin/subscriptions` (all tenants, read-only list + comp/override). Dual-gated exactly
  like the rest of `/admin` (client guard renders the shell; every fetch/RPC re-verifies `is_super_admin()`).
  A non-super-admin reaching it gets the existing `AdminDeniedState` (AC 35).

The client gate is a courtesy; the **server** is the real gate (owner-only edge functions for Checkout/Portal;
service-role-only RPC for comp/override). The UI never sends a tenant id to widen scope.

---

## 2. Information architecture & navigation

- **Owner nav item:** `nav.billing` ("الفوترة") appended to `TopBarSimple`'s nav list, **owner-gated** with
  the exact same `isOwner` check already used for Reports (`claim.roles === 'owner' || is_super_admin`).
  Active state reuses the existing `nav-state-active` pattern (`bg-surface-3 text-primary`, `aria-current`).
  Route: `/dashboard/billing`, `dynamic = 'force-dynamic'` like the other dashboard pages.
- **Admin nav item:** `admin.nav.subscriptions` ("الاشتراكات") inserted into `AdminSidebar` **between**
  Tenants and Audit, with its own icon (Lucide `credit-card`, stroke 1.5, matching the existing sidebar icon
  set — never emoji). This requires widening the `AdminNav` union type from `'overview' | 'audit'` to
  `'overview' | 'subscriptions' | 'audit'` (the only shell change this phase). Route: `/admin/subscriptions`.
- **No breadcrumb** on either page (both are single-level, like rate-rules/products/overview). The page title
  in the header provides orientation; the comp/override dialog opens from a row, not a sub-route.
- **Cross-links:** the Phase-7 tenant detail page (`/admin/tenants/[id]`) gains a small **read-only**
  "الاشتراك" line in its `TenantOverviewCard` (plan + status pill + period-end) with a link to
  `/admin/subscriptions?tenant=<id>` (pre-filtered) — so an operator investigating a tenant sees its billing
  at a glance. This is a display-only addition; no new write path on the detail page.

---

## 3. Screen — Owner billing (`/dashboard/billing`)

**Purpose:** the owner sees exactly where they stand (plan, status, what's left of the trial / when the next
charge lands, usage vs limits) and has one clear path forward (Upgrade or Manage). **Primary action:**
**Upgrade / Subscribe** (Checkout) when not yet on a paid plan, else **Manage billing** (Portal). Maps
AC 25–29.

Container matches the other dashboard pages: `max-w-7xl mx-auto px-xl py-2xl`, `space-y-2xl` between
sections. Desktop-primary, responsive to tablet (cards stack to 1 column < 768; the plan grid goes 1-col).

### 3.1 `PaywallBanner` (top of page **and** app-wide — the calm lapse signal)

The single most important piece of this phase. It appears **only** when the resolved entitlement is not in a
clean `trialing`/`active` state. It is *informational + actionable*, never alarmist: tinted fill (not the
solid impersonation treatment — that violet is one-purpose, §2.4), an icon, one sentence of cause, one
sentence of consequence, and a recovery CTA. Four variants by resolved state (§2.5 mapping):

| Variant | Token | Copy intent | CTA |
|---|---|---|---|
| `trialEnding` (trial, ≤ N days left) | `info` blue | "تنتهي تجربتك خلال {n} يوم" | **اشترك الآن** → Checkout |
| `pastDueGrace` (within grace) | `warning` amber | "تعذّر تحصيل الدفعة — لديك {n} يوم لتحديث البطاقة قبل تعليق العمليات" | **حدّث طريقة الدفع** → Portal |
| `readOnly` (grace elapsed / canceled) | `danger` red | "الحساب في وضع القراءة فقط — جدّد اشتراكك لاستئناف الجلسات والطلبات" | **جدّد الاشتراك** → Checkout/Portal |
| `comped` (super-admin grant) | `platform` steel | "خطة ممنوحة من المنصة — {plan}" | (none — informational) |

- **Always-recover invariant (AC 28, binding):** in `readOnly` the banner's CTA and the whole billing page
  remain fully interactive even though the rest of the app is read-only. The banner explicitly reassures
  ("يمكنك دائمًا الدفع من هنا لاستعادة الوصول").
- **Staff variant:** for a manager/staff member the same banner shows the cause but the CTA becomes a
  non-link "أبلغ مالك الحساب" (no Checkout/Portal). No billing amounts shown to staff beyond the status.
- **App-wide placement:** `pastDueGrace` and `readOnly` also render as a slim persistent strip below the
  `TopBarSimple` on **every** `/dashboard` surface (the `ReadOnlyModeBanner`, §6) so the state is never a
  surprise discovered only on the billing page. The full banner with copy + CTA lives on the billing page;
  the app-wide strip is its compact echo + a "إدارة الفوترة" link.
- **RTL/a11y:** `role="status"` (grace/trial) / `role="alert"` (readOnly), `aria-live="polite"`; icon at the
  start, CTA at the end (mirrored); colour is never the only signal (icon + label + the CTA verb carry it);
  contrast verified both themes for all four tints; never flashes (anti-panic, same rule as the Phase-8
  dead-letter banner).

### 3.2 `CurrentPlanCard`

The "where you stand" hero. One card, `surface` + `e0`, holding:

- **Plan name** (`h2`, e.g. "الخطة الاحترافية") + a **`BillingStatusPill`** (§5) to its end.
- **The date line** that matters for the current status (`label`, tabular, Arabic-Indic):
  - `trialing` → "تنتهي التجربة في {date} · {n} يوم متبقٍ" (countdown derived from `trial_end`, a
    **timestamp**, never an interval — same discipline as `LiveTimer`, CLAUDE.md §2.2; a day-granularity
    derived value, recomputed at render).
  - `active` → "التجديد التالي في {date}".
  - `active` + `cancel_at_period_end` → "ينتهي الوصول في {date} (تم إلغاء التجديد)" with a muted note.
  - `past_due` → "آخر محاولة دفع تعثّرت · المهلة حتى {graceUntil}".
  - `canceled` → "انتهى الاشتراك في {date}".
- **The amount line** (paid plans): the subscription price via the §2.5 `formatMoneyMinor` formatter with the
  currency shown explicitly + interval ("{amount} {currency} / شهريًا"). Tabular. **Never** `formatEgp`.
- **Manage billing** secondary button at the card end (Portal) when a Stripe customer exists; absent on a
  pure trial (nothing to manage yet — directs to Subscribe instead).

**`CurrentPlanCard` props:** `plan` ({ key, nameKey, amountMinor?, currency?, interval }), `status`,
`trialEndIso?`, `currentPeriodEndIso?`, `cancelAtPeriodEnd`, `comped`, `nowIso` (injected for the countdown),
`onManageBilling`, `managePending`, `loading`, `error`, `onRetry`.

### 3.3 `UsageMeterGroup` + `UsageMeter` (plan limits vs current usage)

Three meters (branches / devices / staff), each built per the **§2.5 usage-meter convention**. A meter shows
the resource label, the literal "{used} / {limit}" count (tabular, Arabic-Indic), and a track+fill bar whose
fill recolours `primary` → `warning` (≥80%) → `danger` (=100%). At the cap it shows a lock icon + "بلغت الحد"
and the relevant create action elsewhere in the app is disabled (§6).

- **Unlimited caps** (a plan with no limit on a dimension) render "∞ / غير محدود" with no bar (and never a
  full red bar). The resolver supplies `limit: null` for unlimited.
- **`UsageMeter` props:** `labelKey`, `used` (number), `limit` (number | null), `loading`, `error`.
- **`UsageMeterGroup` props:** `meters[]`, `loading`, `error`, `onRetry`.
- **RTL/a11y:** the bar **grows from the start edge** (right in RTL); `role="meter"` /
  `aria-valuenow`/`aria-valuemax`/`aria-valuetext` (the valuetext is the spoken "{used} of {limit}", not raw
  glyphs); colour never alone (count + lock icon + label carry it); near-limit announced via the valuetext,
  not colour.

### 3.4 `PlanComparison` + `PlanCard` (the tier picker → Checkout)

A responsive grid of tier cards (the seeded catalog, ADR-0010 Q1 — e.g. Basic / Pro; the `trial` plan is the
*current* state, not a buyable card). One card per buyable tier:

- **Header:** tier name (`h3`) + price ("{amount} {currency} / شهريًا" via `formatMoneyMinor`).
- **Limit summary:** the tier's caps as a short list (branches / devices / staff) + any feature flags, each
  with a check icon (consistent icon set, `icon-style-consistent`).
- **The current tier** is marked with a "خطتك الحالية" ribbon/badge and its CTA is disabled (you can't
  "upgrade" to what you have). Tiers **below** the current one (downgrades) route through the **Portal**, not
  Checkout (Stripe handles proration) — labelled "إدارة عبر البوابة"; tiers **above** show **Upgrade** →
  Checkout for that tier's price id.
- **CTA per card:** `Button variant='primary'` "الترقية" (the one primary accent on the page, on the
  recommended/next tier) → calls `create-checkout-session` for that plan, then redirects to the returned URL.
  Shows an inline spinner + disabled while the URL is being minted (`loading-buttons`). Other cards use
  `secondary`.
- **Recommended tier** may carry a subtle `primary` hairline border (the only saturated accent in the grid)
  — `primary-action` (one visual primary).

**`PlanCard` props:** `plan` ({ key, nameKey, amountMinor, currency, interval, limits, features }),
`relation('current'|'upgrade'|'downgrade')`, `onUpgrade(planKey)`, `onManage`, `pending`.
**`PlanComparison` props:** `plans[]`, `currentPlanKey`, `onUpgrade`, `onManage`, `pendingPlanKey?`,
`loading`, `error`, `onRetry`.

### 3.5 Return-from-Checkout / Portal states (`CheckoutReturnState`)

Checkout/Portal return to `/dashboard/billing` with a query flag (`?checkout=success|cancel`,
`?portal=return`). Because **the webhook is the source of truth** (not the redirect — spec §3.3), success is
an *interim* state:

| Return | Treatment |
|---|---|
| `checkout=success` | A success `Toast` ("تم الدفع — يتم تفعيل اشتراكك الآن") **plus** a **finalizing** state on `CurrentPlanCard`: a `incomplete`/"قيد الإتمام" pill + a subtle spinner, polling the subscription row (or a manual "تحديث" affordance) until the webhook flips it to `active`. Copy makes clear activation is "خلال لحظات" — never claims active before the row confirms it (AC 26). |
| `checkout=cancel` | A quiet `info` `Toast` ("لم يكتمل الدفع — لم يتم خصم أي مبلغ") and the page returns to its prior state. No error styling — cancelling is normal. |
| `portal=return` | Silent refetch of the subscription row (the Portal may have changed card/plan/cancel) + a light "تم تحديث بيانات الفوترة" `Toast`. |

The query flag is cleared from the URL after handling (no sticky state on refresh).

### 3.6 The four states + denied (owner billing page)

| State | Contract |
|---|---|
| **Empty** | There is **always** a subscription row (created at provision in `trialing`, spec §3.2/Q8), so the page is never truly data-empty. The "fresh trial, no Stripe customer yet" case is the *default* content (trial card + plan picker + Subscribe CTA, no Manage button) — not an empty state. |
| **Loading** | Skeletons matching the final layout: a `CurrentPlanCard` skeleton (plan line + date line + amount), three `UsageMeter` skeletons, and plan-card skeletons (shimmer > 300ms, reserves height → CLS < 0.1). The paywall banner only renders once status resolves (no skeleton flash of a scary state). |
| **Error** | Subscription fetch fails → one `ErrorState` + Retry in the content region; the page chrome stays. Usage fetch can fail independently → the `UsageMeterGroup` shows its own inline error + retry without taking down the plan card (`error-recovery`). `role="alert"`. |
| **Offline / stale** | Read-on-demand (no outbox here). Shows last-fetched figures with a refresh affordance + "آخر تحديث: {time}" caption so a stale status is never mistaken for live. Checkout/Portal buttons **disable while offline** (minting a redirect needs the live backend) with a tooltip; an already-resolved read-only state still shows its banner (resolved from the stored row + injected now). |
| **Denied (non-owner)** | Manager/staff deep-linking here → `DeniedState` (`billing.denied.title`/`.body`) with a single action back to `/dashboard`. The nav item is hidden for them. Real gate is server-side. |

---

## 4. Entitlement enforcement UX (the paywall, in-app) — AC 30–32

Two enforcement surfaces, both calm and actionable. (The *authoritative* enforcement is server/DB per
ADR-0010 Q3; the UI mirrors it and must never be the only gate.)

### 4.1 `LimitReachedDialog` (cap hit at a create point)

When an owner/manager tries to create a resource beyond the plan cap (add branch / device / staff), the
create control is **disabled with an explainer** *and* — if they reach it anyway (e.g. a server 4xx from the
cap backstop) — a `ConfirmDialog`-style dialog explains and offers the upgrade path:

- **Title** `billing.limit.title` ("بلغت حد خطتك").
- **Body** `billing.limit.body` — names the dimension + the cap ("خطتك تسمح بـ {limit} {resource}؛ أنت تستخدم
  {used}").
- **Actions:** owner → **الترقية** (`primary`) routing to `/dashboard/billing#plans`; manager/staff →
  **أبلغ المالك** (no upgrade control) + Close. Cancel at the start.
- **Disabled-affordance (the primary path):** the "إضافة" button at the cap is rendered `disabled` (opacity
  per `disabled-states`) with a tooltip/helper "بلغت حد خطتك — رقِّ للمزيد"; the dialog is the fallback for
  the server-rejected case so the cap holds even if the client is bypassed (AC 30). Below the cap, create
  works normally (AC 31); when a comp raises the cap, the control re-enables immediately (AC 32).
- **`LimitReachedDialog` props:** `open`, `resourceKey('branch'|'device'|'staff')`, `used`, `limit`,
  `isOwner`, `onUpgrade`, `onClose`.
- **RTL/a11y:** numerals Arabic-Indic; `role="alertdialog"`; focus trapped; Esc/Cancel close;
  `destructive-emphasis` does **not** apply (this is not destructive — it's a calm upsell, neutral/`primary`).

### 4.2 `ReadOnlyModeBanner` (app-wide lapse strip)

A slim persistent strip rendered below `TopBarSimple` on **every** `/dashboard` surface while the resolved
entitlement is `isReadOnly` (grace elapsed or canceled), or a compact `warning` strip during `past_due`
grace. It states the mode in one line and links to billing. It is the app-wide echo of §3.1.

- While read-only, operational mutations elsewhere (start session, take order, adjust stock) are **disabled**
  with a shared helper ("الحساب في وضع القراءة فقط") — viewing always works. The exact disabled wiring is the
  engineer's (mirrors the resolver's `isReadOnly`); the design contract is: **disabled, explained, never a
  silent no-op**, and **billing is never disabled**.
- **`ReadOnlyModeBanner` props:** `mode('grace'|'readOnly')`, `graceUntilIso?`, `isOwner`, `onManageBilling`.
- **RTL/a11y:** `role="status"`; non-dismissible while the state holds; ≥ 44 tall; link/CTA at the end.

---

## 5. `BillingStatusPill` (new, built on `StatusPill` grammar) — §2.5 mapping

The subscription status needs its own statuses (`trialing`/`active`/`past_due`/`canceled`/`comped`/
`incomplete`) beyond the device `free/busy/maintenance` of the existing `StatusPill`. Rather than overload
that component, add a sibling that **reuses the same pill grammar** (dot/icon + label on a `${color}1A`
tint, AA text) bound to the §2.5 token mapping.

- **Props:** `status`, `graceElapsed?` (when `past_due` + grace gone → render the `danger` "read-only"
  variant), `trialDaysLeft?` (folded into the label for `trialing`), `comped?`.
- **Renders:** icon + localized label per §2.5; never colour-only (icon + label always present).
- **RTL/a11y:** dot/icon at the start; `aria-label` echoes the full status text (e.g. "تجريبي — ٣ أيام
  متبقية"); used in both the owner card and the admin table so the status reads identically across surfaces.

---

## 6. Component contracts (new this phase)

| Component | Built on | Key props | States |
|---|---|---|---|
| `BillingView` (owner page root) | — | `isOwner`, `nowIso` | owner-gate → denied; else the four data states cascade |
| `PaywallBanner` | — | `variant`, `daysLeft?`, `graceUntilIso?`, `isOwner`, `onAction`, `actionPending` | trialEnding · pastDueGrace · readOnly · comped · staff-variant |
| `CurrentPlanCard` | card | see §3.2 | loading(skeleton) · ready · finalizing(incomplete) · error(inline+retry) · stale |
| `UsageMeterGroup` / `UsageMeter` | — | see §3.3 | loading · ready · near-limit · at-limit · unlimited · error |
| `PlanComparison` / `PlanCard` | card + `Button` | see §3.4 | loading · ready(current/upgrade/downgrade) · pending(minting URL) · error |
| `CheckoutReturnState` | `Toast` + card overlay | `result('success'|'cancel'|'portalReturn')`, `onDismiss` | success(finalizing) · cancel · portalReturn |
| `LimitReachedDialog` | `ConfirmDialog` §9.8 | see §4.1 | owner · staff · static |
| `ReadOnlyModeBanner` | — | see §4.2 | grace · readOnly |
| `BillingStatusPill` | `StatusPill` §9.2 grammar | see §5 | the §2.5 status set |
| `BillingDeniedState` | `EmptyState` §9.9 | `titleKey`, `bodyKey`, `onBack` | static |
| `SubscriptionStatStrip` | `StatStrip` (Phase 7) | `active`, `trialing`, `pastDue`, `mrrMinor`, `currency` | loading · ready |
| `SubscriptionsTable` | `DataTable` §9.7 / `AuditTable` pattern | see §7.2 | four states + filtered-empty |
| `CompOverrideDialog` | `Dialog` §9.3 + `Select` + `TextField` | see §7.3 | default · plan/reason-invalid · submitting · error(form preserved) |

**`BillingView` cascade:** one `loading` flag drives the plan-card + meter + plan-grid skeletons together
(single subscription+usage query); the paywall banner waits for resolved status before rendering. A
sub-query failure (usage) surfaces inline (§3.6) without collapsing the page.

---

## 7. Screen — Super-admin subscriptions (`/admin/subscriptions`) — AC 33–35

**Purpose:** the platform operator sees every tenant's subscription health at a glance and can comp/override
a plan. **Primary action:** the per-row **comp/override** (in the row overflow, not a page-level CTA — there
is no "create subscription" act here; subscriptions are born at provision). Read-only list + one audited
write. Built inside the existing `AdminShell` with `activeNav='subscriptions'`.

### 7.1 `SubscriptionStatStrip`

Reuses the Phase-7 `StatStrip` (three/four compact `StatCard`s, tabular Arabic-Indic): **active** · **trial**
· **past-due** counts, plus an **MRR-ish** glance figure (Σ active paid-plan monthly amounts) rendered via
`formatMoneyMinor` with the currency shown. The MRR figure is a coarse "revenue health" signal (spec §3.9 /
AC 33), explicitly an approximation (label "≈") — not an accounting number. Empty platform → contextual
zeros, never blank (same rule as the Phase-7 strip).

### 7.2 `SubscriptionsTable` (built on `DataTable` / the Phase-7 `AuditTable` pattern)

Columns (start→end, RTL-mirrored), most-relevant first (default sort: status severity then period-end asc,
or trialing-ending-soonest first — engineer's choice, documented):

| Column | Content |
|---|---|
| `admin.subs.col.tenant` | tenant name (`h3`) + id (`text-faint`, **LTR-isolated** `bdi`) |
| `admin.subs.col.plan` | plan name; `comped` rows show the `platform`-steel "ممنوحة" chip beside it |
| `admin.subs.col.status` | `BillingStatusPill` (§5) — same component as the owner page |
| `admin.subs.col.trialEnd` | trial-end date (Arabic-Indic) or "—" if not trialing |
| `admin.subs.col.periodEnd` | current-period-end date (Arabic-Indic); `cancel_at_period_end` → a muted "إلغاء مجدول" sub-note |
| `admin.subs.col.amount` | monthly amount via `formatMoneyMinor` + currency, end-aligned, tabular; "—" for trial/comp with no charge |
| `admin.subs.col.actions` | end cell: overflow menu → **comp/override** (opens §7.3) |

- **Filters (AC 33):** status (`admin.subs.filter.allStatuses` default + each status) and plan
  (`admin.subs.filter.allPlans` default + each tier), plus a debounced name search. Filters **AND** together;
  `filter.clear` restores all — exactly the `TenantsTable` filter grammar.
- **Pre-filter via query param** (`?tenant=<id>` from the tenant-detail cross-link, §2) selects that tenant.
- **Comped rows** carry the steel chip + are never shown as `past_due`/`canceled` (comp overrides payment
  state — §2.5, AC 5/32). Virtualize at 50+ rows; `aria-sort` on sortable headers.
- **Money/dates** Arabic-Indic; amounts via `formatMoneyMinor` (the second-axis formatter), **not**
  `formatEgp` — and the currency is shown so it is never read as café EGP.
- **No standing cross-tenant write** is implied: the only write is the explicit, audited comp/override RPC
  (ADR-0008/0010 invariant); the table itself is the single ratified cross-tenant **read** for subscriptions.

### 7.3 `CompOverrideDialog` (the one write — reason-gated, audited) — AC 34

A `Dialog` (§9.3) capturing an owner-independent plan grant:

- **Title** `admin.subs.comp.title` ("منح / تعديل خطة — {tenant}"), tenant name LTR-isolated if Latin.
- **Plan select** `admin.subs.comp.plan` — a `Select` of the seeded plans (including the comp-only tiers).
  Selecting a plan shows its limits inline so the operator sees what they're granting.
- **Required reason** `admin.subs.comp.reason` (`TextField`, ≥5 chars, helper `reasonHelper`, persisted to
  the audit `meta` — same friction model as the Phase-7 suspend reason; validated on blur,
  `validation.reasonRequired`).
- **Consequence line** `admin.subs.comp.consequence` — "تتجاوز هذه الخطة فوترة سترايب لهذا العميل
  (comped) وتُسجَّل في سجل التدقيق."
- **Submit** `admin.subs.comp.submit` (`primary`) → calls the service-role `set-tenant-plan` RPC via the
  edge function with the super-admin's JWT; loading + disabled (`loading-buttons`); success → `Toast`
  `admin.subs.comp.success` + the row's plan/status update (refetch); failure → inline cause, **form
  preserved** (no data loss).
- **Not type-to-confirm** (granting a plan is restorative/benign, unlike suspend) but **is** reason-gated and
  audited — `confirmation-dialogs` satisfied by the explicit consequence + reason.
- **`CompOverrideDialog` props:** `open`, `tenant` ({ id, name }), `plans[]`, `currentPlanKey`,
  `onConfirm({ planKey, reason })`, `submitting`, `error`, `onClose`.
- **RTL/a11y:** labels/errors align start; first invalid field focused on submit error (`focus-management`);
  Esc/Cancel close; `confirmOnDirty` guards an accidental dismiss with an unsaved reason.

### 7.4 The four states + denied (admin subscriptions)

| State | Contract |
|---|---|
| **Empty** | No tenants/subscriptions at all (fresh platform): `EmptyState` "لا توجد اشتراكات بعد" (tenants are provisioned from the overview, so this points back there). Filtered-to-empty: a lighter inline "لا اشتراكات بهذه الحالة" + clear-filters — distinct from no-data-at-all (same two-tier rule as `TenantsTable`). |
| **Loading** | `SubscriptionStatStrip` skeleton + 6 shimmer table rows matching column widths (CLS < 0.1). |
| **Error** | Inline panel "تعذّر تحميل الاشتراكات" + Retry (`role="alert"`); filters stay usable. |
| **Offline / stale** | Read-only surface: last fetch + refresh affordance + "آخر تحديث" caption; the comp/override action disables while offline (minting/RPC needs the live backend) with a chrome note (the Phase-7 web rule: super-admin disables mutations offline). |
| **Denied** | Non-super-admin → the existing `AdminDeniedState`; no subscription data in the payload (AC 35). |

---

## 8. Cross-cutting contracts (binding)

- **Two money axes, never conflated (CLAUDE.md §2.1, spec §5).** Café operational money everywhere stays
  integer piastres via `formatEgp` (`٬` separator, `ج.م` suffix). The **subscription** amount uses the new
  `formatMoneyMinor(minorUnits, currencyCode, …)` (§2.5) with the currency **always shown** beside it. No
  inline currency math anywhere; no `formatEgp` on a subscription amount; no Stripe amount fed into café
  pricing.
- **Numerals (CLAUDE.md §2.6).** All displayed digits Arabic-Indic via `toArabicDigits` — amounts, dates,
  trial/renewal countdowns, usage counts, MRR. Business/query values stay Western. There is **no CSV export**
  this phase, so there is **no** Western-digit display surface.
- **Time/countdowns (CLAUDE.md §2.2).** The trial-days-left and grace countdowns derive from the stored
  `trial_end` / `graceUntil` **timestamps** with an injected `nowIso` — never a `setInterval` elapsed counter
  — so a backgrounded tab or dropped network can't mis-state how much trial/grace is left (same discipline as
  `LiveTimer`). Day-granularity is fine here; the value is recomputed at render, not accumulated.
- **No secret in the browser (spec §5, AC 20).** The UI calls owner-only / super-admin edge functions with
  the user's JWT; Checkout/Portal URLs and the comp/override write happen server-side; the client only follows
  a returned redirect URL or shows a returned result. Stripe's hosted Checkout/Portal are **external** — their
  localization is Stripe's (noted as a UX limitation, not an i18n failure, AC 37); our return surfaces are
  fully Arabic/RTL.
- **The billing page is never gated (spec §3.7, AC 28).** Whatever read-only mode does to the app,
  `/dashboard/billing`, its Upgrade (Checkout) and Manage (Portal) actions stay reachable. The
  `ReadOnlyModeBanner` disables operational mutations, **never** the billing recovery path.
- **Tenant isolation (CLAUDE.md §5).** The owner page reads only the tenant's own subscription row (RLS); the
  admin table is the single ratified cross-tenant **read**; the only cross-tenant write is the explicit
  audited comp/override RPC. The design never sends a tenant id from the client to widen scope.
- **All strings via i18n (CLAUDE.md §6).** Zero hardcoded copy — nav, plan names, statuses, paywall banners,
  buttons, usage labels, table headers, filter labels, dialog copy, validation, empty/error/denied. Inventory
  §9.
- **A11y floors (system §7).** Focus → `#main-content` on route entry; visible 2–4px `primary` focus rings;
  contrast verified both themes for all four paywall tints + meter states; interactive controls ≥ 44 (web ops
  surface) with ≥ 8px spacing; reduced-motion disables skeleton shimmer and the finalizing spinner's motion
  (state stays readable); the comp/override (a platform-state change) is reason-gated + audited; paywall
  banners never flash.

---

## 9. i18n key inventory (Phase 9 — keys only; Arabic strings live in `apps/web/src/i18n/messages/ar.json`)

```
nav.billing

billing.title · billing.subtitle
billing.denied.title · billing.denied.body · billing.denied.back
billing.lastUpdated                                  ("آخر تحديث: {time}")
billing.refresh

billing.status.trialing · billing.status.active · billing.status.pastDue
billing.status.canceled · billing.status.comped · billing.status.incomplete
billing.status.readOnly
billing.status.trialDaysLeft                         ("تجريبي — {n} يوم متبقٍ")

billing.plan.current                                 ("خطتك الحالية")
billing.plan.renews                                  ("التجديد التالي في {date}")
billing.plan.trialEnds                               ("تنتهي التجربة في {date} · {n} يوم متبقٍ")
billing.plan.cancelScheduled                         ("ينتهي الوصول في {date} (تم إلغاء التجديد)")
billing.plan.endedOn                                 ("انتهى الاشتراك في {date}")
billing.plan.pastDueUntil                            ("المهلة حتى {date}")
billing.plan.amountPerMonth                          ("{amount} {currency} / شهريًا")
billing.plan.manageBilling                           (→ Portal)
billing.plan.subscribe · billing.plan.upgrade        (→ Checkout)
billing.plan.manageViaPortal                         (downgrade routing)
billing.plan.recommended

billing.usage.title
billing.usage.branches · billing.usage.devices · billing.usage.staff
billing.usage.ofLimit                                ("{used} / {limit}")
billing.usage.unlimited                              ("غير محدود")
billing.usage.atLimit                                ("بلغت الحد")
billing.usage.nearLimit

billing.paywall.trialEnding.title · billing.paywall.trialEnding.body
billing.paywall.pastDue.title · billing.paywall.pastDue.body
billing.paywall.readOnly.title · billing.paywall.readOnly.body
billing.paywall.comped.body
billing.paywall.alwaysRecover                        ("يمكنك دائمًا الدفع من هنا لاستعادة الوصول")
billing.paywall.staff                                ("أبلغ مالك الحساب")
billing.paywall.cta.subscribe · billing.paywall.cta.updateCard · billing.paywall.cta.renew

billing.readOnly.banner                              ("الحساب في وضع القراءة فقط")
billing.readOnly.graceBanner                         ("دفعة متعثّرة — حدّث طريقة الدفع قبل {date}")
billing.readOnly.manage                              ("إدارة الفوترة")
billing.readOnly.mutationsDisabled                   (shared helper on disabled operational controls)

billing.limit.title                                  ("بلغت حد خطتك")
billing.limit.body                                   ("خطتك تسمح بـ {limit} {resource}؛ أنت تستخدم {used}")
billing.limit.resource.branch · billing.limit.resource.device · billing.limit.resource.staff
billing.limit.upgrade · billing.limit.tellOwner

billing.return.success                               ("تم الدفع — يتم تفعيل اشتراكك الآن")
billing.return.finalizing                            ("قيد الإتمام — خلال لحظات")
billing.return.cancel                                ("لم يكتمل الدفع — لم يتم خصم أي مبلغ")
billing.return.portalUpdated                         ("تم تحديث بيانات الفوترة")

billing.error.load · billing.error.checkout · billing.error.portal

admin.nav.subscriptions

admin.subs.title · admin.subs.subtitle
admin.subs.stat.active · admin.subs.stat.trialing · admin.subs.stat.pastDue · admin.subs.stat.mrr
admin.subs.mrrApprox                                 ("≈ {amount} {currency} / شهريًا")

admin.subs.filter.status · admin.subs.filter.plan · admin.subs.filter.search
admin.subs.filter.allStatuses · admin.subs.filter.allPlans · admin.subs.filter.clear

admin.subs.col.tenant · admin.subs.col.plan · admin.subs.col.status
admin.subs.col.trialEnd · admin.subs.col.periodEnd · admin.subs.col.amount · admin.subs.col.actions
admin.subs.comped                                    ("ممنوحة")
admin.subs.cancelScheduled                           ("إلغاء مجدول")
admin.subs.action.comp                               ("منح / تعديل خطة")

admin.subs.comp.title · admin.subs.comp.plan · admin.subs.comp.reason · admin.subs.comp.reasonHelper
admin.subs.comp.consequence · admin.subs.comp.submit · admin.subs.comp.success
admin.subs.comp.validation.reasonRequired · admin.subs.comp.validation.planRequired

admin.subs.empty.title · admin.subs.empty.body
admin.subs.filteredEmpty · admin.subs.error

admin.action.subscription.comp · admin.action.subscription.override
admin.action.subscription.activated · admin.action.subscription.pastDue
admin.action.subscription.canceled                   (audit-log action labels for the §8 taxonomy)
```

**Reused existing keys (no re-introduction):** `state.loading`, `state.error.generic`, `action.retry`,
`action.cancel`, `action.close`, `auth.signOut`, `app.name`, `web.offline.stale`,
`admin.denied.*` (admin denied state), `admin.detail.overview` (tenant-detail subscription line).

---

## 10. Design tokens added this phase

Registered in **`docs/design/design-system.md §2.5`** (the source of truth):

- **Billing status→token mapping** (`trialing`→`info`, `active`→`status-free`, `past_due`→`warning`,
  read-only/`canceled`→`danger`, `comped`→`platform`, `incomplete`→neutral) — **no new colour hex**; reuses
  the §2.2 alert/status palette (the Phase-8 precedent).
- **Usage-meter colour convention** — track `chart-track`; fill `primary` → `warning` (≥80%) → `danger`
  (=100%); count + lock icon carry it (never colour-only). No new hex.
- **Platform-subscription currency formatter contract** — `formatMoneyMinor(minorUnits, currencyCode,
  { arabicDigits })` in `@ps/core` (engineer/core call); the second money axis, always shown with its
  currency, never `formatEgp`.

No new spacing/radius/type/motion tokens — Phase 9 composes the existing scale verbatim. The **only**
shell-level change is widening the `AdminNav` union to add `'subscriptions'` (§2).

---

## 11. Component-draft note (21st.dev magic MCP)

The magic MCP may draft concrete **web** shells for `CurrentPlanCard`, `UsageMeter`, `PlanCard`/
`PlanComparison`, `PaywallBanner`, `SubscriptionsTable`, and `CompOverrideDialog` against the contracts above
(the 21st `Stats`-with-progress and `UsageBadge` samples are sound *visual* references for the meter — a bar
with an explicit "{used} / {limit}" + percentage). When used, **discard any output that:** (a) hardcodes
Latin/Western numerals or inline currency — money must route through `formatMoneyMinor` (subscription) or
`formatEgp` (café), digits through `toArabicDigits`; (b) assumes LTR layout — must follow system §6 (logical
start/end, no hardcoded left/right, LTR-isolated tenant ids/emails); (c) ships a surface without the four
states / denied state; (d) renders the lapse state as alarmist or punitive — the paywall is **calm + always
recoverable** (§3.1, AC 28), never a hard lockout of the billing page; (e) reuses the `impersonation` violet
or the solid-banner treatment — that token is one-purpose (§2.4); the comped chip uses the restrained
`platform` steel and the paywall uses tinted alert fills. Keep only the **visual vocabulary** (card framing,
meter proportions, plan-grid layout, table density, dialog layout) and bind it to the tokens + contracts here
— exactly as Phases 3, 6, and 7 did with rejected MCP samples.

---

## 12. Relationship to the spec's open questions

The visual spec is mechanism-agnostic and accommodates each ADR-0010 outcome without change:

- **Q1 (tiers/limits shape)** — `PlanComparison` renders whatever seeded plans + limits arrive; 2 or 3 tiers
  both fit the responsive grid. Plan names are i18n keys.
- **Q3 (enforcement point)** — the UI mirrors the resolver (`isReadOnly`, caps) and provides the
  disabled-affordance + `LimitReachedDialog`; whether the authoritative gate is DB, app, or both, the UX is
  the same calm "disabled + explain + upgrade" (§4).
- **Q4 (status model)** — `BillingStatusPill` + §2.5 mapping cover the final enum; an unmapped status falls
  back to the neutral `incomplete` treatment rather than rendering raw.
- **Q5 (currency)** — handled by `formatMoneyMinor` + always-shown currency (§2.5, §8); EGP or USD both
  display correctly and stay visibly distinct from café EGP.
- **Q6 (grace length / lapse policy)** — the grace days + read-only scope are data the resolver supplies
  (`graceUntil`, `isReadOnly`); the banners/countdowns render whatever N is ratified.
- **Q9 (staff visibility)** — designed owner-only with the staff "ask the owner" variant (§1.3, §3.1, §4.1);
  if the human elects read-only-status-for-managers instead, only the gate changes, not the components.
```
