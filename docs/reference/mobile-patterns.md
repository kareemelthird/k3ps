# Reference: mobile architecture lessons (from the trial)

RN/Expo patterns the trial got right — a **learning input, not a blueprint**. Reuse the *sound ideas* (offline outbox concept, timestamp-derived timers, query conventions) and **build cleaner**; don't transcribe the trial. Design/UI is fresh via the `ui-ux-pro-max` skill + magic MCP (see `design-approach.md`). Harden every write path for tenancy (carry `tenant_id`/`branch_id`).

## Offline outbox (Phase 8 — rebuilt for multi-tenant, from the trial's concept)

The outbox state machine lives in `@ps/core/outbox` (pure — no React Native or Supabase imports). The mobile adapter wires persistence + flush.

Public API (`outbox.ts`): `enqueue(entry)`, `flushOutbox(): {flushed,remaining,dead}`, `pendingCount()`, `getPending()`, `getDeadLetter()`, `retryDeadLetter()`, `discardDeadLetter(localId?)`. Helper `mutate.ts`: `persistRow({table, op, row})` — queue + fire-and-forget flush.

- **Idempotency:** client `uuidv4()` localId + **upsert** (not insert) so a crash mid-flush replays safely. Stamp `updated_at: nowIso()` before queueing.
- **Dead-letter:** `MAX_ATTEMPTS = 5`; on exhaustion move entry to dead list and KEEP draining (one poison write must not block the queue). `entry.attempts`/`entry.lastError` surfaced in the Sync screen for retry/discard.
- **Persistence:** AsyncStorage keys versioned (`<app>.outbox.v1`, `<app>.outbox.dead.v1`); memory cache + batched writes. Survives force-kill + restart.
- **Dependency ordering:** multi-row ops (e.g. session start = session + first segment + device status) declare `dependsOn` on the child entries. The drain selects parents before dependents so partial flushes cannot create orphaned rows.
- **Money-discard confirmation:** discarding a dead-letter entry that contains money-affecting data (session close, order pay, void) shows a confirmation dialog before removal — the UI never silently drops a billing row.
- **Network watcher (`useNetworkWatcher.ts`):** never use cross-origin reachability probing (CORS breaks web). Use `navigator.onLine`, a 20s interval, AppState foreground, and web online/offline events; flush on reconnect.
- **Tenant scoping:** every `OutboxEntry` carries `tenant_id` and `branch_id`. The flush path verifies the active session matches before draining — a tenant-switch after a crash cannot replay another tenant's writes.

## Realtime (Phase 8)

`useRealtime.ts` subscribes to `devices`, `sessions`, `session_segments`, `orders` via Supabase `postgres_changes`. The subscription filter is **tenant-scoped** (`filter: 'tenant_id=eq.<id>'`) so the channel receives only the active tenant's changes — no cross-tenant data leaks via realtime. On receiving a change the hook invalidates the relevant TanStack Query keys; it does not merge data client-side (server is the source of truth). **Requires Realtime to be enabled and the `0009` publication applied on the hosted project** — see operator actions in `docs/BACKLOG.md`.

## Sentry observability (Phase 10 — DSN-gated, no-op without env var)

Sentry for Expo is initialized in `apps/mobile/src/observability/sentry.ts` via `initSentry()`, called once at the top of the root component module.

```ts
// apps/mobile/src/observability/sentry.ts (summary)
import * as Sentry from '@sentry/react-native';
import { scrubEvent, scrubBreadcrumb } from '@ps/core';  // the pure scrubber

export function initSentry() {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;   // no DSN → Sentry is fully off; zero overhead; CI-safe
  Sentry.init({
    dsn,
    enabled: true,
    sendDefaultPii: false,
    tracesSampleRate: 0,  // no performance tracing this phase
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  });
}
```

The root layout exports `export default Sentry.wrap(App)`. The `@sentry/react-native/expo` plugin is in `app.json` `plugins` with `url`/`org`/`project` placeholders but **no auth token** (an auth token in `app.json` would be bundled and become a secret in the binary). `metro.config.js` uses `getSentryExpoConfig` from `@sentry/react-native/expo`.

**`EXPO_PUBLIC_SENTRY_DSN`** is the publishable DSN — it is client-safe by design and may be committed to `eas.json`. **`SENTRY_AUTH_TOKEN`** (source-map upload) is server/CI-only, set as an EAS secret, never committed. If absent, source-map upload is skipped and the build still succeeds.

**The scrubber policy** is enforced by `@ps/core/observability` (see `docs/reference/core-api.md`). Sentry receives: exception type + stack frames, `tenant_id`/`role`/`release`/`environment`/`screen` tags. It never receives: JWT/session tokens, email/PII, Stripe keys, `grand_total` or money row bodies, `.env` values.

