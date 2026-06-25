'use client';

/**
 * ChartCard — wrapper for Phase 6 charts (design-system §10, feature-design §6).
 * Each chart has: h3 title at start, optional toggle at end, chart slot,
 * screen-reader summary, and all four required states (loading/empty/error/default).
 * All strings via i18n. RTL layout.
 */

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';

interface ChartCardProps {
  titleKey: string;
  summaryKey: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: boolean;
  toggle?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Min-height for the chart body (default 240px) */
  chartHeight?: number;
}

export function ChartCard({
  titleKey,
  summaryKey,
  loading = false,
  error,
  onRetry,
  empty = false,
  toggle,
  children,
  className = '',
  chartHeight = 240,
}: ChartCardProps) {
  const t = useTranslations();

  return (
    <div
      className={`rounded-md bg-surface border border-border shadow-e0 overflow-hidden ${className}`}
    >
      {/* Card header: title at start, optional toggle at end */}
      <div className="flex items-center justify-between px-md pt-md pb-sm gap-sm">
        <h3 className="text-h3 text-text">{t(titleKey)}</h3>
        {toggle && <div>{toggle}</div>}
      </div>

      {/* Chart body */}
      <div
        className="px-md pb-md"
        style={{ minHeight: chartHeight }}
        aria-label={t(summaryKey)}
      >
        {loading ? (
          <Skeleton className="w-full" style={{ height: chartHeight }} />
        ) : error ? (
          <ErrorState onRetry={onRetry} className="py-lg" />
        ) : empty ? (
          <div
            className="flex items-center justify-center text-text-faint text-label"
            style={{ minHeight: chartHeight }}
          >
            {t('chart.empty')}
          </div>
        ) : (
          children
        )}
      </div>

      {/* Screen-reader summary (SR-only) */}
      <p className="sr-only">{t(summaryKey)}</p>
    </div>
  );
}
