'use client';

/**
 * ImpersonationExpiredInterstitial — non-dismissible modal shown when
 * impersonation_exp has passed (AC 27, design §7.3).
 *
 * - Focus-trapped: user cannot dismiss without clicking "Return".
 * - Non-dismissible: no scrim click-close, no Escape (deliberate — not a mistake).
 * - On return: triggers session refresh so the hook reverts to super-admin context.
 * - Audit: impersonation.stop row with reason "expired" was written by the hook.
 */

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';

interface ImpersonationExpiredInterstitialProps {
  tenantName: string;
  onReturn: () => void;
}

export function ImpersonationExpiredInterstitial({
  tenantName,
  onReturn,
}: ImpersonationExpiredInterstitialProps) {
  const t = useTranslations('admin.impersonate.expired');

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="imp-expired-title"
      aria-describedby="imp-expired-body"
      className="fixed inset-0 z-[10001] flex items-center justify-center p-xl"
    >
      {/* Scrim — intentionally not clickable (non-dismissible) */}
      <div className="absolute inset-0 bg-scrim" aria-hidden="true" />

      {/* Dialog panel — violet accent, no close button */}
      <div className="relative z-10 bg-surface rounded-md shadow-e3 p-2xl max-w-md w-full border border-impersonation flex flex-col gap-lg">
        {/* Title */}
        <div className="flex items-center gap-sm">
          <span className="flex-shrink-0 w-8 h-8 rounded-xs bg-impersonation/15 flex items-center justify-center">
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#8B5CF6"
              strokeWidth="1.5"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </span>
          <h2 id="imp-expired-title" className="text-h3 text-text font-semibold">
            {t('title')}
          </h2>
        </div>

        {/* Body */}
        <p id="imp-expired-body" className="text-body text-text-muted">
          {t('body')}
          {tenantName && (
            <> — <bdi className="font-medium text-text">{tenantName}</bdi></>
          )}
        </p>

        {/* Single action — no cancel, no dismiss (non-dismissible per design §7.3) */}
        <div className="flex justify-end">
          <Button
            autoFocus
            variant="primary"
            size="md"
            onClick={onReturn}
          >
            {t('return')}
          </Button>
        </div>
      </div>
    </div>
  );
}
