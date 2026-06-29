/**
 * Adversarial scrubber suite (ADR-0011 §Q1 — the security-review artifact).
 *
 * This is a SECURITY test: it feeds the scrubber the exact payloads we never
 * want to reach Sentry — JWTs, Stripe `sk_`/`whsec_` keys, `sb_secret_`, emails,
 * phone numbers, Authorization headers, nested tenant money rows, deeply-nested
 * and circular and huge objects — and asserts NONE of it survives, while the
 * allowlisted triage tags and exception stack frames DO. Coverage target >90%.
 */
import {
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
  type SentryLikeEvent,
} from './scrub';

// Representative secrets used across the suite.
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
// NOTE: assembled from parts on purpose. These are FAKE fixtures, but a
// contiguous `sk_live_…` literal trips GitHub secret-scanning push protection
// (the repo is public). Splitting the prefix keeps the runtime value identical
// (so the scrubber is exercised exactly the same) without a key-shaped literal
// in source. Do NOT re-inline this into a single string.
const STRIPE_SK = 'sk_' + 'live_' + '51AbCdEfGhIjKlMnOpQrStUvWx';
const STRIPE_WHSEC = 'whsec_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';
const SB_SECRET = 'sb_secret_aBcDeFgHiJkLmNoPqRsTuVwXyZ';
const EMAIL = 'owner@cafe.example.com';
const PHONE = '+201001234567';
const CARD = '4242 4242 4242 4242';
const HEX_SECRET = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
// A realistic 40-char git SHA used as a Sentry `release` (no \b-bounded 8+ digit
// run, so the phone rule does not catch it; only the generic-hex rule would).
const GIT_SHA = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

/** Serialize a scrubbed result and assert no needle string survives anywhere. */
function expectNoSecrets(scrubbed: unknown, needles: string[]): void {
  const json = JSON.stringify(scrubbed);
  for (const needle of needles) {
    expect(json).not.toContain(needle);
  }
}

const ALL_SECRETS = [JWT, STRIPE_SK, STRIPE_WHSEC, SB_SECRET, EMAIL, PHONE, HEX_SECRET, '4242424242424242'];

describe('constants', () => {
  it('SAFE_TAG_KEYS is exactly the human-approved allowlist', () => {
    expect([...SAFE_TAG_KEYS].sort()).toEqual(
      ['environment', 'release', 'role', 'route', 'screen', 'tenant_id'].sort(),
    );
  });

  it('SAFE_TAG_KEYS never includes PII keys', () => {
    for (const pii of ['email', 'phone', 'name', 'user', 'customer_email']) {
      expect(SAFE_TAG_KEYS).not.toContain(pii);
    }
  });

  it('SENSITIVE_KEY_PATTERNS covers the named denylist', () => {
    for (const p of [
      'token',
      'auth',
      'authorization',
      'secret',
      'password',
      'cookie',
      'api_key',
      'apikey',
      'service_role',
      'email',
      'phone',
      'card',
      'cvc',
      'jwt',
      'whsec',
      'dsn',
    ]) {
      expect(SENSITIVE_KEY_PATTERNS).toContain(p);
    }
  });

  it('SENSITIVE_VALUE_PATTERNS are non-global (stateless .test)', () => {
    for (const re of SENSITIVE_VALUE_PATTERNS) {
      expect(re.global).toBe(false);
    }
  });
});

describe('redactValue — value patterns', () => {
  it.each([
    ['JWT', JWT],
    ['Stripe sk_', STRIPE_SK],
    ['Stripe whsec_', STRIPE_WHSEC],
    ['sb_secret_', SB_SECRET],
    ['email', EMAIL],
    ['bearer header', `Bearer ${JWT}`],
    ['long hex', HEX_SECRET],
    ['card-like', '4242424242424242'],
  ])('redacts a bare %s string value', (_label, secret) => {
    expect(redactValue(secret)).toBe(REDACTED);
  });

  it('redacts a secret embedded inside a larger string (whole-string)', () => {
    const r = redactValue(`failed to auth with token ${JWT} at login`);
    expect(r).toBe(REDACTED);
  });

  it('keeps innocuous primitives untouched', () => {
    expect(redactValue('device-3')).toBe('device-3');
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
  });

  it('redacts function and symbol values', () => {
    expect(redactValue(() => 1)).toBe(REDACTED);
    expect(redactValue(Symbol('x'))).toBe(REDACTED);
  });
});

