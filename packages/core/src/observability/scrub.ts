/**
 * observability/scrub — the pure, security-critical Sentry scrubber.
 *
 * ADR-0011 §Q1 (NORMATIVE). This is the single, audited source of truth for the
 * `beforeSend` / `beforeBreadcrumb` redaction policy that BOTH the web (Next.js)
 * and mobile (Expo) Sentry adapters delegate to. The novel risk this guards is
 * the inverse of every prior phase: tenant / PII / secret / money data *leaving
 * the device* via error telemetry. Nothing sensitive may survive these functions.
 *
 * HARD RULES (CLAUDE.md §2.4):
 *   - PURE. No imports from @sentry/*, React, React Native, Expo, Next.js, or
 *     Supabase. Operates on a minimal STRUCTURAL `SentryLikeEvent` type only.
 *   - Deterministic. Reads no clock / system time in the logic.
 *   - Never throws. Every public function is wrapped so malformed / adversarial
 *     / circular / huge input degrades to a safe, redacted value — telemetry must
 *     never crash the host app.
 *   - Returns scrubbed COPIES; the caller's input object is never mutated.
 *
 * Policy summary (see ADR-0011 §Q1.6):
 *   DROPPED  — any value whose KEY matches SENSITIVE_KEY_PATTERNS, any STRING
 *              matching SENSITIVE_VALUE_PATTERNS (JWT / Stripe / sb_secret_ /
 *              bearer / email / long-hex / card-like), request bodies & cookies,
 *              query-string credentials, exception-frame local `vars`, all
 *              `user` PII, and every tag not on the allowlist.
 *   ALLOWED  — exception type + stack frame code locations (filename/function/
 *              line), and tags in SAFE_TAG_KEYS (tenant_id / role / release /
 *              environment / route / screen) — coarse triage keys, no café data.
 */

/** Sentry-shaped, but structural — core imports NO @sentry types. */
export interface SentryLikeBreadcrumb {
  type?: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  level?: string;
  [k: string]: unknown;
}

export interface SentryLikeRequest {
  url?: string;
  query_string?: string | Record<string, unknown>;
  headers?: Record<string, unknown>;
  data?: unknown;
  cookies?: unknown;
  [k: string]: unknown;
}

export interface SentryLikeEvent {
  message?: string;
  request?: SentryLikeRequest;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: SentryLikeBreadcrumb[];
  user?: Record<string, unknown>;
  // exception / stacktrace are intentionally PRESERVED (code locations, not data),
  // except frame-local `vars` and the exception message, which are scrubbed.
  exception?: unknown;
  [k: string]: unknown;
}

/** The sentinel written in place of any redacted value. */
export const REDACTED = '[redacted]';

/** Default recursion bound — protects against deeply-nested / DoS payloads. */
export const DEFAULT_MAX_DEPTH = 8;

export interface RedactOptions {
  /** Recursion depth bound; beyond it nested objects collapse to REDACTED. */
  maxDepth?: number;
  /**
   * Skip ONLY the generic long-hex value rule (GENERIC_HEX_PATTERN) on string
   * values. High-confidence patterns (JWT / sb_secret_ / sk_/whsec_ / bearer /
   * email / phone / card) still apply. Used exclusively by `scrubTags` so a
   * legitimate 40-char git-SHA `release` tag survives for release correlation.
   * Do NOT enable this anywhere else.
   */
  skipGenericHex?: boolean;
}

