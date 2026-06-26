# Feature design — Phase 8: Offline sync-status UX (mobile)

> Tokens, type, spacing, motion, RTL, a11y, and the shared primitives all come from
> **`docs/design/design-system.md`** ("Calm Operations" — dark-first, low-chroma, teal accent). This doc
> specifies only the **sync-resilience surfaces** Phase 8 adds to `apps/mobile` (Expo / React Native — the
> counter operator app), their composition, component contracts, the four states, and the i18n/RTL/a11y
> rules. It never re-derives a token or a rule; where a value appears it cites the system token.
>
> - **Surface:** `apps/mobile` only. Web stays online-only (spec §3 out-of-scope); no new web surface.
> - **Spec:** `docs/specs/phase-8-offline-first-hardening.md` — design serves §3.9 (sync-status UI),
>   §3.7 (dead-letter handling), §6 Block G (AC 28–30), Block H (AC 31–32), and the §7 UX-designer asks
>   (glanceable indicator + detail screen + dead-letter alarm + all-clear at shift close).
> - **References:** `CLAUDE.md` §2.6 (Arabic-first RTL, Arabic-Indic numerals), §2.8 (idempotent durable
>   writes — what the UI reports on), `docs/reference/mobile-patterns.md` (offline-outbox), the existing
>   `OfflineBanner` (§9.9), `StatusPill` (§9.2), `Sheet` (§9.3), `ConfirmDialog` (§9.8), `useSync` store,
>   and `apps/mobile/src/lib/outbox.ts` (the queue this UI surfaces).
> - **Continuity:** this **extends** the Phase 3–5 mobile patterns. It does **not** add a bottom-nav tab
>   (bottom-nav stays at 4: Devices / Orders / Stock / Shift, `bottom-nav-limit`). The sync surfaces live in
>   the **header chip + an attention banner + a bottom-sheet Sync Center**, all composed from existing
>   primitives.

---

## 1. The problem this UI solves (counter trust)

The mobile app is the till. Phase 8 makes every write durable through a crash-safe outbox; this design makes
the queue's state **legible and trustworthy** to a counter operator who can never stop to think about
"networking". The whole UX rests on three promises:

1. **Reassuring, not noisy.** When everything is fine the indicator is calm and almost silent — a small
   "synced" chip. Counter-speed means it must never block, modal, or interrupt a sale.
2. **A failed money write is impossible to miss — but not panic-inducing.** A dead-letter raises a persistent
   *attention* surface (calm danger tone, plain-Arabic cause, one clear action), never a flashing alarm.
3. **"Did everything sync?" is answerable in one glance** — the all-clear state (pending = 0, failed = 0,
   recent last-synced) lets a manager confirm before counting the drawer at shift close (AC 30).

The state machine the UI renders (derived from `useSync` + the outbox) has **four operator-facing states**:

| Sync state | Meaning | Chip tone | Source |
|---|---|---|---|
| `synced` | online, queue empty, recent flush | `status-free` green, calm | `online && pending==0 && failed==0` |
| `syncing` | online, draining N pending | `primary` teal + spinner | `online && syncing && pending>0` |
| `offline` | no connection, N queued | `warning` amber | `!online` |
| `attention` | ≥1 dead-lettered write (online or off) | `danger` red | `failed>0` (overrides all) |

`attention` always wins (a failed money write outranks "offline" or "syncing" — it is the one state that
needs a human). `offline` outranks `syncing`/`synced`.

---

## 2. Where the sync UI lives (information architecture)

Three layers, increasing in weight, so the operator gets exactly as much as the situation demands
(`progressive-disclosure`, `content-priority`):

```
Layer 1  SyncStatusChip      — persistent, in every (operate) tab header (end side). Glanceable, tappable.
Layer 2  OfflineBanner       — existing persistent banner; re-enabled with pending count (offline only).
         SyncAttentionBanner — NEW persistent banner; appears ONLY when failed>0 (the dead-letter alarm).
Layer 3  SyncCenterSheet     — the detail view, opened by tapping the chip or either banner.
                               Status summary + Pending list + Failed (dead-letter) list + actions.
```