## EAS build profiles (Phase 10)

`apps/mobile/eas.json` defines three profiles: `development` (internal distribution, dev client), `preview` (internal distribution, production-like), `production` (auto-increment, app store). Each profile wires only **publishable** `EXPO_PUBLIC_*` env vars (Supabase URL, Supabase anon key, Sentry DSN). No `service_role` key, no `SENTRY_AUTH_TOKEN`, no Stripe secret appears in `eas.json`.

`runtimeVersion: { policy: "appVersion" }` in `app.json` ties OTA-update compatibility to the app version. Local `expo export` and `expo prebuild --no-install` succeed without an Expo account — that is what CI verifies. Cloud `eas build` requires the owner's Expo account and is a post-gate user step.

## List virtualization (Phase 10)

Any list that can exceed ~20 rows **must** use `FlatList` or `FlashList`, not `.map()` into a `ScrollView`. Lists checked in Phase 10: device grid, order/catalog item lists, sync dead-letter list, sessions/audit history, and any future large data list. `ScrollView` maps are only acceptable for lists with a known small upper bound (e.g., a billing plan picker with 3 options).

## State (port from `src/features/auth/`, `sync/store.ts`)
- **Zustand stores:** `useAuth` (`authSession`, `profile`, `role`, `init/signIn/signOut/refreshProfile/resetPassword`; auto sign-out when `is_active=false`); `useSync` (`online/syncing/pending/failed`); `useAppearance` (accent).
- **Permissions (`permissions.ts`):** `can(profile, key)` / `useCan(key)`; owner = all; manager keys missing = allowed, explicit `false` = denied. Gates UI only — back with RLS when it must be enforced server-side.

## Data layer (TanStack Query + outbox)
Consistent per-feature `api.ts`: flat query keys `['domain']` / `['domain', id]`; live queries use `refetchInterval: 30_000`; mutations build the row (`{id: uuidv4(), ...input, created_at, updated_at}`), call `persistRow(...)`, optimistic `onMutate`, `onSettled` invalidate. Multi-row ops (start session = session + first segment + device busy) are queued together with `dependsOn`. Closing a session goes through `close_session_tx` RPC (atomic — one transaction, one audit row).

## Live timers (never intervals for billing)
`useTick(intervalMs|null)` only forces re-render (pass `null` to disable on idle components). Always compute from stored `started_at`: `elapsedSeconds(session.started_at)`, cost via the pricing engine. Prepaid countdown = `prepaid_minutes − elapsedMinutes(started_at)`, warn near zero. A busy card ticks 1s; the grid screen refreshes 15–30s.

## Component kit (`src/components/`)
`Screen`, `AppText` (variant/weight/color), `Button`, `Card`/`GradientCard`/`GlassCard`, `TextField`, `SegmentedControl`(+`SegmentOption`), `NumberStepper`, `Badge`, `Chip`, `StatCard`, `EmptyState`, `ErrorState`, `ErrorBoundary`, `SchemaGate`, `Sheet`, `Row`, `Header`, `OfflineBanner`, `Skeleton`, `ToastHost`, `ConfirmHost`, `BarChart`, `DonutChart`, `ProgressRing`, `ProgressBar`, `Controller3D`. Every screen needs empty/loading(skeleton)/error/offline states.

## i18n & RTL (`src/i18n/`)
i18next + react-i18next, Arabic-first (`ar.json`, `lng:'ar'`, `compatibilityJSON:'v4'`). No hardcoded user strings — always `t('key')`. `toArabicDigits()` for displayed digits (business logic stays Western). Force RTL once at boot (`I18nManager.allowRTL/forceRTL(true)`); use `row-reverse`/start-end spacing, not hardcoded left/right.

## Accessibility (`accessibilityLabel`, touch targets — Phase 10)
Every interactive element that is not a standard labelled button carries `accessibilityLabel` (from i18n) and `accessibilityRole`. Touch targets are at least 44×44 pt (the iOS/Android recommendation for reliable activation). Extra scrutiny applies to safety-critical surfaces: the sync dead-letter discard confirm (money), the session close summary, and the impersonation banner (must be announced/unmistakable by screen readers).

## Navigation (Expo Router, role groups)
`app/(auth)`, `(manager)`, `(operate)` (owner-as-manager test mode w/ "back to admin" banner), `(owner)`. `app/index.tsx` redirects on `authSession` then `role`. Each group `_layout.tsx` guards auth+role; off-tab screens use `options={{href:null}}`. **Multi-tenant addition:** after auth, resolve active tenant/branch (from JWT claim + `tenant_members`); add a branch switcher; never render data outside the active tenant/branch. Super-admin gets a web portal (not this app).
