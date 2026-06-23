import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { AuthProvider } from '@/lib/auth/AuthContext';
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
    <html lang={locale} dir="rtl" className="dark">
      <body>
        <NextIntlClientProvider messages={messages} locale={locale}>
          <AuthProvider>{children}</AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
