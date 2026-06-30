'use client';

/**
 * /dashboard/devices — owner device fleet management (Phase 5 AC F1–F7).
 *
 * Owner: full CRUD (create / edit / maintenance toggle / deactivate / reactivate).
 * Manager/staff: access denied — DeniedState rendered (role boundary, CLAUDE.md §5).
 *
 * Tenant isolation: all data reads are RLS-scoped via the signed JWT claim.
 * tenant_id is NEVER sent from the client as a trust source (CLAUDE.md §5).
 *
 * Role check: reads the `roles` scalar from the JWT claim (set by the Supabase
 * auth hook — ADR-0003). If the claim is absent, redirects to /login.
 * ADR-0008 Decision Q3: roles is scalar — use === not .includes() (fail-closed).
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/AuthContext';
import { DevicesManageView } from '@/components/devices/DevicesManageView';
import { DashboardPageShell } from '@/components/shell/DashboardPageShell';

/** Inline DeniedState for devices — mirrors reports/DeniedState but uses devices.denied keys. */
function DevicesDeniedState() {
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
        <p className="text-h3 text-text">{t('devices.denied.title')}</p>
        <p className="text-label text-text-muted max-w-xs">{t('devices.denied.body')}</p>
      </div>
      <Link
        href="/dashboard"
        className="px-md py-sm rounded-sm bg-surface-3 text-text text-label font-medium hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {t('devices.denied.backToDashboard')}
      </Link>
    </div>
  );
}

export default function DevicesManagePage() {
  const { claim, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !claim) {
      router.replace('/login');
    }
  }, [loading, claim, router]);

  if (loading || !claim) {
    return null; // DashboardPageShell handles loading skeleton
  }

  // Role gate: owner or super_admin only (CLAUDE.md §5 / ADR-0008 Q3).
  const isOwner = claim.roles === 'owner' || claim.is_super_admin;

  return (
    <DashboardPageShell>
      {isOwner ? <DevicesManageView /> : <DevicesDeniedState />}
    </DashboardPageShell>
  );
}
