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
import type { Branch } from '@ps/core';
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

  useEffect(() => {
    void fetchBranches();
  }, [fetchBranches]);

  if (authLoading) {
    return (
      <div className="min-h-dvh bg-bg flex items-center justify-center">
        <div className="text-text-muted text-label">{t('state.loading')}</div>
      </div>
    );
  }

  if (!claim) return null;

  return (
    <div className="min-h-dvh bg-bg text-text">
      <TopBarSimple
        tenantName={claim.tenant_id ?? undefined}
        branches={branches}
        activeBranchId={activeBranchId}
        onBranchSelect={(id) => setActiveBranchId(id)}
      />
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
