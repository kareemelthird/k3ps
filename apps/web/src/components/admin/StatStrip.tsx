'use client';

/**
 * StatStrip / StatCard — platform overview health-at-a-glance strip (design §3.2).
 * Three compact cards: total / active / suspended counts.
 * Arabic-Indic numerals. Tabular for alignment.
 * Never blank — zeros show as "٠" (contextual zeros, not missing data).
 */

import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import { Skeleton } from '@/components/ui/Skeleton';

interface StatCardProps {
  label: string;
  value: number | null;
  tone?: 'default' | 'free' | 'maint';
}

function StatCard({ label, value, tone = 'default' }: StatCardProps) {
  const toneClass =
    tone === 'free'
      ? 'text-status-free'
      : tone === 'maint'
      ? 'text-status-maint'
      : 'text-text';

  return (
    <div className="flex flex-col gap-2xs bg-surface rounded-sm px-md py-sm border border-border min-w-[120px]">
      <p className="text-caption text-text-faint truncate">{label}</p>
      {value === null ? (
        <Skeleton className="h-6 w-12" />
      ) : (
        <p className={`text-h2 font-bold tabular-nums ${toneClass}`}>
          {toArabicDigits(String(value))}
        </p>
      )}
    </div>
  );
}

interface StatStripProps {
  total: number | null;
  active: number | null;
  suspended: number | null;
}

export function StatStrip({ total, active, suspended }: StatStripProps) {
  const t = useTranslations('admin.overview.stat');

  return (
    <div className="flex gap-sm flex-wrap">
      <StatCard label={t('total')} value={total} />
      <StatCard label={t('active')} value={active} tone="free" />
      <StatCard label={t('suspended')} value={suspended} tone="maint" />
    </div>
  );
}
