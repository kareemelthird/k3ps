/**
 * Platform-wide audit log page (super-admin).
 *
 * Design: docs/design/super-admin-console.md §3.4
 * Read-only DataTable with filters: actor, action, tenant, date range.
 * Impersonation rows are first-class audit entries (violet-tinted, AC 38-39).
 * Money amounts via formatEgp, tabular, end-aligned.
 */
import { Suspense } from 'react';
import { AuditLogView } from '@/components/super-admin/AuditLogView';

export default function AuditLogPage() {
  return (
    <Suspense fallback={<AuditSkeleton />}>
      <AuditLogView />
    </Suspense>
  );
}

function AuditSkeleton() {
  return (
    <div aria-label="جارٍ التحميل" role="status">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
    </div>
  );
}
