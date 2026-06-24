/**
 * Tests for id module — AC 13.
 * All AC references are from docs/specs/phase-2-tenant-foundation.md.
 */

import { uuidv4, uuidv5, PS_UUID_NS } from '../id/id';

// RFC 4122 v4 UUID pattern: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// RFC 4122 v5 UUID pattern: version nibble is 5, variant is [89ab].
const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('uuidv4', () => {
  test('AC 13a: returns a valid RFC-4122 v4 UUID string', () => {
    const id = uuidv4();
    expect(typeof id).toBe('string');
    expect(id).toMatch(UUID_V4_RE);
  });

  test('AC 13b: two calls return two distinct UUIDs', () => {
    const a = uuidv4();
    const b = uuidv4();
    expect(a).not.toBe(b);
  });

  test('returns version 4 UUID (version nibble is 4)', () => {
    const id = uuidv4();
    // 13th character (index 14) is the version nibble
    expect(id[14]).toBe('4');
  });

  test('returns valid variant (2 MSBs of clock_seq are 10)', () => {
    const id = uuidv4();
    // 17th character (index 19) is the variant nibble
    const variantChar = id[19]?.toLowerCase() ?? '';
    expect(['8', '9', 'a', 'b']).toContain(variantChar);
  });

  test('generates 100 unique UUIDs (collision-free at café scale)', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuidv4()));
    expect(ids.size).toBe(100);
  });

  // ─── Fallback paths (RNG without crypto.randomUUID, and no crypto at all) ─────

  describe('fallback paths', () => {
    const realCrypto = (globalThis as { crypto?: unknown }).crypto;
    afterEach(() => {
      (globalThis as { crypto?: unknown }).crypto = realCrypto;
    });

    test('uses getRandomValues when randomUUID is unavailable', () => {
      (globalThis as { crypto?: unknown }).crypto = {
        getRandomValues: (arr: Uint8Array) => {
          for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) & 0xff;
          return arr;
        },
      };
      const id = uuidv4();
      expect(id).toMatch(UUID_V4_RE);
      // version + variant bits enforced even on the manual byte path
      expect(id[14]).toBe('4');
      expect(['8', '9', 'a', 'b']).toContain(id[19]?.toLowerCase() ?? '');
    });

    test('falls back to Math.random when no crypto is present', () => {
      (globalThis as { crypto?: unknown }).crypto = undefined;
      const id = uuidv4();
      expect(id).toMatch(UUID_V4_RE);
      // distinct across draws on the Math.random path
      expect(uuidv4()).not.toBe(id);
    });
  });
});

describe('uuidv5 (deterministic, name-based — underpins idempotent upserts)', () => {
  // Canonical RFC-4122 published known-answer vector: applying the DNS namespace
  // to "www.example.com" must yield exactly this v5 UUID. This proves the pure-JS
  // SHA-1 + byte layout matches a real RFC v5 implementation (any drift here would
  // silently change row ids and break idempotency).
  const DNS_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  test('matches the canonical RFC v5 known-answer vector (DNS / www.example.com)', () => {
    expect(uuidv5('www.example.com', DNS_NS)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  test('returns a well-formed v5 UUID (version 5, variant 10xx)', () => {
    const id = uuidv5('close:abc', PS_UUID_NS);
    expect(id).toMatch(UUID_V5_RE);
    expect(id[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(id[19]?.toLowerCase() ?? '');
  });

  test('is deterministic: same name + namespace always yields the same id', () => {
    // This is the property that makes a retried close/switch upsert update-in-place.
    expect(uuidv5('close:session-1', PS_UUID_NS)).toBe(uuidv5('close:session-1', PS_UUID_NS));
    expect(uuidv5('seg:session-1:2026-06-24T18:00:00.000Z', PS_UUID_NS)).toBe(
      uuidv5('seg:session-1:2026-06-24T18:00:00.000Z', PS_UUID_NS),
    );
  });

  test('different names produce different ids (no row-key collisions across keys)', () => {
    const a = uuidv5('close:session-1', PS_UUID_NS);
    const b = uuidv5('close:session-2', PS_UUID_NS);
    const c = uuidv5('seg:session-1:2026-06-24T18:00:00.000Z', PS_UUID_NS);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test('same name under different namespaces produces different ids', () => {
    expect(uuidv5('www.example.com', DNS_NS)).not.toBe(uuidv5('www.example.com', PS_UUID_NS));
  });

  test('handles non-ASCII (UTF-8) names deterministically', () => {
    // Arabic device/session keys must hash stably through the UTF-8 encoder.
    const k = 'إغلاق:جلسة-١';
    expect(uuidv5(k, PS_UUID_NS)).toBe(uuidv5(k, PS_UUID_NS));
    expect(uuidv5(k, PS_UUID_NS)).toMatch(UUID_V5_RE);
  });

  test('PS_UUID_NS is a valid, frozen UUID string', () => {
    // Changing this constant would invalidate every existing deterministic id.
    expect(PS_UUID_NS).toBe('1b5f4b3c-8e6a-5b2d-9c4f-3a7e2d1f8b5c');
  });
});
