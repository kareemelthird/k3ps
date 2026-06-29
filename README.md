# PS-Managment

Multi-tenant SaaS for managing **gaming cafés** (PlayStation lounges). A single platform serving many independent café businesses — each with its own branches, devices, staff, pricing, shifts, and reports — built as a monorepo. The earlier single-café app (`Pochinki`) is a **trial we learn from, not a blueprint**: we reuse genuinely sound ideas (money model, pricing math, offline sync) and build this one fresh, more advanced, and better.

## What this is

| Surface | Stack | Who uses it |
| --- | --- | --- |
| **Mobile app** | Expo / React Native (`apps/mobile`) | Counter staff and managers — run shifts, sessions, orders; offline-first |
| **Web dashboard** | Next.js (`apps/web`) | Café owners — pricing, products, staff, reports, billing |
| **Super-admin portal** | Next.js (`apps/web`) | Platform operators — tenant lifecycle, billing, guarded impersonation |
| **Shared core** | TypeScript (`packages/core`) | Pure pricing/money/time/inventory/entitlements/observability logic, no UI |
| **Backend** | Supabase — Postgres + Auth + RLS (`supabase/`) | Multi-tenant data, isolation enforced in the DB |

## Repository layout

```
PS-Managment/
  packages/core/     # pure logic: pricing engine, money (piastres), time (Cairo TZ),
                     #   inventory, outbox state machine, entitlements, Sentry scrubber
  apps/mobile/       # Expo Router app (counter / manager) — offline-first, Sentry, EAS
  apps/web/          # Next.js: owner dashboard + super-admin portal + billing
  supabase/          # migrations (0001–0012), RLS policies, edge functions, seed, pgTAP tests
  docs/              # ROADMAP, BACKLOG, specs, ADRs (docs/adr/)
  .claude/           # the AI agent "company": agents, workflows, skills, settings
  CLAUDE.md          # domain knowledge + conventions + agent-workflow contract
```

## Domain at a glance

- **Tenancy:** Tenant (café business) → Branch (location) → Devices / Staff / Shifts / Sessions.
- **Money:** integer **piastres** (100 = 1 EGP). No floating point. Ever.
- **Time:** stored UTC; computed in **Africa/Cairo**. Timers derive from timestamps, never `setInterval`.
- **Localization:** Arabic-first, RTL.
- **Pricing:** open-meter / prepaid / fixed-match, resolved by owner-configured rate rules.
- **Offline:** mobile outbox queue survives crashes; drain on reconnect; dead-letter UI for stuck entries.
- **Billing:** Stripe subscriptions (test-mode until owner supplies live keys); entitlements enforced in `@ps/core`.
- **Observability:** Sentry (DSN-gated, no-op without env var); `@ps/core/observability` scrubber enforces deny-by-default policy.

Read [`CLAUDE.md`](CLAUDE.md) before contributing (human or agent).

## Status

**All 10 phases complete.** `ps-verify` green: `tsc` 0 errors × 3 workspaces, 493 `@ps/core` Jest tests, `next build` ≤ 300 kB/route, `expo export` clean. Live pgTAP isolation suite `01–07` passing in CI.

The platform is **feature-complete** and pending the owner's hands-on test and live-account setup. See [`docs/BACKLOG.md`](docs/BACKLOG.md) for the operator action checklist (Sentry DSN, EAS build, Stripe live keys, Supabase auth hook, Realtime).

---

## Setup and running

### Prerequisites

- Node.js 20+ and npm 10+
- Supabase CLI (`npm install -g supabase`)
- Expo CLI (`npm install -g expo-cli`) — for mobile; `eas-cli` for cloud builds

### Install

```sh
# from the repo root
npm install
```

This installs all workspaces (`packages/core`, `apps/web`, `apps/mobile`) in one step.

### Environment variables

Copy `.env.example` to `.env` and fill in the values:

```sh
cp .env.example .env
```

**Client-safe (publishable — may appear in the browser/app bundle):**

| Variable | Used by | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | web | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | Supabase anonymous (public) key |
| `NEXT_PUBLIC_SENTRY_DSN` | web | Sentry DSN for error tracking (omit = Sentry off) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | web | Stripe publishable key |
| `EXPO_PUBLIC_SUPABASE_URL` | mobile | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | mobile | Supabase anonymous (public) key |
| `EXPO_PUBLIC_SENTRY_DSN` | mobile | Sentry DSN for error tracking (omit = Sentry off) |

**Server/CI-only (never bundle, never commit):**

| Variable | Used by | Description |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | edge functions, CI | Supabase service-role key — bypasses RLS; keep secret |
| `STRIPE_SECRET_KEY` | edge functions | Stripe secret key (`sk_test_…` or `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook` edge fn | Stripe webhook signing secret (`whsec_…`) |
| `SENTRY_AUTH_TOKEN` | CI / EAS build (optional) | Sentry source-map upload token; skipped when absent |

### Run the web app

```sh
# development server
cd apps/web
npm run dev       # http://localhost:3000

# production build (what ps-verify checks)
npm run build
```

### Run the mobile app

```sh
cd apps/mobile
npx expo start    # opens Expo dev tools; scan QR with Expo Go or a dev build
```

Local bundle verification (no Expo account needed):

```sh
npx expo export   # builds the JS bundle; used by CI / ps-verify
```

### Run the Supabase local stack

```sh
cd supabase
supabase start    # starts Postgres + Auth + Edge Functions locally (Docker required)
supabase db reset # applies all migrations 0001–0012 + seed.sql
```

### Run the pgTAP isolation tests

```sh
# from the supabase/ directory with the local stack running
supabase test db  # runs supabase/tests/00–07 against the local Postgres
```

The CI runs `01–07` against the local stack. `00_rls_enabled.test.sql` verifies RLS is enabled on every table. If you add a table, add a row to `00_rls_enabled` and a new isolation test.

### Run `@ps/core` unit tests

```sh
cd packages/core
npm test          # jest (ts-jest); 493 tests; target >90% line coverage
```

### Full `ps-verify` pass

```sh
# from the repo root — run all four checks
npm run verify    # or run individually:
npx tsc --noEmit  # in packages/core, apps/web, apps/mobile
cd packages/core && npm test
cd apps/web && npm run build
cd apps/mobile && npx expo export
```

A change is not done until all four pass with zero errors.

## The AI agent "company"

This project is built by a team of specialized AI agents orchestrated through a repeatable workflow:

> **spec → design → build (parallel) → test → review → agents debate → human approves**

See [`docs/AGENTS.md`](docs/AGENTS.md) for the org chart and [`.claude/workflows/`](.claude/workflows/) for the orchestration scripts. The full roadmap and per-phase delivery notes are in [`docs/ROADMAP.md`](docs/ROADMAP.md).
