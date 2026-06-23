/**
 * Tests for id module — AC 13.
 * All AC references are from docs/specs/phase-2-tenant-foundation.md.
 */

import { uuidv4 } from '../id/id';

// RFC 4122 v4 UUID pattern: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
