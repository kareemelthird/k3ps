'use client';

/**
 * AdminSidebar — design-system §2.4, phase-7-super-admin-portal.md §2.
 *
 * Left sidebar (RTL → right edge) for the admin shell.
 * Structurally distinct from the tenant TopBar — the layout contrast alone
 * signals "this is the platform, not a tenant dashboard."
 *
 * Platform badge (platform steel hue) · Nav items · Footer (identity + sign-out).
 * RTL: sidebar pinned to start edge (logical, maps to right in RTL).
 * All strings via i18n. No emoji icons.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/AuthContext';

export type AdminNav = 'overview' | 'subscriptions' | 'audit';

interface AdminSidebarProps {
  active: AdminNav;
  onSignOut: () => void;
}

export function AdminSidebar({ active, onSignOut }: AdminSidebarProps) {
  const tAdmin = useTranslations('admin');
  const tAuth = useTranslations('auth');
  const { user } = useAuth();

  const navItems = [
    { id: 'overview' as const, href: '/admin', label: tAdmin('nav.tenants') },
    { id: 'subscriptions' as const, href: '/admin/subscriptions', label: tAdmin('nav.subscriptions') },
    { id: 'audit' as const, href: '/admin/audit', label: tAdmin('nav.audit') },
  ];

  return (
    <aside
      className="w-[220px] flex-shrink-0 flex flex-col bg-platform-surface border-s border-border min-h-dvh sticky top-0"
      aria-label={tAdmin('platform.badge')}
    >
      {/* ── Header: platform monogram + badge ─────────────────────────────── */}
      <div className="flex items-center gap-sm px-md py-lg border-b border-border">
        {/* Platform monogram — shield SVG, platform-tinted (no emoji per design-system §4) */}
        <span
          className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-xs bg-platform/15"
          aria-hidden="true"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-platform"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
            />
          </svg>
        </span>
        <span className="text-label font-semibold text-platform truncate" aria-hidden="true">
          {tAdmin('platform.badge')}
        </span>
      </div>

      {/* ── Nav ───────────────────────────────────────────────────────────── */}
      <nav
        role="navigation"
        aria-label={tAdmin('platform.name')}
        className="flex-1 flex flex-col gap-2xs p-sm"
      >
        {navItems.map(({ id, href, label }) => {
          const isActive = active === id;
          return (
            <Link
              key={id}
              href={href}
              aria-current={isActive ? 'page' : undefined}
              className={`flex items-center gap-sm px-sm py-xs rounded-xs text-label font-medium transition-colors duration-fast
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
                ${isActive
                  ? 'bg-platform/15 text-platform'
                  : 'text-text-muted hover:text-text hover:bg-surface-3'
                }`}
            >
              {/* Tenants icon */}
              {id === 'overview' && (
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                  />
                </svg>
              )}
              {/* Subscriptions icon — credit-card */}
              {id === 'subscriptions' && (
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                  <line x1="1" y1="10" x2="23" y2="10" />
                </svg>
              )}
              {/* Audit icon */}
              {id === 'audit' && (
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
                  />
                </svg>
              )}
              {label}
            </Link>
          );
        })}
      </nav>

      {/* ── Footer: identity + sign-out (spatially separated from nav, destructive-nav-separation) */}
      <div className="border-t border-border p-sm flex flex-col gap-xs">
        {user?.email && (
          <p className="text-caption text-text-faint truncate px-xs">
            {/* LTR-isolated email (design §1.4: Latin tokens stay LTR in RTL flow) */}
            <bdi>{user.email}</bdi>
          </p>
        )}
        <button
          type="button"
          onClick={onSignOut}
          className="flex items-center gap-sm px-sm py-xs rounded-xs text-label text-text-muted hover:text-danger hover:bg-surface-3 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary w-full text-start"
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
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
          {tAuth('signOut')}
        </button>
      </div>
    </aside>
  );
}