describe('redactValue — key patterns', () => {
  it('redacts by sensitive key even when the value looks innocent', () => {
    const r = redactValue({
      access_token: 'plainlookingvalue',
      password: 'hunter2',
      Authorization: 'whatever',
      api_key: 'abc',
      service_role: 'x',
      keep_me: 'visible',
    }) as Record<string, unknown>;
    expect(r.access_token).toBe(REDACTED);
    expect(r.password).toBe(REDACTED);
    expect(r.Authorization).toBe(REDACTED);
    expect(r.api_key).toBe(REDACTED);
    expect(r.service_role).toBe(REDACTED);
    expect(r.keep_me).toBe('visible');
  });

  it('deep-redacts nested tenant money rows by key + value', () => {
    const row = {
      session: {
        id: 'sess-1',
        grand_total: 12345,
        order: { items: [{ price: 500, name: 'Cola' }], email: EMAIL },
        customer_phone: PHONE,
      },
    };
    const r = redactValue(row);
    // `session` key itself is sensitive -> whole subtree collapses
    expect((r as Record<string, unknown>).session).toBe(REDACTED);
    expectNoSecrets(r, [EMAIL, PHONE, '12345', 'Cola']);
  });

  it('redacts money/email inside a non-sensitive container key', () => {
    const r = redactValue({
      payload: { grand_total: 999, contact_email: EMAIL, label: 'VIP-1' },
    }) as Record<string, Record<string, unknown>>;
    expect(r.payload!.contact_email).toBe(REDACTED); // key 'email' substring
    expect(r.payload!.label).toBe('VIP-1');
  });
});

describe('redactValue — robustness (DoS / circular / huge)', () => {
  it('bounds recursion at maxDepth', () => {
    // build a chain deeper than the bound
    let deep: Record<string, unknown> = { secretLeaf: JWT };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const r = redactValue(deep);
    // somewhere down the chain it collapses to REDACTED — secret never surfaces
    expectNoSecrets(r, [JWT]);
  });

  it('honours a custom maxDepth', () => {
    const r = redactValue({ a: { b: { c: 'x' } } }, { maxDepth: 1 });
    expect((r as Record<string, unknown>).a).toBe(REDACTED);
  });

  it('handles circular references without throwing', () => {
    const a: Record<string, unknown> = { name: 'ok' };
    a.self = a;
    a.token = JWT;
    let r: unknown;
    expect(() => {
      r = redactValue(a);
    }).not.toThrow();
    expectNoSecrets(r, [JWT]);
  });

  it('handles a large array payload', () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ i, token: JWT }));
    const r = redactValue(big) as Array<Record<string, unknown>>;
    expect(r).toHaveLength(5000);
    expect(r[0]!.token).toBe(REDACTED);
    expect(r[0]!.i).toBe(0);
  });
});

describe('scrubUrl', () => {
  it('redacts sensitive query params by key', () => {
    const out = scrubUrl('https://api.cafe.app/v1/sessions?access_token=abc123&page=2');
    expect(out).toContain('page=2');
    expect(out).toContain(`access_token=${REDACTED}`);
    expect(out).not.toContain('abc123');
  });

  it('redacts a JWT in a query value regardless of key', () => {
    const out = scrubUrl(`https://x.app/cb?t=${JWT}&route=reports`);
    expect(out).toContain('route=reports');
    expect(out).not.toContain(JWT);
  });

  it('strips userinfo credentials from the authority', () => {
    const out = scrubUrl('https://user:p4ssw0rd@host.app/path?x=1');
    expect(out).not.toContain('p4ssw0rd');
    expect(out).toContain(`${REDACTED}@host.app`);
  });

  it('scrubs tokens hidden in the fragment (OAuth implicit)', () => {
    const out = scrubUrl(`https://app/cb#access_token=${JWT}&state=ok`);
    expect(out).not.toContain(JWT);
    expect(out).toContain('state=ok');
  });

  it('leaves a clean URL intact', () => {
    const clean = 'https://app/dashboard/reports?range=week';
    expect(scrubUrl(clean)).toBe(clean);
  });

  it('handles a bare query string and non-string input', () => {
    expect(scrubUrl('q=hi&token=secretval')).toContain(`token=${REDACTED}`);
    // @ts-expect-error adversarial: non-string input must not throw
    expect(scrubUrl(undefined)).toBe(REDACTED);
  });

  it('redacts a bare valueless token segment in the query', () => {
    const out = scrubUrl(`https://app/cb?${JWT}&page=1`);
    expect(out).not.toContain(JWT);
    expect(out).toContain('page=1');
  });
});

