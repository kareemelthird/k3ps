/**
 * Tenant detail page (super-admin).
 *
 * Design: docs/design/super-admin-console.md §3.3
 * Sections: Overview · Members · Branches · Recent audit · Danger zone
 * Actions: Impersonate (→ impersonation.md) · Suspend/Reactivate
 *
 * SECURITY: impersonation is explicit, time-boxed, and audited (AC 38-39).
 * No silent cross-tenant read path.
 */
import { Suspense } from 'react';
import { TenantDetailView } from '@/components/super-admin/TenantDetailView';

interface TenantPageProps {
  params: Promise<{ locale: string; id: string }>;
}

export default async function TenantDetailPage({ params }: TenantPageProps) {
  const { id } = await params;

  return (
    <Suspense fallback={<DetailSkeleton />}>
      <TenantDetailView tenantId={id} />
    </Suspense>
  );
}

function DetailSkeleton() {
  return (
    <div aria-label="جارٍ التحميل" role="status">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="skeleton-card" />
      ))}
    </div>
  );
}
