/**
 * Auth store — resolves identity from the signed JWT app_metadata claim.
 * Tenant/role are NEVER taken from client input; they come from the verified
 * JWT claim stamped by the Custom Access Token Hook (ADR-0003).
 * Branch selection is local state, persisted to AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session, User } from '@supabase/supabase-js';
import { create } from 'zustand';

import type { Role } from '@ps/core';

const ACTIVE_BRANCH_KEY = 'ps.activeBranchId.v1';

export interface AuthClaim {
  tenant_id: string;
  roles: string[];
  is_super_admin: boolean;
}

export interface AuthState {
  /** Raw Supabase session (null = unauthenticated). */
  session: Session | null;
  user: User | null;
  /** Parsed claim from app_metadata — the ONLY source of tenant identity. */
  claim: AuthClaim | null;
  /** Effective role: highest of the claim roles for this tenant. */
  role: Role | null;
  /** Active branch ID, persisted locally. */
  activeBranchId: string | null;
  /** Whether the initial session restore has been attempted. */
  isReady: boolean;

  // Actions
  setSession: (session: Session | null) => void;
  setActiveBranch: (branchId: string | null) => Promise<void>;
  restoreActiveBranch: () => Promise<void>;
  signOut: () => Promise<void>;
}

function parseClaim(user: User | null): AuthClaim | null {
  if (!user) return null;
  const meta = user.app_metadata as Record<string, unknown> | undefined;
  if (!meta?.tenant_id) return null;
  return {
    tenant_id: meta.tenant_id as string,
    roles: Array.isArray(meta.roles) ? (meta.roles as string[]) : [],
    is_super_admin: Boolean(meta.is_super_admin),
  };
}

function resolveRole(claim: AuthClaim | null): Role | null {
  if (!claim) return null;
  if (claim.is_super_admin) return 'super_admin';
  if (claim.roles.includes('owner')) return 'owner';
  if (claim.roles.includes('manager')) return 'manager';
  if (claim.roles.includes('staff')) return 'staff';
  return null;
}

export const useAuth = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  claim: null,
  role: null,
  activeBranchId: null,
  isReady: false,

  setSession: (session) => {
    const user = session?.user ?? null;
    const claim = parseClaim(user);
    const role = resolveRole(claim);
    set({ session, user, claim, role, isReady: true });
  },

  setActiveBranch: async (branchId) => {
    set({ activeBranchId: branchId });
    if (branchId) {
      await AsyncStorage.setItem(ACTIVE_BRANCH_KEY, branchId);
    } else {
      await AsyncStorage.removeItem(ACTIVE_BRANCH_KEY);
    }
  },

  restoreActiveBranch: async () => {
    try {
      const stored = await AsyncStorage.getItem(ACTIVE_BRANCH_KEY);
      if (stored) set({ activeBranchId: stored });
    } catch {
      // Ignore storage errors on restore
    }
  },

  signOut: async () => {
    set({
      session: null,
      user: null,
      claim: null,
      role: null,
      activeBranchId: null,
    });
    await AsyncStorage.removeItem(ACTIVE_BRANCH_KEY);
  },
}));
