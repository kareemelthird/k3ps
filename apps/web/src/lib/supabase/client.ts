/**
 * Browser-side Supabase client.
 *
 * CRITICAL: Lazy-initialised so `next build` succeeds without live env vars.
 * Never call this at module-import time (no top-level await of data).
 * RLS is enforced by the signed JWT claim — never bypass tenant scoping here.
 */
import { createBrowserClient } from '@supabase/ssr';

let _client: ReturnType<typeof createBrowserClient> | null = null;

export function getBrowserClient() {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // Build-time or missing env — return a stub that callers can detect
    throw new Error(
      'Supabase env vars not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }

  _client = createBrowserClient(url, anonKey);
  return _client;
}
