/**
 * Tenants list page (super-admin).
 *
 * Design: docs/design/super-admin-console.md §3.1
 * - DataTable with status filter + search
 * - Primary CTA: Provision tenant
 * - Four states: empty, loading, error, offline
 * - All four states per design-system §8
 *
 * This is a Server Component; data fetching via cached queries (CLAUDE.md best practice).
 * AC 37: provisioning writes audit_log — triggered through ProvisionTenantDialog.
 */
import { useTranslations } from 'next-intl';
import { Suspense } from 'react';
import { TenantsView } from '@/components/super-admin/TenantsView';

export default function TenantsPage() {
  return (
    <Suspense fallback={<TenantsLoadingSkeleton />}>
      <TenantsView />
    </Suspense>
  );
}

function TenantsLoadingSkeleton() {
  return (
    <div aria-label="جارٍ التحميل" role="status">
      <div className="skeleton-header" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
    </div>
  );
}
