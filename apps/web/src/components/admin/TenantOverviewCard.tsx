'use client';

/**
 * TenantOverviewCard — tenant detail overview section (design §4 item 1).
 * Name + status + created date + counts (members / branches / owners).
 * Arabic-Indic numerals for all counts.
 */

import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import { Skeleton } from '@/components/ui/Skeleton';

interface TenantOverviewCardProps {
  tenant: {
    name: string;
    status: 'active' | 'suspended';
    createdAt: string;
    memberCount: number;
    branchCount: number;
    ownerCount: number;
    health: 'healthy' | 'noOwner' | 'idle' | 'suspended';
  } | null;
  loading?: boolean;
}

export function TenantOverviewCard({ tenant, loading = false }: TenantOverviewCardProps) {
  const t = useTranslations('admin');

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return toArabicDigits(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    );
  };

  return (
    <div className="bg-surface rounded-md border border-border p-xl flex flex-col gap-md">
      <h2 className="text-h3 text-text font-semibold">{t('detail.overview')}</h2>

      {loading && (
        <div className="flex flex-col gap-sm">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
          <div className="flex gap-md">
            <Skeleton className="h-10 w-24" />
            <Skeleton className="h-10 w-24" />
            <Skeleton className="h-10 w-24" />
          </div>
        </div>
      )}

      {!loading && tenant && (
        <div className="flex flex-col gap-md">
          {/* Name + status */}
          <div className="flex items-center gap-sm flex-wrap">
            <h3 className="text-h2 text-text font-bold">{tenant.name}</h3>
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill text-caption font-medium
                ${tenant.status === 'active'
                  ? 'bg-status-free/10 text-status-free'
                  : 'bg-status-maint/10 text-status-maint'
                }`}
            >
              {tenant.status === 'active' ? t('tenant.status.active') : t('tenant.status.suspended')}
            </span>
          </div>

          {/* Created date */}
          <p className="text-label text-text-muted">
            {t('detail.created')}: <span className="text-text tabular-nums">{formatDate(tenant.createdAt)}</span>
          </p>

          {/* Counts */}
          <div className="flex gap-lg flex-wrap">
            {([
              { key: 'members', value: tenant.memberCount },
              { key: 'branches', value: tenant.branchCount },
              { key: 'owners', value: tenant.ownerCount },
            ] as const).map(({ key, value }) => (
              <div key={key} className="flex flex-col gap-2xs">
                <p className="text-caption text-text-faint">{t(`detail.counts.${key}`)}</p>
                <p className="text-h2 font-bold tabular-nums text-text">
                  {toArabicDigits(String(value))}
                </p>
              </div>
            ))}
          </div>

          {/* Health */}
          {tenant.health !== 'healthy' && tenant.health !== 'suspended' && (
            <p className="text-caption text-warning bg-warning/10 rounded-xs px-sm py-xs">
              {t(`tenant.health.${tenant.health}`)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
