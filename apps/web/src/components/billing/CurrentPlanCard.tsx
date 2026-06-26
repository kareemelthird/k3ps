'use client';

/**
 * CurrentPlanCard — "where you stand" hero card (design §3.2, AC 25).
 *
 * Shows: plan name, BillingStatusPill, the relevant date line, the amount
 * (formatMoneyMinor — the platform currency axis, NOT formatEgp), and a
 * "Manage billing" button when a Stripe customer exists.
 *
 * Time/countdown derives from stored timestamps, NOT setInterval elapsed.
 * All money via formatMoneyMinor (design §2.5 formatter contract).
 * All strings via i18n. RTL. Arabic-Indic numerals.
 */

import { useTranslations } from 'next-intl';
import { formatMoneyMinor, toArabicDigits } from '@ps/core';
import type { SubscriptionStatus } from '@ps/core';
import { BillingStatusPill } from './BillingStatusPill';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';

interface CurrentPlanCardProps {
  plan: {
    key: string;
    nameKey: string;
    amountMinor?: number | null;
    currency?: string | null;
    interval?: string | null;
  };
  status: SubscriptionStatus;
  trialEndIso?: string | null;
  currentPeriodEndIso?: string | null;
  cancelAtPeriodEnd?: boolean;
  comped?: boolean;
  /** Reference instant (injected for countdown — no internal clock, CLAUDE.md §2.2). */
  nowIso: string;
  graceUntil?: string | null;
  graceElapsed?: boolean;
  trialDaysLeft?: number | null;
  onManageBilling?: () => void;
  managePending?: boolean;
  hasStripeCustomer?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Whether the Checkout returned success (interim state). */
  finalizing?: boolean;
}

function formatDateArabic(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    return toArabicDigits(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    );
  } catch {
    return isoStr;
  }
}

export function CurrentPlanCard({
  plan,
  status,
  trialEndIso,
  currentPeriodEndIso,
  cancelAtPeriodEnd = false,
  comped = false,
  graceUntil,
  graceElapsed = false,
  trialDaysLeft,
  onManageBilling,
  managePending = false,
  hasStripeCustomer = false,
  loading = false,
  error,
  onRetry,
  finalizing = false,
}: CurrentPlanCardProps) {
  const t = useTranslations('billing.plan');

  if (loading) {
    return (
      <div className="bg-surface rounded-md border border-border p-xl flex flex-col gap-md">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-surface rounded-md border border-border p-xl">
        <ErrorState message={error} onRetry={onRetry} />
      </div>
    );
  }

  /** Resolve the date line copy based on status. */
  function dateLine(): string | null {
    if (finalizing) return null; // handled by finalizing pill below
    switch (status) {
      case 'trialing':
        if (trialEndIso) {
          return t('trialEnds', {
            date: formatDateArabic(trialEndIso),
            n: toArabicDigits(String(trialDaysLeft ?? 0)),
          });
        }
        return null;
      case 'active':
        if (cancelAtPeriodEnd && currentPeriodEndIso) {
          return t('cancelScheduled', { date: formatDateArabic(currentPeriodEndIso) });
        }
        if (currentPeriodEndIso) {
          return t('renews', { date: formatDateArabic(currentPeriodEndIso) });
        }
        return null;
      case 'past_due':
        if (graceUntil) {
          return t('pastDueUntil', { date: formatDateArabic(graceUntil) });
        }
        return null;
      case 'canceled':
        if (currentPeriodEndIso) {
          return t('endedOn', { date: formatDateArabic(currentPeriodEndIso) });
        }
        return null;
      default:
        return null;
    }
  }

  const planDisplayName = (() => {
    if (plan.key === 'trial') return t('trial');
    if (plan.key === 'basic') return t('basic');
    if (plan.key === 'pro') return t('pro');
    return plan.nameKey;
  })();

  const dateLineText = dateLine();
  const hasAmount = plan.amountMinor != null && plan.amountMinor > 0 && plan.currency;

  return (
    <div className="bg-surface rounded-md border border-border p-xl flex flex-col gap-md shadow-e0">
      {/* Plan name + status pill */}
      <div className="flex items-center gap-sm flex-wrap">
        <h2 className="text-h2 text-text font-bold">{planDisplayName}</h2>
        {finalizing ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-caption font-medium bg-surface-3 text-text-muted">
            {/* spinner */}
            <svg aria-hidden="true" className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            {t('finalizing')}
          </span>
        ) : (
          <BillingStatusPill
            status={status}
            graceElapsed={graceElapsed}
            trialDaysLeft={trialDaysLeft}
            comped={comped}
          />
        )}
      </div>

      {/* Date line */}
      {dateLineText && (
        <p className="text-label text-text-muted tabular-nums">{dateLineText}</p>
      )}

      {/* Amount (platform currency — NOT formatEgp, design §2.5) */}
      {hasAmount && status !== 'trialing' && !comped && (
        <p className="text-label text-text-muted tabular-nums">
          {t('amountPerMonth', {
            amount: formatMoneyMinor(plan.amountMinor!, plan.currency!, { arabicDigits: true }),
            currency: (plan.currency ?? '').toUpperCase(),
          })}
        </p>
      )}

      {/* Manage billing button */}
      {hasStripeCustomer && onManageBilling && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="md"
            onClick={onManageBilling}
            loading={managePending}
          >
            {t('manageBilling')}
          </Button>
        </div>
      )}
    </div>
  );
}