**Why a header chip, not a tab or a tab-bar badge:** the four operate tabs are all primary destinations
(`bottom-nav-top-level`); sync is a *cross-cutting status*, not a destination, so it belongs in the persistent
header that every tab already renders (design-system §9.13 reserved a "sync dot + count" slot there). A
bottom-tab badge would either duplicate this or push us to a 5th tab for a non-destination. The chip is the
single source; the two banners escalate it when the situation is non-calm.

**Header placement (RTL):** identity (branch name) stays at the **start**; the `SyncStatusChip` sits at the
**end** of the header row, before the existing sign-out/actions, with ≥ 8px spacing (system §6, `touch-spacing`).
On every `(operate)` screen the header composes the same chip — devices, orders, stock, shift.

---

## 3. Component contracts

### 3.1 `SyncStatusChip` (NEW — Layer 1, the glanceable indicator)

A compact, tappable pill that renders the current sync state and opens the Sync Center. Replaces the
placeholder "sync dot + count" reserved in `AppScaffold` (design-system §9.13). Built on the visual grammar
of `StatusPill` (§9.2: dot + label on a `${color}1A` tint) plus a state icon and optional count.

- **Props:** `state('synced'|'syncing'|'offline'|'attention')`, `pendingCount`, `failedCount`,
  `onPress` (opens Sync Center), `compact?` (icon-only when header is tight — keeps `accessibilityLabel`).
- **Renders by state:**
  - `synced` — `cloud-check` icon + `status-free` dot, label `t('sync.status.synced')`; no count. Calmest form.
  - `syncing` — `refresh` icon spinning (220ms loop, reduced-motion → static icon) + `primary` tint, label
    `t('sync.pending', { count })` rendering the count Arabic-Indic.
  - `offline` — `cloud-off` icon + `warning` tint, label `t('sync.status.offline')` + count if `pending>0`.
  - `attention` — `alert-triangle` icon + `danger` tint, label `t('sync.pending.failed', { count: failedCount })`.
    A single non-animated emphasis (filled tint, not a flashing pulse) — unmissable, not alarming
    (`color-not-only`, reduced-motion-safe).
- **States (intrinsic):** default · pressed (opacity .92 / scale .97 < 100ms, `scale-feedback`). Never
  disabled — it is always tappable so the operator can always reach the Center.
- **RTL/a11y:** icon + dot at the **start** of the chip; the directional icons here (`cloud`/`alert`) are
  **not** directional so they are **not mirrored** (system §6). Tap target ≥ 52 (expand with `hitSlop` since
  the chip is visually small). `accessibilityLabel` is a full sentence per state, e.g.
  `t('sync.a11y.syncing', { count })` → "تتم مزامنة ٣ تغييرات"; `accessibilityRole='button'`,
  `accessibilityHint = t('sync.a11y.openCenter')`. Count + any time render Arabic-Indic via `toArabicDigits`.

### 3.2 `OfflineBanner` (EXTEND — Layer 2, existing primitive)

The existing component (`apps/mobile/src/components/OfflineBanner.tsx`) currently shows a bare "offline" label
because the outbox was stubbed in Phase 3. Phase 8 **re-enables the pending-count wiring** it was designed for
(design-system §9.9: "shows pending-write count and reconnect status").

- **Props (added):** `pendingCount` (from `useSync`), `onPress?` (opens Sync Center).
- **Renders:** when `!online` → `warning` bar, `cloud-off` icon (start) + `t('sync.offline.queued', { count })`
  ("غير متصل — ٣ تغييرات بانتظار المزامنة"); the whole bar is tappable to open the Center. When count is 0,
  the bar reads `t('sync.offline.idle')` ("غير متصل — لا تغييرات معلّقة").
- **Visibility:** only when `!online` (unchanged). It does **not** show the `attention` state — that is the
  separate banner below, so the two concerns never collapse into one ambiguous bar.
- **RTL/a11y:** `accessibilityRole='alert'` (already present), `aria-live`-equivalent announce on appear;
  count Arabic-Indic; icon not mirrored; min height 52 when tappable.

### 3.3 `SyncAttentionBanner` (NEW — Layer 2, the dead-letter alarm)

