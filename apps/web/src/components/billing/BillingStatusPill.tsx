'use client';

/**
 * BillingStatusPill — subscription status pill for Phase 9.
 *
 * Sibling to StatusPill (which handles device statuses). Reuses the same pill
 * grammar (dot/icon + label on a ${color}1A tint, AA text) but bound to the
 * §2.5 billing-status token mapping from design-system.md.
 *
 * Status is NEVER conveyed by colour alone — every state carries both an icon
 * and a label. RTL: dot/icon at the logical start.
 * All strings via i18n. (design §5, §2.5, AC 36/37)
 */

import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import type { SubscriptionStatus } from '@ps/core';

interface BillingStatusPillProps {
  status: SubscriptionStatus;
  /** When past_due and grace has elapsed — render danger read-only variant. */
  graceElapsed?: boolean;
  /** Trial days remaining — folded into label when status is trialing. */
  trialDaysLeft?: number | null;
  /** Whether this subscription is comped (super-admin grant). */
  comped?: boolean;
}

/** Map subscription status to design-system §2.5 colour token classes. */
function statusClasses(
  status: SubscriptionStatus,
  graceElapsed: boolean,
  comped: boolean,
): { bg: string; text: string; iconText: string } {
  if (comped) {
    return { bg: 'bg-platform/10', text: 'text-platform', iconText: 'text-platform' };
  }
  if (status === 'trialing') {
    return { bg: 'bg-info/10', text: 'text-info', iconText: 'text-info' };
  }
  if (status === 'active') {
    return { bg: 'bg-status-free/10', text: 'text-status-free', iconText: 'text-status-free' };
  }
  if (status === 'past_due') {
    if (graceElapsed) {
      return { bg: 'bg-danger/10', text: 'text-danger', iconText: 'text-danger' };
    }
    return { bg: 'bg-warning/10', text: 'text-warning', iconText: 'text-warning' };
  }
  if (status === 'canceled') {
    return { bg: 'bg-danger/10', text: 'text-danger', iconText: 'text-danger' };
  }
  // incomplete / unknown → muted neutral
  return { bg: 'bg-surface-3', text: 'text-text-muted', iconText: 'text-text-muted' };
}

/** Icon per state (Lucide-style SVG, stroke 1.5). */
function StatusIcon({ status, graceElapsed, comped }: { status: SubscriptionStatus; graceElapsed: boolean; comped: boolean }) {
  if (comped) {
    // gift icon
    return (
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polyline points="20 12 20 22 4 22 4 12" />
        <rect x="2" y="7" width="20" height="5" />
        <line x1="12" y1="22" x2="12" y2="7" />
        <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
        <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
      </svg>
    );
  }
  if (status === 'trialing') {
    // clock icon
    return (
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    );
  }
  if (status === 'active') {
    // check-circle icon
    return (
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (status === 'past_due') {
    if (graceElapsed) {
      // lock icon
      return (
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      );
    }
    // alert-triangle
    return (
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.998L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.35 16.002c-.77 1.331.192 2.998 1.732 2.998z" />
      </svg>
    );
  }
  if (status === 'canceled') {
    // x-circle
    return (
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    );
  }
  // incomplete — hourglass
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}

export function BillingStatusPill({
  status,
  graceElapsed = false,
  trialDaysLeft,
  comped = false,
}: BillingStatusPillProps) {
  const t = useTranslations('billing.status');

  function label(): string {
    if (comped) return t('comped');
    if (status === 'trialing' && trialDaysLeft != null) {
      return t('trialDaysLeft', { n: toArabicDigits(String(trialDaysLeft)) });
    }
    if (status === 'trialing') return t('trialing');
    if (status === 'active') return t('active');
    if (status === 'past_due' && graceElapsed) return t('readOnly');
    if (status === 'past_due') return t('pastDue');
    if (status === 'canceled') return t('canceled');
    return t('incomplete');
  }

  const classes = statusClasses(status, graceElapsed, comped);
  const pillLabel = label();

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-caption font-medium ${classes.bg} ${classes.text}`}
      aria-label={pillLabel}
    >
      <span className={classes.iconText}>
        <StatusIcon status={status} graceElapsed={graceElapsed} comped={comped} />
      </span>
      {pillLabel}
    </span>
  );
}