describe('never-throws on hostile getters (catch paths)', () => {
  const boom = () => {
    throw new Error('hostile getter');
  };

  it('redactValue survives a throwing property getter', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'token', { enumerable: true, get: boom });
    expect(() => redactValue(hostile)).not.toThrow();
    expect(redactValue(hostile)).toBe(REDACTED);
  });

  it('scrubTags returns {} on a throwing allowlisted getter', () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'tenant_id', { enumerable: true, get: boom });
    expect(scrubTags(hostile)).toEqual({});
  });

  it('scrubBreadcrumb returns null on a throwing getter', () => {
    const hostile = {} as { category?: string };
    Object.defineProperty(hostile, 'category', { enumerable: true, get: boom });
    expect(scrubBreadcrumb(hostile)).toBeNull();
  });

  it('scrubEvent returns {} on a throwing getter', () => {
    const hostile = {} as SentryLikeEvent;
    Object.defineProperty(hostile, 'message', { enumerable: true, get: boom });
    expect(scrubEvent(hostile)).toEqual({});
  });
});

describe('scrubTags — allowlist only', () => {
  it('keeps allowlisted tags and drops everything else', () => {
    const out = scrubTags({
      tenant_id: 'tnt-123',
      role: 'owner',
      release: '1.2.0',
      environment: 'production',
      route: '/dashboard',
      screen: 'DeviceGrid',
      // dropped:
      email: EMAIL,
      customer_email: EMAIL,
      user_id: 'u-9',
      authorization: JWT,
      device_id: 'd-1',
    });
    expect(out).toEqual({
      tenant_id: 'tnt-123',
      role: 'owner',
      release: '1.2.0',
      environment: 'production',
      route: '/dashboard',
      screen: 'DeviceGrid',
    });
    expectNoSecrets(out, [EMAIL, JWT]);
  });

  it('defensively redacts an allowlisted tag whose value is a secret', () => {
    const out = scrubTags({ tenant_id: JWT });
    expect(out.tenant_id).toBe(REDACTED);
  });

  it('returns {} for missing/invalid input', () => {
    expect(scrubTags(undefined)).toEqual({});
    // @ts-expect-error adversarial
    expect(scrubTags('nope')).toEqual({});
  });
});

describe('scrubBreadcrumb', () => {
  it('drops inherently-sensitive auth-category crumbs', () => {
    expect(scrubBreadcrumb({ category: 'auth', message: `login ${JWT}` })).toBeNull();
    expect(scrubBreadcrumb({ category: 'auth.session', data: { token: JWT } })).toBeNull();
  });

  it('redacts an email in a breadcrumb message', () => {
    const out = scrubBreadcrumb({ category: 'ui.click', message: `mailed ${EMAIL}` });
    expect(out).not.toBeNull();
    expect(out!.message).toBe(REDACTED);
  });

  it('redacts a token in breadcrumb data and scrubs data.url', () => {
    const out = scrubBreadcrumb({
      category: 'xhr',
      type: 'http',
      data: {
        url: `https://api/v1?access_token=${JWT}`,
        Authorization: `Bearer ${JWT}`,
        status_code: 200,
      },
    });
    expect(out).not.toBeNull();
    expectNoSecrets(out, [JWT]);
    expect((out!.data as Record<string, unknown>).status_code).toBe(200);
  });

  it('returns null on malformed input without throwing', () => {
    // @ts-expect-error adversarial
    expect(scrubBreadcrumb(null)).toBeNull();
    // @ts-expect-error adversarial
    expect(scrubBreadcrumb(42)).toBeNull();
  });

  it('passes through a clean crumb', () => {
    const out = scrubBreadcrumb({ category: 'navigation', message: 'to /reports' });
    expect(out!.message).toBe('to /reports');
  });
});

