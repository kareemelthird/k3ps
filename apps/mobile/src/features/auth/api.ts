/**
 * Auth API — Supabase email/password sign-in/out + session restore.
 * Branch membership resolution. Tenant identity from JWT app_metadata claim only.
 */
import { useQuery } from '@tanstack/react-query';
import type { BillingMode, Branch, PlayMode, RateRule } from '@ps/core';
import { resolveRule } from '@ps/core';

import { supabase } from '../../lib/supabase';

export function useBranches(tenantId: string | null) {
  return useQuery({
    queryKey: ['branches', tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<Branch[]> => {
      const { data, error } = await supabase
        .from('branches')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('name', { ascending: true });

      if (error) throw error;
      return data as Branch[];
    },
    staleTime: 60_000,
  });
}

/** Sign in and return the session; the auth store listens to onAuthStateChange. */
export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

/** Sign out. */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * Fetch all active rate rules for the tenant and resolve the best one for the
 * given context using @ps/core resolveRule (highest-priority, id tie-break,
 * Cairo day-type + time window). Returns all rules so the caller can pass them
 * to planSegments / boundary enumeration.
 *
 * Phase 4: replaces the Phase-3 resolveOpenRate single-query shortcut.
 */
export async function fetchAndResolveRule(
  tenantId: string,
  deviceType: string,
  playMode: PlayMode,
  billingMode: BillingMode,
  atIso: string,
): Promise<{
  pricePerHour: number;
  ruleId: string | null;
  rule: RateRule | null;
  allRules: RateRule[];
}> {
  const { data, error } = await supabase
    .from('rate_rules')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('priority', { ascending: false });

  if (error || !data) {
    return { pricePerHour: 0, ruleId: null, rule: null, allRules: [] };
  }

  const allRules = data as RateRule[];
  const rule = resolveRule(allRules, {
    device_type: deviceType,
    play_mode: playMode,
    billing_mode: billingMode,
    at_iso: atIso,
  });

  return {
    pricePerHour: rule?.price_per_hour ?? 0,
    ruleId: rule?.id ?? null,
    rule: rule ?? null,
    allRules,
  };
}

/**
 * Phase-3 compat: resolve the rate rule snapshot for open-meter sessions.
 * @deprecated Use fetchAndResolveRule for Phase-4 multi-mode support.
 */
export async function resolveOpenRate(
  tenantId: string,
  deviceType: string,
  playMode: 'single' | 'multi',
  atIso: string,
): Promise<{ pricePerHour: number; ruleId: string | null }> {
  const result = await fetchAndResolveRule(
    tenantId,
    deviceType,
    playMode,
    'open',
    atIso,
  );
  return { pricePerHour: result.pricePerHour, ruleId: result.ruleId };
}