The safety-critical surface. Appears **only when `failedCount > 0`**, persistently, on every operate screen,
**below** the header (and below the OfflineBanner if both show). It is the one place a permanently-failed
money write becomes unmissable (spec §3.7, AC 24).

- **Props:** `failedCount`, `onReview` (opens Sync Center → Failed section).
- **Renders:** a `danger`-toned bar (filled tint `${danger}1A` with a 1px `danger` start-edge accent, **not**
  a full-saturation slab — calm but serious; reserved full-saturation is only the impersonation banner,
  system §2.4). `alert-triangle` icon (start) + two lines: title `t('sync.attention.title')`
  ("‏تغييرات لم تُحفظ تحتاج مراجعتك") + body `t('sync.attention.body', { count })`
  ("‏٢ عملية فشلت ولم تُرسل — راجعها قبل إنهاء الوردية"). A `secondary`/`ghost` **Review** button at the **end**
  (`t('sync.attention.review')`).
- **Tone rule:** **never flashes or pulses** (`reduced-motion`, anti-panic); it is static and persistent
  until the operator resolves the dead-letter. It does not block interaction (`no-blocking-animation`) — the
  operator can keep working while it stays visible.
- **RTL/a11y:** `accessibilityRole='alert'`, announced once on appear (`aria-live` polite, does not steal
  focus, `toast-accessibility`); title + body align **start**; Review at **end**; count Arabic-Indic; icon
  not mirrored; the Review control is ≥ 52.

### 3.4 `SyncCenterSheet` (NEW — Layer 3, the detail view)

The full picture. A bottom `Sheet` (§9.3, top corners `radius.lg`, slides up, scrim `scrim`, max-height 92%,
safe-area bottom padding) rather than a new route/tab — it keeps the operator's place and matches the
established start/close/add sheets. Opened from the chip or either banner.

**Composition (top → bottom):**

1. **Status summary header** (`SyncSummaryHeader`, see §3.5) — connectivity, last-synced, pending + failed
   counts, and the global **Retry all** / **Sync now** action.
2. **Failed (dead-letter) section** — shown **first** when `failedCount > 0` (it needs attention before
   anything else): section title `t('sync.center.failed.title')` + a list of `QueueEntryRow` in `failed`
   variant, each with per-row **Retry** and **Discard**, plus section actions **Retry all failed** /
   **Discard all** (the latter requires the money-aware confirm, §3.7).
3. **Pending section** — section title `t('sync.center.pending.title')` + a list of `QueueEntryRow` in
   `pending`/`syncing` variant (read-mostly; the queue drains itself — no per-row action needed, only the
   global Sync-now).

- **Props:** `visible`, `onClose`, `state`, `pending: QueueEntry[]`, `failed: QueueEntry[]`, `lastSyncedAt`,
  `online`, `syncing`, `onSyncNow()`, `onRetry(localId)`, `onRetryAllFailed()`, `onDiscard(localId)`,
  `onDiscardAll()`.
- **`QueueEntry` view-model** (mapped by the screen from `OutboxEntry`, not the raw row):
  `{ localId, actionKey, entityLabel, ageIso, attempts?, errorClass?, isMoney }` — see §3.6.
- **RTL/a11y:** title row start-aligned, close (`x`) at **end**; focus trapped, Esc / drag-down closes,
  focus returns to the chip (`escape-routes`); section headings are `h3`; lists virtualize at 50+ rows
  (`virtualize-lists`).

### 3.5 `SyncSummaryHeader` (NEW — inside the Center)

The one-glance answer to "is everything synced?".

- **Renders:** a connectivity row (`StatusPill`-style dot + `t('sync.status.<state>')`); a **last-synced**
  line `t('sync.lastSynced', { time })` using a relative-time string (§7) — or `t('sync.lastSynced.never')`
  when nothing has flushed yet; two count chips: pending (`info`/`text-muted`) and failed (`danger`, hidden
  when 0); and the primary action button: **Sync now** (`t('sync.action.syncNow')`) when there is pending
  work and the device is online, showing an inline spinner while `syncing` (`loading-buttons`); disabled with
  `t('sync.action.offline')` helper when offline.