/**
 * Case-insensitive key SUBSTRINGS whose VALUE is always redacted, regardless of
 * the value's content. Deliberately broad — over-redaction is the safe failure.
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  // auth / tokens / sessions
  'authorization',
  'auth',
  'token',
  'access_token',
  'refresh_token',
  'bearer',
  'session',
  'jwt',
  // generic secrets / keys
  'secret',
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'apikey',
  'api_key',
  'api-key',
  'access_key',
  'secret_key',
  'client_secret',
  'private_key',
  'privatekey',
  'credential',
  'signing',
  // platform-specific secrets
  'service_role',
  'sb_secret',
  'whsec',
  'stripe',
  'dsn',
  'cookie',
  'server_name',
  'hostname',
  // PII
  'email',
  'phone',
  'telephone',
  // payment data
  'card',
  'cvc',
  'cvv',
  'ssn',
  'iban',
];

/**
 * GENERIC long-hex run — API secrets, hashes, signing keys (>=32 hex chars).
 *
 * This is the ONE value pattern that is *not* high-confidence: a 40-char git SHA
 * (a common Sentry `release` convention) is indistinguishable from a 40-char
 * secret. We therefore expose it by name so SAFE_TAG values (and only those) can
 * be exempted from it — see `redactString(..., skipGenericHex)` / `scrubTags`.
 * Everywhere else it stays active (over-redaction is the safe failure).
 */
export const GENERIC_HEX_PATTERN: RegExp = /\b[0-9a-fA-F]{32,}\b/;

/**
 * Bare phone-number value pattern (E.164-ish). Catches a phone in free text under
 * a NON-sensitive key (e.g. `extra.note = "call +201001234567"`) that no key rule
 * would otherwise reach. Two shapes:
 *   1. International with a leading `+`: `+` then 8–16 digits, tolerant of single
 *      space/dash separators (`+20 100 123 4567`).
 *   2. A bare run of 8–15 CONSECUTIVE digits with no separators (`201001234567`).
 *
 * TRADEOFF: shape (2) requires >=8 digits so ordinary small integers / short IDs
 * (4–6 digits), version strings (`2.0.0`) and dash/colon-separated ISO dates
 * (`2026-06-29`, which has separators and so fails shape 2, and no `+` so fails
 * shape 1) are NOT matched. The accepted cost is that a bare 8–15 digit numeric
 * ID in free text may be over-redacted — acceptable, since leaking a real phone
 * number is the far worse failure for a cash business handling customer PII.
 */
export const PHONE_PATTERN: RegExp = /\+\d[\d\s-]{6,18}\d|\b\d{8,15}\b/;

/**
 * String VALUE patterns redacted regardless of key. Each is anchored loosely so
 * a sensitive token embedded in a larger string still triggers full-string
 * redaction (we redact the whole string, never a partial). No `g` flag — `.test`
 * with a global regex is stateful and would skip every other match.
 */
export const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // JSON Web Tokens (Supabase access/refresh, service_role key, etc.): eyJ....x.y
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/,
  // Stripe secret / restricted / publishable / webhook-signing keys
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bwhsec_[A-Za-z0-9]{8,}/,
  // Supabase secret / personal-access tokens
  /\bsb_secret_[A-Za-z0-9_-]{8,}/,
  /\bsbp_[A-Za-z0-9]{8,}/,
  // Authorization: Bearer <token>
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  // email addresses
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  // long hex runs — API secrets, hashes, signing keys (exemptible for SAFE_TAGs)
  GENERIC_HEX_PATTERN,
  // bare phone numbers in free text (E.164-ish) — see PHONE_PATTERN comment
  PHONE_PATTERN,
  // card-like number runs (13–19 digits, optional space/dash grouping)
  /\b(?:\d[ -]?){13,19}\b/,
];

/**
 * Tags permitted to leave the device (ADR-0011 §Q1, human-approved at the gate).
 * Everything else in `event.tags` is dropped. NO email / name / phone here.
 */
export const SAFE_TAG_KEYS: readonly string[] = [
  'tenant_id',
  'role',
  'release',
  'environment',
  'route',
  'screen',
];

/** Breadcrumb categories that are inherently sensitive and dropped wholesale. */
const DROP_BREADCRUMB_CATEGORIES: readonly string[] = ['auth'];

// ── internal helpers ─────────────────────────────────────────────────────────

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Redact a whole string if any value pattern matches; else return it as-is.
 * When `skipGenericHex` is set, the GENERIC_HEX_PATTERN rule is skipped (and ONLY
 * that one) — every high-confidence secret pattern still applies.
 */
