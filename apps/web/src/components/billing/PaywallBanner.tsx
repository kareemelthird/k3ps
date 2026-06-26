'use client';

/**
 * PaywallBanner — the calm lapse signal (design §3.1, AC 28).
 *
 * Four variants by resolved entitlement state. Never alarmist or punitive.
 * Always includes a recovery CTA. Staff see an "ask the owner" variant
 * without any Checkout/Portal controls.
 *
 * The billing page is ALWAYS reachable even in read-only mode (AC 28, binding).
 * RTL: icon at logical start, CTA at logical end.
 * All strings via i18n. a11y: role="status" (grace/trial) / role="alert" (readOnly).
 */

import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import { Button } from '@/components/ui/Button';

export type PaywallVariant = 'trialEnding' | 'pastDueGrace' | 'readOnly' | 'comped';

interface PaywallBannerProps {
  variant: PaywallVariant;
  /** Days until trial/grace ends (for trialEnding / pastDueGrace). */
  daysLeft?: number | null;
  /** ISO graceUntil (displayed as a date in pastDueGrace). */
  graceUntilIso?: string | null;
  /** Plan name for comped variant. */
  planName?: string;
  /** True if the current user is an owner (shows CTA); false → staff "ask owner" message. */
  isOwner: boolean;
  /** Called when the owner clicks the CTA. */
  onAction?: () => void;
  /** CTA loading state. */
  actionPending?: boolean;
}

interface BannerStyle {
  bg: string;
  border: string;
  iconBg: string;
  iconText: string;
  textColor: string;
  role: 'status' | 'alert';
}

const STYLES: Record<PaywallVariant, BannerStyle> = {
  trialEnding: {
    bg: 'bg-info/8',
    border: 'border-info/30',
    iconBg: 'bg-info/15',
    iconText: 'text-info',
    textColor: 'text-text',
    role: 'status',
  },
  pastDueGrace: {
    bg: 'bg-warning/8',
    border: 'border-warning/30',
    iconBg: 'bg-warning/15',
    iconText: 'text-warning',
    textColor: 'text-text',
    role: 'status',
  },
  readOnly: {
    bg: 'bg-danger/8',
    border: 'border-danger/30',
    iconBg: 'bg-danger/15',
    iconText: 'text-danger',
    textColor: 'text-text',
    role: 'alert',
  },
  comped: {
    bg: 'bg-platform/8',
    border: 'border-platform/30',
    iconBg: 'bg-platform/15',
    iconText: 'text-platform',
    textColor: 'text-text',
    role: 'status',
  },
};

function BannerIcon({ variant }: { variant: PaywallVariant }) {
  if (variant === 'trialEnding') {
    return (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    );
  }
  if (variant === 'pastDueGrace') {
    return (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.998L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.35 16.002c-.77 1.331.192 2.998 1.732 2.998z" />
      </svg>
    );
  }
  if (variant === 'readOnly') {
    return (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    );
  }
  // comped — gift
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="20 12 20 22 4 22 4 12" />
      <rect x="2" y="7" width="20" height="5" />
      <line x1="12" y1="22" x2="12" y2="7" />
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
    </svg>
  );
}

function formatDateArabic(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    return toArabicDigits(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    );
  } catch {
    return toArabicDigits(isoStr);
  }
}

export function PaywallBanner({
  variant,
  daysLeft,
  graceUntilIso,
  planName,
  isOwner,
  onAction,
  actionPending = false,
}: PaywallBannerProps) {
  const t = useTranslations('billing.paywall');
  const style = STYLES[variant];

  const title = (() => {
    if (variant === 'trialEnding') return t('trialEnding.title');
    if (variant === 'pastDueGrace') return t('pastDue.title');
    if (variant === 'readOnly') return t('readOnly.title');
    return null; // comped has no title
  })();

  const body = (() => {
    if (variant === 'trialEnding') {
      return t('trialEnding.body', { n: toArabicDigits(String(daysLeft ?? 0)) });
    }
    if (variant === 'pastDueGrace') {
      return t('pastDue.body', { n: toArabicDigits(String(daysLeft ?? 0)) });
    }
    if (variant === 'readOnly') return t('readOnly.body');
    // comped
    return t('comped.body', { plan: planName ?? '' });
  })();

  const ctaLabel = (() => {
    if (variant === 'trialEnding') return t('cta.subscribe');
    if (variant === 'pastDueGrace') return t('cta.updateCard');
    if (variant === 'readOnly') return t('cta.renew');
    return null;
  })();

  const showRecoverNote = variant === 'readOnly' && isOwner;

  return (
    <div
      role={style.role}
      aria-live={style.role === 'alert' ? 'assertive' : 'polite'}
      className={`rounded-md border ${style.bg} ${style.border} px-md py-sm flex items-start gap-sm`}
    >
      {/* Icon */}
      <span
        className={`flex-shrink-0 mt-0.5 w-8 h-8 flex items-center justify-center rounded-xs ${style.iconBg} ${style.iconText}`}
        aria-hidden="true"
      >
        <BannerIcon variant={variant} />
      </span>

      {/* Copy */}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        {title && (
          <p className={`text-label font-semibold ${style.textColor}`}>{title}</p>
        )}
        <p className={`text-body ${style.textColor}`}>{body}</p>
        {showRecoverNote && (
          <p className="text-caption text-text-muted">{t('alwaysRecover')}</p>
        )}
        {/* Grace date display */}
        {variant === 'pastDueGrace' && graceUntilIso && (
          <p className="text-caption text-text-muted">
            {formatDateArabic(graceUntilIso)}
          </p>
        )}
      </div>

      {/* CTA */}
      {variant !== 'comped' && (
        <div className="flex-shrink-0">
          {isOwner ? (
            ctaLabel && onAction && (
              <Button
                variant="secondary"
                size="md"
                onClick={onAction}
                loading={actionPending}
                className="whitespace-nowrap"
              >
                {ctaLabel}
              </Button>
            )
          ) : (
            <span className="text-label text-text-muted px-sm py-xs">{t('staff')}</span>
          )}
        </div>
      )}
    </div>
  );
}
