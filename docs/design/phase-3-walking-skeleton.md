# Feature design — Phase 3: Walking Skeleton (operator app + owner read)

> Tokens, type, spacing, motion, RTL, a11y, and the shared primitives all come from
> **`docs/design/design-system.md`** ("Calm Operations" — dark-first, low-chroma, teal accent). This doc only
> specifies the **screens, their composition, component contracts, and the four states** for the Phase-3
> slice. It never re-derives a token or a rule; where a value appears it cites the system token.
>
> - **Surfaces:** `apps/mobile` (Expo / React Native — counter operator) · `apps/web` (Next.js + shadcn/ui —
>   owner read-only view).
> - **References:** `CLAUDE.md` §2 (money/timers/RTL), `docs/reference/mobile-patterns.md` (live timers,
>   nav, RTL), `docs/reference/core-api.md` (`elapsedSeconds`/`formatClock`/`formatEgp`/`toArabicDigits`),
>   `docs/design/design-system.md` §9 primitives.
> - **Trial = interaction lessons only.** Glanceable status grid, bottom sheets, ~52px tap floor, tabular
>   money/timers are kept; the orange theme / pulsing-glow / `row-reverse` are **not** (system §11).

---

## 1. The slice (what Phase 3 proves end-to-end)

```
Login ──▶ resolve tenant + branch from JWT claim ──▶ (Branch picker if >1) ──▶ Device grid
                                                                                   │
                                            tap a FREE card ──▶ Start open session ─┘
                                                                                   │
                                            tap a BUSY card ──▶ Session detail (live timer) ──▶ Close
```

**Thin on purpose.** Only the **open meter** billing mode, only **start** and **close**, live timer from
`started_at`. No orders, products, shifts, prepaid, fixed-match, segments-switching UI yet — but the
components are shaped so those drop in later without re-layout (e.g. `SessionDetail` reserves a slot for the
orders list; `StartSessionSheet` reserves the billing-mode `SegmentedControl` even though only "open" is
enabled).

**Strings:** every user-facing string is an i18n key — keys are listed inline as `t('…')`. Arabic is the
default; Arabic-Indic numerals via `toArabicDigits`, money via `formatEgp` (system §6).

---

## 2. Shared component vocabulary (mobile ↔ web)

Both surfaces compose the **same primitives** from design-system §9 — only the platform render differs
(RN `Pressable`/`Modal` vs shadcn/Radix). Phase-3 screen-level reuse:

| Concept | Mobile (Expo) | Web (owner read) | Primitive(s) |
|---|---|---|---|
| Shell | `AppScaffold` (safe-area header + offline banner) | sidebar + topbar layout, same regions | §9.13 |
| Auth form | `TextField` ×2 + `Button` | same | §9.1, §9.6 |
| Branch select | `BranchPicker` screen / header switcher | branch `Select` in topbar | §9.12 |
| Device cell | `DeviceCard` (tappable) | `DeviceCard` (read-only, no `onPress`) | §9.11 |
| Live clock | `LiveTimer` | `LiveTimer` (frozen for recent/closed) | §9.10 |
| Status | `StatusPill` | `StatusPill` | §9.2 |
| Start/close | `Sheet` + `ConfirmDialog` | n/a (read-only) | §9.3, §9.8 |
| Recent list | `RowList` | `DataTable` | §9.7 |
| States | `Skeleton`/`EmptyState`/`ErrorState`/`OfflineBanner` | same | §9.9 |

---

# MOBILE (Expo — operator)

Navigation per `mobile-patterns.md`: Expo Router groups `(auth)` → resolve tenant/branch → `(operate)`.
`app/index.tsx` redirects on `authSession` then role. RTL forced once at boot; layout mirroring at the
primitive level (system §6), never `row-reverse` per component.

## M1. Login `(auth)/login`

**Purpose:** authenticate; on success the JWT carries the tenant claim (Phase 2 hook) and the app resolves
tenant + branch membership. **Primary action:** Sign in (one CTA).

