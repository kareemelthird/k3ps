/**
 * Super-admin portal layout.
 *
 * Route-guard: only users with is_platform_admin=true may access /admin/*.
 * Guard is enforced by middleware (Phase 3+). This layout renders the sidebar
 * navigation per docs/design/super-admin-console.md §2.
 *
 * Design: Calm Operations, dark-first, RTL sidebar (≥1024px) / drawer (<1024px).
 * All strings via next-intl. No hardcoded text.
 */
import { useTranslations } from 'next-intl';
import { AdminSidebar } from '@/components/super-admin/AdminSidebar';

interface AdminLayoutProps {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}

export default async function AdminLayout({ children, params }: AdminLayoutProps) {
  const { locale } = await params;

  return (
    <div className="admin-shell" data-locale={locale}>
      {/* Server-rendered sidebar — uses client component for active state */}
      <AdminSidebar />
      <main className="admin-main" id="main-content">
        {children}
      </main>
    </div>
  );
}
