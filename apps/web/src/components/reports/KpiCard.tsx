'use client';

/**
 * KpiCard — single KPI card (design-system phase-6 §5).
 * Shows: label (above), large money figure (hero), supporting sub-line (below).
 * Four states: loading (skeleton), error (inline retry), empty (zero + context), default.
 * All strings via i18n. Money via formatEgp + toArabicDigits. RTL layout.
 *
 * The accent dot is decorative (aria-hidden). The label carries meaning, never
 * color alone (color-not-only). The figure uses tabular numerals to prevent reflow.
 */

import { useTranslations } from 'next-intl';
import { formatEgp } from '@ps/core';
import { Skeleton } from '@/components/ui/Skeleton';

interface KpiCardProps {
  /** i18n key for the card label (e.g. 'kpi.gross.label') */
  labelKey: string;
  /** i18n key for the sub-line (e.g. 'kpi.gross.sub') */
  subKey?: string;
  /** Named params for sub-line interpolation */
  subParams?: Record<string, string | number>;
  /** Value in integer piastres */
  valuePiastres: number;
  /** CSS color for the accent dot (hex or tailwind token) */
  accentColor?: string;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

export function KpiCard({
  labelKey,
  subKey,
  subParams,
  valuePiastres,
  accentColor = '#14B8A6',
  loading = false,
  error = false,
  onRetry,
}: KpiCardProps) {
  const t = useTranslations();
  const label = t(labelKey);

  if (loading) {
    return (
      <div className="rounded-md bg-surface border border-border shadow-e1 p-md flex flex-col gap-xs">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-32 mt-xs" />
        <Skeleton className="h-3 w-28" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-md bg-surface border border-border shadow-e1 p-md flex flex-col gap-xs min-h-[96px] justify-center"
      >
        <p className="text-caption text-text-muted">{label}</p>
        <p className="text-caption text-danger">{t('state.error.generic')}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-caption text-primary hover:underline text-start"
          >
            {t('action.retry')}
          </button>
        )}
      </div>
    );
  }

  const formatted = formatEgp(valuePiastres);

  return (
    <div
      className="rounded-md bg-surface border border-border shadow-e1 p-md flex flex-col gap-xs"
      aria-label={`${label}: ${formatted}`}
    >
      {/* Accent dot + label */}
      <div className="flex items-center gap-xs">
        <span
          aria-hidden="true"
          className="w-2 h-2 rounded-pill flex-shrink-0"
          style={{ backgroundColor: accentColor }}
        />
        <p className="text-caption text-text-muted">{label}</p>
      </div>

      {/* Hero figure — tabular money, Arabic-Indic (from formatEgp) */}
      <p className="text-display text-text font-bold tabular-nums leading-none">
        {valuePiastres === 0 ? (
          <span className="text-text-faint">{formatEgp(0)}</span>
        ) : (
          formatted
        )}
      </p>

      {/* Sub-line */}
      {subKey && (
        <p className="text-caption text-text-faint">
          {valuePiastres === 0
            ? t('kpi.noData')
            : t(subKey, subParams ?? {})}
        </p>
      )}
    </div>
  );
}
