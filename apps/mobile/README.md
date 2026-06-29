# apps/mobile

Expo / React Native app for **counter staff and managers**: live device grid, start/close sessions (open-meter / prepaid / fixed-match pricing), take orders, walk-in sales, stock management, open/close shifts with cash reconciliation. **Offline-first** — all writes go through a durable outbox queue that survives crashes and syncs on reconnect.

## What's in here

```
apps/mobile/
  app/                  # Expo Router: (auth)/, (operate)/, (owner)/
  src/
    components/         # shared UI components (Sheet, ConfirmDialog, SyncCenterSheet, …)
    i18n/               # Arabic-first strings (ar.json); i18next + react-i18next
    observability/      # sentry.ts — DSN-gated Sentry init + core-scrubber bridge
    stores/             # Zustand: useAuth, useSync, useAppearance
    api/                # per-feature TanStack Query + persistRow (outbox bridge)
  eas.json              # EAS build profiles (development / preview / production)
```

The `mobile-engineer` agent owns this app; it consumes `@ps/core` for all pricing/money/time/outbox/entitlements logic. No money math or billing logic lives here — only in core.

## Conventions

- **Arabic-first, RTL** — all displayed strings from `src/i18n/ar.json`; `toArabicDigits()` for money/counts.
- **Integer piastres** — 100 piastres = 1 EGP; no floats; `formatEgp()` from `@ps/core`.
- **Timers from timestamps** — never `setInterval` for billing; always `elapsedSeconds(session.started_at)`.
- **Every mutation through `persistRow`** — the outbox queue; optimistic update + TanStack Query invalidation on settle.
- **Virtualized lists** — any list >~20 rows uses `FlatList`/`FlashList`, not `.map()` into a `ScrollView`.

See root [`CLAUDE.md`](../../CLAUDE.md) for the full non-negotiable rules.

## Running locally

Install from the repo root first:

```sh
# repo root
npm install
```

Start the Expo dev server:

```sh
cd apps/mobile
npx expo start
```

Scan the QR code with Expo Go (development) or a dev build. For a dev build you need an EAS account; see the EAS section below.

### Environment variables

Create `.env` in the repo root (not in `apps/mobile/`) from `.env.example`:

```
EXPO_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
EXPO_PUBLIC_SENTRY_DSN=          # leave empty → Sentry is fully off (no overhead)
```

`EXPO_PUBLIC_*` variables are publishable/client-safe. They may appear in the JS bundle. Never set `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, or `SENTRY_AUTH_TOKEN` as `EXPO_PUBLIC_*` — these are server/CI-only.

### Verify the bundle (no Expo account needed)

```sh
npx expo export   # builds the JS bundle; runs in CI; no account required
```

This is what `ps-verify` checks. It must succeed before any change is merged.

## EAS build profiles

`eas.json` defines three profiles. Cloud builds require an Expo account (post-gate owner step):

| Profile | Distribution | Sentry DSN | Notes |
|---|---|---|---|
| `development` | Internal (dev client) | empty → off | `developmentClient: true` |
| `preview` | Internal | fill in for smoke testing | Production-like build |
| `production` | App store | required | `autoIncrement: true` |

Each profile sets only publishable `EXPO_PUBLIC_*` env vars. `SENTRY_AUTH_TOKEN` (source-map upload) is supplied as an EAS secret — never in `eas.json`.

To run a cloud build (owner step, not in CI):

```sh
eas login
eas build:configure   # generates credentials
eas build --profile production --platform android
eas build --profile production --platform ios
```

## Sentry observability

Sentry is initialized in `src/observability/sentry.ts`. It is a **no-op when `EXPO_PUBLIC_SENTRY_DSN` is absent** — zero overhead, zero console noise, CI-safe. When a DSN is provided, it captures unhandled JS errors and promise rejections. All events pass through the `@ps/core/observability` scrubber before being sent (see `docs/reference/core-api.md` for the policy).

## Running the pgTAP tests

The mobile app depends on the Supabase backend. Run the full isolation test suite from the `supabase/` directory:

```sh
cd supabase
supabase start
supabase db reset
supabase test db   # runs tests/00–07
```
