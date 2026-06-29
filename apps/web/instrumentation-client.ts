/**
 * Sentry client-side init — Next.js 15 App Router instrumentation-client.ts.
 *
 * ADR-0011 §Q1 (normative). DSN-gated: when NEXT_PUBLIC_SENTRY_DSN is absent
 * (dev / CI / contributor builds) this file is a TRUE no-op — Sentry.init is
 * never called, zero instrumentation overhead, zero network, zero console noise.
 *
 * Scrubbing: delegates 100% to the pure @ps/core scrubber (the security-review
 * artifact). No PII / tokens / money rows leave the device. Only
 * SAFE_TAG_KEYS (tenant_id / role / release / environment / route) are sent.
 */

import * as Sentry from '@sentry/nextjs';
import { scrubEvent, scrubBreadcrumb } from '@ps/core';
import type { SentryLikeEvent, SentryLikeBreadcrumb } from '@ps/core';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

// DSN gate — do NOT call init without a DSN (ADR-0011 §Q1.1 / Decision Q1).
if (dsn) {
  Sentry.init({
    dsn,
    // Errors only this phase — no tracing / replay (ADR-0011 §Q1.4).
    tracesSampleRate: 0,
    // Never attach PII automatically (IP, email, user agent).
    sendDefaultPii: false,
    // Delegate to the pure @ps/core scrubber (single audited source of truth).
    beforeSend(event) {
      return scrubEvent(
        event as unknown as SentryLikeEvent,
      ) as unknown as typeof event;
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(
        breadcrumb as unknown as SentryLikeBreadcrumb,
      ) as unknown as typeof breadcrumb;
    },
  });
}
