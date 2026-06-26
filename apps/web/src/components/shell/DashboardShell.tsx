'use client';

/**
 * DashboardShell — owner dashboard shell for Phase 3.
 * Resolves branches from the active tenant (JWT claim → RLS-scoped query).
 * Persists active branch in localStorage.
 * Never queries cross-tenant; tenant_id always comes from the signed claim.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { getBrowserClient } from '@/lib/supabase/client';
import { TopBar } from './TopBar';
import { OwnerDevicesView } from '@/components/devices/OwnerDevicesView';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import type { Branch } from '@ps/core';

const BRANCH_STORAGE_KEY = 'ps_active_branch_id';

export function DashboardShell() {
  const t = useTranslations();
  const { claim, loading: authLoading } = useAuth();
  const router = useRouter();

  const [branches, setBranches] = useState<Branch[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState<string | null>(null);

  // Redirect to login if no auth claim
  useEffect(() => {
    if (!authLoading && !claim) {
      router.replace('/login');
    }
  }, [authLoading, claim, router]);

  const fetchBranches = useCallback(async () => {
    if (!claim) return;
    setBranchesLoading(true);
    setBranchesError(null);
    try {
      const supabase = getBrowserClient();
      // RLS ensures only this tenant's branches are returned.
      // We additionally filter by tenant_id defensively.
      const { data, error } = await supabase
        .from('branches')
        .select('*')
        .eq('tenant_id', claim.tenant_id)
        .eq('is_active', true)
        .order('name', { ascending: true });

      if (error) throw error;
      const rows = (data as Branch[]) ?? [];
      setBranches(rows);

      // Restore or auto-select branch
      const stored = localStorage.getItem(BRANCH_STORAGE_KEY);
      const storedValid = stored && rows.some((b) => b.id === stored);
      if (storedValid) {
        setActiveBranchId(stored);
      } else if (rows.length === 1 && rows[0]) {
        // Single branch → auto-select (AC 7)
        setActiveBranchId(rows[0].id);
        localStorage.setItem(BRANCH_STORAGE_KEY, rows[0].id);
      }
    } catch (err) {
      setBranchesError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBranchesLoading(false);
    }
  }, [claim]);

  useEffect(() => {
    void fetchBranches();
  }, [fetchBranches]);

  function handleBranchSelect(id: string | null) {
    setActiveBranchId(id);
    if (id) localStorage.setItem(BRANCH_STORAGE_KEY, id);
    else localStorage.removeItem(BRANCH_STORAGE_KEY);
  }

  const activeBranch = branches.find((b) => b.id === activeBranchId);

  if (authLoading) {
    return (
      <div className="min-h-dvh bg-bg flex items-center justify-center">
        <div className="text-text-muted text-label">{t('state.loading')}</div>
      </div>
    );
  }

  if (!claim) return null; // Redirecting

  return (
    <div className="min-h-dvh bg-bg text-text">
      <TopBar
        tenantName={claim.tenant_id ?? undefined}
        branches={branches}
        activeBranchId={activeBranchId}
        onBranchSelect={handleBranchSelect}
        branchesLoading={branchesLoading}
      />

      <main
        id="main-content"
        tabIndex={-1}
        className="max-w-7xl mx-auto px-xl py-2xl"
      >
        {branchesError && (
          <ErrorState message={branchesError} onRetry={fetchBranches} />
        )}

        {!branchesError && !branchesLoading && branches.length === 0 && (
          <EmptyState
            title={t('branch.empty.title')}
            body={t('branch.empty.body')}
          />
        )}

        {!branchesError && !branchesLoading && branches.length > 0 && !activeBranchId && (
          <EmptyState
            title={t('branch.choose.title')}
            body={t('branch.label')}
          />
        )}

        {activeBranchId && claim && claim.tenant_id && (
          <OwnerDevicesView
            key={activeBranchId}
            branchId={activeBranchId}
            tenantId={claim.tenant_id}
          />
        )}
      </main>
    </div>
  );
}
