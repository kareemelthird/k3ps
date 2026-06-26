# PS-Managment — Design System (source of truth)

> Built fresh via the `ui-ux-pro-max` skill + 21st.dev magic MCP. **Not** the Pochinki trial's look.
> The trial is mined for *interaction lessons only* (glanceable device grid, bottom sheets, segmented
> controls, prepaid ring, ~52px tap floor). Its orange/charcoal palette is deliberately **not** reused.
>
> This document is the team's source of truth for tokens, type, spacing, motion, a11y, and RTL across
> **mobile (Expo / React Native)** and **web (Next.js + Tailwind + shadcn/ui)**. Per-feature specs in
> `docs/design/<feature>.md` may override locally but must cite the deviation.

---

## 0. Scope — the source of truth for every phase

This document is the **brand + system source of truth** for every surface. It landed first against the
Phase 2 super-admin flows (`docs/design/super-admin-console.md`, `docs/design/impersonation.md`) and is the
foundation every later phase composes against.

**Phase 3 (the walking skeleton)** is the first *operator-facing* slice and the first real test of the
counter-speed, dark-first, RTL goals here: login → resolve tenant/branch from the JWT claim → device grid →
start one open session → close it (live timer from `started_at`). It introduces the operator primitives
(`DeviceCard`, `LiveTimer`, `BranchPicker`, `AppScaffold`) added in §9, with the full screen + state designs
in **`docs/design/phase-3-walking-skeleton.md`**. No tokens, type, motion, or a11y rules are re-derived
there — Phase 3 consumes this system verbatim.

---

## 1. Design direction

**Product type:** multi-tenant operations SaaS for a **cash business**, run one-handed at a busy counter
(mobile) and reviewed by owners + the platform team (web). The personality must read as **trustworthy,
fast, and calm** — money and timers are on screen constantly, so the UI must never feel noisy or jittery.

**Chosen direction: "Calm Operations" — a precise, dark-first, low-chroma surface system with a single
confident accent.** Rationale (from `ui-ux-pro-max` reasoning):

- **Dark-first** because lounges are dim (`design-approach.md`) and operators stare at the grid for hours —
  a dark canvas reduces glare and lets live status colors (free/busy) pop without shouting.
