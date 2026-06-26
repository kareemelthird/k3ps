'use client';

/**
 * AdminShell — the outer shell for the /admin super-admin portal.
 *
 * Dual-layer role gate (AC 1–4):
 *  1. Client guard: reads is_super_admin from the signed claim.
 *  2. Every data fetch inside re-verifies is_super_admin() server-side.
 *
 * Layout: sidebar (AdminSidebar) + main content area.
 * Visually distinct from the tenant DashboardShell:
 *  - Left sidebar vs top bar
 *  - platform-surface background (design-system §2.4)
 *  - Platform monogram + badge
 *
 * RTL: uses logical spacing (start/end); sidebar is on the start edge
 * (right in RTL because HTML dir="rtl" is set at the root).
 */

import { useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/AuthContext';
import { AdminSidebar, type AdminNav } from './AdminSidebar';
import { AdminDeniedState } from './AdminDeniedState';

interface AdminShellProps {
  children: React.ReactNode;
  /** Which sidebar nav item is currently active. */
  activeNav: AdminNav;
  /** Page title shown in the content header. */
  pageTitle: string;
  /** Optional primary action slot (one CTA per screen, design §1.2). */
  headerActions?: React.ReactNode;
}

export function AdminShell({
  children,
  activeNav,
  pageTitle,
  headerActions,
}: AdminShellProps) {
  const t = useTranslations('state');
  const { claim, loading: authLoading, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !claim) {
      router.replace('/login');
    }
  }, [authLoading, claim, router]);

  const handleSignOut = useCallback(async () => {
    await signOut();
    router.replace('/login');
  }, [signOut, router]);

  // Auth loading
  if (authLoading) {
    return (
      <div className="min-h-dvh bg-bg flex items-center justify-center">
        <p className="text-text-muted text-label">{t('loading')}</p>
      </div>
    );
  }

  // Not logged in — redirect handled above; render nothing while navigating
  if (!claim) return null;

  // Role gate (client-side courtesy; real gate is server-side on every fetch — AC 1, 4)
  if (!claim.is_super_admin) {
    return (
      <div className="min-h-dvh bg-bg text-text">
        <AdminDeniedState />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-bg text-text flex">
      {/* ── Sidebar (start edge, RTL → right) ─────────────────────────────── */}
      <AdminSidebar active={activeNav} onSignOut={() => void handleSignOut()} />

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Page header */}
        <header className="sticky top-0 z-30 bg-surface border-b border-border px-xl py-sm flex items-center gap-md shadow-e1">
          <h1 className="text-h2 text-text font-bold flex-1 truncate">{pageTitle}</h1>
          {headerActions && (
            <div className="flex-shrink-0 flex items-center gap-sm">{headerActions}</div>
          )}
        </header>

        {/* Main content area — keyboard focus on route change (focus-on-route-change) */}
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 max-w-7xl w-full mx-auto px-xl py-2xl"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