- **All-clear form (AC 30):** when `pending==0 && failed==0`, the header collapses to a calm confirmation —
  `check-circle` in `status-free` + `t('sync.allClear.title')` ("كل التغييرات متزامنة") +
  `t('sync.allClear.body', { time })` ("آخر مزامنة قبل لحظات"). This is the explicit "safe to count the
  drawer" signal.
- **RTL/a11y:** counts + time Arabic-Indic; the Sync-now button is the single primary in the sheet; dot +
  label never color-alone.

### 3.6 `QueueEntryRow` (NEW — one queued/failed mutation)

A human-readable row for a single outbox entry. Built on `RowList` row conventions (§9.7) + a `StatusPill`.
This is where a raw mutation (`{table:'sessions', op:'upsert', ...}`) becomes plain Arabic
("‏إنهاء جلسة — PS5 رقم ٣").

- **Props:** `entry: QueueEntry`, `variant('pending'|'syncing'|'failed')`, `onRetry?`, `onDiscard?`.
- **Renders:**
  - **Leading:** an entity/action icon (per `actionKey`, §6) + a per-state `StatusPill`
    (`pending` = `info` "بالانتظار", `syncing` = `primary` "تتم المزامنة", `failed` = `danger` "فشل").
  - **Title:** `t('sync.entry.action.<actionKey>')` + the entity label (device/order/product/shift name) —
    e.g. `t('sync.entry.action.sessionClose')` → "‏إنهاء جلسة" then "— PS5 رقم ٣". A small **money tag**
    (`coins` icon) when `isMoney` so the operator sees which rows carry money (`color-not-only`: icon + the
    danger emphasis, not color alone).
  - **Meta:** age `t('sync.entry.age', { time })` (Arabic-Indic relative); for `failed` rows also
    `t('sync.entry.attempts', { count })` and a **plain-Arabic reason** mapped from the error class
    (`sync.error.class.*`, §3.8) — never a raw server/stack string.
  - **Actions (failed only):** **Retry** (`rotate-ccw`, `ghost`) at the end; **Discard** (`trash`, `danger`
    ghost) — discard triggers the confirm (§3.7). Pending/syncing rows have **no** per-row action (the queue
    drains itself; only the global Sync-now applies).
- **States:** the row itself is the unit; the list's empty/loading/error are the Center's states (§4).
- **RTL/a11y:** icon + pill at **start**; actions in an **end**-anchored cluster; ≥ 52 row height; each action
  labeled (`aria-labels`); `accessibilityLabel` composes action + entity + state + (failed) reason so a screen
  reader announces the whole row without relying on the pill color.

### 3.7 Discard confirmation (money-aware) — `ConfirmDialog` (§9.8)

Discarding a dead-letter can drop a money-bearing write, so it is gated (spec AC 23, `confirmation-dialogs`,
`destructive-emphasis`).