- **Low-chroma neutrals + one accent** (not the trial's hot orange gradient): saturated brand color is
  reserved for *the one primary action per screen* and the *running money total*, so attention always lands
  on what's billable. Status semantics (free/busy/maintenance/danger) own their own hues and are never
  reused decoratively (`color-not-only`, `color-semantic`).
- **Teal/cyan accent**, not green and not orange: green is reserved for the "free/available" status, red for
  danger; a cool **teal** accent stays distinct from both, signals "fintech-grade precision," and is
  trivially distinguishable from the status palette for color-blind users.
- **Flat + soft elevation** (no skeuomorphism, no glass-as-decoration): elevation is a *meaning* (sheets,
  modals, the impersonation banner) not a texture (`elevation-consistent`, `effects-match-style`).

This direction is **one brand across mobile and web**: same tokens, same type roles, same motion rhythm;
only the component primitives differ (RN `Pressable`/`Modal` vs shadcn/Radix).

---

## 2. Color system (semantic tokens)

All UI consumes **semantic tokens**, never raw hex (`color-semantic`). Hex below defines the token; light
and dark are designed together (`dark-mode-pairing`). Dark is the default surface for the operator app.

### 2.1 Primitive ramps (reference only — do not use directly in components)

```
Neutral (cool slate)   N0  #F8FAFC  N50 #EEF2F6  N100 #E2E8F0  N200 #CBD5E1
                       N300 #94A3B8  N400 #64748B  N500 #475569  N600 #334155
                       N700 #1E293B  N800 #131A26  N900 #0D131D  N950 #080C13
Teal (brand accent)    T300 #5EEAD4  T400 #2DD4BF  T500 #14B8A6  T600 #0D9488  T700 #0F766E
Green (status: free)   G400 #34D399  G500 #10B981  G600 #059669
Amber (status: warn)   A400 #FBBF24  A500 #F59E0B  A600 #D97706
Red  (status: danger)  R400 #F87171  R500 #EF4444  R600 #DC2626
Violet (impersonation) V400 #A78BFA  V500 #8B5CF6  V600 #7C3AED
Blue (info / device PS) B400 #60A5FA  B500 #3B82F6
```

### 2.2 Semantic tokens

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `bg` | `N950 #080C13` | `N0 #F8FAFC` | App canvas |
| `surface` | `N900 #0D131D` | `#FFFFFF` | Cards, sheets base |
| `surface-2` | `N800 #131A26` | `N50 #EEF2F6` | Raised rows, nested cards |
| `surface-3` | `N700 #1E293B` | `N100 #E2E8F0` | Inputs, hover fills |
| `border` | `#22304A` | `N200 #CBD5E1` | Default 1px separators |
| `border-strong` | `#33476B` | `N300 #94A3B8` | Focused / emphasized edges |
| `text` | `N50 #EEF2F6` | `N900 #0D131D` | Primary text (≥4.5:1 both modes) |
| `text-muted` | `N300 #94A3B8` | `N500 #475569` | Secondary text (≥3:1, large only) |
| `text-faint` | `N400 #64748B` | `N400 #64748B` | Disabled / placeholder |
| `primary` | `T500 #14B8A6` | `T600 #0D9488` | The one CTA per screen; running total |
| `primary-press` | `T600 #0D9488` | `T700 #0F766E` | Pressed/active primary |
| `on-primary` | `N950 #080C13` | `#FFFFFF` | Text/icon on primary fill |
| `status-free` | `G500 #10B981` | `G600 #059669` | Device available |
| `status-busy` | `B500 #3B82F6` | `B500 #3B82F6` | Device in session (running) |
| `status-maint` | `N400 #64748B` | `N500 #475569` | Maintenance / disabled device |
| `warning` | `A500 #F59E0B` | `A600 #D97706` | Low stock, near-limit, prepaid <5min |
| `danger` | `R500 #EF4444` | `R600 #DC2626` | Voids, refunds, destructive, oversell |
| `info` | `B500 #3B82F6` | `B500 #3B82F6` | Neutral notices |
| `impersonation` | `V500 #8B5CF6` | `V600 #7C3AED` | **Super-admin impersonation only** (never elsewhere) |
| `scrim` | `rgba(0,0,0,0.6)` | `rgba(15,23,42,0.45)` | Modal/sheet backdrop (40–60%) |

**Notes**
- **`busy` is blue, not orange.** A running session is the *normal* state at a busy café; orange/amber is
  reserved for *warnings* (near-empty prepaid, low stock). This is a deliberate departure from the trial,
  where "busy" was the brand orange — that conflated "normal operation" with "attention."
- **`impersonation` violet is a one-purpose token.** It only ever paints the impersonation banner/border so
  the state is instantly recognizable and never confused with brand or status (spec §7: "visually
  unmistakable").
- Contrast is verified per mode (`color-accessible-pairs`): `text`/`bg` ≥ 7:1, `text`/`surface` ≥ 4.5:1,
  all status fills carry an **icon + label**, never color alone (`color-not-only`).

### 2.3 Accent override
The trial allowed an owner-selectable accent. We keep that idea but **scope it to the owner's own tenant
surfaces**, defaulting to `primary` teal; it never overrides status or impersonation tokens. (Deferred to
the owner-settings phase; documented here so the token contract reserves it.)

### 2.4 Platform & impersonation-banner tokens (Phase 7 — super-admin portal)

The super-admin portal at `/admin` is a **platform-level context** that must read as a *different kind of
place* from any tenant dashboard (spec §3 "clearly distinct"). It earns that distinction **structurally**
first — a left **sidebar** shell (the tenant surfaces use a top bar), a persistent platform badge, and the
unique nav set (Tenants / Audit) — and only **secondarily** by a single restrained identity hue. The brand
stays one brand: the *action* accent in the portal is still `primary` teal; the steel `platform` hue is
**identity only** (never an action, status, or chart color).

**Primitive ramps (reference only)**

```
Steel (platform identity)   S300 #A5B4CF  S400 #818EAE  S500 #5E6E94  S600 #44557A
Violet (already in §2.1)     V400 #A78BFA  V500 #8B5CF6  V600 #7C3AED  V700 #6D28D9
```

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `platform` | `S300 #A5B4CF` | `S500 #5E6E94` | **Admin chrome identity only** — sidebar active item, platform badge, header hairline. Never an action/status/chart color, never impersonation. |
| `platform-surface` | `N800 #131A26` | `N50 #EEF2F6` | The admin sidebar / chrome surface (one step off the canvas so the shell reads as platform, not tenant). |
| `impersonation-surface` | `V600 #7C3AED` | `V700 #6D28D9` | **Solid fill** of the impersonation banner. White text clears AA on both (≈5.3:1 / ≈6.5:1). |
| `on-impersonation` | `#FFFFFF` | `#FFFFFF` | Text + icon on the impersonation banner fill. |
| `impersonation-frame` | `V500 #8B5CF6` | `V500 #8B5CF6` | The 3px inset frame painted around the whole app shell while impersonating (belt-and-suspenders for "unmistakable"). |

**Banner countdown states (no new tokens — reuse the alert palette):** the live remaining-time readout is
`on-impersonation` white by default, recolored to `warning` amber under ~2 min and `danger` red under ~30s
(weight/color change only — never a flashing animation; reduced-motion-safe, §5/§7).

**Why violet, and why a *solid* fill here (departure from the calm palette by design):** the impersonation
banner is a **safety control**, not calm chrome. Everywhere else the system uses tinted status fills
(`${color}1A`) and reserves saturation for the one CTA; the banner deliberately breaks that rule with a
**full-saturation violet bar** so the state is impossible to miss and cannot be confused with any tenant UI
(`color-not-only` is still honoured — violet is backed by a persistent text label + the inset frame + a live
countdown, four redundant signals). `impersonation` violet remains a **one-purpose color** (§2.2): it paints
this banner/frame and nothing else.

### 2.5 Billing & entitlement status mapping (Phase 9 — SaaS billing)

The owner billing surface (`/dashboard/billing`) and the super-admin subscriptions view introduce a new
*platform→tenant subscription* status axis. Following the Phase-8 precedent (sync states map onto existing
tokens — **no new color hex**), the four subscription statuses + the paywall states reuse the alert/status
palette already defined in §2.2. The mapping is **binding** so a status always *means* the same colour it
does elsewhere (`color-semantic`, `consistency`); status is **never colour-only** — every state carries a
`StatusPill` (dot/icon + label) per §9.2.

| Subscription / paywall state | Token | Pill grammar |
|---|---|---|
| `trialing` (within trial) | `info` blue | clock icon + "تجريبي — {n} يوم متبقٍ" |
| `active` | `status-free` green | check icon + "نشِط" |
| `past_due` (within grace) | `warning` amber | alert icon + "دفعة متعثّرة" |
| `past_due` (grace elapsed) / read-only | `danger` red | lock icon + "وضع القراءة فقط" |
| `canceled` | `danger` red (muted) | x-circle icon + "مُلغى" |
| `comped` (super-admin grant) | `platform` steel | gift icon + "خطة ممنوحة" — the **one** non-`/admin` reuse of the `platform` hue, justified because a comp *is* a platform act; identity-only, never an action |
| `incomplete` (Checkout not finalized) | `text-muted` neutral | spinner/hourglass + "قيد الإتمام" |

**Usage-meter colour convention (binding).** The plan-limit meters (branches / devices / staff used of
allowed) reuse the chart/track + alert tokens — **no new hex**:

- track = `chart-track` (`surface-2`); fill = `primary` teal under 80% of the cap;
- fill recolours to `warning` amber at **≥ 80%** (near limit) and `danger` red at **= 100%** (cap hit);
- the meter is **never colour-only**: it always shows the literal "{used} / {limit}" count (tabular,
  Arabic-Indic) and, at the cap, a lock icon + "بلغت الحد" label.

**Platform-subscription currency (the second money axis — CLAUDE.md §2.1 caveat, spec §7 Q5).** The café's
operational money stays **EGP integer piastres** via `formatEgp` (§6) and is unchanged. The subscription
charge is a **separate** amount in the platform's billing currency (minor units; the currency itself is
ADR-0010 Q5 / a human call). Because `formatEgp` is EGP-pinned, the billing UI must **not** reuse it for the
subscription price; it needs a generalized `@ps/core` formatter — **design contract:**
`formatMoneyMinor(minorUnits, currencyCode, { arabicDigits })` → grouped amount + the currency's
Arabic-localized symbol, Arabic-Indic digits, tabular. (Engineer/core call; if the ratified currency is EGP,
this can wrap the existing `CURRENCY` constants.) Every displayed subscription amount routes through it; the
currency is always shown explicitly beside the amount so it is never mistaken for in-app EGP.

---

## 3. Typography

**Arabic-first.** The type system must render Arabic without clipping at every weight and never fall back to
a Latin-only face for Arabic glyphs (`design-approach.md`, `dynamic-type`, `truncation-strategy`).

| Role | Family | Notes |
|---|---|---|
| Primary (AR + Latin UI) | **IBM Plex Sans Arabic** | Excellent Arabic shaping, wide weight range, pairs with Latin; one family for both scripts avoids mixed-script jitter |
| Numerals / money / timers | **IBM Plex Mono** (tabular) OR Plex Sans Arabic with `font-variant-numeric: tabular-nums` | **Tabular figures mandatory** for money + timers so digits don't reflow (`number-tabular`) |

Web load: `next/font` with `display: swap`, preload only the primary weights (`font-loading`, `font-preload`).
Mobile: bundle the Plex Arabic ttf via `expo-font`.

### 3.1 Type scale (shared roles)

| Role | Size / line-height | Weight | Use |
|---|---|---|---|
| `display` | 34 / 40 | 800 | Big numbers (shift total, device count) |
| `h1` | 26 / 32 | 700 | Screen title |
| `h2` | 20 / 28 | 700 | Section / sheet title |
| `h3` | 17 / 24 | 600 | Card heading, row title |
| `body` | 16 / 24 | 400 | Default text (16 floor prevents iOS auto-zoom) |
| `label` | 14 / 20 | 500 | Field labels, secondary actions |
| `caption` | 13 / 18 | 500 | Status pills, meta |
| `micro` | 12 / 16 | 600 | Badges only (never body) |
| `timer` | 28 / 32 | 600, tabular | Live session clock |
| `money` | 16–34 tabular | 700 | Any EGP amount; size by context |

Body never below 12; data labels ≥ 14 (`readable-font-size`). Weight carries hierarchy alongside size
(`weight-hierarchy`).

---

## 4. Spacing, radius, elevation

**4 / 8 spacing rhythm** (`spacing-scale`):

```
space: 2xs 4 · xs 8 · sm 12 · md 16 · lg 20 · xl 24 · 2xl 32 · 3xl 48
```

Section spacing tiers: 16 (within group) · 24 (between groups) · 32–48 (between sections).

**Radius** (calmer, more uniform than the trial's bespoke 11/13/15):

```
radius: xs 8 (chip/badge) · sm 10 (input/button) · md 14 (card) · lg 20 (sheet/modal) · pill 999
```

**Elevation** — a consistent scale, meaning not decoration (`elevation-consistent`):

| Level | Dark shadow | Use |
|---|---|---|
| `e0` | none, `border` 1px | Flat cards on canvas |
| `e1` | y2 r8 black/30% | Raised card, hover |
| `e2` | y6 r16 black/40% | Dropdown, popover |
| `e3` | y12 r28 black/50% | Sheet, modal, impersonation banner |

No colored "glow" as default (the trial pulsed orange glow on busy cards). We replace the glow with a
**1px status-colored border + a small status dot/pill**: glanceable, cheaper, and accessible. A subtle
opacity pulse (not shadow) may indicate "live" — see Motion.

---

## 5. Motion

Tokens (`duration-timing`, `easing`, `exit-faster-than-enter`):

```
duration: instant 0 · fast 150 · base 220 · slow 320   (never > 400 for UI)
easing:   enter cubic-bezier(0.16,1,0.3,1)   exit cubic-bezier(0.4,0,1,1)
exit duration ≈ 65% of enter
```

Rules: animate **transform/opacity only** (`transform-performance`); press feedback within ~100ms via
opacity/scale 0.97 (`scale-feedback`, `tap-feedback-speed`); sheets/modals animate **from their trigger**
(`modal-motion`); forward nav slides start→end, back slides end→start (RTL-mirrored, `navigation-direction`);
list entrance staggers 30–50ms; **all motion respects `prefers-reduced-motion`** (`reduced-motion`) — the
"live" pulse and stagger fully disable, content stays readable immediately. Animations are interruptible and
never block input (`interruptible`, `no-blocking-animation`).

**Live indicator:** a busy device card uses a 1.2s opacity pulse (1.0→0.6) on the status **dot only**, not
on the whole card/shadow — cheaper and non-distracting. Disabled under reduced-motion.

---

## 6. RTL — global rules (binding)

Arabic-first, RTL is the default layout, not an afterthought (`CLAUDE.md` §6; `rtl-i18n-check` enforces).

- **Never hardcode left/right.** Use logical props: `start`/`end`, `marginInlineStart`, `paddingInlineEnd`;
  RN uses `flexDirection: 'row'` under `I18nManager.isRTL` (which auto-mirrors) — do **not** litter
  `row-reverse` (the trial did; it breaks if LTR is ever needed). Mirror once at the layout primitive level.
- **Mirror directional icons** (chevrons, arrows, back, send) horizontally; **do not mirror** logos,
  media, checkmarks, or **clocks/timers** (a clock face is not directional).
- **Numerals:** displayed money, counts, timers, and dates render **Arabic-Indic** via `toArabicDigits`
  (`@ps/core`); business/computation values stay Western. Money always via `formatEgp` (renders `٬`
  separator + `ج.م` suffix). Never inline-format currency in UI (`CLAUDE.md` §2.1, §4).
- **Tabular numerals** everywhere a number can change in place (timers, money, counts) so layout never
  shifts (`number-tabular`).
- **Mixed content:** wrap any Latin token (device id, email) so it doesn't flip the surrounding Arabic
  paragraph direction; use isolation (`bdi` on web, explicit direction on RN `Text`).
- **Forms:** labels and errors align to the **start**; the error sits below its field on the start edge.

---

## 7. Accessibility — global rules (binding)

Priorities 1–2 from `ui-ux-pro-max` are CRITICAL and gate review:

- **Contrast** ≥ 4.5:1 body, ≥ 3:1 large/UI glyphs, verified in **both** themes (`color-contrast`).
- **Touch targets ≥ 52px** (our counter-speed floor, above the 44/48 minimum) with ≥ 8px spacing; expand
  hit area with `hitSlop` when the glyph is smaller (`touch-target-size`, `touch-spacing`).
- **Every icon-only control** has an `accessibilityLabel` / `aria-label` (`aria-labels`); status is conveyed
  by **icon + text + color**, never color alone (`color-not-only`).
- **Visible focus** rings on web (2–4px, `primary`/`border-strong`); logical focus order matches visual /
  reading order in RTL (`focus-states`, `voiceover-sr`).
- **Reduced motion** and **dynamic type** supported without layout breakage (`reduced-motion`,
  `dynamic-type`) — components wrap, never truncate critical data; money/timer fields reserve width.
- **Destructive actions** (void, refund, suspend tenant, end impersonation) use `danger`, are spatially
  separated from the primary CTA, and require confirmation (`destructive-emphasis`, `confirmation-dialogs`).
- Modals/sheets always have a visible dismiss + escape route; `aria-live` for toasts and form errors so
  screen readers announce without stealing focus (`toast-accessibility`, `aria-live-errors`).

---

## 8. The four required states (every screen, every feature)

Every screen and data surface specifies all four (`design-approach.md`, `empty-states`, `loading-states`,
`error-recovery`, `offline-support`). The contracts:

| State | Contract |
|---|---|
| **Empty** | Icon + one-line cause + one primary action (e.g. "No tenants yet — Provision the first tenant"). Never a blank panel. |
| **Loading** | **Skeleton** matching final layout (shimmer), shown when > 300ms; reserves space so there is no layout shift (CLS < 0.1). Buttons show inline spinner + disabled during async (`loading-buttons`). |
| **Error** | Human cause + recovery path (Retry / Edit / contact). Inline near the failed region, not a top-of-page dump. `role="alert"` / `aria-live`. |
| **Offline** | Persistent banner (mobile): "Offline — changes are queued" with pending count; queued actions apply optimistically and flush on reconnect (outbox concept, `mobile-patterns.md`). Web super-admin: disable mutations + show reconnect state. |

---

## 9. Shared component primitives (cross-platform contracts)

These are the reusable primitives every feature composes. Each lists **props · states · RTL/a11y**.
Mobile = React Native; Web = shadcn/ui + Tailwind. Same tokens, same behavior.

> Naming note: do **not** transcribe the trial's components; these are re-specified clean. Equivalent trial
> files are interaction references only.

### 9.1 `Button`
- **Variants:** `primary` (one per screen) · `secondary` (outline) · `ghost` · `danger`.
- **Props:** `variant`, `size('md'|'lg')`, `loading`, `disabled`, `icon?`, `iconPosition('start'|'end')`,
  `fullWidth`, `onPress`/`onClick`, `accessibilityLabel`.
- **States:** default · pressed (opacity .92 / scale .97, <100ms) · loading (spinner, disabled) ·
  disabled (opacity .45, no press). Min height **52** (`lg` 56).
- **RTL/a11y:** icon respects `iconPosition` via logical start/end; directional icons mirror; label required
  when icon-only.

### 9.2 `StatusPill` (free / busy / maintenance / warning / danger / impersonation)
- **Props:** `status`, `label`, `dot(bool)`, `pulse(bool, default false)`.
- **Renders:** colored dot + label on a `${color}1A` tint; text uses the status color at AA contrast.
- **States:** static; `pulse` animates the **dot** opacity only (disabled under reduced-motion).
- **RTL/a11y:** dot sits at the **start**; conveys status by **dot + label** (never color alone). Tooltip/
  `accessibilityValue` echoes the status text.

### 9.3 `Sheet` (mobile) / `Dialog` (web)
- **Props:** `visible`, `onClose`, `title`, `leading?` (badge/icon at title start), `children`,
  `dismissible(bool)`, `confirmOnDirty(bool)`.
- **Mobile:** bottom sheet, top corners `radius.lg`, drag handle centered, scrim `scrim`, slides up from
  trigger, max-height 92%, safe-area bottom padding. **Web:** centered dialog, `e3`, scrim.
- **States:** open/close animated (`modal-motion`); `confirmOnDirty` intercepts dismiss when there are
  unsaved changes (`sheet-dismiss-confirm`).
- **RTL/a11y:** title row aligns to start; close affordance at the **end**; focus trapped, Esc closes,
  focus returns to trigger; `aria-modal`. Title is `h2`.

### 9.4 `SegmentedControl`
- **Props:** `options[]` (`{value,label,icon?}`), `value`, `onChange`, `size`.
- **States:** selected segment = `primary` fill + `on-primary` text; unselected = `text-muted`; pressed
  feedback; animated thumb (transform, respects reduced-motion).
- **RTL/a11y:** segment order follows reading order (mirrored in RTL); `role=radiogroup`/`accessibilityRole`;
  selected announced. Min segment height 44, track in a 52-tall row.

### 9.5 `NumberStepper`
- **Props:** `value`, `min`, `max`, `step`, `onChange`, `suffix?` (e.g. "دقيقة").
- **States:** −/＋ buttons (≥44, hitSlop to 52), disabled at bounds; long-press to repeat.
- **RTL/a11y:** value displayed Arabic-Indic, tabular; −/＋ keep semantic meaning (do not swap by RTL —
  minus is always decrement); each button labeled.

### 9.6 `TextField`
- **Props:** `label` (visible, not placeholder-only), `value`, `onChange`, `error?`, `helper?`, `required`,
  `type`, `autoComplete`/`textContentType`, `disabled`, `readOnly`.
- **States:** default · focus (`border-strong` + ring on web) · error (`danger` border + message below) ·
  disabled (.45) · read-only (visually distinct from disabled). Validate on **blur**, not keystroke.
- **RTL/a11y:** label + error align start; `type` drives the correct mobile keyboard; password fields get a
  show/hide toggle at the end; `aria-describedby` links helper/error; min height 52.

### 9.7 `DataTable` (web) / `RowList` (mobile)
- **Props:** `columns[]`, `rows[]`, `sortable`, `onSort`, `rowActions[]`, `emptyState`, `loading`, `error`.
- **States:** all four required states built in; sticky header; sortable headers show `aria-sort`;
  virtualize at 50+ rows (`virtualize-lists`).
- **RTL/a11y:** columns lay out start→end mirrored; numeric columns right-aligned *in logical terms*
  (end-aligned) and tabular; row actions in an end-anchored cell or overflow menu (`overflow-menu`).

### 9.8 `Toast` + `ConfirmDialog`
- **Toast:** auto-dismiss 3–5s, `aria-live=polite`, does not steal focus; success/error/info variants with
  icon (`toast-dismiss`, `success-feedback`).
- **ConfirmDialog:** title + consequence sentence + cancel(start)/confirm(end); destructive confirm uses
  `danger`; always required before void/refund/suspend/impersonate (`confirmation-dialogs`).

### 9.9 `Skeleton`, `EmptyState`, `ErrorState`, `OfflineBanner`
- Direct realizations of §8. `OfflineBanner` shows pending-write count and reconnect status; `ErrorState`
  always carries a retry. All respect RTL alignment and reduced-motion (skeleton shimmer disables).

### 9.10 `LiveTimer` (operator — Phase 3)
The one primitive that encodes `CLAUDE.md` §2.2: **never a `setInterval` elapsed counter** — it stores
`startedAt` (UTC ISO) and recomputes from the clock each render.
- **Props:** `startedAt` (ISO), `endedAt?` (ISO; when set the timer is frozen — closed session),
  `format('clock'|'compact')`, `tickMs` (1000 on a detail screen, 15000–30000 on the grid),
  `size('sm'|'md'|'lg')`.
- **Behavior:** uses `elapsedSeconds(startedAt, endedAt)` + `formatClock` from `@ps/core`; a `useTick(tickMs)`
  hook only forces re-render — it is **never** the source of the value. On background/foreground or network
  loss the displayed value stays correct because it derives from `startedAt`.
- **States:** running (live, `tickMs` re-render) · frozen (`endedAt` set, no tick) · `tickMs=null` disables
  ticking for off-screen cards.
- **RTL/a11y:** digits Arabic-Indic via `toArabicDigits`; **`timer` type role, tabular** so HH:MM:SS never
  reflows; a clock is **not** directional — **do not mirror** it; `accessibilityLabel` reads the elapsed
  duration in words, not the raw glyphs.

### 9.11 `DeviceCard` (operator — Phase 3)
The glanceable grid cell. Free vs busy is readable in under a second from across a counter.
- **Props:** `name`, `deviceType('ps4'|'ps5'|'vip')`, `status('free'|'busy'|'maintenance')`,
  `session?` ({ startedAt, runningTotalPiastres? }), `onPress`.
- **Renders:** device name (`h3`) + a `StatusPill`; **free** = `status-free` 1px border + dot, body shows a
  "tap to start" affordance; **busy** = `status-busy` border, a `LiveTimer` (grid `tickMs`), and the running
  money via `formatEgp` in `money` role; **maintenance** = `status-maint`, muted, non-interactive.
- **States:** the card itself carries the four screen-states via its parent grid (skeleton card, empty grid,
  error, offline). Press feedback scale .97 <100ms (`scale-feedback`); busy dot uses the 1.2s opacity pulse
  (reduced-motion disables).
- **RTL/a11y:** min tap target ≥ 52 (whole card is the target); status by **pill + dot + border**, never
  color alone; `accessibilityLabel` composes name + status + (busy) elapsed + total; money tabular.

### 9.12 `BranchPicker` (operator — Phase 3)
Selects the active branch within the resolved tenant; the app never renders data outside the active
tenant/branch (`mobile-patterns.md`).
- **Props:** `branches[]` ({ id, name }), `activeId`, `onSelect`, `variant('screen'|'switcher')`.
- **`screen`** (post-login, when membership spans >1 branch): a full list of large rows (≥ 56),
  one primary tap each. **`switcher`** (in the `AppScaffold` header): a compact control opening a `Sheet`/
  `Dialog` list; single-branch members skip the screen and see a static label (no control).
- **States:** all four (loading skeleton rows · empty "no branches assigned — contact your owner" · error +
  retry · offline shows last-known list, selection queued).
- **RTL/a11y:** rows align start; active branch shows a check at the **end** + `aria-current`/
  `accessibilityState.selected`; chevron in `switcher` mirrors in RTL.

### 9.13 `AppScaffold` (operator — Phase 3)
The shared mobile shell: safe-area header (tenant/branch identity + branch switcher + sync dot), content
slot, and the persistent `OfflineBanner`. Web owner-read reuses the same regions in a sidebar layout.
- **Props:** `title`, `branchSwitcher?`, `online`, `pendingCount`, `children`, `headerEnd?` (actions slot).
- **RTL/a11y:** header lays out start→end mirrored; identity at start, actions at end; respects top/bottom
  safe areas and reserves space for the fixed `OfflineBanner` (`fixed-element-offset`, `safe-area-awareness`).
- **Phase 8:** the reserved "sync dot" slot is realized by `SyncStatusChip` (§9.14); the shell may also stack
  the `SyncAttentionBanner` below the header when a write dead-letters.

### 9.14 Sync-status primitives (operator — Phase 8)
The offline-resilience surfaces. Full screen/state specs in **`docs/design/phase-8-offline-sync-status.md`**;
this is the primitive registry only. Four operator-facing sync states — `synced` / `syncing` / `offline` /
`attention` (precedence `attention > offline > syncing > synced`) — map onto **existing** semantic tokens
(`status-free` / `primary` / `warning` / `danger`; **no new color hex**, feature doc §11).
- **`SyncStatusChip`** — persistent header chip (end side, every operate tab); `StatusPill` grammar + state
  icon + count; tappable → opens the Sync Center. Always tappable (never disabled); ≥ 52 via `hitSlop`;
  count/time Arabic-Indic; non-directional icons not mirrored.
- **`SyncAttentionBanner`** — the dead-letter alarm; appears **only** when `failedCount > 0`; `danger`-tinted,
  persistent, **never flashes** (anti-panic); Review action opens the Center's Failed section.
- **`SyncCenterSheet`** (+ `SyncSummaryHeader`, `QueueEntryRow`) — the detail view (a `Sheet`, §9.3): status
  summary (connectivity, last-synced, counts, Sync-now), the Failed (dead-letter) list with per-row
  Retry/Discard, and the Pending list. Discarding a money-bearing entry requires the money-aware
  `ConfirmDialog` (§9.8). All-clear empty state answers "is everything synced?" at shift close.
- **`PendingTag`** — tiny "بانتظار المزامنة" marker on optimistically-created flow items (device/order/stock
  rows) until the outbox entry flushes.
- **`OfflineBanner` (§9.9)** — extended in Phase 8 to re-wire the pending count + tap-to-open the Center.
- **Icons:** Phase 8 introduces the first consistent vector icon set (Lucide via `lucide-react-native` /
  `@expo/vector-icons`) — never emoji (`no-emoji-icons`); package choice is an engineering call (feature §11.2).

---

## 10. Charts & data (owner-dashboard system — Phase 6)

Reserved at system level so the brand is complete (`chart-type`, `number-formatting`, `empty-data-state`).
**First implemented in Phase 6** (`docs/design/phase-6-owner-dashboard-reports.md` — screens, table specs,
states). This section is the **source of truth for chart tokens, the categorical palette, and RTL chart
rules**; the feature doc composes against it and never re-derives a token. The chart *library* is an
architect call (ADR-0007 Q7); everything here is **library-agnostic** (it constrains the SVG output, not the
package).

### 10.1 Chart color tokens (categorical + semantic)

Charts draw from the same ramps as the UI so a series color always *means* the same thing it does elsewhere
(`color-semantic`, `consistency`). The semantic four are fixed; the extended categorical sequence is for
many-category series (e.g. top products by category). **Violet is never used in charts** (reserved for
impersonation only). Red is reserved for *negative variance / loss*, never an ordinary category.

| Token | Dark | Light | Meaning (fixed) |
|---|---|---|---|
| `chart-time` | `T500 #14B8A6` | `T600 #0D9488` | **Time revenue** (the core billable) — same teal as `primary` |
| `chart-orders` | `B500 #3B82F6` | `B500 #3B82F6` | **Orders / snacks revenue** — same blue as `busy`/`info` |
| `chart-discount` | `A500 #F59E0B` | `A600 #D97706` | **Discounts** — same amber as `warning` |
| `chart-cash` | `G500 #10B981` | `G600 #059669` | **Cash** settled — same green as `status-free` |
| `chart-pos` | `G500 #10B981` | `G600 #059669` | Positive variance / over |
| `chart-neg` | `R500 #EF4444` | `R600 #DC2626` | Negative variance / short / loss |

**Extended categorical sequence** (use *in order*, only when a series has no fixed semantic meaning — e.g.
product categories): `T500` → `B500` → `A500` → `T300 #5EEAD4` → `B400 #60A5FA` → `N400 #64748B`. Six steps;
beyond six, group the tail into an "أخرى / Other" bucket (`no-pie-overuse`, `data-density`).

**Payment-mix series** (donut): cash = `chart-cash` (green), wallet = `chart-orders` (blue), other =
`N400` neutral slate. (`debt` is inert this phase — excluded, never a slice; system §2.2.)

### 10.2 Chart structural tokens

```
chart-grid        border  (#22304A dark / N200 light)   — gridlines, low-contrast (gridline-subtle)
chart-axis        text-muted                              — axis ticks + labels
chart-axis-title  text                                    — axis unit titles
chart-track       surface-2                               — empty bar track / donut remainder
chart-tooltip-bg  surface (e2 elevation) + border 1px     — popover on hover/tap
series-stroke     2px                                      — line series weight
bar-radius        radius.xs (8) on the bar's end cap only — never both ends
donut-thickness   ~62% inner radius (calm ring, not thin) — matches the prepaid-ring lesson
```

### 10.3 Chart type mapping (which chart for which KPI)

| KPI / data | Chart | Why (`chart-type`) |
|---|---|---|
| Revenue over time (per business-day) | **Stacked vertical bar** (time `chart-time` + orders `chart-orders`), one bar per business-day | comparison across discrete days; stack shows the time-vs-orders split inline |
| Revenue split (time / orders / discount) | **Donut**, ≤3 slices, center = Gross total | proportion of a whole (`no-pie-overuse` ✓ ≤5) |
| Top products | **Horizontal bar** (top N, qty↔revenue toggle) | ranked comparison; horizontal keeps long Arabic product names readable |
| Device utilization | **Horizontal bar** per device (busy-minutes primary; % secondary label) | ranked comparison; horizontal fits device names |
| Payment-method mix | **Donut**, 3 slices (cash/wallet/other) | proportion of settled revenue |
| Sessions by day / peak | **Vertical bar** (count per business-day) | discrete-day comparison |

Line is reserved for true continuous trends; with discrete business-day buckets and sparse café data, **bars
read more honestly** than a connected line (avoids implying interpolation between closed days).

### 10.4 RTL chart rules (binding — `rtl-i18n-check` covers Phase 6)

- **Time axis flows right→left.** In a business-day bar chart the *earliest* day sits at the **right**, the
  latest at the **left** (natural Arabic reading). Tooltips, brush, and any cursor follow the same direction.
- **Horizontal bars grow from the right** (the start edge) leftward; the category label sits at the **start**
  (right), the value label at the bar **end** (`direct-labeling` for ≤8 bars).
- **Legends** sit at the **start** (top-right in RTL) or below; legend swatch precedes its label in reading
  order; legends are **interactive** (tap a series to toggle, `legend-interactive`).
- **Donut** sweeps and the legend order follow reading order; the center total is `money` role, tabular.
- **Numerals on every axis tick, data label, tooltip, legend value, and donut center are Arabic-Indic**
  (`toArabicDigits`); money via `formatEgp`; percentages via a shared `formatPercentAr` helper (Arabic-Indic
  digits + `٪`). **No Western digits rendered in any chart** (CSV export is the only Western-digit surface).
- **Never mirror a chart by flipping the whole SVG** (that would mirror glyphs); mirror by *configuring*
  direction/scale so text stays legible (system §6: "do not mirror logos/media/illegibly").

### 10.5 Chart accessibility (binding)

- **Color is never the only signal:** every series carries a legend label + a **pattern/texture** fill option
  for the stacked bar and donut (`pattern-texture`, `color-not-only`); the palette already avoids a
  red/green-only pair for ordinary categories (`color-guidance`).
- **Every chart ships a screen-reader text summary** (`screen-reader-summary`, one sentence of the key
  insight) **and** the same numbers are available in the report table below it (the `DataTable` *is* the
  accessible alternative, `data-table`).
- **Tooltips are keyboard-reachable** and appear on tap (≥44 hit target on points/bars/slices,
  `tooltip-keyboard`, `touch-target-chart`); they show the exact `formatEgp` value, not the rounded axis.
- **Entrance animation respects `prefers-reduced-motion`** — data is readable immediately, the grow-in is
  optional (`animation-optional`).
- **Contrast:** data marks vs background ≥ 3:1, data text labels ≥ 4.5:1, gridlines low-contrast
  (`contrast-data`, `gridline-subtle`), verified in both themes.

### 10.6 Chart states (the four, every chart)

| State | Chart contract |
|---|---|
| **Empty** | A drawn, labelled, **zeroed** frame + a centered "no data in this range" message (`empty-data-state`) — **never** a blank box and never a misleading flat line at 0 that looks like real data. |
| **Loading** | A **skeleton** in the chart's footprint (shimmer block sized to the chart), not an empty axis frame (`loading-chart`); reserves space (CLS < 0.1). |
| **Error** | Inline error card in the chart slot with **Retry** (`error-state-chart`) — never a broken/half-rendered axis. |
| **Offline / stale** | Phase-6 reports are read-on-demand (no outbox); a stale view shows the last figures with a "reconnect / refresh" affordance (system §8 web rule). |

---

## 11. What we deliberately did **not** carry from the trial

- The **orange brand + hot gradient CTA** identity → replaced by calm teal accent + low-chroma neutrals.
- **Busy = brand color** → busy is now **blue** (normal state); the brand accent is reserved for the single
  primary CTA and the money total; amber/red reserved strictly for warning/danger.
- **Pulsing colored shadow glow** on busy cards → replaced by a status border + a dot-only opacity pulse
  (cheaper, accessible, reduced-motion-safe).
- **`row-reverse` sprinkled per component** → replaced by layout-level RTL mirroring with logical
  start/end spacing.
- Bespoke radii (11/13/15) → a calmer uniform radius scale.

We **kept the interaction lessons**: glanceable status grid, bottom sheets for start/add/close, segmented
controls + number steppers, the prepaid countdown idea, the ~52px tap floor, tabular money/timers, and the
owner-accent concept (re-scoped).
