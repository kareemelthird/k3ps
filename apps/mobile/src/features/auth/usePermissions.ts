/**
 * useMyPermissions — permission-aware hook for the logged-in staff member.
 *
 * ADR-0012 Decision B1: permissions are NOT in the JWT claim (that would bloat
 * the token and require a refresh on every change). Instead, we query
 * tenant_members for role + permissions at login time and cache for 5 minutes.
 * A permission change takes effect on the next refetch — no token refresh needed.
 *
 * Resolution rules (mirror has_permission() SQL helper exactly):
 *   role='owner'  → all flags true unconditionally.
 *   Active staff, absent flag → true (permissive default).
 *   Active staff, explicit false → false.
 *   Query error / not-yet-loaded → all true (permissive default).
 *     The server RLS / has_permission() is the authoritative enforcement gate.
 *
 * Cache: TanStack Query staleTime 5 min (refetches on focus / reconnect per
 * default TanStack behaviour). Query key includes tenantId + userId so a
 * branch switch or sign-in as a different user busts the cache automatically.
 *
 * Gate pattern (caller):
 *   const perms = useMyPermissions();
 *   // UI gate (not the authority — server is):
 *   if (!perms.can('can_void')) { ... }
 *   // Slice 3 debt gate point (not yet wired — leave for Slice 3):
 *   // if (!perms.can('can_manage_debts')) { ... }
 */
import { useQuery } from '@tanstack/react-query';
import {
  resolveStaffPermissions,
  hasPermission,
  type ResolvedPermissions,
  type StaffPermissionKey,
} from '@ps/core';

import { supabase } from '../../lib/supabase';
import { useAuth } from '../../stores/useAuth';

/** Permissive sentinel returned while loading or when the query errors. */
const ALL_ALLOWED: ResolvedPermissions = {
  can_restock:      true,
  can_void:         true,
  can_manage_debts: true,
  can_discount:     true,
};

export interface UseMyPermissionsResult {
  resolved: ResolvedPermissions;
  /**
   * Whether the permissions query is in-flight for the first time.
   * Callers should not gate hard on this — the permissive default applies
   * during loading so the UI stays responsive.
   */
  isLoading: boolean;
  /** Convenience: check a single permission key on the resolved set. */
  can: (key: StaffPermissionKey) => boolean;
}

/**
 * Returns the resolved permissions for the logged-in user in their active
 * tenant. Queries tenant_members — NOT the JWT claim (ADR-0012 Decision B1).
 */
export function useMyPermissions(): UseMyPermissionsResult {
  const { claim, user } = useAuth();
  const tenantId = claim?.tenant_id ?? null;
  const userId   = user?.id ?? null;

  const { data: resolved = ALL_ALLOWED, isLoading } = useQuery({
    queryKey: ['my-permissions', tenantId, userId],
    enabled: Boolean(tenantId && userId),
    staleTime: 5 * 60 * 1000, // 5 minutes — ADR-0012 B1 requirement
    queryFn: async (): Promise<ResolvedPermissions> => {
      const { data, error } = await supabase
        .from('tenant_members')
        .select('role, permissions')
        .eq('tenant_id', tenantId!)
        .eq('profile_id', userId!)
        .eq('is_active', true)
        .single();

      if (error || !data) {
        // Permissive fallback: cannot confirm restrictions → don't block the UI.
        // The server RLS + has_permission() SQL helper is the authoritative gate.
        return ALL_ALLOWED;
      }

      const row = data as { role: string; permissions: Record<string, unknown> | null };
      return resolveStaffPermissions(row.role, row.permissions);
    },
  });

  return {
    resolved,
    isLoading,
    can: (key: StaffPermissionKey) => hasPermission(resolved, key),
  };
}
