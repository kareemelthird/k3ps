/**
 * Super-admin sidebar navigation.
 *
 * Design: docs/design/super-admin-console.md §2
 * - Desktop (≥1024px): sidebar
 * - Mobile: top bar + drawer
 * - Current location highlighted (nav-state-active)
 * - RTL-mirrored: logical start/end, never left/right
 * - All strings via i18n
 */
'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
  href: string;
  labelKey: keyof ReturnType<typeof useTranslations<'nav'>>;
  /**
   * Accessible icon description (icon rendered inline, label required for a11y).
   * Icon SVGs are placeholders; Phase 3+ replaces with lucide-react.
   */
  icon: 'tenants' | 'audit' | 'settings';
}

const NAV_ITEMS: NavItem[] = [
  { href: '/admin/tenants', labelKey: 'tenants', icon: 'tenants' },
  { href: '/admin/audit', labelKey: 'auditLog', icon: 'audit' },
  { href: '/admin/settings', labelKey: 'settings', icon: 'settings' },
];

export function AdminSidebar() {
  const t = useTranslations('nav');
  const pathname = usePathname();

  return (
    <nav
      className="admin-sidebar"
      aria-label={t('tenants')}
      role="navigation"
    >
      <div className="admin-sidebar__brand" aria-label="PS Management">
        {/* Logo placeholder — Phase 3+ uses the actual brand asset */}
        <span className="admin-sidebar__logo" aria-hidden="true">PS</span>
      </div>

      <ul className="admin-sidebar__list" role="list">
        {NAV_ITEMS.map((item) => {
          // Locale-aware active check: matches /ar/admin/tenants, /en/admin/tenants
          const isActive = pathname.includes(item.href);
          return (
            <li key={item.href} className="admin-sidebar__item">
              <Link
                href={item.href}
                className={[
                  'admin-sidebar__link',
                  isActive ? 'admin-sidebar__link--active' : '',
                ].join(' ')}
                aria-current={isActive ? 'page' : undefined}
              >
                {/* Icon: SVG placeholder — real icons in Phase 3+ */}
                <NavIcon icon={item.icon} aria-hidden="true" />
                <span className="admin-sidebar__label">{t(item.labelKey)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface NavIconProps {
  icon: NavItem['icon'];
  'aria-hidden'?: boolean;
}

function NavIcon({ icon, ...rest }: NavIconProps) {
  // Placeholder SVGs — replaced with lucide-react in Phase 3+
  const paths: Record<NavItem['icon'], string> = {
    tenants: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm13 0a3 3 0 0 0-3-3m3 3a3 3 0 0 0 3 3m-3-3h.01',
    audit: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM8 13h8M8 17h4',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7-3a7 7 0 1 1-14 0 7 7 0 0 1 14 0z',
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <path d={paths[icon]} />
    </svg>
  );
}
