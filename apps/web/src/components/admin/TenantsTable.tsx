'use client';

/**
 * TenantsTable — platform overview table (design §3.3).
 *
 * Columns (RTL-mirrored): name/id · status · health · members · branches ·
 *   created · last-activity · actions (Open + overflow: Impersonate, Suspend/Reactivate).
 *
 * Suspended rows: .7 opacity + lock icon (color-not-only rule).
 * Destructive action (Suspend) is in the overflow menu, never a bare row button.
 * Search (debounced) + status SegmentedControl filter both AND together (AC 6).
 * Arabic-Indic numerals for all counts/dates.
 */

import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import { Skeleton, TableRowSkeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';

export interface TenantRow {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  memberCount: number;
  branchCount: number;
  ownerCount: number;
  createdAt: string;
  // lastActivity: future enhancement — deriving it requires a cross-tenant audit_log scan
  /** Derived health signal */
  health: 'healthy' | 'noOwner' | 'idle' | 'suspended';
}

interface TenantsTableProps {
  tenants: TenantRow[];
  query: string;
  statusFilter: 'all' | 'active' | 'suspended';
  loading: boolean;
  error: string | null;
  onSearch: (q: string) => void;
  onStatusChange: (s: 'all' | 'active' | 'suspended') => void;
  onOpen: (id: string) => void;
  onImpersonate: (tenant: TenantRow) => void;
  onSuspendToggle: (tenant: TenantRow) => void;
  onRetry: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return toArabicDigits(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  );
}

export function TenantsTable({
  tenants,
  query,
  statusFilter,
  loading,
  error,
  onSearch,
  onStatusChange,
  onOpen,
  onImpersonate,
  onSuspendToggle,
  onRetry,
}: TenantsTableProps) {
  const t = useTranslations('admin');

  const STATUS_FILTERS = [
    { value: 'all', label: t('overview.filter.all') },
    { value: 'active', label: t('overview.filter.active') },
    { value: 'suspended', label: t('overview.filter.suspended') },
  ] as const;

  const healthColor = (health: TenantRow['health']) => {
    switch (health) {
      case 'healthy': return 'text-status-free';
      case 'suspended': return 'text-status-maint';
      default: return 'text-warning';
    }
  };

  const healthLabel = (row: TenantRow) => {
    switch (row.health) {
      case 'healthy': return t('tenant.health.healthy');
      case 'noOwner': return t('tenant.health.noOwner');
      case 'idle': return t('tenant.health.idle');
      case 'suspended': return t('tenant.health.suspended');
    }
  };

  return (
    <div className="flex flex-col gap-md">
      {/* Filter bar: search + status SegmentedControl */}
      <div className="flex items-center gap-sm flex-wrap">
        {/* Search */}
        <div className="flex-1 min-w-[200px] relative">
          <span className="absolute inset-y-0 start-md flex items-center pointer-events-none text-text-faint">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={t('overview.search')}
            aria-label={t('overview.search')}
            className="w-full h-[44px] ps-10 pe-md rounded-sm text-label text-text bg-surface-3 border border-border
              focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong transition-colors"
          />
        </div>

        {/* Status filter */}
        <div
          role="group"
          aria-label={t('overview.filter.all')}
          className="flex items-center border border-border rounded-sm overflow-hidden"
        >
          {STATUS_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => onStatusChange(value)}
              className={`px-sm h-[44px] text-label font-medium transition-colors duration-fast
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset
                ${statusFilter === value
                  ? 'bg-primary text-on-primary'
                  : 'text-text-muted hover:bg-surface-3'
                }`}
              aria-pressed={statusFilter === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Error state */}
      {error && !loading && <ErrorState message={error} onRetry={onRetry} />}

      {/* Loading: shimmer rows */}
      {loading && (
        <div className="border border-border rounded-sm overflow-hidden">
          <div className="h-10 bg-surface-2 border-b border-border px-md flex items-center gap-md">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-16 flex-1" />
            ))}
          </div>
          <table className="w-full" aria-hidden="true">
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => (
                <TableRowSkeleton key={i} cols={8} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Data table */}
      {!loading && !error && (
        tenants.length === 0 ? (
          query || statusFilter !== 'all' ? (
            <div className="flex items-center justify-between bg-surface-2 rounded-sm px-md py-sm">
              <p className="text-label text-text-muted">{t('overview.filteredEmpty')}</p>
              <button
                type="button"
                onClick={() => { onSearch(''); onStatusChange('all'); }}
                className="text-label text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs"
              >
                {t('overview.clearFilters')}
              </button>
            </div>
          ) : (
            <EmptyState
              title={t('overview.empty.title')}
              body={t('overview.empty.body')}
            />
          )
        ) : (
          <div className="overflow-x-auto border border-border rounded-sm">
            <table className="w-full text-label">
              <thead>
                <tr className="bg-surface-2 border-b border-border text-text-muted">
                  <th className="text-start px-md py-sm font-medium">{t('tenant.col.name')}</th>
                  <th className="text-start px-md py-sm font-medium">{t('tenant.col.status')}</th>
                  <th className="text-start px-md py-sm font-medium">{t('tenant.col.health')}</th>
                  <th className="text-end px-md py-sm font-medium tabular-nums">{t('tenant.col.members')}</th>
                  <th className="text-end px-md py-sm font-medium tabular-nums">{t('tenant.col.branches')}</th>
                  <th className="text-start px-md py-sm font-medium">{t('tenant.col.created')}</th>
                  <th className="text-end px-md py-sm font-medium">{t('tenant.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-border last:border-0 hover:bg-surface-2 transition-colors
                      ${row.status === 'suspended' ? 'opacity-70' : ''}`}
                  >
                    {/* Name + slug */}
                    <td className="px-md py-sm max-w-[200px]">
                      <p className="font-semibold text-text truncate">{row.name}</p>
                      <p className="text-caption text-text-faint truncate">
                        <bdi>{row.id.slice(0, 8)}</bdi>
                      </p>
                    </td>

                    {/* Status pill */}
                    <td className="px-md py-sm">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill text-caption font-medium
                          ${row.status === 'active'
                            ? 'bg-status-free/10 text-status-free'
                            : 'bg-status-maint/10 text-status-maint'
                          }`}
                        aria-label={row.status === 'active' ? t('tenant.status.active') : t('tenant.status.suspended')}
                      >
                        {row.status === 'suspended' && (
                          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="11" width="18" height="11" rx="2" />
                            <path strokeLinecap="round" d="M7 11V7a5 5 0 0110 0v4" />
                          </svg>
                        )}
                        {row.status === 'active' ? t('tenant.status.active') : t('tenant.status.suspended')}
                      </span>
                    </td>

                    {/* Health */}
                    <td className={`px-md py-sm text-caption font-medium ${healthColor(row.health)}`}>
                      {healthLabel(row)}
                    </td>

                    {/* Counts */}
                    <td className="px-md py-sm text-end tabular-nums text-text">
                      {toArabicDigits(String(row.memberCount))}
                    </td>
                    <td className="px-md py-sm text-end tabular-nums text-text">
                      {toArabicDigits(String(row.branchCount))}
                    </td>

                    {/* Created date */}
                    <td className="px-md py-sm text-text-muted" title={row.createdAt}>
                      {formatDate(row.createdAt)}
                    </td>

                    {/* Actions */}
                    <td className="px-md py-sm">
                      <div className="flex items-center gap-xs justify-end">
                        <button
                          type="button"
                          onClick={() => onOpen(row.id)}
                          className="px-sm py-xs rounded-xs text-caption font-medium bg-surface-3 hover:bg-surface-2 text-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        >
                          {t('tenant.action.open')}
                        </button>

                        {/* Overflow menu: Impersonate + Suspend/Reactivate */}
                        <div className="relative group">
                          <button
                            type="button"
                            aria-label={t('tenant.col.actions')}
                            className="p-xs rounded-xs text-text-muted hover:text-text hover:bg-surface-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
                            </svg>
                          </button>
                          <div className="absolute end-0 top-full mt-1 w-44 bg-surface rounded-sm border border-border shadow-e2 z-10
                            opacity-0 invisible group-focus-within:opacity-100 group-focus-within:visible
                            transition-all duration-fast">
                            <button
                              type="button"
                              onClick={() => onImpersonate(row)}
                              disabled={row.status === 'suspended'}
                              className="flex items-center gap-sm w-full text-start px-sm py-xs text-label text-text-muted hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="1.5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                              </svg>
                              {t('tenant.action.impersonate')}
                            </button>
                            <div className="border-t border-border my-1" />
                            <button
                              type="button"
                              onClick={() => onSuspendToggle(row)}
                              className={`flex items-center gap-sm w-full text-start px-sm py-xs text-label transition-colors
                                ${row.status === 'active'
                                  ? 'text-danger hover:bg-danger/10'
                                  : 'text-status-free hover:bg-status-free/10'
                                }`}
                            >
                              {row.status === 'active' ? t('tenant.action.suspend') : t('tenant.action.reactivate')}
                            </button>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
