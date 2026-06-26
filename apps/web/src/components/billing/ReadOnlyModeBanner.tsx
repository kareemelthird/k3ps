'use client';

/**
 * ReadOnlyModeBanner — slim persistent strip below TopBarSimple on every
 * /dashboard surface while entitlement.isReadOnly (design §4.2, AC 28).
 *
 * - grace mode: warning amber strip (past_due within grace)
 * - readOnly mode: danger red strip (grace elapsed / canceled)
 * - Never dismissible while the state holds.
 * - Operational mutations elsewhere are disabled; billing is ALWAYS reachable.
 * - RTL: logical spacing; link at the logical end.
 * - a11y: role="status", non-dismissible.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';

interface ReadOnlyModeBannerProps {
  mode: 'grace' | 'readOnly';
  graceUntilIso?: string | null;
  isOwner: boolean;
  /** Called if the manage billing button is clicked (owner only). */
  onManageBilling?: () => void;
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

export function ReadOnlyModeBanner({
  mode,
  graceUntilIso,
  isOwner,
}: ReadOnlyModeBannerProps) {
  const t = useTranslations('billing.readOnly');

  const isGrace = mode === 'grace';
  const colorClasses = isGrace
    ? 'bg-warning/10 border-warning/30 text-warning'
    : 'bg-danger/10 border-danger/30 text-danger';

  const message = isGrace && graceUntilIso
    ? t('graceBanner', { date: formatDateArabic(graceUntilIso) })
    : t('banner');

  return (
    <div
      role="status"
      aria-live="polite"
      className={`w-full border-b ${colorClasses} px-xl py-xs flex items-center justify-between gap-md min-h-[44px]`}
    >
      <div className="flex items-center gap-sm">
        {/* Warning/lock icon */}
        {isGrace ? (
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.998L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.35 16.002c-.77 1.331.192 2.998 1.732 2.998z" />
          </svg>
        ) : (
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        )}
        <span className="text-caption font-medium">{message}</span>
      </div>

      {/* Always-reachable billing link (owner only) */}
      {isOwner && (
        <Link
          href="/dashboard/billing"
          className="text-caption font-semibold underline decoration-current flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs"
        >
          {t('manage')}
        </Link>
      )}
    </div>
  );
}
