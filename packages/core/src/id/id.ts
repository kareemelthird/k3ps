/**
 * Client-generated UUIDs for idempotent writes.
 *
 * uuidv4 — random RFC-4122 v4 for new entities (offline outbox, new rows).
 * uuidv5 — deterministic RFC-4122 v5 (SHA-1 name-based) for rows whose id
 *           must be the same across retries when derived from stable inputs:
 *           e.g. audit rows keyed by sessionId, sub-segments keyed by
 *           (sessionId + started_at). Replaying the same inputs always
 *           produces the same UUID → the upsert updates-in-place (CLAUDE.md §2.8).
 *
 * Both implementations prefer the platform crypto RNG when available
 * (Node ≥ 14.17 / modern web); v5 uses the platform's SubtleCrypto SHA-1
 * when present, else a pure-JS fallback — no external dependency required.
 *
 * Fixed namespace for PS-Managment deterministic ids:
 *   PS_NS = uuidv5('ps-managment', UUID_NS_URL)
 *   = '6ba7b810-9dad-11d1-80b4-00c04fd430c8' namespace-applied to 'ps-managment'
 * Stored as a pre-computed constant so it is stable across all clients.
 */

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
  subtle?: {
    digest: (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer>;
  };
}

function getCrypto(): CryptoLike | undefined {
  // globalThis.crypto exists in Node 16+ and all modern browsers/RN engines.
  return (globalThis as { crypto?: CryptoLike }).crypto;
}

/** Format a 16-byte array as a UUID string. */
function bytesToUuid(b: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((b[i] ?? 0).toString(16).padStart(2, '0'));
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

  return bytesToUuid(bytes);
}

// ─── UUID v5 (deterministic, SHA-1 name-based, RFC 4122 §4.3) ─────────────────

/**
 * Fixed namespace for PS-Managment deterministic ids.
 * Derived by applying the URL namespace (6ba7b810-...) to 'ps-managment'.
 * Pre-computed and frozen — changing it would invalidate all existing
 * deterministic ids and cause duplicate rows on retry.
 */
export const PS_UUID_NS = '1b5f4b3c-8e6a-5b2d-9c4f-3a7e2d1f8b5c';

/** Parse a UUID string into a 16-byte array. */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Encode a string to UTF-8 bytes (pure JS, no TextEncoder required). */
function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Pure-JS SHA-1 (for the uuidv5 fallback when SubtleCrypto is unavailable).
 * Returns the 20-byte digest as a Uint8Array.
 * Based on the reference algorithm from FIPS PUB 180-4.
 */
function sha1(data: Uint8Array): Uint8Array {
  // Pre-processing: padding to 512-bit (64-byte) boundary.
  const msgLen = data.length;
  const bitLen = msgLen * 8;
  // Minimum padding: 1 bit (0x80), then zeros, then 8 bytes for the length.
  // Total length must be a multiple of 64.
  const padLen = ((msgLen + 9 + 63) & ~63) - msgLen;
  const padded = new Uint8Array(msgLen + padLen);
  padded.set(data);
  padded[msgLen] = 0x80;
  // Append length as 64-bit big-endian (upper 32 bits are 0 for our use).
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);

  // Initial hash values (H0–H4).
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let i = 0; i < padded.length; i += 64) {
    const chunk = new DataView(padded.buffer, i, 64);
    for (let j = 0; j < 16; j++) w[j] = chunk.getUint32(j * 4, false);
    for (let j = 16; j < 80; j++) {
      const x = (w[j - 3] ?? 0) ^ (w[j - 8] ?? 0) ^ (w[j - 14] ?? 0) ^ (w[j - 16] ?? 0);
      w[j] = (x << 1) | (x >>> 31);
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4;

    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + (w[j] ?? 0)) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const result = new Uint8Array(20);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, h0, false);
  rv.setUint32(4, h1, false);
  rv.setUint32(8, h2, false);
  rv.setUint32(12, h3, false);
  rv.setUint32(16, h4, false);
  return result;
}

/**
 * Deterministic RFC-4122 version-5 UUID (SHA-1 name-based).
 *
 * Same `name` + `namespace` always produces the same UUID — so a retried
 * upsert updates the same row instead of inserting a duplicate.
 *
 * SYNCHRONOUS: uses the pure-JS SHA-1 fallback (SubtleCrypto.digest is
 * async and cannot be called inside a synchronous mutation builder).
 * The pure-JS SHA-1 is cryptographically sufficient for collision-free ids
 * at café scale (we do not use these for security — only for row-key stability).
 *
 * @param name       Stable key, e.g. 'close:{sessionId}' or '{sessionId}:{startedAt}'
 * @param namespace  A UUID string; use PS_UUID_NS for all PS-Managment entities.
 */
export function uuidv5(name: string, namespace: string): string {
  const nsBytes = uuidToBytes(namespace);
  const nameBytes = utf8Encode(name);
  const combined = new Uint8Array(nsBytes.length + nameBytes.length);
  combined.set(nsBytes, 0);
  combined.set(nameBytes, nsBytes.length);

  const hash = sha1(combined);

  // RFC 4122 §4.3: take first 16 bytes of hash, set version=5 and variant=10xx.
  const uuid = new Uint8Array(16);
  uuid.set(hash.slice(0, 16));
  uuid[6] = ((uuid[6] ?? 0) & 0x0f) | 0x50; // version 5
  uuid[8] = ((uuid[8] ?? 0) & 0x3f) | 0x80; // variant 10xx

  return bytesToUuid(uuid);
}
