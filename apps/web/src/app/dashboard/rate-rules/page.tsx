'use client';

/**
 * /dashboard/rate-rules — owner rate-rule editor (Phase 4, AC 27–32, 40, 43).
 *
 * Owner: full CRUD (create / edit / deactivate / reactivate) + resolved-rate preview.
 * Manager/staff: read-only list (no write controls).
 *
 * Tenant isolation: all data reads are RLS-scoped via the signed JWT claim.
 * tenant_id is NEVER sent from the client as a trust source (CLAUDE.md §5).
 *
 * Role check: reads the `roles` array from the JWT claim (set by the Supabase
 * auth hook — ADR-0003). If the claim is absent, redirects to /login.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { RateRulesView } from '@/components/rate-rules/RateRulesView';
import { DashboardPageShell } from '@/components/shell/DashboardPageShell';

export default function RateRulesPage() {
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

  // Role gate: owner has write access; manager/staff get read-only list (AC 27).
  const isOwner = claim.roles.includes('owner') || claim.is_super_admin;

  return (
    <DashboardPageShell>
      <RateRulesView isOwner={isOwner} />
    </DashboardPageShell>
  );
}
