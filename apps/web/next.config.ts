import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // Transpile the @ps/core workspace package
  transpilePackages: ['@ps/core'],
};

const baseConfig = withNextIntl(nextConfig);

// ── Sentry (ADR-0011 §Q1 + §Q7) ─────────────────────────────────────────────
// Only apply withSentryConfig when NEXT_PUBLIC_SENTRY_DSN is set at build time.
// When absent (dev / CI / contributors) the standard config is used as-is —
// zero Sentry build overhead, build stays green without any Sentry secret.
//
// Source-map upload is gated separately on SENTRY_AUTH_TOKEN (server/CI-only,
// never committed). When absent, disableSourceMapUpload:true silently skips it.
const hasDsn = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);

let finalConfig = baseConfig;

if (hasDsn) {
  // Dynamic require so the Sentry import only runs when DSN is present.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withSentryConfig } = require('@sentry/nextjs') as typeof import('@sentry/nextjs');
  finalConfig = withSentryConfig(baseConfig, {
    org: process.env.SENTRY_ORG ?? '',
    project: process.env.SENTRY_PROJECT ?? '',
    // Source-map upload: only when SENTRY_AUTH_TOKEN present; skip silently otherwise.
    // v8 API: sourcemaps.disable replaces the removed disableSourceMapUpload option.
    authToken: process.env.SENTRY_AUTH_TOKEN,
    sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
    // Suppress build-time Sentry logs in CI to reduce noise.
    silent: !process.env.SENTRY_AUTH_TOKEN,
    // Disable Sentry telemetry in CI.
    telemetry: false,
  });
}

export default finalConfig;