describe('scrubEvent — the beforeSend artifact', () => {
  function adversarialEvent(): SentryLikeEvent {
    return {
      message: `unhandled error for ${EMAIL}`,
      request: {
        url: `https://api.cafe.app/rpc?service_role=${SB_SECRET}`,
        query_string: `apikey=${STRIPE_SK}&page=1`,
        headers: {
          Authorization: `Bearer ${JWT}`,
          Cookie: 'sb-access-token=xyz; other=1',
          'content-type': 'application/json',
        },
        data: {
          stripe_key: STRIPE_SK,
          session: { grand_total: 5000, customer_email: EMAIL, phone: PHONE },
        },
        cookies: { 'sb-refresh-token': 'r3fr3sh' },
      },
      tags: {
        tenant_id: 'tnt-1',
        role: 'manager',
        release: '2.0.0',
        environment: 'production',
        route: '/dashboard/reports',
        customer_email: EMAIL, // not allowlisted -> dropped
        card: CARD,
      },
      extra: {
        whsec: STRIPE_WHSEC,
        debug_jwt: JWT,
        note: 'device 7 froze',
      },
      contexts: {
        app: { app_version: '2.0.0' },
        creds: { sb_secret: SB_SECRET },
      },
      breadcrumbs: [
        { category: 'auth', message: `login ${JWT}` }, // dropped
        { category: 'ui.click', message: `clicked pay for ${EMAIL}` },
        { category: 'xhr', data: { url: `https://x?token=${JWT}` } },
      ],
      user: { id: 'u-1', email: EMAIL, ip_address: '1.2.3.4' },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: `cannot read 'x' for ${EMAIL}`,
            stacktrace: {
              frames: [
                {
                  filename: 'ProductsView.tsx',
                  function: 'onSave',
                  lineno: 42,
                  vars: { token: JWT, count: 3 },
                },
              ],
            },
          },
        ],
      },
    };
  }

  it('removes every secret from the full event', () => {
    const out = scrubEvent(adversarialEvent());
    expectNoSecrets(out, [...ALL_SECRETS, CARD, '4242424242424242', 'r3fr3sh', '5000', 'sb-access-token']);
  });

  it('does not mutate the input event', () => {
    const ev = adversarialEvent();
    const before = JSON.stringify(ev);
    scrubEvent(ev);
    expect(JSON.stringify(ev)).toBe(before);
  });

  it('enforces the tag allowlist', () => {
    const out = scrubEvent(adversarialEvent());
    expect(out.tags).toEqual({
      tenant_id: 'tnt-1',
      role: 'manager',
      release: '2.0.0',
      environment: 'production',
      route: '/dashboard/reports',
    });
  });

  it('strips user PII entirely', () => {
    const out = scrubEvent(adversarialEvent());
    expect('user' in out).toBe(false);
  });

  it('redacts request headers, body, query and cookies', () => {
    const out = scrubEvent(adversarialEvent());
    const req = out.request!;
    const headers = req.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe(REDACTED);
    expect(headers.Cookie).toBe(REDACTED);
    expect(headers['content-type']).toBe('application/json'); // safe header kept
    expect(req.cookies).toBe(REDACTED);
    expect(req.query_string).toContain('page=1');
    expect(req.query_string).not.toContain(STRIPE_SK);
  });

  it('preserves exception type + frame code location, redacts frame vars & message', () => {
    const out = scrubEvent(adversarialEvent());
    const exc = out.exception as {
      values: Array<{
        type: string;
        value: string;
        stacktrace: { frames: Array<Record<string, unknown>> };
      }>;
    };
    const v = exc.values[0]!;
    expect(v.type).toBe('TypeError'); // triage data preserved
    expect(v.value).toBe(REDACTED); // message had an email
    const frame = v.stacktrace.frames[0]!;
    expect(frame.filename).toBe('ProductsView.tsx'); // code location preserved
    expect(frame.function).toBe('onSave');
    expect(frame.lineno).toBe(42);
    expect((frame.vars as Record<string, unknown>).token).toBe(REDACTED);
    expect((frame.vars as Record<string, unknown>).count).toBe(3);
  });

  it('keeps benign extra/context values for triage', () => {
    const out = scrubEvent(adversarialEvent());
    expect((out.extra as Record<string, unknown>).note).toBe('device 7 froze');
    const contexts = out.contexts as Record<string, Record<string, unknown>>;
    expect(contexts.app!.app_version).toBe('2.0.0');
    expect(contexts.creds!.sb_secret).toBe(REDACTED);
  });

  it('drops the auth breadcrumb and scrubs the rest', () => {
    const out = scrubEvent(adversarialEvent());
    expect(out.breadcrumbs).toHaveLength(2);
    expectNoSecrets(out.breadcrumbs, [JWT, EMAIL]);
  });

  it('never throws on malformed / empty input', () => {
    // @ts-expect-error adversarial
    expect(scrubEvent(null)).toEqual({});
    // @ts-expect-error adversarial
    expect(scrubEvent('boom')).toEqual({});
    expect(scrubEvent({})).toEqual({});
  });

  it('handles single-shape exception (no .values array)', () => {
    const out = scrubEvent({
      exception: { value: `boom ${EMAIL}`, stacktrace: { frames: [{ vars: { k: JWT } }] } },
    } as unknown as SentryLikeEvent);
    expectNoSecrets(out, [EMAIL, JWT]);
  });

  it('handles string query_string and non-array breadcrumbs gracefully', () => {
    const out = scrubEvent({
      request: { query_string: `token=${JWT}` },
      breadcrumbs: undefined,
    });
    expect(out.request!.query_string).not.toContain(JWT);
  });

  it('uses DEFAULT_MAX_DEPTH constant as documented', () => {
    expect(DEFAULT_MAX_DEPTH).toBe(8);
  });
});