- **Money entry** (`isMoney`): `ConfirmDialog` with `danger` confirm — title `t('sync.discard.money.title')`,
  consequence sentence `t('sync.discard.money.body')` ("‏ستُحذف عملية ماليّة لم تُسجَّل — لا يمكن التراجع.
  تأكّد أنك سجّلتها يدويًا."), cancel (start) / **Discard** (end, `danger`). No silent drop, ever.
- **Non-money entry** (e.g. a `device.status` flip): a lighter confirm
  (`t('sync.discard.title')` / `t('sync.discard.body')`), still explicit.
- **Discard all:** always the money-aware variant (`t('sync.discard.all.body')`) since the batch may contain
  money rows; lists the count.
- **Retry** needs **no** confirm (it is non-destructive — re-queues and flushes; AC 22).

---

## 4. The four required states (the Sync Center)

Per design-system §8, the Center specifies all four. (The chip + banners are status atoms; their "states"
are the four sync states in §1.)

| State | Sync Center contract |
|---|---|
| **Empty (all-clear)** | `pending==0 && failed==0` → the `SyncSummaryHeader` all-clear form (§3.5): `check-circle` + "كل التغييرات متزامنة" + last-synced time. Both list sections are hidden (no empty list boxes). This is the AC-30 "safe to count" state — an intentional, reassuring empty, never a blank panel. |
| **Loading** | On first open before the durable queue rehydrates (> 300ms) → 2–3 `QueueEntryRow` **skeletons** matching row height (shimmer, reserves space, CLS < 0.1). Counts in the header show skeleton chips, not "0" (avoid a false all-clear flash). |
| **Error** | The Center reads local durable storage, so a *load* error is rare; if the store read fails → an inline `ErrorState` in the sheet body with **Retry** (re-read). A failed **Sync-now** does not error the sheet — it surfaces per-entry in the Failed list (that is the design). |
| **Offline** | Center fully usable offline (it reads local state). Header shows `offline`; **Sync-now** disabled with `t('sync.action.offline')`; Retry/Discard on dead-letters still work (retry re-queues for the next online drain; discard is local). The OfflineBanner remains visible behind the sheet. |

---

## 5. Offline affordances on the existing flows (trust the action stuck)

The operator must *feel* that an action taken offline was accepted. Every optimistic write gets a calm
"queued" cue so it never looks dropped (spec §3.9 offline affordances; extends Phase 3 §M3 "pending marker").

- **Shared marker — `PendingTag`** (NEW, tiny): a `caption` pill, `info`/`text-muted` tint, `clock` icon +
  `t('sync.pending.marker')` ("بانتظار المزامنة"). Reuses `StatusPill` grammar; not a new color. It overlays
  optimistically-created/changed items until the entry flushes (then it disappears via realtime/refetch).
- **Devices grid (`devices.tsx`):** a card whose start/close/switch is still queued shows the `PendingTag` at
  the card's **end** corner. The card already flips state optimistically (Phase 3); the tag adds the "not yet
  synced" truth. On flush the tag clears.
- **Start / Switch / Close sheets:** keep the existing `t('offline.willSync')` note (already in `ar.json`) in
  the sheet footer while offline, next to the confirm. Confirm stays enabled offline (optimistic + queued).
- **Orders:** a queued add/pay/void shows the `PendingTag` on the affected order/line row; pay-while-offline
  keeps the optimistic "paid" state with the tag until flush.
- **Stock:** a queued restock/adjust/sale shows the `PendingTag` on the item row; the on-hand updates
  optimistically.
- **Shift close (AC 30 — the critical confirm point):** the close-shift screen gains a **sync gate**: above
  the "Close shift" confirm, render a `SyncSummaryHeader`-derived strip — green all-clear → proceed calmly;
  pending → `t('sync.shift.pending')` ("‏بعض التغييرات لم تتم مزامنتها بعد") with a **Sync now** affordance;
  failed → a `danger` `t('sync.shift.attention')` warning steering the operator to resolve dead-letters before
  closing. The close is **not hard-blocked** (the operator may still need to close), but the state is explicit
  so they count the drawer against synced totals.

---

## 6. Action → human-readable mapping (the i18n action table)

The outbox carries `{table, op}`; the UI must render a person-friendly action. The screen maps each rerouted
mutation (spec §3.3) to a stable `actionKey` + icon. **This table is binding** so every queued write reads in
plain Arabic (never a table name).

| `actionKey` | Mutation (table/op) | i18n key | Icon (Lucide) | `isMoney` |
|---|---|---|---|---|
| `sessionStart` | session + first segment + device→busy | `sync.entry.action.sessionStart` | `play` | no |
| `sessionSwitch` | segment close + new segment | `sync.entry.action.sessionSwitch` | `repeat` | no |
| `sessionClose` | segments + session update + stock + device→free + audit | `sync.entry.action.sessionClose` | `square` (stop) | **yes** |
| `orderAdd` | order + order_items | `sync.entry.action.orderAdd` | `plus-circle` | no |
| `orderPay` | order paid + audit | `sync.entry.action.orderPay` | `wallet` | **yes** |
| `orderVoid` | order_item void + stock reverse + audit | `sync.entry.action.orderVoid` | `x-circle` | **yes** |
| `stockRestock` | stock_movement (restock) | `sync.entry.action.stockRestock` | `package-plus` | no |
| `stockAdjust` | stock_movement (adjust) + audit | `sync.entry.action.stockAdjust` | `sliders` | no |
| `stockSale` | stock_movement (sale) | `sync.entry.action.stockSale` | `shopping-cart` | **yes** |
| `shiftOpen` | shift open | `sync.entry.action.shiftOpen` | `log-in` | no |
| `shiftClose` | shift close + audit | `sync.entry.action.shiftClose` | `log-out` | **yes** |
| `deviceStatus` | device status flip (e.g. maintenance) | `sync.entry.action.deviceStatus` | `monitor` | no |

The entity label (device/order/product/shift name) is resolved by the screen from the entry payload + cache;
when unresolvable offline it falls back to a short id wrapped for direction-isolation (system §6 mixed
content), never breaking the Arabic layout.

---

## 7. Numerals, money & relative time (binding)

- **Counts** (pending, failed, attempts) render **Arabic-Indic** via `toArabicDigits` (`@ps/core`), through
  i18n interpolation (`{{count}}`), tabular where they sit in the chip so width doesn't jump
  (`number-tabular`). No Western digits in any sync surface.
- **Money tags** never show an amount in the queue rows (the row reports *which* action, not a recomputed
  total — money math stays in `@ps/core`, frozen before enqueue, spec §5 §2.1). If a row ever surfaces an
  amount it must be `formatEgp` only.
- **Relative "last-synced" / entry age:** needs a small formatter. Prefer a pure `@ps/core` helper
  `formatRelativeTime(fromIso, nowIso, 'ar')` returning bucketed Arabic strings (just now / N min / N hr /
  date) with Arabic-Indic digits — keeps `@ps/core` pure (timestamps passed in, no internal clock,
  `CLAUDE.md` §2.4). **If** the architect declines a new core helper, the UI composes from existing
  `formatTime` + i18n bucket keys (`sync.time.justNow` / `minutesAgo` / `hoursAgo`). Flagged for the core
  engineer; not a blocker for this design.

---

## 8. Motion (calm, reduced-motion-safe)

- **Chip `syncing` spinner:** a single rotating `refresh` icon, `duration.base` loop, `transform` only
  (`transform-performance`); **reduced-motion → static icon** (state still legible by icon + label + color).
- **State transitions** (synced ↔ syncing ↔ offline ↔ attention): crossfade the chip label/icon
  (`fade-crossfade`, `duration.fast`); the chip tint animates color only, never layout (tabular count
  reserves width so the chip doesn't resize as the number changes).
- **Banners** slide in from the top edge (`modal-motion`/`hierarchy-motion`), exit ~65% faster
  (`exit-faster-than-enter`); the `SyncAttentionBanner` does **not** pulse or flash (anti-panic; persistent
  static emphasis is enough).
- **Sync Center sheet:** standard `Sheet` motion (§9.3, slides up from trigger, interruptible).
- **List entry resolve:** when a pending row flushes and leaves the list, a quick fade-out
  (`opacity-threshold`); staggered list entrance 30–50ms; all disabled under `prefers-reduced-motion`.

---

## 9. Accessibility (binding, gates review)

- **Status never by color alone** (`color-not-only`): every sync state carries an **icon + label + color**
  (chip, banners, pills). The `attention` state adds a fourth redundancy (the persistent banner + the money
  `coins` icon on money rows).
- **Touch targets ≥ 52** on the chip (via `hitSlop`), banner Review button, and every Retry/Discard control;
  ≥ 8px spacing (`touch-target-size`, `touch-spacing`).
- **Announcements:** banners use `accessibilityRole='alert'` and announce on appear without stealing focus
  (`toast-accessibility`, `aria-live-errors`); the chip is `accessibilityRole='button'` with a full-sentence
  label + hint.
- **Reduced motion:** spinner, banner slide, list stagger, skeleton shimmer all disable; every state stays
  legible immediately (`reduced-motion`).
- **Focus:** opening the Center traps focus and returns it to the chip on close (`escape-routes`); the
  Discard confirm auto-focuses Cancel (safe default for a destructive money action).
- **Screen-reader reasons:** dead-letter rows announce the **plain-Arabic** reason (`sync.error.class.*`),
  never a raw error string.

---

## 10. RTL (binding, `rtl-i18n-check` covers Phase 8)

- Header chip at the layout **end**, identity at **start** — via logical start/end, never hardcoded
  left/right (system §6). The chip's internal icon/dot sits at the chip's **start**.
- Banner icon + text at **start**; the Review/action cluster at **end**.
- `QueueEntryRow`: icon + pill at **start**, action buttons at **end**.
- **Non-directional icons** (`cloud-off`, `cloud-check`, `refresh`, `alert-triangle`, `check-circle`, `clock`,
  `coins`) are **not mirrored**; only inherently directional glyphs (e.g. a back chevron in the sheet) mirror.
- All counts/times Arabic-Indic; Latin entity ids isolated so they don't flip the Arabic line (system §6).
- Every string is an i18n key — **no hardcoded Arabic** anywhere in the sync surfaces (`CLAUDE.md` §2.6).

---

## 11. New tokens, icons & store fields

### 11.1 Tokens — **no new color hex** (reuse existing semantics)

The sync UI maps onto existing semantic tokens — this keeps the brand tight and avoids palette drift:

| Sync concept | Existing token | Note |
|---|---|---|
| `synced` / all-clear | `status-free` (`#10B981`) | same green as device-available "all good" |
| `syncing` / in-progress | `primary` teal (`#14B8A6`) | the "active work" accent (matches CTA semantics) |
| `offline` / queued | `warning` amber (`#F59E0B`) | matches the existing OfflineBanner |
| `pending` (queued, calm) | `info` blue (`#3B82F6`) / `text-muted` | non-alarming "waiting" |
| `attention` / failed / discard | `danger` red (`#EF4444`) | the one state needing a human |

If engineering wants named aliases for clarity, add **semantic aliases only** (pointing at the above), e.g.
`sync-synced → status-free`, `sync-progress → primary`, `sync-queued → info`, `sync-offline → warning`,
`sync-failed → danger`. No new primitive hue. (Recorded so the token contract stays the source of truth.)

### 11.2 Icons — **new dependency note**

The app currently uses a text glyph (`✓`) and no vector icon set. The sync UI needs a consistent vector
family (design-system §4 / `no-emoji-icons` — never emoji). **Recommend `lucide-react-native`** (or
`@expo/vector-icons` Lucide set): one stroke width, themeable, RTL-safe. Icons used (all 1.5–2px stroke,
sized via an `icon-md` 24 / `icon-sm` 16 token): `cloud-check`, `cloud-off`, `refresh`/`refresh-cw`,
`alert-triangle`, `check-circle`, `clock`, `coins`, `rotate-ccw`, `trash-2`, plus the action icons in §6
(`play`, `repeat`, `square`, `plus-circle`, `wallet`, `x-circle`, `package-plus`, `sliders`, `shopping-cart`,
`log-in`, `log-out`, `monitor`). Flagged for the mobile engineer + a one-line ADR/dep note; the choice of
package is an engineering call, the *requirement* is a single consistent vector set.

### 11.3 `useSync` store — **new fields**

The current store (`apps/mobile/src/stores/useSync.ts`) has `online/syncing/pendingCount/failedCount`.
Add (so the UI can render last-synced + derive the chip state):

- `lastSyncedAt: string | null` + `setLastSyncedAt(iso)` — stamped after a successful flush; rehydrated on
  app start from durable storage alongside the counts (spec §3.2).
- A derived `syncState()` selector (or computed in the chip) returning the §1 four-state value from
  `online/syncing/pendingCount/failedCount` with the precedence `attention > offline > syncing > synced`.

---

## 12. i18n key inventory (Phase 8 — keys only; strings live in `ar.json`)

Extends the existing `sync.*` / `offline.*` namespaces (some already present: `sync.pending`, `sync.online`,
`sync.offline`, `offline.queued`, `offline.willSync`).

```
# chip + state labels
sync.status.synced · sync.status.syncing · sync.status.offline · sync.status.attention
sync.pending           (exists; "{{count}} في الانتظار")
sync.pending.failed    ("{{count}} فشلت")
sync.offline.queued    ("غير متصل — {{count}} تغييرات بانتظار المزامنة")
sync.offline.idle      ("غير متصل — لا تغييرات معلّقة")

# attention banner (dead-letter alarm)
sync.attention.title · sync.attention.body · sync.attention.review

# sync center
sync.center.title
sync.center.pending.title · sync.center.failed.title
sync.allClear.title · sync.allClear.body
sync.lastSynced ("آخر مزامنة {{time}}") · sync.lastSynced.never
sync.action.syncNow · sync.action.offline · sync.action.retryAll · sync.action.discardAll

# queue entry row
sync.entry.age ("منذ {{time}}") · sync.entry.attempts ("{{count}} محاولات")
sync.entry.money ("عملية ماليّة")
sync.entry.action.sessionStart · sync.entry.action.sessionSwitch · sync.entry.action.sessionClose
sync.entry.action.orderAdd · sync.entry.action.orderPay · sync.entry.action.orderVoid
sync.entry.action.stockRestock · sync.entry.action.stockAdjust · sync.entry.action.stockSale
sync.entry.action.shiftOpen · sync.entry.action.shiftClose · sync.entry.action.deviceStatus
sync.entry.state.pending · sync.entry.state.syncing · sync.entry.state.failed

# row actions + discard confirms
sync.action.retry · sync.action.discard
sync.discard.title · sync.discard.body
sync.discard.money.title · sync.discard.money.body
sync.discard.all.title · sync.discard.all.body

# plain-Arabic failure reasons (mapped from the outbox error class)
sync.error.class.network · sync.error.class.conflict · sync.error.class.rejected
sync.error.class.validation · sync.error.class.auth · sync.error.class.unknown

# offline affordances on flows
sync.pending.marker     ("بانتظار المزامنة")
offline.willSync        (exists)
sync.shift.pending · sync.shift.attention · sync.shift.allClear

# relative-time buckets (only if no @ps/core helper — §7)
sync.time.justNow · sync.time.minutesAgo · sync.time.hoursAgo · sync.time.daysAgo

# a11y sentences
sync.a11y.synced · sync.a11y.syncing · sync.a11y.offline · sync.a11y.attention · sync.a11y.openCenter
```

---

## 13. Component summary (what engineering builds vs reuses)

| Component | New / Reuse | Built on |
|---|---|---|
| `SyncStatusChip` | **NEW** | `StatusPill` grammar + state icon + `useSync` (§3.1) |
| `OfflineBanner` | **EXTEND** | existing §9.9 — re-wire `pendingCount` + tap-to-open (§3.2) |
| `SyncAttentionBanner` | **NEW** | banner pattern + `danger` tint + Review action (§3.3) |
| `SyncCenterSheet` | **NEW** | existing `Sheet` (§9.3) (§3.4) |
| `SyncSummaryHeader` | **NEW** | `StatusPill` + `Button` (§3.5) |
| `QueueEntryRow` | **NEW** | `RowList` row + `StatusPill` + icons (§3.6) |
| `PendingTag` | **NEW** | tiny `StatusPill`-style marker for optimistic flow items (§5) |
| Discard `ConfirmDialog` | **REUSE** | existing §9.8, money-aware copy (§3.7) |
| `Skeleton` / `EmptyState` / `ErrorState` | **REUSE** | §9.9 for the Center's four states (§4) |

All compose against `docs/design/design-system.md` tokens and the Phase 3–5 mobile primitives; no token or
rule is re-derived here.

---

## 14. What Phase 8 deliberately does **not** do (UX scope guard)

- **No 5th bottom-nav tab** for sync (status is cross-cutting, not a destination — §2).
- **No interactive conflict-merge UI** (spec out-of-scope §3.10 is automatic; the UI only *reports*).
- **No web sync UI** (web stays online-only; this is mobile-only).
- **No flashing/alarm motion** for the dead-letter state (persistent static emphasis is the deliberate
  anti-panic choice — §3.3, §8).
- **No amount recomputation** in queue rows (money is frozen pre-enqueue; the row reports the action, not a
  total — §7).
