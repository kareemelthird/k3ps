import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { AuthProvider } from '@/lib/auth/AuthContext';
import { ImpersonationBannerHost } from '@/components/admin/ImpersonationBannerHost';
import './globals.css';

export const metadata: Metadata = {
  title: 'PS Management',
  description: 'لوحة تحكم مدير الكافيه — multi-tenant gaming café SaaS',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    // Arabic-first RTL layout (design-system §6, CLAUDE.md §6)
    // dir="rtl" and lang="ar" set at the root — never hardcoded per-component.
    // suppressHydrationWarning on html/body: browser extensions (ColorZilla, Grammarly,
    // password managers, etc.) inject attributes like `cz-shortcut-listen` onto these
    // wrapper elements after load. This only ignores attribute diffs on <html>/<body>
    // themselves — it does NOT mask hydration issues in the app tree.
    <html lang={locale} dir="rtl" className="dark" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <NextIntlClientProvider messages={messages} locale={locale}>
          <AuthProvider>
            {/* Safety-critical: renders impersonation banner + end/expired dialogs
                whenever a super-admin is in an active impersonation session (AC 24–27).
                Non-dismissible while impersonation is active (CLAUDE.md §2.2). */}
            <ImpersonationBannerHost />
            {children}
          </AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