// ── FIX 1: deny-by-default — no top-level field escapes redaction ──────────────
describe('scrubEvent — deny-by-default (FIX 1)', () => {
  it('scrubs threads[].stacktrace.frames[].vars while keeping code locations', () => {
    const out = scrubEvent({
      threads: {
        values: [
          {
            id: 0,
            name: 'main',
            crashed: true,
            stacktrace: {
              frames: [
                {
                  filename: 'DeviceGrid.tsx',
                  function: 'onClose',
                  lineno: 88,
                  colno: 12,
                  vars: { token: JWT, sb: SB_SECRET, count: 7 },
                },
              ],
            },
          },
        ],
      },
    } as unknown as SentryLikeEvent);

    expectNoSecrets(out, [JWT, SB_SECRET]);
    const frame = (
      out.threads as {
        values: Array<{ stacktrace: { frames: Array<Record<string, unknown>> } }>;
      }
    ).values[0]!.stacktrace.frames[0]!;
    // code location survives for triage …
    expect(frame.filename).toBe('DeviceGrid.tsx');
    expect(frame.function).toBe('onClose');
    expect(frame.lineno).toBe(88);
    expect(frame.colno).toBe(12);
    // … but frame-local secrets are gone (and a benign local is kept)
    const vars = frame.vars as Record<string, unknown>;
    expect(vars.token).toBe(REDACTED);
    expect(vars.sb).toBe(REDACTED);
    expect(vars.count).toBe(7);
  });

  it('redacts an UNRECOGNIZED top-level field carrying a secret', () => {
    const out = scrubEvent({
      // not in the known-key set, not a sensitive key name — must still be scrubbed
      some_future_sdk_field: { nested: { blob: `prefix ${JWT} suffix` } },
    } as unknown as SentryLikeEvent);
    expectNoSecrets(out, [JWT]);
  });

  it('drops server_name (hostname/PII) and redacts logentry secrets', () => {
    const out = scrubEvent({
      server_name: `host-7 ${JWT}`,
      logentry: { message: `login failed for ${EMAIL}`, params: [SB_SECRET] },
    } as unknown as SentryLikeEvent);
    expect((out as Record<string, unknown>).server_name).toBe(REDACTED);
    expectNoSecrets(out, [JWT, EMAIL, SB_SECRET]);
  });

  it('preserves safe triage scalars (incl. hex event_id / git-SHA release)', () => {
    const out = scrubEvent({
      event_id: 'fc6d8c0c43fc4630ad850ee518f1b9d0', // 32-char hex
      timestamp: 1719600000,
      level: 'error',
      platform: 'javascript',
      release: GIT_SHA, // 40-char git SHA
      environment: 'production',
      dist: GIT_SHA,
      transaction: '/dashboard/reports',
      sdk: { name: 'sentry.javascript.nextjs', version: '7.118.0' },
    } as unknown as SentryLikeEvent);
    const o = out as Record<string, unknown>;
    expect(o.event_id).toBe('fc6d8c0c43fc4630ad850ee518f1b9d0');
    expect(o.timestamp).toBe(1719600000);
    expect(o.level).toBe('error');
    expect(o.platform).toBe('javascript');
    expect(o.release).toBe(GIT_SHA);
    expect(o.environment).toBe('production');
    expect(o.dist).toBe(GIT_SHA);
    expect(o.transaction).toBe('/dashboard/reports');
    expect((o.sdk as Record<string, unknown>).version).toBe('7.118.0');
  });

  it('still catches a secret hidden in a safe-scalar field (high-confidence rules)', () => {
    // skipGenericHex must NOT exempt a JWT smuggled into `release`
    const out = scrubEvent({ release: JWT } as unknown as SentryLikeEvent);
    expect((out as Record<string, unknown>).release).toBe(REDACTED);
  });

  it('does not mutate an event with threads + unknown fields', () => {
    const ev = {
      threads: { values: [{ stacktrace: { frames: [{ vars: { token: JWT } }] } }] },
      server_name: JWT,
      custom: { x: JWT },
    } as unknown as SentryLikeEvent;
    const before = JSON.stringify(ev);
    scrubEvent(ev);
    expect(JSON.stringify(ev)).toBe(before);
  });
});

