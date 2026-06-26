'use client';

/**
 * SubscriptionStatStrip — platform billing health-at-a-glance (design §7.1, AC 33).
 * Reuses the Phase-7 StatStrip grammar: compact StatCards.
 * Arabic-Indic numerals. formatMoneyMinor for MRR (platform currency, NOT formatEgp).
 */

import { useTranslations } from 'next-intl';
import { toArabicDigits, formatMoneyMinor } from '@ps/core';
import { Skeleton } from '@/components/ui/Skeleton';

interface SubscriptionStatStripProps {
  active: number | null;
  trialing: number | null;
  pastDue: number | null;
  /** null = loading (Skeleton); undefined = no price_amount configured (show —); number = format */
  mrrMinor: number | null | undefined;
  currency: string;
}

interface StatCardProps {
  label: string;
  value: string | null;
  tone?: 'default' | 'free' | 'warning' | 'muted';
}

function StatCard({ label, value, tone = 'default' }: StatCardProps) {
  const toneClass =
    tone === 'free' ? 'text-status-free'
    : tone === 'warning' ? 'text-warning'
    : tone === 'muted' ? 'text-text-muted'
    : 'text-text';

  return (
    <div className="flex flex-col gap-2xs bg-surface rounded-sm px-md py-sm border border-border min-w-[120px]">
      <p className="text-caption text-text-faint truncate">{label}</p>
      {value === null ? (
        <Skeleton className="h-6 w-16" />
      ) : (
        <p className={`text-h2 font-bold tabular-nums ${toneClass}`}>{value}</p>
      )}
    </div>
  );
}

export function SubscriptionStatStrip({
  active,
  trialing,
  pastDue,
  mrrMinor,
  currency,
}: SubscriptionStatStripProps) {
  const t = useTranslations('admin.subs');

  const mrrDisplay =
    mrrMinor === null
      ? null // loading → Skeleton
      : mrrMinor === undefined
        ? '—' // no price_amount configured on any plan yet
        : t('mrrApprox', {
            amount: formatMoneyMinor(mrrMinor, currency, { arabicDigits: true }),
            currency: currency.toUpperCase(),
          });

  return (
    <div className="flex gap-sm flex-wrap">
      <StatCard
        label={t('stat.active')}
        value={active !== null ? toArabicDigits(String(active)) : null}
        tone="free"
      />
      <StatCard
        label={t('stat.trialing')}
        value={trialing !== null ? toArabicDigits(String(trialing)) : null}
      />
      <StatCard
        label={t('stat.pastDue')}
        value={pastDue !== null ? toArabicDigits(String(pastDue)) : null}
        tone={pastDue !== null && pastDue > 0 ? 'warning' : 'muted'}
      />
      <StatCard
        label={t('stat.mrr')}
        value={mrrDisplay}
        tone="free"
      />
    </div>
  );
}
