/**
 * Server-side Supabase client (cookie-based auth via @supabase/ssr).
 *
 * Used in Server Components and Route Handlers. The client reads the
 * auth cookie set by the browser client and issues requests under the
 * signed JWT — so RLS sees the correct tenant_id claim.
 *
 * CRITICAL: Make data pages dynamic (export const dynamic = 'force-dynamic')
 * so Next.js does NOT try to SSG them at build time without a live DB.
 */
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';

type CookieToSet = { name: string; value: string; options?: Partial<ResponseCookie> };

export async function getServerClient() {
  const cookieStore = await cookies();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Supabase env vars not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // setAll called from a Server Component — cookies are read-only here.
          // The middleware handles session refresh.
        }
      },
    },
  });
}