// ── FIX 2: SAFE_TAG values exempt from the generic-hex rule only ───────────────
describe('scrubTags — generic-hex exemption (FIX 2)', () => {
  it('keeps a 40-char git-SHA release tag intact (release correlation)', () => {
    const out = scrubTags({ release: GIT_SHA });
    expect(out.release).toBe(GIT_SHA);
  });

  it('still redacts high-confidence secrets in an allowlisted tag value', () => {
    expect(scrubTags({ release: JWT }).release).toBe(REDACTED);
    expect(scrubTags({ tenant_id: SB_SECRET }).tenant_id).toBe(REDACTED);
    expect(scrubTags({ route: `Bearer ${JWT}` }).route).toBe(REDACTED);
    expect(scrubTags({ screen: EMAIL }).screen).toBe(REDACTED);
  });

  it('exemption is scoped to tags: redactValue still kills a 40-hex elsewhere', () => {
    expect(redactValue(GIT_SHA)).toBe(REDACTED);
    expect(redactValue({ note: GIT_SHA })).toEqual({ note: REDACTED });
  });

  it('GENERIC_HEX_PATTERN and PHONE_PATTERN are non-global (stateless .test)', () => {
    expect(GENERIC_HEX_PATTERN.global).toBe(false);
    expect(PHONE_PATTERN.global).toBe(false);
    expect(SENSITIVE_VALUE_PATTERNS).toContain(GENERIC_HEX_PATTERN);
    expect(SENSITIVE_VALUE_PATTERNS).toContain(PHONE_PATTERN);
  });
});

// ── FIX 3: bare phone-number value pattern ────────────────────────────────────
describe('phone-number value pattern (FIX 3)', () => {
  it.each([
    ['E.164 with +', '+201001234567'],
    ['+ with spaces', '+20 100 123 4567'],
    ['+ with dashes', '+20-100-123-4567'],
    ['bare 12-digit run', '201001234567'],
  ])('redacts a bare phone (%s)', (_label, phone) => {
    expect(redactValue(phone)).toBe(REDACTED);
  });

  it('redacts a phone embedded in free text under a NON-sensitive key', () => {
    const out = redactValue({ note: 'please call +201001234567 after 6pm' });
    expect((out as Record<string, unknown>).note).toBe(REDACTED);
  });

  it('redacts a phone inside an event message / breadcrumb', () => {
    const ev = scrubEvent({ message: 'walk-in left number +201001234567' });
    expect(ev.message).toBe(REDACTED);
    const crumb = scrubBreadcrumb({ category: 'ui', message: 'rang +201001234567' });
    expect(crumb!.message).toBe(REDACTED);
  });

  it.each([
    ['short id', '12345'],
    ['4-digit', '4242'],
    ['version string', '2.0.0'],
    ['ISO date', '2026-06-29'],
    ['device label', 'device-7'],
    ['7-digit (below threshold)', '1234567'],
  ])('does NOT redact a non-phone numeric value (%s)', (_label, val) => {
    expect(redactValue(val)).toBe(val);
  });

  it('leaves small numbers and order ids untouched in objects', () => {
    const out = redactValue({ order_no: '4231', qty: 6, lineno: 42 });
    expect(out).toEqual({ order_no: '4231', qty: 6, lineno: 42 });
  });
});
