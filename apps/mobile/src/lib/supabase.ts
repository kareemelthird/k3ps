/**
 * Supabase client — lazy-initialised so that importing this module in CI/build
 * (where EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY are absent) does NOT crash.
 * The client is only constructed on first use; missing env vars throw then, not
 * at module load time (so `expo export` succeeds without live keys).
 *
 * SECURITY (Fix 6): auth session tokens are stored in expo-secure-store, NOT
 * AsyncStorage. expo-secure-store values have a ~2 KB limit per key, so long
 * session tokens are chunked across multiple entries and reassembled on read.
 * AsyncStorage is retained only for non-sensitive data (e.g. activeBranchId).
 */
import * as SecureStore from 'expo-secure-store';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ─── SecureStore-backed storage adapter ──────────────────────────────────────
// expo-secure-store limits each value to ~2048 bytes. Long JWT tokens (especially
// refresh tokens with claims) can exceed this. We chunk on write and reassemble
// on read using a manifest entry that records the chunk count.

const CHUNK_SIZE = 1800; // bytes; stay safely under 2048
const CHUNK_COUNT_SUFFIX = '__chunkCount';

function chunkString(value: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    chunks.push(value.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

const SecureStoreAdapter = {
  async getItem(key: string): Promise<string | null> {
    try {
      // Check for a chunked value first
      const countStr = await SecureStore.getItemAsync(key + CHUNK_COUNT_SUFFIX);
      if (countStr != null) {
        const count = parseInt(countStr, 10);
        const parts: string[] = [];
        for (let i = 0; i < count; i++) {
          const chunk = await SecureStore.getItemAsync(`${key}__chunk${i}`);
          if (chunk == null) return null; // corrupt — treat as missing
          parts.push(chunk);
        }
        return parts.join('');
      }
      // Non-chunked (short value written in one go)
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    try {
      if (value.length <= CHUNK_SIZE) {
        // Remove any old chunks before writing a single-chunk value
        await SecureStoreAdapter.removeItem(key);
        await SecureStore.setItemAsync(key, value);
      } else {
        // Remove any old plain entry and write in chunks
        try {
          await SecureStore.deleteItemAsync(key);
        } catch {
          // ignore
        }
        const chunks = chunkString(value);
        for (let i = 0; i < chunks.length; i++) {
          await SecureStore.setItemAsync(`${key}__chunk${i}`, chunks[i] ?? '');
        }
        await SecureStore.setItemAsync(key + CHUNK_COUNT_SUFFIX, String(chunks.length));
      }
    } catch {
      // SecureStore unavailable (e.g. simulator without hardware keystore) — fail silently;
      // the session will not persist across restarts but the app remains functional.
    }
  },

  async removeItem(key: string): Promise<void> {
    try {
      // Remove chunked entries if they exist
      const countStr = await SecureStore.getItemAsync(key + CHUNK_COUNT_SUFFIX);
      if (countStr != null) {
        const count = parseInt(countStr, 10);
        for (let i = 0; i < count; i++) {
          await SecureStore.deleteItemAsync(`${key}__chunk${i}`);
        }
        await SecureStore.deleteItemAsync(key + CHUNK_COUNT_SUFFIX);
      } else {
        await SecureStore.deleteItemAsync(key);
      }
    } catch {
      // ignore
    }
  },
};

// ─── Supabase client ──────────────────────────────────────────────────────────

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      '[supabase] EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set. ' +
        'Create apps/mobile/.env.local with these values.',
    );
  }

  _client = createClient(url, anonKey, {
    auth: {
      // SECURITY: auth tokens stored in SecureStore, not AsyncStorage
      storage: SecureStoreAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });

  return _client;
}

/** Supabase client proxy — access via `supabase.from(...)` etc. */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
