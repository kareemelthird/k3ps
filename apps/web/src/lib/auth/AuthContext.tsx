'use client';

/**
 * AuthContext — wraps the Supabase client session for the browser.
 *
 * Tenant identity is read from the signed `app_metadata` JWT claim
 * (set by the custom-access-token-hook). NEVER read from client input.
 * Per CLAUDE.md §5 and ADR-0003.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getBrowserClient } from '@/lib/supabase/client';

// ── Claim shape (ADR-0003) ─────────────────────────────────────────────────

export interface TenantClaim {
  tenant_id: string;
  roles: string[];
  is_super_admin: boolean;
}

function parseTenantClaim(user: User | null): TenantClaim | null {
  if (!user) return null;
  const meta = user.app_metadata as Record<string, unknown> | undefined;
  if (!meta) return null;
  const tenant_id = typeof meta['tenant_id'] === 'string' ? meta['tenant_id'] : null;
  if (!tenant_id) return null;
  const roles = Array.isArray(meta['roles']) ? (meta['roles'] as string[]) : [];
  const is_super_admin = meta['is_super_admin'] === true;
  return { tenant_id, roles, is_super_admin };
}

// ── Context type ───────────────────────────────────────────────────────────

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  claim: TenantClaim | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let supabase: ReturnType<typeof getBrowserClient>;
    try {
      supabase = getBrowserClient();
    } catch {
      // Env not configured — skip
      setLoading(false);
      return;
    }

    // Restore persisted session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  const signIn = useCallback(
    async (email: string, password: string): Promise<{ error: string | null }> => {
      try {
        const supabase = getBrowserClient();
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return { error: error.message };
        return { error: null };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Unknown error' };
      }
    },
    [],
  );

  const signOut = useCallback(async () => {
    try {
      const supabase = getBrowserClient();
      await supabase.auth.signOut();
    } catch {
      // ignore
    }
  }, []);

  const claim = parseTenantClaim(user);

  return (
    <AuthContext.Provider value={{ session, user, claim, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
