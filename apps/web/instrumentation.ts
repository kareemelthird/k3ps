/**
 * Next.js server-side instrumentation file (App Router).
 *
 * register() dynamically loads the correct Sentry runtime config.
 * onRequestError captures Server Component / middleware errors.
 * Both are no-ops when Sentry was not initialised (no DSN). ADR-0011 §Q1.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Next.js 15 App Router: captures Server Component and middleware errors.
// captureRequestError is the stable export in @sentry/nextjs v8 — re-exported as
// the onRequestError hook that Next.js 15 instrumentation calls automatically.
export { captureRequestError as onRequestError } from '@sentry/nextjs';
