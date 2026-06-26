'use client';

/**
 * BillingDeniedState — shown when a manager/staff deep-links to /dashboard/billing.
 * Built on EmptyState grammar. Links back to the dashboard.
 * (design §1.3, AC 29)
 */

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';

export function BillingDeniedState() {
  const t = useTranslations('billing.denied');

  return (
    <div className="flex flex-col items-center justify-center py-3xl gap-lg text-center">
      {/* Icon */}
      <span className="w-16 h-16 flex items-center justify-center rounded-md bg-surface-2 border border-border">
        <svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-muted">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </span>

      <div className="flex flex-col gap-sm max-w-sm">
        <h1 className="text-h2 text-text font-bold">{t('title')}</h1>
        <p className="text-body text-text-muted">{t('body')}</p>
      </div>

      <Link href="/dashboard">
        <Button variant="secondary" size="md">
          {t('back')}
        </Button>
      </Link>
    </div>
  );
}
