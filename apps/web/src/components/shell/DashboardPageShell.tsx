'use client';

/**
 * DashboardPageShell — shared layout for inner dashboard pages.
 *
 * Provides the TopBar (with sign-out) and a centered main content area.
 * Simpler than DashboardShell: no branch selection (rate-rules are tenant-scoped,
 * not branch-scoped per ADR-0004).
 *
 * RTL: dir="rtl" is set at the root HTML element (layout.tsx); this shell uses
 * only logical spacing (px-xl, py-2xl, max-w-7xl).
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/AuthContext';
import { TopBarSimple } from './TopBarSimple';
import { ReadOnlyModeBanner } from '@/components/billing/ReadOnlyModeBanner';
import type { Branch, SubscriptionSnapshot } from '@ps/core';
import { resolveEntitlement, DEFAULT_GRACE_DAYS } from '@ps/core';
import { getBrowserClient } from '@/lib/supabase/client';

interface DashboardPageShellProps {
  children: React.ReactNode;
}

export function DashboardPageShell({ children }: DashboardPageShellProps) {
  const t = useTranslations();
  const { claim, loading: authLoading } = useAuth();
  const router = useRouter();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [subSnapshot, setSubSnapshot] = useState<SubscriptionSnapshot | null | undefined>(undefined);

  useEffect(() => {
    if (!authLoading && !claim) {
      router.replace('/login');
    }
  }, [authLoading, claim, router]);

  const fetchBranches = useCallback(async () => {
    if (!claim) return;
    try {
      const supabase = getBrowserClient();
      const { data } = await supabase
        .from('branches')
        .select('*')
        .eq('tenant_id', claim.tenant_id)
        .eq('is_active', true)
        .order('name', { ascending: true });
      const rows = (data as Branch[]) ?? [];
      setBranches(rows);
    } catch {
      // Non-blocking: shell is layout-only
    }
  }, [claim]);

  const fetchSubscription = useCallback(async () => {
    if (!claim?.tenant_id) return;
    try {
      const supabase = getBrowserClient();
      const { data } = await supabase
        .from('subscriptions')
        .select('status, plan, comped, trial_end, current_period_end, cancel_at_period_end')
        .eq('tenant_id', claim.tenant_id)
        .single();
      if (data) {
        const row = data as {
          status: SubscriptionSnapshot['status'];
          plan: SubscriptionSnapshot['planKey'];
          comped: boolean;
          trial_end: string | null;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
        };
        setSubSnapshot({
          status: row.status,
          planKey: row.plan,
          comped: row.comped,
          trialEnd: row.trial_end,
          currentPeriodEnd: row.current_period_end,
          cancelAtPeriodEnd: row.cancel_at_period_end,
        });
      } else {
        setSubSnapshot(null);
      }
    } catch {
      // Non-blocking — missing sub → null (trialing fallback)
      setSubSnapshot(null);
    }
  }, [claim?.tenant_id]);

  useEffect(() => {
    void fetchBranches();
    void fetchSubscription();
  }, [fetchBranches, fetchSubscription]);

  if (authLoading) {
    return (
      <div className="min-h-dvh bg-bg flex items-center justify-center">
        <div className="text-text-muted text-label">{t('state.loading')}</div>
      </div>
    );
  }

  if (!claim) return null;

  // Resolve entitlement for banner — null plan def is safe (uses trial defaults)
  const nowIso = new Date().toISOString();
  const entitlement = subSnapshot !== undefined
    ? resolveEntitlement(subSnapshot, null, { graceDays: DEFAULT_GRACE_DAYS }, nowIso)
    : null;

  // Determine banner mode (undefined = still loading sub)
  const bannerMode: 'grace' | 'readOnly' | null =
    entitlement === null ? null
    : entitlement.isReadOnly ? 'readOnly'
    : (entitlement.status === 'past_due' && entitlement.graceUntil) ? 'grace'
    : null;

  const isOwner = claim.roles === 'owner' || (claim.is_super_admin ?? false);

  return (
    <div className="min-h-dvh bg-bg text-text">
      <TopBarSimple
        tenantName={claim.tenant_id ?? undefined}
        branches={branches}
        activeBranchId={activeBranchId}
        onBranchSelect={(id) => setActiveBranchId(id)}
      />
      {/* ReadOnly/Grace banner — appears between TopBar and content; always links to billing (AC 28) */}
      {bannerMode && (
        <ReadOnlyModeBanner
          mode={bannerMode}
          graceUntilIso={entitlement?.graceUntil}
          isOwner={isOwner}
        />
      )}
      <main
        id="main-content"
        tabIndex={-1}
        className="max-w-7xl mx-auto px-xl py-2xl"
      >
        {children}
      </main>
    </div>
  );
}
