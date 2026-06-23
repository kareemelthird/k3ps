/**
 * Auth API — Supabase email/password sign-in/out + session restore.
 * Branch membership resolution. Tenant identity from JWT app_metadata claim only.
 */
import { useQuery } from '@tanstack/react-query';
import type { Branch } from '@ps/core';

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

/** Resolve the rate rule snapshot for open-meter sessions (minimal for Phase 3). */
export async function resolveOpenRate(
  tenantId: string,
  deviceType: string,
  playMode: 'single' | 'multi',
  atIso: string,
): Promise<{ pricePerHour: number; ruleId: string | null }> {
  // Minimal Phase-3 rule lookup: find highest-priority active open rule for this device_type
  const { data } = await supabase
    .from('rate_rules')
    .select('id, price_per_hour, priority')
    .eq('tenant_id', tenantId)
    .eq('billing_mode', 'open')
    .eq('is_active', true)
    .in('device_type', [deviceType, 'any'])
    .in('play_mode', [playMode, 'any'])
    .order('priority', { ascending: false })
    .limit(1)
    .single();

  if (!data) return { pricePerHour: 0, ruleId: null };

  return {
    pricePerHour: (data.price_per_hour as number | null) ?? 0,
    ruleId: data.id as string,
  };
}
