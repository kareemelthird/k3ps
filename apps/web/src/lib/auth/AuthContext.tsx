'use client';

/**
 * AuthContext — wraps the Supabase client session for the browser.
 *
 * Tenant identity is read from the signed `app_metadata` JWT claim
 * (set by the custom-access-token-hook). NEVER read from client input.
 * Per CLAUDE.md §5, ADR-0003, ADR-0008 Decision Q3.
 *
 * ADR-0008 Decision Q3 — roles claim shape (fail-closed):
 *   `roles` is a SCALAR string ∈ {'owner','manager','staff'}.
 *   Any array / unknown / null → no role (treated as denied).
 *   A legacy array-shaped claim therefore maps to null → least privilege.
 *
 * Impersonation fields (ADR-0008):
 *   `impersonator_id` — set when a super-admin is impersonating a tenant.
 *   `impersonation_exp` — ISO expiry timestamp for the active impersonation.
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

// ── Claim shape (ADR-0003, ADR-0008) ──────────────────────────────────────

/** Valid scalar role values per ADR-0008 Decision Q3. */
const VALID_ROLES = new Set(['owner', 'manager', 'staff']);

export interface TenantClaim {
  /** The tenant this session is scoped to. Null for a pure super-admin (not impersonating). */
  tenant_id: string | null;
  /**
   * Scalar role within tenant_id. ADR-0008 Decision Q3: ONLY an exact match to
   * 'owner'|'manager'|'staff' is accepted. Any array/unknown/null → null (fail-closed).
   */
  roles: string | null;
  /** True when the signed claim carries is_super_admin=true. */
  is_super_admin: boolean;
  /**
   * Set when a super-admin is actively impersonating this tenant.
   * Equals the super-admin's auth.uid() (never a tenant member id).
   */
  impersonator_id: string | null;
  /** ISO 8601 UTC timestamp: when the impersonation window closes. Null = not impersonating. */
  impersonation_exp: string | null;
  /**
   * Human-readable display name for the tenant being impersonated.
   * Provided by the auth hook alongside impersonator_id. Optional — absent for non-impersonation sessions.
   */
  tenant_name?: string;
}

/**
 * Parse the signed app_metadata claim from the Supabase user object.
 * Returns null when there is no usable identity (not logged in,
 * no tenant_id and not a super admin).
 */
function parseTenantClaim(user: User | null): TenantClaim | null {
  if (!user) return null;
  const meta = user.app_metadata as Record<string, unknown> | undefined;
  if (!meta) return null;

  const is_super_admin = meta['is_super_admin'] === true;
  const tenant_id =
    typeof meta['tenant_id'] === 'string' && meta['tenant_id'].length > 0
      ? meta['tenant_id']
      : null;

  // Fail-closed: must have at least one of tenant_id or is_super_admin.
  if (!tenant_id && !is_super_admin) return null;

  // ADR-0008 Decision Q3: scalar-text only; array/unknown/null → null (denied).
  const rawRoles = meta['roles'];
  const roles: string | null =
    typeof rawRoles === 'string' && VALID_ROLES.has(rawRoles) ? rawRoles : null;

  // Impersonation claim fields (ADR-0008 Decision Q1/Q2).
  const impersonator_id =
    typeof meta['impersonator_id'] === 'string' ? meta['impersonator_id'] : null;
  const impersonation_exp =
    typeof meta['impersonation_exp'] === 'string' ? meta['impersonation_exp'] : null;
  const tenant_name =
    typeof meta['tenant_name'] === 'string' && meta['tenant_name'].length > 0
      ? meta['tenant_name']
      : undefined;

  return { tenant_id, roles, is_super_admin, impersonator_id, impersonation_exp, tenant_name };
}

// ── Context type ───────────────────────────────────────────────────────────

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  claim: TenantClaim | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  /** Force-refresh the session so the hook re-stamps claims (e.g. after impersonation start/end). */
  refreshSession: () => Promise<void>;
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

  /**
   * Force a token refresh so the custom-access-token-hook re-stamps claims.
   * Called after impersonation start/end so the browser session picks up the
   * new tenant_id/impersonator_id claims (ADR-0008 Decision Q2).
   */
  const refreshSession = useCallback(async () => {
    try {
      const supabase = getBrowserClient();
      await supabase.auth.refreshSession();
      // onAuthStateChange listener above will update user/session state.
    } catch {
      // ignore — if refresh fails the user must re-login
    }
  }, []);

  const claim = parseTenantClaim(user);

  return (
    <AuthContext.Provider value={{ session, user, claim, loading, signIn, signOut, refreshSession }}>
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
