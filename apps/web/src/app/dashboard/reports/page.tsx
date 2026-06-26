'use client';

/**
 * /dashboard/reports — owner-only analytics page (Phase 6, ADR-0007).
 *
 * Role gate: `owner` or `super_admin` claim required.
 *   - No claim → redirect to /login (handled by DashboardPageShell and below).
 *   - Non-owner claim → DeniedState (role boundary CLAUDE.md §5).
 *
 * Security:
 *   - All data access flows through signed JWT claim + RLS + RPC owner-gate.
 *   - No service-role key. No client-supplied tenant_id.
 *   - Branch filter is UX convenience; security is enforced server-side.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { DashboardPageShell } from '@/components/shell/DashboardPageShell';
import { DeniedState } from '@/components/reports/DeniedState';
import { ReportsView } from '@/components/reports/ReportsView';

export default function ReportsPage() {
  const { claim, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !claim) {
      router.replace('/login');
    }
  }, [loading, claim, router]);

  if (loading || !claim) {
    // DashboardPageShell handles the auth-loading skeleton; return null here.
    return null;
  }

  // Role gate: owner or super_admin only (CLAUDE.md §5 / design §2).
  // ADR-0008 Decision Q3: roles is scalar — use === not .includes() (fail-closed).
  const isOwner = claim.roles === 'owner' || claim.is_super_admin;

  return (
    <DashboardPageShell>
      {isOwner ? <ReportsView /> : <DeniedState />}
    </DashboardPageShell>
  );
}
