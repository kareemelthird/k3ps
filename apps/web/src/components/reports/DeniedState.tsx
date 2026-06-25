'use client';

/**
 * DeniedState — shown to manager/staff who reach /dashboard/reports.
 * The real gate is server-side (route role check); this is the UX face of AC 12.
 * Design: reports denied state §9 / feature-design §9.
 * All strings via i18n. RTL layout.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export function DeniedState() {
  const t = useTranslations();
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-md text-center py-3xl px-xl min-h-[400px]"
    >
      {/* Lock icon — no emoji (design-system §4) */}
      <svg
        aria-hidden="true"
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-text-faint"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
      <div className="space-y-xs">
        <p className="text-h3 text-text">{t('reports.denied.title')}</p>
        <p className="text-label text-text-muted max-w-xs">{t('reports.denied.body')}</p>
      </div>
      <Link
        href="/dashboard"
        className="px-md py-sm rounded-sm bg-surface-3 text-text text-label font-medium hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {t('reports.denied.backToDashboard')}
      </Link>
    </div>
  );
}
