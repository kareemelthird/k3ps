'use client';

/**
 * AuditTable — cross-tenant read-only audit log (design §5, AC 8–11).
 *
 * Columns: time · tenant · actor · action · entity · amount · detail
 * Filters: tenant / actor / action / date-from / date-to
 * "Acted during impersonation" chip when meta.impersonator_id is present (AC 25).
 *
 * RTL layout, Arabic-Indic digits, all strings via i18n.
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { formatEgp, toArabicDigits } from '@ps/core';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';

export interface AuditEntry {
  id: string;
  createdAt: string;
  tenantId: string | null;
  tenantName?: string;
  actorId: string | null;
  actorName?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  amount: number | null;
  meta: Record<string, unknown> | null;
}

interface AuditTableProps {
  rows: AuditEntry[];
  loading?: boolean;
  /** If pre-filtered to a single tenant, hide the tenant column and filter. */
  tenantFilter?: string;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return toArabicDigits(`${date} ${time}`);
}

export function AuditTable({ rows, loading = false, tenantFilter }: AuditTableProps) {
  const t = useTranslations('admin');

  const [filterTenant, setFilterTenant] = useState(tenantFilter ?? '');
  const [filterActor, setFilterActor] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const uniqueActions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.action))).sort(),
    [rows],
  );

  const uniqueTenants = useMemo(() => {
    if (tenantFilter) return [];
    return Array.from(
      new Map(
        rows
          .filter((r) => r.tenantId)
          .map((r) => [r.tenantId, { id: r.tenantId!, name: r.tenantName ?? r.tenantId! }]),
      ).values(),
    );
  }, [rows, tenantFilter]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filterTenant && r.tenantId !== filterTenant) return false;
      if (filterActor && !(r.actorName ?? r.actorId ?? '').toLowerCase().includes(filterActor.toLowerCase())) return false;
      if (filterAction && r.action !== filterAction) return false;
      if (filterFrom) {
        const rowDate = new Date(r.createdAt).toISOString().slice(0, 10);
        if (rowDate < filterFrom) return false;
      }
      if (filterTo) {
        const rowDate = new Date(r.createdAt).toISOString().slice(0, 10);
        if (rowDate > filterTo) return false;
      }
      return true;
    });
  }, [rows, filterTenant, filterActor, filterAction, filterFrom, filterTo]);

  const hasActiveFilter =
    filterTenant !== (tenantFilter ?? '') ||
    filterActor !== '' ||
    filterAction !== '' ||
    filterFrom !== '' ||
    filterTo !== '';

  const clearFilters = () => {
    setFilterTenant(tenantFilter ?? '');
    setFilterActor('');
    setFilterAction('');
    setFilterFrom('');
    setFilterTo('');
  };

  const localizeAction = (action: string): string => {
    const MAP: Record<string, string> = {
      'tenant.provision': t('action.tenant.provision'),
      'tenant.suspend': t('action.tenant.suspend'),
      'tenant.reactivate': t('action.tenant.reactivate'),
      'impersonation.start': t('action.impersonation.start'),
      'impersonation.stop': t('action.impersonation.stop'),
    };
    return MAP[action] ?? action;
  };

  return (
    <div className="flex flex-col gap-md">
      {/* Filters bar */}
      <div className="bg-surface rounded-md border border-border p-md flex flex-wrap gap-sm items-end">
        {/* Tenant filter — hidden when tenantFilter is pre-set */}
        {!tenantFilter && uniqueTenants.length > 0 && (
          <div className="flex flex-col gap-2xs">
            <label className="text-caption text-text-muted">{t('audit.filter.tenant')}</label>
            <select
              value={filterTenant}
              onChange={(e) => setFilterTenant(e.target.value)}
              className="bg-surface-2 border border-border rounded-xs px-sm py-xs text-label text-text focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">{t('audit.filter.allTenants')}</option>
              {uniqueTenants.map((ten) => (
                <option key={ten.id} value={ten.id}>
                  {ten.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Actor filter */}
        <div className="flex flex-col gap-2xs">
          <label className="text-caption text-text-muted">{t('audit.filter.actor')}</label>
          <input
            type="text"
            value={filterActor}
            onChange={(e) => setFilterActor(e.target.value)}
            placeholder={t('audit.filter.actor')}
            className="bg-surface-2 border border-border rounded-xs px-sm py-xs text-label text-text focus:outline-none focus:ring-2 focus:ring-primary w-40"
          />
        </div>

        {/* Action filter */}
        <div className="flex flex-col gap-2xs">
          <label className="text-caption text-text-muted">{t('audit.filter.action')}</label>
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="bg-surface-2 border border-border rounded-xs px-sm py-xs text-label text-text focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">{t('audit.filter.allActions')}</option>
            {uniqueActions.map((a) => (
              <option key={a} value={a}>
                {localizeAction(a)}
              </option>
            ))}
          </select>
        </div>

        {/* Date from */}
        <div className="flex flex-col gap-2xs">
          <label className="text-caption text-text-muted">{t('audit.filter.dateFrom')}</label>
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            className="bg-surface-2 border border-border rounded-xs px-sm py-xs text-label text-text focus:outline-none focus:ring-2 focus:ring-primary"
            dir="ltr"
          />
        </div>

        {/* Date to */}
        <div className="flex flex-col gap-2xs">
          <label className="text-caption text-text-muted">{t('audit.filter.dateTo')}</label>
          <input
            type="date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            className="bg-surface-2 border border-border rounded-xs px-sm py-xs text-label text-text focus:outline-none focus:ring-2 focus:ring-primary"
            dir="ltr"
          />
        </div>

        {/* Clear filters */}
        {hasActiveFilter && (
          <Button variant="ghost" size="md" onClick={clearFilters}>
            {t('audit.filter.clear')}
          </Button>
        )}
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="flex flex-col gap-sm">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <EmptyState
          title={t('audit.empty.title')}
          body={t('audit.empty.body')}
        />
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="overflow-x-auto bg-surface rounded-md border border-border">
          <table className="w-full text-label">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="text-start px-md py-sm font-medium whitespace-nowrap">{t('audit.col.time')}</th>
                {!tenantFilter && (
                  <th className="text-start px-md py-sm font-medium">{t('audit.col.tenant')}</th>
                )}
                <th className="text-start px-md py-sm font-medium">{t('audit.col.actor')}</th>
                <th className="text-start px-md py-sm font-medium">{t('audit.col.action')}</th>
                <th className="text-start px-md py-sm font-medium">{t('audit.col.entity')}</th>
                <th className="text-start px-md py-sm font-medium">{t('audit.col.amount')}</th>
                <th className="text-start px-md py-sm font-medium">{t('audit.col.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const isImpersonated = row.meta?.impersonator_id != null;
                const impersonatorId = isImpersonated
                  ? String(row.meta?.impersonator_id ?? '')
                  : null;

                return (
                  <tr
                    key={row.id}
                    className={`border-b border-border last:border-0 ${
                      isImpersonated ? 'bg-impersonation/5' : ''
                    }`}
                  >
                    {/* Time */}
                    <td className="px-md py-sm whitespace-nowrap text-text-faint tabular-nums">
                      <time dateTime={row.createdAt} dir="ltr">
                        {formatDateTime(row.createdAt)}
                      </time>
                    </td>

                    {/* Tenant (if not pre-filtered) */}
                    {!tenantFilter && (
                      <td className="px-md py-sm text-text">
                        {row.tenantName ?? row.tenantId ?? '—'}
                      </td>
                    )}

                    {/* Actor */}
                    <td className="px-md py-sm text-text">
                      <bdi>{row.actorName ?? row.actorId ?? '—'}</bdi>
                    </td>

                    {/* Action */}
                    <td className="px-md py-sm">
                      <div className="flex flex-col gap-1">
                        <span className="text-text">{localizeAction(row.action)}</span>
                        {isImpersonated && (
                          <span className="text-caption text-impersonation bg-impersonation/10 rounded-xs px-xs py-0.5 w-fit">
                            {t('audit.impersonated', { actor: impersonatorId ?? '' })}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Entity */}
                    <td className="px-md py-sm text-text-muted text-caption">
                      {row.entityType ? (
                        <span>
                          {row.entityType}
                          {row.entityId && (
                            <span className="ms-1 text-text-faint font-mono" dir="ltr">
                              {row.entityId.slice(0, 8)}…
                            </span>
                          )}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>

                    {/* Amount */}
                    <td className="px-md py-sm text-text tabular-nums">
                      {row.amount != null && row.amount !== 0
                        ? formatEgp(row.amount)
                        : t('audit.noAmount')}
                    </td>

                    {/* Detail (meta summary) */}
                    <td className="px-md py-sm text-caption text-text-faint max-w-[200px] truncate">
                      {row.meta?.reason != null ? String(row.meta.reason) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
