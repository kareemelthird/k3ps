'use client';

/**
 * /admin/audit — Platform-wide audit log view (AC 8–11, design §5).
 *
 * Read-only cross-tenant audit table with filters:
 *  - tenant / actor / action / date-from / date-to
 *  - "acted during impersonation" chip when meta.impersonator_id is present (AC 25)
 *
 * Data: fetched client-side via anon Supabase client.
 * The super-admin SELECT-only policy covers audit_log (ADR-0008 Q4).
 * Pre-filtered to a specific tenant when ?tenant=<id> is in the URL.
 *
 * useSearchParams is inside AuditPageInner which is wrapped in <Suspense>
 * so the page does not opt the entire route out of static rendering.
 */

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase/client';
import { AdminShell } from '@/components/admin/AdminShell';
import { AuditTable, type AuditEntry } from '@/components/admin/AuditTable';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';

function AuditPageInner() {
  const t = useTranslations('admin');
  const searchParams = useSearchParams();
  const tenantFilter = searchParams.get('tenant') ?? undefined;

  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadAudit = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = getBrowserClient();
      let query = supabase
        .from('audit_log')
        .select(
          'id, created_at, tenant_id, actor_id, action, entity, entity_id, amount, meta',
        )
        .order('created_at', { ascending: false })
        .limit(500);

      if (tenantFilter) {
        query = query.eq('tenant_id', tenantFilter);
      }

      const { data, error } = await query;
      if (error) throw error;

      setRows(
        (
          (data ?? []) as Array<{
            id: string;
            created_at: string;
            tenant_id: string | null;
            actor_id: string | null;
            action: string;
            entity: string | null;
            entity_id: string | null;
            amount: number | null;
            meta: Record<string, unknown> | null;
          }>
        ).map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          tenantId: r.tenant_id,
          actorId: r.actor_id,
          action: r.action,
          entityType: r.entity ?? undefined,
          entityId: r.entity_id ?? undefined,
          amount: r.amount,
          meta: r.meta,
        })),
      );
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('error.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [tenantFilter]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  return (
    <>
      {loadError && (
        <ErrorState message={loadError} onRetry={() => void loadAudit()} />
      )}

      {!loadError && (
        <AuditTable rows={rows} loading={loading} tenantFilter={tenantFilter} />
      )}
    </>
  );
}

export default function AdminAuditPage() {
  const t = useTranslations('admin');

  return (
    <AdminShell activeNav="audit" pageTitle={t('audit.title')}>
      <p className="text-label text-text-muted mb-lg">{t('audit.subtitle')}</p>
      <Suspense
        fallback={
          <div className="flex flex-col gap-sm">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        }
      >
        <AuditPageInner />
      </Suspense>
    </AdminShell>
  );
}