**Layout (375px floor):** `AppScaffold` without header chrome → brand mark (logo, **not** mirrored) →
`h1` `t('auth.signIn.title')` → email `TextField` → password `TextField` (show/hide toggle at the **end**) →
primary `Button` full-width (height 52) → ghost `t('auth.forgotPassword')` link.

**Component contract — `LoginForm`**
- Props: `onSubmit(email, password)`, `loading`, `error?`.
- `TextField` email: `type='email'`, `textContentType='username'`/`autoComplete='email'` (correct keyboard +
  autofill, `input-type-keyboard`), label `t('auth.email')`, validate on **blur**.
- `TextField` password: `type='password'`, end-aligned show/hide toggle, `textContentType='password'`.
- `Button`: `variant='primary'`, `loading` shows inline spinner + disabled during async (`loading-buttons`).

**Four states**
- **Empty (default):** fields blank, CTA enabled; helper text only where useful.
- **Loading:** CTA spinner + disabled; fields locked; **no full-screen spinner**.
- **Error:** auth failure renders **below the form** in a `danger`-toned inline region with `role="alert"` /
  `aria-live` — `t('auth.error.invalidCredentials')` — and **re-focuses the first invalid field**
  (`focus-management`). Tenant-claim-missing (membership not yet provisioned) → distinct message
  `t('auth.error.noTenant')` with a "contact support" affordance, **not** a generic failure.
- **Offline:** sign-in needs the network → CTA disabled with `t('auth.offline')` helper + the persistent
  `OfflineBanner`; re-enables on reconnect. (No optimistic auth.)

**RTL/a11y:** labels + errors align **start**; password toggle at **end**; touch targets ≥ 52; brand mark not
mirrored; email field isolates the Latin value (`bdi`-equivalent) so it doesn't flip the Arabic layout.

## M2. Branch picker `(operate)/select-branch`

Shown **only when** the resolved tenant membership spans **>1 branch**. Single-branch members skip straight
to the grid (the branch shows as a static label in the header). `BranchPicker variant='screen'` (§9.12).

**Layout:** `h1` `t('branch.choose.title')` → list of branch rows (each ≥ 56, whole row tappable) → on select,
persist active branch and route to the grid.

**Four states**
- **Empty:** membership resolved but **zero** branches → `EmptyState` `t('branch.empty.title')` /
  `t('branch.empty.body')` ("no branches assigned — contact your owner"); no dead-end blank.
- **Loading:** 3–5 skeleton rows matching final row height (no layout shift).
- **Error:** membership/branch fetch failed → `ErrorState` + Retry (`error-recovery`).
- **Offline:** show last-known branch list (cached); selection is queued and applied on reconnect; banner
  visible.

**RTL/a11y:** rows align start, active gets an end-anchored check + `accessibilityState.selected`; back
navigation predictable; deep-linkable.

## M3. Device grid `(operate)/devices` — the home screen

**Purpose:** the glanceable operating surface — see every device's free/busy state and the live money at a
glance; one tap to act. **Primary action per card:** start (free) or open detail (busy).

**Layout**
- `AppScaffold` header: tenant name + `BranchPicker variant='switcher'` (start), sync dot + count (end).
- A **summary strip** (optional, calm): "X busy · Y free" using `StatusPill`s — glanceable counts, tabular.
- **Grid** of `DeviceCard` (§9.11): 2 columns at 375px, 3 at ≥ 600px (tablet/landscape); 12px gutters
  (system spacing `sm`), comfortable touch density. Cards are square-ish; the whole card is the ≥52 target.
- Grid refresh cadence **15–30s** (`refetchInterval`), but each **busy** card's `LiveTimer` ticks **1s**
  locally — value derived from `started_at`, never an interval counter (`mobile-patterns.md`, §9.10).