function redactString(s: string, skipGenericHex = false): string {
  for (const re of SENSITIVE_VALUE_PATTERNS) {
    if (skipGenericHex && re === GENERIC_HEX_PATTERN) continue;
    if (re.test(s)) return REDACTED;
  }
  return s;
}

/** Scrub the credential-bearing parts of a `k=v&...` query string. */
function scrubQuery(query: string): string {
  return query
    .split('&')
    .map((pair) => {
      if (pair === '') return pair;
      const eq = pair.indexOf('=');
      if (eq < 0) {
        // bare token in the query — redact if it looks sensitive
        return redactString(pair) === REDACTED ? REDACTED : pair;
      }
      const key = pair.slice(0, eq);
      const val = pair.slice(eq + 1);
      let decoded = val;
      try {
        decoded = decodeURIComponent(val.replace(/\+/g, ' '));
      } catch {
        /* keep raw */
      }
      if (isSensitiveKey(key) || redactString(decoded) === REDACTED) {
        return `${key}=${REDACTED}`;
      }
      return `${key}=${val}`;
    })
    .join('&');
}

function redactInner(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  skipGenericHex: boolean,
): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return redactString(value as string, skipGenericHex);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
  if (t === 'function' || t === 'symbol') return REDACTED;

  // object or array
  if (depth <= 0) return REDACTED; // depth bound — DoS protection
  const obj = value as object;
  if (seen.has(obj)) return REDACTED; // circular / shared ref — collapse
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, depth - 1, seen, skipGenericHex));
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[key];
    out[key] = isSensitiveKey(key)
      ? REDACTED
      : redactInner(v, depth - 1, seen, skipGenericHex);
  }
  return out;
}

/** Scrub a URL-ish string in free text, then redact if otherwise sensitive. */
function scrubText(s: string): string {
  let m = s;
  if (/https?:\/\//i.test(m)) m = scrubUrl(m);
  return redactString(m);
}

function scrubStacktrace(st: unknown): unknown {
  if (!st || typeof st !== 'object') return st;
  const frames = (st as { frames?: unknown }).frames;
  if (!Array.isArray(frames)) return st;
  return {
    ...(st as Record<string, unknown>),
    frames: frames.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const nf = { ...(f as Record<string, unknown>) };
      // Local variable snapshots can hold secrets — redact; keep code location.
      if (nf.vars !== undefined) nf.vars = redactValue(nf.vars);
      return nf;
    }),
  };
}

/**
 * Scrub an exception OR a `threads` container — both share the Sentry shape
 * `{ values: [{ value?, stacktrace: { frames: [{ ..., vars }] } }] }`. Redacts the
 * exception/thread `value` message and runs every stack frame through
 * `scrubStacktrace` (drops/redacts frame-local `vars`, keeps the code location).
 */
