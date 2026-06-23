/**
 * Client-generated UUID v4 so a row created offline already has a valid
 * Postgres `uuid` primary key before it reaches the server. This is what makes
 * mutations idempotent (client UUID + upsert) and the offline outbox safe
 * against double-counting on retry (CLAUDE.md §2.8).
 *
 * Prefers the platform crypto RNG when available (Node ≥ 14.17 / modern web)
 * for a high-quality, RFC-4122-compliant value; falls back to `Math.random`,
 * which is sufficient for collision-free ids at café scale.
 */

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

function getCrypto(): CryptoLike | undefined {
  // globalThis.crypto exists in Node 16+ and all modern browsers/RN engines.
  return (globalThis as { crypto?: CryptoLike }).crypto;
}

/** A random RFC-4122 version-4 UUID string. */
export function uuidv4(): string {
  const c = getCrypto();
  if (c?.randomUUID) return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Per RFC 4122 §4.4: set version (4) and variant (10xx) bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}
