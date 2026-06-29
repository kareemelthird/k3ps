/**
 * Sentry mobile init — DSN-gated (ADR-0011 §Q1).
 *
 * HARD RULE (AC 1): if EXPO_PUBLIC_SENTRY_DSN is falsy this function returns
 * immediately without calling Sentry.init — zero SDK overhead, zero network call,
 * zero console noise in dev / CI / contributor builds.
 *
 * When present: captures unhandled JS errors + promise rejections with:
 *   - beforeSend delegating to the pure @ps/core scrubber (redacts PII/tokens/money)
 *   - beforeBreadcrumb likewise scrubbed
 *   - tracesSampleRate: 0 (errors only — no APM this phase)
 *   - sendDefaultPii: false
 *   - NO user identity set (no Sentry.setUser — ADR-0011 §Q1 tag policy)
 *
 * NEVER import @sentry/* into @ps/core — core stays framework-free (CLAUDE.md §2.4).
 */
import * as Sentry from '@sentry/react-native';
import {
  scrubEvent,
  scrubBreadcrumb,
  type SentryLikeEvent,
  type SentryLikeBreadcrumb,
} from '@ps/core';

const dsn: string | undefined = process.env['EXPO_PUBLIC_SENTRY_DSN'];

/**
 * Call once at the earliest possible moment in the root layout module scope.
 * DSN-gated: true no-op (no init, no overhead) when EXPO_PUBLIC_SENTRY_DSN absent.
 */
export function initSentry(): void {
  // Explicit DSN-gate: don't call init at all when absent.
  // "if this is not set, the SDK will not send any events" (Sentry docs),
  // but we go further — zero instrumentation overhead in dev/CI (ADR-0011 §Q1.1).
  if (!dsn) return;

  Sentry.init({
    dsn,
    enabled: true,
    tracesSampleRate: 0,        // errors only; APM/replay off this phase (ADR-0011 §Q4)
    sendDefaultPii: false,      // no IP / cookie / email by default
    enableNativeCrashHandling: true,

    // ── Pure @ps/core scrubber: one audited, unit-tested policy, both runtimes. ──
    // ADR-0011 §Q1 "the novel risk is data *leaving the device*".
    // Core has >90% coverage on adversarial payloads (AC 3–4).
    beforeSend(event) {
      // SentryLikeEvent is a structural subset of @sentry/react-native's Event.
      // Double-cast through unknown: SentryLikeEvent ↔ Sentry.ErrorEvent are
      // structurally incompatible but semantically equivalent for our purposes.
      return scrubEvent(event as unknown as SentryLikeEvent) as unknown as typeof event;
    },

    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(
        breadcrumb as unknown as SentryLikeBreadcrumb,
      ) as unknown as (typeof breadcrumb | null);
    },
  });
}

/**
 * Re-export Sentry so callers can do `Sentry.wrap(Root)` without a second import.
 * When DSN is absent and init was not called, Sentry.wrap is a safe pass-through.
 */
export { Sentry };
