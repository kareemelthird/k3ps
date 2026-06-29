'use client';

/**
 * SubscriptionsTable — platform-level view of all tenant subscriptions (design §7.2, AC 33–34).
 *
 * Columns: tenant · plan · status · trial_end · period_end · amount · actions
 * Filters: status (all/trialing/active/past_due/canceled) · plan · tenant name search
 * Actions: comp/override plan (opens CompOverrideDialog from parent)
 *
 * Uses BillingStatusPill (design §2.5 token mapping).
 * formatMoneyMinor for amount — platform axis (NOT formatEgp).
 * Arabic-Indic numerals. All strings via i18n.
 * RTL: logical spacing. Focus-visible ring on interactive elements.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toArabicDigits, formatMoneyMinor } from '@ps/core';
import { BillingStatusPill } from '@/components/billing/BillingStatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';

export interface SubscriptionRow {
  tenantId: string;
  tenantName: string;
  plan: string;
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';
  comped: boolean;
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  amountMinor: number | null;
  currency: string;
  stripeSubscriptionId: string | null;
}

interface PlanOption {
  key: string;
  displayName: string;
}

interface SubscriptionsTableProps {
  rows: SubscriptionRow[];
  plans: PlanOption[];
  loading: boolean;
  error: string | null;
  onComp: (row: SubscriptionRow) => void;
  onRetry: () => void;
}

function formatDateArabic(isoStr: string | null): string {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    return toArabicDigits(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    );
  } catch {
    return isoStr;
  }
}

export function SubscriptionsTable({
  rows,
  plans,
  loading,
  error,
  onComp,
  onRetry,
}: SubscriptionsTableProps) {
  const t = useTranslations('admin.subs');
  const tAction = useTranslations('action');

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [planFilter, setPlanFilter] = useState('all');

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (query && !r.tenantName.toLowerCase().includes(query.toLowerCase())) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (planFilter !== 'all' && r.plan !== planFilter) return false;
      return true;
    });
  }, [rows, query, statusFilter, planFilter]);

  const hasFilters = query !== '' || statusFilter !== 'all' || planFilter !== 'all';

  function clearFilters() {
    setQuery('');
    setStatusFilter('all');
    setPlanFilter('all');
  }

  return (
    <div className="flex flex-col gap-md">
      {/* ── Filter bar ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-sm items-center">
        {/* Tenant name search */}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('filter.search')}
          aria-label={t('filter.search')}
          className="rounded-sm border border-border bg-surface-3 text-text px-sm py-xs text-body h-[44px] min-w-[220px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />

        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label={t('filter.status')}
          className="rounded-sm border border-border bg-surface-3 text-text px-sm py-xs text-body h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="all">{t('filter.allStatuses')}</option>
          <option value="trialing">{t('filter.statusTrialing')}</option>
          <option value="active">{t('filter.statusActive')}</option>
          <option value="past_due">{t('filter.statusPastDue')}</option>
          <option value="canceled">{t('filter.statusCanceled')}</option>
        </select>

        {/* Plan filter */}
        <select
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value)}
          aria-label={t('filter.plan')}
          className="rounded-sm border border-border bg-surface-3 text-text px-sm py-xs text-body h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="all">{t('filter.allPlans')}</option>
          {plans.map((p) => (
            <option key={p.key} value={p.key}>{p.displayName}</option>
          ))}
        </select>

        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-label text-text-muted hover:text-text transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs px-sm py-xs"
          >
            {t('filter.clear')}
          </button>
        )}
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && !loading && (
        <div className="flex items-center gap-sm rounded-md border border-danger/30 bg-danger/10 px-md py-sm">
          <p className="text-body text-danger flex-1">{t('error')}</p>
          <button
            type="button"
            onClick={onRetry}
            className="text-label text-danger underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs"
          >
            {tAction('retry')}
          </button>
        </div>
      )}

      {/* ── Table ─────────────────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table className="w-full text-start" role="grid">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              {(['tenant', 'plan', 'status', 'trialEnd', 'periodEnd', 'amount', 'actions'] as const).map((col) => (
                <th
                  key={col}
                  scope="col"
                  className="px-md py-sm text-start text-caption font-medium text-text-muted whitespace-nowrap"
                >
                  {t(`col.${col}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-md py-sm">
                      <Skeleton className="h-4 w-24" />
                    </td>
                  ))}
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-md py-3xl text-center">
                  <EmptyState
                    title={hasFilters ? t('filteredEmpty') : t('empty.title')}
                    body={hasFilters ? undefined : t('empty.body')}
                  />
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr
                  key={row.tenantId}
                  className="border-b border-border last:border-b-0 hover:bg-surface-2 transition-colors duration-fast"
                >
                  {/* Tenant name */}
                  <td className="px-md py-sm">
                    <span className="text-body text-text font-medium">{row.tenantName}</span>
                    {row.comped && (
                      <span className="ms-sm text-caption text-platform bg-platform/10 rounded-xs px-xs py-2xs">
                        {t('comped')}
                      </span>
                    )}
                  </td>

                  {/* Plan */}
                  <td className="px-md py-sm">
                    <span className="text-body text-text">
                      {plans.find((p) => p.key === row.plan)?.displayName ?? row.plan}
                    </span>
                  </td>

                  {/* Status pill */}
                  <td className="px-md py-sm">
                    <BillingStatusPill
                      status={row.status}
                      comped={row.comped}
                    />
                    {row.cancelAtPeriodEnd && row.status === 'active' && (
                      <div className="mt-2xs text-caption text-text-muted">{t('cancelScheduled')}</div>
                    )}
                  </td>

                  {/* Trial end */}
                  <td className="px-md py-sm whitespace-nowrap">
                    <span className="text-body text-text-muted tabular-nums">
                      {formatDateArabic(row.trialEnd)}
                    </span>
                  </td>

                  {/* Period end */}
                  <td className="px-md py-sm whitespace-nowrap">
                    <span className="text-body text-text-muted tabular-nums">
                      {formatDateArabic(row.currentPeriodEnd)}
                    </span>
                  </td>

                  {/* Amount — platform currency, NOT EGP */}
                  <td className="px-md py-sm whitespace-nowrap">
                    <span className="text-body text-text tabular-nums">
                      {row.amountMinor !== null
                        ? formatMoneyMinor(row.amountMinor, row.currency, { arabicDigits: true })
                        : '—'}
                    </span>
                  </td>

                  {/* Actions */}
                  <td className="px-md py-sm">
                    <button
                      type="button"
                      onClick={() => onComp(row)}
                      className="text-label text-platform font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs px-xs py-2xs transition-colors duration-fast"
                    >
                      {t('action.comp')}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Row count */}
      {!loading && !error && filtered.length > 0 && (
        <p className="text-caption text-text-muted">
          {toArabicDigits(String(filtered.length))} {filtered.length === rows.length ? '' : `/ ${toArabicDigits(String(rows.length))}`}
        </p>
      )}
    </div>
  );
}
