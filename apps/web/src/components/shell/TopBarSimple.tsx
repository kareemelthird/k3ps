'use client';

/**
 * TopBarSimple — lighter version of TopBar for inner dashboard pages.
 *
 * Includes nav links (Devices, Rate Rules, Products, [Reports — owner only])
 * and sign-out. Phase 6 adds the owner-gated Reports nav item (AC 12 / spec §6 Q8).
 *
 * RTL: all spacing uses logical props (start/end).
 * All strings via i18n (no hardcoded copy).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/AuthContext';
import { Button } from '@/components/ui/Button';
import type { Branch } from '@ps/core';

interface TopBarSimpleProps {
  tenantName?: string;
  branches: Branch[];
  activeBranchId: string | null;
  onBranchSelect: (id: string) => void;
}

export function TopBarSimple({
  tenantName,
}: TopBarSimpleProps) {
  const t = useTranslations();
  const { claim, signOut } = useAuth();
  const pathname = usePathname();

  // ADR-0008 Decision Q3: roles is a scalar; use === not .includes() (fail-closed).
  const isOwner = (claim?.roles === 'owner') || (claim?.is_super_admin ?? false);

  const navItems = [
    { href: '/dashboard', label: t('nav.devices') },
    { href: '/dashboard/rate-rules', label: t('nav.rateRules') },
    { href: '/dashboard/products', label: t('nav.products') },
    // Devices management: owner-only (create/edit/maintenance — AC F1–F7).
    ...(isOwner ? [{ href: '/dashboard/devices', label: t('nav.devicesManage') }] : []),
    // Reports: owner-only nav item (AC 12 / design §2).
    // The nav item is hidden for non-owners (empty-nav-state pattern).
    ...(isOwner ? [{ href: '/dashboard/reports', label: t('nav.reports') }] : []),
    // Billing: owner-only nav item (Phase 9, AC 28 — always reachable for owners).
    ...(isOwner ? [{ href: '/dashboard/billing', label: t('nav.billing') }] : []),
  ];

  return (
    <header
      role="banner"
      className="sticky top-0 z-40 bg-surface border-b border-border px-xl py-sm flex items-center gap-md shadow-e1"
    >
      {/* Start: app name */}
      <div className="flex items-center gap-sm flex-shrink-0">
        <span className="text-h3 text-text font-bold truncate max-w-[140px]">
          {tenantName ?? t('app.name')}
        </span>
      </div>

      {/* Center: nav links */}
      <nav
        className="flex items-center gap-xs flex-1"
        aria-label={t('nav.dashboard')}
      >
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`px-sm py-xs rounded-sm text-label font-medium transition-colors duration-fast
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
                ${isActive
                  ? 'bg-surface-3 text-primary'
                  : 'text-text-muted hover:text-text hover:bg-surface-3'
                }`}
              aria-current={isActive ? 'page' : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* End: sign out */}
      <div className="flex items-center flex-shrink-0">
        <Button
          variant="ghost"
          size="md"
          onClick={() => void signOut()}
          aria-label={t('action.signOut')}
          className="h-9 px-sm text-text-muted"
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
            />
          </svg>
          <span className="hidden sm:inline">{t('auth.signOut')}</span>
        </Button>
      </div>
    </header>
  );
}
