'use client';

/**
 * /dashboard/staff — owner staff management (Slice 2, ADR-0012).
 *
 * Owner: full CRUD (invite / edit role+permissions / toggle active).
 * Manager/staff: access denied — DeniedState rendered (role boundary, CLAUDE.md §5).
 *
 * Tenant isolation: all data reads are RLS-scoped via the signed JWT claim.
 * Role check: reads the `roles` scalar from the JWT claim (set by the Supabase
 * auth hook — ADR-0003). ADR-0008 Decision Q3: roles is scalar.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/AuthContext';
import { StaffView } from '@/components/staff/StaffView';
import { DashboardPageShell } from '@/components/shell/DashboardPageShell';

function StaffDeniedState() {
  const t = useTranslations();
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-md text-center py-3xl px-xl min-h-[400px]"
    >
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
        <p className="text-h3 text-text">{t('staff.denied.title')}</p>
        <p className="text-label text-text-muted max-w-xs">{t('staff.denied.body')}</p>
      </div>
      <Link
        href="/dashboard"
        className="px-md py-sm rounded-sm bg-surface-3 text-text text-label font-medium hover:bg-surface-2
          transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {t('staff.denied.backToDashboard')}
      </Link>
    </div>
  );
}

export default function StaffPage() {
  const { claim, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !claim) {
      router.replace('/login');
    }
  }, [loading, claim, router]);

  if (loading || !claim) return null;

  // Role gate: owner or super_admin only (CLAUDE.md §5 / ADR-0008 Q3).
  const isOwner = claim.roles === 'owner' || claim.is_super_admin;

  return (
    <DashboardPageShell>
      {isOwner ? <StaffView /> : <StaffDeniedState />}
    </DashboardPageShell>
  );
}
