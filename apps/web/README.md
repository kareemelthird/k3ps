# apps/web

Next.js (App Router) web application with two surfaces:

- **Owner dashboard** (`/dashboard`) — pricing/rate-rule editor, product catalog, KPI reports, CSV export, billing (Stripe-powered subscription management).
- **Super-admin portal** (`/admin`) — tenant lifecycle (provision/suspend/reactivate), guarded+audited impersonation, cross-tenant audit view, subscription management/comp.

The `web-engineer` agent owns this app. It consumes `@ps/core` for all pricing/money/entitlements logic. No money math lives here — only in core.

## What's in here

```
apps/web/
  src/
    app/                  # Next.js App Router: /dashboard/*, /admin/*, /auth/*
    components/           # feature components (ProductForm, ProductsView, …)
    components/ui/        # shared UI primitives (Dialog, …)
  instrumentation-client.ts   # Sentry client-side init (DSN-gated)
  instrumentation.ts          # Sentry server/edge init via register() + onRequestError
  sentry.server.config.ts     # Sentry server init
  sentry.edge.config.ts       # Sentry edge-runtime init
  next.config.ts              # withSentryConfig wrapping (source maps, SENTRY_AUTH_TOKEN-gated)
```

## Running locally

Install from the repo root first:

```sh
# repo root
npm install
```

Start the development server:

```sh
cd apps/web
npm run dev    # http://localhost:3000
```

Production build (what `ps-verify` checks):

```sh
npm run build
npm run start  # optional: serve the built output
```

### Environment variables

Create `.env` in the repo root from `.env.example`. The web app reads:

**Client-safe (publishable — safe to expose in the browser bundle):**

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN (omit → Sentry is fully off, zero overhead) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |

**Server-only (never set as `NEXT_PUBLIC_*`, never in the browser bundle):**

| Variable | Description |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key — bypasses RLS; server/edge only |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…` for test-mode, `sk_live_…` for production) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_…`) |
| `SENTRY_AUTH_TOKEN` | Sentry source-map upload token; omit → source-map upload skipped (build still succeeds) |

If you add a new env var, classify it as `NEXT_PUBLIC_*` (publishable) or server-only, and update `.env.example`. Never add a `NEXT_PUBLIC_` prefix to a secret.

## Sentry observability

Sentry is initialized across four Next.js runtimes (client, server, edge, global-error). Each reads `NEXT_PUBLIC_SENTRY_DSN`; **if the DSN is falsy the runtime returns immediately** — no `Sentry.init` is called, no instrumentation is added, CI is not blocked.

When a DSN is present, all events pass through the `@ps/core/observability` scrubber (`beforeSend`/`beforeBreadcrumb`) before being sent. `SENTRY_AUTH_TOKEN` is read at build time by `withSentryConfig` for source-map upload; when absent the step is silently skipped and the build completes normally.

## Linting and type-checking

```sh
cd apps/web
npm run lint     # ESLint (includes eslint-plugin-jsx-a11y recommended)
npx tsc --noEmit # TypeScript strict check (must be 0 errors)
```

`eslint-plugin-jsx-a11y` (recommended config) is enabled — it catches missing `alt`, unlabeled controls, invalid ARIA, and non-interactive event handlers statically.

## Supabase backend

The web app talks to Supabase for data and Supabase Edge Functions for billing (Stripe checkout/portal) and tenant lifecycle. Run the local stack from `supabase/`:

```sh
cd supabase
supabase start      # starts local Postgres + Auth + Edge Functions
supabase db reset   # applies migrations 0001–0012 + seed
supabase test db    # runs pgTAP isolation tests 00–07
```

For the hosted project: set the Supabase URL and keys in `.env`; deploy edge functions with `supabase functions deploy`; **deploy and enable the `custom-access-token` auth hook** (required for JWT-claim-based RLS to work); **enable Realtime** and apply the `0009` publication.