function scrubException(exc: unknown): unknown {
  try {
    if (!exc || typeof exc !== 'object') return exc;
    const values = (exc as { values?: unknown }).values;
    if (Array.isArray(values)) {
      return {
        ...(exc as Record<string, unknown>),
        values: values.map((v) => {
          if (!v || typeof v !== 'object') return v;
          const nv = { ...(v as Record<string, unknown>) };
          if (typeof nv.value === 'string') nv.value = redactString(nv.value);
          if (nv.stacktrace !== undefined) nv.stacktrace = scrubStacktrace(nv.stacktrace);
          return nv;
        }),
      };
    }
    // Single-shape exception { value, stacktrace }.
    const e = { ...(exc as Record<string, unknown>) };
    if (typeof e.value === 'string') e.value = redactString(e.value);
    if (e.stacktrace !== undefined) e.stacktrace = scrubStacktrace(e.stacktrace);
    return e;
  } catch {
    return {}; // never leak an unscrubbed exception on a scrubbing failure
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Deep clone + redact `value`: keys matching SENSITIVE_KEY_PATTERNS collapse to
 * REDACTED; string values matching SENSITIVE_VALUE_PATTERNS collapse to REDACTED.
 * Pure, bounded depth, circular-safe, never throws.
 */
export function redactValue(value: unknown, opts: RedactOptions = {}): unknown {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  try {
    return redactInner(value, maxDepth, new WeakSet<object>(), opts.skipGenericHex ?? false);
  } catch {
    return REDACTED;
  }
}

/**
 * Strip tokens/credentials from a URL or bare query string: removes userinfo
 * (`user:pass@`), redacts query/fragment param values whose key is sensitive or
 * whose value looks like a secret. Preserves path + safe params for triage.
 */
export function scrubUrl(url: string): string {
  if (typeof url !== 'string') return REDACTED;
  try {
    // strip userinfo credentials in the authority component
    let s = url.replace(/(\/\/)[^/@\s]+@/, `$1${REDACTED}@`);

    // peel the fragment (may itself carry OAuth-implicit tokens)
    let frag = '';
    const hashIdx = s.indexOf('#');
    if (hashIdx >= 0) {
      const rawFrag = s.slice(hashIdx + 1);
      s = s.slice(0, hashIdx);
      frag = rawFrag.includes('=')
        ? `#${scrubQuery(rawFrag)}`
        : redactString(rawFrag) === REDACTED
          ? `#${REDACTED}`
          : `#${rawFrag}`;
    }

    const qIdx = s.indexOf('?');
    if (qIdx < 0) {
      // A bare `k=v&...` query string (no scheme/path) — scrub it as a query.
      if (!/[/:]/.test(s) && s.includes('=')) return scrubQuery(s) + frag;
      return s + frag;
    }
    const base = s.slice(0, qIdx);
    const query = s.slice(qIdx + 1);
    return `${base}?${scrubQuery(query)}${frag}`;
  } catch {
    return REDACTED;
  }
}

/**
 * Drop any tag whose key is not in SAFE_TAG_KEYS; defensively redact the value
 * of an allowlisted tag if it nonetheless looks sensitive. Returns a fresh object.
 */
export function scrubTags(
  tags: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!tags || typeof tags !== 'object') return out;
  try {
    for (const key of SAFE_TAG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(tags, key)) {
        // Allowlisted tags are exempt from the generic long-hex rule ONLY, so a
        // 40-char git-SHA `release` survives; all high-confidence secret patterns
        // (JWT / sb_secret_ / sk_/whsec_ / bearer / email / phone / card) still
        // redact the value defensively.
        out[key] = redactValue(tags[key], { skipGenericHex: true });
      }
    }
  } catch {
    return {};
  }
  return out;
}

/**
 * Scrub a breadcrumb: drop inherently-sensitive categories (auth) entirely; else
 * redact `message` (URL- and value-aware) and deep-redact `data` (incl. data.url).
 * Returns null to drop the crumb. Never throws.
 */
