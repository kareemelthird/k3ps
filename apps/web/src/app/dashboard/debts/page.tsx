'use client';

/**
 * /dashboard/debts — owner debts and customer-credit view (Slice 3).
 *
 * All users with a valid tenant claim can VIEW debts (RLS allows reads).
 * The write path (record payment) is guarded inside DebtsView by the
 * debt_payments_insert RLS policy which checks has_permission('can_manage_debts').
 * Owners always have can_manage_debts, so the Record Payment button works for them.
 *
 * Tenant isolation: all data reads are RLS-scoped via the signed JWT claim.
 * tenant_id is NEVER sent from the client as a trust source (CLAUDE.md §5).
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { DebtsView } from '@/components/debts/DebtsView';
import { DashboardPageShell } from '@/components/shell/DashboardPageShell';

export default function DebtsPage() {
  const { claim, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !claim) {
      router.replace('/login');
    }
  }, [loading, claim, router]);

  if (loading || !claim) {
    return null; // AuthContext handles redirect
  }

  return (
    <DashboardPageShell>
      <DebtsView />
    </DashboardPageShell>
  );
}
