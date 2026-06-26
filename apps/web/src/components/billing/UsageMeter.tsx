'use client';

/**
 * UsageMeter / UsageMeterGroup — plan-limit meters (design §3.3, AC 25, 30–32).
 *
 * Each meter shows: resource label, "{used} / {limit}" count (tabular, Arabic-Indic),
 * and a track+fill bar that recolours:
 *   primary (< 80%) → warning (≥ 80%) → danger (= 100%)
 *
 * At the cap: lock icon + "بلغت الحد". Unlimited cap: shows "غير محدود" without a bar.
 * RTL: fill bar grows from the logical start edge. Colour is NEVER the only signal.
 * a11y: role="meter" + aria-valuenow/valuemax/valuetext.
 * All strings via i18n.
 */

import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';

// ── UsageMeter ─────────────────────────────────────────────────────────────

interface UsageMeterProps {
  /** i18n key suffix within billing.usage (e.g. "branches") */
  labelKey: 'branches' | 'devices' | 'staff';
  used: number;
  /** null = unlimited */
  limit: number | null;
  loading?: boolean;
  error?: string | null;
}

function fillColor(pct: number): string {
  if (pct >= 100) return 'bg-danger';
  if (pct >= 80) return 'bg-warning';
  return 'bg-primary';
}

export function UsageMeter({ labelKey, used, limit, loading = false, error }: UsageMeterProps) {
  const t = useTranslations('billing.usage');

  if (loading) {
    return (
      <div className="flex flex-col gap-xs">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-3 w-12" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-caption text-danger" role="alert">
        {error}
      </div>
    );
  }

  const label = t(labelKey);
  const isUnlimited = limit === null || limit < 0;
  const pct = isUnlimited ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const atLimit = !isUnlimited && used >= limit;
  const nearLimit = !isUnlimited && pct >= 80 && !atLimit;

  const valueText = isUnlimited
    ? `${toArabicDigits(String(used))} ${t('unlimited')}`
    : `${toArabicDigits(String(used))} ${t('ofLimit', { used, limit })} (${toArabicDigits(String(pct))}٪)`;

  return (
    <div className="flex flex-col gap-xs">
      {/* Label row */}
      <div className="flex items-center justify-between gap-sm">
        <p className="text-caption text-text-muted font-medium">{label}</p>
        {atLimit ? (
          <span className="inline-flex items-center gap-1 text-caption text-danger font-semibold">
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            {t('atLimit')}
          </span>
        ) : nearLimit ? (
          <span className="text-caption text-warning">{t('nearLimit')}</span>
        ) : null}
      </div>

      {/* Count */}
      <p
        className="text-h3 font-bold tabular-nums text-text"
        role="meter"
        aria-valuenow={used}
        aria-valuemax={isUnlimited ? undefined : limit}
        aria-valuetext={valueText}
      >
        {isUnlimited
          ? `${toArabicDigits(String(used))} / ${t('unlimited')}`
          : `${toArabicDigits(String(used))} / ${toArabicDigits(String(limit))}`}
      </p>

      {/* Bar */}
      {!isUnlimited && (
        <div
          className="w-full h-2 rounded-pill bg-surface-3 overflow-hidden"
          aria-hidden="true"
        >
          <div
            className={`h-full rounded-pill transition-all duration-300 ${fillColor(pct)}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ── UsageMeterGroup ─────────────────────────────────────────────────────────

interface MeterData {
  labelKey: 'branches' | 'devices' | 'staff';
  used: number;
  limit: number | null;
}

interface UsageMeterGroupProps {
  meters: MeterData[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function UsageMeterGroup({ meters, loading = false, error, onRetry }: UsageMeterGroupProps) {
  const t = useTranslations('billing.usage');

  if (error) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }

  return (
    <section aria-label={t('title')} className="bg-surface rounded-md border border-border p-xl flex flex-col gap-md">
      <h2 className="text-label font-semibold text-text-muted">{t('title')}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-xl">
        {meters.map((m) => (
          <UsageMeter
            key={m.labelKey}
            labelKey={m.labelKey}
            used={m.used}
            limit={m.limit}
            loading={loading}
          />
        ))}
      </div>
    </section>
  );
}