export function scrubBreadcrumb(
  crumb: SentryLikeBreadcrumb,
): SentryLikeBreadcrumb | null {
  try {
    if (!crumb || typeof crumb !== 'object') return null;
    const category =
      typeof crumb.category === 'string' ? crumb.category.toLowerCase() : '';
    if (DROP_BREADCRUMB_CATEGORIES.some((c) => category.includes(c))) return null;

    const out: SentryLikeBreadcrumb = { ...crumb };
    if (typeof crumb.message === 'string') out.message = scrubText(crumb.message);
    if (crumb.data !== undefined && crumb.data !== null) {
      const d = redactValue(crumb.data) as Record<string, unknown>;
      if (d && typeof d === 'object' && typeof d.url === 'string') {
        d.url = scrubUrl(d.url);
      }
      out.data = d;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Top-level event keys that `scrubEvent` handles with bespoke logic. Every other
 * key falls through to the deny-by-default deep-redaction sweep at the end.
 */
const HANDLED_EVENT_KEYS: ReadonlySet<string> = new Set([
  'message',
  'request',
  'tags',
  'extra',
  'contexts',
  'breadcrumbs',
  'user',
  'exception',
  'threads',
]);

/**
 * Standard Sentry triage scalars Sentry needs to ingest/correlate an event. These
 * are deep-redacted like any other unhandled key, EXCEPT they are exempt from the
 * generic long-hex rule — `event_id` is a 32-char hex, `release`/`dist` are often
 * a git SHA — so it would otherwise be destroyed, breaking triage. High-confidence
 * secret patterns (JWT / sb_secret_ / stripe / bearer / email / phone / card) and
 * the sensitive-key rule still apply to them.
 */
const SAFE_SCALAR_EVENT_KEYS: ReadonlySet<string> = new Set([
  'event_id',
  'timestamp',
  'level',
  'platform',
  'release',
  'environment',
  'dist',
  'sdk',
  'logger',
]);

/**
 * The event scrubber `beforeSend` delegates to. Deep-scrubs request / extra /
 * contexts / breadcrumbs / exception, scrubs request.url + query_string, enforces
 * the tag allowlist, and removes all `user` PII. Preserves exception type + stack
 * frame code locations (but redacts frame-local vars + the exception message).
 * Returns a cleaned COPY; never mutates input; never throws.
 */
export function scrubEvent(
  event: SentryLikeEvent,
  opts: RedactOptions = {},
): SentryLikeEvent {
  try {
    if (!event || typeof event !== 'object') return {};
    const out: SentryLikeEvent = { ...event };

    if (typeof event.message === 'string') out.message = scrubText(event.message);

    if (event.request && typeof event.request === 'object') {
      const r = event.request;
      const nr: SentryLikeRequest = {};
      // explicit handling for the sensitive request fields
      if (typeof r.url === 'string') nr.url = scrubUrl(r.url);
      if (r.query_string !== undefined) {
        nr.query_string =
          typeof r.query_string === 'string'
            ? scrubQuery(r.query_string)
            : (redactValue(r.query_string, opts) as Record<string, unknown>);
      }
      if (r.headers !== undefined) {
        nr.headers = redactValue(r.headers, opts) as Record<string, unknown>;
      }
      if (r.data !== undefined) nr.data = redactValue(r.data, opts);
      if (r.cookies !== undefined) nr.cookies = REDACTED;
      // copy any remaining request fields (method, etc.), redacted defensively
      for (const key of Object.keys(r)) {
        if (!(key in nr)) nr[key] = redactValue(r[key], opts);
      }
      out.request = nr;
    }

    if (event.tags !== undefined) out.tags = scrubTags(event.tags);
    if (event.extra !== undefined) {
      out.extra = redactValue(event.extra, opts) as Record<string, unknown>;
    }
    if (event.contexts !== undefined) {
      out.contexts = redactValue(event.contexts, opts) as Record<string, unknown>;
    }
    if (Array.isArray(event.breadcrumbs)) {
      out.breadcrumbs = event.breadcrumbs
        .map((b) => scrubBreadcrumb(b))
        .filter((b): b is SentryLikeBreadcrumb => b !== null);
    }

    // Never attach user identity / PII (sendDefaultPii:false + no setUser).
    if ('user' in out) delete out.user;

    if (event.exception !== undefined) out.exception = scrubException(event.exception);
    // `threads` carries the SAME stacktrace/frame-vars shape as `exception`
    // (threaded / native crash events). Scrub it via the identical path — without
    // this, `threads[].stacktrace.frames[].vars` would leak the exact frame-local
    // secrets we strip from `exception`.
    if (event.threads !== undefined) out.threads = scrubException(event.threads);

    // DENY-BY-DEFAULT: every top-level field not explicitly handled above is run
    // through full deep redaction. This closes the by-reference passthrough of
    // UNRECOGNIZED Sentry fields (server_name, transaction, logentry, and any
    // future/SDK-added key). Sensitive-keyed top-level fields are dropped
    // wholesale; standard triage scalars are exempt from the generic-hex rule
    // only (so a hex event_id / git-SHA release survives); everything else is
    // fully deep-redacted.
    for (const key of Object.keys(out)) {
      if (HANDLED_EVENT_KEYS.has(key)) continue;
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(out[key], {
        ...opts,
        skipGenericHex: SAFE_SCALAR_EVENT_KEYS.has(key),
      });
    }

    return out;
  } catch {
    return {}; // last-resort: drop everything rather than leak on a failure
  }
}
