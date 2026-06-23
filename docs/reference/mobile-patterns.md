# Reference: mobile architecture patterns (from Pochinki trial)

Proven RN/Expo patterns to port into `apps/mobile`. Source: `D:\K3\Pochinki\src`. Harden every write path for tenancy (carry `tenant_id`/`branch_id`).

## Offline outbox (port from `src/features/sync/`)
Public API (`outbox.ts`): `enqueue(entry)`, `flushOutbox(): {flushed,remaining,dead}`, `pendingCount()`, `getPending()`, `getDeadLetter()`, `retryDeadLetter()`, `discardDeadLetter(localId?)`. Helper `mutate.ts`: `persistRow({table, op, row})` — queue + fire-and-forget flush.
- **Idempotency:** client `uuidv4()` localId + **upsert** (not insert) so a crash mid-flush replays safely. Stamp `updated_at: nowIso()` before queueing.
- **Dead-letter:** `MAX_ATTEMPTS = 5`; on exhaustion move entry to dead list and KEEP draining (one poison write must not block the queue). `entry.attempts`/`entry.lastError` surfaced in the Sync screen for retry/discard.
- **Persistence:** AsyncStorage keys versioned (`<app>.outbox.v1`, `<app>.outbox.dead.v1`); memory cache + batched writes.
- **Triggers (`useNetworkWatcher.ts`):** never use cross-origin reachability (CORS breaks web); use `navigator.onLine`, a 20s interval, AppState foreground, and web online/offline events; flush on reconnect. `useRealtime.ts` subscribes to `devices/sessions/session_segments/orders` postgres_changes and invalidates Query caches. `usePending.ts` rehydrates the count on mount.

## State (port from `src/features/auth/`, `sync/store.ts`)
- **Zustand stores:** `useAuth` (`authSession`, `profile`, `role`, `init/signIn/signOut/refreshProfile/resetPassword`; auto sign-out when `is_active=false`); `useSync` (`online/syncing/pending/failed`); `useAppearance` (accent).
- **Permissions (`permissions.ts`):** `can(profile, key)` / `useCan(key)`; owner = all; manager keys missing = allowed, explicit `false` = denied. Gates UI only — back with RLS when it must be enforced server-side.

## Data layer (TanStack Query + outbox)
Consistent per-feature `api.ts`: flat query keys `['domain']` / `['domain', id]`; live queries use `refetchInterval: 30_000`; mutations build the row (`{id: uuidv4(), ...input, created_at, updated_at}`), call `persistRow(...)`, optimistic `onMutate`, `onSettled` invalidate. Multi-row ops (start session = session + first segment + device busy) are queued together. Closing a session computes `time_total` via `computeTimeCost(...)`, clamps discount so bill ≥ 0, records `audit_log`, invalidates shifts+reports.

## Live timers (never intervals for billing)
`useTick(intervalMs|null)` only forces re-render (pass `null` to disable on idle components). Always compute from stored `started_at`: `elapsedSeconds(session.started_at)`, cost via `liveTimeCost(...)`. Prepaid countdown = `prepaid_minutes − elapsedMinutes(started_at)`, warn near zero. A busy card ticks 1s; the grid screen refreshes 15–30s.

## Component kit (`src/components/`)
`Screen`, `AppText` (variant/weight/color), `Button`, `Card`/`GradientCard`/`GlassCard`, `TextField`, `SegmentedControl`(+`SegmentOption`), `NumberStepper`, `Badge`, `Chip`, `StatCard`, `EmptyState`, `ErrorState`, `ErrorBoundary`, `SchemaGate`, `Sheet`, `Row`, `Header`, `OfflineBanner`, `Skeleton`, `ToastHost`, `ConfirmHost`, `BarChart`, `DonutChart`, `ProgressRing`, `ProgressBar`, `Controller3D`. Every screen needs empty/loading(skeleton)/error/offline states.

## i18n & RTL (`src/i18n/`)
i18next + react-i18next, Arabic-first (`ar.json`, `lng:'ar'`, `compatibilityJSON:'v4'`). No hardcoded user strings — always `t('key')`. `toArabicDigits()` for displayed digits (business logic stays Western). Force RTL once at boot (`I18nManager.allowRTL/forceRTL(true)`); use `row-reverse`/start-end spacing, not hardcoded left/right.

## Navigation (Expo Router, role groups)
`app/(auth)`, `(manager)`, `(operate)` (owner-as-manager test mode w/ "back to admin" banner), `(owner)`. `app/index.tsx` redirects on `authSession` then `role`. Each group `_layout.tsx` guards auth+role; off-tab screens use `options={{href:null}}`. **Multi-tenant addition:** after auth, resolve active tenant/branch (from JWT claim + `tenant_members`); add a branch switcher; never render data outside the active tenant/branch. Super-admin gets a web portal (not this app).
