/**
 * Sentry Edge runtime init.
 * Loaded by instrumentation.ts when NEXT_RUNTIME === 'edge'.
 * DSN-gated: no-op when NEXT_PUBLIC_SENTRY_DSN is absent. ADR-0011 §Q1.
 */

import * as Sentry from '@sentry/nextjs';
import { scrubEvent, scrubBreadcrumb } from '@ps/core';
import type { SentryLikeEvent, SentryLikeBreadcrumb } from '@ps/core';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0,
    sendDefaultPii: false,
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
