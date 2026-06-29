/**
 * observability — the pure, security-critical Sentry scrubber (ADR-0011 §Q1).
 *
 * The single audited source of truth for the redaction policy both apps'
 * `beforeSend` / `beforeBreadcrumb` adapters delegate to. No @sentry / framework
 * imports; deterministic; never throws. See ./scrub for the policy.
 */
export {
  type SentryLikeBreadcrumb,
  type SentryLikeRequest,
  type SentryLikeEvent,
  type RedactOptions,
  REDACTED,
  DEFAULT_MAX_DEPTH,
  SENSITIVE_KEY_PATTERNS,
  SENSITIVE_VALUE_PATTERNS,
  GENERIC_HEX_PATTERN,
  PHONE_PATTERN,
  SAFE_TAG_KEYS,
  redactValue,
  scrubUrl,
  scrubTags,
  scrubBreadcrumb,
  scrubEvent,
} from './scrub';
