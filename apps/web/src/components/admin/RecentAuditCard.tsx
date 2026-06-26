'use client';

/**
 * RecentAuditCard — last ~10 audit rows for a tenant in tenant detail (design §4 item 4, AC 8).
 * Most-recent first. Money via formatEgp. "View all" links to /admin/audit?tenant=<id>.
 * Impersonated rows show a violet chip (meta.impersonator_id present, AC 25).
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatEgp, toArabicDigits } from '@ps/core';
import { Skeleton } from '@/components/ui/Skeleton';

export interface AuditRowData {
  id: string;
  createdAt: string;
  action: string;
  actorId: string | null;
  actorName?: string;
  amount: number | null;
  meta: Record<string, unknown> | null;
}

interface RecentAuditCardProps {
  tenantId: string;
  rows: AuditRowData[];
  loading?: boolean;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return toArabicDigits(
    `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
  );
}

function localizeAction(action: string, t: (key: string) => string): string {
  const MAP: Record<string, string> = {
    'tenant.provision': t('action.tenant.provision'),
    'tenant.suspend': t('action.tenant.suspend'),
    'tenant.reactivate': t('action.tenant.reactivate'),
    'impersonation.start': t('action.impersonation.start'),
    'impersonation.stop': t('action.impersonation.stop'),
  };
  return MAP[action] ?? action;
}

export function RecentAuditCard({ tenantId, rows, loading = false }: RecentAuditCardProps) {
  const t = useTranslations('admin');

  return (
    <div className="bg-surface rounded-md border border-border p-xl flex flex-col gap-md">
      <div className="flex items-center justify-between">
        <h2 className="text-h3 text-text font-semibold">{t('detail.audit.title')}</h2>
        <Link
          href={`/admin/audit?tenant=${tenantId}`}
          className="text-label text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs"
        >
          {t('detail.audit.viewAll')}
        </Link>
      </div>

      {loading && (
        <div className="flex flex-col gap-sm">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      )}

      {!loading && rows.length === 0 && (
        <p className="text-label text-text-muted">{t('audit.empty.body')}</p>
      )}

      {!loading && rows.length > 0 && (
        <ul className="flex flex-col gap-xs">
          {rows.map((row) => {
            const hasImpersonator = row.meta?.impersonator_id != null;
            const isImpersonationEvent =
              row.action === 'impersonation.start' || row.action === 'impersonation.stop';

            return (
              <li
                key={row.id}
                className={`flex items-start gap-md px-sm py-xs rounded-xs bg-surface-2
                  ${isImpersonationEvent ? 'border border-impersonation/20' : ''}`}
              >
                <time
                  className="text-caption text-text-faint tabular-nums flex-shrink-0 mt-0.5"
                  dateTime={row.createdAt}
                  dir="ltr"
                >
                  {formatTime(row.createdAt)}
                </time>
                <div className="flex-1 min-w-0">
                  <p className="text-label text-text truncate">{localizeAction(row.action, t as unknown as (key: string) => string)}</p>
                  {hasImpersonator && !isImpersonationEvent && (
                    <span className="text-caption text-impersonation bg-impersonation/10 rounded-xs px-xs py-0.5">
                      {t('audit.impersonated', { actor: String(row.meta?.impersonator_id ?? '') })}
                    </span>
                  )}
                </div>
                {row.amount != null && row.amount !== 0 && (
                  <span className="text-caption text-text tabular-nums flex-shrink-0">
                    {formatEgp(row.amount)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
