'use client';

/**
 * /dashboard/products — owner product catalog (Phase 5, AC A1–A5).
 *
 * Owner: full CRUD (create / edit / deactivate / reactivate).
 * Manager/staff: read-only list (no write controls — AC A1).
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
import { ProductsView } from '@/components/products/ProductsView';
import { DashboardPageShell } from '@/components/shell/DashboardPageShell';

export default function ProductsPage() {
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

  // Role gate: owner has write access; manager/staff get read-only list (AC A1).
  // ADR-0008 Decision Q3: roles is scalar — use === not .includes() (fail-closed).
  const isOwner = claim.roles === 'owner' || claim.is_super_admin;

  return (
    <DashboardPageShell>
      <ProductsView isOwner={isOwner} />
    </DashboardPageShell>
  );
}