**`DeviceCard` per state**
- **Free:** `status-free` border + dot + `StatusPill t('device.status.free')`; body = subtle "tap to start".
- **Busy:** `status-busy` border + `LiveTimer` (`format='clock'`, grid `tickMs`) + running total
  `formatEgp(...)` in `money` role (tabular); dot pulses (reduced-motion disables).
- **Maintenance:** `status-maint`, muted, non-interactive (`empty-nav-state` analog — explain, don't hide).

**Four states (screen-level)**
- **Empty:** branch has **no devices** → `EmptyState` `t('devices.empty.title')` ("No devices yet"); for
  Phase 3 the recovery is owner-side, so the action is informational (`t('devices.empty.body')`).
- **Loading:** a grid of **skeleton cards** (same dimensions) with shimmer (>300ms); reserves space → no CLS.
- **Error:** grid fetch failed → `ErrorState` replacing the grid, Retry; header stays usable.
- **Offline:** persistent `OfflineBanner` `t('offline.queued')` + pending count; the grid renders from cache;
  start/close actions apply **optimistically** and flush on reconnect (outbox concept). A queued card shows a
  small "pending" marker so the operator knows the write hasn't synced.

**RTL/a11y:** grid fills start→end mirrored; each card `accessibilityLabel` = name + status + (busy: elapsed +
total); status never color-only; money/timer tabular so cards don't jitter as digits change.

## M4. Start session — `StartSessionSheet` (bottom sheet)

Triggered by tapping a **free** card. `Sheet` (§9.3) keeps the grid in context (trial lesson). **Thin Phase-3
form:** open-meter only.

**Layout:** sheet title `t('session.start.title')` + device name leading → a `SegmentedControl` for
**billing mode** with only `open` enabled (others present but disabled, reserving the layout for Phase 4) →
play-mode `SegmentedControl` (`single`/`multi`) → primary `Button` `t('session.start.confirm')` (height 56,
`lg`). Sheet slides up from the card (`modal-motion`), scrim `scrim`, safe-area bottom padding.

**Component contract — `StartSessionSheet`**
- Props: `visible`, `device`, `onConfirm({ playMode, billingMode })`, `onClose`, `submitting`,
  `confirmOnDirty`.
- On confirm: client `uuidv4()` id; queues session + first segment + device→busy **together** (idempotent
  upsert, `mobile-patterns.md`); optimistic — the card flips to busy immediately.

**Four states**
- **Empty/default:** open meter + single preselected; confirm enabled.
- **Loading (submitting):** confirm spinner + disabled; sheet stays open until queued, then closes.
- **Error:** if the write is rejected (e.g. device already busy — concurrent start) → inline `danger` message
  in the sheet `t('session.start.error.busy')` + the grid reconciles; recovery = close + reopen on the now-busy card.
- **Offline:** confirm still works (optimistic + queued); sheet shows `t('offline.willSync')` note; banner
  visible.

**RTL/a11y:** title row start-aligned, close affordance at **end**; segmented order mirrors reading order but
−/＋-style semantics not applicable here; focus trapped, Esc/drag-down closes, `confirmOnDirty` guards
dismissal; segments ≥ 44 in a 52 row.

## M5. Session detail — `(operate)/session/[id]`

Triggered by tapping a **busy** card. **Purpose:** watch the live bill and **close** the session.
**Primary action:** Close & settle (one CTA, `danger`-adjacent emphasis but it is the primary completion, so
`primary` fill; the **destructive** confirm is in the dialog).

**Layout**
- Header: device name + `StatusPill busy`.
- **Hero block:** big `LiveTimer` (`size='lg'`, `format='clock'`, `tickMs=1000`) centered; below it the
  **running total** via `formatEgp` in `money` `display` size (tabular). Started-at shown as
  `t('session.startedAt')` + `formatTime` (Arabic-Indic).
- A **reserved orders slot** (empty in Phase 3 — hidden, not a placeholder box) so Phase-6 orders insert
  without re-layout.
- Bottom: primary `Button` `t('session.close.confirm')` full-width (56), pinned above safe area.

**Close flow:** tapping Close opens a `ConfirmDialog` (§9.8) summarizing **frozen** elapsed + computed total
(`t('session.close.summary')`) → confirm writes the close (computes `time_total` via core, clamps bill ≥ 0,
writes `audit_log` per `CLAUDE.md` §2.7), freezes the `LiveTimer` (`endedAt` set), flips the card to free,
routes back to the grid, and shows a success `Toast`.

**Component contract — `SessionDetail`**
- Props: `session` ({ id, startedAt, deviceName, status }), `liveTotalPiastres`, `onClose()`, `closing`.
- `LiveTimer`: `startedAt` from the session; **frozen** (`endedAt`) once closed. Never an interval counter.
- `ConfirmDialog`: cancel (start, ghost) / confirm (end). Destructive emphasis on the consequence sentence;
  confirm disabled+spinner while `closing` (`loading-buttons`).

**Four states**
- **Empty:** n/a (a detail always has a session); a session that was closed elsewhere (realtime) →
  reconciles to a "this session is closed" `EmptyState` with a back action, not a stuck timer.
- **Loading:** skeleton hero (timer + total placeholders) while the session loads (>300ms).
- **Error:** load or close failure → inline `ErrorState` near the action with Retry; the timer keeps running
  correctly (derived from `started_at`) even if the close write failed — the bill is never corrupted.
- **Offline:** Close still works optimistically (queued, audit row queued too); dialog shows
  `t('offline.willSync')`; the card flips free locally and reconciles on flush; banner visible.

**RTL/a11y:** the **timer/clock is not mirrored**; money + timer tabular; `accessibilityLabel` on the timer
reads elapsed in words; Close is the single primary, the confirm dialog supplies destructive friction
(`confirmation-dialogs`, `destructive-emphasis`); back behavior predictable, state preserved.

---

# WEB (Next.js — owner read-only)

**Purpose:** an owner, on a laptop, watches their branch live — **read-only** in Phase 3 (no start/close on
web). Same brand, same primitives (shadcn/Radix render). Arabic-first/RTL like the operator app; numerals
Arabic-Indic; money via `formatEgp`. Adaptive: sidebar ≥ 1024px, top bar + drawer below
(`adaptive-navigation`).

## W1. Login `/login`

Same `LoginForm` contract as M1 (shadcn `Input` + `Button`). Centered card on `bg`, `e3` elevation, max-width
~ 400px. Visible focus rings (2–4px `primary`/`border-strong`, `focus-states`). Four states identical to M1
(empty / submitting / inline error with `role="alert"` + first-field focus / offline disables CTA — web
shows a reconnect state rather than a queue, since reads need the network).

## W2. Devices + sessions (read) `/branch/[branchId]/devices`

**Layout**
- Topbar: tenant name (start) · **branch `Select`** (the web form of `BranchPicker`) · sync/connection state
  (end). Sidebar: Devices (active), with later phases reserved.
- **Devices section:** the same `DeviceCard` grid as mobile, but cards are **read-only** (`onPress` omitted,
  no hover-as-affordance for actions — hover only reveals detail, never a primary action, `hover-vs-tap`).
  Live timers tick from `started_at`; grid auto-refreshes (TanStack Query `refetchInterval`) + realtime
  invalidation where available.
- **Current & recent sessions table** (`DataTable`, §9.7): columns = Device · Status (`StatusPill`) ·
  Started (`formatTime`) · Elapsed (`LiveTimer` — live for active, **frozen** for closed) · Total
  (`formatEgp`, end-aligned/tabular). Sortable headers with `aria-sort`; virtualize at 50+ rows. Read-only:
  no row actions in Phase 3 (the actions cell is reserved/empty).

**Component contract — `OwnerDevicesView`**
- Props: `branchId`, `devices[]`, `sessions[]` (active + recent), `connection('online'|'reconnecting')`.
- `DataTable`: `columns`, `rows`, `sortable`, `emptyState`, `loading`, `error` — all four states built in.
- No mutations on this surface (system §8 offline contract for web = disable mutations + show reconnect; here
  there are none, so offline = stale-data banner + reconnect indicator).

**Four states**
- **Empty:** branch has no devices → `EmptyState` ("No devices configured for this branch"); table shows its
  own empty row ("No sessions yet").
- **Loading:** skeleton device cards + skeleton table rows matching final layout (no CLS); never an empty axis
  frame or bare table.
- **Error:** section-scoped `ErrorState` + Retry (grid and table can fail independently); topbar stays usable.
- **Offline / reconnecting:** banner `t('web.offline.stale')` ("showing last-known data — reconnecting");
  timers keep computing from `started_at` (still correct); reconnect re-validates.

**RTL/a11y:** table columns lay out start→end **mirrored**; numeric columns (Elapsed, Total) **end-aligned**
in logical terms + tabular; sortable headers keyboard-reachable with `aria-sort`; focus moves to main content
on route change (`focus-on-route-change`); branch `Select` shows current with `aria-current`.

---

## 3. Cross-cutting contracts (both surfaces)

- **Timers (binding, `CLAUDE.md` §2.2):** every elapsed value is `elapsedSeconds(startedAt, endedAt?)` +
  `formatClock` from `@ps/core`. A tick hook only re-renders. Background/foreground/network loss must never
  change a computed bill. Closed sessions pass `endedAt` and freeze.
- **Money (binding, §2.1):** all amounts are integer piastres in state and render via `formatEgp`
  (Arabic separator `٬`, suffix `ج.م`). Never inline currency math in a component.
- **Numerals:** displayed digits Arabic-Indic via `toArabicDigits`; computation values stay Western.
- **Idempotent writes (mobile):** client `uuidv4()` + upsert; start = session + segment + device-busy queued
  together; close writes the bill + `audit_log` (§2.7); optimistic + outbox flush.
- **Tap floor:** ≥ 52 on every operator control; ≥ 8px spacing; `hitSlop` where a glyph is smaller.
- **Reduced motion:** busy-dot pulse, sheet/stagger, and skeleton shimmer all disable; data is readable
  immediately.

## 4. i18n key inventory (Phase 3 — keys only, strings live in resources)

```
auth.signIn.title · auth.email · auth.password · auth.signIn.cta · auth.forgotPassword
auth.error.invalidCredentials · auth.error.noTenant · auth.offline
branch.choose.title · branch.empty.title · branch.empty.body
devices.empty.title · devices.empty.body · device.status.free · device.status.busy · device.status.maintenance
session.start.title · session.start.confirm · session.start.error.busy
session.startedAt · session.close.confirm · session.close.summary · session.closed.title
playMode.single · playMode.multi · billingMode.open
offline.queued · offline.willSync · web.offline.stale
state.loading · state.error.generic · action.retry · action.cancel
```

## 5. What Phase 3 deliberately defers (shaped-for, not built)

- Orders/products, prepaid + fixed-match billing, segment switching, shifts/reports — **reserved layout
  slots** exist (start sheet billing-mode control, session-detail orders slot, web row-actions cell) so they
  add without a redesign.
- Web mutations (start/close from owner view), super-admin operator-app access (super-admin stays on the web
  console per `mobile-patterns.md`), and the owner accent override (system §2.3) — all later phases.

## 6. Component-draft note (21st.dev magic MCP)

The magic MCP `_inspiration` pass for timers returned generic `@ark-ui` **countdown** components that drive
the value off an internal timer/`setInterval`-style mechanism. Those were **rejected as implementations**:
they violate `CLAUDE.md` §2.2 (timers must derive from `started_at`, not elapsed counters). We kept only the
**visual vocabulary** they confirmed — segmented `HH:MM:SS` with **mono/tabular** figures and card framing —
and specified `LiveTimer` (§9.10) as a timestamp-derived primitive instead. Concrete builder output should be
generated against the `LiveTimer`/`DeviceCard` contracts here, not adopted from the countdown samples.
