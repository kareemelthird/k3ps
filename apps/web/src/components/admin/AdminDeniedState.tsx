'use client';

/**
 * AdminDeniedState — shown to any authenticated user who reaches /admin
 * without a valid is_super_admin claim (AC 1, design §3.4).
 *
 * The real gate is server-side (every fetch re-verifies is_super_admin()).
 * This is the UX face of the route role-gate: no platform data in the payload.
 * All strings via i18n. RTL layout.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export function AdminDeniedState() {
  const t = useTranslations('admin.denied');

  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-md text-center py-3xl px-xl min-h-[400px]"
    >
      {/* Shield / lock icon — no emoji (design-system §4) */}
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
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
        />
      </svg>

      <div className="space-y-xs">
        <p className="text-h3 text-text">{t('title')}</p>
        <p className="text-label text-text-muted max-w-xs">{t('body')}</p>
      </div>

      <Link
        href="/"
        className="px-md py-sm rounded-sm bg-surface-3 text-text text-label font-medium hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {t('back')}
      </Link>
    </div>
  );
}
